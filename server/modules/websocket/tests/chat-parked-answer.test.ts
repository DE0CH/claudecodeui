import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { releaseTestDatabase } from '@/modules/database/testing.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

/**
 * chat.permission-response for a question whose turn let its sandbox go (DECISIONS 17): the runtime answers that the
 * conversation is to resume, and the gateway starts that turn on the answering socket, with the asking turn's options
 * and no text of its own (the runtime gives Claude Code the answer). A live wait's answer starts nothing.
 */

const SESSION_ID = 'parked-answer-session';

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & { readyState: number; frames: Array<Record<string, unknown>>; send: (data: string) => void };
  socket.readyState = 1;
  socket.frames = [];
  socket.send = (data: string) => socket.frames.push(JSON.parse(data) as Record<string, unknown>);
  return socket;
}

const sleep = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

test('an answer to a parked question starts the turn that resumes the conversation; a live answer starts nothing', async () => {
  const previous = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'chat-parked-answer-'));
  await closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  await initializeDatabase();
  const runs: Array<{ command: string; options: Record<string, unknown> }> = [];
  const answers: string[] = [];
  try {
    await sessionsDb.createAppSession(SESSION_ID, 'claude', dir);
    const socket = createFakeSocket();
    handleChatConnection(socket as never, { user: { id: 1 } } as never, {
      runtime: {
        hasRuntime: () => true,
        run: async (_provider: string, command: string, options: Record<string, unknown>, writer: { send: (m: unknown) => void }) => {
          runs.push({ command, options });
          writer.send({ kind: 'complete', exitCode: 0, sessionId: SESSION_ID, provider: 'claude' });
        },
        resolveToolApproval: (requestId: string) => {
          answers.push(requestId);
          return requestId === 'parked'
            ? { resume: { sessionId: SESSION_ID, options: { model: 'm', permissionMode: 'bypassPermissions', sessionSummary: 'pick' } } }
            : null;
        },
        getPendingApprovalsForSession: () => [],
        hasBackgroundWork: () => false,
      } as never,
    });

    socket.emit('message', JSON.stringify({ type: 'chat.permission-response', requestId: 'live', allow: true }));
    await sleep(100);
    assert.deepEqual(answers, ['live']);
    assert.deepEqual(runs, [], 'a live wait took it: no turn');

    socket.emit('message', JSON.stringify({ type: 'chat.permission-response', requestId: 'parked', allow: true, updatedInput: { answers: { q: 'a' } } }));
    for (let i = 0; i < 100 && runs.length === 0; i += 1) await sleep(20);
    const started = runs as Array<{ command: string; options: Record<string, unknown> }>;
    assert.equal(started.length, 1);
    assert.equal(started[0]!.command, '');
    assert.equal(started[0]!.options.sessionId, SESSION_ID);
    assert.equal(started[0]!.options.model, 'm');
    assert.equal(started[0]!.options.permissionMode, 'bypassPermissions');
    await sleep(50);
    assert.ok(socket.frames.some((f) => f.kind === 'complete'), 'the turn streams to the socket that answered');
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    await releaseTestDatabase();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
