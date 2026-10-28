import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { NormalizedMessage } from '@/shared/types.js';

import { SessionTimeline, sentFilesOf } from '../paseo-timeline.js';

const toRelative = (value: unknown): string | null =>
  typeof value === 'string' && value.startsWith('/workspace/') ? value.slice('/workspace/'.length) : null;

function message(fields: Partial<NormalizedMessage> & Pick<NormalizedMessage, 'kind'>): NormalizedMessage {
  return {
    id: fields.id ?? Math.random().toString(36).slice(2),
    sessionId: 's1',
    timestamp: '2026-10-26T10:00:00.000Z',
    provider: 'claude',
    ...fields,
  } as NormalizedMessage;
}

describe('SessionTimeline', () => {
  it('turns CloudCLI messages into Paseo timeline rows with increasing sequence numbers', () => {
    const timeline = new SessionTimeline(toRelative);
    timeline.apply(message({ kind: 'text', role: 'user', content: 'hello' }));
    timeline.apply(message({ kind: 'thinking', content: 'pondering' }));
    timeline.apply(message({ kind: 'text', role: 'assistant', content: 'hi there' }));

    assert.deepEqual(
      timeline.rows.map((row) => [row.item.type, row.seqStart]),
      [['user_message', 1], ['reasoning', 2], ['assistant_message', 3]],
    );
    assert.equal(timeline.maxSeq, 3);
  });

  it("keeps the user's images and files on their message, as the history has them", () => {
    const timeline = new SessionTimeline(toRelative);
    timeline.apply(message({
      kind: 'text',
      role: 'user',
      content: 'look',
      images: [{ data: 'data:image/png;base64,AAAA' }, { data: 'https://not-a-data-url' }],
      files: [
        { path: '/workspace/uploads/brief.pdf', name: 'brief.pdf' },
        { path: '/etc/passwd', name: 'passwd' },
      ],
    }));
    // an image-only message still shows
    timeline.apply(message({ kind: 'text', role: 'user', content: '', images: [{ data: 'data:image/jpeg;base64,BBBB' }] }));
    assert.deepEqual(timeline.rows.map((row) => row.item), [
      {
        type: 'user_message',
        text: 'look',
        messageId: (timeline.rows[0]!.item as { messageId?: string }).messageId,
        images: [{ url: 'data:image/png;base64,AAAA', mimeType: 'image/png' }],
        attachments: [{ type: 'uploaded_file', id: 'uploads/brief.pdf', fileName: 'brief.pdf', mimeType: 'application/pdf', size: 0, path: 'uploads/brief.pdf' }],
      },
      {
        type: 'user_message',
        text: '',
        messageId: (timeline.rows[1]!.item as { messageId?: string }).messageId,
        images: [{ url: 'data:image/jpeg;base64,BBBB', mimeType: 'image/jpeg' }],
      },
    ]);
  });

  it('applies a message once, whether it comes from history or replay', () => {
    const timeline = new SessionTimeline(toRelative);
    const reply = message({ id: 'm1', kind: 'text', role: 'assistant', content: 'once' });
    assert.equal(timeline.apply(reply).length, 1);
    assert.equal(timeline.apply(reply).length, 0);
    assert.equal(timeline.rows.length, 1);
  });

  it('completes a tool call in its own row, spanning both sequence numbers', () => {
    const timeline = new SessionTimeline(toRelative);
    timeline.apply(message({ kind: 'tool_use', toolId: 't1', toolName: 'Bash', toolInput: { command: 'ls' } }));
    const [row] = timeline.apply(
      message({ kind: 'tool_result', toolId: 't1', toolResult: { content: 'a.txt' } }),
    );

    assert.equal(timeline.rows.length, 1);
    assert.equal(row, timeline.rows[0]);
    assert.equal(row?.item.type, 'tool_call');
    assert.equal((row?.item as { status: string }).status, 'completed');
    assert.equal((row?.item as { detail: { type: string } }).detail.type, 'shell');
    assert.deepEqual([row?.seqStart, row?.seqEnd], [1, 2]);
    assert.deepEqual(row?.collapsed, ['tool_lifecycle']);
  });

  it('marks a failed tool call', () => {
    const timeline = new SessionTimeline(toRelative);
    timeline.apply(message({ kind: 'tool_use', toolId: 't1', toolName: 'Read', toolInput: { file_path: '/x' } }));
    timeline.apply(message({ kind: 'tool_result', toolId: 't1', isError: true, toolResult: { content: 'no such file' } }));
    assert.equal((timeline.rows[0]?.item as { status: string }).status, 'failed');
  });

  it('puts the files SendUserFile handed over on the tool call', () => {
    const timeline = new SessionTimeline(toRelative);
    timeline.apply(message({ kind: 'tool_use', toolId: 'f1', toolName: 'SendUserFile', toolInput: { files: ['/workspace/a.csv'] } }));
    timeline.apply(message({
      kind: 'tool_result',
      toolId: 'f1',
      toolResult: {
        toolUseResult: { attachments: [{ path: '/workspace/out/a.csv', size: 12, media_type: 'text/csv', isImage: false }] },
      },
    }));
    const metadata = (timeline.rows[0]?.item as { metadata?: { sentFiles?: unknown } }).metadata;
    assert.deepEqual(metadata?.sentFiles, [
      { path: 'out/a.csv', name: 'a.csv', size: 12, mediaType: 'text/csv', isImage: false, sent: 'f1' },
    ]);
  });

  it('pages the tail, then older and newer rows around a cursor', () => {
    const timeline = new SessionTimeline(toRelative);
    for (let i = 1; i <= 5; i += 1) timeline.apply(message({ kind: 'text', role: 'assistant', content: `m${i}` }));

    const tail = timeline.fetch({ direction: 'tail', limit: 2 });
    assert.deepEqual(tail.entries.map((row) => row.seqStart), [4, 5]);
    assert.equal(tail.hasOlder, true);
    assert.equal(tail.hasNewer, false);
    assert.deepEqual(tail.startCursor, { epoch: timeline.epoch, seq: 4 });

    const older = timeline.fetch({ direction: 'before', cursor: tail.startCursor, limit: 2 });
    assert.deepEqual(older.entries.map((row) => row.seqStart), [2, 3]);
    assert.equal(older.hasOlder, true);

    const newer = timeline.fetch({ direction: 'after', cursor: { epoch: timeline.epoch, seq: 3 }, limit: 10 });
    assert.deepEqual(newer.entries.map((row) => row.seqStart), [4, 5]);
    assert.equal(newer.hasNewer, false);
    assert.deepEqual(newer.window, { minSeq: 1, maxSeq: 5, nextSeq: 6 });
  });

  it('answers a cursor from another epoch with the tail and reset', () => {
    const timeline = new SessionTimeline(toRelative);
    timeline.apply(message({ kind: 'text', role: 'user', content: 'x' }));
    const page = timeline.fetch({ direction: 'after', cursor: { epoch: 'old', seq: 40 } });
    assert.equal(page.reset, true);
    assert.equal(page.staleCursor, true);
    assert.equal(page.entries.length, 1);
  });

  it('lists the prompts for the prompt index', () => {
    const timeline = new SessionTimeline(toRelative);
    timeline.apply(message({ kind: 'text', role: 'user', content: 'first question' }));
    timeline.apply(message({ kind: 'text', role: 'assistant', content: 'answer' }));
    assert.deepEqual(timeline.prompts().map((prompt) => [prompt.seq, prompt.preview]), [[1, 'first question']]);
  });
});

describe('sentFilesOf', () => {
  it('keeps only files inside the conversation files root', () => {
    const files = sentFilesOf(
      { attachments: [{ path: '/workspace/r.pdf', isImage: false }, { path: '/etc/passwd' }, { size: 3 }] },
      toRelative,
    );
    assert.deepEqual(files.map((file) => file.path), ['r.pdf']);
  });

  it('is empty without attachments', () => {
    assert.deepEqual(sentFilesOf(null, toRelative), []);
    assert.deepEqual(sentFilesOf({ attachments: 'x' }, toRelative), []);
  });
});
