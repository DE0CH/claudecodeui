import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, run } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import { releaseTestDatabase } from '@/modules/database/testing.js';

async function withIsolatedDatabase(runTest: () => Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(tmpdir(), 'jarvis-deleted-'));
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

test('Recently deleted: hidden from the lists, listed with its time, restorable, and not revived by a transcript write', async () => {
  await withIsolatedDatabase(async () => {
    await sessionsDb.createAppSession('app-1', 'claude', '/workspace', 'First words');
    await sessionsDb.assignProviderSessionId('app-1', 'prov-1');
    await sessionsDb.moveSessionToRecentlyDeleted('app-1');

    assert.equal((await sessionsDb.getRecentSessionsPage(10, 0)).total, 0);
    const deleted = await sessionsDb.getRecentlyDeletedSessions();
    assert.equal(deleted.length, 1);
    assert.match(String(deleted[0]!.deleted_at), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);

    // the synchronizer seeing a newer transcript must not bring it back
    await sessionsDb.createSession('prov-1', 'claude', '/workspace', 'x', undefined, new Date(Date.now() + 60_000).toISOString());
    assert.equal((await sessionsDb.getRecentSessionsPage(10, 0)).total, 0);

    assert.deepEqual(await sessionsDb.getSessionIdsDeletedBefore(30), []);
    await run(`UPDATE sessions SET deleted_at = to_char(now() at time zone 'utc' - interval '31 days', 'YYYY-MM-DD HH24:MI:SS') WHERE session_id = ?`, ['app-1']);
    assert.deepEqual(await sessionsDb.getSessionIdsDeletedBefore(30), ['app-1']);

    await sessionsDb.restoreSessionFromRecentlyDeleted('app-1');
    assert.equal((await sessionsDb.getRecentSessionsPage(10, 0)).total, 1);
    assert.equal((await sessionsDb.getRecentlyDeletedSessions()).length, 0);
  });
});

test('names: the title replaces a provisional name, a rename wins over both and over Claude Code', async () => {
  await withIsolatedDatabase(async () => {
    await sessionsDb.createAppSession('app-2', 'claude', '/workspace', '幫我整理今日有關港珠澳大橋…');
    assert.equal(await sessionsDb.setProvisionalSessionName('app-2', 'Claude title'), true);
    assert.equal(await sessionsDb.setGeneratedSessionTitle('app-2', '港珠澳大橋今日新聞'), true);
    assert.equal(await sessionsDb.setProvisionalSessionName('app-2', 'Claude again'), false);
    assert.equal((await sessionsDb.getSessionById('app-2'))!.custom_name, '港珠澳大橋今日新聞');

    await sessionsDb.updateSessionCustomName('app-2', '我的名');
    assert.equal(await sessionsDb.setGeneratedSessionTitle('app-2', 'later'), false);
    await sessionsDb.assignProviderSessionId('app-2', 'prov-2');
    await sessionsDb.createSession('prov-2', 'claude', '/workspace', 'from disk');
    const row = await sessionsDb.getSessionById('app-2');
    assert.equal(row!.custom_name, '我的名');
    assert.equal(row!.name_source, 'user');
  });
});
