// Wave 4, stage B, w4b-c: per-character text merge through rooms, the relay, the editor and carets.
// Three people (Ana the owner, Ben, Cai) type in one text layer in a live room.
//   1  concurrent typing at the start (Ben) and the end (Ana): "BBB Hello world AAA" everywhere
//   2  the same spot at once: both runs stay whole
//   3  Ana deletes "world" while Ben types inside it: Ben's characters survive
//   4  Ben bolds "Hello" (Ctrl+B) while Ana types inside it: identical runs everywhere
//   5  undo is per person: Ctrl+Z in the editor removes only Ana's last word, after Escape only her session
//   6  Ben's caret stays after his word while Ana types before it
//   7  Ana's page draws Ben's caret and selection inside the text
//   8  Cai types offline while the others type; back online everything converges
//   9  Claude (update_nodes) replaces the text while Ben types at the end: Ben's characters survive
//   10 a relay without the capability: whole texts, no `text` key on the wire, no error toast
//   11 an older editor in a new relay's room: sees the typing, its own edit reaches everyone
//   12 the same concurrent typing through the bridge (LAN room)
//   13 size: after heavy editing the room's sequence for the layer is under 16 KB
//   14 typing latency in a shared text against the editor of main (E2E_MAIN_DIST)
// Servers (all local, started and stopped here):
//   new relay        E2E_PORT        default 7422   (--static web/dist; the editors run from it)   E2E_RELAY_BIN
//   old relay        E2E_OLD_PORT    default 7423   (an older relay build serving an older web/dist)  E2E_OLD_RELAY_BIN, E2E_OLD_DIST
//   main's editor    E2E_MAIN_PORT   default 7427   (the new relay serving E2E_MAIN_DIST, step 14)
//   bridge           E2E_BRIDGE_PORT default 7425   (its LAN listener is port + 1)                  E2E_BRIDGE_BIN
// Every document comparison is canonical JSON (sorted keys). Messages from the room are held in the
// page (`__hold`) so that "at the same time" really is: each person types before hearing the others.
// Usage: cd web && npm run build && node scripts/qa/w4bc-e2e.mjs      Screenshots: E2E_OUT.

import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const NEW_PORT = Number(process.env.E2E_PORT ?? 7422);
const OLD_PORT = Number(process.env.E2E_OLD_PORT ?? 7423);
const MAIN_PORT = Number(process.env.E2E_MAIN_PORT ?? 7427);
const BRIDGE_PORT = Number(process.env.E2E_BRIDGE_PORT ?? 7425);
const NEW = `http://127.0.0.1:${NEW_PORT}`;
const OLD = `http://127.0.0.1:${OLD_PORT}`;
const MAIN = `http://127.0.0.1:${MAIN_PORT}`;
const BRIDGE = `http://127.0.0.1:${BRIDGE_PORT}`;
const BIN = process.env.E2E_RELAY_BIN ?? path.resolve("../target/debug/designotron-relay");
const OLD_BIN = process.env.E2E_OLD_RELAY_BIN ?? "";
const OLD_DIST = process.env.E2E_OLD_DIST ?? "";
const MAIN_DIST = process.env.E2E_MAIN_DIST ?? "";
const BRIDGE_BIN = process.env.E2E_BRIDGE_BIN ?? "";
const OUT = process.env.E2E_OUT ?? "/tmp/w4bc-shots";
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + String(detail).slice(0, 600) : ""}`);
};
const skip = (name, why) => console.log(`SKIP  ${name}  - ${why}`);
const note = (msg) => console.log(`##    ${msg}`);

async function waitUntil(fn, timeout = 15000, step = 100) {
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

if (!fs.existsSync(BIN)) {
  console.error(`relay binary not found: ${BIN} (cargo build -p designotron-relay)`);
  process.exit(2);
}

// ---------- servers ----------
const children = [];
const tmp = [];
function serve(bin, port, staticDir, extra = []) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "w4bc-rooms-"));
  tmp.push(data);
  const child = spawn(bin, ["--port", String(port), "--static", staticDir, "--data", data, ...extra], { stdio: "ignore" });
  children.push(child);
  return child;
}
const up = (base, p = "/health") => waitUntil(() => fetch(base + p).then((r) => r.ok, () => false), 10000, 100);

serve(BIN, NEW_PORT, "dist");
const haveOld = !!OLD_BIN && fs.existsSync(OLD_BIN) && !!OLD_DIST && fs.existsSync(path.join(OLD_DIST, "index.html"));
if (haveOld) serve(OLD_BIN, OLD_PORT, OLD_DIST);
const haveMain = !!MAIN_DIST && fs.existsSync(path.join(MAIN_DIST, "index.html"));
if (haveMain) serve(BIN, MAIN_PORT, MAIN_DIST);
let bridgeWs = "";
if (BRIDGE_BIN && fs.existsSync(BRIDGE_BIN)) {
  bridgeWs = fs.mkdtempSync(path.join(os.tmpdir(), "w4bc-ws-"));
  tmp.push(bridgeWs);
  const child = spawn(BRIDGE_BIN, ["--port", String(BRIDGE_PORT), "--static", "dist", "--workspace", bridgeWs, "--no-open"], {
    stdio: "ignore",
    env: { ...process.env, CLAUDE_BIN: path.resolve("scripts/fixtures/fake-claude.mjs") },
  });
  children.push(child);
}
await up(NEW);
if (haveOld) await up(OLD);
if (haveMain) await up(MAIN);

// ---------- people ----------
const launch = { headless: true, args: ["--no-sandbox"] };
if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";
const LOCAL = /^(https?:\/\/(localhost|127\.0\.0\.1)[:/])|^(data|blob|ws|wss|about):/;
const browser = await chromium.launch(launch);
const everyone = [];

// Runs before the page: records what is sent, can hold what the room says, and notes error toasts.
const INIT = () => {
  window.__sent = [];
  window.__hold = false;
  window.__queue = [];
  window.__toasts = [];
  window.__socks = new Set();
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (d) {
    window.__socks.add(this);
    try {
      if (typeof d === "string" && !d.includes('"presence"') && !d.includes('"ping"')) {
        window.__sent.push(d);
        if (window.__sent.length > 400) window.__sent.shift();
      }
    } catch {
      /* ignore */
    }
    return send.call(this, d);
  };
  const desc = Object.getOwnPropertyDescriptor(WebSocket.prototype, "onmessage");
  Object.defineProperty(WebSocket.prototype, "onmessage", {
    configurable: true,
    get() {
      return desc.get.call(this);
    },
    set(fn) {
      desc.set.call(
        this,
        fn &&
          function (ev) {
            if (window.__hold) window.__queue.push([fn, ev, this]);
            else fn.call(this, ev);
          },
      );
    },
  });
  window.__release = () => {
    window.__hold = false;
    while (window.__queue.length) {
      const [fn, ev, s] = window.__queue.shift();
      fn.call(s, ev);
    }
  };
  try {
    new MutationObserver(() => {
      const t = document.querySelector(".toast.error");
      if (t && !window.__toasts.includes(t.textContent)) window.__toasts.push(t.textContent);
    }).observe(document, { childList: true, subtree: true, characterData: true });
  } catch {
    /* ignore */
  }
};

async function person(name, { initScript = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await ctx.route((u) => !LOCAL.test(u.toString()), (r) => r.abort());
  await ctx.addInitScript((n) => {
    try {
      localStorage.setItem("dt:tour-done", "1");
      localStorage.setItem("dt:userName", n);
    } catch {
      /* no storage */
    }
  }, name);
  if (initScript) await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  const p = { name, ctx, page, errors: [] };
  page.on("pageerror", (e) => p.errors.push("pageerror: " + String(e)));
  page.on("console", (m) => {
    if (m.type() === "error" && !/bridge\/ws|Failed to load resource|ERR_INTERNET_DISCONNECTED|WebSocket connection|ERR_NETWORK/.test(m.text())) p.errors.push("console: " + m.text().slice(0, 300));
  });
  everyone.push(p);
  return p;
}

const CANON = `(function canon(v){ if (Array.isArray(v)) return v.map(canon); if (v && typeof v === "object") { const o = {}; for (const k of Object.keys(v).sort()) o[k] = canon(v[k]); return o; } return v; })`;
const canon = (p) => p.page.evaluate((src) => JSON.stringify(eval(src)(window.__dt.doc())), CANON);
const docOf = (p) => p.page.evaluate(() => window.__dt.doc());
const dispatch = (p, cmd) => p.page.evaluate((c) => window.__dt.dispatch(c), cmd);
const tool = async (p, name, input) => {
  const r = await p.page.evaluate(([n, i]) => window.__dt.dispatch({ op: "ai", tool: n, input: i }), [name, input]);
  return r && r.result !== undefined ? r.result : r;
};
const textOf = (p, id) => p.page.evaluate((i) => window.__dt.doc().nodes[i]?.text?.characters, id);
const nodeJson = (p, id) =>
  p.page.evaluate(([src, i]) => JSON.stringify(eval(src)(window.__dt.doc().nodes[i]?.text ?? null)), [CANON, id]);

async function converge(peers, timeout = 20000) {
  const t0 = Date.now();
  let last = [];
  while (Date.now() - t0 < timeout) {
    last = await Promise.all(peers.map(canon));
    if (last.every((d) => d === last[0])) return { same: true, ms: Date.now() - t0 };
    await sleep(150);
  }
  const at = (a, b) => {
    let k = 0;
    while (k < a.length && a[k] === b[k]) k++;
    return k;
  };
  const i = at(last[0], last[last.length - 1]);
  return { same: false, ms: Date.now() - t0, at: i, left: last[0].slice(Math.max(0, i - 120), i + 120), right: last[last.length - 1].slice(Math.max(0, i - 120), i + 120) };
}
// The layer's text (characters, runs, ids) is the same everywhere; geometry of auto-size text is
// compared between editors, never with the room.
async function sameText(peers, id, name, timeout = 20000) {
  const ok = await waitUntil(async () => {
    const all = await Promise.all(peers.map((p) => nodeJson(p, id)));
    return all.every((t) => t === all[0]);
  }, timeout, 150);
  const c = await converge(peers, 5000);
  check(`${name}: every editor holds the same document`, ok && c.same, ok && c.same ? "" : JSON.stringify(c));
  return ok && c.same;
}
const holdAll = (peers) => Promise.all(peers.map((p) => p.page.evaluate(() => (window.__hold = true))));
const releaseAll = async (peers, settle = 500) => {
  // Everyone has sent what they typed (flushes run on the next frame) before anyone hears anything.
  await sleep(settle);
  await Promise.all(peers.map((p) => p.page.evaluate(() => window.__release())));
};

// ---------- the editor, as a person uses it ----------
const openEditor = async (p, id) => {
  await p.page.evaluate((i) => {
    window.__dt.dispatch({ op: "select", ids: [i] });
    window.__dt.edit(i);
  }, id);
  await p.page.waitForSelector(".text-editor");
  await p.page.evaluate(() => document.querySelector(".text-editor").focus());
};
const setSel = (p, a, b = a) =>
  p.page.evaluate(([x, y]) => {
    const ta = document.querySelector(".text-editor");
    ta.focus();
    ta.setSelectionRange(x, y);
  }, [a, b]);
const type = (p, s) => p.page.keyboard.type(s);
const closeEditor = async (p) => {
  await p.page.keyboard.press("Escape");
  await p.page.waitForFunction(() => !document.querySelector(".text-editor"), null, { timeout: 5000 });
};
const taState = (p) => p.page.evaluate(() => {
  const ta = document.querySelector(".text-editor");
  return ta ? { value: ta.value, s: ta.selectionStart, e: ta.selectionEnd } : null;
});

// ---------- a room ----------
// `owner` shares a file with the text layers made by `newText`; the others join.
async function openRoom({ ownerBase, relay, joinBase = ownerBase, names = ["Ana", "Ben", "Cai"], lan = false, initScripts = [true, true, true] }) {
  const ana = await person(names[0], { initScript: initScripts[0] });
  await ana.page.goto(ownerBase);
  await ana.page.click("button:has-text('New design file')");
  await ana.page.waitForSelector("#dt-canvas");
  const seed = await tool(ana, "create_nodes", { nodes: [{ type: "text", name: "Seed", x: 20, y: 20, width: 400, text: "Seed", fontSize: 24 }] });
  const seedId = seed.created[0].id;
  await ana.page.click(".tbtn[title='Share for live editing']");
  await ana.page.fill(".share-dialog input.textinput >> nth=0", names[0]);
  if (lan) {
    await ana.page.click("button:has-text('Share on this network')");
  } else {
    await ana.page.waitForSelector(".share-dialog input.mono, .share-dialog :text('Use a different relay')", { timeout: 15000 });
    if (!(await ana.page.locator(".share-dialog input.mono").count())) await ana.page.click(".share-dialog :text('Use a different relay')");
    await ana.page.fill(".share-dialog input.mono", relay);
    await ana.page.click("button:has-text('Share online')");
  }
  await ana.page.waitForFunction(() => window.__dt.collab().status === "live", null, { timeout: 20000 });
  let link = await ana.page.evaluate(() => window.__dt.collab().link);
  // A share on the local network names this computer's address: reach it through localhost.
  const u = new URL(link);
  if (!/^(127\.0\.0\.1|localhost)$/.test(u.hostname)) {
    u.hostname = "127.0.0.1";
    link = u.toString();
  }
  await ana.page.keyboard.press("Escape");
  await ana.page.click(".modal-head .ibtn[title='Close']").catch(() => {});
  const others = [];
  for (const [i, n] of names.slice(1).entries()) {
    const p = await person(n, { initScript: initScripts[i + 1] });
    let url = link;
    if (!lan) {
      // The editor each person runs and the relay holding the room can differ.
      const room = new URL(link).searchParams.get("room");
      url = `${joinBase}/?room=${room}${new URL(joinBase).origin === new URL(relay).origin ? "" : `&relay=${encodeURIComponent(relay)}`}`;
    }
    await p.page.goto(url);
    await p.page.waitForSelector("#dt-canvas");
    await p.page.waitForFunction((id) => window.__dt.collab().status === "live" && !!window.__dt.doc().nodes[id], seedId, { timeout: 25000 });
    others.push(p);
  }
  const peers = [ana, ...others];
  const c = await converge(peers);
  return { ana, ben: others[0], cai: others[1], peers, seedId, link, converged: c.same };
}

let counter = 0;
// A new text layer made by Ana and seen by everyone.
async function newText(R, characters = "Hello world") {
  const r = await tool(R.ana, "create_nodes", { nodes: [{ type: "text", name: `T${++counter}`, x: 20, y: 80 + counter * 60, width: 420, text: characters, fontSize: 24 }] });
  const id = r.created[0].id;
  await waitUntil(async () => (await Promise.all(R.peers.map((p) => textOf(p, id)))).every((t) => t === characters), 15000, 100);
  await converge(R.peers);
  return id;
}

const failIf = (cond, label, detail) => check(label, cond, detail);
const WORLD = (peers, id) => Promise.all(peers.map((p) => textOf(p, id)));

// ---------- the cases ----------
async function newRoomCases() {
  const R = await openRoom({ ownerBase: NEW, relay: NEW });
  const { ana, ben, cai, peers } = R;
  check("three people are in the room and share one document", R.converged);
  const welcomeText = await ana.page.evaluate(() => window.__dt.engine().collabText());
  check("the room merges text per character (the welcome said `text`)", welcomeText === true && (await ben.page.evaluate(() => window.__dt.engine().collabText())) && (await cai.page.evaluate(() => window.__dt.engine().collabText())));
  const joinFrames = await ben.page.evaluate(() => window.__sent.filter((f) => f.includes('"type":"join"')));
  check("the join says `text: true`", joinFrames.length > 0 && JSON.parse(joinFrames[0]).text === true, joinFrames[0]?.slice(0, 200));

  // 1: the start and the end at once.
  {
    const id = await newText(R);
    await openEditor(ana, id);
    await openEditor(ben, id);
    await setSel(ana, 11);
    await setSel(ben, 0);
    await holdAll(peers);
    await type(ana, " AAA");
    await type(ben, "BBB ");
    await releaseAll(peers);
    await sameText(peers, id, "1 start and end at once");
    const t = await WORLD(peers, id);
    check("1: BBB Hello world AAA on all three", t.every((x) => x === "BBB Hello world AAA"), JSON.stringify(t));
    const seqs = await Promise.all(peers.map((p) => p.page.evaluate((i) => !!window.__dt.doc().nodes[i].text.seq, id)));
    check("1: the text carries character ids (seq) on every editor", seqs.every(Boolean));
    await closeEditor(ana);
    await closeEditor(ben);
  }

  // 2: the same spot at once.
  {
    const id = await newText(R);
    await openEditor(ana, id);
    await openEditor(ben, id);
    await setSel(ana, 5);
    await setSel(ben, 5);
    await holdAll(peers);
    await type(ana, "AAA");
    await type(ben, "BBB");
    await releaseAll(peers);
    await sameText(peers, id, "2 same spot at once");
    const t = await WORLD(peers, id);
    check("2: both runs whole (HelloAAABBB world or HelloBBBAAA world), the same everywhere", /^Hello(AAABBB|BBBAAA) world$/.test(t[0]) && t.every((x) => x === t[0]), JSON.stringify(t));
    await closeEditor(ana);
    await closeEditor(ben);
  }

  // 3: a deleted word with typing inside it.
  {
    const id = await newText(R);
    await openEditor(ana, id);
    await openEditor(ben, id);
    await setSel(ana, 6, 11);
    await setSel(ben, 8);
    await holdAll(peers);
    await ana.page.keyboard.press("Backspace");
    await type(ben, "XY");
    await releaseAll(peers);
    await sameText(peers, id, "3 delete a word while typing inside it");
    const t = await WORLD(peers, id);
    check("3: Ben's XY survives the deletion of world", t.every((x) => x === "Hello XY"), JSON.stringify(t));
    await closeEditor(ana);
    await closeEditor(ben);
  }

  // 4: a style over text someone types in.
  {
    const id = await newText(R);
    await openEditor(ana, id);
    await openEditor(ben, id);
    await setSel(ana, 2);
    await setSel(ben, 0, 5);
    await holdAll(peers);
    await type(ana, "Z");
    await ben.page.keyboard.press("Control+b");
    await releaseAll(peers);
    await sameText(peers, id, "4 bold while typing inside");
    const t = await WORLD(peers, id);
    const runs = await Promise.all(peers.map((p) => p.page.evaluate((i) => JSON.stringify(window.__dt.doc().nodes[i].text.runs), id)));
    check("4: HeZllo world everywhere", t.every((x) => x === "HeZllo world"), JSON.stringify(t));
    check("4: identical runs everywhere, bold over Hello", runs.every((r) => r === runs[0]) && JSON.parse(runs[0]).some((r) => r.fontWeight === 700 && r.start === 0 && r.end >= 5), runs[0]);
    await closeEditor(ana);
    await closeEditor(ben);
  }

  // 5: undo is per person.
  {
    const id = await newText(R);
    await openEditor(ana, id);
    await openEditor(ben, id);
    await setSel(ana, 11);
    await type(ana, " foo bar");
    await waitUntil(async () => (await textOf(ben, id)) === "Hello world foo bar", 8000);
    await setSel(ben, 0);
    await type(ben, "BBB ");
    await waitUntil(async () => (await textOf(ana, id)) === "BBB Hello world foo bar", 8000);
    await ana.page.evaluate(() => document.querySelector(".text-editor").focus());
    await ana.page.keyboard.press("Control+z");
    await sleep(300);
    await sameText(peers, id, "5a undo in the editor");
    let t = await WORLD(peers, id);
    check("5a: Ctrl+Z removes only Ana's last word (BBB stays)", t.every((x) => x === "BBB Hello world foo "), JSON.stringify(t));
    await ana.page.keyboard.press("Control+Shift+z");
    await sleep(300);
    await sameText(peers, id, "5b redo in the editor");
    t = await WORLD(peers, id);
    check("5b: Ctrl+Shift+Z brings bar back", t.every((x) => x === "BBB Hello world foo bar"), JSON.stringify(t));
    await closeEditor(ana);
    await closeEditor(ben);
    // After editing the engine's undo takes Ana's whole session.
    await ana.page.evaluate(() => document.getElementById("dt-canvas")?.focus());
    await ana.page.keyboard.press("Control+z");
    await sleep(300);
    await sameText(peers, id, "5c undo after editing");
    t = await WORLD(peers, id);
    check("5c: Ctrl+Z after Escape removes Ana's session only", t.every((x) => x === "BBB Hello world"), JSON.stringify(t));
  }

  // 5d: Ben types inside Ana's open run; her undo leaves his characters.
  {
    const id = await newText(R);
    await openEditor(ana, id);
    await openEditor(ben, id);
    await setSel(ana, 5);
    await type(ana, "f");
    await waitUntil(async () => (await textOf(ben, id)) === "Hellof world", 8000);
    await setSel(ben, 6);
    await type(ben, "X");
    await waitUntil(async () => (await textOf(ana, id)) === "HellofX world", 8000);
    await ana.page.evaluate(() => document.querySelector(".text-editor").focus());
    await type(ana, "oo");
    await sameText(peers, id, "5d typing around a collaborator");
    await ana.page.keyboard.press("Control+z");
    await sleep(300);
    await sameText(peers, id, "5d undo");
    const t = await WORLD(peers, id);
    check("5d: Ana's undo removes her last typing, Ben's X stays", t.every((x) => x === "HellofX world"), JSON.stringify(t));
    await closeEditor(ana);
    await closeEditor(ben);
  }

  // 5e: redo never brings back what a collaborator deleted.
  {
    const id = await newText(R);
    await openEditor(ana, id);
    await openEditor(ben, id);
    await setSel(ana, 11);
    await type(ana, "foo");
    await waitUntil(async () => (await textOf(ben, id)) === "Hello worldfoo", 8000);
    await setSel(ben, 0);
    await type(ben, "X");
    await waitUntil(async () => (await textOf(ana, id)) === "XHello worldfoo", 8000);
    await ana.page.evaluate(() => document.querySelector(".text-editor").focus());
    await ana.page.keyboard.press("Control+z");
    await waitUntil(async () => (await textOf(ben, id)) === "XHello world", 8000);
    await setSel(ben, 1);
    await ben.page.keyboard.press("Backspace");
    await waitUntil(async () => (await textOf(ana, id)) === "Hello world", 8000);
    await ana.page.evaluate(() => document.querySelector(".text-editor").focus());
    await ana.page.keyboard.press("Control+Shift+z");
    await sleep(300);
    await sameText(peers, id, "5e redo");
    const t = await WORLD(peers, id);
    check("5e: Ana's redo brings back her foo, not Ben's deleted X", t.every((x) => x === "Hello worldfoo"), JSON.stringify(t));
    await closeEditor(ana);
    await closeEditor(ben);
  }

  // 6 and 7: caret stability and the remote caret.
  {
    const id = await newText(R);
    await openEditor(ben, id);
    await openEditor(ana, id);
    await setSel(ben, 5);
    await type(ben, "!!");
    await waitUntil(async () => (await textOf(ana, id)) === "Hello!! world", 8000);
    await setSel(ana, 0);
    await type(ana, "AAAA ");
    await waitUntil(async () => (await textOf(ben, id)) === "AAAA Hello!! world", 8000);
    const st = await taState(ben);
    check("6: Ben's caret stays after his word while Ana types before it", st && st.s === 12 && st.e === 12, JSON.stringify(st));
    await type(ben, "?");
    await sameText(peers, id, "6 typing on");
    const t = await WORLD(peers, id);
    check("6: his next key lands after his word (AAAA Hello!!? world)", t.every((x) => x === "AAAA Hello!!? world"), JSON.stringify(t));
    // 7: Ben selects "Hello" (5..10): Cai (who is not editing) sees it drawn inside the text.
    await setSel(ben, 5, 10);
    const benId = await ben.page.evaluate(() => window.__dt.collab().me);
    const barSel = `[data-text-caret][data-peer="${benId}"]`;
    const sel = await cai.page.waitForSelector(barSel, { timeout: 8000 }).catch(() => null);
    check("7: Cai's page draws Ben's caret", !!sel);
    await sleep(400);
    const drawn = await cai.page.evaluate(([i, barSel, benId]) => {
      const bar = document.querySelector(barSel);
      const b = bar?.getBoundingClientRect();
      const g = window.__dt.query({ q: "textLayout", id: i });
      const m = window.__dt.query({ q: "bounds", ids: [i] }).items[0].matrix;
      const v = window.__dt.viewport();
      const root = document.getElementById("dt-canvas").getBoundingClientRect();
      const index = Number(bar?.getAttribute("data-index"));
      const line = g.lines.find((l) => index >= l.start && index <= l.end);
      const x = line.xs[index - line.start];
      const y = line.top;
      const sx = (m.a * x + m.c * y + m.e) * v.zoom + v.x + root.left;
      const sy = (m.b * x + m.d * y + m.f) * v.zoom + v.y + root.top;
      return { index, got: b && { x: b.x + b.width / 2, y: b.y, w: b.width }, want: { x: sx, y: sy }, sels: document.querySelectorAll(`.remote-text-sel[data-peer="${benId}"]`).length, flag: document.querySelector(`.remote-text-flag[data-peer="${benId}"] text`)?.textContent };
    }, [id, barSel, benId]);
    check("7: the caret is where index 10 is drawn (within 2 px)", drawn.index === 10 && drawn.got && Math.abs(drawn.got.x - drawn.want.x) <= 2 && Math.abs(drawn.got.y - drawn.want.y) <= 2, JSON.stringify(drawn));
    check("7: the caret is 2 px wide, the selection is drawn and the flag names Ben", drawn.got && Math.abs(drawn.got.w - 2) < 0.2 && drawn.sels >= 1 && drawn.flag === "Ben", JSON.stringify(drawn));
    await cai.page.evaluate((i) => window.__dt.dispatch({ op: "select", ids: [i] }), id);
    await cai.page.screenshot({ path: path.join(OUT, "07-remote-caret.png") });
    await closeEditor(ben);
    const gone = await waitUntil(async () => !(await cai.page.locator(barSel).count()), 5000);
    check("7: the remote caret goes when Ben stops editing", gone);
    await closeEditor(ana);
  }

  // 8: Cai types offline.
  {
    const id = await newText(R, "Hello world and more words here");
    await openEditor(cai, id);
    await setSel(cai, 11);
    await cai.ctx.setOffline(true);
    // (An open socket survives the browser going offline: drop it, as a dead network would.)
    await cai.page.evaluate(() => window.__socks.forEach((s) => s.close()));
    const wentOffline = await waitUntil(() => cai.page.evaluate(() => window.__dt.collab().status !== "live"), 15000);
    check("8: Cai is cut off from the room", wentOffline);
    await type(cai, " OFFLINE");
    await openEditor(ana, id);
    await setSel(ana, 0);
    await type(ana, "AAA ");
    await openEditor(ben, id);
    await setSel(ben, 999);
    await type(ben, " BBB");
    await sleep(500);
    check("8: the others don't have Cai's offline text yet", !(await textOf(ana, id)).includes("OFFLINE") && !(await textOf(ben, id)).includes("OFFLINE"));
    await cai.page.screenshot({ path: path.join(OUT, "08-offline-cai.png") });
    const before = await textOf(cai, id);
    await cai.ctx.setOffline(false);
    const t0 = Date.now();
    const ok = await sameText(peers, id, "8 offline typing", 20000);
    const t = await WORLD(peers, id);
    note(`8: converged in ${Date.now() - t0} ms; Cai offline text was "${before}"`);
    check("8: everyone's text is there after Cai is back (AAA, OFFLINE, BBB, the original)", ok && t.every((x) => x === t[0]) && ["AAA ", " OFFLINE", " BBB", "Hello world"].every((s) => t[0].includes(s)), JSON.stringify(t));
    check("8: Cai's editor is live again", await cai.page.evaluate(() => window.__dt.collab().status === "live"));
    await ana.page.screenshot({ path: path.join(OUT, "08-offline-ana.png") });
    for (const p of [ana, ben, cai]) await closeEditor(p).catch(() => {});
  }

  // 9: Claude replaces the text while Ben types.
  {
    const id = await newText(R, "Hello world");
    await openEditor(ben, id);
    await setSel(ben, 11);
    await holdAll(peers);
    await type(ben, " BBB");
    await tool(ana, "update_nodes", { updates: [{ id, text: "Hello there" }] });
    await releaseAll(peers);
    await sameText(peers, id, "9 Claude's replace while typing");
    const t = await WORLD(peers, id);
    check("9: Ben's characters survive, the changed word is replaced", t.every((x) => x === t[0]) && t[0].includes(" BBB") && t[0].startsWith("Hello ") && t[0].includes("there") && !t[0].includes("world"), JSON.stringify(t));
    await closeEditor(ben);
  }

  // 13: size after heavy editing.
  {
    const id = await newText(R, "The quick brown fox jumps over the lazy dog. ".repeat(6));
    const rnd = (() => {
      let s = 12345;
      return (n) => ((s = (s * 1103515245 + 12345) & 0x7fffffff), s % n);
    })();
    // Typing bursts (a few words at one place), now and then a stretch deleted, from three people.
    let ops = 0;
    const burst = (p, seed) =>
      p.page.evaluate(
        ([i, sd]) => {
          let s = sd;
          const rnd = (m) => ((s = (s * 1103515245 + 12345) & 0x7fffffff), s % m);
          const len = Array.from(window.__dt.doc().nodes[i].text.characters).length;
          const at = rnd(len + 1);
          const word = ["lorem ", "ipsum ", "dolor ", "sit amet ", "consectetur "][rnd(5)];
          for (const [k, ch] of Array.from(word.slice(0, 4 + rnd(6))).entries()) {
            window.__dt.dispatch({ op: "editText", id: i, start: at + k, end: at + k, text: ch });
          }
          if (rnd(3) === 0) {
            const l2 = Array.from(window.__dt.doc().nodes[i].text.characters).length;
            const from = rnd(Math.max(1, l2 - 8));
            window.__dt.dispatch({ op: "editText", id: i, start: from, end: Math.min(l2, from + 2 + rnd(6)), text: "" });
          }
        },
        [id, seed],
      );
    for (let round = 0; round < 30; round++) {
      for (const [k, p] of [ana, ben, cai].entries()) {
        await burst(p, 1000 + round * 7 + k);
        ops++;
      }
      await sleep(80);
    }
    const ok = await sameText(peers, id, `13 ${ops} typing bursts`, 30000);
    const size = await ana.page.evaluate((i) => JSON.stringify(window.__dt.doc().nodes[i].text.seq ?? null).length, id);
    const spans = await ana.page.evaluate((i) => (window.__dt.doc().nodes[i].text.seq?.s ?? []).length, id);
    check(`13: the layer's seq is ${size} bytes (${spans} spans), under 16 KB`, ok && size > 2 && size < 16 * 1024);
  }

  // 14: typing latency here (the comparison with main runs in `latency`).
  const lat = await latency(R, "this build");
  const errs = everyone.flatMap((p) => p.errors.map((e) => `${p.name}: ${e}`));
  check("no page errors in the new room", errs.length === 0, errs.slice(0, 3).join(" | "));
  const toasts = (await Promise.all(peers.map((p) => p.page.evaluate(() => window.__toasts)))).flat();
  check("no error toast in the new room", toasts.length === 0, toasts.join(" | "));
  await closeRoom(R);
  return lat;
}

// Per key: keydown to the next painted frame after the textarea's input event, in a room with three
// people, typing 120 characters into a long shared text.
async function latency(R, label) {
  const { ana, ben, cai, peers } = R;
  const id = await newText(R, "Latency test text. ".repeat(40));
  await openEditor(ana, id);
  await setSel(ana, 200);
  await ana.page.evaluate(() => {
    window.__lat = [];
    let t0 = 0;
    const ta = document.querySelector(".text-editor");
    ta.addEventListener("keydown", () => (t0 = performance.now()), true);
    ta.addEventListener("input", () => requestAnimationFrame(() => requestAnimationFrame(() => window.__lat.push(performance.now() - t0))), true);
  });
  const runs = [];
  for (let r = 0; r < 3; r++) {
    await ana.page.evaluate(() => (window.__lat = []));
    // Ben types too, so every key of Ana's meets a remote delta now and then.
    const bt = (async () => {
      await openEditor(ben, id);
      await setSel(ben, 0);
      for (let k = 0; k < 30; k++) {
        await type(ben, "b");
        await sleep(40);
      }
    })();
    await ana.page.keyboard.type("the quick brown fox jumps over the lazy dog ".repeat(3).slice(0, 120), { delay: 5 });
    await bt;
    await sleep(300);
    const xs = (await ana.page.evaluate(() => window.__lat)).sort((a, b) => a - b);
    runs.push({ n: xs.length, median: xs[Math.floor(xs.length / 2)], p95: xs[Math.floor(xs.length * 0.95)] });
    await closeEditor(ben);
  }
  const med = runs.map((r) => r.median).sort((a, b) => a - b)[1];
  note(`14: typing latency (${label}), keydown to painted frame, 3 runs of 120 keys: ${runs.map((r) => `median ${r.median.toFixed(1)} ms / p95 ${r.p95.toFixed(1)} ms (n=${r.n})`).join("; ")}; median of medians ${med.toFixed(1)} ms`);
  await closeEditor(ana);
  return { label, runs, med };
}

async function oldRelayCases() {
  if (!haveOld) return skip("10: an older relay", "E2E_OLD_RELAY_BIN / E2E_OLD_DIST not set");
  const R = await openRoom({ ownerBase: NEW, relay: OLD, names: ["Ana", "Ben"] });
  const { ana, ben, peers } = R;
  const id = await newText(R);
  const merging = await Promise.all(peers.map((p) => p.page.evaluate(() => window.__dt.engine().collabText())));
  check("10: against the older relay text merging stays off", merging.every((m) => m === false));
  await openEditor(ana, id);
  await openEditor(ben, id);
  await setSel(ana, 11);
  await setSel(ben, 0);
  await holdAll(peers);
  await type(ana, " AAA");
  await type(ben, "BBB ");
  await releaseAll(peers);
  await converge(peers, 15000);
  await sleep(500);
  const t = await WORLD(peers, id);
  check("10: both editors hold the same text (last write wins, as before)", t[0] === t[1] && t[0].includes("Hello world"), JSON.stringify(t));
  // And a quiet edit travels whole.
  await closeEditor(ben);
  await openEditor(ana, id);
  await setSel(ana, 0);
  await type(ana, "Z");
  await sleep(500);
  const sent = (await Promise.all(peers.map((p) => p.page.evaluate(() => window.__sent)))).flat();
  const deltas = sent.filter((f) => f.includes('"type":"delta"'));
  const withText = deltas.filter((f) => {
    try {
      return "text" in JSON.parse(f).delta;
    } catch {
      return false;
    }
  });
  check("10: no `text` key is ever sent to the older relay", deltas.length > 0 && withText.length === 0, `${deltas.length} deltas, ${withText.length} with text`);
  const seqs = await Promise.all(peers.map((p) => p.page.evaluate((i) => window.__dt.doc().nodes[i].text.seq === undefined, id)));
  check("10: no character ids are kept on a text edited there", seqs.every(Boolean));
  const toasts = (await Promise.all(peers.map((p) => p.page.evaluate(() => window.__toasts)))).flat();
  check("10: no error toast", toasts.length === 0, toasts.join(" | "));
  const errs = peers.flatMap((p) => p.errors);
  check("10: no page errors", errs.length === 0, errs.slice(0, 3).join(" | "));
  await closeRoom(R);
}

async function oldEditorCases() {
  if (!haveOld) return skip("11: an older editor", "E2E_OLD_RELAY_BIN / E2E_OLD_DIST not set");
  // Ana and Ben are new editors; Cai runs the older build from the older relay, in the new relay's room.
  const R0 = await openRoom({ ownerBase: NEW, relay: NEW, names: ["Ana", "Ben"] });
  const olli = await person("Olli", { initScript: false });
  const room = new URL(R0.link).searchParams.get("room");
  await olli.page.goto(`${OLD}/?room=${room}&relay=${encodeURIComponent(NEW)}`);
  await olli.page.waitForSelector("#dt-canvas");
  await olli.page.waitForFunction((id) => window.__dt.collab().status === "live" && !!window.__dt.doc().nodes[id], R0.seedId, { timeout: 25000 });
  const peers = [R0.ana, R0.ben, olli];
  const R = { ...R0, peers, cai: olli };
  const id = await newText(R);
  await waitUntil(async () => (await textOf(olli, id)) === "Hello world", 10000);
  check("11: the older editor has the layer", (await textOf(olli, id)) === "Hello world");
  await openEditor(R.ana, id);
  await setSel(R.ana, 11);
  await type(R.ana, " AAA");
  await waitUntil(async () => (await textOf(olli, id)) === "Hello world AAA", 10000);
  check("11: it sees Ana's typing", (await textOf(olli, id)) === "Hello world AAA", await textOf(olli, id));
  const seqOlli = await olli.page.evaluate((i) => window.__dt.doc().nodes[i].text.seq === undefined, id);
  check("11: the whole text it was sent carries no sequence", seqOlli);
  await olli.page.evaluate((i) => window.__dt.dispatch({ op: "setText", id: i, characters: "OLLI Hello world AAA" }), id);
  await waitUntil(async () => (await textOf(R.ben, id)) === "OLLI Hello world AAA", 10000);
  check("11: the older editor's own edit reaches Ben (last write wins)", (await textOf(R.ben, id)) === "OLLI Hello world AAA", await textOf(R.ben, id));
  await sleep(500);
  await setSel(R.ana, 20);
  await type(R.ana, "!");
  await waitUntil(async () => (await textOf(olli, id)) === "OLLI Hello world AAA!", 10000);
  await sameText([R.ana, R.ben], id, "11 new editors after the older edit");
  check("11: Ana can go on typing after it, and Olli sees it", (await textOf(olli, id)) === "OLLI Hello world AAA!", await textOf(olli, id));
  const errs = everyone.flatMap((p) => p.errors.map((e) => `${p.name}: ${e}`));
  check("11: no page errors anywhere", errs.length === 0, errs.slice(0, 3).join(" | "));
  const toasts = (await Promise.all([R.ana, R.ben].map((p) => p.page.evaluate(() => window.__toasts)))).flat();
  check("11: no error toast on the new editors", toasts.length === 0, toasts.join(" | "));
  await closeEditor(R.ana).catch(() => {});
  await closeRoom({ peers });
}

async function lanCases() {
  if (!bridgeWs) return skip("12: the bridge's LAN room", "E2E_BRIDGE_BIN not set");
  if (!(await up(BRIDGE, "/"))) return skip("12: the bridge's LAN room", "the bridge didn't start");
  const R = await openRoom({ ownerBase: BRIDGE, relay: "", lan: true, names: ["Ana", "Ben"] });
  const { ana, ben, peers } = R;
  const merging = await Promise.all(peers.map((p) => p.page.evaluate(() => window.__dt.engine().collabText())));
  check("12: the LAN room merges text too", merging.every(Boolean));
  const id = await newText(R);
  await openEditor(ana, id);
  await openEditor(ben, id);
  await setSel(ana, 11);
  await setSel(ben, 0);
  await holdAll(peers);
  await type(ana, " AAA");
  await type(ben, "BBB ");
  await releaseAll(peers);
  await sameText(peers, id, "12 LAN concurrent typing");
  const t = await WORLD(peers, id);
  check("12: BBB Hello world AAA through the bridge", t.every((x) => x === "BBB Hello world AAA"), JSON.stringify(t));
  const errs = peers.flatMap((p) => p.errors);
  check("12: no page errors", errs.length === 0, errs.slice(0, 3).join(" | "));
  await closeRoom(R);
}

async function mainLatency() {
  if (!haveMain) return null;
  const R = await openRoom({ ownerBase: MAIN, relay: MAIN });
  const r = await latency(R, "main's editor");
  await closeRoom(R);
  return r;
}

const closeRoom = async (R) => {
  for (const p of R.peers) await p.ctx.close().catch(() => {});
};

// ---------- run ----------
let exitCode = 0;
try {
  const here = await newRoomCases();
  await oldRelayCases();
  await oldEditorCases();
  await lanCases();
  const main = await mainLatency();
  if (main) {
    const slower = here.med - main.med;
    note(`14: this build ${here.med.toFixed(1)} ms vs main ${main.med.toFixed(1)} ms (median of 3 medians)`);
    check("14: typing latency in a shared text is within 5 ms of main's", slower <= 5, `${here.med.toFixed(1)} vs ${main.med.toFixed(1)}`);
  } else skip("14: comparison with main", "E2E_MAIN_DIST not set");
} catch (e) {
  failed++;
  console.log("FAIL  the script stopped: " + (e?.stack ?? e));
  for (const p of everyone) console.log(p.name, p.errors.slice(0, 3));
  exitCode = 1;
} finally {
  await browser.close().catch(() => {});
  for (const c of children) c.kill();
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(exitCode || (failed ? 1 : 0));
