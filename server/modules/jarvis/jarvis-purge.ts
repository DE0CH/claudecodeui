/**
 * Jarvis mode: Recently deleted is emptied by itself. A conversation deleted RECENTLY_DELETED_DAYS (30) ago or more is
 * deleted for good (transcripts, row, sandbox, /workspace folder), as iOS Photos does. This process checks soon after
 * it starts and then every hour; the router starts a person's process once a day when that person has expired
 * conversations and no process (jarvis/router.mjs purgeWake), so nobody's deleted files outlive the period by more
 * than about a day.
 */
import { sessionsService } from '@/modules/providers/services/sessions.service.js';

const FIRST_AFTER_MS = 30_000;
const EVERY_MS = 60 * 60_000;

export function startRecentlyDeletedPurge(): () => void {
  const run = () => void sessionsService.purgeExpiredDeletedSessions().catch((error) => {
    console.warn('[jarvis] purge of Recently deleted failed', { error: error instanceof Error ? error.message : String(error) });
  });
  const first = setTimeout(run, FIRST_AFTER_MS);
  const every = setInterval(run, EVERY_MS);
  first.unref?.();
  every.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
