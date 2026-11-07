import assert from 'node:assert/strict';
import test from 'node:test';

import { startRecentlyDeletedPurge } from '@/modules/jarvis/jarvis-purge.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('Recently deleted purge: runs first after its delay and then on its interval, until stopped', async () => {
  const service = sessionsService as unknown as { purgeExpiredDeletedSessions: () => Promise<number> };
  const real = service.purgeExpiredDeletedSessions;
  let calls = 0;
  service.purgeExpiredDeletedSessions = async () => {
    calls += 1;
    return 0;
  };
  try {
    const stop = startRecentlyDeletedPurge({ firstAfterMs: 20, everyMs: 30 });
    await wait(200);
    stop();
    assert.ok(calls >= 3, `the purge ran ${calls} times`);
    const after = calls;
    await wait(100);
    assert.equal(calls, after, 'stopped');
  } finally {
    service.purgeExpiredDeletedSessions = real;
  }
});
