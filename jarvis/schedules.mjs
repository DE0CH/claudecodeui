// Schedules (Deyao, 2026-11-06; DE0CH/aviary magpie src/schedules is the new stack's): a message the conversation's
// AI arms to be posted into that same conversation once (`at`) or on a repeating rule (`cron` read in `tz`, until
// `until`). Everything here is the router's: the AI's REST API (egress's sandbox route `schedules` →
// /__jarvis/schedules, bearer JARVIS_SENT_FILES_TOKEN, the conversation as egress verified it), the app's panel
// (GET /api/jarvis/sessions/<id>/schedules for the signed-in person), the admin page /ops/schedules, and firing.
//
// The REST shape, the reading of a rule (`describe`, plain Hong Kong Chinese), the safety stops and the firing rules
// are the new stack's, word for word, so the AI's skill and the app are the same on both stacks:
//   POST   <base>            {prompt, at} | {prompt, cron, tz?, until?}      → 201 the schedule
//   GET    <base>            → {schedules: [...]} (the person's, every conversation)
//   GET    <base>/<id>       → the schedule with its last 10 runs
//   PATCH  <base>/<id>       {paused} | {prompt} | {at} | {cron, tz?, until?} → the schedule
//   DELETE <base>/<id>       → 204
//   errors: {code: bad_request | not_found, message} (400, 404)
// Firing (every replica, every 5 s; each due row claimed with `for update skip locked`, its run recorded under the
// key (schedule, due time) and next_at moved on in the same transaction: exactly once across replicas): the replica
// that serves the person (rendezvous hash) posts `<scheduled-message rule="…">prompt</scheduled-message>` into the
// conversation through the person's CloudCLI process (POST /api/jarvis/schedules/deliver, jarvis-schedules.routes.ts):
// a new turn when the conversation is idle, at once into the running turn when one runs (Claude Code takes it in at
// its next tool result or when the model stops). More than 10 minutes late (the service was down): skipped and
// recorded. The pause-all switch records due times as skipped; Recently deleted too. A conversation released to the
// new stack (aviary magpie-import carries its schedules over and marks the rows `moved`) is never fired here again.
//
// Tables (database cloudcli, schema cc_shared, made here on first use): schedules, schedule_runs, schedule_settings.
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

export const DEFAULT_TZ = "Asia/Hong_Kong";
export const MIN_GAP_SECONDS = 15 * 60;
export const MAX_LIVE = 25;
export const PROMPT_MAX_CHARS = 8000;
export const LATE_LIMIT_SECONDS = 10 * 60;
export const RUNS_SHOWN = 10;
export const FIRE_EVERY_MS = 5000;
export const API_PATH = "/__jarvis/schedules";
export const ADMIN_PATH = "/ops/schedules";
export const PAUSE_PATH = "/ops/schedules/pause";
const SEARCH_DAYS = 366 * 5;
const AT_MAX_AHEAD = 2 * 366 * 86400;
const SCHEMA = "cc_shared";

export class BadRequest extends Error {}
export class NotFound extends Error {}

// ---- rules and times (the same as aviary crates/magpie/src/schedules/cron.rs) ----

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const WEEKDAY_ZH = ["日", "一", "二", "三", "四", "五", "六"];

function value(s, lo, hi, names, first) {
  const i = names.indexOf(s.toUpperCase());
  if (i >= 0) return first + i;
  if (!/^\d+$/.test(s)) throw new BadRequest(`\`${s}\` is not a number`);
  const v = Number(s);
  if (v < lo || v > hi) throw new BadRequest(`${v} is outside ${lo}-${hi}`);
  return v;
}

/** One field: the set of its values and whether it starts with `*`. */
function field(s, lo, hi, names = [], first = 0) {
  if (!s) throw new BadRequest("an empty field");
  const set = new Set();
  for (const part of s.split(",")) {
    let base = part;
    let step = 1;
    const slash = part.indexOf("/");
    if (slash >= 0) {
      base = part.slice(0, slash);
      const st = part.slice(slash + 1);
      if (!/^\d+$/.test(st)) throw new BadRequest(`\`${st}\` is not a step`);
      step = Number(st);
      if (step === 0) throw new BadRequest("a step of 0");
    }
    let a;
    let b;
    if (base === "*") [a, b] = [lo, hi];
    else if (base.includes("-")) {
      const [x, y] = base.split("-");
      [a, b] = [value(x, lo, hi, names, first), value(y, lo, hi, names, first)];
    } else {
      a = value(base, lo, hi, names, first);
      b = slash >= 0 ? hi : a;
    }
    if (a > b) throw new BadRequest(`the range ${a}-${b} runs backwards`);
    for (let v = a; v <= b; v += step) set.add(v);
  }
  return { set, any: s.startsWith("*") };
}

/** Parses a five-field rule (minute hour day-of-month month day-of-week). */
export function parseCron(expr) {
  const f = String(expr).trim().split(/\s+/).filter(Boolean);
  if (f.length !== 5) throw new BadRequest("a cron rule has five fields: minute hour day-of-month month day-of-week");
  const wrap = (what, fn) => {
    try { return fn(); } catch (e) { throw new BadRequest(`${what}: ${e.message}`); }
  };
  const minutes = wrap("minute", () => field(f[0], 0, 59)).set;
  const hours = wrap("hour", () => field(f[1], 0, 23)).set;
  const days = wrap("day of month", () => field(f[2], 1, 31));
  const months = wrap("month", () => field(f[3], 1, 12, MONTHS, 1)).set;
  const weekdays = wrap("day of week", () => field(f[4], 0, 7, WEEKDAYS, 0));
  if (weekdays.set.has(7)) { weekdays.set.delete(7); weekdays.set.add(0); }
  return { minutes, hours, days: days.set, daysAny: days.any, months, weekdays: weekdays.set, weekdaysAny: weekdays.any };
}

const formatters = new Map();
function formatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
      minute: "2-digit", second: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Checks an IANA zone name. */
export function zone(name) {
  try {
    formatter(name).format(0);
    return name;
  } catch {
    throw new BadRequest(`\`${name}\` is not an IANA time zone (e.g. Asia/Hong_Kong)`);
  }
}

/** The wall clock of Unix second `t` in `tz`: {y, m, d, h, mi, s, wd, offset (seconds east of UTC)}. */
export function wall(t, tz) {
  const parts = Object.fromEntries(formatter(tz).formatToParts(new Date(t * 1000)).map((p) => [p.type, p.value]));
  const [y, m, d, h, mi, s] = ["year", "month", "day", "hour", "minute", "second"].map((k) => Number(parts[k]));
  const asUtc = Date.UTC(y, m - 1, d, h, mi, s) / 1000;
  return { y, m, d, h, mi, s, wd: new Date(Date.UTC(y, m - 1, d)).getUTCDay(), offset: asUtc - t };
}

/** The first Unix second whose wall clock in `tz` is that time; null when it does not exist (a clock change gap). */
export function fromWall(tz, y, m, d, h, mi, s = 0) {
  const guess = Date.UTC(y, m - 1, d, h, mi, s) / 1000;
  const out = [];
  for (const probe of [guess - 86400, guess + 86400]) {
    const t = guess - wall(probe, tz).offset;
    const w = wall(t, tz);
    if (w.y === y && w.m === m && w.d === d && w.h === h && w.mi === mi && w.s === s && !out.includes(t)) out.push(t);
  }
  return out.length ? Math.min(...out) : null;
}

const sorted = (set) => [...set].sort((a, b) => a - b);

/** The first fire strictly after Unix second `after`, in `tz`; null within five years. */
export function nextAfter(rule, tz, after) {
  const start = wall(after, tz);
  const hours = sorted(rule.hours);
  const minutes = sorted(rule.minutes);
  for (let i = 0; i < SEARCH_DAYS; i++) {
    const date = new Date(Date.UTC(start.y, start.m - 1, start.d + i));
    const [y, m, d, wd] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCDay()];
    if (!rule.months.has(m)) continue;
    const dom = rule.days.has(d);
    const dow = rule.weekdays.has(wd);
    if (!(rule.daysAny || rule.weekdaysAny ? dom && dow : dom || dow)) continue;
    for (const h of hours) {
      for (const mi of minutes) {
        const t = fromWall(tz, y, m, d, h, mi);
        if (t !== null && t > after) return t;
      }
    }
  }
  return null;
}

/** The shortest gap between consecutive fires over the next `n` fires (seconds); null when it fires fewer than twice. */
export function minGap(rule, tz, after, n) {
  let prev = nextAfter(rule, tz, after);
  if (prev === null) return null;
  let gap = null;
  for (let i = 1; i < n; i++) {
    const t = nextAfter(rule, tz, prev);
    if (t === null) break;
    gap = gap === null ? t - prev : Math.min(gap, t - prev);
    prev = t;
  }
  return gap;
}

/** The step of values that run evenly from `lo` to the end of the range, when they do and there are at least two. */
function evenStep(v, lo, hi) {
  if (v.length < 2 || v[0] !== lo) return null;
  const step = v[1] - v[0];
  for (let i = 1; i < v.length; i++) if (v[i] - v[i - 1] !== step) return null;
  return v[v.length - 1] + step > hi ? step : null;
}

const pad = (n) => String(n).padStart(2, "0");

function timePart(rule) {
  const mins = sorted(rule.minutes);
  const hrs = sorted(rule.hours);
  const everyHour = hrs.length === 24;
  if (mins.length === 1) {
    const minute = mins[0];
    if (everyHour) return `每小時第 ${minute} 分`;
    if (hrs.length <= 6) return hrs.map((h) => `${pad(h)}:${pad(minute)}`).join("、");
    const step = evenStep(hrs, 0, 23);
    return step === null ? null : `每 ${step} 小時（第 ${minute} 分）`;
  }
  if (everyHour && mins[0] === 0) {
    const step = evenStep(mins, 0, 59);
    if (step !== null) return `每 ${step} 分鐘`;
  }
  return null;
}

function dayPart(rule) {
  const allMonths = rule.months.size === 12;
  const wd = sorted(rule.weekdays);
  const ds = sorted(rule.days);
  let weekdays = null;
  if (!rule.weekdaysAny) {
    if (wd.join() === "1,2,3,4,5") weekdays = "每個工作日";
    else if (wd.join() === "0,6") weekdays = "每個週末";
    else weekdays = `每個星期${wd.map((d) => WEEKDAY_ZH[d]).join("、")}`;
  }
  const days = rule.daysAny ? null : ds.join("、");
  const months = allMonths ? null : sorted(rule.months).join("、");
  if (months === null && days === null && weekdays === null) return "每天";
  if (months === null && days === null) return weekdays;
  if (months === null && weekdays === null) return `每月 ${days} 日`;
  if (months === null) return `每月 ${days} 日及${weekdays}`;
  if (days === null && weekdays === null) return `每年 ${months} 月每天`;
  if (days === null) return `每年 ${months} 月${weekdays}`;
  if (weekdays === null) return `每年 ${months} 月 ${days} 日`;
  return `每年 ${months} 月 ${days} 日及${weekdays}`;
}

/** A rule in plain Hong Kong Chinese (`每個工作日 08:30`); one this reading cannot put in words is quoted. */
export function describeRule(rule, expr) {
  const day = dayPart(rule);
  const t = timePart(rule);
  if (t === null) return `按規則「${String(expr).trim().split(/\s+/).join(" ")}」`;
  if (day === "每天" && t.startsWith("每")) return t;
  return `${day} ${t}`;
}

const ZONE_WORDS = {
  "Asia/Shanghai": "北京時間", "Asia/Taipei": "台北時間", "Asia/Macau": "澳門時間", "Asia/Singapore": "新加坡時間",
  "Asia/Tokyo": "東京時間", "Asia/Seoul": "首爾時間", "Europe/London": "倫敦時間", "America/New_York": "紐約時間",
  UTC: "UTC", "Etc/UTC": "UTC",
};

/** A zone in words; null for Hong Kong (the default says nothing). */
export function zoneWords(tz) {
  if (tz === "Asia/Hong_Kong") return null;
  return ZONE_WORDS[tz] ?? tz;
}

export function describeCron(rule, expr, tz) {
  const d = describeRule(rule, expr);
  const z = zoneWords(tz);
  return z ? `${d}（${z}）` : d;
}

/** A one-off's reading: `11月7日（星期五）09:00`, with the year when it is not now's, and the zone. */
export function describeOnce(at, tz, now) {
  const l = wall(at, tz);
  const year = l.y === wall(now, tz).y ? "" : `${l.y}年`;
  const d = `${year}${l.m}月${l.d}日（星期${WEEKDAY_ZH[l.wd]}）${pad(l.h)}:${pad(l.mi)}`;
  const z = zoneWords(tz);
  return z ? `${d}（${z}）` : d;
}

/** Unix second `t` as a local time with its offset in `tz`: `2026-11-07T08:30:00+08:00`. */
export function local(t, tz) {
  const w = wall(t, tz);
  const off = Math.abs(w.offset);
  const sign = w.offset < 0 ? "-" : "+";
  return `${String(w.y).padStart(4, "0")}-${pad(w.m)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}:${pad(w.s)}${sign}${pad(Math.floor(off / 3600))}:${pad(Math.floor((off % 3600) / 60))}`;
}

/** A time as the AI writes it (2026-11-07T09:00+08:00, …Z, or a local 2026-11-07 09:00 in `tz`) → Unix seconds. */
export function parseTime(s, tz) {
  const text = String(s).trim();
  const bad = () => new BadRequest(`\`${text}\` is not a time like 2026-11-07T09:00+08:00`);
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|z|[+-]\d{2}(?::?\d{2})?)?$/.exec(text);
  if (!m) throw bad();
  const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4], m[5]].map(Number);
  const sec = Math.min(Number(m[6] ?? 0), 59);
  const probe = new Date(Date.UTC(y, mo - 1, d, h, mi, sec));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d || h > 23 || mi > 59) throw bad();
  const zoneText = m[7];
  if (!zoneText) {
    const t = fromWall(tz, y, mo, d, h, mi, sec);
    if (t === null) throw new BadRequest(`${text} does not exist in ${tz} (a clock change)`);
    return t;
  }
  let offset = 0;
  if (!/^z$/i.test(zoneText)) {
    const digits = zoneText.slice(1).replace(":", "");
    if (digits.length !== 4 && digits.length !== 2) throw bad();
    const oh = Number(digits.slice(0, 2));
    const om = digits.length === 4 ? Number(digits.slice(2)) : 0;
    if (oh > 18 || om > 59) throw bad();
    offset = (zoneText[0] === "-" ? -1 : 1) * (oh * 3600 + om * 60);
  }
  return Date.UTC(y, mo - 1, d, h, mi, sec) / 1000 - offset;
}

/** Checks a rule and computes its reading and next fire at `now` (Unix seconds). */
export function spec({ at, cron, tz, until }, now) {
  const trim = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const tzName = trim(tz) ?? DEFAULT_TZ;
  zone(tzName);
  const a = trim(at);
  const c = trim(cron);
  const u = trim(until);
  if (a && c) throw new BadRequest("give either at (once) or cron (repeating), not both");
  if (!a && !c) throw new BadRequest("give at (a one-off time like 2026-11-07T09:00+08:00) or cron (five fields, like 30 8 * * 1-5)");
  if (a) {
    if (u) throw new BadRequest("until is only for a repeating schedule (cron)");
    const t = parseTime(a, tzName);
    if (t < now - 60) throw new BadRequest(`${local(t, tzName)} is in the past (now it is ${local(now, tzName)})`);
    if (t > now + AT_MAX_AHEAD) throw new BadRequest("a one-off can be at most two years ahead");
    return { kind: "once", at: t, cron: null, tz: tzName, until: null, describe: describeOnce(t, tzName, now), next: Math.max(t, now) };
  }
  const expr = c.split(/\s+/).join(" ");
  const rule = parseCron(expr);
  const end = u ? parseTime(u, tzName) : null;
  if (end !== null && end <= now) throw new BadRequest("until is in the past");
  const next = nextAfter(rule, tzName, now);
  if (next === null || (end !== null && next > end)) throw new BadRequest(`\`${expr}\` never fires (before until)`);
  const gap = minGap(rule, tzName, now, 200);
  if (gap !== null && gap < MIN_GAP_SECONDS) throw new BadRequest("a repeating schedule fires at most every 15 minutes");
  return { kind: "cron", at: null, cron: expr, tz: tzName, until: end, describe: describeCron(rule, expr, tzName), next };
}

/** The message a fire posts. */
export function message(describe, prompt) {
  const rule = String(describe).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return `<scheduled-message rule="${rule}">${prompt}</scheduled-message>`;
}

function checkPrompt(p) {
  if (typeof p !== "string" || !p.trim()) throw new BadRequest("prompt is empty: give the exact message to post");
  if ([...p].length > PROMPT_MAX_CHARS) throw new BadRequest("prompt is over 8000 characters");
}

/** The words of a run's outcome on the admin page. */
export const OUTCOME_WORDS = {
  answered: "answered (a new turn)",
  answered_mid_turn: "answered (sent into the running turn)",
  unanswered: "sent, not answered (the turn failed or was stopped)",
  sent: "sent (a new turn), not answered yet",
  sent_mid_turn: "sent into the running turn, not answered yet",
  pending: "being delivered into the running turn",
  redeliver: "to be sent again",
  skipped_late: "skipped: the service was down for more than 10 minutes",
  skipped_paused: "skipped: all schedules paused",
  skipped_deleted: "skipped: the conversation is in Recently deleted",
  failed: "failed",
};

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ---- the store and the firing ----

const DDL = `
create schema if not exists ${SCHEMA};
create table if not exists ${SCHEMA}.schedules (
  id text primary key,
  person text not null,
  conversation_id text not null,
  kind text not null,
  prompt text not null,
  at timestamptz,
  cron text,
  tz text not null,
  until timestamptz,
  describe text not null,
  next_at timestamptz,
  state text not null,
  created_at timestamptz not null default now(),
  created_by text not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists schedules_due on ${SCHEMA}.schedules (next_at) where state = 'active';
create index if not exists schedules_person on ${SCHEMA}.schedules (person);
create index if not exists schedules_conversation on ${SCHEMA}.schedules (conversation_id);
create table if not exists ${SCHEMA}.schedule_runs (
  schedule_id text not null,
  due_at timestamptz not null,
  at timestamptz not null default now(),
  outcome text not null,
  conversation_id text not null,
  detail text,
  primary key (schedule_id, due_at)
);
create table if not exists ${SCHEMA}.schedule_settings (
  id int primary key,
  paused_all boolean not null default false,
  paused_by text,
  paused_at timestamptz
);
insert into ${SCHEMA}.schedule_settings (id) values (1) on conflict do nothing;
`;

const COLUMNS = "id, person, conversation_id, kind, prompt, at, cron, tz, until, describe, next_at, state, created_at, created_by";
const toSec = (d) => (d ? Math.floor(new Date(d).getTime() / 1000) : null);
const toDate = (s) => (s === null || s === undefined ? null : new Date(s * 1000));

/**
 * The schedules of one router replica. `opts`: `pool` (a pg Pool of database cloudcli), `token` (the egress route's
 * bearer), `deliver(email, body)` (posts to the person's process; resolves to its JSON answer), `servesHere(email)`
 * (this replica serves the person and the person is not moved), `admins` (a Set), `now()` (ms), `log(level, msg,
 * fields)`.
 */
export class Schedules {
  constructor(opts) {
    this.pool = opts.pool;
    this.token = opts.token || "";
    this.deliver = opts.deliver;
    this.servesHere = opts.servesHere ?? (() => true);
    this.admins = opts.admins ?? new Set();
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    this.ready = null;
    this.owners = new Map();
    this.schemas = new Map();
    this.timer = null;
    this.firing = false;
  }

  async ensure() {
    if (!this.ready) {
      this.ready = (async () => {
        const c = await this.pool.connect();
        try {
          await c.query("select pg_advisory_lock(hashtext('cc_shared.schedules'))");
          try { await c.query(DDL); } finally { await c.query("select pg_advisory_unlock(hashtext('cc_shared.schedules'))"); }
        } finally { c.release(); }
      })().catch((e) => { this.ready = null; throw e; });
    }
    return this.ready;
  }

  nowSec() { return Math.floor(this.now() / 1000); }

  /** The CloudCLI schema (`cc_u…`) that has conversation `id`'s sessions row (cached), or null. */
  async schemaOf(id) {
    if (this.schemas.has(id)) return this.schemas.get(id);
    const { rows: schemas } = await this.pool.query(
      `select nspname from pg_namespace where nspname like 'cc\\_u%' and to_regclass(quote_ident(nspname) || '.sessions') is not null`);
    for (const { nspname } of schemas) {
      const { rows } = await this.pool.query(`select 1 from "${nspname}".sessions where session_id = $1 limit 1`, [id]);
      if (!rows.length) continue;
      this.schemas.set(id, nspname);
      return nspname;
    }
    return null;
  }

  /** The owner of conversation `id`: the person whose CloudCLI schema has its sessions row (cached). */
  async ownerOf(id) {
    if (this.owners.has(id)) return this.owners.get(id);
    const nspname = await this.schemaOf(id);
    if (!nspname) return null;
    const { rows: users } = await this.pool.query(`select username from "${nspname}".users order by id limit 1`);
    const email = String(users[0]?.username ?? "").trim().toLowerCase();
    if (!email) return null;
    this.owners.set(id, email);
    return email;
  }

  /**
   * `rows` with `title`: each conversation's name as its sidebar shows it (`sessions.custom_name`), as magpie joins
   * `conversations.title` (the AI's list and one schedule, and the admin page; the panel's own list goes without it).
   */
  async withTitles(rows) {
    const titles = new Map();
    for (const id of new Set(rows.map((r) => r.conversation_id))) {
      try {
        const nspname = await this.schemaOf(id);
        if (!nspname) continue;
        const { rows: [t] } = await this.pool.query(`select custom_name from "${nspname}".sessions where session_id = $1`, [id]);
        if (t?.custom_name) titles.set(id, t.custom_name);
      } catch (e) {
        this.log("warn", "schedules: a conversation title was not read", { conversation: id, error: String(e?.message || e) });
      }
    }
    return rows.map((r) => (titles.has(r.conversation_id) ? { ...r, title: titles.get(r.conversation_id) } : r));
  }

  api(row, runs = undefined, title = false) {
    const tz = row.tz;
    const l = (d) => (d ? local(toSec(d), tz) : null);
    const out = {
      id: row.id, conversationId: row.conversation_id, kind: row.kind, prompt: row.prompt,
      ...(row.at ? { at: l(row.at) } : {}), ...(row.cron ? { cron: row.cron } : {}), tz,
      ...(row.until ? { until: l(row.until) } : {}), describe: row.describe, next: l(row.next_at),
      state: row.state, createdBy: row.created_by, createdAt: l(row.created_at),
    };
    if (title && row.title) out.conversationTitle = row.title;
    if (runs) out.runs = runs.map((r) => ({ due: l(r.due_at), at: l(r.at), outcome: r.outcome, ...(r.detail ? { detail: r.detail } : {}) }));
    return out;
  }

  async runsOf(ids) {
    if (!ids.length) return new Map();
    const { rows } = await this.pool.query(
      `select schedule_id, due_at, at, outcome, detail from (
         select r.*, row_number() over (partition by schedule_id order by due_at desc) as n
         from ${SCHEMA}.schedule_runs r where schedule_id = any($1)) x where n <= $2 order by schedule_id, due_at desc`,
      [ids, RUNS_SHOWN]);
    const out = new Map(ids.map((id) => [id, []]));
    for (const r of rows) out.get(r.schedule_id)?.push(r);
    return out;
  }

  async one(id, person) {
    const { rows } = await this.pool.query(
      `select ${COLUMNS} from ${SCHEMA}.schedules where id = $1 and person = $2 and state not in ('deleted', 'moved')`, [id, person]);
    return rows[0] ?? null;
  }

  async create(person, conversation, body) {
    checkPrompt(body?.prompt);
    const s = spec(body, this.nowSec());
    const c = await this.pool.connect();
    try {
      await c.query("begin");
      await c.query("select pg_advisory_xact_lock(hashtext($1))", [`schedules:${person}`]);
      const { rows: [{ n }] } = await c.query(
        `select count(*)::int as n from ${SCHEMA}.schedules where person = $1 and state in ('active', 'paused')`, [person]);
      if (n >= MAX_LIVE) throw new BadRequest(`this person already has ${MAX_LIVE} schedules: delete or finish one first`);
      const id = `sch_${randomUUID().replace(/-/g, "")}`;
      const { rows } = await c.query(
        `insert into ${SCHEMA}.schedules (id, person, conversation_id, kind, prompt, at, cron, tz, until, describe, next_at, state, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active', $2) returning ${COLUMNS}`,
        [id, person, conversation, s.kind, body.prompt, toDate(s.at), s.cron, s.tz, toDate(s.until), s.describe, toDate(s.next)]);
      await c.query("commit");
      this.log("info", "schedule armed", { schedule: id, conversation, kind: s.kind });
      return this.api(rows[0]);
    } catch (e) {
      await c.query("rollback").catch(() => {});
      throw e;
    } finally { c.release(); }
  }

  async list(person) {
    const { rows } = await this.pool.query(
      `select ${COLUMNS} from ${SCHEMA}.schedules where person = $1 and state not in ('deleted', 'moved') order by created_at desc`, [person]);
    return { schedules: (await this.withTitles(rows)).map((r) => this.api(r, undefined, true)) };
  }

  async get(person, id) {
    const row = await this.one(id, person);
    if (!row) throw new NotFound("not found");
    const runs = await this.runsOf([id]);
    const [titled] = await this.withTitles([row]);
    return this.api(titled, runs.get(id), true);
  }

  async update(person, id, body) {
    if (body?.prompt !== undefined) checkPrompt(body.prompt);
    const now = this.nowSec();
    const c = await this.pool.connect();
    try {
      await c.query("begin");
      const { rows: [row] } = await c.query(
        `select ${COLUMNS} from ${SCHEMA}.schedules where id = $1 and person = $2 and state not in ('deleted', 'moved') for update`, [id, person]);
      if (!row) throw new NotFound("not found");
      const ruleChanged = ["at", "cron", "tz", "until"].some((k) => body?.[k] !== undefined);
      let state = row.state;
      if (body?.paused === true && state === "active") state = "paused";
      if (body?.paused === false && state === "paused") state = "active";
      const storedAt = row.at ? local(toSec(row.at), row.tz) : null;
      const storedUntil = row.until ? local(toSec(row.until), row.tz) : null;
      let at;
      let cron;
      if (body?.at !== undefined) [at, cron] = [body.at, null];
      else if (body?.cron !== undefined) [at, cron] = [null, body.cron];
      else [at, cron] = [storedAt, row.cron];
      const until = body?.until !== undefined ? body.until : at ? null : storedUntil;
      const tz = body?.tz ?? row.tz;
      if (ruleChanged && state === "done") state = "active";
      let s = null;
      let next = null;
      if (state === "active") {
        s = spec({ at, cron, tz, until }, now);
        next = s.next;
      } else if (ruleChanged) s = spec({ at, cron, tz, until }, now);
      const prompt = body?.prompt ?? row.prompt;
      if (s) {
        await c.query(
          `update ${SCHEMA}.schedules set prompt = $2, kind = $3, at = $4, cron = $5, tz = $6, until = $7, describe = $8,
                  next_at = $9, state = $10, updated_at = now() where id = $1`,
          [id, prompt, s.kind, toDate(s.at), s.cron, s.tz, toDate(s.until), s.describe, toDate(next), state]);
      } else {
        await c.query(`update ${SCHEMA}.schedules set prompt = $2, state = $3, next_at = $4, updated_at = now() where id = $1`,
          [id, prompt, state, toDate(next)]);
      }
      await c.query("commit");
      this.log("info", "schedule changed", { schedule: id, state });
    } catch (e) {
      await c.query("rollback").catch(() => {});
      throw e;
    } finally { c.release(); }
    return this.api(await this.one(id, person));
  }

  async remove(person, id) {
    const r = await this.pool.query(
      `update ${SCHEMA}.schedules set state = 'deleted', next_at = null, deleted_at = now(), updated_at = now()
       where id = $1 and person = $2 and state not in ('deleted', 'moved')`, [id, person]);
    if (!r.rowCount) throw new NotFound("not found");
    this.log("info", "schedule deleted", { schedule: id });
  }

  /** The panel's list of conversation `id` of `person` (live ones, and ones done in the last day), with runs. */
  async panel(person, id) {
    const { rows } = await this.pool.query(
      `select ${COLUMNS} from ${SCHEMA}.schedules where conversation_id = $1 and person = $2
         and (state in ('active', 'paused') or (state = 'done' and updated_at > now() - interval '1 day'))
       order by created_at`, [id, person]);
    const runs = await this.runsOf(rows.map((r) => r.id));
    return { schedules: rows.map((r) => this.api(r, runs.get(r.id))) };
  }

  async adminView() {
    const { rows: [s] } = await this.pool.query(`select paused_all, paused_by, paused_at from ${SCHEMA}.schedule_settings where id = 1`);
    const { rows } = await this.pool.query(
      `select ${COLUMNS} from ${SCHEMA}.schedules where state not in ('deleted') order by person, created_at desc`);
    const runs = await this.runsOf(rows.map((r) => r.id));
    return {
      pausedAll: !!s?.paused_all, ...(s?.paused_by ? { pausedBy: s.paused_by } : {}),
      ...(s?.paused_at ? { pausedAt: new Date(s.paused_at).toISOString() } : {}),
      schedules: (await this.withTitles(rows)).map((r) => this.api(r, runs.get(r.id), true)),
    };
  }

  async setPaused(admin, paused) {
    await this.pool.query(`update ${SCHEMA}.schedule_settings set paused_all = $1, paused_by = $2, paused_at = now() where id = 1`,
      [!!paused, admin]);
    this.log("info", "schedules: pause-all set", { paused: !!paused });
  }

  // ---- HTTP ----

  static answer(res, status, body) {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(body === undefined ? "" : JSON.stringify(body));
  }

  static failed(res, e) {
    if (e instanceof BadRequest) return Schedules.answer(res, 400, { code: "bad_request", message: e.message });
    if (e instanceof NotFound) return Schedules.answer(res, 404, { code: "not_found", message: e.message || "not found" });
    return Schedules.answer(res, 500, { code: "internal", message: "the schedules could not be read or written" });
  }

  /** The AI's API (egress's `schedules` route): `/__jarvis/schedules[/<id>]`. */
  async handleApi(req, res, body) {
    const given = String(req.headers.authorization || "");
    const want = `Bearer ${this.token}`;
    const ok = this.token && given.length === want.length && timingSafeEqual(Buffer.from(given), Buffer.from(want));
    if (!ok) return Schedules.answer(res, 404, { code: "not_found", message: "not found" });
    const conversation = String(req.headers["x-jarvis-conversation"] || "").toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(conversation)) {
      return Schedules.answer(res, 400, { code: "bad_request", message: "the sandbox identity is missing" });
    }
    try {
      await this.ensure();
      const person = await this.ownerOf(conversation);
      if (!person) throw new NotFound("not found");
      const rest = new URL(req.url, "http://x").pathname.slice(API_PATH.length).replace(/^\/+/, "");
      const id = rest ? decodeURIComponent(rest) : null;
      if (id && id.includes("/")) throw new NotFound("not found");
      let parsed = {};
      if (body && body.trim()) {
        try { parsed = JSON.parse(body); } catch { throw new BadRequest("the body is not JSON"); }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new BadRequest("the body is not a JSON object");
      }
      if (!id && req.method === "GET") return Schedules.answer(res, 200, await this.list(person));
      if (!id && req.method === "POST") return Schedules.answer(res, 201, await this.create(person, conversation, parsed));
      if (id && req.method === "GET") return Schedules.answer(res, 200, await this.get(person, id));
      if (id && req.method === "PATCH") return Schedules.answer(res, 200, await this.update(person, id, parsed));
      if (id && req.method === "DELETE") { await this.remove(person, id); res.writeHead(204, { "cache-control": "no-store" }); return res.end(); }
      return Schedules.answer(res, 405, { code: "method_not_allowed", message: "this method is not served on this path" });
    } catch (e) {
      if (!(e instanceof BadRequest) && !(e instanceof NotFound)) this.log("warn", "schedules api failed", { error: String(e?.message || e) });
      return Schedules.failed(res, e);
    }
  }

  /** GET /api/jarvis/sessions/<id>/schedules for the signed-in person (or the person viewed as). */
  async handlePanel(res, person, id) {
    try {
      await this.ensure();
      if ((await this.ownerOf(id)) !== person) {
        return Schedules.answer(res, 404, { success: false, error: { code: "SESSION_NOT_FOUND", message: "Conversation not found." } });
      }
      return Schedules.answer(res, 200, await this.panel(person, id));
    } catch (e) {
      this.log("warn", "schedules panel failed", { error: String(e?.message || e) });
      return Schedules.answer(res, 502, { success: false, error: { code: "SCHEDULES_FAILED", message: "The schedules could not be read." } });
    }
  }

  /** /ops/schedules (GET) and /ops/schedules/pause (same-origin form POST), for an admin. */
  async handleAdmin(req, res, admin, body) {
    const page = (status, html) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'" });
      res.end(html);
    };
    if (!this.admins.has(admin)) return page(403, "<!doctype html><meta charset=utf-8><p>Not allowed.</p>");
    const pathname = new URL(req.url, "http://x").pathname;
    try {
      await this.ensure();
      if (pathname === PAUSE_PATH && req.method === "POST") {
        const site = String(req.headers["sec-fetch-site"] || "");
        const host = String(req.headers.host || "");
        const origin = String(req.headers.origin || "");
        const same = site ? site === "same-origin" : !origin || origin.replace(/^https?:\/\//, "") === host;
        if (!same) return page(403, "<!doctype html><meta charset=utf-8><p>Cross-origin requests are refused.</p>");
        await this.setPaused(admin, String(body || "").split("&").includes("paused=1"));
        res.writeHead(303, { location: ADMIN_PATH, "cache-control": "no-store" });
        return res.end();
      }
      if (pathname !== ADMIN_PATH || !["GET", "HEAD"].includes(req.method)) return page(404, "<!doctype html><meta charset=utf-8><p>Not found.</p>");
      return page(200, renderAdmin(await this.adminView()));
    } catch (e) {
      this.log("warn", "schedules admin failed", { error: String(e?.message || e) });
      return page(502, "<!doctype html><meta charset=utf-8><p>The schedules could not be read.</p>");
    }
  }

  // ---- firing ----

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), FIRE_EVERY_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass: fire what is due for the persons this replica serves, then deliver again what must be. */
  async tick() {
    if (this.firing) return 0;
    this.firing = true;
    try {
      await this.ensure();
      let n = 0;
      for (let i = 0; i < 100; i++) {
        const fired = await this.fireOne();
        if (!fired) break;
        n++;
      }
      for (let i = 0; i < 100; i++) {
        const done = await this.redeliverOne();
        if (!done) break;
        n++;
      }
      return n;
    } catch (e) {
      this.log("warn", "schedules pass failed", { error: String(e?.message || e) });
      return 0;
    } finally { this.firing = false; }
  }

  /** Delivers through the person's process: `sent`, `sent_mid_turn`, `skipped_deleted`, or `redeliver` (busy). */
  async post(row, due) {
    const text = message(row.describe, row.prompt);
    try {
      const r = await this.deliver(row.person, { sessionId: row.conversation_id, text, key: `${row.id}:${toSec(due)}` });
      if (["sent", "sent_mid_turn", "skipped_deleted"].includes(r?.outcome)) return { outcome: r.outcome };
      return { outcome: "redeliver" };
    } catch (e) {
      this.log("warn", "schedule delivery failed", { schedule: row.id, error: String(e?.message || e) });
      return { outcome: "redeliver" };
    }
  }

  async fireOne() {
    const c = await this.pool.connect();
    try {
      await c.query("begin");
      const { rows } = await c.query(
        `select ${COLUMNS} from ${SCHEMA}.schedules where state = 'active' and next_at <= now()
         order by next_at limit 20 for update skip locked`);
      const row = rows.find((r) => this.servesHere(r.person));
      if (!row) { await c.query("rollback"); return false; }
      const now = this.nowSec();
      const due = row.next_at;
      const { rows: [s] } = await c.query(`select paused_all from ${SCHEMA}.schedule_settings where id = 1`);
      let outcome;
      if (s?.paused_all) outcome = "skipped_paused";
      else if (now - toSec(due) > LATE_LIMIT_SECONDS) outcome = "skipped_late";
      else outcome = (await this.post(row, due)).outcome;
      await c.query(
        `insert into ${SCHEMA}.schedule_runs (schedule_id, due_at, outcome, conversation_id) values ($1, $2, $3, $4)
         on conflict (schedule_id, due_at) do nothing`, [row.id, due, outcome, row.conversation_id]);
      let state = "done";
      let next = null;
      if (row.cron) {
        try {
          const n = nextAfter(parseCron(row.cron), row.tz, Math.max(now, toSec(due)));
          if (n !== null && (!row.until || n <= toSec(row.until))) { state = "active"; next = toDate(n); }
        } catch { /* a stored rule that no longer parses: done */ }
      }
      await c.query(`update ${SCHEMA}.schedules set state = $2, next_at = $3, updated_at = now() where id = $1`, [row.id, state, next]);
      await c.query("commit");
      this.log("info", "schedule fired", { schedule: row.id, conversation: row.conversation_id, outcome });
      return true;
    } catch (e) {
      await c.query("rollback").catch(() => {});
      throw e;
    } finally { c.release(); }
  }

  async redeliverOne() {
    const c = await this.pool.connect();
    try {
      await c.query("begin");
      const { rows } = await c.query(
        `select r.schedule_id, r.due_at, s.person, s.conversation_id, s.describe, s.prompt, s.id
         from ${SCHEMA}.schedule_runs r join ${SCHEMA}.schedules s on s.id = r.schedule_id
         where r.outcome = 'redeliver' and s.state <> 'moved' order by r.due_at limit 20 for update of r skip locked`);
      const row = rows.find((r) => this.servesHere(r.person));
      if (!row) { await c.query("rollback"); return false; }
      const { outcome } = await this.post(row, row.due_at);
      await c.query(`update ${SCHEMA}.schedule_runs set outcome = $3, at = now() where schedule_id = $1 and due_at = $2`,
        [row.schedule_id, row.due_at, outcome]);
      await c.query("commit");
      if (outcome !== "redeliver") this.log("info", "schedule delivered again", { schedule: row.schedule_id, outcome });
      return outcome !== "redeliver";
    } catch (e) {
      await c.query("rollback").catch(() => {});
      throw e;
    } finally { c.release(); }
  }
}

/** The admin page (English, Deyao only). */
export function renderAdmin(v) {
  const css = ":root{--ink:#111;--line:#d4d4d4;--muted:#666;--bg:#fff;--warn:#b42318}@media (prefers-color-scheme:dark){:root{--ink:#eee;--line:#3a3a3a;--muted:#999;--bg:#111;--warn:#ff8a80}}"
    + "body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,sans-serif}main{max-width:1100px;margin:0 auto;padding:16px}"
    + "h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;border-bottom:1px solid var(--ink);padding-bottom:4px;margin:28px 0 8px}"
    + "h3{font-size:16px;margin:0 0 6px}h3 small{font-weight:400;color:var(--muted)}h4{margin:10px 0 4px;font-size:13px}"
    + "section{border:1px solid var(--line);padding:12px;margin:8px 0}dl{display:grid;grid-template-columns:110px 1fr;gap:2px 10px;margin:0}"
    + "dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}ul{margin:0;padding-left:18px;font-size:13px}"
    + "button{font:inherit;padding:8px 14px;border:1px solid var(--ink);background:var(--bg);color:var(--ink);border-radius:0;cursor:pointer}"
    + ".paused{color:var(--warn);font-weight:600}a{color:inherit}";
  let out = `<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Schedules</title><style>${css}</style></head><body><main><h1>Schedules</h1><p>Every person's schedules with their last runs. <a href="/ops/">Operator page</a></p>`;
  if (v.pausedAll) {
    out += `<p class=paused>All schedules are paused${v.pausedBy ? ` by ${escapeHtml(v.pausedBy)}` : ""}${v.pausedAt ? ` at ${escapeHtml(v.pausedAt)}` : ""}. Due times are recorded as skipped.</p><form method=post action="${PAUSE_PATH}"><input type=hidden name=paused value=0><button>Resume all schedules</button></form>`;
  } else {
    out += `<p>Schedules fire.</p><form method=post action="${PAUSE_PATH}"><input type=hidden name=paused value=1><button>Pause all schedules</button></form>`;
  }
  if (!v.schedules.length) out += "<p>No schedules.</p>";
  let person = "";
  for (const s of v.schedules) {
    if (s.createdBy !== person) { person = s.createdBy; out += `<h2>${escapeHtml(person)}</h2>`; }
    const row = (k, val) => `<dt>${k}</dt><dd>${escapeHtml(val)}</dd>`;
    out += `<section><h3>${escapeHtml(s.describe)} <small>${s.kind === "cron" ? "repeating" : "once"} · ${escapeHtml(s.state)}</small></h3><dl>`
      + row("Next", s.next ?? "none") + row("Message", s.prompt) + row("Conversation", `${s.conversationTitle ?? "(untitled)"} · ${s.conversationId}`)
      + (s.cron ? row("Rule", `${s.cron} (${s.tz})`) : s.at ? row("At", `${s.at} (${s.tz})`) : "")
      + (s.until ? row("Until", s.until) : "") + row("Set", `${s.createdBy} · ${s.createdAt}`) + row("Id", s.id) + "</dl><h4>Runs</h4><ul>";
    const runs = s.runs ?? [];
    if (!runs.length) out += "<li>none yet</li>";
    for (const r of runs) out += `<li><b>${escapeHtml(r.due)}</b> ${escapeHtml(OUTCOME_WORDS[r.outcome] ?? r.outcome)}${r.detail ? ` (${escapeHtml(r.detail)})` : ""}</li>`;
    out += "</ul></section>";
  }
  return out + "</main></body></html>";
}

/** A key that names the router to a CloudCLI process for /api/jarvis/schedules/deliver (derived from JARVIS_CC_TOKEN). */
export function deliverKey(ccToken) {
  return createHash("sha256").update(`jarvis-schedules-deliver:${ccToken}`).digest("hex");
}
