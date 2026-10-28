// Router tests with fake CloudCLI children (test/fake-cloudcli.mjs): `node --test jarvis/test/`.
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readlinkSync, existsSync, readFileSync, symlinkSync, unlinkSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { AccessVerifier, Router, needsSignIn, TeamsVerifier, ownerOf, pickFirstName, userKey, workspaceRelative } from "../router.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, "fake-cloudcli.mjs");
const TEAM = "team.cloudflareaccess.com";
const AUD = "aud-ui-test";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWKS = { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" }] };
const ALICE = "alice@yyc.hk";
const BOB = "bob@yyc.hk";
const CAROL = "carol@yyc.hk";

function jwt(claims, { kid = "k1", key = privateKey } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const h = Buffer.from(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })).toString("base64url");
  const p = Buffer.from(JSON.stringify({ iss: `https://${TEAM}`, aud: [AUD], exp: now + 600, iat: now, ...claims })).toString("base64url");
  const s = sign("RSA-SHA256", Buffer.from(`${h}.${p}`), key).toString("base64url");
  return `${h}.${p}.${s}`;
}

const routers = [];
function makeRouter(o = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "router-test-"));
  const r = new Router({
    config: { access: { teamDomain: TEAM, audience: AUD }, users: [ALICE, BOB, CAROL.toUpperCase()] },
    jwks: JWKS,
    serverEntry: FAKE,
    homeRoot: path.join(root, "home"),
    jfsRoot: path.join(root, "jfs"),
    port: 0,
    host: "127.0.0.1",
    killAfterMs: 2000,
    sweepMs: 3600_000,
    distDir: null,
    ...o,
  });
  r.root = root;
  routers.push(r);
  return r;
}
after(async () => { for (const r of routers) if (!r.draining) await r.drain(); });

function get(r, p, headers = {}, method = "GET", body) {
  return new Promise((resolve, reject) => {
    const q = http.request({ host: r.host ?? "127.0.0.1", port: r.port, path: p, method, headers }, (res) => {
      let b = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: b, json: (() => { try { return JSON.parse(b); } catch { return null; } })() }));
    });
    q.on("error", reject);
    if (body) q.write(body);
    q.end();
  });
}
const auth = (email) => ({ "cf-access-jwt-assertion": jwt({ email }) });
const setRunning = (r, email, n) => writeFileSync(path.join(r.homeRoot, userKey(email), "running"), String(n));

test("userKey matches jarvis3's", () => {
  assert.equal(userKey("  Alice@YYC.hk "), userKey("alice@yyc.hk"));
  assert.match(userKey("a@b"), /^u[0-9a-f]{24}$/);
});

test("Access checks: missing, bad audience, wrong key, expired, service token, unlisted", async () => {
  const r = makeRouter();
  await r.listen();
  assert.equal((await get(r, "/healthz")).status, 200);
  assert.equal((await get(r, "/")).status, 401);
  assert.equal((await get(r, "/", { "cf-access-jwt-assertion": jwt({ email: ALICE, aud: ["other"] }) })).status, 401);
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  assert.equal((await get(r, "/", { "cf-access-jwt-assertion": jwt({ email: ALICE }, { key: other }) })).status, 401);
  assert.equal((await get(r, "/", { "cf-access-jwt-assertion": jwt({ email: ALICE, exp: Math.floor(Date.now() / 1000) - 60 }) })).status, 401);
  assert.equal((await get(r, "/", { "cf-access-jwt-assertion": jwt({ common_name: "svc" }) })).status, 401);
  assert.equal((await get(r, "/", { "cf-access-jwt-assertion": jwt({ email: ALICE, iss: "https://evil" }) })).status, 401);
  const denied = await get(r, "/", auth("mallory@yyc.hk"));
  assert.equal(denied.status, 403);
  assert.equal(r.procs.size, 0);
});

test("the verifier fetches the team's JWKS and refetches for an unknown key id", async () => {
  let calls = 0;
  let now = Date.now();
  const v = new AccessVerifier({
    teamDomain: TEAM, audience: AUD, now: () => now,
    fetchImpl: async (url) => { calls++; assert.equal(url, `https://${TEAM}/cdn-cgi/access/certs`); return { ok: true, json: async () => JWKS }; },
  });
  assert.equal(await v.email(jwt({ email: "X@yyc.hk" })), "x@yyc.hk");
  assert.equal(calls, 1);
  // an unknown key id: no refetch within the 30 s cooldown, one after it
  await assert.rejects(v.email(jwt({ email: ALICE }, { kid: "k2" })));
  assert.equal(calls, 1);
  now += 31_000;
  await assert.rejects(v.email(jwt({ email: ALICE }, { kid: "k2" })));
  assert.equal(calls, 2);
});

test("a signed-in user gets their own process with the contract env, X-Jarvis-User and ~/.claude on JuiceFS", async () => {
  const r = makeRouter();
  await r.listen();
  process.env.DATABASE_URL = "postgres://x"; process.env.JWT_SECRET = "s"; process.env.JARVIS_WEB_URL = "http://web:8080"; process.env.JARVIS_CC_TOKEN = "t";
  const res = await get(r, "/api/x?y=1", { ...auth(ALICE), "x-jarvis-user": "forged@yyc.hk" }, "POST", "hello");
  assert.equal(res.status, 200);
  const j = res.json;
  assert.equal(j.url, "/api/x?y=1");
  assert.equal(j.body, "hello");
  assert.equal(j.headers["x-jarvis-user"], ALICE);
  const key = userKey(ALICE);
  assert.equal(j.env.VITE_IS_PLATFORM, "true");
  assert.equal(j.env.HOST, "127.0.0.1");
  assert.equal(j.env.DATABASE_SCHEMA, `cc_${key}`);
  assert.equal(j.env.JARVIS_CC_OWNER, ALICE);
  assert.equal(j.env.DATABASE_URL, "postgres://x");
  assert.equal(j.env.JARVIS_CC_TOKEN, "t");
  assert.equal(j.env.JARVIS_JFS_ROOT, r.jfsRoot);
  assert.equal(j.env.HOME, path.join(r.homeRoot, key));
  assert.equal(readlinkSync(path.join(j.env.HOME, ".claude")), path.join(r.jfsRoot, "users", key, "claude"));
  assert.ok(existsSync(path.join(r.jfsRoot, "users", key, "claude")));
  // the cookie works too, and the same process serves the next request
  const again = await get(r, "/", { cookie: `a=b; CF_Authorization=${jwt({ email: ALICE })}` });
  assert.equal(again.json.pid, j.pid);
  // an upper-case entry in `users` matches
  assert.equal((await get(r, "/", auth(CAROL))).status, 200);
  assert.equal(r.procs.size, 2);
});

test("a \"@domain\" entry in users admits everyone at that email domain, and only them", async () => {
  const r = makeRouter({ config: { access: { teamDomain: TEAM, audience: AUD }, users: [ALICE, "@Yyc.HK"] } });
  await r.listen();
  assert.equal((await get(r, "/", auth("staff@yyc.hk"))).status, 200);
  assert.equal((await get(r, "/", auth("Other.Staff@YYC.hk"))).status, 200);
  assert.equal((await get(r, "/", auth("someone@notyyc.hk"))).status, 403);
  assert.equal((await get(r, "/", auth("yyc.hk@evil.test"))).status, 403);
  assert.equal((await get(r, "/", auth("x@sub.yyc.hk"))).status, 403);
  assert.equal((await get(r, "/", auth(ALICE))).status, 200);
  assert.equal(r.allowed("@yyc.hk"), false);
});

test("concurrent first requests start one process", async () => {
  const r = makeRouter();
  await r.listen();
  const rs = await Promise.all([1, 2, 3, 4].map(() => get(r, "/", auth(BOB))));
  assert.deepEqual(new Set(rs.map((x) => x.json.pid)).size, 1);
});

test("WebSocket upgrades are proxied with X-Jarvis-User", async () => {
  const r = makeRouter();
  await r.listen();
  const s = net.connect(r.port, "127.0.0.1");
  s.write(`GET /ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: test\r\ncf-access-jwt-assertion: ${jwt({ email: ALICE })}\r\n\r\n`);
  let data = "";
  await new Promise((resolve) => s.on("data", (d) => { data += d; if (data.includes("\r\n\r\n")) resolve(); }));
  assert.match(data, /^HTTP\/1.1 101/);
  assert.match(data, new RegExp(`X-Jarvis-User-Seen: ${ALICE}`, "i"));
  data = "";
  s.write("ping");
  await new Promise((resolve) => s.on("data", () => { if (data.endsWith("ping")) resolve(); }));
  assert.ok(data.endsWith("ping"));
  assert.equal(r.procs.get(ALICE).sockets.size, 1);
  s.destroy();
  // an unauthenticated upgrade is refused
  const bad = net.connect(r.port, "127.0.0.1");
  bad.write("GET /ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n");
  const ans = await new Promise((resolve) => { let b = ""; bad.on("data", (d) => (b += d)); bad.on("close", () => resolve(b)); });
  assert.match(ans, /^HTTP\/1.1 401/);
});

test("the cap: an idle process makes room, a process with a running chat does not", async () => {
  const r = makeRouter({ maxUsers: 1 });
  await r.listen();
  assert.equal((await get(r, "/", auth(ALICE))).status, 200);
  setRunning(r, ALICE, 1);
  assert.equal((await get(r, "/", auth(BOB))).status, 503);
  assert.ok(r.procs.has(ALICE));
  setRunning(r, ALICE, 0);
  assert.equal((await get(r, "/", auth(BOB))).status, 200);
  assert.ok(!r.procs.has(ALICE));
  assert.ok(r.procs.has(BOB));
});

test("idle processes stop unless a chat is running", async () => {
  let now = Date.now();
  const r = makeRouter({ now: () => now, idleMs: 60_000 });
  await r.listen();
  await get(r, "/", auth(ALICE));
  const p = r.procs.get(ALICE);
  now += 61_000;
  setRunning(r, ALICE, 2);
  await r.sweep();
  assert.ok(r.procs.has(ALICE));
  setRunning(r, ALICE, 0);
  await r.sweep();
  assert.ok(!r.procs.has(ALICE));
  assert.ok(p.exited);
  // the next request starts it again
  assert.equal((await get(r, "/", auth(ALICE))).status, 200);
});

test("a process that dies is started again on the next request", async () => {
  const r = makeRouter();
  await r.listen();
  const first = (await get(r, "/", auth(ALICE))).json.pid;
  process.kill(first, "SIGKILL");
  for (let i = 0; i < 50 && r.procs.has(ALICE); i++) await new Promise((x) => setTimeout(x, 20));
  const second = (await get(r, "/", auth(ALICE))).json.pid;
  assert.notEqual(first, second);
});

test("drain: not ready, waits for running chats, then stops every process", async () => {
  const r = makeRouter({ drainMs: 10_000 });
  await r.listen();
  await get(r, "/", auth(ALICE));
  const p = r.procs.get(ALICE);
  setRunning(r, ALICE, 1);
  const t0 = Date.now();
  const drained = r.drain();
  await new Promise((x) => setTimeout(x, 300));
  assert.ok(!p.exited, "kept while a chat runs");
  setRunning(r, ALICE, 0);
  await drained;
  assert.ok(p.exited);
  assert.ok(Date.now() - t0 < 9000);
});

test("rendezvous owner is stable and spreads users", () => {
  const peers = ["10.0.0.1", "10.0.0.2"];
  const owners = new Set();
  for (let i = 0; i < 50; i++) {
    const k = userKey(`${i}@x`);
    assert.equal(ownerOf(k, peers), ownerOf(k, [...peers].reverse()));
    owners.add(ownerOf(k, peers));
  }
  assert.equal(owners.size, 2);
});

test("a request for a user owned by the other replica is served there", async () => {
  const port = await new Promise((res) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
  const peers = ["127.0.0.1", "127.0.0.2"];
  const a = makeRouter({ host: "127.0.0.1", port, peers: "ui-peers", selfIp: "127.0.0.1", resolve: async () => peers });
  const b = makeRouter({ host: "127.0.0.2", port, peers: "ui-peers", selfIp: "127.0.0.2", resolve: async () => peers });
  await a.listen();
  await b.listen();
  // a user owned by b, asked at a
  let email = null;
  for (let i = 0; i < 100 && !email; i++) if (ownerOf(userKey(`u${i}@yyc.hk`), peers) === "127.0.0.2") email = `u${i}@yyc.hk`;
  a.users.add(email); b.users.add(email);
  const res = await get(a, "/hello", auth(email));
  assert.equal(res.status, 200);
  assert.equal(res.json.headers["x-jarvis-user"], email);
  assert.ok(b.procs.has(email));
  assert.ok(!a.procs.has(email));
  // b unreachable: a serves the user itself
  await b.drain();
  const res2 = await get(a, "/hello", auth(email));
  if (res2.status === 503) assert.equal((await get(a, "/hello", auth(email))).status, 200);
  assert.ok(a.procs.has(email));
});

// --- rollouts: three replicas on 127.0.0.1-3 sharing a port, a mutable list of ready replicas ---
async function freeTestPort() {
  return new Promise((res) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
}
async function cluster(n) {
  const port = await freeTestPort();
  const ready = { list: ["127.0.0.1", "127.0.0.2"] };
  const rs = [];
  for (let i = 1; i <= n; i++) {
    const ip = `127.0.0.${i}`;
    rs.push(makeRouter({ host: ip, port, peers: "ui-peers", selfIp: ip, ccToken: "peer-test-token", resolve: async () => ready.list }));
  }
  for (const r of rs) await r.listen();
  const refresh = async () => { for (const r of rs) if (!r.draining) await r.refreshPeers(); };
  return { rs, ready, refresh };
}
/** A user (added to every router) for which `pick(ownerAmongTwo, ownerAmongThree)` holds. */
function userWhere(rs, pick) {
  for (let i = 0; i < 500; i++) {
    const e = `roll${i}@yyc.hk`;
    const k = userKey(e);
    if (pick(ownerOf(k, ["127.0.0.1", "127.0.0.2"]), ownerOf(k, ["127.0.0.1", "127.0.0.2", "127.0.0.3"]))) {
      for (const r of rs) r.users.add(e);
      return e;
    }
  }
  throw new Error("no such user");
}
function openWs(r, email) {
  return new Promise((resolve, reject) => {
    const s = net.connect(r.port, r.host);
    s.on("error", reject);
    s.write(`GET /ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: test\r\ncf-access-jwt-assertion: ${jwt({ email })}\r\n\r\n`);
    let data = "";
    const onData = (d) => { data += d; if (data.includes("\r\n\r\n")) { s.off("data", onData); resolve({ s, head: data }); } };
    s.on("data", onData);
  });
}
async function echoes(s, text) {
  return new Promise((resolve) => {
    let got = "";
    const t = setTimeout(() => { s.off("data", on); resolve(false); }, 2000);
    const on = (d) => { got += d; if (got.includes(text)) { clearTimeout(t); s.off("data", on); resolve(true); } };
    s.on("data", on);
    s.write(text);
  });
}

test("rollout surge: a new replica that becomes the hash owner sends the person to the replica holding their process", async () => {
  const { rs: [a, b, c], ready, refresh } = await cluster(3);
  const email = userWhere([a, b, c], (two, three) => two === "127.0.0.1" && three === "127.0.0.3");
  const first = await get(b, "/x", auth(email));
  assert.equal(first.status, 200);
  assert.ok(a.procs.has(email));
  setRunning(a, email, 1);
  // the surge pod joins: by the hash, c owns the person now
  ready.list = ["127.0.0.1", "127.0.0.2", "127.0.0.3"];
  await refresh();
  for (const r of [a, b, c]) {
    const res = await get(r, "/x", auth(email));
    assert.equal(res.status, 200);
    assert.equal(res.json.pid, first.json.pid, "the same process serves every request");
  }
  assert.ok(!c.procs.has(email) && !b.procs.has(email));
  const ws = await openWs(c, email);
  assert.match(ws.head, /^HTTP\/1.1 101/);
  assert.equal(a.procs.get(email).sockets.size, 1, "the WebSocket reaches the holder");
  ws.s.destroy();
  // the old owner drains (out of DNS): while the chat runs it keeps the process and serves passed-on requests
  ready.list = ["127.0.0.2", "127.0.0.3"];
  await refresh();
  const drained = a.drain();
  await new Promise((x) => setTimeout(x, 200));
  const during = await get(b, "/x", auth(email));
  assert.equal(during.json.pid, first.json.pid);
  const ws2 = await openWs(b, email);
  assert.ok(await echoes(ws2.s, "still-streaming"));
  // the chat ends: a stops; the next request starts the process on the hash owner c
  setRunning(a, email, 0);
  await drained;
  await new Promise((x) => setTimeout(x, 100));
  let after = await get(b, "/x", auth(email));
  if (after.status !== 200) after = await get(b, "/x", auth(email));
  assert.equal(after.status, 200);
  assert.notEqual(after.json.pid, first.json.pid);
  assert.ok(c.procs.has(email));
  ws2.s.destroy();
});

test("drain: a replica keeps WebSockets it forwards while the owner runs a chat for the person, closes the others", async () => {
  const { rs: [a, b], refresh } = await cluster(2);
  await refresh();
  const busy = userWhere([a, b], (two) => two === "127.0.0.1");
  let idle = null;
  for (let i = 0; i < 500 && !idle; i++) if (`idle${i}@yyc.hk` && ownerOf(userKey(`idle${i}@yyc.hk`), ["127.0.0.1", "127.0.0.2"]) === "127.0.0.1") idle = `idle${i}@yyc.hk`;
  a.users.add(idle); b.users.add(idle);
  const w1 = await openWs(b, busy);
  const w2 = await openWs(b, idle);
  assert.ok(a.procs.has(busy) && a.procs.has(idle) && !b.procs.has(busy));
  setRunning(a, busy, 1);
  const closed2 = new Promise((r) => w2.s.on("close", r));
  const closed1 = new Promise((r) => w1.s.on("close", () => r("closed")));
  const drained = b.drain();
  await closed2; // no chat running for it: closed at once, the tab reconnects through a ready replica
  assert.equal(await Promise.race([closed1, new Promise((r) => setTimeout(() => r("open"), 1500))]), "open");
  assert.ok(await echoes(w1.s, "turn-output"), "the running chat keeps streaming through the draining replica");
  setRunning(a, busy, 0);
  await drained;
  assert.equal(await closed1, "closed");
  assert.ok(!a.procs.get(busy)?.exited, "the owner's process is untouched");
});

test("a replica in its preStop pause (out of DNS, not yet draining) never counts itself as an owner", async () => {
  const { rs: [a, b], ready, refresh } = await cluster(2);
  const email = userWhere([a, b], (two) => two === "127.0.0.1");
  ready.list = ["127.0.0.2"];
  await refresh();
  assert.equal(a.ownerFor(email), "127.0.0.2");
  const res = await get(a, "/x", auth(email));
  assert.equal(res.status, 200);
  assert.ok(b.procs.has(email) && !a.procs.has(email));
});

test("sent files: egress's snapshot call keeps a copy of each file outside the workspace; refusals", async () => {
  const r = makeRouter({ sentFilesToken: "snap-tok", juicefs: "/nonexistent/juicefs" });
  await r.listen();
  const conv = randomUUID();
  const ws = path.join(r.jfsRoot, "ws", conv);
  mkdirSync(path.join(ws, "out"), { recursive: true });
  writeFileSync(path.join(ws, "out", "report.pdf"), "v1");
  writeFileSync(path.join(ws, "chart.png"), "png");
  const snap = (body, headers = {}) =>
    get(r, "/__jarvis/sent-files/snapshot", { authorization: "Bearer snap-tok", "x-jarvis-conversation": conv, "content-type": "application/json", ...headers }, "POST", JSON.stringify(body));
  const ok = await snap({ toolUseId: "toolu_01", files: ["/workspace/out/report.pdf", "/workspace/chart.png", "/workspace/gone.txt"] });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { kept: ["out/report.pdf", "chart.png"], skipped: ["gone.txt"] });
  const kept = path.join(r.jfsRoot, "sent", conv, "toolu_01", "out", "report.pdf");
  assert.equal(readFileSync(kept, "utf8"), "v1");
  // the agent rewrites and deletes the original: the kept copy stays as sent; a retried send keeps the first copy
  writeFileSync(path.join(ws, "out", "report.pdf"), "v2");
  assert.equal((await snap({ toolUseId: "toolu_01", files: ["/workspace/out/report.pdf"] })).status, 200);
  unlinkSync(path.join(ws, "out", "report.pdf"));
  assert.equal(readFileSync(kept, "utf8"), "v1");
  // refusals: no or a wrong token (404, as if absent), no conversation, a path outside /workspace, a symlink, GET
  assert.equal((await snap({ toolUseId: "toolu_02", files: [] }, { authorization: "Bearer nope" })).status, 404);
  assert.equal((await snap({ toolUseId: "toolu_02", files: [] }, { "x-jarvis-conversation": "../x" })).status, 400);
  assert.equal((await snap({ toolUseId: "../up", files: [] })).status, 400);
  assert.equal((await snap({ toolUseId: "toolu_02", files: ["/etc/passwd"] })).status, 400);
  symlinkSync("/etc/passwd", path.join(ws, "link.txt"));
  const linked = await snap({ toolUseId: "toolu_02", files: ["/workspace/link.txt"] });
  assert.equal(linked.status, 400);
  assert.match(linked.json.error, /not a plain file/);
  assert.equal(existsSync(path.join(r.jfsRoot, "sent", conv, "toolu_02", "link.txt")), false);
  assert.equal((await get(r, "/__jarvis/sent-files/snapshot", { authorization: "Bearer snap-tok", "x-jarvis-conversation": conv })).status, 405);
  // without a token configured the endpoint does not exist
  const off = makeRouter();
  await off.listen();
  assert.equal((await get(off, "/__jarvis/sent-files/snapshot", { authorization: "Bearer ", "x-jarvis-conversation": conv }, "POST", "{}")).status, 404);
  assert.equal(workspaceRelative("/workspace/a/../b.txt"), "b.txt");
  assert.equal(workspaceRelative("/workspace/../etc/passwd"), null);
  assert.equal(workspaceRelative("relative.txt"), null);
});

test("the peer endpoint needs the peer key", async () => {
  const { rs: [a] } = await cluster(1);
  assert.equal((await get(a, "/__jarvis/peer/holds?key=u1")).status, 404);
  assert.equal((await get(a, "/__jarvis/peer/holds?key=u1", { "x-jarvis-ui-peer": "nope" })).status, 404);
  assert.deepEqual(await a.peerState("127.0.0.1", userKey(ALICE)), { holds: false, running: 0, draining: false });
  // a replica that has gone (not ready, nothing answers) is forgotten after one failed lookup
  a.seen.set("127.0.0.9", Date.now());
  assert.equal(await a.peerState("127.0.0.9", userKey(ALICE)), null);
  assert.ok(!a.seen.has("127.0.0.9"));
});

test("the operator page: /ops/* goes to web's /internal/ops/* for admins only, with the token and X-Jarvis-User", async () => {
  const seen = [];
  const web = http.createServer((req, res) => {
    seen.push({ url: req.url, method: req.method, auth: req.headers.authorization, user: req.headers["x-jarvis-user"] });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, url: req.url }));
  });
  await new Promise((r) => web.listen(0, "127.0.0.1", r));
  try {
    const r = makeRouter({
      config: { access: { teamDomain: TEAM, audience: AUD }, users: [ALICE, BOB], admins: [ALICE.toUpperCase()] },
      webUrl: `http://127.0.0.1:${web.address().port}`,
      ccToken: "cc-secret",
    });
    await r.listen();
    // not signed in, a user who is not an admin, someone not even a user: refused, nothing forwarded
    assert.equal((await get(r, "/ops/")).status, 401);
    assert.equal((await get(r, "/ops/", auth(BOB))).status, 403);
    assert.equal((await get(r, "/ops/snapshot", auth(BOB))).status, 403);
    assert.equal((await get(r, "/ops/", auth("mallory@yyc.hk"))).status, 403);
    assert.equal(seen.length, 0);
    assert.equal(r.procs.size, 0, "no CloudCLI process for the operator page");
    // the admin: forwarded with the token and their (verified) address, never a forged one
    const res = await get(r, "/ops/snapshot?tz=Asia/Hong_Kong", { ...auth(ALICE), "x-jarvis-user": "forged@yyc.hk", authorization: "Bearer mine" });
    assert.equal(res.status, 200);
    assert.deepEqual(seen.at(-1), { url: "/internal/ops/snapshot?tz=Asia/Hong_Kong", method: "GET", auth: "Bearer cc-secret", user: ALICE });
    assert.equal((await get(r, "/ops", auth(ALICE))).headers.location, "/ops/");
    // read-only, and dot segments can't reach another /internal path
    assert.equal((await get(r, "/ops/snapshot", auth(ALICE), "POST", "{}")).status, 405);
    const n = seen.length;
    assert.equal((await get(r, "/ops/../cc/sandbox", auth(ALICE))).status, 404);
    assert.equal((await get(r, "/ops/%2e%2e/cc/sandbox", auth(ALICE))).status, 404);
    assert.equal(seen.length, n);
    assert.equal(r.procs.size, 0);
  } finally {
    web.close();
  }
});

test("GET /api/jarvis/me: the identity's first name for the greeting, answered by the router, never from the address", async () => {
  const r = makeRouter();
  await r.listen();
  assert.equal((await get(r, "/api/jarvis/me")).status, 401);
  assert.equal((await get(r, "/api/jarvis/me", auth("mallory@yyc.hk"))).status, 403);
  const named = await get(r, "/api/jarvis/me", { "cf-access-jwt-assertion": jwt({ email: ALICE, given_name: "Alice", name: "Alice Wong" }) });
  assert.equal(named.status, 200);
  assert.deepEqual(named.json, { firstName: "Alice" });
  assert.deepEqual((await get(r, "/api/jarvis/me", auth(BOB))).json, { firstName: null });
  assert.equal(r.procs.size, 0, "no CloudCLI process for /api/jarvis/me");
});

test("first names: given_name, else the first word of name (CJK kept whole), never an address; get-identity fallback, cached", async () => {
  assert.equal(pickFirstName({ given_name: " Deyao ", name: "Deyao Chen" }), "Deyao");
  assert.equal(pickFirstName({ name: "Tai Man Chan" }), "Tai");
  assert.equal(pickFirstName({ name: "陳大文" }), "陳大文");
  assert.equal(pickFirstName({ name: "x@yyc.hk" }), null);
  assert.equal(pickFirstName({}), null);
  assert.equal(pickFirstName(null), null);
  let identity = 0;
  const v = new AccessVerifier({
    teamDomain: TEAM, audience: AUD,
    fetchImpl: async (url, init) => {
      if (url.endsWith("/certs")) return { ok: true, json: async () => JWKS };
      identity++;
      assert.equal(url, `https://${TEAM}/cdn-cgi/access/get-identity`);
      assert.match(init.headers.cookie, /^CF_Authorization=/);
      return { ok: true, json: async () => ({ email: ALICE, oidc_fields: { given_name: "Alice", name: "Alice Wong" } }) };
    },
  });
  const tok = jwt({ email: ALICE });
  assert.equal(await v.firstName(tok, ALICE), "Alice");
  assert.equal(await v.firstName(tok, ALICE), "Alice");
  assert.equal(identity, 1, "cached");
  assert.equal(await v.firstName("garbage", BOB), null);
});

test("GET /api/jarvis/app-signin: redirects only to the configured app scheme, with the caller's own token and state", async () => {
  const off = makeRouter();
  await off.listen();
  const tok = jwt({ email: ALICE });
  assert.equal((await get(off, "/api/jarvis/app-signin?state=abcdefghijklmnop", { "cf-access-jwt-assertion": tok })).status, 404, "off without JARVIS_APP_SCHEME");
  const r = makeRouter({ appScheme: "pwashell-test" });
  await r.listen();
  assert.equal((await get(r, "/api/jarvis/app-signin?state=abcdefghijklmnop")).status, 401, "needs a signed-in caller");
  assert.equal((await get(r, "/api/jarvis/app-signin?state=abcdefghijklmnop", auth("mallory@yyc.hk"))).status, 403, "staff only");
  assert.equal((await get(r, "/api/jarvis/app-signin?state=short", { "cf-access-jwt-assertion": tok })).status, 400);
  assert.equal((await get(r, "/api/jarvis/app-signin?state=abcdefghijklmnop%2F%2Fevil", { "cf-access-jwt-assertion": tok })).status, 400);
  const viaHeader = await get(r, "/api/jarvis/app-signin?state=abcdefghijklmnop", { "cf-access-jwt-assertion": tok });
  assert.equal(viaHeader.status, 302);
  assert.equal(viaHeader.headers.location, `pwashell-test://signed-in?state=abcdefghijklmnop#token=${encodeURIComponent(tok)}`);
  assert.equal(viaHeader.headers["cache-control"], "no-store");
  const viaCookie = await get(r, "/api/jarvis/app-signin?state=abcdefghijklmnop&scheme=evil", { cookie: `a=b; CF_Authorization=${tok}` });
  assert.equal(viaCookie.status, 302);
  assert.ok(viaCookie.headers.location.startsWith("pwashell-test://signed-in?state=abcdefghijklmnop#token="), "the scheme is never the caller's");
  assert.equal(r.procs.size, 0, "no CloudCLI process for the sign-in");
});

test("purgeWake starts the process of a person with expired Recently deleted conversations, and only theirs", async () => {
  const checked = [];
  const r = makeRouter({ expiredCheck: async (email) => (checked.push(email), email === BOB) });
  await r.listen();
  await get(r, "/", auth(ALICE)); // Alice is using the app: her process already purges by itself
  assert.ok(r.procs.has(ALICE));
  await r.purgeWake();
  assert.ok(r.procs.has(BOB), "Bob's process was started to purge");
  assert.ok(!r.procs.has(CAROL.toLowerCase()));
  assert.deepEqual(checked.sort(), [BOB, CAROL.toLowerCase()].sort());
  await r.drain();
});

test("two Access teams (access.also, a move to another Cloudflare account): each token is checked against its own issuer's team", async () => {
  const NEW = "new.cloudflareaccess.com";
  const fetched = [];
  const mk = (t) => new AccessVerifier({ ...t, fetchImpl: async (url) => { fetched.push(url); return { ok: true, json: async () => JWKS }; } });
  const v = new TeamsVerifier([mk({ teamDomain: TEAM, audience: AUD }), mk({ teamDomain: NEW, audience: "aud-new" })]);
  assert.equal(await v.email(jwt({ email: ALICE })), ALICE);
  assert.equal(await v.email(jwt({ email: ALICE, iss: `https://${NEW}`, aud: ["aud-new"] })), ALICE);
  await assert.rejects(v.email(jwt({ email: ALICE, iss: `https://${NEW}`, aud: [AUD] })), /bad audience/);
  await assert.rejects(v.email(jwt({ email: ALICE, aud: ["aud-new"] })), /bad audience/);
  await assert.rejects(v.email(jwt({ email: ALICE, iss: "https://evil.cloudflareaccess.com" })), /bad issuer/);
  await assert.rejects(v.email("garbage"), /bad issuer/);
  assert.ok(fetched.includes(`https://${NEW}/cdn-cgi/access/certs`));
  // the Router builds it from config access.also
  const r = new Router({ config: { access: { teamDomain: TEAM, audience: AUD, also: [{ teamDomain: NEW, audience: "aud-new" }] }, users: [ALICE] }, jwks: JWKS });
  assert.ok(r.verifier instanceof TeamsVerifier);
  assert.equal(await r.verifier.email(jwt({ email: ALICE, iss: `https://${NEW}`, aud: ["aud-new"] })), ALICE);
});

test("signed out: only the built shell (index marked signed out, files of dist/), 401 for API, WebSocket and anything else; /api/jarvis/signin sends a signed-in person back", async () => {
  const dist = mkdtempSync(path.join(os.tmpdir(), "router-dist-"));
  writeFileSync(path.join(dist, "index.html"), '<html><head><title>x</title><meta name="apple-mobile-web-app-title" content="x" /></head><body></body></html>');
  mkdirSync(path.join(dist, "_expo", "static", "js"), { recursive: true });
  writeFileSync(path.join(dist, "_expo", "static", "js", "app-0123456789abcdef0123.js"), "console.log(1)");
  writeFileSync(path.join(dist, "yyc-logo.png"), "png");
  writeFileSync(path.join(os.tmpdir(), "router-secret.txt"), "secret");
  const r = makeRouter({ distDir: dist, productName: "YYC <AI>" });
  await r.listen();
  for (const p of ["/", "/new", "/s/abc", "/h/srv/workspace/wks_1?x=1"]) {
    const page = await get(r, p);
    assert.equal(page.status, 200, p);
    assert.match(page.body, /<meta name="yyc-signed-out" content="1"><\/head>/);
    assert.match(page.body, /<title>YYC &#60;AI&#62;<\/title>/);
    assert.equal(page.headers["cache-control"], "no-store");
  }
  const js = await get(r, "/_expo/static/js/app-0123456789abcdef0123.js");
  assert.equal(js.status, 200);
  assert.match(js.headers["content-type"], /^text\/javascript/);
  assert.match(js.headers["cache-control"], /immutable/);
  const logo = await get(r, "/yyc-logo.png");
  assert.equal(logo.status, 200);
  assert.equal(logo.headers["content-type"], "image/png");
  assert.equal((await get(r, "/yyc-logo.png", {}, "HEAD")).status, 200);
  for (const p of ["/api/jarvis/me", "/api/sessions", "/api/jarvis/signin", "/paseo-ws", "/ws", "/ops/", "/missing.js",
    "/../router-secret.txt", "/%2e%2e/router-secret.txt", "/..%2Frouter-secret.txt", "/__jarvis/x"]) {
    assert.equal((await get(r, p)).status, 401, p);
  }
  assert.equal((await get(r, "/", {}, "POST")).status, 401, "only GET/HEAD");
  const sock = net.connect(r.port, "127.0.0.1");
  sock.write("GET /paseo-ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n");
  const ans = await new Promise((resolve) => { let b = ""; sock.on("data", (c) => (b += c)); sock.on("close", () => resolve(b)); });
  assert.match(ans, /^HTTP\/1.1 401/);
  assert.equal(r.procs.size, 0, "no CloudCLI process for a signed-out visitor");
  // a bad token is signed out too
  assert.match((await get(r, "/", { "cf-access-jwt-assertion": jwt({ email: ALICE, aud: ["other"] }) })).body, /yyc-signed-out/);
  // unlisted: 403, never the shell
  assert.equal((await get(r, "/", auth("mallory@yyc.hk"))).status, 403);
  // signed in: back to the page, only a same-origin path
  const back = await get(r, "/api/jarvis/signin?next=%2Fs%2Fabc%3Fx%3D1", auth(ALICE));
  assert.equal(back.status, 302);
  assert.equal(back.headers.location, "/s/abc?x=1");
  for (const next of ["https://evil.example/", "//evil.example/", "/\\evil.example", "/api/jarvis/app-signin?state=abcdefghijklmnop", ""]) {
    assert.equal((await get(r, `/api/jarvis/signin?next=${encodeURIComponent(next)}`, auth(ALICE))).headers.location, "/", next);
  }
  // a bare /api (where Access's own login page returns to) lands on the app
  for (const bare of ["/api", "/api/", "/paseo-ws"]) {
    const res = await get(r, bare, auth(ALICE));
    assert.equal(res.status, 302, bare);
    assert.equal(res.headers.location, "/", bare);
  }
  assert.equal(r.procs.size, 0, "no CloudCLI process for the sign-in either");
  assert.ok(needsSignIn("/api") && needsSignIn("/paseo-ws") && needsSignIn("/ops/x") && !needsSignIn("/apix") && !needsSignIn("/"));
});
