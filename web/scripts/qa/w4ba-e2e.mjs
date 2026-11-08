// W4B-A: per-character text merging in the engine, in a real browser: two pages share one document,
// merge text per character through the engine's own deltas (no relay: this script carries
// `collabDelta` / `applyRemote` / `collabAck` between the pages in an order it picks), one page types
// in the real text editor (whole-text `setText`, so the engine's fixup path) while the other
// dispatches `editText` at another spot.
// Servers (local only):
//   E2E_URL  vite preview of web/dist (default http://127.0.0.1:7401)
//   SHOTS    folder for screenshots
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const URL_ = process.env.E2E_URL ?? "http://127.0.0.1:7401";
const SHOTS = process.env.SHOTS;
const launch = { headless: true, args: ["--no-sandbox"] };
if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + String(detail).slice(0, 600) : ""}`);
};
const local = (u) => /^(127\.0\.0\.1|localhost)$/.test(new globalThis.URL(u).hostname) || /^(data|blob|about):/.test(u);

const browser = await chromium.launch(launch);
const errors = [];
const newPage = async () => {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 2 });
  await context.route((u) => !local(u.toString()), (r) => r.abort());
  await context.addInitScript(() => {
    try {
      localStorage.setItem("dt:tour-done", "1");
    } catch {
      /* no storage */
    }
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  return page;
};
const open = async (page) => {
  await page.goto(URL_);
  await page.waitForSelector(".files", { timeout: 20000 });
  await page.click("button:has-text('New design file')");
  await page.waitForSelector("#dt-canvas", { timeout: 20000 });
  await page.waitForTimeout(300);
};
const canon = (v) => JSON.stringify(v, (_, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
const node = (page, id) => page.evaluate((i) => window.__dt.doc().nodes[i], id);
const chars = async (page, id) => (await node(page, id)).text.characters;
const cmd = (page, c) => page.evaluate((c) => JSON.parse(window.__dt.engine().dispatch(JSON.stringify(c))), c);
const delta = (page) => page.evaluate(() => JSON.parse(window.__dt.engine().collabDelta()));
const SITE_A = 2 ** 48 - 7;
const SITE_B = 123456789012;

const a = await newPage();
const b = await newPage();
await open(a);
await open(b);

// One document: A makes the text layer, B loads A's file.
const id = await a.evaluate(() => {
  window.__dt.dispatch({ op: "createText", x: 40, y: 40, characters: "Hello world" });
  return Object.values(window.__dt.doc().nodes).find((n) => n.text?.characters === "Hello world").id;
});
const file = await a.evaluate(() => window.__dt.engine().save());
await b.evaluate((f) => {
  window.__dt.engine().load(f);
  window.__dt.dispatch({ op: "relayout" });
}, file);
check("both pages hold the layer", (await chars(b, id)) === "Hello world");

// A text room: ordered, granular, lists, and the engine told to merge text.
const supported = await a.evaluate(() => window.__dt.engine().collabTextSupported());
check("the engine says it merges text", supported === true);
for (const [p, site] of [[a, SITE_A], [b, SITE_B]]) {
  await p.evaluate((s) => {
    const e = window.__dt.engine();
    e.collabReset(true, true, true);
    e.collabEnableText(s);
  }, site);
}
check("merging is on", (await a.evaluate(() => window.__dt.engine().collabText())) === true);

// Round 1: A types at the end in the real editor, B types at the start through editText.
await a.evaluate((i) => window.__dt.edit(i), id);
await a.waitForSelector("textarea");
await a.locator("textarea").first().focus();
await a.keyboard.press("Control+End");
await a.keyboard.type(" AAA", { delay: 20 });
await a.keyboard.press("Escape");
await a.waitForTimeout(200);
await cmd(b, { op: "editText", id, start: 0, end: 0, text: "BBB " });
check("A's editor typing is in A's document", (await chars(a, id)) === "Hello world AAA", await chars(a, id));

const dA = await delta(a);
const dB = await delta(b);
check("A's change travels as a text entry", !!dA.text?.[id]?.ins?.length, JSON.stringify(dA).slice(0, 300));
check("with no whole text next to it", !JSON.stringify(dA).includes('"characters"') && !dA.patch?.[id]?.text, JSON.stringify(dA).slice(0, 300));
check("B's change travels as a text entry", !!dB.text?.[id]?.ins?.length);
const siteSeen = dA.text[id].ins[0].id[0];
check("a site near 2^48 survives the browser's JSON", siteSeen === SITE_A, `${siteSeen} vs ${SITE_A}`);

// The room's order: A's change, then B's.
await b.evaluate((d) => window.__dt.dispatch({ op: "applyRemote", delta: d, local: false }), dA);
await b.evaluate(() => window.__dt.dispatch({ op: "collabAck", rejected: false }));
await a.evaluate(() => window.__dt.dispatch({ op: "collabAck", rejected: false }));
await a.evaluate((d) => window.__dt.dispatch({ op: "applyRemote", delta: d, local: false }), dB);
const [ta, tb] = [await node(a, id), await node(b, id)];
check("both end with every character", (await chars(a, id)) === "BBB Hello world AAA" && (await chars(b, id)) === "BBB Hello world AAA", `${await chars(a, id)} | ${await chars(b, id)}`);
check("identical layers, sequence included", canon(ta) === canon(tb) && !!ta.text.seq, canon(ta.text).slice(0, 300));
await a.screenshot({ path: SHOTS ? path.join(SHOTS, "w4ba-a.png") : undefined }).catch(() => {});

// Round 2: concurrent again at one spot (both whole), a style, and a delete with typing inside it.
await cmd(a, { op: "editText", id, start: 4, end: 4, text: "<a>" });
await cmd(b, { op: "editText", id, start: 4, end: 4, text: "<b>" });
await cmd(b, { op: "styleText", id, start: 0, end: 3, style: { fontWeight: 700 } });
const d2a = await delta(a);
const d2b = await delta(b);
await b.evaluate((d) => window.__dt.dispatch({ op: "applyRemote", delta: d, local: false }), d2a);
await b.evaluate(() => window.__dt.dispatch({ op: "collabAck", rejected: false }));
await a.evaluate(() => window.__dt.dispatch({ op: "collabAck", rejected: false }));
await a.evaluate((d) => window.__dt.dispatch({ op: "applyRemote", delta: d, local: false }), d2b);
const [ta2, tb2] = [await node(a, id), await node(b, id)];
check("same spot: both runs whole, the later one first", ta2.text.characters.includes("<b><a>"), ta2.text.characters);
check("converged with the style", canon(ta2) === canon(tb2) && ta2.text.runs.length > 0, canon(ta2.text.runs));

// Round 3: B deletes a stretch while A types inside it.
const len = (await chars(a, id)).length;
await cmd(b, { op: "editText", id, start: 8, end: len - 4, text: "" });
await cmd(a, { op: "editText", id, start: 12, end: 12, text: "KEEP" });
const d3a = await delta(a);
const d3b = await delta(b);
await b.evaluate((d) => window.__dt.dispatch({ op: "applyRemote", delta: d, local: false }), d3a);
await b.evaluate(() => window.__dt.dispatch({ op: "collabAck", rejected: false }));
await a.evaluate(() => window.__dt.dispatch({ op: "collabAck", rejected: false }));
await a.evaluate((d) => window.__dt.dispatch({ op: "applyRemote", delta: d, local: false }), d3b);
const [ta3, tb3] = [await node(a, id), await node(b, id)];
check("typed inside a deleted stretch survives", ta3.text.characters.includes("KEEP"), ta3.text.characters);
check("and the layers are identical", canon(ta3) === canon(tb3));

// Per-person undo across the pages: B undoes its own step only.
await b.evaluate(() => window.__dt.dispatch({ op: "undo" }));
await b.waitForTimeout(100);
check("an undo keeps the other page's characters", (await chars(b, id)).includes("KEEP"), await chars(b, id));

check("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
