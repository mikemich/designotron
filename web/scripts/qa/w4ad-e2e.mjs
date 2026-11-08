// Wave 4, package w4a-d (background blur on the canvas and in SVG/PNG export): stripes under a glass
// card on the canvas, hide / undo, content moving out from under the card, PNG and SVG export, code
// export keeping backdrop-filter, the one-top-level-layer limit, and zoom timings with and without
// the effect.
// Usage: serve web/dist (`vite preview --port 7331`), then `node scripts/qa/w4ad-e2e.mjs`.
// Env: E2E_URL (default http://localhost:7331), CHROMIUM (executable path), SHOTS (screenshot dir;
//      deviceScaleFactor 2), PERF=0 skips the timings.
// Local servers only: every other request is aborted.

import { chromium } from "playwright-core";
import fs from "node:fs";

const URL = process.env.E2E_URL ?? "http://localhost:7331";
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
async function openPage() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
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
const at = async (page, x, y) => {
  const r = await page.locator("#dt-canvas").boundingBox();
  const v = await page.evaluate(() => window.__dt.viewport());
  return { x: r.x + v.x + x * v.zoom, y: r.y + v.y + y * v.zoom };
};

// ---------- pixels ----------
async function decode(page, b64, pts, scale) {
  return page.evaluate(
    async ([b64, pts, scale]) => {
      const img = new Image();
      img.src = "data:image/png;base64," + b64;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      return pts.map(([x, y]) => g.getImageData(Math.min(img.width - 1, Math.round(x * scale)), Math.min(img.height - 1, Math.round(y * scale)), 1, 1).data[0]);
    },
    [b64, pts, scale],
  );
}
/** Red channel at points of a 400x200 frame placed at page (0, 0), as the canvas paints it at zoom 1. */
async function canvasRed(page, pts, name) {
  const p = await at(page, 0, 0);
  const shot = await page.screenshot({ clip: { x: p.x, y: p.y, width: 400, height: 200 } });
  if (SHOTS && name) fs.writeFileSync(`${SHOTS}/${name}.png`, shot);
  return decode(page, shot.toString("base64"), pts, 2);
}
/** The engine's PNG export at 1x. */
async function pngRed(page, id, pts, name) {
  const shot = await tool(page, "get_screenshot", { id, scale: 1 });
  if (SHOTS && name) fs.writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(shot.image.data, "base64"));
  return { levels: await decode(page, shot.image.data, pts, 1), width: shot.image.width ?? shot.width };
}
const row = (x0, x1, y) => Array.from({ length: x1 - x0 }, (_, i) => [x0 + i, y]);
const distinct = (a) => new Set(a).size;

// ---------- the fixture: ten 40 px stripes (black, white, ...) and a glass card over them ----------
/** A 400x200 "Glass" frame with stripes and a card (100,40, 200x120) whose white fill is 40% and background blur 20. */
async function glass(page, { top = false, blur = 20 } = {}) {
  const stripes = Array.from({ length: 10 }, (_, i) => ({ type: "rectangle", name: `Stripe ${i}`, x: i * 40, y: 0, width: 40, height: 200, fill: i % 2 ? "#FFFFFF" : "#000000" }));
  const card = { type: "rectangle", name: "Card", x: 100, y: 40, width: 200, height: 120, fill: "#FFFFFF66", effects: [{ type: "backgroundBlur", blur }] };
  const r = await tool(page, "create_nodes", { nodes: [{ type: "frame", name: "Glass", x: 0, y: 0, width: 400, height: 200, fill: "#FFFFFF", clipContent: true, children: top ? stripes : [...stripes, card] }] });
  if (top) await tool(page, "create_nodes", { nodes: [{ ...card }] });
  await page.evaluate(() => window.__dt.setViewport({ x: 300, y: 200, zoom: 1 }));
  await sleep(300);
  return r;
}
const IN_CARD = row(110, 290, 100);
const OUT_CARD = row(110, 290, 20);

const page = await openPage();
await newFile(page);

// ---------- 1. canvas ----------
await glass(page);
const card = await byName(page, "Card");
const stripe3 = await byName(page, "Stripe 3");
const stripe4 = await byName(page, "Stripe 4");
let inside = await canvasRed(page, IN_CARD, "1-canvas-blurred");
let outside = await canvasRed(page, OUT_CARD);
check("canvas: stripe edges inside the card show intermediate greys", distinct(inside) >= 5, `${distinct(inside)} levels`);
check("canvas: outside the card the edges are sharp", distinct(outside) <= 3, `${distinct(outside)} levels`);
const dom = await page.evaluate((id) => [document.querySelectorAll(`[data-id="${id}"]`).length, document.querySelectorAll(".dt-bb").length, document.querySelectorAll(".dt-bb [data-id]").length], stripe3.id);
check("DOM: one data-id per stripe, one backdrop, no hooks inside it", dom[0] === 1 && dom[1] === 1 && dom[2] === 0, JSON.stringify(dom));
const midBefore = await canvasRed(page, [[160, 100]]);
check("canvas: the card's own fill still paints over the blur", inside.every((v) => v >= 100), `min ${Math.min(...inside)}`);

// ---------- 2. hide the effect, undo ----------
await run(page, { op: "update", ids: [card.id], patch: { effects: [{ ...card.effects[0], visible: false }] } });
await sleep(250);
inside = await canvasRed(page, IN_CARD, "2-canvas-hidden");
check("hidden effect: sharp stripes under the card", distinct(inside) <= 3, `${distinct(inside)} levels`);
await run(page, { op: "undo" });
await sleep(250);
inside = await canvasRed(page, IN_CARD);
check("undo: blurred again", distinct(inside) >= 5, `${distinct(inside)} levels`);

// ---------- 3. content moving out from under the card ----------
const before = await canvasRed(page, [[165, 100], [190, 100]]);
await run(page, { op: "update", ids: [stripe4.id], patch: { visible: false } });
await sleep(250);
const after = await canvasRed(page, [[165, 100], [190, 100]]);
check("changing a stripe under the card updates the blur", before[0] !== after[0] || before[1] !== after[1], `${before} -> ${after}`);
await run(page, { op: "undo" });
await sleep(200);

// ---------- 4. exports ----------
const frame = await byName(page, "Glass");
const png = await pngRed(page, frame.id, IN_CARD, "4-png-frame");
const pngOut = await pngRed(page, frame.id, OUT_CARD);
check("PNG of the frame: blurred under the card", distinct(png.levels) >= 5, `${distinct(png.levels)} levels`);
check("PNG of the frame: sharp outside the card", distinct(pngOut.levels) <= 3, `${distinct(pngOut.levels)} levels`);
const cardPng = await pngRed(page, card.id, row(10, 190, 60), "4-png-card");
check("PNG of the card alone: no stripes", distinct(cardPng.levels) <= 2, `${distinct(cardPng.levels)} levels`);
const svgFrame = await page.evaluate((id) => window.__dt.query({ q: "exportSvg", id }), frame.id);
const svgCard = await page.evaluate((id) => window.__dt.query({ q: "exportSvg", id }), card.id);
const svgText = (v) => (typeof v === "string" ? v : (v?.svg ?? JSON.stringify(v)));
check("SVG of the frame has the blur filter, no editor hooks", /stdDeviation="10"/.test(svgText(svgFrame)) && !/data-id|dt-bb/.test(svgText(svgFrame)));
check("SVG of the card alone has no backdrop", !/feGaussianBlur/.test(svgText(svgCard)));
const code = await tool(page, "export_code", { format: "html", id: frame.id });
check("code export keeps backdrop-filter: blur(10px)", /backdrop-filter:\s*blur\(10px\)/.test(JSON.stringify(code)), JSON.stringify(code).slice(0, 120));
// The canvas and the PNG look alike (same markup): compare the blurred rows.
const maxDiff = Math.max(...inside.map((v, i) => Math.abs(v - png.levels[i])));
check("canvas and PNG export look alike across the card", maxDiff <= 12, `max channel difference ${maxDiff}`);

// ---------- 5. a top-level card over a frame: the limit ----------
await newFile(page);
await glass(page, { top: true });
inside = await canvasRed(page, IN_CARD, "5-top-level-card");
check("top-level card over another frame: no backdrop (the limit)", distinct(inside) <= 3 && (await page.evaluate(() => document.querySelectorAll(".dt-bb").length)) === 0, `${distinct(inside)} levels`);

// ---------- 6. zoom timings ----------
if (process.env.PERF !== "0") {
  await newFile(page);
  const made = await page.evaluate(() => {
    const ai = (tool, input) => window.__dt.dispatch({ op: "ai", tool, input });
    const busy = Array.from({ length: 600 }, (_, i) => ({ type: "rectangle", name: `B${i}`, x: (i % 40) * 40, y: Math.floor(i / 40) * 40, width: 36, height: 36, cornerRadius: 6, fill: `hsl(${(i * 37) % 360} 70% 55%)` }));
    const cards = Array.from({ length: 10 }, (_, i) => ({ type: "rectangle", name: `Glass ${i}`, x: 100 + (i % 5) * 300, y: 60 + Math.floor(i / 5) * 260, width: 300, height: 200, cornerRadius: 16, fill: "#FFFFFF40", effects: [{ type: "backgroundBlur", blur: 24 }] }));
    const r = ai("create_nodes", { nodes: [{ type: "frame", name: "Busy", x: 0, y: 0, width: 1600, height: 600, fill: "#222222", clipContent: true, children: [...busy, ...cards] }] });
    return r.created[0].id;
  });
  await page.evaluate(() => window.__dt.zoomToFit());
  await sleep(600);
  const glassIds = Object.values(await nodes(page)).filter((n) => n.name.startsWith("Glass ")).map((n) => n.id);
  const setBlur = (on) => run(page, { op: "update", ids: glassIds, patch: { effects: [{ type: "backgroundBlur", color: "#00000040", x: 0, y: 0, blur: 24, spread: 0, visible: on }] } });
  await page.evaluate(() => {
    window.__gaps = [];
    let last = performance.now();
    const loop = () => {
      const t = performance.now();
      window.__gaps.push(t - last);
      last = t;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  async function zoomRun() {
    await page.evaluate(() => window.__dt.zoomToFit());
    await sleep(500);
    await page.mouse.move(720, 450);
    const out = [];
    for (const dir of [-1, 1]) {
      await page.evaluate(() => (window.__gaps = []));
      await page.keyboard.down("Control");
      for (let i = 0; i < 10; i++) await page.mouse.wheel(0, dir * 60);
      await page.keyboard.up("Control");
      await sleep(900);
      out.push(await page.evaluate(() => [...window.__gaps]));
    }
    const g = out.flat().sort((a, b) => a - b);
    return { frames: g.length, p50: g[Math.floor(g.length * 0.5)], p95: g[Math.floor(g.length * 0.95)], max: g[g.length - 1] };
  }
  const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const results = { off: [], on: [] };
  for (let i = 0; i < 3; i++) {
    for (const on of [false, true]) {
      await setBlur(on);
      await sleep(500);
      results[on ? "on" : "off"].push(await zoomRun());
    }
  }
  for (const k of ["off", "on"]) console.log(`perf zoom, effects ${k}: ${results[k].map((r) => `p50 ${r.p50.toFixed(1)} p95 ${r.p95.toFixed(1)} max ${r.max.toFixed(1)} (${r.frames} frames)`).join(" | ")}`);
  // Raster cost: frame gaps hide compositor work, so also time a screenshot (which forces a full
  // paint and raster of the view) at six zoom levels with the effects off and on.
  const paintCost = async (keepZooming = false) => {
    const t = [];
    for (const z of [0.4, 0.55, 0.7, 0.9, 1.1, 1.4]) {
      await page.evaluate((z) => window.__dt.setViewport({ x: 200 * (1 - z), y: 150 * (1 - z), zoom: z }), z);
      await sleep(40);
      if (keepZooming) await page.evaluate(() => document.querySelector(".dt-content > g").classList.add("zooming"));
      else await sleep(150);
      const t0 = performance.now();
      await page.screenshot({ clip: { x: 300, y: 100, width: 600, height: 500 } });
      t.push(performance.now() - t0);
    }
    return t.reduce((a, b) => a + b, 0) / t.length;
  };
  const paint = { off: [], on: [] };
  for (let i = 0; i < 3; i++) {
    for (const on of [false, true]) {
      await setBlur(on);
      await sleep(400);
      paint[on ? "on" : "off"].push(await paintCost());
    }
  }
  const pOff = med(paint.off);
  const pOn = med(paint.on);
  console.log(`perf paint (screenshot mean over 6 zoom levels), off: ${paint.off.map((v) => v.toFixed(0)).join(" ")} ms; on: ${paint.on.map((v) => v.toFixed(0)).join(" ")} ms; median off ${pOff.toFixed(0)} on ${pOn.toFixed(0)} (${((pOn / pOff - 1) * 100).toFixed(0)}%)`);
  // Panning: the same screenshot timing at one zoom, six offsets, effects off and on.
  const panCost = async () => {
    const t = [];
    for (let i = 0; i < 6; i++) {
      await page.evaluate((i) => window.__dt.setViewport({ x: 100 - i * 37, y: 80 - i * 23, zoom: 0.7 }), i);
      await sleep(150);
      const t0 = performance.now();
      await page.screenshot({ clip: { x: 300, y: 100, width: 600, height: 500 } });
      t.push(performance.now() - t0);
    }
    return t.reduce((a, b) => a + b, 0) / t.length;
  };
  const pan = { off: [], on: [] };
  for (let i = 0; i < 3; i++) {
    for (const on of [false, true]) {
      await setBlur(on);
      await sleep(400);
      pan[on ? "on" : "off"].push(await panCost());
    }
  }
  console.log(`perf pan (screenshot mean over 6 offsets), off: ${pan.off.map((v) => v.toFixed(0)).join(" ")} ms; on: ${pan.on.map((v) => v.toFixed(0)).join(" ")} ms; median off ${med(pan.off).toFixed(0)} on ${med(pan.on).toFixed(0)} (${((med(pan.on) / med(pan.off) - 1) * 100).toFixed(0)}%)`);
  await setBlur(true);
  // The hide-while-zooming rule: the copies are display:none while the view zooms and come back.
  const bbDisplay = () => page.evaluate(() => getComputedStyle(document.querySelector(".dt-bb")).display);
  await setBlur(true);
  await page.evaluate(() => window.__dt.zoomToFit());
  await sleep(500);
  check("backdrops show while the view is still", (await bbDisplay()) !== "none");
  await page.mouse.move(720, 450);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -60);
  await page.keyboard.up("Control");
  await sleep(40);
  const during = await bbDisplay();
  await sleep(500);
  check("backdrops are hidden while zooming and back after it", during === "none" && (await bbDisplay()) !== "none", `during ${during}`);
  await page.mouse.wheel(0, 40);
  await sleep(40);
  const panning = await bbDisplay();
  await sleep(500);
  check("backdrops are hidden while panning and back after it", panning === "none" && (await bbDisplay()) !== "none", `during ${panning}`);
  // What a zoom frame costs with the rule (the class stays until the view changes): the same six views.
  const paintZoomingOff = [];
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => document.querySelector(".dt-content > g").classList.add("zooming"));
    paintZoomingOff.push(await paintCost(true));
  }
  console.log(`perf paint while zooming (copies hidden): ${paintZoomingOff.map((v) => v.toFixed(0)).join(" ")} ms; median ${med(paintZoomingOff).toFixed(0)}`);
  check("painting a zoom frame with the copies hidden is within 20% of no effects", med(paintZoomingOff) <= pOff * 1.2, `${pOff.toFixed(0)} vs ${med(paintZoomingOff).toFixed(0)} ms`);
  const p95Off = med(results.off.map((r) => r.p95));
  const p95On = med(results.on.map((r) => r.p95));
  console.log(`perf zoom median p95: off ${p95Off.toFixed(1)} ms, on ${p95On.toFixed(1)} ms (${((p95On / p95Off - 1) * 100).toFixed(0)}%)`);
  check("zoom with ten blurred cards is at most 20% slower (p95)", p95On <= p95Off * 1.2, `${p95Off.toFixed(1)} -> ${p95On.toFixed(1)} ms`);
  console.log(`paint with the effect settled is ${((pOn / pOff - 1) * 100).toFixed(0)}% slower (shown only once zooming stops)`);
}

await browser.close();
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
