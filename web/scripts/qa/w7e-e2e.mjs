// W7-E: keyboard use and accessibility of menus, dialogs, the dashboard, the presenter and the
// chat panel. After the page loads, everything is driven by page.keyboard.
// Env: E2E_URL (the editor, default http://localhost:5341), CHROMIUM, AXE_PATH (axe.min.js; the
// copy in web/node_modules is used when there is one).
// No Claude is contacted: chat runs in API mode against a stubbed Messages endpoint.

import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const URL = process.env.E2E_URL ?? "http://localhost:5341";
const here = path.dirname(fileURLToPath(import.meta.url));
const AXE = [path.join(here, "../../node_modules/axe-core/axe.min.js"), process.env.AXE_PATH, "/tmp/claude-0/-home-user-designotron/286bf7bb-781e-5d8f-9708-6c1f94840e4a/scratchpad/qa7/I-a11y/node_modules/axe-core/axe.min.js"].find((p) => p && fs.existsSync(p));

const launch = { headless: true, args: ["--no-sandbox"] };
launch.executablePath = process.env.CHROMIUM ?? (fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
if (!launch.executablePath) delete launch.executablePath;

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const browser = await chromium.launch(launch);
const errors = [];

/** A fresh browser context and page; `api` puts the chat in API mode with a made-up key. */
async function newPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await page.addInitScript((api) => {
    try {
      localStorage.setItem("dt:tour-done", "1");
      if (api) {
        localStorage.setItem("dt:chatMode", "api");
        localStorage.setItem("dt:apiKey", "sk-ant-test");
        localStorage.setItem("dt:keyChecked", "1");
      }
    } catch {
      /* sandboxed */
    }
  }, !!opts.api);
  page.on("pageerror", (e) => errors.push(String(e)));
  return page;
}

/** The element with focus, described. */
const focused = (page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return { tag: "NONE" };
    return {
      tag: el.tagName,
      id: el.id,
      role: el.getAttribute("role"),
      label: el.getAttribute("aria-label") || (el.textContent || "").trim().slice(0, 40),
      inMenu: !!el.closest(".menu"),
      inPresenter: !!el.closest(".presenter"),
      inModal: !!el.closest(".modal"),
      cls: el.className?.toString?.() ?? "",
    };
  });

/** Focuses an element the way a keyboard user gets there: after a key press (focus that follows a
 *  mouse click is treated as pointer focus, where Enter acts on the design). */
async function kbFocus(page, selector) {
  await page.keyboard.press("F7");
  await page.locator(selector).first().focus();
}

/** Presses Tab until `test(focused element)` holds; the number of presses, or -1. */
async function tabTo(page, test, max = 60, key = "Tab") {
  for (let i = 1; i <= max; i++) {
    await page.keyboard.press(key);
    if (await page.evaluate(test)) return i;
  }
  return -1;
}

const doc = (page) => page.evaluate(() => window.__dt.doc());
const nodeNamed = async (page, name) => Object.values((await doc(page)).nodes).find((n) => n.name === name);

try {
  // ---------- Dashboard: cards by keyboard ----------
  {
    const page = await newPage();
    await page.goto(URL);
    await page.waitForSelector(".files", { timeout: 20000 });
    await page.click("button:has-text('New design file')");
    await page.waitForSelector("#dt-canvas", { timeout: 20000 });
    await page.waitForTimeout(500);
    await page.evaluate(() => (location.hash = "#/"));
    await page.waitForSelector(".files");
    await page.reload();
    await page.waitForSelector(".file-card .more", { timeout: 20000 });
    check("dashboard has one <main> and one <h1>", (await page.locator("main").count()) === 1 && (await page.locator("h1").count()) === 1);
    const stops = await tabTo(page, () => document.activeElement?.matches(".file-card .file-open") && /Edited/.test(document.activeElement.textContent), 40);
    check("Tab reaches the first saved file card", stops > 0, `${stops} Tab presses`);
    await page.keyboard.press("Enter");
    const opened = await page.waitForSelector("#dt-canvas", { timeout: 15000 }).then(() => true, () => false);
    check("Enter on a file card opens the editor", opened);
    await page.waitForTimeout(600);
    const f = await focused(page);
    // An empty file puts focus in the "What do you want to design?" prompt (round 21); any other focuses the canvas.
    check("a newly opened file focuses the canvas or its empty-file prompt", f.id === "dt-canvas" || f.id === "empty-prompt-input", JSON.stringify(f));


    // The "more" button: named, and its menu opens at the button and is operable.
    await page.evaluate(() => (location.hash = "#/"));
    await page.waitForSelector(".file-card .more");
    const label = await page.locator(".file-card .more").first().getAttribute("aria-label");
    check("the more button names its file", /^More actions for .+/.test(label ?? ""), label ?? "");
    await kbFocus(page, ".file-card .more");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".menu");
    const box = await page.locator(".menu").boundingBox();
    const btn = await page.locator(".file-card .more").first().boundingBox();
    check("file menu opens at the button (not at 8,8)", Math.abs(box.x - btn.x) < 40 && box.y > btn.y, `menu ${Math.round(box.x)},${Math.round(box.y)} button ${Math.round(btn.x)},${Math.round(btn.y)}`);
    const f2 = await focused(page);
    check("focus is on the first menu item", f2.inMenu && f2.role === "menuitem" && f2.label === "Open", JSON.stringify(f2));
    await page.keyboard.press("Escape");
    const f3 = await focused(page);
    check("Escape returns focus to the more button", f3.label?.startsWith("More actions") && (await page.locator(".menu").count()) === 0, JSON.stringify(f3));
    await page.context().close();
  }

  // ---------- Editor: menus, fields, focus ----------
  {
    const page = await newPage();
    await page.goto(URL);
    await page.waitForSelector(".files", { timeout: 20000 });
    await page.click("button:has-text('New design file')");
    await page.waitForSelector("#dt-canvas", { timeout: 20000 });
    await page.waitForTimeout(500);
    await page.evaluate(() =>
      window.__dt.tool("create_nodes", {
        nodes: [
          { type: "frame", name: "Card", x: 0, y: 0, width: 300, height: 200, fill: "#FFFFFF", children: [{ type: "rectangle", name: "Box", x: 20, y: 20, width: 100, height: 60, fill: "#7C5CFF" }] },
        ],
      }),
    );
    await page.evaluate(() => window.__dt.zoomToFit());
    const card = await nodeNamed(page, "Card");
    const box = await nodeNamed(page, "Box");
    await page.evaluate((id) => window.__dt.dispatch({ op: "select", ids: [id] }), card.id);
    await page.waitForTimeout(300);

    check("editor has a <main>, a <header> and an <h1>", (await page.locator("main").count()) === 1 && (await page.locator("header.topbar").count()) === 1 && (await page.locator("h1").count()) === 1);

    // Main menu
    await kbFocus(page, ".tbtn[title='Main menu']");
    check("main menu trigger announces a menu", (await page.getAttribute(".tbtn[title='Main menu']", "aria-haspopup")) === "menu" && (await page.getAttribute(".tbtn[title='Main menu']", "aria-expanded")) === "false");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".menu[role=menu]");
    let f = await focused(page);
    check("Enter on the trigger puts focus on the first menu item", f.inMenu && f.role === "menuitem" && f.label.startsWith("Back to files"), JSON.stringify(f));
    check("trigger reports expanded while open", (await page.getAttribute(".tbtn[title='Main menu']", "aria-expanded")) === "true");
    const labels = await page.$$eval(".menu [role=menuitem]", (els) => els.map((e) => e.textContent.trim()));
    const at = labels.findIndex((l) => l.startsWith("Keyboard shortcuts"));
    for (let i = 0; i < at; i++) await page.keyboard.press("ArrowDown");
    f = await focused(page);
    check("ArrowDown moves through the items", f.label.startsWith("Keyboard shortcuts"), f.label);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowUp");
    f = await focused(page);
    check("ArrowUp moves back", f.label.startsWith("Keyboard shortcuts"), f.label);
    await page.keyboard.press("Home");
    f = await focused(page);
    const home = f.label;
    await page.keyboard.press("End");
    f = await focused(page);
    check("Home and End jump to the first and last item", home.startsWith("Back to files") && f.label.startsWith("About Designotron"), `${home} / ${f.label}`);
    await page.keyboard.press("Home");
    await page.keyboard.type("k");
    f = await focused(page);
    check("typing a letter jumps to the item that starts with it", f.label.startsWith("Keyboard shortcuts"), f.label);
    const before = await nodeNamed(page, "Card");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".shortcuts-dialog");
    const after = await nodeNamed(page, "Card");
    check("menu keys don't reach the canvas shortcuts", before.x === after.x && before.y === after.y && (await page.evaluate(() => window.__dt.state().selection.length)) === 1);
    check("Enter on 'Keyboard shortcuts' opens the dialog", true);
    await page.keyboard.press("Escape");
    await page.waitForSelector(".shortcuts-dialog", { state: "detached" });
    f = await focused(page);
    check("closing a dialog opened from the menu returns focus to the trigger", f.cls.includes("tbtn") && (await page.evaluate(() => document.activeElement.title)) === "Main menu", JSON.stringify(f));
    await page.keyboard.press("Enter");
    await page.waitForSelector(".menu");
    await page.keyboard.press("Escape");
    f = await focused(page);
    check("Escape closes the menu and focus goes back to the trigger", (await page.locator(".menu").count()) === 0 && (await page.evaluate(() => document.activeElement.title)) === "Main menu", JSON.stringify(f));
    await page.keyboard.press("Enter");
    await page.waitForSelector(".menu");
    await page.keyboard.press("Tab");
    check("Tab closes the menu", (await page.locator(".menu").count()) === 0);
    await page.keyboard.press("Escape");

    // A menu opened with the mouse keeps its items unhighlighted until an arrow key
    await page.click(".tbtn[title='Main menu']");
    await page.waitForSelector(".menu");
    f = await focused(page);
    check("a mouse-opened menu has focus on the menu, not on its first item", f.inMenu && f.role === "menu", JSON.stringify(f));
    await page.keyboard.press("ArrowDown");
    check("ArrowDown then focuses the first item", (await focused(page)).label.startsWith("Back to files"));
    await page.keyboard.press("Escape");

    // Context menu from the keyboard
    await kbFocus(page, "#dt-canvas");
    await page.keyboard.press("Shift+F10");
    const opened = await page.waitForSelector(".menu", { timeout: 3000 }).then(() => true, () => false);
    f = await focused(page);
    check("Shift+F10 on the canvas opens the context menu with focus inside it", opened && f.inMenu && f.role === "menuitem", JSON.stringify(f));
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    check("arrows move inside the context menu (the selection stays)", (await page.evaluate(() => window.__dt.state().selection.length)) === 1 && (await focused(page)).inMenu);
    await page.keyboard.press("Escape");
    f = await focused(page);
    check("Escape closes it and focus returns to the canvas", (await page.locator(".menu").count()) === 0 && f.id === "dt-canvas", JSON.stringify(f));

    // The canvas focus ring belongs to keyboard users: no ring through mouse work after a key press
    const outline = () => page.evaluate(() => getComputedStyle(document.getElementById("dt-canvas")).outlineStyle);
    await page.locator("#dt-canvas").click({ position: { x: 60, y: 500 } });
    await page.keyboard.press("v");
    await page.locator("#dt-canvas").click({ position: { x: 80, y: 520 } });
    check("no focus ring on the canvas during mouse work after a key press", (await outline()) === "none", await outline());
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    check("Tab to the canvas shows the focus ring", (await focused(page)).id === "dt-canvas" && (await outline()) === "solid", await outline());
    await page.locator("#dt-canvas").click({ position: { x: 80, y: 520 } });
    check("clicking the canvas removes the ring", (await outline()) === "none");

    // A button that was clicked doesn't keep Enter; arrows on a clicked tab nudge
    await page.evaluate((id) => window.__dt.dispatch({ op: "select", ids: [id] }), card.id);
    await page.waitForSelector("button[aria-label='Add fill']");
    const fills = async () => (await nodeNamed(page, "Card")).fills.length;
    const f0 = await fills();
    await page.click("button[aria-label='Add fill']");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    const sel = await page.evaluate(() => window.__dt.state().selection);
    check("Enter after clicking a button acts on the design (no second fill, children selected)", (await fills()) === f0 + 1 && sel.length === 1 && sel[0] === box.id, `${f0} -> ${await fills()}, selection ${sel.length}`);
    await page.evaluate((id) => window.__dt.dispatch({ op: "select", ids: [id] }), card.id);
    await page.click("#right-tab-design");
    const x0 = (await nodeNamed(page, "Card")).x;
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(200);
    check("arrows after clicking a tab nudge the selection instead of switching tabs", (await page.getAttribute("#right-tab-design", "aria-selected")) === "true" && (await nodeNamed(page, "Card")).x === x0 + 1);
    await page.evaluate((id) => window.__dt.dispatch({ op: "select", ids: [id] }), card.id);
    await kbFocus(page, "#right-tab-design");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("ArrowRight");
    check("arrows on a keyboard-focused tab still switch tabs", (await page.getAttribute("#right-tab-prototype", "aria-selected")) === "true");
    await page.click("#right-tab-design");

    // Hovering a menu item focuses it, so hover and keyboard show one item
    await kbFocus(page, ".tbtn[title='Main menu']");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".menu");
    await page.hover(".menu [role=menuitem]:has-text('Undo')");
    check("the hovered menu item is the focused one", (await focused(page)).label.startsWith("Undo"));
    await page.keyboard.press("Escape");

    // Number fields keep focus on Enter
    await page.evaluate((id) => window.__dt.dispatch({ op: "select", ids: [id] }), box.id);
    await page.waitForSelector("input[aria-label='Width']");
    await kbFocus(page, "input[aria-label='Width']");
    await page.keyboard.type("150");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    const w = (await nodeNamed(page, "Box")).width;
    f = await focused(page);
    check("Enter in the W field commits and keeps focus there", w === 150 && f.tag === "INPUT" && f.label === "Width", `width ${w}, focus ${JSON.stringify(f)}`);
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(300);
    const undone = (await nodeNamed(page, "Box")).width;
    check("Ctrl+Z in a committed field undoes the design change", undone === 100 && (await focused(page)).tag === "INPUT" && (await page.locator("input[aria-label='Width']").inputValue()) === "100", `width ${undone}`);
    await page.keyboard.press("Control+Shift+z");
    await page.waitForTimeout(300);
    check("Ctrl+Shift+Z redoes it", (await nodeNamed(page, "Box")).width === 150);
    await page.keyboard.type("1e20");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    const big = (await nodeNamed(page, "Box")).width;
    check("number fields clamp huge values", big === 1e6, `width ${big}`);
    await page.keyboard.type("77");
    await page.keyboard.press("Escape");
    f = await focused(page);
    check("Escape reverts the field and focus goes to the canvas, not the body", (await nodeNamed(page, "Box")).width === 1e6 && f.id === "dt-canvas", JSON.stringify(f));

    // The Claude panel's close button
    await kbFocus(page, "#claude-toggle");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".chat");
    check("the Claude toggle reports pressed", (await page.getAttribute("#claude-toggle", "aria-pressed")) === "true");
    await kbFocus(page, "button[aria-label='Close Claude panel']");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".chat", { state: "detached" });
    f = await focused(page);
    check("closing the Claude panel with its X leaves focus on its toolbar button", f.tag !== "BODY" && f.id === "claude-toggle", JSON.stringify(f));

    // Presenter
    await kbFocus(page, ".tbtn[title^='Present (']");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".presenter");
    await page.waitForTimeout(200);
    let inside = 0;
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press("Tab");
      if ((await focused(page)).inPresenter) inside++;
    }
    check("Presenter: Tab x4 stays inside", inside === 4);
    await page.keyboard.press("Shift+Tab");
    check("Presenter: Shift+Tab stays inside", (await focused(page)).inPresenter);
    await page.keyboard.press("Escape");
    await page.waitForSelector(".presenter", { state: "detached" });
    f = await focused(page);
    check("leaving the presenter returns focus to the Present button", (await page.evaluate(() => document.activeElement.title)).startsWith("Present"), JSON.stringify(f));

    // Labels, roles and live regions
    check("tool buttons report pressed", (await page.getAttribute(".tbtn[title^='Move']", "aria-pressed")) === "true" && (await page.getAttribute(".tbtn[title^='Hand']", "aria-pressed")) === "false");
    check("save state is a status region", (await page.getAttribute(".save-state", "role")) === "status");
    check("file name input is labelled", (await page.getAttribute("input.filename", "aria-label")) === "File name");
    check("right panel tabs control a tabpanel", (await page.getAttribute("#right-tab-design", "aria-controls")) === "right-tabpanel" && (await page.getAttribute("#right-tabpanel", "role")) === "tabpanel");
    await page.evaluate((id) => window.__dt.dispatch({ op: "select", ids: [id] }), card.id);
    await page.evaluate(() => window.__dt.tool("create_nodes", { nodes: [{ type: "frame", name: "Stack", x: 400, y: 0, width: 200, height: 200, layout: { direction: "vertical", padding: 8, gap: 8 }, children: [{ type: "rectangle", name: "A", width: 50, height: 50 }] }] }));
    const stack = await nodeNamed(page, "Stack");
    await page.evaluate((id) => window.__dt.dispatch({ op: "select", ids: [id] }), stack.id);
    await page.waitForSelector(".align-grid");
    const names = await page.$$eval(".align-grid button", (els) => els.map((e) => e.getAttribute("aria-label")));
    check("the 9 alignment buttons are named", names.length === 9 && names.every(Boolean) && names[0] === "Align top left" && names[8] === "Align bottom right", names.join("|"));

    // Share dialog in a short window: the body scrolls and the focused control is visible
    await kbFocus(page, ".tbtn[title='Share for live editing']");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".share-dialog");
    await page.setViewportSize({ width: 640, height: 360 });
    await page.waitForTimeout(200);
    const m = await page.locator(".share-dialog").boundingBox();
    check("Share dialog fits a 640x360 window", m.y >= 0 && m.y + m.height <= 360, `modal y ${Math.round(m.y)} h ${Math.round(m.height)}`);
    const n = await tabTo(page, () => /Copy link/.test(document.activeElement?.textContent ?? ""), 20);
    const r = await page.evaluate(() => {
      const b = document.activeElement.getBoundingClientRect();
      return { top: b.top, bottom: b.bottom, h: innerHeight };
    });
    check("the focused Copy link button is scrolled into view", n > 0 && r.top >= 0 && r.bottom <= r.h, `${n} Tabs, top ${Math.round(r.top)} bottom ${Math.round(r.bottom)} of ${r.h}`);
    check("the Share dialog has a live status region for 'Link copied'", (await page.locator(".share-dialog [role=status][aria-live=polite]").count()) === 1);
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1400, height: 900 });

    // Reduced motion: animations collapse to nothing
    const anim = () =>
      page.evaluate(() => {
        const el = document.createElement("div");
        el.className = "spin";
        document.body.appendChild(el);
        const d = getComputedStyle(el).animationDuration;
        el.remove();
        return d;
      });
    const normal = await anim();
    await page.emulateMedia({ reducedMotion: "reduce" });
    const reduced = await anim();
    check("prefers-reduced-motion switches animations off", normal !== reduced && parseFloat(reduced) < 0.001, `${normal} -> ${reduced}`);
    await page.context().close();
  }

  // ---------- axe-core ----------
  if (!AXE) check("axe-core is available", false, "set AXE_PATH");
  else {
    const page = await newPage();
    await page.goto(URL);
    await page.waitForSelector(".files", { timeout: 20000 });
    const RULES = ["label", "button-name", "select-name", "aria-required-children", "aria-required-parent", "aria-allowed-role", "aria-valid-attr-value", "landmark-one-main", "page-has-heading-one"];
    const scan = async (name, rules = RULES, context = null) => {
      await page.addScriptTag({ path: AXE });
      const res = await page.evaluate(
        async ({ rules, context }) => {
          const r = await window.axe.run(context ? document.querySelector(context) : document, { runOnly: { type: "rule", values: rules }, resultTypes: ["violations"] });
          return r.violations.map((v) => `${v.id}(${v.nodes.length}): ${v.nodes[0].target.join(" ")}`);
        },
        { rules, context },
      );
      check(`axe: ${name} has no violations of ${rules.length > 3 ? "the label/name/structure rules" : rules.join(", ")}`, res.length === 0, res.join("; "));
    };
    await scan("dashboard");
    await page.click("button:has-text('New design file')");
    await page.waitForSelector("#dt-canvas", { timeout: 20000 });
    await page.waitForTimeout(500);
    await scan("empty editor");
    await page.evaluate(() => window.__dt.tool("create_nodes", { nodes: [{ type: "frame", name: "Screen", x: 0, y: 0, width: 300, height: 300, fill: "#FFFFFF", layout: { direction: "vertical", padding: 8, gap: 8 }, children: [{ type: "rectangle", name: "Hero", width: 100, height: 60, fill: "#7C5CFF" }, { type: "text", name: "Title", text: "Hello", fontSize: 20 }] }] }));
    const hero = await nodeNamed(page, "Hero");
    await page.evaluate((id) => window.__dt.dispatch({ op: "select", ids: [id] }), hero.id);
    await page.waitForTimeout(300);
    await scan("editor with a selection");
    const screen = await nodeNamed(page, "Screen");
    await page.evaluate((id) => window.__dt.dispatch({ op: "select", ids: [id] }), screen.id);
    await page.waitForTimeout(300);
    await scan("editor with a frame selected (auto layout, effects)");
    for (const tab of ["Code", "Prototype"]) {
      await page.click(`#right-tab-${tab.toLowerCase()}`);
      await page.waitForTimeout(200);
      await scan(`the ${tab} tab`, RULES.concat(["scrollable-region-focusable"]), ".panel.right");
    }
    await page.click("#right-tab-design");
    // Menu hover contrast
    await page.click(".tbtn[title='Main menu']");
    await page.waitForSelector(".menu");
    await page.hover(".menu [role=menuitem]:has-text('Undo')");
    await page.waitForTimeout(150);
    await scan("a hovered menu item", ["color-contrast", "aria-required-children", "aria-required-parent"], ".menu");
    await page.keyboard.press("Escape");
    await page.click("#claude-toggle");
    await page.waitForSelector(".chat");
    await scan("Claude panel", RULES.concat(["scrollable-region-focusable"]), ".chat");
    await page.context().close();
  }

  // ---------- Chat panel (API mode, stubbed endpoint) ----------
  {
    const page = await newPage({ api: true });
    let requests = 0;
    /** Per-request plan: what the stub answers with, set by each part below. */
    let plan = () => ({ text: "ok" });
    const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
    const message = (content, stop) => [
      { type: "message_start", message: { id: "msg_" + requests, type: "message", role: "assistant", content: [], model: "claude-opus-5-5", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
      ...content.flatMap((c, i) =>
        c.type === "text"
          ? [
              { type: "content_block_start", index: i, content_block: { type: "text", text: "" } },
              { type: "content_block_delta", index: i, delta: { type: "text_delta", text: c.text } },
              { type: "content_block_stop", index: i },
            ]
          : [
              { type: "content_block_start", index: i, content_block: { type: "tool_use", id: c.id, name: c.name, input: {} } },
              { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(c.input) } },
              { type: "content_block_stop", index: i },
            ],
      ),
      { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } },
      { type: "message_stop" },
    ];
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
    await page.route("**/v1/messages*", async (route) => {
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
      requests++;
      const p = plan(requests);
      if (p.delay) await new Promise((r) => setTimeout(r, p.delay));
      const body = p.tools ? message(p.tools.map((t, i) => ({ type: "tool_use", id: "tu_" + requests + "_" + i, name: t, input: {} })), "tool_use") : message([{ type: "text", text: p.text }], "end_turn");
      await route.fulfill({ status: 200, headers: { ...cors, "content-type": "text/event-stream" }, body: sse(body) });
    });
    await page.goto(URL);
    await page.waitForSelector(".files", { timeout: 20000 });
    await page.click("button:has-text('New design file')");
    await page.waitForSelector("#dt-canvas", { timeout: 20000 });
    await page.keyboard.press("Control+/");
    await page.waitForSelector(".chat");
    const textarea = page.locator(".chat-input textarea");

    // Markdown
    plan = () => ({ text: "**Hi** there, use `x` and *this*.\n\n- one\n- two\n\n```\nconst a = 1 < 2;\n```\n[docs](https://example.com) [bad](javascript:alert(1))" });
    await textarea.fill("hello");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".msg.assistant");
    await page.waitForFunction(() => !window.__dt.chat().running);
    const html = await page.locator(".msg.assistant").first().innerHTML();
    const text = await page.locator(".msg.assistant").first().innerText();
    check("assistant Markdown renders <strong> and <code>", html.includes("<strong>Hi</strong>") && html.includes("<code>x</code>") && html.includes("<em>this</em>"));
    check("no raw Markdown asterisks or backticks remain", !/[*`]/.test(text), text.replace(/\n/g, " | "));
    check("lists and fenced code render as elements", html.includes("<ul>") && html.includes("<li>one</li>") && html.includes('<pre class="md-code">'));
    check("http links become links, javascript: links don't", html.includes('href="https://example.com"') && !html.includes("javascript:"));
    check("code in a reply is escaped, not parsed as HTML", html.includes("1 &lt; 2"));
    check("the chat log is a labelled live log", (await page.getAttribute(".chat-log", "role")) === "log" && (await page.getAttribute(".chat-log", "aria-live")) === "polite");

    // 80 chips
    requests = 0;
    plan = (n) => (n === 1 ? { tools: Array(80).fill("get_document") } : { text: "done" });
    await textarea.fill("many steps");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.__dt.chat().items.filter((i) => i.kind === "tool").length >= 80 && !window.__dt.chat().running, null, { timeout: 30000 });
    await page.waitForTimeout(300);
    const heights = await page.$$eval(".tool-chip", (els) => els.map((e) => e.getBoundingClientRect().height));
    check("a long session keeps every tool chip at least 20 px tall", heights.length >= 80 && Math.min(...heights) >= 20, `${heights.length} chips, smallest ${Math.min(...heights).toFixed(1)} px`);

    // A turn in progress: Stop stays next to Queue; the empty page says Claude is working
    await page.evaluate(() => {
      const d = window.__dt.doc();
      window.__dt.tool("delete_nodes", { ids: Object.values(d.nodes).filter((n) => !n.parent).map((n) => n.id) });
    });
    requests = 0;
    plan = () => ({ text: "slow answer", delay: 3000 });
    await textarea.fill("take your time");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.__dt.chat().running);
    await textarea.fill("and then this");
    check("while running, Stop and Queue are both visible", (await page.locator(".chat-input button:has-text('Stop')").isVisible()) && (await page.locator(".chat-input button:has-text('Queue')").isVisible()));
    const empty = await page.locator(".empty-prompt").innerText().catch(() => "");
    check("the empty-page prompt says Claude is working, not 'Connect Claude'", /Claude is working/.test(empty) && !/Connect Claude/.test(empty) && (await page.locator("text=Connect Claude").count()) === 0, empty.slice(0, 80));
    await page.locator(".chat-input button:has-text('Stop')").click();
    await page.waitForFunction(() => !window.__dt.chat().running);
    await page.waitForTimeout(3500);
    await page.context().close();

    // Offline queue: a message that waited more than 10 s for a key is confirmed first.
    // Two pages wait together: one answers the question, the other sends something newer.
    const queued = async (name) => {
      const pg = await newPage();
      pg.bodies = [];
      await pg.route("**/v1/messages*", async (route) => {
        if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
        pg.bodies.push(route.request().postData() ?? "");
        await route.fulfill({ status: 200, headers: { ...cors, "content-type": "text/event-stream" }, body: sse(message([{ type: "text", text: "sent after confirmation" }], "end_turn")) });
      });
      await pg.addInitScript(() => localStorage.setItem("dt:chatMode", "api"));
      await pg.goto(URL);
      await pg.waitForSelector(".files", { timeout: 20000 });
      await pg.click("button:has-text('New design file')");
      await pg.waitForSelector("#dt-canvas", { timeout: 20000 });
      await pg.keyboard.press("Control+/");
      await pg.waitForSelector(".chat");
      await pg.locator(".chat-input textarea").fill(name);
      await pg.keyboard.press("Enter");
      await pg.waitForFunction(() => window.__dt.chat().queued);
      return pg;
    };
    const p2 = await queued("make a poster");
    const p3 = await queued("old request");
    await p2.waitForTimeout(10500);
    for (const pg of [p2, p3]) {
      await pg.locator(".bridge-setup input[type=password]").fill("sk-ant-test");
      await pg.locator(".bridge-setup button:has-text('Connect')").first().click();
      await pg.waitForSelector("text=Send queued message?");
    }
    await p2.waitForTimeout(500);
    check("a prompt that waited over 10 s asks before sending", p2.bodies.length === 0 && (await p2.locator("text=Send queued message?").count()) >= 1, `${p2.bodies.length} requests`);
    await p2.locator(".chat-input button:has-text('Send')").first().click();
    await p2.waitForFunction(() => window.__dt.chat().items.some((i) => i.kind === "assistant"), null, { timeout: 10000 });
    check("Send sends it", p2.bodies.length === 1 && p2.bodies[0].includes("make a poster"));
    await p3.locator(".chat-input textarea").fill("a newer message");
    await p3.keyboard.press("Enter");
    await p3.waitForFunction(() => window.__dt.chat().items.some((i) => i.kind === "assistant"), null, { timeout: 10000 });
    await p3.waitForTimeout(500);
    check("a new message replaces the queued one waiting for confirmation", p3.bodies.length === 1 && p3.bodies[0].includes("a newer message") && !p3.bodies[0].includes("old request") && (await p3.locator("text=Send queued message?").count()) === 0, `${p3.bodies.length} requests`);
    await p2.context().close();
    await p3.context().close();
  }

  const page = await newPage();
  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await page.context().close();
} catch (err) {
  check("script finished without throwing", false, String(err?.stack ?? err));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
