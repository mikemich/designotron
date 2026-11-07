// Round 18d, vector and pen: SVG fill + stroke as one layer through export and import, Enter enters
// vector edit, Alt breaks pen handles, "None" caps draw flat with separate start and end caps, no
// stroke position on open paths, point snapping to anchors and whole pixels, the K tool's "Scale
// strokes" option, and split / join of paths.
// Usage: E2E_URL=http://127.0.0.1:7031 [E2E_OUT=dir] node scripts/qa/r18d-e2e.mjs (vite preview running)
// Only local servers are touched: every other request is aborted.

import { chromium } from "playwright-core";
import fs from "node:fs";

const URL = process.env.E2E_URL ?? "http://127.0.0.1:7031";
const OUT = process.env.E2E_OUT ?? "test-results";
fs.mkdirSync(OUT, { recursive: true });
const launch = { headless: true, args: ["--no-sandbox"] };
if (process.env.CHROMIUM) launch.executablePath = process.env.CHROMIUM;
else if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
}

const browser = await chromium.launch(launch);
const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 2, acceptDownloads: true });
const page = await context.newPage();
await page.route("**/*", (r) => (/^(http:\/\/(localhost|127\.0\.0\.1)|data:|blob:|ws:)/.test(r.request().url()) ? r.continue() : r.abort()));
await page.addInitScript(() => {
  try {
    localStorage.setItem("dt:tour-done", "1");
  } catch {
    /* no storage */
  }
});
let pageErrors = 0;
page.on("pageerror", (e) => {
  pageErrors++;
  check("no page errors", false, String(e));
});

const dt = (fn, arg) => page.evaluate(fn, arg);
const run = (cmd) => dt((c) => window.__dt.dispatch(c), cmd);
const doc = () => dt(() => window.__dt.doc());
const state = () => dt(() => window.__dt.state());
const shot = (n, clip) => page.screenshot({ path: `${OUT}/r18d-${n}.png`, ...(clip ? { clip } : {}) });
const byName = async (name) => Object.values((await doc()).nodes).find((n) => n.name === name);
const exportSvg = (id) => dt((i) => window.__dt.query({ q: "exportSvg", id: i }), id);
const edit = () => dt(() => window.__dt.vectorEdit());
let cb = null;

async function newFile() {
  await page.goto(URL);
  await page.click("button:has-text('New design file')");
  await page.waitForSelector("#dt-canvas");
  await page.waitForTimeout(300);
  await dt(() => window.__dt.setViewport({ zoom: 1, x: 0, y: 0 }));
  cb = await page.locator("#dt-canvas").boundingBox();
}
const create = async (nodes) => {
  await dt((n) => window.__dt.tool("create_nodes", { nodes: n }), nodes);
  await page.waitForTimeout(400);
};
/** A screen point (page coordinates) inside the canvas. */
const S = async (x, y) => {
  const v = await dt(() => window.__dt.viewport());
  return [cb.x + x * v.zoom + v.x, cb.y + y * v.zoom + v.y];
};
const vecPts = (n) => n.vector.subpaths.map((sp) => sp.points.map((p) => ({ x: p.x + n.x, y: p.y + n.y })));
const mkVector = async (points, closed) => {
  const r = await run({ op: "createVector", points: points.map(([x, y]) => ({ x, y, inX: 0, inY: 0, outX: 0, outY: 0 })), closed, parent: null });
  await page.waitForTimeout(150);
  return r.id;
};
const anchorXY = async (sub, idx) => {
  const b = await page.locator(`[data-vpt="${sub}:${idx}:anchor"]`).boundingBox();
  return [b.x + b.width / 2, b.y + b.height / 2];
};

// ---------- 1. SVG: fill and stroke stay one layer ----------
await newFile();
{
  await create([{ type: "rectangle", name: "Badge", x: 40, y: 40, width: 120, height: 60, fill: "#3366FF", stroke: "#112233", strokeWidth: 3, cornerRadius: 6 }]);
  const badge = await byName("Badge");
  await run({ op: "update", ids: [badge.id], patch: { strokeAlign: "center" } });
  const svg = await exportSvg(badge.id);
  fs.writeFileSync(`${OUT}/r18d-badge.svg`, svg);
  const els = (svg.match(/<(rect|path|ellipse)\b/g) ?? []).length;
  check("svg export: a centre stroke and one fill are one element", els === 1 && /fill="#3366FF"/i.test(svg) && /stroke="#112233"/i.test(svg), `${els} elements`);
  // The same file pasted back (as text, on the document itself: no Element target).
  await dt((t) => {
    const d = new DataTransfer();
    d.setData("text/plain", t);
    document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: d, bubbles: true, cancelable: true }));
  }, svg);
  await page.waitForTimeout(700);
  const all = Object.values((await doc()).nodes);
  const frame = all.find((n) => n.name === "SVG");
  const kids = frame ? frame.children.map((c) => (all.find((n) => n.id === c))) : [];
  check("svg paste: a frame holding one layer", !!frame && kids.length === 1, `${kids.length} children`);
  check("svg paste: that layer has the fill and the stroke", kids[0] && kids[0].fills.length === 1 && kids[0].strokes.length === 1 && kids[0].strokeWeight === 3, kids[0] ? `${kids[0].fills.length} fills, ${kids[0].strokes.length} strokes, weight ${kids[0].strokeWeight}` : "none");
  check("svg paste: a document-targeted paste threw nothing", pageErrors === 0);
  // An old export with the fill and the stroke as two elements merges on import too.
  const old = '<svg xmlns="http://www.w3.org/2000/svg" width="42" height="22" viewBox="0 0 42 22" fill="none"><g transform="matrix(1 0 0 1 1 1)"><rect width="40" height="20" fill="#3366FF"/><rect width="40" height="20" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" fill="none" stroke="#000000"/></g></svg>';
  await dt((t) => {
    const d = new DataTransfer();
    d.setData("text/plain", t);
    document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: d, bubbles: true, cancelable: true }));
  }, old);
  await page.waitForTimeout(700);
  const all2 = Object.values((await doc()).nodes);
  const frames = all2.filter((n) => n.name === "SVG");
  const f2 = frames[frames.length - 1];
  const k2 = f2.children.map((c) => all2.find((n) => n.id === c));
  check("svg paste (old export): the two elements are one layer", k2.length === 1 && k2[0].fills.length === 1 && k2[0].strokes.length === 1 && k2[0].type !== "group", `${k2.length} children`);
  // Inside strokes still export as two elements.
  await run({ op: "update", ids: [badge.id], patch: { strokeAlign: "inside" } });
  const inside = await exportSvg(badge.id);
  check("svg export: an inside stroke stays two elements", (inside.match(/<(rect|path|ellipse)\b/g) ?? []).length === 2);
}

// ---------- 2. Enter enters vector edit ----------
await newFile();
{
  const id = await mkVector([[100, 100], [200, 160], [300, 100]], false);
  await run({ op: "select", ids: [id] });
  await page.waitForTimeout(150);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  check("enter: a selected vector enters vector edit", (await edit()).id === id);
  check("enter: its anchors are shown", (await page.locator('[data-vpt$=":anchor"]').count()) === 3);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  check("enter: Enter again leaves vector edit", (await edit()).id === null);
  await run({ op: "select", ids: [id] });
  await create([{ type: "rectangle", name: "Box", x: 400, y: 300, width: 50, height: 50 }]);
  const box = await byName("Box");
  await run({ op: "select", ids: [box.id] });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  check("enter: a rectangle is left as it is", (await edit()).id === null && (await byName("Box")).type === "rectangle");
}

// ---------- 3. Alt breaks the pen handles ----------
await newFile();
{
  await page.keyboard.press("Escape");
  await page.keyboard.press("p");
  await page.mouse.click(...(await S(100, 300)));
  await page.mouse.move(...(await S(300, 300)));
  await page.mouse.down();
  await page.mouse.move(...(await S(310, 300)), { steps: 3 });
  await page.keyboard.down("Alt");
  await page.mouse.move(...(await S(340, 330)), { steps: 4 });
  await page.keyboard.up("Alt");
  await page.mouse.move(...(await S(345, 335)), { steps: 2 });
  await page.mouse.up();
  await page.mouse.click(...(await S(500, 300)));
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  const n = (await doc()).nodes[(await state()).selection[0]];
  const p1 = n.vector.subpaths[0].points[1];
  check("pen: dragging with Alt makes the handles differ", Math.abs(p1.inX + p1.outX) > 5 || Math.abs(p1.inY + p1.outY) > 5, `in ${p1.inX.toFixed(1)},${p1.inY.toFixed(1)} out ${p1.outX.toFixed(1)},${p1.outY.toFixed(1)}`);
  check("pen: the incoming handle kept its value from before Alt", Math.abs(p1.inX + 10) < 3 && Math.abs(p1.inY) < 1.5, `in ${p1.inX.toFixed(1)},${p1.inY.toFixed(1)}`);
  check("pen: the outgoing handle followed the pointer, also after Alt was let go", Math.abs(p1.outX - 45) < 2 && Math.abs(p1.outY - 35) < 2, `out ${p1.outX.toFixed(1)},${p1.outY.toFixed(1)}`);
  // Without Alt the handles mirror, as before.
  await page.keyboard.press("p");
  await page.mouse.click(...(await S(100, 500)));
  await page.mouse.move(...(await S(300, 500)));
  await page.mouse.down();
  await page.mouse.move(...(await S(340, 530)), { steps: 5 });
  await page.mouse.up();
  await page.mouse.click(...(await S(500, 500)));
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  const m = (await doc()).nodes[(await state()).selection[0]];
  const q = m.vector.subpaths[0].points[1];
  check("pen: without Alt the handles still mirror", Math.abs(q.inX + q.outX) < 1e-6 && Math.abs(q.inY + q.outY) < 1e-6 && Math.abs(q.outX) > 30, `in ${q.inX.toFixed(1)} out ${q.outX.toFixed(1)}`);
  // Alt held before the drag starts: the first handle is already a cusp.
  await page.keyboard.press("p");
  await page.mouse.click(...(await S(100, 700)));
  await page.mouse.move(...(await S(300, 700)));
  await page.keyboard.down("Alt");
  await page.mouse.down();
  await page.mouse.move(...(await S(340, 730)), { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await page.mouse.click(...(await S(500, 700)));
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  const c = (await doc()).nodes[(await state()).selection[0]];
  const r = c.vector.subpaths[0].points[1];
  check("pen: Alt held from the start gives a cusp (no incoming handle)", r.inX === 0 && r.inY === 0 && r.outX > 30, `in ${r.inX},${r.inY} out ${r.outX.toFixed(1)}`);
}

// ---------- 4. Caps: None is flat, start and end separate ----------
await newFile();
{
  await create([{ type: "line", name: "Rule", x: 100, y: 200, width: 240, stroke: "#112233", strokeWidth: 12 }]);
  const line = await byName("Rule");
  await run({ op: "select", ids: [line.id] });
  await page.waitForTimeout(250);
  const canvasCap = () => dt((id) => document.querySelector(`#dt-canvas [data-id="${id}"] [stroke-linecap]`)?.getAttribute("stroke-linecap"), line.id);
  check("caps: a line with None ends is drawn flat on the canvas", (await canvasCap()) === "butt", String(await canvasCap()));
  check("caps: and in the export", /stroke-linecap="butt"/.test(await exportSvg(line.id)));
  const startOpts = await dt(() => [...(document.querySelector('select[aria-label="Line start"]')?.options ?? [])].map((o) => o.text));
  const endOpts = await dt(() => [...(document.querySelector('select[aria-label="Line end"]')?.options ?? [])].map((o) => o.text));
  check("caps: the panel has Start and End with None, Round, Square, Arrow, Circle", startOpts.join() === "None,Round,Square,Arrow,Circle" && endOpts.join() === startOpts.join(), `${startOpts} / ${endOpts}`);
  await page.selectOption('select[aria-label="Line start"]', "round");
  await page.selectOption('select[aria-label="Line end"]', "arrow");
  await page.waitForTimeout(250);
  const n = (await doc()).nodes[line.id];
  check("caps: the two ends are stored apart", n.shape?.startCap === "round" && n.shape?.endCap === "arrow", JSON.stringify(n.shape));
  const svg = await exportSvg(line.id);
  fs.writeFileSync(`${OUT}/r18d-caps.svg`, svg);
  check("caps: the export has a marker at each end and a flat body", /marker-start=/.test(svg) && /marker-end=/.test(svg) && /stroke-linecap="butt"/.test(svg), "");
  await run({ op: "update", ids: [line.id], patch: { shape: { startCap: "round", endCap: "round" } } });
  check("caps: Round on both ends is the plain round cap", /stroke-linecap="round"/.test(await exportSvg(line.id)) && !/<marker/.test(await exportSvg(line.id)));
  await run({ op: "update", ids: [line.id], patch: { shape: { startCap: "square", endCap: "none" } } });
  await run({ op: "select", ids: [] });
  await page.waitForTimeout(250);
  await shot("caps-mixed", { x: cb.x + 60, y: cb.y + 150, width: 360, height: 110 });
}

// ---------- 5. Stroke position on open and closed paths ----------
await newFile();
{
  const open = await mkVector([[100, 100], [200, 160], [300, 100]], false);
  const closed = await mkVector([[100, 300], [200, 360], [300, 300]], true);
  for (const id of [open, closed]) await run({ op: "update", ids: [id], patch: { strokes: [{ type: "solid", color: "#112233", opacity: 1, visible: true }], strokeWeight: 4 } });
  const hasPosition = () => dt(() => !!document.querySelector('select[aria-label="Stroke position"]'));
  await run({ op: "select", ids: [open] });
  await page.waitForTimeout(250);
  check("stroke position: hidden for an open path", !(await hasPosition()));
  await run({ op: "select", ids: [closed] });
  await page.waitForTimeout(250);
  check("stroke position: shown for a closed path", await hasPosition());
  await run({ op: "select", ids: [open, closed] });
  await page.waitForTimeout(250);
  check("stroke position: shown for a mixed selection", await hasPosition());
  const before = (await doc()).nodes[open].strokeAlign;
  await run({ op: "select", ids: [open] });
  check("stroke position: the stored value is untouched", before === (await doc()).nodes[open].strokeAlign);
  await create([{ type: "line", name: "L2", x: 100, y: 500, width: 100, stroke: "#112233", strokeWidth: 2 }]);
  await run({ op: "select", ids: [(await byName("L2")).id] });
  await page.waitForTimeout(250);
  check("stroke position: hidden for a line", !(await hasPosition()));
}

// ---------- 6. Point snapping ----------
await newFile();
{
  // Fractional page coordinates under the pointer: 1.5x zoom with an odd offset.
  await dt(() => window.__dt.setViewport({ zoom: 1.5, x: 13.3, y: 7.7 }));
  const a = await mkVector([[100, 100], [220, 100], [220, 200]], false);
  const b = await mkVector([[330, 250], [420, 250]], false);
  await run({ op: "select", ids: [a] });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(250);
  const [ax, ay] = await anchorXY(0, 1);
  const bpts = vecPts((await doc()).nodes[b])[0];
  // Drop the anchor 3 screen px off the sibling's first anchor.
  const [tx, ty] = await S(bpts[0].x, bpts[0].y);
  await page.mouse.move(ax, ay);
  await page.mouse.down();
  await page.mouse.move(tx - 40, ty - 30, { steps: 5 });
  await page.mouse.move(tx + 2.2, ty + 2.0, { steps: 4 });
  await shot("snap-anchor", { x: tx - 80, y: ty - 80, width: 160, height: 160 });
  const markShown = await dt(() => !!document.querySelector(".vsnap-mark"));
  await page.mouse.up();
  await page.waitForTimeout(200);
  let p = vecPts((await doc()).nodes[a])[0][1];
  check("snap: an anchor dragged to 3 screen px from another lands exactly on it", Math.abs(p.x - bpts[0].x) < 1e-6 && Math.abs(p.y - bpts[0].y) < 1e-6, `${p.x},${p.y} vs ${bpts[0].x},${bpts[0].y}`);
  check("snap: a ring marks the anchor while dragging", markShown);
  check("snap: and is gone after the drop", !(await dt(() => !!document.querySelector(".vsnap-mark"))));
  // Elsewhere: whole pixels.
  const [bx, by] = await anchorXY(0, 1);
  await page.mouse.move(bx, by);
  await page.mouse.down();
  await page.mouse.move(bx - 70.37, by + 90.61, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  p = vecPts((await doc()).nodes[a])[0][1];
  check("snap: dragged elsewhere it lands on whole pixels", Math.abs(p.x - Math.round(p.x)) < 1e-6 && Math.abs(p.y - Math.round(p.y)) < 1e-6, `${p.x},${p.y}`);
  // Ctrl: free.
  const [cx, cy] = await anchorXY(0, 1);
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.keyboard.down("Control");
  await page.mouse.move(cx + 31.37, cy + 12.61, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up("Control");
  await page.waitForTimeout(200);
  p = vecPts((await doc()).nodes[a])[0][1];
  check("snap: Ctrl-drag moves freely", Math.abs(p.x - Math.round(p.x)) > 0.01 || Math.abs(p.y - Math.round(p.y)) > 0.01, `${p.x},${p.y}`);
  // Another anchor of the same path counts too.
  const pts = vecPts((await doc()).nodes[a])[0];
  const [ox, oy] = await S(pts[0].x, pts[0].y);
  const [mx, my] = await anchorXY(0, 2);
  await page.mouse.move(mx, my);
  await page.mouse.down();
  await page.mouse.move(ox + 20, oy + 20, { steps: 4 });
  await page.mouse.move(ox + 2, oy - 2, { steps: 3 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const q = vecPts((await doc()).nodes[a])[0];
  check("snap: an anchor of the same path is a target", Math.abs(q[2].x - q[0].x) < 1e-6 && Math.abs(q[2].y - q[0].y) < 1e-6, `${q[2].x},${q[2].y} vs ${q[0].x},${q[0].y}`);
  // Pen clicks snap to anchors of other vectors, or to whole pixels.
  await page.keyboard.press("Escape");
  await run({ op: "select", ids: [] });
  await page.keyboard.press("p");
  const [sx, sy] = await S(bpts[1].x + 1.3, bpts[1].y + 1.1);
  await page.mouse.click(sx, sy);
  await page.mouse.click(...(await S(560.4, 380.6)));
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  const pen = (await doc()).nodes[(await state()).selection[0]];
  const pp = vecPts(pen)[0];
  check("snap: a pen click near an anchor of another vector lands on it", Math.abs(pp[0].x - bpts[1].x) < 1e-6 && Math.abs(pp[0].y - bpts[1].y) < 1e-6, `${pp[0].x},${pp[0].y}`);
  check("snap: other pen clicks land on whole pixels", Math.abs(pp[1].x - Math.round(pp[1].x)) < 1e-6 && Math.abs(pp[1].y - Math.round(pp[1].y)) < 1e-6, `${pp[1].x},${pp[1].y}`);
}

// ---------- 7. Scale strokes ----------
await newFile();
{
  await create([{ type: "rectangle", name: "Framed", x: 100, y: 100, width: 100, height: 60, fill: "#3366FF", stroke: "#112233", strokeWidth: 2 }]);
  const r = await byName("Framed");
  await run({ op: "select", ids: [r.id] });
  await page.keyboard.press("k");
  await page.waitForTimeout(300);
  const box = page.getByLabel("Scale strokes");
  check("scale: the K tool shows a Scale strokes option, on by default", (await box.count()) === 1 && (await box.isChecked()));
  await box.uncheck();
  check("scale: it is remembered in this browser", (await dt(() => localStorage.getItem("dt:scale-strokes"))) === "0");
  const field = page.getByLabel("Scale", { exact: true });
  await field.fill("200");
  await field.press("Enter");
  await page.waitForTimeout(300);
  let n = await byName("Framed");
  check("scale: 200% with strokes off doubles the size and keeps the stroke at 2", n.width === 200 && n.strokeWeight === 2, `${n.width}x${n.height}, stroke ${n.strokeWeight}`);
  // A handle drag.
  const h = await page.locator('[data-handle="se"]').boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 + 200, h.y + h.height / 2 + 120, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  n = await byName("Framed");
  check("scale: a handle drag scales the layer and keeps the stroke", n.width > 300 && n.strokeWeight === 2, `${n.width}x${n.height}, stroke ${n.strokeWeight}`);
  await page.reload();
  await page.waitForSelector("#dt-canvas");
  await page.waitForTimeout(500);
  await run({ op: "select", ids: [(await byName("Framed"))?.id].filter(Boolean) });
  await page.keyboard.press("k");
  await page.waitForTimeout(300);
  check("scale: still off after a reload", (await page.getByLabel("Scale strokes").count()) === 1 && !(await page.getByLabel("Scale strokes").isChecked()));
  await page.getByLabel("Scale strokes").check();
  await page.waitForTimeout(100);
  const w = (await byName("Framed")).strokeWeight;
  await field.fill("200");
  await field.press("Enter");
  await page.waitForTimeout(300);
  check("scale: with strokes on the stroke scales too", (await byName("Framed")).strokeWeight === w * 2, `${w} -> ${(await byName("Framed")).strokeWeight}`);
  await shot("scale-panel", { x: 1100, y: 80, width: 400, height: 400 });
}

// ---------- 8. Split and join ----------
await newFile();
{
  const id = await mkVector([[200, 150], [320, 150], [260, 260]], true);
  await run({ op: "select", ids: [id] });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(250);
  const sps = async () => (await doc()).nodes[id].vector.subpaths;
  const [x1, y1] = await anchorXY(0, 1);
  await page.mouse.click(x1, y1);
  await page.waitForTimeout(150);
  await page.mouse.click(x1 + 200, y1 + 5, { button: "right" });
  await page.waitForTimeout(250);
  const menuState = await dt(() => [...document.querySelectorAll('[role="menuitem"]')].filter((b) => /Split at point|Join ends/.test(b.textContent)).map((b) => [b.textContent.replace(/\s+/g, " ").trim(), b.disabled || b.getAttribute("aria-disabled") === "true"]));
  check("split: the vector edit menu offers Split at point (on) and Join ends (off)", menuState.length === 2 && menuState[0][1] === false && menuState[1][1] === true, JSON.stringify(menuState));
  await shot("split-menu", { x: x1 - 100, y: y1 - 150, width: 500, height: 420 });
  await page.getByRole("menuitem", { name: /Split at point/ }).click();
  await page.waitForTimeout(250);
  let s = await sps();
  check("split: a closed path opens, the anchor becomes both ends", s.length === 1 && !s[0].closed && s[0].points.length === 4 && s[0].points[0].x === s[0].points[3].x && s[0].points[0].y === s[0].points[3].y, `${s.length} subpaths, ${s[0].points.length} points, closed ${s[0].closed}`);
  const ev = await edit();
  check("split: both new ends are selected", ev.points.length === 2 && ev.points.some(([a, b]) => a === 0 && b === 0) && ev.points.some(([a, b]) => a === 0 && b === 3), JSON.stringify(ev.points));
  // Join them again with Ctrl+J.
  await page.keyboard.press("Control+j");
  await page.waitForTimeout(250);
  s = await sps();
  check("join: the same two ends close the path again with the original point count", s.length === 1 && s[0].closed && s[0].points.length === 3, `${s[0].points.length} points, closed ${s[0].closed}`);
  await run({ op: "undo" });
  s = await sps();
  check("join: one undo reopens it", !s[0].closed && s[0].points.length === 4);
  await run({ op: "undo" });
  s = await sps();
  check("split: one more undo closes the original", s[0].closed && s[0].points.length === 3);
  await run({ op: "redo" });
  s = await sps();
  check("split: redo opens it again", !s[0].closed && s[0].points.length === 4);
  check("split: redo keeps the anchor selection", (await edit()).points.length === 0 || (await edit()).points.length === 2);
  // Splitting an open path cuts it in two; joining two paths connects them.
  await page.keyboard.press("Escape");
  const open = await mkVector([[400, 400], [480, 440], [560, 400], [640, 440]], false);
  await run({ op: "select", ids: [open] });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(250);
  const [ix, iy] = await anchorXY(0, 1);
  await page.mouse.click(ix, iy);
  await page.mouse.click(ix + 300, iy + 100, { button: "right" });
  await page.waitForTimeout(250);
  await page.getByRole("menuitem", { name: /Split at point/ }).click();
  await page.waitForTimeout(250);
  const cut = (await doc()).nodes[open].vector.subpaths;
  check("split: an inner anchor cuts an open path in two", cut.length === 2 && cut[0].points.length === 2 && cut[1].points.length === 3, cut.map((c) => c.points.length).join("+"));
  await page.keyboard.press("Control+j");
  await page.waitForTimeout(250);
  const joined = (await doc()).nodes[open].vector.subpaths;
  check("join: the cut ends merge back into one path", joined.length === 1 && joined[0].points.length === 4 && !joined[0].closed, joined.map((c) => c.points.length).join("+"));
  check("no page errors in the whole run", pageErrors === 0);
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
