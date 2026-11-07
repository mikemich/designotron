// Round 15 / r15c, export and file hardening:
//   X-06  a crafted font family and hostile names/values don't break out of the exported project
//         (checked in the source, and by building it offline and opening it in a browser),
//   Z-06  a view link, a copy link and a remote change carrying javascript:/data: links are stripped
//         when they load,
//   Z-04  the Share dialog says links carry every page and the comments.
// Usage: start `npm run dev` (E2E_URL, default http://localhost:6731), then
//   E2E_DEPS=<dir with node_modules> node scripts/qa/r15c-e2e.mjs
// Env: E2E_SERVE_PORT (default 6735), E2E_SHOTS (screenshot directory), CHROMIUM (executable path).
// Without E2E_DEPS the exported project is not built. Only local servers are used.

import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const URL = process.env.E2E_URL ?? "http://localhost:6731";
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

const XSS = "<script>window.__pwned=1</script>";
const EVIL_FONT = `Inter"; } </style>${XSS} a{`;

const browser = await chromium.launch(launch);
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, acceptDownloads: true });
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

await page.goto(URL);
await page.waitForSelector(".files", { timeout: 30000 });
await page.click("button:has-text('New design file')");
await page.waitForSelector("#dt-canvas", { timeout: 30000 });
await page.waitForTimeout(500);

// ---- the design: a crafted font, hostile names, a real Google font ----
await tool("define_variables", {
  collection: "Strings",
  modes: ["A", "B"],
  variables: [
    { name: "Trail", type: "string", values: { A: "ends with a backslash \\", B: "two\nlines" } },
    { name: `Quote "x" */ ${XSS}`, type: "string", values: { A: `He said "hi" </style>`, B: "ok" } },
  ],
});
await tool("create_nodes", {
  nodes: [
    {
      type: "frame",
      name: `Home */ ${XSS} {/* x`,
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      fill: "#FFFFFF",
      children: [
        { type: "text", name: "Evil", text: "Injected font", x: 10, y: 10, fontFamily: EVIL_FONT },
        { type: "text", name: "Open", text: "Open Sans text", x: 10, y: 60, fontFamily: "Open Sans" },
        { type: "text", name: "Play", text: "Playfair text", x: 10, y: 110, fontFamily: "Playfair Display" },
        { type: "text", name: "Slashes and more", text: `Name with separators ${XSS}`, x: 10, y: 160 },
      ],
    },
  ],
});
await page.waitForTimeout(300);

const exp = await tool("export_code", { format: "project" });
const files = exp.result.files;
const get = (p) => files.find((f) => f.path === p)?.content ?? "";
const css = get("src/index.css");
check("X-06: the crafted family isn't in index.css as markup", !css.includes("<script") && !css.includes("</style"), css.slice(0, 300));
const imp = css.match(/@import url\("([^"]*)"\);/);
check("X-06: the Google Fonts import is one well-formed string without the crafted family", !!imp && !/[<>{}\\]/.test(imp[1]) && !imp[1].includes("%22") && !imp[1].includes("script"), imp?.[1]);
const W = "wght@300;400;500;600;700;800";
check("X-06: real families (and the default Inter) give the usual URL", imp?.[1] === `https://fonts.googleapis.com/css2?family=Inter:${W}&family=Open+Sans:${W}&family=Playfair+Display:${W}&display=swap`, imp?.[1]);
const tokens = get("src/tokens.css");
check("string tokens end their strings (backslash and newline escaped)", tokens.includes('"ends with a backslash \\\\"') && tokens.includes('"two\\A lines"'), tokens);
check("no file but tsx and json carries the raw script tag", files.filter((f) => !/\.(tsx|json|md)$/.test(f.path)).every((f) => !f.content.includes(XSS)), files.filter((f) => f.content.includes(XSS)).map((f) => f.path).join());
const frameId = await page.evaluate(() => Object.values(window.__dt.doc().nodes).find((n) => n.type === "frame" && n.name.startsWith("Home")).id);
const html = (await tool("export_code", { format: "html", id: frameId })).result;
const htmlText = typeof html === "string" ? html : (html.code ?? html.content ?? JSON.stringify(html));
check("the HTML export's font link and style block stay closed", !/family=Inter%22|family=Inter"/.test(htmlText) && (htmlText.match(/<script/g) ?? []).length === 0, htmlText.slice(0, 200));

if (process.env.E2E_DEPS) {
  const deps = path.resolve(process.env.E2E_DEPS);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "r15c-"));
  const proj = path.join(work, "proj");
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(proj, f.path)), { recursive: true });
    fs.writeFileSync(path.join(proj, f.path), f.content);
  }
  fs.symlinkSync(path.join(deps, "node_modules"), path.join(proj, "node_modules"));
  let built = true;
  try {
    for (const [bin, args] of [["tsc", ["--noEmit"]], ["vite", ["build"]]]) execFileSync(path.join(deps, "node_modules/.bin", bin), args, { cwd: proj, stdio: "pipe" });
  } catch (e) {
    built = false;
    console.log(String(e.stdout ?? e).slice(0, 1500));
  }
  check("the export with hostile names type-checks and builds offline", built);
  if (built) {
    const dist = path.join(proj, "dist");
    const server = http.createServer((req, res) => {
      let f = path.join(dist, decodeURIComponent((req.url ?? "/").split(/[?#]/)[0]));
      if (!f.startsWith(dist) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(dist, "index.html");
      const type = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" }[path.extname(f)] ?? "application/octet-stream";
      res.writeHead(200, { "content-type": type }).end(fs.readFileSync(f));
    });
    const port = Number(process.env.E2E_SERVE_PORT ?? 6735);
    await new Promise((r) => server.listen(port, "127.0.0.1", r));
    const ctx = await browser.newContext({ viewport: { width: 700, height: 500 }, deviceScaleFactor: 2 });
    await ctx.route((u) => !local(u), (r) => r.abort());
    const app = await ctx.newPage();
    const appErrors = [];
    app.on("pageerror", (e) => appErrors.push(String(e)));
    await app.goto(`http://127.0.0.1:${port}/`);
    await app.waitForTimeout(800);
    const r = await app.evaluate(() => ({
      pwned: window.__pwned ?? null,
      scripts: document.querySelectorAll("script").length,
      texts: [...document.querySelectorAll("p")].map((p) => p.textContent),
      evilFont: getComputedStyle([...document.querySelectorAll("p")].find((p) => p.textContent === "Injected font")).fontFamily,
      body: getComputedStyle(document.body).backgroundColor,
    }));
    check("the built page runs nothing from the names", r.pwned === null && appErrors.length === 0, JSON.stringify([r.pwned, appErrors]));
    check("the page shows the text, including the one with a script tag as plain text", r.texts.includes("Injected font") && r.texts.some((t) => t.includes(XSS)), JSON.stringify(r.texts));
    check("the crafted family styles nothing but its own text", !/pwned|script/i.test(r.evilFont), r.evilFont);
    if (SHOTS) await app.screenshot({ path: path.join(SHOTS, "export.png") });
    await ctx.close();
    server.close();
  }
  fs.rmSync(work, { recursive: true, force: true });
} else console.log("SKIP  building the exported project (set E2E_DEPS)");

// ---- Z-06: crafted links ----
const doc = await page.evaluate(() => structuredClone(window.__dt.doc()));
const bad = structuredClone(doc);
const findByName = (d, n) => Object.values(d.nodes).find((x) => x.name === n);
const open = findByName(bad, "Open");
const evil = findByName(bad, "Evil");
open.interactions = [
  { trigger: "onClick", action: "openUrl", url: "javascript:window.__xss=1", transition: "instant", durationMs: 300 },
  { trigger: "onClick", action: "openUrl", url: "data:text/html,<script>window.__xss=2</script>", transition: "instant", durationMs: 300 },
  { trigger: "onClick", action: "openUrl", url: "https://example.com/ok", transition: "instant", durationMs: 300 },
];
evil.text.characters = "abcdef";
evil.text.runs = [
  { start: 0, end: 3, link: "javascript:window.__xss=3" },
  { start: 3, end: 6, link: "https://example.com/fine" },
];
const toData = (d) => zlib.gzipSync(Buffer.from(JSON.stringify({ v: 1, doc: d, assets: {} }))).toString("base64url");
const unsafe = (d) => {
  const urls = Object.values(d.nodes).flatMap((n) => [...(n.interactions ?? []).map((i) => i.url), ...(n.text?.runs ?? []).map((r) => r.link)]).filter(Boolean);
  return { bad: urls.filter((u) => !/^https?:/i.test(u)), good: urls.filter((u) => /^https?:/i.test(u)) };
};
const probe = unsafe(bad);
check("the crafted file really carries the links", probe.bad.length === 3, JSON.stringify(probe));

for (const kind of ["view", "copy"]) {
  const p = await context.newPage();
  const dialogs = [];
  p.on("dialog", (d) => {
    dialogs.push(d.message());
    d.dismiss();
  });
  await p.goto(`${URL}/#/${kind}/${toData(bad)}`);
  await p.waitForFunction(
    () => {
      try {
        return Object.keys(window.__dt.doc().nodes).length > 0;
      } catch {
        return false;
      }
    },
    null,
    { timeout: 20000 },
  );
  await p.waitForTimeout(800);
  const loaded = await p.evaluate(() => structuredClone(window.__dt.doc()));
  const u = unsafe(loaded);
  check(`Z-06: a crafted ${kind} link loads without javascript:/data: links`, u.bad.length === 0, JSON.stringify(u));
  check(`Z-06: ${kind} link keeps the https links`, u.good.length === 2, JSON.stringify(u));
  check(`Z-06: ${kind} link ran nothing`, (await p.evaluate(() => window.__xss ?? null)) === null && dialogs.length === 0);
  await p.close();
}

// A remote change (a peer's delta) with the same payload: only the changed ids are cleaned.
const canUndoBefore = await page.evaluate(() => window.__dt.state().canUndo);
const remote = await page.evaluate(
  ([openId, evilId, payload]) => {
    const d = window.__dt.doc();
    const nodes = {};
    for (const id of [openId, evilId]) nodes[id] = { ...structuredClone(d.nodes[id]), ...payload[id] };
    window.__dt.dispatch({ op: "applyRemote", delta: { nodes }, local: false });
    return structuredClone(window.__dt.doc());
  },
  [open.id, evil.id, { [open.id]: { interactions: open.interactions }, [evil.id]: { text: evil.text } }],
);
const ru = unsafe(remote);
check("Z-06: a remote delta with javascript:/data: links is stripped", ru.bad.length === 0 && ru.good.length === 2, JSON.stringify(ru));
check("Z-06: the remote change added no local undo step", (await page.evaluate(() => window.__dt.state().canUndo)) === canUndoBefore, "");

// ---- Z-04: the Share dialog says what a link carries ----
await page.click(".tbtn[title='Share for live editing']");
await page.waitForSelector(".share-carries", { timeout: 10000 });
const sentence = await page.textContent(".share-carries");
check("Z-04: the Share dialog says links carry every page and the comments", /every page/.test(sentence) && /comments/.test(sentence), sentence);
if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "share.png") });

check("no page errors in the editor", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
