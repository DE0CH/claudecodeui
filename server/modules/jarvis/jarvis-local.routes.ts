/**
 * What a Jarvis 4 session's harness (DE0CH/jarvis4 session-image/base/harness-cloudcli.sh) asks this server, in local
 * mode only (jarvis-config.ts):
 *
 *   GET  /api/jarvis/main     → {sessionId, providerSessionId, title, status: idle | busy}
 *                               the session's main conversation (the newest one; sessionId null when there is none),
 *                               which the harness's status shim reports to Jarvis
 *   POST /api/jarvis/deliver {content} → 202 {sessionId, created}
 *                               a prompt from Jarvis (the first prompt, a wakeup, a watch, Deyao's resume prompt) as
 *                               a turn of the main conversation, made if there is none; the turn runs with no client
 *                               attached, and every open tab or app sees it. 409 {busy: true} while the conversation is
 *                               running a turn or background work: the harness's inbox tries again later.
 *
 * The person's own chats come in over /ws like any other; these two are for the machine itself.
 */
import express, { type Request, type Response } from 'express';

import { sessionsDb, userDb } from '@/modules/database/index.js';
import { jarvisWorkspacePath } from '@/modules/jarvis/jarvis-config.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { chatRunRegistry, runDetachedChatTurn } from '@/modules/websocket/index.js';
import type { ProviderRuntimeGateway } from '@/modules/websocket/index.js';

type MainConversation = { sessionId: string; providerSessionId: string | null; title: string | null };

/** The newest conversation that is not deleted, or null. */
export async function mainConversation(): Promise<MainConversation | null> {
  const page = await sessionsDb.getRecentSessionsPage(1, 0);
  const row = page.sessions[0];
  if (!row) return null;
  return { sessionId: row.session_id, providerSessionId: row.provider_session_id ?? null, title: row.custom_name ?? null };
}

function busy(sessionId: string, runtime: ProviderRuntimeGateway): boolean {
  return chatRunRegistry.isProcessing(sessionId) || runtime.hasBackgroundWork(sessionId);
}

export function createJarvisLocalRouter(runtime: ProviderRuntimeGateway): express.Router {
  const router = express.Router();

  router.get('/main', async (_req: Request, res: Response) => {
    const main = await mainConversation();
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      sessionId: main?.sessionId ?? null,
      providerSessionId: main?.providerSessionId ?? null,
      title: main?.title ?? null,
      status: main && busy(main.sessionId, runtime) ? 'busy' : 'idle',
    });
  });

  router.post('/deliver', async (req: Request, res: Response) => {
    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    if (!content.trim()) {
      res.status(400).json({ error: 'content is required' });
      return;
    }
    let main = await mainConversation();
    let created = false;
    if (!main) {
      const made = await sessionsService.createAppSession('claude', jarvisWorkspacePath(), content);
      main = { sessionId: made.sessionId, providerSessionId: null, title: made.sessionName };
      created = true;
    } else if (busy(main.sessionId, runtime)) {
      res.status(409).json({ busy: true, sessionId: main.sessionId });
      return;
    }
    const user = await userDb.getFirstUser();
    const sessionId = main.sessionId;
    // the turn runs on after this answer; how it went is in the conversation (and the server log)
    void runDetachedChatTurn({ sessionId, userId: user ? Number(user.id) : null, content }, { runtime })
      .then((result) => {
        if (!result.started) console.warn(`[jarvis] deliver: not started (${result.error})`);
      })
      .catch((error) => console.error('[jarvis] deliver failed', error instanceof Error ? error.message : error));
    res.status(202).json({ sessionId, created });
  });

  return router;
}
