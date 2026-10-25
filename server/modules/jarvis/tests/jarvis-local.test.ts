import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { releaseTestDatabase } from '@/modules/database/testing.js';
import { ensureJarvisProject, ensureJarvisUser } from '@/modules/jarvis/jarvis-bootstrap.js';
import {
  conversationFilesRoot,
  conversationUploads,
  conversationWorkspaceDir,
  jarvisEnabled,
  jarvisLocal,
  jarvisLocalPermissionMode,
  jarvisProjectDirName,
  jarvisTranscriptPath,
  jarvisWorkspacePath,
  resetJarvisInstanceConfig,
} from '@/modules/jarvis/jarvis-config.js';
import { onConversationDeleted, onConversationForked, stageAttachmentsInWorkspace } from '@/modules/jarvis/jarvis-conversations.js';
import { createJarvisFilesRouter } from '@/modules/jarvis/jarvis-files.routes.js';
import { createJarvisLocalRouter } from '@/modules/jarvis/jarvis-local.routes.js';
import { sentPathToWorkspaceRelative } from '@/modules/jarvis/jarvis-sent-files.js';
import { isUnavailableInJarvis, jarvisApiGuard } from '@/modules/jarvis/jarvis-guard.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { queryClaudeSDK } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

const OWNER = 'deyao@example.org';

/** Local Jarvis mode (a Jarvis 4 session) for one test: a temp HOME with a workspace, a private database schema. */
async function withLocal(run: (ctx: { home: string; workspace: string }) => Promise<void>): Promise<void> {
  const saved = { ...process.env };
  const temp = await mkdtemp(path.join(os.tmpdir(), 'jarvis-local-'));
  const home = path.join(temp, 'home');
  const workspace = path.join(home, 'workspace', 'repo');
  await mkdir(workspace, { recursive: true });
  await closeConnection();
  process.env.HOME = home;
  process.env.DATABASE_PATH = path.join(temp, 'auth.db');
  delete process.env.JARVIS_WEB_URL;
  delete process.env.JARVIS_CC_TOKEN;
  process.env.JARVIS_LOCAL_WORKSPACE = workspace;
  process.env.JARVIS_CC_OWNER = OWNER;
  process.env.JARVIS_PRODUCT_NAME = 'Jarvis 4';
  process.env.JARVIS_MODEL = 'claude-opus-5-5';
  process.env.JARVIS_MODEL_LABEL = 'Opus 5.5';
  process.env.JARVIS_CONFIG = path.join(temp, 'no-config.json');
  delete process.env.JARVIS_LOCAL_UPLOADS;
  delete process.env.JARVIS_LOCAL_PERMISSION_MODE;
  delete process.env.JARVIS_LOCAL_PERMISSION_FILE;
  resetJarvisInstanceConfig();
  await initializeDatabase();
  try {
    await run({ home, workspace });
  } finally {
    await releaseTestDatabase();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
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

test('local mode: Jarvis mode with the session workspace as the one project', async () => {
  await withLocal(async ({ home, workspace }) => {
    assert.equal(jarvisLocal(), true);
    assert.equal(jarvisEnabled(), true);
    assert.equal(jarvisWorkspacePath(), workspace);
    assert.equal(jarvisProjectDirName(), workspace.replace(/[^a-zA-Z0-9]/g, '-'));
    assert.equal(jarvisTranscriptPath('abc'), path.join(home, '.claude', 'projects', jarvisProjectDirName(), 'abc.jsonl'));

    await ensureJarvisUser();
    await ensureJarvisProject();
    const projects = await projectsDb.getProjectPaths();
    assert.deepEqual(projects.map((p) => [p.project_path, p.custom_project_name]), [[workspace, 'Jarvis 4']]);
    const created = await sessionsService.createAppSession('claude', '/elsewhere', 'hello');
    assert.equal((await sessionsDb.getSessionById(created.sessionId))?.project_path, workspace);
  });
});

test('local mode: no X-Jarvis-User needed, and no share links', async () => {
  await withLocal(async () => {
    const app = express();
    app.use('/api', jarvisApiGuard);
    app.use('/api', (_req, res) => { res.json({ reached: true }); });
    await serve(app, async (base) => {
      assert.equal((await fetch(`${base}/api/providers/sessions/recent`)).status, 200);
      assert.equal((await fetch(`${base}/api/jarvis/sessions/${randomUUID()}/shares`, { method: 'POST' })).status, 404);
      assert.equal((await fetch(`${base}/api/jarvis/shares/abc`)).status, 404);
      assert.equal((await fetch(`${base}/api/projects/create-project`, { method: 'POST' })).status, 404);
    });
    assert.equal(isUnavailableInJarvis('GET', '/jarvis/sessions/x/files'), false);
  });
  // sandbox mode keeps its share links
  assert.equal(isUnavailableInJarvis('POST', '/jarvis/sessions/x/shares'), false);
});

test('local mode: deleting or forking a conversation never touches the machine\'s folders', async () => {
  await withLocal(async ({ workspace }) => {
    await writeFile(path.join(workspace, 'keep.txt'), 'k');
    const id = randomUUID();
    const order: string[] = [];
    await onConversationDeleted(id, {
      release: async () => { order.push('release'); },
      removeDir: async () => { order.push('rm'); },
      revokeShares: async () => { order.push('revoke'); },
    });
    assert.deepEqual(order, []);
    await sessionsDb.createAppSession(id, 'claude', workspace, 'Delete me');
    await sessionsService.deleteOrArchiveSessionById(id, { force: true });
    assert.equal(await readFile(path.join(workspace, 'keep.txt'), 'utf8'), 'k');
    await onConversationForked(id, randomUUID());
    assert.throws(() => conversationWorkspaceDir(id), /no folder of their own/);
  });
});

test('local mode: attachments go to ~/uploads (or JARVIS_LOCAL_UPLOADS), outside the workspace', async () => {
  await withLocal(async ({ home, workspace }) => {
    const id = randomUUID();
    const src = path.join(home, 'tmp-upload.pdf');
    await writeFile(src, 'pdf');
    const staged = (await stageAttachmentsInWorkspace(id, [{ path: src, name: 'report.pdf' }])) as Array<{ path: string }>;
    assert.equal(staged[0]!.path, path.join(home, 'uploads', 'report.pdf'));
    assert.equal(await readFile(path.join(home, 'uploads', 'report.pdf'), 'utf8'), 'pdf');
    assert.deepEqual(conversationUploads(id), { dir: path.join(home, 'uploads'), claudePath: path.join(home, 'uploads') });

    process.env.JARVIS_LOCAL_UPLOADS = path.join(home, 'elsewhere');
    assert.equal(conversationUploads(id).dir, path.join(home, 'elsewhere'));
    assert.ok(!conversationUploads(id).dir.startsWith(workspace));
  });
});

test('local mode: sent files are read from the home folder, relative paths from the workspace', async () => {
  await withLocal(async ({ home, workspace }) => {
    const id = randomUUID();
    assert.deepEqual(conversationFilesRoot(id), { dir: home, claudePath: home });
    assert.equal(sentPathToWorkspaceRelative(path.join(home, 'artifacts', 'a.png')), 'artifacts/a.png');
    assert.equal(sentPathToWorkspaceRelative('out/b.pdf'), path.posix.join(path.relative(home, workspace), 'out/b.pdf'));
    assert.equal(sentPathToWorkspaceRelative('/etc/passwd'), null);
    assert.equal(sentPathToWorkspaceRelative('../../../../etc/passwd'), null);

    // the routes serve a file Claude sent from ~/artifacts
    const transcriptDir = path.join(home, '.claude', 'projects', jarvisProjectDirName());
    await mkdir(transcriptDir, { recursive: true });
    await mkdir(path.join(home, 'artifacts'), { recursive: true });
    await writeFile(path.join(home, 'artifacts', 'a.txt'), 'A!');
    const providerId = randomUUID();
    const lines = [
      { type: 'assistant', timestamp: '2026-10-25T10:00:00.000Z', message: { content: [{ type: 'tool_use', id: 't1', name: 'SendUserFile', input: { files: [path.join(home, 'artifacts', 'a.txt')] } }] } },
      { type: 'user', timestamp: '2026-10-25T10:00:01.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    ];
    await writeFile(path.join(transcriptDir, `${providerId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    await sessionsDb.createAppSession(id, 'claude', workspace, 'Files');
    await sessionsDb.assignProviderSessionId(id, providerId);
    const app = express();
    app.use('/api/jarvis', createJarvisFilesRouter());
    await serve(app, async (base) => {
      const list = (await (await fetch(`${base}/api/jarvis/sessions/${id}/files`)).json()) as { files: Array<{ path: string; size: number }> };
      assert.deepEqual(list.files.map((f) => [f.path, f.size]), [['artifacts/a.txt', 2]]);
      const raw = await fetch(`${base}/api/jarvis/sessions/${id}/files/raw?path=artifacts/a.txt`);
      assert.equal(raw.status, 200);
      assert.equal(await raw.text(), 'A!');
      assert.equal((await fetch(`${base}/api/jarvis/sessions/${id}/files/raw?path=../x`)).status, 400);
    });
  });
});

test('local mode: the session\'s permission mode, read at every turn', async () => {
  await withLocal(async ({ home }) => {
    assert.equal(jarvisLocalPermissionMode(), 'bypassPermissions');
    process.env.JARVIS_LOCAL_PERMISSION_MODE = 'auto';
    assert.equal(jarvisLocalPermissionMode(), 'auto');
    const file = path.join(home, '.permission-mode');
    process.env.JARVIS_LOCAL_PERMISSION_FILE = file;
    assert.equal(jarvisLocalPermissionMode(), 'auto', 'no file yet: the environment');
    await writeFile(file, 'bypass\n');
    assert.equal(jarvisLocalPermissionMode(), 'bypassPermissions');
    await writeFile(file, 'auto');
    assert.equal(jarvisLocalPermissionMode(), 'auto');
  });
});

test('local mode: Claude Code runs here, in the workspace, with the session\'s mode and model, and no sandbox', async () => {
  await withLocal(async ({ workspace }) => {
    const created = await sessionsService.createAppSession('claude', workspace, 'hello');
    const sent: NormalizedMessage[] = [];
    let options: any = null;
    const context = {
      resolveProviderSessionId: async () => null,
      resolveResumeModel: async () => undefined,
      getProviderModels: async () => [],
      normalizeMessage: () => [],
      isProviderInstalled: async () => true,
      createQuery: (q: { options: unknown }) => {
        options = q.options;
        return (async function* () { /* no output */ })();
      },
    } as unknown as ProviderRuntimeContext;
    const writer = { send: (m: NormalizedMessage) => { sent.push(m); }, userId: null };
    await queryClaudeSDK('hello', { sessionId: created.sessionId, cwd: '/somewhere', permissionMode: 'default', model: 'claude-haiku-5-5' }, writer as never, context);

    assert.ok(options, 'Claude Code was started');
    assert.equal(options.cwd, workspace);
    assert.equal(options.permissionMode, 'bypassPermissions');
    assert.equal(options.allowDangerouslySkipPermissions, true);
    assert.equal(options.model, 'claude-opus-5-5');
    assert.equal(options.spawnClaudeCodeProcess, undefined);
    assert.equal(sent.some((m) => (m as any).jarvisSandbox), false, 'no sandbox wait');
  });
});

test('local mode: Jarvis delivers prompts into the main conversation, made on first use, never into a running turn', async () => {
  await withLocal(async ({ workspace }) => {
    await ensureJarvisUser();
    await ensureJarvisProject();
    const runs: Array<{ command: string; sessionId: string }> = [];
    let release: () => void = () => {};
    const runtime = {
      hasRuntime: () => true,
      run: async (_provider: string, command: string, options: { sessionId: string }) => {
        runs.push({ command, sessionId: options.sessionId });
        await new Promise<void>((resolve) => { release = resolve; });
      },
      abort: async () => true,
      stopBackgroundTask: async () => false,
      hasBackgroundWork: () => false,
      resolveToolApproval: () => {},
      getPendingApprovalsForSession: () => [],
    };
    const app = express();
    app.use(express.json());
    app.use('/api/jarvis', createJarvisLocalRouter(runtime as never));
    await serve(app, async (base) => {
      const post = (content: string) => fetch(`${base}/api/jarvis/deliver`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }),
      });
      const main = async () => (await (await fetch(`${base}/api/jarvis/main`)).json()) as { sessionId: string | null; status: string };

      assert.deepEqual(await main(), { sessionId: null, providerSessionId: null, title: null, status: 'idle' });
      assert.equal((await post('  ')).status, 400);

      const first = await post('Build the thing');
      assert.equal(first.status, 202);
      const made = (await first.json()) as { sessionId: string; created: boolean };
      assert.equal(made.created, true);
      assert.equal((await sessionsDb.getSessionById(made.sessionId))?.project_path, workspace);
      for (let i = 0; i < 50 && runs.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(runs, [{ command: 'Build the thing', sessionId: made.sessionId }]);
      assert.equal((await main()).status, 'busy');

      const second = await post('wake up');
      assert.equal(second.status, 409);
      assert.deepEqual(await second.json(), { busy: true, sessionId: made.sessionId });

      release();
      for (let i = 0; i < 50 && (await main()).status === 'busy'; i++) await new Promise((r) => setTimeout(r, 20));
      const third = await post('wake up');
      assert.equal(third.status, 202);
      assert.deepEqual(await third.json(), { sessionId: made.sessionId, created: false });
      for (let i = 0; i < 50 && runs.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(runs.map((r) => r.command), ['Build the thing', 'wake up']);
      release();
      for (let i = 0; i < 50 && (await main()).status === 'busy'; i++) await new Promise((r) => setTimeout(r, 20));
    });
  });
});
