/**
 * Jarvis mode: Recently deleted is emptied by itself. A conversation deleted RECENTLY_DELETED_DAYS (30) ago or more is
 * deleted for good (transcripts, row, sandbox, /workspace folder), as iOS Photos does. This process checks soon after
 * it starts and then every hour; the router starts a person's process once a day when that person has expired
 * conversations and no process (jarvis/router.mjs purgeWake), so nobody's deleted files outlive the period by more
 * than about a day. JARVIS_UI_PURGE=off (set by the router in the switch window, jarvis/router.mjs): no purge.
 */
import { sessionsService } from '@/modules/providers/services/sessions.service.js';

const FIRST_AFTER_MS = 30_000;
const EVERY_MS = 60 * 60_000;

/** `timing` is for tests (jarvis-purge.test.ts); the server uses the defaults. */
export function startRecentlyDeletedPurge(timing: { firstAfterMs?: number; everyMs?: number } = {}): () => void {
  if (process.env.JARVIS_UI_PURGE === 'off') return () => {};
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
