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

// Overlapping writes: each scenario ends by reopening the stored file, which must open (never
// "damaged") and equal what one of the writers had.
const RELAY = process.env.E2E_RELAY ?? "";
const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
const rig = async (ctxIn) => {
  const c = ctxIn ?? (await browser.newContext({ viewport: { width: 1400, height: 900 } }));
  if (!ctxIn)
    await c.route(
      (u) => !/^(127\.0\.0\.1|localhost)$/.test(new globalThis.URL(u).hostname) && !/^(data|blob):/.test(u.toString()),
      (r) => r.abort(),
    );
  const pg = await c.newPage();
  await pg.addInitScript(() => {
    try {
      localStorage.setItem("dt:tour-done", "1");
    } catch {
      /* no storage */
    }
  });
  pg.on("pageerror", (e) => errors.push(String(e)));
  pg.on("dialog", (d) => d.accept().catch(() => {}));
  const R = {
    c,
    pg,
    tool: (n, i) => pg.evaluate(([n, i]) => window.__dt.tool(n, i), [n, i]),
    dispatch: (cmd) => pg.evaluate((x) => window.__dt.dispatch(x), cmd),
    byName: async (name) => Object.values(await pg.evaluate(() => window.__dt.doc().nodes)).find((n) => n.name === name),
    canon: () =>
      pg.evaluate(() => {
        const sort = (v) => (Array.isArray(v) ? v.map(sort) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v);
        return JSON.stringify(sort(window.__dt.doc()));
      }),
    label: () => pg.locator(".save-state").textContent().catch(() => ""),
    fileId: () => pg.evaluate(() => location.hash.match(/#\/file\/(\w+)/)?.[1]),
    async settle() {
      for (let i = 0; i < 30 && (await R.label()).includes("Saved locally"); i++) await sleep(30);
      for (let i = 0; i < 600 && !(await R.label()).includes("Saved locally"); i++) await sleep(50);
      await sleep(300);
    },
    async newFile(url = URL_) {
      await pg.goto(url);
      await pg.waitForSelector("button:has-text('New design file')");
      await pg.click("button:has-text('New design file')");
      await pg.waitForSelector("#dt-canvas");
      await sleep(400);
    },
    // The stored file as canonical JSON (either form), or "ERR ...".
    stored: (id) =>
      pg.evaluate(async (id) => {
        const db = await new Promise((r) => {
          const q = indexedDB.open("keyval-store");
          q.onsuccess = () => r(q.result);
        });
        const get = (k) =>
          new Promise((res) => {
            const q = db.transaction("keyval").objectStore("keyval").get(k);
            q.onsuccess = () => res(q.result);
          });
        const sort = (v) => (Array.isArray(v) ? v.map(sort) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v);
        const m = await get("dt:file:" + id);
        db.close();
        if (!m) return "ERR no record";
        if (m.v !== 2) return JSON.stringify(sort(JSON.parse(m.doc)));
        const db2 = await new Promise((r) => {
          const q = indexedDB.open("keyval-store");
          q.onsuccess = () => r(q.result);
        });
        const bodies = [];
        for (const r of Object.keys(m.roots)) {
          const b = await new Promise((res) => {
            const q = db2.transaction("keyval").objectStore("keyval").get(`dt:root:${id}:${r}`);
            q.onsuccess = () => res(q.result);
          });
          if (typeof b !== "string") return "ERR missing root " + r;
          bodies.push(b);
        }
        db2.close();
        return JSON.stringify(sort(JSON.parse(`${m.meta.slice(0, -1)},"nodes":{${bodies.join(",")}}}`)));
      }, id),
    // Opens the file afresh and returns its canonical JSON, or "ERR <screen text>".
    async reopen(url) {
      await pg.goto(url);
      await pg.waitForSelector("#dt-canvas, .empty-hint", { timeout: 60000 });
      await sleep(800);
      return (await pg.locator(".empty-hint").count()) ? "ERR " + (await pg.locator(".empty-hint").innerText()) : R.canon();
    },
  };
  return R;
};
// Runs `fn` on the first manifest write after `arm`.
const armOnManifestPut = (R) =>
  R.pg.evaluate(() => {
    if (window.__hooked) return;
    window.__hooked = true;
    const orig = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (v, k) {
      const r = orig.call(this, v, k);
      if (window.__armFn && String(k).startsWith("dt:file:") && v && v.v === 2) {
        const f = window.__armFn;
        window.__armFn = null;
        queueMicrotask(f);
      }
      return r;
    };
  });
const nodes4 = (heavy = 2) => [frame("A", 0), frame("B", 400), frame("C", 800), { ...frame("H", 1200), children: [...frame("H", 0).children, ...Array.from({ length: Math.max(0, heavy - 2) }, (_, i) => ({ type: "rectangle", name: `H r${i}`, x: (i % 50) * 5, y: 100 + Math.floor(i / 50) * 5, width: 4, height: 4, fill: "#00FF00" }))] }];
const overlapCase = async (name, heavy, arm, step, after) => {
  const R = await rig();
  await R.newFile();
  await R.tool("create_nodes", { nodes: nodes4(heavy) });
  await R.settle();
  const id = await R.fileId();
  await armOnManifestPut(R);
  await R.pg.evaluate(arm);
  await step(R);
  await sleep(3000);
  if (after) await after(R);
  // (Leaving for the files list: what the editor held at that moment.)
  const want = (await R.pg.evaluate(() => window.__expected ?? null)) ?? (await R.canon());
  const stored = await R.stored(id);
  const reopened = await R.reopen(URL_ + "/?r=" + Date.now() + "#/file/" + id);
  check(`${name}: the stored file equals the editor's`, stored === want, stored.startsWith("ERR") ? stored : "differs");
  check(`${name}: it reopens undamaged and equal`, reopened === want, reopened.startsWith("ERR") ? reopened.slice(0, 120) : "differs");
  await R.c.close();
};
const undoAndHide = () => {
  window.__armFn = () => {
    window.__dt.dispatch({ op: "undo" });
    window.dispatchEvent(new Event("pagehide"));
  };
};

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

  // 9. Overlapping writes: undo during a save, two tabs, and a copy made while a save runs.
  {
    await overlapCase(
      "delete C, then undo and pagehide during the write",
      2,
      undoAndHide,
      async (R) => R.dispatch({ op: "delete", ids: [(await R.byName("C")).id] }),
      async (R) => {
        await R.dispatch({ op: "update", ids: [(await R.byName("A")).id], patch: { x: 5 } });
        await R.settle();
      },
    );
    await overlapCase(
      "move B, then undo and pagehide during the write",
      2,
      undoAndHide,
      async (R) => R.dispatch({ op: "update", ids: [(await R.byName("B")).id], patch: { y: 333 } }),
      async (R) => {
        await R.dispatch({ op: "update", ids: [(await R.byName("A")).id], patch: { x: 5 } });
        await R.settle();
      },
    );
    await overlapCase(
      "edit H and delete C, then undo and leave for the files list during the write",
      3000,
      () => {
        window.__armFn = () => {
          window.__dt.dispatch({ op: "undo" });
          const sort = (v) => (Array.isArray(v) ? v.map(sort) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v);
          window.__expected = JSON.stringify(sort(window.__dt.doc()));
          history.replaceState(null, "", location.pathname + "#/");
          dispatchEvent(new HashChangeEvent("hashchange"));
        };
      },
      async (R) => {
        const h = await R.byName("H");
        await R.dispatch({ op: "update", ids: [h.id], patch: { y: 50 } });
        await R.dispatch({ op: "delete", ids: [(await R.byName("C")).id] });
      },
      async (R) => {
        // Back in the file: whatever the editor holds now was saved on the way out.
        await R.pg.waitForSelector("button:has-text('New design file')");
      },
    );
  }
  {
    // Two tabs of one file hide at the same moment, each with its own change.
    for (let rep = 0; rep < 3; rep++) {
      const A = await rig();
      await A.newFile();
      await A.tool("create_nodes", { nodes: nodes4(400) });
      await A.settle();
      const id = await A.fileId();
      const B = await rig(A.c);
      await B.pg.goto(URL_ + "/#/file/" + id);
      await B.pg.waitForSelector("#dt-canvas");
      await sleep(1500);
      const cId = (await A.byName("C")).id;
      const bId = (await B.byName("B")).id;
      await Promise.all([
        A.pg.evaluate((x) => {
          window.__dt.dispatch({ op: "delete", ids: [x] });
          window.dispatchEvent(new Event("pagehide"));
        }, cId),
        B.pg.evaluate((x) => {
          window.__dt.dispatch({ op: "update", ids: [x], patch: { y: 77 } });
          window.dispatchEvent(new Event("pagehide"));
        }, bId),
      ]);
      await sleep(3500);
      const da = await A.canon();
      const db = await B.canon();
      const stored = await A.stored(id);
      const again = await (await rig(A.c)).reopen(URL_ + "/?r=" + Date.now() + "#/file/" + id);
      check(`two tabs hiding together #${rep + 1}: the stored file is one tab's document`, stored === da || stored === db, stored.startsWith("ERR") ? stored : "a mix");
      check(`two tabs hiding together #${rep + 1}: it reopens undamaged`, !again.startsWith("ERR") && (again === da || again === db), again.slice(0, 100));
      await A.c.close();
    }
  }
  {
    // A layer record that is missing doesn't make the file unopenable.
    const R = await rig();
    await R.newFile();
    await R.tool("create_nodes", { nodes: nodes4(2) });
    await R.settle();
    await sleep(500);
    const id = await R.fileId();
    const cId = (await R.byName("C")).id;
    await R.pg.evaluate(
      ([id, cId]) =>
        new Promise((res) => {
          const q = indexedDB.open("keyval-store");
          q.onsuccess = () => {
            const tx = q.result.transaction("keyval", "readwrite");
            tx.objectStore("keyval").delete(`dt:root:${id}:${cId}`);
            tx.oncomplete = () => (q.result.close(), res(null));
          };
        }),
      [id, cId],
    );
    const got = await R.reopen(URL_ + "/?r=" + Date.now() + "#/file/" + id);
    check("a missing layer record: the rest of the file opens", !got.startsWith("ERR") && (await R.byName("A"))?.name === "A" && !(await R.byName("C")));
    check("and the toast names the layer", (await R.pg.locator(".toast").innerText().catch(() => "")).includes("\u201cC\u201d"));
    await R.dispatch({ op: "update", ids: [(await R.byName("A")).id], patch: { x: 9 } });
    await R.settle();
    const healed = await R.reopen(URL_ + "/?r=" + Date.now() + "#/file/" + id);
    check("the next save repairs the file", !healed.startsWith("ERR") && (await R.byName("A")).x === 9);
    await R.c.close();
  }
  {
    // IndexedDB that opens but fails every write (older Safari in a private window): files live in memory.
    const R = await rig();
    await R.pg.addInitScript(() => {
      IDBObjectStore.prototype.put = function () {
        throw new DOMException("no writes here", "QuotaExceededError");
      };
    });
    await R.newFile();
    await R.tool("create_nodes", { nodes: nodes4(2) });
    await sleep(2500);
    const ok = (await R.pg.locator(".empty-hint").count()) === 0 && (await R.byName("B"))?.name === "B";
    check("writes that always fail fall back to memory instead of breaking the editor", ok);
    check("and the label says the browser storage is unavailable", (await R.label()).includes("storage unavailable"), await R.label());
    check("the file stays unsaved, so closing still asks", await R.pg.evaluate(() => window.__dt.dirty()));
    await R.c.close();
  }
  {
    // An edit and a tab hide while the autosave is still gathering a big plan in slices, and the
    // newer write is slow: the older plan must not land after it.
    const R = await rig();
    await R.newFile();
    for (let k = 0; k < 6; k++) await R.tool("create_nodes", { nodes: Array.from({ length: 10 }, (_, i) => frame(`F${k * 10 + i}`, (k * 10 + i) * 400)) });
    await R.settle();
    await sleep(1000);
    const id = await R.fileId();
    await R.pg.evaluate(() => {
      const parse = JSON.parse;
      JSON.parse = function (src, ...rest) {
        const v = parse.call(this, src, ...rest);
        if (window.__armSlice && typeof src === "string" && v && typeof v === "object" && "token" in v && Array.isArray(v.dirty) && !v.full && v.dirty.length > 20) {
          window.__armSlice = false;
          setTimeout(() => {
            const n = Object.values(window.__dt.doc().nodes).find((x) => x.name === "F3");
            window.__dt.dispatch({ op: "update", ids: [n.id], patch: { name: "F3 edited during slicing" } });
            window.dispatchEvent(new Event("pagehide"));
            window.__holdNext = true;
          }, 1);
        }
        return v;
      };
      const orig = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (v, k) {
        const r = orig.call(this, v, k);
        if (window.__holdNext && String(k).startsWith("dt:file:") && v && v.v === 2) {
          window.__holdNext = false;
          // Keep this transaction busy (a slow disk), so it commits after the slicing ends.
          const os = this;
          const until = performance.now() + 1500;
          const spin = () => {
            if (performance.now() < until) os.get("dt:index").onsuccess = spin;
          };
          spin();
        }
        return r;
      };
    });
    const ids = await R.pg.evaluate(() => window.__dt.doc().pages[0].children);
    await R.dispatch({ op: "nudge", ids, dx: 5, dy: 0 });
    await R.pg.evaluate(() => (window.__armSlice = true));
    await sleep(7000);
    await R.dispatch({ op: "update", ids: [(await R.byName("F52")).id], patch: { y: 9 } });
    await R.settle();
    await sleep(800);
    const want = await R.canon();
    const stored = await R.stored(id);
    check("a plan gathered slowly never lands over a newer one", stored === want, stored.startsWith("ERR") ? stored : "differs");
    await R.c.close();
  }
  {
    // The first write of a session fails once (the transaction aborts): it shows as not saved,
    // is retried, and lands in IndexedDB; nothing is kept only in memory.
    const R = await rig();
    await R.newFile();
    await R.tool("create_nodes", { nodes: nodes4(2) });
    await R.settle();
    const id = await R.fileId();
    await R.pg.reload();
    await R.pg.waitForSelector("#dt-canvas");
    await sleep(1000);
    await R.pg.evaluate(() => {
      const orig = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (v, k) {
        const r = orig.call(this, v, k);
        if (window.__failOnce && String(k).startsWith("dt:file:")) {
          window.__failOnce = false;
          this.transaction.abort();
        }
        return r;
      };
      window.__failOnce = true;
    });
    await R.dispatch({ op: "update", ids: [(await R.byName("A")).id], patch: { y: 11 } });
    await sleep(2500);
    const failed = await R.label();
    check("a failed first write shows as not saved, with a retry", failed.includes("Not saved, retrying"), failed);
    await sleep(6500);
    await R.settle();
    check("the retry saves it to IndexedDB", (await R.label()).includes("Saved locally") && (await R.stored(id)) === (await R.canon()), await R.label());
    await R.c.close();
  }
  {
    // A file renamed in the files list while it is open elsewhere keeps the new name when the editor saves.
    const A = await rig();
    await A.newFile();
    await A.tool("create_nodes", { nodes: nodes4(2) });
    await A.dispatch({ op: "setDocName", name: "Before" });
    await A.settle();
    const id = await A.fileId();
    const B = await rig(A.c);
    await B.pg.goto(URL_ + "/#/");
    await B.pg.waitForSelector(".file-card");
    B.pg.removeAllListeners("dialog");
    B.pg.once("dialog", (d) => d.accept("Renamed elsewhere"));
    const card = B.pg.locator(".file-card", { hasText: "Before" });
    await card.hover();
    await card.locator(".ibtn.more").click();
    await B.pg.click(".menu >> text=Rename");
    await sleep(800);
    const names3 = [];
    for (let i = 0; i < 3; i++) {
      await A.dispatch({ op: "update", ids: [(await A.byName("A")).id], patch: { x: 7 + i } });
      await A.settle();
      await sleep(500);
      const st = JSON.parse(await A.stored(id));
      names3.push(st.name);
    }
    check("a rename made elsewhere survives three saves of the open editor", names3.every((n) => n === "Renamed elsewhere"), names3.join(" | "));
    check("and the open editor shows it", (await A.pg.evaluate(() => window.__dt.doc().name)) === "Renamed elsewhere");
    await A.c.close();
  }
  {
    // Leave a file while its save is held in flight and reopen it at once: the old editor's final
    // write lands after the new editor has opened. The tab must stay responsive and the new
    // editor's edit must be stored.
    const R = await rig();
    await R.newFile();
    await R.tool("create_nodes", { nodes: nodes4(2000) });
    await R.settle();
    const id = await R.fileId();
    for (let i = 0; i < 8; i++) {
      await R.dispatch({ op: "update", ids: [(await R.byName("A")).id], patch: { x: i } });
      await R.settle();
    }
    await R.pg.evaluate(() => {
      const orig = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (v, k) {
        const r = orig.call(this, v, k);
        if (window.__holdNext && String(k).startsWith("dt:file:") && v && v.v === 2) {
          window.__holdNext = false;
          window.__held = true;
          const os = this;
          const until = performance.now() + 4000;
          const spin = () => {
            if (performance.now() < until) os.get("dt:index").onsuccess = spin;
          };
          spin();
        }
        return r;
      };
      window.__holdNext = true;
    });
    await R.dispatch({ op: "update", ids: [(await R.byName("H")).id], patch: { y: 30 } });
    await R.pg.waitForFunction(() => window.__held, null, { timeout: 10000 });
    await R.dispatch({ op: "update", ids: [(await R.byName("A")).id], patch: { y: 44 } });
    await R.pg.evaluate(() => (location.hash = "#/"));
    await sleep(400);
    await R.pg.evaluate((id) => (location.hash = "#/file/" + id), id);
    await R.pg.waitForSelector("#dt-canvas");
    await sleep(6000);
    await R.dispatch({ op: "update", ids: [(await R.byName("B")).id], patch: { y: 77 } });
    await sleep(5000);
    const alive = await Promise.race([R.pg.evaluate(() => 1).then(() => true), sleep(5000).then(() => false)]);
    check("reopening a file whose save is still running leaves the tab responsive", alive);
    if (alive) {
      await R.settle();
      check("and the new editor's edit is stored", (await R.stored(id)) === (await R.canon()));
    }
    await R.c.close();
  }
  {
    // The closing editor's save is held longer than the new editor waits for it: it must not land
    // over what the new editor read and wrote.
    const R = await rig();
    await R.newFile();
    await R.tool("create_nodes", { nodes: nodes4(2000) });
    await R.settle();
    const id = await R.fileId();
    await R.pg.evaluate(() => {
      const orig = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (v, k) {
        const r = orig.call(this, v, k);
        if (window.__holdNext && String(k).startsWith("dt:file:") && v && v.v === 2) {
          window.__holdNext = false;
          window.__held = true;
          const os = this;
          const until = performance.now() + 20000;
          const spin = () => {
            if (performance.now() < until) os.get("dt:index").onsuccess = spin;
          };
          spin();
        }
        return r;
      };
      window.__holdNext = true;
    });
    await R.dispatch({ op: "update", ids: [(await R.byName("H")).id], patch: { y: 30 } });
    await R.pg.waitForFunction(() => window.__held, null, { timeout: 10000 });
    await R.dispatch({ op: "update", ids: [(await R.byName("A")).id], patch: { y: 44 } });
    await R.pg.evaluate(() => (location.hash = "#/"));
    await sleep(400);
    await R.pg.evaluate((id) => (location.hash = "#/file/" + id), id);
    await sleep(1500);
    check("while the last save finishes the editor says so", (await R.pg.locator(".empty-hint").innerText().catch(() => "")).includes("Finishing the last save"));
    await R.pg.waitForSelector("#dt-canvas", { timeout: 40000 });
    await sleep(8000);
    await R.dispatch({ op: "update", ids: [(await R.byName("B")).id], patch: { y: 66 } });
    await R.settle();
    await sleep(800);
    check("after the wait ran out, stored equals the new editor's document", (await R.stored(id)) === (await R.canon()));
    await R.c.close();
  }
  if (RELAY) {
    // A guest makes their own copy of a shared file while an autosave lands during the copy's write.
    for (const racy of [false, true]) {
      const O = await rig();
      await O.newFile(RELAY);
      await O.tool("create_nodes", { nodes: [frame("A", 0), frame("B", 400), frame("C", 800)] });
      await O.settle();
      await O.pg.click(".tbtn[title='Share for live editing']");
      await O.pg.fill(".share-dialog input.textinput >> nth=0", "Owner");
      if (await O.pg.locator(".share-dialog input.mono").count()) await O.pg.fill(".share-dialog input.mono", RELAY);
      else if (await O.pg.locator("text=Use a different relay").count()) {
        await O.pg.click("text=Use a different relay");
        await O.pg.fill(".share-dialog input.mono", RELAY);
      }
      await O.pg.click("button:has-text('Share online')");
      await O.pg.waitForFunction(() => window.__dt.collab().status === "live", null, { timeout: 10000 });
      const link = await O.pg.evaluate(() => window.__dt.collab().link);
      const G = await rig();
      await G.pg.goto(link);
      await G.pg.waitForFunction(() => window.__dt?.collab?.().status === "live", null, { timeout: 15000 });
      await sleep(1500);
      await G.dispatch({ op: "update", ids: [(await G.byName("A")).id], patch: { y: 40 } });
      await G.settle();
      if (racy)
        await G.pg.evaluate(() => {
          const orig = IDBObjectStore.prototype.put;
          IDBObjectStore.prototype.put = function (v, k) {
            const r = orig.call(this, v, k);
            if (!window.__fired && String(k).startsWith("dt:file:") && v && typeof v.doc === "string") {
              window.__fired = true;
              queueMicrotask(() => {
                const n = Object.values(window.__dt.doc().nodes).find((x) => x.name === "B");
                window.__dt.dispatch({ op: "update", ids: [n.id], patch: { y: 66 } });
                window.dispatchEvent(new Event("pagehide"));
              });
            }
            return r;
          };
        });
      await G.pg.click("button:has-text('Skip')", { timeout: 3000 }).catch(() => {});
      await G.pg.click("button:has-text('Make my own copy')");
      await sleep(2500);
      await G.dispatch({ op: "update", ids: [(await G.byName("C")).id], patch: { y: 77 } });
      await G.settle();
      await sleep(500);
      const want = await G.canon();
      const id2 = await G.fileId();
      const stored = await G.stored(id2);
      const got = await G.reopen(G.pg.url());
      const tag = `copy of a shared file${racy ? " with an autosave during its write" : ""}`;
      check(`${tag}: stored equal`, stored === want, stored.startsWith("ERR") ? stored : "differs");
      check(`${tag}: reopens undamaged and equal`, got === want, got.slice(0, 100));
      await O.c.close();
      await G.c.close();
    }
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
