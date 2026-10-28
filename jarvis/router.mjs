#!/usr/bin/env node
// Jarvis 3 UI router (DE0CH/jarvis3 docs/CLAUDE-CODE.md): the front of the CloudCLI-fork UI pods. One CloudCLI server
// process per signed-in staff member, started on demand and stopped when idle; every request is checked against
// Cloudflare Access (RS256 against the team's JWKS, issuer,
// audience, expiry, an email claim, the instance's `users`) and proxied (HTTP and WebSocket) to that person's process
// with `X-Jarvis-User: <email>`.
//
// The operator page (DE0CH/jarvis3 docs/CHAT.md, "Operator page"): GET /ops/* from a signed-in user who is also in the
// config's `admins` is forwarded to web's /internal/ops/* (JARVIS_WEB_URL, bearer JARVIS_CC_TOKEN, X-Jarvis-User);
// anyone else gets 403 and nothing is forwarded. It needs no CloudCLI process and is served by whichever replica
// gets the request.
//
// Signed out (Deyao, 2026-10-27, "interface first"): only the paths in SIGNED_IN_PATHS are behind Cloudflare Access
// (the Access app "YYC AI (staff)" and cloudflared require a token there); everything else reaches the router without
// one. A request with no valid token gets the static shell and nothing else: GET/HEAD of a built file in dist/ (the
// Paseo web app's bundle) or, for a page path, dist/index.html marked <meta name="yyc-signed-out">, which the app shows
// with the chat disabled and a 「登入」 button to GET /api/jarvis/signin (behind Access: it signs the person in, then
// this answers 302 back to the page). Every other request without a valid token is 401; API, WebSocket and user data
// still need the token and `users`, checked here on every call.
//
// GET /api/jarvis/me is answered by the router too (no CloudCLI process): {firstName}, the Access identity's first
// name or null, for the empty chat's greeting.
//
// Several router replicas run side by side (stateless). Each person's process lives on one replica, picked by
// rendezvous hashing over the ready replicas (a headless Service's DNS): a request that lands on another replica is
// passed on to the owner, so a person's tabs all reach the same process (a run's live stream exists only there).
// If the owner can't be reached, the request is served here.
//
// Rollouts (zero-downtime): the replica set changes (a surge pod joins, an old one leaves), so the hash can name a
// new owner while the person's process, and the chat it is running, still live on another replica. Before the owner
// starts a process it asks every replica it has seen recently (the ready ones plus draining ones, which stay
// reachable until they exit) whether one already holds that person's process (GET /__jarvis/peer/holds, authenticated
// by a key derived from JARVIS_CC_TOKEN); if one does, and it is not draining or it has a chat running, the request
// goes there (hop "2": served there, never passed on again). A replica that is not among the ready ones (draining, or
// in its preStop pause) never counts itself as an owner, so it agrees with the ready replicas.
// Draining (SIGTERM) keeps the listener open for those passed-on requests and keeps every WebSocket that carries a
// running chat open: its own processes' tabs, and tabs it only forwards to another replica while that replica reports
// a chat running for the person (each up to JARVIS_UI_DRAIN_SECONDS). Other forwarded tabs are closed at once and
// reconnect through a ready replica to the process that has the run, where the page re-subscribes to it.
//
// No dependencies beyond Node's standard library.
//
// Environment (defaults in brackets):
//   PORT [8080]                       listen port (all interfaces)
//   JARVIS_CONFIG [/etc/jarvis/config.json]   instance config: access.teamDomain, access.audience (and access.also:
//                                             more {teamDomain, audience}), users (emails, or "@domain"), admins
//                                     (access.jwksFile: a local JWKS instead of the team's, for tests only)
//   JARVIS_UI_SERVER [<repo>/dist-server/server/index.js]   the CloudCLI server entry
//   JARVIS_UI_HOME_ROOT [/var/lib/cloudcli/home]   per-user HOME folders (HOME/.claude -> $JARVIS_JFS_ROOT/users/<key>/claude)
//   JARVIS_JFS_ROOT [/jfs]            the JuiceFS volume
//   JARVIS_UI_MAX_USERS [6]           cap on concurrent user processes in this replica
//   JARVIS_UI_IDLE_MINUTES [30]       stop a process after this long without traffic and without a running chat
//   JARVIS_UI_DRAIN_SECONDS [900]     on SIGTERM: wait at most this long for running chats before stopping processes
//   JARVIS_UI_START_SECONDS [60]      a process must answer /health within this long
//   JARVIS_UI_CHILD_HEAP_MB [256]     --max-old-space-size of each user process
//   JARVIS_UI_PEERS [unset]           DNS name of the replicas' headless Service (unset: no peer forwarding)
//   POD_IP                            this replica's address (with JARVIS_UI_PEERS)
//   JARVIS_UI_DIST [<repo>/dist]       the built web app, served to signed-out visitors (no index.html: no shell)
//   JARVIS_UID [1000]                 owner of folders the router makes when it runs as root
//   passed to every process: DATABASE_URL, JWT_SECRET, JARVIS_WEB_URL, JARVIS_CC_TOKEN (plus the per-user contract env)
import { createHash, createPublicKey, timingSafeEqual, verify as cryptoVerify } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import { promises as dns } from "node:dns";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, readlink, symlink, unlink, chown, lstat, readFile, stat } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOP = "x-jarvis-ui-hop";
const PEER_AUTH = "x-jarvis-ui-peer";
const PEER_PATH = "/__jarvis/peer/holds";
// Paths that always need a signed-in staff member; keep in step with the Access app's destinations and cloudflared's
// access-required ingress rule (DE0CH/YYC news-stream/deploy/cloudflare/tofu: access.tf staff_ai, tunnels.tf yyc_ai)
export const SIGNED_IN_PATHS = ["/api", "/paseo-ws", "/ws", "/ops"];
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".map": "application/json", ".webmanifest": "application/manifest+json",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".webp": "image/webp", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".otf": "font/otf", ".txt": "text/plain; charset=utf-8", ".wasm": "application/wasm",
};

/** Whether a URL path (no query) needs a signed-in staff member whatever it is. */
export function needsSignIn(pathname) {
  return SIGNED_IN_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/")) || pathname.startsWith("/__jarvis");
}

export function log(level, msg, fields = {}) {
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields }) + "\n");
}

/** Days a deleted conversation stays in Recently deleted (server/modules/providers/services/sessions.service.ts). */
const RECENTLY_DELETED_DAYS = 30;

/** Whether the person's schema holds a conversation deleted RECENTLY_DELETED_DAYS ago or more (false: no schema yet). */
async function hasExpiredDeletions(email) {
  if (!process.env.DATABASE_URL) return false;
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const table = `"cc_${userKey(email)}".sessions`;
    const { rows: exists } = await client.query("select to_regclass($1) as t", [table]);
    if (!exists[0]?.t) return false;
    const { rows } = await client.query(
      `select 1 from ${table} where deleted_at is not null
         and deleted_at <= to_char(now() at time zone 'utc' - make_interval(days => $1), 'YYYY-MM-DD HH24:MI:SS') limit 1`,
      [RECENTLY_DELETED_DAYS],
    );
    return rows.length > 0;
  } catch (e) {
    if (e.code === "42703") return false; // schema not migrated yet (no deleted_at)
    throw e;
  } finally {
    await client.end().catch(() => {});
  }
}

/** jarvis3's userKey: "u" + the first 24 hex characters of sha256(lowercased, trimmed email). */
export function userKey(email) {
  return "u" + createHash("sha256").update(String(email).trim().toLowerCase()).digest("hex").slice(0, 24);
}

/** The Access token of a request: the Cf-Access-Jwt-Assertion header, else the CF_Authorization cookie. */
export function accessToken(req) {
  const h = req.headers["cf-access-jwt-assertion"];
  if (typeof h === "string" && h) return h;
  const m = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(req.headers.cookie || "");
  return m ? decodeURIComponent(m[1]) : "";
}

const b64url = (s) => Buffer.from(s, "base64url");

/**
 * Cloudflare Access JWT verification: RS256 against the team's JWKS (cached an hour, refetched for an unknown key id
 * at most every 30 s), issuer https://<teamDomain>, audience, exp/nbf with 5 s tolerance, an email claim.
 */
export class AccessVerifier {
  #issuer; #audience; #jwks; #keys = new Map(); #names = new Map(); #fetchedAt = 0; #lastTry = 0; #fetch; #now;
  get issuer() { return this.#issuer; }
  constructor({ teamDomain, audience, jwks, fetchImpl, now }) {
    if (!teamDomain || !audience) throw new Error("access.teamDomain and access.audience are required");
    this.#issuer = `https://${teamDomain}`;
    this.#audience = audience;
    this.#jwks = jwks ?? null;
    this.#fetch = fetchImpl ?? globalThis.fetch;
    this.#now = now ?? (() => Date.now());
    if (jwks) this.#load(jwks);
  }
  #load(jwks) {
    this.#keys.clear();
    for (const k of jwks.keys ?? []) {
      if (k.kty !== "RSA") continue;
      try { this.#keys.set(k.kid ?? "", createPublicKey({ key: k, format: "jwk" })); } catch { /* skip a bad key */ }
    }
  }
  async #refresh(force) {
    if (this.#jwks) return;
    const now = this.#now();
    if (!force && this.#keys.size && now - this.#fetchedAt < 3600_000) return;
    if (now - this.#lastTry < 30_000 && this.#keys.size) return;
    this.#lastTry = now;
    const r = await this.#fetch(`${this.#issuer}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`JWKS ${r.status}`);
    this.#load(await r.json());
    this.#fetchedAt = now;
  }
  /** The signed-in email (lowercased); throws on anything but a valid, current identity token for this app. */
  async email(token) {
    const p = await this.#verify(token);
    const email = typeof p.email === "string" ? p.email.trim().toLowerCase() : "";
    if (!email) throw new Error("no email (service tokens are not staff)");
    return email;
  }

  /**
   * The person's first name as their identity provider gives it (Google: given_name, else the first word of name), for
   * the empty chat's greeting; null when there is none (e-mailed code). Never derived from the address. Best effort:
   * the token's claims, else the team's get-identity endpoint (1.5 s timeout); cached per email (6 h; 5 min after a
   * failure).
   */
  async firstName(token, email) {
    const hit = this.#names.get(email);
    if (hit && hit.until > this.#now()) return hit.name;
    let name = null;
    let ttl = 6 * 3600_000;
    try {
      name = pickFirstName(await this.#verify(token));
      if (!name && !this.#jwks) name = pickFirstName(await this.#identity(token));
    } catch {
      ttl = 5 * 60_000;
    }
    this.#names.set(email, { name, until: this.#now() + ttl });
    return name;
  }

  async #identity(token) {
    const r = await this.#fetch(`${this.#issuer}/cdn-cgi/access/get-identity`, {
      headers: { cookie: `CF_Authorization=${token}` },
      signal: AbortSignal.timeout(1500),
    });
    if (!r.ok) throw new Error(`get-identity ${r.status}`);
    const j = await r.json();
    // Google's claims arrive as `name` and, depending on the IdP setup, under oidc_fields
    const oidc = j.oidc_fields ?? {};
    return { given_name: oidc.given_name ?? j.given_name, name: oidc.name ?? j.name };
  }

  /** The verified claims; throws on anything but a valid, current token for this app. */
  async #verify(token) {
    const parts = String(token).split(".");
    if (parts.length !== 3) throw new Error("malformed token");
    const header = JSON.parse(b64url(parts[0]).toString("utf8"));
    if (header.alg !== "RS256") throw new Error("unexpected alg");
    await this.#refresh(false);
    let key = this.#keys.get(header.kid ?? "");
    if (!key) {
      await this.#refresh(true);
      key = this.#keys.get(header.kid ?? "");
    }
    if (!key) throw new Error("unknown key");
    const ok = cryptoVerify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, b64url(parts[2]));
    if (!ok) throw new Error("bad signature");
    const p = JSON.parse(b64url(parts[1]).toString("utf8"));
    const now = this.#now() / 1000;
    if (p.iss !== this.#issuer) throw new Error("bad issuer");
    const aud = Array.isArray(p.aud) ? p.aud : [p.aud];
    if (!aud.includes(this.#audience)) throw new Error("bad audience");
    if (typeof p.exp !== "number" || p.exp + 5 < now) throw new Error("expired");
    if (typeof p.nbf === "number" && p.nbf - 5 > now) throw new Error("not yet valid");
    return p;
  }
}

/**
 * Several Access teams at once (config access.also: [{teamDomain, audience}], e.g. while an instance moves to another
 * Cloudflare account): the token's issuer picks the team's AccessVerifier, which checks everything else; an issuer
 * that is none of them is refused.
 */
export class TeamsVerifier {
  #by = new Map();
  constructor(verifiers) {
    for (const v of verifiers) this.#by.set(v.issuer, v);
  }
  #pick(token) {
    let iss = "";
    try { iss = JSON.parse(b64url(String(token).split(".")[1] ?? "").toString("utf8")).iss ?? ""; } catch { /* malformed */ }
    const v = this.#by.get(iss);
    if (!v) throw new Error("bad issuer");
    return v;
  }
  async email(token) { return this.#pick(token).email(token); }
  async firstName(token, email) {
    try { return await this.#pick(token).firstName(token, email); } catch { return null; }
  }
}

/** given_name, else the first word of name (a CJK name is kept whole); trimmed to 40 characters; null otherwise. */
export function pickFirstName(id) {
  if (!id) return null;
  const given = typeof id.given_name === "string" ? id.given_name.trim() : "";
  const full = typeof id.name === "string" ? id.name.trim() : "";
  const n = given || (/[\u3400-\u9fff]/.test(full) ? full : full.split(/\s+/)[0] || "");
  if (!n || n.includes("@")) return null;
  return [...n].slice(0, 40).join("");
}

/** Rendezvous hashing: the replica that owns `key` among `peers` (addresses). */
export function ownerOf(key, peers) {
  let best = null, bestScore = "";
  for (const p of peers) {
    const s = createHash("sha256").update(`${key}|${p}`).digest("hex");
    if (best === null || s > bestScore) { best = p; bestScore = s; }
  }
  return best;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function page(res, status, title, text) {
  if (res.headersSent) return res.end();
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(`<!doctype html><html lang="zh-HK"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;padding:24px 16px;max-width:560px;margin:auto"><h1 style="font-size:20px">${title}</h1><p>${text}</p></body></html>`);
}

function rejectUpgrade(socket, status, text) {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] || ""}\r\ncontent-type: text/plain\r\nconnection: close\r\ncontent-length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
}

/** Request headers for the user's process: hop-by-hop headers dropped, X-Jarvis-User set by us only. */
function upstreamHeaders(req, email, extra = {}) {
  const h = { ...req.headers };
  for (const k of ["x-jarvis-user", HOP, PEER_AUTH, "proxy-connection", "keep-alive", "te", "trailer"]) delete h[k];
  if (!req.headers.upgrade) delete h.connection;
  if (email) h["x-jarvis-user"] = email;
  return { ...h, ...extra };
}

/** Response headers passed back: hop-by-hop headers of the upstream connection dropped. */
function responseHeaders(ures) {
  const h = { ...ures.headers };
  delete h.connection;
  delete h["keep-alive"];
  return h;
}

/**
 * A user's CloudCLI process. `spawn(opts)` returns a ChildProcess-like object (tests pass fake children).
 */
class UserProcess {
  constructor(router, email) {
    this.router = router;
    this.email = email;
    this.key = userKey(email);
    this.port = 0;
    this.child = null;
    this.ready = null;       // Promise resolved when /health answers
    this.lastActivity = Date.now();
    this.inflight = 0;       // HTTP requests in progress
    this.sockets = new Set();// upgraded (WebSocket) client sockets
    this.stopping = false;
    this.exited = false;
  }
  touch() { this.lastActivity = this.router.now(); }

  async start() {
    const r = this.router;
    const home = path.join(r.homeRoot, this.key);
    const claudeDir = path.join(r.jfsRoot, "users", this.key, "claude");
    await r.makeDir(home, 0o700);
    await r.makeDir(path.join(r.jfsRoot, "users", this.key), 0o755);
    await r.makeDir(claudeDir, 0o700);
    const link = path.join(home, ".claude");
    let current = null;
    try { current = await readlink(link); } catch { /* none */ }
    if (current !== claudeDir) {
      try { await lstat(link); await unlink(link); } catch { /* none */ }
      await symlink(claudeDir, link);
    }
    this.port = await freePort();
    const env = {
      PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
      NODE_ENV: "production",
      TZ: process.env.TZ || "UTC",
      VITE_IS_PLATFORM: "true",
      HOST: "127.0.0.1",
      SERVER_PORT: String(this.port),
      HOME: home,
      DATABASE_URL: process.env.DATABASE_URL || "",
      DATABASE_SCHEMA: `cc_${this.key}`,
      JWT_SECRET: process.env.JWT_SECRET || "",
      JARVIS_WEB_URL: process.env.JARVIS_WEB_URL || "",
      JARVIS_CC_TOKEN: process.env.JARVIS_CC_TOKEN || "",
      JARVIS_CC_OWNER: this.email,
      JARVIS_JFS_ROOT: r.jfsRoot,
    };
    const args = [`--max-old-space-size=${r.childHeapMb}`, r.serverEntry];
    log("info", "process start", { user: this.key, port: this.port });
    const child = r.spawnImpl(process.execPath, args, { env, cwd: home, stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    const pipeLines = (stream, level) => {
      if (!stream) return;
      let buf = "";
      stream.setEncoding?.("utf8");
      stream.on("data", (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (line.trim()) log(level, "process output", { user: this.key, line: line.slice(0, 4000) });
        }
        if (buf.length > 16384) { log(level, "process output", { user: this.key, line: buf.slice(0, 4000) }); buf = ""; }
      });
    };
    pipeLines(child.stdout, "info");
    pipeLines(child.stderr, "warn");
    const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    exited.then(({ code, signal }) => {
      this.exited = true;
      log(this.stopping ? "info" : "warn", "process exit", { user: this.key, code, signal });
      r.forget(this);
      for (const s of this.sockets) s.destroy();
    });
    this.exitedPromise = exited;
    const deadline = r.now() + r.startMs;
    while (r.now() < deadline) {
      if (this.exited) throw new Error("the process exited while starting");
      if (await this.#healthy()) { log("info", "process ready", { user: this.key, port: this.port }); return; }
      await sleep(200);
    }
    await this.stop("start timeout");
    throw new Error("the process did not start in time");
  }

  #healthy() {
    return new Promise((resolve) => {
      const q = http.get({ host: "127.0.0.1", port: this.port, path: "/health", timeout: 2000 }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      q.on("timeout", () => q.destroy());
      q.on("error", () => resolve(false));
    });
  }

  /** Running chats (CloudCLI's GET /api/providers/sessions/running); null when it can't tell. */
  runningChats() {
    return new Promise((resolve) => {
      const q = http.get({ host: "127.0.0.1", port: this.port, path: "/api/providers/sessions/running", timeout: 5000,
                          headers: { "x-jarvis-user": this.email } }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { if (body.length < 1 << 20) body += c; });
        res.on("end", () => {
          if (res.statusCode !== 200) return resolve(null);
          try {
            const j = JSON.parse(body);
            const s = j?.data?.sessions ?? j?.sessions;
            resolve(Array.isArray(s) ? s.length : null);
          } catch { resolve(null); }
        });
      });
      q.on("timeout", () => q.destroy());
      q.on("error", () => resolve(null));
    });
  }

  async stop(reason) {
    if (this.stopping) return this.exitedPromise;
    this.stopping = true;
    log("info", "process stop", { user: this.key, reason });
    for (const s of this.sockets) s.destroy();
    if (!this.child || this.exited) return;
    this.child.kill("SIGTERM");
    const t = setTimeout(() => { if (!this.exited) this.child.kill("SIGKILL"); }, this.router.killAfterMs);
    t.unref?.();
    await this.exitedPromise;
    clearTimeout(t);
  }
}

export class Router {
  constructor(o = {}) {
    const cfgPath = o.configPath ?? process.env.JARVIS_CONFIG ?? "/etc/jarvis/config.json";
    this.config = o.config ?? JSON.parse(readFileSync(cfgPath, "utf8"));
    const a = this.config.access ?? {};
    const jwks = o.jwks ?? (a.jwksFile ? JSON.parse(readFileSync(a.jwksFile, "utf8")) : undefined);
    const also = Array.isArray(a.also) ? a.also : [];
    this.verifier = o.verifier ?? (also.length
      ? new TeamsVerifier([{ teamDomain: a.teamDomain, audience: a.audience }, ...also].map((t) => new AccessVerifier({ ...t, jwks })))
      : new AccessVerifier({ teamDomain: a.teamDomain, audience: a.audience, jwks }));
    // `users`: emails, or "@domain" for everyone at that email domain (YYC: "@yyc.hk", signing in with Access's emailed
    // code); Access checks the same list, so the router admits no one Access didn't
    const entries = (this.config.users ?? []).map((u) => String(u).trim().toLowerCase());
    this.users = new Set(entries.filter((u) => !u.startsWith("@")));
    this.domains = new Set(entries.filter((u) => u.startsWith("@") && u.length > 1).map((u) => u.slice(1)));
    this.admins = new Set((this.config.admins ?? []).map((u) => String(u).trim().toLowerCase()));
    this.webUrl = o.webUrl ?? process.env.JARVIS_WEB_URL ?? "";
    this.ccToken = o.ccToken ?? process.env.JARVIS_CC_TOKEN ?? "";
    this.serverEntry = o.serverEntry ?? process.env.JARVIS_UI_SERVER ?? path.join(HERE, "..", "dist-server", "server", "index.js");
    this.homeRoot = o.homeRoot ?? process.env.JARVIS_UI_HOME_ROOT ?? "/var/lib/cloudcli/home";
    this.jfsRoot = o.jfsRoot ?? process.env.JARVIS_JFS_ROOT ?? "/jfs";
    this.maxUsers = o.maxUsers ?? Number(process.env.JARVIS_UI_MAX_USERS || 6);
    this.idleMs = o.idleMs ?? Number(process.env.JARVIS_UI_IDLE_MINUTES || 30) * 60_000;
    this.drainMs = o.drainMs ?? Number(process.env.JARVIS_UI_DRAIN_SECONDS || 900) * 1000;
    this.startMs = o.startMs ?? Number(process.env.JARVIS_UI_START_SECONDS || 60) * 1000;
    this.childHeapMb = o.childHeapMb ?? Number(process.env.JARVIS_UI_CHILD_HEAP_MB || 256);
    this.killAfterMs = o.killAfterMs ?? 10_000;
    this.sweepMs = o.sweepMs ?? 60_000;
    // Recently deleted (server/modules/jarvis/jarvis-purge.ts): a person's process purges their expired deletions; once
    // a day this replica starts the process of each person it serves who has some and isn't using the app
    this.purgeFirstMs = o.purgeFirstMs ?? 10 * 60_000;
    this.purgeEveryMs = o.purgeEveryMs ?? 24 * 3600_000;
    this.expiredCheck = o.expiredCheck ?? ((email) => hasExpiredDeletions(email));
    this.peersName = o.peers ?? process.env.JARVIS_UI_PEERS ?? "";
    this.selfIp = o.selfIp ?? process.env.POD_IP ?? "";
    this.port = o.port ?? Number(process.env.PORT || 8080);
    this.host = o.host ?? undefined;
    this.uid = o.uid ?? Number(process.env.JARVIS_UID || 1000);
    // The native app's sign-in callback scheme (GET /api/jarvis/app-signin); unset = the endpoint is off.
    this.appScheme = o.appScheme ?? process.env.JARVIS_APP_SCHEME ?? "";
    // The signed-out shell (top of this file); null or a folder without index.html = off (401 as for any other path)
    const dist = o.distDir !== undefined ? o.distDir : (process.env.JARVIS_UI_DIST || path.join(HERE, "..", "dist"));
    this.distDir = dist && existsSync(path.join(dist, "index.html")) ? path.resolve(dist) : null;
    this.productName = String(o.productName ?? process.env.JARVIS_PRODUCT_NAME ?? this.config.product?.name ?? "").trim() || "YYC AI";
    this.spawnImpl = o.spawn ?? nodeSpawn;
    this.resolve = o.resolve ?? ((name) => dns.resolve4(name));
    this.now = o.now ?? (() => Date.now());
    this.procs = new Map();  // email -> UserProcess
    this.peers = [];
    this.seen = new Map();   // peer address -> when DNS last listed it (draining replicas stay reachable a while)
    this.forwarded = new Set(); // WebSockets passed on to another replica: {socket, peer, key}
    this.holderCache = new Map(); // email -> {peer, until}
    this.holderTtlMs = o.holderTtlMs ?? 2000;
    const peerSecret = o.peerSecret ?? this.ccToken;
    this.peerAuth = peerSecret ? createHash("sha256").update(`jarvis-ui-peer|${peerSecret}`).digest("hex") : "";
    this.draining = false;
    this.server = http.createServer((req, res) => this.#onRequest(req, res));
    this.server.on("upgrade", (req, socket, head) => this.#onUpgrade(req, socket, head));
    this.server.keepAliveTimeout = 65_000;
    this.server.headersTimeout = 70_000;
    this.server.requestTimeout = 0;  // long SSE/streams
  }

  async makeDir(dir, mode) {
    await mkdir(dir, { recursive: true, mode });
    if (process.getuid?.() === 0) await chown(dir, this.uid, this.uid).catch(() => {});
  }

  forget(p) { if (this.procs.get(p.email) === p) this.procs.delete(p.email); }

  async listen() {
    await this.refreshPeers();
    await new Promise((r) => this.server.listen(this.port, this.host, r));
    this.port = this.server.address().port;
    this.sweeper = setInterval(() => void this.sweep(), this.sweepMs);
    this.sweeper.unref();
    this.purgeFirst = setTimeout(() => void this.purgeWake(), this.purgeFirstMs);
    this.purgeFirst.unref();
    this.purgeTimer = setInterval(() => void this.purgeWake(), this.purgeEveryMs);
    this.purgeTimer.unref();
    if (this.peersName) {
      this.peerTimer = setInterval(() => void this.refreshPeers(), 5000);
      this.peerTimer.unref();
    }
    log("info", "router listening", { port: this.port, users: this.users.size, maxUsers: this.maxUsers, peers: this.peersName || null });
  }

  async refreshPeers() {
    if (!this.peersName) return;
    try {
      const ips = await this.resolve(this.peersName);
      this.peers = [...new Set(ips)].sort();
    } catch (e) {
      // no ready replica (this one starting): serve locally
      this.peers = [];
    }
    const now = this.now();
    for (const ip of this.peers) this.seen.set(ip, now);
    // a replica that left DNS may still be draining for up to drainMs (+ preStop)
    for (const [ip, at] of this.seen) if (now - at > this.drainMs + 120_000) this.seen.delete(ip);
  }

  /**
   * The replica (address) that should serve `email` by the hash, or null for this one. A replica that is draining, or
   * is missing from a non-empty list of ready replicas (its preStop pause, or not ready yet), never names itself, so
   * it agrees with the ready ones.
   */
  ownerFor(email) {
    if (!this.peersName || !this.selfIp) return null;
    const others = this.peers.filter((p) => p !== this.selfIp);
    const selfOut = this.draining || (this.peers.length > 0 && !this.peers.includes(this.selfIp));
    const o = ownerOf(userKey(email), selfOut ? others : [...others, this.selfIp]);
    return o && o !== this.selfIp ? o : null;
  }

  /** This replica's live (not stopping) process for a user key, if any. */
  #procByKey(key) {
    for (const p of this.procs.values()) if (p.key === key && !p.stopping && !p.exited) return p;
    return null;
  }

  /** GET /__jarvis/peer/holds?key=<userKey> from another replica: {holds, running, draining}. */
  async #peerHolds(req, res) {
    const given = String(req.headers[PEER_AUTH] || "");
    const ok = this.peerAuth && given.length === this.peerAuth.length && timingSafeEqual(Buffer.from(given), Buffer.from(this.peerAuth));
    if (!ok) { res.writeHead(404); return res.end(); }
    const key = new URL(req.url, "http://x").searchParams.get("key") || "";
    const p = this.#procByKey(key);
    const running = p ? await p.runningChats() : 0;
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ holds: !!p, running, draining: this.draining }));
  }

  /** Ask one replica about a user key; null when it can't be asked (a replica that refuses connections is forgotten). */
  peerState(peer, key) {
    if (!this.peerAuth) return Promise.resolve(null);
    return new Promise((resolve) => {
      const q = http.get({ host: peer, port: this.port, path: `${PEER_PATH}?key=${encodeURIComponent(key)}`, timeout: 2000,
                          headers: { [PEER_AUTH]: this.peerAuth } }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { if (body.length < 4096) body += c; });
        res.on("end", () => {
          if (res.statusCode !== 200) return resolve(null);
          try { resolve(JSON.parse(body)); } catch { resolve(null); }
        });
      });
      // a replica that has gone (its address answers nothing) must not cost every later lookup the full timeout
      let connected = false;
      q.on("socket", (sock) => sock.once("connect", () => { connected = true; }));
      const connectTimer = setTimeout(() => { if (!connected) q.destroy(Object.assign(new Error("connect timeout"), { code: "ECONNTIMEOUT" })); }, 1000);
      q.on("close", () => clearTimeout(connectTimer));
      q.on("timeout", () => q.destroy(new Error("timeout")));
      q.on("error", (e) => {
        if (["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ECONNTIMEOUT"].includes(e.code) && !this.peers.includes(peer)) this.seen.delete(peer);
        resolve(null);
      });
    });
  }

  /**
   * Another replica that already holds `email`'s process and should keep serving it: one with a chat running first,
   * else one that is not draining. Cached for holderTtlMs.
   */
  async #holder(email) {
    if (!this.peersName || !this.peerAuth) return null;
    const hit = this.holderCache.get(email);
    if (hit && hit.until > this.now()) return hit.peer;
    const key = userKey(email);
    const peers = [...new Set([...this.peers, ...this.seen.keys()])].filter((p) => p !== this.selfIp);
    const states = await Promise.all(peers.map(async (peer) => ({ peer, s: await this.peerState(peer, key) })));
    const held = states.filter(({ s }) => s?.holds);
    const pick = held.find(({ s }) => s.running === null || s.running > 0) ?? held.find(({ s }) => !s.draining);
    const peer = pick ? pick.peer : null;
    this.holderCache.set(email, { peer, until: this.now() + this.holderTtlMs });
    return peer;
  }

  /**
   * Where a request for `email` goes: {peer, hop} to pass it on, or {local: true} to serve it here (starting the
   * process if needed). Hop "1" = sent to the hash owner (it may pass it once more, to the replica holding the
   * person's process); hop "2" = final.
   */
  async #route(req, email) {
    const hop = String(req.headers[HOP] || "");
    if (this.#procByKey(userKey(email))) return { local: true };
    if (hop !== "2") {
      if (!hop) {
        const owner = this.ownerFor(email);
        if (owner) return { peer: owner, hop: "1" };
      }
      const holder = await this.#holder(email);
      if (holder) return { peer: holder, hop: "2" };
    }
    if (this.draining) {
      // never start a process here: hand it to a ready replica, which serves it
      const owner = this.ownerFor(email);
      return owner ? { peer: owner, hop: "2" } : { local: true };
    }
    return { local: true };
  }

  /** a person of this instance: listed by email, or at a listed "@domain" */
  allowed(email) {
    const e = String(email || "").toLowerCase();
    if (this.users.has(e)) return true;
    const at = e.lastIndexOf("@");
    return at > 0 && this.domains.has(e.slice(at + 1));
  }

  async #identify(req) {
    const token = accessToken(req);
    if (!token) return { status: 401 };
    let email;
    try { email = await this.verifier.email(token); } catch { return { status: 401 }; }
    if (!this.allowed(email)) return { status: 403, email };
    return { status: 200, email };
  }

  async #process(email) {
    let p = this.procs.get(email);
    if (p && !p.stopping) { await p.ready; return p; }
    if (this.draining) throw Object.assign(new Error("draining"), { status: 503 });
    if (this.procs.size >= this.maxUsers) await this.#evict();
    if (this.procs.size >= this.maxUsers) throw Object.assign(new Error("busy"), { status: 503 });
    p = new UserProcess(this, email);
    this.procs.set(email, p);
    p.ready = p.start().catch((e) => { this.forget(p); throw e; });
    await p.ready;
    return p;
  }

  /** Make room: stop the least recently used process with no traffic in flight and no running chat. */
  async #evict() {
    const cands = [...this.procs.values()].filter((p) => !p.stopping && p.inflight === 0).sort((a, b) => a.lastActivity - b.lastActivity);
    for (const p of cands) {
      const running = await p.runningChats();
      if (running === 0) { await p.stop("evicted for another user"); return; }
    }
  }

  /**
   * Starts the process of every person this replica serves who has conversations past their 30 days in Recently
   * deleted and no process: it purges them on start (jarvis-purge.ts) and stops again when idle, like any other.
   */
  async purgeWake() {
    if (this.draining) return;
    for (const email of this.users) {
      if (this.procs.has(email) || this.ownerFor(email)) continue;
      let expired = false;
      try { expired = await this.expiredCheck(email); } catch (e) { log("warn", "purge check failed", { user: userKey(email), error: String(e.message || e) }); }
      if (!expired) continue;
      log("info", "starting a process to purge Recently deleted", { user: userKey(email) });
      await this.#process(email).catch((e) => log("warn", "purge start failed", { user: userKey(email), error: String(e.message || e) }));
    }
  }

  /** Stop processes idle for idleMs with no running chat (a process that can't tell is kept until twice that). */
  async sweep() {
    const now = this.now();
    for (const p of [...this.procs.values()]) {
      if (p.stopping || p.inflight > 0) continue;
      const idle = now - p.lastActivity;
      if (idle < this.idleMs) continue;
      const running = await p.runningChats();
      if (running === 0 || (running === null && idle >= 2 * this.idleMs)) await p.stop(`idle ${Math.round(idle / 60000)} min`);
    }
  }

  async #onRequest(req, res) {
    const url = req.url || "/";
    if (url === "/healthz" || url === "/readyz") {
      const ok = !(url === "/readyz" && this.draining);
      res.writeHead(ok ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify({ ok, draining: this.draining, processes: this.procs.size }));
    }
    if (url.startsWith(PEER_PATH)) return this.#peerHolds(req, res);
    const who = await this.#identify(req);
    if (who.status === 401 && this.distDir && (req.method === "GET" || req.method === "HEAD")) {
      if (await this.#shell(req, res)) return;
    }
    if (who.status === 401) return page(res, 401, "未登入", "請重新整理頁面登入。Not signed in: reload the page to sign in.");
    if (who.status === 403) return page(res, 403, "沒有權限", `${who.email} 沒有使用 YYC AI 的權限。This account is not allowed.`);
    if (url === "/ops" || url.startsWith("/ops/") || url.startsWith("/ops?")) return this.#ops(req, res, who.email);
    if (url === "/api/jarvis/me" || url.startsWith("/api/jarvis/me?")) return this.#me(req, res, who.email);
    if (url === "/api/jarvis/app-signin" || url.startsWith("/api/jarvis/app-signin?")) return this.#appSignin(req, res);
    if (url === "/api/jarvis/signin" || url.startsWith("/api/jarvis/signin?")) return this.#signin(req, res);
    // A bare signed-in prefix opened as a page lands on the app: Access sends a sign-in that started from its own login
    // page (not from 「登入」) back to the app's first path, /api, which CloudCLI answers 404 (Deyao, 2026-10-28)
    if ((req.method === "GET" || req.method === "HEAD") && ["/api", "/api/", "/ws", "/paseo-ws"].includes(url)) {
      res.writeHead(302, { location: "/", "cache-control": "no-store" });
      return res.end();
    }
    const route = await this.#route(req, who.email);
    if (route.peer) return this.#forwardHttp(req, res, route.peer, route.hop, who.email);
    let p;
    try {
      p = await this.#process(who.email);
    } catch (e) {
      log("warn", "no process", { user: userKey(who.email), error: String(e.message || e) });
      res.setHeader("retry-after", "5");
      return page(res, 503, "暫時未能使用", "系統繁忙，請稍後再試。The service is busy, try again shortly.");
    }
    p.inflight++;
    p.touch();
    let finished = false;
    const done = () => { if (!finished) { finished = true; p.inflight--; p.touch(); } };
    const up = http.request({ host: "127.0.0.1", port: p.port, method: req.method, path: url, headers: upstreamHeaders(req, who.email) }, (ures) => {
      res.writeHead(ures.statusCode || 502, ures.statusMessage, responseHeaders(ures));
      ures.on("data", () => p.touch());
      ures.pipe(res);
      ures.on("end", done);
      ures.on("error", () => { done(); res.destroy(); });
    });
    res.on("close", () => { if (!res.writableFinished) up.destroy(); done(); });
    up.on("error", (e) => {
      done();
      log("warn", "proxy error", { user: p.key, error: e.message });
      if (!res.headersSent) page(res, 502, "暫時未能使用", "請重新整理頁面。Reload the page.");
      else res.destroy();
    });
    req.pipe(up);
  }

  /** GET /api/jarvis/me: {firstName} for the empty chat's greeting (answered here, no CloudCLI process needed). */
  async #me(req, res, email) {
    const firstName = await this.verifier.firstName(accessToken(req), email).catch(() => null);
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ firstName }));
  }

  /**
   * GET /api/jarvis/app-signin?state=…: the native app's sign-in. The app opens this URL in ASWebAuthenticationSession,
   * Access signs the person in as usual (Google or an emailed code), and this answers with a redirect to the app's own
   * scheme (JARVIS_APP_SCHEME, the only target) carrying the caller's own Access token and the app's state, which the app
   * checks against the one it sent. The token is the CF_Authorization cookie Access just set for this host (else the
   * Cf-Access-Jwt-Assertion header); the app then sends it as a cookie/`cf-access-token` header on its API and WebSocket
   * calls. It travels in the fragment, so it is never in a server log or a Referer.
   */
  #appSignin(req, res) {
    if (!this.appScheme) return page(res, 404, "Not found", "Not found.");
    if (req.method !== "GET") return page(res, 405, "Not allowed", "GET only.");
    const state = new URL(req.url, "http://x").searchParams.get("state") || "";
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(state)) return page(res, 400, "Bad request", "Bad state.");
    const m = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(req.headers.cookie || "");
    const token = m ? decodeURIComponent(m[1]) : accessToken(req);
    res.writeHead(302, {
      location: `${this.appScheme}://signed-in?state=${state}#token=${encodeURIComponent(token)}`,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    });
    res.end();
  }

  /**
   * The signed-out shell (top of this file): a built file of the web app, or for a page path its index.html marked
   * signed out. Answers false (nothing sent) for anything else, which then gets the 401.
   */
  async #shell(req, res) {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch { return false; }
    if (needsSignIn(pathname) || pathname.includes("\0")) return false;
    const head = { "x-content-type-options": "nosniff", "referrer-policy": "same-origin" };
    if (path.extname(pathname)) {
      const file = path.resolve(this.distDir, "." + path.posix.normalize(pathname));
      if (!file.startsWith(this.distDir + path.sep)) return false;
      const st = await stat(file).catch(() => null);
      if (!st?.isFile()) return false;
      const ext = path.extname(file).toLowerCase();
      const hashed = pathname.startsWith("/_expo/static/") || /[.-][0-9a-f]{16,}\.[a-z0-9]+$/i.test(pathname);
      res.writeHead(200, {
        ...head,
        "content-type": MIME[ext] ?? "application/octet-stream",
        "content-length": st.size,
        "cache-control": ext === ".html" ? "no-store" : hashed ? "public, max-age=31536000, immutable" : "public, max-age=300",
      });
      if (req.method === "HEAD") return res.end(), true;
      res.end(await readFile(file));
      return true;
    }
    const name = this.productName.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    const html = (await readFile(path.join(this.distDir, "index.html"), "utf8"))
      .replace(/<title>[^<]*<\/title>/, `<title>${name}</title>`)
      .replace(/(<meta name="apple-mobile-web-app-title" content=")[^"]*(")/, `$1${name}$2`)
      .replace(/<\/head>/i, `<meta name="yyc-signed-out" content="1"></head>`);
    res.writeHead(200, { ...head, "content-type": "text/html; charset=utf-8", "cache-control": "no-store", vary: "cookie" });
    res.end(req.method === "HEAD" ? undefined : html);
    return true;
  }

  /**
   * GET /api/jarvis/signin?next=/path: the web page's 「登入」. Access has signed the person in by the time this runs
   * (the path is behind it), so it only sends them back to the page they were on (a same-origin path, else /).
   */
  #signin(req, res) {
    const next = new URL(req.url, "http://x").searchParams.get("next") || "/";
    const safe = /^\/(?![\/\\])[^\s]*$/.test(next) && !needsSignIn(next.split(/[?#]/)[0]) ? next : "/";
    res.writeHead(302, { location: safe, "cache-control": "no-store", "referrer-policy": "no-referrer" });
    res.end();
  }

  /** The operator page: admins only, read-only, forwarded to web's /internal/ops/* (see the top of this file). */
  #ops(req, res, email) {
    if (!this.admins.has(email)) return page(res, 403, "Not allowed", `${email} is not an operator of this instance.`);
    if (req.method !== "GET" && req.method !== "HEAD") return page(res, 405, "Not allowed", "Read-only.");
    const u = new URL(req.url, "http://x");
    // only /ops itself or below it once dot segments are resolved (never another /internal path)
    if (u.pathname !== "/ops" && !u.pathname.startsWith("/ops/")) return page(res, 404, "Not found", "Not found.");
    if (u.pathname === "/ops") { res.writeHead(302, { location: "/ops/", "cache-control": "no-store" }); return res.end(); }
    if (!this.webUrl || !this.ccToken) return page(res, 503, "Not configured", "JARVIS_WEB_URL / JARVIS_CC_TOKEN are not set.");
    const target = new URL("/internal" + u.pathname + u.search, this.webUrl);
    const up = http.request(target, { method: req.method, headers: { authorization: `Bearer ${this.ccToken}`, "x-jarvis-user": email, accept: String(req.headers.accept || "*/*") }, timeout: 30_000 }, (ures) => {
      res.writeHead(ures.statusCode || 502, ures.statusMessage, responseHeaders(ures));
      ures.pipe(res);
    });
    res.on("close", () => { if (!res.writableFinished) up.destroy(); });
    up.on("timeout", () => up.destroy(new Error("timeout")));
    up.on("error", (e) => {
      log("warn", "ops proxy error", { error: e.message });
      if (!res.headersSent) page(res, 502, "Not reachable", "The control plane did not answer; reload in a moment.");
      else res.destroy();
    });
    up.end();
  }

  #forwardHttp(req, res, owner, hop, email) {
    const up = http.request({ host: owner, port: this.port, method: req.method, path: req.url, headers: { ...upstreamHeaders(req, null), [HOP]: hop } }, (ures) => {
      res.writeHead(ures.statusCode || 502, ures.statusMessage, responseHeaders(ures));
      ures.pipe(res);
    });
    res.on("close", () => { if (!res.writableFinished) up.destroy(); });
    up.on("error", (e) => {
      log("warn", "peer unreachable", { peer: owner, error: e.message });
      this.peers = this.peers.filter((x) => x !== owner);
      this.holderCache.delete(email);
      if (!res.headersSent) { res.setHeader("retry-after", "1"); page(res, 503, "請重新整理", "請重新整理頁面。Reload the page."); }
      else res.destroy();
    });
    req.pipe(up);
  }

  async #onUpgrade(req, socket, head) {
    socket.on("error", () => {});
    const who = await this.#identify(req);
    if (who.status !== 200) return rejectUpgrade(socket, who.status, "not allowed\n");
    const route = await this.#route(req, who.email);
    const owner = route.peer ?? null;
    let target, p = null;
    if (owner) {
      target = { host: owner, port: this.port, headers: { ...upstreamHeaders(req, null), [HOP]: route.hop } };
    } else {
      try { p = await this.#process(who.email); } catch { return rejectUpgrade(socket, 503, "busy\n"); }
      target = { host: "127.0.0.1", port: p.port, headers: upstreamHeaders(req, who.email) };
    }
    const up = http.request({ ...target, method: req.method, path: req.url });
    up.on("upgrade", (ures, usock, uhead) => {
      let raw = `HTTP/1.1 101 Switching Protocols\r\n`;
      for (let i = 0; i < ures.rawHeaders.length; i += 2) raw += `${ures.rawHeaders[i]}: ${ures.rawHeaders[i + 1]}\r\n`;
      socket.write(raw + "\r\n");
      if (uhead?.length) socket.write(uhead);
      if (head?.length) usock.write(head);
      usock.on("error", () => socket.destroy());
      if (p) {
        p.sockets.add(socket);
        p.touch();
        // any traffic either way is activity
        usock.on("data", () => p.touch());
        socket.on("data", () => p.touch());
        socket.on("close", () => { p.sockets.delete(socket); p.touch(); });
      } else {
        // passed on to another replica: kept while that replica runs a chat for this person when we drain
        const f = { socket, peer: owner, key: userKey(who.email) };
        this.forwarded.add(f);
        socket.on("close", () => this.forwarded.delete(f));
      }
      socket.pipe(usock).pipe(socket);
      socket.on("close", () => usock.destroy());
      usock.on("close", () => socket.destroy());
    });
    up.on("response", (ures) => {
      // the upstream refused the upgrade: pass its answer on
      let raw = `HTTP/1.1 ${ures.statusCode} ${ures.statusMessage}\r\n`;
      for (let i = 0; i < ures.rawHeaders.length; i += 2) raw += `${ures.rawHeaders[i]}: ${ures.rawHeaders[i + 1]}\r\n`;
      socket.write(raw + "\r\n");
      ures.pipe(socket);
    });
    up.on("error", (e) => {
      if (owner) { this.peers = this.peers.filter((x) => x !== owner); this.holderCache.delete(who.email); }
      log("warn", "upgrade proxy error", { error: e.message, peer: owner });
      rejectUpgrade(socket, 502, "upstream error\n");
    });
    up.end();
  }

  /**
   * Graceful stop (SIGTERM): readiness turns 503 (Kubernetes has taken the pod out of the Services during preStop).
   * The listener stays open for requests the other replicas pass on to a process held here. Running chats get up to
   * drainMs to finish: this replica's own processes with a running chat, and WebSockets passed on to another replica
   * while that replica reports a chat running for the person (other forwarded WebSockets are closed at once; the tab
   * reconnects through a ready replica). Then every process stops and the listener closes.
   */
  async drain() {
    if (this.draining) return;
    this.draining = true;
    this.holderCache.clear();
    log("info", "draining", { processes: this.procs.size, forwarded: this.forwarded.size });
    const deadline = this.now() + this.drainMs;
    let first = true;
    while (this.now() < deadline) {
      let busy = 0;
      for (const p of this.procs.values()) {
        const r = await p.runningChats();
        if (r === null ? p.inflight > 0 : r > 0) busy++;
      }
      const forwardedBusy = await this.#checkForwarded();
      if (!busy && !forwardedBusy) break;
      if (first || busy || forwardedBusy) log("info", "waiting for running chats", { processes: busy, forwarded: forwardedBusy });
      first = false;
      await sleep(Math.min(5000, Math.max(50, deadline - this.now())));
    }
    await Promise.all([...this.procs.values()].map((p) => p.stop("shutdown")));
    for (const f of this.forwarded) f.socket.destroy();
    this.server.close();
    this.server.closeAllConnections?.();
    clearInterval(this.sweeper);
    clearTimeout(this.purgeFirst);
    clearInterval(this.purgeTimer);
    clearInterval(this.peerTimer);
    log("info", "drained");
  }

  /** While draining: close forwarded WebSockets whose replica runs no chat for the person; count the others. */
  async #checkForwarded() {
    const groups = new Map();
    for (const f of this.forwarded) {
      if (f.socket.destroyed) { this.forwarded.delete(f); continue; }
      const k = `${f.peer}|${f.key}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(f);
    }
    let busy = 0;
    await Promise.all([...groups.values()].map(async (fs) => {
      const s = await this.peerState(fs[0].peer, fs[0].key);
      if (s?.holds && (s.running === null || s.running > 0)) { busy += fs.length; return; }
      for (const f of fs) { f.socket.destroy(); this.forwarded.delete(f); }
      log("info", "forwarded connection closed", { peer: fs[0].peer, user: fs[0].key, sockets: fs.length });
    }));
    return busy;
  }
}

async function main() {
  const r = new Router();
  await r.listen();
  let stopping = false;
  const stop = async (sig) => {
    if (stopping) return;
    stopping = true;
    log("info", "signal", { signal: sig });
    await r.drain();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
}

// run as a program (also when started through a symlink, e.g. a ConfigMap mount)
const isMain = (() => { try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); } catch { return false; } })();
if (isMain) {
  main().catch((e) => { log("error", "router failed", { error: String(e?.stack || e) }); process.exit(1); });
}
