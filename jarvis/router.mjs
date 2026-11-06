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
// name or null, for the empty chat's greeting. /api/jarvis/relay too: the person's relay tokens for running Claude
// Code on their own computer on this instance's models (Router #relay; jarvis3 docs/CLAUDE-CODE.md "Relay"; env
// JARVIS_RELAY_URL, JARVIS_RELAY_ACCESS_ID, JARVIS_RELAY_ACCESS_SECRET).
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
// Sent files (DE0CH/jarvis3 docs/CLAUDE-CODE.md "Sent files"): POST /__jarvis/sent-files/snapshot, from egress's
// `sent-files` route only (bearer JARVIS_SENT_FILES_TOKEN, X-Jarvis-Conversation as egress verified it), is what
// Claude Code's PreToolUse hook on SendUserFile waits for: each file it is about to send is cloned copy-on-write
// (`juicefs clone`) from $JARVIS_JFS_ROOT/ws/<conversation>/<path> to sent/<conversation>/<toolUseId>/<path>, outside
// the sandbox's view, and the UI's file cards read that copy. Any replica serves it; no CloudCLI process is involved.
// Symlinks are refused; a file that is not there is skipped (SendUserFile reports it itself).
//
// View as (Deyao, 2026-10-28; DE0CH/jarvis3 docs/CHAT.md "View as"): an admin sees the app exactly as a staff member
// does, in a tab of its own. POST /api/jarvis/view-as (form field `user`, from the operator page's 「View as」, same
// origin only) by someone in config `admins` records the start in the operator page's History (web POST
// /internal/cc/view-as; nothing opens if it can't be recorded) and answers 303 to /#jarvis-view-as=<token>. The token
// (HMAC with a key derived from JARVIS_CC_TOKEN, so every replica checks it; VIEW_AS_HOURS long) names the admin, the
// person and the view's id; the page keeps it in that tab only (sessionStorage) and sends it as ?jarvis_view_as= (or
// the X-Jarvis-View-As header) on every API call, file link and socket. The router honours it only when the request's
// own Access identity is that admin, still in `admins`, and the person is still a user; anything else with a token is
// 403 (a non-admin can never become anyone). Honoured, the request goes to the PERSON's process as them
// (X-Jarvis-User), with X-Jarvis-Viewer / X-Jarvis-Viewer-Session naming the admin and the view (set here only, a
// client's copies are dropped), and the token taken off the URL. While viewing: GET/HEAD anything, POST only
// /api/jarvis/warm and /api/assets/files (an upload for a message), WebSocket only /paseo-ws, whose bridge
// (server/modules/paseo) records every message and new conversation sent as the person before sending it and refuses
// renames and deletes. Peers re-check the token like any request.
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
//   JARVIS_SENT_FILES_TOKEN [unset]   bearer of POST /__jarvis/sent-files/snapshot (egress's sent-files route); unset: off
//   JARVIS_JUICEFS [/usr/local/bin/juicefs]   the client used for copy-on-write clones (absent: a plain copy)
//   JARVIS_VIEW_AS_HOURS [12]         how long a view-as token lasts
//   JARVIS_UI_SWITCH_TOKEN, JARVIS_UI_LU_TOKEN, JARVIS_UI_PASS_ON_URL, JARVIS_UI_PURGE: the switch window (its section
//                                     at the end of this file)
//   passed to every process: DATABASE_URL, JWT_SECRET, JARVIS_WEB_URL, JARVIS_CC_TOKEN (plus the per-user contract env)
import { createHash, createHmac, createPublicKey, randomUUID, timingSafeEqual, verify as cryptoVerify } from "node:crypto";
import { execFile, spawn as nodeSpawn } from "node:child_process";
import { promises as dns } from "node:dns";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, readlink, symlink, unlink, chown, lstat, readFile, stat, realpath, copyFile, access } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Schedules, API_PATH as SCHEDULES_API, ADMIN_PATH as SCHEDULES_ADMIN, PAUSE_PATH as SCHEDULES_PAUSE, deliverKey } from "./schedules.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOP = "x-jarvis-ui-hop";
const PEER_AUTH = "x-jarvis-ui-peer";
const PEER_PATH = "/__jarvis/peer/holds";
const SENT_FILES_PATH = "/__jarvis/sent-files/snapshot";
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOOL_USE_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const VIEW_AS_PATH = "/api/jarvis/view-as";
export const RELAY_PATH = "/api/jarvis/relay";
export const VIEW_AS_PARAM = "jarvis_view_as";
const VIEW_AS_HEADER = "x-jarvis-view-as";
const VIEWER_HEADER = "x-jarvis-viewer";
const VIEWER_SESSION_HEADER = "x-jarvis-viewer-session";
/** The router's key on its own schedule deliveries to a person's process (schedules.mjs); a client's copy is dropped. */
const SCHEDULES_KEY_HEADER = "x-jarvis-schedules-key";
const SCHEDULES_PANEL = /^\/api\/jarvis\/sessions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/schedules$/i;
/** The only writes while viewing as someone (method, path): warming and an upload for a message sent with the override. */
const VIEW_AS_WRITES = [["POST", "/api/jarvis/warm"], ["POST", "/api/assets/files"]];
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

/** A view-as token: base64url(JSON {a: admin, u: person, s: view id, e: expiry in s}).base64url(HMAC-SHA256). */
export function signViewAs(key, claims) {
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

/** The claims of a valid, unexpired view-as token, else null. */
export function readViewAs(key, token, nowMs = Date.now()) {
  if (!key || typeof token !== "string" || token.length > 2048) return null;
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return null;
  const want = createHmac("sha256", key).update(body).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  let c;
  try { c = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return null; }
  if (!c || typeof c.a !== "string" || typeof c.u !== "string" || typeof c.s !== "string" || typeof c.e !== "number") return null;
  if (c.e * 1000 <= nowMs) return null;
  return c;
}

/** The view-as token a request carries (?jarvis_view_as= or X-Jarvis-View-As), or "". */
export function viewAsTokenOf(req) {
  const h = req.headers[VIEW_AS_HEADER];
  if (typeof h === "string" && h) return h;
  const url = req.url || "/";
  if (!url.includes(VIEW_AS_PARAM)) return "";
  try { return new URL(url, "http://x").searchParams.get(VIEW_AS_PARAM) || ""; } catch { return ""; }
}

/** The URL without its ?jarvis_view_as= (unchanged when it has none). */
export function withoutViewAs(url) {
  if (!url.includes(VIEW_AS_PARAM)) return url;
  const q = url.indexOf("?");
  if (q < 0) return url;
  const params = new URLSearchParams(url.slice(q + 1));
  if (!params.has(VIEW_AS_PARAM)) return url;
  params.delete(VIEW_AS_PARAM);
  const rest = params.toString();
  return url.slice(0, q) + (rest ? `?${rest}` : "");
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

  /** A first name already looked up for `email` (another person's, while an admin views as them), else null. */
  cachedFirstName(email) {
    const hit = this.#names.get(email);
    return hit && hit.until > this.#now() ? hit.name : null;
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
  cachedFirstName(email) {
    for (const v of this.#by.values()) { const n = v.cachedFirstName(email); if (n) return n; }
    return null;
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

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** The relay token page (Router #relay): plain, no script; forms post back to the same path. */
export function relayPage({ owner, tokens, created, setup, product }) {
  const when = (v) => (v ? esc(new Date(v).toISOString().slice(0, 16).replace("T", " ")) + " UTC" : "—");
  const rows = tokens.map((t) => `<li style="border-top:1px solid #ddd;padding:10px 0;display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap">
<span><b>${esc(t.label || "(no label)")}</b><br><small>建立 Created ${when(t.createdAt)} · 最後使用 Last used ${when(t.lastUsedAt)}</small></span>
<form method="post" style="margin:0"><input type="hidden" name="action" value="revoke"><input type="hidden" name="id" value="${esc(t.id)}"><button>撤銷 Revoke</button></form></li>`).join("");
  const fresh = created ? `<section style="border:2px solid #1A1A1E;padding:12px;margin:16px 0">
<p><b>新權杖只會顯示這一次。This token is shown only once.</b> 在終端機貼上以下內容，便會以 ${esc(owner)} 的身份使用 Claude Code。Paste this in a terminal to run Claude Code as ${esc(owner)}:</p>
<pre style="white-space:pre-wrap;word-break:break-all;background:#F4F4F5;padding:10px;font-size:13px">${esc(setup)}</pre></section>` : "";
  return `<!doctype html><html lang="zh-HK"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>Claude Code relay</title></head>
<body style="font-family:system-ui,sans-serif;padding:24px 16px;max-width:720px;margin:auto;color:#1A1A1E">
<h1 style="font-size:20px">Claude Code relay</h1>
<p>在自己的電腦上用 Claude Code，使用 ${esc(product)} 的模型；用量計入共用預算並記在你的名下（${esc(owner)}）。Run Claude Code on your own computer on ${esc(product)}'s models; usage counts toward the shared budget under your name.</p>
${fresh}
<form method="post" style="display:flex;gap:8px;flex-wrap:wrap;margin:16px 0"><input type="hidden" name="action" value="create">
<input name="label" maxlength="80" placeholder="名稱 Label (e.g. MacBook)" style="flex:1;min-width:180px;padding:6px">
<button>建立新權杖 New token</button></form>
<ul style="list-style:none;padding:0;margin:0">${rows || "<li><small>未有權杖。No tokens yet.</small></li>"}</ul>
</body></html>`;
}

function rejectUpgrade(socket, status, text) {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] || ""}\r\ncontent-type: text/plain\r\nconnection: close\r\ncontent-length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
}

/** A /workspace path (absolute, as Claude Code passes it) as a normalised relative path, or null outside it. */
export function workspaceRelative(abs) {
  if (typeof abs !== "string" || abs.includes("\0") || abs.length > 4096) return null;
  const p = path.posix.normalize(abs.replace(/^file:\/\//, ""));
  if (!p.startsWith("/workspace/")) return null;
  const rel = p.slice("/workspace/".length);
  if (!rel || rel === "." || rel.startsWith("../") || rel.split("/").includes("..")) return null;
  return rel;
}

/** The request body as text, at most `max` bytes (more is an error). */
function readLimited(req, max) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > max) { reject(new Error("too large")); req.destroy(); return; }
      parts.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Request headers for the user's process (`email` set) or another replica (`email` null): hop-by-hop headers dropped,
 * X-Jarvis-User and the viewer headers set by us only. A replica gets the view-as token as sent (it checks it again);
 * the process gets the viewer instead.
 */
function upstreamHeaders(req, email, extra = {}, viewer = null) {
  const h = { ...req.headers };
  for (const k of ["x-jarvis-user", VIEWER_HEADER, VIEWER_SESSION_HEADER, SCHEDULES_KEY_HEADER, HOP, PEER_AUTH, LU_HEADER, SWITCH_TOKEN_HEADER /* switch window */, "proxy-connection", "keep-alive", "te", "trailer"]) delete h[k];
  if (!req.headers.upgrade) delete h.connection;
  if (email) {
    h["x-jarvis-user"] = email;
    delete h[VIEW_AS_HEADER];
    if (viewer) {
      h[VIEWER_HEADER] = viewer.a;
      h[VIEWER_SESSION_HEADER] = viewer.s;
    }
  }
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
      ...r.sw.childEnv(), // switch window
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

  /**
   * For the switch module's restart: CloudCLI's GET /api/jarvis/switch/busy (jarvis-switch.routes.ts), the session ids
   * running (the running list), held by a Claude Code process (holds the running list misses), preparing a sandbox or
   * with a Paseo message pending; null when it can't tell.
   */
  switchBusy() {
    return new Promise((resolve) => {
      const q = http.get({ host: "127.0.0.1", port: this.port, path: "/api/jarvis/switch/busy", timeout: 5000,
                          headers: { "x-jarvis-user": this.email } }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { if (body.length < 1 << 20) body += c; });
        res.on("end", () => {
          if (res.statusCode !== 200) return resolve(null);
          try {
            const j = JSON.parse(body);
            const keys = ["running", "processes", "preparing", "pending"];
            resolve(keys.every((k) => Array.isArray(j?.[k])) ? Object.fromEntries(keys.map((k) => [k, j[k].length])) : null);
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

/**
 * The headers of an S3 request signed with AWS Signature V4 (path-style URL, no body): what the router needs to read
 * one object from Hetzner Object Storage without an SDK.
 */
export function s3Sign(method, url, { region, accessKey, secretKey }, now = new Date()) {
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const payload = "UNSIGNED-PAYLOAD";
  const headers = { host: url.host, "x-amz-content-sha256": payload, "x-amz-date": amzDate };
  const names = Object.keys(headers).sort();
  const canonical = [method, url.pathname, "", ...names.map((n) => `${n}:${headers[n]}`), "", names.join(";"), payload].join("\n");
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, createHash("sha256").update(canonical).digest("hex")].join("\n");
  let k = createHmac("sha256", `AWS4${secretKey}`).update(day).digest();
  for (const part of [region, "s3", "aws4_request"]) k = createHmac("sha256", k).update(part).digest();
  const signature = createHmac("sha256", k).update(toSign).digest("hex");
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` };
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
    // Relay tokens (jarvis3 docs/CLAUDE-CODE.md "Relay"; the page at RELAY_PATH): the relay host and the Access service
    // token every relay client sends; no JARVIS_RELAY_URL = the page is off
    this.relayUrl = String(o.relayUrl ?? process.env.JARVIS_RELAY_URL ?? "").replace(/\/$/, "");
    this.relayAccessId = o.relayAccessId ?? process.env.JARVIS_RELAY_ACCESS_ID ?? "";
    this.relayAccessSecret = o.relayAccessSecret ?? process.env.JARVIS_RELAY_ACCESS_SECRET ?? "";
    this.relayTokens = o.relayTokens ?? ((body) => this.#postRelayTokens(body));
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
    this.sentFilesToken = o.sentFilesToken ?? process.env.JARVIS_SENT_FILES_TOKEN ?? "";
    this.juicefs = o.juicefs ?? process.env.JARVIS_JUICEFS ?? "/usr/local/bin/juicefs";
    // The native app's sign-in callback scheme (GET /api/jarvis/app-signin); unset = the endpoint is off.
    this.appScheme = o.appScheme ?? process.env.JARVIS_APP_SCHEME ?? "";
    // The Android app's APK in the object store (GET /api/jarvis/android.apk); no endpoint = the download is off
    this.apk = o.apk ?? {
      endpoint: process.env.JARVIS_APK_S3_ENDPOINT || "",
      region: process.env.JARVIS_APK_S3_REGION || "fsn1",
      bucket: process.env.JARVIS_APK_S3_BUCKET || "",
      key: process.env.JARVIS_APK_S3_KEY || "",
      accessKey: process.env.JARVIS_APK_S3_ACCESS_KEY || "",
      secretKey: process.env.JARVIS_APK_S3_SECRET_KEY || "",
    };
    // View as (top of this file): the token key (none without JARVIS_CC_TOKEN: view-as is off), lifetime, and how a
    // start is recorded (web's /internal/cc/view-as; tests pass their own)
    const viewAsSecret = o.viewAsSecret ?? this.ccToken;
    this.viewAsKey = viewAsSecret ? createHash("sha256").update(`jarvis-view-as|${viewAsSecret}`).digest() : null;
    this.viewAsTtlMs = o.viewAsTtlMs ?? Number(process.env.JARVIS_VIEW_AS_HOURS || 12) * 3600_000;
    this.recordViewAs = o.recordViewAs ?? ((event) => this.#postViewAs(event));
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
    this.sw = new SwitchWindow(this, o); // switch window
    // Schedules (schedules.mjs): the AI's API, the panel, the admin page and firing; off without a database (or
    // `schedules: false` in tests)
    this.schedulesPool = o.schedulesPool ?? null;
    this.schedules = null;
    this.schedulesOff = o.schedules === false;
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

  /** The schedules store, made on first use (a pg Pool of DATABASE_URL); null when there is no database. */
  async schedulesStore() {
    if (this.schedulesOff) return null;
    if (this.schedules) return this.schedules;
    let pool = this.schedulesPool;
    if (!pool) {
      if (!process.env.DATABASE_URL) return null;
      const { default: pg } = await import("pg");
      pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
      pool.on("error", (e) => log("warn", "schedules pool error", { error: String(e.message || e) }));
    }
    this.schedules = new Schedules({
      pool,
      token: this.sentFilesToken,
      admins: this.admins,
      now: () => this.now(),
      log,
      // this replica fires for the persons it serves, never for one the switch moved (or while draining)
      servesHere: (email) => !this.draining && !this.ownerFor(email) && !this.sw.armedFor({ status: 200, email }),
      deliver: (email, body) => this.#deliverSchedule(email, body),
    });
    return this.schedules;
  }

  /** POST the person's process's /api/jarvis/schedules/deliver (starting the process if needed): its JSON answer. */
  async #deliverSchedule(email, body) {
    const p = await this.#process(email);
    p.touch();
    const data = JSON.stringify(body);
    return await new Promise((resolve, reject) => {
      const q = http.request({ host: "127.0.0.1", port: p.port, method: "POST", path: "/api/jarvis/schedules/deliver", timeout: 30_000,
        headers: { "x-jarvis-user": email, [SCHEDULES_KEY_HEADER]: deliverKey(this.ccToken), "content-type": "application/json",
          "content-length": Buffer.byteLength(data) } }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { if (text.length < 65536) text += c; });
        res.on("end", () => {
          if (res.statusCode !== 200) return reject(new Error(`the process answered ${res.statusCode}`));
          try { resolve(JSON.parse(text)); } catch { reject(new Error("the process answered no JSON")); }
        });
      });
      q.on("timeout", () => q.destroy(new Error("the process did not answer")));
      q.on("error", reject);
      q.end(data);
    });
  }

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
    void this.schedulesStore().then((s) => s?.start()).catch((e) => log("warn", "schedules off", { error: String(e.message || e) }));
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

  /** The AI's schedules API (schedules.mjs), from egress's `schedules` route. */
  async #schedulesApi(req, res) {
    const store = await this.schedulesStore().catch(() => null);
    if (!store) { req.resume(); res.writeHead(404, { "cache-control": "no-store" }); return res.end(); }
    let body = "";
    try { body = await readLimited(req, 64 * 1024); } catch {
      res.writeHead(413, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify({ code: "too_large", message: "the body is over 64 KiB" }));
    }
    return store.handleApi(req, res, body);
  }

  /** /ops/schedules and its pause switch, for an admin (schedules.mjs). */
  async #schedulesAdmin(req, res, actor) {
    const store = await this.schedulesStore().catch(() => null);
    if (!store) { req.resume(); return page(res, 404, "Not found", "Schedules are off here."); }
    let body = "";
    if (req.method === "POST") {
      try { body = await readLimited(req, 4096); } catch { /* too large: nothing set */ }
    } else req.resume();
    return store.handleAdmin(req, res, actor, body);
  }

  /** POST /__jarvis/sent-files/snapshot {toolUseId, files: [/workspace/…]}: copy-on-write copies (top of this file). */
  async #sentFilesSnapshot(req, res) {
    const answer = (status, body) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    const given = String(req.headers.authorization || "");
    const want = `Bearer ${this.sentFilesToken}`;
    const ok = this.sentFilesToken && given.length === want.length && timingSafeEqual(Buffer.from(given), Buffer.from(want));
    if (!ok) { req.resume(); return answer(404, { error: "not found" }); }
    if (req.method !== "POST") { req.resume(); return answer(405, { error: "POST only" }); }
    const conversation = String(req.headers["x-jarvis-conversation"] || "").toLowerCase();
    if (!CONVERSATION_ID.test(conversation)) { req.resume(); return answer(400, { error: "no conversation" }); }
    let body;
    try {
      const raw = await readLimited(req, 256 * 1024);
      body = JSON.parse(raw);
    } catch {
      return answer(400, { error: "the body is JSON {toolUseId, files}" });
    }
    const toolUseId = typeof body?.toolUseId === "string" ? body.toolUseId : "";
    const files = Array.isArray(body?.files) ? body.files : [];
    if (!TOOL_USE_ID.test(toolUseId) || files.length > 100 || !files.every((f) => typeof f === "string")) {
      return answer(400, { error: "toolUseId and files (paths) are required" });
    }
    const ws = path.join(this.jfsRoot, "ws", conversation);
    const dest = path.join(this.jfsRoot, "sent", conversation, toolUseId);
    const kept = [];
    const skipped = [];
    try {
      const realWs = await realpath(ws).catch(() => null);
      for (const abs of files) {
        const rel = workspaceRelative(abs);
        if (!rel) return answer(400, { error: `${abs} is not a file in /workspace` });
        const src = path.join(ws, ...rel.split("/"));
        const st = await lstat(src).catch(() => null);
        if (!st || !realWs) { skipped.push(rel); continue; }
        // only a plain file reached without a symlink anywhere on the way (the sandbox can link anywhere on the volume)
        if (!st.isFile() || (await realpath(src)) !== path.join(realWs, ...rel.split("/"))) {
          return answer(400, { error: `${rel} is not a plain file (symlinks and folders are not sent)` });
        }
        const dst = path.join(dest, ...rel.split("/"));
        if (await lstat(dst).catch(() => null)) { kept.push(rel); continue; } // a retried send: already kept
        await this.#mkdirOwned(path.dirname(dst));
        await this.#clone(src, dst);
        kept.push(rel);
      }
    } catch (e) {
      log("warn", "sent files snapshot failed", { conversation, toolUseId, error: String(e.message || e) });
      return answer(500, { error: String(e.message || e).slice(0, 300) });
    }
    log("info", "sent files kept", { conversation, toolUseId, kept: kept.length, skipped: skipped.length });
    answer(200, { kept, skipped });
  }

  /** mkdir -p, owned by JARVIS_UID when the router runs as root. */
  async #mkdirOwned(dir) {
    await mkdir(dir, { recursive: true });
    if (process.getuid?.() === 0) await chown(dir, this.uid, this.uid).catch(() => {});
  }

  /** A copy-on-write clone with the juicefs client (metadata only), or a plain copy where there is none. */
  async #clone(src, dst) {
    const haveJuicefs = await access(this.juicefs).then(() => true, () => false);
    if (!haveJuicefs) return copyFile(src, dst);
    await new Promise((resolve, reject) => {
      execFile(this.juicefs, ["clone", src, dst], { timeout: 30_000 }, (error, _stdout, stderr) => {
        if (error) reject(new Error(`juicefs clone: ${String(stderr || error.message).trim().slice(0, 200)}`));
        else resolve();
      });
    });
    if (process.getuid?.() === 0) await chown(dst, this.uid, this.uid).catch(() => {});
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

  /**
   * Who a request is: {status, email, actor, viewAs}. `actor` is the Access identity; `email` is whose data it reaches:
   * the actor, or the person an admin views as (a valid view-as token of this admin: top of this file). A token that
   * isn't the caller's own, has expired, or comes from a non-admin is 403 (`viewAsRefused`), never a fall-back.
   */
  async #identify(req) {
    const token = accessToken(req);
    if (!token) return { status: 401 };
    let email;
    try { email = await this.verifier.email(token); } catch { return { status: 401 }; }
    if (!this.allowed(email)) return { status: 403, email };
    const viewToken = viewAsTokenOf(req);
    if (!viewToken) return { status: 200, email, actor: email, viewAs: null };
    const claims = this.admins.has(email) ? readViewAs(this.viewAsKey, viewToken, this.now()) : null;
    if (!claims || claims.a !== email || !this.allowed(claims.u)) {
      log("warn", "view-as refused", { user: userKey(email), admin: this.admins.has(email) });
      return { status: 403, email, viewAsRefused: true };
    }
    return { status: 200, email: claims.u, actor: email, viewAs: claims };
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
    if (this.draining || !this.sw.purgeOn) return; // switch window: JARVIS_UI_PURGE=off
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
    if (url === SENT_FILES_PATH || url.startsWith(SENT_FILES_PATH + "?")) return this.#sentFilesSnapshot(req, res);
    if (url === SCHEDULES_API || url.startsWith(SCHEDULES_API + "/") || url.startsWith(SCHEDULES_API + "?")) return this.#schedulesApi(req, res);
    if (this.sw.handles(req, res)) return; // switch window: its endpoints, and the pass-on once armed for everyone
    const who = await this.#identify(req);
    if (this.sw.passOnPerson(req, res, who)) return; // switch window: the pass-on once armed for this person
    this.sw.httpStarted(req, res, who); // switch window
    if (who.status === 401 && this.distDir && (req.method === "GET" || req.method === "HEAD")) {
      if (await this.#shell(req, res)) return;
    }
    if (who.status === 401) return page(res, 401, "未登入", "請重新整理頁面登入。Not signed in: reload the page to sign in.");
    if (who.status === 403 && who.viewAsRefused) {
      res.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify({ success: false, error: { code: "VIEW_AS_REFUSED", message: "This view-as link is not valid for this account, or has expired." } }));
    }
    if (who.status === 403) return page(res, 403, "沒有權限", `${who.email} 沒有使用 YYC AI 的權限。This account is not allowed.`);
    const schedulesPath = url.split("?")[0];
    if (schedulesPath === SCHEDULES_ADMIN || schedulesPath === SCHEDULES_PAUSE) return this.#schedulesAdmin(req, res, who.actor);
    if (url === "/ops" || url.startsWith("/ops/") || url.startsWith("/ops?")) return this.#ops(req, res, who.actor);
    const pathname = url.split("?")[0];
    if (pathname === VIEW_AS_PATH) return this.#viewAsStart(req, res, who.actor);
    if (pathname === RELAY_PATH) return this.#relay(req, res, who);
    if (pathname === "/api/jarvis/me") return this.#me(req, res, who);
    if (url === "/api/jarvis/app-signin" || url.startsWith("/api/jarvis/app-signin?")) return this.#appSignin(req, res);
    if (pathname === "/api/jarvis/android.apk") return this.#androidApk(req, res);
    if (url === "/api/jarvis/signin" || url.startsWith("/api/jarvis/signin?")) return this.#signin(req, res);
    // A bare signed-in prefix opened as a page lands on the app: Access sends a sign-in that started from its own login
    // page (not from 「登入」) back to the app's first path, /api, which CloudCLI answers 404 (Deyao, 2026-10-28)
    if ((req.method === "GET" || req.method === "HEAD") && ["/api", "/api/", "/ws", "/paseo-ws"].includes(url)) {
      res.writeHead(302, { location: "/", "cache-control": "no-store" });
      return res.end();
    }
    if (who.viewAs && !["GET", "HEAD", "OPTIONS"].includes(req.method) && !VIEW_AS_WRITES.some(([m, p]) => m === req.method && p === pathname)) {
      req.resume();
      res.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify({ success: false, error: { code: "VIEW_AS_READ_ONLY", message: "Read-only while viewing as someone else." } }));
    }
    const panel = req.method === "GET" ? SCHEDULES_PANEL.exec(pathname) : null;
    if (panel) {
      const store = await this.schedulesStore().catch(() => null);
      if (store) return store.handlePanel(res, who.email, panel[1].toLowerCase());
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
    const up = http.request({ host: "127.0.0.1", port: p.port, method: req.method, path: withoutViewAs(url), headers: upstreamHeaders(req, who.email, {}, who.viewAs) }, (ures) => {
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

  /**
   * GET /api/jarvis/me: {firstName} for the empty chat's greeting (answered here, no CloudCLI process needed). Viewing
   * as someone: their first name if this replica has seen it, and viewAs {user, expiresAt}.
   */
  async #me(req, res, who) {
    const body = who.viewAs
      ? { firstName: this.verifier.cachedFirstName?.(who.email) ?? null, viewAs: { user: who.email, expiresAt: new Date(who.viewAs.e * 1000).toISOString() } }
      : { firstName: await this.verifier.firstName(accessToken(req), who.email).catch(() => null) };
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  }

  /**
   * POST /api/jarvis/view-as (form `user`): an admin starts viewing the app as that person (top of this file). Same
   * origin only (the operator page's form); recorded in the operator page's History before anything opens.
   */
  async #viewAsStart(req, res, actor) {
    const refuse = (status, text) => { req.resume(); return page(res, status, "View as", text); };
    if (!this.admins.has(actor)) {
      log("warn", "view-as start refused: not an admin", { user: userKey(actor) });
      return refuse(403, "Only an admin of this instance can view as someone else.");
    }
    if (req.method !== "POST") return refuse(405, "Start it from the operator page.");
    const site = String(req.headers["sec-fetch-site"] || "");
    let originHost = "";
    try { originHost = new URL(String(req.headers.origin || "")).host; } catch { /* none */ }
    if (site ? site !== "same-origin" : originHost !== String(req.headers.host || "")) return refuse(403, "Start it from the operator page.");
    if (!this.viewAsKey) return refuse(503, "View as is off (no JARVIS_CC_TOKEN).");
    let user = "";
    try { user = String(new URLSearchParams(await readLimited(req, 4096)).get("user") || "").trim().toLowerCase(); } catch { /* bad body */ }
    if (!user || user.startsWith("@") || !this.allowed(user)) return page(res, 400, "View as", "That address is not a user of this instance.");
    const claims = { a: actor, u: user, s: randomUUID(), e: Math.floor((this.now() + this.viewAsTtlMs) / 1000) };
    try {
      await this.recordViewAs({ event: "start", admin: actor, user, session: claims.s });
    } catch (e) {
      log("warn", "view-as start not recorded", { error: String(e.message || e) });
      return page(res, 502, "View as", "The view could not be recorded in the operator page's History, so it was not opened. Try again in a moment.");
    }
    log("info", "view-as started", { admin: userKey(actor), user: userKey(user), session: claims.s });
    res.writeHead(303, { location: `/#jarvis-view-as=${signViewAs(this.viewAsKey, claims)}`, "cache-control": "no-store", "referrer-policy": "no-referrer" });
    res.end();
  }

  /**
   * GET/POST /api/jarvis/relay: the signed-in person's relay tokens, for running Claude Code on their own computer on
   * this instance's models (jarvis3 docs/CLAUDE-CODE.md "Relay"). GET lists them; POST (same-origin form) `action`
   * create (`label`) shows the new token once with the setup lines, revoke (`id`) answers 303 back to the list. Never
   * while viewing as someone.
   */
  async #relay(req, res, who) {
    const refuse = (status, text) => { req.resume(); return page(res, status, "Claude Code relay", text); };
    if (!this.relayUrl || !this.webUrl || !this.ccToken) return refuse(404, "The relay is not set up on this instance.");
    if (who.viewAs) return refuse(403, "Not available while viewing as someone else.");
    const owner = who.email;
    let created = null;
    if (req.method === "POST") {
      const site = String(req.headers["sec-fetch-site"] || "");
      let originHost = "";
      try { originHost = new URL(String(req.headers.origin || "")).host; } catch { /* none */ }
      if (site ? site !== "same-origin" : originHost !== String(req.headers.host || "")) return refuse(403, "Use the form on this page.");
      let form;
      try { form = new URLSearchParams(await readLimited(req, 4096)); } catch { return refuse(400, "Bad form."); }
      const action = form.get("action");
      try {
        if (action === "revoke") {
          await this.relayTokens({ owner, action: "revoke", id: String(form.get("id") || "") });
          res.writeHead(303, { location: RELAY_PATH, "cache-control": "no-store" });
          return res.end();
        }
        if (action !== "create") return page(res, 400, "Claude Code relay", "Unknown action.");
        created = await this.relayTokens({ owner, action: "create", label: String(form.get("label") || "") });
        log("info", "relay token created", { user: userKey(owner) });
      } catch (e) {
        return page(res, 502, "Claude Code relay", esc(String(e.message || e)));
      }
    } else if (req.method !== "GET" && req.method !== "HEAD") {
      return refuse(405, "Method not allowed.");
    }
    let tokens = [];
    try { tokens = (await this.relayTokens({ owner, action: "list" })).tokens ?? []; } catch (e) {
      return page(res, 502, "Claude Code relay", esc(String(e.message || e)));
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" });
    res.end(relayPage({ owner, tokens, created, setup: created ? this.#relaySetup(created.token) : null, product: this.productName }));
  }

  /** The shell lines that point Claude Code at the relay (the token page shows them once, with the new token). */
  #relaySetup(token) {
    const models = (this.config.models ?? []).map((m) => m.id);
    const model = this.config.defaultModel ?? models[0] ?? "";
    const ctx = (this.config.models ?? []).find((m) => m.id === model)?.contextWindow;
    const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
    return [
      `export ANTHROPIC_BASE_URL=${q(`${this.relayUrl}/x/claude`)}`,
      `export ANTHROPIC_AUTH_TOKEN=${q(token)}`,
      `export ANTHROPIC_CUSTOM_HEADERS=$'CF-Access-Client-Id: ${this.relayAccessId}\\nCF-Access-Client-Secret: ${this.relayAccessSecret}'`,
      `export ANTHROPIC_MODEL=${q(model)}`,
      `export ANTHROPIC_SMALL_FAST_MODEL=${q(this.config.titleModel ?? model)}`,
      ...(ctx ? [`export CLAUDE_CODE_MAX_CONTEXT_TOKENS=${ctx}`] : []),
      `# models: ${models.join(", ")} (claude --model <id>)`,
      "claude",
    ].join("\n");
  }

  /** web's POST /internal/cc/relay-tokens; throws with web's error text when it answers otherwise than 200. */
  async #postRelayTokens(body) {
    const r = await fetch(new URL("/internal/cc/relay-tokens", this.webUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${this.ccToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `web answered ${r.status}`);
    return j;
  }

  /** Records a view-as event in web's ops_events (POST /internal/cc/view-as); throws when it isn't recorded. */
  async #postViewAs(event) {
    if (!this.webUrl || !this.ccToken) throw new Error("JARVIS_WEB_URL / JARVIS_CC_TOKEN are not set");
    const r = await fetch(new URL("/internal/cc/view-as", this.webUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${this.ccToken}`, "content-type": "application/json" },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error(`web answered ${r.status}`);
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
   * GET /api/jarvis/android.apk: the newest signed APK of the Android app (android/README.md; its CI puts each one in
   * the object store), streamed to signed-in staff from the bucket with a SigV4-signed GET. Settings → General links
   * here. It is past the identity check like every /api path, so the file never reaches anyone signed out.
   */
  #androidApk(req, res) {
    const a = this.apk;
    if (!a.endpoint || !a.bucket || !a.key || !a.accessKey || !a.secretKey) return page(res, 404, "Not found", "Not found.");
    if (req.method !== "GET" && req.method !== "HEAD") return page(res, 405, "Not allowed", "GET only.");
    const target = new URL(`/${a.bucket}/${a.key.split("/").map(encodeURIComponent).join("/")}`, a.endpoint);
    const headers = s3Sign(req.method, target, a, new Date(this.now()));
    const up = (target.protocol === "https:" ? https : http).request(target, { method: req.method, headers, timeout: 30_000 }, (ures) => {
      if (ures.statusCode !== 200) {
        ures.resume();
        log("warn", "apk fetch failed", { status: ures.statusCode });
        return page(res, ures.statusCode === 404 ? 404 : 502, "未能下載", "暫時未能下載，請稍後再試。The download is not available right now.");
      }
      res.writeHead(200, {
        "content-type": "application/vnd.android.package-archive",
        "content-disposition": 'attachment; filename="YYC-AI.apk"',
        "cache-control": "no-store",
        ...(ures.headers["content-length"] ? { "content-length": ures.headers["content-length"] } : {}),
        ...(ures.headers["last-modified"] ? { "last-modified": ures.headers["last-modified"] } : {}),
      });
      ures.pipe(res);
    });
    res.on("close", () => { if (!res.writableFinished) up.destroy(); });
    up.on("timeout", () => up.destroy(new Error("timeout")));
    up.on("error", (e) => {
      log("warn", "apk fetch error", { error: e.message });
      if (!res.headersSent) page(res, 502, "未能下載", "暫時未能下載，請稍後再試。The download is not available right now.");
      else res.destroy();
    });
    up.end();
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
    const up = http.request({ host: owner, port: this.port, method: req.method, path: req.url, headers: { ...upstreamHeaders(req, null), [HOP]: hop, ...this.#peerKey() /* switch window */ } }, (ures) => {
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

  /** switch window: a request passed on to another replica carries the peer key, so it knows it is not a first hop. */
  #peerKey() { return this.peerAuth ? { [PEER_AUTH]: this.peerAuth } : {}; }

  async #onUpgrade(req, socket, head) {
    socket.on("error", () => {});
    if (this.sw.refuseUpgrade(req, socket)) return; // switch window: 503 before the 101 once armed for everyone
    const who = await this.#identify(req);
    if (who.status !== 200) return rejectUpgrade(socket, who.status, "not allowed\n");
    if (this.sw.refuseUpgrade(req, socket, who)) return; // switch window: 503 before the 101 once armed for this person
    // viewing as someone: only the Paseo socket, whose bridge records what is sent (top of this file)
    if (who.viewAs && (req.url || "").split("?")[0] !== "/paseo-ws") return rejectUpgrade(socket, 403, "read-only while viewing as someone else\n");
    const route = await this.#route(req, who.email);
    const owner = route.peer ?? null;
    let target, p = null;
    if (owner) {
      target = { host: owner, port: this.port, headers: { ...upstreamHeaders(req, null), [HOP]: route.hop, ...this.#peerKey() /* switch window */ } };
    } else {
      try { p = await this.#process(who.email); } catch { return rejectUpgrade(socket, 503, "busy\n"); }
      target = { host: "127.0.0.1", port: p.port, headers: upstreamHeaders(req, who.email, {}, who.viewAs), path: withoutViewAs(req.url || "/") };
    }
    const up = http.request({ path: req.url, ...target, method: req.method });
    up.on("upgrade", (ures, usock, uhead) => {
      if (this.sw.refuseLate(req, socket, usock, who)) return; // switch window
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
      this.sw.track({ req, socket, usock, ures, head, uhead, who, p }); // switch window: after the pipes
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
    this.schedules?.stop();
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
    // switch window: a process stopped here with a chat still running cuts an old turn (old_turn_cut_total, DESIGN 9.9)
    await Promise.all([...this.procs.values()].map(async (p) => {
      if (p.stopping || p.exited) return;
      const r = await p.runningChats();
      if (r === null ? p.inflight > 0 : r > 0) this.sw.turnCut(p, r, "shutdown");
    }));
    await Promise.all([...this.procs.values()].map((p) => p.stop("shutdown")));
    for (const f of this.forwarded) f.socket.destroy();
    this.server.close();
    this.server.closeAllConnections?.();
    clearInterval(this.sweeper);
    clearTimeout(this.purgeFirst);
    clearInterval(this.purgeTimer);
    clearInterval(this.peerTimer);
    this.sw.stop(); // switch window
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

// ==================================== switch window (DESIGN 9.3, 9.5, 9.6) ====================================
// The old side of the switch to the new stack (DE0CH/aviary pigeon), shipped in the A1 ui rollout and deleted with
// this router in A6. Off unless JARVIS_UI_SWITCH_TOKEN is set (then: taps on every upgraded socket, the endpoints),
// and off (logged at error) on a replica with peers (JARVIS_UI_PEERS) but no peer key (JARVIS_CC_TOKEN): without it a
// socket another replica passes on cannot be told from a first hop, so it would be counted twice and refused.
//
// - LU sockets: an upgrade or request whose `x-aviary-lu` equals JARVIS_UI_LU_TOKEN (constant-time) is pigeon's legacy
//   upstream; the header never reaches a process (upstreamHeaders). LU sockets are never moved or refused.
// - Frame reader: on every upgraded socket a reader runs after the bytes are piped (a later 'data' listener, inside
//   try/catch), in both directions. It follows frame headers and runs a streaming scan (JsonScan) over each text
//   message (masked bytes unmasked 64 KB at a time into one scratch buffer the next window overwrites), keeping
//   nothing but `type`, `message.type`, `message.requestId` (client) and `message.payload.requestId` (server). A client message is read up to its `message.requestId`, at most
//   SWITCH_CLIENT_LIMIT bytes: Paseo's client builds requests with zod, which emits keys in schema order, and
//   `workspace.create.request` has `agent` (the first prompt, inline images, attachments) before `requestId`
//   (paseo/packages/protocol/src/messages.ts WorkspaceCreateRequestSchema; daemon-client.ts
//   sendCorrelatedSessionRequest). A server message is read for its first SWITCH_PREFIX bytes: CloudCLI's bridge puts
//   `requestId` first in every payload (server/modules/paseo/paseo-connection.ts). A client request id is
//   outstanding until the server sends a message whose payload names it (its response, or `rpc_error`). Every inbound
//   frame other than a ping (control or `{"type":"ping"}`) and `client_heartbeat` sets the socket's last inbound time.
// - Stale: an outstanding id older than SWITCH_STALE_MS (longer than every finite timeout of Paseo's client: the
//   longest is 300 s, daemon-client.ts) is one the process will not answer (a handler that threw: paseo-connection.ts
//   only logs it) or one the client waits for without a timeout (workspace/agent create, plugin reload). It leaves the
//   outstanding set for the socket's stale set: the socket is reported opaque (`stale`, logged at warn, counted) and
//   never moved while it has one. `restart` still waits for it (DESIGN 9.6: no LU request outstanding), since a request
//   the client waits on with no timeout may still be worked on. An answer that comes later clears it.
// - Opaque: a 101 with Sec-WebSocket-Extensions, a non-WebSocket upgrade, RSV bits, a fragmented message, a lost
//   continuation, a client binary message, a client `requestId` that may lie beyond the scan limit, an unparseable
//   message or a reader exception makes the socket opaque for its lifetime: busy, never moved, reported, logged at warn.
//   The reader runs on every upgraded path, so a non-empty client text message must be a JSON object on every path or
//   the socket turns opaque: CloudCLI's /ws, /paseo-ws and /desktop-notifications all take JSON objects only. An empty
//   text message is no request (ignored).
// - GET /__jarvis/sockets: per person, this replica's first-hop sockets that are not LU (`sockets`: outstanding and
//   stale counts, last inbound time, opaque), LU sockets (`lu`, `luOutstanding`, `luOpaque` with its reasons),
//   sockets another replica passed on (`hop`: id, path, opaque, outstanding, stale; whether it is LU is known only on
//   the first hop), in-flight HTTP that is not LU; totals (`opaque` counts this replica's opaque first-hop sockets, LU
//   ones included; hop sockets only in `hopSockets`/`hopOpaque`, so `opaque` adds up across replicas); `generatedAt`.
// - POST /__jarvis/move[?person=<email>]: arms the refusal of new non-LU upgrades (503 before the 101) and the pass-on
//   of non-LU HTTP to JARVIS_UI_PASS_ON_URL, unchanged (409 and nothing armed while that is unset). A bare `move` arms
//   them for everyone (`armed`), checked before the request is identified; `move?person=` arms them for that person
//   only (`armedPersons`, rehearsal R1 before the flip), checked once the request is identified as that person (the
//   identified person: an admin's view-as request counts as the person viewed, as for the move's closes).
//   RELAY_PATH stays here: it is router-served (no process) and no package of the design serves it on the new side
//   (the page is newer than the design; a recorded gap: it must move before A6, when this router goes). With
//   `person`, each of that person's non-LU, non-opaque first-hop sockets is closed at an instant when it has no
//   outstanding request id, no inbound frame for SWITCH_QUIET_MS and the call is under SWITCH_MOVE_MS old (re-checked
//   at the close, and on every server frame and every SWITCH_TICK_MS while the call is fresh): both pipes stop, a close
//   frame 1012 is sent, the socket is read for SWITCH_TAIL_MS more and a request frame read then is counted
//   (`inflightCloses`) and not forwarded.
// - POST /__jarvis/admit: undoes the arming, for everyone and every person (a rollback before the gate).
// - POST /__jarvis/restart?person=<email>: stops the person's process here unless it is busy: HTTP in flight, a socket
//   of theirs with a request outstanding (stale ones included) or opaque, or CloudCLI's GET /api/jarvis/switch/busy
//   (jarvis-switch.routes.ts) lists anything: running (chats, tracked background work, CLI turns), a Claude Code
//   process (holds, also those with no tracked task), a sandbox preparing, a Paseo message pending; can't tell = busy.
// - old_turn_cut_total: a process the drain stops while it still runs a chat (running list non-empty, or unknown with
//   HTTP in flight) is counted (`oldTurnCutTotal`) and logged at error as "switch: old turn cut (old_turn_cut_total)"
//   with the person and the reason, whether the module is on or not: the drain's pod is going, so the runner reads it
//   from the log (DESIGN 9.9's zero counter; the other stops, idle, eviction, restart, never stop a running chat).
// - JARVIS_UI_PURGE=off: purgeWake does nothing and each process gets JARVIS_UI_PURGE=off (jarvis-purge.ts: no purge).
// The endpoints take `Authorization: Bearer <JARVIS_UI_SWITCH_TOKEN>`, or the token in `x-jarvis-switch-token` (through
// the old cluster's API server's pods/proxy, which keeps `Authorization` for itself); anything else is 404.
//
// Environment:
//   JARVIS_UI_SWITCH_TOKEN [unset]    bearer of the switch endpoints; unset: the module is off
//   JARVIS_UI_LU_TOKEN [unset]        pigeon's pair token in x-aviary-lu; unset: no socket is LU
//   JARVIS_UI_PASS_ON_URL [unset]     where non-LU HTTP goes once armed (pigeon's Service; the deployment sets it):
//                                     exactly `http://<host>:<port>` (parsePassOnUrl); unset or anything else: logged at
//                                     error, move answers 409 and nothing is armed
//   JARVIS_UI_PURGE [on]              off: no Recently-deleted purge (purgeWake and the processes')
const LU_HEADER = "x-aviary-lu";
const SWITCH_TOKEN_HEADER = "x-jarvis-switch-token";
const SWITCH_PATHS = ["/__jarvis/sockets", "/__jarvis/move", "/__jarvis/admit", "/__jarvis/restart"];
/** Server messages: bytes read from each. */
export const SWITCH_PREFIX = 8192;
/** Client messages: bytes read at most, looking for `message.requestId` (CloudCLI's `ws` maxPayload, its default). */
export const SWITCH_CLIENT_LIMIT = 100 * 1024 * 1024;
const SWITCH_MAX_OUTSTANDING = 1024;
const SWITCH_STALE_MS = 6 * 60_000;
const CLOSE_1012 = Buffer.from([0x88, 0x02, 0x03, 0xf4]);

/** JsonScan's unmasking window (one per process: the scan is synchronous). */
const SCRATCH = Buffer.allocUnsafeSlow(64 * 1024);
const SCRATCH32 = new Uint32Array(SCRATCH.buffer, SCRATCH.byteOffset, SCRATCH.length >>> 2);
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
/** SCRATCH[0..n) = buf[start..start+n) unmasked, the first byte at payload position `pos`. */
function unmaskInto(buf, start, n, mask, pos) {
  buf.copy(SCRATCH, 0, start, start + n);
  const o = pos & 3;
  const m0 = mask[o], m1 = mask[(o + 1) & 3], m2 = mask[(o + 2) & 3], m3 = mask[(o + 3) & 3];
  const word = LITTLE_ENDIAN ? (m0 | (m1 << 8) | (m2 << 16) | (m3 << 24)) >>> 0 : ((m0 << 24) | (m1 << 16) | (m2 << 8) | m3) >>> 0;
  const words = n >>> 2;
  for (let i = 0; i < words; i++) SCRATCH32[i] ^= word;
  for (let i = words << 2; i < n; i++) SCRATCH[i] ^= mask[(pos + i) & 3];
}

// JsonScan states
const J_VALUE = 0, J_OBJ_FIRST = 1, J_KEY = 2, J_KEY_STR = 3, J_KEY_ESC = 4, J_COLON = 5, J_AFTER = 6, J_ARR_FIRST = 7,
  J_STR = 8, J_STR_ESC = 9, J_LIT = 10, J_END = 11;
const J_KEY_MAX = 16, J_STR_MAX = 1024, J_LIT_MAX = 64, J_DEPTH = 64;
const LIT_RE = /^(true|false|null|-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?)$/;
const isLitByte = (c) => (c >= 48 && c <= 57) || (c >= 97 && c <= 122) || c === 45 || c === 43 || c === 46 || c === 69;

/**
 * A streaming scan of one JSON message, fed in pieces (masked or not): the string values of `type`, `message.type`,
 * `message.requestId` and `message.payload.requestId`, kept raw (escapes not decoded, at most J_STR_MAX bytes). It
 * keeps nothing else: other strings, however long, are only stepped over. `stop` "client" ends the scan at
 * `message.requestId`, "server" at `message.payload.requestId`, null reads it all; `done` says it ended so. `error`
 * for JSON that is invalid as far as it was read. finish(complete) also sets `requestIdPossible`: no
 * `message.requestId` yet, but one could still follow (the top object and `message` both still open, a session frame).
 */
export class JsonScan {
  topType = null; msgType = null; requestId = null; payloadRequestId = null; error = null; done = false;
  topClosed = false; msgClosed = false; requestIdPossible = false; empty = false;
  #stop; #ctx = []; #arr = []; #st = J_VALUE; #started = false;
  #key = ""; #keyOk = true; #next = 0; #cap = 0; #s = ""; #lit = "";
  constructor(stop = null) { this.#stop = stop; }
  #fail(why) { if (!this.error) this.error = why; }
  /**
   * Bytes buf[start..end), the first at payload position `pos` (for the mask). Masked bytes are unmasked a window
   * at a time into one shared scratch buffer (overwritten by the next window, never kept), 32 bits at a step, so the
   * scan itself always reads plain bytes and steps over unwanted strings with Buffer#indexOf.
   */
  feed(buf, start = 0, end = buf.length, mask = null, pos = 0) {
    if (!mask) return this.#feedPlain(buf, start, end);
    while (start < end && !this.done && !this.error) {
      const n = Math.min(end - start, SCRATCH.length);
      unmaskInto(buf, start, n, mask, pos);
      this.#feedPlain(SCRATCH, 0, n);
      start += n;
      pos += n;
    }
  }
  #feedPlain(buf, start, end) {
    let j = start;
    while (j < end && !this.done && !this.error) {
      const st = this.#st;
      if ((st === J_STR && this.#cap === 0) || (st === J_KEY_STR && !this.#keyOk)) {
        // a string or key nobody wants: straight to its next quote or backslash (a short run byte by byte, a long
        // one with memchr; a match past `end` is no match)
        const short = Math.min(end, j + 64);
        while (j < short) { const c = buf[j]; if (c === 34 || c === 92) break; j++; }
        if (j === short && j < end) {
          let q = buf.indexOf(34, j);
          if (q < 0 || q > end) q = end;
          const b = buf.indexOf(92, j);
          j = b >= 0 && b < q ? b : q;
        }
        if (j >= end) break;
      }
      const c = buf[j];
      if (st === J_STR) {
        j++;
        if (c === 34) this.#strEnd();
        else { if (this.#cap) this.#add(c); if (c === 92) this.#st = J_STR_ESC; }
        continue;
      }
      if (st === J_STR_ESC) { j++; if (this.#cap) this.#add(c); this.#st = J_STR; continue; }
      if (st === J_KEY_STR) {
        j++;
        if (c === 34) this.#st = J_COLON;
        else if (c === 92) { this.#keyOk = false; this.#st = J_KEY_ESC; }
        else if (this.#keyOk) { if (this.#key.length >= J_KEY_MAX) this.#keyOk = false; else this.#key += String.fromCharCode(c); }
        continue;
      }
      if (st === J_KEY_ESC) { j++; this.#st = J_KEY_STR; continue; }
      if (st === J_LIT) {
        if (isLitByte(c)) {
          let k = j + 1;
          while (k < end && isLitByte(buf[k])) k++;
          if (this.#lit.length + (k - j) > J_LIT_MAX) { this.#fail("unexpected value"); break; }
          this.#lit += buf.toString("latin1", j, k);
          j = k;
          continue;
        }
        if (!LIT_RE.test(this.#lit)) { this.#fail("unexpected value"); break; }
        this.#st = J_AFTER; // c is read again as what follows the literal
        continue;
      }
      j++;
      if (c === 32 || c === 10 || c === 13 || c === 9) continue;
      switch (st) {
        case J_ARR_FIRST:
          if (c === 93) { this.#close(); break; }
        // falls through
        case J_VALUE:
          if (!this.#started) { this.#started = true; if (c !== 123) { this.#fail("not an object"); break; } }
          if (c === 123) { if (this.#push(this.#next, false)) this.#st = J_OBJ_FIRST; }
          else if (c === 91) { if (this.#push(3, true)) this.#st = J_ARR_FIRST; }
          else if (c === 34) { this.#s = ""; this.#st = J_STR; }
          else if (isLitByte(c)) { this.#lit = String.fromCharCode(c); this.#st = J_LIT; }
          else this.#fail("unexpected value");
          break;
        case J_OBJ_FIRST:
          if (c === 125) { this.#close(); break; }
        // falls through
        case J_KEY:
          if (c !== 34) { this.#fail("expected a key"); break; }
          // only keys of the top object, `message` and `payload` matter (#setNext); deeper ones are stepped over
          this.#key = ""; this.#keyOk = this.#ctx[this.#ctx.length - 1] !== 3; this.#st = J_KEY_STR;
          break;
        case J_COLON:
          if (c !== 58) { this.#fail("expected :"); break; }
          this.#setNext();
          this.#st = J_VALUE;
          break;
        case J_AFTER: {
          const inArr = this.#arr[this.#arr.length - 1];
          if (c === 44) { if (inArr) { this.#next = 3; this.#cap = 0; this.#st = J_VALUE; } else this.#st = J_KEY; }
          else if (c === (inArr ? 93 : 125)) this.#close();
          else this.#fail(inArr ? "expected , or ]" : "expected , or }");
          break;
        }
        default: this.#fail("data after the message");
      }
    }
  }
  #push(ctx, isArr) {
    if (this.#ctx.length >= J_DEPTH) { this.#fail("too deep"); return false; }
    this.#ctx.push(ctx);
    this.#arr.push(isArr);
    this.#next = 3;
    this.#cap = 0;
    return true;
  }
  #close() {
    const ctx = this.#ctx.pop();
    this.#arr.pop();
    if (ctx === 0) this.topClosed = true;
    else if (ctx === 1) this.msgClosed = true;
    this.#st = this.#ctx.length ? J_AFTER : J_END;
  }
  #setNext() {
    const ctx = this.#ctx[this.#ctx.length - 1];
    const k = this.#keyOk ? this.#key : null;
    this.#next = ctx === 0 && k === "message" ? 1 : ctx === 1 && k === "payload" ? 2 : 3;
    this.#cap = ctx === 0 && k === "type" ? 1 : ctx === 1 && k === "type" ? 2 : ctx === 1 && k === "requestId" ? 3 : ctx === 2 && k === "requestId" ? 4 : 0;
  }
  #add(c) {
    if (this.#s.length >= J_STR_MAX) { this.#fail("string too long"); return; }
    this.#s += String.fromCharCode(c);
  }
  #strEnd() {
    this.#st = J_AFTER;
    const cap = this.#cap, v = this.#s;
    this.#cap = 0;
    this.#s = "";
    if (cap === 1) this.topType = v;
    else if (cap === 2) this.msgType = v;
    else if (cap === 3) { this.requestId = v; if (this.#stop === "client") this.done = true; }
    else if (cap === 4) { this.payloadRequestId = v; if (this.#stop === "server") this.done = true; }
  }
  /** `complete`: the whole message was fed. */
  finish(complete) {
    // an empty (or all-whitespace) text message is no request and nothing unreadable
    if (complete && !this.#started && !this.error) { this.empty = true; return this; }
    if (!this.error && !this.done && complete && this.#st !== J_END) this.error = "message cut short";
    this.requestIdPossible = !this.requestId && !this.topClosed && !this.msgClosed && (this.topType === null || this.topType === "session");
    return this;
  }
}

/** One JSON message (a latin1 string) scanned whole: JsonScan with no early stop. */
export function scanMessage(s, complete) {
  const sc = new JsonScan(null);
  sc.feed(Buffer.from(s, "latin1"));
  return sc.finish(complete);
}

/**
 * A WebSocket frame follower for one direction of a byte stream (RFC 6455 framing, masked or not). `onFrame(opcode,
 * scan)` gets each whole frame: for a text message the finished JsonScan of its first `limit` payload bytes (`stop` as
 * JsonScan's), null for a binary or control frame. `onOpaque(reason)` is called once for anything it cannot follow,
 * after which it reads nothing more. It never touches the input buffers and copies only the frame header.
 */
export class FrameReader {
  #hdr = Buffer.alloc(14); #hdrLen = 0; #need = 2; #inPayload = false; #remaining = 0; #pos = 0; #mask = null;
  #opcode = 0; #scan = null; #fed = 0; #len = 0; #onFrame; #onOpaque;
  dead = false;
  constructor(onFrame, onOpaque, { limit = SWITCH_PREFIX, stop = null } = {}) {
    this.#onFrame = onFrame; this.#onOpaque = onOpaque; this.limit = limit; this.stop = stop;
  }
  /** No partial frame read: a frame written now would not split another. */
  get atBoundary() { return !this.#inPayload && this.#hdrLen === 0; }
  opaque(reason) {
    if (this.dead) return;
    this.dead = true;
    this.#scan = null;
    this.#onOpaque(reason);
  }
  feed(buf) {
    let off = 0;
    while (off < buf.length && !this.dead) {
      if (!this.#inPayload) {
        const take = Math.min(this.#need - this.#hdrLen, buf.length - off);
        buf.copy(this.#hdr, this.#hdrLen, off, off + take);
        this.#hdrLen += take;
        off += take;
        if (this.#hdrLen === 2 && this.#need === 2) {
          const l7 = this.#hdr[1] & 0x7f;
          this.#need = 2 + (l7 === 126 ? 2 : l7 === 127 ? 8 : 0) + (this.#hdr[1] & 0x80 ? 4 : 0);
        }
        if (this.#hdrLen === this.#need) this.#header();
        continue;
      }
      const n = Math.min(this.#remaining, buf.length - off);
      const sc = this.#scan;
      if (sc && !sc.done && !sc.error && this.#fed < this.limit) {
        const k = Math.min(n, this.limit - this.#fed);
        sc.feed(buf, off, off + k, this.#mask, this.#pos);
        this.#fed += k;
      }
      this.#pos += n;
      this.#remaining -= n;
      off += n;
      if (this.#remaining === 0) this.#end();
    }
  }
  #header() {
    const h = this.#hdr;
    const fin = (h[0] & 0x80) !== 0, rsv = h[0] & 0x70, opcode = h[0] & 0x0f, masked = (h[1] & 0x80) !== 0, l7 = h[1] & 0x7f;
    let len = l7;
    if (l7 === 126) len = h.readUInt16BE(2);
    else if (l7 === 127) {
      const hi = h.readUInt32BE(2);
      if (hi > 0x1fffff) return this.opaque("frame length out of range");
      len = hi * 2 ** 32 + h.readUInt32BE(6);
    }
    this.#mask = masked ? Buffer.from(h.subarray(this.#need - 4, this.#need)) : null;
    this.#hdrLen = 0;
    this.#need = 2;
    if (rsv) return this.opaque("extension bits in a frame");
    if (opcode >= 8) {
      if (opcode > 10 || !fin || len > 125) return this.opaque("bad control frame");
    } else if (opcode === 0) return this.opaque("continuation frame");
    else if (opcode !== 1 && opcode !== 2) return this.opaque("unknown opcode");
    else if (!fin) return this.opaque("fragmented message");
    this.#opcode = opcode;
    this.#len = len;
    this.#scan = opcode === 1 ? new JsonScan(this.stop) : null;
    this.#fed = 0;
    this.#pos = 0;
    this.#remaining = len;
    this.#inPayload = true;
    if (len === 0) this.#end();
  }
  #end() {
    this.#inPayload = false;
    const sc = this.#scan;
    this.#scan = null;
    this.#onFrame(this.#opcode, sc ? sc.finish(this.#fed === this.#len) : null);
  }
}

const eqSecret = (given, want) => {
  if (!want || typeof given !== "string" || !given) return false;
  const a = createHash("sha256").update(given).digest(), b = createHash("sha256").update(want).digest();
  return timingSafeEqual(a, b);
};

/**
 * JARVIS_UI_PASS_ON_URL checked once: `http://<host>:<port>` with nothing after it but an optional `/` (pigeon's
 * Service; requests keep their own path). {host, port}, or {error} for anything else: no scheme (`host:port`, which
 * `new URL` reads as a scheme), another scheme (https is not supported: the pass-on stays inside the cluster), no
 * explicit port, a path, a query, a fragment or credentials.
 */
export function parsePassOnUrl(raw) {
  const s = String(raw ?? "").trim();
  if (!/^http:\/\//i.test(s)) return { error: "it must start with http://" };
  let u;
  try { u = new URL(s); } catch { return { error: "not a URL" }; }
  if (u.protocol !== "http:") return { error: "it must start with http://" };
  if (!u.hostname) return { error: "no host" };
  if (u.username || u.password) return { error: "credentials are not allowed" };
  if (u.pathname !== "/" || u.search || u.hash || /[?#]/.test(s)) return { error: "a path, query or fragment is not allowed" };
  // an explicit port (URL drops a written :80, so read it from the text)
  const auth = s.slice(7).split("/")[0];
  const m = /:(\d{1,5})$/.exec(auth);
  if (!m) return { error: "no port" };
  const port = Number(m[1]);
  if (!(port >= 1 && port <= 65535)) return { error: "port out of range" };
  return { host: u.hostname.replace(/^\[(.*)\]$/, "$1"), port };
}

class SwitchWindow {
  constructor(router, o) {
    this.r = router;
    this.token = o.switchToken ?? process.env.JARVIS_UI_SWITCH_TOKEN ?? "";
    this.luToken = o.luToken ?? process.env.JARVIS_UI_LU_TOKEN ?? "";
    this.passOnUrl = o.passOnUrl ?? process.env.JARVIS_UI_PASS_ON_URL ?? "";
    this.purgeOn = String(o.purge ?? process.env.JARVIS_UI_PURGE ?? "on").toLowerCase() !== "off";
    this.quietMs = o.switchQuietMs ?? 5000;
    this.moveMs = o.switchMoveMs ?? 10_000;
    this.tailMs = o.switchTailMs ?? 2000;
    this.tickMs = o.switchTickMs ?? 100;
    this.staleMs = o.switchStaleMs ?? SWITCH_STALE_MS;
    this.clientLimit = o.switchClientLimit ?? SWITCH_CLIENT_LIMIT;
    this.timings = o.switchTimings ?? null; // tests: {ms, bytes, dir} per chunk the module's 'data' handlers read
    this.enabled = !!this.token;
    if (this.enabled && router.peersName && !router.peerAuth) {
      this.enabled = false;
      log("error", "switch: module off: peers are set (JARVIS_UI_PEERS) but there is no peer key (JARVIS_CC_TOKEN)", { peers: router.peersName });
    }
    this.passOn = null; // {host, port} of passOnUrl once it checks out
    if (this.passOnUrl) {
      const t = parsePassOnUrl(this.passOnUrl);
      if (t.error) log("error", `switch: JARVIS_UI_PASS_ON_URL is not usable (${t.error}): move answers 409 and nothing is armed`, { passOn: this.passOnUrl });
      else this.passOn = t;
    } else if (this.enabled) log("error", "switch: JARVIS_UI_PASS_ON_URL is not set: move answers 409 and nothing is armed");
    this.armed = false;            // bare move: refusal and pass-on for everyone
    this.armedPersons = new Set();  // move?person=: refusal and pass-on for these persons only
    this.recs = new Set();          // every upgraded socket's record (first hop or not)
    this.moveCalls = new Map();     // person -> when move?person= was last called
    this.http = new Map();          // person -> in-flight non-LU HTTP (first hop)
    this.luHttp = new Map();        // person -> in-flight LU HTTP (first hop)
    this.passOnInFlight = 0;
    this.nextId = 1;
    this.counters = { movedTotal: 0, inflightClosesTotal: 0, opaqueSocketsTotal: 0, hopOpaqueSocketsTotal: 0, staleRequestsTotal: 0, refusedUpgradesTotal: 0, passedOnTotal: 0, closeErrorsTotal: 0, oldTurnCutTotal: 0 };
    this.ticker = null;
    this.ager = null;
    if (this.enabled) {
      this.ager = setInterval(() => { try { this.#ageAll(); } catch (e) { log("error", "switch: ageing failed", { error: String(e?.message || e) }); } }, Math.max(10, Math.min(10_000, Math.floor(this.staleMs / 4))));
      this.ager.unref?.();
    }
  }

  /** A process stopped with a chat running (`running`: its running count, null when it could not tell). */
  turnCut(p, running, reason) {
    this.counters.oldTurnCutTotal++;
    log("error", "switch: old turn cut (old_turn_cut_total)", { user: p.key, running, reason });
  }

  /** Env for each CloudCLI process. */
  childEnv() { return this.purgeOn ? {} : { JARVIS_UI_PURGE: "off" }; }

  isLu(req) { return eqSecret(req.headers[LU_HEADER], this.luToken); }

  /** Passed on by another replica (hop header with the peer key), i.e. not a first hop. */
  isHop(req) { return !!req.headers[HOP] && eqSecret(req.headers[PEER_AUTH], this.r.peerAuth); }

  /** The switch endpoints and, once armed, the pass-on; true when the request was handled here. */
  handles(req, res) {
    const pathname = (req.url || "/").split("?")[0];
    if (SWITCH_PATHS.includes(pathname)) {
      this.#endpoint(req, res, pathname).catch((e) => {
        log("error", "switch: endpoint failed", { path: pathname, error: String(e?.message || e).slice(0, 200) });
        if (!res.headersSent) { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "internal error" })); } else res.destroy();
      });
      return true;
    }
    if (!this.enabled || !this.armed) return false;
    return this.#passOnIf(req, res, pathname);
  }

  /** Once armed for the identified person: their non-LU HTTP goes to pigeon; true when the request was handled here. */
  passOnPerson(req, res, who) {
    if (!this.enabled || this.armed || who.status !== 200 || !this.armedPersons.has(who.email)) return false;
    return this.#passOnIf(req, res, (req.url || "/").split("?")[0]);
  }

  #passOnIf(req, res, pathname) {
    if (pathname.startsWith("/__jarvis") || pathname === RELAY_PATH || this.isHop(req) || this.isLu(req)) return false;
    try { this.#passOn(req, res); } catch (e) {
      log("error", "switch: pass-on failed", { error: String(e?.message || e).slice(0, 200) });
      if (!res.headersSent) { res.setHeader("retry-after", "1"); page(res, 502, "請重新整理", "請重新整理頁面。Reload the page."); } else res.destroy();
    }
    return true;
  }

  /** Counts a signed-in first-hop request while it is in flight. */
  httpStarted(req, res, who) {
    if (!this.enabled || who.status !== 200 || this.isHop(req)) return;
    const m = this.isLu(req) ? this.luHttp : this.http;
    const person = who.email;
    m.set(person, (m.get(person) || 0) + 1);
    let done = false;
    res.on("close", () => {
      if (done) return;
      done = true;
      const v = (m.get(person) || 1) - 1;
      if (v) m.set(person, v); else m.delete(person);
    });
  }

  /** Armed for everyone, or (`who` given: the request identified) for this person. */
  armedFor(who) { return this.armed || (!!who && who.status === 200 && this.armedPersons.has(who.email)); }

  /** Once armed for everyone (`who` absent) or for the identified person: a new non-LU first-hop upgrade gets 503 before any 101. */
  refuseUpgrade(req, socket, who) {
    if (!this.enabled || !this.armedFor(who) || this.isHop(req) || this.isLu(req)) return false;
    this.counters.refusedUpgradesTotal++;
    socket.on("error", () => {});
    rejectUpgrade(socket, 503, "moved, reconnect\n");
    return true;
  }

  /** The upstream answered 101: refused anyway if the arming came meanwhile (nothing has reached the client yet). */
  refuseLate(req, socket, usock, who) {
    if (!this.refuseUpgrade(req, socket, who)) return false;
    usock.destroy();
    return true;
  }

  /** Taps an upgraded socket (called right after the pipes are set up, before any 'data' event). */
  track({ req, socket, usock, ures, head, uhead, who, p }) {
    if (!this.enabled) return;
    const now = this.r.now();
    const rec = {
      // LU is known on the first hop only: it strips x-aviary-lu before passing the socket on (upstreamHeaders)
      id: `s${this.nextId++}`, person: who.email, viewAs: who.viewAs ? who.viewAs.a : null, lu: !this.isHop(req) && this.isLu(req),
      firstHop: !this.isHop(req), path: (req.url || "/").split("?")[0], openedAt: now, lastInboundAt: now,
      outstanding: new Map(), stale: new Map(), opaque: null, closing: false, socket, usock, p,
    };
    rec.cr = new FrameReader((op, m) => this.#clientFrame(rec, op, m), (why) => this.#opaque(rec, why), { limit: this.clientLimit, stop: "client" });
    rec.sr = new FrameReader((op, m) => this.#serverFrame(rec, op, m), (why) => this.#opaque(rec, why), { limit: SWITCH_PREFIX, stop: "server" });
    this.recs.add(rec);
    socket.on("close", () => { this.recs.delete(rec); clearTimeout(rec.tail); });
    if (String(req.headers.upgrade || "").toLowerCase() !== "websocket") this.#opaque(rec, "not a WebSocket upgrade");
    else if (ures.headers["sec-websocket-extensions"]) this.#opaque(rec, "extension negotiated");
    const feed = (reader, d) => {
      if (reader.dead) return;
      try { reader.feed(d); } catch (e) { reader.opaque(`reader exception: ${String(e.message || e).slice(0, 120)}`); }
    };
    if (uhead?.length) feed(rec.sr, uhead);
    if (head?.length) feed(rec.cr, head);
    // after socket.pipe(usock).pipe(socket): these listeners run after the bytes are written on
    const fromServer = (d) => {
      feed(rec.sr, d);
      if (this.moveCalls.has(rec.person)) this.#safeClose(rec);
    };
    if (!this.timings) {
      socket.on("data", (d) => feed(rec.cr, d));
      usock.on("data", fromServer);
    } else {
      const timed = (dir, fn) => (d) => { const t0 = process.hrtime.bigint(); fn(d); this.timings.push({ ms: Number(process.hrtime.bigint() - t0) / 1e6, bytes: d.length, dir }); };
      socket.on("data", timed("c2s", (d) => feed(rec.cr, d)));
      usock.on("data", timed("s2c", fromServer));
    }
  }

  #opaque(rec, why) {
    if (rec.opaque) return;
    rec.opaque = why;
    rec.cr?.opaque(why);
    rec.sr?.opaque(why);
    if (rec.firstHop) this.counters.opaqueSocketsTotal++; else this.counters.hopOpaqueSocketsTotal++;
    log("warn", "switch: opaque socket", { user: userKey(rec.person), socket: rec.id, ...(rec.firstHop ? { lu: rec.lu } : {}), firstHop: rec.firstHop, why });
  }

  #clientFrame(rec, op, m) {
    if (op >= 8) return; // ping, pong, close: not activity
    if (op === 2) return this.#opaque(rec, "binary message from the client");
    if (m.empty) return; // an empty text message: no request, no activity
    if (m.error) return this.#opaque(rec, `unreadable message: ${m.error}`);
    if (rec.closing) {
      if (m.requestId) {
        this.counters.inflightClosesTotal++;
        log("warn", "switch: a request arrived after the close decision", { user: userKey(rec.person), socket: rec.id, type: m.msgType });
      }
      return;
    }
    if (!(m.topType === "ping" || m.msgType === "client_heartbeat")) rec.lastInboundAt = this.r.now();
    if (m.requestId) {
      rec.outstanding.set(m.requestId, { type: m.msgType, at: this.r.now() });
      if (rec.outstanding.size > SWITCH_MAX_OUTSTANDING) this.#opaque(rec, "too many outstanding requests");
    } else if (m.requestIdPossible) this.#opaque(rec, "requestId beyond the scan limit");
  }

  #serverFrame(rec, op, m) {
    if (op !== 1 || !m?.payloadRequestId) return;
    rec.outstanding.delete(m.payloadRequestId);
    if (rec.stale.delete(m.payloadRequestId) && !rec.stale.size) log("info", "switch: a stale request was answered", { user: userKey(rec.person), socket: rec.id });
  }

  /** Outstanding ids older than staleMs move to the socket's stale set (logged, counted). */
  #age(rec, now) {
    for (const [id, v] of rec.outstanding) {
      if (now - v.at < this.staleMs) continue;
      rec.outstanding.delete(id);
      rec.stale.set(id, v);
      this.counters.staleRequestsTotal++;
      log("warn", "switch: a request has had no answer for longer than the client waits", { user: userKey(rec.person), socket: rec.id, ...(rec.firstHop ? { lu: rec.lu } : {}), firstHop: rec.firstHop, type: v.type, ageMs: now - v.at });
    }
  }

  #ageAll() {
    const now = this.r.now();
    for (const rec of this.recs) if (rec.outstanding.size) this.#age(rec, now);
  }

  #eligible(rec, now) {
    if (!rec.firstHop || rec.lu || rec.opaque || rec.stale.size || rec.closing || rec.socket.destroyed) return false;
    const at = this.moveCalls.get(rec.person);
    return at !== undefined && now - at < this.moveMs && rec.outstanding.size === 0 && now - rec.lastInboundAt >= this.quietMs &&
      rec.cr.atBoundary && rec.sr.atBoundary;
  }

  /** Closes the socket if the move rule holds at this instant. */
  #tryClose(rec) {
    const now = this.r.now();
    if (!this.#eligible(rec, now)) return false;
    rec.closing = true;
    this.counters.movedTotal++;
    const { socket, usock } = rec;
    socket.unpipe(usock);
    usock.unpipe(socket);
    usock.pause();
    socket.write(CLOSE_1012);
    socket.resume(); // keep reading the client for the tail
    socket.once("end", () => socket.destroy());
    rec.tail = setTimeout(() => socket.destroy(), this.tailMs);
    rec.tail.unref?.();
    log("info", "switch: socket moved", { user: userKey(rec.person), socket: rec.id });
    return true;
  }

  /** #tryClose that never throws (it runs from stream events and timers): an error makes the socket opaque. */
  #safeClose(rec) {
    try { return this.#tryClose(rec); } catch (e) {
      this.counters.closeErrorsTotal++;
      log("error", "switch: closing a socket failed", { user: userKey(rec.person), socket: rec.id, error: String(e?.message || e).slice(0, 200) });
      try { this.#opaque(rec, `close failed: ${String(e?.message || e).slice(0, 120)}`); } catch { /* nothing more to do */ }
      return false;
    }
  }

  #tick() {
    try {
      const now = this.r.now();
      for (const [person, at] of this.moveCalls) if (now - at >= this.moveMs) this.moveCalls.delete(person);
      if (!this.moveCalls.size) { clearInterval(this.ticker); this.ticker = null; return; }
      for (const rec of this.recs) if (this.moveCalls.has(rec.person)) this.#safeClose(rec);
    } catch (e) { log("error", "switch: tick failed", { error: String(e?.message || e).slice(0, 200) }); }
  }

  stop() { clearInterval(this.ticker); this.ticker = null; clearInterval(this.ager); this.ager = null; for (const rec of this.recs) clearTimeout(rec.tail); }

  /** Why a socket counts as opaque in the report and for move: its reader gave up, or it has a stale request. */
  #opaqueReason(rec) {
    if (rec.opaque) return rec.opaque;
    if (!rec.stale.size) return null;
    const [id, v] = rec.stale.entries().next().value;
    return `stale: ${rec.stale.size} request(s) unanswered for over ${Math.round(this.staleMs / 1000)} s (first ${v.type ?? "?"} ${id})`;
  }

  report() {
    const now = this.r.now();
    this.#ageAll();
    const persons = {};
    const of = (email) => (persons[email] ??= { sockets: [], lu: 0, luOutstanding: 0, luOpaque: 0, luOpaqueReasons: [], hop: [], http: 0, luHttp: 0 });
    const iso = (ms) => new Date(ms).toISOString();
    const oldest = (map) => { let o = null; for (const v of map.values()) if (o === null || v.at < o) o = v.at; return o === null ? null : iso(o); };
    let sockets = 0, opaque = 0, lu = 0, luOpaque = 0, hop = 0, hopOpaque = 0;
    for (const rec of this.recs) {
      if (rec.socket.destroyed) continue;
      const e = of(rec.person);
      const why = this.#opaqueReason(rec);
      if (!rec.firstHop) {
        // the first hop counts this socket in its own totals; the owner reports it apart (hopSockets, hopOpaque)
        hop++;
        if (why) hopOpaque++;
        e.hop.push({ id: rec.id, path: rec.path, opaque: !!why, opaqueReason: why, outstanding: rec.outstanding.size, stale: rec.stale.size, openedAt: iso(rec.openedAt) });
        continue;
      }
      if (why) opaque++;
      if (rec.lu) {
        e.lu++;
        e.luOutstanding += rec.outstanding.size;
        lu++;
        if (why) { e.luOpaque++; e.luOpaqueReasons.push(why); luOpaque++; }
        continue;
      }
      sockets++;
      e.sockets.push({
        id: rec.id, path: rec.path, viewAs: rec.viewAs, opaque: !!why, opaqueReason: why, outstanding: rec.outstanding.size,
        oldestOutstandingAt: oldest(rec.outstanding), stale: rec.stale.size, oldestStaleAt: oldest(rec.stale),
        lastInboundAt: iso(rec.lastInboundAt), openedAt: iso(rec.openedAt), closing: rec.closing,
      });
    }
    let http = 0;
    for (const [person, n] of this.http) { of(person).http = n; http += n; }
    for (const [person, n] of this.luHttp) of(person).luHttp = n;
    return {
      generatedAt: iso(now), armed: this.armed, armedPersons: [...this.armedPersons].sort(), pod: this.r.selfIp || null, persons,
      totals: { sockets, opaque, lu, luOpaque, http, passOnInFlight: this.passOnInFlight, hopSockets: hop, hopOpaque },
      counters: { ...this.counters },
    };
  }

  move(person) {
    if (person) this.armedPersons.add(person); else this.armed = true;
    this.#ageAll();
    let closed = 0, waiting = 0, opaque = 0;
    if (person) {
      this.moveCalls.set(person, this.r.now());
      for (const rec of this.recs) {
        if (rec.person !== person || !rec.firstHop || rec.lu || rec.closing || rec.socket.destroyed) continue;
        if (rec.opaque || rec.stale.size) opaque++;
        else if (this.#safeClose(rec)) closed++;
        else waiting++;
      }
      if (!this.ticker) { this.ticker = setInterval(() => this.#tick(), this.tickMs); this.ticker.unref?.(); }
    }
    return { armed: this.armed, armedPersons: [...this.armedPersons].sort(), person: person || null, closed, waiting, opaque, generatedAt: new Date(this.r.now()).toISOString() };
  }

  async restart(person) {
    const p = this.r.procs.get(person);
    if (!p || p.stopping || p.exited) return { result: "none" };
    const why = () => {
      if (p.inflight > 0) return "http in flight";
      this.#ageAll();
      for (const rec of this.recs) {
        if (rec.person !== person || rec.socket.destroyed) continue;
        if (rec.outstanding.size) return "request outstanding";
        // a stale id still holds the restart (DESIGN 9.6: no request outstanding): it may be a request the client
        // waits on without a timeout (workspace/agent create, plugin reload) that is still being worked on
        if (rec.stale.size) return "stale request outstanding";
        if (rec.opaque) return "opaque socket";
      }
      return null;
    };
    let busy = why();
    if (busy) return { result: "busy", why: busy };
    const b = await p.switchBusy();
    if (b === null) return { result: "busy", why: "running state unknown" };
    if (b.running) return { result: "busy", why: "running" };
    if (b.processes) return { result: "busy", why: "claude process held" };
    if (b.preparing) return { result: "busy", why: "preparing" };
    if (b.pending) return { result: "busy", why: "message pending" };
    busy = why();
    if (busy || p.stopping) return { result: "busy", why: busy ?? "stopping" };
    await p.stop("switch restart");
    return { result: "stopped" };
  }

  async #endpoint(req, res, pathname) {
    const answer = (status, body) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    req.resume();
    // the token as `Authorization: Bearer …`, or as `x-jarvis-switch-token` when the caller comes through the old
    // cluster's API server (pods/proxy keeps `Authorization` for its own login: the importer and the runner, B7)
    const presented = req.headers[SWITCH_TOKEN_HEADER] !== undefined ? String(req.headers[SWITCH_TOKEN_HEADER]) : null;
    const ok = presented !== null ? eqSecret(presented, this.token) : eqSecret(String(req.headers.authorization || ""), `Bearer ${this.token}`);
    if (!this.enabled || !ok) return answer(404, { error: "not found" });
    const want = pathname === "/__jarvis/sockets" ? "GET" : "POST";
    if (req.method !== want) return answer(405, { error: `${want} only` });
    const person = String(new URL(req.url, "http://x").searchParams.get("person") || "").trim().toLowerCase();
    if (pathname === "/__jarvis/sockets") return answer(200, this.report());
    if (pathname === "/__jarvis/move") {
      if (!this.passOnUrl) return answer(409, { error: "JARVIS_UI_PASS_ON_URL is not set: nothing armed" });
      if (!this.passOn) return answer(409, { error: `JARVIS_UI_PASS_ON_URL is not usable (${parsePassOnUrl(this.passOnUrl).error}): nothing armed` });
      const first = person ? !this.armed && !this.armedPersons.has(person) : !this.armed;
      const out = this.move(person);
      if (first && person) log("info", "switch: armed for one person (their new non-LU upgrades refused, their non-LU HTTP passed on)", { user: userKey(person), passOn: this.passOnUrl });
      else if (first) log("info", "switch: armed (new non-LU upgrades refused, non-LU HTTP passed on)", { passOn: this.passOnUrl });
      return answer(200, out);
    }
    if (pathname === "/__jarvis/admit") {
      this.armed = false;
      this.armedPersons.clear();
      this.moveCalls.clear();
      log("info", "switch: admitted (arming undone)");
      return answer(200, { armed: false, armedPersons: [] });
    }
    if (!person) return answer(400, { error: "person is required" });
    try { return answer(200, await this.restart(person)); } catch (e) { return answer(500, { error: String(e.message || e) }); }
  }

  /** A non-LU request once armed: to pigeon unchanged (Access headers included); only hop-by-hop headers dropped. */
  #passOn(req, res) {
    const target = this.passOn;
    const headers = { ...req.headers };
    for (const k of ["connection", "keep-alive", "proxy-connection", "te", "trailer", "upgrade"]) delete headers[k];
    this.passOnInFlight++;
    this.counters.passedOnTotal++;
    let done = false;
    const finish = () => { if (!done) { done = true; this.passOnInFlight--; } };
    const up = http.request({ host: target.host, port: target.port, method: req.method, path: req.url, headers }, (ures) => {
      res.writeHead(ures.statusCode || 502, ures.statusMessage, responseHeaders(ures));
      ures.pipe(res);
    });
    res.on("close", () => { finish(); if (!res.writableFinished) up.destroy(); });
    up.on("error", (e) => {
      finish();
      log("warn", "switch: pass-on error", { error: e.message });
      if (!res.headersSent) { res.setHeader("retry-after", "1"); page(res, 502, "請重新整理", "請重新整理頁面。Reload the page."); }
      else res.destroy();
    });
    req.pipe(up);
  }
}
// ================================== end of the switch window section ==================================

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
