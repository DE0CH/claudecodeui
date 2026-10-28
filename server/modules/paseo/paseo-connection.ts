/**
 * One Paseo web app connection (DE0CH/claudecodeui docs/paseo-ui.md): Paseo's WebSocket protocol (the app's
 * DaemonClient, getpaseo/paseo packages/protocol messages.ts) answered from CloudCLI's own state through the hub.
 *
 * The app sees one host with one project; each conversation is a workspace holding one agent whose id is the
 * CloudCLI session id. Only what a chat app needs is implemented; everything a developer machine has (git, terminals,
 * scripts, plugins, worktrees) answers empty, and the server_info features leave it out so the app hides it.
 */
import { randomUUID } from 'node:crypto';

import type { WebSocket } from 'ws';

import {
  recordViewAs,
  VIEW_AS_NOT_RECORDED,
  VIEW_AS_READ_ONLY,
  viewerOf,
  type Viewer,
} from '@/modules/jarvis/index.js';
import { sessionsService } from '@/modules/providers/index.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';

import {
  PROJECT_ID,
  paseoHub,
  sessionIdFromWorkspace,
  workspaceIdFor,
  type HubEvent,
  type SessionRowLite,
} from './paseo-hub.js';
import type { PaseoTimelineRow } from './paseo-timeline.js';

type AnyRecord = Record<string, any>;
type ChatDependencies = Parameters<typeof paseoHub.ensureStarted>[1];

const PROTOCOL_VERSION = 1;
const SERVER_ID = 'srv_conversations';
const VERSION = '0.13.2';

const FEATURES = {
  ownedSubscriptions: true,
  explicitEventSubscriptions: true,
  selectiveAgentTimeline: true,
  providersSnapshot: true,
  providersSnapshotCwd: true,
  directorySync: true,
  workspaceMultiplicity: true,
  canonicalSubmittedPrompts: true,
  agentTimelinePromptIndex: true,
  workspaceSortTimes: true,
  stableProjectIdentity: true,
  projectList: true,
  creationLifecycle: true,
  agentRequestReceipts: true,
  workspaceRequestReceipts: true,
};

const CAPABILITIES = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsSessionListing: false,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
  supportsRewindConversation: false,
  supportsRewindFiles: false,
  supportsRewindBoth: false,
};

/** The daemon settings the app reads; nothing here is configurable from the UI. */
const DAEMON_CONFIG = {
  relay: { enabled: false, requireProtectedSecurity: false },
  mcp: { enabled: false, injectIntoAgents: false },
  hostnames: [],
  cors: { allowedOrigins: [] },
  trustedProxies: ['loopback'],
  git: { maxProcessesPerSecond: 1, maxProcessConcurrency: 1 },
  app: { baseUrl: '' },
  browserTools: { enabled: false },
  providers: {},
  metadataGeneration: { providers: [] },
  autoArchiveAfterMerge: false,
  enableTerminalAgentHooks: false,
  idleRuntimeCleanup: true,
  appendSystemPrompt: '',
  skills: {},
  pluginsEnabled: false,
  plugins: {},
  features: {
    dictation: { enabled: false, stt: { provider: 'local' } },
    voiceMode: { enabled: false, stt: { provider: 'local' }, tts: { provider: 'local' } },
  },
  envOverrides: {},
};

function nowIso(): string {
  return new Date().toISOString();
}

/** CloudCLI's SQLite-style UTC text ("2026-10-26 16:00:00") as ISO. */
function toIso(value: string): string {
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? nowIso() : parsed.toISOString();
}

export function handlePaseoConnection(ws: WebSocket, request: AuthenticatedWebSocketRequest, chat: ChatDependencies): void {
  paseoHub.ensureStarted(request, chat);
  // view as (jarvis-view-as.ts): the admin the router says is viewing as this process's user, else null
  const connection = new PaseoConnection(ws, viewerOf(request.headers ?? {}));
  const onHubEvent = (event: HubEvent) => {
    void connection.onHubEvent(event).catch((error) => console.error('[paseo] hub event failed', error));
  };
  paseoHub.on('event', onHubEvent);
  ws.on('message', (raw) => {
    void connection.onMessage(raw.toString()).catch((error) => console.error('[paseo] message failed', error));
  });
  ws.on('close', () => paseoHub.off('event', onHubEvent));
}

class PaseoConnection {
  private helloDone = false;
  private agentsSubscription: string | null = null;
  private workspacesSubscription: string | null = null;
  private projectsSubscription: string | null = null;
  private timelineSubscription: string | null = null;
  private timelineAgents = new Set<string>();
  private creations = new Map<string, string>();

  constructor(
    private readonly ws: WebSocket,
    private readonly viewer: Viewer | null = null,
  ) {}

  /** Viewing as someone: a change other than sending is refused with an rpc_error (true = refused). */
  private refuseWhileViewing(type: string, requestId: string): boolean {
    if (!this.viewer) return false;
    this.reply('rpc_error', { requestId, requestType: type, error: VIEW_AS_READ_ONLY, code: 'view_as_read_only' });
    return true;
  }

  private sendRaw(message: AnyRecord): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(JSON.stringify(message));
  }

  private send(message: AnyRecord): void {
    this.sendRaw({ type: 'session', message });
  }

  private reply(type: string, payload: AnyRecord): void {
    this.send({ type, payload });
  }

  async onMessage(raw: string): Promise<void> {
    let frame: AnyRecord;
    try {
      frame = JSON.parse(raw) as AnyRecord;
    } catch {
      return;
    }
    if (frame.type === 'ping') {
      this.sendRaw({ type: 'pong' });
      return;
    }
    if (frame.type === 'hello') {
      this.helloDone = true;
      this.send({ type: 'status', payload: this.serverInfo() });
      return;
    }
    if (frame.type !== 'session' || !frame.message || !this.helloDone) return;
    await this.onSessionMessage(frame.message as AnyRecord);
  }

  private serverInfo(): AnyRecord {
    return {
      status: 'server_info',
      protocolVersion: PROTOCOL_VERSION,
      serverId: SERVER_ID,
      hostname: paseoHub.productName,
      version: VERSION,
      sourceId: 'owner',
      permissions: ['daemon.read', 'workspace.read', 'workspace.write'],
      desktopManaged: false,
      capabilities: {
        voice: {
          dictation: { enabled: false, reason: '' },
          voice: { enabled: false, reason: '' },
        },
      },
      features: FEATURES,
    };
  }

  private async onSessionMessage(message: AnyRecord): Promise<void> {
    const type = String(message.type ?? '');
    const requestId = typeof message.requestId === 'string' ? message.requestId : '';

    switch (type) {
      case 'client_heartbeat':
      case 'abort_request':
      case 'audio_played':
        return;

      case 'subscription.release.request':
        this.reply('subscription.release.response', { requestId, subscriptionId: String(message.subscriptionId ?? '') });
        return;

      case 'session.events.set_subscription.request':
        this.reply('session.events.set_subscription.response', { requestId, subscriptionId: randomUUID() });
        return;

      case 'workspace.label.list.request':
        this.reply('workspace.label.list.response', {
          requestId,
          ...(message.subscribe ? { subscriptionId: randomUUID() } : {}),
          labels: [],
          sync: { mode: message.sync ? 'changes' : 'snapshot', generation: paseoHub.generation, headSeq: 0, removals: [] },
        });
        return;

      case 'hosts.list.request':
        this.reply('hosts.list.response', {
          requestId,
          subscriptionId: randomUUID(),
          directory: { self: { serverId: SERVER_ID, label: paseoHub.productName }, hosts: [] },
        });
        return;

      case 'usage.list_reports.request':
        this.reply('usage.list_reports.response', { requestId, error: null });
        return;

      case 'plugin.catalog.get.request':
        this.reply('plugin.catalog.get.response', { requestId, plugins: [] });
        return;

      case 'project.icon.get.request':
        this.reply('project.icon.get.response', { requestId, projectId: message.projectId, icon: null, error: null });
        return;

      case 'project_icon_request':
        this.reply('project_icon_response', { requestId, cwd: message.cwd ?? '', icon: null, error: null });
        return;

      case 'list_provider_features_request':
        this.reply('list_provider_features_response', { requestId, provider: 'claude', features: [], error: null, fetchedAt: nowIso() });
        return;

      case 'get_daemon_config_request':
        this.reply('get_daemon_config_response', { requestId, config: DAEMON_CONFIG });
        return;

      case 'checkout_status_request':
        this.reply('checkout_status_response', {
          requestId,
          cwd: message.cwd,
          isGit: false,
          repoRoot: null,
          currentBranch: null,
          isDirty: null,
          baseRef: null,
          aheadBehind: null,
          upstreamRef: null,
          aheadOfOrigin: null,
          behindOfOrigin: null,
          hasRemote: false,
          remoteUrl: null,
          isPaseoOwnedWorktree: false,
          error: null,
        });
        return;

      case 'checkout_pr_status_request':
        this.reply('checkout_pr_status_response', {
          requestId,
          cwd: message.cwd,
          status: null,
          githubFeaturesEnabled: false,
          authState: 'no_remote',
          error: null,
        });
        return;

      case 'subscribe_terminals_request':
        this.reply('terminals_changed', {
          requestId,
          cwd: message.cwd,
          workspaceId: message.workspaceId,
          terminals: [],
          subscriptionId: randomUUID(),
        });
        return;

      case 'list_terminals_request':
        this.reply('list_terminals_response', { requestId, cwd: message.cwd, terminals: [] });
        return;

      case 'workspace.script.list.request':
        this.reply('workspace.script.list.response', { requestId, workspaceId: message.workspaceId, scripts: [], error: null });
        return;

      case 'agent.provider_subagents.list.request':
        this.reply('agent.provider_subagents.list.response', {
          requestId,
          parentAgentId: message.parentAgentId,
          subagents: [],
          error: null,
        });
        return;

      case 'get_providers_snapshot_request':
        this.reply('get_providers_snapshot_response', { requestId, ...this.providersSnapshot(message.cwd) });
        return;

      case 'project.list.request':
        this.reply('project.list.response', {
          requestId,
          projects: [this.projectDescriptor()],
          sync: this.syncSnapshot(message.sync),
        });
        if (message.subscribe) this.projectsSubscription = randomUUID();
        return;

      case 'fetch_workspaces_request':
        await this.fetchWorkspaces(message, requestId);
        return;

      case 'fetch_agents_request':
        await this.fetchAgents(message, requestId);
        return;

      case 'fetch_agent_request': {
        const agentId = String(message.agentId ?? '');
        const row = await paseoHub.getSession(agentId, { includeDeleted: true });
        this.reply('fetch_agent_response', {
          requestId,
          agent: row ? this.agentSnapshot(row) : null,
          project: row ? this.projectPlacement(row) : null,
          error: row ? null : 'Conversation not found',
        });
        return;
      }

      case 'agent.timeline.set_subscription.request': {
        const agentIds = Array.isArray(message.agentIds) ? (message.agentIds as unknown[]).map(String) : [];
        this.timelineAgents = new Set(agentIds);
        this.timelineSubscription = this.timelineSubscription ?? randomUUID();
        this.reply('agent.timeline.set_subscription.response', {
          requestId,
          agentIds,
          subscriptionId: this.timelineSubscription,
        });
        return;
      }

      case 'fetch_agent_timeline_request':
        await this.fetchTimeline(message, requestId);
        return;

      case 'agent.timeline.list_prompts.request': {
        const agentId = String(message.agentId ?? '');
        const timeline = await paseoHub.timeline(agentId);
        this.reply('agent.timeline.list_prompts.response', {
          requestId,
          agentId,
          epoch: timeline.epoch,
          prompts: timeline.prompts(),
          error: null,
        });
        return;
      }

      case 'send_agent_message_request': {
        const agentId = String(message.agentId ?? '');
        const text = typeof message.text === 'string' ? message.text : '';
        const clientMessageId = typeof message.messageId === 'string' ? message.messageId : randomUUID();
        let error: string | null = null;
        if (paseoHub.isRunning(agentId)) {
          error = '對話仍在進行中，請稍候。';
        } else {
          // view as: recorded in the operator page's History first; nothing is sent without that record
          const recorded = this.viewer
            ? await recordViewAs(this.viewer, { event: 'message', conversation: agentId, chars: text.length }).then(
                () => true,
                (e: unknown) => {
                  console.error('[paseo] view-as send not recorded', e);
                  return false;
                },
              )
            : true;
          if (!recorded) error = VIEW_AS_NOT_RECORDED;
          else await paseoHub.send(agentId, text, clientMessageId, { images: message.images, attachments: message.attachments });
        }
        this.reply('send_agent_message_response', { requestId, agentId, accepted: error === null, error });
        return;
      }

      case 'cancel_agent_request': {
        const agentId = String(message.agentId ?? '');
        paseoHub.abort(agentId);
        const row = await paseoHub.getSession(agentId);
        this.reply('cancel_agent_response', { requestId, agentId, agent: row ? this.agentSnapshot(row) : null, error: null });
        return;
      }

      case 'workspace.create.request':
        await this.createWorkspace(message, requestId);
        return;

      case 'update_agent_request': {
        if (this.refuseWhileViewing(type, requestId)) return;
        const agentId = String(message.agentId ?? '');
        const title = typeof message.title === 'string' ? message.title.trim() : '';
        let error: string | null = null;
        if (title) {
          try {
            await sessionsService.renameSessionById(agentId, title);
          } catch (e) {
            error = e instanceof Error ? e.message : String(e);
          }
        }
        this.reply('update_agent_response', { requestId, agentId, accepted: error === null, error });
        return;
      }

      // A workspace's title is the conversation's name (a rename nothing overwrites later)
      case 'workspace.title.set.request': {
        if (this.refuseWhileViewing(type, requestId)) return;
        const sessionId = sessionIdFromWorkspace(String(message.workspaceId ?? '')) ?? '';
        const title = typeof message.title === 'string' ? message.title.trim() : '';
        let error: string | null = null;
        if (title) {
          try {
            await sessionsService.renameSessionById(sessionId, title);
          } catch (e) {
            error = e instanceof Error ? e.message : String(e);
          }
        } else {
          error = '名稱不能留空。';
        }
        this.reply('workspace.title.set.response', {
          requestId,
          workspaceId: message.workspaceId,
          accepted: error === null,
          title: error === null ? title : null,
          error,
        });
        return;
      }

      case 'fetch_agent_history_request':
        await this.fetchHistory(message, requestId);
        return;

      // Unarchive in Paseo = restore from Recently deleted
      case 'refresh_agent_request': {
        const agentId = String(message.agentId ?? '');
        const row = await paseoHub.getSession(agentId, { includeDeleted: true });
        if (row && Number(row.isArchived) === 1 && this.refuseWhileViewing(type, requestId)) return;
        if (row && Number(row.isArchived) === 1) await sessionsService.restoreSessionById(agentId);
        this.send({ type: 'status', payload: { status: 'agent_refreshed', agentId, requestId } });
        await this.pushSession(agentId);
        return;
      }

      // Archive in Paseo = CloudCLI's delete, into Recently deleted; deleting from there is for good
      case 'archive_workspace_request':
      case 'archive_agent_request':
      case 'delete_agent_request': {
        if (this.refuseWhileViewing(type, requestId)) return;
        const sessionId = type === 'archive_workspace_request'
          ? sessionIdFromWorkspace(String(message.workspaceId ?? '')) ?? ''
          : String(message.agentId ?? '');
        let error: string | null = null;
        try {
          const row = await paseoHub.getSession(sessionId, { includeDeleted: true });
          const permanent = type === 'delete_agent_request' && !!row && Number(row.isArchived) === 1;
          await sessionsService.deleteOrArchiveSessionById(sessionId, permanent ? { force: true, deletedFromDisk: true } : {});
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
        if (type === 'archive_workspace_request') {
          this.reply('archive_workspace_response', {
            requestId,
            workspaceId: message.workspaceId,
            archivedAt: error ? null : nowIso(),
            error,
          });
        } else if (error) {
          this.reply('rpc_error', { requestId, requestType: type, error, code: 'failed' });
        } else if (type === 'archive_agent_request') {
          this.reply('agent_archived', { requestId, agentId: sessionId, archivedAt: nowIso() });
        } else {
          this.reply('agent_deleted', { requestId, agentId: sessionId });
        }
        return;
      }

      default:
        if (requestId) {
          this.reply('rpc_error', {
            requestId,
            requestType: type,
            error: 'Not available here',
            code: 'unsupported',
          });
        }
    }
  }

  // ---------------------------------------------------------------- directory

  private syncSnapshot(sync: unknown): AnyRecord {
    return {
      generation: paseoHub.generation,
      headSeq: paseoHub.headSeq,
      mode: 'snapshot',
      reason: sync && typeof sync === 'object' && Object.keys(sync).length > 0 ? 'cursor_expired' : 'no_cursor',
      removals: [],
    };
  }

  private projectDescriptor(): AnyRecord {
    return {
      projectId: PROJECT_ID,
      projectKey: PROJECT_ID,
      projectDisplayName: paseoHub.productName,
      projectCustomName: null,
      projectCustomIconRevision: null,
      projectIconRevision: 'automatic:none:v1',
      projectRootPath: paseoHub.workspacePath,
      projectKind: 'directory',
    };
  }

  private projectPlacement(row: SessionRowLite): AnyRecord {
    return {
      projectKey: PROJECT_ID,
      projectName: paseoHub.productName,
      workspaceName: this.titleOf(row),
      checkout: {
        cwd: paseoHub.workspacePath,
        isGit: false,
        currentBranch: null,
        remoteUrl: null,
        worktreeRoot: null,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      },
    };
  }

  private titleOf(row: SessionRowLite): string {
    return row.custom_name?.trim() || '新對話';
  }

  private workspaceDescriptor(row: SessionRowLite): AnyRecord {
    const running = paseoHub.isRunning(row.session_id);
    return {
      id: workspaceIdFor(row.session_id),
      projectId: PROJECT_ID,
      projectDisplayName: paseoHub.productName,
      projectCustomName: null,
      projectCustomIconRevision: null,
      projectRootPath: paseoHub.workspacePath,
      workspaceDirectory: paseoHub.workspacePath,
      setupStatus: null,
      projectKind: 'directory',
      workspaceKind: 'directory',
      name: this.titleOf(row),
      title: row.custom_name?.trim() || null,
      pinnedAt: null,
      background: false,
      archivingAt: null,
      status: running ? 'running' : 'done',
      statusEnteredAt: row.updated_at,
      activityAt: row.updated_at,
      createdAt: row.created_at,
      lastUserMessageAt: row.updated_at,
      diffStat: null,
      scripts: [],
      project: this.projectPlacement(row),
    };
  }

  private agentSnapshot(row: SessionRowLite): AnyRecord {
    const running = paseoHub.isRunning(row.session_id);
    const model = paseoHub.model;
    return {
      id: row.session_id,
      provider: 'claude',
      cwd: paseoHub.workspacePath,
      workspaceId: workspaceIdFor(row.session_id),
      model: model.value,
      thinkingOptionId: null,
      effectiveThinkingOptionId: null,
      runtimeInfo: { provider: 'claude', sessionId: row.provider_session_id, model: model.value, modeId: null },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastUserMessageAt: row.updated_at,
      status: running ? 'running' : 'idle',
      activeTurn: paseoHub.activeTurn(row.session_id),
      capabilities: CAPABILITIES,
      currentModeId: null,
      availableModes: [],
      features: [],
      pendingPermissions: [],
      persistence: null,
      title: this.titleOf(row),
      labels: {},
      archivedAt: Number(row.isArchived) === 1 ? toIso(row.deleted_at ?? row.updated_at) : null,
      requiresAttention: false,
      attentionReason: null,
      attentionTimestamp: null,
    };
  }

  private async fetchWorkspaces(message: AnyRecord, requestId: string): Promise<void> {
    const rows = await paseoHub.listSessions();
    if (message.subscribe) this.workspacesSubscription = this.workspacesSubscription ?? randomUUID();
    this.reply('fetch_workspaces_response', {
      requestId,
      subscriptionId: message.subscribe ? this.workspacesSubscription : null,
      entries: rows.map((row) => this.workspaceDescriptor(row)),
      emptyProjects: rows.length === 0 ? [this.projectDescriptor()] : [],
      pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
      sync: this.syncSnapshot(message.sync),
    });
  }

  private async fetchAgents(message: AnyRecord, requestId: string): Promise<void> {
    const rows = await paseoHub.listSessions();
    if (message.subscribe) this.agentsSubscription = this.agentsSubscription ?? randomUUID();
    this.reply('fetch_agents_response', {
      requestId,
      subscriptionId: message.subscribe ? this.agentsSubscription : null,
      entries: rows.map((row) => ({ agent: this.agentSnapshot(row), project: this.projectPlacement(row) })),
      pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
      sync: this.syncSnapshot(message.sync),
    });
  }

  private async fetchHistory(message: AnyRecord, requestId: string): Promise<void> {
    const search = typeof message.search === 'string' ? message.search.trim().toLowerCase() : '';
    const rows = (await paseoHub.listDeleted()).filter((row) => !search || this.titleOf(row).toLowerCase().includes(search));
    this.reply('fetch_agent_history_response', {
      requestId,
      entries: rows.map((row) => ({ agent: this.agentSnapshot(row), project: this.projectPlacement(row) })),
      pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
    });
  }

  private async pushSession(sessionId: string, removed = false): Promise<void> {
    const row = removed ? null : await paseoHub.getSession(sessionId);
    if (!row) {
      if (this.workspacesSubscription) {
        this.reply('workspace_update', {
          subscriptionId: this.workspacesSubscription,
          kind: 'remove',
          id: workspaceIdFor(sessionId),
          generation: paseoHub.generation,
          seq: paseoHub.nextDirectorySeq(),
        });
      }
      if (this.agentsSubscription) {
        this.reply('agent_update', {
          subscriptionId: this.agentsSubscription,
          kind: 'remove',
          agentId: sessionId,
          generation: paseoHub.generation,
          seq: paseoHub.nextDirectorySeq(),
        });
      }
      return;
    }
    if (this.agentsSubscription) {
      this.reply('agent_update', {
        subscriptionId: this.agentsSubscription,
        kind: 'upsert',
        agent: this.agentSnapshot(row),
        project: this.projectPlacement(row),
        generation: paseoHub.generation,
        seq: paseoHub.nextDirectorySeq(),
      });
    }
    if (this.workspacesSubscription) {
      this.reply('workspace_update', {
        subscriptionId: this.workspacesSubscription,
        kind: 'upsert',
        workspace: { ...this.workspaceDescriptor(row), syncSeq: paseoHub.headSeq },
        generation: paseoHub.generation,
        seq: paseoHub.nextDirectorySeq(),
      });
    }
  }

  // ---------------------------------------------------------------- providers

  private providersSnapshot(cwd: unknown): AnyRecord {
    const model = paseoHub.model;
    return {
      ...(typeof cwd === 'string' ? { cwd } : {}),
      generatedAt: nowIso(),
      entries: [],
      snapshotHash: `yyc:${model.value}`,
      fetchedAt: { claude: nowIso() },
      compactSnapshot: {
        thinkingSets: [],
        entries: [
          {
            provider: 'claude',
            status: 'ready',
            enabled: true,
            source: 'builtin',
            label: model.label,
            description: '',
            defaultModeId: null,
            models: [{ id: model.value, label: model.label, description: '', isDefault: true }],
            modes: [],
          },
        ],
      },
    };
  }

  // ---------------------------------------------------------------- timeline

  private async fetchTimeline(message: AnyRecord, requestId: string): Promise<void> {
    const agentId = String(message.agentId ?? '');
    const row = await paseoHub.getSession(agentId, { includeDeleted: true });
    if (!row) {
      this.reply('fetch_agent_timeline_response', {
        requestId,
        agentId,
        agent: null,
        direction: message.direction ?? 'tail',
        projection: 'projected',
        epoch: '',
        reset: false,
        staleCursor: false,
        gap: false,
        window: { minSeq: 0, maxSeq: 0, nextSeq: 0 },
        startCursor: null,
        endCursor: null,
        hasOlder: false,
        hasNewer: false,
        entries: [],
        error: 'Conversation not found',
      });
      return;
    }
    const timeline = await paseoHub.timeline(agentId);
    const page = timeline.fetch({ direction: message.direction, cursor: message.cursor, limit: message.limit });
    this.reply('fetch_agent_timeline_response', {
      requestId,
      agentId,
      agent: this.agentSnapshot(row),
      ...page,
      error: null,
    });
  }

  private streamRows(sessionId: string, rows: PaseoTimelineRow[], epoch: string, turnId?: string): void {
    if (!this.timelineAgents.has(sessionId)) return;
    for (const row of rows) {
      this.reply('agent_stream', {
        agentId: sessionId,
        event: { type: 'timeline', provider: 'claude', item: row.item, ...(turnId ?? row.turnId ? { turnId: turnId ?? row.turnId } : {}) },
        timestamp: row.timestamp,
        seq: row.seqEnd,
        epoch,
        ...(this.timelineSubscription ? { subscriptionId: this.timelineSubscription } : {}),
      });
    }
  }

  private streamEvent(sessionId: string, event: AnyRecord): void {
    if (!this.timelineAgents.has(sessionId)) return;
    this.reply('agent_stream', {
      agentId: sessionId,
      event,
      timestamp: nowIso(),
      ...(this.timelineSubscription ? { subscriptionId: this.timelineSubscription } : {}),
    });
  }

  async onHubEvent(event: HubEvent): Promise<void> {
    switch (event.type) {
      case 'timeline':
        this.streamRows(event.sessionId, event.rows, event.epoch, event.turnId);
        return;
      case 'turn': {
        const typeByPhase = {
          started: 'turn_started',
          completed: 'turn_completed',
          failed: 'turn_failed',
          canceled: 'turn_canceled',
        } as const;
        const payload: AnyRecord = { type: typeByPhase[event.phase], provider: 'claude', turnId: event.turnId };
        if (event.phase === 'failed') payload.error = event.error ?? 'The turn failed';
        if (event.phase === 'canceled') payload.reason = 'Stopped';
        this.streamEvent(event.sessionId, payload);
        await this.pushSession(event.sessionId);
        return;
      }
      case 'session':
        await this.pushSession(event.sessionId, event.removed);
        return;
      case 'preparing':
        // yyc.sandbox_status (paseo/packages/protocol messages.ts): the chip above the composer
        this.reply('yyc.sandbox_status', { agentId: event.sessionId, state: event.state });
        return;
    }
  }

  // ---------------------------------------------------------------- creation

  private async createWorkspace(message: AnyRecord, requestId: string): Promise<void> {
    const idempotencyKey = typeof message.idempotencyKey === 'string' ? message.idempotencyKey : randomUUID();
    const agent = (message.agent ?? {}) as AnyRecord;
    const text = typeof agent.initialPrompt === 'string'
      ? agent.initialPrompt
      : typeof message.firstAgentContext?.prompt === 'string' ? message.firstAgentContext.prompt : '';
    const clientMessageId = typeof agent.clientMessageId === 'string' ? agent.clientMessageId : `${idempotencyKey}:initial-message`;

    const existing = this.creations.get(idempotencyKey);
    const firstContext = (message.firstAgentContext ?? {}) as AnyRecord;
    const viewer = this.viewer;
    let sessionId: string;
    try {
      sessionId = existing ?? await paseoHub.createConversation(
        text,
        clientMessageId,
        { images: agent.images ?? firstContext.images, attachments: agent.attachments ?? firstContext.attachments },
        // view as: recorded in the operator page's History before the first message goes
        viewer ? (id) => recordViewAs(viewer, { event: 'conversation', conversation: id, chars: text.length }) : undefined,
      );
    } catch (error) {
      if (!viewer) throw error;
      console.error('[paseo] view-as conversation not recorded', error);
      this.reply('workspace.create.response', { requestId, workspace: null, setupTerminalId: null, error: VIEW_AS_NOT_RECORDED });
      return;
    }
    this.creations.set(idempotencyKey, sessionId);
    const row = await paseoHub.getSession(sessionId);
    if (!row) {
      this.reply('workspace.create.response', { requestId, workspace: null, setupTerminalId: null, error: 'Could not start the conversation' });
      return;
    }
    const workspace = this.workspaceDescriptor(row);
    const agentSnapshot = this.agentSnapshot(row);
    const update = (revision: number, phase: string) => {
      if (!message.subscribe) return;
      this.reply('workspace.create.update', {
        kind: 'workspace',
        idempotencyKey,
        revision,
        phase,
        error: null,
        workspaceId: workspace.id,
        agentId: sessionId,
        workspace,
        agent: agentSnapshot,
      });
    };
    update(0, 'accepted');
    update(1, 'workspace_ready');
    update(2, 'agent_ready');
    update(3, 'prompt_started');
    update(4, 'completed');
    this.reply('workspace.create.response', { requestId, workspace, agent: agentSnapshot, setupTerminalId: null, error: null });
    await this.pushSession(sessionId);
  }
}
