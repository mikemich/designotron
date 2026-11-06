// Round 11, P1: durable relay acks. An edit the relay acknowledged is on its disk (room log,
// fsynced before the ack and before anyone else sees it), so SIGKILL right after an ack loses
// nothing for anyone. Also reports ack latency for a drag-sized burst and for a 500-layer paste
// with concurrent edits (and the relay's own sync timings from /health).
// Starts its own relay (E2E_RELAY_BIN, default ../target/debug/designotron-relay) on E2E_PORT
// (default 5914) with a temp --data dir, serving web/dist, and stops it when done. Local only:
// every non-local request is aborted. E2E_COMPARE_BIN: a relay from before the change, to run
// the burst measurements against as well (informational; its SIGKILL loss is not asserted).
// Usage: cd web && npm run build && node scripts/qa/r11a-e2e.mjs      Screenshots: E2E_OUT.

import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.E2E_PORT ?? 5914);
const BASE = `http://127.0.0.1:${PORT}`;
const BIN = process.env.E2E_RELAY_BIN ?? path.resolve("../target/debug/designotron-relay");
const COMPARE = process.env.E2E_COMPARE_BIN;
const OUT = process.env.E2E_OUT ?? "/tmp/r11a-shots";
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
};
const info = (s) => console.log(`      ${s}`);
async function waitUntil(fn, timeout = 20000, step = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      if (await fn()) return true;
    } catch {
      /* not yet */
    }
    await sleep(step);
  }
  return false;
}
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;
const pct = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] ?? 0;

// ---- the relay ----
let DATA = "";
let relay = null;
let exited = null;
let expectedExit = false;
function startRelay(bin = BIN) {
  expectedExit = false;
  exited = new Promise((res) => {
    relay = spawn(bin, ["--port", String(PORT), "--static", "dist", "--data", DATA], {
      stdio: ["ignore", "ignore", process.env.E2E_RELAY_LOG ? fs.openSync(process.env.E2E_RELAY_LOG, "a") : "ignore"],
    });
    relay.on("exit", (code, sig) => {
      if (!expectedExit) console.log(`      relay exited unexpectedly: code ${code} signal ${sig}`);
      res({ code, sig });
    });
  });
  return waitUntil(() => fetch(`${BASE}/health`).then((r) => r.ok, () => false), 10000, 50);
}
async function killRelay() {
  expectedExit = true;
  relay.kill("SIGKILL");
  await exited;
}
async function stopRelay() {
  expectedExit = true;
  relay.kill("SIGTERM");
  await Promise.race([exited, sleep(8000)]);
}
const health = () => fetch(`${BASE}/health`).then((r) => r.json());
const diskText = () =>
  fs
    .readdirSync(DATA)
    .filter((f) => f.endsWith(".json") || f.endsWith(".log"))
    .map((f) => fs.readFileSync(path.join(DATA, f), "utf8"))
    .join("\n");

// ---- people ----
const launch = { headless: true, args: ["--no-sandbox"] };
if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";
const LOCAL = /^(https?:\/\/(localhost|127\.0\.0\.1)[:/])|^(data|blob|ws|wss):/;
// Counts acknowledgements and times each one against the oldest delta still waiting for it.
function watchSockets() {
  window.__acks = 0;
  window.__sent = 0;
  window.__frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  window.__create = (input) => window.__dt.dispatch({ op: "ai", tool: "create_nodes", input });
  window.__lat = [];
  const sent = [];
  const Native = window.WebSocket;
  window.WebSocket = class extends Native {
    constructor(...a) {
      super(...a);
      this.addEventListener("message", (e) => {
        if (typeof e.data !== "string" || !e.data.startsWith('{"type":"ack"')) return;
        window.__acks++;
        const t = sent.shift();
        if (t !== undefined) window.__lat.push(performance.now() - t);
      });
      this.addEventListener("close", () => (sent.length = 0));
    }
    send(d) {
      if (typeof d === "string" && d.startsWith('{"type":"delta"')) {
        sent.push(performance.now());
        window.__sent++;
      }
      return super.send(d);
    }
  };
}
async function person(browser, name) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await ctx.route((u) => !LOCAL.test(u.toString()), (r) => r.abort());
  await ctx.addInitScript(watchSockets);
  await ctx.addInitScript((n) => {
    try {
      localStorage.setItem("dt:tour-done", "1");
      localStorage.setItem("dt:userName", n);
    } catch {
      /* no storage */
    }
  }, name);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  return { name, ctx, page, errors };
}
const status = (p) => p.page.evaluate(() => window.__dt.collab().status);
const live = (p) => waitUntil(async () => (await status(p)) === "live", 30000);
const nodeNames = (p) => p.page.evaluate(() => Object.values(window.__dt.doc().nodes).map((n) => n.name));
// One edit per animation frame, like a drag: the editor sends one change per frame.
const addRects = (p, prefix, n, y = 0, fill = "#6D4AFF") =>
  p.page.evaluate(
    async ([prefix, n, y, fill]) => {
      for (let i = 0; i < n; i++) {
        window.__create({ nodes: [{ type: "rectangle", name: `${prefix}-${i}`, x: i * 6, y, width: 5, height: 5, fill }] });
        await window.__frame();
      }
    },
    [prefix, n, y, fill],
  );
const counters = (p) => p.page.evaluate(() => ({ sent: window.__sent, acks: window.__acks }));
// Everything sent since `from` is acknowledged (and something was sent).
const allAcked = (p, from, min = 1) =>
  p.page.waitForFunction(([f, min]) => window.__sent - f.sent >= min && window.__acks - f.acks >= window.__sent - f.sent, [from, min], { polling: 2, timeout: 60000 });
async function setUp(browser, label) {
  const O = await person(browser, "Olga"), G = await person(browser, "Gina");
  await O.page.goto(BASE);
  await O.page.click("button:has-text('New design file')");
  await O.page.waitForSelector("#dt-canvas");
  await O.page.evaluate(() => window.__create({ nodes: [{ type: "frame", name: "Base", x: 0, y: 0, width: 400, height: 300, fill: "#FFFFFF" }] }));
  await O.page.click(".tbtn[title='Share for live editing']");
  await O.page.click("button:has-text('Share online')");
  await O.page.waitForFunction(() => window.__dt.collab().status === "live");
  const link = await O.page.evaluate(() => window.__dt.collab().link);
  await O.page.keyboard.press("Escape");
  await O.page.locator(".modal-bg").waitFor({ state: "detached" }).catch(() => {});
  await G.page.goto(link);
  check(`${label}: both people are live`, (await live(G)) && (await live(O)));
  await sleep(500);
  return { O, G };
}

// Edits, wait for every ack, SIGKILL `pause` ms later, restart; everything acknowledged must be
// on the relay's disk at the kill and on both screens afterwards.
async function killAfterAcks(O, G, tag, edits, pause) {
  const names = Array.from({ length: edits }, (_, i) => `${tag}-${i}`);
  const c0 = await counters(O);
  await addRects(O, tag, edits, 40, "#FF4A6D");
  await allAcked(O, c0, edits);
  if (pause) await sleep(pause);
  await killRelay();
  const text = diskText();
  const onDisk = names.filter((n) => text.includes(`"${n}"`)).length;
  check(`${tag}: all ${edits} acked edits were on disk at the kill (${pause} ms after the last ack)`, onDisk === edits, `${onDisk}/${edits}`);
  await startRelay();
  const ok = (await live(O)) && (await live(G));
  await sleep(1200);
  const [no, ng] = [await nodeNames(O), await nodeNames(G)];
  const have = (list) => names.filter((n) => list.includes(n)).length;
  check(`${tag}: both tabs live again with every edit`, ok && have(no) === edits && have(ng) === edits, `owner ${have(no)}/${edits}, Gina ${have(ng)}/${edits}`);
  check(`${tag}: both tabs hold the same layers`, JSON.stringify([...no].sort()) === JSON.stringify([...ng].sort()), `${no.length} / ${ng.length}`);
}

async function bursts(O, G, label) {
  // A drag's worth: 200 small edits as fast as the editor produces them.
  await O.page.evaluate(() => (window.__lat.length = 0));
  const c0 = await counters(O);
  const t0 = Date.now();
  await addRects(O, `${label}-drag`, 200, 80);
  await allAcked(O, c0, 200);
  const total = Date.now() - t0;
  const lat = await O.page.evaluate(() => window.__lat.slice());
  info(`${label} 200 rapid edits: all acked after ${total} ms; ack latency median ${median(lat).toFixed(0)} ms, p95 ${pct(lat, 0.95).toFixed(0)} ms, max ${Math.max(...lat).toFixed(0)} ms (${lat.length} samples)`);
  // 500-layer paste with 20 concurrent edits from Gina.
  await O.page.evaluate(() => (window.__lat.length = 0));
  await G.page.evaluate(() => (window.__lat.length = 0));
  const [oc, gc] = [await counters(O), await counters(G)];
  const t1 = Date.now();
  await O.page.evaluate((label) => {
    const nodes = Array.from({ length: 500 }, (_, i) => ({ type: "rectangle", name: `${label}-paste-${i}`, x: (i % 25) * 30, y: 200 + Math.floor(i / 25) * 30, width: 24, height: 24, fill: "#10B981" }));
    window.__create({ nodes });
  }, label);
  const ginaEdits = addRects(G, `${label}-gina`, 20, 400, "#F59E0B");
  await allAcked(O, oc, 1);
  const pasteAcked = Date.now() - t1;
  await ginaEdits;
  await allAcked(G, gc, 20);
  const ginaAcked = Date.now() - t1;
  const everywhere = await waitUntil(async () => {
    const [no, ng] = [await nodeNames(O), await nodeNames(G)];
    return no.filter((n) => n.startsWith(`${label}-paste-`)).length === 500 && ng.filter((n) => n.startsWith(`${label}-paste-`)).length === 500 && no.filter((n) => n.startsWith(`${label}-gina-`)).length === 20 && ng.filter((n) => n.startsWith(`${label}-gina-`)).length === 20;
  }, 60000, 50);
  const settled = Date.now() - t1;
  const [ol, gl] = [await O.page.evaluate(() => window.__lat.slice()), await G.page.evaluate(() => window.__lat.slice())];
  info(`${label} 500-layer paste + 20 concurrent edits: paste acked after ${pasteAcked} ms, Gina's 20 after ${ginaAcked} ms, identical on both tabs after ${settled} ms (ack latency owner ${ol.map((x) => x.toFixed(0)).join("/")} ms, Gina median ${median(gl).toFixed(0)} ms)`);
  check(`${label}: the paste and the concurrent edits reach both tabs`, everywhere);
  const h = await health();
  if (h.log) info(`${label} relay log syncs so far: ${h.log.syncs} syncs carrying ${h.log.changes} changes, average ${h.log.avgSyncMicros} us, max ${h.log.maxSyncMicros} us`);
  return { total, lat, pasteAcked, settled, log: h.log };
}

if (!fs.existsSync(BIN)) {
  console.error(`relay binary not found: ${BIN} (cargo build -p designotron-relay)`);
  process.exit(2);
}
DATA = fs.mkdtempSync(path.join(os.tmpdir(), "r11a-rooms-"));
await startRelay();
const browser = await chromium.launch(launch);
const results = {};
try {
  const { O, G } = await setUp(browser, "durable");
  await O.page.screenshot({ path: `${OUT}/owner-live.png` });
  // The window N measured: 0 ms and 300 ms after the ack lost everything.
  await killAfterAcks(O, G, "K0a", 5, 0);
  await killAfterAcks(O, G, "K0b", 5, 0);
  await killAfterAcks(O, G, "K0c", 3, 0);
  await killAfterAcks(O, G, "K300", 5, 300);
  await killAfterAcks(O, G, "K0d", 5, 0);
  await killAfterAcks(O, G, "K0e", 1, 0);
  // A drag-sized burst, then a hard kill right after its last ack: all 200 survive.
  results.durable = await bursts(O, G, "durable");
  await killRelay();
  const text = diskText();
  const onDisk = Array.from({ length: 200 }, (_, i) => `durable-drag-${i}`).filter((n) => text.includes(`"${n}"`)).length;
  check("200 rapid edits and the paste were all on disk at the kill", onDisk === 200 && text.includes('"durable-paste-499"') && text.includes('"durable-gina-19"'), `${onDisk}/200 drag edits`);
  await startRelay();
  check("both tabs reconnect after the last kill", (await live(O)) && (await live(G)));
  await sleep(1500);
  const [no, ng] = [await nodeNames(O), await nodeNames(G)];
  const count = (l, p) => l.filter((n) => n.startsWith(p)).length;
  check("after the kill: 200 drag edits, 500 pasted layers and Gina's 20 on both tabs", [no, ng].every((l) => count(l, "durable-drag-") === 200 && count(l, "durable-paste-") === 500 && count(l, "durable-gina-") === 20), `${count(no, "durable-drag-")}/${count(no, "durable-paste-")}/${count(no, "durable-gina-")} and ${count(ng, "durable-drag-")}/${count(ng, "durable-paste-")}/${count(ng, "durable-gina-")}`);
  check("the editors saw no page errors", O.errors.length + G.errors.length === 0, [...O.errors, ...G.errors].join(" | ").slice(0, 300));
  await O.ctx.close();
  await G.ctx.close();

  // Old room files still load: a snapshot without `seq` and no log.
  await stopRelay();
  const room = fs.readdirSync(DATA).find((f) => f.endsWith(".json"));
  const snap = JSON.parse(fs.readFileSync(path.join(DATA, room), "utf8"));
  check("a stopped relay left a snapshot with seq and an emptied log", typeof snap.seq === "number" && snap.seq > 0 && (!fs.existsSync(path.join(DATA, room.replace(".json", ".log"))) || fs.statSync(path.join(DATA, room.replace(".json", ".log"))).size === 0), `seq ${snap.seq}`);
  delete snap.seq;
  fs.writeFileSync(path.join(DATA, room), JSON.stringify(snap));
  await startRelay();
  const old = await person(browser, "Old");
  await old.page.goto(`${BASE}/?room=${room.replace(".json", "")}`);
  const ok = await live(old);
  await sleep(800);
  const names = ok ? await nodeNames(old) : [];
  check("an old room file (no seq) loads and shows its layers", ok && names.length > 700, `${names.length} layers`);
  await old.page.screenshot({ path: `${OUT}/old-file.png` });
  await old.ctx.close();

  // The same bursts against the relay from before the change, for the cost comparison.
  if (COMPARE) {
    await stopRelay();
    DATA = fs.mkdtempSync(path.join(os.tmpdir(), "r11a-old-"));
    await startRelay(COMPARE);
    const { O: O2, G: G2 } = await setUp(browser, "before");
    results.before = await bursts(O2, G2, "before");
    await O2.ctx.close();
    await G2.ctx.close();
  }
} catch (e) {
  check("script ran to the end", false, String(e?.stack ?? e).slice(0, 600));
} finally {
  await browser.close().catch(() => {});
  await stopRelay();
  fs.rmSync(DATA, { recursive: true, force: true });
}
if (results.durable && results.before) {
  const d = results.durable, b = results.before;
  info(`comparison (durable / before): 200 rapid edits ${d.total} / ${b.total} ms, median ack ${median(d.lat).toFixed(0)} / ${median(b.lat).toFixed(0)} ms, p95 ${pct(d.lat, 0.95).toFixed(0)} / ${pct(b.lat, 0.95).toFixed(0)} ms; paste acked ${d.pasteAcked} / ${b.pasteAcked} ms, everything identical ${d.settled} / ${b.settled} ms`);
}
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
