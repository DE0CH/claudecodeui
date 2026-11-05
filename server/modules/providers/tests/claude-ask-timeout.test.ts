import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

/**
 * An AskUserQuestion nobody answers is closed after CLAUDE_INTERACTIVE_TOOL_TIMEOUT_MS (default 30 min): the model is
 * told so and may ask again, the client's prompt is withdrawn, and the turn can end, so the sandbox can go idle
 * (Deyao, 2026-11-05). The timeout is read when the module loads, so it is set before the import.
 */
process.env.CLAUDE_INTERACTIVE_TOOL_TIMEOUT_MS = '200';
const { askTimeoutMessage, queryClaudeSDK } = await import('@/modules/providers/list/claude/claude-runtime.provider.js');
const { ClaudeSessionsProvider } = await import('@/modules/providers/list/claude/claude-sessions.provider.js');
const { CLAUDE_PREDEFINED_MODELS } = await import('@/modules/providers/list/claude/claude-models.provider.js');

test('the default timeout answer names 30 minutes', () => {
  assert.equal(
    askTimeoutMessage(30 * 60 * 1000),
    'User has not answered in 30 minutes, the session has timed out, ask again if needed.',
  );
});

test('an unanswered AskUserQuestion is denied with the timeout answer and its prompt withdrawn', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-ask-timeout-'));
  const sent: NormalizedMessage[] = [];
  const writer = { send: (message: NormalizedMessage) => { sent.push(message); }, userId: null };
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  let decision: unknown;
  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = ({ prompt, options }) => {
    void (async () => { for await (const _m of prompt) { /* stdin */ } })();
    const iterator = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'native-ask' };
      const canUseTool = (options as { canUseTool: (n: string, i: unknown, c: unknown) => Promise<unknown> }).canUseTool;
      decision = await canUseTool('AskUserQuestion', { questions: [{ question: 'Which?' }] }, { signal: new AbortController().signal });
      yield { type: 'result', subtype: 'success', session_id: 'native-ask', result: 'done', duration_ms: 1, num_turns: 1 };
    })();
    return Object.assign(iterator, { interrupt: async () => {}, stopTask: async () => {} });
  };
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: async () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
    createQuery,
  };
  try {
    await queryClaudeSDK('hello', { sessionId: 'app-ask', cwd }, writer as never, context);
    assert.deepEqual(decision, {
      behavior: 'deny',
      message: 'User has not answered in 0 minutes, the session has timed out, ask again if needed.',
    });
    const asked = sent.find((m) => m.kind === 'permission_request');
    assert.ok(asked, 'the question reached the client');
    assert.ok(
      sent.some((m) => m.kind === 'permission_cancelled' && (m as { requestId?: string }).requestId === (asked as { requestId?: string }).requestId),
      'the prompt is withdrawn',
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
