// Auto layout and text completeness: min/max size fields (edit + undo), truncation, paragraph
// spacing, links on text ranges (Ctrl+K, safe schemes only), baseline alignment, removing auto
// layout and the Wrap toggle.
// Usage: E2E_URL=http://localhost:5214 node scripts/qa/w2c-e2e.mjs (dev server running).
// Screenshots go to E2E_SHOTS (default: the system temp dir) for a human to look at.

import { chromium } from "playwright-core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const URL = process.env.E2E_URL ?? "http://localhost:5214";
const SHOTS = process.env.E2E_SHOTS ?? path.join(os.tmpdir(), "w2c-shots");
fs.mkdirSync(SHOTS, { recursive: true });
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

async function fresh() {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(() => {
    try {
      localStorage.setItem("dt:tour-done", "1");
    } catch {
      /* no storage */
    }
  });
  // Nothing may leave the machine.
  await page.route(/^https?:\/\/(?!(127\.0\.0\.1|localhost)[:/])/, (r) => r.abort());
  page.on("pageerror", (e) => check("no page errors", false, String(e)));
  await page.goto(URL);
  await page.click("button:has-text('New design file')");
  await page.waitForSelector("#dt-canvas");
  await sleep(300);
  return page;
}
const doc = (p) => p.evaluate(() => window.__dt.doc());
const named = async (p, name) => Object.values((await doc(p)).nodes).find((n) => n.name === name);
const create = (p, nodes) => p.evaluate((nodes) => window.__dt.tool("create_nodes", { nodes }), nodes);
const select = (p, ids) => p.evaluate((ids) => window.__dt.dispatch({ op: "select", ids }), ids);
const dispatch = (p, cmd) => p.evaluate((cmd) => window.__dt.dispatch(cmd), cmd);
const svg = (p) => p.evaluate(() => document.querySelector("#dt-canvas svg")?.outerHTML ?? "");
/** Sets a Design panel NumberField found by its title (or placeholder text) and commits it. */
async function setField(p, title, value) {
  const inp = p.locator(`label.field[title="${title}"] input`).first();
  await inp.click({ clickCount: 3 });
  await inp.fill(String(value));
  await inp.press("Enter");
  await sleep(150);
}
/** y positions of the lines of one text layer on the canvas. */
const lineYs = async (p, id) => {
  const s = await svg(p);
  const i = s.indexOf(`data-id="${id}"`);
  const g = s.slice(i, s.indexOf("</g>", i));
  return [...g.matchAll(/<tspan x="[\d.]+" y="([\d.]+)"/g)].map((m) => Number(m[1]));
};
const LONG = "The quick brown fox jumps over the lazy dog and keeps running through the forest all day long";

try {
  // 1. Min/max fields on a fill child: edit, clamp, undo.
  {
    const p = await fresh();
    await create(p, [
      {
        type: "frame",
        name: "Row",
        x: 0,
        y: 0,
        width: 400,
        height: 100,
        fill: "#eeeeee",
        children: [
          { type: "rectangle", name: "A", x: 0, y: 0, width: 50, height: 50, fill: "#ff0000" },
          { type: "rectangle", name: "B", x: 60, y: 0, width: 50, height: 50, fill: "#00ff00" },
        ],
      },
    ]);
    const row = await named(p, "Row");
    await select(p, [row.id]);
    await p.keyboard.press("Shift+a");
    await sleep(200);
    let r = await named(p, "Row");
    await dispatch(p, { op: "update", ids: [r.id], patch: { layout: { direction: "horizontal", gap: 0, paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0 }, sizingH: "fixed", width: 400 } });
    for (const n of ["A", "B"]) await dispatch(p, { op: "update", ids: [(await named(p, n)).id], patch: { sizingH: "fill" } });
    const a = await named(p, "A");
    check("fill children split 400 evenly", (await named(p, "A")).width === 200 && (await named(p, "B")).width === 200);
    await select(p, [a.id]);
    await sleep(200);
    await p.click("button:has-text('Add min / max size')");
    await setField(p, "Maximum width (0 or empty for none)", 120);
    check("max width field clamps the fill child", (await named(p, "A")).width === 120 && (await named(p, "B")).width === 280, `${(await named(p, "A")).width}/${(await named(p, "B")).width}`);
    check("max width stored on the layer", (await named(p, "A")).maxWidth === 120);
    await p.screenshot({ path: path.join(SHOTS, "01-maxwidth.png") });
    await setField(p, "Minimum width (0 or empty for none)", 300);
    check("min wins over max when they cross", (await named(p, "A")).width === 300, `${(await named(p, "A")).width}`);
    await setField(p, "Minimum width (0 or empty for none)", 0);
    check("0 clears a limit", (await named(p, "A")).minWidth == null);
    await p.keyboard.press("Control+z");
    await sleep(200);
    check("undo restores the minimum", (await named(p, "A")).minWidth === 300 && (await named(p, "A")).width === 300);
    await p.keyboard.press("Control+z");
    await p.keyboard.press("Control+z");
    await sleep(200);
    check("undo removes the maximum", (await named(p, "A")).maxWidth == null && (await named(p, "A")).width === 200);
    await p.context().close();
  }

  // 2. Hug frame honours min/max height and wraps its fill text at the max width.
  {
    const p = await fresh();
    await create(p, [
      {
        type: "frame",
        name: "Card",
        x: 0,
        y: 0,
        width: 200,
        height: 100,
        fill: "#ffffff",
        children: [{ type: "text", name: "Body", x: 0, y: 0, text: LONG, fontSize: 16 }],
      },
    ]);
    const card = await named(p, "Card");
    await select(p, [card.id]);
    await p.keyboard.press("Shift+a");
    await sleep(200);
    const body = await named(p, "Body");
    await dispatch(p, { op: "update", ids: [body.id], patch: { sizingH: "fill" } });
    await dispatch(p, { op: "update", ids: [card.id], patch: { maxWidth: 240, minHeight: 300 } });
    await sleep(200);
    const c = await named(p, "Card");
    const b = await named(p, "Body");
    check("hug card stops at its max width", c.width === 240, `${c.width}`);
    check("fill text wraps inside it", b.width === 240 - c.layout.paddingLeft - c.layout.paddingRight && b.height > 40, `${b.width}x${b.height}`);
    check("min height lifts a hug frame", c.height === 300, `${c.height}`);
    await p.context().close();
  }

  // 3. Truncation: Design panel toggle, max lines, rendering (screenshot), undo.
  {
    const p = await fresh();
    await create(p, [{ type: "text", name: "Para", x: 40, y: 40, text: LONG, fontSize: 18 }]);
    const t = await named(p, "Para");
    await select(p, [t.id]);
    await dispatch(p, { op: "update", ids: [t.id], patch: { width: 260, text: { autoResize: "height" } } });
    await sleep(200);
    const full = (await named(p, "Para")).height;
    await p.evaluate(() => window.__dt.zoomToFit?.());
    await p.locator("label:has-text('Truncate text') input").check();
    await sleep(200);
    let n = await named(p, "Para");
    check("Truncate on auto-height text starts at one line", n.text.truncate === true && n.text.maxLines === 1 && n.height < full, `${n.height} < ${full}`);
    await setField(p, "Maximum lines (0 or empty: the lines that fit a fixed box)", 2);
    n = await named(p, "Para");
    check("max lines 2 makes the layer two lines tall", n.text.maxLines === 2 && Math.abs(n.height - Math.ceil(2 * 18 * 1.2)) < 1.5, `${n.height}`);
    const s = await svg(p);
    check("canvas draws an ellipsis", s.includes("…"));
    check("the ellipsis follows the visible words", /<tspan[^>]*>[^<]*…<\/tspan>/.test(s) && !s.includes("all day long"));
    await p.screenshot({ path: path.join(SHOTS, "02-truncate-2-lines.png") });
    await p.keyboard.press("Control+z");
    await sleep(200);
    check("undo returns to one line", (await named(p, "Para")).text.maxLines === 1);
    await p.keyboard.press("Control+z");
    await sleep(200);
    check("undo turns truncation off", !(await named(p, "Para")).text.truncate && (await named(p, "Para")).height === full && !(await svg(p)).includes("…"));
    // Fixed box: the lines that fit.
    await dispatch(p, { op: "update", ids: [t.id], patch: { height: 60, text: { autoResize: "none", truncate: true } } });
    await sleep(200);
    const fixed = await svg(p);
    check("truncate in a fixed 60px box shows the lines that fit", fixed.includes("…") && (fixed.match(/<tspan x=/g) ?? []).length === 2, `${(fixed.match(/<tspan x=/g) ?? []).length} lines`);
    await p.screenshot({ path: path.join(SHOTS, "03-truncate-fixed-box.png") });
    await p.context().close();
  }

  // 4. Long word breaks in a fixed-width text; paragraph spacing moves lines.
  {
    const p = await fresh();
    await create(p, [{ type: "text", name: "Word", x: 40, y: 40, text: "Pneumonoultramicroscopicsilicovolcanoconiosis", fontSize: 16 }]);
    const t = await named(p, "Word");
    await dispatch(p, { op: "update", ids: [t.id], patch: { width: 120, text: { autoResize: "height" } } });
    await sleep(200);
    const n = await named(p, "Word");
    check("a long word breaks by character instead of overflowing", n.height > 19.2 * 2.5, `height ${n.height}`);
    await p.evaluate(() => window.__dt.zoomToFit?.());
    await p.screenshot({ path: path.join(SHOTS, "04-long-word.png") });
    await create(p, [{ type: "text", name: "Paras", x: 40, y: 200, text: "One\nTwo\nThree", fontSize: 16 }]);
    const q = await named(p, "Paras");
    await select(p, [q.id]);
    await sleep(200);
    const y0 = await lineYs(p, q.id);
    await setField(p, "Paragraph spacing (between lines separated by Enter)", 20);
    const after = await named(p, "Paras");
    check("paragraph spacing grows the layer by 2 gaps", Math.abs(after.height - (q.height + 40)) < 1.5, `${q.height} -> ${after.height}`);
    const y1 = await lineYs(p, q.id);
    check("lines moved apart on the canvas by the spacing", y0.length === 3 && y1.length === 3 && Math.abs(y1[1] - y0[1] - 20) < 0.01 && Math.abs(y1[2] - y0[2] - 40) < 0.01, `${y0.join(" ")} -> ${y1.join(" ")}`);
    await p.screenshot({ path: path.join(SHOTS, "05-paragraph-spacing.png") });
    await p.context().close();
  }

  // 5. Links: Ctrl+K in text edit mode, safe schemes only, underline, list, removal.
  {
    const p = await fresh();
    await create(p, [{ type: "text", name: "Doc", x: 40, y: 40, text: "Read the docs now", fontSize: 24 }]);
    const t = await named(p, "Doc");
    await select(p, [t.id]);
    await p.evaluate(() => window.__dt.zoomToFit?.());
    await p.keyboard.press("Enter");
    await sleep(300);
    const ta = p.locator("textarea.text-editor");
    check("text editor opened", (await ta.count()) === 1);
    // Select "docs" (characters 9..13).
    await ta.evaluate((el) => el.setSelectionRange(9, 13));
    await ta.dispatchEvent("select");
    await sleep(150);
    await p.keyboard.press("Control+k");
    await sleep(200);
    const input = p.locator("[data-testid=link-row] input");
    check("Ctrl+K opens the link field", (await input.count()) === 1);
    await p.screenshot({ path: path.join(SHOTS, "06a-link-field.png") });
    await input.fill("javascript:alert(1)");
    await input.press("Enter");
    await sleep(200);
    let n = await named(p, "Doc");
    check("javascript: links are refused", !(n.text.runs ?? []).some((r) => r.link), JSON.stringify(n.text.runs));
    check("with an error toast", /link must start with/.test(await p.locator(".toast.error").innerText().catch(() => "")));
    await input.fill("data:text/html,<script>1</script>");
    await input.press("Enter");
    await sleep(150);
    n = await named(p, "Doc");
    check("data: links are refused", !(n.text.runs ?? []).some((r) => r.link));
    await input.fill("example.com/docs");
    await input.press("Enter");
    await sleep(250);
    n = await named(p, "Doc");
    const run = (n.text.runs ?? []).find((r) => r.link);
    check("a bare address gets https://", run?.link === "https://example.com/docs" && run.start === 9 && run.end === 13, JSON.stringify(n.text.runs));
    await p.keyboard.press("Escape");
    await sleep(200);
    const s = await svg(p);
    check("the linked word is underlined on the canvas", /<tspan text-decoration="underline">docs<\/tspan>/.test(s));
    check("canvas has no anchors", !s.includes("<a ") && !s.includes("href"));
    await select(p, [t.id]);
    await sleep(200);
    check("link list shows the words and the address", (await p.locator("[data-testid=link-list]").innerText()).includes("docs") && (await p.locator("[data-testid=link-list]").innerText()).includes("https://example.com/docs"));
    await p.screenshot({ path: path.join(SHOTS, "06-link.png") });
    // mailto and tel are fine; raw patch can't smuggle a script link.
    await dispatch(p, { op: "styleText", id: t.id, start: 0, end: 4, style: { link: "mailto:hi@example.com" }, clear: [] });
    await dispatch(p, { op: "update", ids: [t.id], patch: { text: { runs: [{ start: 0, end: 4, link: "mailto:hi@example.com" }, { start: 9, end: 13, link: "javascript:alert(1)" }] } } });
    await sleep(150);
    n = await named(p, "Doc");
    check("mailto kept, script link dropped from a raw patch", n.text.runs.length === 1 && n.text.runs[0].link === "mailto:hi@example.com", JSON.stringify(n.text.runs));
    await p.locator("[data-testid=link-list] button[title='Remove link']").first().click();
    await sleep(200);
    check("Remove link clears it", !((await named(p, "Doc")).text.runs ?? []).some((r) => r.link));
    // Code export keeps the safe link as an anchor and never a script link.
    await dispatch(p, { op: "styleText", id: t.id, start: 9, end: 13, style: { link: "https://example.com/docs" }, clear: [] });
    const code = await p.evaluate((id) => window.__dt.tool("export_code", { id, format: "react" }), t.id);
    const src = typeof code === "string" ? code : JSON.stringify(code);
    check("react export has an <a> with rel", src.includes("<a href=") && src.includes("noopener"), src.slice(0, 200));
    await p.context().close();
  }

  // 6. Baseline alignment: two texts of different sizes line up on the baseline.
  {
    const p = await fresh();
    await create(p, [
      {
        type: "frame",
        name: "Line",
        x: 0,
        y: 0,
        width: 300,
        height: 100,
        fill: "#ffffff",
        children: [
          { type: "text", name: "Big", x: 0, y: 0, text: "Hello", fontSize: 40 },
          { type: "text", name: "Small", x: 100, y: 0, text: "world", fontSize: 14 },
        ],
      },
    ]);
    const f = await named(p, "Line");
    await select(p, [f.id]);
    await p.keyboard.press("Shift+a");
    await sleep(200);
    const frame = await named(p, "Line");
    await dispatch(p, { op: "update", ids: [frame.id], patch: { layout: { direction: "horizontal" } } });
    await sleep(150);
    await p.click("button[title='Align text baselines']");
    await sleep(250);
    const big = await named(p, "Big");
    const small = await named(p, "Small");
    check("baseline mode stored", (await named(p, "Line")).layout.counterAlign === "baseline");
    const baseline = (n) => n.y + n.height / 2 + 0.35 * n.text.fontSize;
    check("baselines line up", Math.abs(baseline(big) - baseline(small)) < 1, `${baseline(big)} vs ${baseline(small)}`);
    check("the small text sits lower than the big one", small.y > big.y);
    await p.screenshot({ path: path.join(SHOTS, "07-baseline.png") });
    // Switching to vertical drops baseline, and Wrap is disabled there.
    await p.click("button[title='Vertical']");
    await sleep(200);
    check("vertical layout leaves baseline alignment", (await named(p, "Line")).layout.counterAlign === "start");
    check("Wrap is disabled in a vertical layout", await p.locator("button[title^='Wrap needs a horizontal layout']").isDisabled());
    await p.context().close();
  }

  // 7. Wrap no longer flips the direction silently; removing auto layout leaves no hidden fill.
  {
    const p = await fresh();
    await create(p, [
      {
        type: "frame",
        name: "Stack",
        x: 0,
        y: 0,
        width: 300,
        height: 200,
        fill: "#ffffff",
        children: [
          { type: "rectangle", name: "R1", x: 0, y: 0, width: 80, height: 40, fill: "#ff0000" },
          { type: "rectangle", name: "R2", x: 0, y: 50, width: 80, height: 40, fill: "#00ff00" },
        ],
      },
    ]);
    const f = await named(p, "Stack");
    await select(p, [f.id]);
    await p.keyboard.press("Shift+a");
    await sleep(200);
    let s = await named(p, "Stack");
    check("starts vertical", s.layout.direction === "vertical");
    check("Wrap button is disabled until the layout is horizontal", await p.locator("button[title^='Wrap needs a horizontal layout']").isDisabled());
    await p.click("button[title='Horizontal']");
    await sleep(150);
    await p.click("button[title='Wrap']");
    await sleep(150);
    s = await named(p, "Stack");
    check("Wrap on a horizontal layout", s.layout.wrap === true && s.layout.direction === "horizontal");
    await p.click("button[title='Vertical']");
    await sleep(150);
    s = await named(p, "Stack");
    check("switching to vertical turns wrap off explicitly", s.layout.direction === "vertical" && s.layout.wrap === false);
    // Hidden fill sizing: make R1 fill, remove the layout.
    await dispatch(p, { op: "update", ids: [(await named(p, "R1")).id], patch: { sizingH: "fill" } });
    await sleep(150);
    await select(p, [s.id]);
    await p.click("button[title='Remove auto layout']");
    await sleep(200);
    const r1 = await named(p, "R1");
    check("children that filled are fixed after removing auto layout", r1.sizingH === "fixed" && r1.sizingV === "fixed", `${r1.sizingH}/${r1.sizingV}`);
    await p.context().close();
  }
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
