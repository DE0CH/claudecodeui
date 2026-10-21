/**
 * Jarvis staff build: typing in the composer warms a sandbox host (DE0CH/jarvis3 docs/CLAUDE-CODE.md, "Warming").
 * With no host up, a conversation's first message waits about 2 minutes for one to boot; a warm signal sent while the
 * user types lets the scaler start it early. At most one signal per conversation every WARM_INTERVAL_MS (a new chat,
 * before it has an id, counts as one conversation). Fire and forget: a failed signal only means no head start.
 */
import { api } from '@/shared/api';

export const WARM_INTERVAL_MS = 30_000;

/** A throttle per conversation key (null = a new chat); `send` is called at most once per interval per key. */
export function createWarmThrottle(
  send: (sessionId: string | null) => void,
  intervalMs = WARM_INTERVAL_MS,
  now: () => number = Date.now,
): (sessionId: string | null) => void {
  const last = new Map<string, number>();
  return (sessionId) => {
    const key = sessionId || '';
    const t = now();
    const prev = last.get(key);
    if (prev !== undefined && t - prev < intervalMs) return;
    last.set(key, t);
    send(sessionId);
  };
}

/** The app's one throttle: POST /api/jarvis/warm, errors ignored. */
export const warmSandbox = createWarmThrottle((sessionId) => {
  void api.jarvis.warm(sessionId).catch(() => undefined);
});
