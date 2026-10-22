import assert from 'node:assert/strict';

import { render, renderHook } from '@testing-library/react';
import React from 'react';
import { test } from 'vitest';

import '@/modules/i18n';
import ActivityIndicator from '@/modules/chat/composer/ActivityIndicator';
import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';
import { JARVIS_PREPARING_STATUS } from '@/shared/jarvis';
import type { NormalizedMessage, ProjectSession, ServerEvent, SessionActivity } from '@/shared/types';

/**
 * The wait for a conversation's sandbox comes as `status` frames with `jarvisSandbox` and no `text`. Deyao saw the
 * raw text "jarvis_ready…" in the composer's chip (2026-10-22): the frames then carried `text`, which a tab still
 * running the previous build shows verbatim. Now no frame has text to show, the handler never turns them into a
 * status line, never starts an indicator for a turn that already ended, and the chip never prints a jarvis_* state.
 */

const renderHandlers = (activity: Map<string, SessionActivity>) => {
  let listener: ((event: ServerEvent) => void) | null = null;
  const calls: Array<[string, unknown]> = [];
  renderHook(() => useChatRealtimeHandlers({
    isActive: true,
    subscribe: (fn) => { listener = fn; return () => { listener = null; }; },
    provider: 'claude',
    selectedSession: { id: 'viewed' } as ProjectSession,
    currentSessionId: 'viewed',
    setTokenBudget: () => {},
    pendingPermissionRequests: [],
    setPendingPermissionRequests: () => {},
    streamTimerRef: { current: null },
    accumulatedStreamRef: { current: '' },
    lastSeqRef: { current: new Map() },
    statusCheckSentAtRef: { current: new Map() },
    onSessionProcessing: (sid, a) => {
      calls.push([sid as string, a]);
      const prev = activity.get(sid as string);
      activity.set(sid as string, {
        statusText: a?.statusText !== undefined ? a.statusText : prev?.statusText ?? null,
        canInterrupt: a?.canInterrupt ?? prev?.canInterrupt ?? true,
        startedAt: prev?.startedAt ?? Date.now(),
      });
    },
    onSessionIdle: (sid) => { if (sid) activity.delete(sid); },
    onSessionBackground: (sid) => { activity.delete(sid); },
    getSessionActivity: (sid) => activity.get(sid),
    requestLatestMessages: async () => {},
    sessionStore: {
      appendRealtime: () => {},
      getMessages: () => [] as NormalizedMessage[],
      updateStreaming: () => {},
      finalizeStreaming: () => {},
    } as unknown as SessionStore,
  }));
  return { dispatch: (e: Record<string, unknown>) => listener?.({ id: 'e', provider: 'claude', timestamp: '', ...e } as unknown as ServerEvent), calls };
};

test('preparing then ready on a turn in flight: its own state, then the usual indicator', () => {
  const activity = new Map<string, SessionActivity>([['viewed', { statusText: null, canInterrupt: true, startedAt: Date.now() }]]);
  const { dispatch } = renderHandlers(activity);

  dispatch({ kind: 'status', jarvisSandbox: 'preparing', canInterrupt: true, sessionId: 'viewed' });
  assert.equal(activity.get('viewed')?.statusText, JARVIS_PREPARING_STATUS);
  assert.equal(activity.get('viewed')?.canInterrupt, true, 'Stop cancels the wait');

  dispatch({ kind: 'status', jarvisSandbox: 'ready', canInterrupt: true, sessionId: 'viewed' });
  assert.equal(activity.get('viewed')?.statusText, null);
  assert.equal(activity.get('viewed')?.canInterrupt, true);
});

test('frames for a turn that already ended (late or replayed) bring no indicator back, with or without a session id', () => {
  const activity = new Map<string, SessionActivity>();
  const { dispatch, calls } = renderHandlers(activity);
  for (const sessionId of ['viewed', undefined, '']) {
    dispatch({ kind: 'status', jarvisSandbox: 'preparing', canInterrupt: false, sessionId });
    dispatch({ kind: 'status', jarvisSandbox: 'ready', canInterrupt: true, sessionId });
  }
  assert.equal(activity.size, 0);
  assert.deepEqual(calls, []);
});

test('ready never overwrites a status line that is not the wait', () => {
  const activity = new Map<string, SessionActivity>([['viewed', { statusText: 'Compacting', canInterrupt: true, startedAt: Date.now() }]]);
  const { dispatch } = renderHandlers(activity);
  dispatch({ kind: 'status', jarvisSandbox: 'ready', canInterrupt: true, sessionId: 'viewed' });
  assert.equal(activity.get('viewed')?.statusText, 'Compacting');
});

test('the chip never prints an internal jarvis_* state', () => {
  const { container } = render(
    <ActivityIndicator activity={{ statusText: 'jarvis_ready', canInterrupt: true, startedAt: Date.now() - 10_000 }} />,
  );
  assert.doesNotMatch(container.textContent ?? '', /jarvis_/);
});
