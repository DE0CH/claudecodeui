import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { listen, notify, projectsDb, resolveSchema, sessionsDb } from '@/modules/database/index.js';
import { generateDisplayName } from '@/modules/projects/index.js';
import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import type { SessionRemovedEvent, SessionUpsertedEvent } from '@/shared/types.js';

/**
 * The single producer of the `session_upserted` delta.
 *
 * The event carries everything a sidebar needs to upsert a session in place
 * (its summary plus the owning project's metadata), so clients never refetch
 * the whole project list because one transcript changed on disk.
 *
 * It used to be built in two places — the on-disk sessions watcher and the
 * chat run registry — and only the registry's copy set `providerSessionId`.
 * That field is how the client notices a row it is showing has been merged
 * into its canonical app-session row, so a merge announced by any other path
 * left a stale duplicate in the sidebar. One builder, one shape.
 */
async function buildSessionUpsertedEvent(
  sessionIdOrProviderSessionId: string,
): Promise<SessionUpsertedEvent | null> {
  // Resolving by provider id first covers the watcher, which only ever sees
  // the id written in the transcript. For a row where the two ids are equal
  // — legacy rows, and any session indexed from disk before its mapping
  // existed — both lookups land on the same row anyway.
  const row = await sessionsDb.getSessionByProviderSessionId(sessionIdOrProviderSessionId)
    ?? await sessionsDb.getSessionById(sessionIdOrProviderSessionId);
  if (!row || row.isArchived) {
    return null;
  }

  const projectPath = row.project_path;
  const project = projectPath ? await projectsDb.getProjectPath(projectPath) : null;
  const displayName = project?.custom_project_name?.trim()
    ? project.custom_project_name
    : await generateDisplayName(path.basename(projectPath ?? '') || (projectPath ?? ''), projectPath);

  return {
    kind: 'session_upserted',
    sessionId: row.session_id,
    providerSessionId: row.provider_session_id ?? null,
    // The column is a plain TEXT and typed as `string` on the row, but only
    // provider adapters ever write it.
    provider: row.provider as SessionUpsertedEvent['provider'],
    session: {
      id: row.session_id,
      summary: row.custom_name || '',
      messageCount: 0,
      lastActivity: row.updated_at ?? row.created_at ?? new Date().toISOString(),
    },
    project: project
      ? {
        projectId: project.project_id,
        path: project.project_path,
        fullPath: project.project_path,
        displayName,
        isStarred: Boolean(project.isStarred),
      }
      : null,
    timestamp: new Date().toISOString(),
  };
}

/**
 * The same user's tabs can be attached to two CloudCLI processes for a while (the router moved the person to another
 * replica during a rollout while old sockets stay on the old one). Every session-list frame is therefore also
 * published with Postgres NOTIFY on a channel of the user's schema, and each process passes on frames another
 * process published to its own sockets. Off unless started (Jarvis mode starts it with the server).
 */
const RELAY_ORIGIN = randomUUID();
const RELAY_MAX_PAYLOAD = 7900; // Postgres caps a notification at 8000 bytes
let relayChannel: string | null = null;
let stopRelay: (() => Promise<void>) | null = null;

export function startSessionListRelay(): void {
  if (stopRelay) {
    return;
  }
  const channel = `cloudcli_sessions_${resolveSchema()}`;
  relayChannel = channel;
  stopRelay = listen(channel, (payload) => {
    try {
      const message = JSON.parse(payload) as { origin?: string; frame?: string };
      if (message.origin !== RELAY_ORIGIN && typeof message.frame === 'string') {
        sendToLocalClients([message.frame]);
      }
    } catch {
      // not ours
    }
  });
}

export async function stopSessionListRelay(): Promise<void> {
  const stop = stopRelay;
  stopRelay = null;
  relayChannel = null;
  await stop?.();
}

function sendToLocalClients(payloads: string[]): void {
  connectedClients.forEach((client) => {
    if (client.readyState === WS_OPEN_STATE) {
      for (const payload of payloads) {
        client.send(payload);
      }
    }
  });
}

function sendToConnectedClients(payloads: string[]): void {
  if (payloads.length === 0) {
    return;
  }

  const channel = relayChannel;
  if (channel) {
    for (const frame of payloads) {
      const message = JSON.stringify({ origin: RELAY_ORIGIN, frame });
      if (Buffer.byteLength(message) > RELAY_MAX_PAYLOAD) {
        continue;
      }
      void notify(channel, message).catch((error: unknown) => {
        console.error('[sessions] relay notify failed', { error: error instanceof Error ? error.message : String(error) });
      });
    }
  }

  connectedClients.forEach((client) => {
    if (client.readyState === WS_OPEN_STATE) {
      for (const payload of payloads) {
        client.send(payload);
      }
    }
  });
}

/** Announces one session. Used by the chat run registry when a run reports its provider-native id. */
export async function broadcastSessionUpserted(sessionIdOrProviderSessionId: string): Promise<void> {
  const event = await buildSessionUpsertedEvent(sessionIdOrProviderSessionId);
  if (event) {
    sendToConnectedClients([JSON.stringify(event)]);
  }
}

/**
 * Announces a batch of sessions. Used by the providers module's sessions
 * watcher, whose debounced flush can carry dozens of ids at once — the client
 * set is walked once for the whole batch rather than once per session.
 */
export async function broadcastSessionUpsertedBatch(
  sessionIds: Iterable<string>,
): Promise<void> {
  const payloads: string[] = [];
  for (const sessionId of sessionIds) {
    const event = await buildSessionUpsertedEvent(sessionId);
    if (event) {
      payloads.push(JSON.stringify(event));
    }
  }

  sendToConnectedClients(payloads);
}

/** Announces that a session was archived or deleted, so every open tab drops it from its lists. */
export function broadcastSessionRemoved(sessionId: string, action: SessionRemovedEvent['action']): void {
  const event: SessionRemovedEvent = { kind: 'session_removed', sessionId, action, timestamp: new Date().toISOString() };
  sendToConnectedClients([JSON.stringify(event)]);
}

/** @internal Exported for the broadcast tests, which assert the payload shape directly. */
export { buildSessionUpsertedEvent };
