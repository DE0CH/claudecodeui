import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { releaseTestDatabase } from '@/modules/database/testing.js';
import { createJarvisSwitchRouter, switchBusy } from '@/modules/jarvis/jarvis-switch.routes.js';
import { paseoHub } from '@/modules/paseo/paseo-hub.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import { queryClaudeSDK } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

/**
 * GET /api/jarvis/switch/busy (jarvis-switch.routes.ts) against the real running list, Claude runtime and Paseo hub:
 * what the old router's `restart` must not stop beyond the running list. A hold on the launch rule (a tool that
 * reports no task) and a Paseo message sent before its run registers are in no running list; the route lists both.
 */

const after = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (await condition()) return;
    await after(50);
  }
  assert.fail(`timed out waiting for ${what}`);
}

async function withIsolatedDatabase(runTest: () => Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarvis-switch-db-'));
  await closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  await initializeDatabase();
  try {
    await runTest();
  } finally {
    await releaseTestDatabase();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

/** An empty Claude CLI process registry, so the running list never reads the machine's real `~/.claude/sessions`. */
async function withEmptyCliRegistry(runTest: () => Promise<void>): Promise<void> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'jarvis-switch-home-'));
  await mkdir(path.join(home, '.claude', 'sessions'), { recursive: true });
  const realHomedir = os.homedir;
  (os as unknown as { homedir: () => string }).homedir = () => home;
  try {
    await runTest();
  } finally {
    (os as unknown as { homedir: () => string }).homedir = realHomedir;
    await rm(home, { recursive: true, force: true });
  }
}

type Script = { emit: (m: Record<string, unknown>) => void; end: () => void; released: () => boolean };

/** queryClaudeSDK with a scripted SDK stream (as claude-runtime-hold.test.ts): `released` = the CLI's stdin ended. */
async function withClaudeTurn(sessionId: string, runTest: (script: Script) => Promise<void>): Promise<void> {
  const queue: Array<Record<string, unknown> | null> = [];
  let wake: (() => void) | null = null;
  let released = false;
  const script: Script = {
    emit: (m) => { queue.push(m); wake?.(); },
    end: () => { queue.push(null); wake?.(); },
    released: () => released,
  };
  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = ({ prompt }) => {
    void (async () => {
      for await (const _m of prompt) { /* the CLI reads its stdin */ }
      released = true;
    })();
    const iterator = (async function* () {
      for (;;) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => { wake = resolve; });
          wake = null;
          continue;
        }
        const next = queue.shift();
        if (next === null || next === undefined) return;
        yield next;
      }
    })();
    return Object.assign(iterator, { interrupt: async () => {}, stopTask: async () => {} });
  };
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'jarvis-switch-cwd-'));
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: async () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, id) => sessions.normalizeMessage(raw, id),
    isProviderInstalled: async () => true,
    createQuery,
  };
  const writer = { send: (_m: NormalizedMessage) => {}, userId: null };
  try {
    const done = queryClaudeSDK('hello', { sessionId, cwd }, writer as never, context);
    try {
      await runTest(script);
    } finally {
      script.end();
      await done;
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

const NATIVE = 'native-switch-session';
const init = () => ({ type: 'system', subtype: 'init', session_id: NATIVE });
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'assistant', session_id: NATIVE, parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const ack = (id: string, text: string, toolUseResult: Record<string, unknown>) => ({
  type: 'user', session_id: NATIVE, parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
  tool_use_result: toolUseResult,
});
const taskStarted = (taskId: string, toolUseId: string, taskType: string) => ({
  type: 'system', subtype: 'task_started', session_id: NATIVE, task_id: taskId, tool_use_id: toolUseId, description: `Task ${taskId}`, task_type: taskType,
});
const result = () => ({ type: 'result', subtype: 'success', session_id: NATIVE, result: 'done', duration_ms: 1, num_turns: 1 });
const runningIds = async () => (await sessionsService.listRunningSessions()).map((entry) => entry.sessionId);

test('a hold on the launch rule (no task reported) is in no running list; /switch/busy lists its process until it ends', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => withEmptyCliRegistry(() => withClaudeTurn('switch-hold', async (script) => {
    script.emit(init());
    script.emit(toolUse('toolu_monitor', 'Monitor', { command: 'tail -f x', description: 'watch', timeout_ms: 1000 }));
    script.emit(ack('toolu_monitor', 'Monitor started', {}));
    script.emit(result());
    await until(async () => (await switchBusy()).processes.includes('switch-hold'), 'the process to be listed');
    await after(200);
    assert.equal(script.released(), false, 'the process is held after its result');
    assert.ok(!(await runningIds()).includes('switch-hold'), 'the running list misses the hold');
    const busy = await switchBusy();
    assert.deepEqual(busy.processes, ['switch-hold']);
    assert.deepEqual([busy.running, busy.preparing, busy.pending], [[], [], []]);
  })));
  assert.deepEqual((await switchBusy()).processes, [], 'the process ended: nothing held');
});

test('a background task: the running list has it (background), and so does /switch/busy', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => withEmptyCliRegistry(() => withClaudeTurn('switch-bg', async (script) => {
    script.emit(init());
    script.emit(toolUse('toolu_bash', 'Bash', { command: 'sleep 600', run_in_background: true }));
    script.emit(taskStarted('b1', 'toolu_bash', 'local_bash'));
    script.emit(ack('toolu_bash', 'Command running in background with ID: b1', { backgroundTaskId: 'b1' }));
    script.emit(result());
    await until(async () => (await runningIds()).includes('switch-bg'), 'the background work to be listed');
    const entry = (await sessionsService.listRunningSessions()).find((e) => e.sessionId === 'switch-bg');
    assert.equal(entry?.background, true);
    const busy = await switchBusy();
    assert.deepEqual([busy.running, busy.processes], [['switch-bg'], ['switch-bg']]);
  })));
});

test('Paseo: a message sent before its run registers, and a sandbox preparing, are not in the running list but are busy', { concurrency: false }, async () => {
  const hub = paseoHub as unknown as { onChatFrame: (frame: Record<string, unknown>) => void };
  await withIsolatedDatabase(() => withEmptyCliRegistry(async () => {
    paseoHub.resetForTests();
    try {
      await sessionsDb.createAppSession('switch-paseo', 'claude', '/tmp/switch-paseo');
      // no hub chat client started: the message is on the timeline and pending, and no run exists yet
      await paseoHub.send('switch-paseo', 'hello', 'cm-1');
      assert.deepEqual(await runningIds(), []);
      assert.deepEqual((await switchBusy()).pending, ['switch-paseo']);
      // a send refused before it ran gets no `complete`: no longer pending
      hub.onChatFrame({ kind: 'protocol_error', sessionId: 'switch-paseo', message: 'no' });
      assert.deepEqual((await switchBusy()).pending, []);
      await paseoHub.send('switch-paseo', 'again', 'cm-2');
      hub.onChatFrame({ kind: 'status', sessionId: 'switch-paseo', jarvisSandbox: 'preparing' });
      let busy = await switchBusy();
      assert.deepEqual([busy.preparing, busy.pending], [['switch-paseo'], ['switch-paseo']]);
      hub.onChatFrame({ kind: 'complete', sessionId: 'switch-paseo', exitCode: 0 });
      busy = await switchBusy();
      assert.deepEqual([busy.running, busy.processes, busy.preparing, busy.pending], [[], [], [], []]);
    } finally {
      paseoHub.resetForTests();
    }
  }));
});

test('GET /switch/busy answers the four lists, and 500 when it cannot tell', async () => {
  const serve = async (router: express.Router) => {
    const app = express();
    app.use('/api/jarvis', router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const { port } = server.address() as AddressInfo;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/jarvis/switch/busy`);
      return { status: r.status, body: await r.json() };
    } finally {
      server.close();
    }
  };
  const ok = await serve(createJarvisSwitchRouter({
    listRunning: async () => [{ sessionId: 'a' }],
    listProcesses: () => ['b'],
    hubState: () => ({ preparing: ['c'], pending: ['d'] }),
  }));
  assert.deepEqual(ok, { status: 200, body: { running: ['a'], processes: ['b'], preparing: ['c'], pending: ['d'] } });
  const failed = await serve(createJarvisSwitchRouter({
    listRunning: async () => { throw new Error('db down'); },
    listProcesses: () => [],
    hubState: () => ({ preparing: [], pending: [] }),
  }));
  assert.equal(failed.status, 500);
});
