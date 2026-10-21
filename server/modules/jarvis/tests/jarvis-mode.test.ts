import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { releaseTestDatabase } from '@/modules/database/testing.js';
import { ensureJarvisProject, ensureJarvisUser } from '@/modules/jarvis/jarvis-bootstrap.js';
import { conversationWorkspaceDir, jarvisLocale, jarvisModel, jarvisProductName, jarvisSessionName, resetJarvisInstanceConfig } from '@/modules/jarvis/jarvis-config.js';
import { onConversationDeleted, onConversationForked, recordJarvisFailedTurn, stageAttachmentsInWorkspace } from '@/modules/jarvis/jarvis-conversations.js';
import { readableClaudeApiError, readableSandboxError, SandboxServiceError } from '@/modules/jarvis/jarvis-errors.js';
import { createJarvisFilesRouter, listWorkspaceFiles, openWorkspaceFile } from '@/modules/jarvis/jarvis-files.routes.js';
import { isUnavailableInJarvis, jarvisApiGuard } from '@/modules/jarvis/jarvis-guard.js';
import { createJarvisWarmRouter, forwardWarm } from '@/modules/jarvis/jarvis-warm.routes.js';
import { providerAuthService } from '@/modules/providers/services/provider-auth.service.js';
import { createProviderModelsService } from '@/modules/providers/services/provider-models.service.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';

const OWNER = 'staff@yyc.example';

/** Jarvis env for one test, a private database schema, and a temp JuiceFS root. */
async function withJarvis(run: (ctx: { jfs: string; webUrl: string; calls: Array<{ path: string; body: any }> }) => Promise<void>): Promise<void> {
  const saved = { ...process.env };
  const temp = await mkdtemp(path.join(os.tmpdir(), 'jarvis-mode-'));
  const calls: Array<{ path: string; body: any }> = [];
  const stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push({ path: req.url ?? '', body: body ? JSON.parse(body) : null });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', () => resolve()));
  const webUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;

  await closeConnection();
  process.env.DATABASE_PATH = path.join(temp, 'auth.db');
  process.env.JARVIS_WEB_URL = webUrl;
  process.env.JARVIS_CC_TOKEN = 'test-token';
  process.env.JARVIS_CC_OWNER = OWNER;
  process.env.JARVIS_JFS_ROOT = path.join(temp, 'jfs');
  process.env.JARVIS_MODEL = 'claude-sonnet-5-5';
  process.env.JARVIS_MODEL_LABEL = 'Sonnet 5.5';
  delete process.env.JARVIS_PRODUCT_NAME;
  delete process.env.JARVIS_LOCALE;
  process.env.JARVIS_CONFIG = path.join(temp, 'no-config.json');
  resetJarvisInstanceConfig();
  await initializeDatabase();
  try {
    await run({ jfs: path.join(temp, 'jfs'), webUrl, calls });
  } finally {
    await releaseTestDatabase();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    await new Promise<void>((resolve) => stub.close(() => resolve()));
    await rm(temp, { recursive: true, force: true });
  }
}

async function serve(app: express.Express, run: (base: string) => Promise<void>): Promise<void> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('the guard refuses requests without the owner and the routes staff do not use', async () => {
  await withJarvis(async () => {
    const app = express();
    app.use('/api', jarvisApiGuard);
    app.use('/api', (_req, res) => { res.json({ reached: true }); });
    await serve(app, async (base) => {
      assert.equal((await fetch(`${base}/api/providers/sessions/recent`)).status, 403);
      assert.equal((await fetch(`${base}/api/providers/sessions/recent`, { headers: { 'x-jarvis-user': 'other@yyc.example' } })).status, 403);
      const ok = await fetch(`${base}/api/providers/sessions/recent`, { headers: { 'x-jarvis-user': 'Staff@YYC.example' } });
      assert.equal(ok.status, 200);
      const gone = await fetch(`${base}/api/projects/create-project`, { method: 'POST', headers: { 'x-jarvis-user': OWNER } });
      assert.equal(gone.status, 404);
      assert.equal(((await gone.json()) as { error: { code: string } }).error.code, 'NOT_AVAILABLE');
    });
  });
  assert.equal(isUnavailableInJarvis('POST', '/auth/login'), true);
  assert.equal(isUnavailableInJarvis('GET', '/auth/status'), false);
  assert.equal(isUnavailableInJarvis('GET', '/providers/claude/models'), false);
  assert.equal(isUnavailableInJarvis('POST', '/providers/claude/models'), true);
  assert.equal(isUnavailableInJarvis('PUT', '/providers/claude/models/custom-only'), true);
  assert.equal(isUnavailableInJarvis('POST', '/providers/claude/sessions/x/active-model'), false);
  assert.equal(isUnavailableInJarvis('GET', '/providers/claude/mcp/servers'), true);
  assert.equal(isUnavailableInJarvis('POST', '/providers/mcp/servers/global'), true);
  assert.equal(isUnavailableInJarvis('GET', '/providers/claude/skills'), false);
  assert.equal(isUnavailableInJarvis('DELETE', '/providers/claude/skills/x'), true);
  assert.equal(isUnavailableInJarvis('DELETE', '/projects/abc'), true);
  assert.equal(isUnavailableInJarvis('POST', '/projects/clone'), true);
  assert.equal(isUnavailableInJarvis('POST', '/projects/abc/toggle-star'), false);
  assert.equal(isUnavailableInJarvis('DELETE', '/providers/sessions/abc'), false);
  assert.equal(isUnavailableInJarvis('POST', '/system/update'), true);
  assert.equal(isUnavailableInJarvis('GET', '/settings/api-keys'), true);
  assert.equal(isUnavailableInJarvis('GET', '/settings/notification-preferences'), false);
  assert.equal(isUnavailableInJarvis('GET', '/user/git-config'), true);
  assert.equal(isUnavailableInJarvis('GET', '/user/preferences'), false);
});

test('the guard lets everything through outside Jarvis mode', async () => {
  const app = express();
  app.use('/api', jarvisApiGuard);
  app.use('/api', (_req, res) => { res.json({ reached: true }); });
  await serve(app, async (base) => {
    assert.equal((await fetch(`${base}/api/projects/create-project`, { method: 'POST' })).status, 200);
  });
});

test('start-up creates the owner and the /workspace project once, and refuses a schema of another user', async () => {
  await withJarvis(async () => {
    const first = await ensureJarvisUser();
    const again = await ensureJarvisUser();
    assert.equal(first.username, OWNER);
    assert.equal(again.id, first.id);
    assert.equal(await userDb.hasCompletedOnboarding(first.id), true);

    await ensureJarvisProject();
    await ensureJarvisProject();
    const projects = await projectsDb.getProjectPaths();
    assert.deepEqual(projects.map((p) => [p.project_path, p.custom_project_name]), [['/workspace', 'YYC AI']]);

    process.env.JARVIS_PRODUCT_NAME = 'Acme AI';
    await ensureJarvisProject();
    assert.equal(await projectsDb.getCustomProjectName('/workspace'), 'Acme AI');

    process.env.JARVIS_CC_OWNER = 'someone.else@yyc.example';
    await assert.rejects(ensureJarvisUser(), /belongs to staff@yyc\.example/);
  });
});

test('the instance has one model and no per-session model or effort choice', async () => {
  await withJarvis(async () => {
    const service = createProviderModelsService({
      resolveProvider: () => ({
        models: {
          getSupportedModels: async () => ({ OPTIONS: [{ value: 'opus', label: 'Opus' }], DEFAULT: 'opus' }),
          getCurrentActiveModel: async () => ({ model: 'opus' }),
        },
      }),
    });
    const catalog = await service.getProviderModels('claude');
    assert.deepEqual(catalog.OPTIONS.map((o) => [o.value, o.label]), [['claude-sonnet-5-5', 'Sonnet 5.5']]);
    assert.equal(catalog.DEFAULT, 'claude-sonnet-5-5');
    assert.deepEqual(catalog.EFFORT_LEVELS, []);
    assert.equal((await service.resolveSessionModel('claude', { sessionId: 's1', requestedModel: 'opus' })).model, 'claude-sonnet-5-5');
    assert.equal(await service.resolveResumeModel('claude', 's1', 'opus'), 'claude-sonnet-5-5');
    assert.equal(await service.setSessionEffort('claude', 's1', 'high'), null);
  });
});

test('Claude counts as installed and signed in (the sandbox and egress hold both)', async () => {
  await withJarvis(async () => {
    const status = await providerAuthService.getProviderAuthStatus('claude');
    assert.equal(status.installed, true);
    assert.equal(status.authenticated, true);
    assert.equal(status.email, OWNER);
  });
});

test('workspace files: listing skips symlinks; downloads never leave the folder', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'jarvis-files-'));
  try {
    const root = path.join(temp, 'ws');
    const outside = path.join(temp, 'secret');
    await mkdir(path.join(root, 'reports'), { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(outside, 'key.txt'), 'other user data');
    await writeFile(path.join(root, 'a.txt'), 'hello');
    await writeFile(path.join(root, 'reports', '報告.pdf'), '%PDF-1.4');
    await symlink(path.join(outside, 'key.txt'), path.join(root, 'link.txt'));
    await symlink(outside, path.join(root, 'linkdir'));

    const files = await listWorkspaceFiles(root);
    assert.deepEqual(files.map((f) => [f.path, f.size]), [['a.txt', 5], ['reports/報告.pdf', 8]]);
    assert.deepEqual(await listWorkspaceFiles(path.join(temp, 'missing')), []);

    const opened = await openWorkspaceFile(root, 'reports/報告.pdf');
    assert.equal(opened.size, 8);
    await opened.handle.close();
    for (const bad of ['link.txt', 'linkdir/key.txt', '../secret/key.txt', '/etc/passwd', 'reports/../../secret/key.txt', 'nope.txt']) {
      await assert.rejects(openWorkspaceFile(root, bad), (error: Error & { status?: number }) => error.status === 404 || error.status === 400, bad);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('workspace file routes serve only this user\'s sessions, as attachments unless previewable', async () => {
  await withJarvis(async ({ jfs }) => {
    const sessionId = randomUUID();
    await sessionsDb.createAppSession(sessionId, 'claude', '/workspace', 'Files');
    const ws = path.join(jfs, 'ws', sessionId);
    await mkdir(ws, { recursive: true });
    await writeFile(path.join(ws, 'chart.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(path.join(ws, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await writeFile(path.join(ws, 'notes 筆記.txt'), 'hi');

    const app = express();
    app.use('/api/jarvis', createJarvisFilesRouter());
    await serve(app, async (base) => {
      const list = (await (await fetch(`${base}/api/jarvis/sessions/${sessionId}/files`)).json()) as { files: Array<{ path: string; mtime: string }> };
      assert.deepEqual(list.files.map((f: { path: string }) => f.path), ['chart.png', 'logo.svg', 'notes 筆記.txt']);
      assert.equal(typeof list.files[0].mtime, 'string');

      const png = await fetch(`${base}/api/jarvis/sessions/${sessionId}/files/raw?path=chart.png&inline=1`);
      assert.equal(png.status, 200);
      assert.equal(png.headers.get('content-type'), 'image/png');
      assert.match(png.headers.get('content-disposition') ?? '', /^inline;/);
      assert.equal(png.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(Buffer.from(await png.arrayBuffer()).length, 4);

      const svg = await fetch(`${base}/api/jarvis/sessions/${sessionId}/files/raw?path=logo.svg&inline=1`);
      assert.match(svg.headers.get('content-disposition') ?? '', /^attachment;/);
      await svg.arrayBuffer();

      const txt = await fetch(`${base}/api/jarvis/sessions/${sessionId}/files/raw?path=${encodeURIComponent('notes 筆記.txt')}`);
      assert.match(txt.headers.get('content-disposition') ?? '', /filename\*=UTF-8''notes%20%E7%AD%86%E8%A8%98\.txt/);
      assert.equal(await txt.text(), 'hi');

      assert.equal((await fetch(`${base}/api/jarvis/sessions/${sessionId}/files/raw?path=..%2Fx`)).status, 400);
      assert.equal((await fetch(`${base}/api/jarvis/sessions/${sessionId}/files/raw?path=missing.txt`)).status, 404);
      assert.equal((await fetch(`${base}/api/jarvis/sessions/${randomUUID()}/files`)).status, 404);
      assert.equal((await fetch(`${base}/api/jarvis/sessions/not-a-uuid/files`)).status, 404);
    });
  });
});

test('deleting a conversation releases its sandbox and removes its files; archiving keeps both', async () => {
  await withJarvis(async ({ jfs, calls }) => {
    const sessionId = randomUUID();
    await sessionsDb.createAppSession(sessionId, 'claude', '/workspace', 'Delete me');
    const ws = path.join(jfs, 'ws', sessionId);
    await mkdir(ws, { recursive: true });
    await writeFile(path.join(ws, 'f.txt'), 'x');

    await sessionsService.deleteOrArchiveSessionById(sessionId);
    assert.deepEqual(calls, []);
    assert.equal(await readFile(path.join(ws, 'f.txt'), 'utf8'), 'x');

    await sessionsService.deleteOrArchiveSessionById(sessionId, { force: true });
    assert.deepEqual(calls, [{ path: '/internal/cc/release', body: { conversation: sessionId } }]);
    await assert.rejects(readFile(path.join(ws, 'f.txt')), /ENOENT/);
    assert.equal(await sessionsDb.getSessionById(sessionId), null);
  });
});

test('a failed release still removes the files; ids that are not conversations touch nothing', async () => {
  await withJarvis(async ({ jfs }) => {
    const order: string[] = [];
    const id = randomUUID();
    await onConversationDeleted(id, {
      release: async () => { order.push('release'); throw new Error('down'); },
      removeDir: async (dir) => { order.push(`rm ${path.relative(jfs, dir)}`); },
    });
    assert.deepEqual(order, ['release', `rm ws/${id}`]);

    order.length = 0;
    await onConversationDeleted('../../users', {
      release: async () => { order.push('release'); },
      removeDir: async () => { order.push('rm'); },
    });
    assert.deepEqual(order, []);
    assert.throws(() => conversationWorkspaceDir('../x'), /not a conversation id/);
  });
});

test('a fork starts with a copy of the conversation\'s files', async () => {
  await withJarvis(async ({ jfs }) => {
    const from = randomUUID();
    const to = randomUUID();
    await mkdir(path.join(jfs, 'ws', from, 'sub'), { recursive: true });
    await writeFile(path.join(jfs, 'ws', from, 'sub', 'a.txt'), 'A');
    await onConversationForked(from, to);
    assert.equal(await readFile(path.join(jfs, 'ws', to, 'sub', 'a.txt'), 'utf8'), 'A');
    await onConversationForked(randomUUID(), randomUUID());
  });
});

test('new sessions always belong to /workspace', async () => {
  await withJarvis(async () => {
    const created = await sessionsService.createAppSession('claude', '/home/someone/project', 'hello there');
    assert.equal((await sessionsDb.getSessionById(created.sessionId))?.project_path, '/workspace');
  });
});

test('the instance config fills what the environment leaves unset', async () => {
  await withJarvis(async ({ jfs }) => {
    const config = path.join(jfs, 'config.json');
    await mkdir(jfs, { recursive: true });
    await writeFile(config, JSON.stringify({ product: { name: '測試 AI', locale: 'zh-HK' }, models: [{ id: 'anthropic/claude-sonnet-5.5', label: 'Sonnet 5.5' }], defaultModel: 'anthropic/claude-sonnet-5.5' }));
    process.env.JARVIS_CONFIG = config;
    delete process.env.JARVIS_MODEL;
    delete process.env.JARVIS_MODEL_LABEL;
    resetJarvisInstanceConfig();
    assert.equal(jarvisProductName(), '測試 AI');
    assert.equal(jarvisLocale(), 'zh-HK');
    assert.deepEqual(jarvisModel(), { value: 'anthropic/claude-sonnet-5.5', label: 'Sonnet 5.5' });
    process.env.JARVIS_MODEL_LABEL = 'Override';
    assert.equal(jarvisModel().label, 'Override');
    resetJarvisInstanceConfig();
  });
});

test('sandbox and model failures read as sentences', () => {
  const saved = process.env.JARVIS_LOCALE;
  process.env.JARVIS_CONFIG = '/nonexistent/config.json';
  resetJarvisInstanceConfig();
  try {
    delete process.env.JARVIS_LOCALE;
    const budget = 'API Error: 402 {"type":"error","error":{"type":"budget_exceeded","message":"Deyao has set a USD 50 budget limit and it has now been used up."}}';
    assert.equal(readableClaudeApiError(budget), 'Deyao has set a USD 50 budget limit and it has now been used up.');
    assert.equal(readableClaudeApiError('API Error: 402 The administrator has set a USD 50 budget limit and it has now been used up.'), 'The administrator has set a USD 50 budget limit and it has now been used up.');
    assert.match(readableClaudeApiError('API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"x"}}') ?? '', /Too many requests/);
    assert.match(readableClaudeApiError('API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}') ?? '', /busy or unavailable/);
    assert.match(readableClaudeApiError('API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long"}}') ?? '', /refused this request: prompt is too long/);
    assert.match(readableClaudeApiError('API Error: Connection error.') ?? '', /Could not reach the AI model/);
    assert.equal(readableClaudeApiError('The API Error page says hi'), null);
    assert.equal(readableClaudeApiError('All good.'), null);

    assert.match(readableSandboxError(new SandboxServiceError(0, 'fetch failed')), /Could not reach the computer/);
    assert.match(readableSandboxError(new SandboxServiceError(503, 'no capacity')), /busy/);
    assert.match(readableSandboxError(new SandboxServiceError(403, 'not a user of this instance')), /not allowed/);
    assert.match(readableSandboxError(new Error('Claude Code process exited with code 1')), /Could not start the computer/);

    process.env.JARVIS_LOCALE = 'zh-HK';
    assert.equal(readableSandboxError(new SandboxServiceError(503, 'x')), '所有電腦正在使用中，請過幾分鐘再試。');
    assert.equal(readableClaudeApiError('API Error: 402 {}'), '此服務的使用預算已用完，請聯絡管理員。');
    assert.equal(readableClaudeApiError('API Error: 402'), '此服務的使用預算已用完，請聯絡管理員。');
  } finally {
    if (saved === undefined) delete process.env.JARVIS_LOCALE; else process.env.JARVIS_LOCALE = saved;
  }
});

test('the synchronizer indexes only the /workspace project\'s transcripts', async () => {
  await withJarvis(async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'jarvis-home-'));
    const savedHome = process.env.HOME;
    try {
      process.env.HOME = home;
      const { ClaudeSessionSynchronizer } = await import('@/modules/providers/list/claude/claude-session-synchronizer.provider.js');
      const ws = randomUUID();
      const other = randomUUID();
      const row = (sessionId: string, cwd: string) => `${JSON.stringify({ type: 'user', sessionId, cwd, uuid: randomUUID(), timestamp: '2026-10-21T10:00:00.000Z', message: { role: 'user', content: 'hi' } })}\n`;
      await mkdir(path.join(home, '.claude', 'projects', '-workspace'), { recursive: true });
      await mkdir(path.join(home, '.claude', 'projects', '-tmp'), { recursive: true });
      await writeFile(path.join(home, '.claude', 'projects', '-workspace', `${ws}.jsonl`), row(ws, '/workspace'));
      await writeFile(path.join(home, '.claude', 'projects', '-tmp', `${other}.jsonl`), row(other, '/tmp'));

      const synchronizer = new ClaudeSessionSynchronizer();
      assert.equal(await synchronizer.synchronize(), 1);
      assert.equal((await sessionsDb.getSessionById(ws))?.project_path, '/workspace');
      assert.equal(await sessionsDb.getSessionById(other), null);
      assert.equal(await synchronizer.synchronizeFile(path.join(home, '.claude', 'projects', '-tmp', `${other}.jsonl`)), null);
    } finally {
      process.env.HOME = savedHome;
      await rm(home, { recursive: true, force: true });
    }
  });
});

test('attached files are copied into the conversation\'s /workspace/uploads for the sandbox', async () => {
  await withJarvis(async ({ jfs }) => {
    const sessionId = randomUUID();
    const src = path.join(jfs, 'upload-src');
    await mkdir(src, { recursive: true });
    await writeFile(path.join(src, 'stored-1'), 'one');
    await writeFile(path.join(src, 'stored-2'), 'two');
    const staged = await stageAttachmentsInWorkspace(sessionId, [
      { path: path.join(src, 'stored-1'), name: '報告.pdf' },
      { path: path.join(src, 'stored-2'), name: '報告.pdf' },
      { path: path.join(src, 'missing'), name: 'gone.txt' },
    ]) as Array<{ path: string; name: string }>;
    assert.deepEqual(staged.map((f) => f.path), ['/workspace/uploads/報告.pdf', '/workspace/uploads/報告 (2).pdf', path.join(src, 'missing')]);
    assert.equal(await readFile(path.join(jfs, 'ws', sessionId, 'uploads', '報告 (2).pdf'), 'utf8'), 'two');
  });
});

test('a failed turn keeps the user\'s message and the error in the history, the error after the message', async () => {
  await withJarvis(async () => {
    const created = await sessionsService.createAppSession('claude', '/workspace', '寫一份新聞稿');
    const sentAt = new Date(Date.now() + 5000).toISOString(); // a client clock ahead of the server's
    const times = await recordJarvisFailedTurn({ sessionId: created.sessionId, userText: '寫一份新聞稿', sentAt, receivedAt: Date.now(), error: 'busy' });
    assert.equal(times.userAt, sentAt);
    assert.ok(Date.parse(times.errorAt) > Date.parse(sentAt));
    await recordJarvisFailedTurn({ sessionId: created.sessionId, userText: null, receivedAt: Date.now(), error: 'broke mid-run' });

    const history = await sessionsService.fetchHistory(created.sessionId);
    // in time order: the second failure happened at the server's now, before the skewed client's message
    assert.deepEqual(history.messages.map((m) => [m.kind, m.role ?? null, m.content]), [
      ['error', null, 'broke mid-run'],
      ['text', 'user', '寫一份新聞稿'],
      ['error', null, 'busy'],
    ]);
    assert.equal(history.total, 3);
    const lastPage = await sessionsService.fetchHistory(created.sessionId, { limit: 1, offset: 0 });
    assert.equal(lastPage.messages.length, 1);
    assert.equal(lastPage.hasMore, true);
  });
});

test('conversation names: the first characters of the message, or a placeholder in the instance language', async () => {
  await withJarvis(async () => {
    process.env.JARVIS_LOCALE = 'zh-HK';
    assert.equal(jarvisSessionName(''), '新對話');
    assert.equal(jarvisSessionName('請幫我整理今天關於元意顧問客戶的所有新聞報道並寫一份摘要'), '請幫我整理今天關於元意顧問客戶的所有新聞報道並寫…');
    assert.equal(jarvisSessionName('  short   text '), 'short text');
    const created = await sessionsService.createAppSession('claude', '/workspace', '');
    assert.equal((await sessionsDb.getSessionById(created.sessionId))?.custom_name, '新對話');
    delete process.env.JARVIS_LOCALE;
    assert.equal(jarvisSessionName(''), 'New conversation');
  });
});

test('typing warms a sandbox host: forwarded to web as the owner, at most once per conversation per interval', async () => {
  await withJarvis(async ({ calls }) => {
    const conv = randomUUID();
    let t = 0;
    const forwarded: Array<Promise<boolean>> = [];
    const app = express();
    app.use(express.json());
    app.use('/api/jarvis', createJarvisWarmRouter((c) => {
      const p = forwardWarm(c);
      forwarded.push(p);
      return p;
    }, 30_000, () => t));
    await serve(app, async (base) => {
      const warm = (body: unknown) => fetch(`${base}/api/jarvis/warm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const first = await warm({});
      assert.equal(first.status, 202);
      await first.arrayBuffer();
      await (await warm({})).arrayBuffer(); // same new chat, within the interval
      await (await warm({ sessionId: conv.toUpperCase() })).arrayBuffer();
      await (await warm({ sessionId: conv })).arrayBuffer();
      await (await warm({ sessionId: 'not-a-uuid' })).arrayBuffer(); // counts as a new chat: throttled
      t = 30_000;
      await (await warm({ sessionId: conv })).arrayBuffer();
    });
    assert.deepEqual(await Promise.all(forwarded), [true, true, true]);
    const warms = calls.filter((c) => c.path === '/internal/cc/warm').map((c) => c.body);
    assert.deepEqual(warms, [{ owner: OWNER }, { owner: OWNER, conversation: conv }, { owner: OWNER, conversation: conv }]);
  });
});

test('a warm that cannot reach web fails quietly', async () => {
  await withJarvis(async () => {
    process.env.JARVIS_WEB_URL = 'http://127.0.0.1:1';
    assert.equal(await forwardWarm(null), false);
  });
});
