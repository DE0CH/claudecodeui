import { all, get, run, transaction } from '@/modules/database/connection.js';

type PreferenceRow = {
  preference_key: string;
  preference_value: string;
};

/**
 * Decodes one stored preference, dropping any row whose JSON no longer parses
 * rather than failing the whole read. A single corrupted value must not cost
 * the user every other setting they have.
 */
function decodePreference(row: PreferenceRow): [string, unknown] | null {
  try {
    return [row.preference_key, JSON.parse(row.preference_value) as unknown];
  } catch {
    console.warn(`[UserPreferences] Dropping unreadable value for "${row.preference_key}"`);
    return null;
  }
}

export const userPreferencesDb = {
  /**
   * Returns every preference the user has ever set, as one object.
   *
   * The client fetches this once on start-up, so absent keys simply mean "the
   * user never changed this" and the client applies its own default.
   */
  async getPreferences(userId: number): Promise<Record<string, unknown>> {
    const rows = (await all(`SELECT preference_key, preference_value
         FROM user_preferences
         WHERE user_id = ?`, [userId])) as PreferenceRow[];

    const preferences: Record<string, unknown> = {};
    for (const row of rows) {
      const decoded = decodePreference(row);
      if (decoded) {
        preferences[decoded[0]] = decoded[1];
      }
    }

    return preferences;
  },

  /**
   * Merge-patches preferences: keys present in `updates` are written, keys
   * absent are left alone, and a key given as `undefined` is deleted.
   *
   * Runs in one transaction so a multi-key save from the settings dialog can
   * never be observed half-applied.
   */
  async savePreferences(userId: number, updates: Record<string, unknown>): Promise<void> {
    const upsertSql =
      `INSERT INTO user_preferences (user_id, preference_key, preference_value, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id, preference_key) DO UPDATE SET
         preference_value = excluded.preference_value,
         updated_at = CURRENT_TIMESTAMP`;
    const removeSql = 'DELETE FROM user_preferences WHERE user_id = ? AND preference_key = ?';

    await transaction(async () => {
      for (const [key, value] of Object.entries(updates)) {
        if (value === undefined) {
          await run(removeSql, [userId, key]);
          continue;
        }
        await run(upsertSql, [userId, key, JSON.stringify(value)]);
      }
    });
  },
};
