// The persona drivers (aviary WP-54, DESIGN 9.9): the staff web app (the persona build, jarvis/test/persona/build.sh:
// window.__yycPersona) in a real browser (Playwright, Chromium) through an edge stand-in, while the switch moves its
// tab from the old router to pigeon. Run by aviary testing/legacy-in-a-box/run.sh personas, one persona per run
// (--persona, default draft), each as a person of its own:
//
//   draft     a legacy conversation open with a draft typed and not sent; the flip and the move; the tab reconnects
//             exactly once, the draft is still in the composer, and sent afterwards it is accepted once (one user row
//             in the old child's history: it went through pigeon's legacy upstream to the conversation's owner). With
//             --control a clean run goes on: the gate, the release while the tab shows the conversation (no
//             reconnect, the composer kept), and the next send is a native turn in magpie with nothing written to the
//             old child.
//   inflight  a send in flight at the move: a long old turn sent on the old socket as the move starts; one reconnect,
//             the message accepted once and shown once, the turn streams to its end through the LU
//   upload    an upload after T0 on an unmoved tab: after the flip (every new request to pigeon) a file attached,
//             then sent on the old socket, which is never moved; the upload went to pigeon (the tee), the agent read
//             the file, no reconnect
//   attach    a file attached at move - 2 s to a new conversation and sent at move + 3 s: the tab reconnects once with
//             the file still attached, the send creates a pigeon-born conversation whose first message carries the
//             file, and the new stack's agent reads it
//   ask       an ask in an old turn (AskUserQuestion): shown before the move, still shown after the reconnect, and
//             Stop from the moved tab ends the turn
//   view-as   an admin's view-as tab on a person's legacy conversation: one reconnect at the move, still the view (the
//             box only the admin sees, read-only), the conversation's messages still there
//   bridge    a bridge-node kill: the tab moved, four sends with B1's connections reset in the middle of the third;
//             every send lands once in the old child and is answered, and the tab does not reconnect (E4: pigeon
//             reopens the LU on its own)
//   hold      a hold (Claude Code's process held open after its result for background work): the tab moved, the
//             person's gate set; the conversation stays legacy while the hold lasts, then is released with no
//             reconnect and the next send is native
//   warm      an idle warm old sandbox: the tab moved right after a turn, the person's gate set; the conversation is
//             released only once the old sandbox is gone, with no reconnect, and the next send is native
//
// The checker is proved by the seeded defects (--defect, draft only): `lost-draft` (the persona build empties the
// composer at each reconnect) and `second-reconnect` (the edge drops each tab's first connection after the flip once
// more); with either the run must fail on that check, which run.sh asserts.
//
//   node personas.mjs --edge <url> --old-ui <url> [--old-pods <url,url>] --switch-token <t> --lu-token <t> --key <pem>
//        --kid <k> --iss <url> --aud <a> --email <e> [--persona <name>] [--title <unique text of the conversation>]
//        [--conversation <id>] [--view-as <person>] [--bridge <url>] [--control <url>] [--defect <name>] [--out <dir>]
// Prints one JSON line {persona, ok, checks: [{name, ok, detail}]}; exits 1 unless every check passed.
import { createSign, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const o = {
  persona: arg("persona", "draft"),
  edge: arg("edge"), oldUi: arg("old-ui"), switchToken: arg("switch-token"), key: readFileSync(arg("key")), kid: arg("kid", "k1"),
  iss: arg("iss"), aud: arg("aud"), email: arg("email"), title: arg("title", ""), conversation: arg("conversation", ""),
  defect: arg("defect", ""), out: arg("out", ""), luToken: arg("lu-token"),
  // every old ui pod's own address: the runner stand-in calls move on each (else --old-ui only)
  oldPods: (arg("old-pods", "") || arg("old-ui")).split(",").filter(Boolean),
  // the box's control (gate, owner, native-turns, …): with it, a clean draft run goes on to the gate and the release
  control: arg("control", ""),
  // view-as: the person the admin (--email) views
  viewAs: arg("view-as", ""),
  // the bridge stand-in's control (its :9999), for the bridge-node kill
  bridge: arg("bridge", ""),
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = () => `persona-${randomBytes(4).toString("hex")}`;
// whose conversation and sockets these are (the viewed person in a view-as run)
const person = o.viewAs || o.email;

function token(email, life = 3 * 3600) {
  const now = Math.floor(Date.now() / 1000);
  const b = (x) => Buffer.from(JSON.stringify(x)).toString("base64url");
  const h = b({ alg: "RS256", kid: o.kid, typ: "JWT" });
  const p = b({ iss: o.iss, aud: [o.aud], email, exp: now + life, iat: now, nbf: now - 5, type: "app", identity_nonce: randomUUID() });
  return `${h}.${p}.${createSign("RSA-SHA256").update(`${h}.${p}`).sign(o.key).toString("base64url")}`;
}

async function post(url, headers = {}) {
  const r = await fetch(url, { method: "POST", headers });
  return { status: r.status, body: await r.text() };
}

/** The old child's messages of the conversation (through the old router, as the person: the old stack's truth). */
async function oldMessages() {
  const r = await fetch(`${o.oldUi}/api/providers/sessions/${o.conversation}/messages`, { headers: { "cf-access-jwt-assertion": token(person), "x-aviary-lu": o.luToken } });
  const v = await r.json().catch(() => ({}));
  return (v?.data?.messages || []).map((m) => ({ role: m.role, text: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "") }));
}
const oldUserRows = async (needle) => (await oldMessages()).filter((m) => m.role === "user" && m.text.includes(needle));

async function ctl(name, params = {}) {
  const q = new URLSearchParams(params).toString();
  const r = await fetch(`${o.control}/${name}${q ? `?${q}` : ""}`, { method: "POST" });
  return { ok: r.ok, text: (await r.text()).trim() };
}

async function until(ms, f, every = 1000) {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) {
    v = await f();
    if (v) return v;
    await wait(every);
  }
  return v;
}

const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); };

const browser = await chromium.launch();
const edge = new URL(o.edge);
const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
await context.addCookies([{ name: "CF_Authorization", value: token(o.email), domain: edge.hostname, path: "/" }]);
if (o.defect === "lost-draft") await context.addInitScript(() => { try { localStorage.setItem("yyc-persona-defect", "lost-draft"); } catch { /* none */ } });
if (o.defect === "second-reconnect") await post(`${o.edge}/__edge/defect?name=second-reconnect`);
const page = await context.newPage();
// every frame the tab received (type, agent, a little of the payload), kept beside the screenshot for a failed run
const frames = [];
page.on("websocket", (ws) => ws.on("framereceived", (f) => {
  try {
    const v = JSON.parse(String(f.payload));
    const m = v.message || v;
    frames.push(`${new Date().toISOString()} ${m.type || v.type} ${JSON.stringify(m.payload ?? "").slice(0, 160)}`);
  } catch { /* not JSON */ }
}));
const connects = () => page.evaluate(() => window.__yycPersona?.connects ?? -1);
const box = page.locator('[data-testid="message-input-root"] textarea').first();
const auth = { "x-jarvis-switch-token": o.switchToken };

/** The app loaded and connected (the persona build). */
async function openApp(url = o.edge) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => (window.__yycPersona?.statuses || []).includes("connected") || document.querySelector('[data-testid="message-input-root"]'), null, { timeout: 60000 });
  check("persona build", (await connects()) >= 0, "window.__yycPersona present");
}

/** The conversation opened from the list (by its unique title text). */
async function openConversation() {
  await page.getByText(o.title, { exact: false }).first().click({ timeout: 60000 });
  // (a view-as tab's composer is read-only: no text box)
  await page.locator('[data-testid="message-input-root"]').first().waitFor({ timeout: 30000 });
}

/** The DNS change: the edge sends new connections to pigeon (a `stale` share still to the old tunnel). */
async function flip(stale) {
  check("flip", (await post(`${o.edge}/__edge/flip?stale=${stale}`)).status === 200);
}

/** The runner stand-in: arm every old pod, then move the person on each every second until the tab reconnected. */
async function move(c0, persons = [person]) {
  const armed = await Promise.all(o.oldPods.map((u) => post(`${u}/__jarvis/move`, auth)));
  check("move armed", armed.every((r) => r.status === 200), armed.map((r) => r.status).join(","));
  const end = Date.now() + 90000;
  while (Date.now() < end && (await connects()) <= c0) {
    await Promise.all(o.oldPods.flatMap((u) => persons.map((p) => post(`${u}/__jarvis/move?person=${encodeURIComponent(p)}`, auth))));
    await wait(1000);
  }
  let why = "";
  if ((await connects()) <= c0) {
    // what the old router holds for the person (each call reaches one of the pods)
    for (const u of o.oldPods) {
      const r = await fetch(`${u}/__jarvis/sockets`, { headers: auth }).then((x) => x.json()).catch(() => null);
      why += ` ${r?.pod}: ${JSON.stringify(r?.persons?.[person] ?? null).slice(0, 400)}`;
    }
  }
  check("reconnected", (await connects()) > c0, `connects ${c0} -> ${await connects()}${why}`);
}

/** After a move: no second reconnect within 10 s. */
async function oneReconnect(c0) {
  await wait(10000);
  const n = (await connects()) - c0;
  check("one reconnect per move", n === 1, `${n} reconnects`);
}

/** A file attached through the composer's menu (the app's own upload); the attachment's pill once it is uploaded. */
async function attachFile(name, content) {
  await page.getByTestId("message-input-attach-button").first().click();
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: 15000 }),
    page.getByTestId("message-input-attachment-menu-item-file").first().click(),
  ]);
  await chooser.setFiles({ name, mimeType: "text/plain", buffer: Buffer.from(content) });
  await page.getByTestId("composer-file-attachment-pill").first().waitFor({ timeout: 60000 });
  await until(60000, async () => (await page.getByTestId("composer-pending-file-attachment").count()) === 0, 500);
}

const shown = (needle, testId = "user-message") => page.locator(`[data-testid="${testId}"]`, { hasText: needle }).count();
const stopButton = () => page.getByRole("button", { name: /^(停止|Stop|Stop agent|停止 Agent)$/ }).first();
const edgeStats = () => fetch(`${o.edge}/__edge/stats`).then((r) => r.json());

/** The gate (the person's own with `who`), the release while this tab shows the conversation, and the next send
 * native: no reconnect at the release, the composer untouched by the replacement, nothing written to the old child. */
async function releaseAndNative(who, { whileLegacy } = {}) {
  const draft2 = `persona after release ${randomUUID()}`;
  await box.fill(draft2);
  const c1 = await connects();
  const g = await ctl("gate", who ? { person: who } : {});
  check("gate set", g.ok, g.text.slice(-300));
  let owner = "";
  const samples = [];
  const relUntil = Date.now() + 300000;
  while (Date.now() < relUntil && owner !== "owned") {
    owner = (await ctl("owner", { conversation: o.conversation })).text;
    if (whileLegacy) samples.push({ at: Date.now(), owner, ...(await whileLegacy()) });
    if (owner !== "owned") await wait(2000);
  }
  check("released while shown", owner === "owned", `owner ${owner}`);
  await wait(5000);
  check("no reconnect at the release", (await connects()) === c1, `connects ${c1} -> ${await connects()}`);
  const kept2 = await box.inputValue().catch(() => "");
  check("draft kept across the release", kept2 === draft2, `composer holds ${JSON.stringify(kept2.slice(0, 60))}`);
  await box.press("Enter");
  const native = await until(90000, async () => Number((await ctl("native-turns", { conversation: o.conversation })).text) || 0, 2000);
  check("the next send is native", native >= 1, `${native} person turns in magpie`);
  const old2 = await oldUserRows(draft2);
  check("nothing written to the old child after the release", old2.length === 0, `${old2.length} old rows`);
  return samples;
}

const personas = {
  async draft() {
    await openApp();
    await openConversation();
    const draft = `persona draft ${randomUUID()}`;
    await box.fill(draft);
    // stop typing: the move closes a socket only after 5 s without an inbound frame (DESIGN 9.3)
    await wait(1000);
    const c0 = await connects();
    await flip(0.3);
    await move(c0);
    await oneReconnect(c0);
    const kept = await box.inputValue().catch(() => "");
    check("draft kept across the move", kept === draft, `composer holds ${JSON.stringify(kept.slice(0, 60))}`);
    // sent after the move: accepted once, by the conversation's owner (still the old stack: through LU)
    await box.fill(draft);
    await box.press("Enter");
    await until(60000, async () => (await oldUserRows(draft)).length);
    await wait(3000);
    const rows = await oldUserRows(draft);
    check("sent once after the move", rows.length === 1, `${rows.length} user rows with the draft`);
    if (o.control && !o.defect) await releaseAndNative(null);
  },

  async inflight() {
    await openApp();
    await openConversation();
    const t = tag();
    const text = `[[slow 8]] ${t} in flight`;
    const c0 = await connects();
    await flip(0.3);
    await box.fill(text);
    // Send, and the move starts at once: the old router waits for the send's answer and then the 5 s quiet
    await box.press("Enter");
    await move(c0);
    await oneReconnect(c0);
    const ended = await until(90000, async () => (await shown("done 8", "assistant-message")) > 0);
    check("the turn streams to its end", ended, ended ? "done 8 shown" : "no done 8 in the tab after 90 s");
    const rows = await oldUserRows(t);
    check("accepted once", rows.length === 1, `${rows.length} old user rows`);
    check("shown once", (await shown(t)) === 1, `${await shown(t)} user messages in the tab`);
  },

  async upload() {
    await openApp();
    await openConversation();
    const c0 = await connects();
    // T0: every new request goes to pigeon; this tab's socket stays on the old router (never moved)
    await flip(0);
    const before = await edgeStats();
    const t = tag();
    const name = `${t}.txt`;
    await attachFile(name, `persona upload ${t}\n`);
    const after = await edgeStats();
    check("the upload went to pigeon", after.requests.new > before.requests.new && after.requests.old === before.requests.old,
      `edge requests old ${before.requests.old} -> ${after.requests.old}, new ${before.requests.new} -> ${after.requests.new}`);
    await box.fill(`${t} read the file`);
    await box.press("Enter");
    const rows = await until(60000, async () => { const r = await oldUserRows(t); return r.length ? r : null; });
    check("sent on the old socket, accepted once", rows?.length === 1, `${rows?.length ?? 0} old user rows`);
    const seen = await until(60000, async () => { const r = JSON.parse((await ctl("old-model", { tag: t })).text || "[]"); return r.some((x) => x.user.includes(name)) ? r : null; }, 2000);
    check("the agent read the file", !!seen, seen ? "the old model's prompt names it" : "no old model request names the file");
    check("no reconnect (unmoved)", (await connects()) === c0, `connects ${c0} -> ${await connects()}`);
  },

  async attach() {
    // a new conversation: the app's home is the new conversation's composer
    await openApp();
    await box.waitFor({ timeout: 30000 });
    const c0 = await connects();
    await flip(0);
    const t = tag();
    const name = `${t}.txt`;
    await attachFile(name, `persona attach ${t}\n`);
    const text = `${t} the attached file`;
    await box.fill(text);
    await wait(2000); // the move at attach + 2 s
    await move(c0);
    await wait(3000); // the send at move + 3 s
    check("attachment kept across the move", (await page.getByTestId("composer-file-attachment-pill").count()) === 1,
      `${await page.getByTestId("composer-file-attachment-pill").count()} file pills`);
    check("text kept across the move", (await box.inputValue().catch(() => "")) === text);
    await box.press("Enter");
    const conv = await until(90000, async () => { const v = (await ctl("native-files", { tag: t })).text; return v ? JSON.parse(v) : null; }, 2000);
    check("a pigeon-born conversation", conv && conv.migrating === false, JSON.stringify(conv ?? null).slice(0, 300));
    check("its first message carries the file", JSON.stringify(conv?.payload ?? "").includes(name), JSON.stringify(conv?.payload ?? null).slice(0, 300));
    const got = await until(120000, async () => { const r = JSON.parse((await ctl("new-model", { tag: name })).text || "[]"); return r.length ? r : null; }, 3000);
    check("the agent reads it", !!got, got ? `${got.length} model requests name it` : "no new model request names the file");
    await oneReconnect(c0);
  },

  async ask() {
    await openApp();
    await openConversation();
    const t = tag();
    await box.fill(`[[ask]] ${t} ask`);
    await box.press("Enter");
    const card = page.getByTestId("question-form-card");
    const asked = await until(90000, async () => (await card.count()) > 0);
    check("the ask is shown", asked);
    const c0 = await connects();
    if (!process.argv.includes("--no-move")) {
      // (--no-move: the same on the old stack alone, the control a failure here is compared with)
      await wait(6000); // the socket quiet for the move's 5 s
      await flip(0.3);
      await move(c0);
      await oneReconnect(c0);
    }
    check("the ask still shown after the move", (await card.count()) > 0, `${await card.count()} question cards`);
    const stop = await until(30000, async () => ((await stopButton().count()) > 0 ? stopButton() : null));
    check("Stop offered on the moved tab", !!stop);
    if (stop) await stop.click();
    const stopped = await until(60000, async () => (await stopButton().count()) === 0);
    check("Stop from the moved tab ends the turn", stopped, `${await stopButton().count()} stop buttons`);
    const gone = await until(30000, async () => (await card.count()) === 0);
    check("the ask leaves the tab once the turn is stopped", gone, `${await card.count()} question cards`);
    const rows = await oldUserRows(t);
    check("the ask's message once in the old child", rows.length === 1, `${rows.length} old user rows`);
    // an ask made after the move: the old turn's question reaches the moved tab through the LU
    const before = await card.count();
    const t2 = tag();
    await box.fill(`[[ask]] ${t2} ask after the move`);
    await box.press("Enter");
    const asked2 = await until(90000, async () => (await card.count()) > before);
    check("an ask made after the move is shown", asked2, `${await card.count()} question cards (${before} before)`);
    const stop2 = await until(30000, async () => ((await stopButton().count()) > 0 ? stopButton() : null));
    if (stop2) await stop2.click();
    check("and Stop ends that turn too", await until(60000, async () => (await stopButton().count()) === 0));
  },

  async "view-as"() {
    await openApp();
    // the operator page's form (same origin), which answers 303 to the view-as tab
    await Promise.all([
      page.waitForNavigation({ timeout: 30000 }),
      page.evaluate((user) => {
        const f = document.createElement("form");
        f.method = "POST"; f.action = "/api/jarvis/view-as";
        const i = document.createElement("input"); i.name = "user"; i.value = user; f.appendChild(i);
        document.body.appendChild(f); f.submit();
      }, o.viewAs),
    ]);
    await page.waitForFunction(() => (window.__yycPersona?.statuses || []).includes("connected"), null, { timeout: 60000 });
    const viewBox = page.getByTestId("view-as-box");
    check("the view-as tab", await until(30000, async () => (await viewBox.count()) > 0), "the admin's box");
    await openConversation();
    const first = await until(30000, async () => (await shown(o.title)) > 0);
    check("the person's conversation shown", first);
    await wait(6000);
    const c0 = await connects();
    await flip(0.3);
    await move(c0, [o.viewAs, o.email]);
    await oneReconnect(c0);
    check("still the view after the move", (await viewBox.count()) > 0 && /read-only/.test(await viewBox.innerText().catch(() => "")),
      (await viewBox.innerText().catch(() => "")).slice(0, 120));
    const still = await until(30000, async () => (await shown(o.title)) > 0);
    check("the conversation still shown after the move", still);
  },

  async bridge() {
    await openApp();
    await openConversation();
    const c0 = await connects();
    await flip(0.3);
    await move(c0);
    await oneReconnect(c0);
    await wait(6000); // the LU up past E4's 5 s
    const c1 = await connects();
    const t = tag();
    const sent = [];
    for (let k = 1; k <= 4; k++) {
      const text = `${t} bridge ${k}`;
      sent.push(text);
      await box.fill(text);
      await box.press("Enter");
      if (k === 3) {
        // the bridge's target node killed mid-run: every relayed connection reset
        const r = await post(`${o.bridge}/__bridge/cut`);
        check("bridge cut", r.status === 200, r.body);
      }
      const answered = await until(90000, async () => (await shown(`Echo: ${text}`, "assistant-message")) > 0);
      check(`send ${k} answered`, answered);
    }
    await wait(3000);
    for (const text of sent) {
      const rows = await oldUserRows(text);
      check(`"${text.slice(-8)}" landed once`, rows.length === 1, `${rows.length} old user rows`);
    }
    check("no reconnect at the cut (the LU reopened)", (await connects()) === c1, `connects ${c1} -> ${await connects()}`);
  },

  async hold() {
    await openApp();
    await openConversation();
    const t = tag();
    // background work longer than the old sandbox's idle time after a plain turn (the box's 90 s), so only the hold
    // can keep the conversation legacy at send + 120 s
    await box.fill(`[[bg 150]] ${t} hold`);
    const tSend = Date.now();
    await box.press("Enter");
    const started = await until(90000, async () => (await shown("started", "assistant-message")) > 0);
    check("the turn ended, its background work running", started);
    const c0 = await connects();
    await wait(6000);
    await flip(0.3);
    await move(c0);
    await oneReconnect(c0);
    const samples = await releaseAndNative(person, { whileLegacy: async () => ({}) });
    const firstOwned = samples.find((s) => s.owner === "owned");
    const after = firstOwned ? Math.round((firstOwned.at - tSend) / 1000) : null;
    check("legacy while the hold lasts", samples.some((s) => s.owner === "legacy" && s.at - tSend > 120000) && after > 150,
      `released ${after} s after the send (the background step runs 150 s)`);
  },

  async warm() {
    await openApp();
    await openConversation();
    const t = tag();
    await box.fill(`${t} warm`);
    await box.press("Enter");
    check("answered", await until(90000, async () => (await shown(`Echo: ${t}`, "assistant-message")) > 0));
    const c0 = await connects();
    await wait(6000);
    await flip(0.3);
    await move(c0);
    await oneReconnect(c0);
    const samples = await releaseAndNative(person, { whileLegacy: async () => ({ sandbox: (await ctl("sandbox", { conversation: o.conversation })).text }) });
    const warmLegacy = samples.filter((s) => s.sandbox === "running");
    check("the gate came while the old sandbox was warm", warmLegacy.length > 0 && warmLegacy.every((s) => s.owner === "legacy"),
      `${warmLegacy.length} samples with it running, owners ${[...new Set(warmLegacy.map((s) => s.owner))].join(",")}`);
    const firstOwned = samples.find((s) => s.owner === "owned");
    check("released only once the old sandbox was gone", firstOwned && firstOwned.sandbox !== "running", `sandbox ${firstOwned?.sandbox} at the release`);
  },
};

try {
  const run = personas[o.persona];
  if (!run) throw new Error(`no persona ${o.persona}`);
  await run();
} catch (e) {
  check("ran to the end", false, String(e?.message || e).slice(0, 300));
} finally {
  if (o.out) {
    const base = `${o.out}/${o.persona}${o.defect ? `-${o.defect}` : ""}`;
    mkdirSync(o.out, { recursive: true });
    await page.screenshot({ path: `${base}.png` }).catch(() => {});
    writeFileSync(`${base}-frames.txt`, frames.filter((l) => !/ agent_stream | pong /.test(l)).join("\n"));
  }
  await browser.close();
}
const ok = checks.every((c) => c.ok);
console.log(JSON.stringify({ persona: o.persona, defect: o.defect || null, ok, checks }));
process.exit(ok ? 0 : 1);
