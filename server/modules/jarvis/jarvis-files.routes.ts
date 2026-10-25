/**
 * Staff file access to a conversation's /workspace (the contract between this server and the UI):
 *
 *   GET /api/jarvis/sessions/:sessionId/files               → { files: [{ path, size, mtime, sentAt, caption? }] }
 *                                                             the files Claude sent with SendUserFile, newest first
 *   GET /api/jarvis/sessions/:sessionId/files/raw?path=REL  → the bytes, as an attachment;
 *                                                             `inline=1` shows images and PDFs in the page
 *
 * The folder is $JARVIS_JFS_ROOT/ws/<sessionId> on the shared JuiceFS volume, written by the conversation's sandbox
 * (local mode: the home folder; jarvis-config.ts conversationFilesRoot).
 * Read-only. Only sessions of this process's user exist here (the session row must be in its database). The listing
 * holds only what Claude sent (jarvis-sent-files.ts), never the scripts and scratch files around it; a download may
 * name any file of the workspace (the chat links to files too). The sandbox can put symlinks in its /workspace that
 * point anywhere on the volume (another user's folder), so symlinks are never followed: a file is opened without
 * following a final symlink and then checked for where the open file really is (/proc/self/fd) before a byte is sent.
 */
import { constants as fsConstants } from 'node:fs';
import { open, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';

import express, { type Request, type Response } from 'express';
import mime from 'mime-types';

import { sessionsDb } from '@/modules/database/index.js';
import { conversationFilesRoot, isConversationId } from '@/modules/jarvis/jarvis-config.js';
import { readSentFiles, transcriptPathFor } from '@/modules/jarvis/jarvis-sent-files.js';

export type SentWorkspaceFile = { path: string; size: number; mtime: string; sentAt: string; caption?: string };

class FilesError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function sendError(res: Response, error: unknown): void {
  if (error instanceof FilesError) {
    res.status(error.status).json({ success: false, error: { code: error.code, message: error.message } });
    return;
  }
  console.error('[jarvis files]', error instanceof Error ? error.message : error);
  res.status(500).json({ success: false, error: { code: 'FILES_FAILED', message: 'Could not read the files.' } });
}

async function sessionFor(sessionId: string) {
  const row = isConversationId(sessionId) ? await sessionsDb.getSessionById(sessionId) : null;
  if (!row) throw new FilesError(404, 'SESSION_NOT_FOUND', 'This conversation was not found.');
  return { row, root: conversationFilesRoot(sessionId).dir };
}

/**
 * The files Claude sent in this conversation (SendUserFile, from its transcript), newest first, each with its size
 * and modification time now. A sent file that is gone, or is a symlink or not inside the workspace, is left out.
 */
export async function listSentWorkspaceFiles(root: string, transcriptPath: string): Promise<SentWorkspaceFile[]> {
  const out: SentWorkspaceFile[] = [];
  for (const sent of await readSentFiles(transcriptPath)) {
    try {
      const { handle, size, mtime } = await openWorkspaceFile(root, sent.path);
      await handle.close().catch(() => {});
      out.push({ ...sent, size, mtime: mtime.toISOString() });
    } catch (error) {
      if (!(error instanceof FilesError)) throw error;
    }
  }
  return out;
}

/** `rel` as a normalised path inside the workspace, or an error for anything that could leave it. */
export function safeRelativePath(rel: unknown): string {
  if (typeof rel !== 'string' || !rel || rel.length > 4096 || rel.includes('\0')) {
    throw new FilesError(400, 'INVALID_PATH', 'A file path is required.');
  }
  const normalized = path.posix.normalize(rel.replace(/\\/g, '/'));
  if (normalized.startsWith('/') || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new FilesError(400, 'INVALID_PATH', 'That path is outside this conversation\'s files.');
  }
  return normalized;
}

function within(base: string, target: string): boolean {
  return target === base || target.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
}

/** Opens the file for reading, refusing symlinks and anything that does not really lie inside `root`. */
export async function openWorkspaceFile(root: string, rel: string) {
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    throw new FilesError(404, 'FILE_NOT_FOUND', 'That file was not found.');
  }
  const full = path.join(realRoot, ...safeRelativePath(rel).split('/'));
  let handle;
  try {
    handle = await open(full, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ELOOP' || code === 'ENOTDIR') {
      throw new FilesError(404, 'FILE_NOT_FOUND', 'That file was not found.');
    }
    throw error;
  }
  try {
    // where the open file really is: a symlinked folder on the way would show here
    const actual = await readlink(`/proc/self/fd/${handle.fd}`).catch(() => null);
    const st = await handle.stat();
    if (!actual || !within(realRoot, actual) || !st.isFile()) {
      throw new FilesError(404, 'FILE_NOT_FOUND', 'That file was not found.');
    }
    return { handle, size: st.size, mtime: st.mtime };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

/** Shown in the page with `inline=1`; everything else (SVG and HTML included: they can run script) downloads. */
function previewable(contentType: string): boolean {
  return (contentType.startsWith('image/') && contentType !== 'image/svg+xml') || contentType === 'application/pdf';
}

function contentDisposition(type: 'inline' | 'attachment', fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export function createJarvisFilesRouter(): express.Router {
  const router = express.Router();

  router.get('/sessions/:sessionId/files', async (req: Request, res: Response) => {
    try {
      const { row, root } = await sessionFor(String(req.params.sessionId));
      res.setHeader('Cache-Control', 'no-store');
      res.json({ files: await listSentWorkspaceFiles(root, transcriptPathFor(row)) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/sessions/:sessionId/files/raw', async (req: Request, res: Response) => {
    try {
      const { root } = await sessionFor(String(req.params.sessionId));
      const rel = safeRelativePath(req.query.path);
      const { handle, size, mtime } = await openWorkspaceFile(root, rel);
      const fileName = path.posix.basename(rel);
      const contentType = mime.lookup(fileName) || 'application/octet-stream';
      const inline = req.query.inline === '1' && previewable(contentType);
      res.status(200);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', String(size));
      res.setHeader('Last-Modified', mtime.toUTCString());
      res.setHeader('Content-Disposition', contentDisposition(inline ? 'inline' : 'attachment', fileName));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
      res.setHeader('Cache-Control', 'private, no-cache');
      const stream = handle.createReadStream();
      stream.on('error', (error) => res.destroy(error));
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}
