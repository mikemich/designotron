// Round 19, r19a: variable delete on instances (C-1), dangling overrides (C-4) and fill children in
// wrap rows (X-01), in the real editor.
//   1. A Card main (Title bound to Theme/text, Body plain), an instance whose Body is bound to
//      Theme/text, a plain bound rectangle. Delete Theme/text: the canvas fill of the instance Body
//      stays #222222 after the delete, after a main edit, after undo/redo and after a reload.
//   2. Delete a layer from a main that an instance overrides: the override key is gone, undo brings it back.
//   3. The Features and Stats wrap frames: every card's canvas rect matches the exported HTML loaded
//      at 1440 px width within 1 px (4 + 2 rows for Features).
//
// Local only: serves web/dist with `vite preview` and aborts every non-local request.
//   cd web && npm run build && node scripts/qa/r19a-e2e.mjs
// Env: E2E_PORT (7101) E2E_URL (an editor that is already served) E2E_DIST (dist) E2E_OUT (screenshots)

import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.E2E_PORT ?? 7101);
const BASE = process.env.E2E_URL ?? `http://127.0.0.1:${PORT}/`;
const DIST = process.env.E2E_DIST ?? "dist";
const OUT = process.env.E2E_OUT ?? "/tmp/r19a-shots";
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + String(detail).slice(0, 500) : ""}`);
};

const children = [];
process.on("exit", () => children.forEach((c) => c.kill()));
if (!process.env.E2E_URL) {
  const vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "preview", "--outDir", DIST, "--port", String(PORT), "--host", "127.0.0.1", "--strictPort"], { stdio: "ignore" });
  children.push(vite);
}
for (let i = 0; ; i++) {
  try {
    if ((await fetch(BASE)).ok) break;
  } catch {
    /* not yet */
  }
  if (i > 100) {
    console.error(`no editor at ${BASE}`);
    process.exit(2);
  }
  await sleep(200);
}

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
await sleep(600);

const tool = async (name, input) => {
  const r = await page.evaluate(([n, i]) => window.__dt.tool(n, i), [name, input]);
  if (!r.ok) throw new Error(`${name} failed: ${JSON.stringify(r.result)}`);
  return r.result;
};
const doc = () => page.evaluate(() => window.__dt.doc());
const dispatch = (cmd) => page.evaluate((c) => window.__dt.dispatch(c), cmd);
const sub = (d, id) => [id, ...(d.nodes[id]?.children ?? []).flatMap((c) => sub(d, c))];
const under = (d, root, name) => sub(d, root).find((i) => i !== root && d.nodes[i].name === name);
const created = (r) => r.created.map((c) => c.id);
const canvasFill = (id) =>
  page.evaluate((i) => {
    const el = document.querySelector(`#dt-canvas g[data-id="${i}"]`);
    const shape = el?.querySelector("rect, path");
    return (shape?.getAttribute("fill") ?? shape?.style.fill ?? "").toUpperCase();
  }, id);
const settle = () => sleep(250);

// ---------- 1. C-1 ----------
await tool("define_variables", { collection: "Theme", modes: ["Light", "Dark"], variables: [{ name: "text", values: { Light: "#111111", Dark: "#EEEEEE" } }] });
const comp = created(await tool("create_nodes", { nodes: [{ type: "component", name: "Card", x: 0, y: 0, width: 200, height: 100, children: [
  { type: "rectangle", name: "Title", width: 50, height: 10, fill: "#000000", bind: { fill: "Theme/text" } },
  { type: "rectangle", name: "Body", y: 20, width: 50, height: 10, fill: "#6B7280" }] }] }))[0];
const inst = (await tool("create_instance", { componentId: comp, x: 400, y: 0 })).id;
const plain = created(await tool("create_nodes", { nodes: [{ type: "rectangle", name: "Plain", x: 700, width: 40, height: 40, fill: "#000000", bind: { fill: "Theme/text" } }] }))[0];
let d = await doc();
const body = under(d, inst, "Body");
await tool("update_nodes", { updates: [{ id: body, bind: { fill: "Theme/text" } }] });
await tool("define_variables", { collection: "Theme", variables: [{ name: "text", values: { Light: "#222222", Dark: "#EEEEEE" } }] });
await settle();
check("instance Body shows the variable", (await canvasFill(body)) === "#222222", await canvasFill(body));
await tool("define_variables", { collection: "Theme", delete: ["text"] });
await settle();
const bodyShows = async (label) => check(`${label}: instance Body fill is #222222 on the canvas`, (await canvasFill(body)) === "#222222", await canvasFill(body));
await bodyShows("after the delete");
check("after the delete: plain bound rectangle keeps #222222", (await canvasFill(plain)) === "#222222", await canvasFill(plain));
d = await doc();
const ov = JSON.stringify(d.nodes[inst].instance.overrides);
check("override has no dead binding or empty object", !ov.includes('"bindings"') && !ov.includes("{}"), ov);
await tool("update_nodes", { updates: [{ id: comp, cornerRadius: 6 }] });
await settle();
await bodyShows("after a main edit");
await dispatch({ op: "undo" });
await dispatch({ op: "undo" });
await settle();
check("undo twice brings the binding back", (await doc()).nodes[body].bindings?.fill != null);
await dispatch({ op: "redo" });
await dispatch({ op: "redo" });
await settle();
await bodyShows("after undo and redo");
// Reload: autosave, then reopen the file from the file list.
await sleep(1500);
await page.reload();
await page.waitForSelector(".files, #dt-canvas");
if (!(await page.$("#dt-canvas"))) {
  await page.locator(".files .file-card, .files [data-file], .files li, .files a").first().click().catch(() => {});
  await page.waitForSelector("#dt-canvas", { timeout: 10000 }).catch(() => {});
}
await sleep(800);
const d2 = await doc();
const body2 = d2.nodes[inst] ? d2.nodes[under(d2, inst, "Body")] : null;
check("reload: the file came back with the instance", !!d2.nodes[inst] && !!body2);
if (body2) check("reload: instance Body fill is #222222 on the canvas", (await canvasFill(body2.id)) === "#222222", await canvasFill(body2.id));
await page.screenshot({ path: path.join(OUT, "c1-after-reload.png") });

// ---------- 2. C-4 ----------
const comp2 = created(await tool("create_nodes", { nodes: [{ type: "component", name: "Row", x: 0, y: 300, width: 200, height: 100, children: [
  { type: "text", name: "Label", text: "Hi" },
  { type: "rectangle", name: "Keep", y: 40, width: 20, height: 20 }] }] }))[0];
const inst2 = (await tool("create_instance", { componentId: comp2, x: 400, y: 300 })).id;
d = await doc();
const lab = under(d, inst2, "Label");
const keep = under(d, inst2, "Keep");
await tool("update_nodes", { updates: [{ id: lab, text: "Yo" }, { id: keep, fill: "#123456" }] });
d = await doc();
const mainLabel = under(d, comp2, "Label");
check("two overrides recorded", Object.keys(d.nodes[inst2].instance.overrides).length === 2, JSON.stringify(d.nodes[inst2].instance.overrides));
await tool("delete_nodes", { ids: [mainLabel] });
d = await doc();
check("override of the removed main layer is gone", !(mainLabel in d.nodes[inst2].instance.overrides) && Object.keys(d.nodes[inst2].instance.overrides).length === 1, JSON.stringify(d.nodes[inst2].instance.overrides));
await dispatch({ op: "undo" });
d = await doc();
check("undo brings the override back", mainLabel in d.nodes[inst2].instance.overrides);

// ---------- 3. X-01 ----------
const card = (min, max) => ({ type: "frame", name: "C", width: "fill", minWidth: min, maxWidth: max, height: 100, fill: "#DDDDDD" });
const features = created(await tool("create_nodes", { nodes: [{ type: "frame", name: "Features", x: 0, y: 700, width: 1440, height: "hug", fill: "#FFFFFF",
  layout: { direction: "horizontal", wrap: true, gap: 24, padding: 48 }, children: Array.from({ length: 6 }, () => card(280, 420)) }] }))[0];
const stats = created(await tool("create_nodes", { nodes: [{ type: "frame", name: "Stats", x: 0, y: 1300, width: 1200, height: "hug", fill: "#FFFFFF",
  layout: { direction: "horizontal", wrap: true, gap: 16, padding: 32 }, children: Array.from({ length: 4 }, () => ({ ...card(180), maxWidth: undefined })) }] }))[0];
d = await doc();
const rects = (id) => d.nodes[id].children.map((c) => ({ x: d.nodes[c].x, y: d.nodes[c].y, w: d.nodes[c].width, h: d.nodes[c].height }));
const fr = rects(features);
check("Features: 4 + 2 rows, widths 318 and 420", fr.slice(0, 4).every((r) => Math.abs(r.w - 318) < 0.5 && r.y === fr[0].y) && fr.slice(4).every((r) => Math.abs(r.w - 420) < 0.5 && r.y > fr[0].y), JSON.stringify(fr));
check("Features: x positions", [48, 390, 732, 1074, 48, 492].every((x, i) => Math.abs(fr[i].x - x) < 0.5), JSON.stringify(fr.map((r) => r.x)));
const sr = rects(stats);
check("Stats: 4 x 272 in one row", sr.every((r) => Math.abs(r.w - 272) < 0.5 && r.y === sr[0].y), JSON.stringify(sr));

// Layout rects against the exported HTML at 1440 px.
for (const [id, name, width] of [[features, "features", 1440], [stats, "stats", 1200]]) {
  const exp = await tool("export_code", { id, format: "html" });
  const p2 = await ctx.newPage();
  watch(p2);
  await p2.setViewportSize({ width: 1440, height: 900 });
  await p2.setContent(exp.code, { waitUntil: "load" });
  const ex = await p2.evaluate(() => {
    const root = [...document.querySelectorAll("body *")].find((e) => getComputedStyle(e).flexWrap === "wrap");
    const kids = [...root.children];
    const o = root.getBoundingClientRect();
    return kids.map((k) => { const b = k.getBoundingClientRect(); return { x: b.x - o.x, y: b.y - o.y, w: b.width, h: b.height }; });
  });
  await p2.screenshot({ path: path.join(OUT, `${name}-export.png`) });
  await p2.close();
  const want = d.nodes[id].children.map((c) => ({ x: d.nodes[c].x, y: d.nodes[c].y, w: d.nodes[c].width }));
  const ok = ex.length === want.length && ex.every((r, i) => Math.abs(r.x - want[i].x) <= 1 && Math.abs(r.y - want[i].y) <= 1 && Math.abs(r.w - want[i].w) <= 1);
  check(`${name}: exported HTML at ${width} matches the canvas layout within 1 px`, ok, JSON.stringify({ ex, want }).slice(0, 400));
  const rows = new Set(ex.map((r) => Math.round(r.y))).size;
  check(`${name}: ${name === "features" ? "2" : "1"} rows in the export`, rows === (name === "features" ? 2 : 1), rows);
}
await dispatch({ op: "select", ids: [features] });
await sleep(300);
await page.keyboard.press("Shift+2");
await sleep(500);
await page.screenshot({ path: path.join(OUT, "features-canvas.png") });

check("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log(failed ? `\n${failed} FAILED` : "\nALL PASSED");
process.exit(failed ? 1 : 0);
