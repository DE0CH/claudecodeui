/**
 * App config repository.
 *
 * Key-value store for application-level configuration that persists
 * across restarts (JWT secret, feature flags, etc.). Values are always
 * stored as strings; callers handle parsing.
 */

import crypto from 'crypto';

import { all, get, run, transaction } from '@/modules/database/connection.js';

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const appConfigDb = {
  /** Returns the stored value for a config key, or null if missing. */
  async get(key: string): Promise<string | null> {
    try {
      const row = (await get('SELECT value FROM app_config WHERE key = ?', [key])) as { value: string } | undefined;
      return row?.value ?? null;
    } catch {
      // Swallow errors so early-startup reads (e.g. JWT secret) do not crash.
      return null;
    }
  },

  /** Inserts or updates a config key (upsert). */
  async set(key: string, value: string): Promise<void> {
    (await run('INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]));
  },

  /**
   * Returns the JWT signing secret, generating and persisting one
   * if it does not already exist. This ensures the secret survives
   * server restarts while being created automatically on first boot.
   */
  async getOrCreateJwtSecret(): Promise<string> {
    let secret = await appConfigDb.get('jwt_secret');
    if (!secret) {
      secret = crypto.randomBytes(64).toString('hex');
      await appConfigDb.set('jwt_secret', secret);
    }
    return secret;
  },
};
