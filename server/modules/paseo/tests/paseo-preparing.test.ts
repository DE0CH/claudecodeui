// The "preparing the workspace" chip (paseo-hub.ts `preparing`): shown only while a message the person sent waits on
// the conversation's sandbox; a turn nobody is waiting for makes its sandbox out of sight (Deyao, 2026-11-03).
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { paseoHub, type HubEvent } from '../paseo-hub.js';

type HubInternals = {
  onChatFrame(frame: Record<string, unknown>): void;
  announcePreparing(sessionId: string): void;
  pendingUserMessages: Map<string, { text: string; clientMessageId: string }>;
};
const hub = paseoHub as unknown as HubInternals;

function chips(run: () => void): HubEvent[] {
  const seen: HubEvent[] = [];
  const listen = (event: HubEvent) => {
    if (event.type === 'preparing') seen.push(event);
  };
  paseoHub.on('event', listen);
  try {
    run();
  } finally {
    paseoHub.off('event', listen);
  }
  return seen;
}

const status = (sessionId: string, jarvisSandbox: 'preparing' | 'ready') =>
  hub.onChatFrame({ kind: 'status', sessionId, jarvisSandbox, canInterrupt: true });

describe('the preparing chip', () => {
  afterEach(() => paseoHub.resetForTests());

  it('stays hidden for a turn nobody sent (a scheduled turn, a background follow-up)', () => {
    const seen = chips(() => status('s1', 'preparing'));
    assert.deepEqual(seen, []);
    assert.deepEqual(paseoHub.busyState().preparing, ['s1'], 'still tracked for the switch-over');
  });

  it('shows while a sent message waits on the sandbox, and clears when it is ready', () => {
    hub.pendingUserMessages.set('s1', { text: 'hi', clientMessageId: 'c1' });
    const seen = chips(() => {
      status('s1', 'preparing');
      status('s1', 'ready');
    });
    assert.deepEqual(seen.map((e) => e.type === 'preparing' && e.state), ['preparing', 'ready']);
  });

  it('shows once a message is sent into a sandbox already being made for a background turn', () => {
    status('s1', 'preparing');
    const seen = chips(() => {
      hub.pendingUserMessages.set('s1', { text: 'hi', clientMessageId: 'c1' });
      hub.announcePreparing('s1');
    });
    assert.deepEqual(seen.map((e) => e.type === 'preparing' && e.state), ['preparing']);
  });
});
