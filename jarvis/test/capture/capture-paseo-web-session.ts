// Captures the raw bytes of a Paseo web session with CloudCLI's Paseo bridge (server/modules/paseo), for the router's
// switch window tests (jarvis/test/router.test.mjs "recorded session"). Nothing is synthetic on the wire:
// - the server is the bridge's own code (handlePaseoConnection) on a real `ws` WebSocketServer, as CloudCLI runs it
//   (perMessageDeflate off, its default); CloudCLI's session store is in memory (as the bridge's tests do);
// - the client is a real `ws` WebSocket (masked frames), and every session message is built the way Paseo's client
//   builds it: SessionInboundMessageSchema.parse (paseo/packages/protocol, zod: keys in schema order) wrapped as
//   {type: "session", message} (daemon-client.ts sendCorrelatedSessionRequest, sendSessionPayload); hello is the
//   literal of daemon-client.ts sendHello;
// - a TCP recorder between them keeps every chunk after the handshake, in both directions, in arrival order.
// The session: hello, a text ping, fetch_agents, a timeline page over 1 MB, workspace.create.request with a first
// prompt over 8 KB and an inline image (its requestId lies past the first 8 KB), a send with two inline images,
// heartbeats, and a close.
//
//   npx tsx --tsconfig server/tsconfig.json jarvis/test/capture/capture-paseo-web-session.ts jarvis/test/fixtures/paseo-web-session.ndjson.gz
//
// Output: gzipped NDJSON; the first line is {"meta": …}, then {"dir": "c2s"|"s2c", "step": n, "b64": chunk}.
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import { WebSocket, WebSocketServer } from 'ws';

process.env.HOME = mkdtempSync(path.join(os.tmpdir(), 'paseo-capture-'));
process.env.JARVIS_PRODUCT_NAME = 'Example AI';
process.env.JARVIS_MODEL = 'claude-opus-4-6';
process.env.JARVIS_MODEL_LABEL = 'Claude Opus 4.6';
process.env.JARVIS_WEB_URL = 'http://web.test';
process.env.JARVIS_CC_TOKEN = 'test-token';
process.env.JARVIS_CC_OWNER = 'person@example.com';
globalThis.fetch = (async () => new Response('{"ok":true}', { status: 200 })) as typeof fetch;

const { sessionsService } = await import('@/modules/providers/index.js');
const { paseoHub } = await import('@/modules/paseo/paseo-hub.js');
const { handlePaseoConnection } = await import('@/modules/paseo/paseo-connection.js');
const { SessionTimeline } = await import('@/modules/paseo/paseo-timeline.js');
const { SessionInboundMessageSchema } = await import('../../../paseo/packages/protocol/src/messages.ts');

type AnyRecord = Record<string, any>;
const out = process.argv[2];
if (!out) throw new Error('usage: capture-paseo-web-session.ts OUT.ndjson.gz');

// ------------------------------------------------------------------------------------- the session store, in memory
type Row = { session_id: string; provider_session_id: string | null; custom_name: string | null; created_at: string; updated_at: string; isArchived?: number };
const A = '0a5e5b9e-1c2d-4e3f-8a9b-000000000001';
const NEW = '0a5e5b9e-1c2d-4e3f-8a9b-000000000004';
const rows = new Map<string, Row>([
  [A, { session_id: A, provider_session_id: 'cc-a', custom_name: 'Quarterly figures', created_at: '2026-10-28 01:00:00', updated_at: '2026-10-29 09:30:00', isArchived: 0 }],
]);
const hub = paseoHub as any;
const sessions = sessionsService as any;
hub.ensureStarted = () => {};
hub.listSessions = async () => [...rows.values()].filter((row) => row.isArchived !== 1);
hub.listDeleted = async () => [];
hub.getSession = async (id: string) => rows.get(id) ?? null;
hub.isRunning = () => false;
hub.activeTurn = () => null;
sessions.createAppSession = async () => {
  rows.set(NEW, { session_id: NEW, provider_session_id: null, custom_name: null, created_at: '2026-10-29 11:00:00', updated_at: '2026-10-29 11:00:00', isArchived: 0 });
  return { sessionId: NEW };
};

// a conversation whose tail page is over 1 MB: a long tool result (a file the agent read) and long answers
const toRelative = (value: unknown): string | null => (typeof value === 'string' && value.startsWith('/workspace/') ? value.slice('/workspace/'.length) : null);
let n = 0;
const message = (fields: AnyRecord): AnyRecord => ({ id: `m${++n}`, sessionId: A, timestamp: `2026-10-29T09:${String(n % 60).padStart(2, '0')}:00.000Z`, provider: 'claude', ...fields });
const lines = (count: number, seed: string) => Array.from({ length: count }, (_, i) => `${seed} ${i}: ${createHash('sha256').update(`${seed}${i}`).digest('hex').slice(0, 8)} 收入 revenue for the quarter, see the ledger`).join('\n');
const timelineA = new SessionTimeline(toRelative);
for (const m of [
  message({ kind: 'text', role: 'user', content: 'Read the ledger and summarise it' }),
  message({ kind: 'tool_use', toolId: 't-read', toolName: 'Read', toolInput: { file_path: '/workspace/uploads/ledger.csv' } }),
  message({ kind: 'tool_result', toolId: 't-read', content: lines(16000, 'row'), toolResult: { content: lines(16000, 'row'), isError: false } }),
  message({ kind: 'text', role: 'assistant', content: lines(400, 'summary') }),
]) timelineA.apply(m as never);
const timelines = new Map<string, any>([[A, timelineA]]);
hub.timeline = async (id: string) => {
  let t = timelines.get(id);
  if (!t) timelines.set(id, (t = new SessionTimeline(toRelative)));
  return t;
};
const realCreate = hub.createConversation.bind(hub);
hub.createConversation = async (...args: unknown[]) => {
  const id = await realCreate(...args);
  timelines.set(id, hub.timelines.get(id));
  return id;
};

// --------------------------------------------------------------------------------- server, recorder, client
const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
await new Promise((resolve) => wss.once('listening', resolve));
wss.on('connection', (ws, req) => handlePaseoConnection(ws as never, { user: { id: 1 }, headers: req.headers } as never, { runtime: {} } as never));
const serverPort = (wss.address() as net.AddressInfo).port;

const events: AnyRecord[] = [];
let step = 0;
const recorder = net.createServer((c) => {
  const u = net.connect(serverPort, '127.0.0.1');
  const tap = (dir: string) => {
    let head = true, buf = Buffer.alloc(0);
    return (d: Buffer) => {
      if (head) {
        buf = Buffer.concat([buf, d]);
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        head = false;
        d = buf.subarray(i + 4);
        if (!d.length) return;
      }
      events.push({ dir, step, b64: d.toString('base64') });
    };
  };
  c.on('data', tap('c2s'));
  u.on('data', tap('s2c'));
  c.pipe(u).pipe(c);
});
await new Promise<void>((resolve) => recorder.listen(0, '127.0.0.1', resolve));

const ws = new WebSocket(`ws://127.0.0.1:${(recorder.address() as net.AddressInfo).port}/paseo-ws`, { perMessageDeflate: false, maxPayload: 100 * 1024 * 1024 });
await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
const answers = new Map<string, (m: AnyRecord) => void>();
let pong: (() => void) | null = null;
ws.on('message', (data) => {
  const f = JSON.parse(data.toString()) as AnyRecord;
  if (f.type === 'pong') { pong?.(); return; }
  const id = f.message?.payload?.requestId;
  if (id && answers.has(id)) { answers.get(id)!(f.message); answers.delete(id); }
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
let rid = 0;
/** A correlated request as Paseo's client sends it; resolves with the response once the bridge is quiet again. */
async function request(body: AnyRecord): Promise<AnyRecord> {
  step++;
  const requestId = `req-${++rid}-${createHash('sha256').update(String(rid)).digest('hex').slice(0, 12)}`;
  const parsed = SessionInboundMessageSchema.parse({ ...body, requestId });
  const got = new Promise<AnyRecord>((resolve) => answers.set(requestId, resolve));
  ws.send(JSON.stringify({ type: 'session', message: parsed }));
  const m = await got;
  await settle();
  return m;
}
async function push(body: AnyRecord) {
  step++;
  ws.send(JSON.stringify({ type: 'session', message: SessionInboundMessageSchema.parse(body) }));
  await settle();
}
const heartbeat = () => push({ type: 'client_heartbeat', deviceType: 'web', focusedAgentId: A, lastActivityAt: '2026-10-29T09:00:00.000Z', appVisible: true });
// a deterministic "photo": incompressible enough to be a real image's size, but reproducible
const image = (seed: string, bytes: number) => {
  const parts: Buffer[] = [];
  for (let i = 0; parts.length * 32 < bytes; i++) parts.push(createHash('sha256').update(`${seed}${i}`).digest());
  return { data: Buffer.concat(parts).subarray(0, bytes).toString('base64'), mimeType: 'image/jpeg' };
};

step++;
ws.send(JSON.stringify({ type: 'hello', clientId: 'cid-web-1', clientType: 'browser', protocolVersion: 1, capabilities: {}, appVersion: '0.13.2' }));
await settle();
step++;
await new Promise<void>((resolve) => { pong = resolve; ws.send(JSON.stringify({ type: 'ping' })); });
await settle();
await request({ type: 'fetch_agents_request', subscribe: {}, sync: {} });
await heartbeat();
await request({ type: 'agent.timeline.set_subscription.request', agentIds: [A] });
const page = await request({ type: 'fetch_agent_timeline_request', agentId: A, direction: 'tail', limit: 50, projection: 'projected' });
const prompt = `Draft a reply to the auditor using these notes:\n${lines(160, 'note')}`;
await request({
  type: 'workspace.create.request', idempotencyKey: 'idem-capture-1', subscribe: true,
  source: { kind: 'directory', path: '/workspace', projectId: 'prj_conversations' },
  agent: { config: { provider: 'claude', cwd: '/workspace' }, initialPrompt: prompt, clientMessageId: 'client-msg-create', images: [image('create', 24_000)] },
});
await heartbeat();
await request({ type: 'send_agent_message_request', agentId: A, text: 'And these two receipts?', messageId: 'client-msg-send', images: [image('r1', 60_000), image('r2', 40_000)] });
await heartbeat();
step++;
await new Promise<void>((resolve) => { ws.once('close', () => resolve()); ws.close(1000); });
await settle();

const meta = {
  what: 'a Paseo web session with CloudCLI\'s Paseo bridge, bytes after the 101 (capture-paseo-web-session.ts)',
  steps: step,
  timelinePageBytes: Buffer.byteLength(JSON.stringify(page)),
  createPromptBytes: Buffer.byteLength(prompt),
};
if (meta.timelinePageBytes < 1 << 20) throw new Error(`the timeline page is only ${meta.timelinePageBytes} bytes`);
writeFileSync(out, gzipSync([JSON.stringify({ meta }), ...events.map((e) => JSON.stringify(e))].join('\n') + '\n'));
console.log(`captured ${events.length} chunks in ${step} steps to ${out}`, meta);
recorder.close();
wss.close();
process.exit(0);
