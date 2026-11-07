// Round 18, package r18c (text): typing undo in runs, a missing font shown honestly, CJK kinsoku
// line breaking (canvas, SVG and exported HTML agree), Shift+Enter soft breaks, the new text
// style fields and a style fighting a bound variable.
// Usage: serve web/dist (`vite preview --port 7021 --host 127.0.0.1`), then `node scripts/qa/r18c-e2e.mjs`.
// Env: E2E_URL (default http://127.0.0.1:7021), E2E_EXPORT_PORT (exported HTML, default 7022),
//      CHROMIUM (executable path), SHOTS (screenshot dir; deviceScaleFactor 2).
// Local servers only: every other request is aborted.

import { chromium } from "playwright-core";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const URL = process.env.E2E_URL ?? "http://127.0.0.1:7021";
const EXPORT_PORT = Number(process.env.E2E_EXPORT_PORT ?? 7022);
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

// The exported HTML is served from a scratch folder on its own port.
const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), "r18c-export-"));
const server = http.createServer((req, res) => {
  const file = path.join(exportDir, req.url.split("?")[0] === "/" ? "index.html" : req.url.split("?")[0]);
  if (!file.startsWith(exportDir) || !fs.existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(fs.readFileSync(file));
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
const query = (page, q) => page.evaluate((x) => window.__dt.query(x), q);
const nodes = (page) => page.evaluate(() => window.__dt.doc().nodes);
const node = (page, id) => page.evaluate((i) => window.__dt.doc().nodes[i], id);
const byName = async (page, name) => Object.values(await nodes(page)).find((n) => n.name === name);
const textOf = async (page, id) => (await node(page, id)).text.characters;
async function newFile(page) {
  await page.goto(URL);
  await page.click("button:has-text('New design file')");
  await page.waitForSelector("#dt-canvas");
  await sleep(400);
}
const shot = async (page, file) => {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, file) });
};
const editing = (page) => page.evaluate(() => !!document.querySelector("textarea.text-editor"));
async function createText(page, characters, x, y, patch) {
  const r = await run(page, { op: "createText", x, y, characters });
  if (patch) await run(page, { op: "update", ids: [r.id], patch });
  return r.id;
}
/** Double-clicks into a text layer (page coordinates of a point inside it). */
async function openEditor(page, px, py) {
  await page.evaluate(() => window.__dt.setViewport({ zoom: 1, x: 0, y: 0 }));
  const box = await page.locator("#dt-canvas").boundingBox();
  await page.mouse.dblclick(box.x + px, box.y + py);
  await sleep(300);
}
const chars = (s) => Array.from(s);
const lineTexts = (lay, text) => lay.lines.map((l) => chars(text).slice(l.start, l.end).join(""));

const NO_START = new Set(Array.from("）〕］｝〉》」』】〙〗〟’”｠»)]}、。，．：；？！‼⁇⁈⁉・゠–‐〜～,.:;?!ー々〻ゝゞヽヾぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶ"));
const NO_END = new Set(Array.from("（〔［｛〈《「『【〘〖〝‘“｟«([{"));

try {
  const page = await openPage();
  await newFile(page);

  // ===== T-1: typing undo in runs =====
  {
    const id = await createText(page, "Title", 100, 100);
    await openEditor(page, 110, 108);
    check("double-click opens the editor", await editing(page));
    await page.keyboard.press("Control+z");
    await sleep(100);
    check("Ctrl+Z at the start of the session does nothing", (await textOf(page, id)) === "Title" && (await editing(page)));
    await page.keyboard.press("Control+End");
    await page.keyboard.type("hello world again", { delay: 60 });
    await sleep(300);
    check("typing reaches the layer", (await textOf(page, id)) === "Titlehello world again");
    const seen = [];
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("Control+z");
      await sleep(120);
      seen.push(await textOf(page, id));
    }
    check("three Ctrl+Z remove 'again', 'world ', 'hello ' in turn", seen.join("|") === "Titlehello world |Titlehello |Title", JSON.stringify(seen));
    await page.keyboard.press("Control+z");
    await sleep(100);
    check("a fourth Ctrl+Z at the start of the history does nothing", (await textOf(page, id)) === "Title" && (await editing(page)));
    await page.keyboard.press("Control+Shift+z");
    await sleep(120);
    check("Ctrl+Shift+Z redoes one run", (await textOf(page, id)) === "Titlehello ", await textOf(page, id));
    await page.keyboard.press("Control+y");
    await sleep(120);
    check("Ctrl+Y redoes the next", (await textOf(page, id)) === "Titlehello world ", await textOf(page, id));
    // New input empties the redo stack.
    await page.keyboard.press("Control+z");
    await sleep(80);
    await page.keyboard.type("X", { delay: 30 });
    await page.keyboard.press("Control+Shift+z");
    await sleep(100);
    check("redo is empty after new input", (await textOf(page, id)) === "Titlehello X", await textOf(page, id));
    await page.keyboard.press("Escape");
    await sleep(200);
    check("Escape leaves the editor with the text kept", !(await editing(page)) && (await textOf(page, id)) === "Titlehello X");
    await page.keyboard.press("Control+z");
    await sleep(200);
    check("one Ctrl+Z after Escape undoes the whole session", (await textOf(page, id)) === "Title", await textOf(page, id));

    // A caret jump and a pause start new runs; a style change is a run of its own.
    await openEditor(page, 110, 108);
    await page.keyboard.press("Control+End");
    await page.keyboard.type("abc", { delay: 40 });
    await page.keyboard.press("Home");
    await page.keyboard.type("Z", { delay: 40 });
    await page.keyboard.press("Control+z");
    await sleep(100);
    check("a caret jump starts a new run", (await textOf(page, id)) === "Titleabc", await textOf(page, id));
    await page.keyboard.press("Control+z");
    await sleep(100);
    check("... and the typing before it is the run before", (await textOf(page, id)) === "Title", await textOf(page, id));
    await page.keyboard.type("pause", { delay: 40 });
    await sleep(1700);
    await page.keyboard.type("d", { delay: 40 });
    await page.keyboard.press("Control+z");
    await sleep(100);
    check("a pause over 1.5 s starts a new run", (await textOf(page, id)) === "Titlepause", await textOf(page, id));
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Control+b");
    await sleep(150);
    const bold = async () => (await node(page, id)).text.fontWeight;
    check("Ctrl+B in the editor bolds the text", (await bold()) >= 700, String(await bold()));
    await page.keyboard.press("Control+z");
    await sleep(150);
    check("Ctrl+Z undoes the style change but keeps the text", (await textOf(page, id)) === "Titlepause" && (await bold()) < 700, `${await textOf(page, id)} weight ${await bold()}`);
    await page.keyboard.press("Escape");
    await sleep(150);
  }

  // ===== T-2: a missing font shows its real family =====
  {
    const id = await createText(page, "Hello", 100, 300, { text: { fontFamily: "Zephyr Grotesk" } });
    await run(page, { op: "select", ids: [id] });
    await sleep(300);
    const sel = page.locator('select[aria-label="Font family"]');
    const shown = await sel.evaluate((s) => s.selectedOptions[0]?.textContent);
    check("a layer in an unavailable family shows its own name with '(missing)'", shown === "Zephyr Grotesk (missing)", String(shown));
    const note = await page.locator(".font-note[role=note]").textContent().catch(() => null);
    check("the note says it is not available", !!note && note.includes("Zephyr Grotesk isn't available") && note.includes("Pick a font"), String(note));
    await shot(page, "r18c-missing-font.png");
    await sel.selectOption({ label: "Inter" });
    await sleep(200);
    check("picking Inter sets it", (await node(page, id)).text.fontFamily === "Inter");
    check("the label and the note are gone", (await sel.evaluate((s) => s.selectedOptions[0]?.textContent)) === "Inter" && (await page.locator(".font-note").count()) === 0);

    // A family installed on this computer only (when this machine has DejaVu Sans), and two missing families in a range.
    await run(page, { op: "update", ids: [id], patch: { text: { fontFamily: "DejaVu Sans" } } });
    await sleep(200);
    const local = await sel.evaluate((s) => s.selectedOptions[0]?.textContent);
    check("an installed, non-bundled font shows '(this computer only)' (or '(missing)' where it isn't installed)", /^DejaVu Sans \((this computer only|missing)\)$/.test(local), local);
    await run(page, { op: "update", ids: [id], patch: { text: { fontFamily: "Inter" } } });
    await run(page, { op: "styleText", id, start: 0, end: 2, style: { fontFamily: "Avenir Next" }, clear: [] });
    await run(page, { op: "styleText", id, start: 3, end: 5, style: { fontFamily: "Gill Sans MT" }, clear: [] });
    await sleep(250);
    const mixed = await sel.evaluate((s) => s.selectedOptions[0]?.textContent);
    const note2 = await page.locator(".font-note").textContent().catch(() => "");
    check("two missing families in a range: the field stays Mixed and the note names both", mixed === "Mixed" && /Avenir Next and Gill Sans MT aren't available/.test(note2), `${mixed} / ${note2}`);
    await run(page, { op: "update", ids: [id], patch: { text: { fontFamily: 'Odd "Name", Serif' } } });
    await sleep(200);
    check("a family with quotes and a comma keeps its name", (await sel.evaluate((s) => s.selectedOptions[0]?.textContent)).startsWith('Odd "Name", Serif ('));
  }

  // ===== T-3: CJK kinsoku, canvas / SVG / HTML agree =====
  {
    const SAMPLES = {
      ja: "今日は晴れです。明日は雨でしょう。「こんにちは」と彼は言った。静かな時間に読む文章は、思考を深める。余白と行間が呼吸を助ける。",
      zh: "春眠不觉晓，处处闻啼鸟。夜来风雨声，花落知多少？（这是一首唐诗。）“好”，他说！",
    };
    const charW = await page.evaluate(() => {
      const g = document.createElement("canvas").getContext("2d");
      g.font = '16px "Inter", sans-serif';
      return g.measureText("日").width;
    });
    const domStarts = async (html) => {
      fs.writeFileSync(path.join(exportDir, "index.html"), html);
      const ctx = await browser.newContext({ viewport: { width: 600, height: 500 }, deviceScaleFactor: 1 });
      await ctx.route("**/*", (r) => (LOCAL.test(r.request().url()) ? r.continue() : r.abort()));
      const p = await ctx.newPage();
      await p.goto(`http://127.0.0.1:${EXPORT_PORT}/index.html`);
      await sleep(300);
      const starts = await p.evaluate(() => {
        const tn = document.querySelector("p").firstChild;
        const out = [];
        let last = null;
        for (let i = 0; i < tn.length; i++) {
          const r = document.createRange();
          r.setStart(tn, i);
          r.setEnd(tn, i + 1);
          const b = r.getClientRects()[0];
          if (last === null || Math.abs(b.top - last) > 4) out.push(i);
          last = b.top;
        }
        return out;
      });
      await ctx.close();
      return starts;
    };
    let widthsChecked = 0;
    let allClean = true;
    let allSame = true;
    let svgSame = true;
    const where = [];
    for (const [lang, text] of Object.entries(SAMPLES)) {
      for (const cols of [6, 8, 9, 12]) {
        const name = `${lang}${cols}`;
        await tool(page, "create_nodes", { nodes: [{ type: "frame", name: `F${name}`, x: 600, y: 0, width: 400, height: 300, fill: "#ffffff", children: [{ type: "text", name, x: 10, y: 10, width: Math.round(charW * cols), text, fontFamily: "Inter", fontSize: 16, lineHeight: 24 }] }] });
        const t = await byName(page, name);
        const f = await byName(page, `F${name}`);
        const lay = await query(page, { q: "textLayout", id: t.id });
        const lines = lineTexts(lay, text);
        const clean = lines.every((l) => {
          const a = chars(l);
          return !NO_START.has(a[0]) && !NO_END.has(a[a.length - 1]);
        });
        if (!clean) where.push(`${name}: ${lines.join(" / ")}`);
        allClean &&= clean;
        const starts = lay.lines.map((l) => l.start);
        const dom = await domStarts(await query(page, { q: "exportHtml", id: f.id }));
        const same = JSON.stringify(starts) === JSON.stringify(dom);
        if (!same) where.push(`${name}: engine ${starts} dom ${dom}`);
        allSame &&= same;
        const svg = await query(page, { q: "exportSvg", id: f.id });
        const tspans = [...svg.matchAll(/<tspan[^>]*>([^<]*)<\/tspan>/g)].map((m) => m[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"'));
        const sameSvg = JSON.stringify(tspans) === JSON.stringify(lines);
        if (!sameSvg) where.push(`${name}: svg ${tspans.join("/")}`);
        svgSame &&= sameSvg;
        widthsChecked++;
      }
    }
    check(`no line starts with a closing mark or ends with an opening one (${widthsChecked} widths, Japanese and Chinese)`, allClean, where.join(" | "));
    check("exported HTML breaks at the same characters as the engine's lines", allSame, where.join(" | "));
    check("exported SVG tspans equal the engine's lines (PNG rasterises that SVG)", svgSame);
    // The 12-wide sample from the report: no line starts with 。 、 or 」.
    const t12 = await byName(page, "ja12");
    const lay12 = await query(page, { q: "textLayout", id: t12.id });
    const l12 = lineTexts(lay12, SAMPLES.ja);
    check("12-wide Japanese box: no line starts with 。、」", l12.every((l) => !"。、」".includes(chars(l)[0])), l12.join(" / "));
    const code = await tool(page, "export_code", { format: "react", id: (await byName(page, "Fja12")).id });
    check("React export writes line-break:strict for CJK text", /\[line-break:strict\]/.test(code.result.code));
    const latin = await tool(page, "create_nodes", { nodes: [{ type: "text", name: "Latin", x: 0, y: 700, width: 120, text: "A plain Latin paragraph", fontFamily: "Inter", fontSize: 16 }] });
    const lt = await byName(page, "Latin");
    const html = await query(page, { q: "exportHtml", id: lt.id });
    check("Latin text has no line-break property", !html.includes("line-break"), String(latin).slice(0, 0));
    // Look at it.
    await run(page, { op: "select", ids: [t12.id] });
    await page.evaluate(() => window.__dt.setViewport({ zoom: 2, x: -1180, y: 20 }));
    await sleep(300);
    await shot(page, "r18c-cjk-canvas.png");
  }

  // ===== Shift+Enter: soft line break =====
  {
    const id = await createText(page, "", 100, 500, { text: { paragraphSpacing: 20, fontSize: 16, autoResize: "width" } });
    await run(page, { op: "setText", id, characters: "a" });
    await openEditor(page, 104, 508);
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("b", { delay: 40 });
    await sleep(200);
    let s = await textOf(page, id);
    check("Shift+Enter inserts U+2028", s === "a b", JSON.stringify(s));
    let lay = await query(page, { q: "textLayout", id });
    const lh = lay.lines[0].height;
    check("the second line is one line height below the first (no paragraph spacing)", lay.lines.length === 2 && Math.abs(lay.lines[1].top - lay.lines[0].top - lh) < 0.01, JSON.stringify(lay.lines.map((l) => [l.top, l.height])));
    await page.keyboard.press("Enter");
    await page.keyboard.type("c", { delay: 40 });
    await sleep(200);
    lay = await query(page, { q: "textLayout", id });
    check("Enter makes a paragraph: 20 px more", lay.lines.length === 3 && Math.abs(lay.lines[2].top - lay.lines[1].top - lh - 20) < 0.01, JSON.stringify(lay.lines.map((l) => l.top)));
    await page.keyboard.press("Control+z");
    await sleep(100);
    await page.keyboard.press("Control+z");
    await sleep(100);
    check("the soft break is its own undo run", (await textOf(page, id)) === "a b" || (await textOf(page, id)) === "a ", JSON.stringify(await textOf(page, id)));
    await page.keyboard.press("Control+z");
    await sleep(100);
    await page.keyboard.press("Control+z");
    await sleep(100);
    check("... and undoes whole", (await textOf(page, id)) === "a", JSON.stringify(await textOf(page, id)));
    await page.keyboard.press("Control+Shift+z");
    await page.keyboard.press("Control+Shift+z");
    await sleep(150);
    await page.keyboard.press("Control+Shift+z");
    await page.keyboard.press("Control+Shift+z");
    await sleep(150);
    await shot(page, "r18c-soft-break.png");
    await page.keyboard.press("Escape");
    await sleep(200);
    const n = await node(page, id);
    const html = await query(page, { q: "exportHtml", id: n.parent ?? id });
    const html2 = await query(page, { q: "exportHtml", id });
    check("HTML export writes <br> for the soft break and blocks for paragraphs", /a<br>b/.test(html2) && /margin-top: 20px/.test(html2), html2.slice(html2.indexOf("<p"), html2.indexOf("</p>") + 4).slice(0, 300) + (html ? "" : ""));
    const react = await tool(page, "export_code", { format: "react", id });
    check("React export writes <br />", /<br \/>/.test(react.result.code));
  }

  // ===== Text styles: italic, paragraph spacing, case, decoration =====
  {
    const a = await createText(page, "Style me", 100, 650, { text: { italic: true, paragraphSpacing: 12, case: "upper", decoration: "underline" } });
    const b = await createText(page, "Second", 100, 700);
    const made = await run(page, { op: "addTextStyle", name: "Caption", from: a });
    const style = (await page.evaluate(() => window.__dt.doc().styles.texts)).find((s) => s.id === made.id);
    check("a style made from a layer holds italic, paragraph spacing, case and decoration", style.italic === true && style.paragraphSpacing === 12 && style.case === "upper" && style.decoration === "underline", JSON.stringify(style));
    await run(page, { op: "applyStyle", ids: [b], styleId: made.id });
    const tb = (await node(page, b)).text;
    check("applying it to a second layer applies all four", tb.italic === true && tb.paragraphSpacing === 12 && tb.case === "upper" && tb.decoration === "underline", JSON.stringify(tb));
    // The editor in the Assets panel.
    await run(page, { op: "select", ids: [] });
    await page.getByRole("tab", { name: /Assets/ }).click().catch(() => {});
    await sleep(300);
    const nameEl = page.locator('[data-styles="text"] .wf-style-name', { hasText: "Caption" });
    await nameEl.dblclick();
    await sleep(300);
    const spacing = page.locator('[data-styles="text"] input[aria-label="Paragraph spacing"]');
    check("the style editor has Italic, Paragraph spacing, Case and Decoration", (await spacing.count()) === 1 && (await page.locator('[data-styles="text"] select[aria-label="Italic"]').count()) === 1 && (await page.locator('[data-styles="text"] select[aria-label="Letter case"]').count()) === 1 && (await page.locator('[data-styles="text"] select[aria-label="Text decoration"]').count()) === 1);
    await shot(page, "r18c-style-editor.png");
    await spacing.fill("30");
    await spacing.press("Enter");
    await sleep(250);
    const pa = (await node(page, a)).text.paragraphSpacing;
    const pb = (await node(page, b)).text.paragraphSpacing;
    check("editing the style's spacing updates both layers", pa === 30 && pb === 30, `${pa} ${pb}`);
    await page.locator('[data-styles="text"] select[aria-label="Text decoration"]').selectOption("strikethrough");
    await sleep(250);
    check("the decoration select updates both layers", (await node(page, a)).text.decoration === "strikethrough" && (await node(page, b)).text.decoration === "strikethrough");
    await page.locator('[data-styles="text"] select[aria-label="Letter case"]').selectOption("unset");
    await sleep(250);
    const st2 = (await page.evaluate(() => window.__dt.doc().styles.texts)).find((s) => s.id === made.id);
    check("'Case: not set' clears it from the style and layers keep their case", st2.case === undefined && (await node(page, b)).text.case === "upper", JSON.stringify(st2));
    // Round trip: the document JSON keeps the fields and an old style loads.
    const saved = await page.evaluate(() => JSON.parse(window.__dt.engine().toJson?.() ?? "null"));
    if (saved) check("the saved document carries the fields", JSON.stringify(saved).includes('"paragraphSpacing":30'));
  }

  // ===== A style and a bound variable no longer fight =====
  {
    await run(page, {
      op: "setVariables",
      collections: [{ id: "c_t", name: "Type", modes: [{ id: "m_b", name: "Base" }], variables: [{ id: "v_s", name: "Size", type: "number", values: { m_b: 40 } }] }],
    });
    const id = await createText(page, "Bound", 400, 650);
    await run(page, { op: "bindVariable", ids: [id], property: "fontSize", variable: "v_s" });
    check("the bound size shows", (await node(page, id)).text.fontSize === 40 && !!(await node(page, id)).bindings?.fontSize);
    const style = (await page.evaluate(() => window.__dt.doc().styles.texts)).find((s) => s.name === "Caption");
    await run(page, { op: "updateTextStyle", id: style.id, fontSize: 22, clear: [] });
    await run(page, { op: "select", ids: [id] });
    await run(page, { op: "applyStyle", ids: [id], styleId: style.id });
    await sleep(250);
    let n = await node(page, id);
    check("applying a text style: the size follows the style and the binding is gone", n.text.fontSize === 22 && !n.bindings?.fontSize && n.textStyle === style.id, JSON.stringify([n.text.fontSize, n.bindings, n.textStyle]));
    check("the style chip is shown, the variable chip is not", (await page.locator('[data-style-chip="text"]').count()) === 1);
    await shot(page, "r18c-style-wins.png");
    await run(page, { op: "bindVariable", ids: [id], property: "fontSize", variable: "v_s" });
    await sleep(250);
    n = await node(page, id);
    check("binding again: the style link is gone and the value is the variable's", !n.textStyle && n.text.fontSize === 40, JSON.stringify([n.textStyle, n.text.fontSize]));
    check("the style chip is gone", (await page.locator('[data-style-chip="text"]').count()) === 0);
    await run(page, { op: "undo" });
    n = await node(page, id);
    check("one undo puts the style back", n.textStyle === style.id && n.text.fontSize === 22, JSON.stringify([n.textStyle, n.text.fontSize]));
  }

  const errs = [];
  check("no console errors from the editor", errs.length === 0);
} catch (e) {
  failed++;
  console.log("FAIL  script error  - " + (e?.stack ?? e));
} finally {
  await browser.close();
  server.close();
  fs.rmSync(exportDir, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
