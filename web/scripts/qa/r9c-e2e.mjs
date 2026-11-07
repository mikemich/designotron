// Round 9, drawing, text and accessibility: justified text and text strokes on the canvas and in
// exports, images dropped into frames, SVG paste sizes, the weight menu, pen Shift, star and polygon
// fields, focus after text editing and hex entry, the canvas description, axe, forced colours, and
// frame labels at low zoom.
// Usage: E2E_URL=http://localhost:5651 [E2E_OUT=dir] node scripts/qa/r9c-e2e.mjs (dev server running)

import { chromium } from "playwright-core";
import fs from "node:fs";

const URL = process.env.E2E_URL ?? "http://localhost:5651";
const OUT = process.env.E2E_OUT ?? "test-results";
const AXE = process.env.AXE_JS ?? "/tmp/claude-0/-home-user-designotron/286bf7bb-781e-5d8f-9708-6c1f94840e4a/scratchpad/qa7/I-a11y/node_modules/axe-core/axe.min.js";
fs.mkdirSync(OUT, { recursive: true });
const launch = { headless: true, args: ["--no-sandbox"] };
if (process.env.CHROMIUM) launch.executablePath = process.env.CHROMIUM;
else if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
}

const browser = await chromium.launch(launch);
async function openPage(opts = {}) {
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 2, acceptDownloads: true, ...opts });
  const page = await context.newPage();
  await page.route("**/*", (r) => (/^(http:\/\/(localhost|127\.0\.0\.1)|data:|blob:|ws:)/.test(r.request().url()) ? r.continue() : r.abort()));
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
let page = await openPage();

const dt = (fn, arg) => page.evaluate(fn, arg);
const run = (cmd) => dt((c) => window.__dt.dispatch(c), cmd);
const doc = () => dt(() => window.__dt.doc());
const shot = (n, clip) => page.screenshot({ path: `${OUT}/r9c-${n}.png`, ...(clip ? { clip } : {}) });
const byName = async (name) => Object.values((await doc()).nodes).find((n) => n.name === name);
async function newFile() {
  await page.goto(URL);
  await page.click("button:has-text('New design file')");
  await page.waitForSelector("#dt-canvas");
  await page.waitForTimeout(300);
  await dt(() => window.__dt.setViewport({ zoom: 1, x: 0, y: 0 }));
}
const create = async (nodes) => {
  await dt((n) => window.__dt.tool("create_nodes", { nodes: n }), nodes);
  await page.waitForTimeout(400);
};
/** Pixels of a PNG data URL (the browser decodes it). */
const pixels = (url) =>
  dt(
    (u) =>
      new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement("canvas");
          c.width = img.width;
          c.height = img.height;
          const ctx = c.getContext("2d");
          ctx.drawImage(img, 0, 0);
          resolve({ w: img.width, h: img.height, data: Array.from(ctx.getImageData(0, 0, img.width, img.height).data) });
        };
        img.src = u;
      }),
    url,
  );
const dataUrl = (buf) => "data:image/png;base64," + buf.toString("base64");
/** Rows (y ranges) of a pixel grid that hold dark ink, and the rightmost dark pixel of each. */
function inkRows(p, dark = (r, g, b) => r < 110 && g < 110 && b < 110) {
  const rows = [];
  let cur = null;
  for (let y = 0; y < p.h; y++) {
    let right = -1;
    for (let x = 0; x < p.w; x++) {
      const i = (y * p.w + x) * 4;
      if (dark(p.data[i], p.data[i + 1], p.data[i + 2])) right = x;
    }
    if (right >= 0) {
      if (!cur) rows.push((cur = { y0: y, y1: y, right }));
      cur.y1 = y;
      cur.right = Math.max(cur.right, right);
    } else cur = null;
  }
  return rows;
}
const redCount = (p) => {
  let n = 0;
  for (let i = 0; i < p.data.length; i += 4) if (p.data[i] > 200 && p.data[i + 1] < 90 && p.data[i + 2] < 120) n++;
  return n;
};
async function svgPixels(id, scale = 2) {
  const svg = await dt((i) => window.__dt.query({ q: "exportSvg", id: i }), id);
  const out = await dt(
    ([s, k]) =>
      new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement("canvas");
          c.width = img.width * k;
          c.height = img.height * k;
          const ctx = c.getContext("2d");
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, c.width, c.height);
          ctx.drawImage(img, 0, 0, c.width, c.height);
          resolve({ w: c.width, h: c.height, data: Array.from(ctx.getImageData(0, 0, c.width, c.height).data) });
        };
        img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(s);
      }),
    [svg, scale],
  );
  return { svg, px: out };
}

// ---------- 1. Justified text ----------
await newFile();
const LONG = "Justified text that wraps onto several lines so the spacing is visible on the first lines here and keeps going while the paragraph carries on for a few more words to end";
await create([
  { type: "frame", name: "J", x: 20, y: 20, width: 340, height: 300, fill: "#FFFFFF", children: [
    { type: "text", name: "Justify", x: 20, y: 20, width: 300, text: LONG, fontSize: 16, fontFamily: "Inter", color: "#000000", textAlign: "justify" },
  ] },
  { type: "frame", name: "JL", x: 400, y: 20, width: 340, height: 300, fill: "#FFFFFF", children: [
    { type: "text", name: "Left", x: 20, y: 20, width: 300, text: LONG, fontSize: 16, fontFamily: "Inter", color: "#000000" },
  ] },
  { type: "frame", name: "JM", x: 20, y: 340, width: 340, height: 300, fill: "#FFFFFF", children: [
    { type: "text", name: "Mixed", x: 20, y: 20, width: 300, text: "x", fontSize: 16, fontFamily: "Inter", color: "#000000", textAlign: "justify", spans: [
      { text: "Justified text with a " }, { text: "BIGGER", fontSize: 28, fontWeight: 700 }, { text: " word inside that wraps onto several lines of a fixed width box and keeps going on" },
    ] },
  ] },
]);
await page.mouse.move(1450, 900);
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
{
  const cb = await page.locator("#dt-canvas").boundingBox();
  // Frame J: box x 40..340 on the page (20 + 20 .. + 300).
  const clip = { x: cb.x + 20, y: cb.y + 20, width: 340, height: 200 };
  const buf = await page.screenshot({ clip });
  fs.writeFileSync(`${OUT}/r9c-justify.png`, buf);
  const rows = inkRows(await pixels(dataUrl(buf)));
  const right = 340 * 2 - 20 * 2; // the box's right edge in device pixels
  const full = rows.slice(0, -1);
  check("justify: wrapped lines reach the box's right edge", full.length >= 3 && full.every((r) => r.right >= right - 6), JSON.stringify(rows.map((r) => r.right)));
  check("justify: the last line stays short", rows.at(-1).right < right - 40, String(rows.at(-1)?.right));
  const lines = async (name) => {
    const n = await byName(name);
    const svg = await dt((i) => window.__dt.query({ q: "exportSvg", id: i }), n.id);
    return (svg.match(/<tspan x=/g) ?? []).length;
  };
  const jl = await lines("Justify");
  const ll = await lines("Left");
  check("justify: same line breaks as left aligned", jl === ll && jl >= 4, `${jl} vs ${ll}`);
  const mclip = { x: cb.x + 20, y: cb.y + 340, width: 340, height: 200 };
  await shot("justify-mixed", mclip);
  const mb = await page.screenshot({ clip: mclip });
  const mrows = inkRows(await pixels(dataUrl(mb)));
  check("justify: mixed-size lines reach the right edge too", mrows.slice(0, -1).filter((r) => r.right >= right - 10).length >= 2, JSON.stringify(mrows.map((r) => r.right)));
  const mixed = await byName("Mixed");
  const msvg = await dt((i) => window.__dt.query({ q: "exportSvg", id: i }), mixed.id);
  check("justify: exported SVG carries word-spacing", /word-spacing="[0-9.]+"/.test(msvg));
}

{
  // Entering the editor keeps justified text justified.
  const j = await byName("Justify");
  await run({ op: "select", ids: [j.id] });
  await page.locator("#dt-canvas").focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  const ta = await dt(() => document.querySelector("textarea.text-editor") && getComputedStyle(document.querySelector("textarea.text-editor")).textAlign);
  check("justify: the editor is justified too", ta === "justify", String(ta));
  await page.keyboard.press("Escape");
}

// ---------- 2. Text strokes ----------
await newFile();
await create([
  { type: "frame", name: "TS", x: 20, y: 20, width: 1000, height: 140, fill: "#FFFFFF", children: ["inside", "outside", "center"].map((a, i) => (
    { type: "text", name: "S-" + a, x: 20 + i * 330, y: 30, text: "Ab" + a.slice(0, 2), fontSize: 72, fontWeight: 800, fontFamily: "Inter", color: "#111111", stroke: "#E11D48", strokeWidth: 6, strokeAlign: a }
  )) },
]);
await page.mouse.move(1450, 900);
await page.keyboard.press("Escape");
await page.waitForTimeout(500);
{
  const cb = await page.locator("#dt-canvas").boundingBox();
  for (const [i, a] of ["inside", "outside", "center"].entries()) {
    const clip = { x: cb.x + 20 + 20 + i * 330, y: cb.y + 20 + 20, width: 320, height: 110 };
    const buf = await page.screenshot({ clip });
    fs.writeFileSync(`${OUT}/r9c-textstroke-${a}.png`, buf);
    check(`text stroke ${a}: red pixels on the canvas`, redCount(await pixels(dataUrl(buf))) > 300, String(redCount(await pixels(dataUrl(buf)))));
  }
  const frame = await byName("TS");
  const { svg, px } = await svgPixels(frame.id);
  fs.writeFileSync(`${OUT}/r9c-textstroke.svg`, svg);
  check("text stroke: exported SVG has stroke, paint-order and a clip", /stroke="#E11D48"/.test(svg) && /paint-order="stroke"/.test(svg) && /<clipPath id="[^"]*tclip/.test(svg));
  check("text stroke: red pixels in the rasterised export", redCount(px) > 800, String(redCount(px)));
  // PNG export through the panel
  await run({ op: "select", ids: [frame.id] });
  await page.waitForTimeout(300);
  await page.locator('select[aria-label="Export format"]').first().selectOption("png").catch(() => {});
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 20000 }), page.locator('button:has-text("Export ")').filter({ hasNotText: "code" }).first().click()]);
  const png = `${OUT}/r9c-textstroke-export.png`;
  await dl.saveAs(png);
  const epx = await pixels(dataUrl(fs.readFileSync(png)));
  check("text stroke: red pixels in the exported PNG", redCount(epx) > 300, String(redCount(epx)));
  // Bounds include the stroke: the outside layer paints 6px further than its box.
  const b = await dt((i) => window.__dt.query({ q: "bounds", ids: [i] }), (await byName("S-outside")).id);
  check("text stroke: bounds query answers", !!b);
  // Codegen
  const html = await dt((i) => window.__dt.query({ q: "exportHtml", id: i }), frame.id).catch(() => null);
  if (typeof html === "string") check("text stroke: HTML export has -webkit-text-stroke", html.includes("-webkit-text-stroke"));
}

// ---------- 3. Drop into a frame, SVG sizes ----------
await newFile();
await create([{ type: "frame", name: "Card frame", x: 100, y: 100, width: 400, height: 300, fill: "#EEEEEE" }]);
{
  const cb = await page.locator("#dt-canvas").boundingBox();
  const drop = (name, mime, text, x, y) =>
    dt(
      async ([name, mime, text, x, y]) => {
        let blob;
        if (mime === "image/png") {
          const c = document.createElement("canvas");
          c.width = 120;
          c.height = 80;
          c.getContext("2d").fillRect(0, 0, 120, 80);
          blob = await new Promise((r) => c.toBlob(r));
        } else blob = new Blob([text], { type: mime });
        const d = new DataTransfer();
        d.items.add(new File([blob], name, { type: mime }));
        document.querySelector("#dt-canvas").dispatchEvent(new DragEvent("drop", { dataTransfer: d, clientX: x, clientY: y, bubbles: true, cancelable: true }));
      },
      [name, mime, text, x, y],
    );
  await drop("photo.png", "image/png", "", cb.x + 300, cb.y + 250);
  await page.waitForTimeout(1000);
  const frame = await byName("Card frame");
  const img = await byName("photo");
  check("drop: the image lands in the frame under the pointer", img?.parent === frame.id, `parent=${img?.parent}`);
  // Where it lands: centred on the pointer (page 300,250 → frame-local 200,150).
  check("drop: centred on the pointer, in frame coordinates", img && Math.abs(img.x + img.width / 2 - 200) < 2 && Math.abs(img.y + img.height / 2 - 150) < 2, img ? `${img.x},${img.y}` : "");
  await drop("outside.png", "image/png", "", cb.x + 700, cb.y + 600);
  await page.waitForTimeout(800);
  const out = await byName("outside");
  check("drop: outside any frame stays on the page", out && !out.parent);
  await drop("vb.svg", "image/svg+xml", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>', cb.x + 650, cb.y + 100);
  await page.waitForTimeout(800);
  const vb = await byName("vb");
  check("svg: a viewBox-only file is 24x24", vb && vb.width === 24 && vb.height === 24, vb ? `${vb.width}x${vb.height}` : "none");
  await drop("sz.svg", "image/svg+xml", '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 160 160"><rect width="160" height="160"/></svg>', cb.x + 750, cb.y + 100);
  await page.waitForTimeout(800);
  const sz = await byName("sz");
  check("svg: width and height win over the viewBox (16x16)", sz && sz.width === 16 && sz.height === 16, sz ? `${sz.width}x${sz.height}` : "none");
  await drop("wd.svg", "image/svg+xml", '<svg xmlns="http://www.w3.org/2000/svg" width="48" viewBox="0 0 24 12"><path d="M0 0h24v12z"/></svg>', cb.x + 850, cb.y + 100);
  await page.waitForTimeout(800);
  const wd = await byName("wd");
  check("svg: one dimension plus a viewBox keeps the ratio", wd && wd.width === 48 && wd.height === 24, wd ? `${wd.width}x${wd.height}` : "none");
  // Pasted SVG text
  await dt((t) => {
    const d = new DataTransfer();
    d.setData("text/plain", t);
    (document.activeElement || document.body).dispatchEvent(new ClipboardEvent("paste", { clipboardData: d, bubbles: true, cancelable: true }));
  }, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>');
  await page.waitForTimeout(800);
  const pasted = Object.values((await doc()).nodes).find((n) => n.name === "SVG");
  check("svg: pasted SVG text is 24x24", pasted && pasted.width === 24 && pasted.height === 24, pasted ? `${pasted.width}x${pasted.height}` : "none");
}

// ---------- 4. Weight menu ----------
await newFile();
await create([
  { type: "text", name: "W100", x: 40, y: 40, text: "Thin", fontSize: 32, fontWeight: 100, fontFamily: "Inter" },
  { type: "text", name: "W900", x: 40, y: 120, text: "Black", fontSize: 32, fontWeight: 900, fontFamily: "Inter" },
  { type: "text", name: "W450", x: 40, y: 200, text: "Odd", fontSize: 32, fontWeight: 450, fontFamily: "Inter" },
]);
{
  const shown = async (name) => {
    await run({ op: "select", ids: [(await byName(name)).id] });
    await page.waitForTimeout(250);
    return dt(() => {
      const s = document.querySelector('select[aria-label="Font weight"]');
      return s ? s.options[s.selectedIndex]?.text : null;
    });
  };
  check("weight: 100 shows Thin", (await shown("W100")) === "Thin");
  check("weight: 900 shows Black", (await shown("W900")) === "Black");
  check("weight: a weight the list lacks shows as a number", (await shown("W450")) === "450");
  const opts = await dt(() => [...document.querySelector('select[aria-label="Font weight"]').options].map((o) => o.text));
  check("weight: the menu keeps its order", opts.indexOf("Thin") < opts.indexOf("Regular") && opts.indexOf("Black") > opts.indexOf("Extra bold"), opts.join(","));
}

// ---------- 5. Pen with Shift ----------
await newFile();
{
  const cb = await page.locator("#dt-canvas").boundingBox();
  const S = (x, y) => [cb.x + x, cb.y + y];
  await page.keyboard.press("Escape");
  await page.keyboard.press("p");
  await page.mouse.click(...S(100, 100));
  await page.keyboard.down("Shift");
  await page.mouse.click(...S(300, 130));
  await page.mouse.click(...S(380, 330));
  await page.keyboard.up("Shift");
  await page.mouse.click(...S(500, 300));
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  const id = (await dt(() => window.__dt.state())).selection[0];
  const n = (await doc()).nodes[id];
  const pts = n.vector.subpaths[0].points.map((p) => ({ x: p.x + n.x, y: p.y + n.y }));
  const ang = (a, b) => ((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI + 360) % 360;
  const a1 = ang(pts[0], pts[1]);
  const a2 = ang(pts[1], pts[2]);
  check("pen: Shift snaps the second point to a multiple of 45 degrees", Math.abs(a1 / 45 - Math.round(a1 / 45)) < 0.01, `angle ${a1.toFixed(2)}`);
  check("pen: and the third", Math.abs(a2 / 45 - Math.round(a2 / 45)) < 0.01, `angle ${a2.toFixed(2)}`);
  const a3 = ang(pts[2], pts[3]);
  check("pen: without Shift the point stays where it was clicked", Math.abs(a3 / 45 - Math.round(a3 / 45)) > 0.05, `angle ${a3.toFixed(2)}`);
}

// ---------- 6. Star and polygon fields ----------
await newFile();
await create([
  { type: "star", name: "Star A", x: 100, y: 100, width: 160, height: 160, fill: "#F59E0B", pointCount: 5 },
  { type: "polygon", name: "Hex", x: 350, y: 100, width: 160, height: 160, fill: "#10B981", pointCount: 6 },
]);
{
  const setField = async (label, value) => {
    const f = page.locator(`input[aria-label="${label}"], [title="${label}"] input`).first();
    await f.click({ clickCount: 3 });
    await page.keyboard.type(String(value));
    await page.keyboard.press("Enter");
    await page.waitForTimeout(250);
  };
  const star = await byName("Star A");
  await run({ op: "select", ids: [star.id] });
  await page.waitForTimeout(300);
  await setField("Points", 8);
  await setField("Ratio (inner radius)", 60);
  const s = await byName("Star A");
  check("star: Points field sets pointCount", s.shape?.pointCount === 8, String(s.shape?.pointCount));
  check("star: Ratio field sets innerRadius", Math.abs((s.shape?.innerRadius ?? 0) - 0.6) < 0.001, String(s.shape?.innerRadius));
  await setField("Points", 100);
  check("star: Points clamps at 60", (await byName("Star A")).shape.pointCount === 60);
  await shot("star-panel");
  const hex = await byName("Hex");
  await run({ op: "select", ids: [hex.id] });
  await page.waitForTimeout(300);
  await setField("Points", 9);
  check("polygon: Points field", (await byName("Hex")).shape?.pointCount === 9);
  check("polygon: no Ratio field", (await page.locator('[title="Ratio (inner radius)"]').count()) === 0);
  {
    const lbl = page.locator("label.field:has(input) .lbl", { hasText: "Points" }).first();
    const bb = await lbl.boundingBox();
    await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 5; i++) await page.mouse.move(bb.x + bb.width / 2 + i * 2, bb.y + bb.height / 2);
    await page.mouse.up();
    await page.waitForTimeout(250);
    const after = (await byName("Hex")).shape.pointCount;
    await page.locator("#dt-canvas").focus();
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(250);
    check("polygon: scrubbing Points is one undo step", after > 9 && (await byName("Hex")).shape.pointCount === 9, `${after} then ${(await byName("Hex")).shape.pointCount}`);
  }
}

// ---------- 7. Focus ----------
const active = () => dt(() => ({ tag: document.activeElement?.tagName, id: document.activeElement?.id, layer: document.activeElement?.getAttribute?.("data-layer"), label: document.activeElement?.getAttribute?.("aria-label") }));
await newFile();
{
  // From the canvas: T, Enter to insert, type, Esc.
  await page.locator("#dt-canvas").focus();
  await page.keyboard.press("t");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  await page.keyboard.type("Hello");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  let a = await active();
  check("focus: after Esc from text editing it is on the canvas, not BODY", a.id === "dt-canvas", JSON.stringify(a));
  // Ctrl+Enter also commits
  await page.keyboard.press("Enter");
  await page.waitForTimeout(250);
  await page.keyboard.press("Control+Enter");
  await page.waitForTimeout(250);
  a = await active();
  check("focus: Ctrl+Enter returns to the canvas too", a.id === "dt-canvas", JSON.stringify(a));
  // From the layers tree: Enter hands the keys to the canvas, and Enter there edits the text.
  const text = Object.values((await doc()).nodes).find((n) => n.type === "text");
  await page.locator(`[data-layer="${text.id}"]`).focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  const inEditor = await dt(() => document.activeElement?.className);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  a = await active();
  check("focus: editing opened from the tree ends on the canvas", inEditor === "text-editor" && a.id === "dt-canvas", JSON.stringify({ inEditor, a }));
  // Hex field
  await run({ op: "select", ids: [text.id] });
  await page.waitForTimeout(300);
  const hexField = page.locator('input[aria-label="Hex colour"]').first();
  await hexField.focus();
  await page.keyboard.press("Control+a");
  await page.keyboard.type("FF5500");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  a = await active();
  const fill = (await doc()).nodes[text.id].fills[0];
  check("focus: Enter in the hex field keeps focus there", a.label === "Hex colour", JSON.stringify(a));
  check("focus: and applies the colour", fill.color.toUpperCase() === "#FF5500", fill.color);
  const sel = await dt(() => {
    const e = document.activeElement;
    return e.selectionEnd - e.selectionStart;
  });
  check("focus: the hex text is selected again", sel === 6, String(sel));
  await page.keyboard.type("00AAFF");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  check("focus: a second value goes in without tabbing back", (await doc()).nodes[text.id].fills[0].color.toUpperCase() === "#00AAFF");
  {
    // Clicking into the field and out without typing must not write the old colour over a newer one.
    await hexField.focus();
    await run({ op: "update", ids: [text.id], patch: { fills: [{ type: "solid", color: "#123456", opacity: 1, visible: true }] } });
    await page.waitForTimeout(250);
    await page.locator("#dt-canvas").focus();
    await page.waitForTimeout(250);
    check("hex: blur without typing keeps a newer colour", (await doc()).nodes[text.id].fills[0].color.toUpperCase() === "#123456", (await doc()).nodes[text.id].fills[0].color);
    const shownHex = await hexField.inputValue();
    check("hex: the field follows the newer colour", shownHex.toUpperCase() === "123456", shownHex);
  }
  const desc = await dt(() => document.getElementById("dt-canvas").getAttribute("aria-description"));
  check("canvas description names the way out", /F6/.test(desc ?? "") && /Esc/.test(desc ?? ""), desc ?? "");
  await page.locator("#dt-canvas").focus();
  await page.keyboard.press("?");
  await page.waitForTimeout(300);
  const dlg = await dt(() => document.querySelector('[role="dialog"]')?.textContent ?? "");
  check("Shortcuts dialog says how to leave the canvas", /Leave the canvas/.test(dlg) && /F6/.test(dlg));
  await page.keyboard.press("Escape");
}

// ---------- 8. Targets and axe ----------
await newFile();
{
  const box = await page.locator('button[title="Shape tools"]').boundingBox();
  check("Shape tools button is at least 24x24", box.width >= 24 && box.height >= 24, `${box.width}x${box.height}`);
  await page.addScriptTag({ content: fs.readFileSync(AXE, "utf8") });
  const res = await dt(() => window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] } }));
  const bad = res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
  fs.writeFileSync(`${OUT}/r9c-axe.json`, JSON.stringify(res.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => n.target) })), null, 1));
  check("axe: no target-size violation", !res.violations.some((v) => v.id === "target-size"), bad.join(" || "));
  check("axe: no serious or critical violations in the empty editor", !res.violations.some((v) => ["serious", "critical"].includes(v.impact)), bad.join(" || "));
}

// ---------- 9. Forced colours ----------
{
  await page.context().close();
  page = await openPage({ forcedColors: "active", viewport: { width: 1280, height: 720 } });
  await page.goto(URL);
  await page.waitForSelector(".files, #dt-canvas");
  await page.waitForTimeout(600);
  const dash = await dt(() => {
    const out = [];
    for (const b of document.querySelectorAll("button, .btn, .file-card, .logo")) {
      const cs = getComputedStyle(b);
      const r = b.getBoundingClientRect();
      if (r.width < 4) continue;
      const w = parseFloat(cs.borderTopWidth);
      out.push({ t: (b.textContent || b.title || b.className).trim().slice(0, 24), ok: (w >= 1 && cs.borderTopStyle !== "none" && cs.borderTopColor !== "rgba(0, 0, 0, 0)") || (b.classList.contains("logo") && parseFloat(cs.outlineWidth) >= 1 && cs.outlineStyle !== "none") });
    }
    return out;
  });
  check("forced colors: dashboard buttons and logo have a visible border", dash.length > 3 && dash.every((d) => d.ok), JSON.stringify(dash.filter((d) => !d.ok)));
  await shot("forced-dash");
  await page.click("button:has-text('New design file')");
  await page.waitForSelector("#dt-canvas");
  await page.waitForTimeout(400);
  const ed = await dt(() => [...document.querySelectorAll(".tbtn, .ibtn")].filter((b) => b.getBoundingClientRect().width > 4).map((b) => parseFloat(getComputedStyle(b).borderTopWidth) >= 1 && getComputedStyle(b).borderTopStyle !== "none"));
  check("forced colors: toolbar buttons have a border", ed.length > 5 && ed.every(Boolean), `${ed.filter(Boolean).length}/${ed.length}`);
  await shot("forced-editor");
}

// ---------- 10. Frame labels at low zoom ----------
await page.context().close();
page = await openPage();
await newFile();
{
  const frames = [];
  for (let i = 0; i < 40; i++) frames.push({ type: "frame", name: `Screen ${String(i + 1).padStart(2, "0")} Listing`, x: (i % 10) * 420, y: Math.floor(i / 10) * 900, width: 390, height: 844, fill: "#FFFFFF" });
  await create(frames);
  await page.keyboard.press("Escape");
  await dt(() => window.__dt.setViewport({ zoom: 0.16, x: 20, y: 60 }));
  await page.waitForTimeout(500);
  const labels = await dt(() => [...document.querySelectorAll("text.frame-label")].map((t) => {
    const r = t.getBoundingClientRect();
    return { text: t.textContent, x: r.x, y: r.y, w: r.width, h: r.height };
  }));
  let overlaps = 0;
  for (let i = 0; i < labels.length; i++)
    for (let j = i + 1; j < labels.length; j++) {
      const a = labels[i];
      const b = labels[j];
      if (a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h && b.y < a.y + a.h) overlaps++;
    }
  check("frame labels: none overlap at 16%", labels.length > 0 && overlaps === 0, `${labels.length} labels, ${overlaps} overlaps`);
  check("frame labels: none wider than their frame", labels.every((l) => l.w <= 390 * 0.16 + 1), `max ${Math.max(...labels.map((l) => l.w)).toFixed(1)}`);
  await shot("labels-16");
  await dt(() => window.__dt.setViewport({ zoom: 0.02, x: 20, y: 60 }));
  await page.waitForTimeout(400);
  const tiny = await dt(() => document.querySelectorAll("text.frame-label").length);
  check("frame labels: hidden when frames are under 24px", tiny === 0, String(tiny));
  await dt(() => window.__dt.setViewport({ zoom: 1, x: 20, y: 60 }));
  await page.waitForTimeout(300);
  const full = await dt(() => [...document.querySelectorAll("text.frame-label")].map((t) => t.textContent));
  check("frame labels: whole names at 100%", full.some((t) => t === "Screen 01 Listing"), full.slice(0, 2).join(","));
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
