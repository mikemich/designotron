// Round 14 / r14b, tokens in exported code: bound padding, gaps, sizes, stroke weight and typography
// export as var(--token) (so tokens.css and a density or theme mode attribute drive them), duplicate
// mode names export de-duplicated, and tokens.json is a W3C design tokens file (project export and the
// Variables dialog's Export JSON button).
// Usage: start `npm run dev` (E2E_URL, default http://localhost:6521), then
//   E2E_DEPS=<dir with node_modules> node scripts/qa/r14b-e2e.mjs
// Env: E2E_SERVE_PORT (default 6525), E2E_SHOTS (screenshot directory), CHROMIUM (executable path).
// Without E2E_DEPS the exported project is not built (only the source and tokens.json are checked).
// Only local servers are used; every other request is aborted.

import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const URL = process.env.E2E_URL ?? "http://localhost:6521";
const launch = { headless: true, args: ["--no-sandbox"] };
if (process.env.CHROMIUM) launch.executablePath = process.env.CHROMIUM;
else if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";
const SHOTS = process.env.E2E_SHOTS;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let failed = 0;
function check(name, ok, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + String(detail).slice(0, 400) : ""}`);
}
const local = (u) => /^(127\.0\.0\.1|localhost)$/.test(new globalThis.URL(u).hostname) || /^(data|blob):/.test(u.toString());

/** A DTCG file check: returns a list of problems. */
export function validateDtcg(json) {
  const problems = [];
  const paths = new Set();
  const tokens = [];
  const walk = (node, p, inherited) => {
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith("$")) continue;
      if (/[.{}]/.test(k)) problems.push(`bad key ${[...p, k].join("/")}`);
      if (v === null || typeof v !== "object") {
        problems.push(`${[...p, k].join(".")} is not an object`);
        continue;
      }
      if ("$value" in v) {
        paths.add([...p, k].join("."));
        tokens.push({ path: [...p, k].join("."), tok: v, group: inherited });
      } else walk(v, [...p, k], inherited ?? v);
    }
  };
  for (const [name, group] of Object.entries(json)) {
    const ext = group?.$extensions?.["com.designotron"];
    if (!Array.isArray(ext?.modes)) problems.push(`${name}: collection extension has no modes list`);
    walk(group, [name], { name, modes: ext?.modes ?? [] });
  }
  const ref = /^\{[^{}.]+(\.[^{}.]+)*\}$/;
  for (const { path: p, tok, group } of tokens) {
    const ext = tok.$extensions?.["com.designotron"] ?? {};
    if (tok.$type !== undefined && !["color", "number"].includes(tok.$type)) problems.push(`${p}: unknown $type ${tok.$type}`);
    if (tok.$type === undefined && !["string", "boolean"].includes(ext.type)) problems.push(`${p}: no $type and no extension type`);
    const okValue = (val, type) => {
      if (typeof val === "string" && val.startsWith("{")) return ref.test(val) && paths.has(val.slice(1, -1));
      if (type === "color") return typeof val === "string" && /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/.test(val);
      if (type === "number") return typeof val === "number";
      if (ext.type === "boolean") return typeof val === "boolean";
      return typeof val === "string";
    };
    if (!okValue(tok.$value, tok.$type)) problems.push(`${p}: bad $value ${JSON.stringify(tok.$value)}`);
    for (const [mode, val] of Object.entries(ext.modes ?? {})) {
      if (!group.modes.includes(mode)) problems.push(`${p}: unknown mode ${mode}`);
      if (!okValue(val, tok.$type)) problems.push(`${p}: bad ${mode} value ${JSON.stringify(val)}`);
    }
  }
  return { problems, tokens: tokens.length };
}

const browser = await chromium.launch(launch);
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, acceptDownloads: true });
await context.route((u) => !local(u), (r) => r.abort());
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

const tool = (name, input) => page.evaluate(([n, i]) => window.__dt.tool(n, i), [name, input]);
await page.goto(URL);
await page.waitForSelector(".files", { timeout: 30000 });
await page.click("button:has-text('New design file')");
await page.waitForSelector("#dt-canvas", { timeout: 30000 });
await page.waitForTimeout(500);

// ---- the design ----
await tool("define_variables", {
  collection: "Density",
  modes: ["Comfortable", "Compact"],
  variables: [
    { name: "Space/Pad", type: "number", values: { Comfortable: 24, Compact: 8 } },
    { name: "Space/Gap", type: "number", values: { Comfortable: 16, Compact: 4 } },
    { name: "Space/Box", type: "number", values: { Comfortable: 200, Compact: 120 } },
    { name: "Stroke", type: "number", values: { Comfortable: 4, Compact: 1 } },
    { name: "Line", type: "number", values: { Comfortable: 28, Compact: 20 } },
  ],
});
await tool("define_variables", {
  collection: "Theme",
  modes: ["Light", "Dark", "Dark B"],
  variables: [{ name: "Surface", type: "color", values: { Light: "#FFFFFF", Dark: "#111111", "Dark B": "#222222" } }],
});
// Two modes named Dark: rename the third (define_variables merges by name).
await page.evaluate(() => {
  const vars = structuredClone(window.__dt.doc().variables);
  const theme = vars.find((c) => c.name === "Theme");
  theme.modes[2].name = "Dark";
  window.__dt.dispatch({ op: "setVariables", collections: vars });
});
await tool("create_nodes", {
  nodes: [
    {
      type: "frame",
      name: "Card",
      x: 0,
      y: 0,
      width: 500,
      height: 400,
      fill: "#FFFFFF",
      stroke: "#336699",
      strokeWeight: 2,
      layout: { direction: "vertical", gap: 8, padding: 8 },
      bind: { fill: "Surface", padding: "Space/Pad", gap: "Space/Gap", strokeWeight: "Stroke" },
      children: [
        { type: "text", name: "Title", text: "Hello tokens", fontSize: 16, lineHeight: 28, bind: { lineHeight: "Line" } },
        { type: "rectangle", name: "Box", width: 200, height: 40, fill: "#FF0000", bind: { width: "Space/Box" } },
        {
          type: "frame",
          name: "Row",
          width: 300,
          height: 60,
          fill: "#00FF00",
          layout: { direction: "horizontal", gap: 0, padding: 0 },
          bind: { paddingLeft: "Space/Pad" },
          children: [{ type: "rectangle", name: "Dot", width: 20, height: 20, fill: "#0000FF" }],
        },
      ],
    },
  ],
});
await page.waitForTimeout(300);
const d = await page.evaluate(() => window.__dt.doc());
const byName = (n) => Object.values(d.nodes).find((x) => x.name === n);
const card = byName("Card");
check("the design is bound as intended", card.layout.paddingTop === 24 && card.layout.gap === 16 && card.strokeWeight === 4, JSON.stringify([card.layout.paddingTop, card.layout.gap, card.strokeWeight]));
check("the Row's left padding is bound", byName("Row").layout.paddingLeft === 24, JSON.stringify(byName("Row").layout));

// ---- export ----
const exp = await tool("export_code", { format: "project" });
const files = exp.result.files;
const get = (p) => files.find((f) => f.path === p)?.content ?? "";
const work = fs.mkdtempSync(path.join(os.tmpdir(), "r14b-"));
const proj = path.join(work, "proj");
for (const f of files) {
  fs.mkdirSync(path.dirname(path.join(proj, f.path)), { recursive: true });
  fs.writeFileSync(path.join(proj, f.path), f.content);
}
const screen = get("src/screens/Card.tsx");
console.log(screen.split("\n").filter((l) => l.includes("className")).join("\n"));
check("padding is the token", screen.includes("p-[calc(var(--space-pad)*1px)]"));
check("gap is the token", screen.includes("gap-y-[calc(var(--space-gap)*1px)]"));
check("stroke weight and its offset are the token", screen.includes("[outline:calc(var(--stroke)*1px)_solid_#336699]") && /\[outline-offset:calc\(var\(--stroke\)\*-(0\.5|1)px\)\]/.test(screen));
check("line height is the token", screen.includes("leading-[calc(var(--line)*1px)]"));
check("a fixed width is the token", screen.includes("w-[calc(var(--space-box)*1px)]"));
check("one bound side keeps the others literal", /pl-\[calc\(var\(--space-pad\)\*1px\)\]/.test(screen));
check("the screen keeps its own size literal", screen.includes("max-w-[500px]"));

const css = get("src/tokens.css");
check("tokens.css has the dark and dark-2 blocks", css.includes('[data-theme="dark"]') && css.includes('[data-theme="dark-2"]') && css.includes('[data-density="compact"]'), css);
check("tokens.ts lists dark and dark-2", /"theme": \["light", "dark", "dark-2"\]/.test(get("src/tokens.ts")), get("src/tokens.ts"));

// ---- tokens.json ----
const tokensText = get("tokens.json");
let tokens = {};
try {
  tokens = JSON.parse(tokensText);
} catch (e) {
  check("tokens.json parses", false, String(e));
}
const v1 = validateDtcg(tokens);
check("tokens.json is valid DTCG", v1.problems.length === 0 && v1.tokens === 6, `${v1.tokens} tokens; ${v1.problems.join("; ")}`);
check("types, hex values and modes", tokens.Density?.Space?.Pad?.$type === "number" && tokens.Density.Space.Pad.$value === 24 && tokens.Density.Space.Pad.$extensions["com.designotron"].modes.Compact === 8 && tokens.Theme?.Surface?.$type === "color" && tokens.Theme.Surface.$value === "#FFFFFF", JSON.stringify(tokens.Theme));
check("duplicate mode names are de-duplicated in the extension", JSON.stringify(tokens.Theme.$extensions["com.designotron"].modes) === '["Light","Dark","Dark-2"]' && tokens.Theme.Surface.$extensions["com.designotron"].modes["Dark-2"] === "#222222");
check("the README mentions tokens.json", get("README.md").includes("tokens.json"));
// An alias reference: bind one more variable through the engine and re-read.
await tool("define_variables", { collection: "Density", variables: [{ name: "Space/Alias", type: "number", value: { alias: "Density/Space/Pad" } }] });
const again = JSON.parse(await page.evaluate(() => window.__dt.query({ q: "tokensJson" })));
check("an alias is a {group.name} reference", again.Density.Space.Alias.$value === "{Density.Space.Pad}", JSON.stringify(again.Density.Space.Alias));
check("the alias file still validates", validateDtcg(again).problems.length === 0, validateDtcg(again).problems.join("; "));

// ---- Export JSON button ----
await page.keyboard.press("Escape");
await page.click("button:has-text('Open variables')");
await page.waitForSelector(".variables-dialog");
if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "variables-dialog.png") });
const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 15000 }), page.click(".variables-dialog button[aria-label='Export JSON']")]);
const dlPath = path.join(work, "dl.json");
await dl.saveAs(dlPath);
const dlJson = JSON.parse(fs.readFileSync(dlPath, "utf8"));
check("Export JSON downloads <name>-tokens.json", /-tokens\.json$/.test(dl.suggestedFilename()), dl.suggestedFilename());
check("the downloaded JSON is valid and has the Theme group", validateDtcg(dlJson).problems.length === 0 && !!dlJson.Theme && !!dlJson.Density, Object.keys(dlJson).join(","));

// ---- build the project and drive it ----
if (process.env.E2E_DEPS) {
  const deps = path.resolve(process.env.E2E_DEPS);
  fs.symlinkSync(path.join(deps, "node_modules"), path.join(proj, "node_modules"));
  const bin = (n, ...a) => execFileSync(path.join(deps, "node_modules/.bin", n), a, { cwd: proj, stdio: "pipe" });
  let built = true;
  try {
    bin("tsc", "--noEmit");
    bin("vite", "build");
  } catch (e) {
    built = false;
    console.log(String(e.stdout ?? e).slice(0, 1200));
  }
  check("the export type-checks and builds", built);
  if (built) {
    const dist = path.join(proj, "dist");
    const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
    let padOverride = null;
    const server = http.createServer((req, res) => {
      const f = path.join(dist, req.url.split("?")[0] === "/" ? "index.html" : req.url.split("?")[0]);
      if (!f.startsWith(dist) || !fs.existsSync(f)) return res.writeHead(404).end();
      let body = fs.readFileSync(f);
      // Editing a token in tokens.css (as built into the bundle): the default mode's value changes.
      if (padOverride !== null && f.endsWith(".css")) body = Buffer.from(String(body).replace(/(:root\s*\{[^}]*--space-pad:\s*)24/, `$1${padOverride}`));
      res.writeHead(200, { "content-type": types[path.extname(f)] ?? "application/octet-stream" }).end(body);
    });
    const port = Number(process.env.E2E_SERVE_PORT ?? 6525);
    await new Promise((r) => server.listen(port, "127.0.0.1", r));
    const ctx = await browser.newContext({ viewport: { width: 700, height: 600 }, deviceScaleFactor: 2 });
    await ctx.route((u) => !local(u), (r) => r.abort());
    const app = await ctx.newPage();
    const base = `http://127.0.0.1:${port}/`;
    const read = () =>
      app.evaluate(() => {
        const s = (e) => getComputedStyle(e);
        const title = [...document.querySelectorAll("p")].find((e) => e.textContent === "Hello tokens");
        const card = title.parentElement;
        const all = [...card.querySelectorAll("div")];
        const box = all.find((e) => s(e).backgroundColor === "rgb(255, 0, 0)");
        const row = all.find((e) => s(e).backgroundColor === "rgb(0, 255, 0)");
        return {
          padTop: s(card).paddingTop,
          gap: s(card).rowGap,
          outline: s(card).outlineWidth,
          bg: s(card).backgroundColor,
          lineHeight: s(title).lineHeight,
          boxW: s(box).width,
          rowPadL: s(row).paddingLeft,
        };
      });
    await app.goto(base);
    await app.waitForSelector("p");
    await app.waitForTimeout(200);
    const a = await read();
    check("comfortable: padding 24, gap 16, stroke 4, line 28, box 200, row padding 24", a.padTop === "24px" && a.gap === "16px" && a.outline === "4px" && a.lineHeight === "28px" && a.boxW === "200px" && a.rowPadL === "24px", JSON.stringify(a));
    if (SHOTS) await app.screenshot({ path: path.join(SHOTS, "export-comfortable.png") });
    await app.evaluate(() => document.documentElement.setAttribute("data-density", "compact"));
    await app.waitForTimeout(100);
    const b = await read();
    check("compact mode attribute: padding 8, gap 4, stroke 1, line 20, box 120, row padding 8", b.padTop === "8px" && b.gap === "4px" && b.outline === "1px" && b.lineHeight === "20px" && b.boxW === "120px" && b.rowPadL === "8px", JSON.stringify(b));
    if (SHOTS) await app.screenshot({ path: path.join(SHOTS, "export-compact.png") });
    // A spacing token edited in tokens.css moves the padding without touching the code.
    padOverride = 40;
    await app.goto(base);
    await app.waitForSelector("p");
    const c = await read();
    check("a tokens.css edit (pad 24 -> 40) changes padding and the Row's left padding", c.padTop === "40px" && c.rowPadL === "40px" && c.gap === "16px", JSON.stringify(c));
    padOverride = null;
    // Duplicate mode names do not collide.
    await app.goto(base);
    await app.waitForSelector("p");
    const bgOf = async (mode) => {
      await app.evaluate((m) => document.documentElement.setAttribute("data-theme", m), mode);
      await app.waitForTimeout(80);
      return (await read()).bg;
    };
    check("light, dark and dark-2 give three backgrounds", (await bgOf("light")) === "rgb(255, 255, 255)" && (await bgOf("dark")) === "rgb(17, 17, 17)" && (await bgOf("dark-2")) === "rgb(34, 34, 34)");
    await ctx.close();
    server.close();
  }
}

check("no page errors", errors.length === 0, errors.join("; "));
await browser.close();
fs.rmSync(work, { recursive: true, force: true });
console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
