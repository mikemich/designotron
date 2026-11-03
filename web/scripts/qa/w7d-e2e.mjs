// Claude build quality (W7-D), the parts that need no Claude: the editor context line sent with
// every chat message says whether the page is empty (so Claude can skip get_document) or lists
// the top-level layers and where new screens fit, and quick actions that need content are off
// until there is some. The eval itself is web/scripts/eval (real Claude turns, run by hand).
// Usage: E2E_URL=http://localhost:5173 node scripts/qa/w7d-e2e.mjs (dev server running)

import { chromium } from "playwright-core";
import fs from "node:fs";

const URL = process.env.E2E_URL ?? "http://localhost:5173";
const launch = { headless: true, args: ["--no-sandbox"] };
if (process.env.CHROMIUM) launch.executablePath = process.env.CHROMIUM;
else if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
}

const browser = await chromium.launch(launch);
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await context.newPage();
await page.addInitScript(() => {
  try {
    localStorage.setItem("dt:tour-done", "1");
  } catch {
    /* no storage */
  }
});
page.on("pageerror", (e) => check("no page errors", false, String(e)));

const context_ = () => page.evaluate(() => window.__dt.contextLine());
// Opens the quick actions menu and returns { label: disabled }.
async function quickActions() {
  await page.click(".chat-input .ibtn[title='Quick actions']");
  await page.waitForSelector(".menu .item");
  const state = await page.$$eval(".menu .item", (els) => Object.fromEntries(els.map((e) => [e.textContent.trim(), e.disabled])));
  await page.keyboard.press("Escape");
  await page.waitForSelector(".menu", { state: "detached" }).catch(() => {});
  return state;
}

try {
  await page.goto(URL);
  await page.click("button:has-text('New design file')");
  await page.waitForSelector("#dt-canvas");
  if (!(await page.$(".chat"))) await page.keyboard.press("Control+/");
  await page.waitForSelector(".chat");

  // Empty page.
  const empty = await context_();
  check("context line says the page is empty", empty.includes("Page is empty.") && empty.includes("Nothing selected."), empty);
  let q = await quickActions();
  check("Dark mode version is disabled with nothing selected", q["Dark mode version"] === true, JSON.stringify(q["Dark mode version"]));
  check("Rename layers is disabled on an empty page", q["Rename layers semantically"] === true);
  check("Sync design to code is disabled on an empty page", q["Sync design → code in the workspace"] === true);
  check("Import a website needs nothing", q["Import a website by URL…"] === false);

  // Two top-level frames.
  const made = await page.evaluate(() =>
    window.__dt.tool("create_nodes", {
      nodes: [
        { type: "frame", name: "Home", x: 0, y: 0, width: 390, height: 844 },
        { type: "frame", name: "Settings", x: 470, y: 0, width: 390, height: 700 },
      ],
    }),
  );
  check("create_nodes worked", made.ok, JSON.stringify(made.result).slice(0, 120));
  const ids = made.result.created.map((c) => c.id);
  const filled = await context_();
  check("context line lists the layers", filled.includes("Page has 2 top-level layers") && filled.includes(`${ids[0]} "Home" 390×844`) && filled.includes(`${ids[1]} "Settings" 390×700`), filled);
  check("context line says where the next screen goes", filled.includes("x >= 940"), filled);
  check("context line no longer says empty", !filled.includes("Page is empty."));

  // Only the first 8 are listed.
  await page.evaluate(() =>
    window.__dt.tool("create_nodes", { nodes: Array.from({ length: 9 }, (_, i) => ({ type: "frame", name: `F${i}`, x: 1000 + i * 100, y: 0, width: 80, height: 80 })) }),
  );
  const many = await context_();
  check("long lists are cut at 8 layers", many.includes("Page has 11 top-level layers") && many.includes(", …;") && !many.includes('"F8"'), many.slice(0, 200));

  q = await quickActions();
  check("content actions are on once the page has layers", q["Rename layers semantically"] === false && q["Sync design → code in the workspace"] === false);
  check("Dark mode version still needs a selection", q["Dark mode version"] === true);
  await page.evaluate((id) => window.__dt.dispatch({ op: "select", ids: [id] }), ids[0]);
  const withSel = await context_();
  check("selection is reported", withSel.includes(`Selected: ${ids[0]} (frame "Home")`), withSel);
  q = await quickActions();
  check("Dark mode version is on with a selection", q["Dark mode version"] === false);
} catch (err) {
  check("unexpected exception", false, String(err));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
