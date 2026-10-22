import { i18n } from '@/modules/i18n';

type ShareLink = { url: string };

/** The link as staff open it: this site's origin + /s/<id>. */
export const absoluteShareUrl = (link: ShareLink): string => new URL(link.url, window.location.origin).toString();

/** Whether this browser has a share sheet (iOS Safari, Android Chrome; not most desktops or the app's web view). */
export const canNativeShare = (): boolean => typeof navigator !== 'undefined' && typeof navigator.share === 'function';

function copyWithTextarea(text: string): void {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
}

/**
 * Copies text that is still being made. Safari allows a clipboard write only inside the tap itself, so the write
 * starts at once with a ClipboardItem whose content is the promise; elsewhere the text is written once it exists.
 */
export async function copyPendingText(text: Promise<string>): Promise<void> {
  const Item = (window as Window & { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
  if (Item && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([
        new Item({ 'text/plain': text.then((t) => new Blob([t], { type: 'text/plain' })) }),
      ]);
      return;
    } catch {
      /* fall through: the text may still be copyable another way */
    }
  }
  const value = await text;
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    copyWithTextarea(value);
  }
}

/** How long ago a link was made, in the reader's language (as the conversation list says it). */
export function shareAge(createdAt: string, now: Date): string {
  const minutes = Math.floor(Math.max(0, now.getTime() - new Date(createdAt).getTime()) / 60000);
  if (!Number.isFinite(minutes)) return '';
  if (minutes < 1) return i18n.t('jarvis:age.justNow');
  if (minutes < 60) return i18n.t('jarvis:age.minutes', { count: minutes });
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? i18n.t('jarvis:age.hours', { count: hours }) : i18n.t('jarvis:age.days', { count: Math.floor(hours / 24) });
}
