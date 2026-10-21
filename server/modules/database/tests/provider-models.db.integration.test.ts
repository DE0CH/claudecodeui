import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  get,
  all,
  run,
  initializeDatabase,
  providerModelsDb,
  sessionsDb,
} from '@/modules/database/index.js';
import { releaseTestDatabase } from '@/modules/database/testing.js';

test('provider model repository stores custom rows only and maintains session references', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'provider-model-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  await closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await writeFile(databasePath, '');
  await initializeDatabase();

  try {
    const columns = await all<{ name: string }>(
      `SELECT column_name AS name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'provider_models' ORDER BY ordinal_position`,
    );
    assert.deepEqual(columns.map((column) => column.name), [
      'id',
      'provider',
      'model_id',
      'model_name',
      'sort_order',
      'created_at',
      'updated_at',
      'effort_values',
      'effort_default',
    ]);
    assert.deepEqual(await providerModelsDb.listCustomProviderModels('codex'), []);

    const custom = await providerModelsDb.createCustomProviderModel('codex', {
      model: 'Private Gateway Model',
      id: 'gateway/model-v1',
    });
    assert.equal(custom.modelId, 'gateway/model-v1');
    assert.equal(custom.effort, null);
    assert.equal(
      (await providerModelsDb.findCustomProviderModelByModelId('codex', 'gateway/model-v1'))?.recordId,
      custom.recordId,
    );

    await run(`
      INSERT INTO projects (project_id, project_path)
      VALUES ('project-1', '/tmp/project-1')
    `);
    await run(`
      INSERT INTO sessions (session_id, provider, project_path, model, effort)
      VALUES ('session-1', 'codex', '/tmp/project-1', 'gateway/model-v1', 'high')
    `);

    const updated = await providerModelsDb.updateCustomProviderModel('codex', custom.recordId, {
      model: 'Private Gateway Model 2',
      id: 'gateway/model-v2',
    });
    assert.equal(updated?.modelId, 'gateway/model-v2');
    assert.equal((await sessionsDb.getSessionById('session-1'))?.model, 'gateway/model-v2');
    // A rename keeps the same underlying model, so its effort stays applicable.
    assert.equal((await sessionsDb.getSessionById('session-1'))?.effort, 'high');

    const removed = await providerModelsDb.deleteCustomProviderModel(
      'codex',
      custom.recordId,
      'gpt-default',
    );
    assert.equal(removed?.modelId, 'gateway/model-v2');
    assert.equal((await sessionsDb.getSessionById('session-1'))?.model, 'gpt-default');
    // The effort belonged to the deleted model and must not survive onto the
    // fallback, which has its own default.
    assert.equal((await sessionsDb.getSessionById('session-1'))?.effort, null);
    assert.equal(await providerModelsDb.getCustomProviderModel('codex', custom.recordId), null);
  } finally {
    await releaseTestDatabase();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('the schema creates the provider model ordering index', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'provider-model-index-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  await closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    const index = await get<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_provider_models_provider_order'`,
    );
    assert.match(index?.indexdef ?? '', /\(provider, sort_order, id\)/);
    // Initializing again is a no-op.
    await initializeDatabase();
  } finally {
    await releaseTestDatabase();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('provider model repository persists declared effort levels', async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'provider-model-effort-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  await closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await writeFile(databasePath, '');
  await initializeDatabase();

  try {
    const custom = await providerModelsDb.createCustomProviderModel('claude', {
      model: 'My Custom Model',
      id: 'my-custom-model',
      effort: { values: ['low', 'high'], default: 'high' },
    });
    assert.deepEqual(custom.effort, { values: ['low', 'high'], default: 'high' });
    assert.deepEqual(
      (await providerModelsDb.listCustomProviderModels('claude'))[0]?.effort,
      { values: ['low', 'high'], default: 'high' },
    );

    // Omitting effort on update keeps the stored levels.
    const renamed = await providerModelsDb.updateCustomProviderModel('claude', custom.recordId, {
      model: 'Renamed',
      id: 'my-custom-model',
    });
    assert.deepEqual(renamed?.effort, { values: ['low', 'high'], default: 'high' });

    const narrowed = await providerModelsDb.updateCustomProviderModel('claude', custom.recordId, {
      model: 'Renamed',
      id: 'my-custom-model',
      effort: { values: ['medium'] },
    });
    assert.deepEqual(narrowed?.effort, { values: ['medium'] });

    const cleared = await providerModelsDb.updateCustomProviderModel('claude', custom.recordId, {
      model: 'Renamed',
      id: 'my-custom-model',
      effort: null,
    });
    assert.equal(cleared?.effort, null);
    const row = await get('SELECT effort_values, effort_default FROM provider_models WHERE id = ?', [custom.recordId]);
    assert.deepEqual(row, { effort_values: null, effort_default: null });
  } finally {
    await releaseTestDatabase();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
