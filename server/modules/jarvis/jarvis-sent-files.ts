/**
 * The files Claude sent to the staff member in a conversation: Claude Code's own `SendUserFile` tool (enabled in
 * the sandbox by CLAUDE_CODE_ATTACHMENTS_BY_PATH=1, DE0CH/jarvis3 docs/CLAUDE-CODE.md "Sent files"). Claude calls it
 * with paths in its /workspace; the conversation's transcript (the session's .jsonl) holds the call and its result,
 * so it is the record: no table of our own. Only calls whose result came back without an error count, and only paths
 * inside /workspace (the sandbox's cwd) — anything else the tool may have accepted is not reachable here.
 */
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { JARVIS_PROJECT_DIR_NAME, JARVIS_WORKSPACE_PATH } from '@/modules/jarvis/jarvis-config.js';

export const SEND_USER_FILE_TOOL = 'SendUserFile';

export type SentFileRecord = {
  /** Relative to the conversation's /workspace, forward slashes. */
  path: string;
  /** When the tool's result was written (ISO 8601). */
  sentAt: string;
  caption?: string;
};

/**
 * A path the tool was given or reported (absolute under /workspace, or relative to the cwd /workspace) as a
 * workspace-relative path, or null when it is outside /workspace or not a plain path.
 */
export function sentPathToWorkspaceRelative(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let p = value.trim().replace(/\\/g, '/');
  if (!p || p.includes('\0') || p.length > 4096) return null;
  if (p.startsWith('file://')) p = p.slice('file://'.length);
  const root = JARVIS_WORKSPACE_PATH;
  if (p.startsWith('/')) {
    if (!p.startsWith(`${root}/`)) return null;
    p = p.slice(root.length + 1);
  }
  const normalized = path.posix.normalize(p);
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) return null;
  return normalized;
}

/** The transcript of a session row: its recorded .jsonl, else where Claude Code writes /workspace sessions. */
export function transcriptPathFor(row: { session_id: string; provider_session_id: string | null; jsonl_path: string | null }): string {
  if (row.jsonl_path) return row.jsonl_path;
  return path.join(os.homedir(), '.claude', 'projects', JARVIS_PROJECT_DIR_NAME, `${row.provider_session_id || row.session_id}.jsonl`);
}

type PendingCall = { files: unknown; caption?: string };

function contentParts(entry: any): any[] {
  const content = entry?.message?.content;
  return Array.isArray(content) ? content : [];
}

/**
 * Every file sent with SendUserFile in a transcript, once each (the latest send wins), newest first. A missing
 * transcript means nothing was sent yet.
 */
export async function readSentFiles(transcriptPath: string): Promise<SentFileRecord[]> {
  const pending = new Map<string, PendingCall>();
  const latest = new Map<string, SentFileRecord>();
  let order = 0;
  const seq = new Map<string, number>();
  const stream = createReadStream(transcriptPath, { encoding: 'utf8' });
  const opened = await new Promise<boolean>((resolve, reject) => {
    stream.once('open', () => resolve(true));
    stream.once('error', (error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? resolve(false) : reject(error)));
  });
  if (!opened) return [];
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    const isCall = line.includes(SEND_USER_FILE_TOOL);
    const isResult = pending.size > 0 && line.includes('"tool_result"');
    if (!isCall && !isResult) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.isSidechain) continue;
    for (const part of contentParts(entry)) {
      if (part?.type === 'tool_use' && part.name === SEND_USER_FILE_TOOL && typeof part.id === 'string') {
        const input = part.input && typeof part.input === 'object' ? part.input : {};
        pending.set(part.id, {
          files: input.files,
          caption: typeof input.caption === 'string' && input.caption.trim() ? input.caption.trim() : undefined,
        });
        continue;
      }
      if (part?.type !== 'tool_result' || typeof part.tool_use_id !== 'string') continue;
      const call = pending.get(part.tool_use_id);
      if (!call) continue;
      pending.delete(part.tool_use_id);
      if (part.is_error) continue;
      const sentAt = typeof entry.timestamp === 'string' ? entry.timestamp : new Date(0).toISOString();
      // the tool reports the absolute paths it delivered; the call's own list is the fallback
      const reported = Array.isArray(entry.toolUseResult?.attachments)
        ? entry.toolUseResult.attachments.map((a: any) => a?.path)
        : null;
      const given = Array.isArray(call.files) ? call.files : typeof call.files === 'string' ? [call.files] : [];
      for (const raw of reported && reported.length ? reported : given) {
        const rel = sentPathToWorkspaceRelative(raw);
        if (!rel) continue;
        latest.set(rel, { path: rel, sentAt, ...(call.caption ? { caption: call.caption } : {}) });
        seq.set(rel, order++);
      }
    }
  }
  return [...latest.values()].sort(
    (a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt) || (seq.get(b.path) ?? 0) - (seq.get(a.path) ?? 0),
  );
}
