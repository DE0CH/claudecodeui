// A stand-in for CloudCLI's server in the router tests: /health, /api/providers/sessions/running (the count in
// $HOME/running), an echo of the request and its contract env, and a raw WebSocket-style upgrade that echoes bytes.
import http from "node:http";
import { readFileSync } from "node:fs";
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
    for (const k of ["VITE_IS_PLATFORM", "HOST", "SERVER_PORT", "HOME", "DATABASE_URL", "DATABASE_SCHEMA", "JWT_SECRET", "JARVIS_WEB_URL", "JARVIS_CC_TOKEN", "JARVIS_CC_OWNER", "JARVIS_JFS_ROOT"]) env[k] = process.env[k];
    res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body, env, pid: process.pid }));
  });
});
server.on("upgrade", (req, socket) => {
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: test\r\nConnection: Upgrade\r\nX-Jarvis-User-Seen: " + (req.headers["x-jarvis-user"] || "") + "\r\n\r\n");
  socket.on("data", (d) => socket.write(d));
});
if (process.env.FAKE_SLOW_START) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_SLOW_START)));
server.listen(Number(process.env.SERVER_PORT), process.env.HOST);
process.on("SIGTERM", () => process.exit(0));
