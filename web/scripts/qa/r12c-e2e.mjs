// R12-C: auto layout, snapping, group size and code export fidelity.
//   Q-B1 reorder by row in a wrapping auto layout; the insertion line while a layer enters auto layout;
//   Q-B2 wrapped rows as a block (canvas and exported code agree); Q-B3 headings keep weight 400;
//   Q-B4 square layout grids snap across the whole frame; Q-B5 typing a group's W scales its layers;
//   O6 mixed-size text keeps its line height in code; constraints become responsive CSS (right,
//   left+right, centre, scale) checked at 320, 375 and 430 px, in the HTML and the React export.
// Usage: start `npm run dev`, then `E2E_URL=http://localhost:<port> node scripts/qa/r12c-e2e.mjs`.
// Env: E2E_URL (default http://localhost:5173), CHROMIUM (executable path), SHOTS (folder for screenshots),
//      E2E_DEPS (a folder with node_modules for the exported project; without it the React steps are
//      skipped), E2E_STATIC_PORT (static server for the exports, default 5645).

import { chromium } from "playwright-core";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const URL = process.env.E2E_URL ?? "http://localhost:5173";
const STATIC_PORT = Number(process.env.E2E_STATIC_PORT ?? 5645);
const SHOTS = process.env.SHOTS;
const launch = { headless: true, args: ["--no-sandbox"] };
if (process.env.CHROMIUM) launch.executablePath = process.env.CHROMIUM;
else if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";

let failed = 0;
function check(name, ok, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + String(detail).slice(0, 400) : ""}`);
}

const browser = await chromium.launch(launch);
const newContext = async (opts = {}) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, ...opts });
  // Nothing may leave this machine.
  await context.route(
    (u) => !/^(127\.0\.0\.1|localhost)$/.test(new globalThis.URL(u).hostname) && !/^(data|blob):/.test(u.toString()),
    (r) => r.abort(),
  );
  await context.addInitScript(() => {
    try {
      localStorage.setItem("dt:tour-done", "1");
    } catch {
      /* no storage */
    }
  });
  return context;
};
const errors = [];
const shot = async (page, name) => {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};

// ---- Fixtures (built through the engine; the interactions under test use the mouse) ----
const fill = (c = "#DDE4FF") => [{ type: "solid", color: c, visible: true, opacity: 1 }];
const lay = (direction, over = {}) => ({ direction, gap: 8, paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0, primaryAlign: "start", counterAlign: "start", wrap: false, counterGap: 0, ...over });
const HL = (over) => lay("horizontal", over);
const VL = (over) => lay("vertical", over);
const pad = (n) => ({ paddingTop: n, paddingRight: n, paddingBottom: n, paddingLeft: n });

async function mk(page, parent, spec) {
  const id = await page.evaluate(
    ([parent, spec]) => {
      const dt = window.__dt;
      const before = new Set(Object.keys(dt.doc().nodes));
      if (spec.kind === "text") dt.dispatch({ op: "createText", x: spec.x || 0, y: spec.y || 0, characters: spec.text || "Text", parent });
      else dt.dispatch({ op: "createShape", kind: spec.kind, x: spec.x || 0, y: spec.y || 0, width: spec.width || 100, height: spec.height || 100, parent });
      return Object.keys(dt.doc().nodes).find((k) => !before.has(k));
    },
    [parent, spec],
  );
  const patch = { name: spec.name || spec.kind, ...(spec.patch || {}) };
  for (const k of ["layout", "sizingH", "sizingV", "constraints", "fills", "x", "y"]) if (spec[k] != null) patch[k] = spec[k];
  if (spec.kind !== "text") for (const k of ["width", "height"]) if (spec[k] != null) patch[k] = spec[k];
  if (spec.absolutePosition) patch.absolutePosition = true;
  await page.evaluate(([id, patch]) => window.__dt.dispatch({ op: "update", ids: [id], patch }), [id, patch]);
  for (const c of spec.children || []) await mk(page, id, c);
  return id;
}

const R = (w, name) => ({ kind: "rectangle", name, width: w, height: 30, sizingH: "fixed", sizingV: "fixed", fills: fill() });
const doc = (page) => page.evaluate(() => window.__dt.doc());
const kids = (page, id) => page.evaluate((i) => window.__dt.doc().nodes[i].children, id);
const nameOf = (d, id) => d.nodes[id].name;
async function fresh() {
  const context = await newContext();
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(URL);
  await page.waitForSelector("#dt-canvas, .files", { timeout: 30000 });
  if (!(await page.$("#dt-canvas"))) await page.locator('button:has-text("New design file")').first().click();
  await page.waitForSelector("#dt-canvas");
  await page.waitForFunction(() => window.__dt?.doc);
  await page.waitForTimeout(500);
  return { context, page };
}
const box = (page, id) => page.locator(`#dt-canvas [data-id="${id}"]`).first().boundingBox();
const fit = async (page) => {
  await page.evaluate(() => window.__dt.zoomToFit());
  await page.waitForTimeout(300);
};

// Static server for exported pages and the built project.
let root = fs.mkdtempSync(path.join(os.tmpdir(), "r12c-static-"));
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent((req.url ?? "/").split(/[?#]/)[0]);
  let f = path.join(root, pathname);
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(root, "index.html");
  const type = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" }[path.extname(f)] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": type });
  res.end(fs.existsSync(f) ? fs.readFileSync(f) : "");
});
await new Promise((resolve) => server.listen(STATIC_PORT, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${STATIC_PORT}/`;
const serveHtml = (name, html) => {
  fs.writeFileSync(path.join(root, name), String(html));
  return base + name;
};

try {
  const { context, page } = await fresh();

  // ---- Q-B1: reorder inside a wrapping auto layout by row ----
  for (const [label, dropIdx, want] of [
    ["T1 onto T6 (row two, second tile)", 5, "T2,T3,T4,T5,T1,T6"],
    ["T1 onto T5 (row two, first tile)", 4, "T2,T3,T4,T1,T5,T6"],
  ]) {
    const f = await fresh();
    const grid = await mk(f.page, null, {
      kind: "frame", name: "Tiles", x: 100, y: 100, width: 300, height: 200, fills: fill("#FFFFFF"), sizingH: "fixed", sizingV: "hug",
      layout: HL({ wrap: true, gap: 10, counterGap: 10, ...pad(10) }),
      children: [1, 2, 3, 4, 5, 6].map((i) => ({ kind: "rectangle", name: "T" + i, width: 60, height: 40, sizingH: "fixed", sizingV: "fixed", fills: fill() })),
    });
    await fit(f.page);
    const ids = await kids(f.page, grid);
    const b1 = await box(f.page, ids[0]);
    const bt = await box(f.page, ids[dropIdx]);
    await f.page.mouse.move(b1.x + b1.width / 2, b1.y + b1.height / 2);
    await f.page.mouse.down();
    await f.page.mouse.move(b1.x + b1.width / 2 + 10, b1.y + b1.height / 2 + 5, { steps: 3 });
    await f.page.mouse.move(bt.x + bt.width / 2, bt.y + bt.height / 2, { steps: 14 });
    await f.page.mouse.up();
    await f.page.waitForTimeout(300);
    const d = await doc(f.page);
    const got = d.nodes[grid].children.map((c) => nameOf(d, c)).join(",");
    check(`Q-B1 wrap reorder, ${label}`, got === want, `${got} (want ${want})`);
    if (dropIdx === 5) await shot(f.page, "r12c-b1-wrap-reorder");
    await f.context.close();
  }

  // ---- The insertion line while a layer enters an auto layout frame ----
  {
    const f = await fresh();
    const stack = await mk(f.page, null, {
      kind: "frame", name: "Stack", x: 100, y: 100, width: 200, height: 200, fills: fill("#FFFFFF"), sizingH: "fixed", sizingV: "hug",
      layout: VL({ gap: 10, ...pad(10) }),
      children: ["A", "B", "C"].map((n) => ({ kind: "rectangle", name: n, width: 160, height: 40, sizingH: "fixed", sizingV: "fixed", fills: fill() })),
    });
    const free = await mk(f.page, null, { kind: "rectangle", name: "Free", x: 500, y: 120, width: 50, height: 30, fills: fill("#FFB4B4") });
    await fit(f.page);
    const [a, b, c] = await kids(f.page, stack);
    const [bb, bc, bf] = [await box(f.page, b), await box(f.page, c), await box(f.page, free)];
    await f.page.mouse.move(bf.x + bf.width / 2, bf.y + bf.height / 2);
    await f.page.mouse.down();
    await f.page.mouse.move(bf.x - 20, bf.y + 10, { steps: 4 });
    // Pointer between B and C.
    const gapY = (bb.y + bb.height + bc.y) / 2;
    await f.page.mouse.move(bb.x + bb.width / 2, gapY, { steps: 12 });
    await f.page.waitForTimeout(150);
    const line = f.page.locator(".flow-drop-line");
    const shown = await line.count();
    check("insertion line is drawn while a layer is over an auto layout frame", shown === 1, `${shown} lines`);
    if (shown) {
      const lb = await line.boundingBox();
      check("the line is horizontal, between B and C, and spans the stack's inner width", lb.height <= 4 && lb.y + lb.height / 2 > bb.y + bb.height - 1 && lb.y + lb.height / 2 < bc.y + 1 && lb.width > bb.width * 0.9, JSON.stringify(lb));
      await shot(f.page, "r12c-drop-line");
    }
    await f.page.mouse.up();
    await f.page.waitForTimeout(250);
    const d = await doc(f.page);
    check("the layer lands at the line's index (between B and C)", d.nodes[stack].children.map((i) => nameOf(d, i)).join(",") === "A,B,Free,C", d.nodes[stack].children.map((i) => nameOf(d, i)).join(","));
    check("the line is gone after the drop", (await f.page.locator(".flow-drop-line").count()) === 0);
    // Reordering inside the same frame has no line (the layers reflow live instead).
    const [x0, x1] = [await box(f.page, a), await box(f.page, c)];
    await f.page.mouse.move(x0.x + 20, x0.y + 10);
    await f.page.mouse.down();
    await f.page.mouse.move(x0.x + 20, x0.y + 30, { steps: 3 });
    await f.page.mouse.move(x1.x + 20, x1.y + 10, { steps: 8 });
    check("no insertion line for a reorder inside the same frame", (await f.page.locator(".flow-drop-line").count()) === 0);
    await f.page.mouse.up();
    await f.context.close();
  }

  // ---- Q-B4: square layout grid snapping far from the origin ----
  for (const [label, W, size, x] of [
    ["2px grid, 1440 frame, box near 900", 1440, 2, 900.3],
    ["4px grid, 2400 frame, box near 1900", 2400, 4, 1902.9],
  ]) {
    const f = await fresh();
    const fr = await mk(f.page, null, {
      kind: "frame", name: "Grid frame", x: 0, y: 0, width: W, height: 900, fills: fill("#FFFFFF"), sizingH: "fixed", sizingV: "fixed",
      children: [{ kind: "rectangle", name: "Box", x, y: 100, width: 8, height: 8, fills: fill("#FF9999") }],
    });
    await f.page.evaluate(([fr, size]) => window.__dt.dispatch({ op: "update", ids: [fr], patch: { layoutGrids: [{ pattern: "grid", count: 1, gutter: 0, margin: 0, size, alignment: "stretch", color: "#FF0000FF", visible: true }] } }), [fr, size]);
    const id = (await doc(f.page)).nodes[fr].children[0];
    // Engine drag.
    const r = await f.page.evaluate((id) => {
      window.__dt.dispatch({ op: "select", ids: [id] });
      window.__dt.dispatch({ op: "beginGesture" });
      const o = window.__dt.dispatch({ op: "translate", ids: [id], dx: 1.6, dy: 0, snap: true, zoom: 0.5 });
      window.__dt.dispatch({ op: "cancelGesture" });
      return o;
    }, id);
    check(`Q-B4 ${label}: the drag snaps to a grid line`, r.guides.some((g) => g.x1 === g.x2), JSON.stringify(r.guides));
    // And with the mouse.
    await f.page.evaluate((id) => window.__dt.dispatch({ op: "select", ids: [id] }), id);
    await f.page.keyboard.press("Shift+2");
    await f.page.waitForTimeout(300);
    const b = await box(f.page, id);
    await f.page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await f.page.mouse.down();
    await f.page.mouse.move(b.x + b.width / 2 + 10, b.y + b.height / 2, { steps: 4 });
    await f.page.mouse.up();
    await f.page.waitForTimeout(200);
    const nx = (await doc(f.page)).nodes[id].x;
    check(`Q-B4 ${label}: after a mouse drag the box sits on the grid (x = ${nx})`, Math.abs(nx / size - Math.round(nx / size)) < 1e-6 || Math.abs((nx + 8) / size - Math.round((nx + 8) / size)) < 1e-6, nx);
    await f.context.close();
  }

  // ---- Q-B5: a group's W field scales its layers ----
  {
    const f = await fresh();
    const sc = await mk(f.page, null, {
      kind: "frame", name: "Screen", x: 0, y: 0, width: 375, height: 300, fills: fill("#FFFFFF"), sizingH: "fixed", sizingV: "fixed",
      children: [
        { kind: "rectangle", name: "Left", x: 20, y: 20, width: 100, height: 40, fills: fill() },
        { kind: "rectangle", name: "Right", x: 200, y: 60, width: 60, height: 40, fills: fill() },
      ],
    });
    const cs = await kids(f.page, sc);
    await f.page.evaluate((ids) => window.__dt.dispatch({ op: "select", ids }), cs);
    await f.page.keyboard.press("Control+g");
    await f.page.waitForTimeout(250);
    const gid = await f.page.evaluate(() => window.__dt.state().selection[0]);
    const before = (await doc(f.page)).nodes[gid].width;
    const w = f.page.getByLabel("Width", { exact: true }).first();
    await w.fill("400");
    await w.press("Enter");
    await f.page.waitForTimeout(250);
    const d = await doc(f.page);
    const [l, r] = cs.map((c) => d.nodes[c]);
    check(`Q-B5 group W field ${before} -> 400 keeps 400`, Math.abs(d.nodes[gid].width - 400) < 0.01, d.nodes[gid].width);
    const k = 400 / before;
    check("the layers inside are scaled with it", Math.abs(l.width - 100 * k) < 0.1 && Math.abs(r.width - 60 * k) < 0.1, `${l.width.toFixed(1)} ${r.width.toFixed(1)}`);
    await fit(f.page);
    await shot(f.page, "r12c-b5-group-width");
    await f.page.keyboard.press("Control+z");
    await f.page.waitForTimeout(200);
    const u = await doc(f.page);
    check("undo restores the group and its layers", Math.abs(u.nodes[gid].width - before) < 0.01 && Math.abs(u.nodes[cs[0]].width - 100) < 0.01, `${u.nodes[gid].width} ${u.nodes[cs[0]].width}`);
    await f.context.close();
  }

  // ---- Q-B2, Q-B3, O6: exported HTML against the canvas ----
  const flat = (d, id, out = []) => {
    const n = d.nodes[id];
    out.push(n);
    for (const c of n.children || []) flat(d, c, out);
    return out;
  };
  const ex = await newContext({ viewport: { width: 1200, height: 1000 } });
  {
    const f = await fresh();
    const mkWrap = (name, x, align) =>
      mk(f.page, null, {
        kind: "frame", name, x, y: 0, width: 300, height: 200, fills: fill("#FFFFFF"), sizingH: "fixed", sizingV: "fixed",
        layout: HL({ wrap: true, gap: 8, counterGap: 12, paddingTop: 4, paddingRight: 20, paddingBottom: 6, paddingLeft: 14, counterAlign: align }),
        children: [80, 120, 60, 140, 90, 70].map((w, i) => R(w, "c" + i)),
      });
    const frames = { Start: await mkWrap("Start", 0, "start"), Center: await mkWrap("Center", 400, "center"), End: await mkWrap("End", 800, "end") };
    await f.page.waitForTimeout(200);
    const d = await doc(f.page);
    const ys = (n) => d.nodes[frames[n]].children.map((c) => d.nodes[c].y);
    check("canvas: Start packs the rows at the top, Center and End move the block", ys("Start")[0] === 4 && ys("Center")[0] > 40 && ys("End")[0] > ys("Center")[0], `${ys("Start")[0]} ${ys("Center")[0]} ${ys("End")[0]}`);
    for (const name of Object.keys(frames)) {
      const html = await f.page.evaluate((id) => window.__dt.query({ q: "exportHtml", id }), frames[name]);
      const p = await ex.newPage();
      await p.goto(serveHtml(`wrap-${name}.html`, html));
      const dom = await p.evaluate(() => {
        const rootEl = document.querySelector("main > div");
        return [rootEl, ...rootEl.querySelectorAll("*")].map((el) => {
          const b = el.getBoundingClientRect();
          return { x: b.x, y: b.y, w: b.width, h: b.height };
        });
      });
      const nodes = flat(d, frames[name]);
      const bad = [];
      nodes.forEach((en, i) => {
        if (i === 0) return;
        const pd = dom[0];
        const dy = dom[i].y - pd.y;
        const dx = dom[i].x - pd.x;
        if (Math.abs(dx - en.x) > 1.5 || Math.abs(dy - en.y) > 1.5) bad.push(`${en.name} eng ${en.x},${en.y} dom ${dx.toFixed(1)},${dy.toFixed(1)}`);
      });
      check(`Q-B2 exported HTML rows match the canvas (${name}, within 1.5 px)`, bad.length === 0 && nodes.length === dom.length, bad.join("; ") || `${nodes.length}/${dom.length}`);
      if (name === "Center") await p.screenshot({ path: SHOTS ? path.join(SHOTS, "r12c-wrap-center-export.png") : undefined });
      await p.close();
    }
    const react = await f.page.evaluate((id) => window.__dt.query({ q: "exportReact", id }), frames.Center);
    check("React export of the Center wrap has content-center", /content-center/.test(String(react)), "");

    // Q-B3 headings and O6 mixed sizes.
    const head = await mk(f.page, null, {
      kind: "frame", name: "Head", x: 0, y: 400, width: 600, height: 300, fills: fill("#FFFFFF"), sizingH: "fixed", sizingV: "fixed", layout: VL({ gap: 8, ...pad(16) }),
      children: [
        { kind: "text", name: "H28", text: "Overview", patch: { text: { fontSize: 28, fontWeight: 400, autoResize: "width" } } },
        { kind: "text", name: "H36", text: "Regular 36", patch: { text: { fontSize: 36, fontWeight: 400, autoResize: "width" } } },
        { kind: "text", name: "Bold", text: "Bold 28", patch: { text: { fontSize: 28, fontWeight: 700, autoResize: "width" } } },
      ],
    });
    await f.page.evaluate(() =>
      window.__dt.tool("create_nodes", {
        nodes: [
          {
            type: "text", name: "Mix2", text: "Big word and small", x: 700, y: 400,
            spans: [{ text: "Big " }, { text: "word", fontSize: 40 }, { text: " and small" }],
          },
        ],
      }),
    );
    await f.page.waitForTimeout(300);
    const d2 = await doc(f.page);
    const html = await f.page.evaluate((id) => window.__dt.query({ q: "exportHtml", id }), head);
    const p = await ex.newPage();
    await p.goto(serveHtml("head.html", html));
    const w = await p.evaluate(() => [...document.querySelectorAll("h1,h2,h3,p")].map((e) => `${e.tagName}:${getComputedStyle(e).fontWeight}`));
    check("Q-B3 headings with weight 400 compute to 400 (bold stays 700)", w.join(",") === "H1:400,H2:400,H2:700" || w.join(",") === "H2:400,H1:400,H2:700" || (w[0].endsWith(":400") && w[1].endsWith(":400") && w[2].endsWith(":700")), w.join(","));
    await p.close();
    const mix = Object.values(d2.nodes).find((n) => n.name === "Mix2");
    const mixHtml = await f.page.evaluate((id) => window.__dt.query({ q: "exportHtml", id }), mix.id);
    const pm = await ex.newPage({ viewport: { width: 500, height: 200 } });
    await pm.goto(serveHtml("mix.html", mixHtml));
    const ph = await pm.evaluate(() => document.querySelector("p").getBoundingClientRect().height);
    check(`O6 mixed-size text: exported <p> height ${ph.toFixed(1)} is within 1 px of the canvas ${mix.height}`, Math.abs(ph - mix.height) <= 1, "");
    await shot(pm, "r12c-o6-mixed-export");
    await pm.close();
    await f.context.close();
  }

  // ---- Constraints -> responsive CSS, at 320, 375 and 430 ----
  const C = (h, v) => ({ horizontal: h, vertical: v });
  const phoneSpec = {
    kind: "frame", name: "Phone", x: 0, y: 0, width: 375, height: 812, fills: fill("#FFFFFF"), sizingH: "fixed", sizingV: "fixed",
    children: [
      { kind: "rectangle", name: "Menu", x: 16, y: 16, width: 40, height: 40, constraints: C("left", "top"), fills: fill() },
      { kind: "rectangle", name: "Avatar", x: 319, y: 16, width: 40, height: 40, constraints: C("right", "top"), fills: fill("#FF9999") },
      { kind: "rectangle", name: "Search", x: 16, y: 80, width: 343, height: 44, constraints: C("leftRight", "top"), fills: fill() },
      { kind: "rectangle", name: "Bottom bar", x: 0, y: 752, width: 375, height: 60, constraints: C("leftRight", "bottom"), fills: fill("#222222") },
      { kind: "rectangle", name: "Pill", x: 147.5, y: 150, width: 80, height: 30, constraints: C("center", "top"), fills: fill("#99CCFF") },
      { kind: "rectangle", name: "Scaled", x: 37.5, y: 200, width: 75, height: 20, constraints: C("scale", "top"), fills: fill("#99FF99") },
    ],
  };
  const measure = (selector) => {
  const rootEl = document.querySelector(selector);
  const rb = rootEl.getBoundingClientRect();
  return {
    scrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
    root: { x: rb.x, y: rb.y, w: rb.width, h: rb.height },
    kids: [...rootEl.children].map((el) => {
      const b = el.getBoundingClientRect();
      return { x: b.x - rb.x, y: b.y - rb.y, r: rb.right - b.right, b: rb.bottom - b.bottom, w: b.width, h: b.height };
    }),
  };
};
const verify = (label, m, vw) => {
    const W = Math.min(vw, 375);
    const [menu, avatar, search, bar, pill, scaled] = m.kids;
    const near = (a, b) => Math.abs(a - b) <= 1;
    check(`${label} @${vw}: no horizontal scroll`, m.scrollW <= m.innerW, `${m.scrollW} > ${m.innerW}`);
    check(`${label} @${vw}: the screen is ${W} wide`, near(m.root.w, W), m.root.w);
    check(`${label} @${vw}: the avatar stays 16 px from the right edge (40 wide)`, near(avatar.r, 16) && near(avatar.w, 40), JSON.stringify(avatar));
    check(`${label} @${vw}: the menu stays 16 px from the left edge`, near(menu.x, 16), JSON.stringify(menu));
    check(`${label} @${vw}: the search field is ${W - 32} wide with 16 px margins`, near(search.x, 16) && near(search.r, 16) && near(search.w, W - 32), JSON.stringify(search));
    check(`${label} @${vw}: the bottom bar spans the screen and sits on its bottom`, near(bar.w, W) && near(bar.x, 0) && near(bar.b, 0), JSON.stringify(bar));
    check(`${label} @${vw}: the centred pill keeps the screen's centre`, near(pill.x + pill.w / 2, W / 2), JSON.stringify(pill));
    check(`${label} @${vw}: the scaled box keeps 10% / 20%`, near(scaled.x, W * 0.1) && near(scaled.w, W * 0.2), JSON.stringify(scaled));
  };
  {
    const f = await fresh();
    const phone = await mk(f.page, null, phoneSpec);
    await f.page.waitForTimeout(200);
    const html = await f.page.evaluate((id) => window.__dt.query({ q: "exportHtml", id }), phone);
    const url = serveHtml("phone.html", html);
    check("exported HTML has right/bottom pins and no fixed width on the left+right layers", /right:\s*16px/.test(html) && /bottom:\s*0/.test(html) && /calc\(50%/.test(html) && /left:\s*10%/.test(html), "");
    const rootPage = await ex.newPage({ viewport: { width: 375, height: 900 } });
    await rootPage.goto(url);
    for (const vw of [320, 375, 430]) {
      await rootPage.setViewportSize({ width: vw, height: 900 });
      await rootPage.waitForTimeout(150);
      const m = await rootPage.evaluate(measure, "main > div");
      verify("HTML", m, vw);
      if (vw === 320) await rootPage.screenshot({ path: SHOTS ? path.join(SHOTS, "r12c-phone-html-320.png") : undefined });
    }
    await rootPage.close();

    // ---- The React project, built offline ----
    const deps = process.env.E2E_DEPS;
    if (!deps) {
      console.log("SKIP  React project steps (set E2E_DEPS)");
    } else {
      const built = await f.page.evaluate(async () => {
        const e = await import("/src/exporter.ts");
        return e.projectFiles();
      });
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r12c-project-"));
      for (const file of built.files) {
        fs.mkdirSync(path.dirname(path.join(dir, file.path)), { recursive: true });
        fs.writeFileSync(path.join(dir, file.path), file.content);
      }
      fs.symlinkSync(path.join(deps, "node_modules"), path.join(dir, "node_modules"));
      let ok = true;
      let out = "";
      for (const [bin, args] of [["tsc", ["-b"]], ["vite", ["build"]]]) {
        try {
          out = execFileSync(path.join(dir, "node_modules/.bin", bin), args, { cwd: dir, encoding: "utf8", stdio: "pipe" });
        } catch (e) {
          ok = false;
          out = String(e.stdout ?? "") + String(e.stderr ?? "");
          break;
        }
      }
      check("the exported project passes tsc and vite build", ok, ok ? dir : out.slice(0, 800));
      if (ok) {
        const readme = built.files.find((x) => x.path === "README.md")?.content ?? "";
        check("the README says fixed-size layers keep their design width", /Fixed-size layers/.test(readme), "");
        const oldRoot = root;
        root = path.join(dir, "dist");
        try {
          const rp = await ex.newPage({ viewport: { width: 375, height: 900 } });
          rp.on("pageerror", (e) => errors.push(String(e)));
          await rp.goto(base + "#Phone");
          await rp.waitForSelector('[class*="max-w-[375px]"]');
          await rp.waitForTimeout(300);
          for (const vw of [320, 375, 430]) {
            await rp.setViewportSize({ width: vw, height: 900 });
            await rp.waitForTimeout(200);
            const m = await rp.evaluate(measure, '[class*="max-w-[375px]"]');
            verify("React", m, vw);
          }
          await rp.close();
        } finally {
          root = oldRoot;
        }
      }
    }
    await f.context.close();
  }
  await ex.close();
  await context.close();
} finally {
  server.close();
  await browser.close();
}

check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
