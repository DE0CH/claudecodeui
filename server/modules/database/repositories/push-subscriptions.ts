/**
 * Push subscriptions repository.
 *
 * Persists browser push subscription endpoints and keys per user.
 */

import { all, get, run, transaction } from '@/modules/database/connection.js';

type PushSubscriptionLookupRow = {
  endpoint: string;
  keys_p256dh: string;
  keys_auth: string;
};

export const pushSubscriptionsDb = {
  /** Upserts a push subscription endpoint for a user. */
  async createPushSubscription(
    userId: number,
    endpoint: string,
    keysP256dh: string,
    keysAuth: string
  ): Promise<void> {
    (await run(`INSERT INTO push_subscriptions (user_id, endpoint, keys_p256dh, keys_auth)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET
         user_id = excluded.user_id,
         keys_p256dh = excluded.keys_p256dh,
         keys_auth = excluded.keys_auth`, [userId, endpoint, keysP256dh, keysAuth]));
  },

  /** Returns all subscriptions for a user. */
  async getPushSubscriptions(userId: number): Promise<PushSubscriptionLookupRow[]> {
    return (await all('SELECT endpoint, keys_p256dh, keys_auth FROM push_subscriptions WHERE user_id = ?', [userId])) as PushSubscriptionLookupRow[];
  },

  /** Deletes one subscription by endpoint. */
  async deletePushSubscription(endpoint: string): Promise<void> {
    (await run('DELETE FROM push_subscriptions WHERE endpoint = ?', [endpoint]));
  },

  /** Deletes all subscriptions for a user. */
  async deletePushSubscriptionsForUser(userId: number): Promise<void> {
    (await run('DELETE FROM push_subscriptions WHERE user_id = ?', [userId]));
  },

  // Legacy aliases used by existing services/routes
  async saveSubscription(
    userId: number,
    endpoint: string,
    keysP256dh: string,
    keysAuth: string
  ): Promise<void> {
    await pushSubscriptionsDb.createPushSubscription(
      userId,
      endpoint,
      keysP256dh,
      keysAuth
    );
  },
  async getSubscriptions(userId: number): Promise<PushSubscriptionLookupRow[]> {
    return pushSubscriptionsDb.getPushSubscriptions(userId);
  },
  async removeSubscription(endpoint: string): Promise<void> {
    await pushSubscriptionsDb.deletePushSubscription(endpoint);
  },
  async removeAllForUser(userId: number): Promise<void> {
    await pushSubscriptionsDb.deletePushSubscriptionsForUser(userId);
  },
};

