import type { Project, ProjectSession, RecentConversationListItem } from '@/shared/types';

/**
 * The Conversations list as it should look now: the rows `/api/providers/sessions/recent` returned, kept in step
 * with what this tab has learnt since without fetching again.
 *
 * The list is fetched once when its tab opens, but `projects` keeps changing: a conversation started here is added
 * to it the moment its first message is sent (`registerOptimisticSession`), and every `session_upserted` delta
 * (a conversation started, renamed or restored in another tab, a transcript the server re-indexed) lands there too.
 * So:
 * - a session in `projects` that the list lacks is added (when the list is complete, or the session is at least as
 *   recent as the oldest loaded row, so a page not loaded yet is not pulled in out of order);
 * - a row takes its session's current title (trimmed, as the server derives `sessionTitle`; an empty summary never
 *   replaces the title the row has) and newer activity time;
 * - sessions archived or deleted (`removedSessionIds`, from this tab or a `session_removed` delta) are dropped;
 * - rows are ordered by last activity, newest first, as the server orders them.
 *
 * Returns the same array, and `added`/`removed` 0, when nothing changed, so unrelated `projects` updates do not
 * re-render the list.
 */
export function mergeLiveRecentConversations(
  rows: RecentConversationListItem[],
  projects: Project[],
  removedSessionIds: ReadonlySet<string>,
  hasMore: boolean,
): { conversations: RecentConversationListItem[]; added: number; removed: number } {
  const known = new Map<string, { session: ProjectSession; project: Project }>();
  for (const project of projects) {
    for (const session of project.sessions ?? []) {
      if (session?.id) known.set(String(session.id), { session, project });
    }
  }

  let changed = false;
  let removed = 0;
  const seen = new Set<string>();
  const next: RecentConversationListItem[] = [];
  for (const row of rows) {
    seen.add(row.sessionId);
    if (removedSessionIds.has(row.sessionId)) {
      changed = true;
      removed += 1;
      continue;
    }
    const entry = known.get(row.sessionId);
    if (!entry) {
      next.push(row);
      continue;
    }
    const summary = typeof entry.session.summary === 'string' ? entry.session.summary.trim() : '';
    const activity = sessionActivity(entry.session);
    const title = summary && summary !== row.sessionTitle ? summary : row.sessionTitle;
    const lastActivity = activity && time(activity) > time(row.lastActivity) ? activity : row.lastActivity;
    if (title === row.sessionTitle && lastActivity === row.lastActivity) {
      next.push(row);
      continue;
    }
    changed = true;
    next.push({ ...row, sessionTitle: title, lastActivity });
  }

  const oldestLoaded = rows.length > 0 ? Math.min(...rows.map((row) => time(row.lastActivity))) : 0;
  let added = 0;
  for (const [sessionId, { session, project }] of known) {
    if (seen.has(sessionId) || removedSessionIds.has(sessionId)) continue;
    const activity = sessionActivity(session);
    if (hasMore && time(activity) < oldestLoaded) continue;
    const summary = typeof session.summary === 'string' ? session.summary.trim() : '';
    next.push({
      sessionId,
      provider: session.__provider ?? 'claude',
      projectId: project.projectId ?? null,
      projectDisplayName: project.displayName ?? '',
      sessionTitle: summary || sessionId,
      lastActivity: activity,
    });
    added += 1;
    changed = true;
  }

  if (!changed) {
    if (isNewestFirst(rows)) return { conversations: rows, added: 0, removed: 0 };
  }
  // Stable: rows with the same time keep their order.
  const ordered = next
    .map((row, index) => ({ row, index }))
    .sort((a, b) => time(b.row.lastActivity) - time(a.row.lastActivity) || a.index - b.index)
    .map(({ row }) => row);
  if (!changed && ordered.every((row, index) => row === rows[index])) {
    return { conversations: rows, added: 0, removed: 0 };
  }
  return { conversations: ordered, added, removed };
}

function sessionActivity(session: ProjectSession): string | null {
  const value = session.lastActivity ?? session.updated_at ?? session.created_at ?? session.createdAt ?? null;
  return typeof value === 'string' && value ? value : null;
}

function time(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isNewestFirst(rows: RecentConversationListItem[]): boolean {
  for (let index = 1; index < rows.length; index += 1) {
    if (time(rows[index].lastActivity) > time(rows[index - 1].lastActivity)) return false;
  }
  return true;
}
