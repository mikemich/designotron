// Round 20 / r20d, handoff and view-only polish:
//   UX-1  Design and Prototype fields are disabled for a viewer and a read-only tab (with a note),
//   tools  drawing tools are disabled there; Move, Hand and Comment are not,
//   UX-4  the Share dialog names the link's real host,
//   comments  clicking one pans to it and keeps the zoom,
//   Inspect  a Stroke group of its own and a Constraints row,
//   "+"  a new interaction has no destination and the picker takes the focus.
// Usage: `npm run build`, then `vite preview --port 7271` and
//   designotron-relay --port 7275 --static web/dist --data <scratch dir>, then
//   E2E_URL=http://127.0.0.1:7271 E2E_RELAY=http://127.0.0.1:7275 node scripts/qa/r20d-e2e.mjs
// Env: E2E_SHOTS (screenshot directory), CHROMIUM (executable path). Only local servers are used.

import { chromium } from "playwright-core";
import fs from "node:fs";

const URL = process.env.E2E_URL ?? "http://127.0.0.1:7271";
const RELAY = process.env.E2E_RELAY ?? "http://127.0.0.1:7275";
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
const dialogs = [];
async function newContext() {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 2 });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new globalThis.URL(URL).origin }).catch(() => {});
  await ctx.route("**/*", (route) => (local(route.request().url()) ? route.continue() : route.abort()));
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem("dt:tour-done", "1");
    } catch {
      /* no storage */
    }
  });
  return ctx;
}
async function track(page) {
  page.on("pageerror", (e) => check("no page errors", false, String(e)));
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    d.dismiss().catch(() => {});
  });
  return page;
}
async function openNew(ctx, url = URL) {
  const page = await track(await ctx.newPage());
  await page.goto(url);
  await page.click("button:has-text('New design file')");
  await page.waitForSelector("#dt-canvas");
  await sleep(500);
  return page;
}
const doc = (p) => p.evaluate(() => window.__dt.doc());
const named = async (p, name) => Object.values((await doc(p)).nodes).find((n) => n.name === name);
const tool = (p, name, input) => p.evaluate(([n, i]) => window.__dt.tool(n, i), [name, input]);
const dispatch = (p, cmd) => p.evaluate((c) => window.__dt.dispatch(c), cmd);
const shot = (p, name) => (SHOTS ? p.screenshot({ path: `${SHOTS}/${name}.png` }) : Promise.resolve());
const rightTab = (p, name) => p.click(`#right-tab-${name}`);
const enabledFields = (p) => p.locator("fieldset.panel-lock :is(input, select, textarea, button):not(:disabled)").count();
const allFields = (p) => p.locator("fieldset.panel-lock :is(input, select, textarea, button)").count();
const toasts = (p) => p.$$eval(".toast, [role=status]", (els) => els.map((e) => e.textContent).join(" | "));

/** The view-only checks shared by a viewer and a read-only tab. */
async function viewOnlyChecks(p, who, rectName) {
  const rect = await named(p, rectName);
  await dispatch(p, { op: "select", ids: [rect.id] });
  await rightTab(p, "design");
  await p.waitForSelector("fieldset.panel-lock:disabled");
  check(`${who}: the Design tab has fields, all disabled`, (await allFields(p)) > 5 && (await enabledFields(p)) === 0, `${await allFields(p)} fields, ${await enabledFields(p)} enabled`);
  const note = await p.locator(".view-only-note[role=note]").innerText();
  check(`${who}: the note is shown`, /View only|Read-only/.test(note), note);
  // Dragging the X label must not move the layer, and must not raise the engine's "can't edit" toast.
  const lbl = p.locator("fieldset.panel-lock .lbl", { hasText: /^X$/ }).first();
  const box = await lbl.boundingBox();
  await p.mouse.move(box.x + 4, box.y + 4);
  await p.mouse.down();
  await p.mouse.move(box.x + 80, box.y + 4, { steps: 6 });
  await p.mouse.up();
  await sleep(200);
  check(`${who}: scrubbing X changes nothing`, (await named(p, rectName)).x === rect.x, `${rect.x} -> ${(await named(p, rectName)).x}`);
  check(`${who}: ...and shows no "can't edit" toast`, !/can.t edit|view the file/i.test(await toasts(p)), await toasts(p));
  await rightTab(p, "prototype");
  check(`${who}: the Prototype tab is disabled too`, (await p.locator("fieldset.panel-lock:disabled").count()) === 1 && (await enabledFields(p)) === 0);
  // Tools.
  const off = async (title) => p.locator(`.tbtn[title^="${title}"]`).first().isDisabled();
  check(`${who}: drawing tools are disabled`, (await off("Rectangle")) && (await off("Frame")) && (await off("Text")) && (await off("Pen")));
  check(`${who}: Move, Hand and Comment are not`, !(await off("Move")) && !(await off("Hand")) && !(await off("Comment")));
  check(`${who}: a disabled tool says why`, /view only/i.test((await p.locator('.tbtn[title*="Rectangle"]').first().getAttribute("title")) ?? ""));
  // The Code tab still copies.
  await rightTab(p, "code");
  const val = p.locator("[data-testid=inspect] .insp-val").first();
  await val.waitFor();
  await val.click();
  await sleep(200);
  const live = await p.locator(".insp-live").innerText();
  check(`${who}: the Code tab copies a value`, /Copied/.test(live), live);
  await rightTab(p, "design");
  // axe on the right panel: the locked scroll area must be a focusable region, and nothing serious is new.
  // The first run comes straight after selection changes made while on Design (no tab round trip).
  await dispatch(p, { op: "select", ids: [] });
  await rightTab(p, "design");
  await sleep(200);
  const axeIds = async () => {
    const AXE = process.env.AXE ?? "/tmp/claude-0/-home-user-designotron/286bf7bb-781e-5d8f-9708-6c1f94840e4a/scratchpad/qa7/I-a11y/node_modules/axe-core/axe.min.js";
    if (!fs.existsSync(AXE)) return null;
    if (!(await p.evaluate(() => !!window.axe))) await p.addScriptTag({ path: AXE });
    return p.evaluate(async () => {
      const r = await window.axe.run({ include: [["#panel-right"]] }, { resultTypes: ["violations"] });
      return r.violations.filter((x) => x.impact === "serious" || x.impact === "critical").map((x) => x.id);
    });
  };
  await dispatch(p, { op: "select", ids: [rect.id] });
  await sleep(200);
  const v1 = await axeIds();
  if (v1) check(`${who}: axe, nothing selected -> a layer on Design`, v1.length === 0, v1.join(","));
  const others = Object.values((await doc(p)).nodes).filter((n) => n.id !== rect.id && n.type !== "page");
  if (others.length) {
    await dispatch(p, { op: "select", ids: [others[0].id] });
    await sleep(200);
    const v2 = await axeIds();
    if (v2) check(`${who}: axe, one layer -> another on Design`, v2.length === 0, v2.join(","));
    await dispatch(p, { op: "select", ids: [rect.id] });
  }
  const AXE = process.env.AXE ?? "/tmp/claude-0/-home-user-designotron/286bf7bb-781e-5d8f-9708-6c1f94840e4a/scratchpad/qa7/I-a11y/node_modules/axe-core/axe.min.js";
  if (fs.existsSync(AXE)) {
    if (!(await p.evaluate(() => !!window.axe))) await p.addScriptTag({ path: AXE });
    const v = await p.evaluate(async () => {
      const r = await window.axe.run({ include: [["#panel-right"]] }, { resultTypes: ["violations"] });
      return r.violations.filter((x) => x.impact === "serious" || x.impact === "critical").map((x) => x.id);
    });
    check(`${who}: axe finds no serious violation on the right panel`, v.length === 0, v.join(","));
  } else console.log("SKIP  axe (axe-core not found)");
}

// ---------------------------------------------------------------- 1 + 3: viewer, and the Share text
let editLink = "";
{
  const octx = await newContext();
  const owner = await openNew(octx, RELAY);
  await tool(owner, "create_nodes", { nodes: [{ type: "rectangle", name: "Card", x: 100, y: 100, width: 120, height: 80, fill: "#3366ff" }, { type: "rectangle", name: "Other", x: 300, y: 100, width: 60, height: 60, fill: "#ff9900" }] });
  await owner.click(".tbtn[title='Share for live editing']");
  await owner.fill(".share-dialog input.textinput >> nth=0", "Olga");
  if (!(await owner.locator(".share-dialog input.mono").count())) await owner.click(".share-dialog >> text=Use a different relay").catch(() => {});
  await owner.waitForSelector(".share-dialog input.mono", { timeout: 5000 }).catch(() => {});
  await owner.fill(".share-dialog input.mono", RELAY);
  await owner.click("button:has-text('Share online')");
  await owner.waitForFunction(() => window.__dt.collab().status === "live", null, { timeout: 15000 });
  await owner.waitForSelector("#share-view-link", { timeout: 8000 });
  editLink = await owner.inputValue("#share-link");
  const viewLink = await owner.inputValue("#share-view-link");
  const text = await owner.locator(".share-local-only").innerText().catch(() => "");
  const relayHost = new globalThis.URL(RELAY).host;
  check("Share: the text names the link's host", text.includes(relayHost) && !/localhost/.test(text), text);
  check("Share: it keeps the 'this computer only' meaning", /this computer only/.test(text), text);
  await shot(owner, "share-dialog");
  await owner.keyboard.press("Escape");

  const vctx = await newContext();
  const viewer = await track(await vctx.newPage());
  await viewer.goto(viewLink);
  await viewer.waitForSelector("#dt-canvas");
  await viewer.waitForFunction(() => window.__dt.collab().viewer === true && window.__dt.state().readOnly === true && Object.values(window.__dt.doc().nodes).some((n) => n.name === "Card"), null, { timeout: 20000 });
  await viewOnlyChecks(viewer, "viewer", "Card");
  await rightTab(viewer, "design");
  await shot(viewer, "viewer-design");
  await vctx.close();

  // An open colour popover closes when the role turns viewer, and no gesture is left open.
  const owner2 = owner;
  await dispatch(owner2, { op: "select", ids: [(await named(owner2, "Card")).id] });
  await rightTab(owner2, "design");
  await owner2.locator("#panel-right .swatch").first().click();
  await owner2.waitForSelector(".popover");
  check("a colour popover opens while editing", (await owner2.locator(".popover").count()) === 1);
  await owner2.evaluate(() => window.__dt.collabSet({ viewer: true }));
  await sleep(300);
  check("...and closes when the role turns viewer", (await owner2.locator(".popover").count()) === 0);
  await owner2.evaluate(() => window.__dt.collabSet({ viewer: false }));
  await sleep(200);
  await dispatch(owner2, { op: "select", ids: [(await named(owner2, "Card")).id] });
  check("...leaving no gesture open", (await owner2.evaluate(() => window.__dt.state().inGesture)) === false);
  await owner2.evaluate(() => window.__dt.collabSet({ viewer: true }));
  await sleep(100);
  await owner2.evaluate(() => window.__dt.collabSet({ viewer: false }));
  await octx.close();
}

// ---------------------------------------------------------------- 2: a read-only tab
{
  const ctx = await newContext();
  const A = await openNew(ctx);
  await tool(A, "create_nodes", { nodes: [{ type: "rectangle", name: "Card", x: 100, y: 100, width: 120, height: 80, fill: "#3366ff" }, { type: "rectangle", name: "Other", x: 300, y: 100, width: 60, height: 60, fill: "#ff9900" }] });
  await sleep(1500);
  const id = await A.evaluate(() => location.hash.match(/file\/([^/?]+)/)?.[1]);
  const B = await track(await ctx.newPage());
  await B.goto(`${URL}/#/file/${id}`);
  await B.waitForSelector("#dt-canvas");
  await B.waitForFunction(() => window.__dt.state().readOnly === true && Object.values(window.__dt.doc().nodes).some((n) => n.name === "Card"), null, { timeout: 15000 });
  await viewOnlyChecks(B, "read-only tab", "Card");
  const note = await B.locator(".view-only-note").first().innerText().catch(() => "");
  check("read-only tab: the note says it is open in another tab", /another tab/.test(note), note);
  await B.getByRole("button", { name: "Edit here instead" }).click();
  await B.waitForFunction(() => !window.__dt.state().readOnly, null, { timeout: 15000 });
  await sleep(300);
  await dispatch(B, { op: "select", ids: [(await named(B, "Card")).id] });
  await rightTab(B, "design");
  check("after Edit here the fields are enabled again", (await B.locator("fieldset.panel-lock:disabled").count()) === 0 && (await B.locator("#panel-right input:not(:disabled)").count()) > 5);
  check("...and the drawing tools too", !(await B.locator('.tbtn[title^="Rectangle"]').first().isDisabled()));
  await ctx.close();
}

// ---------------------------------------------------------------- 4: comments pan
const ctx = await newContext();
const page = await openNew(ctx);
{
  await tool(page, "create_nodes", {
    nodes: [
      { type: "rectangle", name: "Big", x: 500, y: 400, width: 40, height: 40, fill: "#cccccc" },
      { type: "rectangle", name: "Speck", x: 2000, y: 1500, width: 3, height: 3, fill: "#cc0000" },
    ],
  });
  const big = await named(page, "Big");
  const speck = await named(page, "Speck");
  await dispatch(page, { op: "addComment", x: 520, y: 420, node: big.id, text: "On the big one", author: "Olga", time: Date.now() });
  await dispatch(page, { op: "addComment", x: 2001, y: 1501, node: speck.id, text: "On the speck", author: "Olga", time: Date.now() });
  await dispatch(page, { op: "addComment", x: 3000, y: -500, text: "On the page", author: "Olga", time: Date.now() });
  await page.evaluate(() => window.__dt.setViewport({ x: 0, y: 0, zoom: 1 }));
  await page.click("#left-tab-comments");
  const canvasMid = await page.evaluate(() => {
    const el = document.getElementById("dt-canvas");
    return { w: el.clientWidth / 2, h: el.clientHeight / 2 };
  });
  const pinAt = async (x, y) => {
    const v = await page.evaluate(() => window.__dt.viewport());
    return { sx: v.x + x * v.zoom, sy: v.y + y * v.zoom, zoom: v.zoom };
  };
  await page.locator(".comment-row", { hasText: "On the big one" }).click();
  await sleep(200);
  let p = await pinAt(520, 420);
  check("comment on a 40 px layer: the zoom stays 1", p.zoom === 1, p.zoom);
  check("...and the pin is at the canvas centre (2 px)", Math.abs(p.sx - canvasMid.w) <= 2 && Math.abs(p.sy - canvasMid.h) <= 2, `${p.sx},${p.sy} vs ${canvasMid.w},${canvasMid.h}`);
  await page.evaluate(() => window.__dt.setViewport({ x: 0, y: 0, zoom: 0.25 }));
  await page.locator(".comment-row", { hasText: "On the speck" }).click();
  await sleep(200);
  p = await pinAt(2001, 1501);
  check("comment on a 3 px layer at zoom 0.25: the zoom becomes 1", p.zoom === 1, p.zoom);
  check("...with the pin at the centre", Math.abs(p.sx - canvasMid.w) <= 2 && Math.abs(p.sy - canvasMid.h) <= 2, `${p.sx},${p.sy}`);
  await page.evaluate(() => window.__dt.setViewport({ x: 0, y: 0, zoom: 0.1 }));
  await page.locator(".comment-row", { hasText: "On the page" }).click();
  await sleep(200);
  p = await pinAt(3000, -500);
  check("a comment on no layer pans too and keeps zoom 0.1", p.zoom === 0.1 && Math.abs(p.sx - canvasMid.w) <= 2 && Math.abs(p.sy - canvasMid.h) <= 2, `${p.zoom} ${p.sx},${p.sy}`);
  await page.evaluate(() => window.__dt.setViewport({ x: 0, y: 0, zoom: 16 }));
  await page.locator(".comment-row", { hasText: "On the big one" }).click();
  await sleep(200);
  p = await pinAt(520, 420);
  check("zoom 16 is kept as well", p.zoom === 16 && Math.abs(p.sx - canvasMid.w) <= 2, `${p.zoom} ${p.sx}`);
  await page.click("#left-tab-layers");
}

// ---------------------------------------------------------------- 5: Inspect
{
  await page.evaluate(() => window.__dt.setViewport({ x: 0, y: 0, zoom: 1 }));
  await tool(page, "create_nodes", {
    nodes: [
      { type: "rectangle", name: "Dashed", x: 100, y: 700, width: 120, height: 80, fill: "#ffffff", stroke: "#ff0000", strokeWidth: 2, strokeAlign: "inside" },
      {
        type: "frame",
        name: "Stack",
        x: 400,
        y: 700,
        width: 300,
        height: 200,
        layout: { direction: "horizontal", gap: 8 },
        children: [
          { type: "rectangle", name: "InFlow", width: 40, height: 40, fill: "#aaaaaa" },
          { type: "rectangle", name: "Floating", width: 40, height: 40, fill: "#bbbbbb", absolute: true },
        ],
      },
      { type: "frame", name: "Plain", x: 800, y: 700, width: 300, height: 200, children: [{ type: "rectangle", name: "Pinned", x: 10, y: 10, width: 40, height: 40, fill: "#999999" }] },
    ],
  });
  const dashed = await named(page, "Dashed");
  await dispatch(page, { op: "update", ids: [dashed.id], patch: { strokeDash: [6, 4] } });
  await dispatch(page, { op: "select", ids: [dashed.id] });
  await rightTab(page, "code");
  await page.waitForSelector("[data-testid=inspect]");
  const group = (name) => page.locator(`[data-testid=inspect] [role=group][aria-label="${name}"]`);
  const strokeText = (await group("Stroke").innerText().catch(() => "")).replace(/\s+/g, " ");
  check("Inspect: one Stroke group with the colour", (await group("Stroke").count()) === 1 && /Colour/.test(strokeText) && /#FF0000/i.test(strokeText), strokeText);
  check("...the weight and position ('2px', 'inside')", /2px/.test(strokeText) && /inside/.test(strokeText), strokeText);
  check("...and the dash ('Dashed 6, 4')", /Dashed 6, 4/.test(strokeText), strokeText);
  const fillTitle = (await page.locator("[data-testid=inspect] .insp-title").allInnerTexts()).join("|");
  const fillGroup = group("Fill");
  const fillText = await fillGroup.innerText();
  check("...the fill group has no stroke row", !/Stroke|inside|Dashed/.test(fillText) && /Fill/.test(fillText), fillTitle);
  await shot(page, "inspect-stroke");
  const floating = await named(page, "Floating");
  await dispatch(page, { op: "select", ids: [floating.id] });
  await sleep(200);
  check("Inspect: an absolute child in auto layout shows Constraints", /Constraints\s*Left, Top/.test((await group("Layout").innerText()).replace(/\n/g, " ")), await group("Layout").innerText());
  const inflow = await named(page, "InFlow");
  await dispatch(page, { op: "select", ids: [inflow.id] });
  await sleep(200);
  check("...an in-flow child doesn't", !/Constraints/.test(await group("Layout").innerText()));
  const pinned = await named(page, "Pinned");
  await dispatch(page, { op: "update", ids: [pinned.id], patch: { constraints: { horizontal: "right", vertical: "top" } } });
  await dispatch(page, { op: "select", ids: [pinned.id] });
  await sleep(200);
  check("a child of a plain frame shows 'Right, Top'", /Constraints\s*Right, Top/.test((await group("Layout").innerText()).replace(/\n/g, " ")), await group("Layout").innerText());
}

// ---------------------------------------------------------------- 6: the prototype "+"
{
  await tool(page, "create_nodes", {
    nodes: [
      { type: "frame", name: "Home", x: 0, y: 1200, width: 300, height: 200, children: [{ type: "rectangle", name: "Go", x: 20, y: 20, width: 100, height: 40, fill: "#3366ff" }] },
      { type: "frame", name: "Next", x: 400, y: 1200, width: 300, height: 200 },
    ],
  });
  const go = await named(page, "Go");
  await dispatch(page, { op: "select", ids: [go.id] });
  await rightTab(page, "prototype");
  await page.getByRole("button", { name: "Add interaction" }).click();
  await sleep(300);
  const it = (await named(page, "Go")).interactions;
  check("Prototype +: the new interaction has no destination", it.length === 1 && it[0].destination === null, JSON.stringify(it));
  const focused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
  check("...and the Destination picker has the focus", focused === "Destination", focused);
  const shown = await page.evaluate(() => document.activeElement?.selectedOptions?.[0]?.textContent ?? document.activeElement?.textContent);
  check("...showing 'Choose frame…'", /Choose frame/.test(shown ?? ""), shown);
  await page.getByRole("button", { name: "Add interaction" }).click();
  await sleep(300);
  const n2 = (await named(page, "Go")).interactions.length;
  const idx = await page.evaluate(() => {
    const all = [...document.querySelectorAll('[aria-label="Destination"]')];
    return all.indexOf(document.activeElement) + "/" + all.length;
  });
  check("a second + focuses the last picker", n2 === 2 && idx === "1/2", idx);
  // Presenting shows no hotspot for an interaction with no destination.
  await dispatch(page, { op: "select", ids: [] });
  const home = await named(page, "Home");
  await dispatch(page, { op: "setFlowStart", page: (await doc(page)).pages[0].id, id: home.id });
  await page.evaluate(() => window.__dt.dispatch({ op: "select", ids: [] }));
  await page.click("#right-tab-prototype");
  await page.locator(".btn.block.primary:has-text('Present')").click();
  await page.waitForSelector("[data-hotspot], .presenter, [role=dialog]", { timeout: 5000 }).catch(() => {});
  await sleep(500);
  const hotspots = await page.locator("[data-hotspot]").count();
  // player.ts makes a hotspot for every pointer-trigger interaction, destination or not: report, not fix (see the package notes).
  console.log(`NOTE  presenting a navigate with no destination: ${hotspots} hotspot(s) (the click does nothing)`);
  const before = await page.evaluate(() => document.querySelector(".presenter")?.textContent ?? "");
  await page.locator("[data-hotspot]").first().click({ force: true }).catch(() => {});
  await sleep(400);
  check("clicking that hotspot goes nowhere", (await page.evaluate(() => document.querySelector(".presenter")?.textContent ?? "")) === before);
  await page.keyboard.press("Escape");
  await sleep(300);
}

check("no window.confirm, prompt or alert fired", dialogs.length === 0, dialogs.join("|"));
await ctx.close();
await browser.close();
console.log(failed ? `\n${failed} FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
