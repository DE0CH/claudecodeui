import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { all, closeConnection, get, initializeDatabase, run, transaction } from '@/modules/database/index.js';
import { translateSql } from '@/modules/database/connection.js';
import { releaseTestDatabase } from '@/modules/database/testing.js';

async function withDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'connection-db-'));
  await closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    await runTest();
  } finally {
    await releaseTestDatabase();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('translateSql numbers placeholders outside string literals and types a bare `? IS NULL`', () => {
  assert.equal(
    translateSql("SELECT * FROM t WHERE a = ? AND b = '?' AND (? IS NULL OR c = ?)"),
    "SELECT * FROM t WHERE a = $1 AND b = '?' AND ($2::text IS NULL OR c = $3)",
  );
});

test('translateSql keeps SQLite NULL ordering for explicit ASC/DESC', () => {
  assert.equal(
    translateSql('SELECT x FROM t ORDER BY a DESC, b ASC'),
    'SELECT x FROM t ORDER BY a DESC NULLS LAST, b ASC NULLS FIRST',
  );
  assert.equal(translateSql('ORDER BY a DESC NULLS FIRST'), 'ORDER BY a DESC NULLS FIRST');
});

test('julianday and datetime read SQLite text and ISO timestamps like SQLite', async () => {
  await withDatabase(async () => {
    const row = await get<{ same: boolean; later: boolean; bad: number | null; text: string; iso: string; empty: string | null }>(`
      SELECT
        julianday('2026-07-18 10:00:00') = julianday('2026-07-18T10:00:00.000Z') AS same,
        julianday('2026-07-18T10:00:00.500Z') > julianday('2026-07-18 10:00:00') AS later,
        julianday('not a date') AS bad,
        datetime('2026-07-18T10:00:00.900Z') AS text,
        datetime('2026-07-18T12:00:00+02:00') AS iso,
        datetime('') AS empty
    `);
    assert.equal(row?.same, true);
    assert.equal(row?.later, true);
    assert.equal(row?.bad, null);
    assert.equal(row?.text, '2026-07-18 10:00:00');
    assert.equal(row?.iso, '2026-07-18 10:00:00');
    assert.equal(row?.empty, null);
    // SQLite's epoch for julianday.
    assert.equal((await get<{ jd: number }>("SELECT julianday('1970-01-01 00:00:00') AS jd"))?.jd, 2440587.5);
  });
});

test('text sorts bytewise and NULLs sort like SQLite', async () => {
  await withDatabase(async () => {
    await run("INSERT INTO projects (project_id, project_path) VALUES ('p', '/p')");
    for (const [id, updated] of [['b', '2026-01-02 00:00:00'], ['B', null], ['a', '2026-01-01 00:00:00'], ['_', null]] as const) {
      await run('INSERT INTO sessions (session_id, project_path, updated_at) VALUES (?, ?, ?)', [id, '/p', updated]);
    }
    const byId = await all<{ session_id: string }>('SELECT session_id FROM sessions ORDER BY session_id ASC');
    assert.deepEqual(byId.map((r) => r.session_id), ['B', '_', 'a', 'b']);
    const byUpdated = await all<{ session_id: string }>('SELECT session_id FROM sessions ORDER BY updated_at DESC, session_id ASC');
    assert.deepEqual(byUpdated.map((r) => r.session_id), ['b', 'a', 'B', '_']);
  });
});

test('transaction rolls back every statement when its body throws', async () => {
  await withDatabase(async () => {
    await assert.rejects(transaction(async () => {
      await run("INSERT INTO projects (project_id, project_path) VALUES ('tx', '/tx')");
      throw new Error('boom');
    }), /boom/);
    assert.equal((await get<{ n: number }>('SELECT COUNT(*) AS n FROM projects'))?.n, 0);
  });
});
