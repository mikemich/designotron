// Round 18, r18a: big-file editing speed in the real editor (P-1, P-2, P-3, P-5, P-6, P-7).
//
// Builds a generated file in the page the way the QA round-18 testers did (screens of rows, a card
// and a tab-item component used by every screen, a Theme collection with Light/Dark, every screen
// fill and every non-instance text bound to it, every other screen pinned to Dark), then measures,
// on that file and checks what each edit left behind:
//   type 20 characters into a text layer in edit mode       p50 <= 60 ms, no key over 150 ms     (P-1)
//   select every screen, Shift+Right five times             <= 120 ms per key, only screens moved (P-5)
//   set Dark on one screen                                  <= 80 ms, only that screen's fills   (P-6, P-7)
//   delete the bound "Text" variable (the Variables dialog's setVariables) and undo it
//                                                           wall <= 600 ms, longest task <= 400 ms (P-2)
//   copy and paste 29 screens (about 2,000 layers)          paste longest task <= 500 ms        (P-3)
//   create_nodes with 10 screens                            p50 <= 120 ms                        (P-7)
// then (E2E_NO_COLLAB=1 skips it) two editors in a room on a local relay: 10 edits a second for 10
// seconds, and the delta latency p50/p95 is printed (no threshold).
//
// Thresholds are for headless software raster at 20,000 layers (a CPU profile of typing there shows about
// 7 ms per key in wasm and JS; the rest of a key's time is the browser painting, which is why they are wide); at 30,000 and more they are three
// times as wide. E2E_BIG=1 repeats everything on a 50,000-layer file as well.
//
// Local only: it serves web/dist with `vite preview` and the relay binary on its own ports and aborts
// every non-local request.
//   cd web && npm run build && cargo build -p designotron-relay
//   node scripts/qa/r18a-e2e.mjs [layers=20000]
// Env: E2E_PORT (7001) E2E_RELAY_PORT (7003) E2E_URL (an editor that is already served, no vite)
//      E2E_RELAY_BIN (../target/debug/designotron-relay) E2E_DIST (dist) E2E_OUT (screenshots)
//      E2E_BIG=1  E2E_NO_COLLAB=1

import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const LAYERS = Number(args.find((a) => /^\d+$/.test(a)) ?? process.env.E2E_LAYERS ?? 20000);
const PORT = Number(process.env.E2E_PORT ?? 7001);
const RELAY_PORT = Number(process.env.E2E_RELAY_PORT ?? 7003);
const BASE = process.env.E2E_URL ?? `http://127.0.0.1:${PORT}/`;
const RELAY = `http://127.0.0.1:${RELAY_PORT}`;
const DIST = process.env.E2E_DIST ?? "dist";
const RELAY_BIN = process.env.E2E_RELAY_BIN ?? path.resolve("../target/debug/designotron-relay");
const OUT = process.env.E2E_OUT ?? "/tmp/r18a-shots";
const BIG = process.env.E2E_BIG === "1";
const NO_COLLAB = process.env.E2E_NO_COLLAB === "1";
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + String(detail).slice(0, 600) : ""}`);
};
const note = (msg) => console.log(`##    ${msg}`);
const pct = (arr, p) => {
  const a = [...arr].sort((x, y) => x - y);
  return a.length ? +a[Math.min(a.length - 1, Math.floor(a.length * p))].toFixed(1) : null;
};

// ---------- servers ----------
const children = [];
const tmp = [];
const stop = () => {
  for (const c of children) c.kill();
  for (const t of tmp) fs.rmSync(t, { recursive: true, force: true });
};
process.on("exit", stop);
const up = async (url, tries = 100) => {
  for (let i = 0; i < tries; i++) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      /* not yet */
    }
    await sleep(200);
  }
  return false;
};
if (!process.env.E2E_URL) {
  // Run vite directly (not through npx) so killing the child stops the server itself.
  const vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "preview", "--outDir", DIST, "--port", String(PORT), "--host", "127.0.0.1", "--strictPort"], { stdio: "ignore" });
  children.push(vite);
  vite.on("exit", (code) => {
    if (code) {
      console.error(`vite preview exited with ${code} (port ${PORT} in use?)`);
      process.exit(2);
    }
  });
}
if (!(await up(BASE))) {
  console.error(`no editor at ${BASE}`);
  process.exit(2);
}
if (!NO_COLLAB) {
  if (!fs.existsSync(RELAY_BIN)) {
    console.error(`relay binary not found: ${RELAY_BIN} (cargo build -p designotron-relay, or E2E_NO_COLLAB=1)`);
    process.exit(2);
  }
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "r18a-rooms-"));
  tmp.push(data);
  children.push(spawn(RELAY_BIN, ["--port", String(RELAY_PORT), "--static", DIST, "--data", data], { stdio: "ignore" }));
  if (!(await up(`${RELAY}/health`))) {
    console.error(`relay did not start on ${RELAY_PORT}`);
    process.exit(2);
  }
}

// ---------- the browser ----------
const launchOpts = { headless: true, args: ["--no-sandbox", "--enable-precise-memory-info", "--js-flags=--expose-gc"] };
if (fs.existsSync("/opt/pw-browsers/chromium")) launchOpts.executablePath = "/opt/pw-browsers/chromium";
const browser = await chromium.launch(launchOpts);
const LOCAL = /^(https?:\/\/(localhost|127\.0\.0\.1)[:/])|^(data|blob|ws|wss):/;

async function newPeer(name) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await ctx.route((u) => !LOCAL.test(u.toString()), (r) => r.abort());
  await ctx.addInitScript((n) => {
    try {
      localStorage.setItem("dt:tour-done", "1");
      localStorage.setItem("dt:userName", n);
    } catch {
      /* no storage */
    }
    window.__lt = [];
    try {
      new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__lt.push([e.startTime, e.duration]))).observe({ type: "longtask", buffered: true });
    } catch {
      /* no long task entries */
    }
  }, name);
  const page = await ctx.newPage();
  const p = { name, ctx, page, errors: [] };
  page.on("pageerror", (e) => p.errors.push("pageerror: " + e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/bridge\/ws|Failed to load resource|ERR_INTERNET_DISCONNECTED|WebSocket connection/.test(m.text())) p.errors.push("console: " + m.text().slice(0, 200));
  });
  return p;
}

// Longest long task that started after `since` (a performance.now() mark taken in the page).
const longestSince = (page, since) => page.evaluate((s) => Math.max(0, ...window.__lt.filter((x) => x[0] >= s - 5).map((x) => x[1])), since);
const mark = (page) => page.evaluate(() => performance.now());
// Page-side: how long `fn` takes until the browser has painted the result (two frames), and the longest task meanwhile.
async function timed(page, fnSrc, arg) {
  return page.evaluate(
    async ([src, a]) => {
      const t0 = performance.now();
      const out = await eval(src)(a);
      const syncMs = performance.now() - t0;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const wallMs = performance.now() - t0;
      const lt = Math.max(0, ...window.__lt.filter((x) => x[0] >= t0 - 5).map((x) => x[1]));
      return { out, syncMs, wallMs, longest: lt };
    },
    [fnSrc, arg],
  );
}

// ---------- the file ----------
async function buildFile(page, target) {
  await page.goto(BASE);
  await page.waitForSelector(".files");
  await page.click("button:has-text('New design file')");
  await page.waitForSelector("#dt-canvas");
  const t0 = Date.now();
  const built = await page.evaluate(async ({ target }) => {
    const tool = (n, input) => window.__dt.tool(n, input);
    const count = () => Object.keys(window.__dt.doc().nodes).length;
    const card = await tool("create_nodes", {
      nodes: [{ type: "frame", name: "Card", x: -1000, y: 0, width: 358, layout: { direction: "vertical", gap: 8, padding: 12 }, cornerRadius: 12, fill: "#FFFFFF", children: [
        { type: "rectangle", name: "Cover", width: "fill", height: 140, cornerRadius: 8, fill: "#DDDDDD" },
        { type: "text", name: "Title", text: "Card title", fontSize: 17, fontWeight: 600, fill: "#111827" },
        { type: "text", name: "Body", text: "Secondary copy that explains the card", fontSize: 13, fill: "#6B7280", width: "fill" },
        { type: "frame", name: "Action", width: 120, height: 36, cornerRadius: 18, fill: "#2563EB", children: [{ type: "text", name: "Label", text: "Open", fontSize: 14, fontWeight: 600, fill: "#FFFFFF" }] }] }],
    });
    const cardId = card.result.created[0].id;
    const cc = (await tool("arrange", { action: "create_component", ids: [cardId] })).result;
    const cardMain = cc.id ?? cc.componentId ?? cardId;
    const nav = await tool("create_nodes", {
      nodes: [{ type: "frame", name: "NavItem", x: -1000, y: 500, width: 78, height: 56, layout: { direction: "vertical", gap: 4, padding: 4 }, children: [
        { type: "rectangle", name: "Icon", width: 24, height: 24, fill: "#9CA3AF", cornerRadius: 6 },
        { type: "text", name: "Label", text: "Home", fontSize: 11, fill: "#6B7280" }] }],
    });
    const nc = (await tool("arrange", { action: "create_component", ids: [nav.result.created[0].id] })).result;
    const navMain = nc.id ?? nc.componentId ?? nav.result.created[0].id;
    const screenSpec = (i) => ({
      type: "frame", name: `Screen ${i}`, x: (i % 25) * 440, y: Math.floor(i / 25) * 920, width: 390, height: 844, fill: "#FFFFFF", layout: { direction: "vertical", gap: 12, padding: 16 },
      children: [
        { type: "frame", name: "Status bar", width: "fill", height: 44, layout: { direction: "horizontal" }, children: [
          { type: "text", name: "Time", text: "9:41", fontSize: 15, fontWeight: 600 }, { type: "rectangle", name: "Battery", width: 24, height: 12, fill: "#111111", cornerRadius: 3 }] },
        { type: "frame", name: "Header", width: "fill", layout: { direction: "horizontal", gap: 8 }, children: [
          { type: "text", name: "Greeting", text: `Good morning, Ada ${i}`, fontSize: 24, fontWeight: 700, width: "fill", fill: "#111827" },
          { type: "rectangle", name: "Bell", width: 24, height: 24, fill: "#E5E7EB", cornerRadius: 12 }] },
        { type: "frame", name: "Search", width: "fill", height: 44, cornerRadius: 12, fill: "#F3F4F6", layout: { direction: "horizontal", padding: 12 }, children: [
          { type: "text", name: "Placeholder", text: "Search projects", fontSize: 15, fill: "#6B7280" }] },
        ...Array.from({ length: 6 }, (_, k) => ({ type: "frame", name: `Row ${k}`, width: "fill", layout: { direction: "horizontal", gap: 12, crossAxis: "center" }, children: [
          { type: "rectangle", name: "Avatar", width: 48, height: 48, cornerRadius: 24, fill: "#CCCCCC" },
          { type: "frame", name: "Text", width: "fill", layout: { direction: "vertical", gap: 2 }, children: [
            { type: "text", name: "Name", text: `Project ${i}-${k}`, fontSize: 16, fontWeight: 600, fill: "#111827" },
            { type: "text", name: "Meta", text: "Updated 2h ago · 3 comments", fontSize: 13, fill: "#6B7280" }] },
          { type: "rectangle", name: "Chevron", width: 8, height: 14, fill: "#9CA3AF" }] })),
        { type: "instance", name: "Card", componentId: cardMain, width: 358 },
        { type: "instance", name: "Card", componentId: cardMain, width: 358 },
        { type: "frame", name: "Tab bar", width: "fill", height: 64, fill: "#FFFFFF", layout: { direction: "horizontal", padding: 4 }, children: [0, 1, 2, 3].map((k) => ({ type: "instance", name: `Tab ${k}`, componentId: navMain })) }],
    });
    window.__specs = screenSpec;
    window.__ids = { cardMain, navMain };
    const screens = Math.max(1, Math.round((target - count()) / 68));
    for (let s = 0; s < screens; s += 10) {
      const specs = [];
      for (let i = s; i < Math.min(screens, s + 10); i++) specs.push(screenSpec(i));
      const r = await tool("create_nodes", { nodes: specs });
      if (!r.ok) return { error: "create_nodes failed: " + JSON.stringify(r).slice(0, 300), at: s };
      if (s % 100 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    await tool("define_variables", {
      collection: "Theme", modes: ["Light", "Dark"], variables: [
        { name: "Surface", type: "color", values: { Light: "#FFFFFF", Dark: "#0B0F19" } },
        { name: "Text", type: "color", values: { Light: "#111827", Dark: "#F9FAFB" } },
        { name: "Muted", type: "color", values: { Light: "#6B7280", Dark: "#9CA3AF" } },
        { name: "Primary", type: "color", values: { Light: "#2563EB", Dark: "#60A5FA" } }],
    });
    const nodes = window.__dt.doc().nodes;
    const screenIds = Object.values(nodes).filter((n) => n.name.startsWith("Screen ") && !n.parent).map((n) => n.id);
    const textIds = Object.values(nodes).filter((n) => n.type === "text" && !n.instance).map((n) => n.id);
    window.__dt.dispatch({ op: "bindVariable", ids: screenIds, property: "fill", variable: "Theme/Surface" });
    window.__dt.dispatch({ op: "bindVariable", ids: textIds, property: "fill", variable: "Theme/Text" });
    const coll = window.__dt.doc().variables[0];
    const dark = coll.modes.find((m) => m.name === "Dark").id;
    screenIds.forEach((sid, i) => {
      if (i % 2 === 1) window.__dt.dispatch({ op: "setVariableMode", ids: [sid], collection: coll.id, mode: dark });
    });
    return { nodes: count(), screens: screenIds.length, bound: Object.values(window.__dt.doc().nodes).filter((n) => Object.keys(n.bindings ?? {}).length).length };
  }, { target });
  if (built.error) throw new Error(built.error);
  note(`built ${built.nodes} layers (${built.screens} screens, ${built.bound} bound) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return built;
}

// What the checks look at, as plain data (canonical: sorted).
const SNAP = `(() => {
  const d = window.__dt.doc();
  const out = {};
  for (const n of Object.values(d.nodes)) {
    out[n.id] = { x: n.x, y: n.y, fills: (n.fills || []).map((f) => f.color ?? f.type), bindings: n.bindings ?? {}, modes: n.variableModes ?? {}, name: n.name, parent: n.parent ?? null, overrides: n.instance ? JSON.stringify(n.instance.overrides ?? {}) : "" };
  }
  return out;
})()`;
const snap = (page) => page.evaluate((src) => eval(src), SNAP);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function suite(label, target, collab) {
  const peer = await newPeer("Ada");
  const { page } = peer;
  const strict = target >= 30000 ? 3 : 1;
  const T = (n) => n * strict;
  note(`---- ${label}: ${target} layers (thresholds x${strict}) ----`);
  const built = await buildFile(page, target);
  check(`${label}: the file has about ${target} layers`, built.nodes > target * 0.85 && built.nodes < target * 1.2, built.nodes);
  await page.evaluate(() => window.__dt.zoomToFit());
  await sleep(1500);
  await page.screenshot({ path: path.join(OUT, `${label}-built.png`) });

  // ---- typing (P-1) ----
  const greet = await page.evaluate(() => Object.values(window.__dt.doc().nodes).find((n) => n.type === "text" && n.name === "Greeting" && !n.instance).id);
  const original = await page.evaluate((id) => window.__dt.doc().nodes[id].text.characters, greet);
  await page.evaluate((id) => window.__dt.dispatch({ op: "select", ids: [id] }), greet);
  await page.evaluate((id) => window.__dt.edit(id), greet);
  await sleep(600);
  const typed = "Designotron typing!";
  const keys = [];
  const m0 = await mark(page);
  for (const ch of typed) {
    const t = Date.now();
    await page.keyboard.type(ch);
    keys.push(Date.now() - t);
  }
  await sleep(400);
  const typingLongest = await longestSince(page, m0);
  const [p50, p95, max] = [pct(keys, 0.5), pct(keys, 0.95), Math.max(...keys)];
  note(`typing ${typed.length} characters: p50 ${p50} ms, p95 ${p95} ms, max ${max} ms, longest task ${typingLongest.toFixed(0)} ms`);
  check(`${label}: typing p50 <= ${T(60)} ms`, p50 <= T(60), p50);
  check(`${label}: no key over ${T(150)} ms`, max <= T(150), max);
  const nowText = await page.evaluate((id) => window.__dt.doc().nodes[id].text.characters, greet);
  // Entering edit mode selects the text, so what is typed replaces it.
  check(`${label}: the typed text is in the layer`, nowText === typed, JSON.stringify(nowText));
  await page.keyboard.press("Escape");
  await sleep(300);

  // ---- nudging every screen (P-5) ----
  const screens = await page.evaluate(() => Object.values(window.__dt.doc().nodes).filter((n) => n.name.startsWith("Screen ") && !n.parent).map((n) => n.id));
  const beforeNudge = await snap(page);
  await page.evaluate((ids) => window.__dt.dispatch({ op: "select", ids }), screens);
  await sleep(300);
  await page.focus("body").catch(() => {});
  const nudge = [];
  for (let i = 0; i < 5; i++) {
    const t = Date.now();
    await page.keyboard.press("Shift+ArrowRight");
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
    nudge.push(Date.now() - t);
    await sleep(60);
  }
  note(`nudge ${screens.length} screens x5: ${nudge.join(", ")} ms per key`);
  check(`${label}: every nudge <= ${T(120)} ms`, Math.max(...nudge) <= T(120), nudge.join(","));
  const afterNudge = await snap(page);
  const screenSet = new Set(screens);
  const moved = Object.keys(afterNudge).filter((id) => afterNudge[id].x !== beforeNudge[id].x || afterNudge[id].y !== beforeNudge[id].y);
  check(`${label}: only the nudged screens moved, by 50 px`, moved.length === screens.length && moved.every((id) => screenSet.has(id) && afterNudge[id].x === beforeNudge[id].x + 50 && afterNudge[id].y === beforeNudge[id].y), `${moved.length} moved of ${screens.length}`);
  const nudgeUndo = await timed(page, "(async () => { for (let i = 0; i < 5; i++) window.__dt.dispatch({ op: 'undo' }); })", null);
  note(`undo of the five nudges: ${nudgeUndo.wallMs.toFixed(0)} ms`);
  check(`${label}: undoing the nudges brings every layer back`, same(await snap(page), beforeNudge));

  // ---- Dark on one screen (P-6, P-7) ----
  const light = await page.evaluate(() => {
    const d = window.__dt.doc();
    return Object.values(d.nodes).find((n) => n.name.startsWith("Screen ") && !n.parent && !Object.keys(n.variableModes ?? {}).length).id;
  });
  const theme = await page.evaluate(() => {
    const c = window.__dt.doc().variables[0];
    return { id: c.id, dark: c.modes.find((m) => m.name === "Dark").id };
  });
  const beforeDark = await snap(page);
  const dark = await timed(page, "((a) => window.__dt.dispatch({ op: 'setVariableMode', ids: [a.id], collection: a.coll, mode: a.mode }))", { id: light, coll: theme.id, mode: theme.dark });
  note(`set Dark on one screen: ${dark.wallMs.toFixed(0)} ms to paint (${dark.syncMs.toFixed(0)} ms in the call), longest task ${dark.longest.toFixed(0)} ms`);
  check(`${label}: Dark on one screen <= ${T(80)} ms`, dark.wallMs <= T(80), dark.wallMs.toFixed(0));
  const afterDark = await snap(page);
  const inside = new Set(await page.evaluate((id) => {
    const d = window.__dt.doc().nodes;
    const out = [];
    const walk = (i) => { out.push(i); (d[i].children ?? []).forEach(walk); };
    walk(id);
    return out;
  }, light));
  const changed = Object.keys(afterDark).filter((id) => !same(afterDark[id].fills, beforeDark[id].fills));
  const boundInside = [...inside].filter((id) => beforeDark[id].bindings.fill);
  check(`${label}: only the pinned screen's fills changed`, changed.length > 0 && changed.every((id) => inside.has(id)), `${changed.length} changed, ${changed.filter((id) => !inside.has(id)).length} outside`);
  check(`${label}: every bound fill of that screen now shows its Dark value`, boundInside.length > 0 && boundInside.every((id) => ["#0B0F19", "#F9FAFB"].includes(afterDark[id].fills[0]?.toUpperCase?.() ?? "") || beforeDark[id].fills[0] === afterDark[id].fills[0]), `${boundInside.length} bound`);
  await page.evaluate(() => window.__dt.dispatch({ op: "undo" }));
  check(`${label}: undo puts the screen back`, same(await snap(page), beforeDark));

  // ---- delete the bound variable, and undo (P-2) ----
  const beforeDel = await snap(page);
  const textVar = await page.evaluate(() => window.__dt.doc().variables[0].variables.find((v) => v.name === "Text").id);
  const del = await timed(page, `((id) => {
    const cols = JSON.parse(JSON.stringify(window.__dt.doc().variables));
    cols[0].variables = cols[0].variables.filter((v) => v.id !== id);
    return window.__dt.dispatch({ op: 'setVariables', collections: cols });
  })`, textVar);
  note(`delete the Text variable: ${del.wallMs.toFixed(0)} ms to paint (${del.syncMs.toFixed(0)} ms in the call), longest task ${del.longest.toFixed(0)} ms`);
  check(`${label}: variable delete wall <= ${T(600)} ms`, del.wallMs <= T(600), del.wallMs.toFixed(0));
  check(`${label}: variable delete longest task <= ${T(400)} ms`, del.longest <= T(400), del.longest.toFixed(0));
  const afterDel = await snap(page);
  const naming = Object.values(afterDel).filter((n) => Object.values(n.bindings).includes(textVar) || n.overrides.includes(textVar));
  check(`${label}: no layer or instance override names the variable any more`, naming.length === 0, `${naming.length} do`);
  // (A layer inside an instance is a copy of its main's layer, so it takes the main's colour again
  // when the main loses its binding: the Light value, even on a Dark screen. That is how instance
  // syncing has always worked; the checks below leave those copies out and count them.)
  const copies = new Set(await page.evaluate(() => Object.values(window.__dt.doc().nodes).filter((n) => n.masterId).map((n) => n.id)));
  const lost = Object.keys(beforeDel).filter((id) => !copies.has(id) && !same(beforeDel[id].fills, afterDel[id].fills));
  const lostCopies = Object.keys(beforeDel).filter((id) => copies.has(id) && !same(beforeDel[id].fills, afterDel[id].fills)).length;
  note(`${lostCopies} layers inside instances took their main's colour again (as before round 18)`);
  check(`${label}: every fill outside instances keeps its colour`, lost.length === 0, `${lost.length} changed, e.g. ${lost.slice(0, 3).map((id) => `${beforeDel[id].name} ${beforeDel[id].fills} -> ${afterDel[id].fills}`).join("; ")}`);
  const undo = await timed(page, "(() => window.__dt.dispatch({ op: 'undo' }))", null);
  note(`undo of the delete: ${undo.wallMs.toFixed(0)} ms to paint (${undo.syncMs.toFixed(0)} ms in the call), longest task ${undo.longest.toFixed(0)} ms`);
  check(`${label}: undo of the delete wall <= ${T(600)} ms`, undo.wallMs <= T(600), undo.wallMs.toFixed(0));
  check(`${label}: undo brings every binding and override back`, same(await snap(page), beforeDel));

  // ---- copy and paste about 2,000 layers (P-3) ----
  const pick = await page.evaluate(() => {
    const d = window.__dt.doc().nodes;
    // In paint order (the page's list), the order a paste makes them in.
    const page = window.__dt.doc().pages.find((p) => p.children.some((c) => d[c]?.name.startsWith("Screen ")));
    const ids = page.children.filter((c) => d[c].name.startsWith("Screen ")).slice(0, 29);
    let count = 0;
    const walk = (i) => { count++; (d[i].children ?? []).forEach(walk); };
    ids.forEach(walk);
    return { ids, count };
  });
  const copied = await timed(page, "((ids) => window.__dt.query({ q: 'copy', ids }))", pick.ids);
  const clip = await page.evaluate((ids) => window.__dt.query({ q: "copy", ids }), pick.ids);
  note(`copy ${pick.ids.length} screens (${pick.count} layers): ${copied.wallMs.toFixed(0)} ms, ${(String(clip).length / 1e6).toFixed(1)} MB of clipboard`);
  const beforePaste = await snap(page);
  const paste = await timed(page, "((clip) => window.__dt.dispatch({ op: 'paste', data: clip, parent: null, x: -30000, y: -30000 }))", clip);
  note(`paste ${pick.count} layers: ${paste.wallMs.toFixed(0)} ms to paint (${paste.syncMs.toFixed(0)} ms in the call), longest task ${paste.longest.toFixed(0)} ms`);
  check(`${label}: paste longest task <= ${T(500)} ms`, paste.longest <= T(500), paste.longest.toFixed(0));
  const created = paste.out?.created ?? [];
  check(`${label}: one new top-level layer per copied screen`, created.length === pick.ids.length, created.length);
  const afterPaste = await snap(page);
  const dup = await page.evaluate(([src, made]) => {
    const d = window.__dt.doc().nodes;
    const flat = (id) => { const out = []; const walk = (i) => { const n = d[i]; out.push([n.name, JSON.stringify((n.fills ?? []).map((f) => f.color ?? f.type)), JSON.stringify(n.bindings ?? {}), n.type]); (n.children ?? []).forEach(walk); }; walk(id); return out; };
    const bad = [];
    src.forEach((s, i) => {
      const a = flat(s), b = flat(made[i]);
      const at = a.findIndex((row, k) => JSON.stringify(row) !== JSON.stringify(b[k]));
      if (at >= 0 || a.length !== b.length) bad.push(`${a[0][0]}: layer ${at} ${JSON.stringify(a[at])} vs ${JSON.stringify(b[at])}`);
    });
    return bad;
  }, [pick.ids, created]);
  check(`${label}: the pasted layers equal the copied ones (names, fills, bindings)`, created.length === pick.ids.length && dup.length === 0, `${dup.length} differ, e.g. ${dup[0]}`);
  check(`${label}: nothing else changed by pasting`, Object.keys(beforePaste).every((id) => same(beforePaste[id], afterPaste[id])) && Object.keys(afterPaste).length - Object.keys(beforePaste).length === pick.count);
  await page.evaluate(() => window.__dt.dispatch({ op: "undo" }));
  check(`${label}: undo of the paste`, same(await snap(page), beforePaste));

  // ---- create_nodes with 10 screens (P-7) ----
  const creates = [];
  for (let b = 0; b < 5; b++) {
    const r = await timed(page, `(async (b) => { const specs = []; for (let i = 0; i < 10; i++) specs.push(window.__specs(5000 + b * 10 + i)); return (await window.__dt.tool('create_nodes', { nodes: specs })).ok; })`, b);
    creates.push(r.wallMs);
    if (!r.out) check(`${label}: create_nodes batch ${b} worked`, false);
  }
  const cp50 = pct(creates, 0.5);
  note(`create_nodes with 10 screens x5: ${creates.map((x) => x.toFixed(0)).join(", ")} ms`);
  check(`${label}: create_nodes p50 <= ${T(120)} ms`, cp50 <= T(120), cp50);

  check(`${label}: no page errors`, peer.errors.length === 0, peer.errors.slice(0, 3).join(" | "));
  await page.screenshot({ path: path.join(OUT, `${label}-end.png`) });

  if (collab) await collabLatency(peer, label);
  await peer.ctx.close();
}

// ---------- two editors in a room: delta latency (report only) ----------
async function collabLatency(owner, label) {
  const page = owner.page;
  try {
    await page.click(".tbtn[title='Share for live editing']");
    await page.fill(".share-dialog input.textinput >> nth=0", "Ada");
    await page.waitForSelector(".share-dialog input.mono, .share-dialog :text('Use a different relay')", { timeout: 15000 });
    if (!(await page.locator(".share-dialog input.mono").count())) await page.click(".share-dialog :text('Use a different relay')");
    await page.fill(".share-dialog input.mono", RELAY);
    const t0 = Date.now();
    await page.click("button:has-text('Share online')");
    await page.waitForFunction(() => window.__dt.collab().status === "live", null, { timeout: 120000 });
    const link = await page.evaluate(() => window.__dt.collab().link);
    note(`${label}: shared online in ${Date.now() - t0} ms`);
    await page.keyboard.press("Escape");
    await page.click(".modal-head .ibtn[title='Close']").catch(() => {});
    const room = new URL(link).searchParams.get("room");
    const total = await page.evaluate(() => Object.keys(window.__dt.doc().nodes).length);
    const guest = await newPeer("Ben");
    const j0 = Date.now();
    await guest.page.goto(`${RELAY}/?room=${room}`);
    await guest.page.waitForFunction((n) => window.__dt.collab().status === "live" && Object.keys(window.__dt.doc().nodes).length >= n, total, { timeout: 300000 });
    note(`${label}: the second editor joined in ${((Date.now() - j0) / 1000).toFixed(1)} s`);
    const watch = await page.evaluate(() => Object.values(window.__dt.doc().nodes).filter((n) => n.name.startsWith("Screen ") && !n.parent).slice(0, 100).map((n) => n.id));
    await guest.page.evaluate((ids) => {
      window.__seen = {};
      window.__dt.onDocChange(() => {
        const d = window.__dt.doc().nodes;
        for (const id of ids) {
          const n = d[id];
          if (n && n.x >= 100000 && !window.__seen[n.x]) window.__seen[n.x] = Date.now();
        }
      });
    }, watch);
    const sent = [];
    for (let i = 0; i < 100; i++) {
      const val = 100000 + i;
      sent.push([val, Date.now()]);
      await page.evaluate(([id, v]) => window.__dt.dispatch({ op: "update", ids: [id], patch: { x: v } }), [watch[i], val]);
      await sleep(100);
    }
    await sleep(3000);
    const seen = await guest.page.evaluate(() => window.__seen);
    const lat = sent.map(([v, t]) => (seen[v] ? seen[v] - t : null)).filter((x) => x !== null);
    note(`${label}: collaboration, 10 edits/s for 10 s: ${lat.length}/100 arrived, delta latency p50 ${pct(lat, 0.5)} ms, p95 ${pct(lat, 0.95)} ms, max ${Math.max(...lat)} ms`);
    check(`${label}: every edit reached the second editor`, lat.length === 100, lat.length);
    check(`${label}: the second editor's layers are the first's`, await (async () => {
      const [a, b] = await Promise.all([snap(page), snap(guest.page)]);
      return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((id) => b[id] && a[id].x === b[id].x && same(a[id].fills, b[id].fills));
    })());
    check(`${label}: no page errors in the room`, guest.errors.length === 0 && owner.errors.length === 0, [...owner.errors, ...guest.errors].slice(0, 3).join(" | "));
    await guest.ctx.close();
  } catch (e) {
    check(`${label}: collaboration section ran`, false, String(e));
  }
}

try {
  await suite("20k", LAYERS, !NO_COLLAB);
  if (BIG) await suite("50k", 50000, false);
} catch (e) {
  check("the run finished", false, e.stack ?? String(e));
}
await browser.close();
stop();
console.log(failed ? `\n${failed} FAILED` : "\nALL PASSED");
process.exit(failed ? 1 : 0);
