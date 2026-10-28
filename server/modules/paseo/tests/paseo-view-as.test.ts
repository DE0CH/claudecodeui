// View as (jarvis-view-as.ts, jarvis/router.mjs "View as"): on a socket the router marked with a viewer, every message
// and new conversation is recorded in web's ops log before it is sent (nothing is sent without the record), and
// renames and deletes are refused; the person's own sockets are untouched.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { after, before, beforeEach, describe, it } from 'node:test';

import { sessionsService } from '@/modules/providers/index.js';

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
const env = { JARVIS_WEB_URL: process.env.JARVIS_WEB_URL, JARVIS_CC_TOKEN: process.env.JARVIS_CC_TOKEN, JARVIS_CC_OWNER: process.env.JARVIS_CC_OWNER };
const realFetch = globalThis.fetch;
const hub = paseoHub as any;
const sessions = sessionsService as any;
const saved = {
  send: hub.send, isRunning: hub.isRunning, getSession: hub.getSession,
  createAppSession: sessions.createAppSession, deleteOrArchiveSessionById: sessions.deleteOrArchiveSessionById,
  renameSessionById: sessions.renameSessionById,
};

describe('view as on the Paseo socket', () => {
  let records: Array<Record<string, any>>;
  let webOk: boolean;
  let sends: string[];
  let deleted: string[];
  let renamed: string[];

  before(() => {
    process.env.JARVIS_WEB_URL = 'http://web.test';
    process.env.JARVIS_CC_TOKEN = 'cc-token';
    process.env.JARVIS_CC_OWNER = 'bob@yyc.hk';
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      assert.equal(url, 'http://web.test/internal/cc/view-as');
      assert.equal((init.headers as Record<string, string>).authorization, 'Bearer cc-token');
      if (!webOk) return new Response('down', { status: 503 });
      records.push(JSON.parse(String(init.body)));
      return new Response('{"ok":true}', { status: 200 });
    }) as typeof fetch;
    hub.isRunning = () => false;
    hub.getSession = async (id: string) => ({ session_id: id, custom_name: 'x', created_at: '2026-10-28 00:00:00', updated_at: '2026-10-28 00:00:00', isArchived: 0 });
    hub.send = async (id: string, text: string) => { sends.push(`${id}:${text}`); };
    sessions.createAppSession = async () => ({ sessionId: SESSION });
    sessions.deleteOrArchiveSessionById = async (id: string) => { deleted.push(id); };
    sessions.renameSessionById = async (id: string) => { renamed.push(id); };
  });

  after(() => {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    globalThis.fetch = realFetch;
    Object.assign(hub, { send: saved.send, isRunning: saved.isRunning, getSession: saved.getSession });
    Object.assign(sessions, {
      createAppSession: saved.createAppSession,
      deleteOrArchiveSessionById: saved.deleteOrArchiveSessionById,
      renameSessionById: saved.renameSessionById,
    });
    paseoHub.resetForTests();
  });

  beforeEach(() => {
    records = [];
    webOk = true;
    sends = [];
    deleted = [];
    renamed = [];
    paseoHub.resetForTests();
  });

  async function connect(headers: Record<string, string>) {
    const socket = new FakeSocket();
    handlePaseoConnection(socket as never, { user: { id: 1 }, headers } as never, { runtime: {} } as never);
    socket.client({ type: 'hello', clientId: 't', clientType: 'browser', protocolVersion: 1 });
    await flush();
    socket.sent = [];
    return {
      socket,
      async request(message: Record<string, unknown>) {
        socket.client({ type: 'session', message: { requestId: 'r1', ...message } });
        await flush();
        return socket.sent.map((f) => f.message);
      },
    };
  }
  const viewer = { 'x-jarvis-user': 'bob@yyc.hk', 'x-jarvis-viewer': 'alice@yyc.hk', 'x-jarvis-viewer-session': 'view-1' };

  it('records a message sent as the person, then sends it', async () => {
    const c = await connect(viewer);
    const [reply] = await c.request({ type: 'send_agent_message_request', agentId: SESSION, text: 'hello', messageId: 'm1' });
    assert.equal(reply.payload.accepted, true);
    assert.deepEqual(records, [{ event: 'message', conversation: SESSION, chars: 5, admin: 'alice@yyc.hk', user: 'bob@yyc.hk', session: 'view-1' }]);
    assert.deepEqual(sends, [`${SESSION}:hello`]);
  });

  it('sends nothing when the record cannot be written', async () => {
    webOk = false;
    const c = await connect(viewer);
    const [reply] = await c.request({ type: 'send_agent_message_request', agentId: SESSION, text: 'hello', messageId: 'm1' });
    assert.equal(reply.payload.accepted, false);
    assert.match(reply.payload.error, /could not be written/);
    assert.deepEqual(sends, []);
  });

  it('records a new conversation before its first message; without the record it is removed unsent', async () => {
    const c = await connect(viewer);
    await c.request({ type: 'workspace.create.request', idempotencyKey: 'k1', agent: { initialPrompt: 'hi there' } });
    assert.deepEqual(records, [{ event: 'conversation', conversation: SESSION, chars: 8, admin: 'alice@yyc.hk', user: 'bob@yyc.hk', session: 'view-1' }]);
    assert.deepEqual(sends, [`${SESSION}:hi there`]);

    webOk = false;
    const d = await connect(viewer);
    const replies = await d.request({ type: 'workspace.create.request', idempotencyKey: 'k2', agent: { initialPrompt: 'again' } });
    const created = replies.find((m) => m.type === 'workspace.create.response');
    assert.equal(created.payload.workspace, null);
    assert.match(created.payload.error, /could not be written/);
    assert.deepEqual(deleted, [SESSION]);
    assert.equal(sends.length, 1);
  });

  it('refuses renames and deletes while viewing', async () => {
    const c = await connect(viewer);
    for (const message of [
      { type: 'workspace.title.set.request', workspaceId: `wks_${SESSION}`, title: 'new' },
      { type: 'update_agent_request', agentId: SESSION, title: 'new' },
      { type: 'archive_workspace_request', workspaceId: `wks_${SESSION}` },
      { type: 'archive_agent_request', agentId: SESSION },
      { type: 'delete_agent_request', agentId: SESSION },
    ]) {
      c.socket.sent = [];
      const [reply] = await c.request(message);
      assert.equal(reply.type, 'rpc_error', message.type);
      assert.equal(reply.payload.code, 'view_as_read_only');
    }
    assert.deepEqual(renamed, []);
    assert.deepEqual(deleted, []);
    assert.deepEqual(records, []);
  });

  it("the person's own socket records nothing and may rename", async () => {
    const c = await connect({ 'x-jarvis-user': 'bob@yyc.hk' });
    await c.request({ type: 'send_agent_message_request', agentId: SESSION, text: 'mine', messageId: 'm2' });
    await c.request({ type: 'workspace.title.set.request', workspaceId: `wks_${SESSION}`, title: 'new' });
    assert.deepEqual(records, []);
    assert.deepEqual(sends, [`${SESSION}:mine`]);
    assert.deepEqual(renamed, [SESSION]);
  });
});
