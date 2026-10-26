// Prototype overlays: modal + menu on a screen, played in the editor's Present mode and in a
// view-only link. Usage: start `npm run dev`, then `node scripts/overlays-e2e.mjs`.
// Env: E2E_URL (default http://localhost:5173), E2E_OUT (screenshot dir), CHROMIUM (executable path).

import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const URL = process.env.E2E_URL ?? "http://localhost:5173";
const OUT = process.env.E2E_OUT ?? "test-results";
fs.mkdirSync(OUT, { recursive: true });

const launch = { headless: true, args: ["--no-sandbox"] };
if (process.env.CHROMIUM) launch.executablePath = process.env.CHROMIUM;
else if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";
if (process.env.HTTPS_PROXY) launch.proxy = { server: process.env.HTTPS_PROXY, bypass: "localhost,127.0.0.1" };

let failed = 0;
function check(name, ok, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const browser = await chromium.launch(launch);
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, ignoreHTTPSErrors: true });
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
page.on("console", (m) => m.type() === "error" && !m.text().includes("WebSocket") && !m.text().includes("Failed to load resource") && errors.push(m.text()));
const shotOf = (p, name) => p.screenshot({ path: path.join(OUT, `ov-${name}.png`) });
const shot = (name) => shotOf(page, name);
const doc = () => page.evaluate(() => window.__dt.doc());
const tool = (name, input) => page.evaluate(([n, i]) => window.__dt.tool(n, i), [name, input]);
const byName = (d, name) => Object.values(d.nodes).find((n) => n.name === name);
const crumb = (page) => page.locator(".presenter .bar .muted").innerText();
const overlays = (page) => page.locator(".presenter .overlay-backdrop").count();
const box = (page, sel) => page.locator(sel).first().boundingBox();

async function playTests(page, label, ids) {
  const hot = (name) => page.locator(`.presenter [data-hotspot="${ids[name]}"]`);
  const stage = await box(page, ".presenter .stage");
  check(`${label}: starts on Home with no overlay`, (await crumb(page)).trim() === "Home" && (await overlays(page)) === 0);

  // Open the modal: centred, dimmed.
  await hot("Open modal").click();
  await page.waitForSelector(".presenter .overlay-backdrop");
  await page.waitForTimeout(400);
  const modal = await box(page, ".presenter .overlay-frame");
  const centred = Math.abs(modal.x + modal.width / 2 - (stage.x + stage.width / 2)) < 3 && Math.abs(modal.y + modal.height / 2 - (stage.y + stage.height / 2)) < 3;
  check(`${label}: modal opens centred`, centred, `${JSON.stringify(modal)} on ${JSON.stringify(stage)}`);
  const dim = await page.locator(".presenter .overlay-backdrop").evaluate((e) => getComputedStyle(e).backgroundColor);
  check(`${label}: background dimmed 30% black`, dim === "rgba(0, 0, 0, 0.3)", dim);
  await shotOf(page, `${label}-1-modal`);

  // Click outside closes.
  await page.mouse.click(stage.x + 15, stage.y + stage.height - 15);
  await page.waitForTimeout(100);
  check(`${label}: outside click closes`, (await overlays(page)) === 0);

  // Open again, close with its Close button (hotspot inside the overlay).
  await hot("Open modal").click();
  await page.waitForSelector(".presenter .overlay-frame");
  await hot("Close").click();
  await page.waitForTimeout(100);
  check(`${label}: close button closes`, (await overlays(page)) === 0);

  // Click inside the modal (not on a hotspot) keeps it open.
  await hot("Open modal").click();
  await page.waitForSelector(".presenter .overlay-frame");
  const m2 = await box(page, ".presenter .overlay-frame");
  await page.mouse.click(m2.x + 10, m2.y + 10);
  check(`${label}: click inside the overlay keeps it open`, (await overlays(page)) === 1);

  // Swap to the menu from a button in the modal: menu sits top right, no dim.
  await hot("To menu").click();
  await page.waitForTimeout(400);
  check(`${label}: swap replaces the overlay`, (await overlays(page)) === 1 && (await crumb(page)).includes("Menu"), await crumb(page));
  const menu = await box(page, ".presenter .overlay-frame");
  check(`${label}: menu at the top right`, Math.abs(menu.x + menu.width - (stage.x + stage.width)) < 3 && Math.abs(menu.y - stage.y) < 3, JSON.stringify(menu));
  const dim2 = await page.locator(".presenter .overlay-backdrop").evaluate((e) => getComputedStyle(e).backgroundColor);
  check(`${label}: menu has no dim`, dim2 === "rgba(0, 0, 0, 0)", dim2);
  await shotOf(page, `${label}-2-menu`);

  // Escape closes the top overlay (and leaves the player open).
  await page.keyboard.press("Escape");
  await page.waitForTimeout(100);
  check(`${label}: Escape closes the overlay`, (await overlays(page)) === 0 && (await page.locator(".presenter").count()) === 1);

  // Nested: menu -> item opens the modal over it (stack of 2); back pops one at a time.
  await hot("Menu button").click();
  await page.waitForSelector(".presenter .overlay-frame");
  await hot("Item modal").click(); // menu item opens modal
  await page.waitForTimeout(300);
  check(`${label}: overlays stack`, (await overlays(page)) === 2);
  await shotOf(page, `${label}-3-stack`);
  await page.locator(".presenter .bar button[title='Back']").click();
  check(`${label}: back closes the top overlay first`, (await overlays(page)) === 1 && (await crumb(page)).includes("Menu"), await crumb(page));
  await page.keyboard.press("Escape");
  check(`${label}: Escape closes the last overlay`, (await overlays(page)) === 0);

  // Navigating closes overlays; the menu's "Settings" item navigates to Settings.
  await hot("Menu button").click();
  await page.waitForSelector(".presenter .overlay-frame");
  await hot("Item settings").click();
  await page.waitForTimeout(400);
  check(`${label}: navigate from an overlay leaves it`, (await overlays(page)) === 0 && (await crumb(page)).trim() === "Settings", await crumb(page));
  await shotOf(page, `${label}-4-navigated`);
}

try {
  await page.goto(URL);
  await page.waitForSelector(".files", { timeout: 20000 });
  await page.click(".file-card:has-text('Mobile app')");
  await page.waitForSelector("#dt-canvas", { timeout: 15000 });
  await page.waitForTimeout(500);

  // Replace the sample with a screen, a modal and a menu.
  await page.evaluate(() => {
    const d = window.__dt.doc();
    window.__dt.dispatch({ op: "delete", ids: Object.values(d.nodes).filter((n) => n.parent === null && ["frame", "component"].includes(n.type)).map((n) => n.id) });
  });
  const mk = (type, name, props = {}) => ({ type, name, ...props });
  const button = (name, label, extra = {}) => mk("frame", name, { width: 160, height: 44, fill: "#7C5CFF", cornerRadius: 10, layout: "horizontal", align: "center", justify: "center", children: [mk("text", `${name} label`, { text: label, color: "#FFFFFF", fontSize: 15 })], ...extra });
  const r = await tool("create_nodes", {
    nodes: [
      mk("frame", "Home", { x: 0, y: 0, width: 390, height: 700, fill: "#F8FAFC", layout: "vertical", gap: 24, padding: 24, children: [mk("text", "Home title", { text: "Welcome back", fontSize: 28, fontWeight: 700, color: "#0F172A" }), button("Open modal", "Open modal"), button("Menu button", "Menu", { width: 100 }), mk("rectangle", "Hero", { width: 342, height: 260, fill: "#CBD5E1", cornerRadius: 16 })] }),
      mk("frame", "Modal", { x: 600, y: 0, width: 300, height: 200, fill: "#FFFFFF", cornerRadius: 16, layout: "vertical", gap: 14, padding: 20, children: [mk("text", "Modal title", { text: "Are you sure?", fontSize: 20, fontWeight: 700, color: "#0F172A" }), button("Close", "Close", { width: 120, fill: "#E11D48" }), button("To menu", "Swap to menu", { width: 160 })] }),
      mk("frame", "Menu", { x: 1000, y: 0, width: 180, height: 220, fill: "#FFFFFF", cornerRadius: 12, layout: "vertical", gap: 10, padding: 16, children: [button("Item modal", "Modal", { width: 120 }), button("Item settings", "Settings", { width: 120 })] }),
      mk("frame", "Settings", { x: 1400, y: 0, width: 390, height: 700, fill: "#ECFDF5", children: [mk("text", "Settings title", { text: "Settings", fontSize: 28, fontWeight: 700, color: "#065F46", x: 24, y: 24 })] }),
    ],
  });
  check("design built", r.ok, JSON.stringify(r).slice(0, 120));
  const d = await doc();
  const id = (n) => byName(d, n).id;
  const proto = async (nodeId, input) => (await tool("set_prototype", { nodeId, ...input })).ok;
  const wired = [
    await proto(id("Open modal"), { action: "open_overlay", destinationId: id("Modal") }),
    await proto(id("Menu button"), { action: "open_overlay", destinationId: id("Menu"), overlay: { position: "top_right", background: "none" } }),
    await proto(id("Close"), { action: "close_overlay" }),
    await proto(id("To menu"), { action: "swap_overlay", destinationId: id("Menu"), overlay: { position: "top_right", background: "none" } }),
    await proto(id("Item modal"), { action: "open_overlay", destinationId: id("Modal") }),
    await proto(id("Item settings"), { destinationId: id("Settings") }),
  ];
  check("interactions wired through set_prototype", wired.every(Boolean));
  const d2 = await doc();
  check("overlay settings stored", byName(d2, "Menu button").interactions[0].overlay.position === "topRight" && byName(d2, "Menu button").interactions[0].overlay.background === null && byName(d2, "Open modal").interactions[0].overlay.background.opacity === 0.3);

  // Prototype tab: pick the actions and options in the panel; arrows are dashed.
  await page.evaluate(() => window.__dt.zoomToFit());
  await page.evaluate((i) => window.__dt.dispatch({ op: "select", ids: [i] }), id("Open modal"));
  await page.click(".panel.right .tab:has-text('Prototype')");
  await page.waitForTimeout(300);
  const selects = page.locator(".panel.right select");
  check("panel shows overlay options", (await page.locator(".panel.right .overlay-settings").count()) === 1 && (await page.locator(".panel.right option[value='swapOverlay']").count()) > 0);
  await shot("0-prototype-tab");
  const dashed = await page.locator("#dt-canvas [data-proto-link='overlay'] path").count();
  const solid = await page.locator("#dt-canvas [data-proto-link='navigate']").count();
  check("canvas draws overlay links dashed", dashed >= 4 && solid >= 1, `${dashed} overlay, ${solid} navigate`);

  // Change the position through the panel UI.
  const posSelect = page.locator(".panel.right .overlay-settings select").first();
  await posSelect.selectOption("bottomCenter");
  await page.waitForTimeout(100);
  check("position picker updates the interaction", (await doc()).nodes[id("Open modal")].interactions[0].overlay.position === "bottomCenter");
  await page.locator(".panel.right .overlay-settings input[type=checkbox]").first().uncheck();
  check("close-on-outside-click toggle", (await doc()).nodes[id("Open modal")].interactions[0].overlay.closeOnClickOutside === false);
  void selects;
  // Back to the defaults for the player run.
  await posSelect.selectOption("center");
  await page.locator(".panel.right .overlay-settings input[type=checkbox]").first().check();

  // Present from Home.
  await page.evaluate((i) => window.__dt.dispatch({ op: "select", ids: [i] }), id("Home"));
  await page.click("button[title='Present']");
  await page.waitForSelector(".presenter", { timeout: 5000 });
  await page.waitForTimeout(500);
  const ids = Object.fromEntries(["Open modal", "Menu button", "Close", "To menu", "Item modal", "Item settings"].map((n) => [n, id(n)]));
  await playTests(page, "present", ids);


  // View-only link.
  await page.keyboard.press("Escape");
  const link = await page.evaluate(async () => {
    const json = JSON.stringify({ v: 1, doc: window.__dt.doc(), assets: {} });
    const buf = await new Response(new Blob([new TextEncoder().encode(json)]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
    let s = "";
    for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  });
  const view = await context.newPage();
  view.on("pageerror", (e) => errors.push(String(e)));
  await view.addInitScript(() => localStorage.setItem("dt:tour-done", "1"));
  await view.goto(URL + "/#/view/" + link);
  await view.waitForSelector(".presenter", { timeout: 20000 });
  await view.waitForTimeout(500);
  check("view link renders the player with a Remix button", (await view.locator(".presenter .remix").count()) === 1);
  await playTests(view, "view", ids);

  // Manual position and "close on outside click" off.
  await tool("set_prototype", { nodeId: ids["Open modal"], clear: true, action: "open_overlay", destinationId: id("Modal"), overlay: { position: "manual", offsetX: 10, offsetY: 60, closeOnClickOutside: false } });
  await page.evaluate((i) => window.__dt.dispatch({ op: "select", ids: [i] }), id("Home"));
  await page.click("button[title='Present']");
  await page.waitForSelector(".presenter");
  await page.waitForTimeout(400);
  const hs = await box(page, `.presenter [data-hotspot="${ids["Open modal"]}"]`);
  await page.locator(`.presenter [data-hotspot="${ids["Open modal"]}"]`).click();
  await page.waitForSelector(".presenter .overlay-frame");
  await page.waitForTimeout(400);
  const mf = await box(page, ".presenter .overlay-frame");
  check("manual position: offset from the trigger layer", Math.abs(mf.x - (hs.x + 10)) < 2 && Math.abs(mf.y - (hs.y + 60)) < 2, `${JSON.stringify(mf)} vs ${JSON.stringify(hs)}`);
  await shot("5-manual");
  const st = await box(page, ".presenter .stage");
  await page.mouse.click(st.x + 10, st.y + st.height - 10);
  check("outside click ignored when turned off", (await overlays(page)) === 1);
  await page.keyboard.press("Escape");
  check("Escape still closes it", (await overlays(page)) === 0);
  // After-delay on the first frame opens the overlay once; closing it must not re-fire the timer.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(100);
  await tool("set_prototype", { nodeId: id("Home"), trigger: "delay", action: "open_overlay", destinationId: id("Modal") });
  await page.click("button[title='Present']");
  await page.waitForSelector(".presenter");
  await page.waitForSelector(".presenter .overlay-frame", { timeout: 4000 });
  check("after-delay opens the overlay", (await overlays(page)) === 1);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(2500);
  check("closing it doesn't re-fire the base timer", (await overlays(page)) === 0, `${await overlays(page)} overlay(s) after 2.5s`);
  // A: an overlay's own after-delay runs once per opening. Parent opens Menu after a delay;
  // closing Menu must not bring it back when Parent is on top again.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(100);
  await page.evaluate((i) => window.__dt.dispatch({ op: "update", ids: [i], patch: { interactions: [] } }), id("Home"));
  const parent = await tool("create_nodes", { nodes: [{ type: "frame", name: "Parent", x: 0, y: 1400, width: 300, height: 200, fill: "#FFFFFF", cornerRadius: 16 }] });
  const parentId = byName(await doc(), "Parent").id;
  check("parent overlay frame built", parent.ok);
  await tool("set_prototype", { nodeId: parentId, trigger: "delay", action: "open_overlay", destinationId: id("Menu"), overlay: { position: "top_right", background: "none" } });
  await tool("set_prototype", { nodeId: ids["Open modal"], clear: true, action: "open_overlay", destinationId: parentId });
  await page.click("button[title='Present']");
  await page.waitForSelector(".presenter");
  await page.locator(`.presenter [data-hotspot="${ids["Open modal"]}"]`).click();
  await page.waitForFunction(() => document.querySelectorAll(".presenter .overlay-backdrop").length === 2, null, { timeout: 4000 });
  check("overlay's after-delay opens the nested overlay", true);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(2500);
  check("closing the nested overlay doesn't re-fire its parent's timer", (await overlays(page)) === 1, `${await overlays(page)} overlay(s) after 2.5s`);
  await page.keyboard.press("Escape"); // Parent
  await page.keyboard.press("Escape"); // the player
  await page.waitForSelector(".presenter", { state: "detached" });

  // B: a base-frame after-delay Back, firing while a modal is open, closes the modal.
  await tool("set_prototype", { nodeId: ids["Open modal"], clear: true, action: "open_overlay", destinationId: id("Modal") });
  await tool("set_prototype", { nodeId: id("Home"), trigger: "delay", action: "back" });
  // Long enough to open the modal first.
  await page.evaluate((i) => {
    const n = window.__dt.doc().nodes[i];
    window.__dt.dispatch({ op: "update", ids: [i], patch: { interactions: n.interactions.map((x) => ({ ...x, delayMs: 3000 })) } });
  }, id("Home"));
  await page.click("button[title='Present']");
  await page.waitForSelector(".presenter");
  // The frame's own after-delay interaction must not leave a click-swallowing hotspot over its children.
  check("after-delay on a frame makes no hotspot", (await page.locator(`.presenter [data-hotspot="${id("Home")}"]`).count()) === 0);
  await page.locator(`.presenter [data-hotspot="${ids["Open modal"]}"]`).click();
  await page.waitForSelector(".presenter .overlay-frame");
  await page.waitForTimeout(3500);
  check("base after-delay Back closes the open modal", (await overlays(page)) === 0 && (await crumb(page)).trim() === "Home", `${await overlays(page)} overlay(s), ${await crumb(page)}`);
  // Hotspot stacking and inheritance, on their own screen.
  await page.keyboard.press("Escape");
  await page.waitForSelector(".presenter", { state: "detached" });
  const rect = (name, x, y, w, h) => ({ type: "rectangle", name, x, y, width: w, height: h, fill: "#94A3B8" });
  await tool("create_nodes", {
    nodes: [
      {
        type: "frame", name: "Cards", x: 0, y: 1800, width: 390, height: 600, fill: "#FFFFFF",
        children: [
          { type: "frame", name: "Card", x: 20, y: 20, width: 300, height: 120, fill: "#E2E8F0", children: [rect("Icon", 10, 10, 40, 40)] },
          { type: "frame", name: "Hover card", x: 20, y: 160, width: 300, height: 120, fill: "#E2E8F0", children: [rect("Plain button", 200, 60, 80, 40)] },
          { type: "frame", name: "Layered", x: 20, y: 300, width: 300, height: 100, fill: "#E2E8F0", children: [rect("Layered bg", 0, 0, 300, 100)] },
        ],
      },
    ],
  });
  const dc = await doc();
  const cid = (n) => byName(dc, n).id;
  // The card navigates on click; its icon only has a hover (which does nothing visible).
  await tool("set_prototype", { nodeId: cid("Card"), action: "navigate", destinationId: id("Settings") });
  await tool("set_prototype", { nodeId: cid("Icon"), trigger: "hover", action: "close_overlay" });
  // The card opens a menu on hover; its button only has a click.
  await tool("set_prototype", { nodeId: cid("Hover card"), trigger: "hover", action: "open_overlay", destinationId: id("Menu"), overlay: { position: "top_right", background: "none" } });
  await tool("set_prototype", { nodeId: cid("Plain button"), action: "navigate", destinationId: id("Settings") });
  // Parent and a same-sized child both clickable: the child, being deeper, wins.
  await tool("set_prototype", { nodeId: cid("Layered"), action: "open_overlay", destinationId: id("Modal") });
  await tool("set_prototype", { nodeId: cid("Layered bg"), action: "navigate", destinationId: id("Settings") });
  const cardsPage = Object.values(dc.pages)[0].id;
  await page.evaluate(([pg, f]) => window.__dt.dispatch({ op: "setFlowStart", page: pg, id: f }), [cardsPage, cid("Cards")]);
  const present = async () => {
    await page.click("button[title='Present']");
    await page.waitForSelector(".presenter");
    await page.waitForTimeout(300);
  };
  const close = async () => {
    await page.keyboard.press("Escape");
    while ((await page.locator(".presenter").count()) > 0) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(100);
    }
  };

  await present();
  await page.locator(`.presenter [data-hotspot="${cid("Icon")}"]`).click();
  await page.waitForTimeout(500);
  check("click on a hover-only child runs its parent's click", (await crumb(page)).trim() === "Settings", await crumb(page));
  await close();

  await present();
  const btn = await box(page, `.presenter [data-hotspot="${cid("Plain button")}"]`);
  await page.mouse.move(btn.x + btn.width / 2, btn.y + btn.height / 2);
  await page.waitForTimeout(400);
  check("hovering a click-only child counts as hovering its parent", (await overlays(page)) === 1, `${await overlays(page)} overlay(s)`);
  await close();

  await present();
  await page.locator(`.presenter [data-hotspot="${cid("Layered bg")}"]`).click();
  await page.waitForTimeout(500);
  check("deeper layer wins over a same-sized parent", (await crumb(page)).trim() === "Settings" && (await overlays(page)) === 0, `${await crumb(page)}, ${await overlays(page)} overlay(s)`);
  await close();
  await page.evaluate((pg) => window.__dt.dispatch({ op: "setFlowStart", page: pg, id: null }), cardsPage);
} catch (err) {
  failed++;
  console.log("FAIL  exception: " + (err?.stack ?? err));
  await page.screenshot({ path: path.join(OUT, "ov-error.png") }).catch(() => {});
}
check("no console errors", errors.length === 0, errors.slice(0, 3).join(" | "));
await browser.close();
process.exit(failed ? 1 : 0);
