// Round 10, editor papercuts: images land in the frame under their centre (drop and Place image),
// the hex field reverts in view-only tabs, active tools and the logo in forced colours, and new
// text starts white on a dark device frame.
// Usage: E2E_URL=http://localhost:5651 [E2E_OUT=dir] node scripts/qa/r10c-e2e.mjs (dev server running)

import { chromium } from "playwright-core";
import fs from "node:fs";

const URL = process.env.E2E_URL ?? "http://localhost:5651";
const OUT = process.env.E2E_OUT ?? "test-results";
fs.mkdirSync(OUT, { recursive: true });
const launch = { headless: true, args: ["--no-sandbox"] };
if (process.env.CHROMIUM) launch.executablePath = process.env.CHROMIUM;
else if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";
const PHOTO = new globalThis.URL("../fixtures/photos/photo-1.jpg", import.meta.url).pathname;

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOCAL = /^(http:\/\/(localhost|127\.0\.0\.1)|data:|blob:|ws:)/;
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
const nodes = (page) => page.evaluate(() => window.__dt.doc().nodes);
async function newFile(page) {
  await page.goto(URL);
  await page.click("button:has-text('New design file')");
  await page.waitForSelector("#dt-canvas");
  await sleep(300);
}
const frame = async (page, x, y, w, h, name) => {
  const r = await run(page, { op: "createShape", kind: "frame", x, y, width: w, height: h, parent: null });
  await run(page, { op: "update", ids: [r.id], patch: { name } });
  return r.id;
};
const at = async (page, x, y) => {
  const r = await page.locator("#dt-canvas").boundingBox();
  const v = await page.evaluate(() => window.__dt.viewport());
  return { x: r.x + v.x + x * v.zoom, y: r.y + v.y + y * v.zoom };
};
const drop = async (page, b64, name, p) =>
  page.evaluate(
    async ([b64, name, x, y]) => {
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bin], name, { type: "image/jpeg" }));
      document.getElementById("dt-canvas").dispatchEvent(new DragEvent("drop", { dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true }));
    },
    [b64, name, p.x, p.y],
  );

try {
  // 1. Dropping a photo on empty canvas: its top-left lies inside Outer but its centre does not.
  let page = await openPage();
  await newFile(page);
  await page.evaluate(() => window.__dt.setViewport({ zoom: 1, x: 100, y: 100 }));
  const outer = await frame(page, 0, 0, 500, 400, "Outer");
  const b64 = fs.readFileSync(PHOTO).toString("base64");
  await drop(page, b64, "hero.jpg", await at(page, 800, 600));
  await sleep(800);
  let img = Object.values(await nodes(page)).find((n) => n.name === "hero");
  check("drop on empty canvas near a frame makes a top-level image", img && img.parent === null, `parent=${img?.parent === outer ? "Outer" : img?.parent}`);
  await drop(page, b64, "inner.jpg", await at(page, 250, 200));
  await sleep(800);
  img = Object.values(await nodes(page)).find((n) => n.name === "inner");
  check("drop with the centre over a frame joins it", img && img.parent === outer);

  // 2. Place image with the viewport centre over empty canvas next to a frame.
  await newFile(page);
  await page.evaluate(() => window.__dt.setViewport({ zoom: 1, x: -240, y: -72 }));
  await sleep(150);
  const o2 = await frame(page, 0, 0, 500, 400, "Outer");
  await run(page, { op: "select", ids: [] });
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.locator("button[title^='Place image']").first().click()]);
  await chooser.setFiles(PHOTO);
  await sleep(900);
  const placed = Object.values(await nodes(page)).filter((n) => n.fills?.some((f) => f.type === "image"));
  check("Place image over empty canvas stays top-level", placed.length === 1 && placed[0].parent === null, `parent=${placed[0]?.parent === o2 ? "Outer" : placed[0]?.parent}`);

  // 3. Hex field in a view-only tab reverts.
  const A = page;
  await newFile(A);
  const r = await run(A, { op: "createShape", kind: "rectangle", x: 0, y: 0, width: 50, height: 50, parent: null });
  await run(A, { op: "select", ids: [r.id] });
  await sleep(2500);
  const hash = await A.evaluate(() => location.hash);
  const B = await A.context().newPage();
  await B.goto(URL + "/" + hash);
  await B.waitForSelector("#dt-canvas");
  await sleep(1200);
  const ro = await B.evaluate(() => window.__dt.state().readOnly);
  await B.evaluate((id) => window.__dt.dispatch({ op: "select", ids: [id] }), r.id);
  await sleep(300);
  const hex = B.locator("input[aria-label='Hex colour']").first();
  const before = await hex.inputValue();
  await hex.click({ force: true });
  await B.keyboard.press("Control+a");
  await B.keyboard.type("FF0000");
  await B.keyboard.press("Enter");
  await sleep(500);
  const shown = await hex.inputValue();
  const fill = await B.evaluate((id) => window.__dt.doc().nodes[id].fills[0].color, r.id);
  check("view-only tab: typed hex reverts to the paint's colour", ro && shown.toUpperCase() === before.toUpperCase() && shown.toUpperCase() !== "FF0000", `readOnly=${ro} before=${before} shown=${shown} fill=${fill}`);
  await B.close();
  // In an editable tab the normalised value stays.
  await run(A, { op: "select", ids: [r.id] });
  await sleep(200);
  const hexA = A.locator("input[aria-label='Hex colour']").first();
  await hexA.click();
  await A.keyboard.press("Control+a");
  await A.keyboard.type("f00");
  await A.keyboard.press("Enter");
  await sleep(400);
  check("editable tab: hex shows the normalised value", (await hexA.inputValue()) === "FF0000", await hexA.inputValue());
  await A.context().close();

  // 4. Forced colours: active tool, logo vs menu button.
  page = await openPage();
  await page.emulateMedia({ forcedColors: "active" });
  await newFile(page);
  await sleep(300);
  const forced = await page.evaluate(() => {
    const act = document.querySelector(".tbtn.active");
    const canvas = getComputedStyle(document.body).backgroundColor;
    const logo = document.querySelector(".logo")?.getBoundingClientRect();
    const menu = document.querySelector("button[title='Main menu']")?.querySelector("svg")?.getBoundingClientRect();
    const hit = logo && menu && !(logo.right <= menu.left || menu.right <= logo.left || logo.bottom <= menu.top || menu.bottom <= logo.top);
    return { bg: act && getComputedStyle(act).backgroundColor, canvas, hit, logo: !!logo, menu: !!menu };
  });
  check("forced colours: the active tool has a background other than Canvas", forced.bg && forced.bg !== forced.canvas, JSON.stringify(forced));
  check("forced colours: the logo and the menu chevron do not overlap", forced.logo && forced.menu && !forced.hit, JSON.stringify(forced));
  await page.screenshot({ path: `${OUT}/r10c-forced-toolbar.png`, clip: { x: 0, y: 0, width: 560, height: 48 } });
  await page.context().close();

  // 5. A text tool click on a dark device frame starts white; on the light variant it stays black.
  page = await openPage();
  await newFile(page);
  await page.evaluate(() => window.__dt.setViewport({ zoom: 0.5, x: 100, y: 100 }));
  const f = await frame(page, 0, 0, 390, 844, "Screen");
  await run(page, { op: "select", ids: [f] });
  await sleep(200);
  await page.locator("select[aria-label='Device']").selectOption({ index: 2 });
  await sleep(300);
  await page.locator("[role=group][aria-label='System UI'] button", { hasText: "Dark" }).click();
  await sleep(300);
  const textAt = async (px, py) => {
    const before = new Set(Object.keys(await nodes(page)));
    await page.keyboard.press("Escape");
    await page.keyboard.press("t");
    const p = await at(page, px, py);
    await page.mouse.click(p.x, p.y);
    await sleep(400);
    const now = await nodes(page);
    return Object.values(now).find((n) => !before.has(n.id) && n.type === "text");
  };
  const dark = await textAt(200, 400);
  check("text tool click on a dark device frame creates white text", dark && dark.fills?.[0]?.color?.toUpperCase() === "#FFFFFF", JSON.stringify(dark?.fills));
  await page.screenshot({ path: `${OUT}/r10c-dark-text.png` });
  await page.keyboard.press("Escape");
  await run(page, { op: "select", ids: [f] });
  await page.locator("[role=group][aria-label='System UI'] button", { hasText: "Light" }).click();
  await sleep(300);
  await run(page, { op: "select", ids: [] });
  const light = await textAt(200, 450);
  check("on the light variant new text stays black", light && light.fills?.[0]?.color?.toUpperCase() === "#000000", JSON.stringify(light?.fills));
  await page.context().close();
} catch (e) {
  check("script ran to the end", false, String(e));
}
await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`SUMMARY r10c ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
