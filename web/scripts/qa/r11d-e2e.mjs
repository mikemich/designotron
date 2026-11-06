// R11-P4: prototype export and presenter. An exported fixed tab bar doesn't move at the end of its
// list, a Scroll to jump scrolls its section into view, a click Change to stepper changes state,
// layers whose action can't be exported are not buttons; in the presenter Back from a smart animate
// plays a reversed smart animate, the crumb fits a 390 px phone with an overlay open, and click
// hotspots are reachable and activatable by keyboard.
// Usage: start `npm run dev`, then `E2E_URL=http://localhost:<port> node scripts/qa/r11d-e2e.mjs`.
// Env: E2E_URL (default http://localhost:5173), CHROMIUM (executable path), SHOTS (folder for screenshots),
//      E2E_DEPS (a folder with node_modules for the exported project: `npm install --offline
//      --ignore-scripts` in a folder holding its package.json; without it the export steps are skipped),
//      E2E_STATIC_PORT (static server for the built project, default 5645).

import { chromium } from "playwright-core";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const URL = process.env.E2E_URL ?? "http://localhost:5173";
const STATIC_PORT = Number(process.env.E2E_STATIC_PORT ?? 5645);
const SHOTS = process.env.SHOTS;
const launch = { headless: true, args: ["--no-sandbox"] };
if (process.env.CHROMIUM) launch.executablePath = process.env.CHROMIUM;
else if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";

let failed = 0;
function check(name, ok, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + String(detail).slice(0, 400) : ""}`);
}

const browser = await chromium.launch(launch);
const newContext = async (opts = {}) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, ...opts });
  // Nothing may leave this machine.
  await context.route(
    (u) => !/^(127\.0\.0\.1|localhost)$/.test(new globalThis.URL(u).hostname) && !/^(data|blob):/.test(u.toString()),
    (r) => r.abort(),
  );
  await context.addInitScript(() => {
    try {
      localStorage.setItem("dt:tour-done", "1");
    } catch {
      /* no storage */
    }
  });
  return context;
};
const errors = [];
const shot = async (page, name) => {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};

const tool = (page, name, input) => page.evaluate(([n, i]) => window.__dt.tool(n, i), [name, input]);
const ids = (r) => Object.fromEntries(r.result.created.map((c) => [c.name, c.id]));
const node = (page, name, parent) =>
  page.evaluate(([n, p]) => Object.values(window.__dt.doc().nodes).find((x) => x.name === n && (!p || x.parent === p))?.id, [name, parent ?? null]);
const setStart = (page, id) =>
  page.evaluate((f) => {
    const d = window.__dt.doc();
    const pg = Object.values(d.pages).find((p) => p.children.includes(f)) ?? Object.values(d.pages)[0];
    window.__dt.dispatch({ op: "setFlowStart", page: pg.id, id: f });
  }, id);
const crumb = (page) => page.locator(".presenter .bar .crumb").first().innerText().then((t) => t.trim());
const present = async (page) => {
  await page.click("button[title='Present']");
  await page.waitForSelector(".presenter");
  await page.waitForTimeout(400);
};
/** The design as a link payload (the format of #/copy/ and #/view/ links). */
const linkData = (page) =>
  page.evaluate(async () => {
    const json = JSON.stringify({ v: 1, doc: window.__dt.doc(), assets: {} });
    const buf = await new Response(new Blob([new TextEncoder().encode(json)]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
    let s = "";
    for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  });

const text = (name, t, x, y, fontSize = 16, color = "#111827", extra = {}) => ({ type: "text", name, text: t, x, y, fontSize, color, ...extra });
const box = (name, x, y, width, height, fill, children = [], extra = {}) => ({ type: "frame", name, x, y, width, height, ...(fill ? { fill } : {}), children, ...extra });

try {
  const context = await newContext();
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(URL);
  await page.waitForSelector(".files", { timeout: 20000 });
  await page.click("button:has-text('New design file')");
  await page.waitForSelector("#dt-canvas", { timeout: 20000 });
  await page.waitForTimeout(300);

  // ---- The prototype: a phone app (list with fixed header and tab bar, cart with a stepper, detail
  //      with a gallery overlay), a desktop settings page with jump links, and a smart animate pair ----
  const cards = [1, 2, 3, 4, 5, 6].map((i) =>
    box(`Card ${i}`, 20, 130 + (i - 1) * 200, 353, 180, "#F9FAFB", [text(`Name ${i}`, `Item ${i}`, 12, 132)], { cornerRadius: 16 }),
  );
  const created = await tool(page, "create_nodes", {
    nodes: [
      box("Products", 0, 0, 393, 852, "#FFFFFF", [
        box("Header", 0, 0, 393, 56, "#FFFFFF", [text("Shop title", "Shop", 24, 16, 22)], { scrollBehavior: "fixed" }),
        ...cards,
        box("Tab bar", 0, 768, 393, 84, "#FFFFFF", [text("Tab shop", "Shop", 40, 24, 13), text("Tab search", "Search", 170, 24, 13)], { scrollBehavior: "fixed" }),
      ], { overflow: "vertical" }),
      box("Cart", 500, 0, 393, 852, "#FFFFFF", [text("Cart title", "Your cart", 24, 80, 24)]),
      box("Detail", 1000, 0, 393, 852, "#FFFFFF", [
        text("Detail title", "Linen shirt", 24, 80, 24),
        box("Zoom", 24, 200, 200, 48, "#111827", [text("Zoom label", "Zoom photo", 20, 14, 16, "#FFFFFF")]),
      ]),
      box("Gallery zoom overlay with a long name", 1500, 0, 300, 400, "#374151", [text("Zoom note", "Photo", 24, 24, 18, "#FFFFFF")], { cornerRadius: 12 }),
      box("Settings", 2000, 0, 1440, 900, "#F3F4F6", [
        box("Sidebar", 0, 0, 240, 900, "#FFFFFF", [text("Sidebar title", "Menu", 24, 24, 18)], { scrollBehavior: "fixed" }),
        box("Jump Security", 264, 84, 120, 40, "#EEF2FF", [text("Jump label", "Security", 22, 11, 14)], { cornerRadius: 8 }),
        box("Docs link", 400, 84, 120, 40, "#EEF2FF", [text("Docs label", "Docs", 22, 11, 14)], { cornerRadius: 8 }),
        box("Gone", 400, 700, 50, 50, "#FFFFFF"),
        box("Section Profile", 264, 150, 1152, 300, "#FFFFFF", [text("Profile heading", "Profile settings", 24, 24, 20)]),
        box("Section Security", 264, 1800, 1152, 1200, "#FFFFFF", [text("Security heading", "Security settings", 24, 24, 20)]),
      ], { overflow: "vertical" }),
      box("List", 3600, 0, 393, 852, "#FFFFFF", [
        box("Hero", 20, 100, 353, 120, "#93C5FD", []),
        text("Title", "Canvas tote", 20, 240, 20),
        box("Open", 20, 300, 160, 48, "#111827", [text("Open label", "Open", 20, 14, 16, "#FFFFFF")]),
      ]),
      box("Expanded", 4100, 0, 393, 852, "#FFFFFF", [
        box("Hero", 0, 0, 393, 360, "#3B82F6", []),
        text("Title", "Canvas tote", 20, 380, 28),
      ]),
    ],
  });
  const m = ids(created);
  // Stepper set: three variants, Plus changes to the next one; Minus changes back on hover only.
  const variants = [1, 2, 3].map((q) =>
    box(`Qty=${q}`, 0, 1200 + (q - 1) * 80, 124, 40, "#F3F4F6", [
      box("Minus", 0, 0, 40, 40, null, [text("Minus label", "−", 14, 8, 18)], { cornerRadius: 20 }),
      text("Qty value", String(q), 52, 10),
      box("Plus", 84, 0, 40, 40, null, [text("Plus label", "+", 14, 8, 18)], { cornerRadius: 20 }),
    ], { cornerRadius: 20 }),
  );
  const vr = await tool(page, "create_nodes", { nodes: variants });
  const mk = await tool(page, "arrange", { action: "create_component", ids: vr.result.created.map((c) => c.id) });
  const comps = mk.result.ids;
  await tool(page, "arrange", { action: "combine_variants", ids: comps });
  await tool(page, "create_instance", { componentId: comps[0], x: 120, y: 230, parentId: m.Cart });
  for (const [i, comp] of comps.entries()) {
    const plus = await node(page, "Plus", comp);
    const minus = await node(page, "Minus", comp);
    if (i < 2) await tool(page, "set_prototype", { nodeId: plus, action: "change_to", destinationId: comps[i + 1] });
    if (i > 0) await tool(page, "set_prototype", { nodeId: minus, action: "change_to", destinationId: comps[i - 1], trigger: "hover" });
  }
  const set = (nodeId, rest) => tool(page, "set_prototype", { nodeId, ...rest });
  await set(await node(page, "Card 1"), { action: "navigate", destinationId: m.Detail });
  await set(await node(page, "Zoom"), { action: "open_overlay", destinationId: m["Gallery zoom overlay with a long name"], overlay: { position: "center", background: "#000000", backgroundOpacity: 0.3 } });
  await set(await node(page, "Jump Security"), { action: "scroll_to", destinationId: await node(page, "Section Security") });
  // A Scroll to whose destination was deleted: nothing the export can run.
  const docs = await set(await node(page, "Docs link"), { action: "scroll_to", destinationId: await node(page, "Gone") });
  await page.evaluate((id) => window.__dt.dispatch({ op: "delete", ids: [id] }), await node(page, "Gone"));
  await set(await node(page, "Open"), { action: "navigate", destinationId: m.Expanded, transition: "smart_animate" });
  await setStart(page, m.List);
  console.log("setup: docs link interaction ->", JSON.stringify(docs).slice(0, 160));

  // ---- Presenter: Back from a smart animate plays a reversed smart animate ----
  {
    const anims = () => page.evaluate(() => document.getAnimations().length);
    await present(page);
    await page.locator(`.presenter [data-hotspot="${await node(page, "Open")}"]`).click();
    const forward = await anims();
    await page.waitForTimeout(700);
    check("smart animate forward runs one animation per matched layer", forward > 1, `${forward} animations`);
    check("the crumb shows Expanded", (await crumb(page)).includes("Expanded"), await crumb(page));
    await page.click(".presenter button[title='Back']");
    const back = await anims();
    await shot(page, "r11d-smart-back");
    await page.waitForTimeout(700);
    check("Back from a smart animate plays a reversed smart animate (more than one animation)", back > 1, `${back} animations`);
    check("Back lands on List", (await crumb(page)).includes("List"), await crumb(page));

    // ---- Keyboard: Tab reaches a click hotspot, Enter and Space activate it ----
    const focusHotspot = async () => {
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press("Tab");
        if (await page.evaluate(() => document.activeElement?.hasAttribute("data-hotspot"))) return true;
      }
      return false;
    };
    await page.locator(".presenter").focus();
    const reached = await focusHotspot();
    const info = await page.evaluate(() => {
      const a = document.activeElement;
      return { role: a?.getAttribute("role"), label: a?.getAttribute("aria-label"), tab: a?.getAttribute("tabindex") };
    });
    check("Tab reaches a click hotspot with a role and a name", reached && info.role === "button" && info.label === "Open", JSON.stringify(info));
    await shot(page, "r11d-hotspot-focus");
    const ring = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
    check("the focused hotspot has a visible focus ring", ring !== "none", ring);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(700);
    check("Enter on the focused hotspot runs its click (Expanded)", (await crumb(page)).includes("Expanded"), await crumb(page));
    await page.click(".presenter button[title='Back']");
    await page.waitForTimeout(700);
    await page.locator(".presenter").focus();
    await focusHotspot();
    await page.keyboard.press("Space");
    await page.waitForTimeout(700);
    check("Space on the focused hotspot runs its click", (await crumb(page)).includes("Expanded"), await crumb(page));
    await page.keyboard.press("Escape");
    await page.waitForSelector(".presenter", { state: "detached" });
  }

  // ---- Presenter on a 390 px phone with an overlay open ----
  await setStart(page, m.Detail);
  const data = await linkData(page);
  {
    const phone = await newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const p = await phone.newPage();
    p.on("pageerror", (e) => errors.push(String(e)));
    await p.goto(`${URL}/#/view/${data}`);
    await p.waitForSelector(".presenter", { timeout: 20000 });
    await p.waitForTimeout(500);
    await p.locator(`.presenter [data-hotspot="${await node(page, "Zoom")}"]`).tap();
    await p.waitForSelector(".overlay-frame");
    await p.waitForTimeout(600);
    const r = await p.evaluate(() => {
      const bar = document.querySelector(".presenter .bar").getBoundingClientRect();
      const c = document.querySelector(".presenter .bar .crumb");
      const cr = c.getBoundingClientRect();
      return { bar: { l: Math.round(bar.left), r: Math.round(bar.right), h: Math.round(bar.height) }, crumbH: Math.round(cr.height), title: c.getAttribute("title"), shown: c.textContent };
    });
    await shot(p, "r11d-phone-overlay-crumb");
    check("the crumb is one line (height at most 24) on a 390 px phone with an overlay open", r.crumbH <= 24, JSON.stringify(r));
    check("the bar stays inside the 390 px window", r.bar.l >= 0 && r.bar.r <= 390, JSON.stringify(r.bar));
    check("the full crumb is the title", r.title === "Detail › Gallery zoom overlay with a long name", r.title);
    const under = await p.evaluate(() => [...document.querySelectorAll('.presenter .hotspot[tabindex="0"]')].filter((h) => !h.closest(".overlay-frame")).length);
    check("hotspots under an overlay are out of the Tab order", under === 0, `${under} tabbable under the overlay`);
    await phone.close();
  }

  // ---- The exported project ----
  const deps = process.env.E2E_DEPS;
  if (!deps) {
    console.log("SKIP  exported project steps (set E2E_DEPS)");
  } else {
    const built = await page.evaluate(async () => {
      const ex = await import("/src/exporter.ts");
      return ex.projectFiles();
    });
    const get = (p) => built.files.find((f) => f.path === p)?.content ?? "";
    const comps = get("src/components.tsx");
    const settings = get("src/screens/Settings.tsx");
    check("the export's scrollers carry overscroll-contain", /overscroll-y-contain/.test(get("src/screens/Products.tsx")), "");
    check("the stepper set keeps the picked variant (useState, change: messages)", /useState</.test(comps) && /change:/.test(comps));
    check("the Scroll to jump is a button with a scroll: action", /onNavigate\?\.\("scroll:/.test(settings) && /data-scroll-target/.test(settings));
    check("the README no longer lists Scroll to as unexported", !/- [^\n]*Scroll to[^\n]*isn't/.test(get("README.md")) && /Scroll to scrolls/.test(get("README.md")));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r11d-project-"));
    for (const f of built.files) {
      fs.mkdirSync(path.dirname(path.join(dir, f.path)), { recursive: true });
      fs.writeFileSync(path.join(dir, f.path), f.content);
    }
    fs.symlinkSync(path.join(deps, "node_modules"), path.join(dir, "node_modules"));
    let ok = true;
    let out = "";
    for (const [bin, args] of [["tsc", ["-b"]], ["vite", ["build"]]]) {
      try {
        out = execFileSync(path.join(dir, "node_modules/.bin", bin), args, { cwd: dir, encoding: "utf8", stdio: "pipe" });
      } catch (e) {
        ok = false;
        out = String(e.stdout ?? "") + String(e.stderr ?? "");
        break;
      }
    }
    check("the exported project passes tsc and vite build", ok, ok ? dir : out.slice(0, 800));
    if (ok) {
      const dist = path.join(dir, "dist");
      const server = http.createServer((req, res) => {
        let f = path.join(dist, decodeURIComponent((req.url ?? "/").split(/[?#]/)[0]));
        if (!f.startsWith(dist) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(dist, "index.html");
        const type = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" }[path.extname(f)] ?? "application/octet-stream";
        res.writeHead(200, { "content-type": type });
        res.end(fs.readFileSync(f));
      });
      await new Promise((resolve) => server.listen(STATIC_PORT, "127.0.0.1", resolve));
      try {
        const base = `http://127.0.0.1:${STATIC_PORT}/`;
        // Fixed tab bar at the end of the list: nothing moves, on a desktop window and on a phone.
        for (const [label, vp] of [["1440x900", { width: 1440, height: 900 }], ["390x844", { width: 390, height: 844 }]]) {
          const ex = await newContext({ viewport: vp });
          const p = await ex.newPage();
          p.on("pageerror", (e) => errors.push(String(e)));
          await p.goto(base + "#Products");
          await p.waitForSelector("text=Search");
          await p.waitForTimeout(400);
          const tabY = () => p.getByText("Search", { exact: true }).boundingBox().then((b) => Math.round(b.y));
          const headY = () => p.getByText("Shop", { exact: true }).first().boundingBox().then((b) => Math.round(b.y));
          const [t0, h0] = [await tabY(), await headY()];
          await p.mouse.move(vp.width / 2, vp.height / 2);
          for (let i = 0; i < 12; i++) {
            await p.mouse.wheel(0, 300);
            await p.waitForTimeout(60);
          }
          await p.waitForTimeout(300);
          const st = await p.evaluate(() => ({
            winY: window.scrollY,
            docH: document.documentElement.scrollHeight,
            list: Math.max(...[...document.querySelectorAll("div")].filter((e) => getComputedStyle(e).overflowY === "auto").map((e) => e.scrollTop)),
          }));
          const [t1, h1] = [await tabY(), await headY()];
          await shot(p, `r11d-export-tabend-${vp.width}`);
          check(`${label}: the list scrolled and the page did not (scrollY 0)`, st.list > 0 && st.winY === 0, JSON.stringify(st));
          check(`${label}: the fixed tab bar and header don't move at the end of the list`, t0 === t1 && h0 === h1, `tab ${t0} -> ${t1}, header ${h0} -> ${h1}`);
          console.log(`INFO  ${label}: document height ${st.docH}, viewport ${vp.height} (a phone screen taller than the window still scrolls the page)`);
          await ex.close();
        }
        {
          const ex = await newContext({ viewport: { width: 1440, height: 900 } });
          const p = await ex.newPage();
          p.on("pageerror", (e) => errors.push(String(e)));
          // Scroll to: the jump brings its section into view.
          await p.goto(base + "#Settings");
          await p.waitForSelector("text=Profile settings");
          const sec = () => p.getByText("Security settings", { exact: true }).boundingBox().then((b) => Math.round(b.y));
          const before = await sec();
          await p.getByText("Security", { exact: true }).click();
          await p.waitForTimeout(1200);
          const after = await sec();
          check("Scroll to scrolls its section into view", before > 900 && after >= 0 && after < 300, `heading y ${before} -> ${after}`);
          await shot(p, "r11d-export-scrollto");
          const docsBtn = await p.evaluate(() => {
            const el = [...document.querySelectorAll("*")].find((e) => e.children.length === 0 && e.textContent === "Docs");
            return el ? (el.closest("button, a, [role=button]")?.tagName ?? "none") : "missing";
          });
          check("a layer whose action can't be exported (a Scroll to with no target) is not rendered as a button", docsBtn === "none", String(docsBtn));

          // Change to: the stepper's + goes 1 -> 2 -> 3, and the unexportable hover Minus isn't a button.
          await p.goto(base + "#Cart");
          await p.waitForSelector("text=Your cart");
          const qty = () => p.evaluate(() => [...document.querySelectorAll("p")].map((e) => e.textContent).filter((t) => /^[123]$/.test(t ?? "")).join(","));
          const q0 = await qty();
          await p.getByText("+", { exact: true }).click();
          await p.waitForTimeout(200);
          const q1 = await qty();
          await p.getByText("+", { exact: true }).click();
          await p.waitForTimeout(200);
          const q2 = await qty();
          await shot(p, "r11d-export-stepper");
          check("click Change to: the stepper's + goes 1 -> 2 -> 3", q0 === "1" && q1 === "2" && q2 === "3", `${q0} ${q1} ${q2}`);
          const plusLeft = await p.getByText("+", { exact: true }).count();
          const minusBtn = await p.evaluate(() => {
            const el = [...document.querySelectorAll("*")].find((e) => e.children.length === 0 && e.textContent === "−");
            return el ? (el.closest("button, a, [role=button]")?.tagName ?? "none") : "missing";
          });
          check("at 3 the + has no action and the hover-only − is not a button", plusLeft === 1 && minusBtn === "none", `+ count ${plusLeft}, minus in ${minusBtn}`);
          await ex.close();
        }
      } finally {
        server.close();
      }
    }
  }
  await context.close();
  check("no page errors", errors.length === 0, errors.join(" | "));
} catch (e) {
  failed++;
  console.log("FAIL  script error", e);
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
