// Prototype integrity: Present after the starting frame is deleted, dangling links, flow starts,
// "While pressing", the Open-link URL field and view-only links of files with no frames.
// Usage: start `npm run dev`, then `node scripts/qa/w1d-e2e.mjs`.
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
const errors = [];
const watch = (p) => {
  p.on("pageerror", (e) => errors.push(String(e)));
  p.on("console", (m) => m.type() === "error" && !/WebSocket|Failed to load resource/.test(m.text()) && errors.push(m.text()));
};
const page = await context.newPage();
watch(page);
await page.addInitScript(() => {
  try {
    localStorage.setItem("dt:tour-done", "1");
  } catch {
    /* no storage */
  }
});

const doc = () => page.evaluate(() => window.__dt.doc());
const tool = (name, input) => page.evaluate(([n, i]) => window.__dt.tool(n, i), [name, input]);
const dispatch = (cmd) => page.evaluate((c) => window.__dt.dispatch(c), cmd);
const byName = (d, name) => Object.values(d.nodes).find((n) => n.name === name);
const crumb = () => page.locator(".presenter .bar .muted").innerText().then((t) => t.trim());
const flowStart = async () => (await doc()).pages[0].flowStart;
const closePresenter = async () => {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
};
const hotspotBox = (id) => page.locator(`.presenter [data-hotspot="${id}"]`).boundingBox();
const navigate = (destination, trigger = "onClick") => ({ trigger, delayMs: 800, action: "navigate", destination, url: null, transition: "instant", durationMs: 300, overlay: { position: "center", offsetX: 0, offsetY: 0, closeOnClickOutside: true, background: null } });

try {
  await page.goto(URL);
  await page.waitForSelector(".files", { timeout: 20000 });
  await page.click("button:has-text('New design file')");
  await page.waitForSelector("#dt-canvas", { timeout: 15000 });

  const button = (name, x) => ({ type: "frame", name, x, y: 40, width: 120, height: 40, fill: "#2563EB", children: [] });
  const r = await tool("create_nodes", {
    nodes: [
      { type: "frame", name: "Home", x: 0, y: 0, width: 400, height: 300, fill: "#FFFFFF", children: [button("Go", 20), button("Hold", 160), button("Site", 20)] },
      { type: "frame", name: "Detail", x: 600, y: 0, width: 400, height: 300, fill: "#F1F5F9" },
      { type: "frame", name: "Third", x: 1200, y: 0, width: 400, height: 300, fill: "#ECFDF5" },
      { type: "rectangle", name: "Stray", x: 0, y: 500, width: 100, height: 100, fill: "#00FF00" },
    ],
  });
  check("design built", r.ok, JSON.stringify(r).slice(0, 120));
  const d0 = await doc();
  const id = (n) => byName(d0, n).id;
  const pageId = d0.pages[0].id;
  await page.evaluate(() => window.__dt.zoomToFit());

  // Flow starts only on top-level frames.
  await dispatch({ op: "setFlowStart", page: pageId, id: id("Stray") });
  check("a rectangle can't be a flow start", (await flowStart()) === null, String(await flowStart()));
  await dispatch({ op: "select", ids: [id("Stray")] });
  await page.click(".panel.right .tab:has-text('Prototype')");
  check("no 'Set as starting point' for a rectangle", (await page.locator("button:has-text('as starting point')").count()) === 0);

  // Delete the starting frame: Present falls back to the first frame, from the toolbar and the panel.
  await dispatch({ op: "setFlowStart", page: pageId, id: id("Detail") });
  check("flow start set", (await flowStart()) === id("Detail"));
  await dispatch({ op: "delete", ids: [id("Home")] });
  await dispatch({ op: "delete", ids: [id("Detail")] });
  check("deleting the start clears it", (await flowStart()) === null);
  await page.click("button[title='Present']");
  await page.waitForSelector(".presenter", { timeout: 3000 });
  check("toolbar Present opens the next frame", (await crumb()) === "Third", await crumb());
  await closePresenter();
  await dispatch({ op: "undo" });
  await dispatch({ op: "undo" });
  check("undo restores the start frame", (await flowStart()) === id("Detail"));
  await dispatch({ op: "select", ids: [] });
  await page.click(".panel.right .tab:has-text('Prototype')");
  await page.locator(".panel.right button:has-text('Present')").click();
  await page.waitForSelector(".presenter", { timeout: 3000 });
  check("panel Present opens the start frame", (await crumb()) === "Detail", await crumb());
  await closePresenter();

  // A link to a deleted frame is flagged in the panel and can be removed; the player ignores it.
  await dispatch({ op: "setInteractions", id: id("Go"), interactions: [navigate(id("Third"))] });
  await dispatch({ op: "delete", ids: [id("Third")] });
  await dispatch({ op: "select", ids: [id("Go")] });
  await page.waitForTimeout(150);
  check("panel flags the missing destination", (await page.locator(".panel.right .missing-destination").count()) === 1);
  await dispatch({ op: "setFlowStart", page: pageId, id: id("Home") });
  await dispatch({ op: "select", ids: [] });
  await page.click("button[title='Present']");
  await page.waitForSelector(".presenter");
  const go = await hotspotBox(id("Go"));
  await page.mouse.click(go.x + 5, go.y + 5);
  await page.waitForTimeout(300);
  check("player ignores the dangling link", (await page.locator(".presenter").count()) === 1 && (await crumb()) === "Home", await crumb());
  await closePresenter();
  await dispatch({ op: "select", ids: [id("Go")] });
  await page.locator(".panel.right .missing-destination button").click();
  check("Remove clears the broken link", (await doc()).nodes[id("Go")].interactions[0].destination === null && (await page.locator(".panel.right .missing-destination").count()) === 0);

  // While pressing: acts on press, goes back on release.
  await dispatch({ op: "setFlowStart", page: pageId, id: id("Home") });
  await dispatch({ op: "setInteractions", id: id("Hold"), interactions: [navigate(id("Detail"), "onPress")] });
  await dispatch({ op: "select", ids: [] });
  await page.click("button[title='Present']");
  await page.waitForSelector(".presenter");
  const start = await crumb();
  const hold = await hotspotBox(id("Hold"));
  await page.mouse.move(hold.x + 5, hold.y + 5);
  await page.mouse.down();
  await page.waitForTimeout(200);
  check("pointer down navigates", (await crumb()) === "Detail" && start !== "Detail", `${start} -> ${await crumb()}`);
  await page.mouse.up();
  await page.waitForTimeout(200);
  check("release returns to the first screen", (await crumb()) === start, await crumb());
  await closePresenter();

  // Two fingers: only the pointer that pressed controls the revert, and a second press is ignored.
  await page.click("button[title='Present']");
  await page.waitForSelector(".presenter");
  const fire = (type, pointerId, sel) =>
    page.evaluate(([t, pid, s]) => {
      const el = document.querySelector(s) ?? window;
      el.dispatchEvent(new PointerEvent(t, { bubbles: true, pointerId: pid, button: 0, isPrimary: pid === 1 }));
    }, [type, pointerId, sel]);
  const holdSel = `.presenter [data-hotspot="${id("Hold")}"]`;
  await fire("pointerdown", 1, holdSel);
  await page.waitForTimeout(100);
  check("first finger navigates", (await crumb()) === "Detail", await crumb());
  await fire("pointerdown", 2, `.presenter [data-hotspot="${id("Hold")}"]`);
  await fire("pointerup", 2, null);
  await page.waitForTimeout(100);
  check("second finger lifting doesn't revert", (await crumb()) === "Detail", await crumb());
  await fire("pointerup", 1, null);
  await page.waitForTimeout(100);
  check("first finger lifting returns to Home", (await crumb()) === "Home", await crumb());
  await page.waitForTimeout(600);
  await closePresenter();

  // Touch: a tap on a While-pressing layer inside a frame with On click must not run the frame's click.
  const touch = await browser.newContext({ viewport: { width: 1600, height: 1000 }, hasTouch: true, ignoreHTTPSErrors: true });
  const tp = await touch.newPage();
  watch(tp);
  await tp.addInitScript(() => localStorage.setItem("dt:tour-done", "1"));
  await tp.goto(URL);
  await tp.waitForSelector(".files", { timeout: 20000 });
  await tp.click("button:has-text('New design file')");
  await tp.waitForSelector("#dt-canvas", { timeout: 15000 });
  await tp.evaluate(() =>
    window.__dt.tool("create_nodes", {
      nodes: [
        { type: "frame", name: "Home", x: 0, y: 0, width: 400, height: 300, fill: "#FFFFFF", children: [{ type: "frame", name: "Hold", x: 20, y: 40, width: 120, height: 40, fill: "#2563EB", children: [] }] },
        { type: "frame", name: "Detail", x: 600, y: 0, width: 400, height: 300, fill: "#F1F5F9" },
        { type: "frame", name: "Third", x: 1200, y: 0, width: 400, height: 300, fill: "#ECFDF5" },
      ],
    }),
  );
  const t0 = await tp.evaluate(() => window.__dt.doc());
  const tid = (n) => byName(t0, n).id;
  const ix = (trigger, destination) => ({ ...navigate(destination, trigger) });
  await tp.evaluate(
    ([home, hold, detail, third, a, b]) => {
      window.__dt.dispatch({ op: "setInteractions", id: home, interactions: [b] });
      window.__dt.dispatch({ op: "setInteractions", id: hold, interactions: [a] });
      window.__dt.dispatch({ op: "setFlowStart", page: window.__dt.doc().pages[0].id, id: home });
    },
    [tid("Home"), tid("Hold"), tid("Detail"), tid("Third"), ix("onPress", tid("Detail")), ix("onClick", tid("Third"))],
  );
  await tp.click("button[title='Present']");
  await tp.waitForSelector(".presenter");
  const tb = await tp.locator(`.presenter [data-hotspot="${tid("Hold")}"]`).boundingBox();
  await tp.touchscreen.tap(tb.x + 10, tb.y + 10);
  await tp.waitForTimeout(700);
  const tcrumb = (await tp.locator(".presenter .bar .muted").innerText()).trim();
  check("touch tap on a pressing layer doesn't run the parent's click", tcrumb === "Home", tcrumb);
  await touch.close();

  // Open link: Enter commits without leaving the field.
  await dispatch({ op: "setInteractions", id: id("Site"), interactions: [{ ...navigate(null), action: "openUrl" }] });
  await dispatch({ op: "select", ids: [id("Site")] });
  const url = page.locator("input.textinput[placeholder='https://']");
  await url.fill("https://example.com/enter");
  await url.press("Enter");
  await page.waitForTimeout(150);
  check("Enter commits the link URL", (await doc()).nodes[id("Site")].interactions[0].url === "https://example.com/enter");

  // View-only link of a file with no frames still shows its layers.
  const d1 = await doc();
  const frameIds = Object.values(d1.nodes).filter((n) => n.type === "frame" && !n.parent).map((n) => n.id);
  await dispatch({ op: "delete", ids: frameIds });
  const link = await page.evaluate(async () => {
    const json = JSON.stringify({ v: 1, doc: window.__dt.doc(), assets: {} });
    const buf = await new Response(new Blob([new TextEncoder().encode(json)]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
    let s = "";
    for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  });
  const view = await context.newPage();
  watch(view);
  await view.addInitScript(() => localStorage.setItem("dt:tour-done", "1"));
  await view.goto(URL + "/#/view/" + link);
  await view.waitForSelector(".presenter, .empty-hint:has-text('empty')", { timeout: 20000 });
  check("view link without frames renders the layers", (await view.locator(".presenter .stage svg").count()) > 0 && (await view.locator(".empty-hint").count()) === 0);
  await view.screenshot({ path: path.join(OUT, "w1d-view-no-frames.png") });
} catch (err) {
  failed++;
  console.log("FAIL  exception: " + (err?.stack ?? err));
  await page.screenshot({ path: path.join(OUT, "w1d-error.png") }).catch(() => {});
}
check("no console errors", errors.length === 0, errors.slice(0, 3).join(" | "));
await browser.close();
process.exit(failed ? 1 : 0);
