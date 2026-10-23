/**
 * Jarvis staff mode: tell a person why the app can't work instead of loading forever.
 *
 * Three ways it fails, each with its own screen (JarvisHealthGate):
 * - `signed-out`: Cloudflare Access no longer accepts the sign-in (expired, or issued by another Access team after
 *   a change of provider). The router answers 401, or Access answers a fetch with a redirect to its login page.
 * - `forbidden`: signed in, but the address isn't on the staff list (the router's 403).
 * - `unreachable`: the router or the person's server doesn't answer (a timeout, a network error, a 5xx), or the
 *   chat socket can't connect.
 *
 * `probeJarvis` asks the router's GET /api/jarvis/me, which needs no per-person process, with a timeout; any part of
 * the app that sees one of these failures calls `reportJarvisProblem`, and the gate takes over the whole screen.
 */
export type JarvisProblem = 'signed-out' | 'forbidden' | 'unreachable';

export const JARVIS_PROBLEM_EVENT = 'jarvis-problem';

/** How long a probe may take before it counts as unreachable. */
export const PROBE_TIMEOUT_MS = 12_000;

/** How long the chat socket may stay unconnected before the app says so. */
export const SOCKET_GRACE_MS = 20_000;

/** A response that means Access wants a new sign-in: a 401, or its redirect to the login page (fetch's opaqueredirect). */
export function isSignedOutResponse(r: Response): boolean {
  return r.status === 401 || r.type === 'opaqueredirect' || (r.redirected && r.url.includes('cloudflareaccess.com'));
}

export function classify(r: Response): JarvisProblem | null {
  if (isSignedOutResponse(r)) return 'signed-out';
  if (r.status === 403) return 'forbidden';
  if (r.status >= 500 || r.status === 0) return 'unreachable';
  return null;
}

/** One check of the router: null = fine, else what is wrong. */
export async function probeJarvis(timeoutMs = PROBE_TIMEOUT_MS): Promise<JarvisProblem | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch('/api/jarvis/me', { cache: 'no-store', redirect: 'manual', signal: ctl.signal });
    return classify(r);
  } catch {
    return 'unreachable'; // a timeout, no network, or a cross-origin redirect the browser refused
  } finally {
    clearTimeout(timer);
  }
}

export function reportJarvisProblem(problem: JarvisProblem): void {
  window.dispatchEvent(new CustomEvent<JarvisProblem>(JARVIS_PROBLEM_EVENT, { detail: problem }));
}
