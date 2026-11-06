// Browser memory on a big file, before/after the Arc node table. Local only: it serves a built
// editor with `vite preview` on its own port and aborts every non-local request.
//   node scripts/qa/r13d-heap.mjs [layers=20000] [--dist dist] [--port 6341]
// Measures after two forced GCs (CDP): JS heap (usedSize), wasm memory (backingStorageSize),
// DOM (embedderHeapUsedSize), DOM node count. `performance.memory` counts the wasm memory too
// and is bucketed unless precise mode is on, so it is printed only as a cross-check.
// Chromium runs with --enable-precise-memory-info --js-flags=--expose-gc.

import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import fs from "node:fs";

const args = process.argv.slice(2);
const opt = (name, d) => (args.includes(name) ? args[args.indexOf(name) + 1] : d);
const N = Number(args.find((a) => /^\d+$/.test(a)) ?? 20000);
const dist = opt("--dist", "dist");
const port = Number(opt("--port", 6341));
const BASE = `http://127.0.0.1:${port}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Run vite directly (not through npx) so killing the child stops the server itself.
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "preview", "--outDir", dist, "--port", String(port), "--host", "127.0.0.1", "--strictPort"], {
  stdio: "ignore",
});
server.on("exit", (code) => {
  if (code) {
    console.error(`vite preview exited with ${code} (port ${port} in use?)`);
    process.exit(1);
  }
});
const stop = () => server.kill();
process.on("exit", stop);
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(BASE)).ok) break;
  } catch {
    await sleep(200);
  }
}

const launch = { headless: true, args: ["--no-sandbox", "--enable-precise-memory-info", "--js-flags=--expose-gc"] };
if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";
const browser = await chromium.launch(launch);
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem("dt:tour-done", "1");
    } catch {
      /* no storage */
    }
  });
  await ctx.route("**/*", (r) => (/^(http:\/\/(localhost|127\.0\.0\.1)|data:|blob:)/.test(r.request().url()) ? r.continue() : r.abort()));
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("HeapProfiler.enable");
  const mb = (x) => (x == null ? null : Math.round(x / 1e6));
  const measure = async (phase, extra = {}) => {
    await cdp.send("HeapProfiler.collectGarbage");
    await sleep(300);
    await cdp.send("HeapProfiler.collectGarbage");
    const h = await cdp.send("Runtime.getHeapUsage");
    const dom = await cdp.send("Memory.getDOMCounters");
    const nodes = await page.evaluate(() => Object.keys(__dt.doc().nodes).length);
    const pm = await page.evaluate(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null));
    console.log(JSON.stringify({ phase, jsHeapMB: mb(h.usedSize), wasmMB: mb(h.backingStorageSize), domMB: mb(h.embedderHeapUsedSize), domNodes: dom.nodes, layers: nodes, perfMemoryMB: pm, ...extra }));
  };

  await page.goto(BASE + "#/");
  await sleep(800);
  await page.getByText("Landing page", { exact: true }).first().click();
  await page.waitForFunction(() => !!(window.__dt && __dt.doc && __dt.doc()), null, { timeout: 30000 });
  await sleep(1500);
  await measure("empty");

  const cards = 50;
  const screens = Math.round((N - 1000) / (cards * 6 + 1));
  await page.evaluate(
    async ({ screens, cards }) => {
      const card = (s, i) => ({
        type: "frame", name: `Card ${s}-${i}`, width: 300, fill: "#FFFFFF", cornerRadius: 12,
        layout: { direction: "vertical", gap: 8, padding: 12 },
        children: [
          { type: "rectangle", name: "Image", width: 276, height: 120, fill: "#CBD5E1", cornerRadius: 8 },
          { type: "text", name: `Title ${s}-${i}`, text: `Item ${s}-${i}`, fontSize: 16, fontWeight: 600, color: "#0F172A" },
          { type: "frame", name: "Row", layout: { direction: "horizontal", gap: 8, crossAlign: "center" }, children: [
            { type: "text", name: "Tag", text: "Tag", fontSize: 12, color: "#475569" },
            { type: "rectangle", name: "Dot", width: 24, height: 24, fill: "#38BDF8", cornerRadius: 12 },
          ] },
        ],
      });
      for (let s = 0; s < screens; s++) {
        const kids = [];
        for (let i = 0; i < cards; i++) kids.push(card(s, i));
        await __dt.tool("create_nodes", { nodes: [{ type: "frame", name: `Screen ${s}`, x: (s % 8) * 2200, y: Math.floor(s / 8) * 13000, width: 360, fill: "#F1F5F9", layout: { direction: "vertical", gap: 16, padding: 16 }, children: kids }] });
      }
      const kids = [];
      for (let i = 0; i < 1000; i++) kids.push({ type: "rectangle", name: `Dot ${i}`, x: (i % 40) * 40, y: Math.floor(i / 40) * 40, width: 30, height: 30, fill: "#7C3AED", cornerRadius: 6 });
      await __dt.tool("create_nodes", { nodes: [{ type: "frame", name: "Big 1000", x: -1800, y: 0, width: 1600, height: 1000, fill: "#FFFFFF", children: kids }] });
    },
    { screens, cards },
  );
  await sleep(4000);
  await measure("built");
  await page.evaluate(() => __dt.zoomToFit());
  await sleep(1500);
  await measure("built+fit");
  await sleep(4000); // let autosave finish

  const t0 = Date.now();
  await page.reload();
  await page.waitForFunction(() => { try { return !!(__dt.doc() && document.querySelectorAll("#dt-canvas g[data-id]").length); } catch { return false; } }, null, { timeout: 300000 });
  const openMs = Date.now() - t0;
  await sleep(3000);
  await measure("reopened", { openMs });
  await page.evaluate(() => __dt.zoomToFit());
  await sleep(2000);
  await measure("reopened+fit");

  // Ctrl+wheel zoom rAF gaps at fit.
  await page.evaluate(() => {
    window.__gaps = [];
    let last = performance.now();
    const tick = (t) => { window.__gaps.push(t - last); last = t; window.__raf = requestAnimationFrame(tick); };
    window.__raf = requestAnimationFrame(tick);
  });
  await page.mouse.move(720, 450);
  await page.keyboard.down("Control");
  for (let i = 0; i < 20; i++) { await page.mouse.wheel(0, i < 10 ? -60 : 60); await sleep(30); }
  await page.keyboard.up("Control");
  await sleep(300);
  const gaps = await page.evaluate(() => { cancelAnimationFrame(window.__raf); return window.__gaps.slice(1).sort((a, b) => a - b); });
  console.log(JSON.stringify({ phase: "zoom", rafP95Ms: Math.round(gaps[Math.floor(gaps.length * 0.95)] ?? 0), frames: gaps.length }));
} finally {
  await browser.close();
  stop();
}
