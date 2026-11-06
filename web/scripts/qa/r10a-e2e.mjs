// Round 10 / P1, code export fidelity: a scrolling auto-layout screen with a fixed tab bar keeps its
// frame height and scrolls inside, accessible names on text-less controls, inline data-URL images
// moved to public/assets, frame names as screen hashes, the project notes.
// Usage: start `npm run dev` (port 5173), then `node scripts/qa/r10a-e2e.mjs`.
// Env: E2E_URL (default http://localhost:5173), CHROMIUM (executable path).
// E2E_DEPS: a directory holding an installed node_modules for the exported project (offline:
// `npm install --offline --ignore-scripts` from a package.json copied out of an export). With it the
// script builds the export, serves it on E2E_SERVE_PORT (default 5634) and checks it in the browser.
// Only local servers are used; every other request is aborted.

import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import setup from "./r10a-iphone.mjs";

const URL = process.env.E2E_URL ?? "http://localhost:5173";
const launch = { headless: true, args: ["--no-sandbox"] };
if (process.env.CHROMIUM) launch.executablePath = process.env.CHROMIUM;
else if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
}
const local = (u) => /^(127\.0\.0\.1|localhost)$/.test(new globalThis.URL(u).hostname) || /^(data|blob):/.test(u.toString());

const browser = await chromium.launch(launch);
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
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

await page.goto(URL);
await page.waitForSelector(".files", { timeout: 20000 });
await page.click("button:has-text('New design file')");
await page.waitForSelector("#dt-canvas", { timeout: 15000 });
await page.waitForTimeout(500);
await setup(page);
await page.waitForTimeout(500);

const work = fs.mkdtempSync(path.join(os.tmpdir(), "r10a-"));
const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 30000 }), page.click("button:has-text('Export code')")]);
const zipPath = path.join(work, "export.zip");
await dl.saveAs(zipPath);
const proj = path.join(work, "proj");
execFileSync("unzip", ["-q", zipPath, "-d", proj]);
const read = (f) => fs.readFileSync(path.join(proj, f), "utf8");
const feed = read("src/screens/Feed.tsx");

// B1: height instead of min-height, the scroller holds the layout, the tab bar sits outside it.
check("screen has a fixed height, no min-height", feed.includes("h-[874px]") && !feed.includes("min-h-[874px]"));
const scroller = feed.split("\n").find((l) => l.includes("overflow-y-auto")) ?? "";
check("the scroller holds the auto layout and padding", /flex-col/.test(scroller) && /gap-y-\[12px\]/.test(scroller) && /pt-\[/.test(scroller), scroller.trim().slice(0, 140));
const rootLine = feed.split("\n").find((l) => l.includes("h-[874px]")) ?? "";
check("the outer box clips but does not scroll or lay out", !/overflow-[xy]|overflow-auto|flex/.test(rootLine), rootLine.trim().slice(0, 140));

// B5: names for text-less controls.
const detail = read("src/screens/Detail.tsx");
check("text-less button named after its layer", feed.includes('aria-label="Filter button"'));
check("back control named", detail.includes('aria-label="Back"'));

// B3: the inline banner image is a file, once.
const banner = read("src/screens/Banner.tsx");
const assets = fs.existsSync(path.join(proj, "public/assets")) ? fs.readdirSync(path.join(proj, "public/assets")) : [];
check("no data: image left in the screens", !/data:image/.test(banner + feed + detail), `${banner.length} bytes`);
check("the banner image is in public/assets", assets.length === 1 && /\.png$/.test(assets[0]) && banner.includes(`/assets/${assets[0]}`), assets.join(","));

// B8, B10.
check("CLAUDE.md names get_nodes", read("CLAUDE.md").includes("`get_nodes`") && !read("CLAUDE.md").includes("`get_node`"));
check("index.css keeps a keyboard focus ring", read("src/index.css").includes(":focus-visible { outline: 2px solid"));
check("a frame name with a space is an alias", read("src/App.tsx").includes('"Filter sheet":"FilterSheet"'));

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
    console.log(String(e.stdout ?? e).slice(0, 800));
  }
  check("the export type-checks and builds", built);
  if (built) {
    const dist = path.join(proj, "dist");
    const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };
    const server = http.createServer((req, res) => {
      const f = path.join(dist, req.url.split("?")[0] === "/" ? "index.html" : req.url.split("?")[0]);
      if (!f.startsWith(dist) || !fs.existsSync(f)) return res.writeHead(404).end();
      res.writeHead(200, { "content-type": types[path.extname(f)] ?? "application/octet-stream" }).end(fs.readFileSync(f));
    });
    const port = Number(process.env.E2E_SERVE_PORT ?? 5634);
    await new Promise((r) => server.listen(port, "127.0.0.1", r));
    const ctx = await browser.newContext({ viewport: { width: 402, height: 874 }, deviceScaleFactor: 2 });
    await ctx.route((u) => !local(u), (r) => r.abort());
    const app = await ctx.newPage();
    await app.goto(`http://127.0.0.1:${port}/#Feed`);
    await app.waitForSelector("#root main > *");
    await app.waitForTimeout(500);
    const measure = () =>
      app.evaluate(() => {
        const tab = [...document.querySelectorAll("div")].find((d) => d.className.includes("top-[790px]"));
        const scroller = [...document.querySelectorAll("div")].find((d) => getComputedStyle(d).overflowY === "auto" && d.scrollHeight > d.clientHeight);
        return {
          docH: document.documentElement.scrollHeight,
          tabBottom: tab ? Math.round(tab.getBoundingClientRect().bottom) : -1,
          scrollTop: scroller ? scroller.scrollTop : -1,
          scrollerFound: !!scroller,
        };
      });
    const before = await measure();
    await app.mouse.move(200, 400);
    await app.mouse.wheel(0, 500);
    await app.waitForTimeout(500);
    const after = await measure();
    check("the page does not scroll, the frame does", before.docH <= 874 && after.docH <= 874 && after.scrollTop > 0, JSON.stringify(after));
    check("the fixed tab bar stays at the bottom of the screen", before.tabBottom === 874 && after.tabBottom === 874, `${before.tabBottom} -> ${after.tabBottom}`);
    await app.screenshot({ path: path.join(work, "feed-scrolled.png") });
    // B10: a frame's own name opens it.
    await app.goto(`http://127.0.0.1:${port}/#Filter%20sheet`);
    await app.waitForSelector("#root main > *");
    check("/#Filter%20sheet opens that screen", await app.getByText("Filter workouts").isVisible());
    await ctx.close();
    server.close();
  }
}

console.log(`work dir: ${work}`);
await browser.close();
const failed = results.filter((r) => !r.ok);
if (errors.length) console.log("page errors:", errors.slice(0, 5));
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
