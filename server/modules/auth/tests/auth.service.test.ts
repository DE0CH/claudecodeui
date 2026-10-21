import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError } from '@/shared/utils.js';

import { createAuthService } from '../auth.service.js';

type AuthDependencies = Parameters<typeof createAuthService>[0];

function createDependencies(overrides: Partial<AuthDependencies> = {}): AuthDependencies {
  return {
    users: {
      hasUsers: async () => false,
      createUser: async (username, passwordHash) => ({ id: 1, username, password_hash: passwordHash }),
      getUserByUsername: async () => undefined,
      updateLastLogin: async () => undefined,
    },
    withTransaction: async (fn) => await fn(),
    hashPassword: async () => 'hashed-password',
    comparePassword: async () => false,
    generateToken: () => 'signed-token',
    ...overrides,
  };
}

test('register hashes credentials and commits through injected dependencies', async () => {
  const operations: string[] = [];
  const service = createAuthService(createDependencies({
    withTransaction: async (fn) => {
      operations.push('begin');
      try {
        const value = await fn();
        operations.push('commit');
        return value;
      } catch (error) {
        operations.push('rollback');
        throw error;
      }
    },
    hashPassword: async (password) => {
      operations.push(`hash:${password}`);
      return 'hash';
    },
    users: {
      hasUsers: async () => false,
      createUser: async (username, passwordHash) => {
        operations.push(`create:${username}:${passwordHash}`);
        return { id: 1, username, password_hash: passwordHash };
      },
      getUserByUsername: async () => undefined,
      updateLastLogin: async (userId) => { operations.push(`login:${userId}`); },
    },
  }));

  const result = await service.register('alice', 'secret12');

  assert.equal(result.token, 'signed-token');
  // The password is hashed before the transaction opens, so no database connection is held during bcrypt.
  assert.deepEqual(operations, ['hash:secret12', 'begin', 'create:alice:hash', 'commit', 'login:1']);
});

test('login rejects an invalid password without issuing a token', async () => {
  let tokenIssued = false;
  const service = createAuthService(createDependencies({
    users: {
      hasUsers: async () => true,
      createUser: () => { throw new Error('unused'); },
      getUserByUsername: async () => ({ id: 1, username: 'alice', password_hash: 'hash' }),
      updateLastLogin: async () => undefined,
    },
    comparePassword: async () => false,
    generateToken: () => {
      tokenIssued = true;
      return 'token';
    },
  }));

  await assert.rejects(
    service.login('alice', 'wrong-password'),
    (error: unknown) => error instanceof AppError && error.code === 'AUTH_INVALID_CREDENTIALS',
  );
  assert.equal(tokenIssued, false);
});

test('refreshSession issues a replacement token for the authenticated user', () => {
  let tokenUser: { id: number | bigint; username: string } | undefined;
  const service = createAuthService(createDependencies({
    generateToken: (user) => {
      tokenUser = user;
      return 'replacement-token';
    },
  }));

  const result = service.refreshSession({ id: 7, username: 'alice' });

  assert.deepEqual(result, { token: 'replacement-token' });
  assert.deepEqual(tokenUser, { id: 7, username: 'alice' });
});
