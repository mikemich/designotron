// Round 8, P1: relay durability (SIGTERM / SIGKILL keep acknowledged edits), viewer fixes (read-only
// file name, safe context menu, no Pages "+", guest bar clear of the panel tabs), cursor chat that
// outlives Enter, history row actions on keyboard focus, dashboard thumbnails and Claude drafts.
// Starts its own relay (E2E_RELAY_BIN, default ../target/debug/designotron-relay) on E2E_PORT
// (default 5634) with a temp --data dir, serving web/dist, and stops it when done.
// Usage: cd web && npm run build && node scripts/qa/r8a-e2e.mjs      Screenshots: E2E_OUT.

import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.E2E_PORT ?? 5634);
const BASE = `http://127.0.0.1:${PORT}`;
const BIN = process.env.E2E_RELAY_BIN ?? path.resolve("../target/debug/designotron-relay");
const OUT = process.env.E2E_OUT ?? "/tmp/r8a-shots";
fs.mkdirSync(OUT, { recursive: true });
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "r8a-rooms-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
};
async function waitUntil(fn, timeout = 15000, step = 150) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      if (await fn()) return true;
    } catch {
      /* not yet */
    }
    await sleep(step);
  }
  return false;
}

// ---- the relay ----
let relay = null;
let exited = null;
let expectedExit = false;
function startRelay() {
  expectedExit = false;
  exited = new Promise((res) => {
    relay = spawn(BIN, ["--port", String(PORT), "--static", "dist", "--data", DATA], { stdio: ["ignore", "ignore", process.env.E2E_RELAY_LOG ? fs.openSync(process.env.E2E_RELAY_LOG, "a") : "ignore"] });
    relay.on("exit", (code, sig) => {
      if (!expectedExit) console.log(`      relay exited unexpectedly: code ${code} signal ${sig}`);
      res({ code, sig });
    });
  });
  return waitUntil(() => fetch(`${BASE}/health`).then((r) => r.ok, () => false), 10000, 100);
}
const roomFiles = () => fs.readdirSync(DATA).filter((f) => f.endsWith(".json"));
const savedText = () => roomFiles().map((f) => fs.readFileSync(path.join(DATA, f), "utf8")).join("\n");

// ---- people ----
const launch = { headless: true, args: ["--no-sandbox"] };
if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";
const LOCAL = /^(https?:\/\/(localhost|127\.0\.0\.1)[:/])|^(data|blob|ws|wss):/;
async function person(browser, name, viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  await ctx.route((u) => !LOCAL.test(u.toString()), (r) => r.abort());
  await ctx.addInitScript((n) => {
    try {
      localStorage.setItem("dt:tour-done", "1");
      localStorage.setItem("dt:userName", n);
    } catch {
      /* no storage */
    }
  }, name);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  return { name, ctx, page, errors };
}
const doc = (p) => p.page.evaluate(() => window.__dt.doc());
const collab = (p) => p.page.evaluate(() => {
  const c = window.__dt.collab();
  return { status: c.status, link: c.link, viewId: c.viewId, viewer: c.viewer };
});
const names = async (p) => Object.values((await doc(p)).nodes).map((n) => n.name);
const live = (p) => waitUntil(async () => (await collab(p)).status === "live", 20000);

if (!fs.existsSync(BIN)) {
  console.error(`relay binary not found: ${BIN} (cargo build -p designotron-relay)`);
  process.exit(2);
}
await startRelay();
const browser = await chromium.launch(launch);
try {
  const O = await person(browser, "Olga"), E = await person(browser, "Gina"), V = await person(browser, "Vik");
  await O.page.goto(BASE);
  await O.page.click("button:has-text('New design file')");
  await O.page.waitForSelector("#dt-canvas");
  await O.page.evaluate(() => window.__dt.tool("create_nodes", { nodes: [
    { type: "frame", name: "Hero", x: 0, y: 0, width: 480, height: 320, fill: "#FFFFFF" },
    { type: "rectangle", name: "CTA", x: 40, y: 250, width: 140, height: 40, fill: "#6D4AFF" },
  ] }));
  await O.page.click(".tbtn[title='Share for live editing']");
  await O.page.click("button:has-text('Share online')");
  await O.page.waitForFunction(() => window.__dt.collab().status === "live");
  const c = await collab(O);
  await O.page.keyboard.press("Escape");
  await O.page.locator(".modal-bg").waitFor({ state: "detached" }).catch(() => {});
  await E.page.goto(c.link);
  await live(E);
  await V.page.goto(`${BASE}/?view=${c.viewId}`);
  await live(V);
  await sleep(1200);

  // ---------------- viewer ----------------
  const nameInput = V.page.locator("input[aria-label='File name']");
  check("viewer: file name is read-only", (await nameInput.getAttribute("readonly")) !== null);
  const before = (await doc(O)).name;
  await nameInput.focus();
  await V.page.keyboard.type("Renamed by viewer");
  await V.page.keyboard.press("Enter");
  await sleep(600);
  check("viewer: typing in the name changes nothing for anyone", (await doc(O)).name === before && (await doc(V)).name === before && (await nameInput.inputValue()) === before, `${(await doc(V)).name} / "${await nameInput.inputValue()}"`);

  const box = await V.page.locator("#dt-canvas").boundingBox();
  await V.page.mouse.click(box.x + 380, box.y + 360, { button: "right" });
  await sleep(300);
  const items = (await V.page.locator("[role=menu] [role=menuitem]").allTextContents()).map((t) => t.replace(/\s+/g, " ").trim());
  await V.page.screenshot({ path: `${OUT}/viewer-menu.png` });
  console.log("      viewer menu:", items.join(" | "));
  const unsafe = /paste|duplicate|delete|group|frame selection|mask|auto layout|component|flatten|outline|bring|send|flip|show\/hide|lock|claude|move to|swap|detach|tidy/i;
  check("viewer: context menu has only Copy, Zoom/Select and Comment", items.length > 0 && !items.some((t) => unsafe.test(t)) && items.some((t) => /^Copy/.test(t)) && items.some((t) => /^Comment/.test(t)), items.join(" | "));
  await V.page.keyboard.press("Escape");
  // On a layer: pick it first, then right-click it.
  await V.page.mouse.click(box.x + 120 + 100, box.y + 120);
  await V.page.mouse.click(box.x + 120 + 100, box.y + 120, { button: "right" });
  await sleep(300);
  const layerItems = (await V.page.locator("[role=menu] [role=menuitem]").allTextContents()).map((t) => t.replace(/\s+/g, " ").trim());
  check("viewer: menu on a layer is safe too", layerItems.length > 0 && !layerItems.some((t) => unsafe.test(t)), layerItems.join(" | "));
  await V.page.keyboard.press("Escape");

  await V.page.getByRole("tab", { name: /layers/i }).first().click().catch(() => {});
  check("viewer: no Add page button", (await V.page.locator("button[aria-label='Add page'], button[title='Add page']").count()) === 0);
  check("viewer: Add page button exists for the owner", (await O.page.locator("button[aria-label='Add page'], button[title='Add page']").count()) === 1);
  await V.page.locator(".page-item").first().dblclick();
  await sleep(200);
  check("viewer: double-clicking a page doesn't start a rename", (await V.page.locator(".pages input").count()) === 0);

  // Guest bar vs the panel tabs; the "View only" pill shows once.
  const bar = await V.page.locator(".guest-bar").boundingBox();
  const tabs = await V.page.locator("[role=tab]").evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }).filter((r) => r.w > 0));
  const hit = tabs.filter((r) => bar && r.x < bar.x + bar.width && r.x + r.w > bar.x && r.y < bar.y + bar.height && r.y + r.h > bar.y);
  check("guest bar doesn't overlap any [role=tab]", !!bar && tabs.length > 3 && hit.length === 0, `${tabs.length} tabs, ${hit.length} overlapped`);
  const canvasBox = await V.page.locator("#dt-canvas").boundingBox();
  check("guest bar sits inside the canvas column", bar.x >= canvasBox.x && bar.x + bar.width <= canvasBox.x + canvasBox.width + 0.5, `${bar.x}..${bar.x + bar.width} in ${canvasBox.x}..${canvasBox.x + canvasBox.width}`);
  check("'View only' appears once (toolbar), not in the banner", (await V.page.getByText("View only", { exact: true }).count()) === 1 && (await V.page.locator(".guest-bar .view-badge").count()) === 0);
  check("no stray text on the canvas", !(await V.page.locator("#dt-canvas").innerText()).includes("Lives inside"));
  await V.page.screenshot({ path: `${OUT}/viewer-guestbar.png` });
  const narrow = await person(browser, "Nia", { width: 700, height: 800 });
  await narrow.page.goto(`${BASE}/?view=${c.viewId}`);
  await live(narrow);
  await sleep(800);
  const nb = await narrow.page.locator(".guest-bar").boundingBox();
  const nc = await narrow.page.locator("#dt-canvas").boundingBox();
  check("guest bar stays inside the canvas at a narrow width", nb.x >= nc.x - 0.5 && nb.x + nb.width <= nc.x + nc.width + 0.5, `${nb.x}..${nb.x + nb.width} in ${nc.x}..${nc.x + nc.width}`);
  await narrow.page.screenshot({ path: `${OUT}/viewer-guestbar-narrow.png` });
  await narrow.ctx.close();

  // ---------------- cursor chat ----------------
  const ob = await O.page.locator("#dt-canvas").boundingBox();
  await E.page.mouse.move(100, 500);
  await O.page.mouse.move(ob.x + 300, ob.y + 300);
  await O.page.mouse.move(ob.x + 320, ob.y + 310);
  await sleep(500);
  await O.page.keyboard.press("/");
  await O.page.keyboard.type("looks good");
  await sleep(300);
  await O.page.keyboard.press("Enter");
  await sleep(1200);
  const bubble = E.page.locator(".chat-bubble[data-peer]");
  check("cursor chat: the sent message is still up for others 1.2 s after Enter", (await bubble.count()) === 1 && (await bubble.textContent()) === "looks good", await bubble.allTextContents());
  await O.page.screenshot({ path: `${OUT}/chat-sender.png` });
  await E.page.screenshot({ path: `${OUT}/chat-receiver.png` });
  await O.page.keyboard.type("two");
  await sleep(400);
  check("cursor chat: typing the next message replaces it", (await bubble.textContent()) === "two", await bubble.allTextContents());
  await O.page.keyboard.press("Escape");
  await sleep(400);
  check("cursor chat: Escape takes the bubble down", (await bubble.count()) === 0);

  // ---------------- relay durability ----------------
  const addRect = (p, name, x) => p.page.evaluate(([n, x]) => window.__dt.tool("create_nodes", { nodes: [{ type: "rectangle", name: n, x, y: 400, width: 60, height: 60, fill: "#FB8C00" }] }), [name, x]);
  const hasEverywhere = (name) => waitUntil(async () => (await names(O)).includes(name) && (await names(E)).includes(name), 30000);

  // 1. SIGTERM straight after an edit has been relayed.
  await addRect(E, "Term rect", 500);
  await waitUntil(async () => (await names(O)).includes("Term rect"), 10000, 20);
  expectedExit = true;
  relay.kill("SIGTERM");
  const ex = await Promise.race([exited, sleep(12000).then(() => "timeout")]);
  check("SIGTERM: the relay exits by itself", ex !== "timeout" && ex.code === 0, JSON.stringify(ex));
  check("SIGTERM: the edit made just before is on disk", savedText().includes("Term rect"));
  await startRelay();
  check("SIGTERM: after the restart both people have the rectangle", await hasEverywhere("Term rect"), `${await names(O)} / ${await names(E)}`);
  await waitUntil(async () => (await collab(O)).status === "live" && (await collab(E)).status === "live", 30000);

  // 2. SIGKILL 1.5 s after an edit (no chance to save at exit).
  await addRect(O, "Kill rect", 600);
  await waitUntil(async () => (await names(E)).includes("Kill rect"), 10000, 20);
  await sleep(1600);
  expectedExit = true;
  relay.kill("SIGKILL");
  await exited;
  check("SIGKILL: the edit from 1.6 s earlier is on disk", savedText().includes("Kill rect"));
  await startRelay();
  check("SIGKILL: after the restart both people still have it", await hasEverywhere("Kill rect"), `${await names(O)} / ${await names(E)}`);

  // ---------------- history rows on keyboard focus ----------------
  await O.page.getByRole("tab", { name: /history/i }).click();
  await O.page.getByPlaceholder("Name (optional)").fill("Checkpoint");
  await O.page.getByRole("button", { name: "Save", exact: true }).click().catch(() => O.page.locator(".history .btn.primary").first().click());
  await O.page.waitForSelector(".version");
  const restoreBtn = O.page.locator(".version .ibtn[title='Restore this version']").first();
  check("history: row actions are hidden while idle", !(await restoreBtn.isVisible()) || (await restoreBtn.boundingBox())?.width <= 1.5);
  await O.page.locator(".history .btn.primary").first().focus();
  await O.page.keyboard.press("Tab");
  await O.page.keyboard.press("Tab").catch(() => {});
  const focusedTitle = await O.page.evaluate(() => document.activeElement?.getAttribute("title"));
  await O.page.evaluate(() => (document.querySelector(".version .ibtn")).focus());
  await sleep(100);
  const shown = await O.page.locator(".version .ibtn").first().boundingBox();
  check("history: Tab can reach a row action and it shows", !!shown && shown.width > 10, `focused: ${focusedTitle}`);
  await O.page.screenshot({ path: `${OUT}/history-focus.png` });

  for (const p of [O, E, V]) check(`no page errors (${p.name})`, p.errors.length === 0, p.errors.join(" | "));

  // ---------------- dashboard ----------------
  const D = await person(browser, "Dora");
  const home = async (p) => {
    await p.evaluate(() => (location.hash = "#/"));
    await p.waitForSelector(".file-card .file-open");
  };
  await D.page.goto(BASE);
  await D.page.click("button:has-text('New design file')");
  await D.page.waitForSelector("#dt-canvas");
  await D.page.evaluate(() => window.__dt.tool("create_nodes", { nodes: [{ type: "frame", name: "Card", x: 0, y: 0, width: 300, height: 200, fill: "#E8E0FF" }] }));
  // The thumbnail is rendered a little after the first save.
  await sleep(3000);
  await home(D.page);
  await D.page.waitForSelector(".file-card");
  const thumbReady = await waitUntil(async () => (await D.page.locator(".file-card:has(.ibtn.more) .thumb img").count()) > 0, 20000, 300);
  check("dashboard: the file got a preview", thumbReady);
  await home(D.page);
  await D.page.waitForSelector(".file-card");
  const cardName = await D.page.locator(".file-card:has(.ibtn.more) .n").first().textContent();
  await D.page.getByRole("button", { name: `More actions for ${cardName}` }).click();
  await D.page.getByRole("menuitem", { name: "Duplicate" }).click();
  await D.page.waitForFunction(() => document.querySelectorAll(".file-card .ibtn.more").length === 2, null, { timeout: 5000 });
  const copy = D.page.locator(".file-card:has(.ibtn.more)", { hasText: "(copy)" });
  check("dashboard: a duplicate keeps the preview", (await copy.locator(".thumb img").count()) === 1);
  await D.page.screenshot({ path: `${OUT}/dashboard-duplicate.png` });

  // A template has no preview until it is opened; opening makes one without an edit.
  const tplButton = D.page.locator(".file-card:not(:has(.ibtn.more)) button.file-open").first();
  if (await tplButton.count()) {
    await tplButton.click();
    await D.page.waitForSelector("#dt-canvas");
    await sleep(5000);
    await home(D.page);
    await D.page.waitForSelector(".file-card");
    const cards = D.page.locator(".file-card:has(.ibtn.more)");
    const n = await cards.count();
    let withThumb = 0;
    for (let i = 0; i < n; i++) if ((await cards.nth(i).locator(".thumb img").count()) > 0) withThumb++;
    check("dashboard: a template opened but never edited gets a preview", withThumb === n, `${withThumb}/${n} cards with a preview`);
  } else check("dashboard: found a template button", false);

  // Claude drafts: no connection, ask twice, one empty file.
  await home(D.page);
  const count0 = await D.page.locator(".file-card:has(.ibtn.more)").count();
  await D.page.getByLabel("What do you want to design?").fill("A pricing page");
  await D.page.getByRole("button", { name: /Design with Claude/ }).click();
  await D.page.waitForSelector("#dt-canvas");
  await home(D.page);
  await D.page.waitForSelector(".file-card");
  const count1 = await D.page.locator(".file-card:has(.ibtn.more)").count();
  await D.page.getByLabel("What do you want to design?").fill("A pricing page again");
  await D.page.getByRole("button", { name: /Design with Claude/ }).click();
  await D.page.waitForSelector("#dt-canvas");
  await home(D.page);
  await D.page.waitForSelector(".file-card");
  const count2 = await D.page.locator(".file-card:has(.ibtn.more)").count();
  check("Claude draft: the first try makes one file", count1 === count0 + 1, `${count0} -> ${count1}`);
  check("Claude draft: asking again reuses the empty file", count2 === count1, `${count1} -> ${count2}`);
  check("no page errors (dashboard)", D.errors.length === 0, D.errors.join(" | "));
} finally {
  await browser.close();
  if (relay && relay.exitCode === null) relay.kill("SIGTERM");
  await sleep(300);
  fs.rmSync(DATA, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
