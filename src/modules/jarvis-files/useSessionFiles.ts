import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';

/** One file of a conversation's workspace, as `GET /api/jarvis/sessions/:id/files` lists it. */
export type SessionFile = {
  /** Relative to the conversation's /workspace, with forward slashes. */
  path: string;
  size: number;
  /** Last modification, ISO 8601 or epoch milliseconds. */
  mtime: string | number;
};

type State = {
  files: SessionFile[];
  isLoading: boolean;
  error: string | null;
};

const byNewestFirst = (a: SessionFile, b: SessionFile) =>
  new Date(b.mtime).getTime() - new Date(a.mtime).getTime() || a.path.localeCompare(b.path);

/**
 * Used by JarvisFilesPanel: lists the open conversation's files while the panel is open, and
 * again on `reload`. A conversation that has not started yet (no session id) has no files.
 */
export function useSessionFiles(sessionId: string | null, enabled: boolean) {
  const [state, setState] = useState<State>({ files: [], isLoading: false, error: null });
  const requestRef = useRef<AbortController | null>(null);

  const reload = useCallback(async () => {
    requestRef.current?.abort();
    if (!sessionId || !enabled) {
      setState({ files: [], isLoading: false, error: null });
      return;
    }
    const controller = new AbortController();
    requestRef.current = controller;
    setState((previous) => ({ ...previous, isLoading: true, error: null }));
    try {
      const response = await api.jarvis.sessionFiles(sessionId, { signal: controller.signal });
      if (response.status === 404) {
        // No workspace yet: the conversation has not written anything.
        setState({ files: [], isLoading: false, error: null });
        return;
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = (await response.json()) as { files?: SessionFile[] };
      const files = Array.isArray(payload.files) ? [...payload.files].sort(byNewestFirst) : [];
      if (!controller.signal.aborted) {
        setState({ files, isLoading: false, error: null });
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      setState({ files: [], isLoading: false, error: error instanceof Error ? error.message : String(error) });
    }
  }, [enabled, sessionId]);

  useEffect(() => {
    void reload();
    return () => requestRef.current?.abort();
  }, [reload]);

  return { ...state, reload };
}
