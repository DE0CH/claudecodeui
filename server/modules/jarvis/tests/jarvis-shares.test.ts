import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { closeConnection, initializeDatabase, run, sessionsDb } from '@/modules/database/index.js';
import { releaseTestDatabase } from '@/modules/database/testing.js';
import { onConversationDeleted } from '@/modules/jarvis/jarvis-conversations.js';
import { resetJarvisInstanceConfig } from '@/modules/jarvis/jarvis-config.js';
import {
  continueShare,
  createShare,
  historyWithoutRunningTurn,
  listShares,
  resetSharesTable,
  revokeShare,
  shareDirOf,
  shareView,
  userKey,
  withoutRunningTurn,
} from '@/modules/jarvis/jarvis-shares.js';
import { createJarvisSharesRouter } from '@/modules/jarvis/jarvis-shares.routes.js';

const OWNER = 'owner@yyc.example';
const VIEWER = 'viewer@yyc.example';

type Ctx = { jfs: string; temp: string; as: (email: string) => Promise<void> };

/** Jarvis env with two users (each its own schema and HOME), one shared shares schema, a temp JuiceFS root. */
async function withUsers(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const saved = { ...process.env };
  const temp = await mkdtemp(path.join(os.tmpdir(), 'jarvis-shares-'));
  const sharesSchema = `cc_t_shares_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const used: string[] = [];
  const as = async (email: string) => {
    await closeConnection();
    process.env.DATABASE_PATH = path.join(temp, `${email}.db`);
    process.env.JARVIS_CC_OWNER = email;
    process.env.HOME = path.join(temp, 'home', userKey(email));
    await mkdir(process.env.HOME, { recursive: true });
    resetSharesTable();
    await initializeDatabase();
    if (!used.includes(email)) used.push(email);
  };
  process.env.JARVIS_WEB_URL = 'http://127.0.0.1:9';
  process.env.JARVIS_CC_TOKEN = 'test-token';
  process.env.JARVIS_JFS_ROOT = path.join(temp, 'jfs');
  process.env.JARVIS_SHARES_SCHEMA = sharesSchema;
  process.env.JARVIS_CONFIG = path.join(temp, 'no-config.json');
  process.env.JARVIS_LOCALE = 'zh-HK';
  delete process.env.CLAUDE_CONFIG_DIR;
  resetJarvisInstanceConfig();
  try {
    await fn({ jfs: path.join(temp, 'jfs'), temp, as });
  } finally {
    await run(`drop schema if exists ${sharesSchema} cascade`).catch(() => {});
    for (const email of used) {
      await closeConnection();
      process.env.DATABASE_PATH = path.join(temp, `${email}.db`);
      await releaseTestDatabase();
    }
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    resetSharesTable();
    resetJarvisInstanceConfig();
    await rm(temp, { recursive: true, force: true });
  }
}

const deps = (running = false) => ({
  history: async () => HISTORY,
  isRunning: () => running,
  announce: async () => {},
});

const HISTORY = [
  { id: 'm1', kind: 'text', role: 'user', content: '寫一份報告', images: [{ data: 'data:image/png;base64,AAAA' }] },
  { id: 'm2', kind: 'tool_use', toolName: 'SendUserFile', toolId: 't1' },
  { id: 'm3', kind: 'text', role: 'assistant', content: '完成了。' },
  { id: 'm4', kind: 'text', role: 'user', content: '再改一下' },
];

/** A conversation of the current user: its transcript (P), a sent file, an upload, a script and a symlink. */
async function makeConversation(jfs: string): Promise<{ sessionId: string; providerId: string }> {
  const sessionId = randomUUID();
  const providerId = randomUUID();
  const projects = path.join(os.homedir(), '.claude', 'projects', '-workspace');
  await mkdir(path.join(projects, providerId, 'subagents'), { recursive: true });
  await writeFile(path.join(projects, providerId, 'subagents', 'agent-x.jsonl'), '{}\n');
  const rows = [
    { type: 'user', uuid: 'a0000000-0000-4000-8000-000000000001', parentUuid: null, sessionId: providerId, cwd: '/workspace', timestamp: '2026-10-22T01:00:00.000Z', message: { role: 'user', content: '寫一份報告' } },
    { type: 'assistant', uuid: 'a0000000-0000-4000-8000-000000000002', parentUuid: 'a0000000-0000-4000-8000-000000000001', sessionId: providerId, cwd: '/workspace', timestamp: '2026-10-22T01:00:01.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'SendUserFile', input: { files: ['/workspace/report.pdf'] } }] } },
    { type: 'user', uuid: 'a0000000-0000-4000-8000-000000000003', parentUuid: 'a0000000-0000-4000-8000-000000000002', sessionId: providerId, cwd: '/workspace', timestamp: '2026-10-22T01:00:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'sent' }] } },
    { type: 'assistant', uuid: 'a0000000-0000-4000-8000-000000000004', parentUuid: 'a0000000-0000-4000-8000-000000000003', sessionId: providerId, cwd: '/workspace', timestamp: '2026-10-22T01:00:03.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '完成了。' }] } },
    { type: 'user', uuid: 'a0000000-0000-4000-8000-000000000005', parentUuid: 'a0000000-0000-4000-8000-000000000004', sessionId: providerId, cwd: '/workspace', timestamp: '2026-10-22T01:00:04.000Z', message: { role: 'user', content: '再改一下' } },
  ];
  const jsonlPath = path.join(projects, `${providerId}.jsonl`);
  await writeFile(jsonlPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  await sessionsDb.createForkedSession({
    sessionId,
    provider: 'claude',
    projectPath: '/workspace',
    customName: '季度報告',
    providerSessionId: providerId,
    jsonlPath,
    forkedFromSessionId: null,
    model: null,
    effort: null,
  });
  const ws = path.join(jfs, 'ws', sessionId);
  await mkdir(path.join(ws, 'uploads'), { recursive: true });
  await writeFile(path.join(ws, 'report.pdf'), '%PDF-1.4 report');
  await writeFile(path.join(ws, 'uploads', 'photo.png'), 'PNG');
  await writeFile(path.join(ws, 'make.py'), 'print(1)');
  await writeFile(path.join(jfs, 'secret.txt'), 'other user');
  await symlink(path.join(jfs, 'secret.txt'), path.join(ws, 'link.txt'));
  return { sessionId, providerId };
}

async function serve(run: (base: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/jarvis', createJarvisSharesRouter());
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/jarvis`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('a running turn is left out of the snapshot', () => {
  const lines = [
    JSON.stringify({ type: 'user', message: { content: 'one' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'a' }] } }),
    JSON.stringify({ type: 'user', message: { content: 'two' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x' }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x' }] } }),
  ];
  assert.equal(withoutRunningTurn(lines.join('\n') + '\n'), lines.slice(0, 2).join('\n') + '\n');
  assert.deepEqual(historyWithoutRunningTurn(HISTORY).map((m) => m.id), ['m1', 'm2', 'm3']);
});

test('share, view as another user, download only sent files and uploads, continue, stop sharing', async () => {
  await withUsers(async ({ jfs, as }) => {
    await as(OWNER);
    const { sessionId, providerId } = await makeConversation(jfs);
    const link = await createShare(sessionId, deps());
    assert.match(link.url, /^\/s\/[A-Za-z0-9_-]{22}$/);
    const dir = (await shareDirOf(link.id))!;
    assert.ok(dir.startsWith(path.join(jfs, 'users', userKey(OWNER), 'shares')));
    assert.deepEqual((await listShares(sessionId)).map((s) => s.id), [link.id]);

    // the original changes afterwards: the snapshot does not
    await writeFile(path.join(jfs, 'ws', sessionId, 'report.pdf'), 'changed');

    await as(VIEWER);
    const view = await shareView(link.id);
    assert.equal(view.title, '季度報告');
    assert.equal(view.ownerName, 'owner');
    assert.equal(view.isOwner, false);
    // the history as the chat view's timeline rows, the user's image included
    const items = view.timeline.map((r) => r.item);
    assert.deepEqual(items.map((i) => i.type), ['user_message', 'tool_call', 'assistant_message', 'user_message']);
    assert.deepEqual((items[0] as { images?: unknown }).images, [{ url: 'data:image/png;base64,AAAA', mimeType: 'image/png' }]);
    assert.ok(!('messages' in view) && !('files' in view));
    // the viewer can't list or revoke the owner's links
    assert.deepEqual(await listShares(sessionId), []);
    await assert.rejects(revokeShare(link.id), { status: 404 });

    await serve(async (base) => {
      const ok = await fetch(`${base}/shares/${link.id}/files/raw?path=report.pdf`);
      assert.equal(ok.status, 200);
      assert.equal(await ok.text(), '%PDF-1.4 report');
      assert.match(ok.headers.get('content-disposition') ?? '', /^attachment/);
      assert.equal((await fetch(`${base}/shares/${link.id}/files/raw?path=uploads/photo.png&inline=1`)).status, 200);
      for (const p of ['make.py', 'link.txt', '../secret.txt', '/etc/passwd']) {
        const r = await fetch(`${base}/shares/${link.id}/files/raw?path=${encodeURIComponent(p)}`);
        assert.ok(r.status === 404 || r.status === 400, `${p} answered ${r.status}`);
      }
      assert.equal((await fetch(`${base}/shares/AAAAAAAAAAAAAAAAAAAAAA`)).status, 404);
      assert.equal((await fetch(`${base}/shares/x`)).status, 404);
    });

    // continue: a conversation of the viewer's, the whole transcript under new ids, every file, no parent
    const { sessionId: mine } = await continueShare(link.id, deps());
    const row = (await sessionsDb.getSessionById(mine))!;
    assert.equal(row.custom_name, '季度報告');
    assert.equal(row.forked_from_session_id, null);
    assert.notEqual(row.provider_session_id, providerId);
    assert.ok(row.jsonl_path!.startsWith(path.join(os.homedir(), '.claude', 'projects', '-workspace')));
    const text = await readFile(row.jsonl_path!, 'utf8');
    assert.ok(!text.includes(providerId), 'the original session id is gone');
    assert.ok(!text.includes('forkedFrom'));
    assert.ok(text.includes('再改一下'));
    for (const line of text.trim().split('\n')) {
      const o = JSON.parse(line);
      if (o.sessionId) assert.equal(o.sessionId, row.provider_session_id);
    }
    assert.equal(await readFile(path.join(os.homedir(), '.claude', 'projects', '-workspace', row.provider_session_id!, 'subagents', 'agent-x.jsonl'), 'utf8'), '{}\n');
    assert.equal(await readFile(path.join(jfs, 'ws', mine, 'report.pdf'), 'utf8'), '%PDF-1.4 report');
    assert.equal(await readFile(path.join(jfs, 'ws', mine, 'make.py'), 'utf8'), 'print(1)');
    // exactly one conversation in the viewer's list, and its message chain intact
    assert.deepEqual((await sessionsDb.getAllSessions()).map((s) => s.session_id), [mine]);
    const rows = text.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(rows[0].parentUuid, null);
    for (let i = 1; i < rows.length; i++) assert.equal(rows[i].parentUuid, rows[i - 1].uuid);
    assert.ok(!text.includes('a0000000-0000-4000-8000-00000000000'), 'message ids are new');

    // the owner stops sharing: the link is gone for everyone and the snapshot deleted; the continued one stays
    await as(OWNER);
    assert.equal((await shareView(link.id)).isOwner, true);
    await revokeShare(link.id);
    await assert.rejects(shareView(link.id), { status: 404 });
    await assert.rejects(stat(dir), { code: 'ENOENT' });
    assert.deepEqual(await listShares(sessionId), []);
    await as(VIEWER);
    await assert.rejects(continueShare(link.id, deps()), { status: 404 });
    assert.ok(await sessionsDb.getSessionById(mine));
  });
});

test('nothing to share before an answer; a running turn is not in the link; deleting the conversation stops its links', async () => {
  await withUsers(async ({ jfs, as }) => {
    await as(OWNER);
    const { sessionId } = await makeConversation(jfs);
    await assert.rejects(createShare(sessionId, { ...deps(), history: async () => [HISTORY[0]!] }), { status: 400, code: 'NOTHING_TO_SHARE' });
    await assert.rejects(createShare(randomUUID(), deps()), { status: 404 });

    const link = await createShare(sessionId, deps(true));
    const view = await shareView(link.id);
    assert.deepEqual(view.timeline.map((r) => r.item.type), ['user_message', 'tool_call', 'assistant_message']);
    const transcript = await readFile(path.join((await shareDirOf(link.id))!, 'transcript.jsonl'), 'utf8');
    assert.ok(!transcript.includes('再改一下'));

    const second = await createShare(sessionId, deps());
    assert.equal((await listShares(sessionId)).length, 2);
    await onConversationDeleted(sessionId, { release: async () => {}, removeDir: async () => {}, revokeShares: (await import('@/modules/jarvis/jarvis-shares.js')).revokeSharesOf });
    await assert.rejects(shareView(link.id), { status: 404 });
    await assert.rejects(shareView(second.id), { status: 404 });
  });
});
