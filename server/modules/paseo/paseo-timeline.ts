/**
 * One conversation's timeline as the Paseo web app reads it (DE0CH/claudecodeui docs/paseo-ui.md): projected rows with
 * sequence numbers under an epoch, served in pages (`fetch_agent_timeline_request`) and extended live
 * (`agent_stream` timeline events). The source of truth stays CloudCLI's: the rows are rebuilt from the session's
 * history (Claude Code's transcript, through sessionsService) the first time a socket asks, and every live event the
 * chat run registry forwards is appended. A new epoch (a process start, or a rebuild after the transcript changed
 * under us) tells the app to drop what it holds and fetch the tail again.
 */
import { randomUUID } from 'node:crypto';

import type { NormalizedMessage } from '@/shared/types.js';

import {
  mapClaudeCompletedToolCall,
  mapClaudeFailedToolCall,
  mapClaudeRunningToolCall,
} from './vendor/claude-tool-call-mapper.js';
import type { ToolCallTimelineItem } from './vendor/types.js';

/** An image the user attached, as the app shows it on their message (a data: URL, as Claude Code's transcript keeps it). */
export type UserImage = { url: string; mimeType: string };

/** A file the user attached (saved in the conversation's /workspace/uploads/), as an uploaded-file attachment pill. */
export type UserFile = { type: 'uploaded_file'; id: string; fileName: string; mimeType: string; size: number; path: string };

export type PaseoTimelineItem =
  | { type: 'user_message'; text: string; messageId?: string; clientMessageId?: string; images?: UserImage[]; attachments?: UserFile[] }
  | { type: 'assistant_message'; text: string; messageId?: string }
  | { type: 'reasoning'; text: string }
  | ToolCallTimelineItem
  | { type: 'error'; message: string };

export type PaseoTimelineRow = {
  provider: 'claude';
  item: PaseoTimelineItem;
  turnId?: string;
  timestamp: string;
  seqStart: number;
  seqEnd: number;
  sourceSeqRanges: Array<{ startSeq: number; endSeq: number }>;
  collapsed: Array<'assistant_merge' | 'reasoning_merge' | 'tool_lifecycle' | 'identity'>;
};

export type TimelineCursor = { epoch: string; seq: number };

export type TimelineFetchRequest = {
  direction?: 'tail' | 'before' | 'after';
  cursor?: TimelineCursor | null;
  limit?: number;
};

export type TimelineFetchResult = {
  direction: 'tail' | 'before' | 'after';
  projection: 'projected';
  epoch: string;
  reset: boolean;
  staleCursor: boolean;
  gap: boolean;
  window: { minSeq: number; maxSeq: number; nextSeq: number };
  startCursor: TimelineCursor | null;
  endCursor: TimelineCursor | null;
  hasOlder: boolean;
  hasNewer: boolean;
  entries: PaseoTimelineRow[];
};

/** What a live CloudCLI event did to the timeline: the rows to stream, if any. */
export type TimelineAppendResult = { rows: PaseoTimelineRow[] };

const DEFAULT_PAGE = 40;

/** A file Claude handed over with SendUserFile, as the app's sent-file cards read it (tool call metadata). */
export type SentFile = {
  path: string;
  name: string;
  size: number | null;
  mediaType: string | null;
  isImage: boolean;
  /** The SendUserFile call's id: the download reads that send's snapshot (`files/raw?sent=`). */
  sent?: string;
};

/** A sandbox path as a path relative to the conversation's files root, or null outside it. */
export type ToRelativePath = (value: unknown) => string | null;

/** SendUserFile's result, as the files the download route will hand out (anything else is left out). */
export function sentFilesOf(output: unknown, toRelative: ToRelativePath, callId?: string): SentFile[] {
  const attachments = (output as { attachments?: unknown } | null)?.attachments;
  if (!Array.isArray(attachments)) return [];
  const files: SentFile[] = [];
  for (const raw of attachments) {
    const entry = raw as { path?: unknown; size?: unknown; media_type?: unknown; isImage?: unknown };
    const relative = toRelative(entry.path);
    if (!relative) continue;
    files.push({
      path: relative,
      name: relative.split('/').pop() || relative,
      size: typeof entry.size === 'number' ? entry.size : null,
      mediaType: typeof entry.media_type === 'string' ? entry.media_type : null,
      isImage: entry.isImage === true,
      ...(callId ? { sent: callId } : {}),
    });
  }
  return files;
}

/** The user's images in a history message (Claude Code keeps them as data: URLs, CloudCLI passes them on). */
export function userImagesOf(value: unknown): UserImage[] {
  if (!Array.isArray(value)) return [];
  const images: UserImage[] = [];
  for (const raw of value) {
    const data = (raw as { data?: unknown } | null)?.data;
    if (typeof data !== 'string') continue;
    const m = /^data:(image\/[a-z0-9.+-]+);base64,/i.exec(data);
    if (m) images.push({ url: data, mimeType: m[1]!.toLowerCase() });
  }
  return images;
}

const FILE_TYPES: Record<string, string> = {
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', zip: 'application/zip',
};

/** The user's files in a history message (CloudCLI's parsed <files_input> block), with paths the file routes accept. */
export function userFilesOf(value: unknown, toRelative: ToRelativePath): UserFile[] {
  if (!Array.isArray(value)) return [];
  const files: UserFile[] = [];
  for (const raw of value) {
    const entry = raw as { path?: unknown; name?: unknown; mimeType?: unknown; size?: unknown } | null;
    const relative = toRelative(entry?.path);
    if (!relative) continue;
    const fileName = typeof entry?.name === 'string' && entry.name ? entry.name : relative.split('/').pop() || relative;
    const extension = fileName.split('.').pop()?.toLowerCase() ?? '';
    files.push({
      type: 'uploaded_file',
      id: relative,
      fileName,
      mimeType: typeof entry?.mimeType === 'string' && entry.mimeType ? entry.mimeType : FILE_TYPES[extension] ?? 'application/octet-stream',
      size: typeof entry?.size === 'number' && entry.size >= 0 ? Math.floor(entry.size) : 0,
      path: relative,
    });
  }
  return files;
}

function textOf(message: NormalizedMessage): string {
  if (typeof message.content === 'string') return message.content;
  if (typeof message.text === 'string') return message.text;
  return '';
}

function toolOutput(message: NormalizedMessage): unknown {
  const result = message.toolResult;
  if (result?.toolUseResult !== undefined) return result.toolUseResult;
  if (message.toolUseResult !== undefined) return message.toolUseResult;
  return result?.content ?? message.content ?? null;
}

export class SessionTimeline {
  constructor(private readonly toRelative: ToRelativePath) {}

  epoch = randomUUID();
  rows: PaseoTimelineRow[] = [];
  private nextSeq = 1;
  private toolRows = new Map<string, PaseoTimelineRow>();
  private toolInputs = new Map<string, { name: string; input: unknown }>();
  /** Ids of history/live messages already applied, so a replayed live event is not added twice. */
  private seen = new Set<string>();

  get maxSeq(): number {
    return this.nextSeq - 1;
  }

  /** Applies one CloudCLI message (from history or live); returns the rows that changed. */
  apply(message: NormalizedMessage, turnId?: string): PaseoTimelineRow[] {
    if (message.id && this.seen.has(message.id)) return [];
    if (message.id) this.seen.add(message.id);
    const timestamp = message.timestamp || new Date().toISOString();

    switch (message.kind) {
      case 'text': {
        const text = textOf(message);
        const hasAttachments = message.role === 'user' && (userImagesOf(message.images).length > 0 || Array.isArray(message.files) && message.files.length > 0);
        if (!text.trim() && !hasAttachments) return [];
        if (message.role === 'user') {
          const images = userImagesOf(message.images);
          const attachments = userFilesOf(message.files, this.toRelative);
          return [this.push({
            type: 'user_message',
            text,
            messageId: message.transcriptAnchorId ?? message.id,
            ...(images.length ? { images } : {}),
            ...(attachments.length ? { attachments } : {}),
          }, timestamp, turnId)];
        }
        return [this.push({ type: 'assistant_message', text, messageId: message.transcriptAnchorId ?? message.id }, timestamp, turnId)];
      }
      case 'thinking': {
        const text = textOf(message);
        if (!text.trim()) return [];
        return [this.push({ type: 'reasoning', text }, timestamp, turnId)];
      }
      case 'tool_use': {
        const callId = message.toolId;
        const name = message.toolName;
        if (!callId || !name) return [];
        this.toolInputs.set(callId, { name, input: message.toolInput });
        // OpenCode-style inline results arrive on the tool_use itself (Claude sends a separate tool_result)
        const item = message.toolResult
          ? this.finishedTool(callId, name, message.toolInput, toolOutput(message), message.toolResult.isError === true)
          : mapClaudeRunningToolCall({ callId, name, input: message.toolInput });
        if (!item) return [];
        const row = this.push(item, timestamp, turnId);
        this.toolRows.set(callId, row);
        return [row];
      }
      case 'tool_result': {
        const callId = message.toolId;
        if (!callId) return [];
        const known = this.toolInputs.get(callId);
        const name = known?.name ?? message.toolName ?? 'tool';
        const item = this.finishedTool(callId, name, known?.input, toolOutput(message), message.isError === true || message.toolResult?.isError === true);
        if (!item) return [];
        const row = this.toolRows.get(callId);
        if (!row) {
          const created = this.push(item, timestamp, turnId);
          this.toolRows.set(callId, created);
          return [created];
        }
        const seq = this.nextSeq++;
        row.item = item;
        row.seqEnd = seq;
        row.sourceSeqRanges = [...row.sourceSeqRanges, { startSeq: seq, endSeq: seq }];
        if (!row.collapsed.includes('tool_lifecycle')) row.collapsed = [...row.collapsed, 'tool_lifecycle'];
        return [row];
      }
      case 'error': {
        const text = textOf(message) || message.reason || '';
        if (!text.trim()) return [];
        return [this.push({ type: 'error', message: text }, timestamp, turnId)];
      }
      default:
        return [];
    }
  }

  private finishedTool(callId: string, name: string, input: unknown, output: unknown, failed: boolean): ToolCallTimelineItem | null {
    if (failed) {
      const error = typeof output === 'string' ? { message: output } : output ?? { message: 'Tool call failed' };
      return mapClaudeFailedToolCall({ callId, name, input, output, error });
    }
    const metadata = name === 'SendUserFile' ? { sentFiles: sentFilesOf(output, this.toRelative, callId) } : undefined;
    return mapClaudeCompletedToolCall({ callId, name, input, output, ...(metadata ? { metadata } : {}) });
  }

  private push(item: PaseoTimelineItem, timestamp: string, turnId?: string): PaseoTimelineRow {
    const seq = this.nextSeq++;
    const row: PaseoTimelineRow = {
      provider: 'claude',
      item,
      ...(turnId ? { turnId } : {}),
      timestamp,
      seqStart: seq,
      seqEnd: seq,
      sourceSeqRanges: [{ startSeq: seq, endSeq: seq }],
      collapsed: [],
    };
    this.rows.push(row);
    return row;
  }

  /** The user's prompts, for the app's prompt index (jump to a message). */
  prompts(): Array<{ seq: number; timestamp: string; preview: string }> {
    return this.rows
      .filter((row) => row.item.type === 'user_message')
      .map((row) => ({
        seq: row.seqStart,
        timestamp: row.timestamp,
        preview: (row.item as { text: string }).text.slice(0, 200),
      }));
  }

  fetch(request: TimelineFetchRequest): TimelineFetchResult {
    const limit = Math.max(1, Math.min(request.limit ?? DEFAULT_PAGE, 500));
    const requested = request.direction ?? 'tail';
    const staleCursor = !!request.cursor && request.cursor.epoch !== this.epoch;
    const direction = staleCursor ? 'tail' : requested;
    let start: number;
    let end: number;

    if (direction === 'after' && request.cursor) {
      const after = request.cursor.seq;
      start = this.rows.findIndex((row) => row.seqEnd > after);
      if (start === -1) start = this.rows.length;
      end = Math.min(this.rows.length, start + limit);
    } else if (direction === 'before' && request.cursor) {
      const before = request.cursor.seq;
      end = this.rows.findIndex((row) => row.seqStart >= before);
      if (end === -1) end = this.rows.length;
      start = Math.max(0, end - limit);
    } else {
      end = this.rows.length;
      start = Math.max(0, end - limit);
    }

    const entries = this.rows.slice(start, end);
    const first = entries[0];
    const last = entries[entries.length - 1];
    return {
      direction: requested,
      projection: 'projected',
      epoch: this.epoch,
      reset: staleCursor,
      staleCursor,
      gap: false,
      window: {
        minSeq: this.rows[0]?.seqStart ?? 0,
        maxSeq: this.maxSeq,
        nextSeq: this.nextSeq,
      },
      startCursor: first ? { epoch: this.epoch, seq: first.seqStart } : null,
      endCursor: last ? { epoch: this.epoch, seq: last.seqEnd } : null,
      hasOlder: start > 0,
      hasNewer: end < this.rows.length,
      entries,
    };
  }
}
