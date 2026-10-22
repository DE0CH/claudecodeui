import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';

const provider = new ClaudeSessionsProvider();
// the exact text the UI put in front of the first message after a sandbox release, until 2026-10-22
const OLD_NOTE =
  '[System note: your sandbox was reset since the last message: /workspace and this conversation are as they were; installed packages, running processes and files outside /workspace are gone.]';

const userContent = (content: unknown) => {
  const rows = provider.normalizeMessage({
    type: 'user',
    uuid: 'u-1',
    timestamp: '2026-10-21T00:00:00.000Z',
    message: { role: 'user', content },
  }, 'conv-1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].role, 'user');
  return rows[0].content;
};

test('a message saved with the old sandbox-reset note shows without it', () => {
  assert.equal(userContent(`${OLD_NOTE}\n\nhello`), 'hello');
  // with an image the prompt is a content array; the note is at the start of its text part
  assert.equal(userContent([{ type: 'text', text: `${OLD_NOTE}\n\n寫一份新聞稿` }]), '寫一份新聞稿');
});

test('the note anywhere but the start, or a lookalike, is the user\'s own text and stays', () => {
  assert.equal(userContent(`hello ${OLD_NOTE}`), `hello ${OLD_NOTE}`);
  assert.equal(userContent('[System note: something else]\n\nhello'), '[System note: something else]\n\nhello');
});
