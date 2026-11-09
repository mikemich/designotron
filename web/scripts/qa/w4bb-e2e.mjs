// Wave 4 stage B / w4b-b: the presenter gives no hotspot, Tab stop or hint flash to an interaction
// that can't act (navigate with no destination, or to a layer that is gone). A screen with three
// buttons: one navigates nowhere, one to a deleted layer, one to a real screen.
// Usage: `npm run build`, then `vite preview --port 7411`, then
//   E2E_URL=http://127.0.0.1:7411 node scripts/qa/w4bb-e2e.mjs
// Env: E2E_SHOTS (screenshot directory), CHROMIUM (executable path). Only local servers are used.

import { chromium } from "playwright-core";
import fs from "node:fs";

const URL = process.env.E2E_URL ?? "http://127.0.0.1:7411";
const SHOTS = process.env.E2E_SHOTS;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const launch = { headless: true, args: ["--no-sandbox"] };
if (process.env.CHROMIUM) launch.executablePath = process.env.CHROMIUM;
else if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";

let failed = 0;
function check(name, ok, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + String(detail).slice(0, 400) : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const local = (u) => /^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(u) || /^(data|blob):/.test(u);

const browser = await chromium.launch(launch);
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 2 });
await ctx.route("**/*", (route) => (local(route.request().url()) ? route.continue() : route.abort()));
await ctx.addInitScript(() => {
  try {
    localStorage.setItem("dt:tour-done", "1");
  } catch {
    /* no storage */
  }
});
const dialogs = [];
const errors = [];
const page = await ctx.newPage();
page.on("pageerror", (e) => errors.push(String(e)));
page.on("dialog", (d) => {
  dialogs.push(d.message());
  d.dismiss().catch(() => {});
});
await page.goto(URL);
await page.click("button:has-text('New design file')");
await page.waitForSelector("#dt-canvas");
await sleep(500);

const doc = () => page.evaluate(() => window.__dt.doc());
const named = async (name) => Object.values((await doc()).nodes).find((n) => n.name === name);
const tool = (name, input) => page.evaluate(([n, i]) => window.__dt.tool(n, i), [name, input]);
const dispatch = (cmd) => page.evaluate((c) => window.__dt.dispatch(c), cmd);

await tool("create_nodes", {
  nodes: [
    {
      type: "frame",
      name: "Home",
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      fill: "#ffffff",
      children: [
        { type: "rectangle", name: "NoDest", x: 20, y: 20, width: 100, height: 40, fill: "#3366ff" },
        { type: "rectangle", name: "Gone", x: 20, y: 90, width: 100, height: 40, fill: "#cc3333" },
        { type: "rectangle", name: "Real", x: 20, y: 160, width: 100, height: 40, fill: "#33aa55" },
      ],
    },
    { type: "frame", name: "Next", x: 500, y: 0, width: 400, height: 300, fill: "#eeeeee" },
    { type: "frame", name: "Doomed", x: 1000, y: 0, width: 400, height: 300 },
  ],
});
const base = { trigger: "onClick", delayMs: 800, action: "navigate", url: null, transition: "instant", durationMs: 0, overlay: { position: "center", offsetX: 0, offsetY: 0, closeOnClickOutside: true, background: null } };
const [home, next, doomed] = [await named("Home"), await named("Next"), await named("Doomed")];
const set = async (name, destination) => dispatch({ op: "setInteractions", id: (await named(name)).id, interactions: [{ ...base, destination }] });
await set("NoDest", null);
await set("Gone", doomed.id);
await set("Real", next.id);
// Delete the screen the middle button points at (the interaction keeps its stale id).
await dispatch({ op: "delete", ids: [doomed.id] });
const stale = (await named("Gone")).interactions[0].destination;
check("setup: the second interaction points at a layer that no longer exists", stale === doomed.id && !(await doc()).nodes[stale], stale);

await dispatch({ op: "setFlowStart", page: (await doc()).pages[0].id, id: home.id });
await dispatch({ op: "select", ids: [] });
await page.click("#right-tab-prototype");
await page.locator(".btn.block.primary:has-text('Present')").click();
await page.waitForSelector(".presenter", { timeout: 5000 });
await sleep(600);
if (SHOTS) await page.screenshot({ path: `${SHOTS}/presenting.png` });

const hotspots = await page.locator("[data-hotspot]").count();
check("presenting shows one hotspot", hotspots === 1, `${hotspots}`);
const which = await page.locator("[data-hotspot]").first().getAttribute("data-hotspot");
check("...and it is the one with a real destination", which === (await named("Real")).id, which);

const stops = await page.locator('.hotspot[tabindex="0"]').count();
check("one hotspot is in the Tab order", stops === 1, `${stops}`);
// Walk Tab through the whole presenter: the hotspot stops reached.
const seen = new Set();
await page.locator(".presenter").focus();
for (let i = 0; i < 12; i++) {
  await page.keyboard.press("Tab");
  const id = await page.evaluate(() => document.activeElement?.getAttribute("data-hotspot"));
  if (id) seen.add(id);
}
check("Tab reaches one hotspot stop", seen.size === 1, [...seen].join(","));

// A click on nothing flashes the clickable areas.
await page.locator(".presenter").click({ position: { x: 20, y: 400 }, force: true }).catch(() => {});
let flashed = 0;
for (let i = 0; i < 6 && !flashed; i++) {
  flashed = await page.locator(".hotspot.hint-flash").count();
  if (!flashed) await sleep(30);
}
check("the hint flash marks one hotspot", flashed === 1, `${flashed}`);

// The real hotspot still works.
await sleep(500);
await page.locator("[data-hotspot]").first().click({ force: true });
await sleep(500);
const open = await page.evaluate(() => document.querySelector(".presenter")?.textContent ?? "");
check("the real hotspot still navigates (the screen changed)", (await page.locator("[data-hotspot]").count()) === 0, open.slice(0, 80));
await page.keyboard.press("Escape");
await sleep(300);

check("no page errors", errors.length === 0, errors.join("|"));
check("no window.confirm, prompt or alert fired", dialogs.length === 0, dialogs.join("|"));
await ctx.close();
await browser.close();
console.log(failed ? `\n${failed} FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
