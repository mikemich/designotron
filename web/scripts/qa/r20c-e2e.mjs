// Round 20, r20c: constraints in auto layout, Space between in wrap rows, Shift+A on an auto layout
// frame, MCP constraints and the panel fixes, in the real editor.
//   1. Card 300x120 with auto layout, Close absolute at x = 270: the constraint selects show, Right,
//      then the Card width 400 puts Close at 370; undo puts it back.
//   2. A Hug button with a Right/Top absolute badge: a longer label keeps the badge at the right edge.
//   3. A wrap frame with Space between: canvas rects equal the exported HTML's rects (+-1 px).
//   4. Shift+A on an auto layout frame wraps it; the old frame's gap and padding are unchanged.
//   5. Mixed padding shows Mixed; Wrap on a Hug frame switches the width to Fixed; a bad export size
//      shows the inline error and the old value comes back.
//   6. MCP over the bridge (JSON-RPC tools/call): constraints on an absolute child have no
//      "unknown key" warning and get_nodes shows them; on a flow child it warns.
//
// Local only. Servers (started by hand, see RULES.md):
//   CLAUDE_BIN=$PWD/web/scripts/fixtures/fake-claude.mjs <target>/debug/designotron --port 7265 \
//     --static web/dist --workspace <scratch> --no-open
//   cd web && DESIGNOTRON_PORT=7265 npx vite preview --port 7261 --host 127.0.0.1 --strictPort
//   cd web && LANG=C.UTF-8 E2E_URL=http://127.0.0.1:7261 node scripts/qa/r20c-e2e.mjs
// The exported HTML is served on 7262 by this script. Every non-local request is aborted.
// Env: E2E_URL (7261) E2E_STATIC_PORT (7262) E2E_OUT (screenshots)

import { chromium } from "playwright-core";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const BASE = process.env.E2E_URL ?? "http://127.0.0.1:7261";
const STATIC_PORT = Number(process.env.E2E_STATIC_PORT ?? 7262);
const OUT = process.env.E2E_OUT ?? "/tmp/r20c-shots";
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + String(detail).slice(0, 500) : ""}`);
};
const near = (a, b, tol = 0.5) => Math.abs(a - b) <= tol;

const launchOpts = { headless: true, args: ["--no-sandbox"] };
if (fs.existsSync("/opt/pw-browsers/chromium")) launchOpts.executablePath = "/opt/pw-browsers/chromium";
const browser = await chromium.launch(launchOpts);
const LOCAL = /^(https?:\/\/(localhost|127\.0\.0\.1)[:/])|^(data|blob|ws|wss):/;
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
await ctx.route((u) => !LOCAL.test(u.toString()), (r) => r.abort());
await ctx.addInitScript(() => {
  try {
    localStorage.setItem("dt:tour-done", "1");
  } catch {
    /* no storage */
  }
});
const errors = [];
const watch = (p) => {
  p.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  p.on("dialog", (d) => {
    errors.push("dialog: " + d.message());
    d.dismiss();
  });
  p.on("console", (m) => {
    if (m.type() === "error" && !/bridge\/ws|Failed to load resource|WebSocket connection/.test(m.text())) errors.push("console: " + m.text().slice(0, 200));
  });
};
const page = await ctx.newPage();
watch(page);
await page.goto(BASE);
await page.waitForSelector(".files");
await page.click("button:has-text('New design file')");
await page.waitForSelector("#dt-canvas");
await page.waitForFunction(() => window.__dt.chat().bridgeStatus === "connected", null, { timeout: 15000 });
await sleep(600);

const tool = async (name, input) => {
  const r = await page.evaluate(([n, i]) => window.__dt.tool(n, i), [name, input]);
  if (!r.ok) throw new Error(`${name} failed: ${JSON.stringify(r.result)}`);
  return r.result;
};
const doc = () => page.evaluate(() => window.__dt.doc());
const dispatch = (cmd) => page.evaluate((c) => window.__dt.dispatch(c), cmd);
const select = async (ids) => {
  await dispatch({ op: "select", ids });
  await sleep(250);
};
const created = (r) => r.created.map((c) => c.id);
const kids = (d, id) => d.nodes[id].children;
const settle = () => sleep(250);

// ---------- 1. Constraint selects on an absolute child; the Card resized ----------
const card = created(await tool("create_nodes", { nodes: [{ type: "frame", name: "Card", x: 0, y: 0, width: 300, height: 120, fill: "#FFFFFF", layout: { direction: "horizontal" }, children: [
  { type: "rectangle", name: "Body", width: 100, height: 40, fill: "#DDDDDD" },
  { type: "rectangle", name: "Close", width: 20, height: 20, fill: "#FF0000", absolute: true, x: 270, y: 10 }] }] }))[0];
let d = await doc();
const [body, close] = kids(d, card);
await select([body]);
check("a flow child has no constraint selects", (await page.locator('select[aria-label="Horizontal constraint"]').count()) === 0);
await select([close]);
check("an absolute child in auto layout shows both constraint selects", (await page.locator('select[aria-label="Horizontal constraint"]').count()) === 1 && (await page.locator('select[aria-label="Vertical constraint"]').count()) === 1);
await page.selectOption('select[aria-label="Horizontal constraint"]', "right");
await settle();
d = await doc();
check("constraint set to Right through the panel", d.nodes[close].constraints.horizontal === "right", JSON.stringify(d.nodes[close].constraints));
await page.screenshot({ path: path.join(OUT, "1-constraint-selects.png") });
await select([card]);
await tool("update_nodes", { updates: [{ id: card, width: 400 }] });
await settle();
d = await doc();
check("Card width 400: Close sits at x = 370", near(d.nodes[close].x, 370), d.nodes[close].x);
await dispatch({ op: "undo" });
await settle();
d = await doc();
check("undo puts Close back at 270 and the Card at 300", near(d.nodes[close].x, 270) && near(d.nodes[card].width, 300), `${d.nodes[close].x} ${d.nodes[card].width}`);

// ---------- 2. Hug button, Right/Top badge, longer label ----------
const btn = created(await tool("create_nodes", { nodes: [{ type: "frame", name: "Button", x: 0, y: 300, width: "hug", height: "hug", fill: "#EEEEEE", layout: { direction: "horizontal", padding: 12 }, children: [
  { type: "text", name: "Label", text: "Go", fontSize: 16 },
  { type: "ellipse", name: "Badge", width: 10, height: 10, fill: "#FF0000", absolute: true, x: 0, y: 0, constraints: { horizontal: "right", vertical: "top" } }] }] }))[0];
d = await doc();
const [label, badge] = kids(d, btn);
// Put the badge on the right edge (4 px in), then grow the label.
await tool("update_nodes", { updates: [{ id: badge, x: d.nodes[btn].width - 14, y: 2 }] });
d = await doc();
const rightGap = d.nodes[btn].width - (d.nodes[badge].x + d.nodes[badge].width);
await tool("update_nodes", { updates: [{ id: label, text: "A much longer label than before" }] });
await settle();
d = await doc();
const gapAfter = d.nodes[btn].width - (d.nodes[badge].x + d.nodes[badge].width);
check("the Hug button grew with its label", d.nodes[btn].width > 150, d.nodes[btn].width);
check("the badge keeps its distance from the right edge", near(gapAfter, rightGap, 0.01), `${rightGap} -> ${gapAfter}`);
check("the badge stays at the top", near(d.nodes[badge].y, 2));
await page.screenshot({ path: path.join(OUT, "2-hug-button.png") });

// ---------- 3. Wrap + Space between against the exported HTML ----------
const wrap = created(await tool("create_nodes", { nodes: [{ type: "frame", name: "Wrap", x: 0, y: 600, width: 300, height: "hug", fill: "#FFFFFF",
  layout: { direction: "horizontal", wrap: true, gap: 10, counterGap: 12, align: "space-between" },
  children: Array.from({ length: 4 }, (_, i) => ({ type: "rectangle", name: `I${i}`, width: 80, height: 50, fill: "#CCCCCC" })) }] }))[0];
d = await doc();
if (d.nodes[wrap].layout.primaryAlign !== "spaceBetween") await tool("update_nodes", { updates: [{ id: wrap, layout: { align: "space-between" } }] });
d = await doc();
const want = kids(d, wrap).map((c) => ({ x: d.nodes[c].x, y: d.nodes[c].y, w: d.nodes[c].width }));
check("canvas: rows spread 0 / 110 / 220 and 0", [0, 110, 220, 0].every((x, i) => near(want[i].x, x)), JSON.stringify(want));
const exp = await tool("export_code", { id: wrap, format: "html" });
const srv = http.createServer((_, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(exp.code);
});
await new Promise((r) => srv.listen(STATIC_PORT, "127.0.0.1", r));
const p2 = await ctx.newPage();
watch(p2);
await p2.setViewportSize({ width: 800, height: 600 });
await p2.goto(`http://127.0.0.1:${STATIC_PORT}/`, { waitUntil: "load" });
const ex = await p2.evaluate(() => {
  const root = [...document.querySelectorAll("body *")].find((e) => getComputedStyle(e).flexWrap === "wrap");
  const o = root.getBoundingClientRect();
  return [...root.children].map((k) => {
    const b = k.getBoundingClientRect();
    return { x: b.x - o.x, y: b.y - o.y, w: b.width };
  });
});
await p2.screenshot({ path: path.join(OUT, "3-wrap-export.png") });
await p2.close();
srv.close();
check("the exported HTML has the same rects as the canvas (+-1 px)", ex.length === want.length && ex.every((r, i) => near(r.x, want[i].x, 1) && near(r.y, want[i].y, 1) && near(r.w, want[i].w, 1)), JSON.stringify({ ex, want }));
await select([wrap]);
await page.screenshot({ path: path.join(OUT, "3-wrap-canvas.png") });

// ---------- 4. Shift+A on an auto layout frame ----------
const stack = created(await tool("create_nodes", { nodes: [{ type: "frame", name: "Stack", x: 600, y: 0, width: 200, height: 200, fill: "#FFFFFF", layout: { direction: "vertical", gap: 24, padding: 16 }, children: [
  { type: "rectangle", name: "A", width: 50, height: 50 }, { type: "rectangle", name: "B", width: 50, height: 50 }] }] }))[0];
d = await doc();
const before = JSON.stringify(d.nodes[stack].layout);
await select([stack]);
await page.mouse.move(800, 500);
await page.keyboard.press("Shift+A");
await settle();
d = await doc();
const parent = d.nodes[stack].parent;
check("Shift+A wrapped the frame in a new one", !!parent && parent !== stack && d.nodes[parent]?.type === "frame" && d.nodes[parent].layout, parent);
check("the old frame's gap and padding are unchanged", JSON.stringify(d.nodes[stack].layout) === before, JSON.stringify(d.nodes[stack].layout));
check("the new frame is selected", JSON.stringify((await page.evaluate(() => window.__dt.state().selection))) === JSON.stringify([parent]));
await page.screenshot({ path: path.join(OUT, "4-shift-a.png") });
await dispatch({ op: "undo" });
await settle();
d = await doc();
check("one undo restores", !d.nodes[parent] && d.nodes[stack].parent == null && JSON.stringify(d.nodes[stack].layout) === before);

// ---------- 5. Mixed padding, Wrap on Hug, bad export size ----------
const f1 = created(await tool("create_nodes", { nodes: [{ type: "frame", name: "P1", x: 900, y: 0, width: 100, height: 100, layout: { direction: "horizontal" } }] }))[0];
await tool("update_nodes", { updates: [{ id: f1, layout: { padding: { left: 4, right: 20, top: 8, bottom: 8 } } }] });
await select([f1]);
const padH = page.locator('input[aria-label="Horizontal padding"]');
const padV = page.locator('input[aria-label="Vertical padding"]');
check("padding left 4 / right 20 shows Mixed on the horizontal field", (await padH.inputValue()) === "Mixed", await padH.inputValue());
check("equal top and bottom show the value", (await padV.inputValue()) === "8", await padV.inputValue());
await padH.fill("12");
await padH.press("Enter");
await settle();
d = await doc();
check("typing a value sets both sides", d.nodes[f1].layout.paddingLeft === 12 && d.nodes[f1].layout.paddingRight === 12);
check("then the field shows 12", (await padH.inputValue()) === "12", await padH.inputValue());
await page.screenshot({ path: path.join(OUT, "5-mixed-padding.png") });

const hugRow = created(await tool("create_nodes", { nodes: [{ type: "frame", name: "HugRow", x: 900, y: 300, width: "hug", height: "hug", fill: "#EEE", layout: { direction: "horizontal", gap: 8 }, children:
  Array.from({ length: 3 }, () => ({ type: "rectangle", width: 60, height: 30 })) }] }))[0];
d = await doc();
const hugW = d.nodes[hugRow].width;
check("the row hugs its children", d.nodes[hugRow].sizingH === "hug");
await select([hugRow]);
const wrapBtn = page.locator('button[title^="Wrap"]').first();
check("the Wrap toggle says what it does to a Hug width", /Hug width becomes Fixed/.test((await wrapBtn.getAttribute("title")) ?? ""), await wrapBtn.getAttribute("title"));
await wrapBtn.click();
await settle();
d = await doc();
check("Wrap on a Hug frame sets the width to Fixed at its current size", d.nodes[hugRow].layout.wrap === true && d.nodes[hugRow].sizingH === "fixed" && near(d.nodes[hugRow].width, hugW), JSON.stringify([d.nodes[hugRow].sizingH, d.nodes[hugRow].width, hugW]));
await dispatch({ op: "undo" });
await settle();
d = await doc();
check("one undo turns Wrap off and the width back to Hug", d.nodes[hugRow].layout.wrap === false && d.nodes[hugRow].sizingH === "hug");

await select([f1]);
const sizeInput = page.locator('input[aria-label="Export scale"]').first();
if ((await sizeInput.count()) === 0) await page.locator('button[title="Add export setting"]').click();
const scaleField = page.locator('input[aria-label="Export scale"]').first();
await scaleField.waitFor();
const oldValue = await scaleField.inputValue();
await scaleField.fill("banana");
await scaleField.press("Enter");
await settle();
const status = page.locator(".export-error").first();
check("a bad export size shows the inline error", /Use a scale like 2x, a width like 512w or a height like 300h/.test((await status.textContent()) ?? ""), await status.textContent());
check("the error is announced (role=status)", (await status.getAttribute("role")) === "status");
check("the old value comes back", (await scaleField.inputValue()) === oldValue, `${oldValue} / ${await scaleField.inputValue()}`);
await page.screenshot({ path: path.join(OUT, "5-export-error.png") });
await sleep(4300);
check("the error goes away after 4 s", ((await status.textContent()) ?? "") === "");
await scaleField.fill("2.5x");
await scaleField.press("Enter");
await settle();
check("a good size is accepted without an error", ((await status.textContent()) ?? "") === "" && (await page.locator('input[aria-label="Export scale"]').first().inputValue()) === "2.5x");

// ---------- 6. MCP over the bridge ----------
let rpcId = 1;
async function rpc(method, params = {}) {
  const r = await fetch(BASE + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
  });
  return r.json();
}
const mcp = async (name, args) => {
  const j = await rpc("tools/call", { name, arguments: args });
  const text = j.result?.content?.find((c) => c.type === "text")?.text ?? JSON.stringify(j.error ?? j);
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    /* an error */
  }
  return { ok: !!j.result && !j.result.isError, text, obj };
};
const mc = created((await mcp("create_nodes", { nodes: [{ type: "frame", name: "McpCard", x: 1200, y: 0, width: 300, height: 100, layout: { direction: "horizontal" }, children: [
  { type: "rectangle", name: "Flow", width: 60, height: 20 },
  { type: "rectangle", name: "Pin", width: 20, height: 20, absolute: true, x: 270, y: 5 }] }] })).obj);
d = await doc();
const [flow, pin] = kids(d, mc[0]);
const r1 = await mcp("update_nodes", { updates: [{ id: pin, constraints: { horizontal: "right", vertical: "bottom" } }] });
check("MCP update_nodes constraints on an absolute child: no warning at all", r1.ok && !/unknown key|constraints/.test(JSON.stringify(r1.obj?.warnings ?? [])), r1.text);
const g = await mcp("get_nodes", { ids: [pin] });
check("get_nodes shows the constraints", /"right"/.test(g.text) && /"bottom"/.test(g.text), g.text.slice(0, 300));
const r2 = await mcp("update_nodes", { updates: [{ id: flow, constraints: { horizontal: "MAX" } }] });
check("MCP constraints on a flow child warn that they take effect when absolute", r2.ok && /constraints take effect when absolute: true/.test(JSON.stringify(r2.obj?.warnings ?? [])), r2.text);
const r3 = await mcp("update_nodes", { updates: [{ id: pin, constraints: { horizontal: "middle" } }] });
check("a bad value is an error that lists the valid ones", !r3.ok && /left/.test(r3.text) && /scale/.test(r3.text), r3.text);
await mcp("update_nodes", { updates: [{ id: mc[0], width: 500 }] });
await settle();
d = await doc();
check("the pinned child followed the resize: x 270 -> 470 (Right)", near(d.nodes[pin].x, 470), d.nodes[pin].x);

check("no page errors or dialogs", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(failed ? `\n${failed} FAILED` : "\nALL PASSED");
process.exit(failed ? 1 : 0);
