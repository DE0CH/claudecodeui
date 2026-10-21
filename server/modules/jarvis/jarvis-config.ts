/**
 * Jarvis 3 instance settings (DE0CH/jarvis3 docs/CLAUDE-CODE.md). Everything here applies only when JARVIS_WEB_URL
 * is set: one CloudCLI process per signed-in user, started by the router (jarvis/router.mjs), with Claude Code running
 * in each conversation's sandbox. Without JARVIS_WEB_URL the server behaves exactly like upstream CloudCLI.
 *
 * Environment (set by the router):
 *   JARVIS_WEB_URL, JARVIS_CC_TOKEN  Jarvis 3's web role and the bearer token for its /internal/cc/* calls
 *   JARVIS_CC_OWNER                  the signed-in user's email: this process's only user
 *   JARVIS_JFS_ROOT [/jfs]           the JuiceFS volume (ws/<conversation id> = that conversation's /workspace)
 *   JARVIS_PRODUCT_NAME [YYC AI]     display name of the one project, /workspace
 *   JARVIS_MODEL [default]           the instance's model id (the sandbox's ANTHROPIC_MODEL decides what runs)
 *   JARVIS_MODEL_LABEL               its label in the UI (e.g. "Sonnet 5.5"; default: JARVIS_MODEL)
 *   JARVIS_WATCH_INTERVAL_MS [5000]  how often the transcript folder is polled (JuiceFS has no inotify for writes
 *                                    made on other hosts)
 */
import path from 'node:path';

/** The conversation's folder inside the sandbox, and the one project the UI shows. */
export const JARVIS_WORKSPACE_PATH = '/workspace';

/** Claude Code's transcript folder name for cwd /workspace (`~/.claude/projects/-workspace`). */
export const JARVIS_PROJECT_DIR_NAME = '-workspace';

export function jarvisEnabled(): boolean {
  return !!process.env.JARVIS_WEB_URL;
}

/** The process's one user (lowercased), or '' when JARVIS_CC_OWNER is unset. */
export function jarvisOwner(): string {
  return (process.env.JARVIS_CC_OWNER || '').trim().toLowerCase();
}

export function jarvisProductName(): string {
  return (process.env.JARVIS_PRODUCT_NAME || '').trim() || 'YYC AI';
}

export function jarvisModel(): { value: string; label: string } {
  const value = (process.env.JARVIS_MODEL || '').trim() || 'default';
  const label = (process.env.JARVIS_MODEL_LABEL || '').trim() || value;
  return { value, label };
}

export function jarvisJfsRoot(): string {
  return process.env.JARVIS_JFS_ROOT || '/jfs';
}

export function jarvisWatchIntervalMs(): number {
  const n = Number(process.env.JARVIS_WATCH_INTERVAL_MS);
  return Number.isFinite(n) && n >= 500 ? n : 5000;
}

/** Conversation ids are UUIDs (Jarvis 3 refuses anything else); nothing else may name a folder under ws/. */
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isConversationId(value: unknown): value is string {
  return typeof value === 'string' && CONVERSATION_ID.test(value);
}

/** The conversation's /workspace as seen from this pod: $JARVIS_JFS_ROOT/ws/<id>. */
export function conversationWorkspaceDir(conversationId: string): string {
  if (!isConversationId(conversationId)) throw new Error('not a conversation id');
  return path.join(jarvisJfsRoot(), 'ws', conversationId.toLowerCase());
}
