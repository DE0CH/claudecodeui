// The move fuzz (DESIGN 9.9, aviary WP-54): sends, steers and Stops issued at random instants around a move, every
// connection through a proxy with real network delay (per-connection latency plus jitter, order kept), each tab a
// real WebSocket client (Node's) that behaves as the Paseo app does: a request whose socket closes before its answer
// is rejected and its message goes back into the composer (composer/actions.ts: submission.reject), and the person
// sends it again once the tab has reconnected. At T0 the edge stand-in sends new connections to a pigeon stand-in,
// except a stale location that keeps routing some of them to the old router (its upgrade gets the 503, its upload is
// passed on to pigeon unchanged). The runner stand-in arms the move at T0 and then calls move?person= for every
// person every 200 ms whatever they do (stricter than the runner, which skips a person who typed in the last 60 s).
//
// Each round checks: every action accepted exactly once (on the old child or on pigeon) and none left in a composer;
// the request frames the router read after its close decision (written on an old socket, never seen by the old child)
// equal `inflightClosesTotal` (switch_inflight_closes_total); every tab reconnected exactly once (one move, the stale
// edge's refused upgrades are not connections); no opaque socket; every stale-edge upload reached pigeon
// byte-identical. A self-check runs the same scenario with a mover that is not request-aware (the proxy cuts every old
// connection at T0, as the old pods' drain would) and asserts the checker sees the duplicates it causes.
//
// Times are scaled (the router's 5 s quiet = 300 ms, its 10 s move call = 1 s, its 2 s tail = 600 ms). FUZZ_SEED
// (a number) replays one seed; FUZZ_ROUNDS sets the number of rounds (default 3, about 1 000 actions).
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { Router, userKey } from "../router.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, "fake-cloudcli.mjs");
const TEAM = "team.cloudflareaccess.com";
const AUD = "aud-move-fuzz";
const SW = "switch-fuzz-token";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWKS = { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" }] };
const PERSONS = ["ann@yyc.hk", "ben@yyc.hk", "cat@yyc.hk"];
const TABS_PER_PERSON = 4;
const wait = (ms) => new Promise((x) => setTimeout(x, ms));

function jwt(email) {
  const now = Math.floor(Date.now() / 1000);
  const h = Buffer.from(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" })).toString("base64url");
  const p = Buffer.from(JSON.stringify({ iss: `https://${TEAM}`, aud: [AUD], exp: now + 600, iat: now, email })).toString("base64url");
  return `${h}.${p}.${sign("RSA-SHA256", Buffer.from(`${h}.${p}`), privateKey).toString("base64url")}`;
}

/** mulberry32: a small seeded generator, so a failing seed replays. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function until(pred, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await pred()) return; await wait(10); }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * A TCP proxy with network delay: each connection gets a one-way latency in [minMs, maxMs] plus up to jitterMs per
 * chunk, in both directions, bytes and FIN/close kept in order. `cutAll()` destroys every connection at once (the
 * self-check's mover that is not request-aware).
 */
async function delayProxy(targetPort, rand, { minMs = 5, maxMs = 90, jitterMs = 25 } = {}) {
  const pairs = new Set();
  const server = net.createServer((c) => {
    const u = net.connect(targetPort, "127.0.0.1");
    const pair = { c, u };
    pairs.add(pair);
    c.setNoDelay(true);
    u.setNoDelay(true);
    const base = minMs + rand() * (maxMs - minMs);
    const lane = (from, to) => {
      const q = [];
      let timer = null, last = 0;
      const pump = () => {
        timer = null;
        const now = Date.now();
        while (q.length && q[0].at <= now) {
          const e = q.shift();
          if (to.destroyed) continue;
          if (e.kind === "data") to.write(e.d);
          else if (e.kind === "end") to.end();
          else to.destroy();
        }
        if (q.length) timer = setTimeout(pump, q[0].at - now);
      };
      const push = (e) => {
        e.at = Math.max(Date.now() + base + rand() * jitterMs, last);
        last = e.at;
        q.push(e);
        if (!timer) timer = setTimeout(pump, Math.max(0, q[0].at - Date.now()));
      };
      from.on("data", (d) => push({ kind: "data", d }));
      from.on("end", () => push({ kind: "end" }));
      from.on("close", () => push({ kind: "close" }));
      from.on("error", () => {});
    };
    lane(c, u);
    lane(u, c);
    c.on("close", () => pairs.delete(pair));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port,
    cutAll() { for (const { c, u } of pairs) { c.destroy(); u.destroy(); } },
    close() { for (const { c, u } of pairs) { c.destroy(); u.destroy(); } server.close(); },
  };
}

/** Unmasked server frame. */
function sframe(opcode, payload) {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : Buffer.from([0x80 | opcode, 126, n >> 8, n & 255]);
  return Buffer.concat([head, payload]);
}

/**
 * pigeon's stand-in: a Paseo host on any upgrade path (each request answered after its `delayMs`, every message
 * recorded by its `fuzzId`), and POST /api/assets/files recording the sha256 of each body it receives with the
 * headers it came with (the pass-on must keep them).
 */
async function pigeonStandIn() {
  const seen = [];
  const uploads = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      uploads.push({ url: req.url, sha: createHash("sha256").update(body).digest("hex"), access: req.headers["cf-access-jwt-assertion"] ?? null, tag: req.headers["x-fuzz-upload"] ?? null });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, by: "pigeon" }));
    });
  });
  server.on("upgrade", (req, socket) => {
    const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nServer: pigeon/fuzz\r\n\r\n`);
    socket.on("error", () => {});
    let buf = Buffer.alloc(0);
    socket.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf.length < 2) return;
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        const mask = buf.subarray(off, off + 4); off += 4;
        if (buf.length < off + len) return;
        const p = Buffer.from(buf.subarray(off, off + len));
        for (let i = 0; i < len; i++) p[i] ^= mask[i & 3];
        const opcode = buf[0] & 0x0f;
        buf = buf.subarray(off + len);
        if (opcode === 8) { socket.end(sframe(8, p.subarray(0, 2))); return; }
        if (opcode !== 1) continue;
        let m; try { m = JSON.parse(p.toString("utf8")); } catch { continue; }
        const msg = m.message;
        if (!msg?.requestId) continue;
        if (msg.fuzzId) seen.push(msg.fuzzId);
        const reply = Buffer.from(JSON.stringify({ type: "session", message: { type: String(msg.type).replace(/_request$/, "_response"), payload: { requestId: msg.requestId } } }));
        setTimeout(() => { if (!socket.destroyed) socket.write(sframe(1, reply)); }, Number(msg.delayMs || 0));
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, seen, uploads, close: () => { server.closeAllConnections?.(); server.close(); } };
}

/**
 * A tab: a real WebSocket client and the Paseo app's composer rules. `act(kind)` adds an action; it is dispatched at
 * once when the tab is connected, else when it next connects. An action is pending from its write until its answer
 * (accepted) or its socket's close (rejected: back to the composer, sent again after the reconnect, with a new
 * request id and message id, as a person pressing Send again does). Every write records which side it went to.
 */
class Tab {
  constructor(id, person, f) {
    this.id = id;
    this.person = person;
    this.f = f;
    this.ws = null;
    this.side = null;          // "old" | "new" while connected
    this.connected = false;
    this.opens = 0;            // 101s (a refused upgrade is not one)
    this.refused = 0;          // stale-edge upgrades refused before the 101 (or given up)
    this.timedOut = 0;         // handshakes given up after the connect timeout
    this.composer = [];        // actions waiting to be sent
    this.pending = new Map();  // requestId -> action
    this.oldWrites = [];       // {fuzzId, requestId} written on an old socket
    this.beat = null;
  }

  connect() {
    const side = this.f.edge();
    const port = side === "old" ? this.f.oldProxy.port : this.f.newProxy.port;
    if (process.env.FUZZ_DEBUG) console.log("connect", this.id, side, Date.now() % 100000);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/paseo-ws`, { headers: { "cf-access-jwt-assertion": jwt(this.person) } });
    this.ws = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      this.opens++;
      this.side = side;
      this.connected = true;
      this.beat = setInterval(() => this.#write({ type: "client_heartbeat", deviceType: "web", focusedAgentId: null, lastActivityAt: new Date().toISOString(), appVisible: true }), 90);
      // the person presses Send again for what came back to the composer, after a short human delay
      setTimeout(() => this.flush(), 40 + this.f.rand() * 200);
    };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
      const id = m?.message?.payload?.requestId;
      const a = id && this.pending.get(id);
      if (!a) return;
      this.pending.delete(id);
      a.accepted.push({ side, requestId: id });
    };
    let ended = false;
    // a browser fires error then close on a refused handshake; Node's WebSocket fires only error (and keeps the
    // half-closed socket), so an error before the open ends the attempt here (close() fires error again: guarded)
    const fail = () => {
      if (opened || ended) return;
      ws.onclose({ code: 1006 });
      try { ws.close(); } catch { /* not open */ }
    };
    ws.onerror = fail;
    // the app's connect timeout (scaled): a handshake with no answer is given up and tried again
    const giveUp = setTimeout(() => { if (!opened && !ended) { this.timedOut++; fail(); } }, 2000);
    ws.onclose = (ev) => {
      if (ended) return;
      ended = true;
      clearTimeout(giveUp);
      if (process.env.FUZZ_DEBUG) console.log("close", this.id, side, opened, ev?.code, Date.now() % 100000);
      clearInterval(this.beat);
      this.connected = false;
      if (!opened) this.refused++;
      for (const [, a] of this.pending) this.composer.push(a); // rejected: back into the composer
      this.pending.clear();
      if (this.f.stopping) return;
      setTimeout(() => this.connect(), 60 + this.f.rand() * 150); // the app's reconnect backoff
    };
  }

  #write(message) {
    if (!this.connected || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ type: "session", message }));
    return true;
  }

  act(kind) {
    const a = { fuzzId: `${this.id}-${this.f.seq++}`, kind, tab: this.id, person: this.person, accepted: [], writes: [] };
    this.f.actions.push(a);
    this.composer.push(a);
    if (this.connected) this.flush();
  }

  flush() {
    if (!this.connected) return;
    const todo = this.composer.splice(0);
    for (const a of todo) {
      const requestId = randomUUID();
      // a long answer now and then, so requests are outstanding across the move (longer than the quiet period)
      const delayMs = this.f.rand() < 0.25 ? 300 + Math.floor(this.f.rand() * 900) : Math.floor(this.f.rand() * 120);
      const msg = a.kind === "stop"
        ? { type: "cancel_agent_request", agentId: `agent-${this.id}`, requestId, fuzzId: a.fuzzId, delayMs }
        : { type: "send_agent_message_request", agentId: `agent-${this.id}`, requestId, messageId: randomUUID(), text: `fuzz ${a.fuzzId}`, fuzzId: a.fuzzId, delayMs, ...(a.kind === "steer" ? { activeTurnBehavior: "steer" } : {}) };
      if (!this.#write(msg)) { this.composer.push(a); continue; }
      this.pending.set(requestId, a);
      a.writes.push({ side: this.side, requestId });
      if (this.side === "old") this.oldWrites.push({ fuzzId: a.fuzzId, requestId });
    }
  }

  stop() { clearInterval(this.beat); try { this.ws?.close(); } catch { /* closed */ } }
}

/** What the old children saw: each request's fuzzId, from each person's $HOME/paseo-seen (fake-cloudcli.mjs). */
function oldSeen(r) {
  const out = [];
  for (const p of PERSONS) {
    let text = "";
    try { text = readFileSync(path.join(r.homeRoot, userKey(p), "paseo-seen"), "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m?.message?.fuzzId && m.message.requestId) out.push(m.message.fuzzId);
    }
  }
  return out;
}

function makeRouter(passOnPort) {
  const root = mkdtempSync(path.join(os.tmpdir(), "move-fuzz-"));
  return new Router({
    config: { access: { teamDomain: TEAM, audience: AUD }, users: PERSONS },
    jwks: JWKS, serverEntry: FAKE, homeRoot: path.join(root, "home"), jfsRoot: path.join(root, "jfs"),
    port: 0, host: "127.0.0.1", killAfterMs: 2000, sweepMs: 3600_000, distDir: null,
    switchToken: SW, luToken: "lu-fuzz-token", passOnUrl: `http://127.0.0.1:${passOnPort}`,
    switchQuietMs: 300, switchMoveMs: 1000, switchTailMs: 600, switchTickMs: 20,
  });
}

function call(port, p, { method = "POST", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const q = http.request({ host: "127.0.0.1", port, path: p, method, headers }, (res) => {
      let b = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode, body: b, json: (() => { try { return JSON.parse(b); } catch { return null; } })() }));
    });
    q.on("error", reject);
    if (body) q.write(body);
    q.end();
  });
}

/**
 * One round. `naive`: no move; the proxy cuts every old connection at T0 instead (the self-check). Returns the
 * checker's findings and the numbers.
 */
async function round(seed, { naive = false } = {}) {
  const rand = rng(seed);
  const pigeon = await pigeonStandIn();
  const r = makeRouter(pigeon.port);
  await r.listen();
  const f = {
    rand, seq: 0, actions: [], stopping: false, flipped: false,
    oldProxy: await delayProxy(r.port, rand),
    newProxy: await delayProxy(pigeon.port, rand),
    // the edge stand-in: the old tunnel until T0; then pigeon, except a stale location (30 %) that still routes to
    // the old tunnel
    // the old tunnel (in the self-check every reconnect reaches pigeon: nothing is armed to refuse it)
    edge: () => (!f.flipped ? "old" : !naive && rand() < 0.3 ? "old" : "new"),
  };
  const tabs = [];
  for (const p of PERSONS) for (let i = 0; i < TABS_PER_PERSON; i++) tabs.push(new Tab(`${p.split("@")[0]}${i}`, p, f));
  for (const t of tabs) t.connect();
  await until(() => tabs.every((t) => t.connected), 20_000, "every tab connected (the children start)");

  const swHeaders = { authorization: `Bearer ${SW}` };
  const T0 = Date.now() + 1200;
  // actions at random instants in [T0 - 1 s, T0 + 2.5 s]: exponential gaps, mean 120 ms per tab
  const timers = [];
  const kinds = ["send", "send", "send", "steer", "stop"];
  for (const t of tabs) {
    let at = T0 - 1000 + rand() * 120;
    while (at < T0 + 2500) {
      const kind = kinds[Math.floor(rand() * kinds.length)];
      timers.push(setTimeout(() => t.act(kind), Math.max(0, at - Date.now())));
      at += -Math.log(1 - rand()) * 120;
    }
  }
  // stale-edge uploads after T0: through the old router (armed by then), passed on to pigeon unchanged
  const uploads = [];
  for (let i = 0; i < 6; i++) {
    const at = T0 + 300 + rand() * 2000;
    const person = PERSONS[i % PERSONS.length];
    const body = Buffer.from(`upload ${seed} ${i} ${"x".repeat(Math.floor(rand() * 5000))}`);
    const tag = `${seed}-${i}`;
    timers.push(setTimeout(() => {
      uploads.push(call(f.oldProxy.port, "/api/assets/files", { headers: { "cf-access-jwt-assertion": jwt(person), "content-type": "application/octet-stream", "x-fuzz-upload": tag }, body })
        .then((res) => ({ tag, res, sha: createHash("sha256").update(body).digest("hex") })));
    }, Math.max(0, at - Date.now())));
  }

  await wait(Math.max(0, T0 - Date.now()));
  f.flipped = true;
  let moving = null;
  if (naive) f.oldProxy.cutAll();
  else {
    assert.equal((await call(r.port, "/__jarvis/move", { headers: swHeaders })).status, 200, "arm");
    let go = true;
    moving = (async () => {
      while (go) {
        await Promise.all(PERSONS.map((p) => call(r.port, `/__jarvis/move?person=${encodeURIComponent(p)}`, { headers: swHeaders })));
        await wait(200);
      }
    })();
    moving.stop = () => { go = false; };
  }
  await wait(2700); // past the last action
  if (moving) {
    await until(async () => (await call(r.port, "/__jarvis/sockets", { method: "GET", headers: swHeaders })).json.totals.sockets === 0, 20_000, "every old socket moved");
    moving.stop();
    await moving;
  }
  try {
    await until(() => tabs.every((t) => t.connected && t.side === "new" && !t.composer.length && !t.pending.size), 20_000, "every composer empty and every request answered");
  } catch (e) {
    const left = tabs.filter((t) => !(t.connected && t.side === "new" && !t.composer.length && !t.pending.size));
    throw new Error(`${e.message}: ${left.map((t) => `${t.id} connected=${t.connected} side=${t.side} opens=${t.opens} refused=${t.refused} composer=${t.composer.length} pending=${t.pending.size}`).join("; ")}`);
  }
  await wait(300); // late frames (none expected)
  const rep = (await call(r.port, "/__jarvis/sockets", { method: "GET", headers: swHeaders })).json;
  const ups = await Promise.all(uploads);

  // ------------------------------------------------ the checker ------------------------------------------------
  const findings = [];
  const old = new Map(), neu = new Map();
  for (const id of oldSeen(r)) old.set(id, (old.get(id) || 0) + 1);
  for (const id of pigeon.seen) neu.set(id, (neu.get(id) || 0) + 1);
  for (const a of f.actions) {
    const n = (old.get(a.fuzzId) || 0) + (neu.get(a.fuzzId) || 0);
    if (n !== 1) findings.push(`${a.kind} ${a.fuzzId}: accepted ${n} times (old ${old.get(a.fuzzId) || 0}, pigeon ${neu.get(a.fuzzId) || 0}); writes ${JSON.stringify(a.writes)}`);
    if (a.accepted.length !== 1) findings.push(`${a.kind} ${a.fuzzId}: answered ${a.accepted.length} times in its tab`);
  }
  const seenOld = new Set(old.keys());
  // an old write the old child never saw: read by the router after its close decision (or lost: then it is a finding)
  let afterClose = 0;
  for (const t of tabs) for (const w of t.oldWrites) {
    const a = f.actions.find((x) => x.fuzzId === w.fuzzId);
    const answeredOld = a.accepted.some((x) => x.requestId === w.requestId);
    if (!answeredOld && !seenOld.has(w.fuzzId)) afterClose++;
  }
  const counters = rep.counters;
  if (!naive && afterClose !== counters.inflightClosesTotal) findings.push(`after-close frames ${afterClose} != inflightClosesTotal ${counters.inflightClosesTotal}`);
  if (!naive) {
    for (const t of tabs) if (t.opens !== 2) findings.push(`tab ${t.id}: ${t.opens - 1} reconnects (expected exactly 1)`);
    if (counters.opaqueSocketsTotal) findings.push(`opaque sockets: ${counters.opaqueSocketsTotal}`);
    const timedOut = tabs.reduce((n, t) => n + t.timedOut, 0);
    if (timedOut) findings.push(`${timedOut} upgrades had no answer within the connect timeout`);
    if (counters.refusedUpgradesTotal !== tabs.reduce((n, t) => n + t.refused, 0)) findings.push(`refused upgrades ${counters.refusedUpgradesTotal} != the tabs' ${tabs.reduce((n, t) => n + t.refused, 0)}`);
    for (const u of ups) {
      const got = pigeon.uploads.find((x) => x.tag === u.tag);
      if (u.res.status !== 200 || u.res.json?.by !== "pigeon") findings.push(`upload ${u.tag}: answered ${u.res.status} ${u.res.body.slice(0, 80)}`);
      else if (!got || got.sha !== u.sha || !got.access) findings.push(`upload ${u.tag}: pigeon got ${got ? `sha ${got.sha.slice(0, 12)}, access ${!!got.access}` : "nothing"}`);
    }
  }
  const stats = {
    seed, actions: f.actions.length, afterClose, moved: counters.movedTotal, inflightCloses: counters.inflightClosesTotal,
    resent: f.actions.filter((a) => a.writes.length > 1).length, staleEdgeRefusals: tabs.reduce((n, t) => n + t.refused, 0),
    uploadsPassedOn: counters.passedOnTotal,
  };

  f.stopping = true;
  for (const t of timers) clearTimeout(t);
  for (const t of tabs) t.stop();
  f.oldProxy.close();
  f.newProxy.close();
  await r.drain();
  pigeon.close();
  return { findings, stats };
}

const ROUNDS = Number(process.env.FUZZ_ROUNDS || 3);
const SEED0 = process.env.FUZZ_SEED ? Number(process.env.FUZZ_SEED) : (Date.now() & 0x7fffffff);

test(`move fuzz: sends, steers and Stops around a move with network delay are each accepted once (seed ${SEED0}, ${ROUNDS} rounds)`, { timeout: 600_000 }, async () => {
  let total = 0, afterClose = 0, resent = 0;
  for (let i = 0; i < ROUNDS; i++) {
    const seed = (SEED0 + i * 7919) >>> 0;
    const { findings, stats } = await round(seed);
    console.log("move fuzz round", JSON.stringify(stats));
    assert.deepEqual(findings, [], `seed ${seed} (replay: FUZZ_SEED=${seed} FUZZ_ROUNDS=1)`);
    total += stats.actions;
    afterClose += stats.afterClose;
    resent += stats.resent;
  }
  console.log(`move fuzz: ${total} actions, ${resent} sent again after a move, ${afterClose} read after a close decision`);
  assert.ok(total >= ROUNDS * 250, "enough actions per round");
});

test("move fuzz self-check: a mover that is not request-aware (every old connection cut at T0) is caught", { timeout: 120_000 }, async () => {
  const seed = (SEED0 ^ 0x5bd1e995) >>> 0;
  const { findings, stats } = await round(seed, { naive: true });
  console.log("move fuzz naive round", JSON.stringify({ ...stats, findings: findings.length }));
  assert.ok(findings.some((x) => /accepted 2 times/.test(x)), `seed ${seed}: the cut requests come back as duplicates (findings: ${findings.slice(0, 3).join("; ")})`);
});
