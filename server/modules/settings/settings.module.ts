import {
  apiKeysDb,
  credentialsDb,
  notificationPreferencesDb,
  pushSubscriptionsDb,
} from '@/modules/database/index.js';
import {
  createNotificationEvent,
  getPublicKey,
  notifyUserIfEnabled,
} from '@/modules/notifications/index.js';

import { createSettingsRouter } from './settings.routes.js';
import { createSettingsService } from './settings.service.js';

const settingsService = createSettingsService({
  apiKeys: {
    list: async (userId) => await apiKeysDb.getApiKeys(userId),
    create: async (userId, keyName) => await apiKeysDb.createApiKey(userId, keyName),
    remove: async (userId, keyId) => await apiKeysDb.deleteApiKey(userId, keyId),
    toggle: async (userId, keyId, isActive) => await apiKeysDb.toggleApiKey(userId, keyId, isActive),
  },
  credentials: {
    list: async (userId, type) => await credentialsDb.getCredentials(userId, type),
    create: async (userId, name, type, value, description) =>
      await credentialsDb.createCredential(userId, name, type, value, description),
    remove: async (userId, credentialId) => await credentialsDb.deleteCredential(userId, credentialId),
    toggle: async (userId, credentialId, isActive) =>
      await credentialsDb.toggleCredential(userId, credentialId, isActive),
  },
  notifications: {
    getPreferences: async (userId) => await notificationPreferencesDb.getPreferences(userId),
    updatePreferences: async (userId, preferences) =>
      await notificationPreferencesDb.updatePreferences(userId, preferences),
    createEnabledEvent: () => createNotificationEvent({
      provider: 'system', kind: 'info', code: 'push.enabled',
      meta: { message: 'Push notifications are now enabled!' }, severity: 'info',
    }),
    notifyUser: async (userId, event) => await notifyUserIfEnabled({ userId, event }),
  },
  pushSubscriptions: {
    save: async (userId, endpoint, p256dh, auth) =>
      await pushSubscriptionsDb.saveSubscription(userId, endpoint, p256dh, auth),
    remove: async (endpoint) => await pushSubscriptionsDb.removeSubscription(endpoint),
  },
  getVapidPublicKey: getPublicKey,
});

/** Settings router assembled for the authenticated server mount. */
export const settingsRoutes = createSettingsRouter(settingsService);
