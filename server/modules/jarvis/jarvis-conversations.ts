/**
 * What Jarvis mode adds to a conversation's turns: attachments staged where Claude Code reads them, and failed turns
 * kept in the history.
 */
import { copyFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { jarvisTurnsDb } from '@/modules/database/index.js';
import { conversationUploads, isConversationId, jarvisEnabled } from '@/modules/jarvis/jarvis-config.js';

type AttachmentDescriptor = { path: string; name?: string; mimeType?: string; size?: number };

/**
 * Non-image chat attachments as Claude Code sees them: each uploaded file is copied into ~/uploads
 * (JARVIS_LOCAL_UPLOADS), and its descriptor points there.
 * Images need no copy: they go into the prompt itself. A file that cannot be copied keeps its descriptor.
 */
export async function stageAttachmentsInWorkspace(sessionId: string, files: unknown): Promise<unknown> {
  if (!jarvisEnabled() || !isConversationId(sessionId) || !Array.isArray(files) || files.length === 0) return files;
  const { dir: uploads, claudePath } = conversationUploads(sessionId);
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
      staged.push({ ...file, path: `${claudePath}/${name}`, name: file.name ?? original });
    } catch (error) {
      console.warn('[jarvis] could not copy an attachment into the workspace', { sessionId, error: error instanceof Error ? error.message : error });
      staged.push(file);
    }
  }
  return staged;
}

/**
 * A turn that failed (the run broke): records the error, and the user's text when Claude Code never read
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
