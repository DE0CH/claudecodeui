/**
 * Typing warms a sandbox host (DE0CH/jarvis3 docs/CLAUDE-CODE.md, "Warming"):
 *
 *   POST /api/jarvis/warm {sessionId?}  → 202 {ok: true}
 *
 * The composer calls this while the user types (sessionId absent for a new chat). The server forwards it to Jarvis 3's
 * web role, `POST /internal/cc/warm {owner, conversation?}`, which tells the scaler someone may need a sandbox soon
 * (it starts a host when none has room). Nothing waits on it: the answer comes at once and a failed forward is only
 * logged. At most one forward per conversation every WARM_INTERVAL_MS, whatever the client sends.
 */
import express, { type Request, type Response } from 'express';

import { isConversationId, jarvisOwner } from '@/modules/jarvis/jarvis-config.js';

export const WARM_INTERVAL_MS = 30_000;

/** Forwards one warm signal to the web role (resolves to false on any failure; never throws). */
export async function forwardWarm(conversationId: string | null): Promise<boolean> {
  const base = process.env.JARVIS_WEB_URL;
  const token = process.env.JARVIS_CC_TOKEN;
  const owner = jarvisOwner();
  if (!base || !token || !owner) return false;
  try {
    const r = await fetch(`${base.replace(/\/$/, '')}/internal/cc/warm`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(conversationId ? { owner, conversation: conversationId } : { owner }),
      signal: AbortSignal.timeout(10_000),
    });
    await r.arrayBuffer().catch(() => undefined);
    if (!r.ok) console.warn(`[jarvis] warm: web answered ${r.status}`);
    return r.ok;
  } catch (error) {
    console.warn(`[jarvis] warm: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export function createJarvisWarmRouter(
  forward: (conversationId: string | null) => Promise<unknown> = forwardWarm,
  intervalMs = WARM_INTERVAL_MS,
  now: () => number = Date.now,
): express.Router {
  const router = express.Router();
  const last = new Map<string, number>();

  router.post('/warm', (req: Request, res: Response) => {
    const raw = (req.body as { sessionId?: unknown } | undefined)?.sessionId;
    const conversationId = isConversationId(raw) ? raw.toLowerCase() : null;
    const key = conversationId ?? '';
    const t = now();
    const prev = last.get(key);
    if (prev === undefined || t - prev >= intervalMs) {
      last.set(key, t);
      // forget old keys so the map stays small
      if (last.size > 1000) for (const [k, at] of last) if (t - at >= intervalMs) last.delete(k);
      void forward(conversationId);
    }
    res.status(202).json({ ok: true });
  });

  return router;
}
