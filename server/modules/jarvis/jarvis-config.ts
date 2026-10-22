/**
 * Jarvis 3 instance settings (DE0CH/jarvis3 docs/CLAUDE-CODE.md). Everything here applies only when JARVIS_WEB_URL
 * is set: one CloudCLI process per signed-in user, started by the router (jarvis/router.mjs), with Claude Code running
 * in each conversation's sandbox. Without JARVIS_WEB_URL the server behaves exactly like upstream CloudCLI.
 *
 * Environment (set by the router):
 *   JARVIS_WEB_URL, JARVIS_CC_TOKEN  Jarvis 3's web role and the bearer token for its /internal/cc/* calls
 *   JARVIS_CC_OWNER                  the signed-in user's email: this process's only user
 *   JARVIS_JFS_ROOT [/jfs]           the JuiceFS volume (ws/<conversation id> = that conversation's /workspace)
 *   JARVIS_PRODUCT_NAME              display name of the one project, /workspace
 *   JARVIS_MODEL                     the instance's model id (the sandbox's ANTHROPIC_MODEL decides what runs)
 *   JARVIS_MODEL_LABEL               its label in the UI (e.g. "Sonnet 5.5")
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

/** The conversation's folder inside the sandbox, and the one project the UI shows. */
export const JARVIS_WORKSPACE_PATH = '/workspace';

/** Claude Code's transcript folder name for cwd /workspace (`~/.claude/projects/-workspace`). */
export const JARVIS_PROJECT_DIR_NAME = '-workspace';

/**
 * Where Claude Code writes a conversation's transcript, as seen from this process: the sandbox runs it with cwd
 * /workspace and ~/.claude on the user's JuiceFS folder, which is this process's ~/.claude.
 */
export function jarvisTranscriptPath(providerSessionId: string): string {
  return path.join(os.homedir(), '.claude', 'projects', JARVIS_PROJECT_DIR_NAME, `${providerSessionId}.jsonl`);
}

export function jarvisEnabled(): boolean {
  return !!process.env.JARVIS_WEB_URL;
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

export function jarvisJfsRoot(): string {
  return process.env.JARVIS_JFS_ROOT || '/jfs';
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
