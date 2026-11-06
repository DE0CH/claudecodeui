import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { get, initializeDatabase, run } from '@/modules/database/index.js';
import { releaseTestDatabase } from '@/modules/database/testing.js';
import { deleteSchedulesOf } from '@/modules/jarvis/jarvis-conversations.js';
import { recordScheduleAnswers } from '@/modules/jarvis/jarvis-schedules.routes.js';
import {
  awaitScheduleAnswer,
  onScheduleAnswer,
  settleScheduleAnswers,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';

/**
 * A fired schedule's run becomes 已回覆 once the conversation answers it (the approved mock): the runtime keeps the
 * runs waiting per conversation and settles them on the next result; the route writes the outcome into the router's
 * cc_shared.schedule_runs, waiting for a row the router has not committed yet.
 */

test('the runtime settles the runs waiting on a conversation once, with whether it answered', () => {
  const seen: Array<[string[], boolean]> = [];
  onScheduleAnswer((keys: string[], answered: boolean) => seen.push([keys, answered]));
  awaitScheduleAnswer('conv-a', 'sch_1:100');
  awaitScheduleAnswer('conv-a', 'sch_2:200');
  awaitScheduleAnswer('conv-b', 'sch_3:300');
  settleScheduleAnswers('conv-a', true);
  settleScheduleAnswers('conv-a', true);
  settleScheduleAnswers('conv-c', true);
  settleScheduleAnswers('conv-b', false);
  assert.deepEqual(seen, [[['sch_1:100', 'sch_2:200'], true], [['sch_3:300'], false]]);
  onScheduleAnswer(() => undefined);
});

test('the route records answered, answered mid-turn and unanswered, and waits for the router\'s row', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'jarvis-schedules-answer-'));
  process.env.DATABASE_PATH = path.join(temp, 'answer.db');
  try {
    await initializeDatabase();
    await run('CREATE SCHEMA IF NOT EXISTS cc_shared');
    await run(`CREATE TABLE IF NOT EXISTS cc_shared.schedule_runs (
      schedule_id text not null, due_at timestamptz not null, at timestamptz not null default now(),
      outcome text not null, conversation_id text not null, detail text, primary key (schedule_id, due_at))`);
    const tag = randomUUID().replace(/-/g, '').slice(0, 12);
    const id = (n: string) => `sch_${tag}${n}`;
    const due = 1_800_000_000;
    const insert = (sid: string, outcome: string) =>
      run('INSERT INTO cc_shared.schedule_runs (schedule_id, due_at, outcome, conversation_id) VALUES (?, to_timestamp(?::double precision), ?, ?)', [sid, due, outcome, 'c']);
    const outcome = async (sid: string) =>
      (await get<{ outcome: string }>('SELECT outcome FROM cc_shared.schedule_runs WHERE schedule_id = ?', [sid]))?.outcome;
    const noSleep = async () => undefined;

    await insert(id('a'), 'sent');
    await insert(id('b'), 'sent_mid_turn');
    await insert(id('c'), 'sent');
    await insert(id('d'), 'skipped_late');
    await recordScheduleAnswers([`${id('a')}:${due}`, `${id('b')}:${due}`], true, undefined, undefined, noSleep);
    await recordScheduleAnswers([`${id('c')}:${due}`], false, undefined, undefined, noSleep);
    assert.equal(await outcome(id('a')), 'answered');
    assert.equal(await outcome(id('b')), 'answered_mid_turn');
    assert.equal(await outcome(id('c')), 'unanswered');
    // a run that is not waiting for an answer (skipped, or already settled) stays as it is, with no retries
    let sleeps = 0;
    await recordScheduleAnswers([`${id('d')}:${due}`, `${id('a')}:${due}`], false, undefined, undefined, async () => { sleeps += 1; });
    assert.equal(await outcome(id('d')), 'skipped_late');
    assert.equal(await outcome(id('a')), 'answered');
    assert.equal(sleeps, 0);
    // the router writes its row after the delivery's answer: the answer waits for it
    let waited = 0;
    await recordScheduleAnswers([`${id('e')}:${due}`], true, undefined, undefined, async () => {
      waited += 1;
      if (waited === 2) await insert(id('e'), 'sent');
    });
    assert.equal(await outcome(id('e')), 'answered');
    assert.equal(waited, 2);
    // a row that never comes: given up after its tries
    let tries = 0;
    await recordScheduleAnswers([`${id('f')}:${due}`], true, undefined, undefined, async () => { tries += 1; });
    assert.equal(tries, 5);
    await run('DELETE FROM cc_shared.schedule_runs WHERE schedule_id LIKE ?', [`sch_${tag}%`]);
  } finally {
    await releaseTestDatabase();
    delete process.env.DATABASE_PATH;
    await rm(temp, { recursive: true, force: true });
  }
});

test('a conversation deleted for good takes its schedules with it, but not the rows moved to the new stack', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'jarvis-schedules-delete-'));
  process.env.DATABASE_PATH = path.join(temp, 'delete.db');
  try {
    await initializeDatabase();
    await run('CREATE SCHEMA IF NOT EXISTS cc_shared');
    await run(`CREATE TABLE IF NOT EXISTS cc_shared.schedules (
      id text primary key, person text not null, conversation_id text not null, kind text not null, prompt text not null,
      at timestamptz, cron text, tz text not null, until timestamptz, describe text not null, next_at timestamptz,
      state text not null, created_at timestamptz not null default now(), created_by text not null,
      updated_at timestamptz not null default now(), deleted_at timestamptz)`);
    const conv = randomUUID();
    const other = randomUUID();
    const add = (id: string, c: string, state: string) =>
      run(`INSERT INTO cc_shared.schedules (id, person, conversation_id, kind, prompt, cron, tz, describe, next_at, state, created_by)
           VALUES (?, 'p@example.com', ?, 'cron', 'x', '0 9 * * *', 'Asia/Hong_Kong', 'd', now(), ?, 'p@example.com')`, [id, c, state]);
    const tag = randomUUID().replace(/-/g, '').slice(0, 12);
    await add(`sch_${tag}1`, conv, 'active');
    await add(`sch_${tag}2`, conv, 'done');
    await add(`sch_${tag}3`, conv, 'moved');
    await add(`sch_${tag}4`, other, 'active');
    await deleteSchedulesOf(conv);
    const state = async (id: string) =>
      (await get<{ state: string; next_at: string | null }>('SELECT state, next_at FROM cc_shared.schedules WHERE id = ?', [id]));
    assert.deepEqual(await state(`sch_${tag}1`), { state: 'deleted', next_at: null });
    assert.equal((await state(`sch_${tag}2`))?.state, 'deleted');
    assert.equal((await state(`sch_${tag}3`))?.state, 'moved');
    assert.equal((await state(`sch_${tag}4`))?.state, 'active');
    await run('DELETE FROM cc_shared.schedules WHERE id LIKE ?', [`sch_${tag}%`]);
  } finally {
    await releaseTestDatabase();
    delete process.env.DATABASE_PATH;
    await rm(temp, { recursive: true, force: true });
  }
});
