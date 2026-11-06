// Round 9 P1a: engine memory and undo. Memory growth after 300 edits on a ~3.6k-layer file,
// undo of a 40-section delete on a ~20k-layer file, and a grouped AI turn as one undo step.
// Usage: E2E_URL=http://localhost:5631 node scripts/qa/r9a-e2e.mjs (dev server running).
// Env: E2E_URL, CHROMIUM (executable path), SHOTS (screenshot folder).

import { chromium } from "playwright-core";
import fs from "node:fs";

const URL = process.env.E2E_URL ?? "http://localhost:5631";
const SHOTS = process.env.SHOTS ?? "";
const launch = { headless: true, args: ["--no-sandbox", "--js-flags=--expose-gc"] };
if (process.env.CHROMIUM) launch.executablePath = process.env.CHROMIUM;
else if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch(launch);
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
await context.route(/^https?:\/\/(?!(127\.0\.0\.1|localhost)[:/])/, (r) => r.abort());
const errors = [];

async function fresh() {
  const p = await context.newPage();
  await p.addInitScript(() => {
    try {
      localStorage.setItem("dt:tour-done", "1");
    } catch {
      /* no storage */
    }
  });
  p.on("pageerror", (e) => errors.push(String(e)));
  await p.goto(URL);
  await p.waitForFunction(() => {
    try {
      return !!window.__dt?.doc();
    } catch {
      return false;
    }
  });
  // Open a real file so the canvas renders and the timings include the render.
  await p.getByRole("button", { name: /New design file/ }).first().click();
  await p.waitForSelector("#dt-canvas");
  await sleep(400);
  return p;
}

/** Sections of 30 cards of 4 layers each: 121 layers per section. */
async function build(p, sections) {
  await p.evaluate((n) => {
    const mk = (f) => ({
      type: "frame",
      name: `S${f}`,
      x: f * 500,
      width: 393,
      layout: { direction: "vertical", gap: 8, padding: 16 },
      children: Array.from({ length: 30 }, (_, i) => ({
        type: "frame",
        name: `Card ${i}`,
        width: 300,
        fill: "#FFFFFF",
        layout: { direction: "horizontal", gap: 12, padding: 12 },
        children: [
          { type: "rectangle", width: 48, height: 48, fill: "#DDD" },
          { type: "text", text: "Card title with some words", fontSize: 16 },
          { type: "text", text: "Secondary", fontSize: 13 },
        ],
      })),
    });
    for (let f = 0; f < n; f++) window.__dt.dispatch({ op: "ai", tool: "create_nodes", input: { nodes: [mk(f)] } });
  }, sections);
}

const nodeCount = (p) => p.evaluate(() => Object.keys(window.__dt.doc().nodes).length);

try {
  // 1. Memory growth over 300 edits on a ~3.6k-layer file.
  {
    const p = await fresh();
    const cdp = await context.newCDPSession(p);
    // The engine lives in wasm linear memory, which never shrinks: its size is the footprint.
    const heap = async () => {
      await cdp.send("HeapProfiler.collectGarbage");
      const js = await p.evaluate(() => performance.memory.usedJSHeapSize / 1048576);
      const wasm = await p.evaluate(async () => {
        const m = await import("/src/wasm/pkg/designotron_engine_wasm.js");
        return (await m.default()).memory.buffer.byteLength / 1048576;
      });
      return js + wasm;
    };
    await build(p, 30);
    const n = await nodeCount(p);
    const ids = await p.evaluate(() =>
      Object.values(window.__dt.doc().nodes)
        .filter((x) => x.type === "rectangle")
        .slice(0, 300)
        .map((x) => x.id),
    );
    await sleep(500);
    const start = await heap();
    const t0 = Date.now();
    await p.evaluate((ids) => {
      for (let i = 0; i < 300; i++)
        window.__dt.dispatch({ op: "ai", tool: "update_nodes", input: { updates: [{ id: ids[i % ids.length], opacity: 0.2 + (i % 8) / 10 }] } });
    }, ids);
    const ms = Date.now() - t0;
    const end = await heap();
    check(`memory growth after 300 edits on ${n} layers < 100 MB`, end - start < 100, `${start.toFixed(0)} -> ${end.toFixed(0)} MB (+${(end - start).toFixed(1)}), 300 edits in ${ms} ms`);
    await p.close();
  }

  // 2. A grouped AI turn is one undo step, in the real editor.
  {
    const p = await fresh();
    await p.evaluate(() => {
      window.__dt.dispatch({ op: "setHistoryGroup", group: "turn-1" });
      for (let i = 0; i < 10; i++)
        window.__dt.dispatch({ op: "ai", tool: "create_nodes", input: { nodes: [{ type: "frame", name: `g${i}`, x: i * 120, width: 100, height: 100 }] } });
      window.__dt.dispatch({ op: "setHistoryGroup", group: null });
    });
    check("grouped turn created 10 layers", (await nodeCount(p)) === 10);
    await p.evaluate(() => window.__dt.dispatch({ op: "undo" }));
    check("one undo removes the whole turn", (await nodeCount(p)) === 0 && !(await p.evaluate(() => window.__dt.state().canUndo)));
    await p.evaluate(() => window.__dt.dispatch({ op: "redo" }));
    check("one redo brings it all back", (await nodeCount(p)) === 10 && !(await p.evaluate(() => window.__dt.state().canRedo)));
    await p.close();
  }

  // 3. Undo of a 40-section delete on a ~20k-layer file.
  {
    const p = await fresh();
    await build(p, 165);
    const n = await nodeCount(p);
    await p.evaluate(() => window.__dt.zoomToFit());
    await sleep(500);
    await p.evaluate(() => document.getElementById("dt-canvas")?.focus());
    const roots = await p.evaluate(() =>
      Object.values(window.__dt.doc().nodes)
        .filter((x) => !x.parent)
        .slice(0, 40)
        .map((x) => x.id),
    );
    await p.evaluate((ids) => window.__dt.dispatch({ op: "select", ids }), roots);
    check("40 sections selected", (await p.evaluate(() => window.__dt.state().selection.length)) === 40);
    const time = async (key, cmd) => {
      await p.evaluate(() => {
        window.__t0 = performance.now();
      });
      if (cmd) await p.evaluate((c) => window.__dt.dispatch(c), cmd);
      else await p.keyboard.press(key);
      // The task has finished (render included) once the next frame arrives.
      return p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(performance.now() - window.__t0)))));
    };
    const del = await time("", { op: "delete", ids: roots });
    const afterDel = await nodeCount(p);
    const undo = await time("", { op: "undo" });
    const afterUndo = await nodeCount(p);
    const redo = await time("", { op: "redo" });
    check(`delete removed 40 sections of ${n} layers`, afterDel < n - 4000, `${n} -> ${afterDel}, ${del.toFixed(0)} ms`);
    check("undo brought them back", afterUndo === n, `${afterUndo} layers`);
    check("undo of a 40-section delete < 500 ms", undo < 500, `undo ${undo.toFixed(0)} ms, redo ${redo.toFixed(0)} ms, delete ${del.toFixed(0)} ms`);
    if (SHOTS) await p.screenshot({ path: `${SHOTS}/r9a-20k.png` });
    await p.close();
  }

  check("no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));
} catch (e) {
  check("script ran to the end", false, String(e?.stack ?? e));
}
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
