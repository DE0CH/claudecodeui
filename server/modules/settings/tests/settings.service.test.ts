import assert from 'node:assert/strict';
import test from 'node:test';

import { createSettingsService } from '../settings.service.js';

type Dependencies = Parameters<typeof createSettingsService>[0];

function dependencies(overrides: Partial<Dependencies> = {}): Dependencies {
  return {
    apiKeys: { list: async () => [], create: async () => ({}), remove: async () => false, toggle: async () => false },
    credentials: { list: async () => [], create: async () => ({}), remove: async () => false, toggle: async () => false },
    notifications: {
      getPreferences: async () => undefined,
      updatePreferences: async () => ({}),
      createEnabledEvent: () => ({}),
      notifyUser: async () => undefined,
    },
    pushSubscriptions: { save: async () => undefined, remove: async () => undefined },
    getVapidPublicKey: () => null,
    ...overrides,
  };
}

test('listApiKeys redacts secret values through the service boundary', async () => {
  const service = createSettingsService(dependencies({
    apiKeys: {
      list: async () => [{ id: 1, api_key: '1234567890-secret' }],
      create: async () => ({}), remove: async () => false, toggle: async () => false,
    },
  }));
  assert.equal((await service.listApiKeys(1)).apiKeys[0]?.api_key, '1234567890...');
});

test('subscribeToPush persists the subscription and enables Web Push', async () => {
  const operations: string[] = [];
  const service = createSettingsService(dependencies({
    pushSubscriptions: {
      save: async (_id, endpoint) => operations.push(`save:${endpoint}`),
      remove: async () => undefined,
    },
    notifications: {
      getPreferences: async () => ({ channels: { webPush: false } }),
      updatePreferences: async () => { operations.push('preferences'); return {}; },
      createEnabledEvent: () => ({ code: 'push.enabled' }),
      notifyUser: async () => { operations.push('notify'); },
    },
  }));

  await service.subscribeToPush(1, {
    endpoint: 'https://push.example.test',
    keys: { p256dh: 'key', auth: 'auth' },
  });
  assert.deepEqual(operations, ['save:https://push.example.test', 'preferences', 'notify']);
});
