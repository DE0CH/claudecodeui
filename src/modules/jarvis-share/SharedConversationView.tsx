import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Lock, MessageSquarePlus } from 'lucide-react';

import { api } from '@/shared/api';
import type { NormalizedMessage } from '@/shared/types';
import { SharedTranscript } from '@/modules/chat';

type SharedConversation = {
  id: string;
  title: string;
  ownerName: string;
  isOwner: boolean;
  createdAt: string;
  messages: NormalizedMessage[];
};

type SharedConversationViewProps = {
  shareId: string;
  /** The phone's menu button (opens the conversation list), drawn at the start of the header. */
  menuButton?: ReactNode;
  /** Opens the viewer's new conversation once 「繼續對話」 has made it. */
  onContinued: (sessionId: string) => void;
};

/**
 * The shared page `/s/<id>`: the conversation as it was when the link was made, read-only, with whose it is
 * (「<name> 分享的對話（只讀）」). Its one action is 「繼續對話」: a new conversation of the viewer's from it.
 */
export default function SharedConversationView({ shareId, menuButton, onContinued }: SharedConversationViewProps) {
  const { t } = useTranslation('jarvis');
  const [conv, setConv] = useState<SharedConversation | null>(null);
  const [gone, setGone] = useState<'gone' | 'failed' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    setConv(null);
    setGone(null);
    api.jarvis
      .share(shareId)
      .then(async (r) => {
        if (!alive) return;
        if (r.status === 404) return setGone('gone');
        if (!r.ok) return setGone('failed');
        const body = (await r.json()) as SharedConversation;
        if (alive) setConv(body);
      })
      .catch(() => alive && setGone('failed'));
    return () => {
      alive = false;
    };
  }, [shareId]);

  useEffect(() => {
    if (conv?.title) document.title = conv.title;
  }, [conv?.title]);

  const go = async () => {
    setBusy(true);
    setError(false);
    try {
      const r = await api.jarvis.continueShare(shareId);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const { sessionId } = (await r.json()) as { sessionId: string };
      onContinued(sessionId);
    } catch {
      setError(true);
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col" data-testid="shared-conversation">
      <header className="pwa-header-safe flex-shrink-0 border-b border-border/60 bg-background/95 px-3 py-1.5 backdrop-blur-sm sm:px-4 sm:py-2">
        <div className="flex h-9 min-w-0 items-center gap-2">
          {menuButton}
          <h1 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground sm:text-base">
            {conv?.title ?? ''}
          </h1>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pt-3 sm:pt-4">
        <div className="mx-auto w-full max-w-[54.25rem] px-4 pb-6">
          {gone ? (
            <p className="mt-16 text-center text-sm text-muted-foreground" role="status">
              {gone === 'gone' ? t('share.gone') : t('share.loadFailed')}
            </p>
          ) : !conv ? (
            <p className="mt-16 text-center text-sm text-muted-foreground" aria-busy="true">{t('share.loading')}</p>
          ) : (
            <>
              <p className="mb-4 flex items-center gap-1.5 text-sm text-muted-foreground">
                <Lock className="h-3.5 w-3.5 flex-shrink-0" />
                {t('share.sharedBy', { owner: conv.ownerName })}
              </p>
              <SharedTranscript shareId={shareId} messages={conv.messages} />
            </>
          )}
        </div>
      </div>
      {conv && (
        <div
          className="flex-shrink-0 border-t border-border/60 bg-background px-4 pt-3"
          style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
        >
          <div className="mx-auto w-full max-w-[54.25rem]">
            {error && (
              <p role="alert" className="mb-2 text-sm text-red-600 dark:text-red-400">{t('share.continueFailed')}</p>
            )}
            <button
              type="button"
              onClick={() => void go()}
              disabled={busy}
              className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            >
              <MessageSquarePlus className="h-4 w-4" />
              {t('share.continueConversation')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
