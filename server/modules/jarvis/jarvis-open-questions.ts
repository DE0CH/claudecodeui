/**
 * Questions that wait for the person without holding a sandbox (DE0CH/YYC yyc-ai/refactor/DECISIONS.md 17, Deyao,
 * 2026-11-05).
 *
 * When a turn waits only on an AskUserQuestion or ExitPlanMode (no tool running, no background work), the Claude runtime
 * (claude-runtime.provider.js, "park") ends the turn for the client and stops Claude Code, so the sandbox goes idle and
 * is released like any idle one; the question is kept here, in this long-lived process and in its database
 * (jarvis_open_questions), and stays on the person's screen. When the person answers, a new turn resumes the
 * conversation and gives Claude Code the answer as the next message, in the words the tool's own result would have
 * used (`answerContinuation`): a resumed Claude Code (2.1.304, checked 2026-11-05) does not take a permission answer
 * or a tool_result for a tool call made before it restarted, it closes that call itself as interrupted.
 *
 * A question is closed by its answer's turn (`answered`), by a message the person sends instead of answering
 * (`superseded`), or by the long safety limit (`expired`, ASK_SAFETY_LIMIT_MS after it was asked).
 */
import { EventEmitter } from 'node:events';

import { jarvisOpenQuestionsDb, type JarvisOpenQuestionRow } from '@/modules/database/index.js';

/**
 * How long a question may wait for its answer: a safety limit, not a timeout anyone is meant to meet (DECISIONS 17).
 * The same limit closes a question a live Claude Code is still waiting on (a turn that could not let its sandbox go).
 */
export const ASK_SAFETY_LIMIT_MS = parseInt(process.env.CLAUDE_INTERACTIVE_TOOL_TIMEOUT_MS ?? '', 10) || 7 * 24 * 60 * 60 * 1000;

/** The longest delay setTimeout takes; a longer wait is armed again when this one fires. */
const MAX_TIMER_MS = 2_147_483_647;

export type OpenQuestionAnswer = { allow: boolean; updatedInput?: unknown; message?: string };

export type OpenQuestion = {
  requestId: string;
  /** The app session id (the conversation). */
  sessionId: string;
  providerSessionId: string | null;
  toolName: string;
  toolUseId: string | null;
  input: unknown;
  /** The client options the answer's turn runs with (model, effort, permission mode, …). */
  runOptions: Record<string, unknown>;
  /** ISO time the question was asked. */
  askedAt: string;
  answer: OpenQuestionAnswer | null;
};

export type OpenQuestionCloseReason = 'answered' | 'superseded' | 'expired';

export type OpenQuestionClosed = { sessionId: string; requestId: string; reason: OpenQuestionCloseReason };

type Store = {
  insert(row: JarvisOpenQuestionRow): Promise<void>;
  setAnswer(requestId: string, answer: string): Promise<void>;
  remove(requestId: string): Promise<void>;
  listAll(): Promise<JarvisOpenQuestionRow[]>;
};

function parseJson(text: string | null, fallback: unknown): unknown {
  if (text == null) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function toRow(q: OpenQuestion): JarvisOpenQuestionRow {
  return {
    request_id: q.requestId,
    session_id: q.sessionId,
    provider_session_id: q.providerSessionId,
    tool_name: q.toolName,
    tool_use_id: q.toolUseId,
    input: JSON.stringify(q.input ?? null),
    run_options: JSON.stringify(q.runOptions ?? {}),
    asked_at: q.askedAt,
    answer: q.answer ? JSON.stringify(q.answer) : null,
  };
}

function fromRow(row: JarvisOpenQuestionRow): OpenQuestion {
  const runOptions = parseJson(row.run_options, {});
  return {
    requestId: row.request_id,
    sessionId: row.session_id,
    providerSessionId: row.provider_session_id,
    toolName: row.tool_name,
    toolUseId: row.tool_use_id,
    input: parseJson(row.input, null),
    runOptions: runOptions && typeof runOptions === 'object' ? (runOptions as Record<string, unknown>) : {},
    askedAt: row.asked_at,
    answer: (parseJson(row.answer, null) as OpenQuestionAnswer | null) ?? null,
  };
}

/**
 * The open questions of this process (one per person), in memory and written through to the database. Emits `closed`
 * (OpenQuestionClosed) when a question goes; the Paseo hub withdraws its card on `superseded` and `expired`.
 */
export class OpenQuestions extends EventEmitter {
  readonly #byId = new Map<string, OpenQuestion>();
  readonly #timers = new Map<string, NodeJS.Timeout>();
  readonly #store: Store;
  readonly #limitMs: () => number;
  readonly #now: () => number;

  constructor({ store = jarvisOpenQuestionsDb, limitMs = () => ASK_SAFETY_LIMIT_MS, now = () => Date.now() }: { store?: Store; limitMs?: () => number; now?: () => number } = {}) {
    super();
    this.#store = store;
    this.#limitMs = limitMs;
    this.#now = now;
  }

  /** Reads the questions a previous run of this process left open (startup). */
  async load(): Promise<void> {
    const rows = await this.#store.listAll();
    for (const row of rows) {
      if (this.#byId.has(row.request_id)) continue;
      const q = fromRow(row);
      this.#byId.set(q.requestId, q);
      this.#arm(q);
    }
  }

  /** Keeps a question the runtime parked. The database write is awaited; a failed write is logged (the question still waits in memory). */
  async add(q: OpenQuestion): Promise<void> {
    this.#byId.set(q.requestId, q);
    this.#arm(q);
    await this.#store.insert(toRow(q)).catch((error: unknown) => {
      console.error('[open questions] could not store a question', { requestId: q.requestId, error: error instanceof Error ? error.message : error });
    });
  }

  get(requestId: string): OpenQuestion | undefined {
    return this.#byId.get(requestId);
  }

  forSession(sessionId: string): OpenQuestion[] {
    return [...this.#byId.values()].filter((q) => q.sessionId === sessionId);
  }

  list(): OpenQuestion[] {
    return [...this.#byId.values()];
  }

  /** Records the person's answer; null when no such question waits. */
  answer(requestId: string, answer: OpenQuestionAnswer): OpenQuestion | null {
    const q = this.#byId.get(requestId);
    if (!q) return null;
    q.answer = { allow: Boolean(answer.allow), ...(answer.updatedInput !== undefined ? { updatedInput: answer.updatedInput } : {}), ...(answer.message !== undefined ? { message: answer.message } : {}) };
    void this.#store.setAnswer(requestId, JSON.stringify(q.answer)).catch((error: unknown) => {
      console.error('[open questions] could not store an answer', { requestId, error: error instanceof Error ? error.message : error });
    });
    return q;
  }

  /** Whether the conversation has questions and every one of them is answered. */
  allAnswered(sessionId: string): boolean {
    const qs = this.forSession(sessionId);
    return qs.length > 0 && qs.every((q) => q.answer !== null);
  }

  /** Closes one question. */
  close(requestId: string, reason: OpenQuestionCloseReason): OpenQuestion | null {
    const q = this.#byId.get(requestId);
    if (!q) return null;
    this.#byId.delete(requestId);
    const timer = this.#timers.get(requestId);
    if (timer) clearTimeout(timer);
    this.#timers.delete(requestId);
    void this.#store.remove(requestId).catch((error: unknown) => {
      console.error('[open questions] could not remove a question', { requestId, error: error instanceof Error ? error.message : error });
    });
    this.emit('closed', { sessionId: q.sessionId, requestId, reason } satisfies OpenQuestionClosed);
    return q;
  }

  /** Takes every question of the conversation (a new turn starts): answered ones close as `answered`, the rest as `superseded`. */
  take(sessionId: string): OpenQuestion[] {
    const qs = this.forSession(sessionId);
    for (const q of qs) this.close(q.requestId, q.answer ? 'answered' : 'superseded');
    return qs;
  }

  #arm(q: OpenQuestion): void {
    const existing = this.#timers.get(q.requestId);
    if (existing) clearTimeout(existing);
    const askedAt = Date.parse(q.askedAt);
    const due = (Number.isFinite(askedAt) ? askedAt : this.#now()) + this.#limitMs();
    const wait = Math.max(0, due - this.#now());
    const timer = setTimeout(() => {
      this.#timers.delete(q.requestId);
      if (!this.#byId.has(q.requestId)) return;
      if (due > this.#now()) this.#arm(q);
      else this.close(q.requestId, 'expired');
    }, Math.min(wait, MAX_TIMER_MS));
    timer.unref?.();
    this.#timers.set(q.requestId, timer);
  }

  /** Tests: forget everything (nothing is removed from the database). */
  resetForTests(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    this.#byId.clear();
    this.removeAllListeners();
  }
}

export const openQuestions = new OpenQuestions();
openQuestions.setMaxListeners(0);

/** "7 days", "2 hours", "30 minutes": the safety limit in the words of its timeout answer. */
export function formatAskDuration(ms: number): string {
  const units: Array<[number, string]> = [[86_400_000, 'day'], [3_600_000, 'hour']];
  for (const [size, name] of units) {
    if (ms >= size && ms % size === 0) {
      const n = ms / size;
      return `${n} ${name}${n === 1 ? '' : 's'}`;
    }
  }
  const minutes = Math.round((ms / 60000) * 100) / 100;
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

type AskQuestion = { question?: unknown; options?: unknown; multiSelect?: unknown; kind?: unknown; min?: unknown; max?: unknown };

function answerText(value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => String(v)).join(', ');
  return value == null ? '' : String(value);
}

/** Whether every answer is one of its question's offered options (Claude Code then says "Your questions have been answered"). */
function answersAreOptions(questions: AskQuestion[], answers: Record<string, unknown>, annotations: Record<string, { notes?: unknown }> | null): boolean {
  return questions.every((q) => {
    const text = typeof q.question === 'string' ? q.question : '';
    if (annotations?.[text]?.notes) return false;
    const value = answers[text];
    if (q.kind === 'text' || q.kind === 'number') {
      if (value === undefined || value === '') return true;
      if (q.kind === 'text' || typeof value !== 'string') return false;
      const n = Number(value.trim());
      return /^-?\d+(\.\d+)?$/.test(value.trim()) && Number.isFinite(n)
        && (typeof q.min !== 'number' || n >= q.min) && (typeof q.max !== 'number' || n <= q.max);
    }
    const labels = new Set((Array.isArray(q.options) ? q.options : []).map((o) => (o && typeof o === 'object' ? (o as { label?: unknown }).label : o)));
    if (Array.isArray(value)) return q.multiSelect === true && value.length > 0 && value.every((v) => labels.has(v));
    if (!value) return true;
    if (labels.has(value)) return true;
    if (q.multiSelect !== true || typeof value !== 'string') return false;
    const parts = value.split(', ');
    return parts.length >= 1 && parts.every((p) => labels.has(p));
  });
}

/**
 * What Claude Code 2.1.304's AskUserQuestion returns for an answer (its mapToolResultToToolResultBlockParam, read from
 * the binary on 2026-11-05: `"<question>"="<answer>"` pairs joined by ", ", with notes and previews).
 */
export function askUserQuestionResult(input: unknown): string {
  const record = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const questions = (Array.isArray(record.questions) ? record.questions : []) as AskQuestion[];
  const answers = record.answers && typeof record.answers === 'object' ? (record.answers as Record<string, unknown>) : {};
  const annotations = record.annotations && typeof record.annotations === 'object'
    ? (record.annotations as Record<string, { notes?: unknown; preview?: unknown }>)
    : null;
  const pairs = questions
    .map((q) => {
      const text = typeof q.question === 'string' ? q.question : '';
      const value = answerText(answers[text]);
      const notes = annotations?.[text];
      if (!value && !notes?.notes) return null;
      const parts = [value ? `"${text}"="${value}"` : `"${text}"=(no option selected)`];
      if (notes?.preview) parts.push(`selected preview: ${String(notes.preview)}`);
      if (notes?.notes) parts.push(`notes: ${String(notes.notes)}`);
      return parts.join(' ');
    })
    .filter((p): p is string => p !== null)
    .join(', ');
  const response = typeof record.response === 'string' ? record.response.trim() : '';
  if (response) return `The user responded: ${response}`;
  if (!pairs) return 'The user did not answer the questions.';
  return answersAreOptions(questions, answers, annotations)
    ? `Your questions have been answered: ${pairs}. You can now continue with these answers in mind.`
    : `The user answered: ${pairs}. Read the answers carefully — they may request clarification, changes, or that you not proceed — and follow what they actually say.`;
}

/** What ExitPlanMode returns when the plan is approved (Claude Code 2.1.304, without the plan file's path). */
function exitPlanModeResult(input: unknown): string {
  const plan = input && typeof input === 'object' && typeof (input as { plan?: unknown }).plan === 'string' ? (input as { plan: string }).plan : '';
  if (!plan.trim()) return 'User has approved exiting plan mode. You can now proceed.';
  return `User has approved your plan. You can now start coding. Start with updating your todo list if applicable\n\n## Approved Plan:\n${plan}`;
}

/** The answer to one question as the tool's result would have said it. */
export function questionResult(q: Pick<OpenQuestion, 'toolName' | 'input' | 'answer'>): string {
  const answer = q.answer;
  if (!answer) return '';
  if (!answer.allow) return answer.message?.trim() || 'User denied tool use';
  const input = answer.updatedInput ?? q.input;
  if (q.toolName === 'AskUserQuestion') return askUserQuestionResult(input);
  if (q.toolName === 'ExitPlanMode') return exitPlanModeResult(input);
  return answer.message?.trim() || 'The user allowed this tool call.';
}

/** The message that carries the answers of a conversation's questions to the resumed Claude Code (and to the person). */
export function answerContinuation(questions: Array<Pick<OpenQuestion, 'toolName' | 'input' | 'answer'>>): string {
  return questions.map((q) => questionResult(q)).filter((text) => text.trim()).join('\n\n');
}
