/**
 * Staff file access to a conversation's /workspace (the contract between this server and the UI):
 *
 *   GET /api/jarvis/sessions/:sessionId/files               → { files: [{ path, size, mtime }] }  (recursive)
 *   GET /api/jarvis/sessions/:sessionId/files/raw?path=REL  → the bytes, as an attachment;
 *                                                             `inline=1` shows images and PDFs in the page
 *
 * The folder is $JARVIS_JFS_ROOT/ws/<sessionId> on the shared JuiceFS volume, written by the conversation's sandbox.
 * Read-only. Only sessions of this process's user exist here (the session row must be in its database). The sandbox
 * can put symlinks in its /workspace that point anywhere on the volume (another user's folder), so symlinks are never
 * followed: listings skip them, and a download opens the file without following a final symlink and then checks
 * where the open file really is (/proc/self/fd) before sending a byte.
 */
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';

import express, { type Request, type Response } from 'express';
import mime from 'mime-types';

import { sessionsDb } from '@/modules/database/index.js';
import { conversationWorkspaceDir, isConversationId } from '@/modules/jarvis/jarvis-config.js';

/** More files than the workspace quota (1,000) allows; a listing stops here. */
const MAX_LISTED_FILES = 5000;
const MAX_DEPTH = 32;

export type WorkspaceFile = { path: string; size: number; mtime: string };

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

async function workspaceFor(sessionId: string): Promise<string> {
  if (!isConversationId(sessionId) || !(await sessionsDb.getSessionById(sessionId))) {
    throw new FilesError(404, 'SESSION_NOT_FOUND', 'This conversation was not found.');
  }
  return conversationWorkspaceDir(sessionId);
}

/** Every regular file under `root` (symlinks and special files skipped), as POSIX paths relative to it. */
export async function listWorkspaceFiles(root: string): Promise<WorkspaceFile[]> {
  const files: WorkspaceFile[] = [];
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return files;
    throw error;
  }
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || files.length >= MAX_LISTED_FILES) return;
    // a folder swapped for a symlink after it was listed must not lead outside
    if (depth > 0 && !within(realRoot, await realpath(dir).catch(() => ''))) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && depth === 0) return;
      if (depth === 0) throw error;
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (files.length >= MAX_LISTED_FILES) return;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const childAbs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(childAbs, childRel, depth + 1);
      } else if (entry.isFile()) {
        try {
          const st = await lstat(childAbs);
          if (st.isFile()) files.push({ path: childRel, size: st.size, mtime: st.mtime.toISOString() });
        } catch {
          /* removed meanwhile */
        }
      }
    }
  };
  await walk(realRoot, '', 0);
  return files;
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
      const root = await workspaceFor(String(req.params.sessionId));
      res.setHeader('Cache-Control', 'no-store');
      res.json({ files: await listWorkspaceFiles(root) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/sessions/:sessionId/files/raw', async (req: Request, res: Response) => {
    try {
      const root = await workspaceFor(String(req.params.sessionId));
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
