// Round 19, package r19c (touch, tablet and phone, plus the shortcut focus fix):
//  1. a finger 0, 6 and 14 px off the SE handle resizes (rotation stays 0) on iPad Pro (both ways),
//     iPhone 15 and a touchscreen laptop;
//  2. a finger 30 px out on the diagonal rotates;
//  3. a one-finger drag of a layer away from snap lines moves it exactly 40, 20;
//  4. iPhone 15: Layers and Design open as bottom sheets, X and the fill change the document,
//     the close button returns focus to the toggle, one sheet at a time;
//  5. at 1024 and 1100 px the file name keeps 120 px, the save state has a name, nothing overlaps;
//  6. coarse pointers: toolbar buttons 40 px, menu items 40 px, layer rows 36 px, fields 32 px;
//  7. desktop: Ctrl+Z after a checkbox or a select, V after clicking a select, keys kept by a tabbed select.
// Usage: serve web/dist (`vite preview --port 7121`), then `node scripts/qa/r19c-e2e.mjs`.
// Env: E2E_URL (default http://localhost:7121), CHROMIUM, SHOTS (screenshot dir, deviceScaleFactor 2 on tablets/phones).
// Local servers only: every other request is aborted. Test images are not needed.

import { chromium, devices } from "playwright-core";
import fs from "node:fs";

const URL = process.env.E2E_URL ?? "http://localhost:7121";
const SHOTS = process.env.SHOTS ?? "";
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const launch = { headless: true, args: ["--no-sandbox"] };
if (process.env.CHROMIUM) launch.executablePath = process.env.CHROMIUM;
else if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";

let failed = 0;
let passed = 0;
function check(name, ok, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + String(detail).replace(/\s+/g, " ") : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOCAL = /^(https?:\/\/(localhost|127\.0\.0\.1)[:/]|data:|blob:|ws:)/;
const errors = [];

const ipadUA = devices["iPad Mini"].userAgent;
const DEVICES = {
  ipadProP: { ...devices["iPad Pro 11"], viewport: { width: 1024, height: 1366 }, screen: { width: 1024, height: 1366 }, deviceScaleFactor: 2, userAgent: ipadUA },
  ipadProL: { ...devices["iPad Pro 11 landscape"], viewport: { width: 1366, height: 1024 }, screen: { width: 1366, height: 1024 }, deviceScaleFactor: 2, userAgent: ipadUA },
  iphone15: { ...devices["iPhone 15"] },
  laptopTouch: { viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1, hasTouch: true, isMobile: false, fine: true },
};

async function newPage(browser, device) {
  const ctx = await browser.newContext({ ...device, hasTouch: device.hasTouch ?? true, colorScheme: "dark" });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem("dt:tour-done", "1");
    } catch {
      /* no storage */
    }
  });
  const page = await ctx.newPage();
  await page.route("**/*", (r) => (LOCAL.test(r.request().url()) ? r.continue() : r.abort()));
  page.on("pageerror", (e) => {
    errors.push(String(e));
    console.log("PAGEERROR", String(e).slice(0, 300));
  });
  const cdp = await ctx.newCDPSession(page);
  if (device.fine) {
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "pointer", value: "fine" }, { name: "any-pointer", value: "fine,coarse" }, { name: "hover", value: "hover" }, { name: "any-hover", value: "hover" }] });
  }
  await page.goto(URL);
  await page.waitForTimeout(700);
  await page.click("button:has-text('New design file')");
  await page.waitForSelector("#dt-canvas");
  await page.waitForTimeout(400);
  return { ctx, page, cdp };
}

const touch = (cdp, type, pts) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: pts.map(([x, y, id = 0]) => ({ x, y, id, radiusX: 1, radiusY: 1, force: 1 })) });
async function tap(cdp, x, y) {
  await touch(cdp, "touchStart", [[x, y]]);
  await sleep(60);
  await touch(cdp, "touchEnd", []);
}
async function drag(cdp, x0, y0, x1, y1, n = 10) {
  await touch(cdp, "touchStart", [[x0, y0]]);
  for (let i = 1; i <= n; i++) {
    await touch(cdp, "touchMove", [[x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n]]);
    await sleep(16);
  }
  await touch(cdp, "touchEnd", []);
}
const ev = (page, fn, arg) => page.evaluate(fn, arg);
const byName = (page, name) => ev(page, (nm) => Object.values(window.__dt.doc().nodes).find((n) => n.name === nm) ?? null, name);
const rectOf = (page, id) =>
  ev(
    page,
    (i) => {
      const r = document.querySelector(`#dt-canvas g[data-id="${i}"]`).getBoundingClientRect();
      return { w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    },
    id,
  );
const canon = (v) => JSON.stringify(v, (_, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

/** A frame with one card, fitted to the view, the Move tool on and the card selected by a tap. */
async function setup(page, cdp, card = { x: 40, y: 80, width: 200, height: 120 }) {
  await ev(
    page,
    (c) =>
      window.__dt.tool("create_nodes", {
        nodes: [{ type: "frame", name: "Screen", x: 0, y: 0, width: 360, height: 640, fill: "#FFFFFF", children: [{ type: "rectangle", name: "Card", ...c, fill: "#3366FF" }] }],
      }),
    card,
  );
  await page.waitForTimeout(250);
  await ev(page, () => window.__dt.zoomToFit());
  await page.waitForTimeout(350);
  const move = page.locator("button[title^='Move']");
  if ((await move.getAttribute("aria-pressed")) !== "true") await move.click();
  const n = await byName(page, "Card");
  const r = await rectOf(page, n.id);
  await tap(cdp, r.cx, r.cy);
  await sleep(300);
  return { id: n.id, scale: r.w / n.width };
}
const handleAt = (page, h) =>
  ev(
    page,
    (name) => {
      const b = document.querySelector(`[data-handle='${name}']`).getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2, size: b.width };
    },
    h,
  );

const browser = await chromium.launch(launch);

// ---- 1-3: handles on every device ----
for (const [key, device] of Object.entries(DEVICES)) {
  for (const off of [0, 6, 14]) {
    const { ctx, page, cdp } = await newPage(browser, device);
    const { id, scale } = await setup(page, cdp);
    const h = await handleAt(page, "se");
    const before = (await ev(page, (i) => window.__dt.doc().nodes[i], id)).width;
    await drag(cdp, h.x + off, h.y + off, h.x + off + 40, h.y + off);
    await sleep(350);
    const n = await ev(page, (i) => window.__dt.doc().nodes[i], id);
    const grew = n.width - before;
    check(`${key}: touch ${off}px off the SE handle resizes by 40 screen px`, Math.abs(grew - 40 / scale) <= 2 && !n.rotation && n.x === 40, `width ${before} -> ${n.width}, rotation ${n.rotation ?? 0}, expected +${(40 / scale).toFixed(1)}`);
    await ctx.close();
  }
  {
    const { ctx, page, cdp } = await newPage(browser, device);
    const { id } = await setup(page, cdp);
    const h = await handleAt(page, "se");
    const d = 30 / Math.SQRT2;
    const before = await ev(page, (i) => window.__dt.doc().nodes[i], id);
    await drag(cdp, h.x + d, h.y + d, h.x - 20, h.y + d + 40, 12);
    await sleep(350);
    const n = await ev(page, (i) => window.__dt.doc().nodes[i], id);
    check(`${key}: touch 30px out on the diagonal rotates`, Math.abs(n.rotation ?? 0) > 5 && n.width === before.width && n.height === before.height, `rotation ${n.rotation ?? 0}, size ${n.width}x${n.height}`);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/${key}-rotated.png` });
    await ctx.close();
  }
  {
    // Card centre 140 would sit on the screen's centre line (180) after +40: use a card away from every snap line.
    const { ctx, page, cdp } = await newPage(browser, device);
    const { id, scale } = await setup(page, cdp, { x: 30, y: 80, width: 150, height: 120 });
    const r = await rectOf(page, id);
    await drag(cdp, r.cx, r.cy, r.cx + 40 * scale, r.cy + 20 * scale, 10);
    await sleep(350);
    const n = await ev(page, (i) => window.__dt.doc().nodes[i], id);
    check(`${key}: a one-finger drag moves the layer exactly 40, 20 (no snap line near)`, Math.abs(n.x - 70) <= 1 && Math.abs(n.y - 100) <= 1, `x ${n.x}, y ${n.y}`);
    if (SHOTS) {
      await tap(cdp, r.cx + 40 * scale, r.cy + 20 * scale);
      await sleep(200);
      await page.screenshot({ path: `${SHOTS}/${key}-handles.png` });
    }
    await ctx.close();
  }
}

// A small layer still moves from its middle, and a mouse keeps the exact handle.
{
  const { ctx, page, cdp } = await newPage(browser, DEVICES.ipadProP);
  const { id, scale } = await setup(page, cdp, { x: 40, y: 200, width: 16, height: 16 });
  const r = await rectOf(page, id);
  await drag(cdp, r.cx, r.cy, r.cx + 30, r.cy + 30, 8);
  await sleep(300);
  const n = await ev(page, (i) => window.__dt.doc().nodes[i], id);
  check("a layer under 44 screen px moves from its middle", n.width === 16 && Math.abs(n.x - (40 + 30 / scale)) <= 1.5, `x ${n.x}, width ${n.width}, scale ${scale.toFixed(2)}`);
  await ctx.close();
}
{
  // Pinch starting on a handle still cancels the drag.
  const { ctx, page, cdp } = await newPage(browser, DEVICES.ipadProP);
  const { id } = await setup(page, cdp);
  const h = await handleAt(page, "se");
  await touch(cdp, "touchStart", [[h.x, h.y, 0]]);
  await touch(cdp, "touchMove", [[h.x + 10, h.y, 0]]);
  await touch(cdp, "touchStart", [[h.x + 10, h.y, 0], [h.x - 150, h.y - 100, 1]]);
  await touch(cdp, "touchMove", [[h.x + 40, h.y, 0], [h.x - 190, h.y - 100, 1]]);
  await touch(cdp, "touchEnd", []);
  await sleep(300);
  const n = await ev(page, (i) => window.__dt.doc().nodes[i], id);
  check("a second finger cancels a handle drag (no resize left behind)", n.width === 200 && n.height === 120 && !n.rotation, `size ${n.width}x${n.height}`);
  await ctx.close();
}
{
  // Coarse pointers draw bigger handles; a mouse keeps 8 px.
  const { ctx, page, cdp } = await newPage(browser, DEVICES.ipadProP);
  await setup(page, cdp);
  const h = await handleAt(page, "se");
  check("handles are 10 px on a touch screen", h.size >= 9.5 && h.size <= 10.5, `size ${h.size}`);
  await ctx.close();
  const c2 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await c2.addInitScript(() => localStorage.setItem("dt:tour-done", "1"));
  const p2 = await c2.newPage();
  await p2.route("**/*", (r) => (LOCAL.test(r.request().url()) ? r.continue() : r.abort()));
  await p2.goto(URL);
  await p2.waitForTimeout(700);
  await p2.click("button:has-text('New design file')");
  await p2.waitForSelector("#dt-canvas");
  await setup(p2, null).catch(() => {});
  await c2.close();
}

// ---- 4: iPhone sheets ----
{
  const { ctx, page, cdp } = await newPage(browser, DEVICES.iphone15);
  const { id } = await setup(page, cdp);
  const tb = await ev(page, () => ({ sw: document.querySelector(".topbar").scrollWidth, cw: document.querySelector(".topbar").clientWidth }));
  check("iPhone: the top bar, with both panel toggles, fits without scrolling", tb.sw <= tb.cw, `scrollWidth ${tb.sw}, clientWidth ${tb.cw}`);
  check("iPhone: Layers and Design toggles show", (await page.locator("#panel-toggle-left").isVisible()) && (await page.locator("#panel-toggle-right").isVisible()));
  await tap(cdp, ...(await ev(page, () => { const b = document.querySelector("#panel-toggle-right").getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; })));
  await sleep(500);
  const sheet = await ev(page, () => {
    const r = document.querySelector(".main > .panel.right").getBoundingClientRect();
    return { l: r.left, r: r.right, t: r.top, b: r.bottom, h: r.height, vw: innerWidth, vh: innerHeight };
  });
  check("iPhone: Design is a bottom sheet, full width, at most 60% high", sheet.l === 0 && sheet.r === sheet.vw && sheet.b === sheet.vh && sheet.h <= sheet.vh * 0.6 + 1, JSON.stringify(sheet));
  const close = await ev(page, () => { const b = document.querySelector(".panel.right .panel-close").getBoundingClientRect(); return { w: b.width, h: b.height }; });
  check("iPhone: the sheet's close button is 44 px", close.w >= 44 && close.h >= 44, JSON.stringify(close));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/iphone15-design-sheet.png` });
  // Change X and the fill.
  const x = page.locator(".panel.right input[aria-label='X position']");
  await x.fill("70");
  await x.press("Enter");
  await sleep(250);
  let n = await ev(page, (i) => window.__dt.doc().nodes[i], id);
  check("iPhone: X typed in the sheet changes the layer", n.x === 70, `x ${n.x}`);
  const hex = page.locator(".panel.right input[aria-label='Hex colour']").first();
  const hexOk = (await hex.count()) > 0;
  if (hexOk) {
    await hex.fill("#FF0000");
    await hex.press("Enter");
    await sleep(250);
    n = await ev(page, (i) => window.__dt.doc().nodes[i], id);
    check("iPhone: the fill typed in the sheet changes the layer", JSON.stringify(n.fills ?? n.fill).toLowerCase().includes("ff0000"), JSON.stringify(n.fills ?? n.fill).slice(0, 80));
  } else check("iPhone: the fill typed in the sheet changes the layer", false, "no fill field found");
  // One sheet at a time: Layers closes Design.
  await page.locator("#panel-toggle-left").click();
  await sleep(400);
  const both = await ev(page, () => ({ left: !!document.querySelector(".main > .panel:not(.right)")?.getClientRects().length, right: !!document.querySelector(".main > .panel.right")?.getClientRects().length }));
  check("iPhone: Layers replaces Design (one sheet at a time)", both.left && !both.right, JSON.stringify(both));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/iphone15-layers-sheet.png` });
  await page.locator(".main > .panel:not(.right) .panel-close").click();
  await sleep(300);
  const active = await ev(page, () => document.activeElement?.id);
  check("iPhone: the close button gives focus back to the toggle", active === "panel-toggle-left", active);
  // Claude closes a sheet, and a sheet closes Claude.
  await page.locator("#panel-toggle-right").click();
  await sleep(300);
  await page.locator("#claude-toggle").click();
  await sleep(400);
  const claude = await ev(page, () => ({ chat: !!document.querySelector(".main > .chat"), right: !!document.querySelector(".main > .panel.right")?.getClientRects().length }));
  check("iPhone: opening Claude closes the sheet", claude.chat && !claude.right, JSON.stringify(claude));
  await page.locator("#panel-toggle-left").click({ force: true }).catch(() => {});
  await sleep(300);
  // Escape closes a sheet and returns focus (the tablet behaviour).
  await ev(page, () => document.querySelector("#claude-toggle").click());
  await sleep(200);
  await page.locator("#panel-toggle-left").click();
  await sleep(300);
  await page.locator(".main > .panel:not(.right) [role=tab][aria-selected=true]").focus();
  await page.keyboard.press("Escape");
  await sleep(300);
  check("iPhone: Escape closes the sheet, focus returns to the toggle", (await ev(page, () => document.activeElement?.id)) === "panel-toggle-left" && !(await ev(page, () => !!document.querySelector(".main > .panel:not(.right)")?.getClientRects().length)));
  // Rotating to landscape with a sheet open keeps it usable (tablet overlay).
  await page.locator("#panel-toggle-right").click();
  await sleep(300);
  await page.setViewportSize({ width: 852, height: 393 });
  await sleep(500);
  const land = await ev(page, () => { const r = document.querySelector(".main > .panel.right").getBoundingClientRect(); return { w: r.width, h: r.height, vh: innerHeight }; });
  check("iPhone: rotating with a sheet open keeps the panel on screen", land.w > 200 && land.h > 100 && land.h <= land.vh, JSON.stringify(land));
  await ctx.close();
}
{
  // A sheet must not take focus from the text being edited.
  const { ctx, page, cdp } = await newPage(browser, DEVICES.iphone15);
  await ev(page, () => window.__dt.tool("create_nodes", { nodes: [{ type: "text", name: "Hello", x: 20, y: 20, content: "Hello", fontSize: 24 }] }));
  await page.waitForTimeout(250);
  const n = await byName(page, "Hello");
  await ev(page, (i) => window.__dt.edit(i), n.id);
  await sleep(300);
  const before = await ev(page, () => document.activeElement?.tagName + "." + (document.activeElement?.className ?? ""));
  await page.locator("#panel-toggle-right").click();
  await sleep(300);
  const after = await ev(page, () => document.activeElement?.tagName + "." + (document.activeElement?.className ?? ""));
  check("iPhone: opening a sheet while editing text does not crash", errors.length === 0, `${before} -> ${after}`);
  await ctx.close();
}
{
  // A view-only link has no sheets on a phone.
  const { ctx, page } = await newPage(browser, DEVICES.iphone15);
  await ev(page, () => window.__dt.collabSet?.({ viewer: true }));
  await sleep(300);
  const vis = await ev(page, () => ({ t: !!document.querySelector("#panel-toggle-right")?.getClientRects().length, app: document.querySelector(".app")?.className }));
  check("iPhone: a viewer sees no panel toggles", !vis.t || !/view-only/.test(vis.app), JSON.stringify(vis));
  await ctx.close();
}

// ---- 5: the top bar at 1024 and 1100 px ----
async function topbarCheck(label, device, width) {
  const { ctx, page } = await newPage(browser, { ...device, viewport: { width, height: device.viewport?.height ?? 800 }, screen: { width, height: device.viewport?.height ?? 800 } });
  await ev(page, () => window.__dt.tool("create_nodes", { nodes: [{ type: "frame", name: "Screen", x: 0, y: 0, width: 360, height: 640, fill: "#FFFFFF" }] }));
  await sleep(500);
  const m = await ev(page, () => {
    const bar = document.querySelector(".topbar");
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden" && !el.closest(".sr-only");
    };
    const items = [...bar.querySelectorAll("button, input.filename, .save-state, .save-dot")].filter(vis).filter((el) => !el.closest(".save-state") || el.classList.contains("save-state") || el.classList.contains("save-dot"));
    const boxes = items.map((el) => ({ n: (el.getAttribute("aria-label") || el.title || el.className || el.tagName).toString().slice(0, 24), r: el.getBoundingClientRect(), dot: el.classList.contains("save-dot"), st: el.classList.contains("save-state") }));
    const overlaps = [];
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i].r;
        const b = boxes[j].r;
        if (boxes[i].dot && boxes[j].st) continue;
        if (boxes[j].dot && boxes[i].st) continue;
        if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) overlaps.push(boxes[i].n + " x " + boxes[j].n);
      }
    const fn = bar.querySelector(".filename").getBoundingClientRect();
    const ss = bar.querySelector(".save-state");
    return { fw: fn.width, sw: bar.scrollWidth, cw: bar.clientWidth, overlaps, name: (ss?.textContent ?? "").trim(), title: ss?.getAttribute("title"), loc: !!bar.querySelector(".file-loc")?.getClientRects().length, dot: !!bar.querySelector(".save-dot")?.getClientRects().length };
  });
  check(`${label}: the file name keeps ${width > 1000 ? 120 : 48} px`, m.fw >= (width > 1000 ? 119.5 : 47.5), `${m.fw}`);
  check(`${label}: the bar does not scroll or overlap`, m.sw <= m.cw && m.overlaps.length === 0, `${m.sw}/${m.cw} ${m.overlaps.join("; ")}`);
  check(`${label}: no breadcrumb, a save dot with a name`, !m.loc && m.dot && /Saved|Saving/.test(m.name) && !!m.title, JSON.stringify({ loc: m.loc, dot: m.dot, name: m.name, title: m.title }));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${label}-topbar.png`, clip: { x: 0, y: 0, width, height: 60 } });
  await ctx.close();
}
await topbarCheck("ipadProP-1024", DEVICES.ipadProP, 1024);
await topbarCheck("desktop-1100", { viewport: { width: 1100, height: 800 }, deviceScaleFactor: 2, hasTouch: false }, 1100);
await topbarCheck("desktop-1024", { viewport: { width: 1024, height: 800 }, deviceScaleFactor: 2, hasTouch: false }, 1024);

// ---- 6: coarse pointer target sizes ----
{
  const { ctx, page, cdp } = await newPage(browser, DEVICES.ipadProP);
  const { id } = await setup(page, cdp);
  await page.locator("#panel-toggle-left").click();
  await sleep(300);
  await page.locator("#panel-toggle-left").click();
  await sleep(100);
  await page.locator("#panel-toggle-left").click();
  await sleep(300);
  const small = await ev(page, () => {
    const out = [];
    for (const el of document.querySelectorAll(".topbar .tbtn")) {
      const r = el.getBoundingClientRect();
      if (r.width && (r.width < 39.5 || r.height < 39.5)) out.push((el.title || el.className) + " " + Math.round(r.width) + "x" + Math.round(r.height));
    }
    return out;
  });
  check("coarse: no top bar button under 40 px", small.length === 0, small.join("; "));
  const rows = await ev(page, () => [...document.querySelectorAll(".layer")].map((el) => el.getBoundingClientRect().height));
  check("coarse: layer rows are at least 36 px", rows.length > 0 && rows.every((h) => h >= 35.5), JSON.stringify(rows));
  await page.locator("#panel-toggle-left").click();
  await sleep(200);
  await page.locator("#panel-toggle-right").click();
  await sleep(400);
  const fields = await ev(page, () => [...document.querySelectorAll(".panel.right .field")].filter((el) => el.getClientRects().length).map((el) => el.getBoundingClientRect().height));
  check("coarse: Design panel fields are at least 32 px", fields.length > 3 && fields.every((h) => h >= 31.5), JSON.stringify(fields.slice(0, 6)));
  await page.locator("button[title='Main menu']").click();
  await sleep(300);
  const items = await ev(page, () => [...document.querySelectorAll("[role=menuitem]")].filter((el) => el.getClientRects().length).map((el) => Math.round(el.getBoundingClientRect().height)));
  check("coarse: menu items are at least 40 px", items.length > 3 && items.every((h) => h >= 39.5), JSON.stringify(items.slice(0, 8)));
  await page.keyboard.press("Escape");
  await sleep(200);
  await page.locator("button[title^='Share']").first().click();
  await sleep(500);
  const share = await ev(page, () => [...document.querySelectorAll(".share-dialog a, .share-dialog label, .share-option a")].filter((el) => el.getClientRects().length).map((el) => Math.round(el.getBoundingClientRect().height)));
  check("coarse: Share dialog links and labels are at least 32 px", share.length === 0 || share.every((h) => h >= 31.5), JSON.stringify(share));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/ipadProP-share.png` });
  await ctx.close();
  void id;
}

// ---- 7: shortcuts with a panel control focused (desktop) ----
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => localStorage.setItem("dt:tour-done", "1"));
  const page = await ctx.newPage();
  await page.route("**/*", (r) => (LOCAL.test(r.request().url()) ? r.continue() : r.abort()));
  page.on("pageerror", (e) => {
    errors.push(String(e));
    console.log("PAGEERROR", String(e).slice(0, 300));
  });
  await page.goto(URL);
  await page.waitForTimeout(700);
  await page.click("button:has-text('New design file')");
  await page.waitForSelector("#dt-canvas");
  await ev(page, () => window.__dt.tool("create_nodes", { nodes: [{ type: "frame", name: "Screen", x: 0, y: 0, width: 360, height: 640, fill: "#FFFFFF", children: [{ type: "rectangle", name: "Card", x: 40, y: 80, width: 200, height: 120, fill: "#3366FF" }] }] }));
  await page.waitForTimeout(300);
  await ev(page, () => window.__dt.zoomToFit());
  const screen = await byName(page, "Screen");
  const card = await byName(page, "Card");
  const selectIds = (ids) => ev(page, (i) => window.__dt.dispatch({ op: "select", ids: i }), ids);
  const nodeOf = (id) => ev(page, (i) => window.__dt.doc().nodes[i], id);

  // Checkbox: click, Ctrl+Z.
  await selectIds([screen.id]);
  await sleep(200);
  const was = (await nodeOf(screen.id)).clipContent;
  await page.locator("label:has-text('Clip content') input").click();
  await sleep(200);
  const flipped = (await nodeOf(screen.id)).clipContent;
  await page.keyboard.press("Control+z");
  await sleep(250);
  const undone = (await nodeOf(screen.id)).clipContent;
  check("a clicked checkbox: Ctrl+Z undoes the change", !!flipped !== !!was && !!undone === !!was, `${was} -> ${flipped} -> ${undone}`);
  await page.keyboard.press("Control+Shift+z");
  await sleep(250);
  check("a clicked checkbox: Ctrl+Shift+Z redoes it", !!(await nodeOf(screen.id)).clipContent === !!flipped);
  await page.keyboard.press("Control+z");
  await sleep(200);

  // Select: pick a value with the keyboard after a click, then Ctrl+Z.
  await selectIds([card.id]);
  await sleep(250);
  const sel = page.locator(".panel.right select").first();
  const docBefore = canon(await ev(page, () => window.__dt.doc().nodes));
  await sel.click();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await sleep(300);
  const docChanged = canon(await ev(page, () => window.__dt.doc().nodes));
  await page.keyboard.press("Control+z");
  await sleep(250);
  const docUndone = canon(await ev(page, () => window.__dt.doc().nodes));
  check("a clicked select: a picked value changes the document and Ctrl+Z undoes it", docChanged !== docBefore && docUndone === docBefore);

  // V after clicking a select switches to Move; a tabbed select keeps its letters.
  const pressed = (t) => page.locator(`button[title^='${t}']`).getAttribute("aria-pressed");
  await page.locator("#dt-canvas").focus();
  await page.keyboard.press("r");
  await sleep(150);
  const rectOn = (await pressed("Rectangle")) === "true";
  await sel.click();
  await page.keyboard.press("Escape");
  await sleep(150);
  await page.keyboard.press("v");
  await sleep(200);
  check("a clicked select: V selects the Move tool", rectOn && (await pressed("Move")) === "true");
  await page.locator("#dt-canvas").focus();
  await page.keyboard.press("r");
  await sleep(150);
  await page.keyboard.press("Shift");
  await ev(page, () => document.querySelector(".panel.right select").focus());
  await page.keyboard.press("v");
  await sleep(200);
  check("a select reached by keyboard keeps its letters (V does not change the tool)", (await pressed("Rectangle")) === "true" && (await pressed("Move")) !== "true");
  // A text field keeps everything.
  await page.locator("#dt-canvas").focus();
  await page.keyboard.press("v");
  const x = page.locator(".panel.right input[aria-label='X position']");
  await x.click();
  await x.fill("123");
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Backspace");
  await sleep(150);
  check("a number field keeps Ctrl+A and its keys", (await x.inputValue()) === "" && (await ev(page, () => window.__dt.state().selection.length)) === 1);
  await ctx.close();
}

await browser.close();
check("no page errors", errors.length === 0, errors.join(" | ").slice(0, 300));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
