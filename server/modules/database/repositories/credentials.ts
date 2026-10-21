/**
 * User credentials repository.
 *
 * Manages external service tokens (GitHub, GitLab, Bitbucket, etc.)
 * stored per-user. Each credential has a type discriminator so multiple
 * credential kinds can coexist in the same table.
 */

import { all, get, run, transaction } from '@/modules/database/connection.js';
import type {
  CreateCredentialResult,
  CredentialPublicRow,
} from '@/shared/types.js';

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const credentialsDb = {
  /** Stores a new credential and returns a safe (no raw value) result. */
  async createCredential(
    userId: number,
    credentialName: string,
    credentialType: string,
    credentialValue: string,
    description: string | null = null
  ): Promise<CreateCredentialResult> {
    const result = (await run('INSERT INTO user_credentials (user_id, credential_name, credential_type, credential_value, description) VALUES (?, ?, ?, ?, ?) RETURNING id', [userId, credentialName, credentialType, credentialValue, description]));
    return {
      id: result.lastInsertRowid!,
      credentialName,
      credentialType,
    };
  },

  /**
   * Lists credentials for a user (excluding raw values).
   * Optionally filters by credential type (e.g. 'github_token').
   */
  async getCredentials(
    userId: number,
    credentialType: string | null = null
  ): Promise<CredentialPublicRow[]> {

    if (credentialType) {
      return (await all('SELECT id, credential_name, credential_type, description, created_at, is_active FROM user_credentials WHERE user_id = ? AND credential_type = ? ORDER BY created_at DESC', [userId, credentialType])) as CredentialPublicRow[];
    }

    return (await all('SELECT id, credential_name, credential_type, description, created_at, is_active FROM user_credentials WHERE user_id = ? ORDER BY created_at DESC', [userId])) as CredentialPublicRow[];
  },

  /**
   * Returns the raw credential value for the most recent active
   * credential of the given type, or null if none exists.
   */
  async getActiveCredential(
    userId: number,
    credentialType: string
  ): Promise<string | null> {
    const row = (await get('SELECT credential_value FROM user_credentials WHERE user_id = ? AND credential_type = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1', [userId, credentialType])) as { credential_value: string } | undefined;
    return row?.credential_value ?? null;
  },

  /** Permanently removes a credential. Returns true if a row was deleted. */
  async deleteCredential(userId: number, credentialId: number): Promise<boolean> {
    const result = (await run('DELETE FROM user_credentials WHERE id = ? AND user_id = ?', [credentialId, userId]));
    return result.changes > 0;
  },

  /** Enables or disables a credential without deleting it. */
  async toggleCredential(
    userId: number,
    credentialId: number,
    isActive: boolean
  ): Promise<boolean> {
    const result = (await run('UPDATE user_credentials SET is_active = ? WHERE id = ? AND user_id = ?', [isActive ? 1 : 0, credentialId, userId]));
    return result.changes > 0;
  },
};
