// Round 9, package P1b: storage that fails (quota on the first write, a disk that is full and then
// frees up) and two tabs on one file (one editing tab, hand-off, nothing lost).
// Usage: start `npm run dev` (port 5173) or pass E2E_URL, then `node scripts/qa/r9d-e2e.mjs`.
// Env: E2E_URL (default http://localhost:5173), CHROMIUM (executable path).

import { chromium } from "playwright-core";
import fs from "node:fs";

const URL = process.env.E2E_URL ?? "http://localhost:5173";
const launch = { headless: true, args: ["--no-sandbox"] };
if (process.env.CHROMIUM) launch.executablePath = process.env.CHROMIUM;
else if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => {
  for (let t = 0; t < ms; t += 100) {
    if (await fn().catch(() => false)) return true;
    await sleep(100);
  }
  return false;
};

const browser = await chromium.launch(launch);
const errors = [];

async function newContext() {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
  await ctx.route(
    (u) => !/^(127\.0\.0\.1|localhost)$/.test(new globalThis.URL(u).hostname) && !/^(data|blob):/.test(u.toString()),
    (r) => r.abort(),
  );
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem("dt:tour-done", "1");
    } catch {
      /* no storage */
    }
    // A disk that is full: every put throws as it is queued (what Safari does) while __failIDB is set.
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...a) {
      if (window.__failIDB) throw new DOMException("Not enough space on the disk", "QuotaExceededError");
      return put.apply(this, a);
    };
  });
  return ctx;
}
const track = (page) => {
  page.on("pageerror", (e) => errors.push(String(e)));
  return page;
};

const names = (page) => page.evaluate(() => Object.values(window.__dt.doc().nodes).map((n) => n.name));
const addRect = (page, name, x = 0) =>
  page.evaluate(
    ([n, x]) => window.__dt.dispatch({ op: "ai", tool: "create_nodes", input: { nodes: [{ type: "rectangle", name: n, x, y: 0, width: 60, height: 60, fill: "#AA0000" }] } }),
    [name, x],
  );
const label = (page) => page.locator(".save-state").textContent();
const waitSaved = (page, ms = 10000) => waitFor(async () => (await label(page)).includes("Saved locally") && !(await page.evaluate(() => window.__dt.dirty())), ms);
const bars = (page) => page.locator(".stale-bar").allTextContents();
const isReadOnly = (page) => page.evaluate(() => !!window.__dt.state().readOnly);
const fileIdOf = (page) => page.evaluate(() => location.hash.replace(/^#\/file\//, ""));
const storedNames = (page) =>
  page.evaluate(async () => {
    const db = await new Promise((r) => {
      const q = indexedDB.open("keyval-store");
      q.onsuccess = () => r(q.result);
    });
    const get = (k) =>
      new Promise((r) => {
        const q = db.transaction("keyval").objectStore("keyval").get(k);
        q.onsuccess = () => r(q.result);
      });
    const keys = await new Promise((r) => {
      const q = db.transaction("keyval").objectStore("keyval").getAllKeys();
      q.onsuccess = () => r(q.result);
    });
    const k = keys.find((k) => String(k).startsWith("dt:file:"));
    if (!k) return [];
    const v = await get(k);
    if (v.v !== 2) return Object.values(JSON.parse(v.doc).nodes).map((n) => n.name);
    const id = String(k).slice("dt:file:".length);
    const out = [];
    for (const root of Object.keys(v.roots)) {
      const body = await get(`dt:root:${id}:${root}`);
      out.push(...Object.values(JSON.parse(`{${body}}`)).map((n) => n.name));
    }
    return out;
  });

async function openNew(ctx, init) {
  const page = track(await ctx.newPage());
  if (init) await page.addInitScript(init);
  await page.goto(URL);
  await page.click("button:has-text('New design file')");
  await page.waitForSelector("#dt-canvas");
  await sleep(600);
  return page;
}
async function openFile(ctx, id) {
  const page = track(await ctx.newPage());
  await page.goto(`${URL}/#/file/${id}`);
  await page.waitForSelector("#dt-canvas");
  await sleep(700);
  return page;
}
const has = (list, re) => list.some((t) => re.test(t));

// ---------- 1. Two tabs ----------
{
  const ctx = await newContext();
  const A = await openNew(ctx);
  const id = await fileIdOf(A);
  check("tab A, the first, edits (no bar)", (await bars(A)).length === 0 && !(await isReadOnly(A)));
  await addRect(A, "A-1");
  check("A saves A-1", await waitSaved(A));
  check("the browser was asked to keep storage once (flag set after the first save)", await A.evaluate(() => localStorage.getItem("dt:persist-asked") === "1"));

  const B = await openFile(ctx, id);
  check("tab B opens read-only", await isReadOnly(B));
  check("B shows the bar about the other tab", has(await bars(B), /open for editing in another tab/), (await bars(B)).join("|"));
  check("B has the Edit here instead button", (await B.getByRole("button", { name: "Edit here instead" }).count()) === 1);
  check("B shows A-1", (await names(B)).includes("A-1"));
  const before = (await names(B)).length;
  await addRect(B, "refused");
  check("B refuses an edit", (await names(B)).length === before && !(await names(B)).includes("refused"));
  check("A is not disturbed (no bar, editable)", (await bars(A)).length === 0 && !(await isReadOnly(A)));

  // A edits and B sees it without a reload.
  await addRect(A, "A-1b", 80);
  check("A saves A-1b", await waitSaved(A));
  check("B shows A's save without reloading", await waitFor(async () => (await names(B)).includes("A-1b"), 4000));
  check("B is still read-only and not marked stale", (await isReadOnly(B)) && !has(await bars(B), /changed in another tab/));

  // Hand-off, with an edit in A that is not saved yet when B asks.
  await addRect(A, "A-1c", 160);
  await B.getByRole("button", { name: "Edit here instead" }).click();
  check("B becomes editable", await waitFor(async () => !(await isReadOnly(B)), 6000));
  check("B says so", await B.locator(".toast").filter({ hasText: "You can edit here now" }).count().then((n) => n > 0), "toast");
  check("B has A's last edit (flushed before the hand-off)", (await names(B)).includes("A-1c"), (await names(B)).join(","));
  check("B's bar is gone", (await bars(B)).length === 0);
  check("A is read-only with 'Editing moved to another tab'", (await isReadOnly(A)) && has(await bars(A), /Editing moved to another tab/), (await bars(A)).join("|"));
  await addRect(B, "B-1", 240);
  check("B saves B-1", await waitSaved(B));
  check("A shows B-1", await waitFor(async () => (await names(A)).includes("B-1"), 4000));

  // Back again: A takes over, B's last edit must come along.
  await addRect(B, "B-1b", 320);
  await A.getByRole("button", { name: "Edit here", exact: true }).click();
  check("A becomes editable again", await waitFor(async () => !(await isReadOnly(A)), 6000));
  check("A has B's unsaved-at-the-time edit", (await names(A)).includes("B-1b"));
  await addRect(A, "A-2", 400);
  check("A saves A-2", await waitSaved(A));
  check("B shows A-2", await waitFor(async () => (await names(B)).includes("A-2"), 4000));
  const all = await storedNames(A);
  const want = ["A-1", "A-1b", "A-1c", "B-1", "B-1b", "A-2"];
  check("stored file has every edit (A-1, B-1, A-2 and the in-flight ones)", want.every((n) => all.includes(n)), all.join(","));

  // Closing the editing tab makes the other editable.
  await A.close({ runBeforeUnload: false });
  check("closing A makes B editable", await waitFor(async () => !(await isReadOnly(B)), 6000));
  check("B still has everything", want.every(async () => true) && (await names(B)).includes("A-2") && (await names(B)).includes("B-1b"));
  await addRect(B, "B-2", 480);
  check("B saves B-2 after taking over", await waitSaved(B));
  check("no uncaught errors in the two-tab run", errors.length === 0, errors.join("|"));
  await ctx.close();
}

// ---------- 1b. The other tab doesn't answer: "Edit here anyway" ----------
{
  const ctx = await newContext();
  const A = await openNew(ctx);
  const id = await fileIdOf(A);
  await addRect(A, "Stuck-1");
  await waitSaved(A);
  const B = await openFile(ctx, id);
  // A busy page can't answer.
  A.evaluate(() => {
    const t = Date.now();
    while (Date.now() - t < 9000);
  }).catch(() => {});
  await sleep(200);
  await B.getByRole("button", { name: "Edit here instead" }).click();
  check("B waits and says it is asking", has(await bars(B), /Asking the other tab/), (await bars(B)).join("|"));
  check("after 5 s B offers 'Edit here anyway'", await waitFor(async () => (await B.getByRole("button", { name: "Edit here anyway" }).count()) === 1, 7500));
  check("B is still read-only until the person chooses", await isReadOnly(B));
  await B.getByRole("button", { name: "Edit here anyway" }).click();
  check("B takes over", await waitFor(async () => !(await isReadOnly(B)), 4000));
  check("B has the saved file", (await names(B)).includes("Stuck-1"));
  check("A goes read-only as soon as it can answer", await waitFor(async () => (await isReadOnly(A)) && has(await bars(A), /Editing moved/), 15000), (await bars(A)).join("|"));
  await ctx.close();
}

// ---------- 1c. A live-session link keeps today's behaviour ----------
{
  const ctx = await newContext();
  const A = await openNew(ctx);
  const id = await fileIdOf(A);
  await addRect(A, "Live-1");
  await waitSaved(A);
  const C = track(await ctx.newPage());
  await C.goto(`${URL}/?room=zzzz#/file/${id}`);
  await C.waitForSelector("#dt-canvas");
  await sleep(900);
  check("a tab opened from a room link is not made read-only by the lock", !has(await bars(C), /another tab/) && !(await isReadOnly(C)), (await bars(C)).join("|"));
  await ctx.close();
}

// ---------- 2. Storage: a full disk on a file that exists, then it frees up ----------
{
  const ctx = await newContext();
  const A = await openNew(ctx);
  const id = await fileIdOf(A);
  await addRect(A, "Before");
  await waitSaved(A);
  await A.close();
  const P = track(await ctx.newPage());
  await P.goto(`${URL}/#/file/${id}`);
  await P.waitForSelector("#dt-canvas");
  await sleep(700);
  await P.evaluate(() => (window.__failIDB = true));
  await addRect(P, "Full-1");
  await sleep(1500);
  await addRect(P, "Full-2", 80);
  const shown = await waitFor(async () => (await P.locator(".stale-bar").count()) > 0, 14000);
  const lbl = await label(P);
  check("the label says storage is full or blocked", /Not saved: browser storage is full or blocked/.test(lbl), lbl);
  check("after two failed attempts a bar offers a .dtron download", shown && has(await bars(P), /storage is full or blocked/) && (await P.getByRole("button", { name: "Download a .dtron copy" }).count()) === 1, (await bars(P)).join("|"));
  check("no false 'deleted' banner", !has(await bars(P), /deleted/));
  const [dl] = await Promise.all([P.waitForEvent("download", { timeout: 5000 }).catch(() => null), P.getByRole("button", { name: "Download a .dtron copy" }).click()]);
  check("the button downloads a .dtron file", !!dl && /\.dtron$/.test(dl.suggestedFilename()), dl?.suggestedFilename());
  if (dl) {
    const text = fs.readFileSync(await dl.path(), "utf8");
    check("the copy holds the unsaved edits", text.includes("Full-1") && text.includes("Full-2"));
  }
  await P.evaluate(() => (window.__failIDB = false));
  check("the edits are stored once storage returns", await waitSaved(P, 14000));
  check("the bar goes away", await waitFor(async () => (await P.locator(".stale-bar").count()) === 0, 3000));
  const got = await storedNames(P);
  check("the stored file has the edits made while storage was full", got.includes("Full-1") && got.includes("Full-2") && got.includes("Before"), got.join(","));
  await ctx.close();
}

// ---------- 3. Storage: the very first write fails (memory mode), a probe finds it back ----------
{
  const ctx = await newContext();
  const page = track(await ctx.newPage());
  await page.addInitScript(() => (window.__failIDB = true));
  await page.goto(URL);
  await page.click("button:has-text('New design file')");
  await page.waitForSelector("#dt-canvas");
  await sleep(800);
  await addRect(page, "Mem-1");
  await sleep(1200);
  await addRect(page, "Mem-2", 80);
  await sleep(1500);
  check("memory mode says not saved", /Not saved: browser storage is full or blocked/.test(await label(page)), await label(page));
  check("memory mode offers the download after two saves", await waitFor(async () => (await page.getByRole("button", { name: "Download a .dtron copy" }).count()) === 1, 6000), (await bars(page)).join("|"));
  check("no false 'deleted' banner in memory mode", !has(await bars(page), /deleted/));
  await page.evaluate(() => (window.__failIDB = false));
  check("the probe finds storage again and saves (within 35 s)", await waitSaved(page, 36000));
  check("no 'deleted' banner after storage returns", !has(await bars(page), /deleted/), (await bars(page)).join("|"));
  check("the bar is gone", (await page.locator(".stale-bar").count()) === 0);
  const got = await storedNames(page);
  check("the file is in IndexedDB with both layers", got.includes("Mem-1") && got.includes("Mem-2"), got.join(","));
  await page.reload();
  await page.waitForSelector("#dt-canvas");
  await sleep(800);
  check("it reopens with the layers after a reload", (await names(page)).includes("Mem-2"));
  await ctx.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
