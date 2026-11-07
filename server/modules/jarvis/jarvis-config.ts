/**
 * Jarvis instance settings. Everything here applies only in Jarvis mode, which is a Jarvis 4 session's `cloudcli`
 * harness (local mode; JARVIS_LOCAL_WORKSPACE set): one process for the machine's one user, Claude Code running on
 * this machine in that folder. Cloudflare Access in front of the session's origin is the gate (the server listens on
 * loopback only); there are no sandboxes, shares or per-conversation folders, and a deleted conversation never touches
 * the workspace. Without it the server behaves exactly like upstream CloudCLI.
 *
 * Environment (set by the harness, DE0CH/jarvis4 session-image/base/harness-cloudcli.sh):
 *   JARVIS_LOCAL_WORKSPACE           Claude Code's working folder (every conversation's)
 *   JARVIS_LOCAL_UPLOADS [~/uploads] where chat attachments are saved for Claude Code
 *   JARVIS_LOCAL_PERMISSION_FILE, JARVIS_LOCAL_PERMISSION_MODE  Claude Code's permission mode (jarvisLocalPermissionMode)
 *   JARVIS_OWNER_FIRST_NAME          the greeting's name (GET /api/jarvis/me)
 *   JARVIS_CC_OWNER                  the machine's one user (its email): the user row made at start
 *   JARVIS_PRODUCT_NAME [YYC AI]     display name of the one project, the workspace
 *   JARVIS_MODEL [default]           the session's model id (every turn runs it, whatever the client names)
 *   JARVIS_MODEL_LABEL               its label in the UI (e.g. "Opus 5.5"; else the id)
 *   JARVIS_LOCALE [en]               language of server-made messages (zh-* → Traditional Chinese, HK usage)
 */
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Local mode: Claude Code runs on this machine (a Jarvis 4 session), not in a sandbox. */
export function jarvisLocal(): boolean {
  return !!(process.env.JARVIS_LOCAL_WORKSPACE || '').trim();
}

/** Jarvis mode: local mode (there is no other form). */
export function jarvisEnabled(): boolean {
  return jarvisLocal();
}

/** Claude Code's working folder, and the one project the UI shows: the local workspace (/workspace outside Jarvis mode). */
export function jarvisWorkspacePath(): string {
  return jarvisLocal() ? path.resolve(process.env.JARVIS_LOCAL_WORKSPACE!.trim()) : '/workspace';
}

/** Claude Code's transcript folder name for the workspace (`~/.claude/projects/-home-claude-repo` for /home/claude/repo). */
export function jarvisProjectDirName(): string {
  return jarvisWorkspacePath().replace(/[^a-zA-Z0-9]/g, '-');
}

/** Where Claude Code writes a conversation's transcript: this machine's ~/.claude. */
export function jarvisTranscriptPath(providerSessionId: string): string {
  return path.join(os.homedir(), '.claude', 'projects', jarvisProjectDirName(), `${providerSessionId}.jsonl`);
}

/** The process's one user (lowercased), or '' when JARVIS_CC_OWNER is unset. */
export function jarvisOwner(): string {
  return (process.env.JARVIS_CC_OWNER || '').trim().toLowerCase();
}

export function jarvisProductName(): string {
  return (process.env.JARVIS_PRODUCT_NAME || '').trim() || 'YYC AI';
}

export function jarvisLocale(): string {
  return (process.env.JARVIS_LOCALE || '').trim() || 'en';
}

export function jarvisModel(): { value: string; label: string } {
  const value = (process.env.JARVIS_MODEL || '').trim() || 'default';
  const label = (process.env.JARVIS_MODEL_LABEL || '').trim() || value;
  return { value, label };
}

/** Conversation ids are UUIDs. */
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isConversationId(value: unknown): value is string {
  return typeof value === 'string' && CONVERSATION_ID.test(value);
}

/**
 * The folder the conversation's files (what Claude sent, downloads) are read from: as this process sees it (`dir`)
 * and as Claude Code does (`claudePath`): the home folder, so a file Claude sends from ~/artifacts is reachable as
 * well as one in the workspace.
 */
export function conversationFilesRoot(_conversationId: string): { dir: string; claudePath: string } {
  const home = os.homedir();
  return { dir: home, claudePath: home };
}

/**
 * Where the conversation's attachments are saved, as this process sees the folder (`dir`) and as Claude Code does
 * (`claudePath`): JARVIS_LOCAL_UPLOADS (~/uploads), shared by every conversation and outside the workspace (it may be
 * a git checkout).
 */
export function conversationUploads(_conversationId: string): { dir: string; claudePath: string } {
  const dir = path.resolve((process.env.JARVIS_LOCAL_UPLOADS || '').trim() || path.join(os.homedir(), 'uploads'));
  return { dir, claudePath: dir };
}

/**
 * Local mode's permission mode for Claude Code, read at every turn: the Jarvis 4 session's own (its
 * JARVIS_LOCAL_PERMISSION_FILE, which `set-permission-mode` rewrites: `bypass` or `auto`), else JARVIS_LOCAL_PERMISSION_MODE,
 * else bypass (the only mode a Jarvis 4 session starts in).
 */
export function jarvisLocalPermissionMode(): 'bypassPermissions' | 'auto' {
  let mode = (process.env.JARVIS_LOCAL_PERMISSION_MODE || '').trim();
  const file = (process.env.JARVIS_LOCAL_PERMISSION_FILE || '').trim();
  if (file) {
    try {
      mode = readFileSync(file, 'utf8').trim() || mode;
    } catch {
      // no file yet: the environment's mode
    }
  }
  return mode === 'auto' ? 'auto' : 'bypassPermissions';
}

/** The greeting's first name (GET /api/jarvis/me). */
export function jarvisOwnerFirstName(): string | null {
  return (process.env.JARVIS_OWNER_FIRST_NAME || '').trim() || null;
}

/** Shown for a conversation until it has a title (and replaced by Claude Code's title when one comes). */
export function jarvisUntitledName(): string {
  return jarvisLocale().toLowerCase().startsWith('zh') ? '新對話' : 'New conversation';
}

/** A new conversation's name: the first 24 characters of its first message, or the untitled placeholder. */
export function jarvisSessionName(initialMessage: string): string {
  const chars = Array.from(initialMessage.replace(/\s+/g, ' ').trim());
  if (chars.length === 0) return jarvisUntitledName();
  return chars.length > 24 ? `${chars.slice(0, 24).join('').trimEnd()}…` : chars.join('');
}
