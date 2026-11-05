import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { releaseTestDatabase } from '@/modules/database/testing.js';
import { answerContinuation, askUserQuestionResult, formatAskDuration, OpenQuestions } from '@/modules/jarvis/jarvis-open-questions.js';

/**
 * The questions a turn leaves waiting when it lets its sandbox go (DECISIONS 17; jarvis-open-questions.ts): kept in
 * this process's database so a restart keeps them, and answered to the resumed Claude Code in the words its own tool
 * result would use (Claude Code 2.1.304).
 */

async function withIsolatedDatabase(runTest: () => Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarvis-open-questions-db-'));
  await closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  await initializeDatabase();
  try {
    await runTest();
  } finally {
    await releaseTestDatabase();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

const QUESTION = { questions: [{ question: 'Which colour?', header: 'Colour', options: [{ label: 'Red' }, { label: 'Blue' }], multiSelect: false }] };

test('a kept question survives the process restarting, with its answer', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    await sessionsDb.createAppSession('oq-1', 'claude', '/tmp/oq-1');
    const before = new OpenQuestions();
    await before.add({
      requestId: 'r1', sessionId: 'oq-1', providerSessionId: 'native-1', toolName: 'AskUserQuestion', toolUseId: 'toolu_1',
      input: QUESTION, runOptions: { model: 'm', permissionMode: 'bypassPermissions' }, askedAt: '2026-11-05T08:00:00.000Z', answer: null,
    });
    before.answer('r1', { allow: true, updatedInput: { ...QUESTION, answers: { 'Which colour?': 'Red' } } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    before.resetForTests();

    const after = new OpenQuestions({ limitMs: () => 7 * 24 * 60 * 60 * 1000, now: () => Date.parse('2026-11-05T09:00:00.000Z') });
    await after.load();
    const [q] = after.forSession('oq-1');
    assert.deepEqual(q, {
      requestId: 'r1', sessionId: 'oq-1', providerSessionId: 'native-1', toolName: 'AskUserQuestion', toolUseId: 'toolu_1',
      input: QUESTION, runOptions: { model: 'm', permissionMode: 'bypassPermissions' }, askedAt: '2026-11-05T08:00:00.000Z',
      answer: { allow: true, updatedInput: { ...QUESTION, answers: { 'Which colour?': 'Red' } } },
    });
    assert.equal(after.allAnswered('oq-1'), true);
    assert.deepEqual(after.take('oq-1').map((x) => x.requestId), ['r1']);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const again = new OpenQuestions();
    await again.load();
    assert.deepEqual(again.list(), [], 'taken: gone from the database');
    after.resetForTests();
    again.resetForTests();
  });
});

test('a question past the safety limit when the process starts closes as expired', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    await sessionsDb.createAppSession('oq-2', 'claude', '/tmp/oq-2');
    const first = new OpenQuestions();
    await first.add({ requestId: 'r2', sessionId: 'oq-2', providerSessionId: null, toolName: 'AskUserQuestion', toolUseId: null, input: QUESTION, runOptions: {}, askedAt: '2026-10-01T00:00:00.000Z', answer: null });
    first.resetForTests();
    const later = new OpenQuestions({ limitMs: () => 60_000 });
    const closed: unknown[] = [];
    later.on('closed', (c) => closed.push(c));
    await later.load();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(closed, [{ sessionId: 'oq-2', requestId: 'r2', reason: 'expired' }]);
    later.resetForTests();
  });
});

test("answers in AskUserQuestion's own words (Claude Code 2.1.304)", () => {
  const two = {
    questions: [
      { question: 'Which colour?', options: [{ label: 'Red' }, { label: 'Blue' }] },
      { question: 'Which sizes?', options: [{ label: 'S' }, { label: 'M' }, { label: 'L' }], multiSelect: true },
    ],
  };
  assert.equal(
    askUserQuestionResult({ ...two, answers: { 'Which colour?': 'Blue', 'Which sizes?': 'S, L' } }),
    'Your questions have been answered: "Which colour?"="Blue", "Which sizes?"="S, L". You can now continue with these answers in mind.',
  );
  assert.equal(
    askUserQuestionResult({ ...two, answers: { 'Which colour?': 'Teal' } }),
    'The user answered: "Which colour?"="Teal". Read the answers carefully — they may request clarification, changes, or that you not proceed — and follow what they actually say.',
    'an answer of their own',
  );
  assert.equal(askUserQuestionResult({ ...two, answers: {} }), 'The user did not answer the questions.');
  assert.equal(
    askUserQuestionResult({ ...two, answers: { 'Which colour?': 'Red' }, annotations: { 'Which colour?': { notes: 'darker' } } }),
    'The user answered: "Which colour?"="Red" notes: darker. Read the answers carefully — they may request clarification, changes, or that you not proceed — and follow what they actually say.',
  );
});

test('the continuation: denials, plans, and several questions', () => {
  assert.equal(
    answerContinuation([{ toolName: 'AskUserQuestion', input: QUESTION, answer: { allow: false, message: 'The person dismissed the question without answering.' } }]),
    'The person dismissed the question without answering.',
  );
  assert.equal(
    answerContinuation([{ toolName: 'ExitPlanMode', input: { plan: '1. do it' }, answer: { allow: true } }]),
    'User has approved your plan. You can now start coding. Start with updating your todo list if applicable\n\n## Approved Plan:\n1. do it',
  );
  assert.equal(
    answerContinuation([
      { toolName: 'AskUserQuestion', input: QUESTION, answer: { allow: true, updatedInput: { ...QUESTION, answers: { 'Which colour?': 'Red' } } } },
      { toolName: 'ExitPlanMode', input: {}, answer: { allow: true } },
    ]),
    'Your questions have been answered: "Which colour?"="Red". You can now continue with these answers in mind.\n\nUser has approved exiting plan mode. You can now proceed.',
  );
  assert.equal(formatAskDuration(24 * 60 * 60 * 1000), '1 day');
  assert.equal(formatAskDuration(90_000), '1.5 minutes');
});
