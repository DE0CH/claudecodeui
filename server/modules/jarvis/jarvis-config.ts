/**
 * Jarvis instance settings. Everything here applies only in Jarvis mode, which has two forms:
 *   - sandbox (Jarvis 3, DE0CH/jarvis3 docs/CLAUDE-CODE.md; JARVIS_WEB_URL set): one CloudCLI process per signed-in
 *     user, started by the router (jarvis/router.mjs), with Claude Code running in each conversation's sandbox;
 *   - local (a Jarvis 4 session's `cloudcli` harness; JARVIS_LOCAL_WORKSPACE set): one process for the machine's one
 *     user, Claude Code running on this machine in that folder. Cloudflare Access in front of the session's origin is
 *     the gate (the server listens on loopback only); there are no sandboxes, shares or per-conversation folders, and
 *     a deleted conversation never touches the workspace.
 * Without either the server behaves exactly like upstream CloudCLI.
 *
 * Local mode's environment (set by the harness):
 *   JARVIS_LOCAL_WORKSPACE           Claude Code's working folder (every conversation's)
 *   JARVIS_LOCAL_UPLOADS [~/uploads] where chat attachments are saved for Claude Code
 *   JARVIS_OWNER_FIRST_NAME          the greeting's name (GET /api/jarvis/me)
 *
 * Sandbox mode's environment (set by the router):
 *   JARVIS_WEB_URL, JARVIS_CC_TOKEN  Jarvis 3's web role and the bearer token for its /internal/cc/* calls
 *   JARVIS_CC_OWNER                  the signed-in user's email: this process's only user
 *   JARVIS_JFS_ROOT [/jfs]           the JuiceFS volume (ws/<conversation id> = that conversation's /workspace)
 *   JARVIS_PRODUCT_NAME              display name of the one project, /workspace
 *   JARVIS_MODEL                     the instance's model id (the sandbox's ANTHROPIC_MODEL decides what runs)
 *   JARVIS_MODEL_LABEL               its label in the UI (e.g. "Sonnet 5.5")
 *   JARVIS_TITLE_MODEL               the model that names conversations (jarvis-title.ts; else config titleModel)
 *   JARVIS_LOCALE                    language of server-made messages (zh-* → Traditional Chinese, HK usage)
 *   JARVIS_CONFIG [/etc/jarvis/config.json]  the instance config the router reads too: product.name,
 *                                    product.locale, defaultModel and its models[] label fill whatever the
 *                                    variables above leave unset (then "YYC AI", "en", "default")
 */
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type InstanceConfig = {
  product?: { name?: string; locale?: string };
  models?: Array<{ id?: string; label?: string }>;
  defaultModel?: string;
  titleModel?: string;
};

let instanceConfig: InstanceConfig | null = null;

/** The instance config (read once; {} when missing or unreadable). */
function readInstanceConfig(): InstanceConfig {
  if (instanceConfig) return instanceConfig;
  try {
    instanceConfig = JSON.parse(readFileSync(process.env.JARVIS_CONFIG || '/etc/jarvis/config.json', 'utf8')) as InstanceConfig;
  } catch {
    instanceConfig = {};
  }
  return instanceConfig;
}

/** Tests: forget the cached instance config. */
export function resetJarvisInstanceConfig(): void {
  instanceConfig = null;
}

/** Local mode: Claude Code runs on this machine (a Jarvis 4 session), not in a sandbox. */
export function jarvisLocal(): boolean {
  return !!(process.env.JARVIS_LOCAL_WORKSPACE || '').trim();
}

export function jarvisEnabled(): boolean {
  return !!process.env.JARVIS_WEB_URL || jarvisLocal();
}

/**
 * Claude Code's working folder, and the one project the UI shows: /workspace inside a sandbox, or the local
 * workspace.
 */
export function jarvisWorkspacePath(): string {
  return jarvisLocal() ? path.resolve(process.env.JARVIS_LOCAL_WORKSPACE!.trim()) : '/workspace';
}

/** Claude Code's transcript folder name for the workspace (`~/.claude/projects/-workspace` for /workspace). */
export function jarvisProjectDirName(): string {
  return jarvisWorkspacePath().replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Where Claude Code writes a conversation's transcript, as seen from this process: the sandbox runs it with cwd
 * /workspace and ~/.claude on the user's JuiceFS folder, which is this process's ~/.claude (local mode: this
 * machine's ~/.claude).
 */
export function jarvisTranscriptPath(providerSessionId: string): string {
  return path.join(os.homedir(), '.claude', 'projects', jarvisProjectDirName(), `${providerSessionId}.jsonl`);
}

/** The process's one user (lowercased), or '' when JARVIS_CC_OWNER is unset. */
export function jarvisOwner(): string {
  return (process.env.JARVIS_CC_OWNER || '').trim().toLowerCase();
}

export function jarvisProductName(): string {
  return (process.env.JARVIS_PRODUCT_NAME || '').trim() || readInstanceConfig().product?.name?.trim() || 'YYC AI';
}

export function jarvisLocale(): string {
  return (process.env.JARVIS_LOCALE || '').trim() || readInstanceConfig().product?.locale?.trim() || 'en';
}

export function jarvisModel(): { value: string; label: string } {
  const config = readInstanceConfig();
  const value = (process.env.JARVIS_MODEL || '').trim() || config.defaultModel?.trim() || 'default';
  const label = (process.env.JARVIS_MODEL_LABEL || '').trim()
    || config.models?.find((model) => model.id === value)?.label?.trim()
    || value;
  return { value, label };
}

/** The small, fast model that names conversations (config titleModel; Claude Code's small/fast model too). */
export function jarvisTitleModel(): string {
  const config = readInstanceConfig();
  return (process.env.JARVIS_TITLE_MODEL || '').trim() || config.titleModel?.trim() || config.defaultModel?.trim() || '';
}

export function jarvisJfsRoot(): string {
  return process.env.JARVIS_JFS_ROOT || '/jfs';
}

/** Conversation ids are UUIDs (Jarvis 3 refuses anything else); nothing else may name a folder under ws/. */
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isConversationId(value: unknown): value is string {
  return typeof value === 'string' && CONVERSATION_ID.test(value);
}

/**
 * The conversation's own /workspace as seen from this pod: $JARVIS_JFS_ROOT/ws/<id>. Sandbox mode only: local
 * conversations share the machine's folders, which nothing here may copy or remove.
 */
export function conversationWorkspaceDir(conversationId: string): string {
  if (!isConversationId(conversationId)) throw new Error('not a conversation id');
  if (jarvisLocal()) throw new Error('local conversations have no folder of their own');
  return path.join(jarvisJfsRoot(), 'ws', conversationId.toLowerCase());
}

/**
 * The folder the conversation's files (what Claude sent, downloads) are read from: as this process sees it (`dir`)
 * and as Claude Code does (`claudePath`). Sandbox mode: the conversation's /workspace. Local mode: the home folder,
 * so a file Claude sends from ~/artifacts is reachable as well as one in the workspace.
 */
export function conversationFilesRoot(conversationId: string): { dir: string; claudePath: string } {
  if (jarvisLocal()) {
    const home = os.homedir();
    return { dir: home, claudePath: home };
  }
  return { dir: conversationWorkspaceDir(conversationId), claudePath: '/workspace' };
}

/**
 * Where the conversation's attachments are saved, as this process sees the folder (`dir`) and as Claude Code does
 * (`claudePath`): the conversation's /workspace/uploads, or in local mode JARVIS_LOCAL_UPLOADS (~/uploads), shared by
 * every conversation and outside the workspace (it may be a git checkout).
 */
export function conversationUploads(conversationId: string): { dir: string; claudePath: string } {
  if (jarvisLocal()) {
    const dir = path.resolve((process.env.JARVIS_LOCAL_UPLOADS || '').trim() || path.join(os.homedir(), 'uploads'));
    return { dir, claudePath: dir };
  }
  return { dir: path.join(conversationWorkspaceDir(conversationId), 'uploads'), claudePath: '/workspace/uploads' };
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

/** The greeting's first name in local mode (sandbox mode: the router answers from the Access identity). */
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
