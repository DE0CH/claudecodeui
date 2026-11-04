// Claude Code's AskUserQuestion in the Paseo UI (paseo-hub.ts `questions`, paseo-connection.ts
// `agent_permission_response`): CloudCLI's permission_request for it becomes Paseo's question card, the person's answer
// goes back as chat.permission-response keyed by the question's text, and any other tool that asks is allowed at once.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { afterEach, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { answersByQuestionText, paseoHub, type HubEvent } from '../paseo-hub.js';
import { handlePaseoConnection } from '../paseo-connection.js';

type HubInternals = {
  onChatFrame(frame: Record<string, unknown>): void;
  socket: { deliver(frame: Record<string, unknown>): void } | null;
  getSession(id: string): Promise<unknown>;
  isRunning(id: string): boolean;
};
const hub = paseoHub as unknown as HubInternals;

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  sent: Array<Record<string, any>> = [];
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  client(frame: Record<string, unknown>) {
    this.emit('message', Buffer.from(JSON.stringify(frame)));
  }
}

type Schema = { safeParse: (value: unknown) => { success: boolean; error?: { issues: unknown[] } } };
// the app drops any frame that does not parse (paseo-protocol.test.ts)
const messagesModule = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../paseo/packages/protocol/src/messages.ts');
let outbound: Schema;
function expectValid(frame: Record<string, any>) {
  const parsed = outbound.safeParse(frame);
  assert.equal(parsed.success, true, `${frame.message?.type}: ${JSON.stringify(parsed.error?.issues?.slice(0, 3))}`);
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

const INPUT = {
  questions: [
    {
      question: '報告要用哪種語言？',
      header: '語言',
      multiSelect: false,
      options: [{ label: '中文' }, { label: 'English' }],
    },
  ],
};

describe('AskUserQuestion in the Paseo UI', () => {
  let delivered: Array<Record<string, unknown>>;
  let events: HubEvent[];
  const listen = (event: HubEvent) => events.push(event);

  before(async () => {
    outbound = ((await import(pathToFileURL(messagesModule).href)) as { WSOutboundMessageSchema: Schema }).WSOutboundMessageSchema;
    hub.getSession = async (id: string) => ({ session_id: id, provider_session_id: null, custom_name: 'x', created_at: '2026-11-04 00:00:00', updated_at: '2026-11-04 00:00:00', isArchived: 0 });
    hub.isRunning = () => true;
  });

  function start() {
    paseoHub.resetForTests();
    delivered = [];
    events = [];
    hub.socket = { deliver: (frame) => delivered.push(frame) };
    paseoHub.on('event', listen);
  }

  afterEach(() => paseoHub.resetForTests());

  it('keys answers by the question text, leaving text keys alone', () => {
    const out = answersByQuestionText({ ...INPUT, answers: { 語言: 'English', 'Other?': 'x' } });
    assert.deepEqual(out.answers, { '報告要用哪種語言？': 'English', 'Other?': 'x' });
    const same = answersByQuestionText({ ...INPUT, answers: { '報告要用哪種語言？': '中文' } });
    assert.deepEqual(same.answers, { '報告要用哪種語言？': '中文' });
  });

  it('shows the question, sends the answer back and clears the card', async () => {
    start();
    hub.onChatFrame({ kind: 'permission_request', sessionId: 's1', requestId: 'r1', toolName: 'AskUserQuestion', input: INPUT });
    const asked = events.find((e) => e.type === 'question');
    assert.ok(asked && asked.type === 'question');
    assert.equal(asked.request.kind, 'question');
    assert.deepEqual(paseoHub.pendingQuestions('s1').map((q) => q.id), ['r1']);

    // a connection answers it the way Paseo's question card does
    const ws = new FakeSocket();
    handlePaseoConnection(ws as never, { headers: {} } as never, {} as never);
    ws.client({ type: 'hello' });
    // the card reaches a tab that is open when the question comes
    hub.onChatFrame({ kind: 'permission_request', sessionId: 's1', requestId: 'r1b', toolName: 'AskUserQuestion', input: INPUT });
    await flush();
    const card = ws.sent.find((f) => f.message?.type === 'agent_permission_request');
    assert.equal(card?.message.payload.request.id, 'r1b');
    expectValid(card!);
    ws.client({
      type: 'session',
      message: {
        type: 'agent_permission_response',
        agentId: 's1',
        requestId: 'r1',
        response: { behavior: 'allow', updatedInput: { ...INPUT, answers: { 語言: 'English' } } },
      },
    });
    await flush();
    assert.deepEqual(delivered, [{
      type: 'chat.permission-response',
      requestId: 'r1',
      allow: true,
      updatedInput: { ...INPUT, answers: { '報告要用哪種語言？': 'English' } },
    }]);

    // CloudCLI confirms; every tab drops the card with the answer as the resolution
    hub.onChatFrame({ kind: 'permission_resolved', sessionId: 's1', requestId: 'r1' });
    await flush();
    assert.deepEqual(paseoHub.pendingQuestions('s1').map((q) => q.id), ['r1b'], 'only the unanswered one is left');
    const resolved = ws.sent.find((f) => f.message?.type === 'agent_permission_resolved');
    assert.equal(resolved?.message.payload.requestId, 'r1');
    assert.equal(resolved?.message.payload.resolution.behavior, 'allow');
    expectValid(resolved!);
    ws.emit('close');
  });

  it('puts a waiting question in the agent snapshot, for a tab opened later', async () => {
    start();
    hub.onChatFrame({ kind: 'chat_subscribed', sessionId: 's2', isProcessing: true, pendingPermissions: [
      { requestId: 'r2', toolName: 'AskUserQuestion', input: INPUT, sessionId: 's2' },
    ] });
    const ws = new FakeSocket();
    handlePaseoConnection(ws as never, { headers: {} } as never, {} as never);
    ws.client({ type: 'hello' });
    ws.client({ type: 'session', message: { type: 'fetch_agent_request', requestId: 'q', agentId: 's2' } });
    await flush();
    const reply = ws.sent.find((f) => f.message?.type === 'fetch_agent_response');
    expectValid(reply!);
    const agent = reply!.message.payload.agent;
    assert.deepEqual(agent.pendingPermissions.map((p: { id: string }) => p.id), ['r2']);
    assert.equal(agent.requiresAttention, true);
    assert.equal(agent.attentionReason, 'permission');
    ws.emit('close');
  });

  it('allows any other asking tool at once (staff are never asked for permission)', () => {
    start();
    hub.onChatFrame({ kind: 'permission_request', sessionId: 's1', requestId: 'r3', toolName: 'ExitPlanMode', input: { plan: 'p' } });
    assert.deepEqual(delivered, [{ type: 'chat.permission-response', requestId: 'r3', allow: true, updatedInput: { plan: 'p' } }]);
    assert.equal(events.some((e) => e.type === 'question'), false);
  });

  it('a dismissed card denies with a message; a turn that ends drops its questions', () => {
    start();
    hub.onChatFrame({ kind: 'permission_request', sessionId: 's1', requestId: 'r4', toolName: 'AskUserQuestion', input: INPUT });
    assert.equal(paseoHub.answer('s1', 'r4', { behavior: 'deny', message: 'Dismissed by user' }), true);
    assert.deepEqual(delivered.at(-1), { type: 'chat.permission-response', requestId: 'r4', allow: false, message: 'Dismissed by user' });
    hub.onChatFrame({ kind: 'complete', sessionId: 's1', exitCode: 0 });
    assert.deepEqual(paseoHub.pendingQuestions('s1'), []);
    assert.ok(events.some((e) => e.type === 'question_resolved' && e.requestId === 'r4'));
  });
});
