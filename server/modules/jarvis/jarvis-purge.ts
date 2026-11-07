/**
 * Jarvis mode: Recently deleted is emptied by itself. A conversation deleted RECENTLY_DELETED_DAYS (30) ago or more is
 * deleted for good (transcript and row), as iOS Photos does. This process checks soon after it starts and then every
 * hour.
 */
import { sessionsService } from '@/modules/providers/services/sessions.service.js';

const FIRST_AFTER_MS = 30_000;
const EVERY_MS = 60 * 60_000;

/** `timing` is for tests (jarvis-purge.test.ts); the server uses the defaults. */
export function startRecentlyDeletedPurge(timing: { firstAfterMs?: number; everyMs?: number } = {}): () => void {
  const { firstAfterMs = FIRST_AFTER_MS, everyMs = EVERY_MS } = timing;
  const run = () => void sessionsService.purgeExpiredDeletedSessions().catch((error) => {
    console.warn('[jarvis] purge of Recently deleted failed', { error: error instanceof Error ? error.message : String(error) });
  });
  const first = setTimeout(run, firstAfterMs);
  const every = setInterval(run, everyMs);
  first.unref?.();
  every.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
