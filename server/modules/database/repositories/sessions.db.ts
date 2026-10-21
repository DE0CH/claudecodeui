import { all, get, run, transaction } from '@/modules/database/connection.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { normalizeProjectPath } from '@/shared/utils.js';

type SessionRow = {
  session_id: string;
  provider: string;
  provider_session_id: string | null;
  project_path: string | null;
  jsonl_path: string | null;
  custom_name: string | null;
  /** Model this session runs with; NULL until the app records one for it. */
  model: string | null;
  /** Reasoning effort this session runs with; NULL until the app records one. */
  effort: string | null;
  /** The app session this one was branched from; NULL unless it is a fork. */
  forked_from_session_id: string | null;
  isArchived: number;
  created_at: string;
  updated_at: string;
};

type RecentSessionsPage = {
  sessions: SessionRow[];
  total: number;
};

const SESSION_ROW_COLUMNS =
  'session_id, provider, provider_session_id, project_path, jsonl_path, custom_name, model, effort, forked_from_session_id, isArchived, created_at, updated_at';

const SQLITE_UTC_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function normalizeTimestamp(value?: string): string | null {
  if (!value) return null;

  // SQLite CURRENT_TIMESTAMP is stored as UTC without a timezone suffix.
  // Normalize it here so every session reader returns canonical ISO strings
  // and the sidebar never interprets fresh rows as local-time "hours old".
  const normalizedValue = SQLITE_UTC_TIMESTAMP_REGEX.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;

  const parsed = new Date(normalizedValue);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

function normalizeSessionRow<T extends SessionRow | null | undefined>(row: T): T {
  if (!row) {
    return row;
  }

  return {
    ...row,
    created_at: normalizeTimestamp(row.created_at) ?? row.created_at,
    updated_at: normalizeTimestamp(row.updated_at) ?? row.updated_at,
  };
}

function normalizeSessionRows(rows: SessionRow[]): SessionRow[] {
  return rows.map((row) => normalizeSessionRow(row) as SessionRow);
}

function normalizeProjectPathForProvider(provider: string, projectPath: string): string {
  void provider;
  return normalizeProjectPath(projectPath);
}

export const sessionsDb = {
  /**
   * Upserts one session row discovered on disk by a provider synchronizer.
   *
   * The given id is the provider-native session id. Rows are keyed by
   * `provider_session_id` so a session that was first created by the app
   * (with an app-allocated `session_id`) is updated in place once its
   * transcript shows up on disk, instead of producing a duplicate row. An
   * app-created row keeps its existing name; synchronizer names only update
   * rows that were themselves created by indexing provider storage.
   */
  async createSession(
    providerSessionId: string,
    provider: string,
    projectPath: string,
    customName?: string,
    createdAt?: string,
    updatedAt?: string,
    jsonlPath?: string | null
  ): Promise<string> {
    const createdAtValue = normalizeTimestamp(createdAt);
    const updatedAtValue = normalizeTimestamp(updatedAt);
    const normalizedProjectPath = normalizeProjectPathForProvider(provider, projectPath);

    // First, ensure the project path is recorded in the projects table,
    // since it's a foreign key in the sessions table.
    await projectsDb.createProjectPath(normalizedProjectPath);

    const existing = (await get(`SELECT session_id FROM sessions
         WHERE provider_session_id = ? AND provider = ?
         LIMIT 1`, [providerSessionId, provider])) as { session_id: string } | undefined;

    if (existing) {
      (await run(`UPDATE sessions SET
           provider = ?,
           updated_at = COALESCE(?, CURRENT_TIMESTAMP),
           project_path = ?,
           jsonl_path = ?,
           isArchived = CASE WHEN ? IS NULL OR julianday(?) > julianday(updated_at) THEN 0 ELSE isArchived END,
           custom_name = CASE
             WHEN session_id <> provider_session_id AND custom_name IS NOT NULL THEN custom_name
             ELSE COALESCE(?, custom_name)
           END
         WHERE session_id = ?`, [provider,
        updatedAtValue,
        normalizedProjectPath,
        jsonlPath ?? null,
        updatedAtValue,
        updatedAtValue,
        customName ?? null,
        existing.session_id]));

      return existing.session_id;
    }

    // Sessions created outside the app (directly via the provider CLI) are
    // keyed by the provider-native id for both columns. The ON CONFLICT path
    // covers legacy rows that predate the provider_session_id mapping.
    (await run(`INSERT INTO sessions (session_id, provider, provider_session_id, custom_name, project_path, jsonl_path, isArchived, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, COALESCE(?, CURRENT_TIMESTAMP), COALESCE(?, CURRENT_TIMESTAMP))
       ON CONFLICT(session_id) DO UPDATE SET
         provider = excluded.provider,
         provider_session_id = excluded.provider_session_id,
         updated_at = excluded.updated_at,
         project_path = excluded.project_path,
         jsonl_path = excluded.jsonl_path,
         isArchived = CASE WHEN ? IS NULL OR julianday(excluded.updated_at) > julianday(sessions.updated_at) THEN 0 ELSE sessions.isArchived END,
         custom_name = CASE
           WHEN sessions.session_id <> sessions.provider_session_id AND sessions.custom_name IS NOT NULL
             THEN sessions.custom_name
           ELSE COALESCE(excluded.custom_name, sessions.custom_name)
         END`, [providerSessionId,
      provider,
      providerSessionId,
      customName ?? null,
      normalizedProjectPath,
      jsonlPath ?? null,
      createdAtValue,
      updatedAtValue,
      updatedAtValue]));

    return providerSessionId;
  },

  /**
   * Inserts one app-allocated session row before any provider run happens.
   *
   * The session gateway uses this when the frontend starts a brand-new chat:
   * `session_id` is the stable app-facing id, while `provider_session_id`
   * stays NULL until the provider runtime announces its own id and
   * `assignProviderSessionId` records the mapping. `customName` is derived
   * from the first visible CloudCLI message by the sessions service.
   */
  async createAppSession(
    sessionId: string,
    provider: string,
    projectPath: string,
    customName?: string,
  ): Promise<string> {
    const normalizedProjectPath = normalizeProjectPathForProvider(provider, projectPath);

    await projectsDb.createProjectPath(normalizedProjectPath);

    (await run(`INSERT INTO sessions (session_id, provider, provider_session_id, custom_name, project_path, jsonl_path, isArchived, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, NULL, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, [sessionId, provider, customName ?? null, normalizedProjectPath]));

    return sessionId;
  },

  /**
   * Inserts a session that already has its provider artifact on disk.
   *
   * Unlike `createAppSession` this writes `provider_session_id` and
   * `jsonl_path` immediately, because a fork's transcript file exists before
   * the row does — and the filesystem watcher would otherwise index it as an
   * unrelated session under its own id.
   */
  async createForkedSession(input: {
    sessionId: string;
    provider: string;
    projectPath: string;
    customName: string | null;
    providerSessionId: string;
    jsonlPath: string;
    forkedFromSessionId: string;
    model: string | null;
    effort: string | null;
  }): Promise<string> {
    const normalizedProjectPath = normalizeProjectPathForProvider(input.provider, input.projectPath);

    await projectsDb.createProjectPath(normalizedProjectPath);

    // The watcher may already have created a row for the new transcript. Its
    // id is the provider-native one, which is what this row claims, so replace
    // it rather than leaving two sidebar entries for one conversation.
    await transaction(async () => {
      (await run('DELETE FROM sessions WHERE session_id = ? AND session_id <> ?', [input.providerSessionId, input.sessionId]));
      (await run(`INSERT INTO sessions (session_id, provider, provider_session_id, custom_name, project_path, jsonl_path, model, effort, forked_from_session_id, isArchived, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, [input.sessionId,
        input.provider,
        input.providerSessionId,
        input.customName,
        normalizedProjectPath,
        input.jsonlPath,
        input.model,
        input.effort,
        input.forkedFromSessionId,]));
    });

    return input.sessionId;
  },

  /**
   * Records the provider-native session id for one app-allocated session.
   *
   * If the filesystem watcher indexed the provider transcript before this
   * mapping was recorded (a duplicate row keyed by the provider id exists),
   * the duplicate is merged into the app row: its transcript path and name
   * are adopted and the duplicate row is removed. Runs in a transaction so
   * the sidebar can never observe both rows at once.
   */
  async assignProviderSessionId(sessionId: string, providerSessionId: string): Promise<void> {

    const merge = async () => await transaction(async () => {
      const duplicate = (await get(`SELECT ${SESSION_ROW_COLUMNS} FROM sessions
           WHERE (session_id = ? OR provider_session_id = ?)
             AND session_id <> ?
           LIMIT 1`, [providerSessionId, providerSessionId, sessionId])) as SessionRow | undefined;

      if (duplicate) {
        (await run('DELETE FROM sessions WHERE session_id = ?', [duplicate.session_id]));
        (await run(`UPDATE sessions SET
             provider_session_id = ?,
             jsonl_path = COALESCE(jsonl_path, ?),
             custom_name = COALESCE(custom_name, ?),
             updated_at = CURRENT_TIMESTAMP
           WHERE session_id = ?`, [providerSessionId, duplicate.jsonl_path, duplicate.custom_name, sessionId]));
        return;
      }

      (await run(`UPDATE sessions SET
           provider_session_id = ?,
           updated_at = CURRENT_TIMESTAMP
         WHERE session_id = ?`, [providerSessionId, sessionId]));
    });

    await merge();
  },

  /**
   * Moves one session onto a different provider session and transcript.
   *
   * Only editing a message on a provider that has to branch to rewind (Codex)
   * does this — an ordinary run keeps the same provider session for its whole
   * life. `assignProviderSessionId` cannot be used for it: that one keeps the
   * existing `jsonl_path` on purpose, so a session repointed with it would
   * claim the new thread while still reading the old transcript.
   *
   * The watcher may already have indexed the new transcript under its own id.
   * That row is the same conversation this one is about to become, so it is
   * replaced rather than left behind as a second sidebar entry.
   */
  async repointSessionToProviderSession(
    sessionId: string,
    input: { providerSessionId: string; jsonlPath: string },
  ): Promise<void> {

    await transaction(async () => {
      (await run('DELETE FROM sessions WHERE session_id = ? AND session_id <> ?', [input.providerSessionId, sessionId]));
      (await run(`UPDATE sessions SET
           provider_session_id = ?,
           jsonl_path = ?,
           updated_at = CURRENT_TIMESTAMP
         WHERE session_id = ?`, [input.providerSessionId, input.jsonlPath, sessionId]));
    });
  },

  /**
   * Detaches a session from its provider session so the next run starts a new
   * one.
   *
   * Used when an edit replaces the very first prompt: there is no conversation
   * left to branch from, so the session starts over instead.
   */
  async detachProviderSession(sessionId: string): Promise<void> {
    (await run(`UPDATE sessions SET
         provider_session_id = NULL,
         jsonl_path = NULL,
         updated_at = CURRENT_TIMESTAMP
       WHERE session_id = ?`, [sessionId]));
  },

  /**
   * Records that a session has left a provider session behind for good.
   *
   * The transcript stays on disk, which is deliberate — the abandoned attempt
   * is recoverable — but the indexer must not offer it back, and on a session
   * discovered from disk (whose app id *is* the provider id) rediscovering it
   * would repoint the row at the conversation the user edited away from.
   */
  async markProviderSessionSuperseded(input: {
    providerSessionId: string;
    provider: string;
    sessionId: string;
    jsonlPath: string | null;
  }): Promise<void> {
    (await run(`INSERT INTO superseded_provider_sessions (provider_session_id, provider, session_id, jsonl_path)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(provider_session_id, provider) DO UPDATE SET
         session_id = excluded.session_id,
         jsonl_path = excluded.jsonl_path,
         created_at = CURRENT_TIMESTAMP`, [input.providerSessionId, input.provider, input.sessionId, input.jsonlPath]));
  },

  async isProviderSessionSuperseded(providerSessionId: string, provider: string): Promise<boolean> {
    const row = (await get(`SELECT 1 AS found FROM superseded_provider_sessions
         WHERE provider_session_id = ? AND provider = ?
         LIMIT 1`, [providerSessionId, provider])) as { found: number } | undefined;

    return Boolean(row);
  },

  /**
   * Transcripts one session has left behind, for the caller that deletes a
   * conversation from disk.
   *
   * A conversation edited more than once has lived in more than one file, and
   * the session row only ever points at the newest.
   */
  async getSupersededTranscriptPaths(sessionId: string): Promise<string[]> {
    const rows = (await all(`SELECT jsonl_path FROM superseded_provider_sessions
         WHERE session_id = ? AND jsonl_path IS NOT NULL`, [sessionId])) as Array<{ jsonl_path: string }>;

    return rows.map((row) => row.jsonl_path);
  },

  /**
   * Forgets what a session left behind, once the session itself is gone.
   *
   * Without this the record outlives the row it was written for and keeps the
   * indexer refusing a transcript that no longer belongs to anything — a
   * conversation invisible to the app and impossible to delete through it.
   */
  async clearSupersededProviderSessions(sessionId: string): Promise<void> {
    (await run('DELETE FROM superseded_provider_sessions WHERE session_id = ?', [sessionId]));
  },

  /**
   * Records the model one session runs with.
   *
   * Called both when the user picks a model for the session and on every send,
   * so the row always reflects what the session last ran with and reopening it
   * restores that model instead of a catalog default.
   */
  async setSessionModel(sessionId: string, model: string): Promise<void> {
    (await run(`UPDATE sessions
       SET model = ?
       WHERE session_id = ?`, [model, sessionId]));
  },

  /**
   * Records the reasoning effort one session runs with.
   *
   * `default` is stored as an explicit choice rather than NULL so reopening
   * the session does not inherit a later per-provider effort preference.
   */
  async setSessionEffort(sessionId: string, effort: string): Promise<void> {
    (await run(`UPDATE sessions
       SET effort = ?
       WHERE session_id = ?`, [effort, sessionId]));
  },

  async updateSessionCustomName(sessionId: string, customName: string): Promise<void> {
    (await run(`UPDATE sessions
       SET custom_name = ?
       WHERE session_id = ?`, [customName, sessionId]));
  },

  async getSessionById(sessionId: string): Promise<SessionRow | null> {
    const row = (await get(`SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE session_id = ?
         ORDER BY updated_at DESC
         LIMIT 1`, [sessionId])) as SessionRow | undefined;

    return normalizeSessionRow(row) ?? null;
  },

  /**
   * Resolves one session row through the provider-native id.
   *
   * The filesystem watcher only knows provider ids (they come from transcript
   * file names), so it uses this lookup to translate disk artifacts back to
   * the app-facing session row before broadcasting sidebar updates.
   */
  async getSessionByProviderSessionId(providerSessionId: string): Promise<SessionRow | null> {
    const row = (await get(`SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE provider_session_id = ?
         ORDER BY updated_at DESC
         LIMIT 1`, [providerSessionId])) as SessionRow | undefined;

    return normalizeSessionRow(row) ?? null;
  },

  /**
   * Finds the newest app-created session for a project that is still waiting
   * for its provider-native id to be recorded.
   *
   * Primary intention: OpenCode can expose a new session in its shared
   * `opencode.db` before the websocket runtime reports that same provider id
   * back to our app. At that moment the sidebar already has an optimistic
   * app-owned session row, but the watcher only knows the provider-native id.
   *
   * Without this lookup, the synchronizer would insert a second row keyed by
   * the provider id, then `assignProviderSessionId()` would merge it a moment
   * later. That eventually self-heals, but on slow networks the user can still
   * briefly see two sidebar sessions for the same conversation.
   *
   * This helper lets the synchronizer claim the pending app row first, so the
   * provider id is attached before any watcher-created row exists. The result
   * is simpler than frontend dedupe and keeps the race resolved at the source.
   */
  async findLatestPendingAppSession(provider: string, projectPath: string): Promise<SessionRow | null> {
    const normalizedProjectPath = normalizeProjectPathForProvider(provider, projectPath);
    const row = (await get(`SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE provider = ?
           AND project_path = ?
           AND provider_session_id IS NULL
           AND isArchived = 0
         ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, session_id DESC
         LIMIT 1`, [provider, normalizedProjectPath])) as SessionRow | undefined;

    return normalizeSessionRow(row) ?? null;
  },

  async getAllSessions(): Promise<SessionRow[]> {
    const rows = (await all(`SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE isArchived = 0`)) as SessionRow[];

    return normalizeSessionRows(rows);
  },

  /**
   * Returns one globally ordered page of visible conversations.
   *
   * Pagination happens after archived sessions and sessions belonging to an
   * archived project have been excluded. This keeps the sidebar feed complete
   * and correctly ordered across projects instead of flattening only the
   * per-project slices already loaded by the client.
   */
  async getRecentSessionsPage(limit: number, offset: number): Promise<RecentSessionsPage> {
    const visibilityClause = `
      sessions.isArchived = 0
      AND (projects.isArchived IS NULL OR projects.isArchived = 0)
    `;
    const rows = (await all(`SELECT sessions.*
         FROM sessions
         LEFT JOIN projects ON projects.project_path = sessions.project_path
         WHERE ${visibilityClause}
         ORDER BY julianday(COALESCE(sessions.updated_at, sessions.created_at)) DESC,
                  sessions.session_id DESC
         LIMIT ? OFFSET ?`, [limit, offset])) as SessionRow[];
    const countRow = (await get(`SELECT COUNT(*) AS count
         FROM sessions
         LEFT JOIN projects ON projects.project_path = sessions.project_path
         WHERE ${visibilityClause}`)) as { count: number } | undefined;

    return {
      sessions: normalizeSessionRows(rows),
      total: Number(countRow?.count ?? 0),
    };
  },

  /**
   * Archived rows are intentionally queried separately so the caller can render
   * them in a dedicated view without reintroducing them into active session lists.
   */
  async getArchivedSessions(): Promise<SessionRow[]> {
    const rows = (await all(`SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE isArchived = 1
         ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, session_id DESC`)) as SessionRow[];

    return normalizeSessionRows(rows);
  },

  async getSessionsByProjectPath(projectPath: string): Promise<SessionRow[]> {
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const rows = (await all(`SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE project_path = ?
           AND isArchived = 0`, [normalizedProjectPath])) as SessionRow[];

    return normalizeSessionRows(rows);
  },

  /**
   * Permanent project deletion must see every session row for the path,
   * including archived ones, so their transcript files can be cleaned up.
   */
  async getSessionsByProjectPathIncludingArchived(projectPath: string): Promise<SessionRow[]> {
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const rows = (await all(`SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE project_path = ?`, [normalizedProjectPath])) as SessionRow[];

    return normalizeSessionRows(rows);
  },

  async getSessionsByProjectPathPage(projectPath: string, limit: number, offset: number): Promise<SessionRow[]> {
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const rows = (await all(`SELECT ${SESSION_ROW_COLUMNS}
         FROM sessions
         WHERE project_path = ?
           AND isArchived = 0
         ORDER BY datetime(COALESCE(updated_at, created_at)) DESC, session_id DESC
         LIMIT ? OFFSET ?`, [normalizedProjectPath, limit, offset])) as SessionRow[];

    return normalizeSessionRows(rows);
  },

  async countSessionsByProjectPath(projectPath: string): Promise<number> {
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    const row = (await get(`SELECT COUNT(*) AS count
         FROM sessions
         WHERE project_path = ?
           AND isArchived = 0`, [normalizedProjectPath])) as { count: number } | undefined;

    return Number(row?.count ?? 0);
  },

  async deleteSessionsByProjectPath(projectPath: string): Promise<void> {
    const normalizedProjectPath = normalizeProjectPath(projectPath);
    (await run(`DELETE FROM sessions WHERE project_path = ?`, [normalizedProjectPath]));
  },

  async getSessionName(sessionId: string, provider: string): Promise<string | null> {
    const row = (await get(`SELECT custom_name
         FROM sessions
         WHERE session_id = ? AND provider = ?`, [sessionId, provider])) as { custom_name: string | null } | undefined;

    return row?.custom_name ?? null;
  },

  /**
   * Soft-delete and restore both use the same flag update so callers keep the
   * row, metadata, and file path intact while toggling visibility.
   */
  async updateSessionIsArchived(sessionId: string, isArchived: boolean): Promise<void> {
    (await run(`UPDATE sessions
       SET isArchived = ?
       WHERE session_id = ?`, [isArchived ? 1 : 0, sessionId]));
  },

  async deleteSessionById(sessionId: string): Promise<boolean> {
    return (await run('DELETE FROM sessions WHERE session_id = ?', [sessionId])).changes > 0;
  },

  /** Used by the OpenCode synchronizer to remove indexed child sessions by their native id. */
  async deleteSessionByProviderSessionId(providerSessionId: string, provider: string): Promise<boolean> {
    return (await run('DELETE FROM sessions WHERE provider_session_id = ? AND provider = ?', [providerSessionId, provider])).changes > 0;
  },

  /**
   * Lists every indexed session that claims a transcript file on disk.
   *
   * Only rows with a `jsonl_path` are returned, which deliberately excludes
   * app-created sessions still waiting for their first provider write and
   * OpenCode rows (whose transcripts all live inside one shared sqlite file).
   * Used by the session synchronizer to find rows whose transcript has been
   * deleted underneath the index.
   */
  async getSessionsWithTranscriptPath(): Promise<Array<{ session_id: string; jsonl_path: string }>> {
    return (await all(`SELECT session_id, jsonl_path
         FROM sessions
         WHERE jsonl_path IS NOT NULL AND jsonl_path <> ''`)) as Array<{ session_id: string; jsonl_path: string }>;
  },
};
