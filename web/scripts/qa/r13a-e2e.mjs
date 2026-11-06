// Round 13, package A: getting work in and out.
//   S-01 file names (Unicode, dots, hostile names, zip-slip), S-02 .dtron drop on the dashboard and
//   the window drop guard, raster-in-PDF export (Export section button, File > Export frames to
//   PDF), typed export scale, hidden-layer export toast, new interactions (Instant, then the last
//   one used), Figma interactions and import warnings, S-04 accessible names from overlaid text.
// Usage: serve web/dist (vite preview) and run `E2E_URL=http://localhost:6315 node scripts/qa/r13a-e2e.mjs`.
// Env: E2E_URL, CHROMIUM (executable path), E2E_SHOTS (folder for screenshots), E2E_DL (folder for downloads).
// Only local servers are used: every other request is aborted.

import { chromium } from "playwright-core";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const require = createRequire(import.meta.url);
const JSZip = require("jszip");

const URL = process.env.E2E_URL ?? "http://localhost:5173";
const SHOTS = process.env.E2E_SHOTS;
const DL = process.env.E2E_DL ?? fs.mkdtempSync(path.join(os.tmpdir(), "r13a-"));
fs.mkdirSync(DL, { recursive: true });
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const FIX = path.join(path.dirname(new globalThis.URL(import.meta.url).pathname), "..", "fixtures");
const launch = { headless: true, args: ["--no-sandbox"] };
if (process.env.CHROMIUM) launch.executablePath = process.env.CHROMIUM;
else if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + String(detail).slice(0, 500) : ""}`);
}

const browser = await chromium.launch(launch);
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1, acceptDownloads: true });
await context.route("**/*", (r) => (/^(http:\/\/(localhost|127\.0\.0\.1)|data:|blob:|ws:|wss:)/.test(r.request().url()) ? r.continue() : r.abort()));
await context.addInitScript(() => {
  try {
    localStorage.setItem("dt:tour-done", "1");
  } catch {
    /* no storage */
  }
  // Headless Chromium reports "download" for a non-ASCII file name (real browsers keep it), so
  // the name the page asks for is recorded as well.
  window.__dlNames = [];
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download) window.__dlNames.push(this.download);
    return click.call(this);
  };
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

const doc = () => page.evaluate(() => window.__dt.doc());
const byName = async (name) => Object.values((await doc()).nodes).find((n) => n.name === name);
const select = async (...names) => {
  const ids = [];
  for (const n of names) ids.push((await byName(n)).id);
  await page.evaluate((i) => window.__dt.dispatch({ op: "select", ids: i }), ids);
  await page.waitForTimeout(150);
};
const shot = (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, name + ".png") });
const toasts = () => page.locator(".toast").allInnerTexts();
const exportSection = () => page.locator(".section", { has: page.locator(".section-head", { hasText: "Export" }) });
const exportBtn = () => exportSection().locator(".export-actions button").first();
const pdfBtn = () => exportSection().getByRole("button", { name: "PDF", exact: true });
const sizeField = () => exportSection().getByLabel("Export scale").first();

async function download(trigger, name) {
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 30000 }), trigger()]);
  const file = path.join(DL, name ?? `dl-${Date.now()}`);
  await dl.saveAs(file);
  const asked = await page.evaluate(() => window.__dlNames.at(-1));
  return { name: asked ?? dl.suggestedFilename(), bytes: fs.readFileSync(file), file };
}
const pngSize = (b) => ({ w: b.readUInt32BE(16), h: b.readUInt32BE(20) });

/** A PDF's structure: xref offsets checked against the objects they name, pages, boxes, images. */
function parsePdf(buf) {
  const text = buf.toString("latin1");
  const out = { ok: true, why: "", pages: 0, boxes: [], images: [], masks: 0, streams: [] };
  const fail = (why) => ((out.ok = false), (out.why ||= why));
  if (!text.startsWith("%PDF-1.4\n")) fail("header");
  if (!text.trimEnd().endsWith("%%EOF")) fail("trailer");
  const sx = text.match(/startxref\n(\d+)\n%%EOF\n$/);
  if (!sx) return fail("startxref"), out;
  const xrefAt = Number(sx[1]);
  const head = text.slice(xrefAt).match(/^xref\n0 (\d+)\n/);
  if (!head) return fail("xref"), out;
  const count = Number(head[1]);
  const rows = text.slice(xrefAt + head[0].length).split("\n").slice(0, count);
  for (let n = 1; n < count; n++) {
    const off = Number(rows[n].slice(0, 10));
    if (text.slice(off, off + `${n} 0 obj\n`.length) !== `${n} 0 obj\n`) fail(`xref offset of object ${n}`);
  }
  out.pages = Number(text.match(/\/Type \/Pages \/Count (\d+)/)?.[1] ?? -1);
  out.boxes = [...text.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map((m) => [Number(m[1]), Number(m[2])]);
  out.masks = (text.match(/\/SMask \d+ 0 R/g) ?? []).length;
  for (const m of text.matchAll(/<< (\/Type \/XObject \/Subtype \/Image[^>]*?) \/Length (\d+) >>\nstream\n/g)) {
    const len = Number(m[2]);
    const at = m.index + m[0].length;
    const data = buf.subarray(at, at + len);
    if (text.slice(at + len, at + len + 14) !== "\nendstream\nend") fail("stream length");
    let raw = null;
    try {
      raw = zlib.inflateSync(data);
    } catch {
      fail("stream does not inflate");
    }
    out.images.push({ w: Number(m[1].match(/\/Width (\d+)/)[1]), h: Number(m[1].match(/\/Height (\d+)/)[1]), gray: m[1].includes("DeviceGray"), raw });
  }
  return out;
}

async function newFile() {
  await page.goto(URL + "/#/");
  await page.waitForSelector(".files", { timeout: 30000 });
  await page.click("button:has-text('New design file')");
  await page.waitForSelector("#dt-canvas");
  await page.waitForFunction(() => !!window.__dt?.doc);
}
const create = (nodes, parentId = null) => page.evaluate(([n, p]) => window.__dt.tool("create_nodes", { parentId: p, nodes: n }), [nodes, parentId]);
const openMenu = async () => {
  await page.locator('button[aria-haspopup="menu"]').first().click();
};
const dropFiles = (selector, files, types = ["dragenter", "dragover", "drop"]) =>
  page.evaluate(
    ([sel, fs_, ts]) => {
      const dt = new DataTransfer();
      for (const f of fs_) dt.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name, { type: f.type }));
      const el = document.querySelector(sel);
      return ts.map((t) => {
        const ev = new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt });
        el.dispatchEvent(ev);
        return ev.defaultPrevented;
      });
    },
    [selector, files.map((f) => ({ ...f, b64: f.bytes.toString("base64") })), types],
  );
const tinyPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");

try {
  // ---------------------------------------------------------------- S-01 names
  await newFile();
  await create([
    { type: "rectangle", name: "logo.v2", x: 0, y: 0, width: 40, height: 40, fill: "#FF0000" },
    { type: "rectangle", name: "Café icon", x: 60, y: 0, width: 40, height: 40, fill: "#00FF00" },
    { type: "rectangle", name: "日本語", x: 120, y: 0, width: 40, height: 40, fill: "#0000FF" },
    { type: "rectangle", name: "中文", x: 180, y: 0, width: 40, height: 40, fill: "#FFFF00" },
    { type: "rectangle", name: "CON", x: 240, y: 0, width: 40, height: 40, fill: "#00FFFF" },
    { type: "rectangle", name: "photo‮gnp.exe", x: 300, y: 0, width: 40, height: 40, fill: "#FF00FF" },
    { type: "rectangle", name: "../../evil", x: 360, y: 0, width: 40, height: 40, fill: "#888888" },
    { type: "rectangle", name: "a/../b", x: 420, y: 0, width: 40, height: 40, fill: "#444444" },
  ]);
  for (const [layer, want] of [
    ["logo.v2", "logo.v2.png"],
    ["Café icon", "Café icon.png"],
    ["日本語", "日本語.png"],
    ["CON", "_CON.png"],
    ["photo‮gnp.exe", "photognp.exe.png"],
  ]) {
    await select(layer);
    const f = await download(() => exportBtn().click());
    check(`file name: "${layer}" downloads as "${want}"`, f.name === want, f.name);
    if (layer === "logo.v2") check("file name: the PNG is a real image", f.bytes.subarray(1, 4).toString() === "PNG" && pngSize(f.bytes).w === 40);
  }
  await select("日本語", "中文");
  const cjk = await download(() => exportBtn().click());
  const cjkZip = await JSZip.loadAsync(cjk.bytes);
  check("file name: two CJK layers give a zip with both names", Object.keys(cjkZip.files).sort().join() === ["中文.png", "日本語.png"].join(), Object.keys(cjkZip.files).join());
  check("file name: the zip is named after the document, not 'export'", cjk.name.endsWith(".zip") && cjk.name !== "export.zip", cjk.name);
  await select("../../evil", "a/../b", "logo.v2");
  const evil = await download(() => exportBtn().click());
  const evilNames = Object.keys((await JSZip.loadAsync(evil.bytes)).files);
  check(
    "zip-slip: no entry climbs out of the zip or starts at the root",
    evilNames.length >= 3 && evilNames.every((n) => !n.split("/").includes("..") && !n.startsWith("/") && !n.includes("\\")),
    evilNames.join(" | "),
  );
  await select("../../evil");
  const evilOne = await download(() => exportBtn().click());
  check("zip-slip: a single download never carries a slash or '..'", !evilOne.name.includes("/") && !evilOne.name.startsWith(".."), evilOne.name);
  // The .dtron name follows the same rules.
  await page.evaluate(() => window.__dt.dispatch({ op: "setDocName", name: "Q4/../plan: v2?" }));
  await openMenu();
  const dt = await download(() => page.getByRole("menuitem", { name: /Save as \.dtron/ }).click());
  check(".dtron: the file name is made safe", dt.name === "Q4..plan v2.dtron", dt.name);

  // ---------------------------------------------------------------- typed scale (G6)
  await newFile();
  await create([
    { type: "frame", name: "Home", x: 0, y: 0, width: 390, height: 844, fill: "#3366FF" },
    { type: "frame", name: "Settings", x: 500, y: 0, width: 390, height: 844, fill: "#33AA66" },
    { type: "frame", name: "Profile", x: 1000, y: 0, width: 390, height: 844, fill: "#CC5533" },
  ]);
  await select("Home");
  const typed = async (text) => {
    const f = sizeField();
    await f.click();
    await f.fill(text);
    await f.press("Enter");
    await page.waitForTimeout(150);
  };
  await typed("2.5x");
  check("typed scale: 2.5x shows as 2.5x", (await sizeField().inputValue()) === "2.5x");
  let f = await download(() => exportBtn().click());
  check("typed scale: 2.5x exports Home at 975x2110", pngSize(f.bytes).w === 975 && pngSize(f.bytes).h === 2110 && f.name === "Home@2.5x.png", `${JSON.stringify(pngSize(f.bytes))} ${f.name}`);
  await typed("512w");
  check("typed scale: 512w shows as 512w with a width field", (await sizeField().inputValue()) === "512w" && (await exportSection().getByLabel("Export size").count()) === 1);
  const row = (await byName("Home")).exportSettings[0];
  check("typed scale: 512w is stored as width 512", row.width === 512, JSON.stringify(row));
  f = await download(() => exportBtn().click());
  check("typed scale: 512w exports 512 px wide", pngSize(f.bytes).w === 512 && f.name === "Home@512w.png", `${JSON.stringify(pngSize(f.bytes))} ${f.name}`);
  await typed("300H");
  f = await download(() => exportBtn().click());
  check("typed scale: 300H exports 300 px tall", pngSize(f.bytes).h === 300, JSON.stringify(pngSize(f.bytes)));
  await typed("abc");
  check("typed scale: bad input puts the old value back", (await sizeField().inputValue()) === "300h");
  await typed("99");
  check("typed scale: 99 is clamped to 32x", (await sizeField().inputValue()) === "32x" && (await byName("Home")).exportSettings[0].scale === 32);
  await typed("0");
  check("typed scale: 0 puts the old value back", (await sizeField().inputValue()) === "32x");
  await typed("1.5");
  check("typed scale: a bare number is a scale", (await sizeField().inputValue()) === "1.5x");
  check("typed scale: the presets are offered as a list", (await page.locator("datalist option").count()) >= 7);
  await shot("export-section");

  // ---------------------------------------------------------------- PDF (G1)
  await typed("1x");
  await select("Home");
  f = await download(() => pdfBtn().click());
  let pdf = parsePdf(f.bytes);
  check("pdf: Home downloads as Home.pdf", f.name === "Home.pdf", f.name);
  check("pdf: valid structure (header, xref offsets, trailer, streams inflate)", pdf.ok, pdf.why);
  check("pdf: one page of 390x844 pt", pdf.pages === 1 && pdf.boxes.length === 1 && pdf.boxes[0][0] === 390 && pdf.boxes[0][1] === 844, JSON.stringify(pdf.boxes));
  check("pdf: the image is 780x1688", pdf.images.length === 1 && pdf.images[0].w === 780 && pdf.images[0].h === 1688, JSON.stringify(pdf.images.map((i) => [i.w, i.h])));
  const px = pdf.images[0]?.raw;
  check("pdf: the pixels are the frame's colour (#3366FF) and fill the page", !!px && px.length === 780 * 1688 * 3 && px[0] === 0x33 && px[1] === 0x66 && px[2] === 0xff && px[px.length - 3] === 0x33, px && `${px.length} ${px[0]},${px[1]},${px[2]}`);
  check("pdf: an opaque page has no soft mask", pdf.masks === 0);
  try {
    const info = execFileSync("pdfinfo", [f.file]).toString();
    check("pdf: poppler reads it (1 page, 390 x 844 pts)", /Pages:\s+1/.test(info) && /Page size:\s+390 x 844 pts/.test(info), info.split("\n").find((l) => l.startsWith("Page size")));
    const out = path.join(DL, "home-render");
    execFileSync("pdftoppm", ["-png", "-r", "72", "-singlefile", f.file, out]);
    const png = fs.readFileSync(out + ".png");
    const rgb = execFileSync("python3", ["-I", "-c", "import sys,struct,zlib\nd=open(sys.argv[1],'rb').read()\nprint(struct.unpack('>II',d[16:24]))", out + ".png"]).toString();
    check("pdf: poppler renders it at 390x844", rgb.trim() === "(390, 844)", rgb.trim());
    if (SHOTS) fs.copyFileSync(out + ".png", path.join(SHOTS, "pdf-home-render.png"));
    void png;
  } catch (err) {
    console.log("INFO  poppler not available, structure checked only:", String(err).slice(0, 80));
  }
  // A layer with transparency gets a soft mask.
  await create([{ type: "ellipse", name: "Dot", x: 2000, y: 0, width: 60, height: 60, fill: "#FF0000" }]);
  await select("Dot");
  f = await download(() => pdfBtn().click());
  pdf = parsePdf(f.bytes);
  check("pdf: a layer with transparent corners gets a gray soft mask", pdf.ok && pdf.masks === 1 && pdf.images.some((i) => i.gray && i.raw.length === i.w * i.h && i.raw[0] === 0), `masks=${pdf.masks} ${pdf.why}`);
  check("pdf: its page is 60x60 and the image 120x120", pdf.boxes[0]?.join() === "60,60" && pdf.images[0]?.w === 120, JSON.stringify(pdf.boxes));
  // File > Export frames to PDF, nothing selected: every frame of the page, in layer order.
  await page.evaluate(() => window.__dt.dispatch({ op: "select", ids: [] }));
  await page.waitForTimeout(150);
  await openMenu();
  f = await download(() => page.getByRole("menuitem", { name: /Export frames to PDF/ }).click());
  pdf = parsePdf(f.bytes);
  const fram = ["Home", "Settings", "Profile"].length;
  check("pdf: Export frames to PDF on a 3-frame page gives /Count 3", pdf.ok && pdf.pages === 3 && pdf.boxes.length === 3, `${pdf.pages} ${pdf.why}`);
  check("pdf: the pages are the frames in layer order (blue, green, orange)", pdf.images.length >= 3 && [[0x33, 0x66, 0xff], [0x33, 0xaa, 0x66], [0xcc, 0x55, 0x33]].every((c, i) => pdf.images[i].raw[0] === c[0] && pdf.images[i].raw[1] === c[1] && pdf.images[i].raw[2] === c[2]), "");
  check("pdf: a document PDF is named after the document", f.name.endsWith(".pdf") && f.name !== "export.pdf", f.name);
  void fram;
  try {
    const info = execFileSync("pdfinfo", [f.file]).toString();
    check("pdf: poppler reads the 3-page file", /Pages:\s+3/.test(info), info.split("\n").find((l) => l.startsWith("Pages")));
    const out = path.join(DL, "frames-render");
    execFileSync("pdftoppm", ["-png", "-r", "20", "-f", "2", "-l", "2", "-singlefile", f.file, out]);
    if (SHOTS) fs.copyFileSync(out + ".png", path.join(SHOTS, "pdf-page2-render.png"));
  } catch {
    /* no poppler */
  }
  // With a selection the menu command takes the selection.
  await select("Settings", "Profile");
  await openMenu();
  f = await download(() => page.getByRole("menuitem", { name: /Export frames to PDF/ }).click());
  check("pdf: with two frames selected the PDF has 2 pages", parsePdf(f.bytes).pages === 2);
  // An empty page says so.
  await newFile();
  await openMenu();
  await page.getByRole("menuitem", { name: /Export frames to PDF/ }).click();
  await page.waitForTimeout(300);
  check("pdf: nothing to export gives a toast", (await toasts()).some((t) => /Select a layer, or add a frame/.test(t)), (await toasts()).join("|"));

  // ---------------------------------------------------------------- hidden layer (S-05)
  await newFile();
  await create([{ type: "rectangle", name: "Ghost", x: 0, y: 0, width: 50, height: 50, fill: "#FF0000" }]);
  await page.evaluate((id) => window.__dt.dispatch({ op: "update", ids: [id], patch: { visible: false } }), (await byName("Ghost")).id);
  await select("Ghost");
  await download(() => exportBtn().click()).catch(() => null);
  check("hidden layer: exporting says the layer is hidden", (await toasts()).some((t) => /Ghost is hidden, so its export is empty/.test(t)), (await toasts()).join("|"));
  await page.waitForTimeout(100);
  await download(() => pdfBtn().click()).catch(() => null);
  check("hidden layer: the PDF button says so too", (await toasts()).some((t) => /Ghost is hidden/.test(t)));

  // ---------------------------------------------------------------- new interaction defaults (U3)
  await newFile();
  await create([
    { type: "frame", name: "One", x: 0, y: 0, width: 300, height: 300 },
    { type: "frame", name: "Two", x: 400, y: 0, width: 300, height: 300 },
    { type: "rectangle", name: "Btn", x: 20, y: 20, width: 100, height: 40, parentId: undefined },
  ]);
  await select("One");
  await page.getByRole("tab", { name: "Prototype" }).click();
  await page.getByRole("button", { name: "Add interaction" }).click();
  await page.waitForTimeout(150);
  const transitions = () => page.getByLabel("Transition").evaluateAll((els) => els.map((e) => e.value ?? e.textContent));
  let ts = await transitions();
  check("interaction: a new one starts Instant", ts.length === 1 && ts[0] === "instant", JSON.stringify(ts));
  check("interaction: Instant hides the duration and easing", (await page.getByLabel("Duration (ms)").count()) === 0);
  await page.getByLabel("Transition").first().selectOption("smartAnimate");
  await page.waitForTimeout(150);
  await page.getByLabel("Duration (ms)").first().fill("450");
  await page.getByLabel("Duration (ms)").first().press("Enter");
  await page.getByLabel("Easing").first().selectOption("easeInOut");
  await page.waitForTimeout(150);
  await select("Two");
  await page.getByRole("button", { name: "Add interaction" }).click();
  await page.waitForTimeout(150);
  ts = await transitions();
  check("interaction: the next new one reuses Smart animate", ts[0] === "smartAnimate", JSON.stringify(ts));
  const two = (await byName("Two")).interactions[0];
  check("interaction: with the last duration and easing", two.durationMs === 450 && two.easing === "easeInOut", JSON.stringify(two));
  await page.getByLabel("Transition").first().selectOption("instant");
  await select("One");
  await page.getByRole("button", { name: "Add interaction" }).click();
  await page.waitForTimeout(150);
  check("interaction: choosing Instant again is remembered", (await byName("One")).interactions.at(-1).transition === "instant");
  await newFile();
  await create([
    { type: "frame", name: "Three", x: 0, y: 0, width: 300, height: 300 },
    { type: "frame", name: "Four", x: 400, y: 0, width: 300, height: 300 },
  ]);
  await select("Three");
  await page.getByRole("tab", { name: "Prototype" }).click();
  await page.getByRole("button", { name: "Add interaction" }).click();
  await page.waitForTimeout(150);
  check("interaction: still Instant in the next file this session (Instant was the last choice)", (await byName("Three")).interactions.at(-1).transition === "instant");
  await page.goto(URL + "/#/");
  await page.reload();
  await page.waitForSelector(".files");
  await page.click("button:has-text('New design file')");
  await page.waitForSelector("#dt-canvas");
  await page.waitForFunction(() => !!window.__dt?.doc);
  await create([{ type: "frame", name: "Five", x: 0, y: 0, width: 300, height: 300 }]);
  await select("Five");
  await page.getByRole("tab", { name: "Prototype" }).click();
  await page.getByRole("button", { name: "Add interaction" }).click();
  await page.waitForTimeout(150);
  check("interaction: a fresh session starts Instant again", (await byName("Five")).interactions.at(-1).transition === "instant");
  await shot("interaction-instant");

  // ---------------------------------------------------------------- dashboard drop (S-02)
  const dtronOf = async (name) => {
    await newFile();
    await create([{ type: "rectangle", name: `${name} box`, x: 0, y: 0, width: 40, height: 40 }]);
    await page.evaluate((n) => window.__dt.dispatch({ op: "setDocName", name: n }), name);
    await page.waitForTimeout(200);
    await openMenu();
    const f = await download(() => page.getByRole("menuitem", { name: /Save as \.dtron/ }).click());
    return { name: `${name}.dtron`, bytes: f.bytes, type: "application/json" };
  };
  const A = await dtronOf("DropA");
  const B = await dtronOf("DropB");
  await page.goto(URL + "/#/");
  await page.waitForSelector(".files");
  await page.waitForTimeout(400);
  const cards = () => page.locator(".file-card").count();
  let before = await cards();
  const dragEnter = await dropFiles(".dash", [A], ["dragenter"]);
  await page.waitForTimeout(100);
  check("dashboard drop: dragging a file over shows the drop overlay", (await page.locator(".dash-drop[role=status]").innerText().catch(() => "")) === "Drop .dtron files to open them", String(dragEnter));
  await shot("dashboard-drop-overlay");
  await page.evaluate(() => document.querySelector(".dash").dispatchEvent(new DragEvent("dragleave", { bubbles: true, cancelable: true, relatedTarget: document.body })));
  await page.waitForTimeout(100);
  check("dashboard drop: leaving hides the overlay", (await page.locator(".dash-drop").count()) === 0);
  await dropFiles(".dash", [A]);
  await page.waitForFunction(() => location.hash.startsWith("#/file/"), null, { timeout: 15000 }).catch(() => {});
  check("dashboard drop: one .dtron opens it", /^#\/file\//.test(await page.evaluate(() => location.hash)));
  await page.waitForFunction(() => !!window.__dt?.doc);
  check("dashboard drop: the opened file is the dropped one", (await doc()).name === "DropA");
  await page.goto(URL + "/#/");
  await page.waitForSelector(".files");
  await page.waitForTimeout(400);
  before = await cards();
  await dropFiles(".dash", [A, B]);
  await page.waitForTimeout(1500);
  check("dashboard drop: two files stay on the dashboard with both listed", (await page.evaluate(() => location.hash)) === "#/" && (await cards()) === before + 2, `${before} -> ${await cards()}`);
  check("dashboard drop: and say how many were imported", (await toasts()).some((t) => /Imported 2 files/.test(t)), (await toasts()).join("|"));
  await shot("dashboard-after-drop");
  await page.waitForTimeout(100);
  const n0 = await cards();
  await dropFiles(".dash", [{ name: "photo.png", bytes: tinyPng, type: "image/png" }]);
  await page.waitForTimeout(400);
  check("dashboard drop: a .png gives the explaining toast and imports nothing", (await toasts()).some((t) => /Only \.dtron files open here\. Drop images onto a file's canvas\./.test(t)) && (await cards()) === n0, (await toasts()).join("|"));
  await dropFiles(".dash", [{ name: "bad.dtron", bytes: Buffer.from("not json"), type: "application/json" }]);
  await page.waitForTimeout(400);
  check("dashboard drop: a damaged .dtron shows the existing error", (await toasts()).some((t) => /bad\.dtron: That isn't a Designotron file/.test(t)), (await toasts()).join("|"));
  // An internal drag of a file onto a folder still moves it.
  await page.evaluate(() => (location.hash = "#/"));
  await page.locator('button[aria-label="New project"]').click();
  await page.waitForSelector('input[aria-label="Folder name"]');
  await page.keyboard.press("Control+a");
  await page.keyboard.type("Beta");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  await page.evaluate(() => (location.hash = "#/"));
  await page.waitForSelector(".file-card");
  const beta = page.locator('[role=tree] [role=treeitem][aria-label="Beta"]');
  if (await beta.count()) {
    await page.dragAndDrop('.file-card:has(.n:text-is("DropA")) >> nth=0', '[role=tree] [role=treeitem][aria-label="Beta"]');
    await page.waitForTimeout(600);
    check("dashboard drop: dragging a file onto a project still moves it", (await toasts()).some((t) => /Moved .* to Beta/.test(t)) && (await page.locator(".dash-drop").count()) === 0, (await toasts()).join("|"));
  } else {
    check("dashboard drop: dragging a file onto a project still moves it", false, "could not create the project");
  }

  // ---------------------------------------------------------------- window drop guard (S-02)
  await newFile();
  const hash = await page.evaluate(() => location.hash);
  const png = { name: "photo.png", bytes: tinyPng, type: "image/png" };
  const panelSel = ".left-panel, .layers, [aria-label='Layers'], .panel";
  const prevented = await dropFiles(panelSel, [png]);
  check("drop guard: dragover and drop on a panel are cancelled (the browser would open the file)", prevented[1] === true && prevented[2] === true, JSON.stringify(prevented));
  await page.waitForTimeout(300);
  check("drop guard: the editor is still there", (await page.evaluate(() => location.hash)) === hash && (await page.locator("#dt-canvas").count()) === 1);
  const text = await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "hello");
    const ev = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt });
    document.body.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  check("drop guard: a drag of plain text is left alone", text === false);
  const before2 = Object.keys((await doc()).nodes).length;
  await dropFiles("#dt-canvas", [png]);
  await page.waitForTimeout(1200);
  check("drop guard: the canvas still takes a dropped image", Object.keys((await doc()).nodes).length > before2);

  // ---------------------------------------------------------------- Figma import (S-03, S-06)
  const importFigma = async (file) => {
    await newFile();
    await openMenu();
    await page.getByRole("menuitem", { name: "Import from Figma…" }).click();
    await page.waitForSelector('[aria-label="Import from Figma"]');
    await page.getByRole("button", { name: /Open JSON export/ }).click();
    await page.locator('[aria-label="Import from Figma"] input[type=file]').setInputFiles(path.join(FIX, file));
    await page.waitForTimeout(1500);
  };
  await importFigma("figma-rich.json");
  const links = Object.values((await doc()).nodes).filter((n) => n.interactions?.length);
  const d1 = await doc();
  const named = (n) => d1.nodes[n]?.name;
  const rich = links.map((n) => ({ from: n.name, ...n.interactions[0], to: named(n.interactions[0].destination) }));
  check("figma: the rich file's click link comes across (reactions, one action, seconds)", links.length >= 1 && rich.some((i) => i.trigger === "onClick" && i.action === "navigate" && i.to === "Home" && i.durationMs === 300), JSON.stringify(rich));
  await shot("figma-rich-dialog");
  await importFigma("figma-sample.json");
  const dialog = await page.locator('[aria-label="Import from Figma"]').innerText().catch(() => "");
  check("figma: the sample's library instance is reported in the dialog", /1 instance of a library component became a frame \(its main component isn't in this file\)/.test(dialog), dialog.slice(0, 300));
  await shot("figma-sample-warning");

  // ---------------------------------------------------------------- accessible names from text (S-04)
  await newFile();
  await create([
    { type: "frame", name: "Home", x: 0, y: 0, width: 390, height: 600, fill: "#FFFFFF" },
    { type: "frame", name: "Settings", x: 500, y: 0, width: 390, height: 600, fill: "#EEEEEE" },
  ]);
  const home = await byName("Home");
  const settings = await byName("Settings");
  await create(
    [
      { type: "rectangle", name: "Cta", x: 20, y: 100, width: 200, height: 48, fill: "#6D4AFF", cornerRadius: 10 },
      { type: "text", name: "Label", x: 60, y: 112, width: 120, text: "Open settings", fontSize: 16, fill: "#FFFFFF" },
    ],
    home.id,
  );
  const cta = await byName("Cta");
  await page.evaluate(([id, to]) => window.__dt.dispatch({ op: "setInteractions", id, interactions: [{ trigger: "onClick", delayMs: 0, action: "navigate", destination: to, url: null, transition: "instant", durationMs: 300, overlay: { position: "center", offsetX: 0, offsetY: 0, closeOnClickOutside: true, background: null } }] }), [cta.id, settings.id]);
  const html = await page.evaluate((id) => window.__dt.query({ q: "exportHtml", id }), home.id).catch(() => null);
  const react = await page.evaluate((id) => window.__dt.query({ q: "exportReact", id }), home.id).catch(() => null);
  check("a11y: exported HTML names the control by its visible text", !!html && html.includes('aria-label="Open settings"') && !html.includes('aria-label="Cta"'), html && html.slice(0, 400));
  check("a11y: the text is aria-hidden and lets clicks through (HTML)", !!html && /aria-hidden="true"/.test(html) && /pointer-events: none/.test(html));
  check("a11y: React + Tailwind gets aria-label, aria-hidden and pointer-events-none", !!react && react.includes('aria-label="Open settings"') && react.includes('aria-hidden="true"') && react.includes("pointer-events-none"), react && react.slice(0, 300));
  if (html) {
    // Serve the exported page from the local server and click the visible text.
    const full = await page.evaluate(() => window.__dt.query({ q: "exportHtml", id: Object.values(window.__dt.doc().nodes).find((n) => n.name === "Home").id }));
    await context.route(URL + "/__cta.html", (r) => r.fulfill({ contentType: "text/html", body: full }));
    const p2 = await context.newPage();
    await p2.goto(URL + "/__cta.html");
    await p2.waitForTimeout(300);
    const label = p2.getByText("Open settings", { exact: true });
    const box = await label.boundingBox();
    const hitsControl = await p2.evaluate(([x, y]) => document.elementFromPoint(x, y)?.getAttribute("aria-label"), [box.x + box.width / 2, box.y + box.height / 2]);
    check("a11y: clicking the visible text lands on the control", hitsControl === "Open settings", String(hitsControl));
    // The HTML page carries the action as data-navigate (the React project turns it into a handler),
    // so a listener stands in for it: the click on the visible text must reach the control.
    await p2.evaluate(() => {
      window.__clicks = 0;
      document.querySelector("[data-navigate]").addEventListener("click", () => window.__clicks++);
    });
    await p2.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await p2.waitForTimeout(200);
    check("a11y: clicking the visible text triggers the control's click", (await p2.evaluate(() => window.__clicks)) === 1, String(await p2.evaluate(() => window.__clicks)));
    const names = await p2.evaluate(() => [...document.querySelectorAll("[aria-label]")].map((e) => e.getAttribute("aria-label")));
    check("a11y: the page exposes one name for the control and hides the text from screen readers", names.join() === "Open settings" && (await p2.locator("[aria-hidden=true]").innerText()) === "Open settings", names.join());
    await p2.screenshot({ path: SHOTS ? path.join(SHOTS, "exported-cta.png") : path.join(DL, "exported-cta.png") });
    await p2.close();
  }

  check("no uncaught page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (err) {
  check("script ran to the end", false, String(err?.stack ?? err));
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
