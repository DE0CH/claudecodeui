import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { releaseTestDatabase } from '@/modules/database/testing.js';

// Each provider synchronizer resolves `os.homedir()` when the registry module is
// first imported, so HOME has to point at an empty fixture home *before* that
// import runs. Otherwise the sync pass walks the developer's real ~/.claude.
const fixtureHome = await mkdtemp(path.join(os.tmpdir(), 'session-prune-home-'));
const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;
process.env.HOME = fixtureHome;
process.env.USERPROFILE = fixtureHome;

const { sessionSynchronizerService } = await import(
  '@/modules/providers/services/session-synchronizer.service.js'
);

process.on('exit', () => {
  if (previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }
  if (previousUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = previousUserProfile;
  }
});

async function withIsolatedDatabase(runTest: (workspace: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-prune-db-'));

  await closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest(tempDirectory);
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

const PROJECT_PATH = '/tmp/session-prune-project';

test('synchronizeSessions drops indexed sessions whose transcript file was deleted', async () => {
  await withIsolatedDatabase(async (workspace) => {
    const transcriptDirectory = path.join(workspace, 'transcripts');
    await mkdir(transcriptDirectory, { recursive: true });

    const livePath = path.join(transcriptDirectory, 'live.jsonl');
    await writeFile(livePath, '{}\n');
    const deletedPath = path.join(transcriptDirectory, 'deleted.jsonl');

    await sessionsDb.createSession('live-session', 'claude', PROJECT_PATH, 'Live', undefined, undefined, livePath);
    await sessionsDb.createSession('orphan-session', 'claude', PROJECT_PATH, 'Untitled Claude Session', undefined, undefined, deletedPath);

    const result = await sessionSynchronizerService.synchronizeSessions();

    assert.deepEqual(result.failures, []);
    assert.equal(result.prunedOrphans, 1);
    assert.equal(await sessionsDb.getSessionById('orphan-session'), null);
    assert.ok(await sessionsDb.getSessionById('live-session'), 'a session whose transcript still exists must survive');
  });
});

test('synchronizeSessions keeps sessions whose whole transcript directory is missing', async () => {
  await withIsolatedDatabase(async (workspace) => {
    // Stands in for an unmounted or not-yet-created home: every transcript
    // "looks" deleted, so pruning here would wipe the entire index.
    const unmountedPath = path.join(workspace, 'not-mounted', 'session.jsonl');

    await sessionsDb.createSession('unmounted-session', 'claude', PROJECT_PATH, 'Unmounted', undefined, undefined, unmountedPath);

    const result = await sessionSynchronizerService.synchronizeSessions();

    assert.equal(result.prunedOrphans, 0);
    assert.ok(await sessionsDb.getSessionById('unmounted-session'));
  });
});

test('synchronizeSessions keeps sessions that have no transcript path yet', async () => {
  await withIsolatedDatabase(async () => {
    // App-created rows (jsonl_path NULL until the first provider write) and
    // OpenCode rows (one shared sqlite file, so jsonl_path stays NULL).
    await sessionsDb.createAppSession('pending-app-session', 'claude', PROJECT_PATH, 'Pending');
    await sessionsDb.createSession('opencode-session', 'opencode', PROJECT_PATH, 'OpenCode', undefined, undefined, null);

    const result = await sessionSynchronizerService.synchronizeSessions();

    assert.equal(result.prunedOrphans, 0);
    assert.ok(await sessionsDb.getSessionById('pending-app-session'));
    assert.ok(await sessionsDb.getSessionById('opencode-session'));
  });
});
