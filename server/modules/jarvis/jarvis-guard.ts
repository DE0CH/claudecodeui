/**
 * Jarvis mode request gate, mounted on /api before every route. The server listens on loopback and Cloudflare Access
 * in front of the session's origin is the gate, so every request is the machine's one user's.
 *
 * Routes that make no sense in Jarvis mode answer 404 with a short reason: local sign-in and registration, provider
 * model/skill/MCP editing, creating, cloning, renaming, deleting, archiving or restoring projects (there is one, the
 * workspace), the archive (a delete goes to Recently deleted instead), API keys and stored credentials, git config,
 * self-update, and share links. Chat, sessions, search, drafts, preferences, notifications and scheduled messages stay.
 */
import type { NextFunction, Request, Response } from 'express';

import { jarvisEnabled } from '@/modules/jarvis/jarvis-config.js';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | '*';

/** [method, path under /api] pairs that do not exist in Jarvis mode. */
const UNAVAILABLE: Array<[Method, RegExp]> = [
  ['POST', /^\/auth\/(register|login)\/?$/],
  // models: the instance has one model; listing and the per-session read/record routes stay (fixed in the service)
  ['*', /^\/providers\/[^/]+\/models\/custom-only\/?$/],
  ['POST', /^\/providers\/[^/]+\/models\/?$/],
  ['PATCH', /^\/providers\/[^/]+\/models\/[^/]+\/?$/],
  ['DELETE', /^\/providers\/[^/]+\/models\/[^/]+\/?$/],
  // skills and MCP servers are the machine's own settings
  ['POST', /^\/providers\/[^/]+\/skills\/?$/],
  ['DELETE', /^\/providers\/[^/]+\/skills\/[^/]+\/?$/],
  ['*', /^\/providers\/[^/]+\/mcp(\/.*)?$/],
  ['*', /^\/providers\/mcp(\/.*)?$/],
  // the one project
  ['POST', /^\/projects\/create-project\/?$/],
  ['*', /^\/projects\/clone(-progress)?\/?$/],
  ['PUT', /^\/projects\/[^/]+\/rename\/?$/],
  ['DELETE', /^\/projects\/[^/]+\/?$/],
  // no archive (Deyao, 2026-10-22): a delete goes to Recently deleted (GET /providers/sessions/deleted)
  ['GET', /^\/projects\/archived\/?$/],
  ['POST', /^\/projects\/[^/]+\/restore\/?$/],
  ['GET', /^\/providers\/sessions\/archived\/?$/],
  ['*', /^\/projects\/[^/]+\/taskmaster\/?$/],
  // host-level settings
  ['*', /^\/settings\/(api-keys|credentials)(\/.*)?$/],
  ['*', /^\/user\/git-config\/?$/],
  ['*', /^\/system\/update\/?$/],
  // no share links
  ['*', /^\/jarvis\/sessions\/[^/]+\/shares(\/.*)?$/],
  ['*', /^\/jarvis\/shares(\/.*)?$/],
];

/** True when the route is not offered in Jarvis mode (exported for tests). */
export function isUnavailableInJarvis(method: string, apiPath: string): boolean {
  const m = method.toUpperCase();
  return UNAVAILABLE.some(([want, pattern]) => (want === '*' || want === m) && pattern.test(apiPath));
}

export function jarvisApiGuard(req: Request, res: Response, next: NextFunction): void {
  if (!jarvisEnabled()) {
    next();
    return;
  }
  if (isUnavailableInJarvis(req.method, req.path)) {
    res.status(404).json({
      success: false,
      error: { code: 'NOT_AVAILABLE', message: 'This feature is not available here.' },
    });
    return;
  }
  next();
}
