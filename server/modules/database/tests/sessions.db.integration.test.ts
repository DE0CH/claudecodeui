import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sessions-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  await closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    await closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('session archive queries hide archived rows from active project views', async () => {
  withIsolatedDatabase(async () => {
    await sessionsDb.createSession('session-active', 'claude', '/workspace/demo-project', 'Active Session');
    await sessionsDb.createSession('session-archived', 'claude', '/workspace/demo-project', 'Archived Session');
    await sessionsDb.updateSessionIsArchived('session-archived', true);

    const activeSessions = await sessionsDb.getAllSessions();
    const archivedSessions = await sessionsDb.getArchivedSessions();
    const activeProjectSessions = await sessionsDb.getSessionsByProjectPath('/workspace/demo-project');
    const allProjectSessions = await sessionsDb.getSessionsByProjectPathIncludingArchived('/workspace/demo-project');

    assert.deepEqual(activeSessions.map((session) => session.session_id), ['session-active']);
    assert.deepEqual(archivedSessions.map((session) => session.session_id), ['session-archived']);
    assert.deepEqual(activeProjectSessions.map((session) => session.session_id), ['session-active']);
    assert.deepEqual(
      allProjectSessions.map((session) => session.session_id).sort(),
      ['session-active', 'session-archived'],
    );
    assert.equal(await sessionsDb.countSessionsByProjectPath('/workspace/demo-project'), 1);
  });
});

test('createSession reactivates archived rows when the session becomes active again', async () => {
  withIsolatedDatabase(async () => {
    await sessionsDb.createSession('session-reused', 'claude', '/workspace/demo-project', 'First Name');
    await sessionsDb.updateSessionIsArchived('session-reused', true);

    await sessionsDb.createSession('session-reused', 'claude', '/workspace/demo-project', 'Updated Name');

    const activeSessions = await sessionsDb.getAllSessions();
    const archivedSessions = await sessionsDb.getArchivedSessions();
    const restoredSession = await sessionsDb.getSessionById('session-reused');

    assert.equal(activeSessions.length, 1);
    assert.equal(activeSessions[0]?.session_id, 'session-reused');
    assert.equal(activeSessions[0]?.custom_name, 'Updated Name');
    assert.equal(archivedSessions.length, 0);
    assert.equal(restoredSession?.isArchived, 0);
  });
});

test("createSession leaves an archived row archived when the transcript has not changed", async () => {
  withIsolatedDatabase(async () => {
    const createdAt = "2026-07-18T09:00:00.000Z";
    const updatedAt = "2026-07-18T10:00:00.000Z";
    const jsonlPath = "/transcripts/session-untouched.jsonl";

    await sessionsDb.createSession("session-untouched", "claude", "/workspace/demo-project", "A Name", createdAt, updatedAt, jsonlPath);
    await sessionsDb.updateSessionIsArchived("session-untouched", true);

    // A full rescan re-indexes every transcript created since the last scan,
    // changed or not, and hands over the timestamps the file still carries.
    await sessionsDb.createSession("session-untouched", "claude", "/workspace/demo-project", "A Name", createdAt, updatedAt, jsonlPath);

    assert.equal((await sessionsDb.getSessionById("session-untouched"))?.isArchived, 1);
    assert.equal((await sessionsDb.getArchivedSessions()).length, 1);
    assert.equal((await sessionsDb.getAllSessions()).length, 0);

    // Actually writing to the session again still brings it back.
    await sessionsDb.createSession("session-untouched", "claude", "/workspace/demo-project", "A Name", createdAt, "2026-07-18T11:00:00.000Z", jsonlPath);

    assert.equal((await sessionsDb.getSessionById("session-untouched"))?.isArchived, 0);
  });
});

test("the upsert path counts an omitted timestamp as activity", async () => {
  withIsolatedDatabase(async () => {
    // An app-created row carries no provider id, so indexing it takes the
    // INSERT ... ON CONFLICT branch rather than the UPDATE above. Its
    // updated_at is CURRENT_TIMESTAMP, which resolves to whole seconds, so a
    // call in the same second is not *newer* -- the omitted timestamp itself
    // has to be what reactivates the row.
    await sessionsDb.createAppSession("session-legacy", "claude", "/workspace/demo-project");
    await sessionsDb.updateSessionIsArchived("session-legacy", true);

    await sessionsDb.createSession("session-legacy", "claude", "/workspace/demo-project", "Indexed Name");

    assert.equal((await sessionsDb.getSessionById("session-legacy"))?.isArchived, 0);
  });
});

test("the upsert path leaves an archived row alone for a transcript older than it", async () => {
  withIsolatedDatabase(async () => {
    await sessionsDb.createAppSession("session-stale", "claude", "/workspace/demo-project");
    await sessionsDb.updateSessionIsArchived("session-stale", true);

    await sessionsDb.createSession("session-stale", "claude", "/workspace/demo-project", "Indexed Name", "2026-07-18T09:00:00.000Z", "2026-07-18T10:00:00.000Z", "/transcripts/session-stale.jsonl");

    assert.equal((await sessionsDb.getSessionById("session-stale"))?.isArchived, 1);
  });
});


test('repository reads normalize SQLite UTC timestamps to ISO strings', async () => {
  withIsolatedDatabase(async () => {
    await sessionsDb.createAppSession('session-timezone', 'claude', '/workspace/demo-project');

    const row = await sessionsDb.getSessionById('session-timezone');
    assert.ok(row?.created_at.endsWith('Z'));
    assert.ok(row?.updated_at.endsWith('Z'));
    assert.match(row?.created_at ?? '', /^\d{4}-\d{2}-\d{2}T/);
    assert.match(row?.updated_at ?? '', /^\d{4}-\d{2}-\d{2}T/);
  });
});

test('recent sessions are globally ordered, paginated, and limited to visible conversations', async () => {
  withIsolatedDatabase(async () => {
    const fixtures: Array<Parameters<typeof sessionsDb.createSession>> = [
      ['session-oldest', 'claude', '/workspace/project-a', 'Oldest', '2026-07-18T09:00:00.000Z', '2026-07-18T10:00:00.000Z'],
      ['session-newest', 'codex', '/workspace/project-b', 'Newest', '2026-07-18T11:00:00.000Z', '2026-07-18T12:00:00.900Z'],
      ['session-same-second', 'claude', '/workspace/project-a', 'Same second, slightly older', '2026-07-18T12:00:00.000Z', '2026-07-18T12:00:00.100Z'],
      ['session-middle', 'claude', '/workspace/project-a', 'Middle', '2026-07-18T10:00:00.000Z', '2026-07-18T11:00:00.000Z'],
      ['session-archived', 'claude', '/workspace/project-a', 'Archived session', '2026-07-18T13:00:00.000Z', '2026-07-18T13:00:00.000Z'],
      ['session-hidden-project', 'claude', '/workspace/project-hidden', 'Archived project session', '2026-07-18T14:00:00.000Z', '2026-07-18T14:00:00.000Z'],
    ];
    fixtures.forEach((fixture) => sessionsDb.createSession(...fixture));

    await sessionsDb.updateSessionIsArchived('session-archived', true);
    await projectsDb.updateProjectIsArchived('/workspace/project-hidden', true);

    const firstPage = await sessionsDb.getRecentSessionsPage(2, 0);
    const secondPage = await sessionsDb.getRecentSessionsPage(2, 2);

    assert.equal(firstPage.total, 4);
    assert.deepEqual(
      firstPage.sessions.map((session) => session.session_id),
      ['session-newest', 'session-same-second'],
    );
    assert.equal(secondPage.total, 4);
    assert.deepEqual(
      secondPage.sessions.map((session) => session.session_id),
      ['session-middle', 'session-oldest'],
    );
  });
});
