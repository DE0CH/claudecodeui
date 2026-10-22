// Jarvis 3 (DE0CH/jarvis3 docs/CLAUDE-CODE.md): Claude Code runs inside the conversation's gVisor sandbox, not in
// this process. The Agent SDK's `spawnClaudeCodeProcess` hands us the command it would run locally; we run the
// sandbox's own `claude` with the same flags through the sandbox agent's `/proc` endpoint (an upgraded HTTP
// connection carrying stdin, stdout, stderr and the exit status as frames) and give the SDK an object with the
// ChildProcess surface it needs. The sandbox is obtained from Jarvis 3's web role (`/internal/cc/sandbox`), which makes
// it if needed (the conversation's /workspace and the owner's ~/.claude come with it, on JuiceFS).
import { EventEmitter } from 'node:events';
import { request as httpRequest } from 'node:http';
import { PassThrough, Writable } from 'node:stream';
import type { Socket } from 'node:net';

import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';

import { SandboxServiceError } from '@/modules/jarvis/jarvis-errors.js';

const PROC_STDIN = 0;
const PROC_STDOUT = 1;
const PROC_STDERR = 2;
const PROC_EXIT = 3;
const PROC_STDIN_END = 4;
const PROC_SIGNAL = 5;
const TOUCH_EVERY_MS = 60_000;

/** The only variables of the SDK's environment that go into the sandbox (the rest are this pod's). */
const FORWARDED_ENV = /^(CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS|MAX_THINKING_TOKENS|CLAUDE_CODE_MAX_OUTPUT_TOKENS)$/;

export interface JarvisSandbox {
  id: string;
  url: string;
  token: string;
  headers: Record<string, string>;
}

export { jarvisEnabled } from '@/modules/jarvis/jarvis-config.js';

async function internal(path: string, body: Record<string, unknown>): Promise<any> {
  const base = process.env.JARVIS_WEB_URL;
  const token = process.env.JARVIS_CC_TOKEN;
  if (!base || !token) throw new Error('JARVIS_WEB_URL and JARVIS_CC_TOKEN must be set');
  let r: Response;
  try {
    r = await fetch(`${base.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20 * 60_000),
    });
  } catch (error) {
    throw new SandboxServiceError(0, `sandbox service unreachable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await r.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!r.ok) throw new SandboxServiceError(r.status, data?.error || `sandbox service answered ${r.status}`);
  return data;
}

/** The conversation's sandbox (made if needed; may take a minute when a host has to start). */
export async function acquireSandbox(conversationId: string): Promise<JarvisSandbox> {
  const owner = process.env.JARVIS_CC_OWNER;
  if (!owner) throw new Error('JARVIS_CC_OWNER must be set');
  return await internal('/internal/cc/sandbox', { owner, conversation: conversationId });
}

/**
 * Status texts of the wait for the conversation's sandbox, sent to the client as `status` frames: the staff UI shows
 * `JARVIS_PREPARING_STATUS` as its own "preparing the workspace" indicator (not the thinking one), and
 * `JARVIS_READY_STATUS` ends it. Only a wait longer than `PREPARING_AFTER_MS` is announced, so a warm sandbox
 * (ready in well under a second) never flashes it.
 */
export const JARVIS_PREPARING_STATUS = 'jarvis_preparing';
export const JARVIS_READY_STATUS = 'jarvis_ready';
export const PREPARING_AFTER_MS = 1_000;

export type SandboxStatusFrame = { text: typeof JARVIS_PREPARING_STATUS | typeof JARVIS_READY_STATUS; canInterrupt: boolean };

/**
 * `acquireSandbox`, telling the client through `report` when it has to wait: `preparing` once the wait passes
 * `afterMs` (nothing can be stopped yet: the turn has no Claude Code process), `ready` when the sandbox came after
 * that. A failure ends with no `ready`: the turn's error and `complete` follow.
 */
export async function acquireSandboxReporting(
  conversationId: string,
  report: (frame: SandboxStatusFrame) => void,
  { afterMs = PREPARING_AFTER_MS, acquire = acquireSandbox }: { afterMs?: number; acquire?: (id: string) => Promise<JarvisSandbox> } = {},
): Promise<JarvisSandbox> {
  let announced = false;
  const timer = setTimeout(() => {
    announced = true;
    report({ text: JARVIS_PREPARING_STATUS, canInterrupt: false });
  }, afterMs);
  try {
    const sandbox = await acquire(conversationId);
    clearTimeout(timer);
    if (announced) report({ text: JARVIS_READY_STATUS, canInterrupt: true });
    return sandbox;
  } finally {
    clearTimeout(timer);
  }
}

export async function releaseSandbox(conversationId: string): Promise<void> {
  await internal('/internal/cc/release', { conversation: conversationId });
}

function frame(type: number, payload?: Buffer | string): Buffer {
  const b = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? '');
  const h = Buffer.alloc(5);
  h[0] = type;
  h.writeUInt32BE(b.length, 1);
  return Buffer.concat([h, b]);
}

/** The CLI flags of the SDK's command, without the local executable (and the cli.js path when it runs under node). */
export function claudeArgs(options: Pick<SpawnOptions, 'command' | 'args'>): string[] {
  const args = [...options.args];
  while (args.length && !args[0]!.startsWith('-')) args.shift();
  return args;
}

/**
 * Claude Code in `sandbox` for `conversationId`, with the SDK's flags; the returned object behaves like the
 * ChildProcess the SDK would have spawned.
 */
export function spawnInSandbox(sandbox: JarvisSandbox, conversationId: string, options: SpawnOptions): SpawnedProcess {
  const ev = new EventEmitter();
  const stdout = new PassThrough();
  let socket: Socket | null = null;
  const pending: Buffer[] = [];
  let exitCode: number | null = null;
  let killed = false;
  let done = false;

  const send = (b: Buffer) => {
    if (socket && !socket.destroyed) socket.write(b);
    else if (!socket) pending.push(b);
  };
  const stdin = new Writable({
    write(chunk: Buffer, _enc, cb) {
      send(frame(PROC_STDIN, chunk));
      cb();
    },
    final(cb) {
      send(frame(PROC_STDIN_END));
      cb();
    },
  });
  const finish = (code: number | null, signal: NodeJS.Signals | null) => {
    if (done) return;
    done = true;
    exitCode = code;
    clearInterval(touch);
    stdout.end();
    ev.emit('exit', code, signal);
    ev.emit('close', code, signal);
  };
  const fail = (err: Error) => {
    if (done) return;
    ev.emit('error', err);
    finish(1, null);
  };

  // the sandbox is in use while Claude Code runs: its idle time starts again every minute
  const touch = setInterval(() => void internal('/internal/cc/touch', { conversation: conversationId }).catch(() => {}), TOUCH_EVERY_MS);
  touch.unref();

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(options.env ?? {})) if (FORWARDED_ENV.test(k) && typeof v === 'string') env[k] = v;
  const spec = { args: ['claude', ...claudeArgs(options)], cwd: '/workspace', env };
  const url = new URL('/proc', sandbox.url);
  const req = httpRequest({
    hostname: url.hostname,
    port: url.port || 80,
    path: url.pathname,
    headers: {
      ...sandbox.headers,
      connection: 'Upgrade',
      upgrade: 'jarvis-proc',
      authorization: `Bearer ${sandbox.token}`,
      'x-proc': Buffer.from(JSON.stringify(spec)).toString('base64'),
    },
  });
  req.on('upgrade', (_res, sock) => {
    socket = sock;
    sock.setNoDelay(true);
    for (const b of pending.splice(0)) sock.write(b);
    let buf: Buffer = Buffer.alloc(0);
    sock.on('data', (c: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, c]) : c;
      while (buf.length >= 5) {
        const n = buf.readUInt32BE(1);
        if (buf.length < 5 + n) break;
        const type = buf[0];
        const payload = buf.subarray(5, 5 + n);
        buf = buf.subarray(5 + n);
        if (type === PROC_STDOUT) stdout.write(payload);
        else if (type === PROC_STDERR) process.stderr.write(`[sandbox ${sandbox.id.slice(0, 8)}] ${payload.toString('utf8')}`);
        else if (type === PROC_EXIT) {
          let e: { code: number | null; signal: NodeJS.Signals | null } = { code: 1, signal: null };
          try {
            e = JSON.parse(payload.toString('utf8'));
          } catch {
            /* keep the default */
          }
          finish(e.code, e.signal);
        }
      }
    });
    sock.on('close', () => finish(exitCode ?? (killed ? null : 1), killed ? 'SIGTERM' : null));
    sock.on('error', (e) => fail(e));
  });
  req.on('response', (res) => {
    let body = '';
    res.on('data', (c) => (body += c));
    res.on('end', () => fail(new Error(`the sandbox refused to start Claude Code (${res.statusCode}): ${body.trim()}`)));
  });
  req.on('error', (e) => fail(e));
  req.end();

  options.signal?.addEventListener('abort', () => proc.kill('SIGTERM'), { once: true });

  const proc = {
    stdin,
    stdout,
    get killed() {
      return killed;
    },
    get exitCode() {
      return exitCode;
    },
    kill(signal: NodeJS.Signals = 'SIGTERM') {
      if (done) return false;
      killed = true;
      if (socket && !socket.destroyed) socket.write(frame(PROC_SIGNAL, signal));
      else req.destroy();
      return true;
    },
    on(event: string, listener: (...a: any[]) => void) {
      ev.on(event, listener);
      return proc;
    },
    once(event: string, listener: (...a: any[]) => void) {
      ev.once(event, listener);
      return proc;
    },
    off(event: string, listener: (...a: any[]) => void) {
      ev.off(event, listener);
      return proc;
    },
  };
  return proc as unknown as SpawnedProcess;
}
