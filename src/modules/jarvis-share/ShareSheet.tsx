import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Check, Copy, Link2, Loader2, Share, X } from 'lucide-react';

import { api } from '@/shared/api';
import { PRODUCT_NAME } from '@/shared/jarvis';
import { absoluteShareUrl, canNativeShare, copyPendingText, shareAge } from '@/modules/jarvis-share/shareLinks';

type ShareLink = { id: string; url: string; createdAt: string };

type ShareSheetProps = {
  sessionId: string;
  title?: string;
  onClose: () => void;
};

/**
 * The share sheet of a conversation (the previous YYC AI frontend's, server/modules/jarvis/jarvis-shares.ts): one
 * line on who can see it, 「複製連結」 (each tap freezes the conversation as it is now into a new link), 「分享連結」
 * where the device has a share sheet, and the conversation's live links, each with 「停止分享」.
 */
export default function ShareSheet({ sessionId, title, onClose }: ShareSheetProps) {
  const { t } = useTranslation('jarvis');
  const [links, setLinks] = useState<ShareLink[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void api.jarvis.shares(sessionId).then(async (r) => {
      if (!r.ok || !alive) return;
      const body = (await r.json()) as { shares?: ShareLink[] };
      if (alive) setLinks(Array.isArray(body.shares) ? body.shares : []);
    }).catch(() => {});
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => {
      alive = false;
      document.removeEventListener('keydown', onKey);
    };
  }, [sessionId, onClose]);

  const create = useCallback(async (): Promise<ShareLink> => {
    const r = await api.jarvis.createShare(sessionId);
    if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
    const link = (await r.json()) as ShareLink;
    setLinks((ls) => [link, ...ls.filter((l) => l.id !== link.id)]);
    return link;
  }, [sessionId]);

  const failed = (error: unknown) =>
    setNote({ ok: false, text: (error as { status?: number })?.status === 400 ? t('share.nothingToShare') : t('share.copyLinkFailed') });

  const copyNew = () => {
    setBusy(true);
    setNote(null);
    const made = create();
    copyPendingText(made.then(absoluteShareUrl))
      .then(() => setNote({ ok: true, text: t('share.linkCopied') }))
      .catch(failed)
      .finally(() => setBusy(false));
  };

  const shareNew = async () => {
    setBusy(true);
    setNote(null);
    try {
      const link = await create();
      try {
        await navigator.share({ title: title || PRODUCT_NAME, url: absoluteShareUrl(link) });
      } catch {
        // cancelled, or the tap's permission ran out while the link was made: the new link is in the list below,
        // where its own buttons share or copy it at once
      }
    } catch (error) {
      failed(error);
    } finally {
      setBusy(false);
    }
  };

  const copyExisting = (link: ShareLink) => {
    void copyPendingText(Promise.resolve(absoluteShareUrl(link))).then(() => {
      setCopiedId(link.id);
      setTimeout(() => setCopiedId((id) => (id === link.id ? null : id)), 2000);
    });
  };

  const revoke = async (id: string) => {
    const r = await api.jarvis.revokeShare(id).catch(() => null);
    if (r && (r.ok || r.status === 404)) setLinks((ls) => ls.filter((l) => l.id !== id));
  };

  const now = new Date();

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/40 backdrop-blur-sm sm:items-center"
      // a portal still bubbles React events to its parent (a sidebar row that opens its conversation on click)
      onClick={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onTouchStart={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="jarvis-share-title"
        style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
        className="w-full max-w-md rounded-t-2xl border border-border/60 bg-background p-4 shadow-2xl sm:rounded-2xl sm:p-5"
        data-testid="share-sheet"
      >
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 id="jarvis-share-title" className="text-base font-semibold text-foreground">{t('share.title')}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('share.close')}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">{t('share.lead', { product: PRODUCT_NAME })}</p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            onClick={copyNew}
            disabled={busy}
            className="flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : note?.ok ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            {busy ? t('share.creating') : note?.ok ? t('share.linkCopied') : t('share.copyLink')}
          </button>
          {canNativeShare() && (
            <button
              type="button"
              onClick={() => void shareNew()}
              disabled={busy}
              className="flex h-11 flex-1 items-center justify-center gap-2 rounded-xl border border-border px-4 text-sm font-medium text-foreground hover:bg-accent disabled:opacity-60"
            >
              <Share className="h-4 w-4" />
              {t('share.shareLink')}
            </button>
          )}
        </div>
        {note && !note.ok && (
          <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">{note.text}</p>
        )}
        {links.length > 0 && (
          <div className="mt-5">
            <h3 className="mb-1 text-xs font-medium text-muted-foreground">{t('share.sharedLinks')}</h3>
            <ul className="divide-y divide-border/50" data-testid="share-links">
              {links.map((link) => (
                <li key={link.id} className="flex items-center gap-2 py-2">
                  <Link2 className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">{shareAge(link.createdAt, now)}</span>
                  {canNativeShare() ? (
                    <button
                      type="button"
                      onClick={() => void navigator.share({ title: title || PRODUCT_NAME, url: absoluteShareUrl(link) }).catch(() => {})}
                      aria-label={t('share.shareLink')}
                      className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      <Share className="h-4 w-4" />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => copyExisting(link)}
                    className="rounded-md px-2 py-1 text-sm text-primary hover:bg-accent"
                  >
                    {copiedId === link.id ? t('share.copied') : t('share.copy')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void revoke(link.id)}
                    className="rounded-md px-2 py-1 text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
                  >
                    {t('share.stopSharing')}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
