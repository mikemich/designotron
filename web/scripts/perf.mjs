// Browser performance check on a large file: drag frame time (engine + canvas DOM patch).
// Usage: node scripts/perf.mjs [frames] [cards]   (needs the dev server on 5173, or E2E_URL)
// PROFILE=1 prints a CPU profile summary; TRACE=1 lists layout passes; ZOOM=1 first times
// Ctrl+wheel zoom at the zoom-to-fit view (frame gaps and the longest task).
// Headless Chromium rasterises in software, so frame times overstate paint cost.

import { chromium } from "playwright-core";
import fs from "node:fs";

const URL_ = process.env.E2E_URL ?? "http://localhost:5173";
const frames = Number(process.argv[2] ?? 40);
const cards = Number(process.argv[3] ?? 30);
const launch = { headless: true, args: ["--no-sandbox"] };
if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";

const browser = await chromium.launch(launch);
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
await page.addInitScript(() => {
  try {
    localStorage.setItem("dt:tour-done", "1");
  } catch {
    /* sandboxed frames (plugins) have no storage */
  }
});
await page.goto(URL_);
await page.waitForSelector(".files");
await page.click("button:has-text('New design file')");
await page.waitForSelector("#dt-canvas");

const info = await page.evaluate(
  ({ frames, cards }) => {
    const ai = (tool, input) => window.__dt.dispatch({ op: "ai", tool, input });
    const card = ai("create_nodes", {
      nodes: [{ type: "frame", name: "Card", x: -400, width: 300, fill: "#FFFFFF", cornerRadius: 12, layout: { direction: "horizontal", gap: 12, padding: 12 },
        children: [{ type: "rectangle", width: 48, height: 48, fill: "#DDD" }, { type: "frame", width: "fill", layout: { direction: "vertical", gap: 4 },
          children: [{ type: "text", text: "Card title", fontSize: 16, fontWeight: 600 }, { type: "text", text: "Some secondary text that wraps", fontSize: 13, width: "fill" }] }] }],
    }).created[0].id;
    const comp = ai("arrange", { action: "create_component", ids: [card] }).id;
    let first = null;
    for (let f = 0; f < frames; f++) {
      const r = ai("create_nodes", { nodes: [{ type: "frame", name: `Screen ${f}`, x: f * 500, width: 393, layout: { direction: "vertical", gap: 8, padding: 16 },
        children: Array.from({ length: cards }, () => ({ type: "instance", componentId: comp })) }] });
      first ??= r.created[0].id;
    }
    return { nodes: Object.keys(window.__dt.doc().nodes).length, first };
  },
  { frames, cards },
);
await page.evaluate(() => window.__dt.zoomToFit());
if (process.env.DUMP) {
  await page.waitForTimeout(300);
  fs.writeFileSync(process.env.DUMP, await page.evaluate(() => document.querySelector("#dt-canvas > svg").outerHTML));
}
await page.waitForTimeout(500);

if (process.env.ZOOM) {
  await page.evaluate(() => {
    window.__gaps = [];
    window.__long = [];
    let last = performance.now();
    const loop = () => {
      const t = performance.now();
      window.__gaps.push(t - last);
      last = t;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push(e.duration))).observe({ entryTypes: ["longtask"] });
  });
  await page.mouse.move(800, 500);
  for (const dir of [-1, 1]) {
    await page.evaluate(() => ((window.__gaps = []), (window.__long = [])));
    await page.keyboard.down("Control");
    for (let i = 0; i < 10; i++) await page.mouse.wheel(0, dir * 60);
    await page.keyboard.up("Control");
    await page.waitForTimeout(800);
    const z = await page.evaluate(() => {
      const g = [...window.__gaps].sort((a, b) => a - b);
      return { frames: g.length, p50: g[Math.floor(g.length / 2)], p95: g[Math.floor(g.length * 0.95)], max: g[g.length - 1], longest: Math.max(0, ...window.__long) };
    });
    console.log(`zoom ${dir < 0 ? "in " : "out"}: ${z.frames} frames, p50 ${z.p50.toFixed(1)} ms, p95 ${z.p95.toFixed(1)} ms, max ${z.max.toFixed(1)} ms, longest task ${z.longest.toFixed(0)} ms`);
  }
  await page.evaluate(() => window.__dt.zoomToFit());
  await page.waitForTimeout(500);
}

// Select the first screen, zoom to it, and drag it by its padding.
await page.evaluate((id) => window.__dt.dispatch({ op: "select", ids: [id] }), info.first);
await page.click("#dt-canvas", { position: { x: 5, y: 980 } }).catch(() => {});
await page.evaluate((id) => window.__dt.dispatch({ op: "select", ids: [id] }), info.first);
await page.keyboard.press("Shift+2");
await page.waitForTimeout(300);
const box = await page.evaluate((id) => {
  const r = document.querySelector(`[data-label="${id}"]`).getBoundingClientRect();
  return { x: r.x + 6, y: r.bottom + 10 };
}, info.first);
const cdp = process.env.PROFILE ? await page.context().newCDPSession(page) : null;
if (cdp) {
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
  await cdp.send("Profiler.start");
}
const metrics = await page.context().newCDPSession(page);
await metrics.send("Performance.enable");
const snap = async () => Object.fromEntries((await metrics.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
const m0 = await snap();
const tracing = process.env.TRACE ? await page.context().newCDPSession(page) : null;
const traceEvents = [];
if (tracing) {
  tracing.on("Tracing.dataCollected", (e) => traceEvents.push(...e.value));
  await tracing.send("Tracing.start", { categories: "devtools.timeline,disabled-by-default-devtools.timeline.stack", transferMode: "ReportEvents" });
}
// Real mouse input; each step waits for the next painted frame.
await page.mouse.move(box.x, box.y);
await page.mouse.down();
const times = [];
for (let i = 1; i <= 40; i++) {
  const t = Date.now();
  await page.mouse.move(box.x + i * 6, box.y);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  times.push(Date.now() - t);
}
await page.mouse.up();
times.sort((a, b) => a - b);
const result = { median: times[20], p90: times[36] };
const m1 = await snap();
if (tracing) {
  const done = new Promise((r) => tracing.once("Tracing.tracingComplete", r));
  await tracing.send("Tracing.end");
  await done;
  const layouts = traceEvents.filter((e) => e.name === "Layout" && e.ph === "X" || e.name === "Layout" && e.ph === "B");
  const byStack = new Map();
  for (const e of layouts) {
    const st = e.args?.beginData?.stackTrace?.[0];
    const k = st ? `${st.functionName}@${st.url.split("/").pop()}:${st.lineNumber}` : "(frame)";
    const v = byStack.get(k) ?? { n: 0, ms: 0, objs: 0 };
    v.n++;
    v.ms += (e.dur ?? 0) / 1000;
    v.objs += e.args?.beginData?.dirtyObjects ?? 0;
    byStack.set(k, v);
  }
  const sample = layouts.slice(10, 14).map((e) => JSON.stringify({ dur: ((e.dur ?? 0) / 1000).toFixed(1), begin: e.args?.beginData, roots: e.args?.endData?.layoutRoots?.map((r) => ({ id: r.nodeId, depth: r.depth })) }));
  console.log(sample.join("\n"));
  const ids = [...new Set(layouts.flatMap((e) => (e.args?.endData?.layoutRoots ?? []).map((r) => r.nodeId)))].slice(0, 6);
  const dom = await page.context().newCDPSession(page);
  await dom.send("DOM.getDocument", { depth: -1 });
  for (const id of ids) {
    const d = await dom.send("DOM.describeNode", { backendNodeId: id }).catch((err) => ({ node: { nodeName: String(err).slice(0, 60) } }));
    console.log("layout root", id, d.node.nodeName, JSON.stringify(d.node.attributes ?? []).slice(0, 120));
  }
  console.log("layouts:", layouts.length, [...byStack.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 8).map(([k, v]) => `${k} n=${v.n} ${v.ms.toFixed(0)}ms dirty=${v.objs}`).join(" | "));
}
const per = (k) => (((m1[k] - m0[k]) * 1000) / 40).toFixed(1);
console.log(`per frame: script ${per("ScriptDuration")} ms, style ${per("RecalcStyleDuration")} ms, layout ${per("LayoutDuration")} ms, task total ${per("TaskDuration")} ms`);
if (cdp) {
  const { profile } = await cdp.send("Profiler.stop");
  const self = new Map();
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const dt = profile.timeDeltas;
  profile.samples.forEach((id, i) => {
    const n = byId.get(id);
    const key = `${n.callFrame.functionName || "(anon)"} ${n.callFrame.url.split("/").pop()}:${n.callFrame.lineNumber}`;
    self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0) / 1000);
  });
  console.log([...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${v.toFixed(1).padStart(8)} ms  ${k}`).join("\n"));
}
const moved = await page.evaluate((id) => window.__dt.doc().nodes[id].x, info.first);
console.log(`${info.nodes} layers: drag frame median ${result.median.toFixed(1)} ms, p90 ${result.p90.toFixed(1)} ms (moved to x=${Math.round(moved)})`);
await browser.close();
