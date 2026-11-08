// Wave 4 stage A, package c: the bend tool (Ctrl/Cmd-drag on a segment, the Bend toggle), present from the
// selected frame, Ctrl+Alt+Enter, full screen, and hover waiting for real pointer movement (Q-1).
// Usage: E2E_URL=http://127.0.0.1:7321 [E2E_OUT=dir] node scripts/qa/w4ac-e2e.mjs (vite preview running)
// Only local servers are touched: every other request is aborted.

import { chromium } from "playwright-core";
import fs from "node:fs";

const URL = process.env.E2E_URL ?? "http://127.0.0.1:7321";
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch(launch);
const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 2 });
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
const shot = (n, clip) => page.screenshot({ path: `${OUT}/w4ac-${n}.png`, ...(clip ? { clip } : {}) });
const edit = () => dt(() => window.__dt.vectorEdit());
const node = async (id) => (await doc()).nodes[id];
let cb = null;

async function newFile() {
  await page.goto(URL);
  await page.click("button:has-text('New design file')");
  await page.waitForSelector("#dt-canvas");
  await page.waitForTimeout(300);
  await dt(() => window.__dt.setViewport({ zoom: 1, x: 0, y: 0 }));
  cb = await page.locator("#dt-canvas").boundingBox();
}
/** A screen point for page coordinates. */
const S = async (x, y) => {
  const v = await dt(() => window.__dt.viewport());
  return [cb.x + x * v.zoom + v.x, cb.y + y * v.zoom + v.y];
};
const pt = (x, y, extra = {}) => ({ x, y, inX: 0, inY: 0, outX: 0, outY: 0, ...extra });
const mkVector = async (points, closed = false) => {
  const r = await run({ op: "createVector", points, closed, parent: null });
  await page.waitForTimeout(150);
  return r.id;
};
const enterEdit = async (id) => {
  await run({ op: "select", ids: [id] });
  await page.waitForTimeout(150);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(250);
};
/** Page-space points of subpath 0, with handles. */
const abs = (n) => n.vector.subpaths[0].points.map((p) => ({ ...p, x: p.x + n.x, y: p.y + n.y }));
/** Distance from (px, py) to the sampled curve of segment `seg` of subpath 0. */
const distToSegment = (n, seg, px, py) => {
  const p = abs(n);
  const a = p[seg];
  const b = p[(seg + 1) % p.length];
  const c = [
    [a.x, a.y],
    [a.x + a.outX, a.y + a.outY],
    [b.x + b.inX, b.y + b.inY],
    [b.x, b.y],
  ];
  let best = Infinity;
  for (let i = 0; i <= 400; i++) {
    const t = i / 400;
    const u = 1 - t;
    const x = u * u * u * c[0][0] + 3 * u * u * t * c[1][0] + 3 * u * t * t * c[2][0] + t * t * t * c[3][0];
    const y = u * u * u * c[0][1] + 3 * u * u * t * c[1][1] + 3 * u * t * t * c[2][1] + t * t * t * c[3][1];
    best = Math.min(best, Math.hypot(x - px, y - py));
  }
  return best;
};
const straight = (n) => abs(n).every((p) => !p.inX && !p.inY && !p.outX && !p.outY);
const drag = async (from, to, { ctrl = false, steps = 8, pause = 0 } = {}) => {
  if (ctrl) await page.keyboard.down("Control");
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps });
  if (pause) await sleep(pause);
  await page.mouse.up();
  if (ctrl) await page.keyboard.up("Control");
  await page.waitForTimeout(150);
};
const bendBtn = () => page.locator('.topbar button[aria-label="Bend"]');

// ---------- 1. Ctrl-drag on a segment ----------
await newFile();
let line;
{
  line = await mkVector([pt(100, 100), pt(300, 100)]);
  await enterEdit(line);
  check("bend: vector edit is on", (await edit()).id === line);
  const target = await S(200, 150);
  await drag(await S(200, 100), target, { ctrl: true });
  const n = await node(line);
  const [tx, ty] = [200, 150];
  const d = distToSegment(n, 0, tx, ty);
  check("bend: the curve passes through the pointer (within 1 px)", d <= 1, `${d.toFixed(3)} px`);
  check("bend: the straight line became a curve", !straight(n) && abs(n).length === 2, JSON.stringify(abs(n).map((p) => [p.outX, p.outY, p.inX, p.inY])));
  check("bend: the anchors did not move", abs(n)[0].x === 100 && abs(n)[0].y === 100 && abs(n)[1].x === 300 && abs(n)[1].y === 100);
  await shot("bent-line", { x: cb.x + 40, y: cb.y + 40, width: 360, height: 220 });
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(200);
  const u = await node(line);
  check("bend: one Ctrl+Z restores the straight line", straight(u) && abs(u)[0].x === 100 && abs(u)[1].x === 300 && abs(u)[1].y === 100, JSON.stringify(abs(u)));
  // A plain drag on the segment (no modifier, no toggle) still inserts an anchor.
  await drag(await S(200, 100), await S(200, 100), { steps: 1 });
  check("bend: a plain click on a segment still adds an anchor", (await node(line)).vector.subpaths[0].points.length === 3);
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(200);
}

// ---------- 2. The Bend toggle ----------
await newFile();
{
  const id = await mkVector([pt(100, 100), pt(300, 100)]);
  await run({ op: "select", ids: [id] });
  await page.waitForTimeout(150);
  check("toggle: no Bend button outside vector edit", (await bendBtn().count()) === 0);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(250);
  check("toggle: a Bend button appears in vector edit", (await bendBtn().count()) === 1);
  check("toggle: off to begin with", (await bendBtn().getAttribute("aria-pressed")) === "false");
  check("toggle: its title names the modifier", /hold (Ctrl|⌘)/.test((await bendBtn().getAttribute("title")) ?? ""));
  await bendBtn().click();
  check("toggle: pressed after a click", (await bendBtn().getAttribute("aria-pressed")) === "true");
  await drag(await S(200, 100), await S(200, 60));
  let n = await node(id);
  check("toggle: a plain drag on a segment bends it", distToSegment(n, 0, 200, 60) <= 1 && n.vector.subpaths[0].points.length === 2, `${distToSegment(n, 0, 200, 60).toFixed(3)} px`);
  // A corner anchor: a drag pulls mirrored handles out of it.
  await drag(await S(300, 100), await S(340, 130));
  n = await node(id);
  const e = abs(n)[1];
  check("toggle: a drag on a corner anchor pulls out mirrored handles", Math.abs(e.outX - 40) < 1.01 && Math.abs(e.outY - 30) < 1.01 && Math.abs(e.inX + e.outX) < 1e-6 && Math.abs(e.inY + e.outY) < 1e-6, JSON.stringify(e));
  check("toggle: the anchor itself stayed put", e.x === 300 && e.y === 100);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  check("toggle: leaving vector edit removes the button", (await edit()).id === null && (await bendBtn().count()) === 0);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(250);
  check("toggle: re-entering starts with Bend off", (await bendBtn().getAttribute("aria-pressed")) === "false");
}

// ---------- 3. Smooth neighbours stay smooth; corners are left alone ----------
await newFile();
{
  const id = await mkVector([pt(100, 100), pt(200, 100, { inX: -40, outX: 40 }), pt(300, 100)]);
  await enterEdit(id);
  await drag(await S(150, 100), await S(150, 150), { ctrl: true });
  const n = await node(id);
  const p = abs(n)[1];
  const cross = p.inX * p.outY - p.inY * p.outX;
  const dot = p.inX * p.outX + p.inY * p.outY;
  check("smooth: the neighbour's handles stay collinear and opposite", Math.abs(cross) < 1e-6 && dot < 0, `in ${p.inX},${p.inY} out ${p.outX},${p.outY}`);
  check("smooth: equal handles stay equal", Math.abs(Math.hypot(p.inX, p.inY) - Math.hypot(p.outX, p.outY)) < 1e-6);
  const a = abs(n)[0];
  const c = abs(n)[2];
  check("smooth: the corner anchors keep no opposite handle", !a.inX && !a.inY && !c.outX && !c.outY);
  check("smooth: the curve passes through the pointer", distToSegment(n, 0, 150, 150) <= 1);
}

// ---------- 4. Ctrl-drag on an anchor still moves it, without snapping ----------
await newFile();
{
  const id = await mkVector([pt(100, 100), pt(300, 100)]);
  await enterEdit(id);
  const from = await S(300, 100);
  await drag(from, [from[0] + 10.5, from[1] + 7.25], { ctrl: true });
  const n = await node(id);
  const e = abs(n)[1];
  check("anchor: Ctrl-drag moves it freely (no pixel snap)", Math.abs(e.x - 310.5) < 0.01 && Math.abs(e.y - 107.25) < 0.01, `${e.x}, ${e.y}`);
  check("anchor: it grew no handles", !e.inX && !e.outX && !e.inY && !e.outY);
}

// ---------- 5. Escape takes a bend back ----------
await newFile();
{
  const id = await mkVector([pt(100, 100), pt(300, 100)]);
  await enterEdit(id);
  await page.keyboard.down("Control");
  await page.mouse.move(...(await S(200, 100)));
  await page.mouse.down();
  await page.mouse.move(...(await S(200, 160)), { steps: 6 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await page.keyboard.up("Control");
  await page.waitForTimeout(250);
  const n = await node(id);
  check("escape: a bend cancelled mid-drag leaves the path as it was", straight(n) && abs(n)[0].y === 100 && abs(n)[1].y === 100, JSON.stringify(abs(n)));
  check("escape: and leaves vector edit", (await edit()).id === null);
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(150);
  check("escape: the cancelled bend left no undo step (one undo removes the layer itself)", !(await node(id)));
}

// ---------- 5b. Escape without the modifier: the Bend toggle, and a plain anchor drag ----------
await newFile();
{
  const id = await mkVector([pt(100, 100), pt(300, 100)]);
  await enterEdit(id);
  await bendBtn().click();
  await page.mouse.move(...(await S(200, 100)));
  await page.mouse.down();
  await page.mouse.move(...(await S(200, 150)), { steps: 6 });
  await page.keyboard.press("Escape");
  await page.mouse.move(...(await S(200, 190)), { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  const n = await node(id);
  check("escape (toggle, no modifier): the bend is cancelled and stays cancelled", straight(n), JSON.stringify(abs(n)));
  check("escape (toggle, no modifier): vector edit is left", (await edit()).id === null);
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(150);
  check("escape (toggle, no modifier): no undo step was left (undo removes the layer)", !(await node(id)));
}
await newFile();
{
  const id = await mkVector([pt(100, 100), pt(300, 100)]);
  await enterEdit(id);
  await page.mouse.move(...(await S(300, 100)));
  await page.mouse.down();
  await page.mouse.move(...(await S(340, 150)), { steps: 6 });
  await page.keyboard.press("Escape");
  await page.mouse.move(...(await S(360, 170)), { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  const n = await node(id);
  const e = abs(n)[1];
  check("escape (anchor drag): the anchor is back where it was", e.x === 300 && e.y === 100, `${e.x}, ${e.y}`);
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(150);
  check("escape (anchor drag): no undo step was left", !(await node(id)));
}

// ---------- 5c. A bend grabbed near the end of a long segment does not hook ----------
await newFile();
{
  const id = await mkVector([pt(-200, 100), pt(400, 100)]);
  await enterEdit(id);
  await dt(() => window.__dt.setViewport({ zoom: 1, x: 300, y: 0 }));
  await page.waitForTimeout(150);
  const from = await S(-190, 100);
  await drag(from, [from[0], from[1] + 3], { ctrl: true });
  const a = abs(await node(id))[0];
  check("near-end bend: the start handle points forward, no hook", a.outX > -1e-6 && a.outY > 0 && a.outY < 100, JSON.stringify([a.outX, a.outY]));
  await dt(() => window.__dt.setViewport({ zoom: 1, x: 0, y: 0 }));
}

// ---------- 6. A rotated vector and a flattened rectangle ----------
await newFile();
{
  const id = await mkVector([pt(100, 100), pt(300, 100)]);
  await run({ op: "update", ids: [id], patch: { rotation: 30 } });
  await page.waitForTimeout(150);
  await enterEdit(id);
  // The segment's middle on the page: local (width / 2, 0) through the layer's matrix.
  const matrix = () => dt(([i]) => window.__dt.query({ q: "bounds", ids: [i] }).items[0].matrix, [id]);
  const tr = (M, x, y) => [M.a * x + M.c * y + M.e, M.b * x + M.d * y + M.f];
  const m0 = await matrix();
  const [px, py] = tr(m0, (await node(id)).vector.subpaths[0].points[1].x / 2 + (await node(id)).vector.subpaths[0].points[0].x / 2, 0);
  const from = await S(px, py);
  await drag(from, [from[0], from[1] + 60], { ctrl: true });
  const n = await node(id);
  const M = await matrix();
  const pts = n.vector.subpaths[0].points;
  const [a, b] = [pts[0], pts[1]];
  const c = [tr(M, a.x, a.y), tr(M, a.x + a.outX, a.y + a.outY), tr(M, b.x + b.inX, b.y + b.inY), tr(M, b.x, b.y)];
  let best = Infinity;
  for (let i = 0; i <= 400; i++) {
    const t = i / 400;
    const u = 1 - t;
    const x = u * u * u * c[0][0] + 3 * u * u * t * c[1][0] + 3 * u * t * t * c[2][0] + t * t * t * c[3][0];
    const y = u * u * u * c[0][1] + 3 * u * u * t * c[1][1] + 3 * u * t * t * c[2][1] + t * t * t * c[3][1];
    best = Math.min(best, Math.hypot(x - px, y - (py + 60)));
  }
  check("rotated: the bent curve passes through the pointer in page space", best <= 1, `${best.toFixed(3)} px`);
}
await newFile();
{
  const r = await run({ op: "createShape", kind: "rectangle", x: 200, y: 140, width: 160, height: 100, parent: null });
  await run({ op: "update", ids: [r.id], patch: { fills: [{ type: "solid", color: "#3366FF", opacity: 1, visible: true }] } });
  await run({ op: "select", ids: [r.id] });
  await run({ op: "flatten", ids: [r.id] });
  await page.waitForTimeout(200);
  const flat = await doc();
  const vec = Object.values(flat.nodes).find((x) => x.type === "vector");
  check("rectangle: flatten gives an editable vector", !!vec);
  if (vec) {
    await enterEdit(vec.id);
    // The top edge's middle, bent upward.
    const start = await S(vec.x + vec.width / 2, vec.y);
    await drag(start, [start[0], start[1] - 50], { ctrl: true });
    const n = await node(vec.id);
    // The path starts at the top right and runs down, so the closing segment (3) is the top edge.
    const dd = distToSegment(n, 3, vec.x + vec.width / 2, vec.y - 50);
    check("rectangle: the bent top edge follows the pointer", dd <= 1.5, `${dd.toFixed(3)} px, ${JSON.stringify(abs(n).map((q) => [q.x, q.y]))} from ${vec.x},${vec.y},${vec.width}x${vec.height}`);
    await page.mouse.move(cb.x + 700, cb.y + 500);
    await page.waitForTimeout(150);
    await shot("bent-rectangle", { x: cb.x + 140, y: cb.y + 40, width: 320, height: 260 });
  }
}

// ---------- 7. Present from the selection, the shortcut, full screen, Q-1 ----------
const fixture = async () => {
  await newFile();
  const mk = async (name, x) => {
    const f = await run({ op: "createShape", kind: "frame", x, y: 0, width: 300, height: 300, parent: null });
    await run({ op: "update", ids: [f.id], patch: { name } });
    return f.id;
  };
  const home = await mk("Home", 0);
  const settings = await mk("Settings", 400);
  const hovered = await mk("Hovered", 800);
  const child = await run({ op: "createShape", kind: "rectangle", x: 420, y: 20, width: 80, height: 40, parent: settings });
  await run({ op: "update", ids: [child.id], patch: { name: "Inner box" } });
  const go = await run({ op: "createShape", kind: "rectangle", x: 20, y: 20, width: 100, height: 40, parent: home });
  await run({ op: "update", ids: [go.id], patch: { name: "Go", interactions: [{ trigger: "onClick", action: "navigate", destination: settings }] } });
  // On Settings: a layer that goes to Hovered while the pointer is over it.
  const card = await run({ op: "createShape", kind: "rectangle", x: 500, y: 100, width: 100, height: 100, parent: settings });
  await run({ op: "update", ids: [card.id], patch: { name: "Hover card", interactions: [{ trigger: "onHover", action: "navigate", destination: hovered }] } });
  const pageId = await dt(() => window.__dt.doc().pages[0].id);
  await run({ op: "setFlowStart", page: pageId, id: home });
  await run({ op: "select", ids: [] });
  await page.waitForTimeout(200);
  return { home, settings, hovered, child: child.id };
};
const crumb = () => page.locator(".presenter .bar .crumb").innerText().then((t) => t.trim());
const closePresenter = async () => {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
};
{
  const f = await fixture();
  check("present: nothing selected starts on the flow start", await (async () => {
    await page.locator(".topbar .tbtn[title='Present']").click();
    await page.waitForSelector(".presenter");
    return (await crumb()) === "Home";
  })());
  await closePresenter();
  await run({ op: "select", ids: [f.child] });
  await page.waitForTimeout(150);
  await page.locator(".topbar .tbtn[title='Present']").click();
  await page.waitForSelector(".presenter");
  check("present: a child of the second frame starts on that frame", (await crumb()) === "Settings", await crumb());
  await closePresenter();
  await run({ op: "select", ids: [f.hovered] });
  await page.keyboard.press("Control+Alt+Enter");
  await page.waitForTimeout(400);
  check("shortcut: Ctrl+Alt+Enter starts on the selected frame", (await page.locator(".presenter").count()) === 1 && (await crumb()) === "Hovered", await crumb().catch(() => "no presenter"));
  await closePresenter();
  await run({ op: "select", ids: [] });
  await page.keyboard.press("Control+Alt+Enter");
  await page.waitForTimeout(400);
  check("shortcut: with nothing selected it starts on the flow start", (await page.locator(".presenter").count()) === 1 && (await crumb()) === "Home");
  check("present: the Play button declares the shortcut", /Alt\+Enter/.test((await page.locator(".topbar .tbtn[title='Present']").getAttribute("aria-keyshortcuts")) ?? ""));
  await closePresenter();
}

{
  // Full screen.
  const f = await fixture();
  void f;
  await page.locator(".topbar .tbtn[title='Present']").click();
  await page.waitForSelector(".presenter");
  const fsBtn = page.locator('.presenter .bar button[aria-label="Full screen (F)"]');
  check("fullscreen: the bar has a Full screen button", (await fsBtn.count()) === 1);
  check("fullscreen: not automatic", (await dt(() => !document.fullscreenElement)) === true);
  await fsBtn.click();
  await page.waitForTimeout(500);
  check("fullscreen: the button makes the presenter the full screen element", await dt(() => document.fullscreenElement?.classList.contains("presenter") === true));
  check("fullscreen: the button shows it is on", (await fsBtn.getAttribute("aria-pressed")) === "true");
  await shot("fullscreen");
  await page.keyboard.press("f");
  await page.waitForTimeout(500);
  check("fullscreen: F leaves it", await dt(() => !document.fullscreenElement));
  await page.keyboard.press("f");
  await page.waitForTimeout(500);
  check("fullscreen: F enters it", await dt(() => !!document.fullscreenElement));
  // Escape that reaches the page leaves full screen first and keeps presenting.
  await dt(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  await page.waitForTimeout(500);
  check("fullscreen: Escape leaves full screen and keeps presenting", (await dt(() => !document.fullscreenElement)) && (await page.locator(".presenter").count()) === 1);
  await page.keyboard.press("f");
  await page.waitForTimeout(500);
  await page.locator('.presenter .bar button[title="Close (Esc)"]').click();
  await page.waitForTimeout(500);
  check("fullscreen: closing the presenter exits full screen", (await dt(() => !document.fullscreenElement)) && (await page.locator(".presenter").count()) === 0);

  // A refused request: a toast and no error.
  const errs = pageErrors;
  await dt(() => {
    window.__origReq = Element.prototype.requestFullscreen;
    Element.prototype.requestFullscreen = () => Promise.reject(new Error("denied"));
  });
  await page.locator(".topbar .tbtn[title='Present']").click();
  await page.waitForSelector(".presenter");
  await page.locator('.presenter .bar button[aria-label="Full screen (F)"]').click();
  await page.waitForTimeout(400);
  const toastText = await page.locator(".toast").first().innerText().catch(() => "");
  check("fullscreen: a refused request toasts", /Full screen isn't available here/.test(toastText), toastText);
  check("fullscreen: a refused request throws nothing", pageErrors === errs);
  await closePresenter();

  // No API: no button.
  await dt(() => {
    delete Element.prototype.requestFullscreen;
  });
  await page.locator(".topbar .tbtn[title='Present']").click();
  await page.waitForSelector(".presenter");
  check("fullscreen: without requestFullscreen there is no button", (await page.locator('.presenter .bar button[aria-label="Full screen (F)"]').count()) === 0);
  await page.keyboard.press("f");
  await page.waitForTimeout(200);
  check("fullscreen: and F does nothing", (await page.locator(".presenter").count()) === 1 && (await dt(() => !document.fullscreenElement)));
  await closePresenter();
  await dt(() => {
    Element.prototype.requestFullscreen = window.__origReq;
  });
}

{
  // Q-1: hover waits for real movement after a screen appears under a still pointer.
  const f = await fixture();
  void f;
  await page.locator(".topbar .tbtn[title='Present']").click();
  await page.waitForSelector(".presenter");
  await page.waitForTimeout(400);
  const vp = await page.locator(".presenter-viewport").boundingBox();
  // Home's Go button is at (20,20)-(120,60); Settings' hover card at (100,100)-(200,200).
  const go = [vp.x + 70, vp.y + 40];
  const parked = [vp.x + 150, vp.y + 150];
  await page.mouse.move(...parked, { steps: 3 });
  await page.waitForTimeout(200);
  // A key first, so focus counts as keyboard focus (a clicked button keeps Enter for the design).
  await page.keyboard.press("Tab");
  await page.locator('.presenter .hotspot[aria-label="Go"]').focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);
  check("Q-1: Enter navigated to Settings", (await crumb()) === "Settings", await crumb());
  check("Q-1: the pointer parked over the hover card did not fire it", (await crumb()) === "Settings");
  await page.mouse.move(parked[0] + 2, parked[1] + 1);
  await page.waitForTimeout(700);
  check("Q-1: moving 2 px fires the hover link at once", (await crumb()) === "Hovered", await crumb());
  await page.mouse.move(vp.x + 280, vp.y + 280, { steps: 4 });
  await page.waitForTimeout(700);
  check("Q-1: leaving reverts", (await crumb()) === "Settings", await crumb());
  // Coming from outside, a real move onto the layer fires it too.
  await page.mouse.move(parked[0], parked[1], { steps: 6 });
  await page.waitForTimeout(700);
  check("Q-1: a real move onto the layer still fires it", (await crumb()) === "Hovered", await crumb());
  void go;
  await closePresenter();
}

{
  // Q-1: arming enters only the topmost hotspot, so a parent's Mouse leave still fires.
  await newFile();
  const mk = async (name, x) => {
    const f = await run({ op: "createShape", kind: "frame", x, y: 0, width: 300, height: 300, parent: null });
    await run({ op: "update", ids: [f.id], patch: { name } });
    return f.id;
  };
  const home = await mk("Home", 0);
  const b = await mk("Screen B", 400);
  const left = await mk("Left", 800);
  const go = await run({ op: "createShape", kind: "rectangle", x: 20, y: 20, width: 100, height: 40, parent: home });
  await run({ op: "update", ids: [go.id], patch: { name: "Go", interactions: [{ trigger: "onClick", action: "navigate", destination: b }] } });
  const p = await run({ op: "createShape", kind: "frame", x: 450, y: 100, width: 100, height: 100, parent: b });
  await run({ op: "update", ids: [p.id], patch: { name: "P", interactions: [{ trigger: "mouseLeave", action: "navigate", destination: left }] } });
  const k = await run({ op: "createShape", kind: "rectangle", x: 500, y: 120, width: 50, height: 60, parent: p.id });
  await run({ op: "update", ids: [k.id], patch: { name: "K", interactions: [{ trigger: "onClick", action: "navigate", destination: home }] } });
  const pageId = await dt(() => window.__dt.doc().pages[0].id);
  await run({ op: "setFlowStart", page: pageId, id: home });
  await run({ op: "select", ids: [] });
  await page.locator(".topbar .tbtn[title='Present']").click();
  await page.waitForSelector(".presenter");
  await page.waitForTimeout(400);
  const vp = await page.locator(".presenter-viewport").boundingBox();
  const onK = [vp.x + 125, vp.y + 150];
  await page.mouse.move(...onK, { steps: 3 });
  await page.waitForTimeout(200);
  await page.keyboard.press("Tab");
  await page.locator('.presenter .hotspot[aria-label="Go"]').focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
  check("Q-1 leave: Enter arrived on screen B", (await crumb()) === "Screen B", await crumb());
  await page.mouse.move(onK[0] + 1, onK[1]);
  await page.waitForTimeout(200);
  await page.mouse.move(vp.x + 220, onK[1], { steps: 4 });
  await page.waitForTimeout(700);
  check("Q-1 leave: leaving the child out of the parent fires the parent's Mouse leave", (await crumb()) === "Left", await crumb());
  await closePresenter();
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed${pageErrors ? `, ${pageErrors} page errors` : ""}`);
process.exit(failed.length || pageErrors ? 1 : 0);
