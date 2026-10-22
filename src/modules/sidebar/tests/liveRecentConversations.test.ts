import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { beforeEach, test, vi } from 'vitest';

import type { Project, ProjectSession, RecentConversationListItem } from '@/shared/types';
import { mergeLiveRecentConversations } from '@/modules/sidebar/utils/liveRecentConversations';

/**
 * The Conversations list (the staff build's only sidebar list) is fetched once when its tab opens. A conversation
 * started afterwards, in this tab or another, reaches `projects` (optimistic registration, `session_upserted`), and
 * one archived or deleted reaches `removedSessionIds`; the list must follow both without fetching again.
 */

const recentConversationsResponse = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    recentConversations: () => recentConversationsResponse(),
    archivedProjects: () => Promise.resolve({ ok: true, json: async () => ({ data: { projects: [] } }) }),
    getArchivedSessions: () => Promise.resolve({ ok: true, json: async () => ({ data: { sessions: [] } }) }),
  },
}));

const { useSidebarController } = await import('@/modules/sidebar/hooks/useSidebarController');

const t = ((key: string) => key) as unknown as TFunction;

const row = (sessionId: string, sessionTitle: string, lastActivity: string): RecentConversationListItem => ({
  sessionId,
  provider: 'claude',
  projectId: 'project-1',
  projectDisplayName: 'workspace',
  sessionTitle,
  lastActivity,
});

const session = (id: string, summary: string, lastActivity: string): ProjectSession => ({
  id,
  summary,
  lastActivity,
  __provider: 'claude',
});

const project = (sessions: ProjectSession[]): Project => ({
  projectId: 'project-1',
  path: '/workspace',
  fullPath: '/workspace',
  displayName: 'workspace',
  isStarred: false,
  sessions,
  sessionMeta: { hasMore: false, total: sessions.length },
});

const OLD = '2026-10-22T01:00:00.000Z';
const OLDER = '2026-10-22T00:00:00.000Z';
const NOW = '2026-10-22T02:00:00.000Z';
const none = new Set<string>();

test('a session the list lacks is added on top, with its title', () => {
  const rows = [row('s-1', 'One', OLD), row('s-2', 'Two', OLDER)];
  const result = mergeLiveRecentConversations(rows, [project([session('new', '測試對話', NOW)])], none, false);
  assert.deepEqual(result.conversations.map((r) => [r.sessionId, r.sessionTitle]), [['new', '測試對話'], ['s-1', 'One'], ['s-2', 'Two']]);
  assert.equal(result.added, 1);
});

test('with more pages to load, an older session is left for its page', () => {
  const rows = [row('s-1', 'One', OLD)];
  const result = mergeLiveRecentConversations(rows, [project([session('older', 'Older', OLDER)])], none, true);
  assert.equal(result.conversations, rows);
  assert.equal(result.added, 0);
});

test('newer activity moves a row up; a removed session is dropped', () => {
  const rows = [row('s-1', 'One', OLD), row('s-2', 'Two', OLDER), row('s-3', 'Three', OLDER)];
  const result = mergeLiveRecentConversations(rows, [project([session('s-2', 'Two', NOW)])], new Set(['s-3']), false);
  assert.deepEqual(result.conversations.map((r) => r.sessionId), ['s-2', 's-1']);
  assert.equal(result.removed, 1);
});

test('nothing new returns the same rows', () => {
  const rows = [row('s-1', 'One', OLD), row('s-2', 'Two', OLDER)];
  const result = mergeLiveRecentConversations(rows, [project([session('s-1', 'One', OLD), session('s-2', '', OLDER)])], none, false);
  assert.equal(result.conversations, rows);
});

const renderController = (initial: { projects: Project[]; removed: ReadonlySet<string> }) => renderHook(
  ({ projects, removed }: { projects: Project[]; removed: ReadonlySet<string> }) => useSidebarController({
    projects,
    selectedProject: null,
    selectedSession: null,
    activeSessions: new Set<string>(),
    backgroundSessionIds: new Set<string>(),
    isLoading: false,
    isMobile: false,
    t,
    onRefresh: vi.fn(),
    onProjectSelect: vi.fn(),
    onSessionSelect: vi.fn(),
    removedSessionIds: removed,
    setCurrentProject: vi.fn(),
    setSidebarVisible: vi.fn(),
    sidebarVisible: true,
  }),
  { initialProps: initial },
);

beforeEach(() => {
  localStorage.clear();
  recentConversationsResponse.mockReset();
  recentConversationsResponse.mockResolvedValue({
    ok: true,
    json: async () => ({ data: { conversations: [row('s-1', 'One', OLD)], total: 1, hasMore: false } }),
  });
});

test('the Conversations list shows a conversation started after it loaded, and drops a removed one, without a refetch', async () => {
  const { result, rerender } = renderController({ projects: [project([session('s-1', 'One', OLD)])], removed: none });
  act(() => {
    result.current.setSearchMode('conversations');
  });
  await waitFor(() => assert.equal(result.current.recentConversations.length, 1));

  rerender({ projects: [project([session('new', '新的對話', NOW), session('s-1', 'One', OLD)])], removed: none });
  assert.deepEqual(result.current.recentConversations.map((r) => r.sessionId), ['new', 's-1']);
  assert.equal(result.current.recentConversationsTotal, 2);

  rerender({ projects: [project([session('new', '新的對話', NOW)])], removed: new Set(['s-1']) });
  assert.deepEqual(result.current.recentConversations.map((r) => r.sessionId), ['new']);
  assert.equal(result.current.recentConversationsTotal, 1);
  assert.equal(recentConversationsResponse.mock.calls.length, 1);
});
