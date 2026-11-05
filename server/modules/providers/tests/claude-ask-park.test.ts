import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, jarvisOpenQuestionsDb, sessionsDb } from '@/modules/database/index.js';
import { releaseTestDatabase } from '@/modules/database/testing.js';
import { OpenQuestions, openQuestions } from '@/modules/jarvis/index.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import {
  askTimeoutMessage,
  getActiveClaudeSDKSessions,
  getPendingApprovalsForSession,
  listClaudeSDKOpenQuestions,
  queryClaudeSDK,
  resolveToolApproval,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

/** What the switch's busy route (jarvis-switch.routes.ts) is made of. */
async function switchBusy() {
  return {
    running: (await sessionsService.listRunningSessions()).map((entry) => entry.sessionId),
    processes: getActiveClaudeSDKSessions(),
    asking: listClaudeSDKOpenQuestions(),
  };
}

/**
 * DECISIONS 17 (DE0CH/YYC yyc-ai/refactor, Deyao, 2026-11-05): a question nobody answers never holds the sandbox, and
 * the person never sees it time out. A turn that waits only on AskUserQuestion parks: the turn ends for the client, its
 * Claude Code process is stopped (the sandbox then idles like any idle one), and the question is kept and stays
 * pending; the answer starts a turn that resumes the conversation and carries the answer as its message.
 *
 * These drive queryClaudeSDK with a scripted SDK stream (as claude-runtime-hold.test.ts). `close()` is how the script
 * sees the stop (in the sandbox it is a SIGTERM to the process); the stream then ends with the process's error.
 */

const NATIVE = 'native-park-session';
const QUESTION = { questions: [{ question: 'Which colour?', header: 'Colour', options: [{ label: 'Red' }, { label: 'Blue' }], multiSelect: false }] };
const ANSWERED = 'Your questions have been answered: "Which colour?"="Blue". You can now continue with these answers in mind.';

const after = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });
async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (await condition()) return;
    await after(25);
  }
  assert.fail(`timed out waiting for ${what}`);
}

type CanUseTool = (name: string, input: unknown, context: { signal: AbortSignal; toolUseID: string }) => Promise<Record<string, unknown>>;

type Turn = {
  emit: (message: Record<string, unknown>) => void;
  end: () => void;
  /** Calls the runtime's canUseTool as the CLI would (it waits for the answer meanwhile). */
  ask: (name: string, input: unknown, toolUseID: string) => Promise<Record<string, unknown>>;
  closed: () => boolean;
  released: () => boolean;
  prompts: unknown[];
  sent: NormalizedMessage[];
  done: Promise<unknown>;
};

/** One turn of queryClaudeSDK with a scripted stream. */
function startTurn(sessionId: string, command: string, options: Record<string, unknown> = {}, park = true): Turn {
  const queue: Array<Record<string, unknown> | null | Error> = [];
  let wake: (() => void) | null = null;
  let closed = false;
  let released = false;
  let canUseTool: CanUseTool | null = null;
  const prompts: unknown[] = [];
  const sent: NormalizedMessage[] = [];
  const push = (item: Record<string, unknown> | null | Error) => { queue.push(item); wake?.(); };

  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = ({ prompt, options: sdkOptions }) => {
    canUseTool = (sdkOptions as { canUseTool: CanUseTool }).canUseTool;
    void (async () => {
      for await (const message of prompt) prompts.push(message);
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
        if (next instanceof Error) throw next;
        if (next === null || next === undefined) return;
        yield next;
      }
    })();
    return Object.assign(iterator, {
      interrupt: async () => {},
      stopTask: async () => {},
      close: () => {
        closed = true;
        push(new Error('Claude Code process terminated by signal SIGTERM'));
      },
    });
  };
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: async () => NATIVE,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, id) => sessions.normalizeMessage(raw, id),
    isProviderInstalled: async () => true,
    createQuery,
    parkQuestions: park,
  };
  const writer = { send: (message: NormalizedMessage) => { sent.push(message); }, userId: null };
  const done = queryClaudeSDK(command, { sessionId, cwd: os.tmpdir(), ...options }, writer as never, context);
  return {
    emit: (message) => push(message),
    end: () => push(null),
    ask: async (name, input, toolUseID) => {
      await until(() => canUseTool !== null, 'the query to start');
      return await canUseTool!(name, input, { signal: new AbortController().signal, toolUseID });
    },
    closed: () => closed,
    released: () => released,
    prompts,
    sent,
    done,
  };
}

const init = () => ({ type: 'system', subtype: 'init', session_id: NATIVE });
const streamEvent = (type: string) => ({ type: 'stream_event', session_id: NATIVE, parent_tool_use_id: null, event: { type } });
const toolUses = (...blocks: Array<[string, string, Record<string, unknown>]>) => ({
  type: 'assistant', session_id: NATIVE, parent_tool_use_id: null,
  message: { role: 'assistant', content: blocks.map(([id, name, input]) => ({ type: 'tool_use', id, name, input })) },
});
const toolResult = (id: string, text: string) => ({
  type: 'user', session_id: NATIVE, parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
});
const taskStarted = (taskId: string, toolUseId: string) => ({
  type: 'system', subtype: 'task_started', session_id: NATIVE, task_id: taskId, tool_use_id: toolUseId, description: 'sleep', task_type: 'local_bash',
});
const taskNotification = (taskId: string) => ({ type: 'system', subtype: 'task_notification', session_id: NATIVE, task_id: taskId, status: 'completed' });
const result = () => ({ type: 'result', subtype: 'success', session_id: NATIVE, result: 'done', duration_ms: 1, num_turns: 1 });

const kinds = (sent: NormalizedMessage[]) => sent.map((m) => m.kind);
const parkedComplete = (sent: NormalizedMessage[]) => sent.find((m) => m.kind === 'complete' && (m as { awaitingAnswer?: boolean }).awaitingAnswer === true);

async function withDatabase(runTest: () => Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'claude-ask-park-db-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'claude-ask-park-home-'));
  await mkdir(path.join(home, '.claude', 'sessions'), { recursive: true });
  const realHomedir = os.homedir;
  (os as unknown as { homedir: () => string }).homedir = () => home;
  await closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  await initializeDatabase();
  try {
    await runTest();
  } finally {
    for (const q of openQuestions.list()) openQuestions.close(q.requestId, 'superseded');
    await releaseTestDatabase();
    (os as unknown as { homedir: () => string }).homedir = realHomedir;
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(dir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
}

/** Asks in a fresh turn and waits until it parked; returns the turn and the question's requestId. */
async function parkedTurn(sessionId: string): Promise<{ turn: Turn; requestId: string }> {
  const turn = startTurn(sessionId, 'pick a colour');
  turn.emit(init());
  turn.emit(streamEvent('message_start'));
  turn.emit(toolUses(['toolu_ask', 'AskUserQuestion', QUESTION]));
  void turn.ask('AskUserQuestion', QUESTION, 'toolu_ask');
  await until(() => turn.sent.some((m) => m.kind === 'permission_request'), 'the question to reach the client');
  turn.emit(streamEvent('message_stop'));
  await until(() => turn.closed(), 'the park');
  await turn.done;
  const requestId = (turn.sent.find((m) => m.kind === 'permission_request') as { requestId: string }).requestId;
  return { turn, requestId };
}

test('a turn waiting only on its question parks: the turn ends, Claude Code stops, the question stays pending', { concurrency: false }, async () => {
  await withDatabase(async () => {
    await sessionsDb.createAppSession('park-1', 'claude', '/tmp/park-1');
    const turn = startTurn('park-1', 'pick a colour');
    turn.emit(init());
    turn.emit(streamEvent('message_start'));
    turn.emit(toolUses(['toolu_ask', 'AskUserQuestion', QUESTION]));
    void turn.ask('AskUserQuestion', QUESTION, 'toolu_ask');
    await until(() => turn.sent.some((m) => m.kind === 'permission_request'), 'the question to reach the client');
    await after(150);
    assert.equal(turn.closed(), false, 'the model is still writing its reply: nothing is parked yet');
    turn.emit(streamEvent('message_stop'));
    await until(() => turn.closed(), 'the park');
    await turn.done;

    assert.ok(parkedComplete(turn.sent), 'the turn is over for the client, marked as waiting for an answer');
    assert.equal(kinds(turn.sent).filter((k) => k === 'complete').length, 1, 'one complete');
    assert.ok(!kinds(turn.sent).includes('error'), 'the stop is no error');
    assert.ok(!kinds(turn.sent).includes('permission_cancelled'), 'the question is not withdrawn');
    assert.ok(turn.released(), "Claude Code's stdin is closed");
    assert.ok(!getActiveClaudeSDKSessions().includes('park-1'), 'no Claude Code process is held');
    const requestId = (turn.sent.find((m) => m.kind === 'permission_request') as { requestId: string }).requestId;
    const pending = getPendingApprovalsForSession('park-1') as Array<{ requestId: string; toolName: string; input: unknown }>;
    assert.deepEqual(pending.map((p) => [p.requestId, p.toolName]), [[requestId, 'AskUserQuestion']], 'still pending for a reconnecting client');
    assert.deepEqual(pending[0]!.input, QUESTION);
    const stored = await jarvisOpenQuestionsDb.listAll();
    assert.deepEqual(stored.map((r) => [r.request_id, r.session_id, r.tool_use_id]), [[requestId, 'park-1', 'toolu_ask']], 'kept in the database');

    // the switch: no running work (the gate may pass), the question listed for the importer
    const busy = await switchBusy();
    assert.deepEqual([busy.running, busy.processes], [[], []]);
    assert.deepEqual(busy.asking.map((a) => [a.sessionId, a.requestId, a.toolUseId, a.answered]), [['park-1', requestId, 'toolu_ask', false]]);
  });
});

test('the answer after the park resumes the conversation with the answer as its message, and the turn completes', { concurrency: false }, async () => {
  await withDatabase(async () => {
    await sessionsDb.createAppSession('park-2', 'claude', '/tmp/park-2');
    const { requestId } = await parkedTurn('park-2');

    const outcome = resolveToolApproval(requestId, {
      allow: true,
      updatedInput: { ...QUESTION, answers: { 'Which colour?': 'Blue' } },
    }) as { resume: { sessionId: string; options: Record<string, unknown> } } | null;
    assert.ok(outcome?.resume, 'the caller is told to start the answer turn');
    assert.equal(outcome.resume.sessionId, 'park-2');
    assert.equal((await switchBusy()).asking[0]?.answered, true);

    const answerTurn = startTurn('park-2', '', outcome.resume.options);
    await until(() => answerTurn.prompts.length > 0, 'the resumed Claude Code to read its message');
    const message = answerTurn.prompts[0] as { message: { content: unknown } };
    assert.equal(message.message.content, ANSWERED, "the answer in AskUserQuestion's own words");
    assert.ok(answerTurn.sent.some((m) => m.kind === 'permission_resolved' && (m as { requestId?: string }).requestId === requestId), 'the card is resolved');
    assert.deepEqual(getPendingApprovalsForSession('park-2'), [], 'nothing is pending any more');
    assert.deepEqual(await jarvisOpenQuestionsDb.listAll(), [], 'and nothing kept');
    answerTurn.emit(init());
    answerTurn.emit({ type: 'assistant', session_id: NATIVE, parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'BLUE' }] } });
    answerTurn.emit(result());
    await until(() => answerTurn.sent.some((m) => m.kind === 'complete'), 'the turn to complete');
    answerTurn.end();
    await answerTurn.done;
    const complete = answerTurn.sent.find((m) => m.kind === 'complete') as { exitCode?: number; awaitingAnswer?: boolean };
    assert.equal(complete.exitCode, 0);
    assert.equal(complete.awaitingAnswer, undefined);
    assert.ok(answerTurn.sent.some((m) => m.kind === 'text' && (m as { content?: string }).content === 'BLUE'), 'the reply reaches the client');
  });
});

test('a message sent instead of answering withdraws the question and is the turn\'s message', { concurrency: false }, async () => {
  await withDatabase(async () => {
    await sessionsDb.createAppSession('park-3', 'claude', '/tmp/park-3');
    const { requestId } = await parkedTurn('park-3');
    const next = startTurn('park-3', 'never mind, use green');
    await until(() => next.prompts.length > 0, 'the message');
    assert.equal((next.prompts[0] as { message: { content: unknown } }).message.content, 'never mind, use green');
    assert.ok(next.sent.some((m) => m.kind === 'permission_cancelled' && (m as { requestId?: string }).requestId === requestId));
    assert.deepEqual(getPendingApprovalsForSession('park-3'), []);
    next.emit(result());
    next.end();
    await next.done;
  });
});

test('a running tool keeps the sandbox: the question parks only once the other call has its result', { concurrency: false }, async () => {
  await withDatabase(async () => {
    await sessionsDb.createAppSession('park-4', 'claude', '/tmp/park-4');
    const turn = startTurn('park-4', 'read and ask');
    turn.emit(init());
    turn.emit(streamEvent('message_start'));
    turn.emit(toolUses(['toolu_read', 'Read', { file_path: '/workspace/a' }], ['toolu_ask', 'AskUserQuestion', QUESTION]));
    turn.emit(streamEvent('message_stop'));
    void turn.ask('AskUserQuestion', QUESTION, 'toolu_ask');
    await until(() => turn.sent.some((m) => m.kind === 'permission_request'), 'the question');
    await after(200);
    assert.equal(turn.closed(), false, 'the Read is still running: the process and sandbox are kept');
    assert.ok(getActiveClaudeSDKSessions().includes('park-4'));
    assert.deepEqual((await switchBusy()).processes, ['park-4'], 'running work for the switch');
    turn.emit(toolResult('toolu_read', 'contents'));
    await until(() => turn.closed(), 'the park after the Read finished');
    await turn.done;
    assert.ok(parkedComplete(turn.sent));
  });
});

test('background work keeps the sandbox: the question parks only once the task settled', { concurrency: false }, async () => {
  await withDatabase(async () => {
    await sessionsDb.createAppSession('park-5', 'claude', '/tmp/park-5');
    const turn = startTurn('park-5', 'start and ask');
    turn.emit(init());
    turn.emit(streamEvent('message_start'));
    turn.emit(toolUses(['toolu_bash', 'Bash', { command: 'sleep 60', run_in_background: true }]));
    turn.emit(streamEvent('message_stop'));
    turn.emit(taskStarted('b1', 'toolu_bash'));
    turn.emit(toolResult('toolu_bash', 'Command running in background with ID: b1'));
    turn.emit(streamEvent('message_start'));
    turn.emit(toolUses(['toolu_ask', 'AskUserQuestion', QUESTION]));
    turn.emit(streamEvent('message_stop'));
    void turn.ask('AskUserQuestion', QUESTION, 'toolu_ask');
    await until(() => turn.sent.some((m) => m.kind === 'permission_request'), 'the question');
    await after(200);
    assert.equal(turn.closed(), false, 'the background command runs: the process is kept');
    turn.emit(taskNotification('b1'));
    await until(() => turn.closed(), 'the park after the task settled');
    await turn.done;
    assert.ok(parkedComplete(turn.sent));
  });
});

test('timers: a parked question runs no turn clock; the answer\'s turn starts its own', { concurrency: false }, async () => {
  await withDatabase(async () => {
    await sessionsDb.createAppSession('park-6', 'claude', '/tmp/park-6');
    const { turn, requestId } = await parkedTurn('park-6');
    // the asking turn ended when it parked: its complete is the last thing it sent
    assert.equal(turn.sent[turn.sent.length - 1]?.kind, 'complete');
    await after(300);
    assert.equal(turn.sent[turn.sent.length - 1]?.kind, 'complete', 'nothing runs while the question waits');
    assert.deepEqual((await switchBusy()).running, [], 'not in the running list (the displayed working time)');
    const outcome = resolveToolApproval(requestId, { allow: true, updatedInput: { ...QUESTION, answers: { 'Which colour?': 'Red' } } }) as { resume: { options: Record<string, unknown> } };
    const answerTurn = startTurn('park-6', '', outcome.resume.options);
    await until(() => answerTurn.prompts.length > 0, 'the answer turn');
    answerTurn.emit(result());
    answerTurn.end();
    await answerTurn.done;
  });
});

test('without parking (no sandbox of its own), the question waits live up to the safety limit', { concurrency: false }, async () => {
  await withDatabase(async () => {
    await sessionsDb.createAppSession('park-7', 'claude', '/tmp/park-7');
    const turn = startTurn('park-7', 'ask', {}, false);
    turn.emit(init());
    turn.emit(streamEvent('message_start'));
    turn.emit(toolUses(['toolu_ask', 'AskUserQuestion', QUESTION]));
    turn.emit(streamEvent('message_stop'));
    const answer = turn.ask('AskUserQuestion', QUESTION, 'toolu_ask');
    await until(() => turn.sent.some((m) => m.kind === 'permission_request'), 'the question');
    await after(200);
    assert.equal(turn.closed(), false);
    assert.equal(parkedComplete(turn.sent), undefined);
    const requestId = (turn.sent.find((m) => m.kind === 'permission_request') as { requestId: string }).requestId;
    assert.equal(resolveToolApproval(requestId, { allow: true, updatedInput: { ...QUESTION, answers: { 'Which colour?': 'Blue' } } }), null, 'a live wait takes the answer directly');
    assert.equal((await answer).behavior, 'allow');
    turn.emit(result());
    turn.end();
    await turn.done;
  });
});

test('the long safety limit: a kept question closes as expired; the timeout answer names the real duration', async () => {
  assert.equal(askTimeoutMessage(7 * 24 * 60 * 60 * 1000), 'User has not answered in 7 days, the session has timed out, ask again if needed.');
  assert.equal(askTimeoutMessage(30 * 60 * 1000), 'User has not answered in 30 minutes, the session has timed out, ask again if needed.');
  assert.equal(askTimeoutMessage(2 * 60 * 60 * 1000), 'User has not answered in 2 hours, the session has timed out, ask again if needed.');
  const rows: string[] = [];
  const store = new OpenQuestions({
    store: { insert: async (r) => { rows.push(r.request_id); }, setAnswer: async () => {}, remove: async (id) => { rows.splice(rows.indexOf(id), 1); }, listAll: async () => [] },
    limitMs: () => 100,
  });
  const closed: unknown[] = [];
  store.on('closed', (c) => closed.push(c));
  await store.add({ requestId: 'r1', sessionId: 's1', providerSessionId: null, toolName: 'AskUserQuestion', toolUseId: 't1', input: QUESTION, runOptions: {}, askedAt: new Date().toISOString(), answer: null });
  assert.deepEqual(rows, ['r1']);
  await after(50);
  assert.equal(store.get('r1')?.requestId, 'r1', 'still waiting before the limit');
  await until(() => closed.length > 0, 'the limit');
  assert.deepEqual(closed, [{ sessionId: 's1', requestId: 'r1', reason: 'expired' }]);
  assert.deepEqual(rows, [], 'removed from the store');
});
