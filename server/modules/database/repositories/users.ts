/**
 * User repository.
 *
 * Provides typed CRUD operations for the `users` table.
 * This is a single-user system, but the schema supports multiple
 * users for forward compatibility.
 */

import { all, get, run, transaction } from '@/modules/database/connection.js';

type UserRow = {
  id: number;
  username: string;
  password_hash: string;
  created_at: string;
  last_login: string | null;
  is_active: number;
  git_name: string | null;
  git_email: string | null;
  has_completed_onboarding: number;
};

type UserPublicRow = Pick<UserRow, 'id' | 'username' | 'created_at' | 'last_login'>;

type UserGitConfig = {
  git_name: string | null;
  git_email: string | null;
};

type CreateUserResult = {
  id: number | bigint;
  username: string;
};

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const userDb = {
  /** Returns true if at least one user exists in the database. */
  async hasUsers(): Promise<boolean> {
    const row = (await get('SELECT COUNT(*) as count FROM users')) as {
      count: number;
    };
    return row.count > 0;
  },

  /** Inserts a new user and returns the created ID + username. */
  async createUser(username: string, passwordHash: string): Promise<CreateUserResult> {
    const result = (await run('INSERT INTO users (username, password_hash) VALUES (?, ?) RETURNING id', [username, passwordHash]));
    return { id: result.lastInsertRowid!, username };
  },

  /**
   * Looks up an active user by username.
   * Returns the full row (including password hash) for auth verification.
   */
  async getUserByUsername(username: string): Promise<UserRow | undefined> {
    return (await get('SELECT * FROM users WHERE username = ? AND is_active = 1', [username])) as UserRow | undefined;
  },

  /** Updates the last_login timestamp. Non-fatal — logs but does not throw. */
  async updateLastLogin(userId: number): Promise<void> {
    try {
      (await run('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?', [userId]));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Failed to update last login', { error: message });
    }
  },

  /** Returns public user fields by ID (no password hash). */
  async getUserById(userId: number): Promise<UserPublicRow | undefined> {
    return (await get('SELECT id, username, created_at, last_login FROM users WHERE id = ? AND is_active = 1', [userId])) as UserPublicRow | undefined;
  },

  /** Returns the first active user. Used for single-user mode lookups. */
  async getFirstUser(): Promise<UserPublicRow | undefined> {
    return (await get('SELECT id, username, created_at, last_login FROM users WHERE is_active = 1 LIMIT 1')) as UserPublicRow | undefined;
  },

  /** Stores the user's preferred git name and email. */
  async updateGitConfig(
    userId: number,
    gitName: string,
    gitEmail: string
  ): Promise<void> {
    (await run('UPDATE users SET git_name = ?, git_email = ? WHERE id = ?', [gitName,
      gitEmail,
      userId]));
  },

  /** Retrieves the user's git identity (name + email). */
  async getGitConfig(userId: number): Promise<UserGitConfig | undefined> {
    return (await get('SELECT git_name, git_email FROM users WHERE id = ?', [userId])) as UserGitConfig | undefined;
  },

  /** Marks onboarding as complete for the given user. */
  async completeOnboarding(userId: number): Promise<void> {
    (await run('UPDATE users SET has_completed_onboarding = 1 WHERE id = ?', [userId]));
  },

  /** Returns true if the user has finished the onboarding flow. */
  async hasCompletedOnboarding(userId: number): Promise<boolean> {
    const row = (await get('SELECT has_completed_onboarding FROM users WHERE id = ?', [userId])) as { has_completed_onboarding: number } | undefined;
    return row?.has_completed_onboarding === 1;
  },
};
