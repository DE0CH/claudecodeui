import { createRequire } from 'node:module';

import { transaction, userDb } from '@/modules/database/index.js';

import { authenticateToken, generateToken } from './auth.middleware.js';
import { createAuthRouter } from './auth.routes.js';
import { createAuthService } from './auth.service.js';

type BcryptAdapter = {
  hash(password: string, saltRounds: number): Promise<string>;
  compare(password: string, passwordHash: string): Promise<boolean>;
};

// bcrypt does not ship TypeScript declarations in this project, so the
// composition root narrows its CommonJS runtime surface before injecting it.
const require = createRequire(import.meta.url);
const bcrypt = require('bcrypt') as BcryptAdapter;

const authService = createAuthService({
  users: {
    hasUsers: async () => await userDb.hasUsers(),
    createUser: async (username, passwordHash) => await userDb.createUser(username, passwordHash),
    getUserByUsername: async (username) => await userDb.getUserByUsername(username),
    updateLastLogin: async (userId) => await userDb.updateLastLogin(userId),
  },
  withTransaction: async (fn) => await transaction(fn),
  hashPassword: (password) => bcrypt.hash(password, 12),
  comparePassword: (password, passwordHash) => bcrypt.compare(password, passwordHash),
  generateToken,
});

/** Auth router assembled for the server entrypoint. */
export const authRoutes = createAuthRouter(authService, authenticateToken);
