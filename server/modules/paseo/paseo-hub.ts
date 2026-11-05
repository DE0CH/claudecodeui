/**
 * The Paseo UI's view of this process's conversations (DE0CH/claudecodeui docs/paseo-ui.md). One hub per CloudCLI
 * process, shared by every open Paseo tab:
 *   - it is a CloudCLI chat client itself: a socket-shaped object handed to handleChatConnection, so runs, replay,
 *     aborts and the session-list broadcasts reach it exactly as they reach the CloudCLI web UI and the iOS app;
 *   - it keeps each conversation's Paseo timeline (paseo-timeline.ts), built from history on first use and extended
 *     by the live events it receives;
 *   - it tells the Paseo connections (paseo-connection.ts) what changed: timeline rows, run status, list changes.
 * Nothing here stores state of its own: the session rows, transcripts and runs stay CloudCLI's.
 */
import { NotAfterError, pastNotAfter } from './not-after.js';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ensureImageAssetsDir } from '@/modules/assets/index.js';
import { sessionsDb } from '@/modules/database/index.js';
import { jarvisModel, jarvisProductName, jarvisWorkspacePath, sentPathToWorkspaceRelative } from '@/modules/jarvis/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import { chatRunRegistry, handleChatConnection } from '@/modules/websocket/index.js';
import type { AuthenticatedWebSocketRequest, NormalizedMessage } from '@/shared/types.js';

import { SessionTimeline, type PaseoTimelineRow } from './paseo-timeline.js';

type ChatDependencies = Parameters<typeof handleChatConnection>[2];

export type SessionRowLite = {
  session_id: string;
  provider_session_id: string | null;
  custom_name: string | null;
  created_at: string;
  updated_at: string;
  /** Set while the conversation is in Recently deleted (Paseo shows it as archived). */
  deleted_at?: string | null;
  isArchived?: number;
};

export type HubEvent =
  | { type: 'timeline'; sessionId: string; rows: PaseoTimelineRow[]; epoch: string; turnId?: string }
  | { type: 'turn'; sessionId: string; phase: 'started' | 'completed' | 'failed' | 'canceled'; turnId: string; error?: string }
  | { type: 'session'; sessionId: string; removed?: boolean }
  | { type: 'preparing'; sessionId: string; state: 'preparing' | 'ready' }
  | { type: 'question'; sessionId: string; request: PaseoQuestionRequest }
  | { type: 'question_resolved'; sessionId: string; requestId: string; resolution: PaseoPermissionResponse };

/**
 * Claude Code's AskUserQuestion, waiting for the person's answer (CloudCLI's `permission_request` for a tool that
 * needs interaction; Paseo's AgentPermissionRequest of kind "question", drawn as its question card).
 */
export type PaseoQuestionRequest = {
  id: string;
  provider: 'claude';
  name: string;
  kind: 'question';
  input: Record<string, unknown>;
};

/** Paseo's AgentPermissionResponse (packages/protocol agent-types.ts). */
export type PaseoPermissionResponse =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message?: string };

const QUESTION_TOOL = 'AskUserQuestion';

/**
 * Paseo's card keys each answer by the question's `header`; Claude Code reads them by the question's text. Keys that
 * already are a question's text stay as they are.
 */
export function answersByQuestionText(input: Record<string, unknown>): Record<string, unknown> {
  const answers = input.answers;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return input;
  const questions = Array.isArray(input.questions) ? (input.questions as Array<Record<string, unknown>>) : [];
  const texts = new Set(questions.map((q) => q?.question).filter((q): q is string => typeof q === 'string'));
  const byHeader = new Map<string, string>();
  for (const q of questions) {
    if (typeof q?.header === 'string' && typeof q?.question === 'string' && !byHeader.has(q.header)) byHeader.set(q.header, q.question);
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(answers as Record<string, unknown>)) {
    out[texts.has(key) ? key : byHeader.get(key) ?? key] = value;
  }
  return { ...input, answers: out };
}

export const PROJECT_ID = 'prj_conversations';

export function workspaceIdFor(sessionId: string): string {
  return `wks_${sessionId}`;
}

export function sessionIdFromWorkspace(workspaceId: string): string | null {
  return workspaceId.startsWith('wks_') ? workspaceId.slice(4) : null;
}

/** What the Paseo app attaches to a message: uploaded files (already in CloudCLI's assets) and inline images. */
export type PaseoAttachments = {
  images?: Array<{ data: string; mimeType: string }>;
  attachments?: Array<Record<string, unknown>>;
};

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** CloudCLI's attachment descriptors (chat.send options.attachments) for what the app sent. */
async function toCloudCliAttachments(input: PaseoAttachments): Promise<Array<{ path: string; name: string; mimeType: string; size: number }>> {
  const out: Array<{ path: string; name: string; mimeType: string; size: number }> = [];
  for (const attachment of input.attachments ?? []) {
    if (attachment.type !== 'uploaded_file' || typeof attachment.path !== 'string') continue;
    out.push({
      path: attachment.path,
      name: String(attachment.fileName ?? path.basename(attachment.path)),
      mimeType: String(attachment.mimeType ?? 'application/octet-stream'),
      size: Number(attachment.size ?? 0),
    });
  }
  const images = input.images ?? [];
  if (images.length > 0) {
    const dir = await ensureImageAssetsDir();
    for (const [index, image] of images.entries()) {
      const extension = IMAGE_EXTENSIONS[image.mimeType];
      if (!extension) continue;
      const bytes = Buffer.from(image.data, 'base64');
      const name = `image-${index + 1}.${extension}`;
      const file = path.join(dir, `${Date.now()}-${randomUUID()}-${name}`);
      await writeFile(file, bytes);
      out.push({ path: file, name, mimeType: image.mimeType, size: bytes.byteLength });
    }
  }
  return out;
}

/** The socket CloudCLI's chat gateway writes to; frames arrive parsed in `onFrame`. */
class HubChatSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  constructor(private readonly onFrame: (frame: Record<string, unknown>) => void) {
    super();
  }
  send(data: string): void {
    try {
      this.onFrame(JSON.parse(data) as Record<string, unknown>);
    } catch (error) {
      console.error('[paseo] could not read a chat frame', error);
    }
  }
  ping(): void {}
  terminate(): void {}
  close(): void {}
  /** A frame from "the client", as if it had come over the wire. */
  deliver(frame: Record<string, unknown>): void {
    this.emit('message', Buffer.from(JSON.stringify(frame)));
  }
}

/** How long a create's idempotency key is remembered (longer than any client retry). */
const CREATION_KEY_TTL_MS = 10 * 60_000;

class PaseoHub extends EventEmitter {
  private socket: HubChatSocket | null = null;
  private timelines = new Map<string, SessionTimeline>();
  private loading = new Map<string, Promise<SessionTimeline>>();
  private lastSeq = new Map<string, number>();
  private turnIds = new Map<string, string>();
  /**
   * The message each conversation's running turn was sent with: its user row, and the sizes of the files the app
   * attached (by name), so Claude Code's echo of it can fill the row's files (paseo-timeline.ts fillUserFiles).
   */
  private pendingUserMessages = new Map<string, { text: string; clientMessageId: string; row?: PaseoTimelineRow; fileSizes?: Map<string, number> }>();
  /**
   * Conversations whose sandbox is being made. The app's "preparing" chip shows only while a message the person sent
   * is waiting on it: a turn nobody is waiting for (a scheduled turn, Claude Code's own follow-up after background
   * work) makes its sandbox out of sight (Deyao, 2026-11-03).
   */
  private preparing = new Set<string>();
  /** AskUserQuestion calls waiting for an answer, per conversation (requestId → request). */
  private questions = new Map<string, Map<string, PaseoQuestionRequest>>();
  /** The answer given to each waiting question, until CloudCLI says it was resolved. */
  private answers = new Map<string, PaseoPermissionResponse>();
  readonly generation = randomUUID();
  private directorySeq = 0;

  /** Starts the hub's chat client on the first Paseo connection (it needs that request's user). */
  ensureStarted(request: AuthenticatedWebSocketRequest, chat: ChatDependencies): void {
    if (this.socket) return;
    this.socket = new HubChatSocket((frame) => this.onChatFrame(frame));
    handleChatConnection(this.socket as never, request, chat);
  }

  nextDirectorySeq(): number {
    this.directorySeq += 1;
    return this.directorySeq;
  }

  get headSeq(): number {
    return this.directorySeq;
  }

  get productName(): string {
    return jarvisProductName();
  }

  get workspacePath(): string {
    return jarvisWorkspacePath();
  }

  get model(): { value: string; label: string } {
    return jarvisModel();
  }

  async listSessions(): Promise<SessionRowLite[]> {
    const page = await sessionsDb.getRecentSessionsPage(500, 0);
    return page.sessions as SessionRowLite[];
  }

  /** An active conversation; with `includeDeleted`, also one in Recently deleted. */
  async getSession(sessionId: string, options: { includeDeleted?: boolean } = {}): Promise<SessionRowLite | null> {
    const row = await sessionsDb.getSessionById(sessionId);
    if (!row) return null;
    if (Number(row.isArchived) === 1 && !options.includeDeleted) return null;
    return row as SessionRowLite;
  }

  /** Recently deleted, newest delete first (Paseo's History page). */
  async listDeleted(): Promise<SessionRowLite[]> {
    const items = await sessionsService.listRecentlyDeletedSessions();
    const rows = await Promise.all(items.map((item) => sessionsDb.getSessionById(item.sessionId)));
    return rows.filter((row): row is NonNullable<typeof row> => !!row) as SessionRowLite[];
  }

  /** Conversations whose sandbox is being made, and those with a Paseo message not yet completed (jarvis-switch.routes.ts). */
  busyState(): { preparing: string[]; pending: string[] } {
    return { preparing: [...this.preparing], pending: [...this.pendingUserMessages.keys()] };
  }

  isRunning(sessionId: string): boolean {
    return chatRunRegistry.isProcessing(sessionId);
  }

  activeTurn(sessionId: string): { turnId: string; startedAt: string } | null {
    if (!this.isRunning(sessionId)) return null;
    const run = chatRunRegistry.getRun(sessionId) as { startedAt?: number | string } | undefined;
    const startedAt = run?.startedAt ? new Date(run.startedAt).toISOString() : new Date().toISOString();
    return { turnId: this.turnIdFor(sessionId), startedAt };
  }

  private turnIdFor(sessionId: string): string {
    let turnId = this.turnIds.get(sessionId);
    if (!turnId) {
      turnId = randomUUID();
      this.turnIds.set(sessionId, turnId);
    }
    return turnId;
  }

  /**
   * Creates by idempotency key, across every socket of the person (one hub per person): a create retried on another
   * socket (pigeon's legacy upstream reopened, a tab reconnected), also while the first is still running, gets the
   * conversation the first one made. A failed create is forgotten (the retry makes it). Kept for CREATION_KEY_TTL_MS.
   */
  private readonly creations = new Map<string, { made: Promise<string>; at: number }>();

  createOnce(key: string, make: () => Promise<string>): Promise<string> {
    const now = Date.now();
    for (const [k, v] of this.creations) if (now - v.at > CREATION_KEY_TTL_MS) this.creations.delete(k);
    const known = this.creations.get(key);
    if (known) return known.made;
    const made = make();
    this.creations.set(key, { made, at: now });
    made.catch(() => {
      if (this.creations.get(key)?.made === made) this.creations.delete(key);
    });
    return made;
  }

  /** The conversation's timeline, read from history the first time. */
  async timeline(sessionId: string): Promise<SessionTimeline> {
    const ready = this.timelines.get(sessionId);
    if (ready) return ready;
    let pending = this.loading.get(sessionId);
    if (!pending) {
      pending = this.loadTimeline(sessionId).finally(() => this.loading.delete(sessionId));
      this.loading.set(sessionId, pending);
    }
    return await pending;
  }

  private async loadTimeline(sessionId: string): Promise<SessionTimeline> {
    const timeline = new SessionTimeline((value) => sentPathToWorkspaceRelative(value));
    try {
      const history = await sessionsService.fetchHistory(sessionId, { limit: null, offset: 0 });
      for (const message of history.messages as NormalizedMessage[]) timeline.apply(message);
    } catch (error) {
      console.warn('[paseo] could not read history', { sessionId, error: error instanceof Error ? error.message : error });
    }
    this.timelines.set(sessionId, timeline);
    // A run that is already going: follow it from now on (what it already wrote is in the history read above).
    if (this.isRunning(sessionId)) {
      const run = chatRunRegistry.getRun(sessionId) as { lastSeq?: number } | undefined;
      this.subscribe(sessionId, run?.lastSeq ?? 0);
    }
    return timeline;
  }

  private subscribe(sessionId: string, lastSeq?: number): void {
    this.socket?.deliver({
      type: 'chat.subscribe',
      sessions: [{ sessionId, lastSeq: lastSeq ?? this.lastSeq.get(sessionId) ?? 0 }],
    });
  }

  /** Creates a conversation (CloudCLI's session row) and starts its first turn. */
  /**
   * A new conversation with its first message. `beforeSend` (view as: the record of the send) runs once the
   * conversation exists and before anything is sent; if it throws, the empty conversation is removed for good and the
   * error passed on.
   */
  async createConversation(
    text: string,
    clientMessageId: string,
    attachments: PaseoAttachments = {},
    beforeSend?: (sessionId: string) => Promise<void>,
    notAfter?: unknown,
  ): Promise<string> {
    // switch window: nothing is made for a create that arrived after its bound
    if (pastNotAfter(notAfter)) throw new NotAfterError();
    const created = await sessionsService.createAppSession('claude', this.workspacePath, text);
    if (beforeSend) {
      try {
        await beforeSend(created.sessionId);
      } catch (error) {
        await sessionsService
          .deleteOrArchiveSessionById(created.sessionId, { force: true, deletedFromDisk: true })
          .catch((e: unknown) => console.error('[paseo] removing an unsent conversation failed', e));
        throw error;
      }
    }
    this.timelines.set(created.sessionId, new SessionTimeline((value) => sentPathToWorkspaceRelative(value)));
    await this.send(created.sessionId, text, clientMessageId, attachments, notAfter);
    return created.sessionId;
  }

  /** Sends a message: the user row goes on the timeline at once, then CloudCLI runs the turn. */
  async send(
    sessionId: string,
    text: string,
    clientMessageId: string,
    sent: PaseoAttachments = {},
    notAfter?: unknown,
  ): Promise<void> {
    const attachments = await toCloudCliAttachments(sent);
    const timeline = await this.timeline(sessionId);
    // switch window: the commit point (the user row) is here, after the awaits above
    if (pastNotAfter(notAfter)) throw new NotAfterError();
    const turnId = randomUUID();
    this.turnIds.set(sessionId, turnId);
    const rows = timeline.apply(
      {
        id: `paseo-user-${clientMessageId}`,
        sessionId,
        timestamp: new Date().toISOString(),
        provider: 'claude',
        kind: 'text',
        role: 'user',
        content: text,
        // the same images and files the history will show for this message (paseo-timeline.ts userImagesOf/userFilesOf)
        images: (sent.images ?? []).map((image) => ({ data: `data:${image.mimeType};base64,${image.data}` })),
        files: (sent.attachments ?? [])
          .filter((attachment) => attachment.type === 'uploaded_file' && typeof attachment.path === 'string')
          .map((attachment) => ({ path: attachment.path, name: attachment.fileName, mimeType: attachment.mimeType, size: attachment.size })),
      } as NormalizedMessage,
      turnId,
    );
    for (const row of rows) {
      if (row.item.type === 'user_message') row.item.clientMessageId = clientMessageId;
    }
    const fileSizes = new Map(
      (sent.attachments ?? [])
        .filter((attachment) => typeof attachment.fileName === 'string' && typeof attachment.size === 'number')
        .map((attachment) => [attachment.fileName as string, attachment.size as number]),
    );
    this.pendingUserMessages.set(sessionId, {
      text, clientMessageId, row: rows.find((row) => row.item.type === 'user_message'), fileSizes,
    });
    // a sandbox already being made for a turn nobody watched: this message now waits on it
    this.announcePreparing(sessionId);
    this.emitEvent({ type: 'timeline', sessionId, rows, epoch: timeline.epoch, turnId });
    this.emitEvent({ type: 'turn', sessionId, phase: 'started', turnId });
    this.socket?.deliver({
      type: 'chat.send',
      sessionId,
      content: text,
      options: {
        model: this.model.value,
        permissionMode: 'bypassPermissions',
        sessionSummary: text.slice(0, 80),
        attachments,
      },
    });
  }

  abort(sessionId: string): void {
    this.socket?.deliver({ type: 'chat.abort', sessionId });
  }

  /** The chip, when the conversation's sandbox is being made and one of the person's messages waits on it. */
  private announcePreparing(sessionId: string): void {
    if (this.preparing.has(sessionId) && this.pendingUserMessages.has(sessionId)) {
      this.emitEvent({ type: 'preparing', sessionId, state: 'preparing' });
    }
  }

  private emitEvent(event: HubEvent): void {
    this.emit('event', event);
  }

  private onChatFrame(frame: Record<string, unknown>): void {
    const kind = typeof frame.kind === 'string' ? frame.kind : '';
    const sessionId = typeof frame.sessionId === 'string' ? frame.sessionId : '';
    if (typeof frame.seq === 'number' && sessionId) this.lastSeq.set(sessionId, frame.seq);

    switch (kind) {
      case 'session_upserted': {
        if (!sessionId) return;
        // A run that started elsewhere (another tab, the iOS app, a scheduled turn): follow it.
        if (this.isRunning(sessionId) && this.timelines.has(sessionId)) this.subscribe(sessionId);
        this.emitEvent({ type: 'session', sessionId });
        return;
      }
      case 'session_removed':
        if (sessionId) {
          this.timelines.delete(sessionId);
          this.emitEvent({ type: 'session', sessionId, removed: true });
        }
        return;
      case 'permission_request': {
        const requestId = typeof frame.requestId === 'string' ? frame.requestId : '';
        const toolName = typeof frame.toolName === 'string' ? frame.toolName : '';
        const input = frame.input && typeof frame.input === 'object' ? (frame.input as Record<string, unknown>) : {};
        if (sessionId && requestId) this.onPermissionRequest(sessionId, requestId, toolName, input);
        return;
      }
      case 'permission_resolved':
      case 'permission_cancelled': {
        const requestId = typeof frame.requestId === 'string' ? frame.requestId : '';
        if (sessionId && requestId) this.onPermissionGone(sessionId, requestId, kind === 'permission_cancelled');
        return;
      }
      // a run the hub subscribed to mid-way: the questions it is already waiting on
      case 'chat_subscribed': {
        const pending = Array.isArray((frame as { pendingPermissions?: unknown }).pendingPermissions)
          ? ((frame as { pendingPermissions: Array<Record<string, unknown>> }).pendingPermissions)
          : [];
        for (const item of pending) {
          const requestId = typeof item.requestId === 'string' ? item.requestId : '';
          const toolName = typeof item.toolName === 'string' ? item.toolName : '';
          const input = item.input && typeof item.input === 'object' ? (item.input as Record<string, unknown>) : {};
          if (sessionId && requestId) this.onPermissionRequest(sessionId, requestId, toolName, input);
        }
        return;
      }
      case 'loading_progress':
      case 'session_created':
      case 'stream_end':
      case 'task_status':
      case 'task_notification':
        return;
      case 'protocol_error': {
        if (!sessionId) return;
        // a send that was refused before it ran gets no `complete`: its message is no longer pending
        if (!this.isRunning(sessionId)) this.pendingUserMessages.delete(sessionId);
        const message = typeof frame.message === 'string' ? frame.message : typeof frame.error === 'string' ? frame.error : 'The message could not be sent.';
        void this.appendLive(sessionId, { ...(frame as object), kind: 'error', content: message } as NormalizedMessage);
        this.emitEvent({ type: 'turn', sessionId, phase: 'failed', turnId: this.turnIdFor(sessionId), error: message });
        return;
      }
      case 'status': {
        const sandbox = (frame as { jarvisSandbox?: unknown }).jarvisSandbox;
        if (sessionId && (sandbox === 'preparing' || sandbox === 'ready')) {
          if (sandbox === 'preparing') {
            this.preparing.add(sessionId);
            this.announcePreparing(sessionId);
          } else {
            this.preparing.delete(sessionId);
            this.emitEvent({ type: 'preparing', sessionId, state: 'ready' });
          }
        }
        return;
      }
      case 'complete': {
        if (!sessionId) return;
        const aborted = (frame as { aborted?: unknown }).aborted === true;
        const exitCode = (frame as { exitCode?: unknown }).exitCode;
        const turnId = this.turnIdFor(sessionId);
        this.turnIds.delete(sessionId);
        this.pendingUserMessages.delete(sessionId);
        this.dropQuestions(sessionId);
        // A turn that ended while its sandbox was still being made (stopped, or the start failed)
        if (this.preparing.delete(sessionId)) this.emitEvent({ type: 'preparing', sessionId, state: 'ready' });
        const phase = aborted ? 'canceled' : typeof exitCode === 'number' && exitCode !== 0 ? 'failed' : 'completed';
        this.emitEvent({ type: 'turn', sessionId, phase, turnId });
        this.emitEvent({ type: 'session', sessionId });
        return;
      }
      default:
        if (sessionId) void this.appendLive(sessionId, frame as unknown as NormalizedMessage);
    }
  }

  private async appendLive(sessionId: string, message: NormalizedMessage): Promise<void> {
    const timeline = this.timelines.get(sessionId);
    if (!timeline) return; // nobody has opened it in Paseo yet: it is read from history when someone does
    // The user's own message comes back from Claude Code's transcript too: it is already on the timeline. The echo
    // names the files' copies in /workspace/uploads, which the row made at send time could not (fillUserFiles).
    if (message.kind === 'text' && message.role === 'user') {
      const pending = this.pendingUserMessages.get(sessionId);
      if (pending && (message.content ?? '').trim() === pending.text.trim()) {
        if (pending.row && timeline.fillUserFiles(pending.row, message.files, pending.fileSizes)) {
          this.emitEvent({ type: 'timeline', sessionId, rows: [pending.row], epoch: timeline.epoch, turnId: pending.row.turnId });
        }
        return;
      }
    }
    const turnId = this.turnIdFor(sessionId);
    const rows = timeline.apply(message, turnId);
    if (rows.length > 0) this.emitEvent({ type: 'timeline', sessionId, rows, epoch: timeline.epoch, turnId });
  }

  /** The questions of a conversation still waiting for the person (the agent snapshot's pendingPermissions). */
  pendingQuestions(sessionId: string): PaseoQuestionRequest[] {
    return [...(this.questions.get(sessionId)?.values() ?? [])];
  }

  /** The person's answer to a waiting question (Paseo's agent_permission_response); false if nothing waits on it. */
  answer(sessionId: string, requestId: string, response: PaseoPermissionResponse): boolean {
    const request = this.questions.get(sessionId)?.get(requestId);
    if (!request) return false;
    this.answers.set(requestId, response);
    if (response.behavior === 'allow') {
      this.socket?.deliver({
        type: 'chat.permission-response',
        requestId,
        allow: true,
        updatedInput: answersByQuestionText({ ...request.input, ...(response.updatedInput ?? {}) }),
      });
    } else {
      this.socket?.deliver({
        type: 'chat.permission-response',
        requestId,
        allow: false,
        message: response.message || 'The person dismissed the question without answering.',
      });
    }
    return true;
  }

  /**
   * A tool waiting on the person. Only AskUserQuestion is shown (as Paseo's question card); YYC AI asks staff for no
   * permissions (skill yyc-ai "Internal writes only"), so anything else that reaches here (ExitPlanMode after the
   * model entered plan mode) is allowed at once, as bypassPermissions would.
   */
  private onPermissionRequest(sessionId: string, requestId: string, toolName: string, input: Record<string, unknown>): void {
    if (toolName !== QUESTION_TOOL) {
      this.socket?.deliver({ type: 'chat.permission-response', requestId, allow: true, updatedInput: input });
      return;
    }
    let waiting = this.questions.get(sessionId);
    if (!waiting) {
      waiting = new Map();
      this.questions.set(sessionId, waiting);
    }
    if (waiting.has(requestId)) return;
    const request: PaseoQuestionRequest = { id: requestId, provider: 'claude', name: toolName, kind: 'question', input };
    waiting.set(requestId, request);
    this.emitEvent({ type: 'question', sessionId, request });
    this.emitEvent({ type: 'session', sessionId });
  }

  private onPermissionGone(sessionId: string, requestId: string, cancelled: boolean): void {
    const waiting = this.questions.get(sessionId);
    if (!waiting?.delete(requestId)) return;
    if (waiting.size === 0) this.questions.delete(sessionId);
    const resolution: PaseoPermissionResponse = cancelled
      ? { behavior: 'deny', message: 'Cancelled' }
      : this.answers.get(requestId) ?? { behavior: 'allow' };
    this.answers.delete(requestId);
    this.emitEvent({ type: 'question_resolved', sessionId, requestId, resolution });
    this.emitEvent({ type: 'session', sessionId });
  }

  /** A turn that ended takes its unanswered questions with it (stopped, failed, the CLI gone). */
  private dropQuestions(sessionId: string): void {
    for (const requestId of [...(this.questions.get(sessionId)?.keys() ?? [])]) this.onPermissionGone(sessionId, requestId, true);
  }

  /** Tests: forget everything. */
  resetForTests(): void {
    this.socket = null;
    this.timelines.clear();
    this.loading.clear();
    this.lastSeq.clear();
    this.turnIds.clear();
    this.pendingUserMessages.clear();
    this.preparing.clear();
    this.questions.clear();
    this.answers.clear();
    this.creations.clear();
    this.removeAllListeners();
  }
}

export const paseoHub = new PaseoHub();
paseoHub.setMaxListeners(0);
