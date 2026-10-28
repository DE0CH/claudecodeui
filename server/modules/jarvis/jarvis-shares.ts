/**
 * Shared conversations (the previous YYC AI frontend's "Sharing and continuing", DE0CH/jarvis3 docs/CHAT.md before
 * 07e2e49, rebuilt for this fork; docs/CLAUDE-CODE.md "Sharing"):
 *
 * - **Share**: the owner's process freezes the conversation as it is now into a new link `/s/<id>`: the history the
 *   UI shows (finished turns only: a turn still running is left out), Claude Code's transcript (and its session
 *   folder: sub-agent transcripts, saved tool output) and a copy of the conversation's /workspace. Later messages
 *   never show on an earlier link. Every share is a new link; each can be revoked on its own ("Stop sharing").
 * - **Audience**: instance users only. The whole site is behind Cloudflare Access and the router's `users` check, so
 *   a link opens only for signed-in staff; the id (128 random bits) is the only way to a share. Not public.
 * - **The shared page** is read-only and renders with the chat's own view (timeline rows, `shareView`): the owner's
 *   messages with their images and files, tool steps, the sent-file cards.
 *   Downloads: the files Claude sent (SendUserFile) and the uploads, never other workspace files.
 * - **Continue conversation**: a new conversation of the viewer's with the snapshot's title, Claude Code's
 *   transcript (new session id and message ids, so Claude has the whole context) and every /workspace file. The
 *   sandbox is not carried over (the first message starts a new one). Nothing in the new conversation names the
 *   share or the original (no parent, no "fork" record).
 *
 * Where it lives: one table shared by every user's process, `<JARVIS_SHARES_SCHEMA, default cc_shared>.shares` in the
 * same Postgres database as the per-user schemas, and the snapshot's files on the JuiceFS volume under the owner's
 * folder, `$JARVIS_JFS_ROOT/users/<owner key>/shares/<id>/` (`messages.json`, `transcript.jsonl`, `session/`, `ws/`),
 * outside anything a sandbox mounts. Revoking (or deleting the conversation) marks the row and deletes that folder.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { all, get, run, sessionsDb } from '@/modules/database/index.js';
import {
  conversationSentDir,
  conversationWorkspaceDir,
  isConversationId,
  jarvisProjectDirName,
  jarvisWorkspacePath,
  jarvisJfsRoot,
  jarvisModel,
  jarvisOwner,
  jarvisUntitledName,
} from '@/modules/jarvis/jarvis-config.js';
import { cloneTree } from '@/modules/jarvis/jarvis-clone.js';
import { readSentFiles, sentPathToWorkspaceRelative, transcriptPathFor } from '@/modules/jarvis/jarvis-sent-files.js';
import type { PaseoTimelineRow } from '@/modules/paseo/index.js';
import type { NormalizedMessage } from '@/shared/types.js';

export class ShareError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

/** A share link's id: 16 random bytes, base64url (22 characters). */
export const SHARE_ID_RE = /^[A-Za-z0-9_-]{22}$/;
export const newShareId = (): string => randomBytes(16).toString('base64url');

/** jarvis3's userKey (the router's too): "u" + the first 24 hex characters of sha256(lowercased, trimmed email). */
export function userKey(email: string): string {
  return `u${createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 24)}`;
}

/** The schema every user's process shares for the shares table. */
export function sharesSchema(): string {
  const s = process.env.JARVIS_SHARES_SCHEMA || 'cc_shared';
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(s)) throw new Error('JARVIS_SHARES_SCHEMA must be a lowercase identifier');
  return s;
}

let tableReady: Promise<void> | null = null;
let tableSchema = '';

/** Creates the shared schema and table once per process (two processes racing on it is fine: retried once). */
export async function ensureSharesTable(): Promise<void> {
  const schema = sharesSchema();
  if (tableReady && tableSchema === schema) return tableReady;
  tableSchema = schema;
  const make = async () => {
    await run(`create schema if not exists ${schema}`);
    await run(`create table if not exists ${schema}.shares (
      id text primary key,
      owner text not null,
      owner_name text not null,
      session_id text not null,
      title text not null,
      dir text not null,
      files jsonb not null default '[]',
      created_at timestamptz not null default now(),
      revoked_at timestamptz)`);
    await run(`create index if not exists shares_owner_session on ${schema}.shares (owner, session_id)`);
  };
  tableReady = make().catch(async () => {
    // another process created it at the same moment (a unique violation on the catalog): once more, then it exists
    await make();
  });
  tableReady.catch(() => {
    tableReady = null;
  });
  return tableReady;
}

/** Tests: forget that the table was made (another schema). */
export function resetSharesTable(): void {
  tableReady = null;
}

type ShareRow = {
  id: string;
  owner: string;
  owner_name: string;
  session_id: string;
  title: string;
  dir: string;
  files: string[];
  created_at: string | Date;
  revoked_at: string | Date | null;
};

export type ShareLink = { id: string; url: string; createdAt: string };

const iso = (v: string | Date): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

/** The name shown on the shared page: the part of the owner's address before the @ (as the previous frontend did). */
export function ownerDisplayName(email: string): string {
  return email.split('@')[0] || email;
}

function shareDir(owner: string, id: string): string {
  return path.join(jarvisJfsRoot(), 'users', userKey(owner), 'shares', id);
}

/** Claude Code's transcript folder for /workspace in this process's HOME (HOME/.claude is the user's JuiceFS folder). */
function projectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects', jarvisProjectDirName());
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(() => true, () => false);
}

/** A transcript row that is a person's prompt (not a tool result, not a meta or side-chain row). */
function isPromptRow(entry: any): boolean {
  if (entry?.type !== 'user' || entry.isMeta || entry.isSidechain) return false;
  const content = entry.message?.content;
  if (typeof content === 'string') return true;
  return Array.isArray(content) && !content.some((part: any) => part?.type === 'tool_result');
}

/** The transcript without the turn still running: everything before its prompt. */
export function withoutRunningTurn(text: string): string {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (isPromptRow(entry)) return lines.slice(0, i).join('\n') + (i > 0 ? '\n' : '');
  }
  return '';
}

/** The history the UI shows without the turn still running: everything before the last message of the person's. */
export function historyWithoutRunningTurn<T extends { kind?: string; role?: string }>(messages: T[]): T[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.kind === 'text' && m.role === 'user') return messages.slice(0, i);
  }
  return [];
}

/** Every regular file under `root/rel` (recursive, symlinks not followed), as paths relative to root. */
async function listFiles(root: string, rel: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(root, p)));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

type ShareDeps = {
  /** The history the UI shows for the conversation (sessionsService.fetchHistory). */
  history: (sessionId: string) => Promise<unknown[]>;
  /** Whether a turn of the conversation is running now. */
  isRunning: (sessionId: string) => boolean;
  /** Tells this user's open tabs about a new conversation. */
  announce: (sessionId: string) => Promise<void>;
};

async function defaultDeps(): Promise<ShareDeps> {
  const [{ sessionsService }, { chatRunRegistry, broadcastSessionUpserted }] = await Promise.all([
    import('@/modules/providers/index.js'),
    import('@/modules/websocket/index.js'),
  ]);
  return {
    history: async (sessionId) => ((await sessionsService.fetchHistory(sessionId)) as { messages: unknown[] }).messages ?? [],
    isRunning: (sessionId) => chatRunRegistry.isProcessing(sessionId),
    announce: (sessionId) => broadcastSessionUpserted(sessionId),
  };
}

function requireOwner(): string {
  const owner = jarvisOwner();
  if (!owner) throw new ShareError(403, 'NO_OWNER', 'This process has no user.');
  return owner;
}

/**
 * Freezes the conversation as it is now into a new share and returns its link. 400 NOTHING_TO_SHARE when no turn has
 * finished yet.
 */
export async function createShare(sessionId: string, deps?: ShareDeps): Promise<ShareLink> {
  const owner = requireOwner();
  const row = isConversationId(sessionId) ? await sessionsDb.getSessionById(sessionId) : null;
  if (!row) throw new ShareError(404, 'SESSION_NOT_FOUND', 'This conversation was not found.');
  const d = deps ?? (await defaultDeps());
  await ensureSharesTable();

  const running = d.isRunning(sessionId);
  let transcript = '';
  try {
    transcript = await readFile(transcriptPathFor(row), 'utf8');
  } catch {
    transcript = '';
  }
  if (running) transcript = withoutRunningTurn(transcript);
  let messages = await d.history(sessionId);
  if (running) messages = historyWithoutRunningTurn(messages as Array<{ kind?: string; role?: string }>);
  const answered = (messages as Array<{ kind?: string; role?: string }>).some((m) => m.role === 'assistant' || (m.kind && m.kind !== 'text'));
  if (!transcript.trim() || !answered) throw new ShareError(400, 'NOTHING_TO_SHARE', 'There is nothing to share yet.');

  const id = newShareId();
  const dir = shareDir(owner, id);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(dir, 'transcript.jsonl'), transcript, { mode: 0o600 });
    await writeFile(path.join(dir, 'messages.json'), JSON.stringify(messages), { mode: 0o600 });
    // the session folder beside the transcript: sub-agent transcripts and saved tool output
    const providerId = row.provider_session_id || row.session_id;
    const sessionFolder = path.join(path.dirname(transcriptPathFor(row)), providerId);
    if (await exists(sessionFolder)) {
      await cp(sessionFolder, path.join(dir, 'session'), { recursive: true, verbatimSymlinks: true });
    }
    const ws = conversationWorkspaceDir(sessionId);
    await mkdir(path.join(dir, 'ws'), { recursive: true });
    if (await exists(ws)) {
      // symlinks are copied as links (never followed); downloads refuse them anyway
      await cp(ws, path.join(dir, 'ws'), { recursive: true, verbatimSymlinks: true, force: true });
    }
    // the sent files as each send kept them (copy-on-write snapshots, jarvis-config.ts conversationSentDir)
    const sentDir = conversationSentDir(sessionId);
    if (await exists(sentDir)) await cloneTree(sentDir, path.join(dir, 'sent'));
    // what the shared page may hand out: the files Claude sent, and the uploads
    const sent = (await readSentFiles(path.join(dir, 'transcript.jsonl'))).map((f) => f.path);
    const uploads = await listFiles(path.join(dir, 'ws'), 'uploads');
    const files = [...new Set([...sent, ...uploads])];

    await run(
      `insert into ${sharesSchema()}.shares (id, owner, owner_name, session_id, title, dir, files) values (?, ?, ?, ?, ?, ?, ?::jsonb)`,
      [id, owner, ownerDisplayName(owner), sessionId, row.custom_name?.trim() || jarvisUntitledName(), dir, JSON.stringify(files)],
    );
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  const created = await get<ShareRow>(`select * from ${sharesSchema()}.shares where id = ?`, [id]);
  return { id, url: `/s/${id}`, createdAt: iso(created!.created_at) };
}

/** The conversation's live links (newest first); only its owner's. */
export async function listShares(sessionId: string): Promise<ShareLink[]> {
  const owner = requireOwner();
  await ensureSharesTable();
  const rows = await all<ShareRow>(
    `select * from ${sharesSchema()}.shares where owner = ? and session_id = ? and revoked_at is null order by created_at desc`,
    [owner, sessionId],
  );
  return rows.map((r) => ({ id: r.id, url: `/s/${r.id}`, createdAt: iso(r.created_at) }));
}

async function liveShare(id: string): Promise<ShareRow | null> {
  if (!SHARE_ID_RE.test(id)) return null;
  await ensureSharesTable();
  return (await get<ShareRow>(`select * from ${sharesSchema()}.shares where id = ? and revoked_at is null`, [id])) ?? null;
}

async function markRevoked(rows: ShareRow[]): Promise<void> {
  for (const r of rows) {
    await run(`update ${sharesSchema()}.shares set revoked_at = now() where id = ? and revoked_at is null`, [r.id]);
    await rm(r.dir, { recursive: true, force: true }).catch((error) => {
      console.warn('[jarvis] share folder removal failed', { id: r.id, error: error instanceof Error ? error.message : error });
    });
  }
}

/** "Stop sharing": only the owner's own live links; anyone else's id answers 404, like an unknown one. */
export async function revokeShare(id: string): Promise<void> {
  const owner = requireOwner();
  const row = await liveShare(id);
  if (!row || row.owner !== owner) throw new ShareError(404, 'SHARE_NOT_FOUND', 'This link is no longer available.');
  await markRevoked([row]);
}

/** A deleted conversation's links stop working, and their snapshots are deleted. Never throws (logged). */
export async function revokeSharesOf(sessionId: string): Promise<void> {
  try {
    const owner = requireOwner();
    await ensureSharesTable();
    const rows = await all<ShareRow>(
      `select * from ${sharesSchema()}.shares where owner = ? and session_id = ? and revoked_at is null`,
      [owner, sessionId],
    );
    await markRevoked(rows);
  } catch (error) {
    console.warn('[jarvis] revoking a deleted conversation\'s shares failed', { sessionId, error: error instanceof Error ? error.message : error });
  }
}

async function requireShare(id: string): Promise<ShareRow> {
  const row = await liveShare(id);
  if (!row) throw new ShareError(404, 'SHARE_NOT_FOUND', 'This link is no longer available.');
  return row;
}

/**
 * The shared page: who shared it, when, its title, and the frozen history as the chat view's timeline rows (built by
 * the same SessionTimeline a live conversation uses, so the page renders with the chat's own components). File paths
 * in the rows are relative to the snapshot's /workspace; the page reads them through `/shares/:id/files/raw`, which
 * hands out only the share's `files`.
 */
export async function shareView(id: string): Promise<{
  id: string;
  title: string;
  ownerName: string;
  isOwner: boolean;
  createdAt: string;
  timeline: PaseoTimelineRow[];
}> {
  const row = await requireShare(id);
  let messages: NormalizedMessage[] = [];
  try {
    messages = JSON.parse(await readFile(path.join(row.dir, 'messages.json'), 'utf8'));
  } catch {
    throw new ShareError(404, 'SHARE_NOT_FOUND', 'This link is no longer available.');
  }
  // loaded when used: the paseo module imports the providers, which import this module (as in defaultDeps)
  const { SessionTimeline } = await import('@/modules/paseo/index.js');
  const timeline = new SessionTimeline((value) => sentPathToWorkspaceRelative(value));
  for (const message of Array.isArray(messages) ? messages : []) timeline.apply(message);
  return {
    id: row.id,
    title: row.title,
    ownerName: row.owner_name,
    isOwner: row.owner === jarvisOwner(),
    createdAt: iso(row.created_at),
    timeline: timeline.rows,
  };
}

/**
 * Where a shared file may be read from, and only for a file the page may hand out: the share's copy of /workspace,
 * and its copy of the sent-file snapshots (`sent/<toolUseId>/…`, read first when the card names its send).
 */
export async function shareFileRoot(id: string, rel: string): Promise<{ root: string; sentDir: string }> {
  const row = await requireShare(id);
  if (!row.files.includes(rel)) throw new ShareError(404, 'FILE_NOT_FOUND', 'That file was not found.');
  return { root: path.join(row.dir, 'ws'), sentDir: path.join(row.dir, 'sent') };
}

const UUID_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * A Claude Code transcript under a new session id: every session id in it becomes `newSessionId`, every row's own
 * uuid a fresh one (parentUuid and every other reference follow, as they name the same uuids), and `forkedFrom`
 * records are dropped, so nothing names the original. Also returns the rewrite for the session folder's files.
 */
export function transcriptUnderNewIds(text: string, newSessionId: string): { text: string; rewrite: (s: string) => string } {
  const map = new Map<string, string>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (typeof o?.sessionId === 'string' && isConversationId(o.sessionId)) map.set(o.sessionId.toLowerCase(), newSessionId);
      if (typeof o?.uuid === 'string' && isConversationId(o.uuid) && !map.has(o.uuid.toLowerCase())) map.set(o.uuid.toLowerCase(), randomUUID());
    } catch {
      /* not a row */
    }
  }
  const rewrite = (s: string) => s.replace(UUID_G, (m) => map.get(m.toLowerCase()) ?? m);
  const out = text
    .split('\n')
    .map((line) => {
      if (!line.trim()) return line;
      try {
        const o = JSON.parse(line);
        delete o.forkedFrom;
        return rewrite(JSON.stringify(o));
      } catch {
        return rewrite(line);
      }
    })
    .join('\n');
  return { text: out, rewrite };
}

/**
 * "Continue conversation": a new conversation of the viewer's (this process's user) from the snapshot, at the top of
 * their list with the same title. Returns its id.
 */
export async function continueShare(id: string, deps?: ShareDeps): Promise<{ sessionId: string }> {
  requireOwner();
  const row = await requireShare(id);
  const d = deps ?? (await defaultDeps());
  let transcript: string;
  try {
    transcript = await readFile(path.join(row.dir, 'transcript.jsonl'), 'utf8');
  } catch {
    throw new ShareError(404, 'SHARE_NOT_FOUND', 'This link is no longer available.');
  }

  const forked = randomUUID();
  const conversation = randomUUID();
  const { text, rewrite } = transcriptUnderNewIds(transcript, forked);
  const target = projectsDir();
  const jsonlPath = path.join(target, `${forked}.jsonl`);
  // the row first: the transcript watcher then finds the new file already mapped (never a second conversation)
  await sessionsDb.createForkedSession({
    sessionId: conversation,
    provider: 'claude',
    projectPath: jarvisWorkspacePath(),
    customName: row.title,
    providerSessionId: forked,
    jsonlPath,
    forkedFromSessionId: null,
    model: jarvisModel().value,
    effort: null,
  });
  try {
    await mkdir(target, { recursive: true, mode: 0o700 });
    const sessionFolder = path.join(row.dir, 'session');
    if (await exists(sessionFolder)) {
      const to = path.join(target, forked);
      await cp(sessionFolder, to, { recursive: true, verbatimSymlinks: true });
      for (const rel of await listFiles(to, '')) {
        if (!/\.(jsonl|json)$/.test(rel)) continue;
        const f = path.join(to, rel);
        await writeFile(f, rewrite(await readFile(f, 'utf8')), { mode: 0o600 });
      }
    }
    await writeFile(jsonlPath, text, { mode: 0o600 });
    const files = path.join(row.dir, 'ws');
    if (await exists(files)) {
      await cp(files, conversationWorkspaceDir(conversation), { recursive: true, verbatimSymlinks: true, force: true });
    }
    // the snapshots keep their send ids: tool call ids are not among the ids transcriptUnderNewIds replaces
    const sent = path.join(row.dir, 'sent');
    if (await exists(sent)) await cloneTree(sent, conversationSentDir(conversation));
  } catch (error) {
    await sessionsDb.deleteSessionById(conversation).catch(() => {});
    await rm(jsonlPath, { force: true }).catch(() => {});
    await rm(path.join(target, forked), { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  await d.announce(conversation).catch(() => {});
  return { sessionId: conversation };
}

/** Tests: the folder a share's snapshot is in. */
export async function shareDirOf(id: string): Promise<string | null> {
  await ensureSharesTable();
  return (await get<{ dir: string }>(`select dir from ${sharesSchema()}.shares where id = ?`, [id]))?.dir ?? null;
}

