import { useEffect, useState, type ReactNode } from 'react';

import { BRAND_LOGO, BRAND_NAME } from '@/shared/jarvis';

import { JARVIS_PROBLEM_EVENT, probeJarvis, type JarvisProblem } from '@/modules/jarvis-health/health';

/** What each problem tells the person, and the one thing they can do about it (staff pages are in Chinese). */
const SCREENS: Record<JarvisProblem, { title: string; body: string; action: string; go: () => void }> = {
  'signed-out': {
    title: '登入已失效',
    body: '請重新登入以繼續使用。',
    action: '重新登入',
    go: () => window.location.reload(), // the page load goes through Access, which asks for a sign-in
  },
  forbidden: {
    title: '此帳戶沒有使用權限',
    body: '請改用獲授權的帳戶登入。',
    action: '以其他帳戶登入',
    go: () => { window.location.href = '/cdn-cgi/access/logout'; },
  },
  unreachable: {
    title: '未能連接伺服器',
    body: '系統暫時未能回應，請稍後再試。',
    action: '重試',
    go: () => window.location.reload(),
  },
};

/** How often the unreachable screen checks again by itself. */
const RETRY_MS = 15_000;

/**
 * Jarvis staff mode: checks the router before showing the app (at most PROBE_TIMEOUT_MS of the loading screen),
 * then takes over the screen whenever any part of the app reports a problem. An unreachable server is checked
 * again every RETRY_MS and the app comes back by itself once it answers.
 */
export default function JarvisHealthGate({ children, loading }: { children: ReactNode; loading: ReactNode }) {
  const [state, setState] = useState<'checking' | 'ok' | JarvisProblem>('checking');

  useEffect(() => {
    let live = true;
    void probeJarvis().then((p) => { if (live) setState(p ?? 'ok'); });
    const onProblem = (e: Event) => setState((e as CustomEvent<JarvisProblem>).detail);
    window.addEventListener(JARVIS_PROBLEM_EVENT, onProblem);
    return () => { live = false; window.removeEventListener(JARVIS_PROBLEM_EVENT, onProblem); };
  }, []);

  useEffect(() => {
    if (state !== 'unreachable') return undefined;
    const t = window.setInterval(() => {
      void probeJarvis().then((p) => { if (p === null) window.location.reload(); else if (p !== 'unreachable') setState(p); });
    }, RETRY_MS);
    return () => window.clearInterval(t);
  }, [state]);

  if (state === 'checking') return <>{loading}</>;
  if (state === 'ok') return <>{children}</>;
  const s = SCREENS[state];
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4" role="alert" data-jarvis-problem={state}>
      <div className="max-w-sm text-center">
        <img src={BRAND_LOGO} alt={BRAND_NAME} className="mx-auto mb-5 h-16 w-16 rounded-2xl shadow-lg" />
        <h1 className="mb-2 text-xl font-semibold text-foreground">{s.title}</h1>
        <p className="mb-6 text-sm text-muted-foreground">{s.body}</p>
        <button
          type="button"
          onClick={s.go}
          className="rounded-lg bg-primary px-5 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          {s.action}
        </button>
      </div>
    </div>
  );
}
