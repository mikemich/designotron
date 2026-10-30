// Picking and asset placement: a selected top-level frame doesn't capture drags on its children,
// and Assets click/drop choose the parent frame sensibly (never silently a main component).
// Usage: E2E_URL=http://localhost:5173 node scripts/qa/w1b-e2e.mjs (dev server running)

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fresh() {
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
  await page.goto(URL);
  await page.click("button:has-text('New design file')");
  await page.waitForSelector("#dt-canvas");
  return page;
}
const doc = (p) => p.evaluate(() => window.__dt.doc());
const named = async (p, name) => Object.values((await doc(p)).nodes).find((n) => n.name === name);
const toClient = async (p, x, y) => {
  const box = await p.locator("#dt-canvas").boundingBox();
  const v = await p.evaluate(() => window.__dt.viewport());
  return { x: box.x + v.x + x * v.zoom, y: box.y + v.y + y * v.zoom, box };
};
const create = (p, nodes) => p.evaluate((nodes) => window.__dt.tool("create_nodes", { nodes }), nodes);
const select = (p, ids) => p.evaluate((ids) => window.__dt.dispatch({ op: "select", ids }), ids);
const parentName = async (p, n) => (n.parent ? (await doc(p)).nodes[n.parent].name : "page");
const button = { type: "frame", name: "Button", x: 0, y: 0, width: 120, height: 40, fill: "#7c5cff", children: [{ type: "rectangle", name: "Dot", x: 4, y: 4, width: 10, height: 10, fill: "#ffffff" }] };

try {
  // 1. Selected top-level frame with auto layout: dragging the bottom child up reorders it.
  {
    const p = await fresh();
    await create(p, [
      {
        type: "frame",
        name: "Stack",
        x: 0,
        y: 0,
        width: 200,
        height: 200,
        fill: "#eeeeee",
        children: [
          { type: "rectangle", name: "R1", x: 10, y: 10, width: 100, height: 30, fill: "#ff0000" },
          { type: "rectangle", name: "R2", x: 10, y: 50, width: 100, height: 30, fill: "#00ff00" },
          { type: "rectangle", name: "R3", x: 10, y: 90, width: 100, height: 30, fill: "#0000ff" },
        ],
      },
    ]);
    await p.evaluate(() => window.__dt.zoomToFit());
    await select(p, [(await named(p, "Stack")).id]);
    await p.keyboard.press("Shift+a");
    await sleep(200);
    await select(p, [(await named(p, "Stack")).id]);
    const frame0 = await named(p, "Stack");
    const r3 = await named(p, "R3");
    const a = await toClient(p, frame0.x + r3.x + r3.width / 2, frame0.y + r3.y + r3.height / 2);
    await p.mouse.move(a.x, a.y);
    await p.mouse.down();
    for (let i = 1; i <= 20; i++) {
      await p.mouse.move(a.x, a.y - i * 4);
      await sleep(15);
    }
    await p.mouse.up();
    await sleep(250);
    const frame1 = await named(p, "Stack");
    const d = await doc(p);
    const names = frame1.children.map((id) => d.nodes[id].name);
    check("frame stays put when its child is dragged", frame1.x === frame0.x && frame1.y === frame0.y, `(${frame1.x},${frame1.y})`);
    check("dragging the bottom child up reorders it (frame selected)", names.join() === "R3,R1,R2", names.join());
    await p.context().close();
  }

  // 2. Clicking an Assets item with a main component under the viewport centre.
  {
    const p = await fresh();
    await create(p, [button]);
    await select(p, [(await named(p, "Button")).id]);
    await p.keyboard.press("Control+Alt+k");
    await sleep(150);
    await p.evaluate(() => window.__dt.zoomToFit()); // only the main is on the page, so it is centred
    const main = await named(p, "Button");
    const box = await p.locator("#dt-canvas").boundingBox();
    const centre = await p.evaluate(
      ({ w, h }) => {
        const v = window.__dt.viewport();
        return { x: (w / 2 - v.x) / v.zoom, y: (h / 2 - v.y) / v.zoom };
      },
      { w: box.width, h: box.height },
    );
    const onMain = centre.x >= main.x && centre.x <= main.x + main.width && centre.y >= main.y && centre.y <= main.y + main.height;
    check("viewport centre is over the main component", onMain, `${Math.round(centre.x)},${Math.round(centre.y)}`);
    const kids0 = main.children.length;
    await p.click("button[role=tab]:has-text('Assets')");
    await p.locator(".layer", { hasText: "Button" }).first().click();
    await sleep(250);
    const d = await doc(p);
    const inst = Object.values(d.nodes).find((n) => n.type === "instance");
    check("Assets click makes an instance", !!inst);
    check("main component's child count is unchanged", d.nodes[main.id].children.length === kids0, `${kids0} -> ${d.nodes[main.id].children.length}`);
    check("instance sits on the page", !!inst && !inst.parent);
    await p.context().close();
  }

  // 3. Dropping from Assets: the pointer, not the instance corner, picks the frame.
  {
    const p = await fresh();
    await create(p, [button, { type: "frame", name: "Card", x: 300, y: 0, width: 200, height: 100, fill: "#eeeeee" }]);
    await select(p, [(await named(p, "Button")).id]);
    await p.keyboard.press("Control+Alt+k");
    await sleep(150);
    await p.evaluate(() => window.__dt.zoomToFit());
    await p.click("button[role=tab]:has-text('Assets')");
    const drop = async (x, y) => {
      const c = await toClient(p, x, y);
      await p.locator(".layer", { hasText: "Button" }).first().dragTo(p.locator("#dt-canvas"), { targetPosition: { x: c.x - c.box.x, y: c.y - c.box.y } });
      await sleep(250);
      const insts = Object.values((await doc(p)).nodes).filter((n) => n.type === "instance");
      return insts[insts.length - 1];
    };
    const card = await named(p, "Card");
    // Pointer inside the card while the instance's top-left lands outside it.
    const a = await drop(card.x + 40, card.y + 30);
    check("drop with pointer inside the frame nests it, corner outside", !!a && (await parentName(p, a)) === "Card", a ? `${await parentName(p, a)} @ ${Math.round(a.x)},${Math.round(a.y)}` : "none");
    // Pointer outside the card, instance overlapping it.
    const b = await drop(card.x - 20, card.y + 50);
    check("drop with pointer outside the frame stays on the page", !!b && (await parentName(p, b)) === "page", b ? await parentName(p, b) : "none");
    await p.context().close();
  }
} catch (e) {
  check("script ran to the end", false, String(e).slice(0, 300));
}
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
