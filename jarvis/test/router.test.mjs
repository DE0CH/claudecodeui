// Router tests with fake CloudCLI children (test/fake-cloudcli.mjs): `node --test jarvis/test/`.
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, readlinkSync, existsSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { AccessVerifier, Router, ownerOf, userKey } from "../router.mjs";

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
