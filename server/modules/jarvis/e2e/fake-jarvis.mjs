// Stand-in for Jarvis 3's web role (/internal/cc/*) and one sandbox agent (GET /proc upgrade), for the local e2e.
// /proc runs the local `claude` with cwd /workspace (a bind mount of $JFS/ws/<conversation>), HOME whose .claude is
// the user's JuiceFS folder stand-in, and the mock Anthropic API. Logs every call to stdout.
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const port = Number(process.env.FAKE_PORT || 17070);
const TOKEN = process.env.JARVIS_CC_TOKEN || 'cc-test-token';
const AGENT_TOKEN = 'agent-test-token';
const JFS = process.env.JFS;
const SANDBOX_HOME = process.env.SANDBOX_HOME;
let conversation = null;
const frame = (t, b) => { const p = Buffer.isBuffer(b) ? b : Buffer.from(b ?? ''); const h = Buffer.alloc(5); h[0] = t; h.writeUInt32BE(p.length, 1); return Buffer.concat([h, p]); };

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    console.log('HTTP', req.method, req.url, body);
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401); res.end('{"error":"unauthorized"}'); return; }
    const b = JSON.parse(body || '{}');
    if (req.url === '/internal/cc/sandbox') {
      if (process.env.FAKE_SANDBOX_FAIL) { res.writeHead(Number(process.env.FAKE_SANDBOX_FAIL), { 'content-type': 'application/json' }); res.end('{"error":"no capacity"}'); return; }
      conversation = b.conversation;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'sbx-local-1', url: `http://127.0.0.1:${port}`, token: AGENT_TOKEN, headers: {}, reset: false }));
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end('{"ok":true}');
  });
});
server.on('upgrade', (req, sock) => {
  const given = req.headers['x-jarvis-exec-token'] || (/^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '') || [])[1];
  if (given !== AGENT_TOKEN || req.url !== '/proc') { sock.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
  const spec = JSON.parse(Buffer.from(String(req.headers['x-proc']), 'base64').toString('utf8'));
  console.log('PROC', JSON.stringify(spec.args.slice(0, 3)), '... cwd', spec.cwd, 'env', Object.keys(spec.env || {}));
  const ws = path.join(JFS, 'ws', conversation);
  mkdirSync(ws, { recursive: true });
  try { execFileSync('sudo', ['umount', '/workspace'], { stdio: 'ignore' }); } catch {}
  execFileSync('sudo', ['mount', '--bind', ws, '/workspace']);
  sock.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: jarvis-proc\r\n\r\n');
  const child = spawn(spec.args[0], spec.args.slice(1), {
    cwd: '/workspace',
    env: {
      PATH: process.env.PATH, HOME: SANDBOX_HOME,
      ANTHROPIC_BASE_URL: process.env.MOCK_URL, ANTHROPIC_API_KEY: 'sk-ant-mock', ANTHROPIC_MODEL: 'claude-sonnet-5-5',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', ...(spec.env || {}),
    },
  });
  child.stdout.on('data', (d) => sock.write(frame(1, d)));
  child.stderr.on('data', (d) => { process.stdout.write(`[claude stderr] ${d}`); sock.write(frame(2, d)); });
  child.on('exit', (code, signal) => { console.log('PROC exit', code, signal); sock.end(frame(3, JSON.stringify({ code, signal }))); });
  let buf = Buffer.alloc(0);
  sock.on('data', (c) => {
    buf = Buffer.concat([buf, c]);
    while (buf.length >= 5) {
      const n = buf.readUInt32BE(1); if (buf.length < 5 + n) break;
      const t = buf[0]; const p = buf.subarray(5, 5 + n); buf = buf.subarray(5 + n);
      if (t === 0) child.stdin.write(p); else if (t === 4) child.stdin.end(); else if (t === 5) child.kill(p.toString() || 'SIGTERM');
    }
  });
  sock.on('close', () => { if (child.exitCode === null) child.kill('SIGTERM'); });
});
server.listen(port, '127.0.0.1', () => console.log(`fake jarvis on ${port}`));
