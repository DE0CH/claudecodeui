// The persona drivers (aviary WP-54, DESIGN 9.9): the staff web app (the persona build, jarvis/test/persona/build.sh:
// window.__yycPersona) in a real browser (Playwright, Chromium) through an edge stand-in, while the switch moves its
// tab from the old router to pigeon. Run by aviary testing/legacy-in-a-box/run.sh personas. One persona per run:
//
//   draft  a legacy conversation open with a draft typed and not sent; the flip and the move; the tab reconnects
//          exactly once, the draft is still in the composer, and sent afterwards it is accepted once (one user row
//          in the old child's history: it went through pigeon's legacy upstream to the conversation's owner)
//
// With --control (the box's) a clean run goes on: the gate, the release while the tab shows the conversation (no
// reconnect, the composer kept), and the next send is a native turn in magpie with nothing written to the old child.
//
// The checker is proved by the seeded defects (--defect): `lost-draft` (the persona build empties the composer at
// each reconnect) and `second-reconnect` (the edge drops each tab's first connection after the flip once more); with
// either the run must fail on that check, which run.sh asserts.
//
//   node personas.mjs --edge <url> --old-ui <url> [--old-pods <url,url>] --switch-token <t> --lu-token <t> --key <pem> --kid <k> --iss <url> --aud <a>
//        --email <e> --title <unique text of the conversation> --conversation <id> [--defect <name>] [--out <dir>]
// Prints one JSON line {persona, ok, checks: [{name, ok, detail}]}; exits 1 unless every check passed.
import { createSign, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { chromium } from "playwright";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const o = {
  edge: arg("edge"), oldUi: arg("old-ui"), switchToken: arg("switch-token"), key: readFileSync(arg("key")), kid: arg("kid", "k1"),
  iss: arg("iss"), aud: arg("aud"), email: arg("email"), title: arg("title"), conversation: arg("conversation"),
  defect: arg("defect", ""), out: arg("out", ""), luToken: arg("lu-token"),
  // every old ui pod's own address: the runner stand-in calls move on each (else --old-ui only)
  oldPods: (arg("old-pods", "") || arg("old-ui")).split(",").filter(Boolean),
  // the box's control (gate, owner, native-turns): with it, a clean run goes on to the gate and the release
  control: arg("control", ""),
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** The old child's user rows of the conversation (through the old router, as the person: the old stack's truth). */
async function oldUserRows(tok) {
  const r = await fetch(`${o.oldUi}/api/providers/sessions/${o.conversation}/messages`, { headers: { "cf-access-jwt-assertion": tok, "x-aviary-lu": o.luToken } });
  const v = await r.json().catch(() => ({}));
  return (v?.data?.messages || []).filter((m) => m.role === "user").map((m) => String(m.content || ""));
}

async function ctl(name, conversation) {
  const r = await fetch(`${o.control}/${name}${conversation ? `?conversation=${conversation}` : ""}`, { method: "POST" });
  return { ok: r.ok, text: (await r.text()).trim() };
}

const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); };

const browser = await chromium.launch();
const tok = token(o.email);
const edge = new URL(o.edge);
const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
await context.addCookies([{ name: "CF_Authorization", value: tok, domain: edge.hostname, path: "/" }]);
if (o.defect === "lost-draft") await context.addInitScript(() => { try { localStorage.setItem("yyc-persona-defect", "lost-draft"); } catch { /* none */ } });
if (o.defect === "second-reconnect") await post(`${o.edge}/__edge/defect?name=second-reconnect`);
const page = await context.newPage();
const connects = () => page.evaluate(() => window.__yycPersona?.connects ?? -1);
try {
  await page.goto(o.edge, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => (window.__yycPersona?.statuses || []).includes("connected") || document.querySelector('[data-testid="message-input-root"]'), null, { timeout: 60000 });
  check("persona build", (await connects()) >= 0, "window.__yycPersona present");
  // open the conversation from the list
  await page.getByText(o.title, { exact: false }).first().click({ timeout: 60000 });
  const box = page.locator('[data-testid="message-input-root"] textarea').first();
  await box.waitFor({ timeout: 30000 });
  const draft = `persona draft ${randomUUID()}`;
  await box.fill(draft);
  // stop typing: the move closes a socket only after 5 s without an inbound frame (DESIGN 9.3)
  await wait(1000);
  const c0 = await connects();
  check("flip", (await post(`${o.edge}/__edge/flip?stale=0.3`)).status === 200);
  const auth = { "x-jarvis-switch-token": o.switchToken };
  const armed = await Promise.all(o.oldPods.map((u) => post(`${u}/__jarvis/move`, auth)));
  check("move armed", armed.every((r) => r.status === 200), armed.map((r) => r.status).join(","));
  // the runner stand-in: every second, move the person on every old ui pod until the tab reconnected
  const until = Date.now() + 90000;
  while (Date.now() < until && (await connects()) <= c0) {
    await Promise.all(o.oldPods.map((u) => post(`${u}/__jarvis/move?person=${encodeURIComponent(o.email)}`, auth)));
    await wait(1000);
  }
  let why = "";
  if ((await connects()) <= c0) {
    // what the old router holds for the person (each call reaches one of the pods)
    for (const u of o.oldPods) {
      const r = await fetch(`${u}/__jarvis/sockets`, { headers: auth }).then((x) => x.json()).catch(() => null);
      why += ` ${r?.pod}: ${JSON.stringify(r?.persons?.[o.email] ?? null).slice(0, 400)}`;
    }
  }
  check("reconnected", (await connects()) > c0, `connects ${c0} -> ${await connects()}${why}`);
  await wait(10000); // a second reconnect would come in this time
  const reconnects = (await connects()) - c0;
  check("one reconnect per move", reconnects === 1, `${reconnects} reconnects`);
  const kept = await box.inputValue().catch(() => "");
  check("draft kept across the move", kept === draft, `composer holds ${JSON.stringify(kept.slice(0, 60))}`);
  // sent after the move: accepted once, by the conversation's owner (still the old stack: through LU)
  await box.fill(draft);
  await box.press("Enter");
  let rows = [];
  const sendUntil = Date.now() + 60000;
  while (Date.now() < sendUntil) {
    rows = (await oldUserRows(tok)).filter((t) => t.includes(draft));
    if (rows.length) break;
    await wait(1000);
  }
  await wait(3000);
  rows = (await oldUserRows(tok)).filter((t) => t.includes(draft));
  check("sent once after the move", rows.length === 1, `${rows.length} user rows with the draft`);
  if (o.control && !o.defect) {
    // the gate, then the release while this tab shows the conversation: no reconnect, the composer untouched by the
    // replacement, and the next send is a native turn (magpie's), never the old child's
    const draft2 = `persona after release ${randomUUID()}`;
    await box.fill(draft2);
    const c1 = await connects();
    const g = await ctl("gate");
    check("gate set", g.ok, g.text.slice(-300));
    let owner = "";
    const relUntil = Date.now() + 240000;
    while (Date.now() < relUntil && owner !== "owned") {
      owner = (await ctl("owner", o.conversation)).text;
      if (owner !== "owned") await wait(3000);
    }
    check("released while shown", owner === "owned", `owner ${owner}`);
    await wait(5000);
    check("no reconnect at the release", (await connects()) === c1, `connects ${c1} -> ${await connects()}`);
    const kept2 = await box.inputValue().catch(() => "");
    check("draft kept across the release", kept2 === draft2, `composer holds ${JSON.stringify(kept2.slice(0, 60))}`);
    await box.press("Enter");
    let native = 0;
    const natUntil = Date.now() + 90000;
    while (Date.now() < natUntil && native < 1) {
      native = Number((await ctl("native-turns", o.conversation)).text) || 0;
      if (native < 1) await wait(2000);
    }
    check("the next send is native", native >= 1, `${native} person turns in magpie`);
    const old2 = (await oldUserRows(tok)).filter((t) => t.includes(draft2));
    check("nothing written to the old child after the release", old2.length === 0, `${old2.length} old rows`);
  }
} catch (e) {
  check("ran to the end", false, String(e?.message || e).slice(0, 300));
} finally {
  if (o.out) { mkdirSync(o.out, { recursive: true }); await page.screenshot({ path: `${o.out}/draft${o.defect ? `-${o.defect}` : ""}.png` }).catch(() => {}); }
  await browser.close();
}
const ok = checks.every((c) => c.ok);
console.log(JSON.stringify({ persona: "draft", defect: o.defect || null, ok, checks }));
process.exit(ok ? 0 : 1);
