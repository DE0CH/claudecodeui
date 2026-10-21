import { AppError } from '@/shared/utils.js';

type ApiKeyRow = Record<string, unknown> & { api_key: string };
type NotificationPreferences = Record<string, unknown> & {
  channels?: Record<string, unknown> & { webPush?: boolean };
};

type SettingsDependencies = {
  apiKeys: {
    list(userId: number): Promise<ApiKeyRow[]>;
    create(userId: number, keyName: string): Promise<unknown>;
    remove(userId: number, keyId: number): Promise<boolean>;
    toggle(userId: number, keyId: number, isActive: boolean): Promise<boolean>;
  };
  credentials: {
    list(userId: number, credentialType: string | null): Promise<unknown[]>;
    create(
      userId: number,
      name: string,
      type: string,
      value: string,
      description: string | null,
    ): Promise<unknown>;
    remove(userId: number, credentialId: number): Promise<boolean>;
    toggle(userId: number, credentialId: number, isActive: boolean): Promise<boolean>;
  };
  notifications: {
    getPreferences(userId: number): Promise<NotificationPreferences | undefined>;
    updatePreferences(userId: number, preferences: NotificationPreferences): Promise<unknown>;
    createEnabledEvent(): unknown;
    notifyUser(userId: number, event: unknown): Promise<void | Promise<void>>;
  };
  pushSubscriptions: {
    save(userId: number, endpoint: string, p256dh: string, auth: string): Promise<void>;
    remove(endpoint: string): Promise<void>;
  };
  getVapidPublicKey(): string | null;
};

function requiredString(value: unknown, fieldName: string, code: string): string {
  const normalizedValue = typeof value === 'string' ? value.trim() : '';
  if (!normalizedValue) {
    throw new AppError(`${fieldName} is required`, { code, statusCode: 400 });
  }
  return normalizedValue;
}

function assertFound(found: boolean, resourceName: string, code: string): void {
  if (!found) {
    throw new AppError(`${resourceName} not found`, { code, statusCode: 404 });
  }
}

/** Creates settings workflows with repositories and notification effects injected. */
export function createSettingsService(dependencies: SettingsDependencies) {
  return {
    async listApiKeys(userId: number) {
      const apiKeys = (await dependencies.apiKeys.list(userId)).map((key) => ({
        ...key,
        api_key: `${key.api_key.substring(0, 10)}...`,
      }));
      return { apiKeys };
    },
    async createApiKey(userId: number, keyNameInput: unknown) {
      const keyName = requiredString(keyNameInput, 'Key name', 'API_KEY_NAME_REQUIRED');
      return { success: true, apiKey: await dependencies.apiKeys.create(userId, keyName) };
    },
    async deleteApiKey(userId: number, keyId: number) {
      assertFound(await dependencies.apiKeys.remove(userId, keyId), 'API key', 'API_KEY_NOT_FOUND');
      return { success: true };
    },
    async toggleApiKey(userId: number, keyId: number, isActive: unknown) {
      if (typeof isActive !== 'boolean') {
        throw new AppError('isActive must be a boolean', {
          code: 'INVALID_ACTIVE_STATE',
          statusCode: 400,
        });
      }
      assertFound(
        await dependencies.apiKeys.toggle(userId, keyId, isActive),
        'API key',
        'API_KEY_NOT_FOUND',
      );
      return { success: true };
    },
    async listCredentials(userId: number, credentialType: string | null) {
      return { credentials: await dependencies.credentials.list(userId, credentialType) };
    },
    async createCredential(userId: number, input: Record<string, unknown>) {
      const credentialName = requiredString(
        input.credentialName,
        'Credential name',
        'CREDENTIAL_NAME_REQUIRED',
      );
      const credentialType = requiredString(
        input.credentialType,
        'Credential type',
        'CREDENTIAL_TYPE_REQUIRED',
      );
      const credentialValue = requiredString(
        input.credentialValue,
        'Credential value',
        'CREDENTIAL_VALUE_REQUIRED',
      );
      const description = typeof input.description === 'string'
        ? input.description.trim() || null
        : null;
      return {
        success: true,
        credential: await dependencies.credentials.create(
          userId,
          credentialName,
          credentialType,
          credentialValue,
          description,
        ),
      };
    },
    async deleteCredential(userId: number, credentialId: number) {
      assertFound(
        await dependencies.credentials.remove(userId, credentialId),
        'Credential',
        'CREDENTIAL_NOT_FOUND',
      );
      return { success: true };
    },
    async toggleCredential(userId: number, credentialId: number, isActive: unknown) {
      if (typeof isActive !== 'boolean') {
        throw new AppError('isActive must be a boolean', {
          code: 'INVALID_ACTIVE_STATE',
          statusCode: 400,
        });
      }
      assertFound(
        await dependencies.credentials.toggle(userId, credentialId, isActive),
        'Credential',
        'CREDENTIAL_NOT_FOUND',
      );
      return { success: true };
    },
    async getNotificationPreferences(userId: number) {
      return { success: true, preferences: await dependencies.notifications.getPreferences(userId) };
    },
    async updateNotificationPreferences(userId: number, preferences: NotificationPreferences) {
      return {
        success: true,
        preferences: await dependencies.notifications.updatePreferences(userId, preferences),
      };
    },
    getVapidPublicKey() {
      return { publicKey: dependencies.getVapidPublicKey() };
    },
    async subscribeToPush(userId: number, input: Record<string, unknown>) {
      const endpoint = requiredString(input.endpoint, 'Endpoint', 'PUSH_SUBSCRIPTION_REQUIRED');
      const keys = typeof input.keys === 'object' && input.keys !== null
        ? input.keys as Record<string, unknown>
        : {};
      const p256dh = requiredString(keys.p256dh, 'p256dh', 'PUSH_SUBSCRIPTION_REQUIRED');
      const auth = requiredString(keys.auth, 'auth', 'PUSH_SUBSCRIPTION_REQUIRED');
      await dependencies.pushSubscriptions.save(userId, endpoint, p256dh, auth);

      const currentPreferences = await dependencies.notifications.getPreferences(userId);
      if (!currentPreferences?.channels?.webPush) {
        await dependencies.notifications.updatePreferences(userId, {
          ...currentPreferences,
          channels: { ...currentPreferences?.channels, webPush: true },
        });
      }
      const event = dependencies.notifications.createEnabledEvent();
      void dependencies.notifications.notifyUser(userId, event);
      return { success: true };
    },
    async unsubscribeFromPush(userId: number, endpointInput: unknown) {
      const endpoint = requiredString(endpointInput, 'Endpoint', 'PUSH_ENDPOINT_REQUIRED');
      await dependencies.pushSubscriptions.remove(endpoint);
      const currentPreferences = await dependencies.notifications.getPreferences(userId);
      if (currentPreferences?.channels?.webPush) {
        await dependencies.notifications.updatePreferences(userId, {
          ...currentPreferences,
          channels: { ...currentPreferences.channels, webPush: false },
        });
      }
      return { success: true };
    },
  };
}
