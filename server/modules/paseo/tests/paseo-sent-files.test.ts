// A file the person attaches is uploaded to CloudCLI's assets folder (an absolute path outside /workspace) and copied
// into the conversation's /workspace/uploads only when the turn runs. The user row the hub puts on the timeline at send
// time cannot name that copy yet, so it has no file pill; Claude Code's echo of the message (its transcript) names
// the copy, and the hub fills the row's files from it. Without that, everyone who reads the timeline from this process
// (a view-as tab, the person's own reload, another tab) saw the message without its files until the process restarted.
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { sessionsService } from '@/modules/providers/index.js';
import type { NormalizedMessage } from '@/shared/types.js';

import { paseoHub, type HubEvent } from '../paseo-hub.js';
import type { PaseoTimelineRow } from '../paseo-timeline.js';

type HubInternals = {
  onChatFrame(frame: Record<string, unknown>): void;
};
const hub = paseoHub as unknown as HubInternals;
const sessions = sessionsService as unknown as { fetchHistory: (...args: unknown[]) => Promise<unknown> };
const realFetchHistory = sessions.fetchHistory;

const SESSION = '11111111-2222-4333-8444-555555555555';
const ASSET = '/home/node/.claude/cloudcli-assets/1793156025172-486076594-Surgical_Futures.xlsx';
const NAME = 'Surgical Futures Forum【Registration Form】.xlsx';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

async function sendWithFile(): Promise<HubEvent[]> {
  sessions.fetchHistory = async () => ({ messages: [], total: 0, hasMore: false, offset: 0, limit: null });
  const events: HubEvent[] = [];
  paseoHub.on('event', (event: HubEvent) => events.push(event));
  await paseoHub.send(SESSION, 'make a new one from this', 'c1', {
    attachments: [{ type: 'uploaded_file', id: ASSET, fileName: NAME, mimeType: XLSX, size: 12345, path: ASSET }],
  });
  return events;
}

/** Claude Code's echo of the sent message, as the claude provider normalises it (its <files_input> parsed). */
function echo(files: unknown[] | undefined): NormalizedMessage {
  return {
    id: 'echo-1', sessionId: SESSION, timestamp: new Date().toISOString(), provider: 'claude',
    kind: 'text', role: 'user', content: 'make a new one from this', files,
  } as unknown as NormalizedMessage;
}

async function userItem() {
  const timeline = await paseoHub.timeline(SESSION);
  const users = timeline.rows.filter((row) => row.item.type === 'user_message');
  assert.equal(users.length, 1, 'one user row: the echo is not a second message');
  return users[0]!.item as Extract<PaseoTimelineRow['item'], { type: 'user_message' }>;
}

describe("a sent message's files on the timeline", () => {
  afterEach(() => {
    sessions.fetchHistory = realFetchHistory;
    paseoHub.resetForTests();
  });

  it('takes the workspace copy Claude Code was given, with the size the app sent', async () => {
    const events = await sendWithFile();
    assert.equal((await userItem()).attachments, undefined, 'the asset path is outside /workspace: no pill yet');
    events.length = 0;
    hub.onChatFrame({ ...echo([{ path: `/workspace/uploads/${NAME}`, name: NAME }]) });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual((await userItem()).attachments, [
      { type: 'uploaded_file', id: `uploads/${NAME}`, fileName: NAME, mimeType: XLSX, size: 12345, path: `uploads/${NAME}` },
    ]);
    const updated = events.filter((e) => e.type === 'timeline');
    assert.equal(updated.length, 1, 'the filled row goes out to the open tabs');
    const row = (updated[0] as Extract<HubEvent, { type: 'timeline' }>).rows[0]!;
    assert.equal(row.item.type === 'user_message' && row.item.clientMessageId, 'c1');
  });

  it('keeps a renamed copy (a second file of the same name)', async () => {
    await sendWithFile();
    hub.onChatFrame({ ...echo([{ path: '/workspace/uploads/Surgical Futures Forum【Registration Form】 (2).xlsx', name: NAME }]) });
    await new Promise((resolve) => setImmediate(resolve));
    const [file] = (await userItem()).attachments ?? [];
    assert.equal(file?.path, 'uploads/Surgical Futures Forum【Registration Form】 (2).xlsx');
    assert.equal(file?.fileName, NAME);
  });

  it('leaves the row alone when the echo names no file', async () => {
    const events = await sendWithFile();
    events.length = 0;
    hub.onChatFrame({ ...echo(undefined) });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await userItem()).attachments, undefined);
    assert.deepEqual(events.filter((e) => e.type === 'timeline'), []);
  });
});
