/**
 * Notification preferences repository.
 *
 * Stores per-user notification channel/event preferences as JSON.
 */

import { all, get, run, transaction } from '@/modules/database/connection.js';

type NotificationPreferences = {
  channels: {
    inApp: boolean;
    webPush: boolean;
    desktop: boolean;
    sound: boolean;
    [key: string]: boolean;
  };
  events: {
    actionRequired: boolean;
    stop: boolean;
    error: boolean;
  };
};

const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  channels: {
    inApp: false,
    webPush: false,
    desktop: false,
    sound: true,
  },
  events: {
    actionRequired: true,
    stop: true,
    error: true,
  },
};

function normalizeNotificationPreferences(value: unknown): NotificationPreferences {
  const source = value && typeof value === 'object' ? (value as Record<string, any>) : {};
  const sourceChannels = source.channels && typeof source.channels === 'object'
    ? source.channels as Record<string, unknown>
    : {};
  const extraChannels = Object.fromEntries(
    Object.entries(sourceChannels)
      .filter(([key, channelValue]) => !['inApp', 'webPush', 'desktop', 'sound'].includes(key) && typeof channelValue === 'boolean')
  ) as Record<string, boolean>;

  return {
    channels: {
      ...extraChannels,
      inApp: source.channels?.inApp === true,
      webPush: source.channels?.webPush === true,
      desktop: source.channels?.desktop === true,
      sound: source.channels?.sound !== false,
    },
    events: {
      actionRequired: source.events?.actionRequired !== false,
      stop: source.events?.stop !== false,
      error: source.events?.error !== false,
    },
  };
}

export const notificationPreferencesDb = {
  /** Returns the normalized preferences for a user, creating defaults on first read. */
  async getNotificationPreferences(userId: number): Promise<NotificationPreferences> {
    const row = (await get('SELECT preferences_json FROM user_notification_preferences WHERE user_id = ?', [userId])) as { preferences_json: string } | undefined;

    if (!row) {
      const defaults = normalizeNotificationPreferences(DEFAULT_NOTIFICATION_PREFERENCES);
      (await run('INSERT INTO user_notification_preferences (user_id, preferences_json, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)', [userId, JSON.stringify(defaults)]));
      return defaults;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(row.preferences_json);
    } catch {
      parsed = DEFAULT_NOTIFICATION_PREFERENCES;
    }
    return normalizeNotificationPreferences(parsed);
  },

  /** Upserts normalized preferences for a user and returns the stored value. */
  async updateNotificationPreferences(
    userId: number,
    preferences: unknown
  ): Promise<NotificationPreferences> {
    const normalized = normalizeNotificationPreferences(preferences);

    (await run(`INSERT INTO user_notification_preferences (user_id, preferences_json, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id) DO UPDATE SET
         preferences_json = excluded.preferences_json,
         updated_at = CURRENT_TIMESTAMP`, [userId, JSON.stringify(normalized)]));

    return normalized;
  },

  // Legacy aliases used by existing services/routes
  async getPreferences(userId: number): Promise<NotificationPreferences> {
    return notificationPreferencesDb.getNotificationPreferences(userId);
  },
  async updatePreferences(userId: number, preferences: unknown): Promise<NotificationPreferences> {
    return notificationPreferencesDb.updateNotificationPreferences(userId, preferences);
  },
};
