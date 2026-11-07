// Round 17, package r17c (images and effects): tile scale by the image's own size, 90 degree image
// rotation, the seven adjustments (canvas, PNG, SVG and exported HTML agree), interpolated gradient
// stops, create_nodes effects / blendMode / scaleMode, Images in Assets, native drop size and the
// effect row.
// Usage: serve web/dist (`vite preview --port 6921`), then `node scripts/qa/r17c-e2e.mjs`.
// Env: E2E_URL (default http://localhost:6921), E2E_EXPORT_PORT (exported HTML, default 6922),
//      CHROMIUM (executable path), SHOTS (screenshot dir; deviceScaleFactor 2).
// Local servers only: every other request is aborted. Test images are drawn in the page.

import { chromium } from "playwright-core";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const URL = process.env.E2E_URL ?? "http://localhost:6921";
const EXPORT_PORT = Number(process.env.E2E_EXPORT_PORT ?? 6922);
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

// The exported code is served from a scratch folder on its own port.
const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), "r17c-export-"));
const server = http.createServer((req, res) => {
  const file = path.join(exportDir, req.url.split("?")[0] === "/" ? "index.html" : req.url.split("?")[0]);
  if (!file.startsWith(exportDir) || !fs.existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": "text/html" }).end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(EXPORT_PORT, "127.0.0.1", r));

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

// ---------- test images, drawn in the page ----------
const IMAGES = {
  // 40x20, four flat quarters (20x10 each): red, green / blue, yellow.
  checker: { w: 40, h: 20, draw: (g) => [["#ff0000", 0, 0], ["#00ff00", 20, 0], ["#0000ff", 0, 10], ["#ffff00", 20, 10]].forEach(([c, x, y]) => ((g.fillStyle = c), g.fillRect(x, y, 20, 10))) },
  // 60x40, blue with a red band along the top (20%).
  edge: { w: 60, h: 40, draw: (g) => ((g.fillStyle = "#0000ff"), g.fillRect(0, 0, 60, 40), (g.fillStyle = "#ff0000"), g.fillRect(0, 0, 60, 8)) },
  // 40x40, one flat brown.
  flat: { w: 40, h: 40, draw: (g) => ((g.fillStyle = "rgb(180,90,60)"), g.fillRect(0, 0, 40, 40)) },
};
async function makeImage(page, kind, size) {
  const spec = IMAGES[kind];
  return page.evaluate(
    ([w, h, src, big]) => {
      const draw = new Function("g", `return (${src})(g)`);
      const c = document.createElement("canvas");
      c.width = big ? big[0] : w;
      c.height = big ? big[1] : h;
      const g = c.getContext("2d");
      if (big) {
        g.fillStyle = "#336699";
        g.fillRect(0, 0, c.width, c.height);
        g.fillStyle = "#ffcc00";
        g.fillRect(0, 0, 50, 50);
      } else draw(g);
      return c.toDataURL("image/png").split(",")[1];
    },
    [spec?.w ?? 0, spec?.h ?? 0, spec ? spec.draw.toString() : "() => {}", size ?? null],
  );
}
async function dropImage(page, b64, name, p) {
  await page.evaluate(
    async ([b64, name, x, y]) => {
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bin], name, { type: "image/png" }));
      document.getElementById("dt-canvas").dispatchEvent(new DragEvent("drop", { dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true }));
    },
    [b64, name, p.x, p.y],
  );
  for (let i = 0; i < 60; i++) {
    const n = await byName(page, name);
    if (n) return n;
    await sleep(100);
  }
  return null;
}
/** A 400x200 layer at the page origin with an image fill (`fill` fields merged in), the view at zoom 1. */
async function imageLayer(page, kind, name, fill) {
  const b64 = await makeImage(page, kind);
  const n = await dropImage(page, b64, name, await at(page, 600, 500));
  await run(page, { op: "update", ids: [n.id], patch: { x: 0, y: 0, width: 400, height: 200, fills: [{ ...n.fills[0], ...fill }] } });
  await run(page, { op: "select", ids: [] });
  await page.evaluate(() => window.__dt.setViewport({ zoom: 1, x: 100, y: 100 }));
  await page.mouse.move(5, 5);
  await sleep(500);
  return { id: n.id, src: n.fills[0].src, data: "data:image/png;base64," + b64, b64 };
}

// ---------- pixels ----------
async function sample(page, pngB64, pts, scale) {
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
      return pts.map(([x, y]) => Array.from(g.getImageData(Math.min(img.width - 1, Math.round(x * scale)), Math.min(img.height - 1, Math.round(y * scale)), 1, 1).data));
    },
    [pngB64, pts, scale],
  );
}
/** The layer as the canvas paints it (screenshot at deviceScaleFactor 2). */
async function canvasPixels(page, pts, w = 400, h = 200) {
  const p = await at(page, 0, 0);
  const shot = await page.screenshot({ clip: { x: p.x, y: p.y, width: w, height: h } });
  return sample(page, shot.toString("base64"), pts, 2);
}
/** The engine's PNG export at 1x. */
async function pngPixels(page, id, pts) {
  const shot = await tool(page, "get_screenshot", { id, scale: 1 });
  return sample(page, shot.image.data, pts, 1);
}
/** The exported SVG drawn by the browser at 1x. */
async function svgPixels(page, id, assets, pts) {
  const b64 = await page.evaluate(
    async ([id, assets]) => {
      let svg = window.__dt.query({ q: "exportSvg", id });
      svg = svg.replace(/asset:([a-z0-9_]+)/g, (m, a) => assets[a] ?? m);
      const w = Number(svg.match(/width="([\d.]+)"/)[1]);
      const h = Number(svg.match(/height="([\d.]+)"/)[1]);
      const img = new Image();
      img.src = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
      await img.decode();
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      c.getContext("2d").drawImage(img, 0, 0, w, h);
      return c.toDataURL("image/png").split(",")[1];
    },
    [id, assets],
  );
  return sample(page, b64, pts, 1);
}
/** The exported HTML (`export_code`) served on the export port and screenshot at 1x. */
async function htmlPixels(page, id, assets, pts, w = 400, h = 200) {
  const out = await tool(page, "export_code", { format: "html", id });
  let code = out.result.code;
  code = code.replace(/asset:([a-z0-9_]+)/g, (m, a) => assets[a] ?? m);
  fs.writeFileSync(path.join(exportDir, "index.html"), code);
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await ctx.route("**/*", (r) => (LOCAL.test(r.request().url()) ? r.continue() : r.abort()));
  const p = await ctx.newPage();
  await p.goto(`http://127.0.0.1:${EXPORT_PORT}/index.html`);
  await sleep(300);
  const shot = await p.screenshot({ clip: { x: 0, y: 0, width: w, height: h } });
  if (SHOTS && process.env.KEEP_HTML) fs.writeFileSync(path.join(SHOTS, process.env.KEEP_HTML), shot);
  await ctx.close();
  return { px: await sample(page, shot.toString("base64"), pts, 1), code };
}
const near = (a, b, tol) => a.length >= 3 && b.length >= 3 && [0, 1, 2].every((i) => Math.abs(a[i] - b[i]) <= tol);
const maxDiff = (a, b) => Math.max(...[0, 1, 2].map((i) => Math.abs(a[i] - b[i])));
const fmt = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
/** Asserts every sample of `a` is within `tol` of the same sample of `b`. */
function same(name, a, b, tol) {
  const worst = Math.max(...a.map((c, i) => maxDiff(c, b[i])));
  check(name, worst <= tol, `worst diff ${worst} (limit ${tol})`);
}
const shot = async (page, file) => {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, file) });
};

try {
  const page = await openPage();
  await newFile(page);

  // ===== D-02: tile scale by the image's own size =====
  {
    const L = await imageLayer(page, "checker", "tile100", { scaleMode: "tile" });
    const assets = { [L.src.slice(6)]: L.data };
    // Cell centres of the 40x20 image: R, G / B, Y; and the same colours one cell over.
    const pts = [[10, 5], [30, 5], [10, 15], [30, 15], [50, 5], [70, 5], [10, 25], [110, 55], [390, 195]];
    const expect100 = ["#ff0000", "#00ff00", "#0000ff", "#ffff00", "#ff0000", "#00ff00", "#ff0000", "#ffff00", null];
    const hex = (c) => "#" + c.slice(0, 3).map((v) => v.toString(16).padStart(2, "0")).join("");
    const canvas = await canvasPixels(page, pts);
    check("tile 100%: the canvas repeats the 40x20 image every 40 and 20 px", expect100.every((e, i) => e === null || hex(canvas[i]) === e), canvas.map(hex).join(" "));
    const png = await pngPixels(page, L.id, pts);
    check("tile 100%: the PNG export repeats every 40/20 px", expect100.every((e, i) => e === null || hex(png[i]) === e), png.map(hex).join(" "));
    const svg = await svgPixels(page, L.id, assets, pts);
    same("tile 100%: canvas, PNG and SVG agree", canvas, png, 1);
    same("tile 100%: SVG matches the PNG", svg, png, 1);
    const html = await htmlPixels(page, L.id, assets, pts);
    check("tile 100%: exported HTML uses background-size 40px 20px", /background-size: 40px 20px/.test(html.code) && /background-repeat: repeat/.test(html.code));
    same("tile 100%: exported HTML matches the PNG", html.px, png, 3);

    // 50%: the cell is 20x10.
    await run(page, { op: "update", ids: [L.id], patch: { fills: [{ type: "image", src: L.src, scaleMode: "tile", opacity: 1, visible: true, scalingFactor: 0.5 }] } });
    await sleep(500);
    const pts50 = [[5, 2], [15, 2], [5, 7], [15, 7], [25, 2], [35, 2], [5, 12], [55, 27]];
    const exp50 = ["#ff0000", "#00ff00", "#0000ff", "#ffff00", "#ff0000", "#00ff00", "#ff0000", "#ffff00"];
    const c50 = await canvasPixels(page, pts50);
    const p50 = await pngPixels(page, L.id, pts50);
    const s50 = await svgPixels(page, L.id, assets, pts50);
    check("tile 50%: the canvas repeats every 20 and 10 px", exp50.every((e, i) => hex(c50[i]) === e), c50.map(hex).join(" "));
    check("tile 50%: the PNG export repeats every 20 and 10 px", exp50.every((e, i) => hex(p50[i]) === e), p50.map(hex).join(" "));
    same("tile 50%: canvas, PNG and SVG agree", c50, p50, 1);
    same("tile 50%: SVG matches the PNG", s50, p50, 1);
    const h50 = await htmlPixels(page, L.id, assets, pts50);
    check("tile 50%: exported HTML uses background-size 20px 10px", /background-size: 20px 10px/.test(h50.code));
    same("tile 50%: exported HTML matches the PNG", h50.px, p50, 3);
    await run(page, { op: "delete", ids: [L.id] });
  }

  // ===== Rotation =====
  {
    const L = await imageLayer(page, "edge", "turned", { scaleMode: "stretch", rotation: 90 });
    const assets = { [L.src.slice(6)]: L.data };
    // Unrotated, the top 20% (40 px) is red. Turned 90 degrees clockwise: the right 20% (80 px).
    const pts = [[380, 100], [330, 20], [300, 20], [20, 100], [200, 190]];
    const want = ["red", "red", "blue", "blue", "blue"];
    const cls = (c) => (c[0] > 200 && c[2] < 60 ? "red" : c[2] > 200 && c[0] < 60 ? "blue" : fmt(c));
    const canvas = await canvasPixels(page, pts);
    const png = await pngPixels(page, L.id, pts);
    const svg = await svgPixels(page, L.id, assets, pts);
    check("rotation 90: the canvas has the red edge on the right", canvas.map(cls).join() === want.join(), canvas.map(cls).join());
    check("rotation 90: the PNG export has the red edge on the right", png.map(cls).join() === want.join(), png.map(cls).join());
    check("rotation 90: the SVG export has the red edge on the right", svg.map(cls).join() === want.join(), svg.map(cls).join());
    same("rotation 90: canvas and PNG agree", canvas, png, 2);
    const html = await htmlPixels(page, L.id, assets, pts);
    check("rotation 90: exported HTML has the red edge on the right", html.px.map(cls).join() === want.join(), html.px.map(cls).join());
    check("rotation 90: the export turns an inner layer with the box swapped", /width: 100cqh; height: 100cqw/.test(html.code) && /rotate\(90deg\)/.test(html.code));
    same("rotation 90: exported HTML matches the PNG", html.px, png, 8);
    // 180 and 270: red at the bottom / on the left.
    for (const [deg, spot, away] of [[180, [200, 190], [200, 10]], [270, [20, 100], [380, 100]]]) {
      await run(page, { op: "update", ids: [L.id], patch: { fills: [{ type: "image", src: L.src, scaleMode: "stretch", opacity: 1, visible: true, rotation: deg }] } });
      await sleep(400);
      const [a, b] = await pngPixels(page, L.id, [spot, away]);
      const [ch, hh] = (await htmlPixels(page, L.id, assets, [spot, away])).px;
      check(`rotation ${deg}: red where expected in the PNG and the exported HTML`, cls(a) === "red" && cls(b) === "blue" && cls(ch) === "red" && cls(hh) === "blue", `${cls(a)}/${cls(b)} ${cls(ch)}/${cls(hh)}`);
    }
    await run(page, { op: "delete", ids: [L.id] });
  }

  // ===== Exported fills follow the layer's size (a Fill-width hero shown narrower than the design) =====
  {
    const L = await imageLayer(page, "edge", "heroimg", { scaleMode: "stretch" });
    const assets = { [L.src.slice(6)]: L.data };
    await run(page, { op: "delete", ids: [L.id] });
    const made = await tool(page, "create_nodes", {
      nodes: [{ type: "frame", name: "Hero", x: 0, y: 0, width: 400, height: 200, layout: { direction: "vertical" }, children: [{ type: "rectangle", name: "HeroPic", width: "fill", height: 200, imageUrl: L.src, imageScaleMode: "stretch", imageRotation: 90, imageFilters: { contrast: 0.1 } }] }],
    });
    const heroId = made.result.created[0].id;
    await sleep(300);
    // The page is 300 px wide, the design 400: the turned image still covers its box, and the red band
    // (the image's top 20%, now the right 20%) is the right 60 px, not a 400 px layout squeezed in.
    const pts = [[290, 100], [255, 100], [200, 100], [30, 100], [150, 190]];
    const cls = (c) => (c[0] > 200 && c[2] < 60 ? "red" : c[2] > 150 && c[0] < 60 ? "blue" : fmt(c));
    const html = await htmlPixels(page, heroId, assets, pts, 300, 200);
    check("a turned, adjusted fill follows a narrower page: red on the right 20%", html.px.map(cls).join() === "red,red,blue,blue,blue", html.px.map(fmt).join(" "));
    check("the exported fill layers use no pixel sizes", !/width: 400px; height: 200px[^"]*background-image/.test(html.code) && /100cqh/.test(html.code), "");
    await run(page, { op: "delete", ids: [heroId] });
  }

  // ===== Adjustments =====
  {
    const L = await imageLayer(page, "flat", "adjust", { scaleMode: "stretch" });
    const assets = { [L.src.slice(6)]: L.data };
    const pts = [[100, 100], [300, 50]];
    const base = (await pngPixels(page, L.id, pts))[0];
    check("adjustments: the unadjusted layer is the source colour", near(base, [180, 90, 60], 1), fmt(base));
    const set = async (filters) => {
      await run(page, { op: "update", ids: [L.id], patch: { fills: [{ type: "image", src: L.src, scaleMode: "stretch", opacity: 1, visible: true, filters }] } });
      await sleep(500);
    };
    await set({ saturation: -1 });
    let canvas = await canvasPixels(page, pts);
    let png = await pngPixels(page, L.id, pts);
    let svg = await svgPixels(page, L.id, assets, pts);
    let html = await htmlPixels(page, L.id, assets, pts);
    const grey = (c) => Math.abs(c[0] - c[1]) <= 2 && Math.abs(c[1] - c[2]) <= 2;
    check("saturation -100 is grey on the canvas, in PNG, SVG and exported HTML", [canvas[0], png[0], svg[0], html.px[0]].every(grey), [canvas[0], png[0], svg[0], html.px[0]].map(fmt).join(" "));
    same("saturation -100: canvas = PNG within one level", canvas, png, 1);
    same("saturation -100: SVG = PNG within one level", svg, png, 1);
    same("saturation -100: exported HTML within 3 levels", html.px, png, 3);
    check("saturation -100: the export carries the filter", /<filter id="dt-img-[0-9a-f]{8}"/.test(html.code) && /filter: url\(#dt-img-/.test(html.code));

    await set({ exposure: 1 });
    canvas = await canvasPixels(page, pts);
    png = await pngPixels(page, L.id, pts);
    svg = await svgPixels(page, L.id, assets, pts);
    html = await htmlPixels(page, L.id, assets, pts);
    const sum = (c) => c[0] + c[1] + c[2];
    check("exposure +100 is brighter than the source everywhere", [canvas[0], png[0], svg[0], html.px[0]].every((c) => sum(c) > sum(base) + 100), [canvas[0], png[0], svg[0], html.px[0]].map(fmt).join(" "));
    same("exposure +100: canvas = PNG within one level", canvas, png, 1);
    same("exposure +100: SVG = PNG within one level", svg, png, 1);
    same("exposure +100: exported HTML within 3 levels", html.px, png, 3);

    // All seven together, and a rotated, adjusted tile.
    await set({ exposure: 0.3, contrast: 0.4, saturation: 0.5, temperature: 0.6, tint: -0.4, highlights: -0.5, shadows: 0.7 });
    canvas = await canvasPixels(page, pts);
    png = await pngPixels(page, L.id, pts);
    svg = await svgPixels(page, L.id, assets, pts);
    html = await htmlPixels(page, L.id, assets, pts);
    same("all seven adjustments: canvas = PNG within one level", canvas, png, 1);
    same("all seven adjustments: SVG = PNG within one level", svg, png, 1);
    same("all seven adjustments: exported HTML within 3 levels", html.px, png, 3);
    check("all seven adjustments change the colour", maxDiff(png[0], base) > 10, `${fmt(base)} -> ${fmt(png[0])}`);
    await run(page, { op: "delete", ids: [L.id] });

    const T = await imageLayer(page, "checker", "tilefx", { scaleMode: "tile", scalingFactor: 0.5, rotation: 90, filters: { saturation: -1 } });
    const tAssets = { [T.src.slice(6)]: T.data };
    const tp = [[5, 5], [15, 5], [100, 100], [300, 150]];
    const tc = await canvasPixels(page, tp);
    const tpng = await pngPixels(page, T.id, tp);
    const thtml = await htmlPixels(page, T.id, tAssets, tp);
    check("rotated, adjusted tile is grey in the PNG", tpng.every(grey), tpng.map(fmt).join(" "));
    same("rotated, adjusted tile: canvas = PNG", tc, tpng, 1);
    // The turned tile grid in code: the same cell colours at sampled points (edges excluded: a few px of slack).
    const tileMatches = tp.filter((_, i) => maxDiff(thtml.px[i], tpng[i]) <= 3).length;
    check("rotated tile: exported HTML matches the PNG at the sample points", tileMatches === tp.length, `${tileMatches}/${tp.length}`);
    await run(page, { op: "delete", ids: [T.id] });
  }

  // ===== D-03: gradient stops =====
  {
    const r = await run(page, { op: "createShape", kind: "rectangle", x: 0, y: 0, width: 200, height: 100, parent: null });
    await run(page, { op: "update", ids: [r.id], patch: { name: "Grad", fills: [{ type: "linearGradient", angle: 90, stops: [{ color: "#000000", position: 0 }, { color: "#FFFFFF", position: 1 }], opacity: 1, visible: true }] } });
    await run(page, { op: "select", ids: [r.id] });
    await sleep(300);
    await page.locator(".swatch").first().click();
    await page.waitForSelector("button[title='Add stop']");
    await page.click("button[title='Add stop']");
    await sleep(300);
    let g = (await byName(page, "Grad")).fills[0];
    const mid = g.stops.find((s) => Math.abs(s.position - 0.5) < 1e-6);
    const chan = mid ? parseInt(mid.color.slice(1, 3), 16) : -1;
    check("Add stop puts a stop at 50% coloured about #808080", g.stops.length === 3 && !!mid && Math.abs(chan - 128) <= 1 && mid.color.slice(1, 3) === mid.color.slice(3, 5), JSON.stringify(g.stops));
    check("the new stop is the selected one (Position 50)", (await page.locator("input[aria-label='Pos']").inputValue()).startsWith("50"), await page.locator("input[aria-label='Pos']").inputValue());
    check("the selected stop's dot is outlined", (await page.locator(".picker-bar .dot").nth(1).evaluate((e) => e.style.outline)).includes("solid"));
    await page.click("button[title='Add stop']");
    await sleep(300);
    g = (await byName(page, "Grad")).fills[0];
    const positions = g.stops.map((s) => s.position);
    check("a second Add stop splits a widest gap: 25% or 75%", g.stops.length === 4 && (positions.includes(0.25) || positions.includes(0.75)), positions.join());
    const sel = Number(await page.locator("input[aria-label='Pos']").inputValue().then((v) => parseFloat(v)));
    check("the second new stop is selected too", sel === 25 || sel === 75, String(sel));
    // A click on the bar adds a stop at the click position.
    const bar = await page.locator("[data-gradient-bar]").boundingBox();
    await page.mouse.click(bar.x + bar.width * 0.9, bar.y + 3);
    await sleep(300);
    g = (await byName(page, "Grad")).fills[0];
    const added = g.stops.filter((s) => Math.abs(s.position - 0.9) < 0.02);
    check("a click on the gradient bar adds a stop there, coloured by the gradient", g.stops.length === 5 && added.length === 1 && parseInt(added[0].color.slice(1, 3), 16) > 200, JSON.stringify(g.stops.map((s) => [s.position, s.color])));
    await shot(page, "r17c-gradient-stops-dark.png");
    await page.keyboard.press("Escape");
    await run(page, { op: "delete", ids: [r.id] });
  }

  // ===== D-04: create_nodes keys =====
  {
    const made = await tool(page, "create_nodes", {
      nodes: [
        {
          type: "rectangle",
          name: "FxCard",
          x: 600,
          y: 0,
          width: 200,
          height: 120,
          fill: "#3366FF",
          blendMode: "multiply",
          effects: [{ type: "dropShadow", x: 0, y: 8, blur: 24, spread: 0, color: "#00000040" }, { type: "layerBlur", blur: 2 }],
        },
        { type: "rectangle", name: "FxPhoto", x: 900, y: 0, width: 200, height: 120, imageUrl: "asset:none", imageScaleMode: "fit", imageScale: 0.5, imageRotation: 90, imageFilters: { saturation: -0.5 } },
      ],
    });
    check("create_nodes with effects, blendMode and imageScaleMode: no warnings", !(made.result?.warnings?.length), JSON.stringify(made).slice(0, 300));
    const card = await byName(page, "FxCard");
    check("effects land in the model", card?.effects?.length === 2 && card.effects[0].y === 8 && card.effects[0].blur === 24 && card.effects[1].type === "layerBlur", JSON.stringify(card?.effects));
    check("blendMode lands", card?.blendMode === "multiply", String(card?.blendMode));
    const photo = await byName(page, "FxPhoto");
    const f = photo?.fills?.[0];
    check("image keys land (scaleMode fit, scale 0.5, rotation 90, filters)", f?.scaleMode === "fit" && f.scalingFactor === 0.5 && f.rotation === 90 && f.filters?.saturation === -0.5, JSON.stringify(f));
    const bad = await tool(page, "create_nodes", { nodes: [{ type: "rectangle", effects: [{ type: "dropShadow" }], shadow: { y: 2 } }] });
    check("effects together with shadow is an error", bad.ok === false && /not both/.test(JSON.stringify(bad)), JSON.stringify(bad).slice(0, 200));
    const bad2 = await tool(page, "create_nodes", { nodes: [{ type: "rectangle", blendMode: "multipy" }] });
    check("a wrong blendMode is an error naming the field", bad2.ok === false && /blendMode/.test(JSON.stringify(bad2)), JSON.stringify(bad2).slice(0, 200));
    await run(page, { op: "delete", ids: [card.id, photo.id] });
  }

  // ===== Drop size =====
  {
    await page.evaluate(() => window.__dt.setViewport({ zoom: 0.1, x: 100, y: 100 }));
    const big = await makeImage(page, null, [4000, 3000]);
    const a = await dropImage(page, big, "drop4000", await at(page, 6000, 4000));
    check("a 4000x3000 drop keeps its size", a && a.width === 4000 && a.height === 3000, a ? `${a.width}x${a.height}` : "none");
    const wide = await makeImage(page, null, [5000, 1000]);
    const b = await dropImage(page, wide, "drop5000", await at(page, 6000, 6000));
    check("a 5000x1000 drop becomes 4096x819", b && b.width === 4096 && b.height === 819, b ? `${b.width}x${b.height}` : "none");
    const small = await makeImage(page, "checker");
    const c = await dropImage(page, small, "drop40", await at(page, 2000, 2000));
    check("a small image keeps its native size", c && c.width === 40 && c.height === 20, c ? `${c.width}x${c.height}` : "none");
    await run(page, { op: "delete", ids: [a.id, b.id, c.id] });
    await page.evaluate(() => window.__dt.setViewport({ zoom: 1, x: 100, y: 100 }));
  }

  // ===== Images in Assets =====
  {
    const b64 = await makeImage(page, "checker");
    const one = await dropImage(page, b64, "AssetOne", await at(page, 300, 300));
    const src = one.fills[0].src;
    const two = await run(page, { op: "createImage", src, x: 500, y: 300, width: 120, height: 60, name: "AssetTwo", parent: null });
    await run(page, { op: "select", ids: [] });
    await page.click("[role=tab]:has-text('Assets'), button:has-text('Assets')");
    await page.waitForSelector("[data-testid='image-assets']");
    await sleep(700);
    const rows = page.locator(`.image-asset[data-image-src='${src}']`);
    check("two layers sharing an asset are one row", (await rows.count()) === 1);
    check("the row says 2 layers", (await rows.first().getAttribute("data-count")) === "2", await rows.first().innerText());
    await shot(page, "r17c-assets-dark.png");
    await rows.first().click();
    await sleep(200);
    const sel = await page.evaluate(() => window.__dt.state().selection);
    check("a click on the row selects both layers", sel.length === 2 && sel.includes(one.id) && sel.includes(two.id), JSON.stringify(sel));
    await rows.first().locator("button[title^='Place']").click();
    await sleep(700);
    const placed = Object.values(await nodes(page)).filter((n) => n.fills?.[0]?.src === src && n.id !== one.id && n.id !== two.id);
    check("Place adds a layer at the image's own size", placed.length === 1 && placed[0].width === 40 && placed[0].height === 20, placed.map((p) => `${p.width}x${p.height}`).join());
    await sleep(500);
    check("the count follows the document (3 layers)", (await rows.first().getAttribute("data-count")) === "3");
    // The Assets search filters by layer name.
    await page.fill("input[placeholder='Search assets']", "nomatch");
    await sleep(300);
    check("the Assets search filters images by layer name", (await page.locator(".image-asset").count()) === 0);
    await page.fill("input[placeholder='Search assets']", "assettwo");
    await sleep(300);
    check("…and keeps the rows that match", (await page.locator(".image-asset").count()) === 1);
    await page.fill("input[placeholder='Search assets']", "");
    // Another page: a click goes to the page that has the image.
    await run(page, { op: "addPage", name: "Other" });
    await sleep(500);
    await page.locator(`.image-asset[data-image-src='${src}']`).first().click();
    await sleep(300);
    const st = await page.evaluate(() => window.__dt.state());
    const doc = await page.evaluate(() => window.__dt.doc());
    check("a click switches to the page that uses the image", doc.pages.find((p) => p.id === st.page)?.name !== "Other" && st.selection.length === 3, `${doc.pages.find((p) => p.id === st.page)?.name} sel ${st.selection.length}`);
    await page.click("[role=tab]:has-text('Layers'), button:has-text('Layers')");
  }

  // ===== Image popover (Tile scale, Rotate, Adjust) and the effect row =====
  {
    const L = await imageLayer(page, "checker", "popover", { scaleMode: "fill" });
    await run(page, { op: "select", ids: [L.id] });
    await sleep(400);
    await page.locator(".swatch").first().click();
    await page.waitForSelector("select[aria-label='Image scale mode']");
    await page.selectOption("select[aria-label='Image scale mode']", "tile");
    await sleep(300);
    const scaleInput = page.locator("input[aria-label='Tile scale']");
    check("the Scale field shows for Tile, starting at 100%", (await scaleInput.inputValue()).startsWith("100"));
    await scaleInput.fill("50");
    await scaleInput.press("Enter");
    await sleep(300);
    check("Scale 50% stores scalingFactor 0.5", (await byName(page, "popover")).fills[0].scalingFactor === 0.5);
    await page.click("button:has-text('Rotate 90')");
    await page.click("button:has-text('Rotate 90')");
    await sleep(300);
    check("Rotate 90° twice gives 180", (await byName(page, "popover")).fills[0].rotation === 180);
    await page.click("button:has-text('Rotate 90')");
    await page.click("button:has-text('Rotate 90')");
    await sleep(200);
    check("four turns are back to none (the field is dropped)", (await byName(page, "popover")).fills[0].rotation === undefined);
    await page.click("button:has-text('Rotate 90')");
    const slider = page.locator("input[data-adjust='saturation']");
    await slider.evaluate((el) => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      set.call(el, "-100");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await sleep(300);
    check("the Saturation slider stores -1", (await byName(page, "popover")).fills[0].filters?.saturation === -1);
    check("Reset is enabled once something is adjusted", await page.locator(".image-adjust button:has-text('Reset')").isEnabled());
    await shot(page, "r17c-image-popover-dark.png");
    await page.locator(".image-adjust button:has-text('Reset')").click();
    await sleep(200);
    check("Reset clears the adjustments", (await byName(page, "popover")).fills[0].filters === undefined);
    await slider.evaluate((el) => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      for (const v of ["-20", "-60", "-100"]) {
        set.call(el, v);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    await page.keyboard.press("Escape");
    await page.mouse.click(5, 5);
    await sleep(400);
    const before = (await byName(page, "popover")).fills[0];
    await run(page, { op: "undo" });
    const after = (await byName(page, "popover")).fills[0];
    check("one undo reverts the whole slider drag", before.filters?.saturation === -1 && after.filters === undefined, JSON.stringify([before.filters, after.filters]));
    await run(page, { op: "delete", ids: [L.id] });
  }

  // ===== Effect row =====
  {
    const r = await run(page, { op: "createShape", kind: "rectangle", x: 0, y: 0, width: 100, height: 100, parent: null });
    await run(page, { op: "update", ids: [r.id], patch: { name: "FxRow" } });
    for (const width of [1440, 1100]) {
      await page.setViewportSize({ width, height: 900 });
      await run(page, { op: "update", ids: [r.id], patch: { effects: [] } });
      await run(page, { op: "select", ids: [r.id] });
      await sleep(400);
      // Below about 1200 px the Design panel starts hidden (it opens over the canvas).
      if ((await page.locator("#panel-toggle-right").getAttribute("aria-expanded")) !== "true") await page.click("#panel-toggle-right");
      await sleep(300);
      await page.click("button[title='Add effect']");
      await sleep(300);
      const e = (await byName(page, "FxRow")).effects[0];
      check(`"+" adds Figma's default drop shadow at ${width} px (0/4/4/0, 25% black)`, e.type === "dropShadow" && e.x === 0 && e.y === 4 && e.blur === 4 && e.spread === 0 && e.color.toLowerCase() === "#00000040", JSON.stringify(e));
      // (The row keeps its editor open from the pass before.)
      if (!(await page.locator(".effect-fields").count())) await page.click("button[title='Edit']");
      await sleep(300);
      const m = await page.evaluate(() => {
        const fields = [...document.querySelectorAll(".effect-fields .field")];
        return fields.map((f) => {
          const l = f.querySelector(".lbl");
          const range = document.createRange();
          range.selectNodeContents(l);
          const text = range.getBoundingClientRect();
          const box = l.getBoundingClientRect();
          const input = f.querySelector("input");
          return { label: l.textContent, textW: text.width, boxW: box.width, fieldW: f.getBoundingClientRect().width, scrollOk: l.scrollWidth <= l.clientWidth + 0.5, overflow: getComputedStyle(l).textOverflow, align: getComputedStyle(input).textAlign, inputW: input.getBoundingClientRect().width };
        });
      });
      const spread = m.find((x) => x.label === "Spread");
      check(`the "Spread" label is whole at ${width} px`, !!spread && spread.scrollOk && spread.textW <= spread.boxW + 0.5 && spread.overflow !== "ellipsis", JSON.stringify(spread));
      check(`four effect fields have equal widths at ${width} px`, m.length === 4 && Math.max(...m.map((x) => x.fieldW)) - Math.min(...m.map((x) => x.fieldW)) <= 1, m.map((x) => `${x.label}:${Math.round(x.fieldW)}`).join(" "));
      check(`effect values are right-aligned at ${width} px`, m.every((x) => x.align === "right" && x.inputW >= 30), m.map((x) => `${x.align}/${Math.round(x.inputW)}`).join(" "));
      await shot(page, `r17c-effect-row-${width}-dark.png`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await run(page, { op: "delete", ids: [r.id] });
  }

  // ===== Performance: pan with ten adjusted 1600 px images =====
  {
    const b64 = await makeImage(page, null, [1600, 1200]);
    const first = await dropImage(page, b64, "perf0", await at(page, 300, 300));
    const src = first.fills[0].src;
    const make = async (adjusted) => {
      const ids = [];
      for (let i = 0; i < 10; i++) {
        const filters = adjusted ? { exposure: 0.2, contrast: 0.2, saturation: -0.3, temperature: 0.2, highlights: -0.2, shadows: 0.2 } : undefined;
        const r = await run(page, { op: "createImage", src, x: i * 1600, y: 0, width: 1600, height: 1200, name: `perf${adjusted ? "A" : "P"}${i}`, parent: null });
        if (filters) await run(page, { op: "update", ids: [r.id], patch: { fills: [{ type: "image", src, scaleMode: "fill", opacity: 1, visible: true, filters }] } });
        ids.push(r.id);
      }
      return ids;
    };
    const pan = () =>
      page.evaluate(async () => {
        window.__dt.setViewport({ zoom: 0.5, x: 20, y: 20 });
        await new Promise((r) => setTimeout(r, 600));
        const times = [];
        let last = performance.now();
        for (let i = 0; i < 150; i++) {
          window.__dt.setViewport({ zoom: 0.5, x: 20 - i * 8, y: 20 - i });
          await new Promise((r) => requestAnimationFrame(r));
          const now = performance.now();
          times.push(now - last);
          last = now;
        }
        times.sort((a, b) => a - b);
        return { p50: times[Math.floor(times.length * 0.5)], p95: times[Math.floor(times.length * 0.95)] };
      });
    await run(page, { op: "delete", ids: [first.id] });
    const plainIds = await make(false);
    await sleep(800);
    const plain = [await pan(), await pan(), await pan()].sort((a, b) => a.p95 - b.p95)[1];
    await run(page, { op: "delete", ids: plainIds });
    const adjIds = await make(true);
    await sleep(800);
    const adj = [await pan(), await pan(), await pan()].sort((a, b) => a.p95 - b.p95)[1];
    console.log(`INFO  pan p95 (median of 3 runs): unadjusted ${plain.p95.toFixed(1)} ms (p50 ${plain.p50.toFixed(1)}), adjusted ${adj.p95.toFixed(1)} ms (p50 ${adj.p50.toFixed(1)}), ratio ${(adj.p95 / plain.p95).toFixed(2)}`);
    check("pan p95 with ten adjusted 1600 px images stays within 1.5x the unadjusted run (16.7 ms frame floor)", adj.p95 <= Math.max(1.5 * plain.p95, 20), `${adj.p95.toFixed(1)} vs ${plain.p95.toFixed(1)}`);
    await run(page, { op: "delete", ids: adjIds });
  }

  // ===== Light theme screenshots =====
  if (SHOTS) {
    const lp = await openPage({ colorScheme: "light" });
    await newFile(lp);
    const L = await imageLayer(lp, "checker", "light", { scaleMode: "tile", scalingFactor: 0.5 });
    await run(lp, { op: "select", ids: [L.id] });
    await sleep(400);
    await lp.locator(".swatch").first().click();
    await lp.waitForSelector("select[aria-label='Image scale mode']");
    await lp.click("button:has-text('Rotate 90')");
    await lp.locator("input[data-adjust='exposure']").evaluate((el) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, "40");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await sleep(500);
    await shot(lp, "r17c-image-popover-light.png");
    await lp.keyboard.press("Escape");
    await lp.mouse.click(5, 5);
    await run(lp, { op: "select", ids: [L.id] });
    await lp.click("button:has-text('Assets')");
    await sleep(700);
    await shot(lp, "r17c-assets-light.png");
    await lp.click("button:has-text('Layers')");
    await run(lp, { op: "update", ids: [L.id], patch: { effects: [{ type: "dropShadow", x: 0, y: 4, blur: 4, spread: 0, color: "#00000040", visible: true }] } });
    await sleep(300);
    await lp.click("button[title='Edit']");
    await sleep(300);
    await shot(lp, "r17c-effect-row-light.png");
    await lp.context().close();
  }

  await page.context().close();
} catch (err) {
  check("script ran to the end", false, String(err?.stack ?? err));
} finally {
  await browser.close();
  server.close();
  fs.rmSync(exportDir, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
