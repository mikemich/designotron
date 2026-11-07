// Round 13, touch and tablet: a tap inside the text being edited moves the caret and keeps the
// editor open (no canvas menu), a pinch cancels the first finger's drag, a 500 ms hold opens the
// canvas menu, panels are overlays below 1100 px (toolbar toggles, focus, Escape, aria-expanded),
// Ctrl+\ shows/hides the panels, and the toolbar fits without overlap at iPad and phone widths.
// Touch goes through CDP Input.dispatchTouchEvent on iPad Pro 11 (both orientations) and iPhone 13.
// Usage: E2E_URL=http://localhost:6331 [E2E_OUT=dir] node scripts/qa/r13c-e2e.mjs (dev server running)

import { chromium, devices } from "playwright-core";
import fs from "node:fs";

const URL = process.env.E2E_URL ?? "http://localhost:6331";
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

const IPAD = devices["iPad Pro 11"];
const IPAD_L = { ...IPAD, viewport: { width: 1194, height: 834 }, screen: { width: 1194, height: 834 } };
const PHONE = devices["iPhone 13"];
const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 };

const browser = await chromium.launch(launch);

async function open(device, { scheme = "dark", file = true } = {}) {
  const ctx = await browser.newContext({ ...device, hasTouch: true, colorScheme: scheme });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem("dt:tour-done", "1");
    } catch {
      /* no storage */
    }
  });
  const page = await ctx.newPage();
  await page.route("**/*", (r) => (/^(http:\/\/(localhost|127\.0\.0\.1)|data:|blob:|ws:)/.test(r.request().url()) ? r.continue() : r.abort()));
  page.on("pageerror", (e) => check("no page errors", false, String(e)));
  if (file) {
    await page.goto(URL);
    await page.click("button:has-text('New design file')");
    await page.waitForSelector("#dt-canvas");
    await page.waitForTimeout(500);
  }
  const cdp = await ctx.newCDPSession(page);
  return { ctx, page, cdp };
}

const touch = (cdp, type, pts) =>
  cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map(([x, y, id = 0]) => ({ x, y, id, radiusX: 1, radiusY: 1, force: 1 })) });
async function tap(cdp, x, y, hold = 60) {
  await touch(cdp, "touchStart", [[x, y]]);
  await sleep(hold);
  await touch(cdp, "touchEnd", []);
}

const dt = (page, fn, arg) => page.evaluate(fn, arg);
const create = async (page, nodes) => {
  await dt(page, (n) => window.__dt.tool("create_nodes", { nodes: n }), nodes);
  await page.waitForTimeout(300);
};
const byName = (page, name) => dt(page, (nm) => Object.values(window.__dt.doc().nodes).find((n) => n.name === nm) ?? null, name);
const rectOf = (page, id) =>
  dt(
    page,
    (i) => {
      const r = document.querySelector(`#dt-canvas g[data-id="${i}"]`).getBoundingClientRect();
      return { l: r.left, r: r.right, t: r.top, b: r.bottom, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    },
    id,
  );
const state = (page) => dt(page, () => window.__dt.state());
const menuOpen = (page) => dt(page, () => !!document.querySelector("[role=menu]"));
const canvasWidth = (page) => dt(page, () => document.getElementById("dt-canvas").getBoundingClientRect().width);

// ---------------------------------------------------------------- T-1: tap places the caret
for (let run = 1; run <= 5; run++) {
  const { ctx, page, cdp } = await open(IPAD);
  await create(page, [
    { type: "frame", name: "Card", x: 0, y: 0, width: 400, height: 300, fill: "#FFFFFF", children: [{ type: "text", name: "Title", x: 40, y: 120, text: "Hello world", fontSize: 28, fontWeight: 700, color: "#111111" }] },
  ]);
  const title = await byName(page, "Title");
  const card = await byName(page, "Card");
  // Mixed sizes: "world" is much larger than the textarea's own 28 px, so the browser's own caret
  // placement lands somewhere else than where the canvas draws the glyphs.
  await dt(page, (id) => window.__dt.dispatch({ op: "update", ids: [id], patch: { text: { runs: [{ start: 6, end: 11, fontSize: 64 }] } } }), title.id);
  await dt(page, (id) => window.__dt.tool("select", { ids: [id] }), card.id);
  await dt(page, () => window.__dt.zoomToSelection?.());
  await page.keyboard.press("Shift+2");
  await page.waitForTimeout(500);
  const t = await rectOf(page, title.id);
  // T's sequence (runs 1, 3, 5): a tap, a pause, a double-tap. Runs 2 and 4: a clean double-tap,
  // which opens the editor with all the text selected.
  if (run % 2) {
    await tap(cdp, t.l + 20, t.cy);
    await sleep(300);
  }
  await tap(cdp, t.l + 20, t.cy, 40);
  await sleep(120);
  await tap(cdp, t.l + 20, t.cy, 40);
  await sleep(500);
  const opened = await dt(page, () => !!document.querySelector(".text-editor"));
  // Deselect the word the double-tap selected, then tap near the right edge of "world".
  const tx = t.r - 6;
  await tap(cdp, tx, t.cy);
  await sleep(500);
  const after = await dt(page, () => {
    const ta = document.querySelector(".text-editor");
    return { editor: !!ta, menu: !!document.querySelector("[role=menu]"), s: ta?.selectionStart ?? -1, e: ta?.selectionEnd ?? -1 };
  });
  // Where the engine draws the glyph edge nearest the tap.
  const expected = await dt(
    page,
    ([id, x]) => {
      const g = window.__dt.query({ q: "textLayout", id });
      const n = window.__dt.doc().nodes[id];
      const el = document.querySelector(`#dt-canvas g[data-id="${id}"]`).getBoundingClientRect();
      const lx = ((x - el.left) / el.width) * n.width;
      const l = g.lines[0];
      let best = 0;
      l.xs.forEach((v, i) => {
        if (Math.abs(v - lx) < Math.abs(l.xs[best] - lx)) best = i;
      });
      return l.start + best;
    },
    [title.id, tx],
  );
  check(`T-1 run ${run}: editor stays open after a tap inside it`, opened && after.editor);
  check(`T-1 run ${run}: no canvas menu opens`, !after.menu);
  check(`T-1 run ${run}: caret is where the engine draws it`, after.s === after.e && Math.abs(after.s - expected) <= 1, `caret ${after.s}, engine ${expected}`);
  if (after.editor) {
    await page.keyboard.type("X");
    await sleep(200);
    const text = await dt(page, (id) => window.__dt.doc().nodes[id].text.characters, title.id);
    check(`T-1 run ${run}: typing lands at the caret`, text.indexOf("X") >= 0 && Math.abs(text.indexOf("X") - after.s) <= 1, JSON.stringify(text));
  }
  if (run === 1) await page.screenshot({ path: `${OUT}/r13c-t1-caret.png` });
  await ctx.close();
}

// ---------------------------------------------------------------- pinch and long-press (iPad)
{
  const { ctx, page, cdp } = await open(IPAD);
  await create(page, [{ type: "rectangle", name: "Box", x: 100, y: 100, width: 200, height: 200, fill: "#4F46E5" }]);
  await page.evaluate(() => window.__dt.setViewport({ zoom: 1, x: 0, y: 0 }));
  await page.waitForTimeout(300);
  const box = await byName(page, "Box");
  const snapshot = () => dt(page, (id) => JSON.stringify(window.__dt.doc().nodes[id]), box.id);
  const before = await snapshot();
  const selBefore = JSON.stringify((await state(page)).selection);
  const r = await rectOf(page, box.id);

  // One finger on the unselected rectangle drags it, then a second finger pinches.
  await touch(cdp, "touchStart", [[r.cx, r.cy, 1]]);
  await sleep(60);
  await touch(cdp, "touchMove", [[r.cx + 20, r.cy + 10, 1]]);
  await sleep(60);
  await touch(cdp, "touchMove", [[r.cx + 40, r.cy + 20, 1]]);
  const mid = await state(page);
  await touch(cdp, "touchStart", [[r.cx + 40, r.cy + 20, 1], [r.cx + 140, r.cy + 20, 2]]);
  await sleep(60);
  await touch(cdp, "touchMove", [[r.cx + 20, r.cy + 20, 1], [r.cx + 200, r.cy + 20, 2]]);
  await sleep(60);
  const z0 = await dt(page, () => window.__dt.viewport().zoom);
  // The first finger lifts first: its pointerup is swallowed by the pinch.
  await touch(cdp, "touchEnd", [[r.cx + 200, r.cy + 20, 2]]);
  await sleep(60);
  await touch(cdp, "touchEnd", []);
  await sleep(200);
  const st = await state(page);
  check("pinch: the drag had opened an engine gesture before the second finger", mid.inGesture === true);
  check("pinch: no engine gesture is left open", st.inGesture === false);
  check("pinch: the rectangle is back where it was", (await snapshot()) === before);
  check("pinch: the selection is what it was before the first finger", JSON.stringify(st.selection) === selBefore, `${JSON.stringify(st.selection)} vs ${selBefore}`);
  void z0;
  await page.keyboard.press("Control+z");
  await sleep(200);
  check("pinch: nothing of the cancelled drag is left to undo (Ctrl+Z undoes the creation)", (await byName(page, "Box")) === null);
  await page.keyboard.press("Control+Shift+z");
  await sleep(200);

  // Long-press.
  await page.evaluate(() => window.__dt.setViewport({ zoom: 1, x: 0, y: 0 }));
  await dt(page, () => window.__dt.dispatch({ op: "select", ids: [] }));
  await sleep(200);
  const box2 = await byName(page, "Box");
  const r2 = await rectOf(page, box2.id);
  const x0 = box2.x;
  await touch(cdp, "touchStart", [[r2.cx, r2.cy]]);
  await sleep(650);
  const menuHeld = await menuOpen(page);
  const selHeld = (await state(page)).selection;
  await touch(cdp, "touchEnd", []);
  await sleep(300);
  check("long-press 600 ms opens the canvas menu", menuHeld && (await menuOpen(page)));
  check("long-press selects the layer under the finger", selHeld.length === 1 && selHeld[0] === box2.id);
  check("long-press leaves the rectangle where it was", (await byName(page, "Box")).x === x0);
  await page.screenshot({ path: `${OUT}/r13c-long-press.png` });
  await page.keyboard.press("Escape");
  await sleep(200);
  check("the long-press menu closes with Escape", !(await menuOpen(page)));

  // Held but moved 20 px: a drag, no menu.
  await dt(page, () => window.__dt.dispatch({ op: "select", ids: [] }));
  await touch(cdp, "touchStart", [[r2.cx, r2.cy]]);
  await sleep(100);
  await touch(cdp, "touchMove", [[r2.cx + 20, r2.cy]]);
  await sleep(600);
  await touch(cdp, "touchEnd", []);
  await sleep(300);
  check("a hold with a 20 px move opens no menu", !(await menuOpen(page)));
  await page.keyboard.press("Control+z");
  // A short tap opens no menu either.
  await tap(cdp, r2.cx, r2.cy, 100);
  await sleep(300);
  check("a short tap opens no menu", !(await menuOpen(page)));
  await ctx.close();
}

// ---------------------------------------------------------------- panels at 834x1194
{
  const { ctx, page, cdp } = await open(IPAD);
  await create(page, [{ type: "rectangle", name: "Box", x: 100, y: 100, width: 200, height: 200, fill: "#4F46E5" }]);
  const box = await byName(page, "Box");
  const cw = await canvasWidth(page);
  check("834 wide: the canvas is at least 820 px wide with both panels closed", cw >= 820, `${cw}`);
  const aria = (side) => dt(page, (s) => document.getElementById(`panel-toggle-${s}`)?.getAttribute("aria-expanded"), side);
  const shown = (side) => dt(page, (s) => { const e = document.querySelector(s === "left" ? ".main > .panel:not(.right)" : ".main > .panel.right"); return !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden"; }, side);
  check("both panels start closed", !(await shown("left")) && !(await shown("right")));
  check("toggles start aria-expanded=false", (await aria("left")) === "false" && (await aria("right")) === "false");

  await dt(page, (id) => window.__dt.tool("select", { ids: [id] }), box.id);
  const rt = await dt(page, () => document.getElementById("panel-toggle-right").getBoundingClientRect().toJSON());
  await tap(cdp, rt.x + rt.width / 2, rt.y + rt.height / 2);
  await sleep(500);
  check("the Design toggle opens the panel as an overlay", await shown("right"));
  check("Design toggle has aria-expanded=true", (await aria("right")) === "true");
  check("opening the overlay leaves the canvas width unchanged", Math.abs((await canvasWidth(page)) - cw) < 1);
  const overlay = await dt(page, () => {
    const p = document.querySelector(".main > .panel.right");
    const c = document.getElementById("dt-canvas").getBoundingClientRect();
    const r = p.getBoundingClientRect();
    return { pos: getComputedStyle(p).position, over: r.left < c.right && r.right > c.left, inFront: document.elementFromPoint(r.left + 20, r.top + 100)?.closest(".panel") === p };
  });
  check("the Design panel floats over the canvas", overlay.pos === "absolute" && overlay.over && overlay.inFront);
  check("focus moved into the opened panel", await dt(page, () => !!document.activeElement?.closest(".main > .panel.right")), await dt(page, () => document.activeElement?.outerHTML.slice(0, 80)));
  await page.screenshot({ path: `${OUT}/r13c-ipad-design-overlay.png` });
  // Edit W in the overlay.
  await page.fill('.panel.right input[aria-label="Width"]', "320");
  await page.keyboard.press("Enter");
  await sleep(300);
  check("editing W in the overlay works", (await byName(page, "Box")).width === 320);
  // Escape closes the overlay and focus goes back to its toggle.
  await dt(page, () => document.querySelector(".main > .panel.right [role=tab][aria-selected=true]").focus());
  await page.keyboard.press("Escape");
  await sleep(300);
  check("Escape closes the overlay", !(await shown("right")) && (await aria("right")) === "false");
  check("focus returns to the Design toggle", await dt(page, () => document.activeElement?.id === "panel-toggle-right"));

  // The Layers panel, and its close button.
  await page.focus("#panel-toggle-left");
  await page.keyboard.press("Enter");
  await sleep(400);
  check("keyboard: Enter on the Layers toggle opens it and focuses inside", (await shown("left")) && (await dt(page, () => !!document.activeElement?.closest(".main > .panel:not(.right)"))));
  check("the Layers panel names itself", await dt(page, () => document.getElementById("panel-left")?.getAttribute("aria-label") === "Layers panel"));
  await page.screenshot({ path: `${OUT}/r13c-ipad-layers-overlay.png` });
  await page.click(".main > .panel:not(.right) .panel-close");
  await sleep(300);
  check("the panel's own close button closes it", !(await shown("left")));
  // Both open, then the chat takes the Design panel's place.
  await page.click("#panel-toggle-right");
  await sleep(300);
  await page.click("#claude-toggle");
  await sleep(400);
  check("opening Claude closes the Design overlay (same place)", !(await shown("right")) && (await aria("right")) === "false");
  await page.click("#panel-toggle-right");
  await sleep(300);
  check("opening the Design panel closes Claude", (await shown("right")) && !(await dt(page, () => !!document.querySelector(".main > .chat"))));
  // Remembered across a reload at tablet width.
  await page.reload();
  await page.waitForSelector("#dt-canvas");
  await sleep(500);
  check("the tablet choice survives a reload", await shown("right"));
  await ctx.close();
}

// ---------------------------------------------------------------- review fixes: stuck touch, prompts, slow double-tap, phone chat, tabs
{
  const { ctx, page, cdp } = await open(IPAD);
  await create(page, [
    { type: "rectangle", name: "Box", x: 100, y: 100, width: 200, height: 200, fill: "#4F46E5" },
    { type: "rectangle", name: "Box2", x: 100, y: 500, width: 200, height: 200, fill: "#EF4444" },
  ]);
  await page.evaluate(() => window.__dt.setViewport({ zoom: 1, x: 0, y: 0 }));
  await page.waitForTimeout(300);
  const box = await byName(page, "Box");
  const box2 = await byName(page, "Box2");
  const zoomNow = () => dt(page, () => window.__dt.viewport().zoom);
  /** Canvas touch is alive: a tap selects a layer and a one-finger drag moves it (it does not zoom). */
  const alive = async (label) => {
    const r = await rectOf(page, box2.id);
    const z0 = await zoomNow();
    const x0 = (await byName(page, "Box2")).x;
    await dt(page, () => window.__dt.dispatch({ op: "select", ids: [] }));
    await tap(cdp, r.cx, r.cy);
    await sleep(250);
    const sel = (await state(page)).selection;
    check(`${label}: a tap on another layer selects it`, sel.length === 1 && sel[0] === box2.id, JSON.stringify(sel));
    await touch(cdp, "touchStart", [[r.cx, r.cy]]);
    await sleep(60);
    for (let i = 1; i <= 5; i++) await touch(cdp, "touchMove", [[r.cx + i * 10, r.cy]]);
    await sleep(60);
    await touch(cdp, "touchEnd", []);
    await sleep(250);
    check(`${label}: a one-finger drag moves the layer and does not zoom`, Math.abs((await zoomNow()) - z0) < 0.001 && (await byName(page, "Box2")).x > x0 + 20, `zoom ${z0} -> ${await zoomNow()}`);
    await page.keyboard.press("Control+z");
    await sleep(150);
  };

  // Long-press, lift over the menu that opened under the finger, Escape.
  const r = await rectOf(page, box.id);
  await touch(cdp, "touchStart", [[r.cx, r.cy]]);
  await sleep(650);
  const m = await dt(page, () => document.querySelector("[role=menu]")?.getBoundingClientRect().toJSON() ?? null);
  await touch(cdp, "touchMove", [[m ? m.x + 20 : r.cx, m ? m.y + 20 : r.cy]]);
  await touch(cdp, "touchEnd", []);
  await sleep(300);
  await page.keyboard.press("Escape");
  await sleep(250);
  await alive("after a long-press lifted over its menu");

  // A menu item tapped 250 ms after the lift still works (the lift's own click is the only one blocked).
  const r1 = await rectOf(page, box.id);
  const count0 = await dt(page, () => Object.keys(window.__dt.doc().nodes).length);
  await touch(cdp, "touchStart", [[r1.cx, r1.cy]]);
  await sleep(650);
  await touch(cdp, "touchEnd", []);
  await sleep(250);
  const dup = await dt(page, () => {
    const it = [...document.querySelectorAll("[role=menuitem]")].find((e) => /^Duplicate/.test(e.textContent.trim()));
    const b = it?.getBoundingClientRect();
    return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null;
  });
  if (dup) await tap(cdp, dup.x, dup.y);
  await sleep(400);
  check("a menu item tapped 250 ms after the lift runs", dup !== null && (await dt(page, () => Object.keys(window.__dt.doc().nodes).length)) > count0);
  await dt(page, () => window.__dt.dispatch({ op: "select", ids: [] }));
  await page.keyboard.press("Escape");

  // Android: the native contextmenu (at about 400 ms) opens the menu and cancels our timer, so
  // there is no second open (our own path vibrates, the native one does not).
  await page.evaluate(() => {
    window.__vib = 0;
    navigator.vibrate = () => ((window.__vib += 1), true);
  });
  const r3 = await rectOf(page, box.id);
  await touch(cdp, "touchStart", [[r3.cx, r3.cy]]);
  await sleep(380);
  await page.evaluate(([x, y]) => document.elementFromPoint(x, y).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y })), [r3.cx, r3.cy]);
  await sleep(300);
  const nativeMenu = await menuOpen(page);
  await touch(cdp, "touchEnd", []);
  await sleep(250);
  check("a native contextmenu opens the menu and cancels the pending hold", nativeMenu && (await dt(page, () => window.__vib)) === 0, `vibrations ${await dt(page, () => window.__vib)}`);
  await page.keyboard.press("Escape");
  await sleep(200);

  // Pinch whose first finger lifts over an open overlay panel.
  await page.click("#panel-toggle-right");
  await sleep(400);
  await dt(page, () => window.__dt.dispatch({ op: "select", ids: [] }));
  const pr = await rectOf(page, box.id);
  await touch(cdp, "touchStart", [[pr.cx, pr.cy, 1]]);
  await sleep(60);
  await touch(cdp, "touchStart", [[pr.cx, pr.cy, 1], [pr.cx + 60, pr.cy, 2]]);
  await sleep(60);
  await touch(cdp, "touchMove", [[700, 300, 1], [pr.cx + 100, pr.cy, 2]]);
  await sleep(60);
  await touch(cdp, "touchEnd", [[pr.cx + 100, pr.cy, 2]]);
  await sleep(60);
  await touch(cdp, "touchEnd", []);
  await sleep(250);
  await page.evaluate(() => window.__dt.setViewport({ zoom: 1, x: 0, y: 0 }));
  await page.click("#panel-toggle-right");
  await sleep(300);
  await alive("after a pinch whose finger lifted over the overlay");
  await ctx.close();
}
{
  // A hold in the prompt's textarea is the browser's, not the canvas menu.
  const { ctx, page, cdp } = await open(IPAD);
  const ta = await dt(page, () => document.querySelector("#empty-prompt-input")?.getBoundingClientRect().toJSON() ?? null);
  if (ta) {
    await touch(cdp, "touchStart", [[ta.x + 60, ta.y + 30]]);
    await sleep(750);
    await touch(cdp, "touchEnd", []);
    await sleep(250);
  }
  check("a 700 ms hold in the prompt textarea opens no canvas menu", ta !== null && !(await dt(page, () => !!document.querySelector(".menu"))));
  await ctx.close();
}
{
  // A slightly slow double-tap inside the open editor still selects the word.
  const { ctx, page, cdp } = await open(IPAD);
  await create(page, [{ type: "frame", name: "Card", x: 0, y: 0, width: 400, height: 300, fill: "#FFFFFF", children: [{ type: "text", name: "Title", x: 40, y: 120, text: "Hello world", fontSize: 28, fontWeight: 700, color: "#111111" }] }]);
  const title = await byName(page, "Title");
  const card = await byName(page, "Card");
  await dt(page, (id) => window.__dt.tool("select", { ids: [id] }), card.id);
  await page.keyboard.press("Shift+2");
  await sleep(400);
  const t = await rectOf(page, title.id);
  await tap(cdp, t.cx, t.cy);
  await sleep(120);
  await tap(cdp, t.cx, t.cy);
  await sleep(600);
  await tap(cdp, t.l + 10, t.cy, 60);
  await sleep(700);
  await tap(cdp, t.l + 20, t.cy, 80);
  await sleep(280);
  await tap(cdp, t.l + 20, t.cy, 80);
  await sleep(400);
  const sel = await dt(page, () => {
    const ta = document.querySelector(".text-editor");
    return ta ? [ta.selectionStart, ta.selectionEnd] : null;
  });
  check("inside the editor a slow double-tap (80 ms hold, 280 ms pause) still selects the word", sel !== null && sel[1] > sel[0] && sel[1] - sel[0] < 11, JSON.stringify(sel));
  await ctx.close();
}
{
  // The phone's Claude sheet is full width.
  const { ctx, page } = await open(devices["iPhone 14 Pro Max"]);
  await page.click("#claude-toggle");
  await sleep(400);
  const w = await dt(page, () => ({ chat: document.querySelector(".main > .chat")?.getBoundingClientRect().width ?? 0, win: innerWidth, shadow: document.querySelector(".main > .chat") ? getComputedStyle(document.querySelector(".main > .chat")).boxShadow : "" }));
  check("phone: the Claude sheet spans the full width", Math.abs(w.chat - w.win) < 1 && w.shadow === "none", JSON.stringify(w));
  await ctx.close();
}
for (const [w, h] of [[834, 1194], [1024, 768]]) {
  // Every tab of an overlay panel can be hit: the close button covers none of them.
  const { ctx, page } = await open({ ...IPAD, viewport: { width: w, height: h }, screen: { width: w, height: h } });
  for (const side of ["left", "right"]) {
    await page.click(`#panel-toggle-${side}`);
    await sleep(300);
    const bad = await dt(page, (s) => {
      const panel = document.querySelector(s === "left" ? ".main > .panel:not(.right)" : ".main > .panel.right");
      const out = [];
      const tabsRight = panel.querySelector(".tabs").getBoundingClientRect().right;
      for (const tab of panel.querySelectorAll("[role=tab]")) {
        if (tab.getBoundingClientRect().right > tabsRight + 0.5) out.push(`${tab.textContent} runs past the tab row`);
        tab.scrollIntoView({ inline: "nearest" });
        const r = tab.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (hit !== tab && !tab.contains(hit)) out.push(tab.textContent);
      }
      return out;
    }, side);
    check(`${w} px: no tab of the ${side} overlay is covered`, bad.length === 0, bad.join(", "));
    await page.click(`#panel-toggle-${side}`);
    await sleep(200);
  }
  await ctx.close();
}
{
  // Ctrl+\ twice leaves Claude open at 1101-1280 px.
  const { ctx, page } = await open({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
  await page.click("#claude-toggle");
  await sleep(300);
  await page.keyboard.press("Control+\\");
  await sleep(200);
  await page.keyboard.press("Control+\\");
  await sleep(300);
  check("Ctrl+\\ twice at 1200 px keeps Claude open", await dt(page, () => !!document.querySelector(".main > .chat")));
  await ctx.close();
}

// ---------------------------------------------------------------- toolbar fit
async function toolbarFit(label, device, scheme) {
  const { ctx, page } = await open(device, { scheme });
  const r = await dt(page, () => {
    const top = document.querySelector(".topbar");
    const leaves = [...top.querySelectorAll("button, input, .save-state, .file-loc")].filter((e) => e.getClientRects().length && getComputedStyle(e).visibility !== "hidden");
    const boxes = leaves.map((e) => ({ e, r: e.getBoundingClientRect() })).filter((x) => x.r.width > 0 && x.r.height > 0);
    const overlaps = [];
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i].r;
        const b = boxes[j].r;
        if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) overlaps.push(`${boxes[i].e.getAttribute("title") || boxes[i].e.className} x ${boxes[j].e.getAttribute("title") || boxes[j].e.className}`);
      }
    const wrapped = [...top.querySelectorAll(".tbtn")].filter((e) => e.getClientRects().length && e.getBoundingClientRect().height > 40).map((e) => e.textContent);
    const out = boxes.filter((x) => x.r.right > innerWidth + 0.5 || x.r.left < -0.5).map((x) => x.e.getAttribute("title") || x.e.className);
    return { overlaps, wrapped, out, scrollW: document.documentElement.scrollWidth, w: innerWidth, name: document.querySelector(".topbar .filename")?.getBoundingClientRect().width ?? 0 };
  });
  check(`toolbar ${label}: no two items overlap`, r.overlaps.length === 0, r.overlaps.join("; "));
  check(`toolbar ${label}: no button wraps onto two lines`, r.wrapped.length === 0, r.wrapped.join("; "));
  check(`toolbar ${label}: nothing runs past the edge and the page does not scroll sideways`, r.out.length === 0 && r.scrollW <= r.w, `${r.out.join("; ")} scrollW ${r.scrollW} / ${r.w}`);
  if (device !== PHONE) check(`toolbar ${label}: the file name keeps some room`, r.name >= 60, `${r.name}`);
  return { ctx, page };
}
for (const [label, device] of [["iPad portrait", IPAD], ["iPad landscape", IPAD_L], ["phone", PHONE], ["1100 px", { viewport: { width: 1100, height: 800 }, deviceScaleFactor: 2 }], ["1101 px", { viewport: { width: 1101, height: 800 }, deviceScaleFactor: 2 }], ["900 px", { viewport: { width: 900, height: 800 }, deviceScaleFactor: 2 }]]) {
  const { ctx } = await toolbarFit(label, device, "dark");
  await ctx.close();
}

// Screenshots at 834, 1024 and 1194, dark and light.
for (const scheme of ["dark", "light"]) {
  for (const [w, h] of [[834, 1194], [1024, 768], [1194, 834]]) {
    const { ctx, page } = await open({ ...IPAD, viewport: { width: w, height: h }, screen: { width: w, height: h } }, { scheme });
    await create(page, [{ type: "frame", name: "Card", x: 0, y: 0, width: 360, height: 240, fill: "#FFFFFF", children: [{ type: "text", name: "T", x: 30, y: 30, text: "Tablet layout", fontSize: 28, color: "#111111" }] }]);
    await page.keyboard.press("Shift+1");
    const card = await byName(page, "Card");
    await dt(page, (id) => window.__dt.tool("select", { ids: [id] }), card.id);
    if (w <= 1100) {
      await page.click("#panel-toggle-right");
      await page.waitForTimeout(300);
    }
    await page.screenshot({ path: `${OUT}/r13c-${w}-${scheme}.png` });
    await ctx.close();
  }
}
{
  const { ctx, page } = await open(PHONE);
  await page.screenshot({ path: `${OUT}/r13c-phone.png` });
  // r19c: phones now have the Layers and Design toggles (bottom sheets).
  check("phone: panel toggles open bottom sheets (r19c)", await dt(page, () => !!document.querySelector(".panel-toggle") && getComputedStyle(document.querySelector(".panel-toggle")).display !== "none"));
  await ctx.close();
}

// ---------------------------------------------------------------- desktop 1440x900 unchanged, Ctrl+\
{
  const { ctx, page } = await open(DESKTOP);
  await create(page, [{ type: "frame", name: "Parent", x: 0, y: 0, width: 400, height: 300, fill: "#FFFFFF", children: [{ type: "rectangle", name: "Child", x: 20, y: 20, width: 100, height: 100, fill: "#EF4444" }] }]);
  const cols = await dt(page, () => {
    const l = document.querySelector(".main > .panel:not(.right)").getBoundingClientRect();
    const rr = document.querySelector(".main > .panel.right").getBoundingClientRect();
    const c = document.getElementById("dt-canvas").getBoundingClientRect();
    const pos = [...document.querySelectorAll(".main > .panel")].map((p) => getComputedStyle(p).position);
    return { l: l.width, r: rr.width, c: c.width, left: c.left, pos, closeShown: [...document.querySelectorAll(".panel-close")].some((b) => b.getClientRects().length) };
  });
  check("1440: columns are 248 and 272 and the panels are in flow", cols.l === 248 && cols.r === 272 && cols.c === 1440 - 248 - 272 && cols.pos.every((p) => p === "static"), JSON.stringify(cols));
  check("1440: the panels do not cover the canvas and have no close button", cols.left === 248 && !cols.closeShown);
  check("1440: both toggles show the panels as open", await dt(page, () => ["left", "right"].every((s) => document.getElementById(`panel-toggle-${s}`).getAttribute("aria-expanded") === "true")));
  const v0 = await dt(page, () => window.__dt.viewport());
  await page.keyboard.press("Control+\\");
  await sleep(400);
  const hidden = await dt(page, () => ({ c: document.getElementById("dt-canvas").getBoundingClientRect().width, left: document.querySelector(".main > .panel:not(.right)").getBoundingClientRect().width }));
  check("Ctrl+\\ hides both panels (canvas is 1440 wide)", hidden.c === 1440 && hidden.left === 0, JSON.stringify(hidden));
  check("hidden panels leave the tab order", await dt(page, () => getComputedStyle(document.querySelector(".main > .panel.right")).visibility === "hidden"));
  await page.screenshot({ path: `${OUT}/r13c-desktop-hidden.png` });
  await page.keyboard.press("Control+\\");
  await sleep(400);
  const back = await dt(page, () => ({ c: document.getElementById("dt-canvas").getBoundingClientRect().width, l: document.querySelector(".main > .panel:not(.right)").getBoundingClientRect().width }));
  check("a second Ctrl+\\ restores them", back.c === 1440 - 248 - 272 && back.l === 248, JSON.stringify(back));
  void v0;
  // Toggle buttons on desktop.
  await page.click("#panel-toggle-left");
  await sleep(300);
  check("the Layers toggle hides the column on a desktop", (await dt(page, () => document.getElementById("dt-canvas").getBoundingClientRect().left)) === 0);
  await page.click("#panel-toggle-left");
  await sleep(300);
  // The page point at the canvas centre stays at the centre when a column opens or closes.
  await page.evaluate(() => window.__dt.setViewport({ zoom: 1, x: 100, y: 50 }));
  const centre = () => dt(page, () => { const v = window.__dt.viewport(); const c = document.getElementById("dt-canvas").getBoundingClientRect(); return (c.width / 2 - v.x) / v.zoom; });
  const c0 = await centre();
  await page.click("#panel-toggle-right");
  await sleep(400);
  const c1 = await centre();
  await page.click("#panel-toggle-right");
  await sleep(400);
  check("a column opening or closing keeps the page point at the canvas centre", Math.abs(c0 - c1) < 1 && Math.abs((await centre()) - c0) < 1, `${c0} ${c1}`);
  // Plain \ selects the parent.
  const child = await byName(page, "Child");
  const parent = await byName(page, "Parent");
  await dt(page, (id) => window.__dt.tool("select", { ids: [id] }), child.id);
  await page.focus("#dt-canvas");
  await page.keyboard.press("\\");
  await sleep(200);
  const sel = (await state(page)).selection;
  check("plain \\ with a child selected still selects its parent", sel.length === 1 && sel[0] === parent.id);
  // Shortcuts dialog lists it.
  await page.keyboard.press("?");
  await sleep(300);
  check("the shortcuts dialog lists Ctrl+\\", await dt(page, () => /Show \/ hide the side panels/.test(document.querySelector(".shortcuts-dialog")?.textContent ?? "")));
  await ctx.close();
}
// 1101 px is still a desktop layout: columns, not overlays.
{
  const { ctx, page } = await open({ viewport: { width: 1101, height: 800 }, deviceScaleFactor: 1 });
  check("1101 px: the panels are columns that do not cover the canvas", await dt(page, () => [...document.querySelectorAll(".main > .panel")].every((p) => getComputedStyle(p).position === "static") && document.getElementById("dt-canvas").getBoundingClientRect().left === 248));
  await ctx.close();
}
{
  const { ctx, page } = await open({ viewport: { width: 1100, height: 800 }, deviceScaleFactor: 1 });
  check("1100 px: the panels are closed overlays", await dt(page, () => [...document.querySelectorAll(".main > .panel")].every((p) => !p.getClientRects().length) && document.getElementById("dt-canvas").getBoundingClientRect().width >= 1100));
  await ctx.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
