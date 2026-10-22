import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cleanTitle,
  SANDBOX_TITLE_SCRIPT,
  TITLE_MAX,
  titleConversation,
  titleFromResponse,
  titleRequest,
} from '@/modules/jarvis/jarvis-title.js';
import type { JarvisSandbox } from '@/modules/jarvis/sandbox-process.js';

const sandbox: JarvisSandbox = { id: 's1', url: 'http://10.200.0.5:7070', token: 't', headers: {} };
const reply = (text: string) => JSON.stringify({ content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text }] });

test('cleanTitle: one line, no label, quotes or trailing full stop, capped', () => {
  assert.equal(cleanTitle('Title: "Production 500 errors".\nmore'), 'Production 500 errors');
  assert.equal(cleanTitle('標題：「港珠澳大橋今日新聞」。'), '港珠澳大橋今日新聞');
  assert.equal([...cleanTitle('字'.repeat(200))].length, TITLE_MAX);
  assert.equal(cleanTitle('   \n  '), '');
});

test('titleFromResponse takes the last text block and ignores thinking', () => {
  assert.equal(titleFromResponse(JSON.parse(reply('長實與新鴻基業績比較'))), '長實與新鴻基業績比較');
  assert.equal(titleFromResponse({ content: [{ type: 'thinking', thinking: 'only' }] }), '');
  assert.equal(titleFromResponse(null), '');
});

test('titleRequest frames the first message as text to name (opencode) and caps it', () => {
  const body = titleRequest('anthropic/claude-haiku-5.5', 'x'.repeat(5000)) as { model: string; system: string; messages: { content: string }[] };
  assert.equal(body.model, 'anthropic/claude-haiku-5.5');
  assert.match(body.system, /Traditional Chinese with Hong Kong usage/);
  assert.match(body.messages[0]!.content, /^Here is the first message of the conversation:\n\n<message>\n/);
  assert.ok(body.messages[0]!.content.length < 2200);
});

test('the sandbox script is valid JavaScript', () => {
  assert.doesNotThrow(() => new Function(SANDBOX_TITLE_SCRIPT.replace(/async \(\) =>/, '() =>').replace(/await /g, '')));
});

test('titleConversation runs node in the sandbox, saves and announces the title', async () => {
  const calls: string[] = [];
  const title = await titleConversation(sandbox, 'conv-1', '幫我整理今日有關港珠澳大橋嘅新聞', {
    model: () => 'anthropic/claude-haiku-5.5',
    run: async (_sb, args, input) => {
      calls.push(`run ${args[0]} ${args[1]}`);
      assert.equal(JSON.parse(input).model, 'anthropic/claude-haiku-5.5');
      return reply('港珠澳大橋今日新聞');
    },
    save: async (id, t) => (calls.push(`save ${id} ${t}`), true),
    announce: async (id) => void calls.push(`announce ${id}`),
  });
  assert.equal(title, '港珠澳大橋今日新聞');
  assert.deepEqual(calls, ['run node -e', 'save conv-1 港珠澳大橋今日新聞', 'announce conv-1']);
});

test('a rename in the meantime wins: nothing is announced', async () => {
  let announced = false;
  const title = await titleConversation(sandbox, 'conv-2', 'hi', {
    model: () => 'm',
    run: async () => reply('Greeting'),
    save: async () => false,
    announce: async () => void (announced = true),
  });
  assert.equal(title, '');
  assert.equal(announced, false);
});

test('a failed call or an empty message leaves the provisional name', async () => {
  let saved = false;
  const deps = {
    model: () => 'm',
    run: async () => {
      throw new Error('HTTP 402 budget_exceeded');
    },
    save: async () => (saved = true),
    announce: async () => {},
  };
  assert.equal(await titleConversation(sandbox, 'conv-3', 'hello', deps), '');
  assert.equal(await titleConversation(sandbox, 'conv-3', '   ', { ...deps, run: async () => reply('x') }), '');
  assert.equal(saved, false);
});
