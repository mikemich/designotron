// W3-E: pages (reorder, duplicate, move layers between pages), the Scale tool (K), the eyedropper (I),
// selection commands (matching layers, same properties, instances, invert), tidy up, paste positions
// and frame presets while the Frame tool is active.
// Usage: E2E_URL=http://localhost:5541 node scripts/qa/w3e-e2e.mjs (dev server running).
// Env: E2E_URL, CHROMIUM (executable path).

import { chromium } from "playwright-core";
import fs from "node:fs";

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
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new globalThis.URL(URL).origin });
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
const dispatch = (cmd) => p.evaluate((cmd) => window.__dt.dispatch(cmd), cmd);
const sel = async () => (await state()).selection;
const named = async (name) => Object.values((await doc()).nodes).find((n) => n.name === name);
const allNamed = async (name) => Object.values((await doc()).nodes).filter((n) => n.name === name);
const create = (nodes) => p.evaluate((nodes) => window.__dt.tool("create_nodes", { nodes }), nodes);
const select = (...ids) => dispatch({ op: "select", ids });
const press = async (k, wait = 150) => {
  await p.keyboard.press(k);
  await sleep(wait);
};
const focusCanvas = () => p.evaluate(() => document.getElementById("dt-canvas").focus());
const view = (x = 20, y = 20, zoom = 1) => p.evaluate((v) => window.__dt.setViewport(v), { x, y, zoom });
const pageIds = async () => (await doc()).pages.map((pg) => pg.id);
const countOn = async (page) => Object.values((await doc()).nodes).filter((n) => n.page === page).length;
/** Client coordinates of a page point at the current viewport. */
const screenOf = async (x, y) =>
  p.evaluate(
    ([x, y]) => {
      const b = document.getElementById("dt-canvas").getBoundingClientRect();
      const v = window.__dt.viewport();
      return { x: b.left + v.x + x * v.zoom, y: b.top + v.y + y * v.zoom };
    },
    [x, y],
  );
const rightClickPage = async (x, y) => {
  const s = await screenOf(x, y);
  await p.mouse.click(s.x, s.y, { button: "right" });
  await sleep(150);
};
const menuItem = (label) => p.locator(`.menu [role=menuitem]:has-text("${label}")`).first();
const clear = async () => {
  await dispatch({ op: "select", ids: [] });
  await dispatch({ op: "selectAll" });
  const ids = await sel();
  if (ids.length) await dispatch({ op: "delete", ids });
  await dispatch({ op: "select", ids: [] });
};
const toolPressed = (title) => p.getAttribute(`.tbtn[title^='${title}']`, "aria-pressed");
const mainMenu = async (label) => {
  await p.click(".tbtn[title='Main menu']");
  await p.waitForSelector(".menu[role=menu]");
  await menuItem(label).click();
  await sleep(150);
};

try {
  await p.goto(URL);
  await p.click("button:has-text('New design file')");
  await p.waitForSelector("#dt-canvas");
  await sleep(400);
  await view();

  // ---------- Pages ----------
  await dispatch({ op: "addPage", name: "Page 2" });
  await dispatch({ op: "addPage", name: "Page 3" });
  const [p1, p2, p3] = await pageIds();
  await dispatch({ op: "setPage", id: p1 });
  await sleep(200);
  await p.dragAndDrop(`[data-page="${p3}"]`, `[data-page="${p1}"]`, { targetPosition: { x: 40, y: 3 } });
  await sleep(250);
  check("dragging page 3 above page 1 reorders the list", (await pageIds()).join() === [p3, p1, p2].join(), (await pageIds()).join());
  const rowOrder = await p.$$eval("[data-page]", (els) => els.map((e) => e.getAttribute("data-page")));
  check("the list shows the new order", rowOrder.join() === [p3, p1, p2].join());
  await focusCanvas();
  await press("Control+z");
  check("Ctrl+Z restores the page order", (await pageIds()).join() === [p1, p2, p3].join(), (await pageIds()).join());

  await p.focus(`[data-page="${p1}"]`);
  await press("Alt+Shift+ArrowDown");
  check("Alt+Shift+ArrowDown moves the focused page down", (await pageIds()).join() === [p2, p1, p3].join(), (await pageIds()).join());
  check("focus stays on the moved page", await p.evaluate((id) => document.activeElement?.getAttribute("data-page") === id, p1));
  await press("Alt+Shift+ArrowUp");
  check("Alt+Shift+ArrowUp moves it back", (await pageIds()).join() === [p1, p2, p3].join());
  await p.click(`[data-page="${p2}"]`);
  check("clicking a page still switches to it", (await state()).page === p2);
  await p.click(`[data-page="${p1}"]`);

  const cardJson = (x, fill) => ({
    type: "frame",
    name: "Card",
    x,
    y: 0,
    width: 200,
    height: 120,
    children: [
      { type: "text", name: "Title", characters: "Hello", x: 10, y: 10 },
      { type: "rectangle", name: "Bg", x: 10, y: 50, width: 60, height: 50, fill },
    ],
  });
  await create([cardJson(0, "#FF0000"), cardJson(250, "#FF0000"), cardJson(500, "#0000FF")]);
  await sleep(200);
  const before = await countOn(p1);
  await p.click(`[data-page="${p1}"]`, { button: "right" });
  await menuItem("Duplicate page").click();
  await sleep(250);
  const d1 = await doc();
  const cur = (await state()).page;
  const copy = d1.pages.find((pg) => pg.id === cur);
  check("Duplicate page makes the copy current, named '<name> copy', right after the original", cur !== p1 && copy?.name === "Page 1 copy" && d1.pages[1].id === cur, `${copy?.name} ${d1.pages.map((x) => x.name)}`);
  check("the copy has the same layer count", (await countOn(cur)) === before && before === 9, `${await countOn(cur)} vs ${before}`);
  await dispatch({ op: "deletePage", id: cur });
  await dispatch({ op: "setPage", id: p1 });
  await sleep(200);

  // Move to page from the canvas menu.
  const card1 = (await allNamed("Card")).sort((a, b) => a.x - b.x)[0];
  await select(card1.id);
  await rightClickPage(card1.x + 150, card1.y + 100);
  await menuItem("Move to Page 2").click();
  await sleep(300);
  const moved = (await doc()).nodes[card1.id];
  const kids = (await doc()).nodes[card1.id].children.map((c) => c);
  const kidPages = (await doc()).nodes[kids[0]].page;
  check("Move to page: the frame is on Page 2 with its children and Page 2 is current", moved.page === p2 && kidPages === p2 && (await state()).page === p2);
  check("and it stays selected", (await sel()).join() === card1.id);
  await focusCanvas();
  await press("Control+z");
  check("Ctrl+Z moves it back in one step", (await doc()).nodes[card1.id].page === p1);
  await dispatch({ op: "setPage", id: p1 });
  await sleep(200);

  // Drag a layer row onto a page.
  await select(card1.id);
  await p.waitForSelector(`[data-layer="${card1.id}"]`);
  await p.dragAndDrop(`[data-layer="${card1.id}"]`, `[data-page="${p3}"]`);
  await sleep(300);
  check("dragging a layer row onto a page moves it there", (await doc()).nodes[card1.id].page === p3 && (await state()).page === p3);
  await focusCanvas();
  await press("Control+z");
  await dispatch({ op: "setPage", id: p1 });
  await sleep(200);

  // ---------- Scale tool ----------
  await clear();
  await create([
    {
      type: "frame",
      name: "Box",
      x: 50,
      y: 50,
      width: 200,
      height: 100,
      fill: "#FFFFFF",
      children: [{ type: "rectangle", name: "Inner", x: 20, y: 20, width: 80, height: 40, fill: "#FF8800", stroke: "#000000", strokeWidth: 2 }],
    },
  ]);
  await sleep(200);
  const box = await named("Box");
  await select(box.id);
  await focusCanvas();
  await press("k");
  check("K activates the Scale tool", (await toolPressed("Scale")) === "true");
  const h = await p.locator('[data-handle="se"]').boundingBox();
  await p.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await p.mouse.down();
  await p.mouse.move(h.x + h.width / 2 + 100, h.y + h.height / 2 + 20, { steps: 4 });
  await p.mouse.move(h.x + h.width / 2 + 200, h.y + h.height / 2 + 40, { steps: 4 });
  await p.mouse.up();
  await sleep(200);
  const bigBox = await named("Box");
  const inner = await named("Inner");
  check("K + dragging a corner resizes proportionally", Math.abs(bigBox.width - 400) < 0.5 && Math.abs(bigBox.height - 200) < 0.5, `${bigBox.width}x${bigBox.height}`);
  check("children and stroke weights scale with it", inner.strokeWeight === 4 && inner.width === 160 && inner.x === 40, `stroke ${inner.strokeWeight} w ${inner.width} x ${inner.x}`);
  await press("Control+z");
  check("one undo returns the original size", (await named("Box")).width === 200 && (await named("Inner")).strokeWeight === 2);
  await select(box.id);
  const field = p.locator('input[aria-label="Scale"]');
  check("the Design panel has a Scale % field while the tool is active", (await field.count()) === 1);
  await field.fill("50");
  await field.press("Enter");
  await sleep(200);
  check("typing 50 in the Scale field halves the layer around its top-left", (await named("Box")).width === 100 && (await named("Box")).x === 50 && (await named("Inner")).strokeWeight === 1);
  await press("Escape");
  check("Escape leaves the Scale tool", (await toolPressed("Move")) === "true");
  await focusCanvas();
  await press("Control+z");

  // ---------- Eyedropper ----------
  await clear();
  await create([
    { type: "rectangle", name: "Red", x: 50, y: 50, width: 100, height: 100, fill: "#FF0000" },
    { type: "rectangle", name: "Blue", x: 250, y: 50, width: 100, height: 100, fill: "#0000FF" },
  ]);
  await sleep(200);
  const red = await named("Red");
  const blue = await named("Blue");
  await select(blue.id);
  await focusCanvas();
  await press("i");
  check("I activates the eyedropper", (await toolPressed("Eyedropper")) === "true");
  const rc = await screenOf(red.x + 50, red.y + 50);
  await p.mouse.click(rc.x, rc.y);
  await sleep(400);
  const blueNow = await named("Blue");
  check("clicking the red rectangle makes the selected blue one red", blueNow.fills[0]?.color?.toUpperCase().startsWith("#FF0000"), JSON.stringify(blueNow.fills));
  check("the tool ends after one click", (await toolPressed("Move")) === "true");
  await focusCanvas();
  await press("Control+z");
  check("one undo restores the blue fill", (await named("Blue")).fills[0]?.color?.toUpperCase().startsWith("#0000FF"));
  await dispatch({ op: "select", ids: [] });
  await focusCanvas();
  await press("i");
  await p.mouse.click(rc.x, rc.y);
  await sleep(400);
  check("with nothing selected it copies the hex and shows a toast", (await p.locator(".toast").first().textContent().catch(() => ""))?.includes("#FF0000"));
  await focusCanvas();
  await press("i");
  await press("Escape");
  check("Escape leaves the eyedropper", (await toolPressed("Move")) === "true");

  // ---------- Selection commands ----------
  await clear();
  await create([cardJson(0, "#FF0000"), cardJson(250, "#FF0000"), cardJson(500, "#0000FF")]);
  await sleep(200);
  const titles = (await allNamed("Title")).sort((a, b) => a.id.localeCompare(b.id));
  await select(titles[1].id);
  await focusCanvas();
  await press("Control+Alt+a");
  const picked = (await sel()).slice().sort();
  check("Ctrl+Alt+A on one card title selects the three titles", picked.join() === titles.map((t) => t.id).join(), picked.length + " selected");
  const cards = (await allNamed("Card")).sort((a, b) => a.x - b.x);
  await select(cards[0].id);
  await focusCanvas();
  await press("Control+Shift+a");
  check("Ctrl+Shift+A inverts the selection among siblings", (await sel()).slice().sort().join() === [cards[1].id, cards[2].id].sort().join());
  const bgs = await allNamed("Bg");
  const reds = bgs.filter((b) => b.fills[0]?.color?.toUpperCase().startsWith("#FF0000"));
  await select(reds[0].id);
  await mainMenu("Select all with same fill");
  check("Edit menu: Select all with same fill selects the two red layers", (await sel()).slice().sort().join() === reds.map((r) => r.id).sort().join(), (await sel()).length + " selected");

  // Instances.
  await clear();
  await create([{ type: "frame", name: "Btn", x: 50, y: 50, width: 120, height: 40, fill: "#EEEEEE" }]);
  const btn = await named("Btn");
  await dispatch({ op: "createComponent", ids: [btn.id] });
  const main = Object.values(await (await doc()).nodes).find((n) => n.type === "component");
  for (const x of [300, 450]) await dispatch({ op: "createInstance", componentId: main.id, x, y: 50, parent: null });
  const insts = Object.values((await doc()).nodes).filter((n) => n.type === "instance");
  await select(main.id);
  await rightClickPage(main.x + 60, main.y + 20);
  await menuItem("Select all instances").click();
  await sleep(200);
  check("Select all instances from a main component's menu", (await sel()).slice().sort().join() === insts.map((i) => i.id).sort().join() && insts.length === 2, (await sel()).length + " selected");

  // ---------- Tidy up ----------
  await clear();
  const spots = [[10, 14], [150, 0], [330, 22], [-6, 190], [170, 200], [300, 175]];
  await create(spots.map(([x, y], i) => ({ type: "rectangle", name: `Sq ${i}`, x, y, width: 60, height: 60, fill: "#7C5CFF" })));
  await sleep(200);
  await dispatch({ op: "selectAll" });
  await focusCanvas();
  await press("Control+Alt+t");
  const sq = [];
  for (let i = 0; i < 6; i++) sq.push(await named(`Sq ${i}`));
  const gapsH = [sq[1].x - (sq[0].x + 60), sq[2].x - (sq[1].x + 60), sq[4].x - (sq[3].x + 60), sq[5].x - (sq[4].x + 60)];
  const gapV = sq[3].y - (sq[0].y + 60);
  check("Ctrl+Alt+T arranges scattered layers into a 3 x 2 grid with equal gaps (+-1 px)", gapsH.every((g) => Math.abs(g - gapsH[0]) <= 1) && Math.abs(gapV - gapsH[0]) <= 40 && sq[0].y === sq[1].y && sq[1].y === sq[2].y && sq[3].y === sq[4].y && sq[3].x === sq[0].x, JSON.stringify({ gapsH, gapV }));
  await press("Control+z");
  check("one undo puts them back", (await named("Sq 0")).x === 10);

  // ---------- Paste positions ----------
  await clear();
  await create([{ type: "rectangle", name: "Copy me", x: 100, y: 100, width: 100, height: 100, fill: "#00AA00" }]);
  const orig = await named("Copy me");
  await select(orig.id);
  await focusCanvas();
  await press("Control+c");
  await dispatch({ op: "select", ids: [] });
  await press("Control+v");
  let copies = (await allNamed("Copy me")).filter((n) => n.id !== orig.id);
  check("Ctrl+V with the original in view pastes at its position", copies.length === 1 && copies[0].x === 100 && copies[0].y === 100, JSON.stringify(copies.map((c) => [c.x, c.y])));
  await press("Control+z");
  await view(-5000, -5000, 1);
  await sleep(200);
  await focusCanvas();
  await press("Control+v");
  copies = (await allNamed("Copy me")).filter((n) => n.id !== orig.id);
  const vp = await p.evaluate(() => {
    const b = document.getElementById("dt-canvas").getBoundingClientRect();
    const v = window.__dt.viewport();
    return { x0: -v.x / v.zoom, y0: -v.y / v.zoom, x1: (b.width - v.x) / v.zoom, y1: (b.height - v.y) / v.zoom };
  });
  const c0 = copies[0];
  check("Ctrl+V with the original off screen pastes inside the viewport", copies.length === 1 && c0.x >= vp.x0 && c0.x + 100 <= vp.x1 && c0.y >= vp.y0 && c0.y + 100 <= vp.y1, JSON.stringify({ c0: c0 && [c0.x, c0.y], vp }));
  await press("Control+z");
  await dispatch({ op: "select", ids: [] });
  await focusCanvas();
  await press("Control+Shift+v");
  await sleep(200);
  copies = (await allNamed("Copy me")).filter((n) => n.id !== orig.id);
  check("Ctrl+Shift+V pastes in place, ignoring the viewport", copies.length === 1 && copies[0].x === 100 && copies[0].y === 100, JSON.stringify(copies.map((c) => [c.x, c.y])));
  await press("Control+z");
  await view();
  await sleep(200);
  await rightClickPage(400, 300);
  await menuItem("Paste here").click();
  await sleep(300);
  copies = (await allNamed("Copy me")).filter((n) => n.id !== orig.id);
  check("Paste here pastes at the pointer", copies.length === 1 && Math.abs(copies[0].x - 400) <= 2 && Math.abs(copies[0].y - 300) <= 2, JSON.stringify(copies.map((c) => [c.x, c.y])));

  // ---------- Frame presets ----------
  await clear();
  await view();
  await focusCanvas();
  await press("f");
  const presets = await p.locator(".frame-presets button").allTextContents();
  check("with the Frame tool active the Design panel lists the presets", presets.some((t) => t.includes("iPhone 16")) && presets.length >= 5, presets.join("|"));
  await p.locator(".frame-presets button:has-text('iPhone 16')").first().click();
  await sleep(250);
  const phone = await named("iPhone 16");
  const mid = await p.evaluate(() => {
    const b = document.getElementById("dt-canvas").getBoundingClientRect();
    const v = window.__dt.viewport();
    return { x: (b.width / 2 - v.x) / v.zoom, y: (b.height / 2 - v.y) / v.zoom };
  });
  check("clicking 'iPhone 16' makes a 393 x 852 frame at the viewport centre", !!phone && phone.width === 393 && phone.height === 852 && Math.abs(phone.x + 196.5 - mid.x) <= 1 && Math.abs(phone.y + 426 - mid.y) <= 1, JSON.stringify(phone && [phone.x, phone.y, phone.width, phone.height]));
  check("it is selected and the Move tool is active", (await sel()).join() === phone?.id && (await toolPressed("Move")) === "true");
  await focusCanvas();
  await press("Control+z");
  check("one undo removes it", !(await named("iPhone 16")));

  // ---------- Shortcuts do not collide ----------
  await focusCanvas();
  await press("?");
  const dlg = (await p.locator(".shortcuts-dialog").textContent()) ?? "";
  check("the shortcuts dialog lists the new commands", /Tidy up/.test(dlg) && /Paste in place/.test(dlg) && /matching layers/.test(dlg) && /K \/ I/.test(dlg) && /Pages: reorder/.test(dlg));
  await press("Escape");
  await dispatch({ op: "selectAll" });
  const rowsBefore = (await sel()).length;
  await focusCanvas();
  await press("Control+a");
  check("Ctrl+A still selects all", (await sel()).length === rowsBefore);

  check("no page errors", errors.length === 0, errors.join(" | "));
} catch (e) {
  check("script ran to the end", false, String(e?.stack ?? e));
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
