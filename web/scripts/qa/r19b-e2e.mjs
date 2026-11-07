// Round 19, package r19b (code export): token names that keep collections apart, landmarks that
// never nest, one h1 per screen, prototype links as anchors, aria-hidden vector art, and a screen
// root that scrolls sideways instead of clipping.
// Usage: serve web/dist (`vite preview --port 7111`), then `node scripts/qa/r19b-e2e.mjs`.
// Env: E2E_URL (default http://localhost:7111), E2E_EXPORT_PORT (exported HTML and project, default
//      7112), E2E_DEPS (a folder with node_modules for the exported React project; without it the
//      project is only read as text), E2E_AXE (path to axe.min.js; without it the axe step is
//      skipped), CHROMIUM (executable path), SHOTS (screenshot dir; deviceScaleFactor 2).
// Local servers only: every other request is aborted.

import { chromium } from "playwright-core";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const URL = process.env.E2E_URL ?? "http://localhost:7111";
const EXPORT_PORT = Number(process.env.E2E_EXPORT_PORT ?? 7112);
const DEPS = process.env.E2E_DEPS;
const AXE = process.env.E2E_AXE;
const SHOTS = process.env.SHOTS ?? "";
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const launch = { headless: true, args: ["--no-sandbox"] };
if (process.env.CHROMIUM) launch.executablePath = process.env.CHROMIUM;
else if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";

let failed = 0;
function check(name, ok, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + String(detail).slice(0, 500) : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOCAL = /^(http:\/\/(localhost|127\.0\.0\.1)|data:|blob:|ws:)/;

// Exported code is served from a scratch folder: single pages at /<name>.html, a built project at /app/.
const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), "r19b-export-"));
const TYPES = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url ?? "/").split(/[?#]/)[0]);
  let file = path.join(exportDir, url);
  if (url.startsWith("/app/") && (!fs.existsSync(file) || fs.statSync(file).isDirectory())) file = path.join(exportDir, "app/index.html");
  if (!file.startsWith(exportDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" }).end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(EXPORT_PORT, "127.0.0.1", r));

const browser = await chromium.launch(launch);
async function openPage(width = 1440, height = 900) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
  await context.route("**/*", (r) => (LOCAL.test(r.request().url()) ? r.continue() : r.abort()));
  await context.addInitScript(() => {
    try {
      localStorage.setItem("dt:tour-done", "1");
    } catch {
      /* no storage */
    }
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => check("no page errors", false, String(e)));
  return page;
}
const tool = (page, name, input) => page.evaluate(([n, i]) => window.__dt.tool(n, i), [name, input]);
const shot = async (page, name) => {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};

// ---------- the design: the shapes of the QA landing page and dashboard ----------
const F = (name, o = {}, children = []) => ({ type: "frame", name, ...o, children });
const T = (name, text, o = {}) => ({ type: "text", name, text, ...o });
const V = (name, svgPath, o = {}) => ({ type: "vector", name, svgPath, viewBox: [0, 0, 24, 24], width: 24, height: 24, fill: "#4F46E5", ...o });
const feature = (title) =>
  F(
    "Card/Feature",
    { width: "fill", minWidth: 280, maxWidth: 420, height: "hug", layout: { direction: "vertical", gap: 12, padding: 24 }, cornerRadius: 12, fill: "#FFFFFF", bind: { cornerRadius: "Radius/md" } },
    [V("Icon", "M3 3h18v18H3z"), T("Title", title, { fontSize: 20, fontWeight: 600, width: 260 }), T("Body", "Short body text for this card.", { fontSize: 16, width: 260 })],
  );
const landing = F("Landing", { x: 0, y: 0, width: 1440, height: "hug", layout: { direction: "vertical", gap: 0, padding: 0 }, fill: "#F5F5F7" }, [
  F("Header", { width: "fill", height: "hug", layout: { direction: "horizontal", align: "space-between", crossAlign: "center", padding: { vertical: 24, horizontal: 48 } }, fill: "#FFFFFF" }, [
    T("Logo", "Acme", { fontSize: 24, fontWeight: 700 }),
    F("Nav", { layout: { direction: "horizontal", gap: 24 } }, [T("Nav link", "Features", { fontSize: 16 }), T("Nav link", "Pricing", { fontSize: 16 }), T("Nav link", "Docs", { fontSize: 16 })]),
    V("Logo mark", "M4 4h16v16H4z", { name: "Logo mark" }),
  ]),
  F("Hero", { width: "fill", height: "hug", layout: { direction: "vertical", gap: 24, padding: { vertical: 96, horizontal: 48 }, crossAlign: "center" } }, [
    T("Headline", "Ship designs faster", { fontSize: 56, fontWeight: 700 }),
    T("Subhead", "A free design tool for small teams.", { fontSize: 18 }),
    V("Arrow", "M4 12h14M12 5l7 7-7 7"),
  ]),
  F("Features", { width: "fill", height: "hug", layout: { direction: "horizontal", wrap: true, gap: 24, counterGap: 24, padding: 48 } }, [
    feature("Real auto layout"),
    feature("Variables with modes"),
    feature("Components"),
    feature("Prototypes"),
    feature("Code export"),
    feature("Free and open source"),
  ]),
  F("Testimonial", { width: "fill", height: "hug", layout: { direction: "vertical", gap: 8, padding: 48 }, fill: "#FFFFFF" }, [
    T("Quote text", "We moved our whole design system into Designotron in one afternoon and the handoff to engineering finally stopped being a meeting for everyone on the team.", { fontSize: 24, italic: true, width: "fill" }),
  ]),
  F("Footer", { width: "fill", height: "hug", layout: { direction: "horizontal", align: "space-between", crossAlign: "center", padding: { vertical: 32, horizontal: 48 } }, fill: "#111118" }, [
    T("Copyright", "2026 Acme", { fontSize: 14, color: "#FFFFFF" }),
    F("Footer links", { layout: { direction: "horizontal", gap: 16 } }, [T("Footer link", "Privacy", { fontSize: 14, color: "#FFFFFF" }), T("Footer link", "Terms", { fontSize: 14, color: "#FFFFFF" })]),
  ]),
]);
const navItem = (label) =>
  F("Nav/Item", { width: "fill", height: "hug", layout: { direction: "horizontal", crossAlign: "center", padding: 12, gap: 12 }, cornerRadius: 8 }, [
    V("Icon", "M4 4h16v16H4z", { width: 20, height: 20 }),
    T("Label", label, { fontSize: 15 }),
  ]);
const dashboard = F("Dashboard", { x: 1600, y: 0, width: 1440, height: 900, layout: { direction: "horizontal" }, fill: "#F5F5F7", clip: true }, [
  F("Sidebar", { width: 240, height: "fill", layout: { direction: "vertical", gap: 8, padding: 24 }, fill: "#FFFFFF" }, [
    T("Brand", "Acme", { fontSize: 22, fontWeight: 700 }),
    navItem("Overview"),
    navItem("Projects"),
    navItem("Team"),
    navItem("Settings"),
  ]),
  F("Content", { width: "fill", height: "fill", layout: { direction: "vertical", gap: 24, padding: 32 } }, [
    T("Title", "Overview", { fontSize: 32, fontWeight: 700 }),
    T("Section", "Recent activity", { fontSize: 20, fontWeight: 600 }),
    T("Note", "Nothing has changed since yesterday.", { fontSize: 16 }),
  ]),
]);
const detail = F("Detail", { x: 3200, y: 0, width: 600, height: 400, layout: { direction: "vertical", padding: 32 }, fill: "#FFFFFF" }, [
  T("Detail title", "Feature details", { fontSize: 32, fontWeight: 700 }),
]);

async function buildDesign(page) {
  await page.goto(URL);
  await page.waitForSelector(".files", { timeout: 20000 });
  await page.click("button:has-text('New design file')");
  await page.waitForSelector("#dt-canvas", { timeout: 20000 });
  await sleep(300);
  await tool(page, "define_variables", { collection: "Radius", modes: ["Default"], variables: [{ name: "md", type: "number", value: 12 }, { name: "lg", type: "number", value: 20 }] });
  await tool(page, "define_variables", { collection: "Space", modes: ["Default"], variables: [{ name: "sm", type: "number", value: 8 }, { name: "md", type: "number", value: 16 }] });
  const r = await tool(page, "create_nodes", { nodes: [landing, dashboard, detail] });
  if (!r.ok) throw new Error("create_nodes: " + JSON.stringify(r).slice(0, 500));
  const ids = Object.fromEntries(r.result.created.map((c) => [c.name, c.id]));
  const nodes = await page.evaluate(() => Object.values(window.__dt.doc().nodes).map((n) => ({ id: n.id, name: n.name, characters: n.text?.characters })));
  const features = nodes.find((n) => n.characters === "Features");
  const pr = await tool(page, "set_prototype", { nodeId: features.id, action: "navigate", destinationId: ids.Detail });
  if (!pr.ok) throw new Error("set_prototype: " + JSON.stringify(pr).slice(0, 300));
  const start = await page.evaluate((id) => {
    const d = window.__dt.doc();
    const pg = Object.values(d.pages).find((p) => p.children.includes(id));
    window.__dt.dispatch({ op: "setFlowStart", page: pg.id, id });
  }, ids.Landing);
  void start;
  return ids;
}

/** What the loaded page says about itself: counts of landmarks and headings, the radius of a card. */
const audit = (page) =>
  page.evaluate(() => {
    const q = (s) => [...document.querySelectorAll(s)];
    const heads = q("h1,h2,h3,h4,h5,h6").map((h) => h.tagName);
    const card = [...document.querySelectorAll("*")].find((e) => e.children.length > 0 && e.textContent?.startsWith("Real auto layout") === false && /Real auto layout/.test(e.textContent ?? "") && getComputedStyle(e).borderRadius !== "0px");
    return {
      footer: q("footer").length,
      nav: q("nav").length,
      header: q("header").length,
      aside: q("aside").length,
      nested: q("footer footer, header header, nav nav, footer header, header footer, aside aside").length,
      h1: heads.filter((h) => h === "H1").length,
      heads,
      radius: card ? getComputedStyle(card).borderRadius : null,
      hidden: q("svg").filter((s) => s.parentElement?.getAttribute("aria-hidden") === "true").length,
      imgs: q("[role=img]").map((e) => e.getAttribute("aria-label")),
      svgs: q("svg").length,
    };
  });

try {
  const page = await openPage();
  const ids = await buildDesign(page);
  await shot(page, "design");

  // ---- Exported HTML at 1440 ----
  const out = {};
  for (const name of ["Landing", "Dashboard"]) {
    const r = await tool(page, "export_code", { format: "html", id: ids[name] });
    out[name] = r.result.code;
    fs.writeFileSync(path.join(exportDir, `${name.toLowerCase()}.html`), r.result.code);
    if (SHOTS) fs.writeFileSync(path.join(SHOTS, `${name.toLowerCase()}.html`), r.result.code);
  }
  const landingCss = out.Landing;
  check("the tokens block names the two md tokens apart", /--radius-md: 12;/.test(landingCss) && /--space-md: 16;/.test(landingCss) && !/--md:/.test(landingCss));
  const ctx = await openPage(1440, 900);
  const view = async (name, width = 1440) => {
    await ctx.setViewportSize({ width, height: 900 });
    await ctx.goto(`http://127.0.0.1:${EXPORT_PORT}/${name}.html`);
    await sleep(250);
  };
  await view("landing");
  const L = await audit(ctx);
  check("the card radius is the Radius/md token (12px), not Space/md (16px)", L.radius === "12px", L.radius);
  check("Landing: one footer, one nav, one header, nothing nested", L.footer === 1 && L.nav === 1 && L.header === 1 && L.nested === 0, JSON.stringify(L));
  check("Landing: exactly one h1, and it is the first heading", L.h1 === 1 && L.heads[0] === "H1", L.heads.join());
  check("Landing: the six card titles (20px, 600) are h2 under the h1", L.heads.join() === "H1,H2,H2,H2,H2,H2,H2", L.heads.join());
  check("Landing: no skipped heading level", L.heads.every((h, i) => i === 0 || Number(h[1]) <= Number(L.heads[i - 1][1]) + 1), L.heads.join());
  const quote = await ctx.evaluate(() => [...document.querySelectorAll("p,h1,h2,h3")].find((e) => /moved our whole design system/.test(e.textContent ?? ""))?.tagName);
  check("the long testimonial quote is a paragraph", quote === "P", quote);
  const logo = await ctx.evaluate(() => [...document.querySelectorAll("p,h1,h2,h3")].find((e) => e.textContent === "Acme")?.tagName);
  check("the logo text in the header is a paragraph", logo === "P", logo);
  check("vector art: the logo mark is an image with a name, the others are hidden", L.imgs.join() === "Logo mark" && L.hidden === L.svgs - 1, JSON.stringify([L.imgs, L.hidden, L.svgs]));
  check("the Features text is a link to the Detail screen", await ctx.evaluate(() => document.querySelector("a[href='#Detail']")?.textContent === "Features"));
  await shot(ctx, "landing-1440");
  await view("dashboard");
  const D = await audit(ctx);
  check("Dashboard: four Nav/Item rows give no nav landmark; one aside", D.nav === 0 && D.aside === 1, JSON.stringify(D));
  check("Dashboard: exactly one h1 (the 32px title), then an h2", D.h1 === 1 && D.heads.join() === "H1,H2", D.heads.join());
  await shot(ctx, "dashboard-1440");

  if (AXE && fs.existsSync(AXE)) {
    for (const name of ["landing", "dashboard"]) {
      await view(name);
      await ctx.addScriptTag({ content: fs.readFileSync(AXE, "utf8") });
      const res = await ctx.evaluate(() => window.axe.run(document, { runOnly: ["best-practice", "wcag2a", "wcag2aa"] }));
      const bad = res.violations.filter((v) => /^landmark-|^heading-order$|^page-has-heading-one$|^region$/.test(v.id)).map((v) => `${v.id}(${v.nodes.length})`);
      check(`axe on ${name}: no landmark or heading-order violations`, bad.length === 0, bad.join());
    }
  } else console.log("SKIP  axe (set E2E_AXE)");

  // ---- Below the design width: the root scrolls sideways ----
  for (const name of ["landing", "dashboard"]) {
    await view(name, 390);
    const s = await ctx.evaluate(() => {
      const root = document.querySelector("main > div");
      const cs = getComputedStyle(root);
      return { sw: root.scrollWidth, cw: root.clientWidth, ox: cs.overflowX, oy: cs.overflowY, page: document.documentElement.scrollWidth };
    });
    check(`${name} at 390: the screen root scrolls horizontally (scrollWidth ${s.sw} > ${s.cw})`, s.sw > s.cw && s.ox === "auto" && s.oy === "hidden", JSON.stringify(s));
    check(`${name} at 390: the page itself does not scroll sideways`, s.page <= 390, String(s.page));
  }
  await view("landing", 390);
  const reached = await ctx.evaluate(() => {
    const root = document.querySelector("main > div");
    const last = [...root.querySelectorAll("footer *")].reverse().find((e) => e.textContent === "Terms");
    root.scrollLeft = root.scrollWidth;
    const a = last.getBoundingClientRect();
    return a.right <= window.innerWidth + 1 && a.left >= 0;
  });
  check("at 390 the right-most footer link can be scrolled into view", reached);
  await shot(ctx, "landing-390");
  await ctx.context().close();

  // ---- The React project ----
  const pr = await tool(page, "export_code", { format: "project" });
  const files = pr.result.files;
  const get = (p) => files.find((f) => f.path === p)?.content ?? "";
  const landingTsx = get("src/screens/Landing.tsx");
  const tokens = get("src/tokens.css");
  check("project: tokens.css has --radius-md and --space-md", /--radius-md: 12;/.test(tokens) && /--space-md: 16;/.test(tokens) && !/--md:/.test(tokens));
  check("project: Landing.tsx has an anchor with preventDefault and a hash", /href="#Detail"/.test(landingTsx) && /e\.preventDefault\(\); onNavigate\?\.\("Detail"\)/.test(landingTsx), landingTsx.slice(0, 300));
  check("project: App.tsx handles hashchange", /hashchange/.test(get("src/App.tsx")));
  if (!DEPS) console.log("SKIP  building the React project (set E2E_DEPS)");
  else {
    const dir = path.join(exportDir, "app-src");
    for (const f of files) {
      fs.mkdirSync(path.dirname(path.join(dir, f.path)), { recursive: true });
      fs.writeFileSync(path.join(dir, f.path), f.content);
    }
    fs.symlinkSync(path.join(DEPS, "node_modules"), path.join(dir, "node_modules"));
    let ok = true;
    let log = "";
    for (const [bin, args] of [["tsc", ["-b"]], ["vite", ["build", "--base", "/app/"]]]) {
      try {
        log = execFileSync(path.join(dir, "node_modules/.bin", bin), args, { cwd: dir, encoding: "utf8", stdio: "pipe" });
      } catch (e) {
        ok = false;
        log = String(e.stdout ?? "") + String(e.stderr ?? "");
        break;
      }
    }
    check("the exported project passes tsc and vite build", ok, ok ? "" : log.slice(0, 800));
    if (ok) {
      fs.cpSync(path.join(dir, "dist"), path.join(exportDir, "app"), { recursive: true });
      const p = await openPage(1440, 900);
      await p.goto(`http://127.0.0.1:${EXPORT_PORT}/app/`);
      await p.waitForSelector("text=Ship designs faster");
      const link = p.locator("a[href='#Detail']").first();
      check("the Features text is an anchor in the built app", (await link.count()) === 1 && (await link.textContent()) === "Features");
      await link.click();
      await p.waitForSelector("text=Feature details");
      await sleep(150);
      check("clicking the link opens the screen and the address says #Detail", (await p.evaluate(() => location.hash)) === "#Detail", await p.evaluate(() => location.hash));
      await p.goto(`http://127.0.0.1:${EXPORT_PORT}/app/#Dashboard`);
      await p.reload();
      await p.waitForSelector("text=Recent activity");
      check("loading #Dashboard opens the Dashboard directly", true);
      await p.evaluate(() => {
        location.hash = "#Nowhere";
      });
      await sleep(200);
      check("an unknown hash is ignored (a screen still shows)", (await p.locator("main").innerText()).length > 0);
      await shot(p, "app-dashboard");
      await p.context().close();
    }
  }
  await page.context().close();
} catch (e) {
  check("script ran to the end", false, e?.stack ?? String(e));
}

await browser.close();
server.close();
fs.rmSync(exportDir, { recursive: true, force: true });
console.log(failed ? `\n${failed} FAILED` : "\nAll passed");
process.exit(failed ? 1 : 0);
