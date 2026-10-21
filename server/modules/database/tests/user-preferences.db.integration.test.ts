import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  run,
  sessionDraftsDb,
  userPreferencesDb,
} from '@/modules/database/index.js';
import { releaseTestDatabase } from '@/modules/database/testing.js';

const USER_ID = 1;

async function withDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'user-prefs-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  await closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await writeFile(databasePath, '');
  await initializeDatabase();

  // Both tables cascade from users(id), so a row has to exist to write against.
  await run('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)', [USER_ID, 'tester', 'hash']);

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

test('preferences round-trip every JSON shape a setting can take', async () => {
  await withDatabase(async () => {
    await userPreferencesDb.savePreferences(USER_ID, {
      theme: 'dark',
      tasksEnabled: false,
      claudePermissions: { allowedTools: ['Read'], skipPermissions: true },
    });

    assert.deepEqual(await userPreferencesDb.getPreferences(USER_ID), {
      theme: 'dark',
      tasksEnabled: false,
      claudePermissions: { allowedTools: ['Read'], skipPermissions: true },
    });
  });
});

test('saving preferences merge-patches instead of replacing the whole set', async () => {
  await withDatabase(async () => {
    await userPreferencesDb.savePreferences(USER_ID, { theme: 'dark', userLanguage: 'de' });
    await userPreferencesDb.savePreferences(USER_ID, { theme: 'light' });

    assert.deepEqual(await userPreferencesDb.getPreferences(USER_ID), {
      theme: 'light',
      userLanguage: 'de',
    });
  });
});

test('a preference set to undefined is removed', async () => {
  await withDatabase(async () => {
    await userPreferencesDb.savePreferences(USER_ID, { theme: 'dark', userLanguage: 'de' });
    await userPreferencesDb.savePreferences(USER_ID, { userLanguage: undefined });

    assert.deepEqual(await userPreferencesDb.getPreferences(USER_ID), { theme: 'dark' });
  });
});

test('one unreadable preference value does not cost the user the others', async () => {
  await withDatabase(async () => {
    await userPreferencesDb.savePreferences(USER_ID, { theme: 'dark' });
    await run(
      `INSERT INTO user_preferences (user_id, preference_key, preference_value)
       VALUES (?, ?, ?)`,
      [USER_ID, 'broken', 'not json'],
    );

    assert.deepEqual(await userPreferencesDb.getPreferences(USER_ID), { theme: 'dark' });
  });
});

test('drafts round-trip text and queued message per scope', async () => {
  await withDatabase(async () => {
    await sessionDraftsDb.saveDraft(USER_ID, 'session-a', { text: 'half typed', queuedMessage: null });
    await sessionDraftsDb.saveDraft(USER_ID, 'project:p1', {
      text: '',
      queuedMessage: { content: 'run it' },
    });

    const drafts = await sessionDraftsDb.getDrafts(USER_ID);
    const byScope = new Map(drafts.map((draft) => [draft.scope, draft]));

    assert.equal(byScope.get('session-a')?.text, 'half typed');
    assert.equal(byScope.get('session-a')?.queuedMessage, null);
    assert.equal(byScope.get('project:p1')?.text, '');
    assert.deepEqual(byScope.get('project:p1')?.queuedMessage, { content: 'run it' });
  });
});

test('saving an empty draft deletes the row rather than keeping a blank one', async () => {
  await withDatabase(async () => {
    await sessionDraftsDb.saveDraft(USER_ID, 'session-a', { text: 'typed', queuedMessage: null });
    await sessionDraftsDb.saveDraft(USER_ID, 'session-a', { text: '', queuedMessage: null });

    assert.deepEqual(await sessionDraftsDb.getDrafts(USER_ID), []);
  });
});

test('deleteDraft removes only the named scope', async () => {
  await withDatabase(async () => {
    await sessionDraftsDb.saveDraft(USER_ID, 'session-a', { text: 'a', queuedMessage: null });
    await sessionDraftsDb.saveDraft(USER_ID, 'session-b', { text: 'b', queuedMessage: null });

    await sessionDraftsDb.deleteDraft(USER_ID, 'session-a');

    assert.deepEqual(
      (await sessionDraftsDb.getDrafts(USER_ID)).map((draft) => draft.scope),
      ['session-b'],
    );
  });
});
