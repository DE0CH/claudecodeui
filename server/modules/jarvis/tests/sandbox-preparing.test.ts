import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acquireSandboxReporting,
  JARVIS_PREPARING_STATUS,
  JARVIS_READY_STATUS,
  type JarvisSandbox,
  type SandboxStatusFrame,
} from '@/modules/jarvis/sandbox-process.js';

const SANDBOX: JarvisSandbox = { id: 's1', url: 'http://10.200.0.2:7070', token: 't', headers: {}, reset: false };
const after = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test('a sandbox that is there at once announces nothing (no flash of the preparing state)', async () => {
  const frames: SandboxStatusFrame[] = [];
  const sb = await acquireSandboxReporting('c1', (f) => frames.push(f), { afterMs: 50, acquire: async () => SANDBOX });
  assert.equal(sb, SANDBOX);
  await after(80);
  assert.deepEqual(frames, []);
});

test('a long wait is announced once as preparing (nothing to stop yet), then ready', async () => {
  const frames: SandboxStatusFrame[] = [];
  const sb = await acquireSandboxReporting('c1', (f) => frames.push(f), {
    afterMs: 20,
    acquire: async (id) => {
      assert.equal(id, 'c1');
      await after(80);
      return SANDBOX;
    },
  });
  assert.equal(sb, SANDBOX);
  assert.deepEqual(frames, [
    { text: JARVIS_PREPARING_STATUS, canInterrupt: false },
    { text: JARVIS_READY_STATUS, canInterrupt: true },
  ]);
});

test('a failed wait ends without ready (the turn reports the error), and a quick failure announces nothing', async () => {
  const frames: SandboxStatusFrame[] = [];
  await assert.rejects(
    acquireSandboxReporting('c1', (f) => frames.push(f), {
      afterMs: 20,
      acquire: async () => {
        await after(60);
        throw new Error('all sandbox hosts are full');
      },
    }),
    /hosts are full/,
  );
  assert.deepEqual(frames, [{ text: JARVIS_PREPARING_STATUS, canInterrupt: false }]);

  const quick: SandboxStatusFrame[] = [];
  await assert.rejects(acquireSandboxReporting('c1', (f) => quick.push(f), { afterMs: 50, acquire: async () => { throw new Error('x'); } }));
  await after(80);
  assert.deepEqual(quick, []);
});
