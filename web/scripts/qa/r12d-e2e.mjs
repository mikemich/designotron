// Round 12, package d: SVG pasted or dropped as editable vectors, and the vector panel fixes.
// Fidelity (the imported layers drawn by the engine against the browser's own drawing of the SVG),
// paste (text/plain) and drop (.svg file), Ctrl+Shift+V still pasting an image, editability (vector
// edit, recolour), the image fallback with its toast, a 3 MB SVG, Square line ends, no Line end on
// closed paths, the Crop label, round anchors.
// Usage: E2E_URL=http://localhost:6141 [E2E_OUT=dir] node scripts/qa/r12d-e2e.mjs (dev server running)
// Nothing leaves this machine: every non-local request is aborted.

import { chromium } from "playwright-core";
import fs from "node:fs";

const URL = process.env.E2E_URL ?? "http://localhost:6141";
const OUT = process.env.E2E_OUT ?? "test-results";
fs.mkdirSync(OUT, { recursive: true });
const launch = { headless: true, args: ["--no-sandbox"] };
if (process.env.CHROMIUM) launch.executablePath = process.env.CHROMIUM;
else if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + String(detail).slice(0, 300) : ""}`);
}

// ---------- Fixtures, written by hand in the style of the real exports ----------

/** Lucide "settings": a stroked icon on currentColor, round caps and joins. */
const LUCIDE = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-settings"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>`;

/** Heroicons solid "information-circle": filled, evenodd, the glyph is a hole in the disc. */
const HEROICONS = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="24" height="24"><path fill-rule="evenodd" d="M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12zm8.706-1.442c1.146-.573 2.437.463 2.126 1.706l-.709 2.836.042-.02a.75.75 0 01.67 1.34l-.04.022c-1.147.573-2.438-.463-2.127-1.706l.71-2.836-.042.02a.75.75 0 11-.671-1.34l.041-.022zM12 9a.75.75 0 100-1.5.75.75 0 000 1.5z" clip-rule="evenodd"/></svg>`;

/** Material "info" outline: filled, nonzero, with a transparent 24x24 box path. */
const MATERIAL = `<svg xmlns="http://www.w3.org/2000/svg" height="24" viewBox="0 0 24 24" width="24"><path d="M0 0h24v24H0z" fill="none"/><path d="M11 7h2v2h-2zm0 4h2v6h-2zm1-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/></svg>`;

/** A Figma export: viewport clipPath, gradient fill, rotate and matrix transforms, opacity. */
const FIGMA = `<svg width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg"><g clip-path="url(#clip0_5_9)"><rect width="64" height="64" rx="14" fill="url(#paint0_linear_5_9)"/><g transform="rotate(30 32 32)"><rect x="22" y="10" width="20" height="20" rx="4" stroke="white" stroke-width="3"/></g><circle cx="42" cy="44" r="9" transform="matrix(1 0 0 0.6 0 17.6)" fill="#FFD166" fill-opacity="0.9"/><path d="M12 54L24 38L34 50L40 43L52 58H12Z" fill="white" fill-opacity="0.85"/><path d="M8 8L28 8" stroke="#0B1020" stroke-width="4" stroke-linecap="round" opacity="0.6"/></g><defs><linearGradient id="paint0_linear_5_9" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse"><stop stop-color="#7C5CFF"/><stop offset="1" stop-color="#22D3EE"/></linearGradient><clipPath id="clip0_5_9"><rect width="64" height="64" fill="white"/></clipPath></defs></svg>`;

/** Inherited styles, a <style> block, nested transforms, radial gradient on the bounding box. */
const STYLED = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 32 32" fill="#334155"><style>.a{fill:#e11d48}.b{fill:none;stroke:#0ea5e9;stroke-width:1.5;stroke-linejoin:round}#c{fill:url(#r)}</style><defs><radialGradient id="r"><stop offset="0" stop-color="#fde047"/><stop offset="1" stop-color="#f97316"/></radialGradient></defs><g opacity=".85" transform="translate(2 2) scale(.9)"><g transform="translate(4 0)"><path class="a" d="M2 2h10v10H2z"/><path class="b" d="M2 16l6 8 6-8"/><ellipse id="c" cx="20" cy="8" rx="6" ry="4"/></g><path d="M0 30h30v-3H0z"/><polygon points="22,16 28,28 16,28" stroke="green" stroke-width="1" stroke-dasharray="2 1"/></g></svg>`;

const FIXTURES = { lucide: LUCIDE, heroicons: HEROICONS, material: MATERIAL, figma: FIGMA, styled: STYLED };

const browser = await chromium.launch(launch);
const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 2, acceptDownloads: true });
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new globalThis.URL(URL).origin });
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
const nodes = async () => Object.values((await doc()).nodes);
const byName = async (name) => (await nodes()).find((n) => n.name === name);
const shot = (n) => page.screenshot({ path: `${OUT}/r12d-${n}.png` });
const section = (title) => page.locator(".section", { has: page.locator(".section-head", { hasText: new RegExp(`^${title}$`) }) });
const toasts = () => dt(() => [...document.querySelectorAll(".toast, [role=status], [role=alert]")].map((e) => e.textContent));

async function newFile() {
  await page.goto(URL);
  await page.click("button:has-text('New design file')");
  await page.waitForSelector("#dt-canvas");
  // A new file focuses its "What do you want to design?" prompt; Escape leaves it for the canvas.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await dt(() => window.__dt.setViewport({ zoom: 1, x: 0, y: 0 }));
}
const pasteText = (text) =>
  dt((t) => {
    const d = new DataTransfer();
    d.setData("text/plain", t);
    (document.activeElement || document.body).dispatchEvent(new ClipboardEvent("paste", { clipboardData: d, bubbles: true, cancelable: true }));
  }, text);
const dropFile = (name, mime, text, x, y) =>
  dt(
    ([name, mime, text, x, y]) => {
      const d = new DataTransfer();
      d.items.add(new File([new Blob([text], { type: mime })], name, { type: mime }));
      document.querySelector("#dt-canvas").dispatchEvent(new DragEvent("drop", { dataTransfer: d, clientX: x, clientY: y, bubbles: true, cancelable: true }));
    },
    [name, mime, text, x, y],
  );
const subtree = async (id) => {
  const d = await doc();
  const out = [];
  const walk = (i) => {
    out.push(d.nodes[i]);
    (d.nodes[i].children ?? []).forEach(walk);
  };
  walk(id);
  return out;
};
const newest = async () => {
  const d = await doc();
  return d.nodes[(await dt(() => window.__dt.state().selection))[0]];
};

/** Draws the SVG in the browser, and the imported layers (engine export) at the same size; counts differing pixels. */
async function diff(svg, id, scale = 4) {
  return dt(
    async ([svg, id, scale]) => {
      const load = (markup) =>
        new Promise((res, rej) => {
          const img = new Image();
          img.onload = () => res(img);
          img.onerror = () => rej(new Error("image failed"));
          img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(markup);
        });
      const ours = window.__dt.query({ q: "exportSvg", id });
      const [a, b] = await Promise.all([load(svg.replace(/currentColor/g, "#000000")), load(ours)]);
      const w = Math.round(b.naturalWidth || 64);
      const h = Math.round(b.naturalHeight || 64);
      const draw = (img) => {
        const c = document.createElement("canvas");
        c.width = w * scale;
        c.height = h * scale;
        const g = c.getContext("2d", { willReadFrequently: true });
        g.fillStyle = "#fff";
        g.fillRect(0, 0, c.width, c.height);
        g.drawImage(img, 0, 0, c.width, c.height);
        return { c, d: g.getImageData(0, 0, c.width, c.height).data };
      };
      const A = draw(a);
      const B = draw(b);
      let bad = 0;
      let sum = 0;
      for (let i = 0; i < A.d.length; i += 4) {
        const m = Math.max(Math.abs(A.d[i] - B.d[i]), Math.abs(A.d[i + 1] - B.d[i + 1]), Math.abs(A.d[i + 2] - B.d[i + 2]));
        sum += m;
        if (m > 64) bad++;
      }
      // Side by side for a look: browser on the left, imported layers on the right, and the difference.
      const out = document.createElement("canvas");
      out.width = A.c.width * 3 + 20;
      out.height = A.c.height;
      const g = out.getContext("2d");
      g.fillStyle = "#888";
      g.fillRect(0, 0, out.width, out.height);
      g.drawImage(A.c, 0, 0);
      g.drawImage(B.c, A.c.width + 10, 0);
      const dd = g.createImageData(A.c.width, A.c.height);
      for (let i = 0; i < A.d.length; i += 4) {
        const m = Math.max(Math.abs(A.d[i] - B.d[i]), Math.abs(A.d[i + 1] - B.d[i + 1]), Math.abs(A.d[i + 2] - B.d[i + 2]));
        dd.data[i] = 255;
        dd.data[i + 1] = 255 - m;
        dd.data[i + 2] = 255 - m;
        dd.data[i + 3] = 255;
      }
      g.putImageData(dd, A.c.width * 2 + 20, 0);
      return { w, h, badFraction: bad / (A.d.length / 4), mean: sum / (A.d.length / 4), png: out.toDataURL("image/png") };
    },
    [svg, id, scale],
  );
}

try {
  // ---------- 1. Fidelity against the browser's own rendering ----------
  await newFile();
  // Each one in its own place: an import lands inside the frame under its centre.
  for (const [i, [name, svg]] of Object.entries(FIXTURES).map((e, i) => [i, e])) {
    const r = await dt(([s, n, x]) => window.__dt.dispatch({ op: "importSvg", svg: s, x, y: 300, parent: null, name: n }), [svg, name, 200 + i * 200]);
    const frame = await byName(name);
    check(`fidelity ${name}: imports as a frame of layers`, !!r?.id && frame?.type === "frame" && frame.children.length > 0, JSON.stringify(r?.warnings));
    const sub = await subtree(frame.id);
    check(`fidelity ${name}: no image paint, no text`, sub.every((n) => n.type !== "text" && n.fills.concat(n.strokes).every((p) => p.type !== "image")));
    const d = await diff(svg, frame.id);
    fs.writeFileSync(`${OUT}/r12d-fidelity-${name}.png`, Buffer.from(d.png.split(",")[1], "base64"));
    check(`fidelity ${name}: within 1.5% of the browser's pixels`, d.badFraction < 0.015, `${(d.badFraction * 100).toFixed(2)}% differ by more than 64 (mean ${d.mean.toFixed(2)}), ${d.w}x${d.h}`);
  }
  {
    // What the importer made, in numbers.
    const ic = await byName("lucide");
    const sub = await subtree(ic.id);
    const vec = sub.find((n) => n.type === "vector");
    check("lucide: 24x24 frame, stroked vector, stroke #000000 width 2, round joins, no fill", ic.width === 24 && ic.height === 24 && vec.strokes[0]?.color === "#000000" && vec.strokeWeight === 2 && vec.strokeJoin === "round" && vec.fills.length === 0, JSON.stringify([vec.strokes, vec.strokeWeight, vec.strokeJoin]));
    const plus = await dt((s) => window.__dt.dispatch({ op: "importSvg", svg: s, x: 1500, y: 700, parent: null, name: "plus" }), `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>`);
    const pv = (await subtree(plus.id)).filter((n) => n.type === "vector");
    check("lucide plus: open paths keep their round end caps", pv.length === 2 && pv.every((n) => n.shape?.endCap === "round"), JSON.stringify(pv.map((n) => n.shape)));
    const fg = await byName("figma");
    const fgSub = await subtree(fg.id);
    check("figma export: the viewport clipPath adds no extra frame", fgSub.filter((n) => n.type === "frame").length === 1, `${fgSub.filter((n) => n.type === "frame").length} frames`);
    const ma = await byName("material");
    const ho = await byName("heroicons");
    const hv = (await subtree(ho.id)).find((n) => n.type === "vector");
    check("heroicons: a vector with several subpaths (holes)", hv.vector.subpaths.length >= 3, `${hv.vector.subpaths.length} subpaths`);
    check("material: the invisible 24x24 box path (fill none, no stroke) is skipped", (await subtree(ma.id)).filter((n) => n.type === "vector").length === 1);
  }
  await dt(() => window.__dt.setViewport({ zoom: 6, x: -1500, y: -1500 }));
  await page.waitForTimeout(500);
  await shot("fidelity-canvas");

  // ---------- 2. Paste (text/plain), editability ----------
  await newFile();
  await pasteText(LUCIDE);
  await page.waitForTimeout(700);
  const frame = await newest();
  const sub = await subtree(frame.id);
  const vector = sub.find((n) => n.type === "vector");
  check("paste: Lucide settings becomes a frame of vectors", frame.type === "frame" && frame.name === "SVG" && !!vector && sub.every((n) => n.fills.concat(n.strokes).every((p) => p.type !== "image")), `${sub.length} layers`);
  check("paste: the frame sits at the viewport centre", Math.abs(frame.x + frame.width / 2 - (await dt(() => window.__dt.viewport())).zoom * 0 - (await dt(() => { const r = document.querySelector("#dt-canvas").getBoundingClientRect(); const v = window.__dt.viewport(); return (r.width / 2 - v.x) / v.zoom; }))) < 2);
  const importHint = (await toasts()).join("|");
  check("paste: first paste says how to get an image", /Ctrl\+Shift\+V|⇧⌘V/.test(importHint), importHint);
  // Ctrl+Z once removes the import.
  const before = (await nodes()).length;
  await page.locator("#dt-canvas").focus();
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(300);
  const after = (await nodes()).length;
  check("paste: one Ctrl+Z removes the whole import", after === before - sub.length && !(await byName("SVG")), `${before} -> ${after}`);
  await page.keyboard.press("Control+Shift+z");
  await page.waitForTimeout(300);
  check("paste: redo brings it back", !!(await byName("SVG")));

  // Zoom in on the pasted icon, enter vector edit by double-click on the path, check the anchors.
  const fr = await byName("SVG");
  await dt(
    (f) => {
      const r = document.querySelector("#dt-canvas").getBoundingClientRect();
      window.__dt.setViewport({ zoom: 20, x: r.width / 2 - (f.x + 12) * 20, y: r.height / 2 - (f.y + 12) * 20 });
    },
    fr,
  );
  await page.waitForTimeout(400);
  const cb = await page.locator("#dt-canvas").boundingBox();
  const vp = await dt(() => window.__dt.viewport());
  // The circle layer (an ellipse, r=3 at the centre) and the big path: the path's top edge at y=2.
  const topEdge = { x: cb.x + vp.x + (fr.x + 12.0) * vp.zoom, y: cb.y + vp.y + (fr.y + 2.0) * vp.zoom };
  await page.mouse.dblclick(topEdge.x, topEdge.y);
  await page.waitForTimeout(400);
  const ve = await dt(() => window.__dt.vectorEdit());
  const editedNode = ve.id ? (await doc()).nodes[ve.id] : null;
  check("editability: double-click enters vector edit on the imported path", editedNode?.type === "vector" && editedNode.vector.subpaths.length > 0, JSON.stringify(ve).slice(0, 80));
  const anchors = await dt(() => [...document.querySelectorAll(".vector-anchor")].map((e) => ({ tag: e.tagName.toLowerCase(), r: Number(e.getAttribute("r")), sw: Number(e.getAttribute("stroke-width")) })));
  check("anchors are circles of radius 4 with a 1.5px stroke (no squares)", anchors.length > 5 && anchors.every((a) => a.tag === "circle" && a.r === 4 && a.sw === 1.5), JSON.stringify(anchors[0]));
  const handleStyle = await dt(() => [...document.querySelectorAll("circle.vector-handle")].map((e) => Number(e.getAttribute("r"))));
  const handleHits = await dt(() => [...document.querySelectorAll("circle.handle[data-vpt]")].filter((e) => e.getAttribute("data-vpt").endsWith(":out") || e.getAttribute("data-vpt").endsWith(":in")).map((e) => Number(e.getAttribute("r"))));
  check("control handles are drawn smaller than anchors, with a larger hit circle", handleStyle.every((r) => r < 4) && handleHits.every((r) => r >= 5), JSON.stringify([handleStyle.length, handleHits.length]));
  await page.mouse.click(cb.x + vp.x + (fr.x + 12.0) * vp.zoom, cb.y + vp.y + (fr.y + 2.0) * vp.zoom);
  await shot("vector-edit-anchors");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  // Recolour the stroke red through the panel and see red on the canvas.
  await run({ op: "select", ids: [vector.id] });
  await page.waitForTimeout(300);
  const strokeSwatch = section("Stroke").locator(".swatch").first();
  await strokeSwatch.click();
  await page.waitForSelector(".popover");
  const hex = page.locator(".popover input[aria-label*='Hex' i], .popover input[aria-label*='hex' i]").first();
  if (await hex.count()) {
    await hex.fill("FF0000");
    await hex.press("Enter");
  } else {
    await run({ op: "update", ids: [vector.id], patch: { strokes: [{ type: "solid", color: "#FF0000", opacity: 1, visible: true }] } });
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  check("recolour: the imported path's stroke is red in the document", (await doc()).nodes[vector.id].strokes[0].color.toUpperCase() === "#FF0000");
  const red = await dt(() => {
    const paths = [...document.querySelectorAll("#dt-canvas path[stroke]")];
    return paths.some((p) => /^(#ff0000|rgb\(255, 0, 0\))$/i.test(p.getAttribute("stroke") ?? ""));
  });
  check("recolour: the canvas draws it red", red);
  await dt(() => window.__dt.dispatch({ op: "select", ids: [] }));
  await page.waitForTimeout(300);
  await shot("recoloured");

  // ---------- 3. Drop of an .svg file ----------
  await newFile();
  const DONUT = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><path fill-rule="evenodd" fill="#111111" d="M20 2a18 18 0 1 1 0 36a18 18 0 1 1 0-36zM20 12a8 8 0 1 1 0 16a8 8 0 1 1 0-16z"/></svg>`;
  const cb2 = await page.locator("#dt-canvas").boundingBox();
  await run({ op: "createShape", kind: "frame", x: 400, y: 200, width: 300, height: 300, parent: null });
  await dropFile("donut.svg", "image/svg+xml", DONUT, cb2.x + 500, cb2.y + 300);
  await page.waitForTimeout(800);
  const donut = await byName("donut");
  const dsub = donut ? await subtree(donut.id) : [];
  check("drop: an .svg file becomes vectors named after the file", donut?.type === "frame" && dsub.some((n) => n.type === "vector") && dsub.every((n) => n.fills.concat(n.strokes).every((p) => p.type !== "image")));
  check("drop: it lands in the frame under the pointer", !!donut?.parent);
  // Zoom to the donut and probe pixels: the ring is dark, the hole is not.
  await dt(
    (d) => {
      const f = window.__dt.doc().nodes[d.parent];
      const r = document.querySelector("#dt-canvas").getBoundingClientRect();
      window.__dt.setViewport({ zoom: 6, x: r.width / 2 - (f.x + d.x + 20) * 6, y: r.height / 2 - (f.y + d.y + 20) * 6 });
      window.__dt.dispatch({ op: "select", ids: [] });
    },
    donut,
  );
  await page.waitForTimeout(500);
  const centre = { x: cb2.x + cb2.width / 2, y: cb2.y + cb2.height / 2 };
  const probe = async (dx, dy) => {
    const buf = await page.screenshot({ clip: { x: centre.x + dx, y: centre.y + dy, width: 1, height: 1 } });
    return dt(
      (b64) =>
        new Promise((res) => {
          const img = new Image();
          img.onload = () => {
            const c = document.createElement("canvas");
            c.width = c.height = 1;
            const g = c.getContext("2d");
            g.drawImage(img, 0, 0);
            res(Array.from(g.getImageData(0, 0, 1, 1).data));
          };
          img.src = "data:image/png;base64," + b64;
        }),
      buf.toString("base64"),
    );
  };
  const ring = await probe(13 * 6, 0);
  const hole = await probe(0, 0);
  const holeFar = await probe(0, 6 * 6);
  check("drop: the ring is dark and the hole is transparent (shows the frame behind)", ring[0] < 60 && hole[0] > 200 && holeFar[0] > 200, `ring ${ring} hole ${hole} ${holeFar}`);
  await shot("drop-donut");

  // ---------- 4. Ctrl+Shift+V still pastes an image ----------
  await newFile();
  await page.evaluate((t) => navigator.clipboard.writeText(t), LUCIDE);
  await page.locator("#dt-canvas").focus();
  await page.keyboard.press("Control+Shift+v");
  await page.waitForTimeout(900);
  const asImage = (await nodes()).filter((n) => n.fills.some((p) => p.type === "image"));
  check("Ctrl+Shift+V pastes the SVG as an image, not vectors", asImage.length === 1 && !(await nodes()).some((n) => n.type === "vector"), `${asImage.length} image layers`);

  // ---------- 5. Fallbacks ----------
  await newFile();
  await pasteText(`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40" viewBox="0 0 120 40"><rect width="120" height="40" fill="#eee"/><text x="8" y="26" font-size="18">Hello</text></svg>`);
  await page.waitForTimeout(900);
  const textSvg = (await nodes()).filter((n) => n.fills.some((p) => p.type === "image"));
  const t1 = (await toasts()).join("|");
  check("fallback: an SVG with <text> is placed as an image", textSvg.length === 1 && textSvg[0].name === "SVG" && !(await nodes()).some((n) => n.type === "vector"));
  check("fallback: the toast says why", /Placed as an image: this SVG uses text/.test(t1), t1);
  await newFile();
  const big = `<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50" viewBox="0 0 50 50"><path d="M0 0L50 50" stroke="#000"/><!-- ${"x".repeat(3 * 1024 * 1024)} --></svg>`;
  await pasteText(big);
  await page.waitForTimeout(1500);
  const bigImg = (await nodes()).filter((n) => n.fills.some((p) => p.type === "image"));
  const t2 = (await toasts()).join("|");
  check("fallback: a 3 MB SVG is placed as an image with a toast", bigImg.length === 1 && /more than 2 MB/.test(t2), t2);
  const nBefore = (await nodes()).length;
  const refused = await dt(() => window.__dt.dispatch({ op: "importSvg", svg: '<!DOCTYPE svg [<!ENTITY a "b">]><svg width="1" height="1"><rect width="1" height="1"/></svg>', x: 0, y: 0, parent: null, name: null }));
  check("an entity declaration is refused by the engine and changes nothing", refused === null && (await nodes()).length === nBefore, String(refused));

  // ---------- 6. Panel: Square end, closed paths, Crop label ----------
  await newFile();
  await dt(() =>
    window.__dt.tool("create_nodes", {
      nodes: [
        { type: "line", name: "Line", x: 100, y: 100, width: 120, stroke: "#000000", strokeWidth: 12 },
        { type: "vector", name: "Tri", x: 100, y: 200, width: 60, height: 60, svgPath: "M30 0L60 60H0Z", fill: "#cccccc" },
        { type: "vector", name: "Open", x: 300, y: 200, width: 60, height: 60, svgPath: "M0 0L60 30L0 60", stroke: "#000000" },
        { type: "rectangle", name: "Pic", x: 100, y: 400, width: 200, height: 100, fill: "#CCCCCC" },
      ],
    }),
  );
  await page.waitForTimeout(300);
  const select = async (name) => {
    const n = await byName(name);
    await run({ op: "select", ids: [n.id] });
    await page.waitForTimeout(250);
    return n;
  };
  const line = await select("Line");
  await page.locator('select[aria-label="Line end"]').selectOption("square");
  await page.waitForTimeout(300);
  const lineNode = (await doc()).nodes[line.id];
  check("line: the Line end menu has Square and sets it", lineNode.shape?.endCap === "square");
  const lsvg = await dt((id) => window.__dt.query({ q: "exportSvg", id }), line.id);
  // Since r18d the start and end caps are separate: a Square end with a flat (None) start draws a butt
  // body plus a square end marker; both ends Square use the plain square linecap.
  check("line: the Square end renders square (linecap or end marker)", /stroke-linecap="square"/.test(lsvg) || (/marker-end=/.test(lsvg) && /<marker/.test(lsvg)), (lsvg.match(/<path[^>]*>|<line[^>]*>/) ?? [""])[0]);
  await select("Tri");
  check("closed triangle: no Line end select", (await page.locator('select[aria-label="Line end"]').count()) === 0);
  await select("Open");
  check("open vector: has the Line end select", (await page.locator('select[aria-label="Line end"]').count()) === 1);
  // A drawn closed shape (subpaths) too.
  await run({ op: "select", ids: [] });
  const sqId = await dt(() => window.__dt.dispatch({ op: "createShape", kind: "rectangle", x: 600, y: 100, width: 50, height: 50, parent: null }).id);
  await run({ op: "flatten", ids: [sqId] });
  await page.waitForTimeout(300);
  const flat = (await doc()).nodes[(await dt(() => window.__dt.state().selection))[0]];
  check("flattened closed shape: no Line end select", flat?.type === "vector" && flat.vector.subpaths.every((s) => s.closed) && (await page.locator('select[aria-label="Line end"]').count()) === 0);

  await select("Pic");
  const pic = await byName("Pic");
  const src = await dt(() => {
    const c = document.createElement("canvas");
    c.width = 40;
    c.height = 20;
    const g = c.getContext("2d");
    g.fillStyle = "#f00";
    g.fillRect(0, 0, 20, 20);
    return c.toDataURL("image/png");
  });
  await run({ op: "update", ids: [pic.id], patch: { fills: [{ type: "image", src, scaleMode: "fill", opacity: 1, visible: true }] } });
  await page.waitForTimeout(300);
  await section("Fill").locator(".swatch").first().click();
  await page.waitForSelector(".popover");
  const sel = page.locator('.popover select[aria-label="Image scale mode"]');
  await sel.selectOption("crop");
  await page.waitForTimeout(500);
  const fit = await sel.evaluate((s) => {
    const cs = getComputedStyle(s);
    const ctx = document.createElement("canvas").getContext("2d");
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const label = s.options[s.selectedIndex].text;
    const text = ctx.measureText(label).width;
    const room = s.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 16;
    return { label, text, width: s.getBoundingClientRect().width, room };
  });
  check("Crop: the scale mode select shows the whole word", fit.label === "Crop" && fit.text <= fit.room && fit.width >= 80, JSON.stringify(fit));
  const onOwnRow = await sel.evaluate((s) => {
    const row = s.closest(".row");
    return row ? row.querySelectorAll("button").length : -1;
  });
  check("Crop: the select has a row of its own (no buttons beside it)", onOwnRow === 0, String(onOwnRow));
  await shot("crop-label");
  await page.keyboard.press("Escape");

  // ---------- 7. Claude's create_nodes with svg ----------
  await newFile();
  const made = await dt((s) => window.__dt.tool("create_nodes", { nodes: [{ type: "svg", svg: s, name: "gear", x: 50, y: 60, width: 48, height: 48 }] }), LUCIDE);
  const gear = await byName("gear");
  const gsub = gear ? await subtree(gear.id) : [];
  check("create_nodes svg: editable vectors at the requested size", !!gear && gear.width === 48 && gsub.some((n) => n.type === "vector" && n.vector.subpaths.length > 0 && n.strokeWeight === 4), JSON.stringify(made).slice(0, 120));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
