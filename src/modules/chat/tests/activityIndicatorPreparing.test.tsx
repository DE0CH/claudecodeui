import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import ActivityIndicator, { PREPARING_SLOW_AFTER_S } from '@/modules/chat/composer/ActivityIndicator';
import { JARVIS_PREPARING_STATUS } from '@/shared/jarvis';
import type { SessionActivity } from '@/shared/types';

/**
 * A Jarvis turn waiting for its sandbox (a host may be booting) is its own state: "preparing the workspace" on a
 * tinted tab with a spinner, not the rotating thinking words, a Stop that cancels the wait, and after a while a line
 * saying how long it can take.
 */

const preparing = (secondsAgo: number): SessionActivity => ({
  statusText: JARVIS_PREPARING_STATUS,
  canInterrupt: true,
  startedAt: Date.now() - secondsAgo * 1000,
});

test('the wait for the workspace has its own indicator, with Stop and without the thinking words', async () => {
  await i18n.changeLanguage('en');
  const onAbort = vi.fn();
  const { container } = render(<ActivityIndicator activity={preparing(3)} onAbort={onAbort} />);

  assert.ok(screen.getByTestId('jarvis-preparing'));
  assert.match(container.textContent ?? '', /Preparing the workspace…/);
  assert.doesNotMatch(container.textContent ?? '', /jarvis_preparing|Thinking|Processing/);
  assert.doesNotMatch(container.textContent ?? '', /minute or two/, 'no long-wait line yet');
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  assert.equal(onAbort.mock.calls.length, 1, 'Stop cancels the wait');
  assert.ok(container.querySelector('.animate-spin'), 'a spinner, not the pulsing dot');
  assert.equal(container.querySelector('.bg-primary'), null);
});

test('a long wait adds a line saying it can take a minute or two', async () => {
  await i18n.changeLanguage('en');
  const { container } = render(<ActivityIndicator activity={preparing(PREPARING_SLOW_AFTER_S + 1)} />);
  assert.match(container.textContent ?? '', /This can take a minute or two\./);
});

test('staff read it in Hong Kong Chinese', async () => {
  await i18n.changeLanguage('zh-HK');
  const { container } = render(<ActivityIndicator activity={preparing(PREPARING_SLOW_AFTER_S + 5)} />);
  assert.match(container.textContent ?? '', /正在準備工作環境…/);
  assert.match(container.textContent ?? '', /可能需要一至兩分鐘，請稍候。/);
  await i18n.changeLanguage('en');
});

test('once the sandbox is ready the usual thinking indicator with Stop is back', async () => {
  await i18n.changeLanguage('en');
  const onAbort = vi.fn();
  const { container } = render(
    <ActivityIndicator activity={{ statusText: null, canInterrupt: true, startedAt: Date.now() - 30_000 }} onAbort={onAbort} />,
  );
  assert.equal(screen.queryByTestId('jarvis-preparing'), null);
  assert.doesNotMatch(container.textContent ?? '', /Preparing/);
  assert.ok(screen.getByRole('button', { name: 'Stop' }));
});
