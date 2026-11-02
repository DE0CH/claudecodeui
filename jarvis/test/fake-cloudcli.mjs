// A stand-in for CloudCLI's server in the router tests: /health, /api/providers/sessions/running (the count in
// $HOME/running), /slow?ms= (answers after that long), an echo of the request and its contract env, and upgrades: a raw
// one that echoes bytes; a real WebSocket handshake (`Upgrade: websocket`) that echoes bytes on /ws-echo and answers
// like a tiny Paseo host on /paseo-ws (each request id answered after its message's `delayMs`, `{"type":"ping"}` with a
// pong; every message it read is appended to $HOME/paseo-seen). `?ext=1` negotiates an extension in the 101.
// /paseo-replay?f=<fixture>&id=<n> replays a captured session (jarvis/test/capture): each server chunk is written once
// the client bytes captured before it have all arrived; the client bytes it reads go to $HOME/replay-rx-<n>.
import http from "node:http";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import path from "node:path";

const running = () => { try { return Number(readFileSync(path.join(process.env.HOME, "running"), "utf8")) || 0; } catch { return 0; } };
const server = http.createServer((req, res) => {
  if (req.url === "/health") return res.end(JSON.stringify({ status: "ok" }));
  if (req.url === "/api/providers/sessions/running") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ success: true, data: { sessions: Array.from({ length: running() }, (_, i) => ({ sessionId: String(i) })) } }));
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    const env = {};
    for (const k of ["VITE_IS_PLATFORM", "HOST", "SERVER_PORT", "HOME", "DATABASE_URL", "DATABASE_SCHEMA", "JWT_SECRET", "JARVIS_WEB_URL", "JARVIS_CC_TOKEN", "JARVIS_CC_OWNER", "JARVIS_JFS_ROOT", "JARVIS_UI_PURGE"]) env[k] = process.env[k];
    const out = () => res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body, env, pid: process.pid }));
    const slow = /^\/slow\?ms=(\d+)/.exec(req.url);
    if (slow) setTimeout(out, Number(slow[1])); else out();
  });
});

/** Unmasked server frame. */
function frame(opcode, payload) {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
  return Buffer.concat([head, payload]);
}

/** Calls onMessage(opcode, payload) for each whole client frame (no fragmentation handling: tests send whole frames). */
function frames(socket, onMessage) {
  let buf = Buffer.alloc(0);
  socket.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      const masked = buf[1] & 0x80; let len = buf[1] & 0x7f; let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const mask = masked ? buf.subarray(off, off + 4) : null; if (masked) off += 4;
      if (buf.length < off + len) return;
      const payload = Buffer.from(buf.subarray(off, off + len));
      if (mask) for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
      const opcode = buf[0] & 0x0f;
      buf = buf.subarray(off + len);
      onMessage(opcode, payload);
    }
  });
}

server.on("upgrade", (req, socket) => {
  if (String(req.headers.upgrade).toLowerCase() === "websocket") {
    const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    const ext = /[?&]ext=1/.test(req.url) ? "Sec-WebSocket-Extensions: permessage-deflate\r\n" : "";
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${ext}` +
      `X-Lu-Seen: ${req.headers["x-aviary-lu"] || ""}\r\nX-Jarvis-User-Seen: ${req.headers["x-jarvis-user"] || ""}\r\n\r\n`);
    socket.on("error", () => {});
    if (req.url.startsWith("/ws-echo")) { socket.on("data", (d) => socket.write(d)); return; }
    if (req.url.startsWith("/paseo-replay")) return replay(socket, new URL(req.url, "http://x").searchParams);
    frames(socket, (opcode, payload) => {
      if (opcode !== 1) return;
      appendFileSync(path.join(process.env.HOME, "paseo-seen"), payload.toString("utf8") + "\n");
      let m; try { m = JSON.parse(payload.toString("utf8")); } catch { return; }
      if (m.type === "ping") return socket.write(frame(1, Buffer.from('{"type":"pong"}')));
      const id = m.message?.requestId;
      if (!id) return;
      const type = m.message.type === "fail_request" ? "rpc_error" : String(m.message.type).replace(/_request$/, "_response");
      const reply = Buffer.from(JSON.stringify({ type: "session", message: { type, payload: { requestId: id, ...(m.message.pad ? { pad: m.message.pad } : {}) } } }));
      setTimeout(() => { if (!socket.destroyed) socket.write(frame(1, reply)); }, Number(m.message.delayMs || 0));
    });
    return;
  }
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: test\r\nConnection: Upgrade\r\nX-Jarvis-User-Seen: " + (req.headers["x-jarvis-user"] || "") +
    "\r\nX-Jarvis-Viewer-Seen: " + (req.headers["x-jarvis-viewer"] || "") + "\r\nX-Url-Seen: " + req.url + "\r\n\r\n");
  socket.on("data", (d) => socket.write(d));
});
const fixtures = new Map();
/** The captured session's chunks: [{dir, buf, before}] (`before`: client bytes captured before this chunk). */
function fixture(file) {
  if (!fixtures.has(file)) {
    let before = 0;
    const events = gunzipSync(readFileSync(file)).toString("utf8").trim().split("\n").slice(1).map((l) => {
      const e = JSON.parse(l);
      const out = { dir: e.dir, buf: Buffer.from(e.b64, "base64"), before };
      if (e.dir === "c2s") before += out.buf.length;
      return out;
    });
    fixtures.set(file, events);
  }
  return fixtures.get(file);
}
function replay(socket, q) {
  const events = fixture(q.get("f"));
  const rxFile = q.get("id") ? path.join(process.env.HOME, `replay-rx-${q.get("id")}`) : null;
  socket.setNoDelay(true);
  let got = 0, i = 0;
  const flush = () => {
    for (; i < events.length; i++) {
      const e = events[i];
      if (e.dir === "c2s") continue;
      if (e.before > got) return;
      socket.write(e.buf);
      if (e.buf[0] === 0x88) socket.end(); // the server's close frame: then the TCP close, as ws does
    }
  };
  socket.on("data", (d) => {
    got += d.length;
    if (rxFile) appendFileSync(rxFile, d);
    flush();
  });
  flush();
}

if (process.env.FAKE_SLOW_START) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_SLOW_START)));
server.listen(Number(process.env.SERVER_PORT), process.env.HOST);
process.on("SIGTERM", () => process.exit(0));
