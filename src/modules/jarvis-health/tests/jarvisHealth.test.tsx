import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import JarvisHealthGate from '@/modules/jarvis-health/JarvisHealthGate';
import { classify, probeJarvis, reportJarvisProblem } from '@/modules/jarvis-health/health';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('classify', () => {
  it('names what each answer means', () => {
    expect(classify(new Response('{}', { status: 200 }))).toBe(null);
    expect(classify(new Response('', { status: 401 }))).toBe('signed-out');
    expect(classify(new Response('', { status: 403 }))).toBe('forbidden');
    expect(classify(new Response('', { status: 502 }))).toBe('unreachable');
    // Access's redirect to its login page, kept by redirect: 'manual'
    expect(classify({ status: 0, type: 'opaqueredirect', redirected: false, url: '' } as Response)).toBe('signed-out');
  });
});

describe('probeJarvis', () => {
  it('a network error or a timeout is unreachable, never a wait', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect(await probeJarvis()).toBe('unreachable');
    vi.stubGlobal('fetch', vi.fn((_u: string, o: RequestInit) => new Promise((_r, reject) => {
      o.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })));
    expect(await probeJarvis(50)).toBe('unreachable');
  });
  it('asks the router with redirects kept', async () => {
    const f = vi.fn(async () => new Response('{"firstName":"A"}', { status: 200 }));
    vi.stubGlobal('fetch', f);
    expect(await probeJarvis()).toBe(null);
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe('/api/jarvis/me');
    expect((f.mock.calls[0] as unknown as [string, RequestInit])[1].redirect).toBe('manual');
  });
});

describe('JarvisHealthGate', () => {
  it('shows the app once the router answers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    render(<JarvisHealthGate loading={<p>loading</p>}><p>the app</p></JarvisHealthGate>);
    expect(await screen.findByText('the app')).toBeTruthy();
  });
  it('a rejected sign-in is an error screen, not a loading screen', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
    render(<JarvisHealthGate loading={<p>loading</p>}><p>the app</p></JarvisHealthGate>);
    expect(await screen.findByText('登入已失效')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重新登入' })).toBeTruthy();
    expect(screen.queryByText('the app')).toBeNull();
  });
  it('an address not on the staff list and an unreachable server each get their screen', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })));
    const { unmount } = render(<JarvisHealthGate loading={<p>loading</p>}><p>the app</p></JarvisHealthGate>);
    expect(await screen.findByText('此帳戶沒有使用權限')).toBeTruthy();
    unmount();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    render(<JarvisHealthGate loading={<p>loading</p>}><p>the app</p></JarvisHealthGate>);
    expect(await screen.findByText('未能連接伺服器')).toBeTruthy();
  });
  it('a problem reported later replaces the running app', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    render(<JarvisHealthGate loading={<p>loading</p>}><p>the app</p></JarvisHealthGate>);
    await screen.findByText('the app');
    act(() => reportJarvisProblem('signed-out'));
    await waitFor(() => expect(screen.getByText('登入已失效')).toBeTruthy());
  });
});
