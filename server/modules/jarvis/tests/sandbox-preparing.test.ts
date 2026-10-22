import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acquireSandboxReporting,
  SandboxWaitCancelled,
  type JarvisSandbox,
  type SandboxStatusFrame,
} from '@/modules/jarvis/sandbox-process.js';

const SANDBOX: JarvisSandbox = { id: 's1', url: 'http://10.200.0.2:7070', token: 't', headers: {} };
const after = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test('a sandbox that is there at once announces nothing (no flash of the preparing state)', async () => {
  const frames: SandboxStatusFrame[] = [];
  const sb = await acquireSandboxReporting('c1', (f) => frames.push(f), { afterMs: 50, acquire: async () => SANDBOX });
  assert.equal(sb, SANDBOX);
  await after(80);
  assert.deepEqual(frames, []);
});

test('a long wait is announced once as preparing (no `text`: an older client shows nothing) (nothing to stop yet), then ready', async () => {
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
    { jarvisSandbox: 'preparing', canInterrupt: true },
    { jarvisSandbox: 'ready', canInterrupt: true },
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
  assert.deepEqual(frames, [{ jarvisSandbox: 'preparing', canInterrupt: true }]);

  const quick: SandboxStatusFrame[] = [];
  await assert.rejects(acquireSandboxReporting('c1', (f) => quick.push(f), { afterMs: 50, acquire: async () => { throw new Error('x'); } }));
  await after(80);
  assert.deepEqual(quick, []);
});

test('Stop while preparing cancels the wait: the web call is aborted and nothing says ready', async () => {
  const frames: SandboxStatusFrame[] = [];
  const stop = new AbortController();
  let webSignal: AbortSignal | undefined;
  const wait = acquireSandboxReporting('c1', (f) => frames.push(f), {
    afterMs: 10,
    signal: stop.signal,
    acquire: (_id, signal) => {
      webSignal = signal;
      return new Promise<JarvisSandbox>((resolve) => setTimeout(() => resolve(SANDBOX), 200));
    },
  });
  await after(40);
  stop.abort();
  await assert.rejects(wait, SandboxWaitCancelled);
  assert.equal(webSignal?.aborted, true, 'the request to web is cancelled too');
  await after(220);
  assert.deepEqual(frames, [{ jarvisSandbox: 'preparing', canInterrupt: true }]);
});

test('a sandbox that arrives as Stop is pressed is dropped: the stopped turn never runs', async () => {
  const stop = new AbortController();
  const wait = acquireSandboxReporting('c1', () => {}, {
    afterMs: 10,
    signal: stop.signal,
    acquire: async () => {
      await after(30);
      stop.abort();
      return SANDBOX;
    },
  });
  await assert.rejects(wait, SandboxWaitCancelled);
});
