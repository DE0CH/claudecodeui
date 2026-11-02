import assert from 'node:assert/strict';
import test from 'node:test';

import { startRecentlyDeletedPurge } from '@/modules/jarvis/jarvis-purge.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('Recently deleted purge: runs first after its delay and then on its interval; JARVIS_UI_PURGE=off (the switch window) runs none', async () => {
  const service = sessionsService as unknown as { purgeExpiredDeletedSessions: () => Promise<number> };
  const real = service.purgeExpiredDeletedSessions;
  let calls = 0;
  service.purgeExpiredDeletedSessions = async () => {
    calls += 1;
    return 0;
  };
  const before = process.env.JARVIS_UI_PURGE;
  try {
    process.env.JARVIS_UI_PURGE = 'off';
    const stopOff = startRecentlyDeletedPurge({ firstAfterMs: 20, everyMs: 30 });
    await wait(200);
    stopOff();
    assert.equal(calls, 0, 'no purge with JARVIS_UI_PURGE=off');

    delete process.env.JARVIS_UI_PURGE;
    const stopOn = startRecentlyDeletedPurge({ firstAfterMs: 20, everyMs: 30 });
    await wait(200);
    stopOn();
    assert.ok(calls >= 3, `the purge ran ${calls} times`);
    const after = calls;
    await wait(100);
    assert.equal(calls, after, 'stopped');
  } finally {
    service.purgeExpiredDeletedSessions = real;
    if (before === undefined) delete process.env.JARVIS_UI_PURGE;
    else process.env.JARVIS_UI_PURGE = before;
  }
});
