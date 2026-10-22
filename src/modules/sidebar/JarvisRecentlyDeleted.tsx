import { RotateCcw, Trash2 } from 'lucide-react';
import type { TFunction } from 'i18next';

import type { RecentlyDeletedSessionItem } from '@/shared/types';

type JarvisRecentlyDeletedProps = {
  sessions: RecentlyDeletedSessionItem[];
  /** All of Recently deleted, before the search filter. */
  total: number;
  isLoading: boolean;
  now: Date;
  onRestore: (sessionId: string) => void;
  onDeletePermanently: (session: RecentlyDeletedSessionItem) => void;
  t: TFunction;
};

/** Days a deleted conversation is kept (the server's RECENTLY_DELETED_DAYS). */
const RETENTION_DAYS = 30;

/** Whole days until `purgeAt` (rounded up, at most 30: "30 days" right after a delete), 0 when it is due. */
export function daysUntilPurge(purgeAt: string, now: Date): number {
  const ms = Date.parse(purgeAt) - now.getTime();
  return Number.isFinite(ms) && ms > 0 ? Math.min(RETENTION_DAYS, Math.ceil(ms / 86_400_000)) : 0;
}

/**
 * The staff build's Recently deleted (it has no archive): conversations deleted in the last 30 days, each with how
 * long it has left, Restore and Delete permanently. They are deleted for good by the server after 30 days.
 */
export default function JarvisRecentlyDeleted({
  sessions,
  total,
  isLoading,
  now,
  onRestore,
  onDeletePermanently,
  t,
}: JarvisRecentlyDeletedProps) {
  if (isLoading && total === 0) {
    return (
      <div className="px-3 py-6 text-center text-xs text-muted-foreground" aria-live="polite" aria-busy="true">
        {t('jarvis:recentlyDeleted.loading')}
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="px-3 py-8 text-center">
        <div className="mx-auto max-w-[260px] rounded-2xl border border-dashed border-border/80 bg-muted/20 px-5 py-7">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl border border-border/70 bg-background shadow-sm">
            <Trash2 className="h-[18px] w-[18px] text-muted-foreground" />
          </div>
          <h3 className="text-sm font-medium text-foreground">
            {total > 0 ? t('jarvis:recentlyDeleted.noMatch') : t('jarvis:recentlyDeleted.empty')}
          </h3>
          {total === 0 && (
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{t('jarvis:recentlyDeleted.emptyHint')}</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1 px-1 pb-2">
      <p className="px-2 pb-1 pt-1 text-[11px] leading-relaxed text-muted-foreground">{t('jarvis:recentlyDeleted.hint')}</p>
      {sessions.map((session) => {
        const days = daysUntilPurge(session.purgeAt, now);
        return (
          <div
            key={session.sessionId}
            className="flex items-center gap-1 rounded-lg px-2 py-2 hover:bg-accent/35"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-foreground">{session.sessionTitle}</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {days > 0 ? t('jarvis:recentlyDeleted.daysLeft', { count: days }) : t('jarvis:recentlyDeleted.dueNow')}
              </p>
            </div>
            <button
              type="button"
              className="flex h-9 flex-shrink-0 items-center gap-1 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-emerald-500/10 hover:text-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40 dark:hover:text-emerald-300"
              onClick={() => onRestore(session.sessionId)}
              aria-label={`${t('jarvis:recentlyDeleted.restore')}: ${session.sessionTitle}`}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span>{t('jarvis:recentlyDeleted.restore')}</span>
            </button>
            <button
              type="button"
              className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg text-muted-foreground/70 transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/40"
              onClick={() => onDeletePermanently(session)}
              title={t('jarvis:recentlyDeleted.deletePermanently')}
              aria-label={`${t('jarvis:recentlyDeleted.deletePermanently')}: ${session.sessionTitle}`}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
