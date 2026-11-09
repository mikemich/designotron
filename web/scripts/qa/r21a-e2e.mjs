// Round 21, package r21a (prototype and vector): overlays that close with the reverse of their
// opening animation, a Close overlay On drag that follows the finger, the sticky hint with
// "Bring to front", editable svgPath vectors, W/H scaling of vector paths and the component set
// outline as editor chrome.
// Usage: serve web/dist (`vite preview --port 7601`), then `node scripts/qa/r21a-e2e.mjs`.
// Env: E2E_URL (default http://localhost:7601), CHROMIUM (executable path), SHOTS (screenshot dir;
//      deviceScaleFactor 2).
// Local servers only: every other request is aborted. A dialog fails the run.

import { chromium } from "playwright-core";
import fs from "node:fs";

const URL = process.env.E2E_URL ?? "http://localhost:7601";
const SHOTS = process.env.SHOTS ?? "";
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const launch = { headless: true, args: ["--no-sandbox"] };
if (process.env.CHROMIUM) launch.executablePath = process.env.CHROMIUM;
else if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";

let failed = 0;
function check(name, ok, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOCAL = /^(http:\/\/(localhost|127\.0\.0\.1)|data:|blob:|ws:)/;

const browser = await chromium.launch(launch);
async function openPage(opts = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, ...opts });
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
  page.on("dialog", (d) => {
    check("no dialog", false, d.message());
    d.dismiss();
  });
  return page;
}
const run = (page, cmd) => page.evaluate((c) => window.__dt.dispatch(c), cmd);
const tool = (page, name, input) => page.evaluate(([n, i]) => window.__dt.tool(n, i), [name, input]);
const docOf = (page) => page.evaluate(() => window.__dt.doc());
const byName = async (page, name, parent) => Object.values((await docOf(page)).nodes).find((n) => n.name === name && (parent === undefined || n.parent === parent));
async function newFile(page) {
  await page.goto(URL);
  await page.click("button:has-text('New design file')");
  await page.waitForSelector("#dt-canvas");
  await sleep(300);
}
const shot = async (page, name) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
};

// ---------- 1 + 2: the sheet ----------
const SHEET = [
  { type: "frame", name: "Slide 1", x: 0, y: 0, width: 390, height: 844, fill: "#FFFFFF", children: [{ type: "frame", name: "Open sheet", x: 20, y: 700, width: 350, height: 48, fill: "#0055FF", cornerRadius: 24 }] },
  {
    type: "frame",
    name: "Sheet",
    x: 1000,
    y: 0,
    width: 390,
    height: 320,
    fill: "#EEEEEE",
    cornerRadius: 16,
    children: [
      { type: "rectangle", name: "Grabber", x: 0, y: 0, width: 390, height: 80, fill: "#CCCCCC" },
      { type: "frame", name: "Close", x: 24, y: 240, width: 120, height: 48, fill: "#FF3355" },
    ],
  },
];

async function buildSheet(page, close = "drag") {
  await tool(page, "create_nodes", { nodes: SHEET });
  const d = await docOf(page);
  const by = (n, p) => Object.values(d.nodes).find((x) => x.name === n && (p === undefined || x.parent === p));
  const s1 = by("Slide 1"), sheet = by("Sheet"), open = by("Open sheet", s1.id), grab = by("Grabber", sheet.id), closeBtn = by("Close", sheet.id);
  await tool(page, "set_prototype", { nodeId: open.id, action: "open_overlay", destinationId: sheet.id, transition: "move_in", direction: "up", overlay: { position: "bottom_center", background: "#000000", backgroundOpacity: 0.4, closeOnClickOutside: true }, duration: 300 });
  if (close === "drag") await tool(page, "set_prototype", { nodeId: grab.id, action: "close_overlay", trigger: "drag" });
  await tool(page, "set_prototype", { nodeId: closeBtn.id, action: "close_overlay" });
  await run(page, { op: "setFlowStart", page: await page.evaluate(() => window.__dt.state().page), id: s1.id });
  await run(page, { op: "select", ids: [] });
  return { s1, sheet, open, grab, closeBtn };
}
async function present(page) {
  await page.click("[title^='Present (']");
  await page.waitForSelector(".presenter");
  await sleep(300);
}
const hot = (page, id) => page.locator(`.presenter [data-hotspot="${id}"]`).first();
const frameBox = (page) => page.locator(".presenter [data-overlay-frame]").first().boundingBox();
const open = async (page, ids) => {
  await hot(page, ids.open.id).click();
  await page.waitForSelector(".presenter [data-overlay]");
  await sleep(500);
};
const count = (page, sel) => page.locator(sel).count();

{
  const page = await openPage();
  await newFile(page);
  const ids = await buildSheet(page);
  await present(page);
  await open(page, ids);
  const rest = await frameBox(page);
  check("1: the sheet opened and rests at the bottom", (await count(page, ".presenter [data-overlay]")) === 1 && rest.height > 100, JSON.stringify(rest));

  const g = await hot(page, ids.grab.id).boundingBox();
  const x0 = g.x + g.width / 2, y0 = g.y + g.height / 2;
  check("1: the Grabber's touch-action is pan-x", (await hot(page, ids.grab.id).evaluate((e) => getComputedStyle(e).touchAction)) === "pan-x");

  // Hold 40 px down: the sheet follows, still open.
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(x0, y0 + 5 * i);
    await sleep(20);
  }
  await sleep(100);
  const held = await frameBox(page);
  const moved = held.y - rest.y;
  check("1: held 40 px down, the sheet follows by about 40 px", Math.abs(moved - 40) <= 3, `moved ${moved}`);
  check("1: the overlay is still open while held", (await count(page, ".presenter [data-overlay]")) === 1);
  const dim = await page.locator(".presenter [data-overlay]").evaluate((e) => getComputedStyle(e).backgroundColor);
  check("1: the dim has started to fade", /rgba\(0, 0, 0, 0\.3\d*\)|rgba\(0, 0, 0, 0\.4\d*\)/.test(dim) && dim !== "rgba(0, 0, 0, 0.4)", dim);
  await shot(page, "sheet-held-40");
  await page.mouse.up();
  await sleep(120);
  const op = await page.locator(".presenter [data-overlay]").evaluate((e) => getComputedStyle(e).opacity);
  check("1: the dim and sheet don't fade in again during the snap-back", op === "1", op);
  await sleep(500);
  const back = await frameBox(page);
  check("1: released short of half way: snaps back within 600 ms", Math.abs(back.y - rest.y) <= 1 && (await count(page, ".presenter [data-overlay]")) === 1, `y ${back.y} vs ${rest.y}`);
  const dim2 = await page.locator(".presenter [data-overlay]").evaluate((e) => getComputedStyle(e).backgroundColor);
  check("1: the dim is back", dim2 === "rgba(0, 0, 0, 0.4)", dim2);

  // 60% of the sheet's height: it closes.
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  const far = rest.height * 0.6;
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(x0, y0 + (far * i) / 12);
    await sleep(25);
  }
  await sleep(150);
  await page.mouse.up();
  let gone = false;
  for (let t = 0; t < 12 && !gone; t++) {
    await sleep(50);
    gone = (await count(page, ".presenter [data-overlay]")) === 0;
  }
  check("1: released past half way: the overlay closes", gone);
  await sleep(600);
  check("1: nothing is left leaving after 600 ms", (await count(page, ".presenter [data-overlay-leaving]")) === 0 && (await count(page, ".presenter [data-overlay-frame]")) === 0);

  // A flick of 30 px in under 80 ms closes it.
  await open(page, ids);
  const g2 = await hot(page, ids.grab.id).boundingBox();
  const fx = g2.x + g2.width / 2, fy = g2.y + g2.height / 2;
  await page.mouse.move(fx, fy);
  await page.mouse.down();
  // 36 px, fast enough for the flick speed (0.5 px/ms).
  for (let i = 1; i <= 4; i++) await page.mouse.move(fx, fy + 9 * i);
  await page.mouse.up();
  await sleep(800);
  check("1: a 30 px flick closes it", (await count(page, ".presenter [data-overlay]")) === 0 && (await count(page, ".presenter [data-overlay-frame]")) === 0);

  // ---- 2: click close, Escape ----
  await open(page, ids);
  await hot(page, ids.closeBtn.id).click();
  const leaving = await page.evaluate(() => {
    const el = document.querySelector(".presenter [data-overlay-leaving] [data-overlay-frame]");
    return { open: document.querySelectorAll(".presenter [data-overlay]").length, leaving: document.querySelectorAll(".presenter [data-overlay-leaving]").length, anim: el ? getComputedStyle(el).animationName : "" };
  });
  check("2: Close button: the overlay leaves the open list at once, a leaving copy plays dt-out-down", leaving.open === 0 && leaving.leaving === 1 && leaving.anim === "dt-out-down", JSON.stringify(leaving));
  const pe = await page.evaluate(() => getComputedStyle(document.querySelector(".presenter [data-overlay-leaving]")).pointerEvents);
  check("2: the leaving copy takes no pointer events", pe === "none", pe);
  await sleep(700);
  check("2: the leaving copy is gone after 600 ms", (await count(page, ".presenter [data-overlay-leaving]")) === 0);

  await open(page, ids);
  await page.keyboard.press("Escape");
  const esc = await page.evaluate(() => ({ open: document.querySelectorAll(".presenter [data-overlay]").length, leaving: document.querySelectorAll(".presenter [data-overlay-leaving] [data-overlay-frame]").length }));
  check("2: Escape closes the same way", esc.open === 0 && esc.leaving === 1, JSON.stringify(esc));
  await sleep(700);
  check("2: and it is gone", (await count(page, ".presenter [data-overlay-leaving]")) === 0 && (await count(page, ".presenter")) === 1);

  // Back and a restart while one is leaving.
  await open(page, ids);
  await page.keyboard.press("Escape");
  await sleep(50);
  await page.keyboard.press("r");
  await sleep(100);
  check("2: a restart clears a leaving overlay", (await count(page, ".presenter [data-overlay-leaving]")) === 0);
  await page.close();
}

// Touch swipe (CDP touch events).
{
  const page = await openPage({ hasTouch: true });
  await newFile(page);
  const ids = await buildSheet(page);
  await present(page);
  await open(page, ids);
  const cdp = await page.context().newCDPSession(page);
  const g = await hot(page, ids.grab.id).boundingBox();
  const x0 = Math.round(g.x + g.width / 2), y0 = Math.round(g.y + g.height / 2);
  const touch = (type, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x: x0, y, id: 1 }] });
  await touch("touchStart", y0);
  for (let i = 1; i <= 10; i++) {
    await touch("touchMove", y0 + 20 * i);
    await sleep(25);
  }
  await sleep(100);
  const held = (await frameBox(page)).y;
  await touch("touchEnd", y0 + 200);
  let gone = false;
  for (let t = 0; t < 14 && !gone; t++) {
    await sleep(60);
    gone = (await count(page, ".presenter [data-overlay]")) === 0;
  }
  check("1: a touch swipe down closes the sheet", gone, `held at y ${held}`);
  await page.close();
}

// Reduced motion: no leaving copy.
{
  const page = await openPage({ reducedMotion: "reduce" });
  await newFile(page);
  const ids = await buildSheet(page);
  await present(page);
  await open(page, ids);
  await hot(page, ids.closeBtn.id).click();
  await sleep(30);
  const r = await page.evaluate(() => ({ open: document.querySelectorAll(".presenter [data-overlay]").length, leaving: document.querySelectorAll(".presenter [data-overlay-leaving]").length }));
  check("2: under reduced motion the overlay closes at once with no leaving copy", r.open === 0 && r.leaving === 0, JSON.stringify(r));
  await page.close();
}

// ---------- 3: sticky ----------
{
  const page = await openPage();
  await newFile(page);
  await tool(page, "create_nodes", {
    nodes: [
      {
        type: "frame",
        name: "Feed",
        x: 0,
        y: 0,
        width: 390,
        height: 600,
        overflow: "vertical",
        fill: "#FFFFFF",
        children: [
          { type: "rectangle", name: "Header", x: 0, y: 0, width: 390, height: 60, fill: "#FF0000" },
          { type: "rectangle", name: "Post 1", x: 0, y: 60, width: 390, height: 500, fill: "#0000FF" },
          { type: "rectangle", name: "Post 2", x: 0, y: 560, width: 390, height: 500, fill: "#00AA00" },
        ],
      },
    ],
  });
  const feed = await byName(page, "Feed");
  const header = await byName(page, "Header");
  await run(page, { op: "update", ids: [header.id], patch: { scrollBehavior: "sticky" } });
  await run(page, { op: "select", ids: [header.id] });
  await page.click("[role=tab]:has-text('Prototype')");
  await sleep(200);
  const hintShown = (await count(page, "[data-sticky-hint]")) === 1;
  check("3: a sticky header that is first in order shows the hint", hintShown, hintShown ? "" : "no hint");
  // The z-order warning from update_nodes on the old order.
  await run(page, { op: "update", ids: [header.id], patch: { scrollBehavior: "scroll" } });
  const w = await tool(page, "update_nodes", { updates: [{ id: header.id, scrollBehavior: "sticky" }] });
  check("3: update_nodes on the old order warns about later layers", JSON.stringify(w).includes("later layers in 'Feed' are drawn over it"), JSON.stringify(w).slice(0, 200));
  await run(page, { op: "select", ids: [header.id] });
  await sleep(200);
  if (hintShown) {
    await shot(page, "sticky-hint");
    await page.click("[data-sticky-hint] button:has-text('Bring to front')");
    await sleep(200);
    const kids = (await byName(page, "Feed")).children;
    check("3: Bring to front makes the header the last child", kids[kids.length - 1] === header.id);
    check("3: the hint goes", (await count(page, "[data-sticky-hint]")) === 0);
    await page.keyboard.press("Control+z");
    await sleep(200);
    const kids2 = (await byName(page, "Feed")).children;
    check("3: one Ctrl+Z undoes it", kids2[0] === header.id);
    await page.click("[data-sticky-hint] button:has-text('Bring to front')");
    await sleep(200);
  }
  // In the player at scroll 400 the header, now in front, still covers the posts.
  await run(page, { op: "setFlowStart", page: await page.evaluate(() => window.__dt.state().page), id: feed.id });
  await run(page, { op: "select", ids: [] });
  await present(page);
  await page.evaluate((id) => {
    document.querySelector(`.presenter [data-scroller="${id}"]`).scrollTop = 400;
  }, feed.id);
  await sleep(400);
  const box = await page.locator(".presenter .stage").first().boundingBox();
  const scale = box.width / 390;
  const png = await page.screenshot({ clip: { x: box.x + 195 * scale, y: box.y + 30 * scale, width: 2, height: 2 } });
  const px = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    return [...g.getImageData(1, 1, 1, 1).data].slice(0, 3);
  }, png.toString("base64"));
  check("3: at scroll 400 the pixel at the header's centre is the header's red", px[0] > 200 && px[1] < 60 && px[2] < 60, JSON.stringify(px));
  await page.close();
}

// ---------- 4 + 5: svgPath and vector W/H ----------
{
  const page = await openPage();
  await newFile(page);
  const r = await tool(page, "create_nodes", { nodes: [{ type: "vector", name: "Icon", x: 200, y: 200, width: 120, height: 120, svgPath: "M2 2h20v20H2z", fill: "#111827" }] });
  const icon = await byName(page, "Icon");
  check("4: svgPath creates points, not a raw path", !!icon.vector && !icon.vector.raw && icon.vector.subpaths.length === 1, JSON.stringify(icon.vector).slice(0, 80));
  await run(page, { op: "select", ids: [icon.id] });
  await page.locator("#dt-canvas").focus().catch(() => {});
  await page.keyboard.press("Enter");
  await sleep(300);
  const ve = await page.evaluate(() => window.__dt.vectorEdit());
  const anchors = await count(page, ".vector-anchor");
  check("4: Enter opens vector edit with anchors drawn", ve.id === icon.id && anchors >= 4, `${ve.id} anchors ${anchors}`);
  // Ctrl-drag a segment: the path changes, and Ctrl+Z puts it back.
  const view = await page.evaluate(() => window.__dt.viewport());
  const cv = await page.locator("#dt-canvas").boundingBox();
  const px = (x, y) => ({ x: cv.x + view.x + x * view.zoom, y: cv.y + view.y + y * view.zoom });
  const before = JSON.stringify((await byName(page, "Icon")).vector);
  // The top edge's middle: page (200 + 12*5, 200 + 2*5).
  const m = px(260, 210);
  await page.keyboard.down("Control");
  await page.mouse.move(m.x, m.y);
  await page.mouse.down();
  await page.mouse.move(m.x, m.y - 30, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up("Control");
  await sleep(200);
  const bent = JSON.stringify((await byName(page, "Icon")).vector);
  check("4: a Ctrl-drag bends the edge", bent !== before);
  await page.keyboard.press("Control+z");
  await sleep(200);
  check("4: one Ctrl+Z puts the path back", JSON.stringify((await byName(page, "Icon")).vector) === before);
  await page.keyboard.press("Escape");

  // 5: W doubles the path (a pen path in the Design panel).
  const pen = await run(page, { op: "createVector", points: [{ x: 400, y: 400 }, { x: 450, y: 450 }, { x: 500, y: 400 }], closed: false, parent: null });
  await run(page, { op: "select", ids: [pen.id] });
  await sleep(200);
  const bbox = () => page.evaluate((id) => {
    const p = document.querySelector(`#dt-canvas [data-id="${id}"] path`);
    const b = p.getBBox();
    return { w: b.width, h: b.height };
  }, pen.id);
  const b0 = await bbox();
  const w = page.locator("input[aria-label='Width']").first();
  await w.click();
  await w.fill("200");
  await w.press("Enter");
  await sleep(300);
  const b1 = await bbox();
  const node = (await docOf(page)).nodes[pen.id];
  check("5: typing W = 2x doubles the rendered path's width", Math.abs(b1.w - b0.w * 2) <= 1 && Math.abs(b1.h - b0.h) <= 1, `${b0.w} -> ${b1.w}; node width ${node.width}`);

  // Older files: a raw vector converts on double-click, one undo puts the raw path back.
  const d = await docOf(page);
  const raw = { ...d.nodes[icon.id] };
  const cloneDoc = JSON.parse(JSON.stringify(d));
  cloneDoc.nodes[icon.id].vector = { subpaths: [], raw: { d: "M2 2h20v20H2z", viewBox: [0, 0, 24, 24], fillRule: "" } };
  await run(page, { op: "replaceDocument", doc: cloneDoc, keepComments: false });
  await sleep(300);
  await run(page, { op: "select", ids: [icon.id] });
  await sleep(200);
  const c = px(260, 260);
  await page.mouse.dblclick(c.x, c.y);
  await sleep(300);
  const after = await byName(page, "Icon");
  check("4: double-click on a raw vector enters vector edit with anchors", (await page.evaluate(() => window.__dt.vectorEdit().id)) === icon.id && (await count(page, ".vector-anchor")) >= 4 && !after.vector.raw);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+z");
  await sleep(200);
  const undone = await byName(page, "Icon");
  check("4: Ctrl+Z after Escape brings the raw path back (one undo step)", !!undone.vector.raw, JSON.stringify(undone.vector).slice(0, 80));

  // Even-odd: Enter says to Flatten.
  const eo = JSON.parse(JSON.stringify(await docOf(page)));
  eo.nodes[icon.id].vector.raw.fillRule = "evenodd";
  await run(page, { op: "replaceDocument", doc: eo, keepComments: false });
  await sleep(300);
  await run(page, { op: "select", ids: [icon.id] });
  await page.keyboard.press("Enter");
  await sleep(300);
  const toastText = await page.evaluate(() => document.body.innerText);
  check("4: Enter on an even-odd raw vector shows the Flatten message", /even-odd filling: Flatten it/.test(toastText) && !(await page.evaluate(() => window.__dt.vectorEdit().id)));
  await page.close();
}

// ---------- 6: the component set outline ----------
{
  const page = await openPage();
  await newFile(page);
  await tool(page, "create_nodes", {
    nodes: [
      { type: "frame", name: "Host", x: 0, y: 0, width: 400, height: 300, fill: "#FFFFFF", children: [
        { type: "component", name: "Size=S", x: 20, y: 20, width: 80, height: 40, fill: "#DDDDDD" },
        { type: "component", name: "Size=L", x: 20, y: 120, width: 160, height: 40, fill: "#BBBBBB" },
      ] },
    ],
  });
  const comps = Object.values((await docOf(page)).nodes).filter((n) => n.type === "component").map((n) => n.id);
  const made = await run(page, { op: "combineVariants", ids: comps });
  await sleep(300);
  const d = await docOf(page);
  const set = Object.values(d.nodes).find((n) => n.type === "componentSet");
  check("6: a new set has no stroke and no dash", set && set.strokes.length === 0 && (!set.strokeDash || set.strokeDash.length === 0), JSON.stringify([set?.strokes, set?.strokeDash]));
  check("6: the canvas draws the outline", (await count(page, "#dt-canvas .dt-set-outline")) === 1);
  await run(page, { op: "select", ids: [set.id] });
  await sleep(200);
  await shot(page, "set-chrome");
  const host = Object.values(d.nodes).find((n) => n.name === "Host");
  const react = await page.evaluate((id) => window.__dt.query({ q: "exportReact", id }), host.id);
  const html = await page.evaluate((id) => window.__dt.query({ q: "exportHtml", id }), host.id);
  check("6: React and HTML export have no dashed outline", !String(react).includes("dashed") && !String(html).includes("dashed"));
  await run(page, { op: "setFlowStart", page: await page.evaluate(() => window.__dt.state().page), id: host.id });
  await run(page, { op: "select", ids: [] });
  await present(page);
  const dashed = await page.evaluate(() => document.querySelectorAll(".presenter [stroke-dasharray], .presenter .dt-set-outline").length + [...document.querySelectorAll(".presenter *")].filter((e) => getComputedStyle(e).outlineStyle === "dashed" || getComputedStyle(e).borderTopStyle === "dashed").length);
  check("6: the presenter shows no dashed outline", dashed === 0, String(dashed));
  await page.keyboard.press("Escape");
  await sleep(200);

  // Legacy file: the exact default is removed on load, a changed stroke stays.
  const legacy = JSON.parse(JSON.stringify(await docOf(page)));
  const setNode = legacy.nodes[set.id];
  setNode.strokes = [{ type: "solid", color: "#9747FF", opacity: 1, visible: true }];
  setNode.strokeDash = [6, 4];
  const page0 = legacy.pages[0].id;
  const second = JSON.parse(JSON.stringify(setNode));
  second.id = "set_red";
  second.name = "Red set";
  second.children = [];
  second.strokes = [{ type: "solid", color: "#FF0000", opacity: 1, visible: true }];
  second.page = page0;
  second.parent = null;
  legacy.nodes.set_red = second;
  legacy.pages[0].children.push("set_red");
  await page.evaluate((json) => {
    window.__dt.engine().load(json);
  }, JSON.stringify(legacy));
  await run(page, { op: "select", ids: [] });
  await sleep(300);
  const after = await docOf(page);
  check("6: a legacy set with the default stroke loses it on load", after.nodes[set.id].strokes.length === 0 && (after.nodes[set.id].strokeDash ?? []).length === 0, JSON.stringify(after.nodes[set.id].strokes));
  check("6: a set with another colour keeps its stroke", after.nodes.set_red && after.nodes.set_red.strokes.length === 1 && after.nodes.set_red.strokes[0].color === "#FF0000");
  await page.close();
}

console.log(failed ? `\n${failed} FAILED` : "\nALL PASSED");
await browser.close();
process.exit(failed ? 1 : 0);
