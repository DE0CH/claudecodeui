import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import type { IProviderFork } from '@/shared/interfaces.js';
import { releaseTestDatabase } from '@/modules/database/testing.js';

const SOURCE_ID = 'fork-source';

type ForkCall = {
  providerSessionId: string;
  jsonlPath: string;
  upToAnchorId?: string;
  title?: string;
};

async function withForkableClaude(
  runTest: (context: { calls: ForkCall[]; directory: string }) => Promise<void>,
  options: { disableFork?: boolean } = {},
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'session-fork-'));
  const sourcePath = path.join(directory, 'native-source.jsonl');
  const forkedPath = path.join(directory, 'native-fork.jsonl');
  await writeFile(sourcePath, '{}\n', 'utf8');
  await writeFile(forkedPath, '{}\n', 'utf8');

  await closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();

  const calls: ForkCall[] = [];
  const claude = providerRegistry.resolveProvider('claude') as { fork?: IProviderFork };
  const realFork = claude.fork;
  const replacement = options.disableFork
    ? undefined
    : {
      forkSession: async (input: ForkCall) => {
        calls.push(input);
        return { providerSessionId: 'native-fork', jsonlPath: forkedPath };
      },
    } as IProviderFork;

  Object.defineProperty(claude, 'fork', { value: replacement, configurable: true, writable: true });

  try {
    await runTest({ calls, directory });
  } finally {
    Object.defineProperty(claude, 'fork', { value: realFork, configurable: true, writable: true });
    await releaseTestDatabase();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

async function seedSource(directory: string): Promise<void> {
  const now = new Date().toISOString();
  await sessionsDb.createSession(
    SOURCE_ID,
    'claude',
    directory,
    'Original session',
    now,
    now,
    path.join(directory, 'native-source.jsonl'),
  );
  await sessionsDb.assignProviderSessionId(SOURCE_ID, 'native-source');
}

test('a fork becomes an independent session that points back at its source', async () => {
  await withForkableClaude(async ({ calls, directory }) => {
    await seedSource(directory);

    const result = await sessionsService.forkSessionById(SOURCE_ID, { upToAnchorId: 'uuid-3' });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].providerSessionId, 'native-source');
    assert.equal(calls[0].upToAnchorId, 'uuid-3');

    const forked = await sessionsDb.getSessionById(result.sessionId);
    assert.ok(forked);
    // Written before the watcher can see the new file, so it is never indexed
    // a second time under its provider-native id.
    assert.equal(forked?.provider_session_id, 'native-fork');
    assert.equal(forked?.jsonl_path, path.join(directory, 'native-fork.jsonl'));
    assert.equal(forked?.forked_from_session_id, SOURCE_ID);
    assert.equal(forked?.custom_name, 'Original session (fork)');

    // The source is untouched: this is "try two approaches", not a move.
    const source = await sessionsDb.getSessionById(SOURCE_ID);
    assert.equal(source?.provider_session_id, 'native-source');
    assert.equal(source?.custom_name, 'Original session');
  });
});

test('a fork inherits the model and effort of the conversation it branched from', async () => {
  await withForkableClaude(async ({ directory }) => {
    await seedSource(directory);
    await sessionsDb.setSessionModel(SOURCE_ID, 'claude-opus-5');
    await sessionsDb.setSessionEffort(SOURCE_ID, 'xhigh');

    const result = await sessionsService.forkSessionById(SOURCE_ID);

    const forked = await sessionsDb.getSessionById(result.sessionId);
    assert.equal(forked?.model, 'claude-opus-5');
    assert.equal(forked?.effort, 'xhigh');
  });
});

test('forking replaces a row the watcher already made for the new transcript', async () => {
  await withForkableClaude(async ({ directory }) => {
    await seedSource(directory);
    // The watcher wins the race and indexes the fork under its native id.
    const now = new Date().toISOString();
    await sessionsDb.createSession(
      'native-fork',
      'claude',
      directory,
      'Indexed by the watcher',
      now,
      now,
      path.join(directory, 'native-fork.jsonl'),
    );

    const result = await sessionsService.forkSessionById(SOURCE_ID);

    assert.equal(await sessionsDb.getSessionById('native-fork'), null);
    assert.equal((await sessionsDb.getSessionById(result.sessionId))?.provider_session_id, 'native-fork');
  });
});

test('a session with no transcript yet cannot be forked', async () => {
  await withForkableClaude(async ({ directory }) => {
    // An app-created session that has never run: no provider id, no transcript.
    await sessionsDb.createAppSession('never-ran', 'claude', directory, 'Never ran');

    await assert.rejects(
      async () => sessionsService.forkSessionById('never-ran'),
      (error: Error & { code?: string }) => error.code === 'FORK_SOURCE_NOT_READY',
    );
  });
});

test('a provider without the capability is refused rather than silently ignored', async () => {
  await withForkableClaude(
    async ({ directory }) => {
      await seedSource(directory);

      await assert.rejects(
        async () => sessionsService.forkSessionById(SOURCE_ID),
        (error: Error & { code?: string }) => error.code === 'FORK_NOT_SUPPORTED',
      );
    },
    { disableFork: true },
  );
});

test('forking a session that does not exist is a 404', async () => {
  await withForkableClaude(async () => {
    await assert.rejects(
      async () => sessionsService.forkSessionById('no-such-session'),
      (error: Error & { code?: string }) => error.code === 'SESSION_NOT_FOUND',
    );
  });
});
