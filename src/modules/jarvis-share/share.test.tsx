import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import '@/modules/i18n';
import { TranscriptSessionContext } from '@/modules/chat/context/TranscriptSessionContext';
import SentFileCards from '@/modules/jarvis-files/SentFileCards';
import { absoluteShareUrl, copyPendingText, shareAge } from '@/modules/jarvis-share/shareLinks';

const SHARE = 'AbCdEfGhIjKlMnOpQrStUv';

describe('shared conversation', () => {
  it('sent-file cards on a shared page load from the share, never the owner\'s conversation', () => {
    render(
      <TranscriptSessionContext.Provider value={{ sessionId: null, shareId: SHARE }}>
        <SentFileCards
          sessionId={null}
          toolInput={{ files: ['/workspace/out/chart.png'] }}
          toolResult={{ isError: false, toolUseResult: { attachments: [{ path: '/workspace/out/chart.png', size: 2048 }] } }}
        />
      </TranscriptSessionContext.Provider>,
    );
    const img = screen.getByRole('img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe(`/api/jarvis/shares/${SHARE}/files/raw?path=out%2Fchart.png&inline=1`);
    const download = document.querySelector('a[download]') as HTMLAnchorElement;
    expect(download.getAttribute('href')).toBe(`/api/jarvis/shares/${SHARE}/files/raw?path=out%2Fchart.png`);
  });

  it('links are absolute on this site, ages read like the conversation list', () => {
    expect(absoluteShareUrl({ url: `/s/${SHARE}` })).toBe(`${window.location.origin}/s/${SHARE}`);
    const now = new Date('2026-10-22T10:00:00Z');
    expect(shareAge('2026-10-22T09:59:40Z', now)).toBeTruthy();
    expect(shareAge('2026-10-22T07:00:00Z', now)).toMatch(/3/);
  });

  it('copies a link that is still being made', async () => {
    let written = '';
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => { written = t; } } });
    await copyPendingText(Promise.resolve('https://example.test/s/x'));
    expect(written).toBe('https://example.test/s/x');
  });
});
