// r16a: Layers panel parity. Shift-range select, reveal on canvas select, multi-layer drag order,
// Alt-click expand all, Alt+L collapse all, search and filter, the full context menu, Tab rename.
// Builds a 2,333-layer file (6 screens of 34 cards) and drives the panel with real input.
// Usage: vite preview on E2E_URL's port (default 6801), then `node scripts/qa/r16a-e2e.mjs`.
// Env: E2E_URL, CHROMIUM, SHOTS (folder for the screenshots, default none). Only local requests are allowed.

import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const URL = process.env.E2E_URL ?? "http://localhost:6801/";
const SHOTS = process.env.SHOTS ?? "";

const launch = { headless: true, args: ["--no-sandbox"] };
if (process.env.CHROMIUM) launch.executablePath = process.env.CHROMIUM;
else if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";

let failed = 0;
let passed = 0;
function check(name, ok, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== "" ? "  — " + String(detail).slice(0, 300) : ""}`);
}

const browser = await chromium.launch(launch);

async function open(scheme = "dark", scale = 1) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme, deviceScaleFactor: scale });
  await context.route(
    (u) => !/^(127\.0\.0\.1|localhost)$/.test(new globalThis.URL(u).hostname) && !/^(data|blob):/.test(u.toString()),
    (r) => r.abort(),
  );
  const page = await context.newPage();
  await page.addInitScript(() => {
    try {
      localStorage.setItem("dt:tour-done", "1");
    } catch {
      /* no storage */
    }
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  if (process.env.DEBUG) page.on("console", (m) => console.log("console:", m.text()));
  await page.goto(URL);
  await page.waitForSelector(".files");
  await page.click("button:has-text('New design file')");
  await page.waitForSelector("#dt-canvas");
  await page.waitForTimeout(800);
  return { context, page, errors };
}

/** The tester's 2,333-layer document: 6 screens of 34 cards, plus two components. */
async function build(page) {
  return page.evaluate(async () => {
    const T = (n, i) => window.__dt.tool(n, i);
    const c = await T("create_nodes", {
      nodes: [
        {
          type: "component", name: "Button/Primary", x: 0, y: -400, width: 160, height: 48, fill: "#7C5CFF", cornerRadius: 10,
          layout: { direction: "horizontal", align: "center", crossAlign: "center", padding: 12 },
          children: [
            { type: "text", name: "Label", text: "Continue", fontSize: 15, fill: "#FFFFFF" },
            { type: "rectangle", name: "Ripple", width: 8, height: 8, fill: "#FFFFFF", cornerRadius: 4 },
          ],
        },
        { type: "component", name: "Icon/Search", x: 220, y: -400, width: 24, height: 24, children: [{ type: "ellipse", name: "Ring", width: 18, height: 18, stroke: "#888888", strokeWidth: 2, fill: "none" }] },
      ],
    });
    const [btn, icon] = c.result.created.map((x) => x.id);
    const cardFor = (i, s) => ({
      type: "frame", name: `Card ${String(i).padStart(2, "0")}`, width: "fill", height: "hug", fill: s.dark ? "#1E1E24" : "#F7F7FA", cornerRadius: 12,
      layout: { direction: "horizontal", gap: 12, padding: 12, crossAlign: "center" },
      children: [
        { type: "rectangle", name: "Thumb", width: 48, height: 48, fill: `linear-gradient(135deg, #${(0x335577 + i * 4099).toString(16).slice(-6)} 0%, #7C5CFF 100%)`, cornerRadius: 8 },
        {
          type: "frame", name: "Copy", width: "fill", height: "hug", layout: { direction: "vertical", gap: 2 },
          children: [
            { type: "text", name: "Title", width: "fill", text: `Project item ${i + 1} of ${s.n}`, fontSize: 15, fill: s.dark ? "#FFFFFF" : "#111111" },
            { type: "text", name: "Body", width: "fill", text: "Updated 2 hours ago by Mira", fontSize: 12, fill: "#888888" },
          ],
        },
        {
          type: "group", name: "Tag group",
          children: [
            { type: "rectangle", name: "Tag bg", x: 0, y: 0, width: 56, height: 20, fill: "#E4DEFF", cornerRadius: 10 },
            { type: "text", name: "Tag", x: 10, y: 3, text: "Live", fontSize: 11, fill: "#4F46E5" },
          ],
        },
        { type: "instance", name: "Open button", componentId: btn, width: 160, height: 48 },
      ],
    });
    const names = ["Home", "Search", "Project", "Inbox", "Profile", "Settings"];
    const screens = [];
    for (let s = 0; s < 6; s++) {
      const dark = s % 2 === 1;
      const N = 34;
      const cards = [];
      for (let i = 0; i < N; i++) cards.push(cardFor(i, { dark, n: N }));
      screens.push({
        type: "frame", name: `Screen ${s + 1} / ${names[s]}`, x: s * 460, y: 0, width: 390, height: 844, fill: dark ? "#14141A" : "#FFFFFF", clip: true,
        layout: { direction: "vertical", gap: 12, padding: [48, 16, 16, 16] },
        children: [
          {
            type: "frame", name: "Header", width: "fill", height: 44, layout: { direction: "horizontal", align: "space-between", crossAlign: "center" },
            children: [
              { type: "text", name: "Screen title", text: names[s], fontSize: 22, fill: dark ? "#FFFFFF" : "#111111" },
              { type: "instance", name: "Search icon", componentId: icon, width: 24, height: 24 },
              { type: "frame", name: "Avatar", width: 32, height: 32, cornerRadius: 16, fill: "#B0A4FF" },
            ],
          },
          {
            type: "frame", name: "Chips", width: "fill", height: 32, layout: { direction: "horizontal", gap: 8 },
            children: [
              { type: "frame", name: "Chip A", width: 72, height: 32, cornerRadius: 16, fill: "#7C5CFF" },
              { type: "frame", name: "Chip B", width: 72, height: 32, cornerRadius: 16, fill: "#2A2A33" },
              { type: "frame", name: "Chip C", width: 72, height: 32, cornerRadius: 16, fill: "#2A2A33" },
            ],
          },
          { type: "frame", name: "List", width: "fill", height: "hug", layout: { direction: "vertical", gap: 8 }, children: cards },
          {
            type: "group", name: "Footer group",
            children: [
              { type: "rectangle", name: "Divider", x: 0, y: 0, width: 358, height: 1, fill: "#CCCCCC" },
              { type: "text", name: "Footer note", x: 0, y: 12, text: "End of list", fontSize: 12, fill: "#888888" },
            ],
          },
        ],
      });
    }
    const r = await T("create_nodes", { nodes: screens });
    const d = window.__dt.doc();
    let count = 0;
    const walk = (id) => {
      count++;
      (d.nodes[id]?.children || []).forEach(walk);
    };
    d.pages.forEach((p) => p.children.forEach(walk));
    return { ok: r.ok, layers: count };
  });
}

const SCROLL = "#left-tabpanel > .scroll";
const R = "Screen 1 / Home";
const idPath = (page, p) =>
  page.evaluate((names) => {
    const d = window.__dt.doc();
    let ids = d.pages.flatMap((pg) => pg.children);
    let found = null;
    for (const nm of names) {
      found = ids.find((id) => d.nodes[id].name === nm);
      if (!found) return null;
      ids = d.nodes[found].children;
    }
    return found;
  }, p);
const row = (page, id) => page.locator(`[role=treeitem][data-layer="${id}"]`);
const selNames = (page) => page.evaluate(() => window.__dt.state().selection.map((id) => window.__dt.doc().nodes[id]?.name));
const kids = (page, id) => page.evaluate((i) => window.__dt.doc().nodes[i].children.map((c) => window.__dt.doc().nodes[c].name), id);
const twisty = (page, id, opts) => row(page, id).locator(".twisty").click(opts);
const focusCanvas = (page) => page.evaluate(() => document.getElementById("dt-canvas").focus());
/** Scrolls the tree and reports the rows that are drawn, with their open state. */
async function sweepRows(page) {
  return page.evaluate(async () => {
    const el = document.querySelector("#left-tabpanel > .scroll");
    const open = new Set();
    const shut = new Set();
    for (let top = 0; top <= el.scrollHeight; top += 400) {
      el.scrollTop = top;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      for (const r of el.querySelectorAll("[role=treeitem][aria-expanded]")) (r.getAttribute("aria-expanded") === "true" ? open : shut).add(r.dataset.layer);
    }
    el.scrollTop = 0;
    return { open: [...open], shut: [...shut] };
  });
}

let ctx = await open("dark", 2);
let page = ctx.page;
const built = await build(page);
check("test file built", built.ok && built.layers > 2300, JSON.stringify(built));
await page.waitForTimeout(500);
const shot = async (name) => {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name) });
};

// Open Screen 1 and its list.
const screen1 = await idPath(page, [R]);
const list1 = await idPath(page, [R, "List"]);
await twisty(page, screen1);
await twisty(page, list1);
await page.waitForTimeout(200);
const card = (n) => idPath(page, [R, "List", `Card ${String(n).padStart(2, "0")}`]);
const pos = { x: 70, y: 15 };

// ---- L-01: Shift-click selects a range ----
{
  await row(page, await card(5)).click({ position: pos });
  await row(page, await card(10)).click({ position: pos, modifiers: ["Shift"] });
  let names = await selNames(page);
  check("L-01 Shift-click Card 10 after Card 05 selects the 6 rows between", names.length === 6 && ["05", "06", "07", "08", "09", "10"].every((n) => names.includes(`Card ${n}`)), names.join(","));
  await row(page, await card(7)).click({ position: pos, modifiers: ["Control"] });
  names = await selNames(page);
  check("L-01 Ctrl-click Card 07 toggles it off and leaves 5", names.length === 5 && !names.includes("Card 07"), names.join(","));
  await row(page, await card(2)).click({ position: pos, modifiers: ["Shift"] });
  names = await selNames(page);
  check("L-01 Shift-click Card 02 then ranges from Card 07 (the anchor moved)", names.length === 6 && ["02", "03", "04", "05", "06", "07"].every((n) => names.includes(`Card ${n}`)), names.join(","));
  // A frame in the range stands for its expanded children.
  await row(page, await idPath(page, [R, "List"])).click({ position: pos });
  await row(page, await card(33)).click({ position: pos, modifiers: ["Shift"] });
  names = await selNames(page);
  check("L-01 a frame in the range stands for its expanded children (List, not Card 33)", names.length === 1 && names[0] === "List", names.join(","));
  // Shift+Click with nothing selected selects just that row.
  await page.evaluate(() => window.__dt.dispatch({ op: "select", ids: [] }));
  await row(page, await card(12)).click({ position: pos, modifiers: ["Shift"] });
  names = await selNames(page);
  check("L-01 Shift-click with no selection selects that row", names.length === 1 && names[0] === "Card 12", names.join(","));
}

// ---- Alt+L and Alt-click expand / collapse all ----
{
  const tops = await page.evaluate(() => window.__dt.doc().pages.find((p) => p.id === window.__dt.state().page).children.length);
  await focusCanvas(page);
  await page.keyboard.press("Alt+L");
  await page.waitForTimeout(150);
  check("Alt+L collapses every row", (await page.locator("[role=treeitem][aria-expanded=true]").count()) === 0 && (await page.locator("[role=treeitem]").count()) === tops);
  const containers = await page.evaluate((id) => {
    const d = window.__dt.doc();
    const out = [id];
    const stack = [...d.nodes[id].children];
    while (stack.length) {
      const n = d.nodes[stack.pop()];
      if (n.children.length) {
        out.push(n.id);
        stack.push(...n.children);
      }
    }
    return out;
  }, screen1);
  await twisty(page, screen1, { modifiers: ["Alt"] });
  await page.waitForTimeout(300);
  let sweep = await sweepRows(page);
  const open = new Set(sweep.open);
  check("Alt-click on Screen 1's twisty expands every container below it", containers.every((id) => open.has(id)) && !sweep.shut.some((id) => containers.includes(id)), `${open.size}/${containers.length} open`);
  await twisty(page, screen1, { modifiers: ["Alt"] });
  await page.waitForTimeout(200);
  check("Alt-click again collapses it", (await page.locator("[role=treeitem]").count()) === tops);
  await twisty(page, screen1);
  await page.waitForTimeout(150);
  const header = await idPath(page, [R, "Header"]);
  check("...and every row below it is closed too", (await row(page, header).getAttribute("aria-expanded")) === "false" && (await page.locator("[role=treeitem][aria-expanded=true]").count()) === 1);
  await focusCanvas(page);
  await page.keyboard.press("Alt+L");
  await page.waitForTimeout(150);
  check("Alt+L collapses all again", (await page.locator("[role=treeitem][aria-expanded=true]").count()) === 0);
}

// ---- L-02: selecting on the canvas scrolls the panel ----
{
  const revealCase = async (label) => {
    await page.evaluate(() => {
      window.__dt.dispatch({ op: "select", ids: [] });
      document.querySelector("#left-tabpanel > .scroll").scrollTop = 0;
    });
    await page.waitForTimeout(100);
    const bg = await idPath(page, [R, "List", "Card 00", "Tag group", "Tag bg"]);
    const p = await page.evaluate((id) => {
      const d = window.__dt.doc();
      let n = d.nodes[id];
      let x = n.x;
      let y = n.y;
      for (let q = n.parent; q; q = d.nodes[q].parent) {
        x += d.nodes[q].x;
        y += d.nodes[q].y;
      }
      const r = document.getElementById("dt-canvas").getBoundingClientRect();
      const v = window.__dt.viewport();
      return { x: r.left + v.x + (x + 3) * v.zoom, y: r.top + v.y + (y + n.height / 2) * v.zoom };
    }, bg);
    await page.keyboard.down("Control");
    await page.mouse.click(p.x, p.y);
    await page.keyboard.up("Control");
    await page.waitForTimeout(400);
    const sel = await page.evaluate(() => window.__dt.state().selection);
    const info = await page.evaluate((id) => {
      const el = document.querySelector(`[data-layer="${id}"]`);
      const s = document.querySelector("#left-tabpanel > .scroll");
      const sr = s.getBoundingClientRect();
      if (!el) return { drawn: false, top: s.scrollTop };
      const r = el.getBoundingClientRect();
      return { drawn: true, inside: r.top >= sr.top - 1 && r.bottom <= sr.bottom + 1, top: s.scrollTop, row: [r.top, r.bottom], view: [sr.top, sr.bottom, s.clientHeight] };
    }, bg);
    check(`L-02 ${label}: canvas select of Tag bg draws its row inside the panel and scrolls`, sel[0] === bg && info.drawn && info.inside && info.top > 0, JSON.stringify(info));
  };
  await page.evaluate(() => window.__dt.dispatch({ op: "select", ids: [] }));
  await page.evaluate((id) => window.__dt.dispatch({ op: "select", ids: [id] }), screen1);
  await page.keyboard.press("Shift+2");
  await page.waitForTimeout(500);
  await focusCanvas(page);
  await page.keyboard.press("Alt+L");
  await revealCase("collapsed tree");
  await revealCase("already expanded");
}

// ---- L-03: several layers dragged in keep their order ----
{
  await focusCanvas(page);
  await page.keyboard.press("Alt+L");
  await page.evaluate(() => window.__dt.dispatch({ op: "select", ids: [] }));
  await twisty(page, screen1);
  const chips = await idPath(page, [R, "Chips"]);
  const header = await idPath(page, [R, "Header"]);
  await twisty(page, chips);
  await twisty(page, header);
  await page.waitForTimeout(200);
  const cb = await idPath(page, [R, "Chips", "Chip B"]);
  const cc = await idPath(page, [R, "Chips", "Chip C"]);
  const undo = async () => {
    await focusCanvas(page);
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(150);
  };
  const before = await kids(page, header);
  await page.evaluate((ids) => window.__dt.dispatch({ op: "select", ids }), [cb, cc]);
  await row(page, cc).dragTo(row(page, header), { targetPosition: { x: 60, y: 15 } });
  await page.waitForTimeout(300);
  let h = await kids(page, header);
  check("L-03 dragging Chip B and Chip C into Header keeps their order", h.length === before.length + 2 && h.slice(-2).join() === "Chip B,Chip C", h.join(","));
  await undo();
  check("L-03 one undo puts both back", (await kids(page, header)).join() === before.join() && (await kids(page, chips)).join() === "Chip A,Chip B,Chip C");
  const avatar = await idPath(page, [R, "Header", "Avatar"]);
  await page.evaluate((ids) => window.__dt.dispatch({ op: "select", ids }), [cb, cc]);
  await row(page, cc).dragTo(row(page, avatar), { targetPosition: { x: 60, y: 3 } });
  await page.waitForTimeout(300);
  h = await kids(page, header);
  check("L-03 dropping above a row keeps the order", h.join() === "Screen title,Search icon,Avatar,Chip B,Chip C", h.join(","));
  await undo();
  await page.evaluate((ids) => window.__dt.dispatch({ op: "select", ids }), [cb, cc]);
  await row(page, cc).dragTo(row(page, avatar), { targetPosition: { x: 60, y: 27 } });
  await page.waitForTimeout(300);
  h = await kids(page, header);
  check("L-03 dropping below a row keeps the order", h.join() === "Screen title,Search icon,Chip B,Chip C,Avatar", h.join(","));
  await undo();
  await page.evaluate((ids) => window.__dt.dispatch({ op: "select", ids }), [cb, cc]);
  await row(page, cb).dragTo(row(page, cc), { targetPosition: { x: 60, y: 15 } });
  await page.waitForTimeout(300);
  check("L-03 dropping onto a selected row does nothing", (await kids(page, chips)).join() === "Chip A,Chip B,Chip C" && (await kids(page, header)).join() === before.join());
  await page.evaluate(() => window.__dt.dispatch({ op: "select", ids: [] }));
}

// ---- Search and filter ----
{
  await focusCanvas(page);
  await page.keyboard.press("Alt+L");
  const field = page.getByRole("textbox", { name: "Search layers" });
  check("search field is in the panel", await field.isVisible());
  await field.click();
  // Keystroke cost: event timing for each typed character, and no long task while typing.
  await page.evaluate(() => {
    window.__ks = { max: 0, long: 0 };
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (e.name === "keydown" || e.name === "keyup" || e.name === "input") window.__ks.max = Math.max(window.__ks.max, e.duration);
    }).observe({ type: "event", durationThreshold: 16 });
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__ks.long = Math.max(window.__ks.long, e.duration);
    }).observe({ type: "longtask" });
  });
  await page.keyboard.type("card 1", { delay: 180 });
  await page.waitForTimeout(400);
  const hits = await page.locator("[role=option][data-layer-hit]").count();
  const first = await page.locator("[role=option][data-layer-hit]").first().getAttribute("aria-label");
  check('search "card 1" lists Card 10 to Card 19 on every screen (60) with paths', hits === 60 && /^Card 1\d, in Screen \d \/ \w+ \/ List$/.test(first ?? ""), `${hits} rows, first: ${first}`);
  const ks = await page.evaluate(() => window.__ks);
  check("each keystroke stays under 50 ms (no long task, event duration)", ks.max < 50 && ks.long < 50, JSON.stringify(ks));
  check("matches are highlighted", (await page.locator("[aria-label='Layer search results'] mark").first().innerText()).toLowerCase() === "card 1");
  await shot("r16a-search-dark.png");
  await field.press("Enter");
  await page.waitForTimeout(200);
  check("Enter selects all 60 matches", (await page.evaluate(() => window.__dt.state().selection.length)) === 60);
  // Click a result: selects, Shift-click ranges within the results.
  const results = page.locator("[role=option][data-layer-hit]");
  await results.nth(3).click({ position: pos });
  check("clicking a result selects that layer", (await page.evaluate(() => window.__dt.state().selection.length)) === 1);
  await results.nth(6).click({ position: pos, modifiers: ["Shift"] });
  check("Shift-click in the results selects the range", (await page.evaluate(() => window.__dt.state().selection.length)) === 4);
  await field.click();
  await field.press("Escape");
  await page.waitForTimeout(250);
  check("Escape clears the query and restores the tree", (await field.inputValue()) === "" && (await page.locator("[role=tree]").count()) === 1 && (await page.getByRole("listbox", { name: "Layer search results" }).count()) === 0);
  // Filter: Text alone.
  await page.getByRole("button", { name: "Filter layers" }).click();
  await page.getByRole("checkbox", { name: "Text" }).check();
  await page.waitForTimeout(250);
  const allText = await page.evaluate(() => {
    const d = window.__dt.doc();
    const page = window.__dt.state().page;
    let n = 0;
    const walk = (id) => {
      if (d.nodes[id].type === "text") n++;
      d.nodes[id].children.forEach(walk);
    };
    d.pages.find((p) => p.id === page).children.forEach(walk);
    return n;
  });
  const types = await page.evaluate(() => [...document.querySelectorAll("[data-layer-hit]")].map((e) => window.__dt.doc().nodes[e.dataset.layerHit].type));
  check("the Text filter alone lists text layers only", types.length === 500 && types.every((t) => t === "text"), `${types.length} rows`);
  const more = await page.getByRole("listbox", { name: "Layer search results" }).innerText();
  check("the list is capped at 500 and says how many more", more.includes(`${allText - 500} more, refine the search`), `${allText} text layers`);
  await page.getByRole("button", { name: "Clear filters" }).click();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  check("clearing the filter shows the tree again", (await page.locator("[role=tree]").count()) === 1);
  // Text content and inside instances.
  await field.fill("Continue");
  await page.waitForTimeout(400);
  const cont = await page.locator("[role=option][data-layer-hit]").count();
  check("search finds text content, including inside instances (Label, Continue)", cont > 100, `${cont} rows`);
  await field.fill("");
  await page.waitForTimeout(200);
}

// ---- Context menu ----
{
  const c5 = await card(5);
  await page.evaluate(() => window.__dt.dispatch({ op: "select", ids: [] }));
  // Open the list again.
  await focusCanvas(page);
  await page.keyboard.press("Alt+L");
  await twisty(page, screen1);
  await twisty(page, list1);
  await page.waitForTimeout(200);
  await row(page, c5).click({ position: pos });
  await row(page, c5).click({ position: pos, button: "right" });
  const items = await page.locator("[role=menu] [role=menuitem]").allInnerTexts();
  const has = (t) => items.some((x) => x.startsWith(t));
  check("row menu has Rename, Zoom to layer, Collapse all layers", has("Rename") && has("Zoom to layer") && has("Collapse all layers"), items.slice(0, 4).join("|"));
  check("row menu has the canvas commands", ["Copy", "Paste", "Duplicate", "Delete", "Group selection", "Create component", "Show/Hide", "Lock/Unlock", "Bring to front", "Add auto layout"].every(has), items.join("|"));
  check('the panel menu says "Paste", not "Paste here"', has("Paste") && !items.some((x) => x.startsWith("Paste here")));
  await shot("r16a-menu-dark.png");
  const n0 = (await kids(page, list1)).length;
  await page.locator("[role=menu] [role=menuitem]", { hasText: /^Duplicate/ }).click();
  await page.waitForTimeout(300);
  const n1 = (await kids(page, list1)).length;
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(200);
  const n2 = (await kids(page, list1)).length;
  check("Duplicate from the menu adds a layer and one Ctrl+Z removes it", n1 === n0 + 1 && n2 === n0, `${n0} ${n1} ${n2}`);
  await row(page, c5).click({ position: pos, button: "right" });
  await page.locator("[role=menu] [role=menuitem]", { hasText: /^Collapse all layers/ }).click();
  await page.waitForTimeout(200);
  check("Collapse all layers from the menu", (await page.locator("[role=treeitem][aria-expanded=true]").count()) === 0);
  await twisty(page, screen1);
  await twisty(page, list1);
  await page.waitForTimeout(200);
}

// ---- Tab renames the next layer ----
{
  const c5 = await card(5);
  const c4 = await card(4);
  await row(page, c5).click({ position: pos });
  await page.keyboard.press("F2");
  const input = page.getByRole("textbox", { name: "Layer name" });
  await input.waitFor({ timeout: 2000 });
  await page.keyboard.type("A");
  await page.keyboard.press("Tab");
  await page.waitForTimeout(300);
  const n = async (id) => page.evaluate((i) => window.__dt.doc().nodes[i].name, id);
  check("Tab commits the name", (await n(c5)) === "A");
  check("Tab starts renaming the next row (Card 04)", (await input.count()) === 1 && (await input.inputValue()) === "Card 04" && (await input.evaluate((e) => e === document.activeElement)));
  await page.keyboard.type("B");
  await page.keyboard.press("Shift+Tab");
  await page.waitForTimeout(300);
  check("Shift+Tab commits and goes back to the previous row", (await n(c4)) === "B" && (await input.inputValue()) === "A");
  await page.keyboard.type("Z");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  check("Escape reverts only the current row", (await n(c5)) === "A" && (await n(c4)) === "B" && (await input.count()) === 0);
  // At the top of the panel it stops.
  await page.evaluate(() => {
    document.querySelector("#left-tabpanel > .scroll").scrollTop = 0;
  });
  await page.locator("[role=treeitem]").first().click({ position: pos });
  await page.keyboard.press("F2");
  await input.waitFor({ timeout: 2000 });
  await page.keyboard.press("Shift+Tab");
  await page.waitForTimeout(300);
  check("Shift+Tab on the first row commits and stops, focus on the row", (await input.count()) === 0 && (await page.evaluate(() => document.activeElement?.getAttribute("role"))) === "treeitem");
}

// ---- Performance guard: a row click on the big file ----
{
  await page.evaluate(() => {
    window.__click = 0;
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (e.name === "click") window.__click = Math.max(window.__click, e.duration);
    }).observe({ type: "event", durationThreshold: 16 });
  });
  let worst = 0;
  for (const k of [3, 6, 9, 12]) {
    await page.evaluate(() => (window.__click = 0));
    await row(page, await card(k)).click({ position: pos });
    await page.waitForTimeout(250);
    worst = Math.max(worst, await page.evaluate(() => window.__click));
  }
  check("a row click on the 2,333-layer file takes at most 120 ms", worst <= 120, `${worst} ms`);
  await row(page, await card(8)).click({ position: pos });
  await page.waitForTimeout(300);
  await shot("r16a-tree-dark.png");
}

check("no page errors (dark run)", ctx.errors.length === 0, ctx.errors.join(" | "));
await ctx.context.close();

// ---- Fix round: scroll, anchor, debounce, rename in results, read-only, Escape, roving tab stop ----
{
  const fx = await open("dark", 1);
  const fp = fx.page;
  await fp.evaluate(async () => {
    const cards = [];
    for (let i = 0; i < 40; i++) cards.push({ type: "frame", name: `Card ${String(i).padStart(2, "0")}`, width: 100, height: 20, children: [{ type: "rectangle", name: "Inner", width: 5, height: 5 }] });
    await window.__dt.tool("create_nodes", { nodes: [{ type: "frame", name: "Screen", x: 0, y: 0, width: 400, height: 900, layout: { direction: "vertical" }, children: [{ type: "frame", name: "List", width: 300, height: "hug", layout: { direction: "vertical" }, children: cards }] }] });
  });
  const byName = (nm) => fp.evaluate((nm) => Object.values(window.__dt.doc().nodes).find((n) => n.name === nm)?.id, nm);
  const frow = (id) => fp.locator(`[role=treeitem][data-layer="${id}"]`);
  const sn = () => selNames(fp);
  const scrollTop = () => fp.evaluate((s) => document.querySelector(s).scrollTop, SCROLL);
  const inView = (id) =>
    fp.evaluate(
      ([s, id]) => {
        const a = document.querySelector(s).getBoundingClientRect();
        const r = document.querySelector(`[data-layer="${id}"]`);
        if (!r) return false;
        const b = r.getBoundingClientRect();
        return b.top >= a.top - 1 && b.bottom <= a.bottom + 1;
      },
      [SCROLL, id],
    );
  const fscreen = await byName("Screen");
  const flist = await byName("List");
  await frow(fscreen).locator(".twisty").click();
  await frow(flist).locator(".twisty").click();
  await fp.waitForTimeout(200);
  const c39 = await byName("Card 39");
  const c00 = await byName("Card 00");
  const p = { x: 70, y: 10 };
  // 1: Shift-click far down keeps the clicked row in view.
  await frow(c39).click({ position: p });
  await fp.evaluate((s) => (document.querySelector(s).scrollTop = 100000), SCROLL);
  await fp.waitForTimeout(200);
  const before = await scrollTop();
  await frow(c00).click({ position: p, modifiers: ["Shift"] });
  await fp.waitForTimeout(300);
  check("fix 1: Shift-click far down selects the range and leaves the clicked row in view", (await sn()).length === 40 && (await inView(c00)) && Math.abs((await scrollTop()) - before) < 40, `${before} -> ${await scrollTop()}`);
  // 1b: Shift+ArrowDown past the viewport follows the focused row.
  await fp.evaluate((s) => (document.querySelector(s).scrollTop = 0), SCROLL);
  await frow(c39).click({ position: p });
  await frow(c39).focus();
  for (let i = 0; i < 30; i++) {
    await fp.keyboard.press("Shift+ArrowDown");
    await fp.waitForTimeout(30);
  }
  await fp.waitForTimeout(200);
  const foc = await fp.evaluate(() => document.activeElement?.dataset?.layer);
  check("fix 1: Shift+ArrowDown past the viewport keeps the focused row in view", (await sn()).length === 31 && (await inView(foc)));
  // 2: stale anchor after a canvas selection.
  await fp.evaluate((s) => (document.querySelector(s).scrollTop = 0), SCROLL);
  const c35 = await byName("Card 35");
  const c30 = await byName("Card 30");
  const c28 = await byName("Card 28");
  await frow(c35).click({ position: p });
  await fp.evaluate((id) => window.__dt.dispatch({ op: "select", ids: [id] }), c30);
  await fp.waitForTimeout(300);
  await frow(c28).click({ position: p, modifiers: ["Shift"] });
  await fp.waitForTimeout(200);
  const r2 = await sn();
  check("fix 2: Shift-click after a canvas selection ranges from that selection", r2.length === 3 && ["Card 30", "Card 29", "Card 28"].every((n) => r2.includes(n)), r2.join(","));
  // 3: Enter right after typing.
  const ff = fp.getByRole("textbox", { name: "Search layers" });
  await ff.click();
  await fp.keyboard.type("Card 07");
  await fp.keyboard.press("Enter");
  await fp.waitForTimeout(60);
  const r3 = await sn();
  check("fix 3: Enter inside the debounce selects the matches of the typed text", r3.length === 1 && r3[0] === "Card 07", r3.join(","));
  // 4: rename from the results menu, Tab through the hits, nothing left behind in the tree.
  await fp.waitForTimeout(300);
  await ff.fill("Card 0");
  await fp.waitForTimeout(300);
  const hit = (i) => fp.locator("[role=option][data-layer-hit]").nth(i);
  await hit(0).click({ position: { x: 60, y: 10 }, button: "right" });
  await fp.locator("[role=menu] [role=menuitem]", { hasText: /^Rename/ }).click();
  const inp = fp.getByRole("textbox", { name: "Layer name" });
  await inp.waitFor({ timeout: 2000 });
  await fp.keyboard.type("Nine");
  await fp.keyboard.press("Tab");
  await fp.waitForTimeout(300);
  check("fix 4: Rename from the results menu edits in the results; Tab renames the next hit", (await byName("Nine")) !== undefined && (await inp.count()) === 1 && (await inp.inputValue()) === "Card 08" && (await inp.evaluate((e) => e === document.activeElement)));
  await fp.keyboard.press("Escape");
  await fp.waitForTimeout(200);
  await ff.click();
  await ff.fill("");
  await fp.waitForTimeout(500);
  check("fix 4: no stray rename field in the tree after the search ends", (await inp.count()) === 0);
  // F2 on a layer that is not in the results does nothing, now or later.
  await ff.fill("Card 1");
  await fp.waitForTimeout(300);
  await fp.evaluate((id) => window.__dt.dispatch({ op: "select", ids: [id] }), c30);
  await focusCanvas(fp);
  await fp.keyboard.press("F2");
  await fp.waitForTimeout(300);
  await ff.fill("");
  await fp.waitForTimeout(500);
  check("fix 4: F2 while searching, on a layer outside the results, opens nothing later", (await inp.count()) === 0);
  // 5: read-only.
  await fp.evaluate(() => window.__dt.collabSet({ viewer: true }));
  await frow(c35).click({ position: p, button: "right" });
  const vitems = await fp.locator("[role=menu] [role=menuitem]").allInnerTexts();
  await fp.keyboard.press("Escape");
  await frow(c35).dblclick({ position: p });
  await fp.waitForTimeout(200);
  check("fix 5: a read-only tab has no Rename, no double-click rename, no tree drag", !vitems.some((x) => x.startsWith("Rename")) && (await inp.count()) === 0 && (await frow(c35).getAttribute("draggable")) !== "true", vitems.slice(0, 3).join("|"));
  await fp.evaluate(() => window.__dt.collabSet({ viewer: false }));
  // Nice 1+2: Escape on the filter button, popover aria.
  const fb = fp.getByRole("button", { name: "Filter layers" });
  await fp.evaluate((id) => window.__dt.dispatch({ op: "select", ids: [id] }), c30);
  await fb.click();
  check("nice 2: the filter button names the popover it controls", (await fb.getAttribute("aria-controls")) === "layer-filter-menu" && (await fb.getAttribute("aria-haspopup")) === "dialog");
  await fb.focus();
  await fp.keyboard.press("Escape");
  await fp.waitForTimeout(150);
  check("nice 1: Escape on the filter button closes the popover and keeps the selection", (await fp.locator("#layer-filter-menu").count()) === 0 && (await sn()).length === 1);
  await fb.click();
  await fp.getByRole("checkbox", { name: "Frames" }).focus();
  for (let i = 0; i < 12; i++) await fp.keyboard.press("Tab");
  await fp.waitForTimeout(150);
  check("nice 2: Tab out of the popover closes it", (await fp.locator("#layer-filter-menu").count()) === 0);
  // Nice 3+5: roving stop, flat Shift range in the results.
  await ff.fill("Card");
  await fp.waitForTimeout(300);
  await hit(4).focus();
  const stops = await fp.evaluate(() => [...document.querySelectorAll("[data-layer-hit]")].filter((e) => e.tabIndex === 0).map((e) => e.dataset.layerHit));
  check("nice 3: one results tab stop, on the focused hit", stops.length === 1 && stops[0] === (await hit(4).getAttribute("data-layer-hit")));
  await fp.keyboard.press("Enter");
  await hit(8).click({ position: { x: 60, y: 10 }, modifiers: ["Shift"] });
  check("nice 3+5: Enter sets the anchor; Shift range in results keeps every hit", (await sn()).length === 5, (await sn()).join(","));
  // Nice 4: page switch shows no stale results.
  await ff.fill("Card 3");
  await fp.waitForTimeout(300);
  await fp.evaluate(() => window.__dt.dispatch({ op: "addPage", name: null }));
  await fp.waitForTimeout(40);
  check("nice 4: another page doesn't show the previous page's results", (await fp.locator("[role=option][data-layer-hit]").count()) === 0 && (await fp.locator("#layer-search").inputValue()) === "");
  check("no page errors (fix block)", fx.errors.length === 0, fx.errors.join(" | "));
  await fx.context.close();
}

// ---- Screenshots in the light theme ----
if (SHOTS) {
  ctx = await open("light", 2);
  page = ctx.page;
  await build(page);
  await page.waitForTimeout(500);
  const s1 = await idPath(page, [R]);
  const l1 = await idPath(page, [R, "List"]);
  await twisty(page, s1);
  await twisty(page, l1);
  await page.waitForTimeout(200);
  await row(page, await idPath(page, [R, "List", "Card 08"])).click({ position: pos });
  await row(page, await idPath(page, [R, "List", "Card 12"])).click({ position: pos, modifiers: ["Shift"] });
  await page.waitForTimeout(200);
  await shot("r16a-tree-light.png");
  await row(page, await idPath(page, [R, "List", "Card 10"])).click({ position: pos, button: "right" });
  await page.waitForTimeout(200);
  await shot("r16a-menu-light.png");
  await page.keyboard.press("Escape");
  await page.getByRole("textbox", { name: "Search layers" }).fill("card 1");
  await page.waitForTimeout(400);
  await shot("r16a-search-light.png");
  check("no page errors (light run)", ctx.errors.length === 0, ctx.errors.join(" | "));
  await ctx.context.close();
}

await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
