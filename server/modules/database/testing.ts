/**
 * Test helpers for the Postgres-backed database.
 *
 * Tests give themselves a private database by pointing DATABASE_PATH at a temp path (connection.ts derives a
 * private schema from it). `releaseTestDatabase()` drops that schema and closes the pool, so test runs don't
 * leave schemas behind on the test server.
 */
import { closeConnection, dropSchema } from '@/modules/database/connection.js';

/** Drops the current test schema (DATABASE_PATH-derived only, never an explicit DATABASE_SCHEMA) and closes the pool. */
export async function releaseTestDatabase(): Promise<void> {
  if (process.env.DATABASE_PATH && !process.env.DATABASE_SCHEMA) {
    await dropSchema().catch((error: unknown) => {
      console.warn('[test-db] could not drop the test schema:', error instanceof Error ? error.message : error);
    });
  }
  await closeConnection();
}
