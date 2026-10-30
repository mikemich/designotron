// Measurement and spacing: Alt-hover distance lines (red) between the selection and the hovered
// layer or its parent, and equal-spacing snapping with pink gap guides while moving or resizing.
// Usage: E2E_URL=http://localhost:5173 node scripts/qa/w2a-e2e.mjs (dev server running)
// Screenshots go to E2E_OUT (default /tmp/w2a-shots).

import { chromium } from "playwright-core";
import fs from "node:fs";

const URL = process.env.E2E_URL ?? "http://localhost:5173";
const OUT = process.env.E2E_OUT ?? "/tmp/w2a-shots";
fs.mkdirSync(OUT, { recursive: true });
const launch = { headless: true, args: ["--no-sandbox"] };
if (process.env.CHROMIUM) launch.executablePath = process.env.CHROMIUM;
else if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";

const RED = "#f24822";
const PINK = "#f5359d";
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
  await context.route("**/*", (route) => {
    const u = route.request().url();
    if (u.startsWith("data:") || u.startsWith("blob:") || /^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(u)) return route.continue();
    return route.abort();
  });
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
  return { x: box.x + v.x + x * v.zoom, y: box.y + v.y + y * v.zoom, zoom: v.zoom };
};
const create = (p, nodes) => p.evaluate((nodes) => window.__dt.tool("create_nodes", { nodes }), nodes);
const select = (p, ids) => p.evaluate((ids) => window.__dt.dispatch({ op: "select", ids }), ids);
const rect = (name, x, y, width, height, fill = "#7c5cff") => ({ type: "rectangle", name, x, y, width, height, fill });
const centre = async (p, n) => toClient(p, n.x + n.width / 2, n.y + n.height / 2);
const overlay = (p, sel) => p.$$eval(`svg.overlay ${sel}`, (els) => els.length);
const labels = (p, group) => p.$$eval(`svg.overlay ${group} text`, (els) => els.map((e) => e.textContent));
const strokes = (p, group) => p.$$eval(`svg.overlay ${group} line, svg.overlay ${group} polygon`, (els) => [...new Set(els.map((e) => e.getAttribute("stroke")))]);
const shot = (p, name) => p.screenshot({ path: `${OUT}/${name}.png` });

/** Drags the layer under `from` by (dx, dy) page pixels in steps, runs `during` before release. */
async function dragBy(p, from, dx, dy, during) {
  const z = from.zoom;
  await p.mouse.move(from.x, from.y);
  await p.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await p.mouse.move(from.x + (dx * z * i) / 10, from.y + (dy * z * i) / 10);
    await sleep(12);
  }
  await sleep(60);
  const r = during ? await during() : undefined;
  await p.mouse.up();
  await sleep(100);
  return r;
}

try {
  // 1. Staircase A, B, C: B dragged 7px right snaps to the equal gaps (x = -90) with pink guides.
  {
    const p = await fresh();
    await create(p, [rect("A", -300, -300, 100, 100), rect("B", -100, -100, 80, 60), rect("C", 100, -300, 60, 60)]);
    await p.evaluate(() => window.__dt.zoomToFit());
    await sleep(150);
    const b = await named(p, "B");
    await select(p, [b.id]);
    const mid = await dragBy(p, await centre(p, b), 7, 0, async () => {
      await shot(p, "1-spacing-midrag");
      return { labels: await labels(p, "g.spacing-gaps"), colours: await strokes(p, "g.spacing-gaps"), lines: await overlay(p, "g.spacing-gaps line") };
    });
    const x = (await named(p, "B")).x;
    check("equal-gap snap: B lands on x = -90", Math.abs(x + 90) < 1e-6, `x=${x}`);
    check("pink spacing guides with the gap labelled 110 on both sides", mid.labels.length === 2 && mid.labels.every((l) => l === "110"), JSON.stringify(mid.labels));
    check("spacing guides are pink, not red", mid.colours.length === 1 && mid.colours[0] === PINK, JSON.stringify(mid.colours));
    check("guides gone after release", (await overlay(p, "g.spacing-gaps")) === 0);

    // Far from the equal position: no snap, no guides.
    await select(p, [(await named(p, "B")).id]);
    const far = await dragBy(p, await centre(p, await named(p, "B")), 25, 0, async () => overlay(p, "g.spacing-gaps"));
    check("no spacing guides 25px away from the equal position", far === 0);
    await p.keyboard.press("Control+z");
    await sleep(100);

    // Ctrl disables snapping.
    await select(p, [(await named(p, "B")).id]);
    await p.keyboard.down("Control");
    const ctrl = await dragBy(p, await centre(p, await named(p, "B")), 4, 0, async () => overlay(p, "g.spacing-gaps"));
    await p.keyboard.up("Control");
    check("Ctrl held: no snapping, no guides", ctrl === 0);
    await p.context().close();
  }

  // 2. Row of three, repeat the gap: C dragged near x = 180 (gap A-B = 40) snaps with 40/40 labels; vertical too.
  {
    const p = await fresh();
    await create(p, [rect("A", 0, 0, 50, 50), rect("B", 90, 0, 50, 50), rect("C", 200, 0, 50, 50), rect("D", 400, 300, 50, 50), rect("E", 400, 390, 50, 50), rect("F", 400, 500, 50, 50)]);
    await p.evaluate(() => window.__dt.zoomToFit());
    await sleep(150);
    const c = await named(p, "C");
    await select(p, [c.id]);
    const mid = await dragBy(p, await centre(p, c), -17, 0, async () => labels(p, "g.spacing-gaps"));
    check("repeat-gap snap: C lands 40px right of B", Math.abs((await named(p, "C")).x - 180) < 1e-6, `x=${(await named(p, "C")).x}`);
    check("repeat-gap guides label both gaps 40", mid.length === 2 && mid.every((l) => l === "40"), JSON.stringify(mid));
    const f = await named(p, "F");
    await select(p, [f.id]);
    const vm = await dragBy(p, await centre(p, f), 0, -17, async () => labels(p, "g.spacing-gaps"));
    check("vertical repeat-gap snap: F lands 40px below E", Math.abs((await named(p, "F")).y - 480) < 1e-6, `y=${(await named(p, "F")).y}`);
    check("vertical guides labelled 40", vm.length === 2 && vm.every((l) => l === "40"), JSON.stringify(vm));
    await p.context().close();
  }

  // 3. Resize: B's right handle dragged until the B-C gap equals the A-B gap.
  {
    const p = await fresh();
    await create(p, [rect("A", 0, 0, 50, 50), rect("B", 90, 0, 50, 50), rect("C", 260, 0, 50, 50)]);
    await p.evaluate(() => window.__dt.zoomToFit());
    await sleep(150);
    const b = await named(p, "B");
    await select(p, [b.id]);
    await sleep(100);
    const h = await toClient(p, b.x + b.width, b.y + b.height / 2);
    const mid = await dragBy(p, h, 77, 0, async () => {
      await shot(p, "3-resize-spacing");
      return labels(p, "g.spacing-gaps");
    });
    const nb = await named(p, "B");
    check("resize snaps the right edge to an equal gap (width 130)", Math.abs(nb.width - 130) < 1e-6, `width=${nb.width}`);
    check("resize shows pink 40 / 40 gaps", mid.length === 2 && mid.every((l) => l === "40"), JSON.stringify(mid));
    await p.context().close();
  }

  // 4. Alt-hover: nothing without Alt; distances to a sibling; to the parent's inner edges; multi-select.
  {
    const p = await fresh();
    await create(p, [
      { type: "frame", name: "Card", x: 0, y: 0, width: 400, height: 300, fill: "#f3f3f3", children: [rect("Dot", 50, 40, 100, 60), rect("Bar", 250, 150, 100, 30, "#ff8a00")] },
      rect("Side", 480, 40, 80, 60, "#00aa66"),
    ]);
    await p.evaluate(() => window.__dt.zoomToFit());
    await sleep(150);
    const card = await named(p, "Card");
    const dot = await named(p, "Dot");
    const bar = await named(p, "Bar");
    const side = await named(p, "Side");
    await select(p, [dot.id]);
    const over = async (n, dx = 0, dy = 0) => {
      const c = await toClient(p, card.x + n.x + n.width / 2 + dx, card.y + n.y + n.height / 2 + dy);
      await p.mouse.move(c.x - 3, c.y - 3);
      await p.mouse.move(c.x, c.y);
      await sleep(120);
    };
    await over(bar);
    check("no measurement without Alt", (await overlay(p, "g.measure")) === 0);

    await p.keyboard.down("Alt");
    await sleep(80);
    const bl = await labels(p, "g.measure");
    // Dot (50..150, 40..100) to Bar (250..350, 150..180): 100 horizontal gap, 50 vertical gap.
    check("Alt over a sibling: distances 100 and 50", bl.slice().sort().join() === ["100", "50"].join(), JSON.stringify(bl));
    check("measurement lines are red", JSON.stringify(await strokes(p, "g.measure")) === JSON.stringify([RED]), JSON.stringify(await strokes(p, "g.measure")));
    await shot(p, "4a-alt-sibling");

    // Over the frame's empty area: parent inner edges 50 / 250 / 40 / 200.
    const cc = await toClient(p, card.x + 200, card.y + 250);
    await p.mouse.move(cc.x, cc.y);
    await sleep(120);
    const pl = await labels(p, "g.measure");
    check("Alt over the parent frame: inner distances 50, 250, 40, 200", pl.slice().sort().join() === ["200", "250", "40", "50"].join(), JSON.stringify(pl));
    await shot(p, "4b-alt-parent");

    // Over another top-level layer.
    const sc = await toClient(p, side.x + side.width / 2, side.y + side.height / 2);
    await p.mouse.move(sc.x, sc.y);
    await sleep(120);
    const sl = await labels(p, "g.measure");
    check("Alt over a layer outside the frame: 330 across", sl.length === 1 && sl[0] === "330", JSON.stringify(sl));

    // Over the selection itself: nothing.
    const dc = await toClient(p, card.x + dot.x + 10, card.y + dot.y + 10);
    await p.mouse.move(dc.x, dc.y);
    await sleep(120);
    check("Alt over the selection: nothing drawn", (await overlay(p, "g.measure")) === 0);

    // Multiple selection: measure from the union of Dot and Bar to Side.
    await select(p, [dot.id, bar.id]);
    await p.mouse.move(sc.x, sc.y);
    await sleep(120);
    const ml = await labels(p, "g.measure");
    // Union is 50..350 x 40..180; Side is 480..560 x 40..100: gap 130 across the overlapping rows.
    check("multi-selection measures from the selection bounds (130)", ml.includes("130"), JSON.stringify(ml));
    await shot(p, "4c-alt-multi");

    // Releasing Alt removes it; so does leaving the key without moving.
    await p.keyboard.up("Alt");
    await sleep(80);
    check("measurement disappears when Alt is released", (await overlay(p, "g.measure")) === 0);

    // Alt pressed while the pointer rests picks it up without moving.
    await p.mouse.move(sc.x, sc.y);
    await p.keyboard.down("Alt");
    await sleep(120);
    check("Alt pressed over a resting pointer measures immediately", (await overlay(p, "g.measure")) > 0);
    await p.keyboard.up("Alt");

    // No selection: Alt does nothing.
    await select(p, []);
    await p.keyboard.down("Alt");
    await sleep(100);
    check("Alt with nothing selected draws nothing", (await overlay(p, "g.measure")) === 0);
    await p.keyboard.up("Alt");

    // Alt-drag duplicates and doesn't leave measurements behind.
    await select(p, [side.id]);
    const before = Object.keys((await doc(p)).nodes).length;
    await p.keyboard.down("Alt");
    await dragBy(p, sc, 0, 120, async () => overlay(p, "g.measure"));
    await p.keyboard.up("Alt");
    await sleep(100);
    check("Alt-drag still duplicates", Object.keys((await doc(p)).nodes).length === before + 1);
    check("no measurement lingers after an Alt-drag", (await overlay(p, "g.measure")) === 0);
    await p.context().close();
  }

  // 5. 1k layers: Alt-hover and spacing snaps stay cheap.
  {
    const p = await fresh();
    const nodes = [];
    for (let i = 0; i < 1000; i++) nodes.push(rect(`R${i}`, (i % 40) * 70, Math.floor(i / 40) * 70, 50, 50));
    await create(p, nodes);
    await p.evaluate(() => window.__dt.zoomToFit());
    await sleep(500);
    const r = await named(p, "R420");
    await select(p, [r.id]);
    await p.keyboard.down("Alt");
    const target = await named(p, "R425");
    const t0 = await toClient(p, target.x + 25, target.y + 25);
    const frames = await p.evaluate(
      async ({ x, y }) => {
        const el = document.elementFromPoint(x, y) ?? document.body;
        const times = [];
        for (let i = 0; i < 40; i++) {
          const t = performance.now();
          el.dispatchEvent(new PointerEvent("pointermove", { clientX: x + (i % 2), clientY: y, bubbles: true, altKey: true }));
          window.dispatchEvent(new PointerEvent("pointermove", { clientX: x + (i % 2), clientY: y }));
          await new Promise((res) => requestAnimationFrame(() => res()));
          times.push(performance.now() - t);
        }
        return times;
      },
      { x: t0.x, y: t0.y },
    );
    const avg = frames.reduce((a, b) => a + b, 0) / frames.length;
    const worst = Math.max(...frames);
    check("Alt-hover at 1k layers: lines drawn", (await overlay(p, "g.measure")) > 0);
    check("Alt-hover at 1k layers: average frame under 30 ms", avg < 30, `avg ${avg.toFixed(1)} ms, worst ${worst.toFixed(1)} ms`);
    await shot(p, "5-alt-1k");
    await p.keyboard.up("Alt");

    // Drag one of the 1k: per pointer-move cost (engine + render) with snapping on and, as the
    // baseline, off (Ctrl held).
    const drag30 = async (ctrl) => {
      await select(p, [r.id]);
      const from = await centre(p, r);
      if (ctrl) await p.keyboard.down("Control");
      await p.mouse.move(from.x, from.y);
      await p.mouse.down();
      const moves = [];
      for (let i = 1; i <= 30; i++) {
        const t = performance.now();
        await p.mouse.move(from.x + i * 0.9, from.y + i * 0.4);
        await p.evaluate(() => new Promise((res) => requestAnimationFrame(() => res())));
        moves.push(performance.now() - t);
      }
      await p.mouse.up();
      if (ctrl) await p.keyboard.up("Control");
      await p.keyboard.press("Control+z");
      return moves.reduce((a, b) => a + b, 0) / moves.length;
    };
    const off = await drag30(true);
    const on = await drag30(false);
    check("drag with snapping at 1k layers costs under 15 ms more per move than without", on - off < 15, `snap on ${on.toFixed(1)} ms, off ${off.toFixed(1)} ms`);
    await p.context().close();
  }
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
