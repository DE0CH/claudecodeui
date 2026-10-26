// Every frame the bridge sends must parse with Paseo's own wire schema: the app drops a frame that does not (often
// with "Response validation failed for …"). This covers the replies that need no database; the conversation ones
// were checked against a live app (docs/paseo-ui.md "Tests").
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { paseoHub } from '../paseo-hub.js';
import { handlePaseoConnection } from '../paseo-connection.js';
import { SessionTimeline } from '../paseo-timeline.js';

type Schema = { safeParse: (value: unknown) => { success: boolean; error?: { issues: unknown[] } } };

const here = path.dirname(fileURLToPath(import.meta.url));
// paseo/packages/protocol (the copy of Paseo in this repo); a runtime path, so the server's tsc does not compile it
const messagesModule = path.resolve(here, '../../../../paseo/packages/protocol/src/messages.ts');

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

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('Paseo protocol replies', () => {
  let outbound: Schema;
  let socket: FakeSocket;

  before(async () => {
    const messages = (await import(pathToFileURL(messagesModule).href)) as { WSOutboundMessageSchema: Schema };
    outbound = messages.WSOutboundMessageSchema;
    paseoHub.resetForTests();
    socket = new FakeSocket();
    const chat = { runtime: {} } as Parameters<typeof handlePaseoConnection>[2];
    handlePaseoConnection(socket as never, { user: { id: 1 } } as never, chat);
    socket.client({ type: 'hello', clientId: 'test', clientType: 'browser', protocolVersion: 1 });
    await flush();
  });

  after(() => paseoHub.resetForTests());

  function expectValid(frame: Record<string, any>) {
    const parsed = outbound.safeParse(frame);
    assert.equal(parsed.success, true, `${frame.message?.type ?? frame.type}: ${JSON.stringify(parsed.error?.issues?.slice(0, 3))}`);
  }

  function request(message: Record<string, unknown>) {
    socket.client({ type: 'session', message: { requestId: `r-${Math.random()}`, ...message } });
  }

  it('answers hello with a valid server_info', () => {
    assert.equal(socket.sent[0]?.message?.payload?.status, 'server_info');
    expectValid(socket.sent[0]!);
  });

  it('answers the requests that need no conversation data with valid frames', async () => {
    socket.sent = [];
    for (const message of [
      { type: 'session.events.set_subscription.request', events: ['project.update'] },
      { type: 'subscription.release.request', subscriptionId: 's1' },
      { type: 'workspace.label.list.request', subscribe: {} },
      { type: 'hosts.list.request', observe: true },
      { type: 'usage.list_reports.request', forceRefresh: false },
      { type: 'plugin.catalog.get.request' },
      { type: 'project.icon.get.request', projectId: 'prj_conversations' },
      { type: 'project_icon_request', cwd: '/workspace' },
      { type: 'list_provider_features_request', draftConfig: { provider: 'claude', cwd: '/workspace' } },
      { type: 'get_daemon_config_request' },
      { type: 'checkout_status_request', cwd: '/workspace' },
      { type: 'checkout_pr_status_request', cwd: '/workspace' },
      { type: 'subscribe_terminals_request', cwd: '/workspace', workspaceId: 'wks_x' },
      { type: 'list_terminals_request', cwd: '/workspace', workspaceId: 'wks_x' },
      { type: 'workspace.script.list.request', workspaceId: 'wks_x' },
      { type: 'agent.provider_subagents.list.request', parentAgentId: 'a1' },
      { type: 'get_providers_snapshot_request', cwd: '/workspace' },
      { type: 'project.list.request', sync: {} },
      { type: 'agent.timeline.set_subscription.request', agentIds: ['s1'] },
      { type: 'something_this_server_has_not.request' },
    ]) {
      request(message);
    }
    await flush();
    assert.equal(socket.sent.length, 20);
    for (const frame of socket.sent) expectValid(frame);
  });

  it('streams timeline rows and the sandbox status as valid frames', async () => {
    socket.sent = [];
    const timeline = new SessionTimeline(() => null);
    const rows = timeline.apply({
      id: 'm1',
      sessionId: 's1',
      timestamp: '2026-10-26T10:00:00.000Z',
      provider: 'claude',
      kind: 'tool_use',
      toolId: 't1',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
    } as never);
    paseoHub.emit('event', { type: 'timeline', sessionId: 's1', rows, epoch: timeline.epoch, turnId: 'turn-1' });
    paseoHub.emit('event', { type: 'preparing', sessionId: 's1', state: 'preparing' });
    await flush();
    assert.deepEqual(socket.sent.map((frame) => frame.message.type), ['agent_stream', 'yyc.sandbox_status']);
    for (const frame of socket.sent) expectValid(frame);
  });
});
