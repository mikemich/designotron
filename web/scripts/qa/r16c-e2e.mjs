// Round 16 / r16c, handoff and export:
//   H2  rotated auto layout children keep their rotation, are laid out by their bounding box,
//       and export as `transform: rotate()` plus margins (no wrapper element),
//   H4  a frame named CON (a Windows device name) or App (the shell's own function) exports as a
//       compiling screen (`CONScreen`, `AppScreen`),
//   H3  README, CLAUDE.md and tokens.css name a token the design really has,
//   U1  Inspect's colour format list has no "CSS" label (it says "Token"),
//   U2  single-layer code writes var(--token, literal).
// Usage: `npm run build`, then `vite preview --port 6821` (E2E_URL, default http://127.0.0.1:6821), then
//   E2E_DEPS=<dir with node_modules> node scripts/qa/r16c-e2e.mjs
// (no Tailwind offline: the project is built without its PostCSS plugin and the layout is measured on the HTML export)
// Env: E2E_SERVE_PORT (default 6822), E2E_SHOTS (screenshot directory), CHROMIUM (executable path).
// Without E2E_DEPS the exported project is parsed with the TypeScript compiler API but not built.
// Only local servers are used: every other request is aborted.

import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const URL = process.env.E2E_URL ?? "http://127.0.0.1:6821";
const launch = { headless: true, args: ["--no-sandbox"] };
if (process.env.CHROMIUM) launch.executablePath = process.env.CHROMIUM;
else if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";
const SHOTS = process.env.E2E_SHOTS;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let failed = 0;
function check(name, ok, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + String(detail).slice(0, 500) : ""}`);
}
const local = (u) => /^(127\.0\.0\.1|localhost)$/.test(new globalThis.URL(u).hostname) || /^(data|blob):/.test(u.toString());
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;

// The TypeScript compiler API from the main checkout's node_modules (no install, no network).
const here = path.dirname(new globalThis.URL(import.meta.url).pathname);
const require = createRequire(path.join(here, "../../package.json"));
const ts = require("typescript");
/** Syntax errors of a TSX file (empty when it parses). */
const tsErrors = (name, text) => {
  const out = ts.transpileModule(text, { fileName: name, reportDiagnostics: true, compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020 } });
  return (out.diagnostics ?? []).map((d) => `${name}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
};

const browser = await chromium.launch(launch);
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await context.route((u) => !local(u), (r) => r.abort());
await context.addInitScript(() => {
  try {
    localStorage.setItem("dt:tour-done", "1");
  } catch {
    /* no storage */
  }
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const tool = (name, input) => page.evaluate(([n, i]) => window.__dt.tool(n, i), [name, input]);
const doc = () => page.evaluate(() => structuredClone(window.__dt.doc()));
const select = (ids) => page.evaluate((i) => window.__dt.dispatch({ op: "select", ids: i }), ids);
const byName = (d, n) => Object.values(d.nodes).find((x) => x.name === n);
/** Bounding box of a layer in its parent's space (rotation pivots on the centre). */
const bbox = (n) => {
  const t = (n.rotation * Math.PI) / 180;
  const w = Math.abs(n.width * Math.cos(t)) + Math.abs(n.height * Math.sin(t));
  const h = Math.abs(n.width * Math.sin(t)) + Math.abs(n.height * Math.cos(t));
  const cx = n.x + n.width / 2;
  const cy = n.y + n.height / 2;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
};

await page.goto(URL);
await page.waitForSelector(".files", { timeout: 30000 });
await page.click("button:has-text('New design file')");
await page.waitForSelector("#dt-canvas", { timeout: 30000 });
await page.waitForTimeout(500);

// ---- the design ----
await tool("define_variables", { collection: "Space", modes: ["Base"], variables: [{ name: "Gap", type: "number", values: { Base: 12 } }] });
await tool("define_styles", { colors: [{ name: "Brand/Primary", color: "#5B3DF5" }] });
const made = await tool("create_nodes", {
  nodes: [
    {
      type: "frame",
      name: "Button row",
      x: 0,
      y: 0,
      width: "hug",
      height: "hug",
      fillStyle: "Brand/Primary",
      cornerRadius: 12,
      layout: { direction: "horizontal", padding: 16, gap: 12, crossAlign: "center" },
      bind: { gap: "Space/Gap" },
      children: [
        { type: "text", name: "Label", text: "Continue", fontSize: 16, color: "#FFFFFF" },
        { type: "rectangle", name: "Block90", width: 20, height: 40, fill: "#FFFFFF", rotation: 90 },
        { type: "rectangle", name: "Block180", width: 20, height: 30, fill: "#FFD166", rotation: 180 },
        { type: "rectangle", name: "Block45", width: 24, height: 24, fill: "#06D6A0", rotation: 45 },
        { type: "svg", name: "Chevron", svg: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><path d="M6 3l8 7-8 7" fill="none" stroke="#FFFFFF" stroke-width="2"/></svg>', width: 20, height: 20, rotation: 90 },
        { type: "rectangle", name: "Dot", width: 10, height: 10, fill: "#EF476F" },
      ],
    },
    { type: "frame", name: "CON", x: 800, y: 0, width: 400, height: 200, fill: "#F4F4F4" },
    { type: "frame", name: "App", x: 1300, y: 0, width: 400, height: 200, fill: "#E4E4E4" },
  ],
});
check("the design was created", made.ok === true, JSON.stringify(made).slice(0, 300));
await page.waitForTimeout(300);

const KIDS = ["Label", "Block90", "Block180", "Block45", "Chevron", "Dot"];
/** The row's children are laid out by bounding box: each sits `gap` after the previous one. */
async function rowLaidOut(label, gap = 12) {
  const d = await doc();
  const row = byName(d, "Button row");
  const kids = KIDS.map((n) => byName(d, n)).filter(Boolean);
  const boxes = kids.map(bbox);
  let ok = boxes.length === KIDS.length;
  let x = row.layout.paddingLeft;
  const detail = [];
  boxes.forEach((b, i) => {
    detail.push(`${KIDS[i]} ${b.x.toFixed(1)},${b.y.toFixed(1)} ${b.w.toFixed(1)}x${b.h.toFixed(1)}`);
    if (!near(b.x, x, 0.01)) ok = false;
    x += b.w + gap;
  });
  const tallest = Math.max(...boxes.map((b) => b.h));
  const inside = boxes.every((b) => b.y >= row.layout.paddingTop - 0.01 && b.y + b.h <= row.height - row.layout.paddingBottom + 0.01);
  check(`${label}: children sit by their bounding boxes in order`, ok, detail.join(" | ") + ` expected x ${x - gap}`);
  check(`${label}: the row hugs the tallest bounding box and its width`, near(row.height, tallest + row.layout.paddingTop + row.layout.paddingBottom, 0.01) && near(row.width, x - gap + row.layout.paddingRight, 0.01) && inside, `row ${row.width}x${row.height}`);
  return d;
}

let d = await rowLaidOut("create_nodes");
const rot = (n) => byName(d, n)?.rotation;
check("create_nodes keeps 90, 180 and 45 degrees on auto layout children", rot("Block90") === 90 && rot("Block180") === 180 && rot("Block45") === 45, JSON.stringify([rot("Block90"), rot("Block180"), rot("Block45")]));
check("the imported chevron keeps its 90 degrees", rot("Chevron") === 90, `${byName(d, "Chevron")?.type} ${rot("Chevron")}`);

// update_nodes, then an edit of a sibling.
await tool("update_nodes", { updates: [{ id: byName(d, "Block180").id, rotation: 90 }] });
d = await rowLaidOut("update_nodes (180 to 90)");
check("update_nodes sets a new rotation", rot("Block180") === 90);
await tool("update_nodes", { updates: [{ id: byName(d, "Label").id, text: "Continue to checkout" }] });
d = await rowLaidOut("after editing a sibling");
check("a sibling edit keeps every rotation", rot("Block90") === 90 && rot("Block180") === 90 && rot("Block45") === 45 && rot("Chevron") === 90);

// The panel field.
await select([byName(d, "Block45").id]);
const field = page.getByLabel("Rotation", { exact: true });
await field.fill("135");
await field.press("Enter");
await page.waitForTimeout(200);
d = await rowLaidOut("panel rotation field (45 to 135)");
check("the Rotation field set 135", rot("Block45") === 135, rot("Block45"));

// A fresh row through create_nodes keeps them too.
await tool("create_nodes", {
  nodes: [
    {
      type: "frame",
      name: "Second row",
      x: 0,
      y: 400,
      width: "hug",
      height: "hug",
      layout: { direction: "horizontal", padding: 8, gap: 8 },
      children: [
        { type: "rectangle", name: "Flip", width: 20, height: 12, fill: "#333333", rotation: 180 },
        { type: "rectangle", name: "Turn", width: 20, height: 12, fill: "#333333", rotation: 90 },
      ],
    },
  ],
});
d = await doc();
const second = byName(d, "Second row");
check("a new row built with create_nodes keeps both rotations and hugs the bounding boxes", rot("Flip") === 180 && rot("Turn") === 90 && near(second.width, 8 + 20 + 8 + 12 + 8, 0.01) && near(second.height, 8 + 20 + 8, 0.01), `${second.width}x${second.height}`);

// Fill acts as Fixed on a tilted child, and the panel says so.
await tool("update_nodes", { updates: [{ id: byName(d, "Block90").id, width: "fill" }] });
d = await doc();
await select([byName(d, "Block90").id]);
await page.waitForTimeout(200);
const hint = await page.locator("[data-testid=fill-rotated-hint]").allTextContents();
check("the Design panel explains Fill on a rotated child", hint.length === 1 && /Fill doesn't apply while rotated/.test(hint[0]), JSON.stringify(hint));
check("Fill acts as Fixed (size unchanged) and the stored sizing stays", byName(d, "Block90").width === 20 && byName(d, "Block90").sizingH === "fill", `${byName(d, "Block90").width} ${byName(d, "Block90").sizingH}`);
await rowLaidOut("with a Fill child at 90 degrees");
await tool("update_nodes", { updates: [{ id: byName(d, "Block90").id, width: 20 }] });
await select([byName(d, "Block90").id]);
await page.waitForTimeout(150);
check("no hint once the layer is fixed again", (await page.locator("[data-testid=fill-rotated-hint]").count()) === 0);

// Undo is one step for the panel rotation.
await select([byName(await doc(), "Block45").id]);
await field.fill("20");
await field.press("Enter");
await page.waitForTimeout(150);
const w20 = byName(await doc(), "Button row").width;
await page.keyboard.press("Escape");
await page.evaluate(() => window.__dt.dispatch({ op: "undo" }));
await page.waitForTimeout(150);
d = await doc();
check("one undo restores the rotation and the row", rot("Block45") === 135 && byName(d, "Button row").width !== w20, `${rot("Block45")} ${w20} ${byName(d, "Button row").width}`);
await rowLaidOut("after undo");

// Canvas look: the row zoomed in, and the engine's own PNG of it.
await select([byName(d, "Button row").id]);
await page.evaluate(() => window.__dt.zoomToFit());
await page.keyboard.press("Shift+Digit2");
await page.waitForTimeout(500);
if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "canvas-row.png") });
const shot = await tool("get_screenshot", { id: byName(d, "Button row").id, scale: 2 });
const png = shot.image?.data ? Buffer.from(shot.image.data, "base64") : null;
check("the engine renders the row as a PNG", !!png && png.subarray(1, 4).toString() === "PNG", shot.ok);
if (png && SHOTS) fs.writeFileSync(path.join(SHOTS, "row-crop.png"), png);
if (png) {
  const row = byName(d, "Button row");
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  check("the PNG is the row's size at 2x", near(w, row.width * 2, 3) && near(h, row.height * 2, 3), `${w}x${h} for ${row.width}x${row.height}`);
}

// ---- Inspect: the colour format list and the layer code ----
await select([byName(d, "Button row").id]);
await page.click("[role=tab]:has-text('Code')");
await page.waitForSelector(".code-block", { timeout: 10000 });
const labels = await page.locator("[aria-label='Colour format'] button").allTextContents();
check("Inspect's colour formats are Hex, RGB, HSL and Token (no CSS label)", JSON.stringify(labels) === JSON.stringify(["Hex", "RGB", "HSL", "Token"]), JSON.stringify(labels));
const title = await page.locator("[aria-label='Colour format'] button:has-text('Token')").getAttribute("title");
check("the Token item explains itself", /custom property/.test(title ?? ""), title);
const react = await page.locator(".code-block").innerText();
check("layer code (React) writes var(--token, literal) for a colour style and the bound gap", react.includes("var(--color-brand-primary,#5B3DF5)") && react.includes("calc(var(--gap,12)*1px)"), react.slice(0, 600));
check("layer code has the rotation and margins, no wrapper", react.includes("[transform:rotate(90deg)]") && /my-\[-?\d/.test(react) && react.includes("mx-["), react.slice(0, 900));
const lang = page.getByLabel("Code language");
await lang.selectOption({ label: "HTML + CSS" });
await page.waitForTimeout(300);
const html = await page.locator(".code-block").innerText();
check("layer code (HTML) has var(--token, literal) and rotate + margin", html.includes("var(--color-brand-primary,#5B3DF5)") && html.includes("transform: rotate(90deg)") && /margin: -?[\d.]+px -?[\d.]+px/.test(html), html.slice(0, 700));
if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "inspect-code.png") });

// ---- the exported project ----
const exp = await tool("export_code", { format: "project" });
const files = exp.result.files;
const get = (p) => files.find((f) => f.path === p)?.content ?? "";
const paths = files.map((f) => f.path);
check("the CON frame exports as src/screens/CONScreen.tsx (no CON.tsx)", paths.includes("src/screens/CONScreen.tsx") && !paths.includes("src/screens/CON.tsx"), paths.filter((p) => p.startsWith("src/screens")).join());
check("the App frame exports as AppScreen, imported without clashing with function App", paths.includes("src/screens/AppScreen.tsx") && get("src/App.tsx").includes('import AppScreen from "./screens/AppScreen";') && !/import App from/.test(get("src/App.tsx")));
const syntax = files.filter((f) => /\.tsx?$/.test(f.path)).flatMap((f) => tsErrors(f.path, f.content));
check("every exported TSX/TS file parses with the TypeScript compiler API", syntax.length === 0, syntax.slice(0, 5).join(" | "));
for (const p of ["README.md", "CLAUDE.md", "src/tokens.css"]) {
  const t = get(p);
  check(`${p} names the design's own number token`, t.includes("calc(var(--gap) * 1px)") && !t.includes("--space-8"), t.slice(0, 200));
}
const rowCode = get("src/screens/ButtonRow.tsx");
check("the project keeps bare custom properties (no fallbacks)", rowCode.includes("var(--gap)") && !rowCode.includes("var(--gap,"), rowCode.slice(0, 300));

// ---- serve the exported code and compare the browser's boxes with the design ----
// Tailwind isn't installed offline, so the React project is built without its PostCSS plugin (it must
// compile and mount; its classes are checked in the DOM) and the layout is measured on the HTML export,
// which carries the same positions as inline styles.
const work = fs.mkdtempSync(path.join(os.tmpdir(), "r16c-"));
let root = path.join(work, "site");
fs.mkdirSync(root);
const rowId = byName(d, "Button row").id;
const htmlExport = (await tool("export_code", { format: "html", id: rowId })).result;
const htmlText = typeof htmlExport === "string" ? htmlExport : (htmlExport.code ?? htmlExport.content ?? JSON.stringify(htmlExport));
let built = null;
if (process.env.E2E_DEPS) {
  const deps = path.resolve(process.env.E2E_DEPS);
  const proj = path.join(work, "proj");
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(proj, f.path)), { recursive: true });
    fs.writeFileSync(path.join(proj, f.path), f.content);
  }
  fs.writeFileSync(path.join(proj, "postcss.config.js"), "export default { plugins: [] };\n");
  fs.symlinkSync(path.join(deps, "node_modules"), path.join(proj, "node_modules"));
  built = true;
  try {
    for (const [bin, args] of [["tsc", ["--noEmit"]], ["vite", ["build"]]]) execFileSync(path.join(deps, "node_modules/.bin", bin), args, { cwd: proj, stdio: "pipe" });
  } catch (e) {
    built = false;
    console.log(String(e.stdout ?? "").slice(-1500), String(e.stderr ?? "").slice(-1500));
  }
  check("the exported project (with CONScreen and AppScreen) type-checks and builds offline", built);
  if (built) root = path.join(proj, "dist");
} else console.log("SKIP  building the exported project (set E2E_DEPS)");
fs.writeFileSync(path.join(root, "row.html"), htmlText);
const server = http.createServer((req, res) => {
  let f = path.join(root, decodeURIComponent((req.url ?? "/").split(/[?#]/)[0]));
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(root, "index.html");
  if (!fs.existsSync(f)) return res.writeHead(404).end();
  const type = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" }[path.extname(f)] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": type }).end(fs.readFileSync(f));
});
const port = Number(process.env.E2E_SERVE_PORT ?? 6822);
await new Promise((r) => server.listen(port, "127.0.0.1", r));
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await ctx.route((u) => !local(u), (r) => r.abort());
const appErrors = [];

if (built) {
  const app = await ctx.newPage();
  app.on("pageerror", (e) => appErrors.push(String(e)));
  await app.goto(`http://127.0.0.1:${port}/`);
  await app.waitForTimeout(800);
  const dom = await app.evaluate(() => ({
    mounted: document.querySelector("#root")?.children.length ?? 0,
    rotated: [...document.querySelectorAll("#root [class*='rotate(']")].map((e) => e.className),
  }));
  check("the built project mounts its first screen", dom.mounted > 0, JSON.stringify(dom).slice(0, 200));
  check("its rotated children carry rotate plus margin classes", dom.rotated.length >= 4 && dom.rotated.some((c) => c.includes("rotate(90deg)") && c.includes("my-[") && c.includes("mx-[")), JSON.stringify(dom.rotated).slice(0, 400));
  check("the built project ran without errors", appErrors.length === 0, appErrors.join(" | "));
  if (SHOTS) await app.screenshot({ path: path.join(SHOTS, "export-react-unstyled.png") });
}

const row = await ctx.newPage();
row.on("pageerror", (e) => appErrors.push(String(e)));
await row.goto(`http://127.0.0.1:${port}/row.html`);
await row.waitForTimeout(500);
const design = byName(d, "Button row");
const got = await row.evaluate(() => {
  const screen = document.querySelector("main > div");
  const r = screen.getBoundingClientRect();
  return {
    screen: { x: r.x, y: r.y, w: r.width, h: r.height },
    kids: [...screen.children].map((c) => {
      const b = c.getBoundingClientRect();
      return { x: b.x - r.x, y: b.y - r.y, w: b.width, h: b.height, transform: getComputedStyle(c).transform };
    }),
  };
});
check("the exported row has the design's six children and no wrapper", got.kids.length === 6, JSON.stringify(got.kids).slice(0, 300));
// getBoundingClientRect() of a rotated box is its bounding box: it must match the design's.
let all = got.kids.length === 6;
const detail = [];
KIDS.forEach((n, i) => {
  const want = bbox(byName(d, n));
  const have = got.kids[i];
  if (!have) return;
  const ok = near(have.x, want.x) && near(have.y, want.y) && near(have.w, want.w) && near(have.h, want.h);
  if (!ok) all = false;
  detail.push(`${n} want ${want.x.toFixed(1)},${want.y.toFixed(1)} ${want.w.toFixed(1)}x${want.h.toFixed(1)} got ${have.x.toFixed(1)},${have.y.toFixed(1)} ${have.w.toFixed(1)}x${have.h.toFixed(1)}`);
});
check("each rotated child's getBoundingClientRect() matches the design's bounding box within 1 px", all, detail.join(" | "));
check("the exported row is as big as the design's row", near(got.screen.w, design.width) && near(got.screen.h, design.height), `${got.screen.w}x${got.screen.h} vs ${design.width}x${design.height}`);
check("the exported HTML ran without errors", appErrors.length === 0, appErrors.join(" | "));
if (SHOTS) await row.screenshot({ path: path.join(SHOTS, "export-row.png"), clip: { x: 0, y: 0, width: 460, height: 120 } });
await ctx.close();
server.close();
fs.rmSync(work, { recursive: true, force: true });

check("no page errors in the editor", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
