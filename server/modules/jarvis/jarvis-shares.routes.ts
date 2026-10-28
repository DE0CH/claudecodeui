/**
 * Shared conversations over HTTP (jarvis-shares.ts says what a share is):
 *
 *   POST   /api/jarvis/sessions/:sessionId/shares     (owner)  → 201 {id, url, createdAt}; 400 NOTHING_TO_SHARE
 *   GET    /api/jarvis/sessions/:sessionId/shares     (owner)  → {shares: [{id, url, createdAt}]} its live links
 *   DELETE /api/jarvis/shares/:id                     (owner)  → 204; anyone else's or a revoked id → 404
 *   GET    /api/jarvis/shares/:id                     (staff)  → {id, title, ownerName, isOwner, createdAt, timeline}
 *                                                               (timeline: the chat view's rows, paseo-timeline.ts)
 *   GET    /api/jarvis/shares/:id/files/raw?path=REL[&sent=TOOL_USE_ID]  (staff)  → the bytes of a file the page may
 *                                                     hand out (with `sent`: as that send kept it)
 *                                                                (`inline=1` shows images and PDFs)
 *   POST   /api/jarvis/shares/:id/continue            (staff)  → 201 {sessionId}: a new conversation of the caller's
 *
 * "Owner" = this process's user owns the conversation (its row is in this process's schema) or the share; "staff" =
 * anyone signed in (the router lets only the instance's users in). Revoked shares and shares of deleted
 * conversations answer 404 everywhere.
 */
import path from 'node:path';

import express, { type Request, type Response } from 'express';
import mime from 'mime-types';

import { openSentFile, safeRelativePath } from '@/modules/jarvis/jarvis-files.routes.js';
import { continueShare, createShare, listShares, revokeShare, shareFileRoot, ShareError, shareView } from '@/modules/jarvis/jarvis-shares.js';

function sendError(res: Response, error: unknown): void {
  const status = (error as { status?: unknown })?.status;
  const code = (error as { code?: unknown })?.code;
  if (error instanceof ShareError || (typeof status === 'number' && typeof code === 'string' && status < 500)) {
    res.status(status as number).json({ success: false, error: { code, message: (error as Error).message } });
    return;
  }
  console.error('[jarvis shares]', error instanceof Error ? error.message : error);
  res.status(500).json({ success: false, error: { code: 'SHARE_FAILED', message: 'Sharing failed.' } });
}

function previewable(contentType: string): boolean {
  return (contentType.startsWith('image/') && contentType !== 'image/svg+xml') || contentType === 'application/pdf';
}

function contentDisposition(type: 'inline' | 'attachment', fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export function createJarvisSharesRouter(): express.Router {
  const router = express.Router();

  router.post('/sessions/:sessionId/shares', async (req: Request, res: Response) => {
    try {
      res.status(201).json(await createShare(String(req.params.sessionId)));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/sessions/:sessionId/shares', async (req: Request, res: Response) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ shares: await listShares(String(req.params.sessionId)) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.delete('/shares/:id', async (req: Request, res: Response) => {
    try {
      await revokeShare(String(req.params.id));
      res.status(204).end();
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/shares/:id', async (req: Request, res: Response) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await shareView(String(req.params.id)));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/shares/:id/files/raw', async (req: Request, res: Response) => {
    try {
      const rel = safeRelativePath(req.query.path);
      const { root, sentDir } = await shareFileRoot(String(req.params.id), rel);
      const { handle, size, mtime } = await openSentFile(root, sentDir, rel, req.query.sent);
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

  router.post('/shares/:id/continue', async (req: Request, res: Response) => {
    try {
      res.status(201).json(await continueShare(String(req.params.id)));
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}
