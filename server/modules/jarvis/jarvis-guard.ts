/**
 * Jarvis mode request gate, mounted on /api before every route.
 *
 * 1. Every request must come through the router as this process's user: the router sets `X-Jarvis-User` to the
 *    Access-verified email (and strips any client-sent copy), so a missing or different value is refused.
 * 2. Routes that make no sense for staff on a hosted instance answer 404 with a short reason: local sign-in and
 *    registration, provider model/skill/MCP editing (the sandbox's managed settings decide those), creating, cloning,
 *    renaming, deleting, archiving or restoring projects (there is one, /workspace), the archive (a delete goes to
 *    Recently deleted instead), API keys and stored credentials, git config, and
 *    self-update. Chat, sessions, search, drafts, preferences, notifications and scheduled messages stay.
 */
import type { IncomingHttpHeaders } from 'node:http';

import type { NextFunction, Request, Response } from 'express';

import { jarvisEnabled, jarvisOwner } from '@/modules/jarvis/jarvis-config.js';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | '*';

/** [method, path under /api] pairs that do not exist in Jarvis mode. */
const UNAVAILABLE: Array<[Method, RegExp]> = [
  ['POST', /^\/auth\/(register|login)\/?$/],
  // models: the instance has one model; listing and the per-session read/record routes stay (fixed in the service)
  ['*', /^\/providers\/[^/]+\/models\/custom-only\/?$/],
  ['POST', /^\/providers\/[^/]+\/models\/?$/],
  ['PATCH', /^\/providers\/[^/]+\/models\/[^/]+\/?$/],
  ['DELETE', /^\/providers\/[^/]+\/models\/[^/]+\/?$/],
  // skills and MCP servers are the sandbox's managed settings
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
];

/** True when the route is not offered in Jarvis mode (exported for tests). */
export function isUnavailableInJarvis(method: string, apiPath: string): boolean {
  const m = method.toUpperCase();
  return UNAVAILABLE.some(([want, pattern]) => (want === '*' || want === m) && pattern.test(apiPath));
}

/** True when the request names this process's user in X-Jarvis-User (set only by the router). */
export function jarvisCallerMatches(headers: IncomingHttpHeaders): boolean {
  const owner = jarvisOwner();
  const raw = headers['x-jarvis-user'];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim().toLowerCase();
  return !!owner && value === owner;
}

export function jarvisApiGuard(req: Request, res: Response, next: NextFunction): void {
  if (!jarvisEnabled()) {
    next();
    return;
  }
  if (!jarvisCallerMatches(req.headers)) {
    res.status(403).json({
      success: false,
      error: { code: 'JARVIS_WRONG_USER', message: 'This request did not come through the sign-in for this account.' },
    });
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
