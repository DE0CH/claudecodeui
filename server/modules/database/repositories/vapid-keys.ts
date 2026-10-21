/**
 * VAPID keys repository.
 *
 * Stores and retrieves the Web Push VAPID key pair.
 */

import { all, get, run, transaction } from '@/modules/database/connection.js';

type VapidKeyRow = {
  public_key: string;
  private_key: string;
};

type VapidKeyPair = {
  publicKey: string;
  privateKey: string;
};

export const vapidKeysDb = {
  /** Returns the latest stored VAPID key pair, or null when unset. */
  async getVapidKeys(): Promise<VapidKeyPair | null> {
    const row = (await get('SELECT public_key, private_key FROM vapid_keys ORDER BY id DESC LIMIT 1')) as Pick<VapidKeyRow, 'public_key' | 'private_key'> | undefined;

    if (!row) return null;
    return {
      publicKey: row.public_key,
      privateKey: row.private_key,
    };
  },

  /** Persists a new VAPID key pair. */
  async createVapidKeys(publicKey: string, privateKey: string): Promise<void> {
    (await run('INSERT INTO vapid_keys (public_key, private_key) VALUES (?, ?)', [publicKey, privateKey]));
  },

  /** Replaces all existing keys with a fresh pair. */
  async updateVapidKeys(publicKey: string, privateKey: string): Promise<void> {
    (await run('DELETE FROM vapid_keys'));
    await vapidKeysDb.createVapidKeys(publicKey, privateKey);
  },

  /** Deletes all VAPID key rows. */
  async deleteVapidKeys(): Promise<void> {
    (await run('DELETE FROM vapid_keys'));
  },
};

