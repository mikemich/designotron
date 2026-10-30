// Autosave integrity: a slow thumbnail must never put an older document over a newer save,
// selecting must not write, and closing with unsaved work must warn and keep it.
// Usage: start `npm run dev` (port 5173) or pass E2E_URL, then `node scripts/qa/autosave-e2e.mjs`.
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

const browser = await chromium.launch(launch);

/** A page with the tour dismissed, and optional init script (spies) installed first. */
async function open(init) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(String(e)));
  await page.addInitScript(() => {
    try {
      localStorage.setItem("dt:tour-done", "1");
    } catch {
      /* no storage */
    }
  });
  if (init) await page.addInitScript(init);
  await page.goto(URL);
  await page.click("button:has-text('New design file')");
  await page.waitForSelector("#dt-canvas");
  await sleep(600);
  return page;
}

const addRect = (page, name, x, y, fill) =>
  page.evaluate(
    (a) => window.__dt.dispatch({ op: "ai", tool: "create_nodes", input: { nodes: [{ type: "rectangle", name: a.name, x: a.x, y: a.y, width: 100, height: 100, fill: a.fill }] } }),
    { name, x, y, fill },
  );

const label = (page) => page.locator(".save-state").textContent();

// Names of the layers in the stored copy of the open file.
const stored = (page) =>
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
    return Object.values(JSON.parse(v.doc).nodes).map((n) => n.name);
  });

const layerNames = (page) => page.evaluate(() => Object.values(window.__dt.doc().nodes).map((n) => n.name));

try {
  // 1. The oracle's repro: every thumbnail encode takes 2 s, two edits land 600 ms apart.
  {
    const page = await open(() => {
      const orig = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function (cb, ...rest) {
        orig.call(this, (b) => setTimeout(() => cb(b), 2000), ...rest);
      };
    });
    await addRect(page, "Base", 0, 300, "#0000ff");
    // The next thumbnail is due 15 s after the last one.
    await sleep(16000);
    await addRect(page, "First", 0, 0, "#ff0000");
    await sleep(600);
    await addRect(page, "Second", 200, 0, "#00ff00");
    // Whenever the label says saved, the stored copy must hold everything made so far.
    let lied = 0;
    let last = [];
    for (let t = 0; t < 14; t++) {
      await sleep(400);
      last = await stored(page);
      if ((await label(page)).includes("Saved locally") && !(last.includes("First") && last.includes("Second"))) lied++;
    }
    check("slow thumbnail: label never says saved while a layer is missing", lied === 0, `${lied} polls`);
    check("slow thumbnail: both later layers are stored", last.includes("First") && last.includes("Second"), last.filter((n) => ["Base", "First", "Second"].includes(n)).join(","));
    await page.reload();
    await page.waitForSelector("#dt-canvas");
    await sleep(800);
    const names = await layerNames(page);
    check("slow thumbnail: both layers after reload", names.includes("First") && names.includes("Second") && names.includes("Base"));
    check("slow thumbnail: no page errors", page.errors.length === 0, page.errors.join(" | "));
    await page.context().close();
  }

  // 2. Selecting writes nothing.
  {
    const page = await open(() => {
      window.__puts = 0;
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...a) {
        window.__puts++;
        return put.apply(this, a);
      };
    });
    for (let i = 0; i < 4; i++) await addRect(page, "R" + i, i * 150, 0, "#336699");
    for (let i = 0; i < 40 && !(await label(page)).includes("Saved locally"); i++) await sleep(250);
    await sleep(2500);
    const ids = await page.evaluate(() => Object.values(window.__dt.doc().nodes).filter((n) => n.type === "rectangle").map((n) => n.id));
    const rev = await page.evaluate(() => window.__dt.state().docRev);
    await page.evaluate(() => (window.__puts = 0));
    for (let i = 0; i < 50; i++) await page.evaluate((id) => window.__dt.dispatch({ op: "select", ids: [id] }), ids[i % ids.length]);
    for (let i = 0; i < 10; i++) await page.mouse.click(700 + i * 5, 800);
    await sleep(2500);
    const puts = await page.evaluate(() => window.__puts);
    check("60 selection changes cause 0 IndexedDB puts", puts === 0, `${puts} puts`);
    check("selection leaves the label at Saved locally", (await label(page)).includes("Saved locally"));
    check("docRev unchanged by selection", (await page.evaluate(() => window.__dt.state().docRev)) === rev);
    await addRect(page, "After", 0, 400, "#aa3366");
    await sleep(2500);
    const after = await page.evaluate(() => window.__puts);
    check("a real edit after selecting does write", after > 0 && (await stored(page)).includes("After"), `${after} puts`);
    await page.context().close();
  }

  // 3. Closing with a save in flight asks first, and nothing is lost either way.
  {
    const page = await open(() => {
      // Every write's transaction reports completion 1.5 s late, so one is always in flight
      // after an edit.
      const d = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, "oncomplete");
      Object.defineProperty(IDBTransaction.prototype, "oncomplete", {
        ...d,
        set(fn) {
          d.set.call(this, fn && ((e) => setTimeout(() => fn(e), 1500)));
        },
      });
    });
    await page.mouse.click(700, 500);
    await addRect(page, "Unsaved", 10, 10, "#ff00ff");
    await sleep(700);
    const dirty = !(await label(page)).includes("Saved locally");
    check("label says Saving while the write is outstanding", dirty);
    let dialog = null;
    page.on("dialog", async (d) => {
      dialog = d.type();
      await d.accept();
    });
    await page.reload();
    await page.waitForSelector("#dt-canvas");
    await sleep(1200);
    check("reload with unsaved work asks first", dialog === "beforeunload", String(dialog));
    check("the unsaved layer survives the reload", (await layerNames(page)).includes("Unsaved"));
    await page.context().close();
  }

  // 4. A write that fails (quota) is not "saved": the label says so, the copy in localStorage
  // keeps the edit, closing asks first, and a later write that works clears it all.
  {
    const page = await open(() => {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...a) {
        if (window.__failPut) throw new DOMException("quota", "QuotaExceededError");
        return put.apply(this, a);
      };
    });
    await addRect(page, "Kept", 0, 0, "#ff0000");
    await sleep(1500);
    await page.evaluate(() => (window.__failPut = true));
    await page.mouse.click(700, 500);
    await addRect(page, "AfterQuota", 200, 0, "#00ff00");
    await sleep(2500);
    const text = await label(page);
    check("a failed write is not reported as saved", !text.includes("Saved locally") && text.includes("Not saved"), text);
    const recovery = () => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("dt:recover")).length);
    check("a failed write keeps a recovery copy", (await recovery()) === 1);
    let dialog = null;
    page.on("dialog", async (d) => {
      dialog = d.type();
      await d.accept();
    });
    await page.evaluate(() => (window.__failPut = false));
    await sleep(5500);
    check("the save is retried and succeeds", (await label(page)).includes("Saved locally") && (await stored(page)).includes("AfterQuota"), await label(page));
    check("a successful retry clears the recovery copy", (await recovery()) === 0);
    await page.evaluate(() => (window.__failPut = true));
    await addRect(page, "Lost?", 400, 0, "#0000ff");
    await sleep(2500);
    await page.reload();
    await page.waitForSelector("#dt-canvas");
    await sleep(800);
    check("closing after a failed write asks first", dialog === "beforeunload", String(dialog));
    check("the edit made after the failure survives via the recovery copy", (await layerNames(page)).includes("Lost?"));
    await page.context().close();
  }

  // 5. Steady edits can't postpone saving for ever.
  {
    const page = await open(() => {
      window.__puts = [];
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (v, k) {
        if (String(k).startsWith("dt:file:")) window.__puts.push(performance.now());
        return put.call(this, v, k);
      };
    });
    await addRect(page, "R", 0, 0, "#ff0000");
    await sleep(2000);
    const id = await page.evaluate(() => Object.values(window.__dt.doc().nodes).find((n) => n.name === "R").id);
    await page.evaluate(() => (window.__puts = []));
    for (let i = 0; i < 40; i++) {
      await page.evaluate((a) => window.__dt.dispatch({ op: "update", ids: [a.id], patch: { x: a.i * 3 } }), { id, i });
      await sleep(300);
    }
    const n = await page.evaluate(() => window.__puts.length);
    check("edits every 300 ms for 12 s are saved along the way", n >= 2, `${n} saves`);
    await page.context().close();
  }

  // 6. Opening a file and not touching it writes nothing (fonts loading re-run layout).
  {
    const page = await open(() => {
      window.__puts = [];
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (v, k) {
        window.__puts.push(String(k).slice(0, 12));
        return put.call(this, v, k);
      };
    });
    await page.evaluate(() =>
      window.__dt.dispatch({
        op: "ai",
        tool: "create_nodes",
        input: { nodes: [{ type: "text", name: "T1", x: 0, y: 0, text: "Hello serif", fontFamily: "Playfair Display", fontSize: 32 }] },
      }),
    );
    await sleep(3000);
    await page.reload();
    await page.waitForSelector("#dt-canvas");
    await sleep(5000);
    const puts = await page.evaluate(() => window.__puts);
    check("reopening without editing writes no file", puts.length === 0, JSON.stringify(puts));
    await page.evaluate(() => window.__dt.dispatch({ op: "relayout" }));
    await sleep(1500);
    check("a relayout that changes nothing writes no file", (await page.evaluate(() => window.__puts.length)) === 0);
    check("the label stays Saved locally", (await label(page)).includes("Saved locally"));
    await page.context().close();
  }
} catch (err) {
  check("unexpected exception", false, String(err));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
