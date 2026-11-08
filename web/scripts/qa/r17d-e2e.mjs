// Round 17, package r17d (prototyping polish): overlays bigger than the screen scroll, Preserve scroll
// position, hotspot hint options, hotspot names and keyboard press, R restarts, no Push shadow strip
// and the Share "Open here in a new tab" label.
// Usage: serve web/dist (`vite preview --port 6931`), optionally the relay with the same dist
// (`designotron-relay --port 6933 --static web/dist --data <dir>`), then `node scripts/qa/r17d-e2e.mjs`.
// Env: E2E_URL (default http://127.0.0.1:6931), E2E_RELAY (default http://127.0.0.1:6933), CHROMIUM, SHOTS.
// Local servers only: every other request is aborted.

import { chromium } from "playwright-core";
import fs from "node:fs";

const URL = process.env.E2E_URL ?? "http://127.0.0.1:6931";
const RELAY = process.env.E2E_RELAY ?? "http://127.0.0.1:6933";
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
const shot = (page, name, opts = {}) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png`, ...opts }) : null);

const browser = await chromium.launch(launch);
async function newPage(opts = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, ...opts });
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
  const page = await context.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push("pageerror: " + String(e)));
  return page;
}

const tool = (page, name, input) => page.evaluate(([n, i]) => window.__dt.tool(n, i), [name, input]);
const text = (name, t, x, y, fontSize = 16, color = "#111827") => ({ type: "text", name, text: t, x, y, fontSize, color });
const box = (name, x, y, width, height, fill, children = [], extra = {}) => ({ type: "frame", name, x, y, width, height, ...(fill ? { fill } : {}), children, ...extra });
const rect = (name, x, y, width, height, fill) => ({ type: "rectangle", name, x, y, width, height, fill });

const W = 375;
const H = 812;
/** Home: a scrolling screen with buttons on top and tall content below; Home 2 has the same structure. */
const homeKids = () => [
  ...[
    ["Open tall", 20],
    ["Open scrolly", 80],
    ["Open far", 140],
    ["Hold", 200],
    ["Hover only", 260],
    ["Push", 320],
    ["Go Detail", 380],
    ["To KeyR", 440],
    ["Release", 490],
  ].map(([n, y]) => box(n, 16, y, 200, 44, "#DBEAFE", [text(n + " label", n, 12, 12, 15, "#1E3A8A")])),
  ...Array.from({ length: 10 }, (_, i) => box(`Card ${i + 1}`, 16, 580 + i * 100, 343, 88, "#FFFFFF", [text(`Card ${i + 1} title`, `Card ${i + 1}`, 16, 16, 18)])),
  rect("Spacer", 16, 1620, 343, 60, "#E2E8F0"),
];
const screens = () => [
  box("Home", 0, 0, W, H, "#F8FAFC", homeKids(), { overflow: "vertical" }),
  box("Home 2", 460, 0, W, H, "#F1F5F9", homeKids(), { overflow: "vertical" }),
  box("Detail", 920, 0, W, H, "#FFFFFF", [text("Detail heading", "Detail", 24, 80, 28), box("Open pop", 24, 200, 200, 44, "#DBEAFE", [text("Open pop label", "Open pop", 12, 12, 15)])]),
  box("KeyR", 1380, 0, W, H, "#FEF3C7", [text("KeyR heading", "Has its own R", 24, 80, 28)]),
  box("Tall", 1840, 0, 300, 1200, "#FFFFFF", [text("Tall title", "Tall overlay", 24, 24, 24), box("Tall bottom", 24, 1100, 252, 52, "#3B82F6", [text("Tall bottom label", "Go to Detail", 60, 16, 16, "#FFFFFF")], { cornerRadius: 12 })], { cornerRadius: 16 }),
  box("Scrolly", 2200, 0, 300, 400, "#FFFFFF", Array.from({ length: 9 }, (_, i) => box(`Item ${i + 1}`, 16, 16 + i * 80, 268, 64, "#EEF2FF", [text(`Item ${i + 1} text`, `Item ${i + 1}`, 12, 20, 16)])), { cornerRadius: 16, overflow: "vertical" }),
  box("Far", 2560, 0, 200, 100, "#FFFFFF", [text("Far text", "Far overlay", 16, 36, 16)], { cornerRadius: 12 }),
  box("Pop", 2820, 0, 200, 100, "#FFFFFF", [text("Pop text", "Pop", 16, 36, 18)], { cornerRadius: 12 }),
];

let ids = {};
const inside = (page, screen, name) =>
  page.evaluate(
    ([sid, n]) => {
      const d = window.__dt.doc();
      const walk = (id) => {
        const x = d.nodes[id];
        if (!x) return null;
        if (x.name === n && x.parent) return x.id;
        for (const c of x.children) {
          const r = walk(c);
          if (r) return r;
        }
        return null;
      };
      return walk(sid);
    },
    [ids[screen], name],
  );

async function build(page) {
  await page.goto(URL);
  await page.waitForSelector(".files", { timeout: 20000 });
  await page.click("button:has-text('New design file')");
  await page.waitForSelector("#dt-canvas", { timeout: 20000 });
  await sleep(300);
  const created = await tool(page, "create_nodes", { nodes: screens() });
  ids = Object.fromEntries(created.result.created.map((c) => [c.name, c.id]));
  const set = async (screen, layer, opts) => {
    const r = await tool(page, "set_prototype", { nodeId: layer ? await inside(page, screen, layer) : ids[screen], ...opts });
    if (!r?.ok) console.log("set_prototype failed", screen, layer, JSON.stringify(r).slice(0, 200));
  };
  await set("Home", "Open tall", { action: "open_overlay", destinationId: ids.Tall, transition: "instant" });
  await set("Home", "Open scrolly", { action: "open_overlay", destinationId: ids.Scrolly, transition: "instant" });
  await set("Home", "Open far", { action: "open_overlay", destinationId: ids.Far, overlay: { position: "manual", offsetX: 700, offsetY: 0 }, transition: "instant" });
  await set("Home", "Hold", { trigger: "press", action: "open_overlay", destinationId: ids.Pop, transition: "instant" });
  await set("Home", "Hover only", { trigger: "mouse_enter", action: "navigate", destinationId: ids.Detail, transition: "instant" });
  await set("Home", "Push", { action: "navigate", destinationId: ids.Detail, transition: "push", direction: "left", duration: 1000, easing: "linear" });
  await set("Home", "Go Detail", { action: "navigate", destinationId: ids.Detail, transition: "instant" });
  await set("Home", "Release", { trigger: "mouse_up", action: "navigate", destinationId: ids.Detail, transition: "instant" });
  await set("Home", "To KeyR", { action: "navigate", destinationId: ids.KeyR, transition: "instant" });
  await set("Home", null, { trigger: "key", key: "K", action: "navigate", destinationId: ids["Home 2"], transition: "instant", preserveScroll: true });
  await set("Home", null, { trigger: "key", key: "J", action: "navigate", destinationId: ids["Home 2"], transition: "instant" });
  await set("Detail", "Open pop", { action: "open_overlay", destinationId: ids.Pop, transition: "instant" });
  await set("Tall", "Tall bottom", { action: "navigate", destinationId: ids.Detail, transition: "instant" });
  await set("KeyR", null, { trigger: "key", key: "R", action: "navigate", destinationId: ids.Detail, transition: "instant" });
  await set("Pop", null, { action: "close_overlay" });
}

const crumb = (p) => p.locator(".presenter .crumb").first().innerText();
const overlayCount = (p) => p.locator(".presenter .overlay-backdrop").count();
async function present(p) {
  // Present starts at the selected frame when there is one: clear the selection.
  await p.evaluate(() => window.__dt.dispatch({ op: "select", ids: [] }));
  await p.click("button[title^='Present (']");
  await p.waitForSelector(".presenter");
  await sleep(250);
}
const stageBox = (p) => p.evaluate(() => { const r = document.querySelector(".presenter .stage").getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; });
const hotspot = (p, name) => p.locator(`.presenter .hotspot[aria-label='${name}']`);
const allLabelled = (p) =>
  p.evaluate(() => {
    const bad = [...document.querySelectorAll(".presenter .hotspot")].filter((h) => !h.getAttribute("aria-label") && h.getAttribute("aria-hidden") !== "true");
    return { total: document.querySelectorAll(".presenter .hotspot").length, bad: bad.length };
  });

/** Decodes two screenshots in the page and compares the column `x` for rows y0..y1 (device px). */
async function columnDiff(p, pngA, pngB, ax, bx, y0, y1) {
  return p.evaluate(
    async ([a, b, ax, bx, y0, y1]) => {
      const load = async (s) => {
        const bmp = await createImageBitmap(await (await fetch("data:image/png;base64," + s)).blob());
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const g = c.getContext("2d");
        g.drawImage(bmp, 0, 0);
        return g;
      };
      const [ga, gb] = [await load(a), await load(b)];
      const da = ga.getImageData(ax, y0, 1, y1 - y0).data;
      const db = gb.getImageData(bx, y0, 1, y1 - y0).data;
      let bad = 0;
      let max = 0;
      for (let i = 0; i < da.length; i += 4) {
        const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]));
        max = Math.max(max, d);
        if (d > 2) bad++;
      }
      return { rows: da.length / 4, bad, max };
    },
    [pngA.toString("base64"), pngB.toString("base64"), ax, bx, y0, y1],
  );
}

try {
  const p = await newPage();
  await build(p);
  await p.evaluate((id) => window.__dt.dispatch({ op: "setFlowStart", page: window.__dt.doc().pages[0].id, id }), ids.Home);

  // ---------- Share label ----------
  await p.click(".tbtn[title='Share for live editing']");
  await p.waitForSelector(".share-destination");
  const label = (await p.locator(".share-destination .link-btn").first().innerText().catch(() => "")).trim();
  check('Share link reads "Open here in a new tab"', label === "Open here in a new tab", label);
  check("the label's title says it opens the link on this editor", /this editor instead of/.test((await p.locator(".share-destination .link-btn").first().getAttribute("title")) ?? ""));
  check('no "Preview here" is left in the dialog', (await p.locator(".modal, .dialog").first().innerText().catch(() => "")).indexOf("Preview here") < 0);
  await p.keyboard.press("Escape");
  await sleep(200);
  if (await p.locator(".share-destination").count()) await p.mouse.click(5, 5);

  // ---------- presenter basics, hotspot names ----------
  await present(p);
  check("Present starts on Home", (await crumb(p)) === "Home", await crumb(p));
  let a11y = await allLabelled(p);
  check("every Home hotspot has an aria-label or is aria-hidden", a11y.total >= 8 && a11y.bad === 0, JSON.stringify(a11y));
  const hoverOnly = await p.evaluate(() => document.querySelector(".presenter .hotspot[data-hotspot]:not([aria-label])") && [...document.querySelectorAll(".presenter .hotspot:not([aria-label])")].every((h) => h.getAttribute("aria-hidden") === "true" && !h.hasAttribute("tabindex")));
  check("hover-only hotspots are aria-hidden and not Tab stops", hoverOnly === true);
  const holdLabel = await hotspot(p, "Hold, while pressing").count();
  check('a While pressing hotspot is named "Hold, while pressing"', holdLabel === 1);

  // ---------- Tab and Space on a While pressing hotspot ----------
  let reached = false;
  for (let i = 0; i < 14 && !reached; i++) {
    await p.keyboard.press("Tab");
    reached = (await p.evaluate(() => document.activeElement?.getAttribute("aria-label"))) === "Hold, while pressing";
  }
  check("Tab reaches the While pressing hotspot", reached);
  await p.keyboard.down("Space");
  await sleep(250);
  check("Space down opens its overlay", (await overlayCount(p)) === 1);
  a11y = await allLabelled(p);
  check("with an overlay open every hotspot still has a label or is aria-hidden", a11y.bad === 0, JSON.stringify(a11y));
  await p.keyboard.up("Space");
  await sleep(250);
  check("Space up closes it again", (await overlayCount(p)) === 0);
  check("the screen is still Home", (await crumb(p)) === "Home");

  // Tab follows the screen (top to bottom), not the order the hotspots were drawn in.
  await p.evaluate(() => document.querySelector(".presenter").focus());
  const order = [];
  // Enough presses to pass the bar's controls (Wave 4 added full screen) and wrap to the first hotspot.
  for (let i = 0; i < 30; i++) {
    await p.keyboard.press("Tab");
    const l = await p.evaluate(() => (document.activeElement?.classList.contains("hotspot") ? document.activeElement.getAttribute("aria-label") : null));
    if (l) order.push(l);
  }
  const want = ["Open tall", "Open scrolly", "Open far", "Hold, while pressing", "Push", "Go Detail", "To KeyR", "Release, mouse up"];
  check("Tab visits the hotspots top to bottom", want.every((w, i) => order[i] === w) && order[8] === want[0], order.join(" > "));

  // A key held on a Mouse up hotspot: the release acts, but not once R has restarted the screen.
  const focusLabel = async (label) => {
    await p.evaluate(() => document.querySelector(".presenter").focus());
    for (let i = 0; i < 20; i++) {
      await p.keyboard.press("Tab");
      if ((await p.evaluate(() => document.activeElement?.getAttribute("aria-label"))) === label) return true;
    }
    return false;
  };
  check("Tab reaches the Mouse up hotspot", await focusLabel("Release, mouse up"));
  await p.keyboard.down("Space");
  await p.keyboard.up("Space");
  await sleep(250);
  check("Space down and up on a Mouse up hotspot runs it on release", (await crumb(p)) === "Detail", await crumb(p));
  await p.keyboard.press("R");
  await sleep(250);
  await focusLabel("Release, mouse up");
  await p.keyboard.down("Space");
  await p.keyboard.press("r");
  await sleep(250);
  await p.keyboard.up("Space");
  await sleep(300);
  check("a key held across R does nothing when it is released", (await crumb(p)) === "Home", await crumb(p));
  await p.keyboard.down("Space"); // held while the presenter closes
  await p.keyboard.press("Escape");
  await sleep(250);
  await p.keyboard.up("Space");
  await sleep(250);
  check("a key held while the presenter closes does nothing afterwards", (await p.locator(".presenter").count()) === 0);
  await present(p);

  // ---------- overlay with its own overflow scrolls ----------
  await hotspot(p, "Open scrolly").click();
  await sleep(250);
  const own = await p.evaluate((id) => {
    const el = document.querySelector(`.presenter .overlay-frame [data-scroller="${id}"]`);
    if (!el) return null;
    el.scrollTop = 120;
    return { before: el.scrollHeight > el.clientHeight, top: el.scrollTop };
  }, ids.Scrolly);
  check("an overlay frame with its own overflow scrolls", !!own && own.before && own.top === 120, JSON.stringify(own));
  await p.waitForTimeout(100);
  await shot(p, "overlay-own-scroll");
  await p.keyboard.press("Escape");
  await sleep(250);

  // ---------- an overlay bigger than the screen ----------
  await hotspot(p, "Open tall").click();
  await sleep(300);
  const st = await stageBox(p);
  const tall = await p.evaluate(() => {
    const el = document.querySelector(".presenter .overlay-frame");
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, client: el.clientHeight, scroll: el.scrollHeight, scrolls: el.classList.contains("overlay-scrolls") };
  });
  check("a 1200 px overlay on an 812 px screen is limited to the screen", tall.client === H && tall.scroll >= 1200 && tall.top >= st.top - 1 && tall.bottom <= st.top + st.height + 1, JSON.stringify({ ...tall, stage: st }));
  await shot(p, "overlay-tall-top");
  await p.mouse.move(st.left + st.width / 2, st.top + st.height / 2);
  await p.mouse.wheel(0, 300);
  await sleep(300);
  const wheeled = await p.evaluate(() => document.querySelector(".presenter .overlay-frame").scrollTop);
  check("the wheel scrolls the overlay", wheeled > 100, String(wheeled));
  await p.evaluate(() => (document.querySelector(".presenter .overlay-frame").scrollTop = 1e6));
  await sleep(150);
  await shot(p, "overlay-tall-bottom");
  await hotspot(p, "Tall bottom").click();
  await sleep(300);
  check("its bottom button opens its destination", (await crumb(p)) === "Detail" && (await overlayCount(p)) === 0, await crumb(p));
  check("one overlay frame carries the scroll class when clipped", tall.scrolls);

  // ---------- a manual offset past the right edge ----------
  await p.keyboard.press("R");
  await sleep(300);
  await hotspot(p, "Open far").click();
  await sleep(300);
  const far = await p.evaluate(() => {
    const r = document.querySelector(".presenter .overlay-frame").getBoundingClientRect();
    return { left: r.left, right: r.right };
  });
  const st2 = await stageBox(p);
  check("a manual offset past the right edge stays inside the screen", far.left >= st2.left - 1 && far.right <= st2.left + st2.width + 1 && Math.abs(far.right - (st2.left + st2.width)) < 2, JSON.stringify({ far, st2 }));
  await p.keyboard.press("Escape");
  await sleep(250);

  // ---------- R restarts ----------
  await hotspot(p, "Go Detail").click();
  await sleep(250);
  await hotspot(p, "Open pop").click();
  await sleep(250);
  check("setup: on Detail with an overlay", (await crumb(p)).startsWith("Detail") && (await overlayCount(p)) === 1);
  await p.keyboard.press("r");
  await sleep(300);
  check("R returns to the start frame with no overlay", (await crumb(p)) === "Home" && (await overlayCount(p)) === 0, await crumb(p));
  await hotspot(p, "To KeyR").click();
  await sleep(250);
  check("setup: on KeyR", (await crumb(p)) === "KeyR");
  await p.keyboard.press("R");
  await sleep(300);
  check("a frame with its own Key trigger for R runs that instead", (await crumb(p)) === "Detail", await crumb(p));
  await p.locator(".presenter .bar button[title='Restart (R)']").click();
  await sleep(300);
  check("the Restart button restarts too", (await crumb(p)) === "Home");

  // ---------- Preserve scroll position ----------
  const homeScroll = (sel) => p.evaluate((s) => document.querySelector(`.presenter ${s}`)?.scrollTop ?? -1, sel);
  const scrollHome = async (top) => {
    await p.evaluate((t) => (document.querySelector(".presenter .stage .scroller").scrollTop = t), top);
    await sleep(150);
  };
  await scrollHome(400);
  await p.keyboard.press("K");
  await sleep(300);
  check("Navigate with Preserve scroll position on gives Home 2 the same scroll", (await crumb(p)) === "Home 2" && (await homeScroll(".stage .scroller")) === 400, `${await crumb(p)} ${await homeScroll(".stage .scroller")}`);
  await p.locator(".presenter .bar button[title='Back']").click();
  await sleep(300);
  const backTop = await homeScroll(".stage .scroller");
  console.log(`INFO  Back after a preserved navigation lands at scrollTop ${backTop} (today's behaviour: the screen starts at the top)`);
  await p.keyboard.press("R");
  await sleep(300);
  await scrollHome(400);
  await p.keyboard.press("J");
  await sleep(300);
  check("with the flag off the new screen starts at the top", (await crumb(p)) === "Home 2" && (await homeScroll(".stage .scroller")) === 0, `${await crumb(p)} ${await homeScroll(".stage .scroller")}`);
  await p.keyboard.press("R");
  await sleep(300);
  check("R also resets the scroll of the start screen", (await homeScroll(".stage .scroller")) === 0);

  // ---------- hotspot hints ----------
  const bar = ".presenter .bar button[aria-controls]";
  const item = (n) => p.getByRole("checkbox", { name: n });
  const flashes = () => p.locator(".presenter .hint-flash").count();
  await p.click(bar);
  check("the options menu offers both options with today's defaults", (await item("Show hotspot hints on click").isChecked()) && !(await item("Always show hotspots").isChecked()));
  await p.mouse.click(40, 450); // empty space outside the screen
  await sleep(80);
  check("a click on empty space flashes the hotspots (hints on)", (await flashes()) > 0);
  await sleep(500);
  await p.click(bar);
  await item("Show hotspot hints on click").uncheck();
  await p.mouse.click(40, 450);
  await sleep(80);
  check("with hints off a click on empty space doesn't flash", (await flashes()) === 0);
  await p.click(bar); // the click on empty space closed the menu
  await item("Always show hotspots").check();
  const outline = await p.evaluate(() => {
    const cs = getComputedStyle(document.querySelector(".presenter .hotspot[aria-label='Go Detail']"));
    return { style: cs.outlineStyle, width: cs.outlineWidth };
  });
  check("Always show hotspots outlines every hotspot", outline.style === "solid" && parseFloat(outline.width) >= 2, JSON.stringify(outline));
  await p.mouse.click(40, 450);
  await shot(p, "hints-always");
  const stored = await p.evaluate(() => [localStorage.getItem("dt:present-hints"), localStorage.getItem("dt:present-always")]);
  check("both options are remembered in localStorage", stored[0] === "0" && stored[1] === "1", JSON.stringify(stored));
  await p.click(".presenter .bar button[title='Close (Esc)']");
  await sleep(200);
  await present(p);
  const again = await p.evaluate(() => getComputedStyle(document.querySelector(".presenter .hotspot[aria-label='Go Detail']")).outlineStyle);
  check("they apply the next time the presenter opens", again === "solid");
  await p.click(bar);
  check("and the menu shows them", !(await item("Show hotspot hints on click").isChecked()) && (await item("Always show hotspots").isChecked()));
  await p.keyboard.press("Escape");
  await sleep(150);
  check("the options are a disclosure, not an ARIA menu", (await p.locator(".presenter [role='menu'], .presenter [aria-haspopup]").count()) === 0 && (await p.locator(bar).getAttribute("aria-expanded")) === "false");
  check("Escape closes the menu, not the presenter", (await p.locator(".presenter").count()) === 1 && (await p.locator(".presenter .bar-menu-list").count()) === 0);
  const menuOpen = () => p.locator(".presenter .bar-menu-list").count();
  await p.click(bar);
  await p.evaluate(() => (document.querySelector(".presenter .bar button[title=\x27Back\x27]") ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await sleep(150);
  check("Escape anywhere closes only the open options", (await menuOpen()) === 0 && (await p.locator(".presenter").count()) === 1);
  await p.click(bar);
  await p.keyboard.press("Tab");
  await p.keyboard.press("Tab");
  check("Tab inside the options stays open", (await menuOpen()) === 1);
  await p.keyboard.press("Tab");
  await sleep(100);
  check("Tab out of the options closes them", (await menuOpen()) === 0);
  await p.click(bar);
  await p.locator(".presenter .bar button[title='Back']").click();
  await sleep(100);
  check("clicking Back (or Next) closes the options", (await menuOpen()) === 0);
  await p.click(bar);
  await p.mouse.click(40, 450);
  await sleep(100);
  check("a click outside closes the options", (await menuOpen()) === 0);
  // With every hotspot outlined, the focused one still stands out.
  check("Tab reaches Go Detail", await focusLabel("Go Detail"));
  const ring = await p.evaluate(() => {
    const st = (el) => {
      const c = getComputedStyle(el);
      return `${c.outlineWidth}|${c.outlineColor}|${c.boxShadow}|${c.backgroundColor}`;
    };
    return { focused: st(document.activeElement), other: st(document.querySelector(".presenter .hotspot[aria-label='Push']")) };
  });
  check("in Always show hotspots mode the focus ring differs from the outline", ring.focused !== ring.other && /rgb\(255, 255, 255\)/.test(ring.focused), JSON.stringify(ring));
  await p.click(".presenter .bar button[title='Close (Esc)']");
  await sleep(200);

  // ---------- Push has no shadow strip ----------
  await present(p);
  const rest = await stageBox(p);
  const dsf = 2;
  const restPng = await p.screenshot();
  const measure = async (label) => {
    await hotspot(p, "Push").click();
    await p.waitForFunction(() => document.getAnimations().length >= 2, null, { timeout: 3000 });
    await p.evaluate(() => document.getAnimations().forEach((a) => (a.pause(), (a.currentTime = 400))));
    await sleep(150);
    const seam = await p.evaluate(() => {
      const l = document.querySelector(".presenter .stage-leaving").getBoundingClientRect();
      return { left: l.left, right: l.right };
    });
    const png = await p.screenshot();
    await shot(p, `push-${label}`, { clip: { x: Math.max(0, seam.right - 120), y: rest.top + 250, width: 240, height: 300 } });
    const x = seam.right - 8;
    const res = await columnDiff(p, png, restPng, Math.round(x * dsf), Math.round((rest.left + (x - seam.left)) * dsf), Math.round((rest.top + 250) * dsf), Math.round((rest.top + 750) * dsf));
    return { ...res, seam };
  };
  const pushed = await measure("fixed");
  check("Push at 40%: the leaving screen next to the seam has no shadow", pushed.bad === 0 && pushed.max <= 2, JSON.stringify(pushed));
  await p.keyboard.press("R");
  await sleep(300);
  // Control: the old rule (a shadow on every stage) must fail the same measurement.
  await p.addStyleTag({ content: ".presenter .stage { box-shadow: 0 20px 60px rgba(0,0,0,.6) !important; }" });
  const control = await measure("control-old-shadow");
  check("control: with the old per-stage shadow the same measurement fails", control.bad > 20, JSON.stringify(control));
  check("the shadow sits on the viewport instead", await p.evaluate(() => getComputedStyle(document.querySelector(".presenter .presenter-viewport")).boxShadow !== "none"));
  await p.keyboard.press("Escape");
  await sleep(250);

  // ---------- view-only player (view link) ----------
  const payload = await p.evaluate(async () => {
    const json = JSON.stringify({ v: 1, doc: window.__dt.doc(), assets: {} });
    const buf = await new Response(new Blob([new TextEncoder().encode(json)]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
    let s = "";
    for (const x of new Uint8Array(buf)) s += String.fromCharCode(x);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  });
  for (const [name, base] of [["editor server", URL], ["relay", RELAY]]) {
    const v = await newPage();
    try {
      await v.goto(base + "/");
    } catch {
      check(`view link on the ${name}`, false, "server not reachable");
      continue;
    }
    await v.goto(base + "/#/view/" + payload);
    const up = await v.waitForSelector(".presenter", { timeout: 15000 }).then(() => true).catch(() => false);
    check(`view link plays on the ${name}`, up);
    if (!up) continue;
    await sleep(300);
    check(`view-only (${name}): has the Restart button and the options menu`, (await v.locator(".presenter .bar button[title='Restart (R)']").count()) === 1 && (await v.locator(".presenter .bar button[aria-controls]").count()) === 1);
    await v.locator(".presenter .hotspot[aria-label='Open tall']").click();
    await sleep(300);
    check(`view-only (${name}): an overlay is open`, (await v.locator(".presenter .overlay-backdrop").count()) === 1);
    await v.keyboard.press("R");
    await sleep(300);
    check(`view-only (${name}): R with an overlay open restarts`, (await v.locator(".presenter .overlay-backdrop").count()) === 0 && (await v.locator(".presenter .crumb").first().innerText()) === "Home");
    check(`view-only (${name}): every hotspot has a label or is aria-hidden`, (await allLabelled(v)).bad === 0);
    if (base === URL) {
      await v.click(".presenter .bar button[aria-controls]");
      await v.getByRole("checkbox", { name: "Always show hotspots" }).check();
      await v.reload();
      await v.waitForSelector(".presenter", { timeout: 15000 });
      await sleep(300);
      const o = await v.evaluate(() => getComputedStyle(document.querySelector(".presenter .hotspot[aria-label='Go Detail']")).outlineStyle);
      check("view-only: Always show hotspots survives a reload", o === "solid");
      await shot(v, "view-hints");
    }
    await v.context().close();
  }

  const errs = p.errors.filter((e) => !/ERR_FAILED|status of 500|WebSocket/.test(e));
  check("no page errors", errs.length === 0, errs.join(" | ").slice(0, 300));
} catch (e) {
  failed++;
  console.log("FAIL  exception  - " + (e.stack ?? e.message).slice(0, 600));
}
await browser.close();
console.log(failed ? `\n${failed} FAILED` : "\nALL PASSED");
process.exit(failed ? 1 : 0);
