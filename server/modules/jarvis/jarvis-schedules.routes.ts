/**
 * Schedules (Deyao, 2026-11-06; the router's jarvis/schedules.mjs fires them): the router posts a due schedule's
 * message here, into the conversation, the same way a typed message goes in.
 *
 *   POST /api/jarvis/schedules/deliver {sessionId, text, key}   (the router only: its key in x-jarvis-schedules-key)
 *     → 200 {outcome: "sent"}            the conversation was idle: a new turn (its sandbox started as for any send)
 *     → 200 {outcome: "sent_mid_turn"}   a turn runs: written into it at once (Claude Code takes it in at its next tool
 *                                        result or when the model stops, as a message typed mid-turn)
 *     → 200 {outcome: "skipped_deleted"} the conversation is gone or in Recently deleted
 *     → 200 {outcome: "busy"}            a turn is starting (its sandbox is being made): the router tries again
 */
import { createHash, timingSafeEqual } from 'node:crypto';

import express, { type Request, type Response } from 'express';

import { sessionsDb, userDb } from '@/modules/database/index.js';
import { injectClaudeSDKMessage } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';

/** The router's key (schedules.mjs deliverKey): derived from JARVIS_CC_TOKEN, which only the router and this share. */
export function deliverKey(ccToken: string): string {
  return createHash('sha256').update(`jarvis-schedules-deliver:${ccToken}`).digest('hex');
}

/** What the routes need of the Paseo hub (paseo-hub.ts). */
export type ScheduleHub = {
  isStarted(): boolean;
  send(sessionId: string, text: string, clientMessageId: string): Promise<void>;
  appendUserRow(sessionId: string, text: string, key: string): Promise<void>;
};

export type ScheduleDeps = {
  inject?: (sessionId: string, text: string) => boolean;
  isRunning?: (sessionId: string) => boolean;
  ccToken?: string;
};

export function createJarvisSchedulesRouter(
  runtime: ProviderRuntimeGateway,
  hub: ScheduleHub,
  deps: ScheduleDeps = {},
): express.Router {
  const router = express.Router();
  const inject = deps.inject ?? injectClaudeSDKMessage;
  const isRunning = deps.isRunning ?? ((sessionId: string) => chatRunRegistry.isProcessing(sessionId));

  router.post('/schedules/deliver', async (req: Request, res: Response) => {
    const token = deps.ccToken ?? process.env.JARVIS_CC_TOKEN ?? '';
    const given = String(req.headers['x-jarvis-schedules-key'] ?? '');
    const want = token ? deliverKey(token) : '';
    if (!want || given.length !== want.length || !timingSafeEqual(Buffer.from(given), Buffer.from(want))) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const body = (req.body ?? {}) as { sessionId?: unknown; text?: unknown; key?: unknown };
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    const text = typeof body.text === 'string' ? body.text : '';
    const key = typeof body.key === 'string' ? body.key : '';
    if (!sessionId || !text.trim() || !key) {
      res.status(400).json({ error: 'sessionId, text and key are required' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    const session = await sessionsDb.getSessionById(sessionId);
    if (!session || Number(session.isArchived) === 1 || (session as { deleted_at?: string | null }).deleted_at) {
      res.json({ outcome: 'skipped_deleted' });
      return;
    }
    // Claude Code runs for this conversation (a turn, or the process held after one for its background work): the
    // message goes into it now
    if (inject(sessionId, text)) {
      await hub.appendUserRow(sessionId, text, key).catch(() => undefined);
      console.log('[jarvis] schedule delivered into the running turn', { sessionId });
      res.json({ outcome: 'sent_mid_turn' });
      return;
    }
    if (isRunning(sessionId)) {
      // a turn whose Claude Code has not started yet (its sandbox is being made): the router tries again shortly
      res.json({ outcome: 'busy' });
      return;
    }
    if (hub.isStarted()) {
      // a Paseo tab is open in this process: the user row shows at once, as for a typed message
      await hub.send(sessionId, text, `schedule-${key}`);
    } else {
      const user = await userDb.getFirstUser();
      void runDetachedChatTurn({ sessionId, userId: user ? Number(user.id) : null, content: text }, { runtime })
        .then((result) => {
          if (!result.started) console.warn(`[jarvis] schedule: the turn did not start (${result.error})`);
        })
        .catch((error) => console.error('[jarvis] schedule turn failed', error instanceof Error ? error.message : error));
    }
    console.log('[jarvis] schedule delivered as a new turn', { sessionId });
    res.json({ outcome: 'sent' });
  });

  return router;
}
