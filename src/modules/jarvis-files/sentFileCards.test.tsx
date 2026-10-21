import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import { groupConsecutiveTools } from '@/modules/chat/utils/toolGrouping';
import SentFileCards from '@/modules/jarvis-files/SentFileCards';
import { readSendUserFileInput, sentFilesOf } from '@/modules/jarvis-files/sentFiles';
import type { ChatMessage } from '@/shared/types';

const SESSION = '6f1d0c3e-1111-4a2b-9c1d-000000000001';

describe('SendUserFile input and result', () => {
  it('reads the input as an object or as its JSON, keeping only paths inside /workspace', () => {
    const input = readSendUserFileInput(JSON.stringify({
      files: ['report.pdf', '/workspace/charts/a.png', '/etc/passwd', '../x', 'report.pdf'],
      caption: ' 報告 ',
      status: 'normal',
      display: 'attach',
    }));
    expect(input.caption).toBe('報告');
    expect(input.display).toBe('attach');
    const files = sentFilesOf(input, { attachments: [{ path: '/workspace/report.pdf', size: 2048 }] });
    expect(files).toEqual([
      { path: 'report.pdf', size: 2048 },
      { path: 'charts/a.png', size: null },
    ]);
    expect(readSendUserFileInput('{"files": ["a').files).toEqual([]);
  });
});

describe('SentFileCards', () => {
  it('shows a card per sent file with its size, a preview for images and a download', () => {
    const onOpen = vi.fn();
    render(
      <SentFileCards
        sessionId={SESSION}
        toolInput={{ files: ['/workspace/out/chart.png', 'summary.xlsx'], caption: '報道數量', status: 'normal' }}
        toolResult={{ isError: false, toolUseResult: { attachments: [
          { path: '/workspace/out/chart.png', size: 1536 },
          { path: '/workspace/summary.xlsx', size: 18432 },
        ] } }}
        onOpen={onOpen}
      />,
    );
    expect(screen.getByText('報道數量')).toBeTruthy();
    expect(screen.getByText('chart.png')).toBeTruthy();
    expect(screen.getByText('1.5 KB')).toBeTruthy();
    expect(screen.getByText('18.0 KB')).toBeTruthy();
    const img = screen.getByRole('img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe(`/api/jarvis/sessions/${SESSION}/files/raw?path=out%2Fchart.png&inline=1`);
    const downloads = screen.getAllByRole('link');
    expect(downloads.map((a) => a.getAttribute('href'))).toEqual([
      `/api/jarvis/sessions/${SESSION}/files/raw?path=out%2Fchart.png`,
      `/api/jarvis/sessions/${SESSION}/files/raw?path=summary.xlsx`,
    ]);
    fireEvent.click(screen.getByText('summary.xlsx'));
    expect(onOpen).toHaveBeenCalledWith('/workspace/summary.xlsx');
  });

  it('shows the files as being sent until the tool has run, and no preview when Claude attaches only', () => {
    const { rerender } = render(
      <SentFileCards sessionId={SESSION} toolInput={{ files: ['report.pdf'], status: 'normal' }} toolResult={null} />,
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(document.querySelector('iframe')).toBeNull();
    rerender(
      <SentFileCards
        sessionId={SESSION}
        toolInput={{ files: ['report.pdf'], status: 'normal' }}
        toolResult={{ isError: false, toolUseResult: { attachments: [{ path: '/workspace/report.pdf', size: 10 }] } }}
      />,
    );
    expect(document.querySelector('iframe')?.getAttribute('src')).toContain('path=report.pdf&inline=1');
    rerender(
      <SentFileCards
        sessionId={SESSION}
        toolInput={{ files: ['report.pdf'], status: 'normal', display: 'attach' }}
        toolResult={{ isError: false }}
      />,
    );
    expect(document.querySelector('iframe')).toBeNull();
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });
});

describe('grouping', () => {
  it('never folds SendUserFile calls into a collapsed run', () => {
    const row = (id: string): ChatMessage => ({
      type: 'assistant', isToolUse: true, toolName: 'SendUserFile', toolId: id, toolInput: { files: [`${id}.pdf`] }, timestamp: 0,
    } as ChatMessage);
    const items = groupConsecutiveTools([row('a'), row('b'), row('c')]);
    expect(items).toHaveLength(3);
  });
});
