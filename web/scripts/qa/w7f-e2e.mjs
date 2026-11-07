// Keyboard layers, pages and canvas: layers tree, page list, sibling selection, keyboard insert,
// screen reader description of the selection and F6 region cycling. Keys only after setup.
// Usage: E2E_URL=http://localhost:5173 node scripts/qa/w7f-e2e.mjs (dev server running).
// Env: E2E_URL, CHROMIUM (executable path), AXE (path of axe.min.js; default web/node_modules).

import { chromium } from "playwright-core";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const URL = process.env.E2E_URL ?? "http://localhost:5173";
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
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
// Nothing may leave the machine.
await context.route(/^https?:\/\/(?!(127\.0\.0\.1|localhost)[:/])/, (r) => r.abort());
const p = await context.newPage();
await p.addInitScript(() => {
  try {
    localStorage.setItem("dt:tour-done", "1");
  } catch {
    /* no storage */
  }
});
const errors = [];
p.on("pageerror", (e) => errors.push(String(e)));

const doc = () => p.evaluate(() => window.__dt.doc());
const state = () => p.evaluate(() => window.__dt.state());
const named = async (name) => Object.values((await doc()).nodes).find((n) => n.name === name);
const sel = async () => (await state()).selection;
const selNames = async () => {
  const d = await doc();
  return (await sel()).map((id) => d.nodes[id]?.name);
};
const press = async (k, wait = 120) => {
  await p.keyboard.press(k);
  await sleep(wait);
};
const active = () =>
  p.evaluate(() => {
    const a = document.activeElement;
    return { tag: a?.tagName, id: a?.id, layer: a?.getAttribute?.("data-layer"), page: a?.getAttribute?.("data-page"), role: a?.getAttribute?.("role"), cls: a?.className?.toString?.() ?? "" };
  });
const dispatch = (cmd) => p.evaluate((cmd) => window.__dt.dispatch(cmd), cmd);
const nodeCount = async () => Object.keys((await doc()).nodes).length;
const focusCanvas = () => p.evaluate(() => document.getElementById("dt-canvas").focus());
const rowNames = () => p.evaluate(() => [...document.querySelectorAll("[role=treeitem]")].map((r) => r.querySelector(".name")?.textContent ?? ""));

try {
  await p.goto(URL);
  await p.click("button:has-text('New design file')");
  await p.waitForSelector("#dt-canvas");
  await sleep(300);
  await p.evaluate(() =>
    window.__dt.tool("create_nodes", {
      nodes: [
        {
          type: "frame",
          name: "Screen A",
          x: 0,
          y: 0,
          width: 400,
          height: 600,
          fill: "#FFFFFF",
          children: [
            { type: "rectangle", name: "Hero", x: 10, y: 10, width: 100, height: 60, fill: "#7C5CFF" },
            { type: "rectangle", name: "Middle", x: 10, y: 90, width: 100, height: 60, fill: "#FF5C7C" },
            { type: "rectangle", name: "Footer", x: 10, y: 170, width: 100, height: 60, fill: "#5CFF7C" },
          ],
        },
        { type: "frame", name: "Screen B", x: 500, y: 0, width: 300, height: 400, fill: "#EEEEEE" },
        { type: "frame", name: "Screen C", x: 900, y: 0, width: 300, height: 400, fill: "#DDDDDD" },
      ],
    }),
  );
  await dispatch({ op: "addPage", name: "Second" });
  await dispatch({ op: "addPage", name: "Third" });
  const pages = (await doc()).pages;
  await dispatch({ op: "setPage", id: pages[0].id });
  await dispatch({ op: "select", ids: [] });
  await p.evaluate(() => window.__dt.zoomToFit());
  await sleep(300);

  // ---------- Layers tree ----------
  const treeAttrs = await p.evaluate(() => {
    const t = document.querySelector("[role=tree]");
    const rows = [...document.querySelectorAll("[role=treeitem]")];
    return {
      label: t?.getAttribute("aria-label"),
      multi: t?.getAttribute("aria-multiselectable"),
      rows: rows.length,
      levels: [...new Set(rows.map((r) => r.getAttribute("aria-level")))].join(),
      tabStops: rows.filter((r) => r.tabIndex === 0).length,
      expandable: rows.filter((r) => r.hasAttribute("aria-expanded")).length,
    };
  });
  check("layers: role=tree with label, multiselectable, treeitems with level and one tab stop", treeAttrs.label === "Layers" && treeAttrs.multi === "true" && treeAttrs.rows === 3 && treeAttrs.levels === "1" && treeAttrs.tabStops === 1 && treeAttrs.expandable === 1, JSON.stringify(treeAttrs));

  // Tab from the Layers tab: Add page, the page list, the layer search field and filter button, then the tree (one stop each).
  await p.evaluate(() => document.querySelector("#left-tab-layers").focus());
  let stops = [];
  for (let i = 0; i < 8; i++) {
    await press("Tab", 40);
    const a = await active();
    stops.push(a.page ? "page" : a.layer ? "layer" : a.tag);
    if (a.layer) break;
  }
  check("Tab reaches the page list, layer search and the layers tree in one stop each", stops.join() === "BUTTON,page,INPUT,BUTTON,layer", stops.join());
  check("tab stop of the tree is the first row when nothing is selected", (await active()).layer === (await named("Screen C")).id);

  await press("ArrowDown");
  check("layers: ArrowDown moves focus and selects the next row", (await sel()).length === 1 && (await sel())[0] === (await named("Screen B")).id && (await active()).layer === (await named("Screen B")).id, (await selNames()).join());
  await press("ArrowDown");
  await press("ArrowRight");
  const expanded = await p.evaluate(() => document.querySelector("[data-layer]:nth-of-type(3)")?.getAttribute("aria-expanded"));
  check("layers: ArrowRight expands the focused layer", expanded === "true" && (await rowNames()).includes("Hero"), (await rowNames()).join());
  await press("ArrowRight");
  check("layers: ArrowRight on an expanded layer moves to its first child", (await selNames()).join() === "Footer", (await selNames()).join());
  await press("ArrowLeft");
  check("layers: ArrowLeft on a child moves to the parent", (await selNames()).join() === "Screen A");
  await press("ArrowLeft");
  check("layers: ArrowLeft on an expanded layer collapses it", (await rowNames()).join() === "Screen C,Screen B,Screen A");
  await press("ArrowRight");

  // Shift+Arrow extends, Space toggles.
  await press("ArrowDown");
  await press("Shift+ArrowDown");
  check("layers: Shift+ArrowDown extends the selection over a range", (await sel()).length === 2, (await selNames()).join());
  await press("ArrowUp");
  check("layers: plain arrows collapse a range to one row", (await sel()).length === 1);
  await press(" ");
  check("layers: Space on the lone selected row keeps it selected (round 14, U2)", (await sel()).length === 1);
  await press("Shift+ArrowDown");
  await press(" ");
  check("layers: Space toggles the focused row out of a larger selection", (await sel()).length === 1);

  // Rename with F2: Enter commits, Escape cancels, focus returns to the row.
  const heroBefore = await named("Hero");
  await press("Home");
  await press("ArrowDown");
  await press("ArrowDown");
  await press("ArrowLeft");
  await press("End");
  const aId = (await named("Screen A")).id;
  check("layers: Home/End move to the first/last row", (await active()).layer === aId);
  await press("F2", 200);
  const renaming = await p.evaluate(() => document.activeElement?.tagName === "INPUT" && document.activeElement.getAttribute("aria-label"));
  check("layers: F2 opens the rename field (labelled)", renaming === "Layer name", String(renaming));
  await press("Escape", 200);
  check("layers: Escape cancels the rename and focus returns to the row", (await active()).layer === aId && (await named("Screen A")) !== undefined);
  await press("F2", 200);
  await p.keyboard.press("Control+a");
  await p.keyboard.type("Landing");
  await press("Enter", 300);
  check("layers: F2, type, Enter renames the layer", (await doc()).nodes[aId].name === "Landing", (await doc()).nodes[aId].name);
  check("layers: focus is on the row after the rename", (await active()).layer === aId, JSON.stringify(await active()));
  await press("F2", 200);
  await p.keyboard.press("Control+a");
  await p.keyboard.type("Screen A");
  await press("Enter", 300);

  // Reorder and delete.
  await dispatch({ op: "select", ids: [] });
  await press("Home");
  const orderOf = async () => (await doc()).pages[0].children.map((id) => (doc_nodes[id] ?? ""));
  let doc_nodes = {};
  const topNames = async () => {
    const d = await doc();
    doc_nodes = Object.fromEntries(Object.entries(d.nodes).map(([k, v]) => [k, v.name]));
    return d.pages[0].children.map((id) => d.nodes[id].name).join();
  };
  const before = await topNames(); // bottom-to-top: Screen A,Screen B,Screen C
  await press("Alt+Shift+ArrowDown");
  const after = await topNames();
  check("layers: Alt+Shift+ArrowDown sends the layer backward", before === "Screen A,Screen B,Screen C" && after === "Screen A,Screen C,Screen B", `${before} -> ${after}`);
  await press("Alt+Shift+ArrowUp");
  check("layers: Alt+Shift+ArrowUp brings it forward again", (await topNames()) === before);
  void orderOf;

  // ---------- Pages ----------
  const listAttrs = await p.evaluate(() => {
    const l = document.querySelector("[role=listbox]");
    const o = [...l.querySelectorAll("[role=option]")];
    return { label: l.getAttribute("aria-labelledby") && document.getElementById(l.getAttribute("aria-labelledby")).textContent, options: o.length, selected: o.filter((x) => x.getAttribute("aria-selected") === "true").length, stops: o.filter((x) => x.tabIndex === 0).length };
  });
  check("pages: listbox named Pages with options, one selected, one tab stop", listAttrs.label === "Pages" && listAttrs.options === 3 && listAttrs.selected === 1 && listAttrs.stops === 1, JSON.stringify(listAttrs));
  await p.evaluate(() => document.querySelector("#left-tab-layers").focus());
  await press("Tab", 40);
  await press("Tab", 40);
  check("pages: Tab lands on the current page option", (await active()).page === (await doc()).pages[0].id);
  await press("ArrowDown");
  check("pages: ArrowDown moves focus without switching", (await active()).page === pages[1].id && (await state()).page === pages[0].id);
  await press("Enter", 250);
  check("pages: Enter switches the page", (await state()).page === pages[1].id);
  await press("ArrowDown");
  await press(" ", 250);
  check("pages: Space switches the page", (await state()).page === pages[2].id);
  await press("F2", 200);
  await p.keyboard.press("Control+a");
  await p.keyboard.type("Last");
  await press("Enter", 300);
  check("pages: F2, type, Enter renames the page and focus stays on it", (await doc()).pages[2].name === "Last" && (await active()).page === pages[2].id);
  await focusCanvas();
  await press("Alt+PageUp", 250);
  check("pages: Alt+PageUp goes to the previous page", (await state()).page === pages[1].id);
  await press("Alt+PageDown", 250);
  await press("Alt+PageDown", 250);
  check("pages: Alt+PageDown stops at the last page", (await state()).page === pages[2].id);
  await press("Alt+PageUp", 150);
  await press("Alt+PageUp", 250);
  check("pages: back on the first page", (await state()).page === pages[0].id);

  // ---------- Canvas: sibling selection ----------
  const frameA = await named("Screen A");
  await dispatch({ op: "select", ids: [frameA.id] });
  await focusCanvas();
  await press("Enter");
  check("canvas: Enter selects the children", (await sel()).length === 3, (await selNames()).join());
  await press("Tab");
  await press("Tab");
  check("canvas: Tab Tab selects the third child alone", (await selNames()).join() === "Footer", (await selNames()).join());
  check("canvas: focus stays on the canvas", (await active()).id === "dt-canvas");
  await press("Shift+Tab");
  check("canvas: Shift+Tab selects the previous sibling", (await selNames()).join() === "Middle", (await selNames()).join());
  await press("Tab");
  await press("Tab");
  check("canvas: Tab wraps around the siblings", (await selNames()).join() === "Hero", (await selNames()).join());
  await press("Shift+Enter");
  check("canvas: Shift+Enter selects the parent", (await selNames()).join() === "Screen A", (await selNames()).join());
  await press("Escape");
  check("canvas: Escape from a top-level layer deselects", (await sel()).length === 0);
  await press("Tab", 80);
  const out = await active();
  check("canvas: with nothing selected Tab moves focus out (no keyboard trap)", out.id !== "dt-canvas");

  // Tab and arrows must not leak into other controls: a focused field keeps its own keys.
  await dispatch({ op: "select", ids: [frameA.id] });
  await p.evaluate(() => document.querySelector(".topbar input.filename, .topbar input")?.focus());
  const sameBefore = await sel();
  await press("Tab", 80);
  check("Tab in the toolbar leaves the selection alone", JSON.stringify(await sel()) === JSON.stringify(sameBefore));

  // ---------- Keyboard insert ----------
  await dispatch({ op: "select", ids: [] });
  await focusCanvas();
  const n0 = await nodeCount();
  await press("r");
  await press("Enter", 250);
  const d1 = await doc();
  const newId = (await sel())[0];
  const made = d1.nodes[newId];
  const bounds = await p.evaluate((id) => window.__dt.query({ q: "bounds", ids: [id] }).items[0].bounds, newId);
  const center = await p.evaluate(() => {
    const c = document.getElementById("dt-canvas");
    const v = window.__dt.viewport();
    return { x: (c.clientWidth / 2 - v.x) / v.zoom, y: (c.clientHeight / 2 - v.y) / v.zoom };
  });
  check("insert: R then Enter adds one rectangle, selected, back on the Move tool", (await nodeCount()) === n0 + 1 && made?.type === "rectangle" && (await p.evaluate(() => window.__dt.state().selection.length)) === 1);
  check("insert: it is 100×100 at the viewport centre", Math.abs(bounds.width - 100) < 1 && Math.abs(bounds.x + 50 - center.x) <= 1 && Math.abs(bounds.y + 50 - center.y) <= 1, JSON.stringify({ bounds, center }));
  await press("Control+z", 250);
  check("insert: Ctrl+Z removes it in one step", (await nodeCount()) === n0);
  await press("Control+Shift+z", 250);
  await press("Control+z", 250);

  await press("o");
  await press("Enter", 200);
  const ell = Object.values((await doc()).nodes).filter((n) => n.type === "ellipse");
  check("insert: O then Enter adds an ellipse", ell.length === 1);
  await press("Control+z", 250);

  await press("f");
  await press("Enter", 200);
  const fr = (await doc()).nodes[(await sel())[0]];
  check("insert: F then Enter adds a 390×844 frame", fr?.type === "frame" && Math.round(fr.width) === 390 && Math.round(fr.height) === 844, JSON.stringify([fr?.width, fr?.height]));
  await press("Control+z", 250);

  // Ctrl+Enter goes inside the selected frame.
  await dispatch({ op: "select", ids: [(await named("Screen B")).id] });
  await focusCanvas();
  await press("r");
  await press("Control+Enter", 250);
  const inner = (await doc()).nodes[(await sel())[0]];
  check("insert: Ctrl+Enter puts the layer inside the selected frame", inner?.type === "rectangle" && inner.parent === (await named("Screen B")).id, inner?.parent);
  await press("Control+z", 250);

  // Text opens for typing.
  await dispatch({ op: "select", ids: [] });
  await focusCanvas();
  await press("t");
  await press("Enter", 300);
  const editing = await p.evaluate(() => document.activeElement?.tagName === "TEXTAREA");
  check("insert: T then Enter creates a text layer in edit mode", editing);
  await p.keyboard.type("Hello");
  await press("Escape", 300);
  check("insert: typed text lands in the new layer", Object.values((await doc()).nodes).some((n) => n.type === "text" && n.text?.characters === "Hello"));
  await focusCanvas();
  await press("Escape");

  // Enter without a creation tool still selects children; typing in inputs is untouched.
  await dispatch({ op: "select", ids: [frameA.id] });
  await focusCanvas();
  await press("Enter");
  check("Enter with the Move tool still selects the children", (await sel()).length === 3);

  // ---------- Canvas semantics ----------
  const attrs = await p.evaluate(() => {
    const c = document.getElementById("dt-canvas");
    return { role: c.getAttribute("role"), rd: c.getAttribute("aria-roledescription"), label: c.getAttribute("aria-label") };
  });
  check("canvas: role=application, roledescription and a name with the page", attrs.role === "application" && attrs.rd === "design canvas" && /^Canvas, /.test(attrs.label ?? ""), JSON.stringify(attrs));
  await dispatch({ op: "select", ids: [(await named("Middle")).id] });
  await sleep(600);
  const live = await p.evaluate(() => document.querySelector(".canvas-live")?.textContent);
  check("canvas: the live region names the selection, size and position", /Middle \(rectangle\) 100×60, 2 of 3 in Screen A/.test(live ?? ""), live);
  const liveAttr = await p.evaluate(() => document.querySelector(".canvas-live")?.getAttribute("aria-live"));
  check("canvas: the description region is polite", liveAttr === "polite");

  // ---------- F6 ----------
  await focusCanvas();
  const region = async () =>
    p.evaluate(() => {
      const a = document.activeElement;
      if (a?.closest(".topbar")) return "toolbar";
      if (a?.closest(".main > .panel.right")) return "right";
      if (a?.closest(".main > .panel")) return "layers";
      if (a?.closest(".main > .chat")) return "chat";
      if (a?.id === "dt-canvas") return "canvas";
      return a?.tagName ?? "?";
    });
  const seq = [];
  for (let i = 0; i < 4; i++) {
    await press("F6", 80);
    seq.push(await region());
  }
  check("F6 cycles through the four regions and returns to the canvas", seq.join() === "right,toolbar,layers,canvas", seq.join());
  await press("Shift+F6", 80);
  check("Shift+F6 goes the other way", (await region()) === "layers");

  // ---------- Mouse then keyboard: clicks give the keys back to the canvas ----------
  await dispatch({ op: "select", ids: [] });
  await dispatch({ op: "setPage", id: pages[0].id });
  await sleep(200);
  const heroId = (await named("Hero")).id;
  const treeRow = (name) => p.locator(`[role=treeitem] .name:text-is("${name}")`).first();
  await dispatch({ op: "select", ids: [heroId] }); // reveals Hero
  await dispatch({ op: "select", ids: [] });
  await sleep(200);
  await treeRow("Hero").click();
  await sleep(150);
  check("click a layer row: focus goes to the canvas", (await active()).id === "dt-canvas", JSON.stringify(await active()));
  await p.keyboard.down("Space");
  await p.keyboard.down("Space");
  await p.keyboard.down("Space");
  await p.keyboard.up("Space");
  await sleep(150);
  check("click a row, hold Space: the layer stays selected (Space is the pan key)", (await selNames()).join() === "Hero");
  const hx = (await named("Hero")).x;
  await press("ArrowRight");
  check("click a row, ArrowRight nudges the layer", (await named("Hero")).x === hx + 1 && (await selNames()).join() === "Hero");
  await treeRow("Screen A").click();
  await press("Enter");
  check("click a frame row, one Enter selects its children", (await sel()).length === 3);
  await dispatch({ op: "select", ids: [] });

  // A mouse click on a page leaves Delete for the layers; Delete on a keyboard-focused page removes it.
  await dispatch({ op: "select", ids: [frameA.id] });
  await p.locator(".page-item").first().click();
  await sleep(150);
  await press("Delete");
  check("click a page item, Delete: the page stays", (await doc()).pages.length === 3);
  await dispatch({ op: "setPage", id: pages[0].id });

  // Body focus (after Enter in a field) is not the canvas: Tab moves on, Enter does not insert.
  await dispatch({ op: "select", ids: [frameA.id] });
  await p.evaluate(() => document.activeElement?.blur?.());
  await press("Tab", 80);
  check("Tab from body is not taken for sibling selection", JSON.stringify(await sel()) === JSON.stringify([frameA.id]) && (await active()).id !== "dt-canvas");
  await focusCanvas();
  await press("r");
  await p.evaluate(() => document.activeElement?.blur?.());
  const nBody = await nodeCount();
  await press("Enter", 200);
  check("Enter on body with a drawing tool inserts nothing", (await nodeCount()) === nBody);
  await press("Escape");
  await press("Escape");

  // Keyboard delete in the tree hands focus to a surviving row, also when the frame is expanded.
  await dispatch({ op: "select", ids: [] });
  await p.evaluate(() => document.querySelector("[role=treeitem]").focus());
  await press("Home");
  await press("End");
  const rowsBefore = await rowNames();
  const lastRow = rowsBefore[rowsBefore.length - 1];
  void lastRow;
  // Focus the expanded frame row with the keyboard and delete it.
  await p.evaluate((id) => document.querySelector(`[data-layer="${id}"]`).focus(), frameA.id);
  await press("Delete", 300);
  const afterDel = await active();
  check("layers: Delete on an expanded frame leaves focus on a surviving row", !!afterDel.layer && afterDel.layer !== frameA.id, JSON.stringify(afterDel));
  await press("Control+z", 300);
  // Tab leaves the tree (it is one stop) and Shift+Tab comes back to the same row.
  await p.evaluate((id) => document.querySelector(`[data-layer="${id}"]`).focus(), frameA.id);
  await press("Tab", 150);
  const tabbedOut = (await active()).id === "dt-canvas";
  await dispatch({ op: "select", ids: [] }); // with a selection Shift+Tab on the canvas picks siblings
  await press("Shift+Tab", 150);
  check("layers: Tab leaves the tree for the canvas, Shift+Tab returns to the row", tabbedOut && (await active()).layer === frameA.id, JSON.stringify(await active()));
  // A row deleted from outside (a collaborator) hands focus on, too.
  const bId = (await named("Screen B")).id;
  await p.evaluate((id) => document.querySelector(`[data-layer="${id}"]`).focus(), bId);
  await dispatch({ op: "delete", ids: [bId] });
  await sleep(300);
  check("layers: a focused row deleted elsewhere hands focus to the tab stop", !!(await active()).layer, JSON.stringify(await active()));
  await press("Control+z", 300);
  // Keyboard-focused page option: Backspace deletes like Delete.
  await dispatch({ op: "addPage", name: "Spare" });
  const nPages = (await doc()).pages.length;
  await p.evaluate(() => document.querySelector("[role=option]:last-child").focus());
  await press("Backspace", 300);
  check("pages: Backspace on a keyboard-focused page deletes it", (await doc()).pages.length === nPages - 1);
  await dispatch({ op: "setPage", id: pages[0].id });
  await sleep(200);

  // F6 from a rename field.
  await treeRow("Screen B").dblclick();
  await sleep(200);
  check("double-click still opens the rename field", await p.evaluate(() => document.activeElement?.tagName === "INPUT"));
  await press("F6", 250);
  check("F6 works from a rename field", (await active()).tag !== "INPUT");
  await focusCanvas();

  // A stale tree focus must not pull focus back later: keyboard-focus a row, switch to an empty page
  // with Alt+PageDown, draw, Enter in a field, then the arrows must still nudge.
  await p.evaluate(() => document.querySelector("[role=treeitem]").focus());
  await press("Alt+PageDown", 300);
  const emptyPage = (await doc()).pages[1];
  check("Alt+PageDown from a row switched to the next page", (await state()).page === emptyPage.id);
  const drawn = await dispatch({ op: "createShape", kind: "rectangle", x: 50, y: 50, width: 80, height: 80, parent: null });
  await sleep(300);
  const widthInput = p.locator("label.field", { hasText: /^W$/ }).locator("input").first();
  await widthInput.click({ clickCount: 3 });
  await widthInput.fill("150");
  await widthInput.press("Enter");
  await sleep(300);
  const afterEnter = await active();
  check("Enter in a field after Alt+PageDown and drawing leaves focus off the tree", !afterEnter.layer, JSON.stringify(afterEnter));
  const rx = (await doc()).nodes[drawn.id].x;
  await p.evaluate(() => document.activeElement?.blur?.());
  await press("ArrowRight");
  check("...and the arrows still nudge the rectangle", (await doc()).nodes[drawn.id].x === rx + 1 && (await doc()).nodes[drawn.id].width === 150);
  await dispatch({ op: "delete", ids: [drawn.id] });
  await dispatch({ op: "setPage", id: pages[0].id });
  await sleep(200);

  // A long (windowed) list scrolls by wheel while a row has focus: the focused row stays drawn.
  await dispatch({ op: "setPage", id: pages[2].id });
  await p.evaluate(() => {
    const nodes = [];
    for (let i = 0; i < 300; i++) nodes.push({ type: "rectangle", name: "L" + i, x: i * 12, y: 0, width: 10, height: 10, fill: "#888888" });
    window.__dt.tool("create_nodes", { nodes });
  });
  await sleep(600);
  await dispatch({ op: "select", ids: [] });
  const listTop = () => p.evaluate(() => document.querySelector("[role=tree]").parentElement.scrollTop);
  const longRow = p.locator("[data-layer]").nth(3);
  await longRow.dblclick();
  await sleep(200);
  await p.keyboard.type("Renamed");
  await press("Enter", 300);
  check("long list: rename by double-click returns focus to the row", !!(await active()).layer);
  const box = await longRow.boundingBox();
  await p.mouse.move(box.x + 60, box.y + 200);
  for (let i = 0; i < 3; i++) {
    await p.mouse.wheel(0, 1500);
    await sleep(300);
  }
  check("long list: the wheel scrolls while a row has focus", (await listTop()) > 3000, String(await listTop()));
  check("long list: the focused row is still drawn and focused", !!(await active()).layer);
  await press("End", 300);
  check("long list: End focuses the last row", (await active()).layer === (await sel())[0]);
  // Drag-reorder in the panel leaves the keys with the canvas.
  await p.evaluate(() => (document.querySelector("[role=tree]").parentElement.scrollTop = 0));
  await sleep(300);
  const rowA = p.locator("[data-layer]").nth(2);
  const rowB = p.locator("[data-layer]").nth(4);
  await rowA.dragTo(rowB);
  await sleep(300);
  const dragged = (await sel())[0];
  const dx0 = (await doc()).nodes[dragged].x;
  await press("ArrowRight");
  check("after a drag-reorder in the layers panel the arrows nudge", (await active()).id === "dt-canvas" && (await doc()).nodes[dragged].x === dx0 + 1, JSON.stringify(await active()));
  await dispatch({ op: "setPage", id: pages[0].id });
  await sleep(200);

  // Tree and canvas attributes.
  const pos = await p.evaluate(() =>
    [...document.querySelectorAll("[role=treeitem]")]
      .filter((r) => r.getAttribute("aria-level") === "1")
      .map((r) => `${r.getAttribute("aria-posinset")}/${r.getAttribute("aria-setsize")}`)
      .join(),
  );
  check("layers: treeitems carry aria-posinset and aria-setsize in display order", pos === "1/3,2/3,3/3", pos);
  const desc = await p.evaluate(() => document.getElementById("dt-canvas").getAttribute("aria-description"));
  check("canvas: aria-description tells how to leave with Tab and F6", /Tab/.test(desc ?? "") && /F6/.test(desc ?? ""), desc);

  // ---------- Deep nesting ----------
  await dispatch({ op: "setPage", id: pages[1].id });
  const nest = { type: "frame", name: "Level 0 with a rather long name", x: 0, y: 0, width: 500, height: 500, fill: "#fff", children: [] };
  let cur = nest;
  for (let i = 1; i <= 12; i++) {
    const c = { type: "frame", name: `Level ${i} with a rather long name`, width: 400 - i * 10, height: 400 - i * 10, fill: "#eee", children: [] };
    cur.children.push(c);
    cur = c;
  }
  await p.evaluate((n) => window.__dt.tool("create_nodes", { nodes: [n] }), nest);
  await sleep(300);
  await p.evaluate(() => document.querySelector("[role=treeitem]").focus());
  for (let i = 0; i < 12; i++) {
    await press("ArrowRight", 60);
    await press("ArrowDown", 60);
  }
  const deep = await p.evaluate(() => {
    const rows = [...document.querySelectorAll("[role=treeitem]")];
    const last = rows[rows.length - 1];
    const name = last.querySelector(".name").getBoundingClientRect();
    const panel = document.querySelector(".main > .panel").getBoundingClientRect();
    return { rows: rows.length, level: last.getAttribute("aria-level"), pad: parseFloat(last.style.paddingLeft), nameW: Math.round(name.width), inside: name.right <= panel.right + 1, title: last.title };
  });
  check("deep nesting: indent is capped and the name keeps room", deep.rows === 13 && deep.level === "13" && deep.pad <= 8 + 8 * 14 + 5 * 4 && deep.nameW >= 60 && deep.inside, JSON.stringify(deep));
  check("deep nesting: the row title has the full name", /^Level 12 with a rather long name/.test(deep.title));

  // ---------- axe: tree and listbox structure ----------
  const axePath = [process.env.AXE, path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../node_modules/axe-core/axe.min.js")].filter(Boolean).find((f) => fs.existsSync(f));
  if (!axePath) console.log("SKIP  axe: axe-core not installed");
  else {
    await p.addScriptTag({ content: fs.readFileSync(axePath, "utf8") });
    await dispatch({ op: "setPage", id: pages[0].id });
    await sleep(300);
    const res = await p.evaluate(async () => {
      const r = await window.axe.run(document, { runOnly: ["aria-required-children", "aria-required-parent", "aria-valid-attr-value", "aria-allowed-attr", "aria-allowed-role", "nested-interactive", "aria-roles"] });
      return r.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target.join(" ")).slice(0, 3) }));
    });
    const mine = res.filter((v) => v.nodes.some((t) => /tree|listbox|treeitem|option|data-layer|page-item|layer|pages|canvas/.test(t)) || /required/.test(v.id));
    check("axe: no required-children/parent or ARIA violations in the tree, list or canvas", mine.length === 0, JSON.stringify(mine));
  }

  check("no page errors", errors.length === 0, errors.join(" | "));
} catch (e) {
  check("script ran to the end", false, String(e?.stack ?? e));
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
