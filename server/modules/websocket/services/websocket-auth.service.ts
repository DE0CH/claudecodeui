import type { VerifyClientCallbackSync } from 'ws';

import { jarvisEnabled } from '@/modules/jarvis/jarvis-config.js';
import { jarvisCallerMatches } from '@/modules/jarvis/jarvis-guard.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';

type WebSocketAuthDependencies = {
  isPlatform: boolean;
  authenticateWebSocket: (token: string | null) => Promise<{
    id?: string | number;
    userId?: string | number;
    username?: string;
    [key: string]: unknown;
  } | null>;
};

/**
 * Authenticates websocket upgrade requests before the `connection` handler runs.
 */
export async function verifyWebSocketClient(
  info: Parameters<VerifyClientCallbackSync<AuthenticatedWebSocketRequest>>[0],
  dependencies: WebSocketAuthDependencies
): Promise<boolean> {
  const request = info.req as AuthenticatedWebSocketRequest;
  const upgradeUrl = new URL(request.url ?? '/', 'http://localhost');
  const loggedUrl = new URL(upgradeUrl);
  if (loggedUrl.searchParams.has('token')) {
    loggedUrl.searchParams.set('token', 'REDACTED');
  }

  console.log('WebSocket connection attempt to:', `${loggedUrl.pathname}${loggedUrl.search}`);

  // Jarvis mode: the router is the only client and names the verified user in X-Jarvis-User.
  if (jarvisEnabled() && !jarvisCallerMatches(request.headers)) {
    console.log('[WARN] Jarvis mode: WebSocket without this process\'s user refused');
    return false;
  }

  // Platform mode: use the first DB user and skip token checks.
  if (dependencies.isPlatform) {
    const user = await dependencies.authenticateWebSocket(null);
    if (!user) {
      console.log('[WARN] Platform mode: No user found in database');
      return false;
    }

    request.user = user;
    console.log('[OK] Platform mode WebSocket authenticated for user:', user.username);
    return true;
  }

  // OSS mode: read JWT from query string first, then Authorization header.
  const token =
    upgradeUrl.searchParams.get('token') ??
    request.headers.authorization?.split(' ')[1] ??
    null;

  const user = await dependencies.authenticateWebSocket(token);
  if (!user) {
    console.log('[WARN] WebSocket authentication failed');
    return false;
  }

  request.user = user;
  console.log('[OK] WebSocket authenticated for user:', user.username);
  return true;
}
