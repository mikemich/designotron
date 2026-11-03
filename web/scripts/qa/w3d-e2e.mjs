// W3-D paint: angular and diamond gradients, gradient handles on the canvas, image crop,
// individual strokes, stroke join and dash fields.
// Usage: E2E_URL=http://localhost:5173 node scripts/qa/w3d-e2e.mjs (dev server running)
// Env: E2E_URL, CHROMIUM (executable path). Pixels are read from the exported SVG rasterised in the page.

import { chromium } from "playwright-core";
import fs from "node:fs";

const URL = process.env.E2E_URL ?? "http://localhost:5173";
const launch = { headless: true, args: ["--no-sandbox"] };
if (process.env.CHROMIUM) launch.executablePath = process.env.CHROMIUM;
else if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const browser = await chromium.launch(launch);
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
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

const near = (a, b, tol) => Math.abs(a - b) <= tol;
const doc = () => page.evaluate(() => window.__dt.doc());
const byName = async (name) => Object.values((await doc()).nodes).find((n) => n.name === name);
const section = (title) => page.locator(".section", { has: page.locator(".section-head", { hasText: new RegExp(`^${title}$`) }) });

/** Selects a layer and puts it at (200, 150) on the screen at 100% zoom. */
async function show(name) {
  const n = await byName(name);
  await page.evaluate(
    ({ id, x, y }) => {
      window.__dt.dispatch({ op: "select", ids: [id] });
      window.__dt.setViewport({ x: 200 - x, y: 150 - y, zoom: 1 });
    },
    { id: n.id, x: n.x, y: n.y },
  );
  await page.waitForTimeout(250);
  return n;
}

/** Screen position of a point given in a layer's unit box. */
async function screenOf(name, u, v) {
  const n = await byName(name);
  const r = await page.locator("#dt-canvas").boundingBox();
  const vp = await page.evaluate(() => window.__dt.viewport());
  return { x: r.x + vp.x + (n.x + u * n.width) * vp.zoom, y: r.y + vp.y + (n.y + v * n.height) * vp.zoom };
}

/** Exports the layer as SVG, rasterises it at 2x in the page and returns a pixel sampler. */
async function raster(name) {
  const n = await byName(name);
  return page.evaluate(async (id) => {
    const svg = window.__dt.query({ q: "exportSvg", id });
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error("svg did not load"));
      img.src = url;
    });
    const c = document.createElement("canvas");
    c.width = img.naturalWidth * 2;
    c.height = img.naturalHeight * 2;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const w = c.width;
    const h = c.height;
    const data = ctx.getImageData(0, 0, w, h).data;
    window.__px = (x, y) => Array.from(data.slice((y * w + x) * 4, (y * w + x) * 4 + 4));
    return { w, h, svg: svg.slice(0, 20000) };
  }, n.id);
}
const px = (x, y) => page.evaluate(([a, b]) => window.__px(a, b), [x, y]);
const differs = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) > 40;
const dark = (p) => p[3] > 200 && p[0] < 60 && p[1] < 60 && p[2] < 60;

/** Markup of the top-level layer a node belongs to (its defs sit beside the layer's own group). */
const rootHtml = (id) =>
  page.evaluate((i) => document.querySelector(`#dt-canvas .dt-content [data-id="${i}"]`)?.closest("[data-root]")?.outerHTML ?? "", id);

async function openPaint(title) {
  await section(title).locator(".swatch").first().click();
  await page.waitForSelector(".popover");
}

try {
  await page.goto(URL);
  await page.waitForSelector(".files", { timeout: 20000 });
  await page.click("button:has-text('New design file')");
  await page.waitForSelector("#dt-canvas");
  const picture = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 40;
    c.height = 20;
    const g = c.getContext("2d");
    g.fillStyle = "#FF0000";
    g.fillRect(0, 0, 20, 20);
    g.fillStyle = "#0000FF";
    g.fillRect(20, 0, 20, 20);
    return c.toDataURL("image/png");
  });
  await page.evaluate(() =>
    window.__dt.tool("create_nodes", {
      parentId: null,
      nodes: [
        { type: "rectangle", name: "Ang", x: 100, y: 100, width: 200, height: 200, fill: "#FF0000" },
        { type: "rectangle", name: "Lin", x: 100, y: 400, width: 200, height: 200, fill: "linear-gradient(90deg, #000000, #FFFFFF)" },
        { type: "rectangle", name: "Pic", x: 100, y: 700, width: 200, height: 100, fill: "#CCCCCC" },
        { type: "rectangle", name: "Sides", x: 100, y: 900, width: 200, height: 100, fill: "#FFFFFF", stroke: "#000000", strokeWidth: 1 },
        { type: "star", name: "Star", x: 500, y: 900, width: 120, height: 120, fill: "#FFFFFF", stroke: "#000000", strokeWidth: 6 },
      ],
    }),
  );
  await page.evaluate((src) => {
    const pic = Object.values(window.__dt.doc().nodes).find((n) => n.name === "Pic");
    window.__dt.dispatch({ op: "update", ids: [pic.id], patch: { fills: [{ type: "image", src, scaleMode: "fill", opacity: 1, visible: true }] } });
  }, picture);
  await page.waitForTimeout(300);

  // 1. Angular gradient from the fill popover: the canvas references a pattern; the export differs round the centre.
  await show("Ang");
  await openPaint("Fill");
  await page.locator(".popover .seg button", { hasText: "Angular" }).click();
  await page.waitForTimeout(150);
  let ang = await byName("Ang");
  check("1a. the fill becomes an angular gradient", ang.fills[0].type === "angularGradient", ang.fills[0].type);
  await page.evaluate((id) => {
    const n = window.__dt.doc().nodes[id];
    window.__dt.dispatch({ op: "update", ids: [id], patch: { fills: [{ ...n.fills[0], stops: [{ color: "#FF0000", position: 0 }, { color: "#0000FF", position: 1 }] }] } });
  }, ang.id);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  const html = await rootHtml(ang.id);
  check("1b. the canvas layer references a pattern", /<pattern/.test(html) && /fill="url\(#[^"]*ag\d+\)"/.test(html), html.slice(0, 120));
  const r1 = await raster("Ang");
  const top = await px(Math.round(r1.w * 0.75), 4);
  const left = await px(4, Math.round(r1.h / 2));
  check("1c. a 2x export has different colours at the top and left edge midpoints", differs(top, left), `${top} vs ${left}`);

  // 2. Linear handles: three handles, drag the end one, angle follows, one undo step.
  const lin = await show("Lin");
  await openPaint("Fill");
  await page.waitForSelector("[data-paint-handle]");
  check("2a. three handles show while the popover is open", (await page.locator("[data-paint-handle]").count()) === 3);
  const from = await screenOf("Lin", 1, 0.5);
  const to = await screenOf("Lin", 0, 1);
  const before = (await byName("Lin")).fills[0];
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 });
  await page.mouse.move(to.x, to.y, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  const after = (await byName("Lin")).fills[0];
  check(
    "2b. dragging the end handle stores new handles",
    !!after.handles && near(after.handles.end[0], 0, 0.03) && near(after.handles.end[1], 1, 0.03),
    JSON.stringify(after.handles),
  );
  check("2c. the angle follows by about 90 degrees", near(after.angle - before.angle, 90, 3), `${before.angle} -> ${after.angle}`);
  check("2d. the popover stays open during the drag", (await page.locator(".popover").count()) === 1);
  // 3. A stop marker slides along the line.
  await page.locator('.popover button[title="Add stop"]').click();
  await page.waitForTimeout(200);
  const stopsBefore = (await byName("Lin")).fills[0].stops.map((s) => s.position);
  const a = await screenOf("Lin", after.handles.start[0], after.handles.start[1]);
  const b = await screenOf("Lin", after.handles.end[0], after.handles.end[1]);
  // The new stop sits halfway; stops 0 and 2 lie under the start and end handles.
  const marker = await page.locator('[data-paint-stop="1"]').boundingBox();
  const mx = marker.x + marker.width / 2;
  const my = marker.y + marker.height / 2;
  const target = { x: a.x + (b.x - a.x) * 0.6, y: a.y + (b.y - a.y) * 0.6 };
  await page.mouse.move(mx, my);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  const moved = (await byName("Lin")).fills[0].stops.map((s) => s.position);
  check(
    "3a. dragging a stop marker changes that stop's position",
    near(moved[1], 0.6, 0.04) && moved[0] === stopsBefore[0] && moved[2] === stopsBefore[2],
    `${stopsBefore} -> ${moved}`,
  );
  // (A key pressed inside the popover never reaches its Escape handler: leave its button first.)
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  check("3b. closing the popover hides the handles", (await page.locator("[data-paint-handle]").count()) === 0);
  // Undo steps: the stop drag, adding the stop, then the handle drag (both fields together).
  await page.locator("#dt-canvas").focus();
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(200);
  }
  await page.waitForTimeout(250);
  const undone = (await byName("Lin")).fills[0];
  check("2e. undo restores the handles and the angle in one step", !undone.handles && undone.angle === before.angle, JSON.stringify({ h: undone.handles, a: undone.angle }));

  // 4. Image crop.
  await show("Pic");
  await openPaint("Fill");
  await page.locator('.popover select[aria-label="Image scale mode"]').selectOption("crop");
  await page.waitForSelector("[data-crop-body]");
  await page.waitForFunction(() => Object.values(window.__dt.doc().nodes).find((n) => n.name === "Pic")?.fills[0]?.crop);
  const pic0 = await byName("Pic");
  const c0 = pic0.fills[0].crop;
  check("4a. choosing Crop starts from the rectangle Fill showed", near(c0.x, 0, 0.01) && near(c0.w, 1, 0.01), JSON.stringify(c0));
  const p1 = await screenOf("Pic", 0.5, 0.5);
  await page.mouse.move(p1.x, p1.y);
  await page.mouse.down();
  await page.mouse.move(p1.x + 20, p1.y, { steps: 4 });
  await page.mouse.move(p1.x + 40, p1.y, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  const pic1 = await byName("Pic");
  check(
    "4b. dragging inside moves the image by 40 px; the layer keeps its size",
    near(pic1.fills[0].crop.x - c0.x, 0.2, 0.01) && pic1.width === 200 && pic1.height === 100,
    `${pic1.fills[0].crop.x} ${pic1.width}x${pic1.height}`,
  );
  await page.keyboard.press("Enter");
  await page.waitForTimeout(250);
  check("4c. Enter leaves crop mode", (await page.locator("[data-crop-body]").count()) === 0 && (await page.locator(".popover").count()) === 0);
  const r4 = await raster("Pic");
  const empty = await px(10, 100);
  const red = await px(2 * 60, 100);
  const blue = await px(2 * 170, 100);
  check("4d. the export shows the shifted image", empty[3] < 40 && red[0] > 200 && red[2] < 60 && blue[2] > 200 && blue[0] < 60, `${empty} ${red} ${blue} (${r4.w}x${r4.h})`);

  // 5. Individual strokes.
  await show("Sides");
  const strokeSec = section("Stroke");
  await strokeSec.locator("button", { hasText: "Individual" }).click();
  await page.waitForSelector('input[aria-label="Top stroke weight"]');
  for (const [side, v] of [["Right", "0"], ["Bottom", "0"], ["Left", "0"], ["Top", "4"]]) {
    const inp = page.locator(`input[aria-label="${side} stroke weight"]`);
    await inp.fill(v);
    await inp.press("Enter");
    await page.waitForTimeout(80);
  }
  const sides = await byName("Sides");
  check("5a. the four weights are stored", JSON.stringify(sides.strokeWeights) === "[4,0,0,0]", JSON.stringify(sides.strokeWeights));
  const r5 = await raster("Sides");
  const topBand = await px(r5.w / 2, 3);
  const below = await px(r5.w / 2, 12);
  const leftEdge = await px(1, r5.h / 2);
  const bottomEdge = await px(r5.w / 2, r5.h - 2);
  check("5b. the export has a 4 px band at the top only", dark(topBand) && !dark(below) && !dark(leftEdge) && !dark(bottomEdge), `${topBand} ${below} ${leftEdge} ${bottomEdge}`);
  let rows = 0;
  for (let y = 0; y < 40; y++) if (dark(await px(r5.w / 2, y))) rows++;
  check("5c. the band is 8 device pixels (4 px at 2x)", rows === 8, `${rows}`);
  await page.locator(".tabs button, [role=tab]", { hasText: /^Code$/ }).first().click();
  await page.waitForSelector(".code-block");
  const code = await page.locator(".code-block").innerText();
  check("5d. the React code has border-t-", /border-t-\[4px\]/.test(code) && /border-r-0/.test(code), code.slice(0, 200).replace(/\n/g, " "));
  await page.locator(".tabs button, [role=tab]", { hasText: /^Design$/ }).first().click();

  // 6. Join and dash.
  await show("Star");
  await page.locator('select[aria-label="Stroke join"]').selectOption("bevel");
  await page.waitForTimeout(250);
  const star = await byName("Star");
  const starHtml = await page.evaluate((id) => document.querySelector(`#dt-canvas .dt-content [data-id="${id}"]`)?.outerHTML ?? "", star.id);
  check("6a. Bevel join renders stroke-linejoin=bevel", star.strokeJoin === "bevel" && /stroke-linejoin="bevel"/.test(starHtml));
  await page.locator('select[aria-label="Stroke style"]').selectOption("dashed");
  for (const [label, v] of [["Dash length", "10"], ["Gap length", "5"]]) {
    const inp = page.locator(`input[aria-label="${label}"]`);
    await inp.fill(v);
    await inp.press("Enter");
    await page.waitForTimeout(80);
  }
  await page.waitForTimeout(250);
  const starHtml2 = await page.evaluate((id) => document.querySelector(`#dt-canvas .dt-content [data-id="${id}"]`)?.outerHTML ?? "", star.id);
  check("6b. dash 10 and gap 5 render stroke-dasharray 10 5", /stroke-dasharray="10 5"/.test(starHtml2), starHtml2.match(/stroke-dasharray="[^"]*"/)?.[0]);

  // 7. Diamond gradient: four quadrant gradients on the canvas.
  await show("Ang");
  await openPaint("Fill");
  await page.locator(".popover .seg button", { hasText: "Diamond" }).click();
  await page.waitForTimeout(200);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  const diamond = await rootHtml(ang.id);
  check("7. a diamond gradient renders four quadrant gradients", (diamond.match(/<linearGradient/g) ?? []).length === 4, `${(diamond.match(/<linearGradient/g) ?? []).length}`);

  check("no page errors", errors.length === 0, errors.join(" | "));
} catch (e) {
  check("script ran to the end", false, String(e).split("\n").slice(0, 3).join(" "));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
