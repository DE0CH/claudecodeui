import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, notify, resolveSchema, sessionsDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import {
  broadcastSessionUpserted,
  chatRunRegistry,
  connectedClients,
  startSessionListRelay,
  stopSessionListRelay,
} from '@/modules/websocket/index.js';
import { releaseTestDatabase } from '@/modules/database/testing.js';

/**
 * Every open tab of the user keeps its conversation list current from websocket deltas, without a reload: a
 * conversation created, renamed or restored is announced as `session_upserted`, one archived or deleted as
 * `session_removed`.
 */

class FakeConnection {
  readyState = 1; // WS_OPEN_STATE
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

async function withIsolatedDatabase(runTest: (tab: FakeConnection) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-list-broadcasts-'));

  await closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  const tab = new FakeConnection();
  connectedClients.add(tab as never);

  try {
    await runTest(tab);
  } finally {
    connectedClients.clear();
    await releaseTestDatabase();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('a new conversation is announced to every tab before its first run', { concurrency: false }, async () => {
  await withIsolatedDatabase(async (tab) => {
    const created = await sessionsService.createAppSession('claude', '/tmp/list-broadcast-project', 'Summarise this week');

    assert.equal(tab.frames.length, 1);
    assert.equal(tab.frames[0].kind, 'session_upserted');
    assert.equal(tab.frames[0].sessionId, created.sessionId);
    assert.equal(tab.frames[0].providerSessionId, null);
    assert.equal((tab.frames[0].session as { summary: string }).summary, created.sessionName);
  });
});

test('a rename and a restore are announced with the session', { concurrency: false }, async () => {
  await withIsolatedDatabase(async (tab) => {
    const created = await sessionsService.createAppSession('claude', '/tmp/list-broadcast-project', 'First');
    tab.frames.length = 0;

    await sessionsService.renameSessionById(created.sessionId, 'Renamed elsewhere');
    assert.equal(tab.frames.length, 1);
    assert.equal(tab.frames[0].kind, 'session_upserted');
    assert.equal((tab.frames[0].session as { summary: string }).summary, 'Renamed elsewhere');

    await sessionsService.deleteOrArchiveSessionById(created.sessionId);
    await sessionsService.restoreSessionById(created.sessionId);
    assert.deepEqual(tab.frames.slice(1).map((frame) => frame.kind), ['session_removed', 'session_upserted']);
  });
});

test('archiving and deleting are announced as session_removed with the action', { concurrency: false }, async () => {
  await withIsolatedDatabase(async (tab) => {
    const archived = await sessionsService.createAppSession('claude', '/tmp/list-broadcast-project', 'One');
    const deleted = await sessionsService.createAppSession('claude', '/tmp/list-broadcast-project', 'Two');
    tab.frames.length = 0;

    await sessionsService.deleteOrArchiveSessionById(archived.sessionId);
    await sessionsService.deleteOrArchiveSessionById(deleted.sessionId, { force: true });

    assert.deepEqual(
      tab.frames.map((frame) => [frame.kind, frame.sessionId, frame.action]),
      [
        ['session_removed', archived.sessionId, 'archived'],
        ['session_removed', deleted.sessionId, 'deleted'],
      ],
    );
  });
});

test('a run starting and finishing moves the session to now and announces it', { concurrency: false }, async () => {
  await withIsolatedDatabase(async (tab) => {
    await sessionsDb.createAppSession('run-session', 'claude', '/tmp/list-broadcast-project', 'Run me');
    const before = (await sessionsDb.getSessionById('run-session'))?.updated_at;
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const run = chatRunRegistry.startRun({
      appSessionId: 'run-session',
      provider: 'claude',
      providerSessionId: null,
      connection: null,
      userId: null,
    });
    assert.ok(run);
    await waitFor(() => tab.frames.some((frame) => frame.kind === 'session_upserted' && frame.sessionId === 'run-session'));
    const after = (await sessionsDb.getSessionById('run-session'))?.updated_at;
    assert.notEqual(after, before);

    tab.frames.length = 0;
    await run.writer.send({ kind: 'complete', sessionId: 'run-session', provider: 'claude' } as never);
    await waitFor(() => tab.frames.some((frame) => frame.kind === 'session_upserted' && frame.sessionId === 'run-session'));
  });
});

test('frames another process published reach this process\'s tabs, its own are not sent twice', { concurrency: false }, async () => {
  await withIsolatedDatabase(async (tab) => {
    startSessionListRelay();
    try {
      await new Promise((resolve) => setTimeout(resolve, 1500)); // LISTEN is up
      const channel = `cloudcli_sessions_${resolveSchema()}`;
      const frame = JSON.stringify({ kind: 'session_removed', sessionId: 'elsewhere', action: 'deleted', timestamp: 'x' });
      await notify(channel, JSON.stringify({ origin: 'another-process', frame }));
      await waitFor(() => tab.frames.some((f) => f.sessionId === 'elsewhere'));

      await sessionsDb.createAppSession('local-session', 'claude', '/tmp/list-broadcast-project', 'Local');
      await broadcastSessionUpserted('local-session');
      await new Promise((resolve) => setTimeout(resolve, 1500));
      assert.equal(tab.frames.filter((f) => f.sessionId === 'local-session').length, 1);
    } finally {
      await stopSessionListRelay();
    }
  });
});

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
