// The switch window's write bound (not-after.ts, DESIGN 9.5): a write from pigeon's legacy upstream that reaches its
// commit point after its `aviaryNotAfter` is refused and never applied; a create retried on another socket of the
// person, also while the first runs, makes one conversation.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { after, before, beforeEach, describe, it } from 'node:test';

import { sessionsService } from '@/modules/providers/index.js';

import { NotAfterError, pastNotAfter } from '../not-after.js';
import { paseoHub } from '../paseo-hub.js';
import { handlePaseoConnection } from '../paseo-connection.js';

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

const flush = () => new Promise((resolve) => setTimeout(resolve, 30));
const SESSION = '11111111-2222-4333-8444-555555555555';
const hub = paseoHub as any;
const sessions = sessionsService as any;
const saved = {
  send: hub.send, isRunning: hub.isRunning, getSession: hub.getSession, timeline: hub.timeline,
  createAppSession: sessions.createAppSession, renameSessionById: sessions.renameSessionById,
  deleteOrArchiveSessionById: sessions.deleteOrArchiveSessionById,
};
const past = () => Date.now() - 1;
const future = () => Date.now() + 60_000;

describe('pastNotAfter', () => {
  it('reads a number or a header string; anything else is unbounded', () => {
    assert.equal(pastNotAfter(1000, 2000), true);
    assert.equal(pastNotAfter('1000', 2000), true);
    assert.equal(pastNotAfter(3000, 2000), false);
    assert.equal(pastNotAfter(undefined, 2000), false);
    assert.equal(pastNotAfter('soon', 2000), false);
    assert.equal(pastNotAfter(['1000'], 2000), false);
  });
});

describe('paseoHub.send at its commit point', () => {
  after(() => {
    hub.timeline = saved.timeline;
    paseoHub.resetForTests();
  });

  it('refuses a send whose bound passed while it waited, before the user row', async () => {
    let applied = 0;
    let release!: () => void;
    const waited = new Promise<void>((r) => { release = r; });
    hub.timeline = async () => {
      await waited;
      return { apply: () => { applied += 1; return []; }, epoch: 'e' };
    };
    const notAfter = Date.now() + 20;
    const sent = paseoHub.send(SESSION, 'hi', 'm1', {}, notAfter);
    await new Promise((r) => setTimeout(r, 40));
    release();
    await assert.rejects(sent, NotAfterError);
    assert.equal(applied, 0);
  });
});

describe('the bound on the Paseo socket', () => {
  let sends: string[];
  let renamed: string[];
  let deleted: string[];
  let creates: number;

  before(() => {
    hub.isRunning = () => false;
    hub.getSession = async (id: string) => ({ session_id: id, custom_name: 'x', created_at: '2026-11-04 00:00:00', updated_at: '2026-11-04 00:00:00', isArchived: 0 });
    hub.send = async (id: string, text: string, _c: string, _s: unknown, notAfter: unknown) => {
      if (pastNotAfter(notAfter)) throw new NotAfterError();
      sends.push(`${id}:${text}`);
    };
    sessions.createAppSession = async () => {
      creates += 1;
      await new Promise((r) => setTimeout(r, 15));
      return { sessionId: SESSION };
    };
    sessions.renameSessionById = async (id: string) => { renamed.push(id); };
    sessions.deleteOrArchiveSessionById = async (id: string) => { deleted.push(id); };
  });

  after(() => {
    Object.assign(hub, { send: saved.send, isRunning: saved.isRunning, getSession: saved.getSession });
    Object.assign(sessions, {
      createAppSession: saved.createAppSession,
      renameSessionById: saved.renameSessionById,
      deleteOrArchiveSessionById: saved.deleteOrArchiveSessionById,
    });
    paseoHub.resetForTests();
  });

  beforeEach(() => {
    sends = [];
    renamed = [];
    deleted = [];
    creates = 0;
    paseoHub.resetForTests();
  });

  async function connect() {
    const socket = new FakeSocket();
    handlePaseoConnection(socket as never, { user: { id: 1 }, headers: { 'x-jarvis-user': 'bob@yyc.hk' } } as never, { runtime: {} } as never);
    socket.client({ type: 'hello', clientId: 't', clientType: 'browser', protocolVersion: 1 });
    await flush();
    socket.sent = [];
    return {
      socket,
      async request(message: Record<string, unknown>) {
        socket.sent = [];
        socket.client({ type: 'session', message: { requestId: 'r1', ...message } });
        await flush();
        return socket.sent.map((f) => f.message);
      },
    };
  }

  it('a send past its bound is answered not accepted and not sent; within it, sent', async () => {
    const c = await connect();
    const [late] = await c.request({ type: 'send_agent_message_request', agentId: SESSION, text: 'late', messageId: 'm1', aviaryNotAfter: past() });
    assert.equal(late.payload.accepted, false);
    assert.equal(late.payload.error, 'not_after');
    const [ok] = await c.request({ type: 'send_agent_message_request', agentId: SESSION, text: 'ok', messageId: 'm2', aviaryNotAfter: future() });
    assert.equal(ok.payload.accepted, true);
    assert.deepEqual(sends, [`${SESSION}:ok`]);
  });

  it('a rename, a delete and a cancel past their bound change nothing', async () => {
    const c = await connect();
    const [r] = await c.request({ type: 'update_agent_request', agentId: SESSION, title: 'new', aviaryNotAfter: past() });
    assert.equal(r.type, 'rpc_error');
    assert.equal(r.payload.code, 'not_after');
    await c.request({ type: 'workspace.title.set.request', workspaceId: `wks_${SESSION}`, title: 'new', aviaryNotAfter: past() });
    await c.request({ type: 'archive_agent_request', agentId: SESSION, aviaryNotAfter: past() });
    assert.deepEqual(renamed, []);
    assert.deepEqual(deleted, []);
    await c.request({ type: 'update_agent_request', agentId: SESSION, title: 'new', aviaryNotAfter: future() });
    assert.deepEqual(renamed, [SESSION]);
  });

  it('a create past its bound makes nothing; one retried on another socket makes one conversation', async () => {
    const a = await connect();
    const [late] = await a.request({ type: 'workspace.create.request', idempotencyKey: 'k0', agent: { initialPrompt: 'x' }, aviaryNotAfter: past() });
    assert.equal(late.type, 'rpc_error');
    assert.equal(late.payload.code, 'not_after');
    assert.equal(creates, 0);

    const b = await connect();
    a.socket.client({ type: 'session', message: { requestId: 'ra', type: 'workspace.create.request', idempotencyKey: 'k1', agent: { initialPrompt: 'hi' } } });
    b.socket.client({ type: 'session', message: { requestId: 'rb', type: 'workspace.create.request', idempotencyKey: 'k1', agent: { initialPrompt: 'hi' } } });
    await flush();
    await flush();
    assert.equal(creates, 1);
    assert.deepEqual(sends, [`${SESSION}:hi`]);
  });
});
