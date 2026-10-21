import { ensureSchema, exec, get, run, transaction } from '@/modules/database/connection.js';
import { APP_CONFIG_TABLE_SCHEMA_SQL, SCHEMA_VERSIONS } from '@/modules/database/schema.js';

/**
 * Makes this installation's schema current: the schema itself, app_config (auth reads it first), then every
 * SCHEMA_VERSIONS entry not applied yet, each in its own transaction under an advisory lock (two UI processes
 * starting at once apply each version once).
 */
export const initializeDatabase = async () => {
  try {
    await ensureSchema();
    await exec(APP_CONFIG_TABLE_SCHEMA_SQL);
    await exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)');
    for (let v = 1; v <= SCHEMA_VERSIONS.length; v++) {
      await transaction(async () => {
        await get('SELECT pg_advisory_xact_lock(hashtext(current_schema()))');
        if (await get('SELECT version FROM schema_version WHERE version = ?', [v])) return;
        await exec(SCHEMA_VERSIONS[v - 1]!);
        await run('INSERT INTO schema_version (version) VALUES (?)', [v]);
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log('Database initialization failed', { error: message });
    throw err;
  }
};
