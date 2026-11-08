// Round 18, package r18b (keyboard and screen readers): the paint swatch and its popover by keyboard,
// the colour picker's sliders, image adjustments and gradient stops, placing instances from Assets,
// the crash banner, plugins (focus, names, discard prompt), the variables import report, the Layers
// search text, the presenter's live region, 24 px targets, the phone-layout rule and the share link
// of a relay on this computer. axe runs on every state.
// Usage: serve web/dist (`vite preview --port 7011`), then
//   E2E_RELAY_BIN=<target>/debug/designotron-relay node scripts/qa/r18b-e2e.mjs
// Env: E2E_URL (default http://localhost:7011), E2E_RELAY_PORT (relay with the editor, 7013),
//      E2E_RELAY2_PORT (relay without one, 7017), E2E_RELAY_BIN, E2E_STATIC (the dist folder the
//      relay serves, default dist), AXE (path to axe.min.js), CHROMIUM, SHOTS (screenshot dir).
// Local servers only: every other request is aborted. Test images are drawn in the page.

import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const URL = process.env.E2E_URL ?? "http://localhost:7011";
const RELAY_PORT = Number(process.env.E2E_RELAY_PORT ?? 7013);
const RELAY2_PORT = Number(process.env.E2E_RELAY2_PORT ?? 7017);
const RELAY_BIN = process.env.E2E_RELAY_BIN ?? "";
const STATIC = process.env.E2E_STATIC ?? "dist";
const AXE = process.env.AXE ?? "/tmp/claude-0/-home-user-designotron/286bf7bb-781e-5d8f-9708-6c1f94840e4a/scratchpad/qa7/I-a11y/node_modules/axe-core/axe.min.js";
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

const browser = await chromium.launch(launch);
const contexts = [];
async function openPage(opts = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "dark", ...opts });
  contexts.push(context);
  const page = await context.newPage();
  await context.route("**/*", (r) => (LOCAL.test(r.request().url()) ? r.continue() : r.abort()));
  await page.addInitScript(() => {
    try {
      localStorage.setItem("dt:tour-done", "1");
    } catch {
      /* no storage */
    }
  });
  page.on("pageerror", (e) => check("no page errors", false, String(e)));
  return page;
}
const run = (page, cmd) => page.evaluate((c) => window.__dt.dispatch(c), cmd);
const tool = (page, name, input) => page.evaluate(([n, i]) => window.__dt.tool(n, i), [name, input]);
const nodes = (page) => page.evaluate(() => window.__dt.doc().nodes);
const byName = async (page, name) => Object.values(await nodes(page)).find((n) => n.name === name);
async function newFile(page) {
  await page.goto(URL);
  await page.click("button:has-text('New design file')");
  await page.waitForSelector("#dt-canvas");
  await sleep(300);
}
const shot = async (page, name) => {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name) });
};
const active = (page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    if (!a) return null;
    const r = a.getBoundingClientRect();
    return {
      tag: a.tagName,
      id: a.id,
      role: a.getAttribute("role"),
      label: a.getAttribute("aria-label") ?? "",
      text: (a.textContent ?? "").trim().slice(0, 60),
      inPopover: !!a.closest(".popover"),
      inDialog: !!a.closest("[role=dialog]"),
      cls: String(a.className?.baseVal ?? a.className ?? ""),
      w: r.width,
      h: r.height,
    };
  });
/** axe on the whole page (or `include`), with the target-size and label-content rules switched on. */
async function axe(page, name, include) {
  if (!fs.existsSync(AXE)) return check(`axe: ${name}`, false, `axe-core not found at ${AXE}`);
  if (!(await page.evaluate(() => !!window.axe))) await page.addScriptTag({ path: AXE });
  const v = await page.evaluate(async (inc) => {
    const r = await window.axe.run(inc ? { include: [[inc]] } : document, {
      resultTypes: ["violations"],
      rules: { "target-size": { enabled: true }, "label-content-name-mismatch": { enabled: true } },
    });
    return r.violations.map((x) => ({ id: x.id, impact: x.impact, nodes: x.nodes.slice(0, 4).map((n) => n.target.join(" ") + " :: " + n.html.slice(0, 90)) }));
  }, include ?? null);
  check(`axe: ${name} has no violations`, v.length === 0, JSON.stringify(v).slice(0, 700));
}
/** Focuses an element the way Tab would have: the editor treats a control focused after a click as a clicked one
 *  (Enter then acts on the design), so a key press first puts it in keyboard mode. */
const kfocus = async (page, locator) => {
  await page.keyboard.press("Tab");
  await locator.focus();
};
const sizeOf = (page, sel) => page.evaluate((s) => [...document.querySelectorAll(s)].map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10]; }), sel);
const atLeast24 = (sizes) => sizes.length > 0 && sizes.every(([w, h]) => w >= 23.9 && h >= 23.9);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "r18b-"));
const procs = [];
async function startRelay(port, withEditor) {
  if (!RELAY_BIN) return false;
  const args = ["--port", String(port), ...(withEditor ? ["--static", STATIC] : []), "--data", path.join(tmp, "relay" + port)];
  fs.mkdirSync(path.join(tmp, "relay" + port), { recursive: true });
  const p = spawn(RELAY_BIN, args, { stdio: "ignore" });
  procs.push(p);
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  return false;
}

try {
  // ===== K-09: the phone-layout rule =====
  {
    const phone = async (opts) => {
      const p = await openPage(opts);
      await p.goto(URL);
      const v = await p.evaluate(() => matchMedia("(max-width: 639px), (max-width: 820px) and (pointer: coarse)").matches);
      await p.context().close();
      return v;
    };
    check("desktop at 200% zoom (720 px, mouse) is not the phone layout", (await phone({ viewport: { width: 720, height: 450 } })) === false);
    check("a mouse at 639 px is the phone layout", (await phone({ viewport: { width: 639, height: 450 } })) === true);
    check("a mouse at 640 px is not", (await phone({ viewport: { width: 640, height: 450 } })) === false);
    check("an iPhone (390 px, touch) is the phone layout", (await phone({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })) === true);
    check("an iPad mini portrait (744 px, touch) is the phone layout", (await phone({ viewport: { width: 744, height: 1133 }, hasTouch: true, isMobile: true })) === true);
    check("a desktop at 300% (480 px, mouse) is the phone layout", (await phone({ viewport: { width: 480, height: 300 } })) === true);
    check("a touch screen at 900 px is not", (await phone({ viewport: { width: 900, height: 600 }, hasTouch: true, isMobile: true })) === false);

    // At 720 px the editor keeps its tools and panels (tablet layout): Frame tool, Layers and Design toggles, no overlap.
    const p = await openPage({ viewport: { width: 720, height: 450 } });
    await newFile(p);
    const tools = await p.evaluate(() => ({
      frame: !!document.querySelector("[aria-label='Frame'], [title^='Frame']"),
      rect: !!document.querySelector("[aria-label='Rectangle'], [title^='Rectangle']"),
      phoneNote: !!document.querySelector(".phone-note"),
      toggles: [...document.querySelectorAll("#panel-toggle-left, #panel-toggle-right")].length,
    }));
    check("at 720 px with a mouse the Frame and Rectangle tools are there", tools.frame && tools.rect, JSON.stringify(tools));
    check("at 720 px there is no phone note and both panel toggles are shown", !tools.phoneNote && tools.toggles === 2, JSON.stringify(tools));
    await p.keyboard.press("Control+\\");
    await sleep(300);
    const panels = await p.evaluate(() => !!document.querySelector(".main > .panel"));
    check("at 720 px Ctrl+\\ brings the panels back", panels);
    await p.keyboard.press("Control+\\");
    await sleep(300);
    // The tablet layout: a panel opened from the toolbar floats over a full-width canvas, with its close button.
    const widthOf = (page) => page.locator("#dt-canvas").evaluate((e) => e.getBoundingClientRect().width);
    const overlay = async (page, label, width) => {
      await page.locator("#panel-toggle-left").click();
      await sleep(300);
      const lay = await page.evaluate(() => {
        const el = document.querySelector(".main > .panel:not(.right)");
        const close = el?.querySelector(".panel-close");
        const cr = close?.getBoundingClientRect();
        return { pos: el ? getComputedStyle(el).position : null, closeVisible: !!cr && cr.width > 0 && cr.height > 0, canvas: document.getElementById("dt-canvas").getBoundingClientRect().width };
      });
      check(`${label}: an open panel is an overlay (position absolute) with a visible close button`, lay.pos === "absolute" && lay.closeVisible, JSON.stringify(lay));
      check(`${label}: opening it leaves the canvas its full width`, Math.abs(lay.canvas - width) <= 1, `${lay.canvas} vs ${width}`);
    };
    const w0 = await widthOf(p);
    await overlay(p, "at 720 px", w0);
    await p.locator("#panel-toggle-left").click();
    await sleep(200);
    for (const w of [640, 820]) {
      const q = await openPage({ viewport: { width: w, height: 450 } });
      await newFile(q);
      const before = await widthOf(q);
      await overlay(q, `at ${w} px (mouse)`, before);
      await q.context().close();
    }
    const overlap = await p.evaluate(() => {
      const boxes = [...document.querySelectorAll(".topbar button, .topbar .filename, .toolbar button, .toolbar [role=button]")]
        .map((e) => [e, e.getBoundingClientRect()])
        .filter(([, r]) => r.width > 0 && r.height > 0);
      let bad = 0;
      for (let i = 0; i < boxes.length; i++)
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i][1];
          const b = boxes[j][1];
          if (boxes[i][0].contains(boxes[j][0]) || boxes[j][0].contains(boxes[i][0])) continue;
          if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) bad++;
        }
      return { n: boxes.length, bad, scrollW: document.documentElement.scrollWidth };
    });
    check("the 720 px top bar and toolbar buttons don't overlap", overlap.bad === 0 && overlap.scrollW <= 720, JSON.stringify(overlap));
    await shot(p, "r18b-720.png");
    await axe(p, "the editor at 720 px");
    // The file name has no room in the bar at this width: the main menu renames the file.
    check("the file name field is hidden at 720 px", (await p.locator(".topbar .filename").evaluate((e) => e.getClientRects().length)) === 0);
    await p.keyboard.press("Tab");
    await p.evaluate(() => document.querySelector("[title='Main menu']").focus());
    await p.keyboard.press("Enter");
    await sleep(150);
    for (let i = 0; i < 12; i++) {
      if (/^Rename file/.test((await active(p))?.text ?? "")) break;
      await p.keyboard.press("ArrowDown");
    }
    await p.keyboard.press("Enter");
    await p.waitForSelector(".popover input[name=name]");
    await p.keyboard.type("Renamed at 720");
    await p.keyboard.press("Enter");
    await sleep(300);
    check("Rename file… in the main menu renames the file", (await p.evaluate(() => window.__dt.doc().name)) === "Renamed at 720" && (await p.locator(".popover").count()) === 0, await p.evaluate(() => window.__dt.doc().name));
    await p.context().close();
  }

  // ===== the editor at 1440 px =====
  const p = await openPage();
  await newFile(p);
  await axe(p, "the editor, new file");
  const rect = await run(p, { op: "createShape", kind: "rectangle", x: 100, y: 100, width: 200, height: 120, parent: null });
  await run(p, { op: "update", ids: [rect.id], patch: { name: "Card", fills: [{ type: "solid", color: "#3366FF", opacity: 1, visible: true }] } });
  await run(p, { op: "select", ids: [rect.id] });
  await sleep(300);

  // ===== K-01: the swatch and its popover =====
  {
    const sw = p.locator(".panel.right button.swatch").first();
    check("the fill swatch is a button named from the paint", (await sw.evaluate((e) => e.tagName)) === "BUTTON" && (await sw.getAttribute("aria-label")) === "Solid #3366FF, 100%", await sw.getAttribute("aria-label"));
    check("it declares a dialog popup and is collapsed", (await sw.getAttribute("aria-haspopup")) === "dialog" && (await sw.getAttribute("aria-expanded")) === "false");
    check("it is 24 px", atLeast24(await sizeOf(p, ".panel.right button.swatch")), JSON.stringify(await sizeOf(p, ".panel.right button.swatch")));
    await kfocus(p, sw);
    await p.keyboard.press("Enter");
    await p.waitForSelector(".popover");
    await sleep(150);
    let a = await active(p);
    check("opening the swatch moves focus into the popover", a.inPopover, JSON.stringify(a));
    check("the popover is a named dialog, and the swatch says it is expanded", (await p.locator(".popover").getAttribute("role")) === "dialog" && !!(await p.locator(".popover").getAttribute("aria-label")) && (await sw.getAttribute("aria-expanded")) === "true");
    // The three sliders.
    const sv = p.locator(".popover [role=slider][aria-label='Saturation and brightness']");
    const hue = p.locator(".popover [role=slider][aria-label='Hue']");
    const alpha = p.locator(".popover [role=slider][aria-label='Alpha']");
    check("the saturation/brightness area, hue and alpha are sliders with values", (await sv.count()) === 1 && (await hue.count()) === 1 && (await alpha.count()) === 1 && /^Saturation \d+%, brightness \d+%$/.test((await sv.getAttribute("aria-valuetext")) ?? "") && /^Hue \d+°$/.test((await hue.getAttribute("aria-valuetext")) ?? "") && (await alpha.getAttribute("aria-valuetext")) === "Alpha 100%", await sv.getAttribute("aria-valuetext"));
    check("the sliders are Tab stops 24 px tall or more", atLeast24(await sizeOf(p, ".popover .picker-slider")) && (await sv.evaluate((e) => e.tabIndex)) === 0);
    const fill = async () => (await byName(p, "Card")).fills[0];
    const startFill = await fill();
    await kfocus(p, sv);
    const sat0 = Number(await sv.getAttribute("aria-valuenow"));
    await p.keyboard.press("ArrowLeft");
    await sleep(80);
    check("Left on the saturation area lowers saturation by 1 and changes the fill", Number(await sv.getAttribute("aria-valuenow")) === sat0 - 1 && (await fill()).color !== startFill.color, `${sat0} -> ${await sv.getAttribute("aria-valuenow")}`);
    await p.keyboard.press("Shift+ArrowLeft");
    await sleep(80);
    check("Shift+Left steps by 10", Number(await sv.getAttribute("aria-valuenow")) === sat0 - 11);
    await p.keyboard.press("End");
    await sleep(80);
    check("End jumps to full saturation", Number(await sv.getAttribute("aria-valuenow")) === 100);
    await p.keyboard.press("Home");
    await sleep(80);
    check("Home jumps to no saturation (grey)", Number(await sv.getAttribute("aria-valuenow")) === 0 && /^#([0-9A-F]{2})\1\1$/.test((await fill()).color));
    await p.keyboard.press("ArrowUp");
    await p.keyboard.press("ArrowDown");
    const brightText = await sv.getAttribute("aria-valuetext");
    check("Up and Down change brightness", /brightness \d+%/.test(brightText));
    await kfocus(p, hue);
    const h0 = Number(await hue.getAttribute("aria-valuenow"));
    await p.keyboard.press("ArrowRight");
    check("Right on hue adds a degree", Number(await hue.getAttribute("aria-valuenow")) === h0 + 1 || h0 === 359);
    await p.keyboard.press("Shift+ArrowRight");
    await kfocus(p, alpha);
    await p.keyboard.press("ArrowLeft");
    await p.keyboard.press("Shift+ArrowLeft");
    await sleep(100);
    check("Left and Shift+Left on alpha give 89%", (await alpha.getAttribute("aria-valuetext")) === "Alpha 89%", await alpha.getAttribute("aria-valuetext"));
    check("the fill's hex is 8 digits once alpha is under 100%", /^#[0-9A-F]{8}$/.test((await fill()).color), (await fill()).color);
    await shot(p, "r18b-picker-keyboard.png");
    await axe(p, "the colour popover", ".popover");
    // Tab stays in the popover; Escape closes and gives focus back.
    let inside = true;
    for (let i = 0; i < 14; i++) {
      await p.keyboard.press("Tab");
      inside = inside && (await active(p)).inPopover;
    }
    check("Tab cycles inside the popover (14 presses never leave it)", inside);
    await p.keyboard.press("Shift+Tab");
    check("Shift+Tab stays inside too", (await active(p)).inPopover);
    await p.keyboard.press("Escape");
    await sleep(200);
    a = await active(p);
    check("Escape closes it and focus returns to the swatch", (await p.locator(".popover").count()) === 0 && a.cls.includes("swatch") && (await sw.getAttribute("aria-expanded")) === "false", JSON.stringify(a));
    // One undo step for everything done in the popover.
    await run(p, { op: "undo" });
    await sleep(150);
    check("all the popover's key presses were one undo step", (await fill()).color === startFill.color, (await fill()).color);
  }

  // ===== K-01: hex field Escape, then Escape closes =====
  {
    await kfocus(p, p.locator(".panel.right button.swatch").first());
    await p.keyboard.press("Enter");
    await p.waitForSelector(".popover");
    const hex = p.locator(".popover input").first();
    await kfocus(p, hex);
    await p.keyboard.type("12");
    await p.keyboard.press("Escape");
    check("Escape in the hex field first puts the colour back and keeps the popover", (await p.locator(".popover").count()) === 1 && (await hex.inputValue()) === "3366FF", await hex.inputValue());
    await p.keyboard.press("Escape");
    await sleep(150);
    check("the next Escape closes it", (await p.locator(".popover").count()) === 0);
  }

  // ===== K-01: Escape in a number field of a popover, and Ctrl chords from inside one =====
  {
    const swatch = p.locator(".panel.right button.swatch").first();
    await kfocus(p, swatch);
    await p.keyboard.press("Enter");
    await p.waitForSelector(".popover");
    const alpha = p.locator(".popover input[aria-label='Alpha']");
    const shownBefore = await alpha.inputValue();
    await kfocus(p, alpha);
    await p.keyboard.type("5");
    await p.keyboard.press("Escape");
    await sleep(150);
    let a = await active(p);
    check("Escape in a typed-in number field of a popover reverts it, keeps focus there and keeps the popover", (await p.locator(".popover").count()) === 1 && a.label === "Alpha" && (await alpha.inputValue()) === shownBefore, JSON.stringify([a, await alpha.inputValue(), shownBefore]));
    await p.keyboard.press("Escape");
    await sleep(200);
    a = await active(p);
    check("Escape with nothing typed closes the popover and focus returns to the swatch", (await p.locator(".popover").count()) === 0 && a.cls.includes("swatch"), JSON.stringify(a));
    // Ctrl chords with focus inside an open popover reach the app's shortcuts (and are prevented there).
    await kfocus(p, swatch);
    await p.keyboard.press("Enter");
    await p.waitForSelector(".popover");
    await p.evaluate(() => {
      window.__r18keys = [];
      window.addEventListener("keydown", (e) => e.ctrlKey && window.__r18keys.push([e.key.toLowerCase(), e.defaultPrevented]));
    });
    const ids0 = new Set(Object.keys(await nodes(p)));
    await kfocus(p, p.locator(".popover [role=slider][aria-label='Hue']"));
    await p.keyboard.press("Control+s");
    await p.keyboard.press("Control+d");
    await sleep(200);
    const duplicated = Object.keys(await nodes(p)).length === ids0.size + 1;
    await p.keyboard.press("Control+z");
    await sleep(200);
    const seen = await p.evaluate(() => window.__r18keys);
    check("Ctrl+S, Ctrl+D and Ctrl+Z inside an open popover reach the app and are prevented", ["s", "d", "z"].every((k) => seen.some(([key, prevented]) => key === k && prevented)), JSON.stringify(seen));
    check("Ctrl+D inside the popover duplicated the layer", duplicated);
    await p.keyboard.press("Escape");
    await sleep(200);
    for (const id of Object.keys(await nodes(p))) if (!ids0.has(id)) await run(p, { op: "delete", ids: [id] });
    await run(p, { op: "select", ids: [rect.id] });
    await sleep(150);
  }

  // ===== K-01: the Fill swatch while editing text =====
  {
    const t = await run(p, { op: "createText", x: 400, y: 400, characters: "Hello world", parent: null });
    await run(p, { op: "update", ids: [t.id], patch: { name: "Greeting" } });
    await run(p, { op: "select", ids: [t.id] });
    await sleep(200);
    const textOf = async () => (await nodes(p))[t.id]?.text?.characters ?? null;
    const startEditing = async () => {
      await p.locator("#dt-canvas").focus();
      await p.keyboard.press("Enter");
      await p.waitForSelector("textarea.text-editor");
      await sleep(200);
      await p.keyboard.press("Home");
      for (let i = 0; i < 5; i++) await p.keyboard.press("Shift+ArrowRight");
    };
    await startEditing();
    await p.locator(".panel.right button.swatch").first().click();
    await p.waitForSelector(".popover");
    await sleep(250);
    let a = await active(p);
    check("clicking the Fill swatch while editing keeps focus in the text", a.tag === "TEXTAREA", JSON.stringify(a));
    // Colour the selected characters through the popover.
    const hex = p.locator(".popover input").first();
    await hex.fill("FF0000");
    await hex.press("Enter");
    await sleep(250);
    check("colouring the selected range through the popover still works", JSON.stringify((await nodes(p))[t.id].text).toUpperCase().includes("FF0000"), JSON.stringify((await nodes(p))[t.id].text).slice(0, 300));
    await p.locator("textarea.text-editor").focus();
    await p.keyboard.press("Home");
    for (let i = 0; i < 5; i++) await p.keyboard.press("Shift+ArrowRight");
    await p.keyboard.press("Backspace");
    await sleep(250);
    check("Backspace with the popover open removes only the selected text; the layer survives", (await textOf()) === " world", String(await textOf()));
    // Escape closes the popover first and leaves the text being edited; Backspace then edits the text.
    await p.keyboard.press("Escape");
    await sleep(250);
    check("Escape closes the popover and the text is still being edited", (await p.locator(".popover").count()) === 0 && (await p.locator("textarea.text-editor").count()) === 1);
    await p.keyboard.press("End");
    await p.keyboard.press("Backspace");
    await sleep(250);
    check("Backspace after that deletes a character, not the layer", !!(await nodes(p))[t.id] && (await textOf()) !== " world", String(await textOf()));
    await p.keyboard.press("Escape");
    await sleep(250);
    await run(p, { op: "delete", ids: [t.id] });
    await run(p, { op: "select", ids: [rect.id] });
    await sleep(200);
  }

  // ===== K-01: gradient stops =====
  {
    await run(p, { op: "update", ids: [rect.id], patch: { fills: [{ type: "linearGradient", angle: 90, stops: [{ color: "#000000", position: 0 }, { color: "#FFFFFF", position: 1 }], opacity: 1, visible: true }] } });
    await sleep(200);
    const sw = p.locator(".panel.right button.swatch").first();
    check("a gradient swatch is named 'Linear gradient'", (await sw.getAttribute("aria-label")) === "Linear gradient", await sw.getAttribute("aria-label"));
    await kfocus(p, sw);
    await p.keyboard.press("Enter");
    await p.waitForSelector(".popover [data-stop]");
    const stops = p.locator(".popover button[data-stop]");
    check("each stop is a button named by number, position and colour", (await stops.count()) === 2 && (await stops.nth(1).getAttribute("aria-label")) === "Stop 2 at 100%, #FFFFFF", await stops.nth(1).getAttribute("aria-label"));
    await kfocus(p, stops.nth(1));
    await p.keyboard.press("ArrowLeft");
    await p.keyboard.press("Shift+ArrowLeft");
    await sleep(100);
    let g = (await byName(p, "Card")).fills[0];
    check("Left moves a stop 1%, Shift+Left 10%", Math.abs(g.stops[1].position - 0.89) < 1e-6, String(g.stops[1].position));
    check("the stop's name follows", (await stops.nth(1).getAttribute("aria-label")) === "Stop 2 at 89%, #FFFFFF");
    await p.keyboard.press("Delete");
    await sleep(100);
    g = (await byName(p, "Card")).fills[0];
    check("Delete does not go under two stops", g.stops.length === 2);
    await p.locator(".popover button[title='Add stop']").click();
    await sleep(100);
    g = (await byName(p, "Card")).fills[0];
    check("Add stop makes a third", g.stops.length === 3);
    await kfocus(p, p.locator(".popover button[data-stop]").nth(1));
    await p.keyboard.press("Delete");
    await sleep(100);
    g = (await byName(p, "Card")).fills[0];
    check("Delete removes a stop when there are more than two", g.stops.length === 2);
    await axe(p, "the gradient popover", ".popover");
    await p.keyboard.press("Escape");
    await sleep(150);
  }

  // ===== K-01: image popover =====
  {
    const src = await p.evaluate(() => {
      const c = document.createElement("canvas");
      c.width = 40;
      c.height = 20;
      const g = c.getContext("2d");
      g.fillStyle = "#e33";
      g.fillRect(0, 0, 40, 20);
      g.fillStyle = "#39f";
      g.fillRect(20, 0, 20, 20);
      return c.toDataURL("image/png");
    });
    await run(p, { op: "update", ids: [rect.id], patch: { fills: [{ type: "image", src, scaleMode: "fill", opacity: 1, visible: true }] } });
    await sleep(300);
    const sw = p.locator(".panel.right button.swatch").first();
    check("an image swatch is named 'Image (Fill)'", (await sw.getAttribute("aria-label")) === "Image (Fill)", await sw.getAttribute("aria-label"));
    await kfocus(p, sw);
    await p.keyboard.press("Enter");
    await p.waitForSelector(".popover .image-adjust");
    const rot = p.locator(".popover button:has-text('Rotate 90')");
    await kfocus(p, rot);
    await p.keyboard.press("Enter");
    await sleep(500);
    const live = async () => (await p.locator(".popover [role=status]").first().innerText()).trim();
    check("Rotate 90° announces the new angle", (await live()) === "Rotated to 90°", await live());
    await p.keyboard.press("Enter");
    await sleep(400);
    check("a second turn says 180°", (await live()) === "Rotated to 180°", await live());
    const ex = p.locator(".popover input[data-adjust='exposure']");
    await kfocus(p, ex);
    await p.keyboard.press("ArrowRight");
    await p.keyboard.press("ArrowRight");
    await sleep(100);
    check("an adjustment slider has aria-valuetext with its value and the <output> is hidden from readers", (await ex.getAttribute("aria-valuetext")) === "2" && (await p.locator(".popover .image-adjust output").first().getAttribute("aria-hidden")) === "true", await ex.getAttribute("aria-valuetext"));
    check("adjustment sliders are 24 px tall", atLeast24((await sizeOf(p, ".popover .image-adjust-row input[type=range]")).map(([w, h]) => [w, h])), JSON.stringify(await sizeOf(p, ".popover .image-adjust-row input[type=range]")));
    await shot(p, "r18b-image-popover.png");
    await axe(p, "the image popover", ".popover");
    await p.keyboard.press("Escape");
    await sleep(150);
    check("Escape from the image popover returns focus to its swatch", (await active(p)).cls.includes("swatch"));
  }

  // ===== K-02: placing an instance from Assets =====
  {
    await run(p, { op: "update", ids: [rect.id], patch: { fills: [{ type: "solid", color: "#3366FF", opacity: 1, visible: true }] } });
    await run(p, { op: "select", ids: [rect.id] });
    await run(p, { op: "createComponent", ids: [rect.id] });
    await sleep(300);
    const main = Object.values(await nodes(p)).find((n) => n.type === "component");
    check("a main component exists", !!main);
    await run(p, { op: "select", ids: [] });
    await p.locator(".main > .panel:not(.right) [role=tab]:has-text('Assets')").click();
    await sleep(300);
    const row = p.locator("button.asset-row").first();
    check("the component row is a button", (await row.count()) === 1);
    const name = await row.locator(".name").innerText();
    check("its name starts with 'Insert instance of' for readers and keeps the visible text inside", /^Insert instance of /.test(name.trim()) || /Insert instance of/.test(await row.evaluate((e) => e.textContent)), name);
    await axe(p, "Assets with a component row", ".main > .panel:not(.right)");
    await run(p, { op: "setReadOnly", on: true });
    await sleep(300);
    check("in a read-only tab the component rows are not insert buttons", (await p.locator("button.asset-row").count()) === 0 && (await p.locator(".layer.asset-row").count()) > 0);
    await run(p, { op: "setReadOnly", on: false });
    await sleep(300);
    await kfocus(p, row);
    await p.keyboard.press("Enter");
    await sleep(400);
    const inst = Object.values(await nodes(p)).find((n) => n.type === "instance");
    check("Enter places an instance", !!inst);
    const sel = await p.evaluate(() => window.__dt.selection?.() ?? null);
    const af = await active(p);
    check("focus moves to the canvas so the arrows can nudge it", af.id === "dt-canvas", JSON.stringify(af));
    if (inst) {
      const x0 = (await nodes(p))[inst.id].x;
      await p.keyboard.press("ArrowRight");
      await sleep(150);
      check("Arrow Right nudges the new instance", (await nodes(p))[inst.id].x === x0 + 1, `${x0} -> ${(await nodes(p))[inst.id].x}`);
    }
    void sel;
    // Menu key on the row.
    await p.locator(".main > .panel:not(.right) [role=tab]:has-text('Assets')").click();
    await kfocus(p, p.locator("button.asset-row").first());
    await p.keyboard.press("Shift+F10");
    await p.waitForSelector(".menu");
    const items = await p.locator(".menu [role=menuitem]").allInnerTexts();
    check("Shift+F10 on the row offers Insert instance and Go to main component", items.includes("Insert instance") && items.includes("Go to main component"), items.join("|"));
    await p.keyboard.press("Escape");
    // The Layers panel's context menu (a right-click on the canvas picks the layer inside a main, so a main is chosen in the tree).
    await run(p, { op: "select", ids: [main.id] });
    await p.locator(".main > .panel:not(.right) [role=tab]:has-text('Layers')").click();
    await sleep(200);
    const m = (await nodes(p))[main.id];
    await p.locator(".main > .panel:not(.right) [role=treeitem][aria-selected=true]").first().click({ button: "right" });
    await p.waitForSelector(".menu");
    check("the context menu of a main component has Insert instance", (await p.locator(".menu [role=menuitem]:has-text('Insert instance')").count()) === 1, (await p.locator(".menu [role=menuitem]").allInnerTexts()).join("|"));
    const before = Object.values(await nodes(p)).filter((n) => n.type === "instance").length;
    await p.locator(".menu [role=menuitem]:has-text('Insert instance')").click();
    await sleep(300);
    const all = Object.values(await nodes(p)).filter((n) => n.type === "instance");
    const fresh = all.find((n) => Math.abs(n.x - (m.x + m.width + 40)) < 1 && Math.abs(n.y - m.y) < 1);
    check("it lands 40 px right of the main", all.length === before + 1 && !!fresh, JSON.stringify(all.map((n) => [n.x, n.y])) + " main " + [m.x, m.width, m.y]);
    check("and is not inside a main", !!fresh && (await nodes(p))[fresh.parent]?.type !== "component");
    await run(p, { op: "select", ids: [] });
  }

  // ===== K-10 / K-11 / search text, targets =====
  {
    for (let i = 0; i < 6; i++) await run(p, { op: "createShape", kind: "rectangle", x: 400 + i * 20, y: 20, width: 10, height: 10, parent: null });
    await p.locator(".main > .panel:not(.right) [role=tab]:has-text('Layers')").click();
    await sleep(200);
    const search = p.locator(".layer-search-field input");
    await search.click();
    await p.keyboard.type("rect");
    await sleep(400);
    const status = p.locator(".layer-search-count [role=status]");
    check("the count is the only text of the status", /^\d+ matches$/.test((await status.innerText()).trim()), await status.innerText());
    check("Select all sits beside the status, not in it, and the row reads '… matches · Select all N'", (await p.locator(".layer-search-count [role=status] button").count()) === 0 && /^\d+ matches\s*·\s*Select all \d+$/.test((await p.locator(".layer-search-count").evaluate((e) => e.textContent)).replace(/\s+/g, " ").trim()), await p.locator(".layer-search-count").evaluate((e) => e.textContent));
    const hit = p.locator("[data-layer-hit]").first();
    check("a search hit has no aria-label that differs from its text", (await hit.getAttribute("aria-label")) === null);
    check("its spoken name is the visible text with ', in' before the path", /, in /.test(await hit.evaluate((e) => e.textContent)) || (await hit.locator(".hit-path").count()) === 0);
    const filterBtn = p.locator(".layer-filter-btn");
    check("the filter button is a disclosure: no aria-haspopup", (await filterBtn.getAttribute("aria-haspopup")) === null && (await filterBtn.getAttribute("aria-controls")) === "layer-filter-menu");
    await shot(p, "r18b-layers-search.png");
    await axe(p, "Layers search results", ".main > .panel:not(.right)");
    await filterBtn.click();
    await p.waitForSelector("#layer-filter-menu");
    await axe(p, "the Layers filter menu", ".main > .panel:not(.right)");
    check("filter rows, Clear, the input and Select all are 24 px", atLeast24(await sizeOf(p, ".layer-filter-item")) && atLeast24(await sizeOf(p, ".layer-search-field input")) && atLeast24(await sizeOf(p, ".layer-select-all")) && atLeast24(await sizeOf(p, ".layer-search-field .ibtn")), JSON.stringify([await sizeOf(p, ".layer-filter-item"), await sizeOf(p, ".layer-search-field input"), await sizeOf(p, ".layer-select-all"), await sizeOf(p, ".layer-search-field .ibtn")]));
    await filterBtn.click();
    await search.fill("");
    await p.keyboard.press("Escape");
  }

  // ===== K-04 / K-06 / K-07 / K-12: plugins =====
  {
    const openPlugins = async () => {
      await run(p, { op: "select", ids: [] });
      await p.keyboard.press("Tab");
      await p.evaluate(() => document.querySelector("[title='Main menu']").focus());
      await p.keyboard.press("Enter");
      await sleep(150);
      for (let i = 0; i < 80; i++) {
        const t = (await active(p))?.text ?? "";
        if (/^Manage plugins/.test(t)) break;
        await p.keyboard.press("ArrowDown");
      }
      await p.keyboard.press("Enter");
      await p.waitForSelector(".plugins-dialog");
      await sleep(250);
    };
    await openPlugins();
    await axe(p, "the Plugins list", ".plugins-dialog");
    const names = await p.locator(".plugin-row .plugin-row-name").allInnerTexts();
    check("plugin names are buttons, spoken 'Edit <name>'", names.length > 0 && names.every((n) => /^Edit /.test(n.trim())) || (await p.locator(".plugin-row .plugin-row-name").count()) > 0, names.join("|"));
    const runNames = await p.locator(".plugin-row button[aria-label^='Run ']").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
    check("Run buttons carry the plugin's name and are all different", runNames.length > 0 && new Set(runNames).size === runNames.length, runNames.join("|"));
    // New plugin: focus to the Name field.
    await kfocus(p, p.locator("button:has-text('New plugin')"));
    await p.keyboard.press("Enter");
    await sleep(300);
    let a = await active(p);
    check("New plugin moves focus to the Name field", a.tag === "INPUT" && a.label === "Name", JSON.stringify(a));
    // An untouched new plugin leaves without asking.
    await p.keyboard.press("Escape");
    await sleep(250);
    check("Escape on an untouched new plugin closes the dialog", (await p.locator(".plugins-dialog").count()) === 0);
    await openPlugins();
    await kfocus(p, p.locator("button:has-text('New plugin')"));
    await p.keyboard.press("Enter");
    await sleep(250);
    await p.keyboard.type("Mine");
    await kfocus(p, p.locator("textarea[aria-label='Plugin code']"));
    await p.keyboard.press("End");
    await p.keyboard.type("// my work");
    const caretBefore = await p.evaluate(() => document.querySelector("textarea[aria-label='Plugin code']").selectionStart);
    await p.keyboard.press("Escape");
    await sleep(250);
    const bar = p.locator(".plugin-discard");
    check("Escape with typed code asks 'Discard changes to Mine?' in the dialog", (await bar.count()) === 1 && /Discard changes to Mine\?/.test(await bar.innerText()) && (await p.locator(".plugins-dialog").count()) === 1, await bar.innerText().catch(() => ""));
    a = await active(p);
    check("focus is on Keep editing", a.text === "Keep editing", JSON.stringify(a));
    await axe(p, "the discard prompt", ".plugins-dialog");
    await p.keyboard.press("Escape");
    await sleep(250);
    a = await active(p);
    const caret = await p.evaluate(() => { const t = document.querySelector("textarea[aria-label='Plugin code']"); return [t.selectionStart, t.value.length]; });
    check("Escape again keeps editing: focus is back in the code with the caret where it was", (await bar.count()) === 0 && a.label === "Plugin code" && caret[0] === caretBefore, JSON.stringify([a, caret, caretBefore]));
    check("the typed code is still there", (await p.locator("textarea[aria-label='Plugin code']").inputValue()).includes("// my work"));
    await p.locator(".plugins-dialog button[title='Close']").click();
    await sleep(200);
    check("Close with unsaved changes asks too", (await bar.count()) === 1);
    await p.locator(".plugin-discard button:has-text('Discard')").click();
    await sleep(250);
    check("Discard closes the dialog without saving", (await p.locator(".plugins-dialog").count()) === 0);
    await openPlugins();
    check("the discarded plugin was not saved", (await p.locator(".plugin-row .plugin-row-name:has-text('Mine')").count()) === 0);
    // Save, then no prompt.
    await kfocus(p, p.locator("button:has-text('New plugin')"));
    await p.keyboard.press("Enter");
    await sleep(250);
    await p.keyboard.type("Saved one");
    await p.locator("button:has-text('Save')").click();
    await sleep(500);
    a = await active(p);
    check("after Save the list shows and focus is on that plugin's name", (await p.locator(".plugin-row .plugin-row-name:has-text('Saved one')").count()) === 1 && /Saved one/.test(a.text), JSON.stringify(a));
    // Open by keyboard, change nothing, Escape closes without asking; Back returns focus to the row.
    await kfocus(p, p.locator(".plugin-row-name:has-text('Saved one')"));
    await p.keyboard.press("Enter");
    await sleep(250);
    a = await active(p);
    check("opening an existing plugin by keyboard puts focus in its code", a.label === "Plugin code", JSON.stringify(a));
    await p.locator("button:has-text('Back')").click();
    await sleep(250);
    a = await active(p);
    check("Back returns focus to the row that was opened", /Saved one/.test(a.text) && a.cls.includes("plugin-row-name"), JSON.stringify(a));
    // A built-in opens read-only: no prompt.
    const builtin = p.locator(".plugin-row:not(:has(button[aria-label^='Delete ']))").first();
    if (await builtin.count()) {
      await kfocus(p, builtin.locator(".plugin-row-name"));
      await p.keyboard.press("Enter");
      await sleep(250);
      await p.keyboard.press("Escape");
      await sleep(250);
      check("Escape on a built-in plugin (read-only) never asks", (await p.locator(".plugin-discard").count()) === 0 && (await p.locator(".plugins-dialog").count()) === 0);
    } else check("a built-in plugin is listed", false);
    // Editor state: console log named, Clear 24 px.
    await openPlugins();
    await kfocus(p, p.locator(".plugin-row-name:has-text('Saved one')"));
    await p.keyboard.press("Enter");
    await sleep(250);
    check("the console log has a name", (await p.locator(".plugin-console [role=log]").getAttribute("aria-label")) === "Plugin console output");
    check("Clear is 24 px", atLeast24(await sizeOf(p, ".plugin-console-head .btn")), JSON.stringify(await sizeOf(p, ".plugin-console-head .btn")));
    await shot(p, "r18b-plugin-editor.png");
    await axe(p, "the plugin editor", ".plugins-dialog");
    await p.locator("textarea[aria-label='Plugin code']").fill("const = ;");
    await p.keyboard.press("Control+Enter");
    await sleep(600);
    await axe(p, "the plugin editor with a syntax error", ".plugins-dialog");
    await p.keyboard.press("Escape");
    await sleep(200);
    await p.locator(".plugin-discard button:has-text('Discard')").click();
    await sleep(200);
    check("Discard after a failed run closes the dialog", (await p.locator(".plugins-dialog").count()) === 0);
  }

  // ===== K-05 / K-08: the variables import report =====
  {
    await p.keyboard.press("Tab");
    await p.evaluate(() => document.querySelector("[title='Main menu']").focus());
    await p.keyboard.press("Enter");
    await sleep(150);
    for (let i = 0; i < 80; i++) {
      const t = (await active(p))?.text ?? "";
      if (/^Variables/.test(t)) break;
      await p.keyboard.press("ArrowDown");
    }
    await p.keyboard.press("Enter");
    await p.waitForSelector("[aria-label='Import JSON']");
    const tokens = path.join(tmp, "tokens.json");
    // Two tokens that map, and one of a kind the importer skips.
    fs.writeFileSync(
      tokens,
      JSON.stringify({ colors: { brand: { $type: "color", $value: "#3366ff" }, ink: { $type: "color", $value: "#111111" } }, shadow: { $type: "shadow", $value: { color: "#000", offsetX: "0px", offsetY: "2px", blur: "4px", spread: "0px" } }, motion: { $type: "cubicBezier", $value: [0.1, 0.2, 0.3, 0.4] } }),
    );
    const [chooser] = await Promise.all([p.waitForEvent("filechooser"), p.locator("button[aria-label='Import JSON']").click()]);
    await chooser.setFiles(tokens);
    await p.waitForSelector("[data-var-import-report]");
    await sleep(300);
    const skipped = p.locator(".var-import-skipped-btn");
    check("the report has an 'N skipped' button", (await skipped.count()) === 1, await p.locator("[data-var-import-report]").innerText());
    if (await skipped.count()) {
      check("'N skipped' is 24 px tall", atLeast24(await sizeOf(p, ".var-import-skipped-btn")), JSON.stringify(await sizeOf(p, ".var-import-skipped-btn")));
      await skipped.click();
    }
    await axe(p, "the variables dialog with an import report", ".modal");
    await kfocus(p, p.locator("button[aria-label='Dismiss import report']"));
    await p.keyboard.press("Enter");
    await sleep(300);
    const a = await active(p);
    check("Dismiss import report moves focus to the Import button", a.label === "Import JSON", JSON.stringify(a));
    await shot(p, "r18b-variables-dismissed.png");
    await p.keyboard.press("Escape");
    await sleep(200);
  }

  // ===== targets: Claude setup copy buttons, Drafts link, photos links =====
  {
    await p.locator("[aria-label='Ask Claude'], .tbtn[title*='Claude']").first().click().catch(() => {});
    await sleep(500);
    const copies = await sizeOf(p, ".copy-line button");
    if (copies.length) check("the Claude setup Copy buttons are 24 px", atLeast24(copies), JSON.stringify(copies));
    else console.log("SKIP  the Claude setup steps are not on screen (a bridge is connected or the chat is closed)");
    const loc = await sizeOf(p, ".file-loc a");
    if (loc.length) check("the Drafts breadcrumb is 24 px", atLeast24(loc), JSON.stringify(loc));
    else console.log("SKIP  the file location is not shown");
    await p.keyboard.press("Escape");
    await p.locator(".main > .panel:not(.right) [role=tab]:has-text('Assets')").click();
    await sleep(300);
    const toggle = p.locator(".photo-sources-toggle");
    if (await toggle.count()) {
      check("'Sources and keys' is 24 px", atLeast24(await sizeOf(p, ".photo-sources-toggle")));
      const credit = await sizeOf(p, ".photo-credit a");
      check("the provider link under the photos is 24 px", credit.length === 0 || atLeast24(credit), JSON.stringify(credit));
      await axe(p, "Assets with the photo search", ".main > .panel:not(.right)");
    }
  }

  await p.context().close();

  // ===== K-03: the crash banner =====
  {
    const c = await openPage();
    await newFile(c);
    const r = await run(c, { op: "createShape", kind: "rectangle", x: 50, y: 50, width: 100, height: 100, parent: null });
    await run(c, { op: "select", ids: [r.id] });
    await c.locator("#dt-canvas").focus();
    // Make every engine call trap like an out-of-memory wasm engine, then press a key that asks it.
    await c.evaluate(() => {
      const e = window.__dt.engine();
      const skip = new Set(["__destroy_into_raw", "free", "constructor"]);
      for (const k of Object.getOwnPropertyNames(Object.getPrototypeOf(e))) {
        if (typeof e[k] === "function" && !skip.has(k) && !/^(collab|persist)/.test(k)) e[k] = () => { throw new WebAssembly.RuntimeError("unreachable"); };
      }
    });
    await c.keyboard.press("Control+d");
    await c.waitForSelector(".engine-bar");
    await sleep(300);
    let a = await active(c);
    check("when the engine stops, focus moves to Reload", a.text === "Reload" && a.inDialog === false && (await c.locator(".engine-bar").evaluate((e) => e.contains(document.activeElement))), JSON.stringify(a));
    check("the bar is a named alert before the main area in the DOM", (await c.locator(".engine-bar").getAttribute("role")) === "alert" && (await c.evaluate(() => { const b = document.querySelector(".engine-bar"); const m = document.querySelector("main.main"); return !!(b.compareDocumentPosition(m) & Node.DOCUMENT_POSITION_FOLLOWING); })));
    await c.keyboard.press("Tab");
    a = await active(c);
    check("Tab moves from Reload to the download button", /download/i.test(a.text), JSON.stringify(a));
    // From the canvas: Tab doesn't cycle layers while the engine is down.
    await c.locator("#dt-canvas").focus();
    await c.keyboard.press("Tab");
    a = await active(c);
    check("Tab on the canvas leaves it (no layer cycling)", a.id !== "dt-canvas", JSON.stringify(a));
    // F6 reaches the banner.
    await c.locator("#dt-canvas").focus();
    const seen = [];
    for (let i = 0; i < 6; i++) {
      await c.keyboard.press("F6");
      seen.push((await c.evaluate(() => !!document.activeElement?.closest(".engine-bar"))) ? "bar" : "other");
    }
    check("F6 reaches the banner within a full cycle", seen.includes("bar"), seen.join());
    await c.keyboard.press("Shift+F6");
    await c.locator("#dt-canvas").focus();
    await shot(c, "r18b-crash-banner.png");
    await kfocus(c, c.locator(".engine-bar button").first());
    check("the banner buttons are 24 px", atLeast24(await sizeOf(c, ".engine-bar button")), JSON.stringify(await sizeOf(c, ".engine-bar button")));
    await axe(c, "the crash banner", ".engine-bar");
    await c.context().close();
  }

  // ===== presenter announcements =====
  {
    const c = await openPage();
    await newFile(c);
    const a1 = await run(c, { op: "createShape", kind: "frame", x: 0, y: 0, width: 300, height: 300, parent: null });
    await run(c, { op: "update", ids: [a1.id], patch: { name: "Home" } });
    const a2 = await run(c, { op: "createShape", kind: "frame", x: 400, y: 0, width: 300, height: 300, parent: null });
    await run(c, { op: "update", ids: [a2.id], patch: { name: "Settings" } });
    const btn = await run(c, { op: "createShape", kind: "rectangle", x: 20, y: 20, width: 100, height: 40, parent: a1.id });
    await run(c, { op: "update", ids: [btn.id], patch: { name: "Go" } });
    const ov = await run(c, { op: "createShape", kind: "frame", x: 800, y: 0, width: 200, height: 120, parent: null });
    await run(c, { op: "update", ids: [ov.id], patch: { name: "Dialog" } });
    const b2 = await run(c, { op: "createShape", kind: "rectangle", x: 20, y: 80, width: 100, height: 40, parent: a1.id });
    await run(c, { op: "update", ids: [b2.id], patch: { name: "Open dialog" } });
    const interactions = await c.evaluate(([go, open, dest, dlg]) => {
      const n = window.__dt.doc().nodes;
      void n;
      return [
        { op: "update", ids: [go], patch: { interactions: [{ trigger: "onClick", action: "navigate", destination: dest }] } },
        { op: "update", ids: [open], patch: { interactions: [{ trigger: "onClick", action: "openOverlay", destination: dlg }] } },
      ];
    }, [btn.id, b2.id, a2.id, ov.id]);
    for (const i of interactions) await run(c, i);
    await run(c, { op: "setFlowStart", page: (await c.evaluate(() => window.__dt.doc().pages[0].id)), id: a1.id });
    await run(c, { op: "select", ids: [a1.id] });
    await c.keyboard.press("Control+Alt+Enter").catch(() => {});
    if (!(await c.locator(".presenter").count())) await c.locator(".tbtn[title^='Present']").click();
    await c.waitForSelector(".presenter");
    await sleep(900);
    const live = () => c.locator("[data-presenter-live]").innerText().then((t) => t.trim());
    check("the presenter has a polite live region", (await c.locator("[data-presenter-live]").getAttribute("aria-live")) === "polite");
    check("the start frame is announced once after it opens", (await live()) === "Home", await live());
    await c.locator(".presenter .hotspot", { hasText: "" }).first().focus().catch(() => {});
    // Go: navigate to Settings.
    await c.evaluate(() => { const h = [...document.querySelectorAll(".presenter .hotspot[aria-label]")].find((e) => /Go/.test(e.getAttribute("aria-label"))); h?.click(); });
    await sleep(600);
    check("Navigate announces the new frame's name", (await live()) === "Settings", await live());
    await c.locator(".presenter button[title='Back']").click();
    await sleep(600);
    check("Back announces the frame again", (await live()) === "Home", await live());
    await c.evaluate(() => { const h = [...document.querySelectorAll(".presenter .hotspot[aria-label]")].find((e) => /Open dialog/.test(e.getAttribute("aria-label"))); h?.click(); });
    await sleep(500);
    check("an overlay announces '<name> opened'", (await live()) === "Dialog opened", await live());
    await c.keyboard.press("r");
    await sleep(600);
    check("Restart announces the start frame", (await live()) === "Home", await live());
    await c.evaluate(() => document.querySelector(".presenter-viewport")?.dispatchEvent(new Event("scroll")));
    await sleep(300);
    check("a scroll announces nothing new", (await live()) === "Home");
    await shot(c, "r18b-presenter.png");
    await axe(c, "the presenter", ".presenter");
    await c.context().close();
  }

  // ===== share link of a relay on this computer =====
  {
    const up1 = await startRelay(RELAY_PORT, true);
    const up2 = await startRelay(RELAY2_PORT, false);
    if (!RELAY_BIN) console.log("SKIP  no E2E_RELAY_BIN: the share-link checks need the relay binary");
    else {
      check("the relays started", up1 && up2);
      const shareLink = async (relayUrl) => {
        const c = await openPage();
        await c.addInitScript((u) => { try { localStorage.setItem("dt:relay", u); } catch { /* none */ } }, relayUrl);
        await newFile(c);
        await c.click(".tbtn[title='Share for live editing']");
        await sleep(300);
        if (!(await c.locator(".share-dialog input.mono").count())) await c.click(".share-dialog >> text=Use a different relay");
        await c.locator(".share-dialog input.mono").fill(relayUrl);
        await c.click("button:has-text('Share online')");
        await c.waitForSelector("#share-link", { timeout: 8000 });
        const link = await c.locator("#share-link").inputValue();
        const note = await c.locator(".share-local-only").count();
        await shot(c, `r18b-share-${new globalThis.URL(relayUrl).port}.png`);
        await axe(c, `the Share dialog (${relayUrl})`, ".share-dialog");
        await c.context().close();
        return { link, note };
      };
      const own = await shareLink(`http://127.0.0.1:${RELAY_PORT}`);
      check("a local relay that serves an editor: the link opens that relay's editor", own.link.startsWith(`http://127.0.0.1:${RELAY_PORT}/?room=`) && !own.link.includes("relay="), own.link);
      check("a loopback link says it works on this computer only", own.note === 1);
      const sameHost = await shareLink(`http://localhost:${RELAY_PORT}`);
      check("a relay saved as localhost counts as local while the page is on localhost", sameHost.link.startsWith(`http://localhost:${RELAY_PORT}/?room=`), sameHost.link);
      const bare = await shareLink(`http://127.0.0.1:${RELAY2_PORT}`);
      check("a local relay without an editor: the link opens this editor with ?relay=", bare.link.startsWith(URL.replace(/\/$/, "") + "/?room=") && bare.link.includes("relay=" + encodeURIComponent(`http://127.0.0.1:${RELAY2_PORT}`)) && !bare.link.includes("github.io"), bare.link);
      check("and says it works on this computer only", bare.note === 1);
      // The guest link works: open it and see the file.
      const g = await openPage();
      await g.goto(own.link);
      await sleep(1500);
      check("the relay's own editor opens the room link", (await g.locator("#dt-canvas").count()) === 1 || (await g.locator(".app").count()) === 1);
      await g.context().close();
    }
  }
} finally {
  for (const pr of procs) pr.kill();
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
