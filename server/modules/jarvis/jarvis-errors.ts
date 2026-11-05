/**
 * Readable messages for what goes wrong between a chat turn and its sandbox, shown to staff in the conversation
 * instead of raw errors: getting the sandbox from Jarvis 3 (busy, not allowed, unreachable) and model calls that
 * egress or the model provider refuse (Claude Code writes those into the transcript as "API Error: <status> <body>";
 * egress answers 402 `budget_exceeded` with a ready-made message once the shared budget is used up).
 *
 * Language: jarvisLocale() (zh-* → Traditional Chinese, Hong Kong usage); English otherwise.
 */
import v8 from 'node:v8';

import { jarvisLocale } from '@/modules/jarvis/jarvis-config.js';

type Key =
  | 'unreachable'
  | 'busy'
  | 'notAllowed'
  | 'sandboxFailed'
  | 'budget'
  | 'rateLimited'
  | 'modelUnavailable'
  | 'modelRefused'
  | 'modelAccess'
  | 'modelConnection'
  | 'tooLong';

const MESSAGES: Record<'en' | 'zh', Record<Key, string>> = {
  en: {
    unreachable: 'Could not reach the computer for this conversation. Please try again in a minute.',
    busy: 'All computers are busy right now. Please try again in a few minutes.',
    notAllowed: 'This account is not allowed to use this service. Please ask your administrator.',
    sandboxFailed: 'Could not start the computer for this conversation. Please try again; if it keeps happening, tell your administrator.',
    budget: 'The usage budget for this service has been used up. Please ask your administrator.',
    rateLimited: 'Too many requests to the AI model right now. Please wait a moment and try again.',
    modelUnavailable: 'The AI model is busy or unavailable right now. Please try again in a moment.',
    modelRefused: 'The AI model refused this request',
    modelAccess: 'The AI model service refused access. Please tell your administrator.',
    modelConnection: 'Could not reach the AI model. Please try again.',
    tooLong: 'This conversation is too long to open for now. There is a known problem in the system: when a conversation gets very long, the server can\'t load it. We\'re fixing it and expect to finish within two weeks; after that this won\'t happen again. Until then, please start a new conversation to continue, or contact the admin to raise this conversation\'s limit temporarily.',
  },
  zh: {
    unreachable: '暫時連接不到這個對話的電腦，請稍後再試。',
    busy: '所有電腦正在使用中，請過幾分鐘再試。',
    notAllowed: '這個帳戶不可使用此服務，請聯絡管理員。',
    sandboxFailed: '未能啟動這個對話的電腦，請再試一次；如問題持續，請通知管理員。',
    budget: '此服務的使用預算已用完，請聯絡管理員。',
    rateLimited: '目前向 AI 模型發出的請求太多，請稍等一會再試。',
    modelUnavailable: 'AI 模型目前繁忙或暫時無法使用，請稍後再試。',
    modelRefused: 'AI 模型拒絕了這個請求',
    modelAccess: 'AI 模型服務拒絕存取，請通知管理員。',
    modelConnection: '連接不到 AI 模型，請再試一次。',
    tooLong: '這個對話太長，暫時無法開啟。系統目前有一個已知問題：對話內容太多時，伺服器無法把它載入。我們正在修復，預計兩星期內完成，之後便不會再出現這個情況。在此之前，請開始一個新對話繼續工作，或聯絡管理員，暫時提高這個對話的上限。',
  },
};

function t(key: Key): string {
  const locale = jarvisLocale().toLowerCase();
  return MESSAGES[locale.startsWith('zh') ? 'zh' : 'en'][key];
}

/**
 * Opening a conversation reads its whole transcript into this process, parses it and serialises it again: the heap
 * peaks near 4.6x the file (measured 2026-11-05 on transcripts of base64 page renders), so a file past the heap's room
 * crashes the process (V8 "Reached heap limit") in a loop on every open, and the page spins forever (2026-11-02). 5x
 * leaves a margin. Temporary until magpie serves conversations without loading them whole.
 */
export const TRANSCRIPT_HEAP_FACTOR = 5;

/** Whether a transcript of `bytes` would not fit this process's heap (the room left under --max-old-space-size). */
export function transcriptTooLongToOpen(bytes: number, heap = v8.getHeapStatistics()): boolean {
  const room = heap.heap_size_limit - heap.used_heap_size;
  return bytes * TRANSCRIPT_HEAP_FACTOR > room;
}

/** What to show instead of a conversation too long to open. */
export function conversationTooLongMessage(): string {
  return t('tooLong');
}

/** An error answer from Jarvis 3's /internal/cc/* (status 0: no answer at all). */
export class SandboxServiceError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'SandboxServiceError';
  }
}

/** What to show when getting or running the conversation's sandbox failed. */
export function readableSandboxError(error: unknown): string {
  if (error instanceof SandboxServiceError) {
    if (error.status === 0) return t('unreachable');
    if (error.status === 403) return t('notAllowed');
    if (error.status === 402) return t('budget');
    if (error.status === 429 || error.status === 503) return t('busy');
    return t('sandboxFailed');
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/the sandbox refused to start Claude Code|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ETIMEDOUT|socket hang up/i.test(message)) {
    return t('unreachable');
  }
  return t('sandboxFailed');
}

function parseJsonObject(text: string): Record<string, any> | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  try {
    const value = JSON.parse(text.slice(start));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/**
 * Claude Code's "API Error: …" text (the transcript's synthetic assistant row) as a readable message, or null when
 * the text is not such an error.
 */
export function readableClaudeApiError(text: string): string | null {
  const trimmed = text.trim();
  const match = /^API Error:\s*(?:(\d{3})\b)?\s*([\s\S]*)$/.exec(trimmed);
  if (!match) return null;
  const status = match[1] ? Number(match[1]) : 0;
  const body = parseJsonObject(match[2] ?? '');
  const inner = body?.error && typeof body.error === 'object' ? body.error : null;
  const type = typeof inner?.type === 'string' ? inner.type : '';
  // Claude Code writes either the provider's JSON body or just its error message after the status
  const plain = body ? '' : (match[2] ?? '').trim();
  const message = typeof inner?.message === 'string' ? inner.message.trim() : plain;

  // egress's budget refusal carries a ready, localized sentence (who set the limit, how much)
  if (type === 'budget_exceeded') return message || t('budget');
  if (status === 402) return message || t('budget');
  if (status === 429 || type === 'rate_limit_error') return t('rateLimited');
  if (status === 529 || status >= 500 || type === 'overloaded_error' || type === 'api_error') return t('modelUnavailable');
  if (status === 401 || status === 403) return t('modelAccess');
  if (status >= 400) return message ? `${t('modelRefused')}: ${message}` : `${t('modelRefused')}.`;
  // no status: "API Error: Connection error." / "Request timed out."
  return t('modelConnection');
}
