/**
 * Database connection: Postgres (Jarvis 3 fork; upstream uses a local better-sqlite3 file).
 *
 * The schema mirrors upstream's SQLite one exactly (schema.ts): timestamps are text in SQLite's
 * `YYYY-MM-DD HH:MM:SS` form, booleans are 0/1 integers, ids are plain numbers, so the repositories and their
 * callers see the same values as before. Every query goes through `all`/`get`/`run`, which take the repositories'
 * SQLite SQL and translate the few dialect differences (`?` placeholders, CURRENT_TIMESTAMP, `datetime(x)`,
 * the camel-case columns `isStarred`/`isArchived`, which SQLite matches case-insensitively).
 *
 * Where the data lives:
 *   - DATABASE_URL: the Postgres server (default: TEST_DATABASE_URL, else the local test server);
 *   - DATABASE_SCHEMA: this installation's schema (one per CloudCLI user process), created on first use.
 *     Without it (the tests), the schema is derived from DATABASE_PATH, so a test's private database path still
 *     gives it a private, empty schema.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

import pg from 'pg';

// int8 (count(*), sums) as numbers, like SQLite
pg.types.setTypeParser(20, (v: string) => Number(v));

type Queryable = { query: (text: string, values?: unknown[]) => Promise<pg.QueryResult> };

let pool: pg.Pool | null = null;
let poolSchema = '';
let schemaReady: Promise<void> | null = null;
const txClient = new AsyncLocalStorage<pg.PoolClient>();

const TEST_URL = 'postgres://claude:dev@127.0.0.1:5432/postgres';

function resolveUrl(): string {
  return process.env.DATABASE_URL || process.env.TEST_DATABASE_URL || TEST_URL;
}

/** The schema name: DATABASE_SCHEMA, else one derived from DATABASE_PATH (tests), else `cloudcli`. */
export function resolveSchema(): string {
  const explicit = process.env.DATABASE_SCHEMA;
  if (explicit) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(explicit)) throw new Error('DATABASE_SCHEMA must be a lowercase identifier');
    return explicit;
  }
  const p = process.env.DATABASE_PATH;
  if (p) return `cc_t_${createHash('sha256').update(p).digest('hex').slice(0, 20)}`;
  return 'cloudcli';
}

/** SQLite's CURRENT_TIMESTAMP text, in UTC. */
export const NOW_TEXT = "to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS')";

/** The repositories' SQLite SQL as Postgres SQL. */
export function translateSql(sql: string): string {
  let out = '';
  let n = 0;
  let inStr = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    if (c === "'") inStr = !inStr;
    if (c === '?' && !inStr) {
      n += 1;
      out += `$${n}`;
      continue;
    }
    out += c;
  }
  return out
    .replace(/\bCURRENT_TIMESTAMP\b/g, NOW_TEXT)
    .replace(/\bdatetime\(/gi, '(')
    .replace(/(?<!")\bisStarred\b(?!")/g, '"isStarred"')
    .replace(/(?<!")\bisArchived\b(?!")/g, '"isArchived"');
}

function getPool(): pg.Pool {
  const schema = resolveSchema();
  if (pool && poolSchema === schema) return pool;
  if (pool) void pool.end().catch(() => {});
  poolSchema = schema;
  pool = new pg.Pool({
    connectionString: resolveUrl(),
    max: Number(process.env.DATABASE_POOL_MAX || 5),
    options: `-c search_path=${schema}`,
  });
  pool.on('error', (e) => console.error('[database] idle client error', e.message));
  schemaReady = null;
  return pool;
}

function target(): Queryable {
  return txClient.getStore() ?? getPool();
}

/** Makes this installation's schema if it doesn't exist yet (run before any table is touched). */
export async function ensureSchema(): Promise<void> {
  const p = getPool();
  schemaReady ??= p.query(`create schema if not exists ${poolSchema}`).then(() => undefined);
  await schemaReady;
}

export async function all<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await target().query(translateSql(sql), params);
  return r.rows as T[];
}

export async function get<T = any>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  const r = await target().query(translateSql(sql), params);
  return r.rows[0] as T | undefined;
}

/** `changes`: rows affected; `lastInsertRowid`: the `id` a `RETURNING id` gave (SQLite's run() result shape). */
export async function run(sql: string, params: unknown[] = []): Promise<{ changes: number; lastInsertRowid?: number }> {
  const r = await target().query(translateSql(sql), params);
  const id = r.rows?.[0]?.id;
  return { changes: r.rowCount ?? 0, ...(id !== undefined ? { lastInsertRowid: Number(id) } : {}) };
}

/** Several statements without parameters (schema). */
export async function exec(sql: string): Promise<void> {
  await target().query(sql);
}

/**
 * Runs `fn` in one transaction; every all/get/run inside it (in this async context) uses the transaction's
 * connection. Nested calls join the outer transaction.
 */
export async function transaction<T>(fn: () => Promise<T>): Promise<T> {
  if (txClient.getStore()) return await fn();
  const client = await getPool().connect();
  try {
    await client.query('begin');
    const result = await txClient.run(client, fn);
    await client.query('commit');
    return result;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Where the data is, for diagnostics (upstream returned the SQLite file path). */
export function getDatabasePath(): string {
  const u = new URL(resolveUrl());
  return `postgres://${u.host}${u.pathname} schema ${resolveSchema()}`;
}

/** Closes the pool (graceful shutdown, tests). */
export async function closeConnection(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = null;
    schemaReady = null;
    await p.end();
  }
}

/** Drops this installation's schema (tests only). */
export async function dropSchema(): Promise<void> {
  const schema = resolveSchema();
  await getPool().query(`drop schema if exists ${schema} cascade`);
}
