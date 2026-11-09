// Round 12 package a, live rich text editing: the canvas draws the text while it is edited (mixed
// runs, overflowing lines of fixed boxes), the caret and selection line up with the glyphs at any
// zoom and rotation, the text tool edits existing text, and copy/paste keeps character styles.
// Also a plain-text regression pass (typing, selection keys, undo, IME, auto width) and the
// per-keystroke latency in a long paragraph.
// Usage: E2E_URL=http://localhost:5651 [E2E_OUT=dir] node scripts/qa/r12a-e2e.mjs (dev server running)

import { chromium } from "playwright-core";
import fs from "node:fs";

const URL = process.env.E2E_URL ?? "http://localhost:5651";
const OUT = process.env.E2E_OUT ?? "test-results";
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
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
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

const dt = (fn, arg) => page.evaluate(fn, arg);
const run = (cmd) => dt((c) => window.__dt.dispatch(c), cmd);
const doc = () => dt(() => window.__dt.doc());
const node = async (id) => (await doc()).nodes[id];
const shot = (n, clip) => page.screenshot({ path: `${OUT}/r12a-${n}.png`, ...(clip ? { clip } : {}) });
/** Screenshot of the area around a layer (its box plus a margin, screen px). */
async function shotAround(name, id, pad = 40) {
  const n = await node(id);
  const z = (await dt(() => window.__dt.viewport())).zoom;
  const a = await toScreen(id, 0, 0);
  const g = await geo(id);
  const h = Math.max(n.height, g ? g.height : 0);
  const vp = page.viewportSize();
  const x = Math.max(a.x - pad, 0);
  const y = Math.max(a.y - pad, 0);
  await shot(name, { x, y, width: Math.min(Math.max(n.width * z, 300) + pad * 2, vp.width - x), height: Math.min(h * z + pad * 2 + 40, vp.height - y) });
}
const settle = (ms = 150) => page.waitForTimeout(ms);
async function newFile(zoom = 1) {
  await page.goto(URL);
  await page.click("button:has-text('New design file')");
  await page.waitForSelector("#dt-canvas");
  // A new file focuses its "What do you want to design?" prompt; Escape leaves it for the canvas.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  await dt((z) => window.__dt.setViewport({ zoom: z, x: 0, y: 0 }), zoom);
}
/** Creates one text layer (create_nodes spec) and returns its id. */
async function mkText(spec) {
  const before = new Set(Object.keys((await doc()).nodes));
  await dt((s) => window.__dt.tool("create_nodes", { nodes: [{ type: "text", ...s }] }), spec);
  await settle(200);
  const d = await doc();
  return Object.keys(d.nodes).find((k) => !before.has(k) && d.nodes[k].type === "text");
}
/** Screen point of a point in a layer's own coordinates (works for rotated layers). */
const toScreen = (id, lx, ly) =>
  dt(
    ([i, x, y]) => {
      const c = document.getElementById("dt-canvas").getBoundingClientRect();
      const v = window.__dt.viewport();
      const m = window.__dt.query({ q: "bounds", ids: [i] }).items[0].matrix;
      const px = m.a * x + m.c * y + m.e;
      const py = m.b * x + m.d * y + m.f;
      return { x: c.left + px * v.zoom + v.x, y: c.top + py * v.zoom + v.y };
    },
    [id, lx, ly],
  );
const geo = (id) => dt((i) => window.__dt.query({ q: "textLayout", id: i }), id);
/** Screen point at char `i` (left edge) on the vertical middle of its line. */
async function charPoint(id, i) {
  const g = await geo(id);
  const l = g.lines.find((ln) => i >= ln.start && i <= ln.end) ?? g.lines[g.lines.length - 1];
  return toScreen(id, l.xs[Math.min(i - l.start, l.xs.length - 1)], l.top + l.height / 2);
}
const taState = () =>
  dt(() => {
    const t = document.querySelector(".text-editor");
    return t ? { s: t.selectionStart, e: t.selectionEnd, v: t.value, sel: t.value.slice(t.selectionStart, t.selectionEnd) } : null;
  });
const edit = async (id) => {
  await dt((i) => window.__dt.dispatch({ op: "select", ids: [i] }), id);
  await dt((i) => window.__dt.edit(i), id);
  await settle(200);
};
const leave = async () => {
  await page.keyboard.press("Escape");
  await settle(200);
};
const pxOf = (buf) =>
  dt(
    (b64) =>
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
        img.src = "data:image/png;base64," + b64;
      }),
    buf.toString("base64"),
  );
const diffFraction = (a, b) => {
  let n = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const d = Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
    if (d > 60) n++;
  }
  return n / (a.data.length / 4);
};
const hideOverlay = () => dt(() => (document.querySelectorAll(".text-caret").forEach((e) => (e.style.display = "none")), 0));
const showOverlay = () => dt(() => (document.querySelectorAll(".text-caret").forEach((e) => (e.style.display = ""), 0)));
const svgFor = (id) =>
  dt((i) => {
    const g = document.querySelector(`g[data-id="${i}"]`);
    if (!g) return null;
    const vis = (e) => {
      for (let n = e; n && n !== document.body; n = n.parentElement) if (getComputedStyle(n).visibility === "hidden") return false;
      return true;
    };
    return {
      html: g.innerHTML,
      visible: vis(g),
      text: g.querySelector("text")?.textContent ?? "",
      tspans: [...g.querySelectorAll("tspan")].map((t) => ({ w: t.getAttribute("font-weight"), s: t.getAttribute("font-size"), f: t.getAttribute("fill"), t: t.textContent })),
    };
  }, id);

// ---------- 1. O1: styled runs are drawn while editing ----------
await newFile();
const o1 = await mkText({ name: "O1", x: 120, y: 120, text: "Hello world, this is a paragraph.", fontSize: 16, fontFamily: "Inter", color: "#000000" });
await edit(o1);
// Bold "world" with a double-click and Ctrl+B, then colour "this" red and 32 px on "paragraph." (as the panel does).
let p = await charPoint(o1, 8);
await page.mouse.dblclick(p.x, p.y);
await settle();
check("O1: double-click selects the word under the pointer", (await taState()).sel === "world", JSON.stringify(await taState()));
await page.keyboard.press("Control+b");
await settle();
await run({ op: "styleText", id: o1, start: 13, end: 17, style: { color: "#ff0000" }, clear: [] });
await run({ op: "styleText", id: o1, start: 23, end: 33, style: { fontSize: 32 }, clear: [] });
await settle(300);
const s1 = await svgFor(o1);
check("O1: the layer is not hidden while editing", s1 && s1.visible, JSON.stringify(s1?.visible));
check("O1: a bold run is drawn", s1.tspans.some((t) => t.w === "700" && t.t === "world"), JSON.stringify(s1.tspans));
check("O1: a 32 px run is drawn", s1.tspans.some((t) => t.s === "32" && t.t.startsWith("paragraph")), JSON.stringify(s1.tspans));
check("O1: a red run is drawn", s1.tspans.some((t) => /ff0000|255, ?0, ?0/i.test(t.f ?? "") && t.t === "this"), JSON.stringify(s1.tspans));
check("O1: the textarea text is transparent", (await dt(() => getComputedStyle(document.querySelector(".text-editor")).color)) === "rgba(0, 0, 0, 0)");
await shotAround("o1-editing", o1);
// Pixel diff of the text box while editing (caret and selection hidden) against after Escape.
const boxClip = async () => {
  // Inside the box, clear of the selection handles that only show outside editing.
  const a = await toScreen(o1, 10, 10);
  const n = await node(o1);
  const z = (await dt(() => window.__dt.viewport())).zoom;
  return { x: a.x, y: a.y, width: (n.width - 20) * z, height: (n.height - 20) * z };
};
await page.keyboard.press("End");
await settle();
await hideOverlay();
const clip1 = await boxClip();
const editingPx = await pxOf(await page.screenshot({ clip: clip1 }));
await showOverlay();
await leave();
await settle();
const afterPx = await pxOf(await page.screenshot({ clip: clip1 }));
const frac1 = diffFraction(editingPx, afterPx);
check("O1: the text box looks the same while editing and after Escape", frac1 < 0.01, `${(frac1 * 100).toFixed(3)}% of pixels differ`);
await shotAround("o1-after", o1);

// ---------- 2. Caret and selection line up with the glyphs ----------
// geometry x of every char against the browser's own glyph positions, in the layer's coordinates.
async function alignment(id) {
  return dt((i) => {
    const g = window.__dt.query({ q: "textLayout", id: i });
    const t = document.querySelector(`g[data-id="${i}"] text`);
    const out = [];
    let ci = 0;
    for (const ln of g.lines) {
      for (let k = 0; k < ln.end - ln.start; k++) {
        const pos = t.getStartPositionOfChar(ci);
        out.push(Math.abs(pos.x - ln.xs[k]));
        ci++;
      }
    }
    return { max: Math.max(...out), n: out.length, count: t.getNumberOfChars() };
  }, id);
}
for (const zoom of [1, 2]) {
  await newFile(zoom);
  const a = await mkText({
    name: "Mixed",
    x: 60,
    y: 60,
    text: "x",
    fontSize: 16,
    fontFamily: "Inter",
    color: "#000000",
    spans: [{ text: "Mixed " }, { text: "BIGGER", fontSize: 32, fontWeight: 700 }, { text: " and " }, { text: "italic", italic: true, fontSize: 24 }, { text: " words." }],
  });
  await edit(a);
  const al = await alignment(a);
  check(`alignment ${zoom}x: engine char positions match the browser's glyphs`, al.max < 1, `max diff ${al.max.toFixed(2)}px over ${al.n} chars`);
  // Select "BIGGER and" and check the overlay rectangle against the glyph extents.
  await dt(() => {
    const t = document.querySelector(".text-editor");
    t.focus();
    t.setSelectionRange(6, 16);
  });
  await settle();
  const overlay = await dt((i) => {
    const r = [...document.querySelectorAll(".text-caret .text-sel")].map((e) => e.getBoundingClientRect());
    const t = document.querySelector(`g[data-id="${i}"] text`);
    const ctm = t.getScreenCTM();
    let x0 = Infinity;
    let x1 = -Infinity;
    for (let k = 6; k < 16; k++) {
      const e = t.getExtentOfChar(k);
      for (const px of [e.x, e.x + e.width]) {
        const sx = ctm.a * px + ctm.c * e.y + ctm.e;
        x0 = Math.min(x0, sx);
        x1 = Math.max(x1, sx);
      }
    }
    return { rects: r.map((q) => ({ l: q.left, r: q.right, t: q.top, b: q.bottom })), glyph: { l: x0, r: x1 } };
  }, a);
  const ov = overlay.rects[0];
  check(`selection ${zoom}x: highlight edges sit on the glyph edges`, overlay.rects.length === 1 && Math.abs(ov.l - overlay.glyph.l) < 1.5 && Math.abs(ov.r - overlay.glyph.r) < 1.5, JSON.stringify({ ov, glyph: overlay.glyph }));
  // A click on the left edge of char 8 puts the caret there at this zoom.
  const cpt = await charPoint(a, 8);
  await page.mouse.click(cpt.x + 1, cpt.y);
  await settle();
  const clicked = await taState();
  check(`hit-testing ${zoom}x: a click lands on the char under it`, clicked && clicked.s === 8 && clicked.e === 8, JSON.stringify(clicked));
  await shotAround(`align-${zoom}x`, a);
  await leave();
}
// A rotated layer: the caret and selection are drawn in the layer's own rotated frame.
await newFile(1);
const rot = await mkText({ name: "Rot", x: 200, y: 260, text: "x", fontSize: 16, fontFamily: "Inter", color: "#000000", spans: [{ text: "Rotated " }, { text: "BIG", fontSize: 32, fontWeight: 700 }, { text: " text here" }] });
await run({ op: "update", ids: [rot], patch: { rotation: 20 } });
await edit(rot);
await dt(() => {
  const t = document.querySelector(".text-editor");
  t.focus();
  t.setSelectionRange(8, 11);
});
await settle();
const rotCheck = await dt((i) => {
  const t = document.querySelector(`g[data-id="${i}"] text`);
  const ctm = t.getScreenCTM();
  const rect = document.querySelector(".text-caret .text-sel").getBoundingClientRect();
  const xs = [];
  const ys = [];
  for (let k = 8; k < 11; k++) {
    const e = t.getExtentOfChar(k);
    for (const [px, py] of [[e.x, e.y], [e.x + e.width, e.y], [e.x, e.y + e.height], [e.x + e.width, e.y + e.height]]) {
      xs.push(ctm.a * px + ctm.c * py + ctm.e);
      ys.push(ctm.b * px + ctm.d * py + ctm.f);
    }
  }
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  return { dx: Math.abs((rect.left + rect.right) / 2 - cx), dy: Math.abs((rect.top + rect.bottom) / 2 - cy), rot: Math.round((Math.atan2(ctm.b, ctm.a) * 180) / Math.PI) };
}, rot);
check("rotated layer (20 deg): the selection centre sits on the glyphs", rotCheck.rot === 20 && rotCheck.dx < 3 && rotCheck.dy < 4, JSON.stringify(rotCheck));
const rp = await charPoint(rot, 9);
await page.mouse.click(rp.x, rp.y);
await settle();
const rs = await taState();
check("rotated layer: a click lands on the char under it", rs.s >= 8 && rs.s <= 10, JSON.stringify(rs));
await shotAround("rotated", rot, 80);
await leave();

// ---------- 3. Hit-testing, drag and arrow keys with mixed sizes ----------
await newFile(1);
const mx = await mkText({
  name: "Multi",
  x: 80,
  y: 80,
  width: 260,
  text: "x",
  fontSize: 16,
  fontFamily: "Inter",
  color: "#000000",
  spans: [{ text: "Small words first " }, { text: "Gigantic", fontSize: 40 }, { text: " then more small words that wrap onto further lines and keep going for a while." }],
});
await run({ op: "update", ids: [mx], patch: { text: { autoResize: "height" } } });
await edit(mx);
const text3 = (await node(mx)).text.characters;
const bigAt = text3.indexOf("Gigantic");
const g3 = await geo(mx);
const bigLine = g3.lines.find((l) => bigAt >= l.start && bigAt < l.end);
const bx0 = bigLine.xs[bigAt - bigLine.start];
const bx1 = bigLine.xs[bigAt + 8 - bigLine.start];
const mid = await toScreen(mx, (bx0 + bx1) / 2, bigLine.top + bigLine.height / 2);
await page.mouse.click(mid.x, mid.y);
await settle();
const hit = await taState();
check("hit-testing: a click in the middle of the 40 px word lands inside it", hit.s >= bigAt + 2 && hit.s <= bigAt + 6, `caret ${hit.s}, word ${bigAt}..${bigAt + 8}`);
// The caret bar is as tall as the big line, at the clicked x.
const caretBox = await dt(() => {
  const r = document.querySelector(".text-caret .text-caret-bar")?.getBoundingClientRect();
  return r ? { h: r.height, x: r.left } : null;
});
check("caret: as tall as the line it is on", caretBox && Math.abs(caretBox.h - bigLine.height) < 1.5, JSON.stringify({ caretBox, line: bigLine.height }));
// Drag over two lines gives two selection rectangles.
const a3 = await charPoint(mx, 5);
const lastLine = g3.lines[1];
const b3 = await toScreen(mx, lastLine.xs[4], lastLine.top + lastLine.height / 2);
await page.mouse.move(a3.x, a3.y);
await page.mouse.down();
await page.mouse.move((a3.x + b3.x) / 2, (a3.y + b3.y) / 2, { steps: 4 });
await page.mouse.move(b3.x, b3.y, { steps: 4 });
await page.mouse.up();
await settle();
const nrects = await dt(() => document.querySelectorAll(".text-caret .text-sel").length);
check("drag over two lines draws two selection rectangles", nrects === 2, String(nrects));
await shotAround("drag-select", mx);
// ArrowDown from line 1 lands on line 2 near the same x.
await page.mouse.click(a3.x, a3.y);
await settle();
const before = await caretBoxOf();
async function caretBoxOf() {
  return dt(() => {
    const r = document.querySelector(".text-caret .text-caret-bar")?.getBoundingClientRect();
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  });
}
await page.keyboard.press("ArrowDown");
await settle();
const after = await caretBoxOf();
check("ArrowDown moves to the next line near the same x", after && after.y > before.y + 10 && Math.abs(after.x - before.x) < 14, JSON.stringify({ before, after }));
await page.keyboard.press("ArrowUp");
await settle();
const back = await caretBoxOf();
check("ArrowUp returns to the first line", back && Math.abs(back.y - before.y) < 2, JSON.stringify({ before, back }));
await page.keyboard.press("Shift+ArrowDown");
await settle();
const sh = await taState();
check("Shift+ArrowDown extends the selection", sh.e - sh.s > 3, JSON.stringify({ s: sh.s, e: sh.e }));
await page.keyboard.press("End");
await settle();
const endLine = await taState();
check("End goes to the end of the displayed line (not the whole text)", endLine.s > 0 && endLine.s < text3.length - 1, String(endLine.s));
await leave();

// ---------- 4. O5: the overflow of a fixed box is visible while editing ----------
await newFile(1);
const o5 = await mkText({ name: "O5", x: 100, y: 100, width: 220, text: "First line\nSecond line\nThird line\nFourth line", fontSize: 16, fontFamily: "Inter", color: "#000000" });
await run({ op: "update", ids: [o5], patch: { height: 44, text: { autoResize: "none" } } });
await settle();
await edit(o5);
await page.keyboard.press("Control+a");
await settle();
const z5 = (await dt(() => window.__dt.viewport())).zoom;
const o5s = await dt(() => [...document.querySelectorAll(".text-caret .text-sel")].map((e) => e.getBoundingClientRect().bottom));
const boxBottom = (await toScreen(o5, 0, 44)).y;
check("O5: Ctrl+A selects all four lines past the 44 px box", o5s.length === 4 && Math.max(...o5s) > boxBottom + 20 * z5, `${o5s.length} rects, last bottom ${Math.max(...o5s).toFixed(0)} vs box ${boxBottom.toFixed(0)}`);
const taH = await dt(() => document.querySelector(".text-editor").getBoundingClientRect().height);
check("O5: the editor is as tall as all the lines", taH > 44 * z5 + 20, String(taH));
await page.keyboard.press("Control+End");
await page.keyboard.type(" ZZZ");
await settle(250);
const s5 = await svgFor(o5);
check("O5: typing at the end shows on the canvas", s5.visible && s5.text.includes("ZZZ"), s5.text);
// Pixels below the box have ink (the overflow is drawn).
await hideOverlay();
const below = await pxOf(await page.screenshot({ clip: { x: (await toScreen(o5, 0, 0)).x, y: boxBottom + 4, width: 220 * z5, height: 40 * z5 } }));
let ink = 0;
for (let i = 0; i < below.data.length; i += 4) if (below.data[i] < 100 && below.data[i + 1] < 100) ink++;
check("O5: there is ink below the fixed box while editing", ink > 80, `${ink} dark pixels`);
await showOverlay();
await shotAround("o5-editing", o5);
await leave();
check("O5: the fixed box keeps its size after editing", (await node(o5)).height === 44);
// Truncated text: every line while editing, the ellipsis back afterwards.
const tr = await mkText({ name: "Trunc", x: 100, y: 400, width: 160, text: "one two three four five six seven eight nine ten eleven twelve", fontSize: 16, fontFamily: "Inter", color: "#000000" });
await run({ op: "update", ids: [tr], patch: { text: { autoResize: "height", maxLines: 1 } } });
await settle();
check("truncated: the canvas shows the ellipsis before editing", (await svgFor(tr)).text.includes("…"));
await edit(tr);
const st = await svgFor(tr);
check("truncated: all lines render while editing, without the ellipsis", !st.text.includes("…") && st.text.includes("twelve") && (st.html.match(/<tspan x=/g) ?? []).length >= 3, `${(st.html.match(/<tspan x=/g) ?? []).length} lines`);
await leave();
check("truncated: the ellipsis is back after Escape", (await svgFor(tr)).text.includes("…"));

// ---------- 5. O7: the text tool on existing text ----------
await newFile(1);
const o7 = await mkText({ x: 140, y: 160, text: "Existing headline", fontSize: 24, fontFamily: "Inter", color: "#000000" });
const countText = async () => Object.values((await doc()).nodes).filter((n) => n.type === "text").length;
const n7 = await countText();
await page.keyboard.press("t");
const at7 = await charPoint(o7, 8);
await page.mouse.click(at7.x, at7.y);
await settle(250);
const editing7 = await dt(() => window.__dt.state().selection.slice());
const ta7 = await taState();
check("O7: T then a click on text opens that layer's editor", !!ta7 && ta7.v === "Existing headline" && editing7[0] === o7, JSON.stringify({ ta: ta7?.v, sel: editing7 }));
check("O7: the caret is where it was clicked", ta7 && ta7.s === 8 && ta7.e === 8, JSON.stringify(ta7));
await page.keyboard.type(" plus");
await leave();
check("O7: typing lands at the click, no second layer", (await countText()) === n7 && (await node(o7)).text.characters === "Existing plus headline", (await node(o7)).text.characters);
check("O7: the layer name has no leading space", (await node(o7)).name === "Existing plus headline", (await node(o7)).name);
// A drag still makes a new box, and a click on empty canvas a new layer.
await page.keyboard.press("t");
await page.mouse.move(600, 500);
await page.mouse.down();
await page.mouse.move(760, 540, { steps: 4 });
await page.mouse.up();
await settle(250);
await page.keyboard.type("dragged");
await leave();
check("O7: a drag with the text tool still creates a new box", (await countText()) === n7 + 1);
await page.keyboard.press("t");
await page.mouse.click(900, 700);
await settle(200);
await page.keyboard.type("loose");
await leave();
check("O7: a click on empty canvas still creates a new text", (await countText()) === n7 + 2);
// A locked text isn't edited: a new layer is made.
const lk = await mkText({ name: "Locked", x: 140, y: 300, text: "Locked copy here", fontSize: 24, fontFamily: "Inter", color: "#000000" });
await run({ op: "update", ids: [lk], patch: { locked: true } });
await settle();
await page.keyboard.press("t");
const lp = await charPoint(lk, 4);
await page.mouse.click(lp.x, lp.y);
await settle(200);
await page.keyboard.type("new");
await leave();
check("O7: a locked text layer is not edited by the text tool", (await node(lk)).text.characters === "Locked copy here" && (await countText()) === n7 + 4);

// ---------- 6. O8: rich copy and paste ----------
await newFile(1);
const A = await mkText({ name: "A", x: 100, y: 100, text: "Hello world tail", fontSize: 16, fontFamily: "Inter", color: "#000000" });
const B = await mkText({ name: "B", x: 100, y: 200, text: "Target text", fontSize: 16, fontFamily: "Inter", color: "#000000" });
await edit(A);
const wp = await charPoint(A, 8);
await page.mouse.dblclick(wp.x, wp.y);
await settle();
await page.keyboard.press("Control+b");
await run({ op: "styleText", id: A, start: 0, end: 5, style: { color: "#cc0000" }, clear: [] });
await page.keyboard.press("Control+c");
await settle();
// Back to the bold word: the selection is still "world" (the colour run is elsewhere).
check("O8: A has a bold run on world", (await node(A)).text.runs.some((r) => r.fontWeight === 700 && r.start === 6 && r.end === 11), JSON.stringify((await node(A)).text.runs));
// Paste inside the same layer: the bold survives at the end.
await page.keyboard.press("Control+End");
await page.keyboard.press("Control+v");
await settle(250);
const ra = (await node(A)).text;
check("O8: pasting in the same layer keeps bold", ra.characters === "Hello world tailworld" && ra.runs.some((r) => r.fontWeight === 700 && r.start === 16 && r.end === 21), JSON.stringify({ c: ra.characters, runs: ra.runs }));
await leave();
await dt(() => window.__dt.dispatch({ op: "select", ids: [] }));
// Into layer B, in the middle.
await edit(B);
const bp = await charPoint(B, 7);
await page.mouse.click(bp.x, bp.y);
await page.keyboard.press("Control+v");
await settle(250);
const rb = (await node(B)).text;
check("O8: pasting into another text gives the pasted range a 700 run", rb.characters === "Target worldtext" && rb.runs.some((r) => r.fontWeight === 700 && r.start === 7 && r.end === 12), JSON.stringify({ c: rb.characters, runs: rb.runs }));
check("O8: the text around the paste stays plain", !rb.runs.some((r) => r.start < 7 || r.end > 12), JSON.stringify(rb.runs));
await shotAround("o8-pasted", B);
await leave();
await page.keyboard.press("Control+z");
await settle(250);
const undone = (await node(B)).text;
check("O8: one Ctrl+Z after Escape removes the paste and its styles", undone.characters === "Target text" && undone.runs.length === 0, JSON.stringify({ c: undone.characters, runs: undone.runs }));
// Paste and match style.
await dt(() => window.__dt.dispatch({ op: "select", ids: [] }));
await edit(B);
await page.keyboard.press("Control+End");
await page.keyboard.press("Control+Shift+v");
await settle(250);
const rp2 = (await node(B)).text;
check("O8: Ctrl+Shift+V pastes the text without its styles", rp2.characters === "Target textworld" && rp2.runs.length === 0, JSON.stringify({ c: rp2.characters, runs: rp2.runs }));
await leave();
// Plain text from outside keeps pasting as before.
await dt(() => window.__dt.dispatch({ op: "select", ids: [] }));
await edit(B);
await page.keyboard.press("Control+a");
await dt(() => {
  const t = document.querySelector(".text-editor");
  const dtf = new DataTransfer();
  dtf.setData("text/plain", "from outside");
  t.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dtf, bubbles: true, cancelable: true }));
  if (t.value !== "from outside") document.execCommand("insertText", false, "from outside");
});
await settle(200);
check("O8: other clipboard content pastes as plain text", (await node(B)).text.characters === "from outside" && (await node(B)).text.runs.length === 0, (await node(B)).text.characters);
await leave();
// Cut removes the range and keeps its styles for a paste elsewhere.
await dt(() => window.__dt.dispatch({ op: "select", ids: [] }));
await edit(A);
const cp = await charPoint(A, 8);
await page.mouse.dblclick(cp.x, cp.y);
await page.keyboard.press("Control+x");
await settle(250);
check("O8: cut removes the selected range", !(await node(A)).text.characters.includes("Hello world") || (await node(A)).text.characters.length < 21, (await node(A)).text.characters);
await leave();

// ---------- 7. IME composition ----------
await newFile(1);
const ime = await mkText({ name: "IME", x: 120, y: 160, text: "Hi ", fontSize: 24, fontFamily: "Inter", color: "#000000" });
await edit(ime);
await page.keyboard.press("End");
const cdp = await context.newCDPSession(page);
await cdp.send("Input.imeSetComposition", { text: "にほ", selectionStart: 2, selectionEnd: 2 });
await settle(250);
const mid2 = await svgFor(ime);
check("IME: composing text is drawn on the canvas", mid2.text.includes("にほ"), mid2.text);
await cdp.send("Input.insertText", { text: "日本" });
await settle(250);
const ci = await node(ime);
check("IME: the committed text is in the layer and on the canvas", ci.text.characters === "Hi 日本" && (await svgFor(ime)).text.includes("日本"), ci.text.characters);
await leave();

// ---------- 8. Plain-text regression ----------
await newFile(1);
await page.keyboard.press("t");
await page.mouse.click(300, 300);
await page.keyboard.type("one two three");
await settle(200);
let ts = await taState();
check("plain: typing builds the text", ts && ts.v === "one two three" && ts.s === 13);
const nodeIdNow = (await dt(() => window.__dt.state().selection))[0];
check("plain: the layer grows with auto width", (await node(nodeIdNow)).width > 60);
await page.keyboard.press("Home");
await page.keyboard.press("Shift+ArrowRight");
await page.keyboard.press("Shift+ArrowRight");
ts = await taState();
check("plain: Home and Shift+Arrow select", ts.s === 0 && ts.e === 2 && ts.sel === "on", JSON.stringify(ts));
await page.keyboard.press("Control+Shift+ArrowRight");
ts = await taState();
check("plain: Ctrl+Shift+Arrow selects by word", ts.s === 0 && ts.e >= 3, JSON.stringify(ts));
await page.keyboard.press("Control+a");
ts = await taState();
check("plain: Ctrl+A selects everything", ts.sel === "one two three");
const w3 = await charPoint(nodeIdNow, 5);
await page.mouse.dblclick(w3.x, w3.y);
ts = await taState();
check("plain: double-click selects a word", ts.sel === "two", JSON.stringify(ts));
await page.mouse.click(w3.x, w3.y, { clickCount: 3 });
ts = await taState();
check("plain: triple-click selects the paragraph", ts.sel === "one two three", JSON.stringify(ts));
await page.keyboard.press("End");
await page.keyboard.press("Enter");
await page.keyboard.type("four");
await settle(200);
check("plain: Enter adds a line", (await node(nodeIdNow)).text.characters === "one two three\nfour" && (await node(nodeIdNow)).height > 30);
await page.keyboard.press("ArrowUp");
await page.keyboard.press("Home");
ts = await taState();
check("plain: ArrowUp then Home go to the start of the first line", ts.s === 0, JSON.stringify(ts));
await page.keyboard.press("ArrowDown");
await page.keyboard.press("End");
ts = await taState();
check("plain: ArrowDown then End go to the end of the last line", ts.s === 18, JSON.stringify(ts));
await page.keyboard.type("X");
await page.keyboard.press("Control+z");
await settle(150);
ts = await taState();
check("plain: Ctrl+Z inside the editor undoes natively", ts && ts.v === "one two three\nfour", JSON.stringify(ts));
await page.keyboard.type("!");
await page.keyboard.press("Control+Enter");
await settle(250);
check("plain: Ctrl+Enter leaves the editor and keeps the text", !(await taState()) && (await node(nodeIdNow)).text.characters === "one two three\nfour!");
await edit(nodeIdNow);
await page.keyboard.press("Escape");
await settle(150);
check("plain: Escape leaves the editor", !(await taState()));
await edit(nodeIdNow);
const a11y = await dt(() => {
  const t = document.querySelector(".text-editor");
  return { tag: t.tagName, focused: document.activeElement === t, hidden: t.getAttribute("aria-hidden"), value: t.value };
});
check("plain: the input stays a focused, readable textarea (screen readers)", a11y.tag === "TEXTAREA" && a11y.focused && !a11y.hidden && a11y.value.length > 0, JSON.stringify(a11y));
await leave();

// ---------- 8b. Review fixes ----------
// Forced colours: the textarea stays invisible (the canvas draws the text) and the caret and
// selection stay visible.
await newFile(1);
const fc = await mkText({ name: "Forced", x: 120, y: 160, text: "Forced colours check", fontSize: 24, fontFamily: "Inter", color: "#000000" });
await page.emulateMedia({ forcedColors: "active" });
await edit(fc);
await page.keyboard.press("Control+a");
await settle();
const forced = await dt(() => {
  const t = document.querySelector(".text-editor");
  const cs = getComputedStyle(t);
  const r = document.querySelector(".text-caret .text-sel");
  return { color: cs.color, adjust: cs.forcedColorAdjust, rectFill: r && getComputedStyle(r).fill, rects: document.querySelectorAll(".text-caret .text-sel").length };
});
check("forced colours: the textarea text stays transparent", forced.color === "rgba(0, 0, 0, 0)" && forced.adjust === "none", JSON.stringify(forced));
check("forced colours: the selection is drawn in a system colour", forced.rects === 1 && forced.rectFill && forced.rectFill !== "none", JSON.stringify(forced));
await leave();
await page.emulateMedia({ forcedColors: "none" });

// A bottom-aligned 4-line text in a 200x40 box starts above the box: clicks there stay in the editor.
await newFile(1);
const ab = await mkText({ name: "Above", x: 200, y: 300, width: 200, text: "Line one\nLine two\nLine three\nLine four", fontSize: 16, fontFamily: "Inter", color: "#000000" });
await run({ op: "update", ids: [ab], patch: { height: 40, text: { autoResize: "none", alignV: "bottom" } } });
await settle();
await edit(ab);
const gab = await geo(ab);
check("O5: bottom-aligned text starts above its box", gab.lines[0].top < -20, String(gab.lines[0].top));
const firstLine = await toScreen(ab, 20, gab.lines[0].top + gab.lines[0].height / 2);
await page.mouse.click(firstLine.x, firstLine.y);
await settle(200);
const above = await taState();
check("O5: a click on a line above the box keeps editing and places the caret there", !!above && above.s <= 8, JSON.stringify(above));
await leave();

// A hidden text edits with the textarea's own glyphs (nothing is drawn on the canvas to follow).
await newFile(1);
const hid = await mkText({ name: "Hidden", x: 200, y: 200, text: "Hidden words", fontSize: 24, fontFamily: "Inter", color: "#000000" });
await run({ op: "update", ids: [hid], patch: { visible: false } });
await settle();
await edit(hid);
const hs = await dt(() => {
  const t = document.querySelector(".text-editor");
  return t ? { live: t.hasAttribute("data-live"), color: getComputedStyle(t).color } : null;
});
check("hidden text: the textarea keeps its visible glyphs", hs && !hs.live && hs.color !== "rgba(0, 0, 0, 0)", JSON.stringify(hs));
await leave();

// CRLF text: the textarea's indices and the layer's agree.
await newFile(1);
const crlf = await mkText({ name: "CRLF", x: 200, y: 200, text: "x", fontSize: 24, fontFamily: "Inter", color: "#000000" });
await run({ op: "setText", id: crlf, characters: "ab\r\ncd\r\nef" });
await edit(crlf);
await page.keyboard.press("Control+End");
await page.keyboard.type("!");
await settle(200);
check("CRLF: typing at the end lands after the last line", (await node(crlf)).text.characters === "ab\ncd\nef!", JSON.stringify((await node(crlf)).text.characters));
// A change from elsewhere shows in the editor, and the next key doesn't overwrite it.
await run({ op: "setText", id: crlf, characters: "peer wrote this" });
await settle(200);
check("a collaborator's edit shows in the textarea", (await taState()).v === "peer wrote this", JSON.stringify(await taState()));
await page.keyboard.press("Control+End");
await page.keyboard.type("?");
await settle(200);
check("typing after a remote edit keeps it", (await node(crlf)).text.characters === "peer wrote this?", JSON.stringify((await node(crlf)).text.characters));
// Deleting the layer being edited ends editing.
await run({ op: "delete", ids: [crlf] });
await settle(250);
check("deleting the edited layer ends editing", !(await taState()) && (await dt(() => window.__dt.state().selection.length)) === 0);

// Emoji with joiners: a click picks the nearer edge of the cluster.
await newFile(1);
const zwj = await mkText({ name: "ZWJ", x: 200, y: 200, text: "a\u{1F468}\u200D\u{1F469}\u200D\u{1F467}z", fontSize: 48, fontFamily: "Inter", color: "#000000" });
await edit(zwj);
const gz = await geo(zwj);
const xs = gz.lines[0].xs;
const nearEnd = await toScreen(zwj, xs[6] - 1, gz.lines[0].top + gz.lines[0].height / 2);
await page.mouse.click(nearEnd.x, nearEnd.y);
const zs = await taState();
check("emoji with joiners: a click near its right edge puts the caret after it", zs.s === 9, JSON.stringify(zs));
const nearStart = await toScreen(zwj, xs[1] + 1, gz.lines[0].top + gz.lines[0].height / 2);
await page.mouse.click(nearStart.x, nearStart.y);
check("emoji with joiners: a click near its left edge puts the caret before it", (await taState()).s === 1);
await leave();

// Cmd+Left / Cmd+Right are Home / End.
await newFile(1);
const mc = await mkText({ name: "Meta", x: 200, y: 200, text: "first line\nsecond line", fontSize: 24, fontFamily: "Inter", color: "#000000" });
await edit(mc);
await page.keyboard.press("Control+End");
await page.keyboard.press("Meta+ArrowLeft");
check("Meta+ArrowLeft goes to the start of the line", (await taState()).s === 11, JSON.stringify(await taState()));
await page.keyboard.press("Meta+ArrowRight");
check("Meta+ArrowRight goes to the end of the line", (await taState()).s === 22);
await leave();

// Rich paste: malformed clipboard data inserts nothing; 300 runs paste in one update.
await newFile(1);
const big2 = await mkText({ name: "Runs", x: 100, y: 100, width: 700, text: "x", fontSize: 16, fontFamily: "Inter", color: "#000000" });
const words300 = Array.from({ length: 300 }, (_, i) => `w${i} `).join("");
await run({ op: "setText", id: big2, characters: words300 });
await run({ op: "update", ids: [big2], patch: { text: { autoResize: "height", runs: Array.from({ length: 300 }, (_, i) => ({ start: i * ("w0 ".length), end: i * ("w0 ".length) + 2, fontWeight: 700 })).filter((r) => r.end <= words300.length) } } });
const target2 = await mkText({ name: "Dest", x: 100, y: 500, text: "dest", fontSize: 16, fontFamily: "Inter", color: "#000000" });
await settle();
await edit(big2);
await page.keyboard.press("Control+a");
await page.keyboard.press("Control+c");
await leave();
await dt(() => window.__dt.dispatch({ op: "select", ids: [] }));
await edit(target2);
await page.keyboard.press("Control+a");
const tp0 = Date.now();
await page.keyboard.press("Control+v");
await settle(100);
const pasteMs = Date.now() - tp0 - 100;
const rd = (await node(target2)).text;
check("big rich paste: 300 runs arrive, as a bold-run set", rd.characters.length === words300.length && rd.runs.length >= 250 && rd.runs.every((r) => r.fontWeight === 700), `${rd.runs.length} runs, ${rd.characters.length} chars`);
console.log(`INFO  300-run rich paste took ${pasteMs} ms`);
check("big rich paste: well under a second", pasteMs < 400, `${pasteMs} ms`);
await dt(() => {
  const t = document.querySelector(".text-editor");
  for (const bad of ["{not json", JSON.stringify({ text: 5, spans: "no" }), JSON.stringify({ text: "zz", spans: [{ start: 0, end: 99, style: { color: "javascript:alert(1)", link: "javascript:alert(1)" } }, { start: "a" }, null] })]) {
    const dtf = new DataTransfer();
    dtf.setData("text/plain", "zz");
    dtf.setData("application/x-designotron-text", bad);
    t.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dtf, bubbles: true, cancelable: true }));
  }
});
await settle(200);
check("malformed rich clipboard data changes nothing", (await node(target2)).text.characters.length === words300.length && !JSON.stringify((await node(target2)).text.runs).includes("javascript"));
await leave();

// 3,000 characters on one line (what a text tool click makes): typing stays fast.
await newFile(1);
const oneLine = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor ".repeat(40).slice(0, 3000);
const single = await mkText({ name: "OneLine", x: 20, y: 100, text: oneLine, fontSize: 16, fontFamily: "Inter", color: "#000000" });
await edit(single);
await page.keyboard.press("Control+Home");
const st1 = [];
for (let i = 0; i < 12; i++) {
  const t0 = Date.now();
  await page.keyboard.press("x");
  await dt(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  st1.push(Date.now() - t0);
}
st1.sort((a, b) => a - b);
console.log(`INFO  3,000-char single line: median ${st1[6]} ms per key, max ${st1[11]} ms`);
check("a 3,000-character single line types in under 250 ms per key", st1[6] < 250, `median ${st1[6]} ms`);
await leave();

// ---------- 9. Latency: typing in a 2,000-character paragraph ----------
await newFile(1);
const para = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} of the long paragraph used to time typing.`).join(" ").slice(0, 2000);
const big = await mkText({ name: "Long", x: 100, y: 100, width: 600, text: para, fontSize: 16, fontFamily: "Inter", color: "#000000" });
await run({ op: "update", ids: [big], patch: { text: { autoResize: "height" } } });
await settle();
await edit(big);
await page.keyboard.press("Control+End");
const times = [];
for (let i = 0; i < 40; i++) {
  const t0 = Date.now();
  await page.keyboard.press(i % 2 ? "b" : "a");
  await dt(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  times.push(Date.now() - t0);
}
times.sort((a, b) => a - b);
const median = times[Math.floor(times.length / 2)];
console.log(`INFO  keystroke latency in a ${para.length}-char paragraph: median ${median} ms, max ${times[times.length - 1]} ms (headless, includes the test's round trip)`);
check("latency: typing in a 2,000-character paragraph stays under 120 ms per key", median < 120, `median ${median} ms`);
check("latency: the layer text kept every key", (await node(big)).text.characters.length === para.length + 40);
await leave();

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
