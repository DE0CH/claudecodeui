/**
 * API keys repository.
 *
 * Manages API keys used for external/programmatic access to the backend.
 * Keys are prefixed with `ck_` and tied to a user via foreign key.
 */

import crypto from 'crypto';

import { all, get, run, transaction } from '@/modules/database/connection.js';

type ApiKeyRow = {
  id: number;
  key_name: string;
  api_key: string;
  created_at: string;
  last_used: string | null;
  is_active: number;
};

type CreateApiKeyResult = {
  id: number | bigint;
  keyName: string;
  apiKey: string;
};

type ValidatedApiKeyUser = {
  id: number;
  username: string;
  api_key_id: number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generates a cryptographically random API key with the `ck_` prefix. */
function generateApiKey(): string {
  return 'ck_' + crypto.randomBytes(32).toString('hex');
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const apiKeysDb = {
  generateApiKey,

  /** Creates a new API key for the given user and returns it for one-time display. */
  async createApiKey(userId: number, keyName: string): Promise<CreateApiKeyResult> {
    const apiKey = generateApiKey();
    const result = (await run('INSERT INTO api_keys (user_id, key_name, api_key) VALUES (?, ?, ?) RETURNING id', [userId, keyName, apiKey]));
    return { id: result.lastInsertRowid!, keyName, apiKey };
  },

  /** Lists all API keys for a user, most recent first. */
  async getApiKeys(userId: number): Promise<ApiKeyRow[]> {
    return (await all('SELECT id, key_name, api_key, created_at, last_used, is_active FROM api_keys WHERE user_id = ? ORDER BY created_at DESC', [userId])) as ApiKeyRow[];
  },

  /**
   * Validates an API key and resolves the owning user.
   * If the key is valid, its `last_used` timestamp is updated as a side effect.
   * Returns undefined when the key is invalid or the user is inactive.
   */
  async validateApiKey(apiKey: string): Promise<ValidatedApiKeyUser | undefined> {
    const row = (await get(`SELECT u.id, u.username, ak.id as api_key_id
         FROM api_keys ak
         JOIN users u ON ak.user_id = u.id
         WHERE ak.api_key = ? AND ak.is_active = 1 AND u.is_active = 1`, [apiKey])) as ValidatedApiKeyUser | undefined;

    if (row) {
      (await run('UPDATE api_keys SET last_used = CURRENT_TIMESTAMP WHERE id = ?', [row.api_key_id]));
    }

    return row;
  },

  /** Permanently removes an API key. Returns true if a row was deleted. */
  async deleteApiKey(userId: number, apiKeyId: number): Promise<boolean> {
    const result = (await run('DELETE FROM api_keys WHERE id = ? AND user_id = ?', [apiKeyId, userId]));
    return result.changes > 0;
  },

  /** Enables or disables an API key without deleting it. */
  async toggleApiKey(
    userId: number,
    apiKeyId: number,
    isActive: boolean
  ): Promise<boolean> {
    const result = (await run('UPDATE api_keys SET is_active = ? WHERE id = ? AND user_id = ?', [isActive ? 1 : 0, apiKeyId, userId]));
    return result.changes > 0;
  },
};
