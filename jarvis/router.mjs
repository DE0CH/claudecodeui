#!/usr/bin/env node
// Jarvis 3 UI router (DE0CH/jarvis3 docs/CLAUDE-CODE.md): the front of the CloudCLI-fork UI pods. One CloudCLI server
// process per signed-in staff member, started on demand and stopped when idle; every request is checked against
// Cloudflare Access (RS256 against the team's JWKS, issuer,
// audience, expiry, an email claim, the instance's `users`) and proxied (HTTP and WebSocket) to that person's process
// with `X-Jarvis-User: <email>`.
//
// Several router replicas run side by side (stateless). Each person's process lives on one replica, picked by
// rendezvous hashing over the ready replicas (a headless Service's DNS): a request that lands on another replica is
// passed on to the owner, so a person's tabs all reach the same process (a run's live stream exists only there).
// If the owner can't be reached, the request is served here.
//
// No dependencies beyond Node's standard library.
//
// Environment (defaults in brackets):
//   PORT [8080]                       listen port (all interfaces)
//   JARVIS_CONFIG [/etc/jarvis/config.json]   instance config: access.teamDomain, access.audience, users
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
//   JARVIS_UID [1000]                 owner of folders the router makes when it runs as root
//   passed to every process: DATABASE_URL, JWT_SECRET, JARVIS_WEB_URL, JARVIS_CC_TOKEN (plus the per-user contract env)
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import { promises as dns } from "node:dns";
import { readFileSync, realpathSync } from "node:fs";
import { mkdir, readlink, symlink, unlink, chown, lstat } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOP = "x-jarvis-ui-hop";

export function log(level, msg, fields = {}) {
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields }) + "\n");
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
  #issuer; #audience; #jwks; #keys = new Map(); #fetchedAt = 0; #lastTry = 0; #fetch; #now;
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
    const email = typeof p.email === "string" ? p.email.trim().toLowerCase() : "";
    if (!email) throw new Error("no email (service tokens are not staff)");
    return email;
  }
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
  for (const k of ["x-jarvis-user", HOP, "proxy-connection", "keep-alive", "te", "trailer"]) delete h[k];
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
    this.verifier = o.verifier ?? new AccessVerifier({ teamDomain: a.teamDomain, audience: a.audience, jwks });
    this.users = new Set((this.config.users ?? []).map((u) => String(u).trim().toLowerCase()));
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
    this.peersName = o.peers ?? process.env.JARVIS_UI_PEERS ?? "";
    this.selfIp = o.selfIp ?? process.env.POD_IP ?? "";
    this.port = o.port ?? Number(process.env.PORT || 8080);
    this.host = o.host ?? undefined;
    this.uid = o.uid ?? Number(process.env.JARVIS_UID || 1000);
    this.spawnImpl = o.spawn ?? nodeSpawn;
    this.resolve = o.resolve ?? ((name) => dns.resolve4(name));
    this.now = o.now ?? (() => Date.now());
    this.procs = new Map();  // email -> UserProcess
    this.peers = [];
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
    await this.#refreshPeers();
    await new Promise((r) => this.server.listen(this.port, this.host, r));
    this.port = this.server.address().port;
    this.sweeper = setInterval(() => void this.sweep(), this.sweepMs);
    this.sweeper.unref();
    if (this.peersName) {
      this.peerTimer = setInterval(() => void this.#refreshPeers(), 5000);
      this.peerTimer.unref();
    }
    log("info", "router listening", { port: this.port, users: this.users.size, maxUsers: this.maxUsers, peers: this.peersName || null });
  }

  async #refreshPeers() {
    if (!this.peersName) return;
    try {
      const ips = await this.resolve(this.peersName);
      this.peers = [...new Set(ips)].sort();
    } catch (e) {
      // no ready replica (this one starting): serve locally
      this.peers = [];
    }
  }

  /** The replica (address) that should serve `email`, or null for this one. */
  ownerFor(email) {
    if (!this.peersName || !this.selfIp) return null;
    const others = this.peers.filter((p) => p !== this.selfIp);
    const o = ownerOf(userKey(email), this.draining ? others : [...others, this.selfIp]);
    return o && o !== this.selfIp ? o : null;
  }

  async #identify(req) {
    const token = accessToken(req);
    if (!token) return { status: 401 };
    let email;
    try { email = await this.verifier.email(token); } catch { return { status: 401 }; }
    if (!this.users.has(email)) return { status: 403, email };
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
    const who = await this.#identify(req);
    if (who.status === 401) return page(res, 401, "未登入", "請重新整理頁面登入。Not signed in: reload the page to sign in.");
    if (who.status === 403) return page(res, 403, "沒有權限", `${who.email} 沒有使用 YYC AI 的權限。This account is not allowed.`);
    const owner = !req.headers[HOP] ? this.ownerFor(who.email) : null;
    if (owner) return this.#forwardHttp(req, res, owner, who.email);
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

  #forwardHttp(req, res, owner, email) {
    const up = http.request({ host: owner, port: this.port, method: req.method, path: req.url, headers: { ...upstreamHeaders(req, null), [HOP]: "1" } }, (ures) => {
      res.writeHead(ures.statusCode || 502, ures.statusMessage, responseHeaders(ures));
      ures.pipe(res);
    });
    res.on("close", () => { if (!res.writableFinished) up.destroy(); });
    up.on("error", (e) => {
      log("warn", "peer unreachable", { peer: owner, error: e.message });
      this.peers = this.peers.filter((x) => x !== owner);
      if (!res.headersSent) { res.setHeader("retry-after", "1"); page(res, 503, "請重新整理", "請重新整理頁面。Reload the page."); }
      else res.destroy();
    });
    req.pipe(up);
  }

  async #onUpgrade(req, socket, head) {
    socket.on("error", () => {});
    const who = await this.#identify(req);
    if (who.status !== 200) return rejectUpgrade(socket, who.status, "not allowed\n");
    const owner = !req.headers[HOP] ? this.ownerFor(who.email) : null;
    let target, p = null;
    if (owner) {
      target = { host: owner, port: this.port, headers: { ...upstreamHeaders(req, null), [HOP]: "1" } };
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
      if (owner) this.peers = this.peers.filter((x) => x !== owner);
      log("warn", "upgrade proxy error", { error: e.message, peer: owner });
      rejectUpgrade(socket, 502, "upstream error\n");
    });
    up.end();
  }

  /**
   * Graceful stop (SIGTERM): readiness turns 503 and the listener closes (Kubernetes has taken the pod out of the
   * Service during preStop), running chats get up to drainMs to finish, then every process is stopped.
   */
  async drain() {
    if (this.draining) return;
    this.draining = true;
    log("info", "draining", { processes: this.procs.size });
    this.server.close();
    const deadline = this.now() + this.drainMs;
    while (this.now() < deadline) {
      let busy = 0;
      for (const p of this.procs.values()) {
        const r = await p.runningChats();
        if (r === null ? p.inflight > 0 : r > 0) busy++;
      }
      if (!busy) break;
      log("info", "waiting for running chats", { processes: busy });
      await sleep(Math.min(5000, Math.max(50, deadline - this.now())));
    }
    await Promise.all([...this.procs.values()].map((p) => p.stop("shutdown")));
    this.server.closeAllConnections?.();
    clearInterval(this.sweeper);
    clearInterval(this.peerTimer);
    log("info", "drained");
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
