/**
 * View as (Deyao, 2026-10-28; jarvis/router.mjs "View as", DE0CH/jarvis3 docs/CHAT.md "View as"): an admin sees the
 * app as a staff member. The router sends such a request to the PERSON's process as them, and names the admin in
 * `X-Jarvis-Viewer` and the view in `X-Jarvis-Viewer-Session` (it drops any copy a client sends, and only sets them
 * for an admin holding a valid token of their own). The Paseo bridge (server/modules/paseo/paseo-connection.ts) reads
 * them on its socket: it records every message and new conversation sent as the person in the operator page's History
 * (web `POST /internal/cc/view-as`) before sending it, and nothing is sent when that record fails; renames, deletes and
 * restores are refused. Only in sandbox mode (the router exists there; local mode has no router and no viewers).
 */
import type { IncomingHttpHeaders } from 'node:http';

import { jarvisEnabled, jarvisLocal, jarvisOwner } from '@/modules/jarvis/jarvis-config.js';

export interface Viewer {
  /** The admin's email. */
  admin: string;
  /** The view's id (one per 「View as」 click). */
  session: string;
}

export type ViewAsEvent =
  | { event: 'message'; conversation: string; chars: number }
  | { event: 'conversation'; conversation: string; chars: number };

const one = (raw: string | string[] | undefined): string => (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '';

/** The admin viewing as this process's user, from the router's headers; null for the person's own requests. */
export function viewerOf(headers: IncomingHttpHeaders): Viewer | null {
  if (!jarvisEnabled() || jarvisLocal()) return null;
  const admin = one(headers['x-jarvis-viewer']).toLowerCase();
  if (!admin || !admin.includes('@')) return null;
  return { admin, session: one(headers['x-jarvis-viewer-session']).slice(0, 64) };
}

/** Records one send as the person (web `POST /internal/cc/view-as`); throws when it was not recorded. */
export async function recordViewAs(viewer: Viewer, event: ViewAsEvent): Promise<void> {
  const base = process.env.JARVIS_WEB_URL;
  const token = process.env.JARVIS_CC_TOKEN;
  if (!base || !token) throw new Error('JARVIS_WEB_URL / JARVIS_CC_TOKEN are not set');
  const r = await fetch(`${base.replace(/\/$/, '')}/internal/cc/view-as`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...event, admin: viewer.admin, user: jarvisOwner(), session: viewer.session }),
    signal: AbortSignal.timeout(5000),
  });
  await r.arrayBuffer().catch(() => undefined);
  if (!r.ok) throw new Error(`web answered ${r.status}`);
}

/** The bridge's answer to a change it refuses while viewing as someone (the admin reads it; English). */
export const VIEW_AS_READ_ONLY = 'Read-only while viewing as someone else.';
export const VIEW_AS_NOT_RECORDED = 'Not sent: the view-as log in Ops could not be written. Try again.';
