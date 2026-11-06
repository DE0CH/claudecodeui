// Schedules on the old stack (jarvis/schedules.mjs). The rules and readings are checked against the same cases as
// the new stack's (DE0CH/aviary crates/magpie/src/schedules/cron.rs tests), so the AI reads the same words on both.
// With SCHEDULES_TEST_DATABASE_URL (a Postgres the test may write) and PG_MODULE (the path of node-postgres), the
// store, the AI's API, the panel, the admin page and firing are checked too: idle → a new turn, a running turn → into
// it, busy → delivered again, at most 10 minutes late (else skipped), pause-all, exactly once across replicas.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import {
  Schedules, describeCron, describeOnce, describeRule, local, message, minGap, nextAfter, parseCron, parseTime,
  renderAdmin, spec,
} from "../schedules.mjs";

const HK = "Asia/Hong_Kong";
const t = (s) => parseTime(s, HK);

test("weekdays at half past eight", () => {
  const r = parseCron("30 8 * * 1-5");
  assert.equal(describeRule(r, "30 8 * * 1-5"), "每個工作日 08:30");
  assert.equal(local(nextAfter(r, HK, t("2026-11-06T09:00+08:00")), HK), "2026-11-09T08:30:00+08:00");
  assert.equal(local(nextAfter(r, HK, t("2026-11-06T08:00+08:00")), HK), "2026-11-06T08:30:00+08:00");
});

test("readings (the same as the new stack's)", () => {
  for (const [expr, want] of [
    ["0 9 * * *", "每天 09:00"],
    ["0 9 * * 0,6", "每個週末 09:00"],
    ["0 18 * * MON", "每個星期一 18:00"],
    ["0 9 * * 1,3,5", "每個星期一、三、五 09:00"],
    ["0 9 1 * *", "每月 1 日 09:00"],
    ["0 9 1,15 * *", "每月 1、15 日 09:00"],
    ["0 9 1 1 *", "每年 1 月 1 日 09:00"],
    ["0 * * * *", "每小時第 0 分"],
    ["*/30 * * * *", "每 30 分鐘"],
    ["0 9,13,18 * * 1-5", "每個工作日 09:00、13:00、18:00"],
    ["0 */2 * * *", "每 2 小時（第 0 分）"],
    ["7,19 3 * * *", "按規則「7,19 3 * * *」"],
  ]) assert.equal(describeRule(parseCron(expr), expr), want, expr);
  assert.equal(describeCron(parseCron("0 9 * * *"), "0 9 * * *", "Europe/London"), "每天 09:00（倫敦時間）");
});

test("both day fields restricted: either matches", () => {
  const r = parseCron("0 9 13 * 5");
  assert.equal(local(nextAfter(r, HK, t("2026-11-06T08:00+08:00")), HK), "2026-11-06T09:00:00+08:00");
  assert.equal(local(nextAfter(r, HK, t("2026-11-06T10:00+08:00")), HK), "2026-11-13T09:00:00+08:00");
  assert.equal(local(nextAfter(parseCron("0 9 13 * *"), HK, t("2026-11-14T00:00+08:00")), HK), "2026-12-13T09:00:00+08:00");
});

test("refused rules", () => {
  for (const bad of ["", "* * * *", "60 * * * *", "0 24 * * *", "0 0 0 * *", "0 0 * 13 *", "0 0 * * 8", "*/0 * * * *", "5-1 * * * *", "a * * * *"]) {
    assert.throws(() => parseCron(bad), undefined, bad);
  }
  assert.equal(nextAfter(parseCron("0 0 30 2 *"), HK, 0), null);
});

test("gaps", () => {
  assert.equal(minGap(parseCron("*/5 * * * *"), HK, 0, 50), 300);
  assert.equal(minGap(parseCron("0,10 9 * * *"), HK, 0, 50), 600);
  assert.equal(minGap(parseCron("30 8 * * 1-5"), HK, 0, 50), 86400);
});

test("times", () => {
  assert.equal(t("2026-11-07T09:00+08:00"), t("2026-11-07T01:00:00Z"));
  assert.equal(t("2026-11-07 09:00"), t("2026-11-07T09:00:00+08:00"));
  assert.equal(t("2026-11-07T09:00:30.5+0800"), t("2026-11-07T01:00:30Z"));
  for (const bad of ["tomorrow", "2026-11-07", "2026-13-07T09:00", "2026-11-07T25:00", "2026-11-07T09:00+8"]) {
    assert.throws(() => parseTime(bad, HK), undefined, bad);
  }
  assert.equal(local(t("2026-11-07T01:00:00Z"), HK), "2026-11-07T09:00:00+08:00");
  assert.equal(local(t("2026-07-01T12:00:00Z"), "Europe/London"), "2026-07-01T13:00:00+01:00");
});

test("one-offs", () => {
  const now = t("2026-11-06T10:00+08:00");
  assert.equal(describeOnce(t("2026-11-09T15:00+08:00"), HK, now), "11月9日（星期一）15:00");
  assert.equal(describeOnce(t("2027-01-04T09:00+08:00"), HK, now), "2027年1月4日（星期一）09:00");
});

test("daylight saving", () => {
  const after = parseTime("2027-03-27T12:00:00Z", "Europe/London");
  assert.equal(local(nextAfter(parseCron("30 1 * * *"), "Europe/London", after), "Europe/London"), "2027-03-29T01:30:00+01:00");
});

test("spec: safety stops and words", () => {
  const now = t("2026-11-06T10:00+08:00");
  assert.throws(() => spec({ cron: "*/5 * * * *" }, now), /at most every 15 minutes/);
  assert.throws(() => spec({ cron: "0 9 30 2 *" }, now), /never fires/);
  assert.throws(() => spec({ at: "2020-01-01T09:00+08:00" }, now), /in the past/);
  assert.throws(() => spec({}, now), /give at/);
  assert.throws(() => spec({ cron: "0 9 * * *", tz: "Mars/Base" }, now), /IANA/);
  const s = spec({ cron: "30  8 * * 1-5" }, now);
  assert.deepEqual([s.kind, s.cron, s.tz, s.describe, local(s.next, HK)], ["cron", "30 8 * * 1-5", HK, "每個工作日 08:30", "2026-11-09T08:30:00+08:00"]);
  assert.equal(message("每天 09:00", "整理新聞"), '<scheduled-message rule="每天 09:00">整理新聞</scheduled-message>');
  assert.equal(message('a"b&c', "x"), '<scheduled-message rule="a&quot;b&amp;c">x</scheduled-message>');
});

test("the admin page escapes and offers the switch", () => {
  const page = renderAdmin({ pausedAll: false, schedules: [{ id: "sch_1", conversationId: "c", kind: "cron", prompt: "<b>news</b>", cron: "30 8 * * 1-5",
    tz: HK, describe: "每個工作日 08:30", next: null, state: "active", createdBy: "a@example.com", createdAt: "x", runs: [{ due: "d", at: "a", outcome: "skipped_late" }] }] });
  assert.ok(page.includes("&lt;b&gt;news&lt;/b&gt;") && !page.includes("<b>news"));
  assert.ok(page.includes("Pause all schedules") && page.includes("skipped: the service was down for more than 10 minutes"));
  assert.ok(renderAdmin({ pausedAll: true, pausedBy: "d@example.com", schedules: [] }).includes("Resume all schedules"));
});

// ---- with a database ----

const DB = process.env.SCHEDULES_TEST_DATABASE_URL;
const PG = process.env.PG_MODULE;

async function world() {
  const { default: pg } = await import(pathToFileURL(PG).href);
  const pool = new pg.Pool({ connectionString: DB, max: 8 });
  const tag = randomUUID().slice(0, 8);
  // a person's CloudCLI schema: their user row and a conversation
  const person = `p${tag}@example.com`;
  const schema = `cc_u${tag}`;
  await pool.query(`create schema ${schema}`);
  await pool.query(`create table ${schema}.users (id serial primary key, username text not null)`);
  await pool.query(`create table ${schema}.sessions (session_id text primary key, custom_name text)`);
  await pool.query(`insert into ${schema}.users (username) values ($1)`, [person]);
  const conversation = randomUUID();
  await pool.query(`insert into ${schema}.sessions values ($1, '每日新聞摘要')`, [conversation]);
  const delivered = [];
  let reply = "sent";
  const make = (now = Date.now) => new Schedules({
    pool, token: "tok", admins: new Set(["admin@example.com"]), now,
    deliver: async (email, body) => { delivered.push({ email, ...body }); return { outcome: reply }; },
  });
  return { pool, person, conversation, delivered, make, setReply: (r) => { reply = r; },
    async close() {
      await pool.query(`delete from cc_shared.schedule_runs where conversation_id = $1`, [conversation]);
      await pool.query(`delete from cc_shared.schedules where conversation_id = $1`, [conversation]);
      await pool.query(`drop schema ${schema} cascade`);
      await pool.end();
    } };
}

/** Calls the AI's API as egress would. */
async function call(s, conversation, method, path, body) {
  let status = 0;
  let text = "";
  const res = { writeHead(st) { status = st; }, end(b) { text = b ?? ""; }, setHeader() {} };
  const req = { method, url: `/__jarvis/schedules${path}`, headers: { authorization: "Bearer tok", "x-jarvis-conversation": conversation } };
  await s.handleApi(req, res, body ? JSON.stringify(body) : "");
  return { status, body: text ? JSON.parse(text) : null };
}

const db = DB && PG ? test : test.skip;

db("the AI's API: arm, list, read, change, delete; others refused", async () => {
  const w = await world();
  try {
    const s = w.make();
    const created = await call(s, w.conversation, "POST", "", { prompt: "整理新聞", cron: "30 8 * * 1-5" });
    assert.equal(created.status, 201);
    assert.match(created.body.id, /^sch_[0-9a-f]{32}$/);
    assert.equal(created.body.describe, "每個工作日 08:30");
    assert.equal(created.body.createdBy, w.person);
    assert.match(created.body.next, /08:30:00\+08:00$/);
    const id = created.body.id;
    assert.equal((await call(s, w.conversation, "GET", "")).body.schedules.length, 1);
    assert.deepEqual((await call(s, w.conversation, "GET", `/${id}`)).body.runs, []);
    const paused = await call(s, w.conversation, "PATCH", `/${id}`, { paused: true });
    assert.deepEqual([paused.body.state, paused.body.next], ["paused", null]);
    const resumed = await call(s, w.conversation, "PATCH", `/${id}`, { paused: false, cron: "0 9 * * *" });
    assert.deepEqual([resumed.body.state, resumed.body.describe], ["active", "每天 09:00"]);
    const bad = await call(s, w.conversation, "POST", "", { prompt: "x", cron: "*/5 * * * *" });
    assert.deepEqual([bad.status, bad.body.code], [400, "bad_request"]);
    // another conversation's sandbox (not this person's) sees nothing of it
    const stranger = await call(s, randomUUID(), "GET", `/${id}`);
    assert.equal(stranger.status, 404);
    // a wrong token: nothing
    let status = 0;
    await s.handleApi({ method: "GET", url: "/__jarvis/schedules", headers: { authorization: "Bearer no", "x-jarvis-conversation": w.conversation } },
      { writeHead(st) { status = st; }, end() {}, setHeader() {} }, "");
    assert.equal(status, 404);
    assert.equal((await call(s, w.conversation, "DELETE", `/${id}`)).status, 204);
    assert.equal((await call(s, w.conversation, "GET", `/${id}`)).status, 404);
    // the panel: the owner's only
    assert.equal((await s.panel(w.person, w.conversation)).schedules.length, 0);
  } finally { await w.close(); }
});

db("the conversation's title: in the AI's list, one schedule and the admin page (as magpie), not the panel's list", async () => {
  const w = await world();
  try {
    const s = w.make();
    const { body } = await call(s, w.conversation, "POST", "", { prompt: "整理新聞", cron: "30 8 * * 1-5" });
    assert.equal((await call(s, w.conversation, "GET", "")).body.schedules[0].conversationTitle, "每日新聞摘要");
    assert.equal((await call(s, w.conversation, "GET", `/${body.id}`)).body.conversationTitle, "每日新聞摘要");
    const view = await s.adminView();
    const mine = view.schedules.find((x) => x.id === body.id);
    assert.equal(mine.conversationTitle, "每日新聞摘要");
    assert.ok(renderAdmin({ ...view, schedules: [mine] }).includes(`每日新聞摘要 · ${w.conversation}`));
    assert.equal((await s.panel(w.person, w.conversation)).schedules[0].conversationTitle, undefined);
    // the process records the answer in the run's outcome; the admin page reads it
    await w.pool.query(`insert into cc_shared.schedule_runs (schedule_id, due_at, outcome, conversation_id) values ($1, now(), 'answered', $2)`, [body.id, w.conversation]);
    const answered = (await s.adminView()).schedules.find((x) => x.id === body.id);
    assert.equal(answered.runs[0].outcome, "answered");
    assert.ok(renderAdmin({ pausedAll: false, schedules: [answered] }).includes("answered (a new turn)"));
  } finally { await w.close(); }
});

db("firing: idle, mid-turn, busy, late, paused, deleted — each once", async () => {
  const w = await world();
  try {
    const s = w.make();
    const { body } = await call(s, w.conversation, "POST", "", { prompt: "看看進度", cron: "0 9 * * *" });
    const due = (ago) => w.pool.query(`update cc_shared.schedules set next_at = now() - make_interval(secs => $2) where id = $1`, [body.id, ago]);
    const runs = async () => (await w.pool.query(`select outcome from cc_shared.schedule_runs where schedule_id = $1 order by at, due_at`, [body.id])).rows.map((r) => r.outcome);
    assert.equal(await s.tick(), 0, "nothing due");
    await due(5);
    w.setReply("sent");
    assert.equal(await s.tick(), 1);
    assert.deepEqual(await runs(), ["sent"]);
    assert.equal(w.delivered[0].text, '<scheduled-message rule="每天 09:00">看看進度</scheduled-message>');
    assert.equal(w.delivered[0].sessionId, w.conversation);
    assert.equal(w.delivered[0].email, w.person);
    assert.equal(await s.tick(), 0, "moved on to its next time");
    await due(5);
    w.setReply("sent_mid_turn");
    await s.tick();
    assert.deepEqual(await runs(), ["sent", "sent_mid_turn"]);
    // busy (a turn starting): recorded to deliver again, delivered on a later pass
    await due(5);
    w.setReply("busy");
    await s.tick();
    assert.deepEqual(await runs(), ["sent", "sent_mid_turn", "redeliver"]);
    w.setReply("sent");
    await s.tick();
    assert.deepEqual(await runs(), ["sent", "sent_mid_turn", "sent"]);
    // more than 10 minutes late: skipped, not delivered
    const before = w.delivered.length;
    await due(11 * 60);
    await s.tick();
    assert.equal((await runs()).at(-1), "skipped_late");
    assert.equal(w.delivered.length, before);
    // within 10 minutes: sent once on recovery
    await due(9 * 60);
    await s.tick();
    assert.equal((await runs()).at(-1), "sent");
    // pause-all
    await s.setPaused("admin@example.com", true);
    await due(5);
    await s.tick();
    assert.equal((await runs()).at(-1), "skipped_paused");
    await s.setPaused("admin@example.com", false);
    const view = await s.adminView();
    assert.ok(view.schedules.some((x) => x.id === body.id && x.runs.length === 6));
    // exactly once across two replicas ticking at the same time
    const other = w.make();
    await due(5);
    const n0 = w.delivered.length;
    const [a, b] = await Promise.all([s.tick(), other.tick()]);
    assert.equal(a + b, 1);
    assert.equal(w.delivered.length, n0 + 1);
    // a one-off is done after its fire
    const once = await call(s, w.conversation, "POST", "", { prompt: "提醒", at: new Date(Date.now() + 120_000).toISOString() });
    await w.pool.query(`update cc_shared.schedules set next_at = now() where id = $1`, [once.body.id]);
    await s.tick();
    const { rows: [row] } = await w.pool.query(`select state, next_at from cc_shared.schedules where id = $1`, [once.body.id]);
    assert.deepEqual([row.state, row.next_at], ["done", null]);
  } finally { await w.close(); }
});
