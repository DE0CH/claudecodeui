/**
 * What a conversation's lifecycle means outside this process in Jarvis mode: deleting a session lets Jarvis 3 drop
 * its sandbox (/internal/cc/release) and removes the conversation's /workspace folder ($JARVIS_JFS_ROOT/ws/<id>);
 * forking one gives the fork a copy of the files, since every conversation has its own /workspace.
 */
import { copyFile, cp, mkdir, readdir, rm, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { jarvisTurnsDb } from '@/modules/database/index.js';
import { conversationWorkspaceDir, isConversationId, jarvisEnabled } from '@/modules/jarvis/jarvis-config.js';
import { releaseSandbox } from '@/modules/jarvis/sandbox-process.js';
import { revokeSharesOf } from '@/modules/jarvis/jarvis-shares.js';

type Deps = {
  release: (conversationId: string) => Promise<void>;
  removeDir: (dir: string) => Promise<void>;
  revokeShares?: (conversationId: string) => Promise<void>;
};

/**
 * Empties the folder, then removes it. ws/ itself belongs to root on the volume (the sandbox hosts make each
 * ws/<id> and hand it to uid 1000, the sandbox user and this pod's user), so removing the emptied folder's own entry
 * can be refused; an empty folder is left then.
 */
async function removeWorkspaceDir(dir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) await rm(path.join(dir, entry), { recursive: true, force: true });
  try {
    await rmdir(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EACCES' && code !== 'EPERM' && code !== 'ENOENT') throw error;
  }
}

const defaultDeps: Deps = {
  release: releaseSandbox,
  removeDir: removeWorkspaceDir,
  revokeShares: revokeSharesOf,
};

/**
 * After a session row was deleted: its share links stop working, then its sandbox is released and its files deleted. Failures are logged, not thrown: the
 * conversation is already gone for the user, and the control plane releases idle sandboxes on its own.
 */
export async function onConversationDeleted(sessionId: string, deps: Deps = defaultDeps): Promise<void> {
  if (!jarvisEnabled() || !isConversationId(sessionId)) return;
  await deps.revokeShares?.(sessionId);
  try {
    await deps.release(sessionId);
  } catch (error) {
    console.warn('[jarvis] sandbox release failed', { sessionId, error: error instanceof Error ? error.message : error });
  }
  try {
    await deps.removeDir(conversationWorkspaceDir(sessionId));
  } catch (error) {
    console.warn('[jarvis] workspace removal failed', { sessionId, error: error instanceof Error ? error.message : error });
  }
}

/** After a fork: the new conversation starts with a copy of the source's /workspace (when it has one). */
export async function onConversationForked(sourceSessionId: string, forkSessionId: string): Promise<void> {
  if (!jarvisEnabled() || !isConversationId(sourceSessionId) || !isConversationId(forkSessionId)) return;
  const from = conversationWorkspaceDir(sourceSessionId);
  const to = conversationWorkspaceDir(forkSessionId);
  try {
    if (!(await stat(from)).isDirectory()) return;
  } catch {
    return;
  }
  try {
    // symlinks are copied as links (never followed), like the sandbox would see them
    await cp(from, to, { recursive: true, errorOnExist: false, force: false, verbatimSymlinks: true });
  } catch (error) {
    console.warn('[jarvis] workspace copy for fork failed', { sourceSessionId, forkSessionId, error: error instanceof Error ? error.message : error });
  }
}

type AttachmentDescriptor = { path: string; name?: string; mimeType?: string; size?: number };

/**
 * Non-image chat attachments as the sandbox sees them: each uploaded file is copied into the conversation's
 * /workspace/uploads/ (on JuiceFS, so the sandbox and the file panel see it), and its descriptor points there.
 * Images need no copy: they go into the prompt itself. A file that cannot be copied keeps its descriptor.
 */
export async function stageAttachmentsInWorkspace(sessionId: string, files: unknown): Promise<unknown> {
  if (!jarvisEnabled() || !isConversationId(sessionId) || !Array.isArray(files) || files.length === 0) return files;
  const uploads = path.join(conversationWorkspaceDir(sessionId), 'uploads');
  const used = new Set<string>();
  const staged: unknown[] = [];
  for (const file of files as AttachmentDescriptor[]) {
    if (!file || typeof file.path !== 'string') {
      staged.push(file);
      continue;
    }
    try {
      const original = (file.name || path.basename(file.path)).replace(/[\/\0]/g, '_').replace(/^\.+/, '_').slice(0, 200) || 'file';
      const ext = path.extname(original);
      const stem = original.slice(0, original.length - ext.length);
      let name = original;
      for (let n = 2; used.has(name) || (await stat(path.join(uploads, name)).then(() => true, () => false)); n++) {
        name = `${stem} (${n})${ext}`;
      }
      used.add(name);
      await mkdir(uploads, { recursive: true });
      await copyFile(file.path, path.join(uploads, name));
      staged.push({ ...file, path: `/workspace/uploads/${name}`, name: file.name ?? original });
    } catch (error) {
      console.warn('[jarvis] could not copy an attachment into the workspace', { sessionId, error: error instanceof Error ? error.message : error });
      staged.push(file);
    }
  }
  return staged;
}

/**
 * A turn that failed (no sandbox, the run broke): records the error, and the user's text when Claude Code never read
 * it, so both are in the history after a reload. Times: the user's message at the client's `sentAt` (else when the
 * server got it), the error strictly after it and not before now. Never throws (logged).
 */
export async function recordJarvisFailedTurn(input: {
  sessionId: string | undefined;
  userText: string | null;
  sentAt?: unknown;
  receivedAt: number;
  error: string;
}): Promise<{ userAt: string; errorAt: string }> {
  const sent = typeof input.sentAt === 'string' ? Date.parse(input.sentAt) : Number.NaN;
  const userMs = Number.isFinite(sent) ? sent : input.receivedAt;
  const errorMs = Math.max(Date.now(), userMs + 1);
  const userAt = new Date(userMs).toISOString();
  const errorAt = new Date(errorMs).toISOString();
  if (input.sessionId) {
    try {
      await jarvisTurnsDb.recordFailedTurn({
        sessionId: input.sessionId,
        userText: input.userText && input.userText.trim() ? input.userText : null,
        userAt: input.userText ? userAt : null,
        error: input.error,
        errorAt,
      });
    } catch (error) {
      console.warn('[jarvis] could not record the failed turn', { sessionId: input.sessionId, error: error instanceof Error ? error.message : error });
    }
  }
  return { userAt, errorAt };
}
