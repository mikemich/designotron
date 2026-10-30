// Performance stage 1: text level of detail, viewport culling, document-change listeners that
// ignore selection, and per-layer incremental storage (writes follow what changed, old
// single-record files still open and migrate, rename and delete handle both forms).
// Usage: start `npm run dev` (port 5173) or pass E2E_URL, then `node scripts/qa/w2d-e2e.mjs`.
// Env: E2E_URL (default http://localhost:5173), CHROMIUM (executable path).

import { chromium } from "playwright-core";
import fs from "node:fs";

const URL_ = process.env.E2E_URL ?? "http://localhost:5173";
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
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
// Fonts come from Google; keep the test off the internet.
await context.route(
  (u) => !/^(127\.0\.0\.1|localhost)$/.test(new globalThis.URL(u).hostname) && !/^(data|blob):/.test(u.toString()),
  (r) => r.abort(),
);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.addInitScript(() => {
  try {
    localStorage.setItem("dt:tour-done", "1");
  } catch {
    /* no storage */
  }
});

const tool = (name, input) => page.evaluate(([n, i]) => window.__dt.tool(n, i), [name, input]);
const dispatch = (cmd) => page.evaluate((c) => window.__dt.dispatch(c), cmd);
const doc = () => page.evaluate(() => window.__dt.doc());
const names = async () => Object.values((await doc()).nodes).map((n) => n.name);
const byName = async (name) => Object.values((await doc()).nodes).find((n) => n.name === name);
const label = () => page.locator(".save-state").textContent();
const saved = async () => {
  for (let i = 0; i < 80; i++) {
    if ((await label()).includes("Saved locally")) return true;
    await sleep(100);
  }
  return false;
};
// Waits for the edit to be picked up (the label leaves "Saved"), then for it to be stored.
const settle = async () => {
  for (let i = 0; i < 20 && (await label()).includes("Saved locally"); i++) await sleep(50);
  return saved();
};

const idb = (fn, arg) =>
  page.evaluate(
    async ([src, a]) => {
      const db = await new Promise((r) => {
        const q = indexedDB.open("keyval-store");
        q.onsuccess = () => r(q.result);
      });
      const req = (r) => new Promise((res) => ((r.onsuccess = () => res(r.result)), undefined));
      const store = () => db.transaction("keyval", "readwrite").objectStore("keyval");
      return new Function("store", "req", "arg", `return (${src})(store, req, arg)`)(store, req, a);
    },
    [fn.toString(), arg],
  );
const keys = () => idb(async (store, req) => (await req(store().getAllKeys())).map(String));
const get = (k) => idb((store, req, k) => req(store().get(k)), k);
const put = (k, v) => idb((store, req, a) => req(store().put(a[1], a[0])), [k, v]);
// The stored record of the file open now.
const fileKeyOf = async () => "dt:file:" + (await page.evaluate(() => location.hash.match(/#\/file\/(\w+)/)[1]));

const spyPuts = () =>
  page.evaluate(() => {
    window.__puts = [];
    if (window.__putSpy) return;
    window.__putSpy = true;
    const orig = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (v, k) {
      window.__puts.push(String(k));
      return orig.call(this, v, k);
    };
  });
const puts = () => page.evaluate(() => window.__puts);

const open = async () => {
  await page.goto(URL_);
  await page.waitForSelector("button:has-text('New design file')");
  await page.click("button:has-text('New design file')");
  await page.waitForSelector("#dt-canvas");
  await sleep(500);
};
const reload = async () => {
  await page.reload();
  await page.waitForSelector("#dt-canvas");
  await sleep(1200);
};
const frame = (name, x, extra = {}) => ({
  type: "frame",
  name,
  x,
  y: 0,
  width: 300,
  height: 200,
  fill: "#FFFFFF",
  children: [
    { type: "rectangle", name: name + " box", x: 10, y: 10, width: 50, height: 50, fill: "#FF0000" },
    { type: "text", name: name + " label", x: 10, y: 80, text: "Hello " + name, fontSize: 16 },
  ],
  ...extra,
});

try {
  await open();

  // 1. Text level of detail: bars instead of glyphs when the text would be under 5 px.
  {
    await tool("create_nodes", { nodes: [{ type: "text", name: "Small", x: 0, y: 0, text: "Readable at 100%", fontSize: 16 }] });
    const shown = (sel) => page.evaluate((s) => [...document.querySelectorAll(s)].map((e) => getComputedStyle(e).display), sel);
    await page.evaluate(() => window.__dt.setViewport({ x: 100, y: 100, zoom: 1 }));
    await sleep(200);
    check("text is drawn at 100%", (await shown(".dt-content text.s16")).every((d) => d !== "none") && (await shown(".dt-content text.s16")).length === 1);
    check("its greek bar is hidden at 100%", (await shown(".dt-content path.gk")).every((d) => d === "none"));
    await page.evaluate(() => window.__dt.setViewport({ x: 100, y: 100, zoom: 0.25 }));
    await sleep(300);
    check("16 px text is hidden below 5 px on screen", (await shown(".dt-content text.s16")).every((d) => d === "none"));
    check("its bar is shown instead", (await shown(".dt-content path.gk")).every((d) => d !== "none"));
    await page.evaluate(() => window.__dt.setViewport({ x: 100, y: 100, zoom: 0.33 }));
    await sleep(300);
    check("text is back at 5.3 px", (await shown(".dt-content text.s16")).every((d) => d !== "none"));
  }

  // 2. Viewport culling: roots far outside the view leave the layout and come back when panned to.
  {
    await tool("create_nodes", { nodes: [frame("Near", 0), frame("Far", 30000)] });
    await page.evaluate(() => window.__dt.setViewport({ x: 50, y: 50, zoom: 1 }));
    await sleep(300);
    const state = () =>
      page.evaluate(() => {
        const d = window.__dt.doc();
        const out = {};
        for (const g of document.querySelectorAll(".dt-content g[data-root]")) {
          const n = d.nodes[g.dataset.root];
          if (n.name === "Near" || n.name === "Far") out[n.name] = g.getAttribute("display") === "none";
        }
        return out;
      });
    let s = await state();
    check("a root inside the view is drawn, one 30000 px away is not", s.Near === false && s.Far === true, JSON.stringify(s));
    await page.evaluate(() => window.__dt.setViewport({ x: -29950, y: 50, zoom: 1 }));
    await sleep(300);
    s = await state();
    check("panning there swaps them", s.Near === true && s.Far === false, JSON.stringify(s));
    await page.evaluate(() => window.__dt.zoomToFit());
    await sleep(300);
    s = await state();
    check("zoom to fit shows both", s.Near === false && s.Far === false, JSON.stringify(s));
    // Editing a hidden root still updates it; it is right when it comes into view.
    const far = await byName("Far box");
    await page.evaluate(() => window.__dt.setViewport({ x: 50, y: 50, zoom: 1 }));
    await dispatch({ op: "update", ids: [far.id], patch: { fill: undefined, x: 120 } });
    await page.evaluate(() => window.__dt.zoomToFit());
    await sleep(300);
    const boxX = await page.evaluate((id) => document.querySelector(`.dt-content g[data-id="${id}"]`)?.getAttribute("transform"), far.id);
    check("a change made while its root was off screen shows up when it is back", /translate\(120/.test(boxX ?? "") || /matrix\(1 0 0 1 120/.test(boxX ?? ""), String(boxX));
  }

  // 3. While zooming a big page, text is drawn as bars; it comes back 150 ms after the last step.
  {
    await tool("create_nodes", {
      nodes: [
        {
          type: "frame",
          name: "Wall",
          x: 0,
          y: 2000,
          width: 1200,
          fill: "#FFFFFF",
          layout: { direction: "horizontal", gap: 4, padding: 8, wrap: true },
          children: Array.from({ length: 450 }, (_, i) => ({ type: "text", name: "w" + i, text: "t" + i, fontSize: 14 })),
        },
      ],
    });
    await page.evaluate(() => window.__dt.zoomToFit());
    await sleep(600);
    const lod = () => page.evaluate(() => document.querySelector(".dt-content g[transform]")?.classList.contains("zoom-lod"));
    await page.mouse.move(700, 450);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -40);
    await sleep(40);
    const during = await lod();
    await page.keyboard.up("Control");
    await sleep(500);
    const after = await lod();
    check("zooming a page with 450+ texts in view uses the cheap look", during === true, String(during));
    check("and it is back to normal after the zoom stops", after === false, String(after));
  }

  // 4. Document listeners ignore selection and fire once per real change.
  {
    const a = await byName("Near box");
    await page.evaluate(() => {
      window.__calls = 0;
      window.__off = window.__dt.onDocChange(() => window.__calls++);
    });
    for (let i = 0; i < 6; i++) await dispatch({ op: "select", ids: [a.id] });
    await dispatch({ op: "select", ids: [] });
    check("selecting doesn't notify document listeners", (await page.evaluate(() => window.__calls)) === 0);
    await dispatch({ op: "update", ids: [a.id], patch: { x: 33 } });
    check("an edit does, once", (await page.evaluate(() => window.__calls)) === 1);
    await dispatch({ op: "undo" });
    check("undo does", (await page.evaluate(() => window.__calls)) === 2);
    await page.evaluate(() => window.__off());
  }

  // 5. Storage is one record per top-level layer; saves write only what changed.
  {
    await open();
    await tool("create_nodes", { nodes: [frame("A", 0), frame("B", 400), frame("C", 800)] });
    await saved();
    await sleep(800);
    const fkey = await fileKeyOf();
    const id = fkey.slice("dt:file:".length);
    let m = await get(fkey);
    const all = await keys();
    check("the file is a manifest of layers", m.v === 2 && Object.keys(m.roots).length >= 3, `v=${m.v} roots=${Object.keys(m.roots).length}`);
    check("each layer has its own record", Object.keys(m.roots).every((r) => all.includes(`dt:root:${id}:${r}`)));
    await spyPuts();
    const b = await byName("B box");
    await dispatch({ op: "update", ids: [b.id], patch: { x: 25 } });
    await settle();
    await sleep(600);
    const ps = await puts();
    const rootPuts = ps.filter((k) => k.startsWith("dt:root:"));
    const bRoot = (await byName("B")).id;
    check("editing a layer in B writes only B's record", rootPuts.length === 1 && rootPuts[0] === `dt:root:${id}:${bRoot}`, rootPuts.join(","));
    check("and the manifest", ps.filter((k) => k === fkey).length === 1, ps.join(","));
    await reload();
    const after = await names();
    check("every layer is there after reloading", ["A", "B", "C", "A box", "B box", "C box", "A label", "B label", "C label"].every((n) => after.includes(n)), after.join(","));
    check("the edit is there", (await byName("B box")).x === 25);
    check("opening and not editing writes nothing", (await page.evaluate(() => (window.__puts ?? []).length)) === 0);

    // Deleting a top-level layer drops its record.
    const cId = (await byName("C")).id;
    await spyPuts();
    await dispatch({ op: "delete", ids: [cId] });
    await settle();
    await sleep(600);
    m = await get(fkey);
    const keysNow = await keys();
    check("deleting a layer removes it from the manifest", !(cId in m.roots) && Object.keys(m.roots).length >= 2);
    check("and its record is deleted", !keysNow.includes(`dt:root:${id}:${cId}`));
    await reload();
    check("the deleted layer stays deleted", !(await names()).includes("C box"));

    // Moving a layer into another one, and undoing it.
    const aId = (await byName("A")).id;
    const bId = (await byName("B")).id;
    await dispatch({ op: "moveToParent", ids: [aId], parent: bId, index: null });
    await settle();
    await sleep(600);
    m = await get(fkey);
    check("a layer moved into another stops being stored on its own", !(aId in m.roots) && bId in m.roots, Object.keys(m.roots).join(","));
    await dispatch({ op: "undo" });
    await settle();
    await sleep(600);
    m = await get(fkey);
    check("undoing the move stores it on its own again", aId in m.roots && bId in m.roots);
    await dispatch({ op: "redo" });
    await settle();
    await sleep(600);
    await reload();
    const moved = await byName("A");
    check("the moved layer keeps its place after a reload", moved?.parent === bId && (await names()).includes("A box") && (await names()).includes("A label"));
  }

  // 6. Images are stored once, and found again.
  {
    await page.evaluate(() => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="#0a0"/></svg>';
      const dt = new DataTransfer();
      dt.setData("text/plain", svg);
      document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await sleep(500);
    await settle();
    await sleep(500);
    const fkey = await fileKeyOf();
    const id = fkey.slice("dt:file:".length);
    const m = await get(fkey);
    const all = await keys();
    check("the image is stored as its own record", m.assets.length === 1 && all.includes(`dt:asset:${id}:${m.assets[0]}`), JSON.stringify(m.assets));
    await spyPuts();
    const box = await byName("A box");
    await dispatch({ op: "update", ids: [box.id], patch: { x: 77 } });
    await settle();
    await sleep(600);
    check("editing something else doesn't rewrite the image", !(await puts()).some((k) => k.startsWith("dt:asset:")), (await puts()).join(","));
    await reload();
    const img = await page.evaluate(() => document.querySelector(".dt-content image")?.getAttribute("href") ?? "");
    check("the image comes back after a reload", img.startsWith("blob:"), img.slice(0, 30));
  }

  // 7. A file saved the old way (one record) opens, and becomes layered on its first edit.
  {
    const fkey = await fileKeyOf();
    const id = fkey.slice("dt:file:".length);
    const m = await get(fkey);
    const chunks = await Promise.all(Object.keys(m.roots).map((r) => get(`dt:root:${id}:${r}`)));
    const json = JSON.stringify({ ...JSON.parse(`${m.meta.slice(0, -1)},"nodes":{${chunks.join(",")}}}`), name: "Legacy" });
    const assets = {};
    for (const a of m.assets) assets[a] = await get(`dt:asset:${id}:${a}`);
    await put("dt:file:flegacy1", { doc: json, assets });
    const index = await get("dt:index");
    await put("dt:index", [...index, { id: "flegacy1", name: "Legacy", updatedAt: Date.now() }]);
    await page.evaluate(() => (location.hash = "#/file/flegacy1"));
    await page.waitForSelector("#dt-canvas");
    await sleep(1200);
    check("an old single-record file opens", (await names()).includes("B box") && (await names()).includes("A label"));
    await spyPuts();
    await sleep(2500);
    check("opening it writes nothing", (await puts()).length === 0);
    const b = await byName("B box");
    await dispatch({ op: "update", ids: [b.id], patch: { x: 5 } });
    await settle();
    await sleep(600);
    const migrated = await get("dt:file:flegacy1");
    check("its first edit stores it as layers", migrated.v === 2 && Object.keys(migrated.roots).length >= 1, `v=${migrated.v}`);
    await reload();
    check("and it opens again with the edit", (await byName("B box")).x === 5 && (await names()).includes("A label"));
  }

  // 8. Rename and delete from the files list, for layered files.
  {
    await page.evaluate(() => (location.hash = "#/"));
    await page.waitForSelector(".file-card");
    await sleep(300);
    const cards = await page.locator(".file-card").count();
    const legacyName = "Legacy";
    page.once("dialog", (d) => d.accept("Renamed legacy"));
    const card = page.locator(".file-card", { hasText: legacyName });
    await card.hover();
    await card.locator(".ibtn.more").click();
    await page.click(".menu >> text=Rename");
    await sleep(800);
    check("a layered file can be renamed", (await page.locator(".file-card", { hasText: "Renamed legacy" }).count()) === 1);
    await page.locator(".file-card", { hasText: "Renamed legacy" }).click();
    await page.waitForSelector("#dt-canvas");
    await sleep(1200);
    check("it opens under its new name with its content", (await page.evaluate(() => window.__dt.doc().name)) === "Renamed legacy" && (await names()).includes("B box"));
    await page.evaluate(() => (location.hash = "#/"));
    await page.waitForSelector(".file-card");
    page.once("dialog", (d) => d.accept());
    const c2 = page.locator(".file-card", { hasText: "Renamed legacy" });
    await c2.hover();
    await c2.locator(".ibtn.more").click();
    await page.click(".menu >> text=Delete");
    await sleep(800);
    const left = await keys();
    check("deleting a layered file removes every record", !left.some((k) => k.startsWith("dt:root:flegacy1:") || k === "dt:file:flegacy1"), left.filter((k) => k.includes("flegacy1")).join(","));
    check("other files are untouched", (await page.locator(".file-card").count()) === cards - 1);
  }

  check("no page errors", errors.length === 0, errors.join(" | "));
} catch (err) {
  check("unexpected exception", false, String(err && err.stack ? err.stack : err));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
