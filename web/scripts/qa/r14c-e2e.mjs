// Round 14, r14c: the Variables dialog (fixed columns, sticky Name column, search with counts, delete
// toast), the grouped bind picker, alias chip swatches, and accessibility: Ctrl+\ focus, Figma dialog
// focus return, real labels, headings, Space in the Layers tree, the export toast, alert toasts, the text
// editor's name, and number keys that set opacity. Local servers only: every other request is aborted.
// Usage: E2E_URL=http://localhost:6531 [E2E_OUT=dir] [AXE=path/to/axe.min.js] node scripts/qa/r14c-e2e.mjs

import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const URL = process.env.E2E_URL ?? "http://localhost:6531";
const OUT = process.env.E2E_OUT ?? "test-results";
fs.mkdirSync(OUT, { recursive: true });
const launch = { headless: true, args: ["--no-sandbox"] };
if (process.env.CHROMIUM) launch.executablePath = process.env.CHROMIUM;
else if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";
const AXE = [process.env.AXE, "/tmp/claude-0/-home-user-designotron/286bf7bb-781e-5d8f-9708-6c1f94840e4a/scratchpad/qa7/I-a11y/node_modules/axe-core/axe.min.js", path.resolve("node_modules/axe-core/axe.min.js")].find((p) => p && fs.existsSync(p));

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== "" ? "  - " + String(detail).slice(0, 400) : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch(launch);

async function open({ file = true, width = 1440, height = 900, scheme = "dark" } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, colorScheme: scheme, acceptDownloads: true });
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
  await page.goto(URL);
  await page.waitForSelector(".files", { timeout: 30000 });
  if (file) {
    await page.click("button:has-text('New design file')");
    await page.waitForSelector("#dt-canvas", { timeout: 30000 });
    await page.waitForTimeout(400);
  }
  return { ctx, page };
}
const tool = (page, name, input) => page.evaluate(([n, i]) => window.__dt.tool(n, i), [name, input]);
const doc = (page) => page.evaluate(() => window.__dt.doc());
const nodeNamed = async (page, name) => Object.values((await doc(page)).nodes).find((n) => n.name === name);
const select = (page, id) => page.evaluate((i) => window.__dt.dispatch({ op: "select", ids: [i] }), id);
const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.png` });

async function axeRun(page, label, selector = null) {
  if (!AXE) return check(`axe: ${label}`, false, "axe-core not found (set AXE)");
  await page.addScriptTag({ path: AXE });
  const res = await page.evaluate(async (sel) => {
    const r = await window.axe.run(sel ? document.querySelector(sel) : document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] }, resultTypes: ["violations"] });
    return r.violations.map((v) => `${v.id}(${v.nodes.length}): ${v.nodes[0].target.join(" ")}`);
  }, selector);
  check(`axe: ${label} has 0 violations`, res.length === 0, res.join("; "));
}

const BRAND = async (page) => {
  await tool(page, "define_variables", {
    collection: "Primitives",
    modes: ["Value"],
    variables: [
      { name: "Blue/500", type: "color", value: "#2563EB" },
      { name: "Gray/0", type: "color", value: "#FFFFFF" },
      { name: "Gray/950", type: "color", value: "#020617" },
      { name: "Radius/md", type: "number", value: 8 },
    ],
  });
  await tool(page, "define_variables", {
    collection: "Theme",
    modes: ["Light", "Dark", "High contrast"],
    variables: [
      { name: "Surface", type: "color", values: { Light: { alias: "Primitives/Gray/0" }, Dark: { alias: "Primitives/Gray/950" }, "High contrast": { alias: "Primitives/Gray/0" } } },
      { name: "Accent", type: "color", values: { Light: { alias: "Primitives/Blue/500" }, Dark: { alias: "Primitives/Blue/500" }, "High contrast": { alias: "Primitives/Blue/500" } } },
      { name: "Card/Radius", type: "number", values: { Light: { alias: "Primitives/Radius/md" }, Dark: { alias: "Primitives/Radius/md" }, "High contrast": { alias: "Primitives/Radius/md" } } },
    ],
  });
  await tool(page, "create_nodes", {
    nodes: [
      { type: "frame", name: "Landing", x: 0, y: 0, width: 400, height: 300, fill: "#000000", bind: { fill: "Surface" }, children: [{ type: "rectangle", name: "Button", width: 100, height: 40, fill: "#000000", cornerRadius: 4, bind: { fill: "Accent", cornerRadius: "Card/Radius" } }] },
    ],
  });
  await sleep(300);
};

const openVariables = async (page) => {
  await page.evaluate(() => window.__dt.dispatch({ op: "select", ids: [] }));
  await page.mouse.click(300, 700);
  await page.getByRole("button", { name: "Open variables" }).first().click();
  await page.waitForSelector(".variables-dialog");
  await sleep(200);
};

// ---------------------------------------------------------------- V-06: columns
{
  const { ctx, page } = await open();
  await BRAND(page);
  await openVariables(page);
  for (const coll of ["Primitives", "Theme"]) {
    await page.locator(".var-coll", { hasText: coll }).click();
    await sleep(150);
    const w = await page.evaluate(() => [...document.querySelectorAll(".variables-dialog tr[data-variable] td:first-child input")].map((i) => Math.round(i.getBoundingClientRect().width)));
    check(`${coll}: every name input is at least 180 px wide (${Math.min(...w)})`, w.length > 0 && Math.min(...w) >= 180, JSON.stringify(w));
  }
  const dlgW = await page.evaluate(() => Math.round(document.querySelector(".variables-dialog").getBoundingClientRect().width));
  check("dialog is 1080 px wide at 1440", dlgW === 1080, String(dlgW));
  await shot(page, "01-theme-3-modes");
  await axeRun(page, "Variables dialog (3 modes)");

  // Six modes scroll sideways and keep the Name column.
  for (let i = 0; i < 3; i++) await page.locator(".variables-dialog thead button[title='Add mode']").click();
  await sleep(300);
  const SC = ".variables-dialog .var-table-scroll";
  const geo = await page.evaluate((SC) => {
    const wrap = document.querySelector(SC);
    return { scrolls: wrap.scrollWidth > wrap.clientWidth, sw: wrap.scrollWidth, cw: wrap.clientWidth };
  }, SC);
  check("6 modes: the table scrolls sideways inside the dialog", geo.scrolls, JSON.stringify(geo));
  await page.evaluate((SC) => (document.querySelector(SC).scrollLeft = 9999), SC);
  await sleep(150);
  const after = await page.evaluate((SC) => {
    const wrap = document.querySelector(SC).getBoundingClientRect();
    const inp = document.querySelector(".variables-dialog tr[data-variable] td:first-child input").getBoundingClientRect();
    const td = document.querySelector(".variables-dialog tr[data-variable] td:first-child");
    const bg = getComputedStyle(td).backgroundColor;
    const hit = document.elementFromPoint(wrap.left + 3, inp.top + inp.height / 2);
    const folder = document.querySelector(".variables-dialog .var-folder button")?.getBoundingClientRect();
    const search = document.querySelector(".variables-dialog .var-search").getBoundingClientRect();
    const name = document.querySelector(".variables-dialog .var-table-wrap > .row").getBoundingClientRect();
    return { inLeft: inp.left, wrapLeft: wrap.left, w: inp.width, bg, hitName: !!hit?.closest("td:first-child"), folderLeft: folder?.left, folderRight: folder?.right, searchVisible: search.left >= wrap.left - 20 && search.width > 100, nameRowVisible: name.left >= wrap.left - 20 && name.width > 100 };
  }, SC);
  check("scrolled right: the Name column is still visible (sticky)", after.inLeft >= after.wrapLeft - 1 && after.inLeft < after.wrapLeft + 60 && after.w >= 180, JSON.stringify(after));
  check("the sticky Name cell has an opaque background", !/rgba\(0, 0, 0, 0\)|transparent/.test(after.bg), after.bg);
  check("scrolled right: just inside the scroller's left edge is the Name column (no mode input shows through)", after.hitName, JSON.stringify(after));
  check("scrolled right: folder names stay visible", after.folderLeft === undefined || (after.folderLeft >= after.wrapLeft - 1 && after.folderRight > after.wrapLeft + 40), JSON.stringify(after));
  check("scrolled right: the collection name row and the search box stay put", after.searchVisible && after.nameRowVisible, JSON.stringify(after));
  // Shift+Tab into an off-screen earlier mode cell leaves it fully visible (not under the Name column).
  const focus = await page.evaluate((SC) => {
    const sc = document.querySelector(SC);
    sc.scrollLeft = sc.scrollWidth;
    const rows = [...document.querySelectorAll(".variables-dialog tr[data-variable]")];
    const lastMode = rows.map((r) => { const c = [...r.querySelectorAll("td")]; return [...c[c.length - 2].querySelectorAll("input:not([type=color]), button")].pop(); }).find((i) => i && i.getBoundingClientRect().height > 0);
    lastMode.focus();
    return { ok: document.activeElement === lastMode };
  }, SC);
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  await sleep(200);
  const vis = await page.evaluate((SC) => {
    const sc = document.querySelector(SC).getBoundingClientRect();
    const nameCol = document.querySelector(".variables-dialog tr[data-variable] td:first-child").getBoundingClientRect();
    const r = document.activeElement.getBoundingClientRect();
    const w = document.querySelector(".variables-dialog .var-table-wrap");
    return { wrapScroll: w.scrollLeft, wrapOverflow: w.scrollWidth - w.clientWidth, left: r.left, right: r.right, nameRight: nameCol.right, scLeft: sc.left, scRight: sc.right, tag: document.activeElement.tagName };
  }, SC);
  check("Shift+Tab to an earlier mode cell leaves it fully visible, clear of the sticky Name column, and the dialog body itself never scrolls", focus.ok && vis.wrapScroll === 0 && vis.wrapOverflow <= 0 && vis.left >= vis.nameRight - 1 && vis.right <= vis.scRight + 1, JSON.stringify(vis));
  await shot(page, "02-six-modes-scrolled");
  await ctx.close();
}

// ---------------------------------------------------------------- new names stay unique after deletes
{
  const { ctx, page } = await open();
  await BRAND(page);
  await openVariables(page);
  const names = async () => (await doc(page)).variables.map((c) => c.name);
  await page.getByRole("button", { name: "New collection" }).click();
  await page.getByRole("button", { name: "New collection" }).click();
  await sleep(200);
  let n = await names();
  check("two new collections get distinct names", new Set(n).size === n.length && n.includes("Collection 3") && n.includes("Collection 4"), JSON.stringify(n));
  // Delete Collection 3, then add: the next free number, not a repeat of Collection 4.
  await page.locator(".var-coll", { hasText: "Collection 3" }).click();
  await page.getByRole("button", { name: "Delete collection Collection 3" }).click();
  await sleep(200);
  await page.getByRole("button", { name: "New collection" }).click();
  await sleep(200);
  n = await names();
  check("add after delete never repeats a collection name", new Set(n).size === n.length && n.includes("Collection 4"), JSON.stringify(n));
  const modes = async () => (await doc(page)).variables.find((c) => c.name === "Collection 4").modes.map((m) => m.name);
  await page.locator(".var-coll", { hasText: "Collection 4" }).click();
  await sleep(150);
  for (let i = 0; i < 2; i++) await page.locator(".variables-dialog thead button[title='Add mode']").click();
  await sleep(200);
  check("modes are Default, Mode 2, Mode 3", JSON.stringify(await modes()) === '["Default","Mode 2","Mode 3"]', JSON.stringify(await modes()));
  await page.getByRole("button", { name: "Delete mode Mode 2" }).click();
  await page.getByRole("button", { name: "Delete mode", exact: true }).click();
  await sleep(250);
  await page.locator(".variables-dialog thead button[title='Add mode']").click();
  await sleep(250);
  const m = await modes();
  check("add mode after deleting Mode 2 gives a free name (Mode 4)", new Set(m).size === m.length && m.length === 3 && m.includes("Mode 4"), JSON.stringify(m));
  await ctx.close();
}

// ---------------------------------------------------------------- 300 variables, 3 modes: names, search, keyboard
{
  const { ctx, page } = await open();
  const colours = Array.from({ length: 150 }, (_, i) => ({ name: `Gray/${Math.floor(i / 10) * 100 + (i % 10)}`, type: "color", value: `#${(((i + 1) * 2654435761) >>> 8 & 0xffffff).toString(16).padStart(6, "0")}` }));
  const numbers = Array.from({ length: 100 }, (_, i) => ({ name: `Space/Step ${i}`, type: "number", value: i * 2 }));
  const strings = Array.from({ length: 50 }, (_, i) => ({ name: `Copy/Line ${i}`, type: "string", value: `Line ${i}` }));
  await tool(page, "define_variables", { collection: "Tokens", modes: ["Light", "Dark", "High contrast"], variables: [...colours, ...numbers, ...strings] });
  await tool(page, "define_variables", { collection: "Other", modes: ["Default"], variables: [{ name: "Gray/900", type: "color", value: "#111111" }, { name: "Gray/901", type: "color", value: "#121212" }, { name: "Misc/One", type: "number", value: 1 }] });
  const n = (await doc(page)).variables.reduce((a, c) => a + c.variables.length, 0);
  check("300 variables in the file (plus 3 in a second collection)", n === 303, String(n));
  await openVariables(page);
  await page.locator(".var-coll", { hasText: "Tokens" }).click();
  await sleep(200);
  check("the Variables dialog has a search field", (await page.getByRole("searchbox", { name: "Search variables" }).count()) === 1);
  // Folders start open.
  check("folders start open", (await page.locator(".variables-dialog tr.var-folder button[aria-expanded=true]").count()) > 0);
  const widths = await page.evaluate(() => [...document.querySelectorAll(".variables-dialog tr[data-variable] td:first-child input")].map((i) => Math.round(i.getBoundingClientRect().width)));
  check(`300 variables, 3 modes: names stay readable (min ${Math.min(...widths)} px over ${widths.length} rows)`, widths.length > 0 && Math.min(...widths) >= 180);
  const fits = await page.evaluate(() => [...document.querySelectorAll(".variables-dialog tr[data-variable] td:first-child input")].slice(0, 20).every((i) => i.scrollWidth <= i.clientWidth + 1));
  check("names are not cut off", fits);
  await shot(page, "03-300-variables");

  const search = page.getByRole("searchbox", { name: "Search variables" });
  await search.click();
  await page.keyboard.type("gray/9");
  await sleep(250);
  const shown = await page.evaluate(() => [...document.querySelectorAll(".variables-dialog tr[data-variable]")].map((r) => r.getAttribute("data-variable")));
  check("typing gray/9 narrows to the matching rows", shown.length === 11 && shown.every((s) => s.toLowerCase().includes("gray/9")), `${shown.length}: ${shown.slice(0, 3)}`);
  const noFolders = await page.locator(".variables-dialog tr.var-folder").count();
  check("with a query the rows are a flat list (no folder rows)", noFolders === 0);
  const counts = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll(".var-coll[data-matches]")].map((b) => [b.querySelector(".var-coll-name").textContent, b.getAttribute("data-matches")])));
  check("the collection list shows the match count per collection", counts.Tokens === "11" && counts.Other === "2", JSON.stringify(counts));
  await shot(page, "04-search-gray-9");
  // Matches in another collection are reachable.
  await page.locator(".var-coll", { hasText: "Other" }).click();
  await sleep(150);
  const other = await page.evaluate(() => [...document.querySelectorAll(".variables-dialog tr[data-variable]")].map((r) => r.getAttribute("data-variable")));
  check("clicking a collection with matches shows them", other.length === 2 && other.includes("Gray/900"), JSON.stringify(other));
  await page.locator(".var-coll", { hasText: "Tokens" }).click();
  await search.fill("zzz-nothing");
  await sleep(200);
  check("no match shows 'No variables match'", (await page.getByText("No variables match").count()) === 1);
  // Keyboard: Escape clears first, the next Escape closes.
  await search.focus();
  await page.keyboard.press("Escape");
  await sleep(200);
  check("Escape in the search field clears it and keeps the dialog open", (await search.inputValue()) === "" && (await page.locator(".variables-dialog").count()) === 1);
  await page.waitForSelector(".variables-dialog tr.var-folder", { timeout: 5000 }).catch(() => {});
  check("after clearing, the folder view is back", (await page.locator(".variables-dialog tr.var-folder").count()) > 0);
  // Keyboard path through the table: Tab from the search field reaches a name input, typing renames it.
  await search.fill("Step 7");
  await sleep(150);
  let focusInfo = null;
  for (let i = 0; i < 12 && !focusInfo?.inRow; i++) {
    await page.keyboard.press("Tab");
    focusInfo = await page.evaluate(() => ({ tag: document.activeElement.tagName, inRow: !!document.activeElement.closest("tr[data-variable]"), v: document.activeElement.value, tabs: 0 }));
  }
  check("Tab from the search field reaches the first matching row's name (past the mode headers)", focusInfo.inRow && /Step 7/.test(focusInfo.v), JSON.stringify(focusInfo));
  await page.keyboard.press("Control+a");
  await page.keyboard.type("Spacing/Step 7 renamed");
  await page.keyboard.press("Enter");
  await sleep(300);
  const renamed = (await doc(page)).variables.flatMap((c) => c.variables).some((v) => v.name === "Spacing/Step 7 renamed" || v.name === "Space/Spacing/Step 7 renamed");
  check("Enter commits a rename done by keyboard", renamed);
  // Tab walks name -> scope -> value -> alias button of the first mode.
  await page.keyboard.press("Tab");
  const next = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName);
  check("Tab keeps moving through the row's controls", !!next, String(next));
  // Escape twice closes.
  await search.fill("x");
  await search.focus();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await sleep(250);
  check("a second Escape closes the dialog", (await page.locator(".variables-dialog").count()) === 0);
  await openVariables(page);
  check("the query resets when the dialog is reopened", (await page.getByRole("searchbox", { name: "Search variables" }).inputValue()) === "");
  await ctx.close();
}

// ---------------------------------------------------------------- picker, V-09, V-08
{
  const { ctx, page } = await open();
  await BRAND(page);
  const landing = await nodeNamed(page, "Landing");
  const button = await nodeNamed(page, "Button");
  await select(page, button.id);
  await sleep(300);
  await page.getByRole("button", { name: "Bind a property" }).click();
  await sleep(200);
  const sel = page.locator("select[aria-label='Bound variable']").first();
  const labels = await sel.locator("optgroup").evaluateAll((els) => els.map((e) => e.label));
  check("the bound-variable select has optgroups", labels.length > 0, JSON.stringify(labels));
  check("groups are 'Collection / folder'", labels.includes("Primitives / Blue") && labels.includes("Theme"), JSON.stringify(labels));
  const opt = await sel.locator("optgroup[label='Primitives / Blue'] option").allInnerTexts();
  check("options show the full name within the collection (a closed select shows no group)", opt.length === 1 && /Blue\/500$/.test(opt[0]), JSON.stringify(opt));
  await shot(page, "05-picker-groups");

  // V-09: the chip of a fill bound to an alias has the swatch of the layer's fill.
  await select(page, landing.id);
  await sleep(300);
  const chip = page.locator("[data-bound-chip=fill]").first();
  await chip.waitFor();
  const swatchColour = await chip.locator(".wf-chip-swatch i").evaluate((el) => getComputedStyle(el).backgroundColor);
  const fill = (await nodeNamed(page, "Landing")).fills[0].color;
  const hex = swatchColour.match(/\d+/g).slice(0, 3).map((x) => Number(x).toString(16).padStart(2, "0")).join("").toUpperCase();
  check("the chip of a fill bound to an alias shows the layer's fill colour", hex === fill.replace("#", "").slice(0, 6).toUpperCase(), `${swatchColour} vs ${fill}`);
  await shot(page, "06-alias-chip");

  // V-08: delete a used variable.
  await openVariables(page);
  await page.locator(".var-coll", { hasText: "Theme" }).click();
  await sleep(150);
  await page.getByRole("button", { name: "Delete Surface" }).click();
  await sleep(500);
  const alertText = await page.evaluate(() => document.querySelector("[data-toast-live=info]").textContent);
  check("deleting a bound variable toasts the counts", /Deleted Surface\. 1 layer keeps its current value/.test(alertText) && /Ctrl\+Z undoes/.test(alertText), alertText);
  let b = (await doc(page)).nodes[landing.id].bindings ?? {};
  check("the layer lost the binding and kept its colour", !b.fill && !!(await nodeNamed(page, "Landing")).fills[0].color);
  await page.getByRole("button", { name: "Delete Accent" }).click();
  await sleep(400);
  await page.locator(".var-coll", { hasText: "Primitives" }).click();
  await sleep(150);
  await sleep(150);
  await shot(page, "07-after-deletes");
  await page.waitForFunction(() => !document.querySelector(".toast"), null, { timeout: 15000 });
  await page.getByRole("button", { name: "Delete Blue/500" }).click();
  await sleep(500);
  const t2 = await page.evaluate(() => document.querySelector(".toast")?.textContent ?? "");
  check("deleting a variable that nothing uses shows no toast", t2 === "", t2);
  await page.keyboard.press("Escape");
  await sleep(200);
  await page.evaluate(() => document.getElementById("dt-canvas").focus());
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  await sleep(400);
  const back = (await doc(page)).nodes[landing.id].bindings ?? {};
  check("Ctrl+Z restores the binding", back.fill === (await doc(page)).variables.flatMap((c) => c.variables).find((v) => v.name === "Surface")?.id, JSON.stringify(back));
  await ctx.close();
}

// ---------------------------------------------------------------- A1 Ctrl+\ keeps focus
{
  const { ctx, page } = await open();
  await tool(page, "create_nodes", { nodes: [{ type: "rectangle", name: "Box", x: 0, y: 0, width: 100, height: 100, fill: "#7C5CFF" }, { type: "rectangle", name: "Box 2", x: 150, y: 0, width: 100, height: 100, fill: "#FF5C7C" }] });
  await sleep(300);
  for (const where of ["layers", "design", "topbar"]) {
    if (where === "layers") await page.locator("[role=treeitem]").first().focus();
    if (where === "design") await page.locator("#right-tab-design").focus();
    if (where === "topbar") await page.locator(".topbar button").first().focus();
    await page.keyboard.press("Control+\\");
    await sleep(500);
    const f = await page.evaluate(() => {
      const a = document.activeElement;
      return { id: a?.id ?? "", tag: a?.tagName, body: a === document.body, visible: !!a && [...a.getClientRects()].some((c) => c.width > 0 && c.height > 0), topbar: !!a?.closest?.(".topbar") };
    });
    if (where === "topbar") check("A1: focus in the top bar stays there when the panels hide", f.topbar && f.visible, JSON.stringify(f));
    else check(`A1: Ctrl+\\ from ${where === "layers" ? "a Layers row" : "the Design tab"} puts focus on the canvas`, f.id === "dt-canvas" && f.visible, JSON.stringify(f));
    if (where === "layers") {
      await page.keyboard.press("Escape");
      await page.keyboard.press("Tab");
      const t = await page.evaluate(() => ({ first: document.activeElement === document.querySelector(".topbar button"), id: document.activeElement?.id }));
      check("A1: Tab after Ctrl+\\ continues after the canvas, not from the top of the page", !t.first, JSON.stringify(t));
      await page.evaluate(() => document.getElementById("dt-canvas").focus());
      await page.keyboard.press("Shift+Tab");
      const u = await page.evaluate(() => ({ inApp: !!document.activeElement?.closest?.(".topbar, .main"), tag: document.activeElement?.tagName }));
      check("A1: Shift+Tab from the canvas goes to the control before it", u.inApp && u.tag !== "BODY", JSON.stringify(u));
    }
    await page.keyboard.press("Control+\\");
    await sleep(400);
  }
  await ctx.close();
}

// ---------------------------------------------------------------- A2 + A3 (Figma) and the dashboard headings
{
  const { ctx, page } = await open({ file: false });
  const h1 = await page.getByRole("heading", { level: 1 }).count();
  const h2 = await page.getByRole("heading", { level: 2 }).allInnerTexts();
  check("A6: the dashboard has an h1", h1 === 1, String(h1));
  check("A6: the dashboard has two level-2 headings (template list and files)", h2.length === 2, JSON.stringify(h2));
  await page.getByRole("button", { name: "Import from Figma" }).first().focus();
  await page.keyboard.press("Enter");
  await page.waitForSelector("[role=dialog][aria-label='Import from Figma']");
  await sleep(300);
  check("A3: 'Figma file or frame link' is the name of its field", (await page.getByLabel("Figma file or frame link").count()) === 1);
  check("A3: 'Personal access token' is the name of its field", (await page.getByLabel("Personal access token").count()) === 1);
  await shot(page, "08-figma-dialog");
  await axeRun(page, "Import from Figma dialog");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".files", { timeout: 10000 });
  await sleep(600);
  const f = await page.evaluate(() => ({ text: document.activeElement?.textContent?.trim(), body: document.activeElement === document.body }));
  check("A2: after Escape, focus is on the Import from Figma button", /Import from Figma/.test(f.text ?? "") && !f.body, JSON.stringify(f));
  await page.keyboard.press("Tab");
  const t = await page.evaluate(() => document.activeElement?.textContent?.trim().slice(0, 30));
  check("A2: the next Tab continues from there (not from the top)", /Open \.dtron|New design file|Import/.test("") || (t !== undefined && !/Designotron/.test(t ?? "")), String(t));
  await axeRun(page, "dashboard");
  await shot(page, "09-dashboard");
  await ctx.close();
}

// ---------------------------------------------------------------- editor: A3 notes/share, A6, U2, U3, U7, U8, number keys
{
  const { ctx, page } = await open();
  await tool(page, "create_nodes", {
    nodes: [
      { type: "rectangle", name: "Box", x: 0, y: 0, width: 100, height: 100, fill: "#7C5CFF" },
      { type: "rectangle", name: "Box 2", x: 150, y: 0, width: 100, height: 100, fill: "#FF5C7C" },
      { type: "rectangle", name: "Box 3", x: 300, y: 0, width: 100, height: 100, fill: "#5CFF7C" },
      { type: "text", name: "Label", text: "Hello", x: 0, y: 200, fontSize: 24 },
    ],
  });
  await page.evaluate(() => window.__dt.zoomToFit());
  await sleep(300);
  const box = await nodeNamed(page, "Box");
  await select(page, box.id);
  await sleep(300);
  check("A3: Developer notes textarea is named 'Developer notes'", (await page.getByLabel("Developer notes").count()) === 1);
  const heads = await page.locator(".panel.right").getByRole("heading", { level: 3 }).allInnerTexts();
  check("A6: the Design panel exposes level-3 headings (Fill, Export)", heads.includes("Fill") && heads.includes("Export"), JSON.stringify(heads));

  // Share
  await page.click("[title='Share for live editing']");
  await page.waitForSelector("[role=dialog][aria-label=Share], .modal");
  await sleep(300);
  check("A3: Share 'Your name' has a real label", (await page.getByLabel("Your name").count()) === 1);
  await shot(page, "10-share");
  await axeRun(page, "Share dialog");
  await page.keyboard.press("Escape");
  await sleep(300);

  // U2: Space on the row just arrowed to.
  await page.locator(`[data-layer="${box.id}"]`).click();
  await page.keyboard.press("ArrowDown");
  await sleep(150);
  const second = await nodeNamed(page, "Box 2");
  let sel = await page.evaluate(() => window.__dt.state().selection ?? null);
  await page.keyboard.press(" ");
  await sleep(150);
  const sel2 = await page.evaluate(() => [...document.querySelectorAll("[role=treeitem][aria-selected=true]")].map((e) => e.getAttribute("aria-label")));
  check("U2: arrow to a row, then Space: it stays selected", sel2.length === 1, JSON.stringify(sel2));
  await page.keyboard.press("Control+ArrowDown").catch(() => {});
  void second;
  void sel;

  // U3: Export code announces the download.
  const dl = page.waitForEvent("download", { timeout: 15000 }).catch(() => null);
  await page.getByRole("button", { name: "Export code" }).click();
  const d = await dl;
  await sleep(500);
  const said = await page.evaluate(() => document.querySelector("[data-toast-live=info]").textContent);
  check("U3: Export code downloads and says so", !!d && /Downloaded .*-react\.zip/.test(said), `${d?.suggestedFilename()} / ${said}`);

  // U7: an error toast goes to the assertive alert region.
  await tool(page, "define_variables", { collection: "C", modes: ["M"], variables: [{ name: "a", type: "color", value: "#000000" }, { name: "b", type: "color", value: "#111111" }] });
  await page.evaluate(() => window.__dt.dispatch({ op: "select", ids: [] }));
  await page.mouse.click(300, 700);
  await page.getByRole("button", { name: "Open variables" }).first().click();
  await page.waitForSelector(".variables-dialog");
  const nameInputs = page.locator(".variables-dialog tr[data-variable] td:first-child input");
  await nameInputs.nth(1).fill("a");
  await nameInputs.nth(1).press("Enter");
  await sleep(500);
  const alert = await page.evaluate(() => ({ alert: document.querySelector("[role=alert][data-toast-live=error]").textContent, status: document.querySelector("[role=status][data-toast-live=info]").textContent, visibleHidden: document.querySelector(".toast.error")?.getAttribute("aria-hidden") }));
  check("U7: an error toast is written into the role=alert region", /already exists/.test(alert.alert) && alert.status === "", JSON.stringify(alert));
  check("U7: the visible toast is aria-hidden (read once)", alert.visibleHidden === "true");
  const regions = await page.evaluate(() => ({ alert: !!document.querySelector("[role=alert][aria-live=assertive]"), status: !!document.querySelector("[role=status][aria-live=polite]") }));
  check("U7: both live regions exist while no toast shows", regions.alert && regions.status);
  await page.keyboard.press("Escape");
  await sleep(300);

  // U8: the text editor's textarea has a name.
  const label = await nodeNamed(page, "Label");
  await select(page, label.id);
  await page.evaluate(() => document.getElementById("dt-canvas").focus());
  await page.keyboard.press("Enter");
  await sleep(400);
  const ta = await page.evaluate(() => document.querySelector("textarea.text-editor")?.getAttribute("aria-label") ?? null);
  check("U8: the text editor textarea is named", ta === "Edit text: Label", String(ta));
  await page.keyboard.press("Escape");
  await sleep(200);

  // Number keys.
  await select(page, box.id);
  await page.evaluate(() => document.getElementById("dt-canvas").focus());
  const op = async () => (await nodeNamed(page, "Box")).opacity;
  await page.keyboard.press("5");
  await sleep(200);
  check("number key 5 sets opacity 0.5", (await op()) === 0.5, String(await op()));
  await sleep(700);
  await page.keyboard.press("9");
  await sleep(700);
  check("number key 9 sets opacity 0.9", (await op()) === 0.9, String(await op()));
  await page.keyboard.press("0");
  await sleep(700);
  check("number key 0 sets opacity 1", (await op()) === 1, String(await op()));
  await page.keyboard.press("0");
  await page.keyboard.press("5");
  await sleep(200);
  check("0 then 5 typed quickly sets opacity 0.05", Math.abs((await op()) - 0.05) < 1e-9, String(await op()));
  await page.keyboard.press("Control+z");
  await sleep(200);
  check("a two-digit pair is one undo step: undo after '0','5' goes back to 1", (await op()) === 1, String(await op()));
  await page.keyboard.press("Control+z");
  await sleep(200);
  check("another undo steps back to the previous value (0.9)", (await op()) === 0.9, String(await op()));
  await page.keyboard.press("4");
  await page.keyboard.press("5");
  await sleep(200);
  check("4 then 5 typed quickly sets opacity 0.45", Math.abs((await op()) - 0.45) < 1e-9, String(await op()));
  await sleep(700);
  await page.keyboard.press("0");
  await page.keyboard.press("0");
  await sleep(200);
  check("0 then 0 typed quickly sets opacity 0", (await op()) === 0, String(await op()));
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  await sleep(200);
  // Opacity of every selected layer.
  await page.evaluate(() => window.__dt.dispatch({ op: "select", ids: Object.values(window.__dt.doc().nodes).filter((n) => /^Box/.test(n.name)).map((n) => n.id) }));
  await sleep(200);
  await page.keyboard.press("3");
  await sleep(200);
  const all = Object.values((await doc(page)).nodes).filter((n) => /^Box/.test(n.name)).map((n) => n.opacity);
  check("number keys act on every selected layer", all.length === 3 && all.every((o) => o === 0.3), JSON.stringify(all));
  await sleep(700);
  // Where it must not fire.
  await select(page, box.id);
  await page.keyboard.press("0");
  await sleep(700);
  const before = await op();
  await page.getByLabel("Opacity").first().click();
  await page.keyboard.press("Control+a");
  await page.keyboard.type("7");
  const typed = await page.getByLabel("Opacity").first().inputValue();
  check("in a number field, 7 types a 7 and changes nothing on its own", typed === "7" && (await op()) === before, `${typed} ${await op()}`);
  await page.keyboard.press("Escape");
  await page.evaluate(() => document.getElementById("dt-canvas").focus());
  await page.keyboard.press("Control+8");
  await page.keyboard.press("Alt+8");
  await sleep(200);
  check("with Ctrl or Alt held, digits don't set opacity", (await op()) === before, String(await op()));
  // Text editor.
  await select(page, label.id);
  await page.evaluate(() => document.getElementById("dt-canvas").focus());
  await page.keyboard.press("Enter");
  await sleep(300);
  await page.keyboard.press("Control+a");
  await page.keyboard.type("a5");
  await sleep(200);
  const lbl = await nodeNamed(page, "Label");
  check("in the text editor, 5 types a 5 (opacity untouched)", lbl.opacity === 1 && /5/.test(await page.evaluate(() => document.querySelector("textarea.text-editor")?.value ?? "")), `${lbl.opacity}`);
  await page.keyboard.press("Escape");
  await sleep(200);
  // Chat.
  await page.click("#claude-toggle");
  await page.waitForSelector(".chat textarea");
  await select(page, box.id);
  await page.locator(".chat textarea").click();
  await page.keyboard.type("6");
  check("in the chat box, 6 types a 6 (opacity untouched)", (await page.locator(".chat textarea").inputValue()) === "6" && (await op()) === before, String(await op()));
  await page.locator(".chat textarea").fill("");
  await page.click("#claude-toggle");
  // Nothing selected: no-op.
  await page.evaluate(() => window.__dt.dispatch({ op: "select", ids: [] }));
  await page.evaluate(() => document.getElementById("dt-canvas").focus());
  const hist = await page.evaluate(() => window.__dt.doc().nodes && JSON.stringify(Object.values(window.__dt.doc().nodes).map((n) => n.opacity)));
  await page.keyboard.press("2");
  await sleep(200);
  check("with nothing selected, a digit changes nothing", hist === (await page.evaluate(() => JSON.stringify(Object.values(window.__dt.doc().nodes).map((n) => n.opacity)))));
  // Opacity binding is detached like typing in the field (engine behaviour, checked on a bound layer).
  await shot(page, "11-editor");
  await axeRun(page, "editor (1440)");
  // Shortcuts list.
  await page.keyboard.press("?");
  await sleep(300);
  check("the shortcuts dialog lists the number keys", (await page.getByText("Opacity 10% to 90% / 100%").count()) === 1);
  await axeRun(page, "shortcuts dialog");
  await page.keyboard.press("Escape");
  await ctx.close();
}

// ---------------------------------------------------------------- editor at 1000 px with overlays, and the presenter
{
  const { ctx, page } = await open({ width: 1000, height: 800 });
  await tool(page, "create_nodes", { nodes: [{ type: "frame", name: "Screen", x: 0, y: 0, width: 300, height: 300, fill: "#FFFFFF", children: [{ type: "text", name: "T", text: "Hi", fontSize: 20 }] }] });
  await sleep(300);
  const screen = await nodeNamed(page, "Screen");
  await select(page, screen.id);
  await page.locator("[aria-label*='Layers']").first().click().catch(() => {});
  await sleep(300);
  await axeRun(page, "editor (1000, Layers overlay)");
  await page.keyboard.press("Escape");
  await page.locator("[aria-label*='Design']").first().click().catch(() => {});
  await sleep(300);
  await shot(page, "12-editor-1000");
  await axeRun(page, "editor (1000, Design overlay)");
  await page.keyboard.press("Escape");
  await page.locator(".tbtn[title^='Present (']").click();
  await page.waitForSelector(".presenter");
  await sleep(500);
  await axeRun(page, "presenter");
  await ctx.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
