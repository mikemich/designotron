// Round 17, r17a: collaboration correctness with three people in a live room (B-1 to B-5).
//   B-1  concurrent replies to one thread all stay (dispatch op, reply_comment tool, the comment box),
//        undoing a reply removes only yours, a viewer's reply racing an editor's stays
//   B-2  concurrent reorders both apply (C,B,T,A)
//   B-3  undo of a reorder keeps a collaborator's later reorder
//   B-4  delete a variable while someone binds it: no peer keeps a dangling id, the fill keeps its colour
//   B-5  delete a style while someone applies it: same
// Servers (all local, started and stopped here):
//   new relay (this build)   E2E_PORT        default 6903   E2E_RELAY_BIN  default ../target/debug/designotron-relay
//   old relay (round 16)     E2E_OLD_PORT    default 6904   E2E_OLD_RELAY_BIN (SKIP when missing)
//   old editor (round 16)    E2E_OLD_EDITOR_PORT default 6902   E2E_OLD_DIST (the old build's dist; SKIP when missing),
//                            served by the old relay binary
// The mixed-version rooms (an old editor with a new relay, new editors with an old relay) must
// converge without losing what a new editor does; an old editor's own whole-list changes keep
// today's behaviour (last writer wins).
// Every document comparison is canonical JSON (sorted keys): raw key order differs between peers.
// Usage: cd web && npm run build && node scripts/qa/r17a-e2e.mjs      Screenshots: E2E_OUT.

import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const NEW_PORT = Number(process.env.E2E_PORT ?? 6903);
const OLD_PORT = Number(process.env.E2E_OLD_PORT ?? 6904);
const OLD_EDITOR_PORT = Number(process.env.E2E_OLD_EDITOR_PORT ?? 6902);
const NEW = `http://127.0.0.1:${NEW_PORT}`;
const OLD_RELAY = `http://127.0.0.1:${OLD_PORT}`;
const OLD_EDITOR = `http://127.0.0.1:${OLD_EDITOR_PORT}`;
const BIN = process.env.E2E_RELAY_BIN ?? path.resolve("../target/debug/designotron-relay");
const OLD_BIN = process.env.E2E_OLD_RELAY_BIN ?? "";
const OLD_DIST = process.env.E2E_OLD_DIST ?? "";
const OUT = process.env.E2E_OUT ?? "/tmp/r17a-shots";
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + String(detail).slice(0, 500) : ""}`);
};
const skip = (name, why) => console.log(`SKIP  ${name}  - ${why}`);
const note = (msg) => console.log(`##    ${msg}`);

async function waitUntil(fn, timeout = 15000, step = 150) {
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
function serve(bin, port, staticDir) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "r17a-rooms-"));
  tmp.push(data);
  const child = spawn(bin, ["--port", String(port), "--static", staticDir, "--data", data], { stdio: "ignore" });
  children.push(child);
  return child;
}
const up = (base) => waitUntil(() => fetch(`${base}/health`).then((r) => r.ok, () => false), 10000, 100);

serve(BIN, NEW_PORT, "dist");
const haveOldRelay = !!OLD_BIN && fs.existsSync(OLD_BIN);
if (haveOldRelay) serve(OLD_BIN, OLD_PORT, "dist");
const haveOldEditor = haveOldRelay && !!OLD_DIST && fs.existsSync(path.join(OLD_DIST, "index.html"));
if (haveOldEditor) serve(OLD_BIN, OLD_EDITOR_PORT, OLD_DIST);
await up(NEW);
if (haveOldRelay) await up(OLD_RELAY);
if (haveOldEditor) await up(OLD_EDITOR);

// ---------- people ----------
const launch = { headless: true, args: ["--no-sandbox"] };
if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";
const LOCAL = /^(https?:\/\/(localhost|127\.0\.0\.1)[:/])|^(data|blob|ws|wss):/;
const browser = await chromium.launch(launch);
const everyone = [];

async function person(name) {
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
  const page = await ctx.newPage();
  const p = { name, ctx, page, errors: [], welcome: null };
  page.on("pageerror", (e) => p.errors.push("pageerror: " + String(e)));
  page.on("console", (m) => {
    if (m.type() === "error" && !/bridge\/ws|Failed to load resource|ERR_INTERNET_DISCONNECTED|WebSocket connection/.test(m.text())) p.errors.push("console: " + m.text().slice(0, 300));
  });
  p.frames = [];
  const keep = (dir) => (f) => {
    const t = String(f.payload);
    if (!t.includes('"presence"') && !t.includes('"ping"') && !t.includes('"pong"')) p.frames.push(`${dir} ${t.slice(0, 400)}`);
    if (p.frames.length > 12) p.frames.shift();
  };
  page.on("websocket", (ws) => {
    ws.on("framesent", keep(">>"));
    ws.on("framereceived", (f) => {
      keep("<<")(f);
      try {
        const m = JSON.parse(f.payload);
        if (m.type === "welcome") p.welcome = m;
      } catch {
        /* binary or partial */
      }
    });
  });
  everyone.push(p);
  return p;
}

// Canonical JSON: keys sorted.
const CANON = `(function canon(v){ if (Array.isArray(v)) return v.map(canon); if (v && typeof v === "object") { const o = {}; for (const k of Object.keys(v).sort()) o[k] = canon(v[k]); return o; } return v; })`;
const canon = (p) => p.page.evaluate((src) => JSON.stringify(eval(src)(window.__dt.doc())), CANON);
const docOf = (p) => p.page.evaluate(() => window.__dt.doc());
const dispatch = (p, cmd) => p.page.evaluate((c) => window.__dt.dispatch(c), cmd);
const tool = async (p, name, input) => {
  const r = await p.page.evaluate(([n, i]) => window.__dt.tool(n, i), [name, input]);
  return r && r.result !== undefined ? r.result : r;
};

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
  return { same: false, ms: Date.now() - t0, at: i, left: last[0].slice(Math.max(0, i - 100), i + 100), right: last[last.length - 1].slice(Math.max(0, i - 100), i + 100) };
}
const settled = async (peers, name, timeout) => {
  const c = await converge(peers, timeout);
  check(`${name}: every peer holds the same document`, c.same, c.same ? "" : JSON.stringify(c));
  return c.same;
};

// A layer tree that doesn't hang together, a binding or a style link to something that isn't there.
const INTEGRITY = `(d) => {
  const errs = []; const N = d.nodes;
  const vars = new Set((d.variables || []).flatMap((c) => (c.variables || []).map((v) => v.id)));
  const styles = new Set([...(d.styles?.colors || []), ...(d.styles?.texts || []), ...(d.styles?.effects || []), ...(d.styles?.grids || [])].map((s) => s.id));
  for (const [id, n] of Object.entries(N)) {
    if (n.parent && (!N[n.parent] || !(N[n.parent].children || []).includes(id))) errs.push("bad parent " + id);
    for (const c of n.children || []) if (!N[c] || N[c].parent !== id) errs.push("bad child " + id + " -> " + c);
    if (!n.parent && !(d.pages.find((p) => p.id === n.page)?.children || []).includes(id)) errs.push("top-level not on its page " + id);
    for (const [p, v] of Object.entries(n.bindings || {})) if (v && !vars.has(v)) errs.push("dangling variable " + id + "." + p);
    for (const k of ["fillStyle", "strokeStyle", "textStyle", "effectStyle", "gridStyle"]) if (n[k] && !styles.has(n[k])) errs.push("dangling " + k + " " + id);
  }
  return errs;
}`;
const integrity = (p) => p.page.evaluate((src) => eval(src)(window.__dt.doc()), INTEGRITY);
const allIntegrity = async (peers, name) => {
  const out = {};
  for (const p of peers) out[p.name] = await integrity(p);
  const bad = Object.entries(out).filter(([, e]) => e.length);
  check(`${name}: nothing dangling or out of place on any peer`, bad.length === 0, JSON.stringify(bad));
};

// ---------- a room ----------
// `owner` shares a file with a frame (Hero) holding Box A, B, C and a Headline; the others join.
// `relay` is the relay the owner types in; `joinBase` is where the other two open the link
// (the editor they run): a new editor at the relay, or an old editor beside it.
async function openRoom({ ownerBase, relay, joinBase, names = ["Ana", "Ben", "Cai"], joinNames }) {
  const ana = await person(names[0]);
  await ana.page.goto(ownerBase);
  await ana.page.click("button:has-text('New design file')");
  await ana.page.waitForSelector("#dt-canvas");
  const frame = (await tool(ana, "create_nodes", { nodes: [{ type: "frame", name: "Hero", x: 0, y: 0, width: 800, height: 600, fill: "#FFFFFF" }] })).created[0].id;
  const kids = (
    await tool(ana, "create_nodes", {
      nodes: [
        { type: "rectangle", name: "Box A", x: 20, y: 20, width: 120, height: 80, fill: "#FF0000" },
        { type: "rectangle", name: "Box B", x: 160, y: 20, width: 120, height: 80, fill: "#00FF00" },
        { type: "rectangle", name: "Box C", x: 300, y: 20, width: 120, height: 80, fill: "#0000FF" },
        { type: "text", name: "Headline", x: 20, y: 200, width: 300, height: 40, text: "Hello", fontSize: 24 },
      ],
    })
  ).created.map((k) => k.id);
  await tool(ana, "move_nodes", { ids: kids, parentId: frame });
  await ana.page.click(".tbtn[title='Share for live editing']");
  await ana.page.fill(".share-dialog input.textinput >> nth=0", names[0]);
  // The dialog shows the relay field, or (a page served by a relay) a link that opens it.
  await ana.page.waitForSelector(".share-dialog input.mono, .share-dialog :text('Use a different relay')", { timeout: 15000 });
  if (!(await ana.page.locator(".share-dialog input.mono").count())) await ana.page.click(".share-dialog :text('Use a different relay')");
  await ana.page.fill(".share-dialog input.mono", relay);
  await ana.page.click("button:has-text('Share online')");
  await ana.page.waitForFunction(() => window.__dt.collab().status === "live", null, { timeout: 20000 });
  const link = await ana.page.evaluate(() => window.__dt.collab().link);
  const room = new URL(link).searchParams.get("room");
  await ana.page.keyboard.press("Escape");
  await ana.page.click(".modal-head .ibtn[title='Close']").catch(() => {});
  const others = [];
  for (const n of (joinNames ?? names.slice(1))) {
    const p = await person(n);
    await p.page.goto(`${joinBase}/?room=${room}${joinBase === NEW || joinBase === OLD_RELAY ? "" : `&relay=${encodeURIComponent(relay)}`}`);
    await p.page.waitForSelector("#dt-canvas");
    await p.page.waitForFunction((id) => window.__dt.collab().status === "live" && !!window.__dt.doc().nodes[id], kids[3], { timeout: 25000 });
    others.push(p);
  }
  const peers = [ana, ...others];
  const c = await converge(peers);
  return { ana, ben: others[0], cai: others[1], peers, frame, a: kids[0], b: kids[1], c: kids[2], t: kids[3], room, link, converged: c.same };
}

const label = (R) => (arr) => arr.map((id) => (id === R.a ? "A" : id === R.b ? "B" : id === R.c ? "C" : id === R.t ? "T" : "?")).join(",");
const order = async (R, p) => label(R)((await docOf(p)).nodes[R.frame].children);
// Puts the four layers back in A,B,C,T for everyone.
async function resetOrder(R) {
  for (const [i, id] of [R.a, R.b, R.c, R.t].entries()) await dispatch(R.ana, { op: "moveToParent", ids: [id], parent: R.frame, index: i });
  // Everyone shows A,B,C,T and nothing of the reset is still on its way (a late reset delta would
  // land in the middle of the race that follows).
  for (let k = 0; k < 2; k++) {
    await waitUntil(async () => (await Promise.all(R.peers.map((p) => order(R, p)))).every((o) => o === "A,B,C,T"), 15000, 100);
    await sleep(600);
  }
  await converge(R.peers);
}
const texts = async (p, cid) => (await docOf(p)).comments[cid]?.messages.map((m) => m.text);
const newThread = async (R, text) => {
  const r = await dispatch(R.ana, { op: "addComment", x: 40, y: 40, node: R.a, text, author: "Ana", time: Date.now() });
  await converge(R.peers);
  return r.id;
};
const closeRoom = async (R) => {
  for (const p of R.peers) await p.ctx.close().catch(() => {});
};

// ---------- the cases that need a relay that speaks `lists` ----------
// `R.ana`, `R.ben` and `R.cai` may be old or new editors (see `mixed`).
async function repliesAndOrders(R, tag, { oldOwner = false } = {}) {
  const { ana, ben, cai, peers } = R;
  // B-1 through the dispatch op
  for (let round = 1; round <= 2; round++) {
    const cid = await newThread(R, `${tag} Q${round}`);
    await Promise.all([
      dispatch(ben, { op: "replyComment", id: cid, text: `BEN-${round}`, author: "Ben", time: Date.now() }),
      dispatch(cai, { op: "replyComment", id: cid, text: `CAI-${round}`, author: "Cai", time: Date.now() }),
    ]);
    const same = await converge(peers);
    const lists = await Promise.all(peers.map((p) => texts(p, cid)));
    check(`${tag} B-1 (op, round ${round}): both replies on every peer, same order`, same.same && lists.every((l) => l.length === 3 && l[0] === `${tag} Q${round}` && l.includes(`BEN-${round}`) && l.includes(`CAI-${round}`) && l.join() === lists[0].join()), JSON.stringify(lists));
  }
  // B-1 through the reply_comment tool
  {
    const cid = await newThread(R, `${tag} Tq`);
    await Promise.all([tool(ben, "reply_comment", { id: cid, text: "BEN-T", author: "Ben" }), tool(cai, "reply_comment", { id: cid, text: "CAI-T", author: "Cai" })]);
    const same = await converge(peers);
    const lists = await Promise.all(peers.map((p) => texts(p, cid)));
    check(`${tag} B-1 (reply_comment tool): both replies on every peer`, same.same && lists.every((l) => l.length === 3 && l.includes("BEN-T") && l.includes("CAI-T")), JSON.stringify(lists));
  }
  // Resolve while someone replies: both stick.
  {
    const cid = await newThread(R, `${tag} Rq`);
    await Promise.all([dispatch(ana, { op: "resolveComment", id: cid, resolved: true }), dispatch(ben, { op: "replyComment", id: cid, text: "BEN-R", author: "Ben", time: Date.now() })]);
    const same = await converge(peers);
    const cs = await Promise.all(peers.map(async (p) => (await docOf(p)).comments[cid]));
    check(`${tag} resolve and reply at once both stick`, same.same && cs.every((c) => c.resolved && c.messages.length === 2), JSON.stringify(cs[0]));
  }
  // Reply while the thread is deleted: it stays deleted everywhere.
  {
    const cid = await newThread(R, `${tag} Dq`);
    await Promise.all([dispatch(ana, { op: "deleteComment", id: cid }), dispatch(ben, { op: "replyComment", id: cid, text: "BEN-D", author: "Ben", time: Date.now() })]);
    const same = await converge(peers);
    const gone = await Promise.all(peers.map(async (p) => !(await docOf(p)).comments[cid]));
    check(`${tag} a reply racing the thread's deletion: deleted everywhere`, same.same && gone.every(Boolean));
  }
  // Undo of a reply removes only the replier's.
  {
    const cid = await newThread(R, `${tag} Uq`);
    await dispatch(ben, { op: "replyComment", id: cid, text: "BEN-U", author: "Ben", time: Date.now() });
    await converge(peers);
    await dispatch(cai, { op: "replyComment", id: cid, text: "CAI-U", author: "Cai", time: Date.now() });
    await converge(peers);
    await dispatch(ben, { op: "undo" });
    const same = await converge(peers);
    const lists = await Promise.all(peers.map((p) => texts(p, cid)));
    check(`${tag} undoing Ben's reply keeps Cai's`, same.same && lists.every((l) => l.join() === `${tag} Uq,CAI-U`), JSON.stringify(lists));
  }
  // B-2: concurrent reorders.
  for (let rep = 1; rep <= 2; rep++) {
    await resetOrder(R);
    await Promise.all([dispatch(ana, { op: "reorder", ids: [R.a], to: "front" }), dispatch(ben, { op: "reorder", ids: [R.c], to: "back" })]);
    const same = await converge(peers);
    const os = await Promise.all(peers.map((p) => order(R, p)));
    // Both moves apply; an old editor's own list is whole-list, last writer wins (see the header).
    const ok = oldOwner ? same.same && os.every((o) => o === os[0]) : same.same && os.every((o) => o === "C,B,T,A");
    check(`${tag} B-2 (rep ${rep}): concurrent front and back${oldOwner ? " (an old editor's list may win)" : " both apply: C,B,T,A"}`, ok, JSON.stringify(os));
    if (!ok) for (const p of [ana, ben]) console.log(p.name, p.frames.join("\n"));
  }
  // Bring forward one step races a send to back: the layer moved is B, not its neighbour C.
  if (!oldOwner) {
    await resetOrder(R);
    await Promise.all([dispatch(ana, { op: "reorder", ids: [R.b], to: "forward" }), dispatch(ben, { op: "reorder", ids: [R.t], to: "back" })]);
    const same = await converge(peers);
    const os = await Promise.all(peers.map((p) => order(R, p)));
    check(`${tag} bring forward (B) and send to back (T) at once: both apply (T,A,C,B)`, same.same && os.every((o) => o === "T,A,C,B"), JSON.stringify(os));
    if (!os.every((o) => o === "T,A,C,B")) for (const p of [ana, ben]) console.log(p.name, p.frames.join("\n"));
    await resetOrder(R);
    await dispatch(ana, { op: "reorder", ids: [R.c], to: "backward" }); // A,C,B,T
    await converge(peers);
    await dispatch(ben, { op: "reorder", ids: [R.b], to: "front" }); // A,C,T,B
    await converge(peers);
    await dispatch(ana, { op: "undo" });
    const su = await converge(peers);
    const ou = await Promise.all(peers.map((p) => order(R, p)));
    check(`${tag} undo of send backward after Ben moved B: C goes back, B stays (A,T,B,C)`, su.same && ou.every((o) => o === "A,T,B,C"), JSON.stringify(ou));
  }
  // B-3: Ana's undo keeps Ben's later reorder.
  if (!oldOwner) {
    for (let rep = 1; rep <= 2; rep++) {
      await resetOrder(R);
      await dispatch(ana, { op: "reorder", ids: [R.a], to: "front" }); // B,C,T,A
      await converge(peers);
      await dispatch(ben, { op: "reorder", ids: [R.c], to: "back" }); // C,B,T,A
      await converge(peers);
      const before = await order(R, ben);
      await dispatch(ana, { op: "undo" });
      const same = await converge(peers);
      const os = await Promise.all(peers.map((p) => order(R, p)));
      check(`${tag} B-3 (rep ${rep}): Ana's undo puts A back and keeps Ben's reorder (${before} -> ${os[0]})`, same.same && os.every((o) => o === "A,C,B,T"), JSON.stringify(os));
    }
  }
  await allIntegrity(peers, `${tag} reorders and replies`);
}

async function danglingCases(R, tag, { binder, deleter }) {
  const { peers } = R;
  // B-4: delete a variable while someone binds it (twice, with the other binding order).
  for (let round = 1; round <= 2; round++) {
    const f = (await tool(R.ana, "create_nodes", { nodes: [{ type: "rectangle", name: `${tag}R${round}`, x: 100, y: 700 + round * 60, width: 50, height: 50, fill: "#111111" }] })).created[0].id;
    await tool(R.ana, "define_variables", { collection: `${tag}Ink${round}`, modes: ["Default"], variables: [{ name: `Ink${round}`, type: "color", values: { Default: "#111111" } }] });
    await converge(peers);
    const d0 = await docOf(R.ana);
    const ink = d0.variables.flatMap((x) => x.variables).find((v) => v.name === `Ink${round}`).id;
    const colls = JSON.parse(JSON.stringify(d0.variables)).map((col) => ({ ...col, variables: col.variables.filter((v) => v.id !== ink) }));
    await Promise.all([dispatch(deleter, { op: "setVariables", collections: colls }), dispatch(binder, { op: "bindVariable", ids: [f], property: "fill", variable: ink })]);
    const same = await converge(peers);
    const bound = await Promise.all(peers.map(async (p) => (await docOf(p)).nodes[f].bindings));
    const fills = await Promise.all(peers.map(async (p) => (await docOf(p)).nodes[f].fills[0].color));
    check(`${tag} B-4 (round ${round}): delete variable + bind: no peer binds the deleted id`, same.same && bound.every((b) => !b || !b.fill), JSON.stringify(bound));
    check(`${tag} B-4 (round ${round}): the layer keeps its colour`, fills.every((c) => c.toUpperCase() === "#111111"), JSON.stringify(fills));
    await dispatch(R.cai, { op: "update", ids: [f], patch: { x: 333 } });
    await converge(peers);
    const xs = await Promise.all(peers.map(async (p) => (await docOf(p)).nodes[f].x));
    check(`${tag} B-4 (round ${round}): a later move of that layer reaches everyone`, xs.every((x) => x === 333), JSON.stringify(xs));
  }
  // B-5: delete a style while someone applies it.
  for (let round = 1; round <= 2; round++) {
    const f = (await tool(R.ana, "create_nodes", { nodes: [{ type: "rectangle", name: `${tag}S${round}`, x: 100, y: 900 + round * 60, width: 50, height: 50, fill: "#111111" }] })).created[0].id;
    await tool(R.ana, "define_styles", { colors: [{ name: `${tag}Tmp${round}`, color: "#FF00FF" }] });
    await converge(peers);
    const sid = (await docOf(R.ana)).styles.colors.find((s) => s.name === `${tag}Tmp${round}`).id;
    await Promise.all([dispatch(deleter, { op: "deleteStyle", id: sid }), dispatch(binder, { op: "applyStyle", ids: [f], styleId: sid })]);
    const same = await converge(peers);
    const links = await Promise.all(peers.map(async (p) => (await docOf(p)).nodes[f].fillStyle ?? null));
    check(`${tag} B-5 (round ${round}): delete style + apply: no peer links the deleted style`, same.same && links.every((l) => l === null), JSON.stringify(links));
  }
  await allIntegrity(peers, `${tag} variables and styles`);
}

// ====================================================================================
// 1. The new relay, new editors
// ====================================================================================
note("1. new relay, new editors (this build)");
for (let rep = 1; rep <= Number(process.env.E2E_REPS ?? 2); rep++) {
  let R = null;
  try {
    R = await openRoom({ ownerBase: NEW, relay: NEW, joinBase: NEW });
    check(`room ${rep}: three editors converged`, R.converged);
    for (const p of R.peers) check(`room ${rep}: ${p.name}'s welcome says lists`, p.welcome?.lists === true, JSON.stringify(p.welcome && Object.keys(p.welcome)));
    await repliesAndOrders(R, `new${rep}`);
    await danglingCases(R, `new${rep}`, { binder: R.ben, deleter: R.ana });
    if (rep === 1) {
      // B-1 through the comment box: both reply with the keyboard at the same moment.
      const cid = await newThread(R, "UI-Q");
      for (const p of [R.ben, R.cai]) await p.page.click(".tbtn[title='Comment (C)']");
      const reply = async (p, text) => {
        await p.page.locator(".comment-pin[title='UI-Q']").first().click();
        const box = p.page.locator(".comment-popover input.textinput[placeholder='Reply…']");
        await box.fill(text);
        await box.press("Enter");
      };
      await Promise.all([reply(R.ben, "UI-BEN"), reply(R.cai, "UI-CAI")]);
      const same = await converge(R.peers);
      const lists = await Promise.all(R.peers.map((p) => texts(p, cid)));
      check("B-1 (comment box): both replies on every peer", same.same && lists.every((l) => l.length === 3 && l.includes("UI-BEN") && l.includes("UI-CAI") && l.join() === lists[0].join()), JSON.stringify(lists));
      await R.ana.page.click(".tbtn[title='Comment (C)']");
      await R.ana.page.locator(".comment-pin[title='UI-Q']").first().click();
      await R.ana.page.waitForSelector(".comment-popover .comment-message >> nth=2", { timeout: 5000 }).catch(() => {});
      await R.ana.page.screenshot({ path: path.join(OUT, "b1-thread-ana.png") });
      await R.ana.page.keyboard.press("Escape");
      // A viewer's reply races an editor's.
      await R.ana.page.click("button[aria-label^='Share, shared live']");
      await R.ana.page.waitForSelector("#share-view-link", { timeout: 8000 }).catch(() => {});
      const viewLink = await R.ana.page.locator("#share-view-link").inputValue().catch(() => null);
      await R.ana.page.keyboard.press("Escape");
      await R.ana.page.click(".modal-head .ibtn[title='Close']").catch(() => {});
      if (viewLink) {
        const vic = await person("Vic");
        R.peers.push(vic);
        await vic.page.goto(viewLink);
        await vic.page.waitForSelector("#dt-canvas");
        await vic.page.waitForFunction(() => window.__dt.collab().status === "live" && window.__dt.collab().viewer, null, { timeout: 20000 });
        const c2 = await newThread(R, "VIEW-Q");
        await Promise.all([
          dispatch(vic, { op: "replyComment", id: c2, text: "VIC-1", author: "Vic", time: Date.now() }),
          dispatch(R.ben, { op: "replyComment", id: c2, text: "BEN-V", author: "Ben", time: Date.now() }),
        ]);
        const sv = await converge(R.peers);
        const ls = await Promise.all(R.peers.map((p) => texts(p, c2)));
        check("a viewer's reply racing an editor's: both stay on every peer", sv.same && ls.every((l) => l.length === 3 && l.includes("VIC-1") && l.includes("BEN-V")), JSON.stringify(ls));
        await dispatch(vic, { op: "resolveComment", id: c2, resolved: true });
        await converge(R.peers);
        check("a viewer can resolve a thread", (await docOf(R.ana)).comments[c2].resolved === true);
        await R.ana.page.screenshot({ path: path.join(OUT, "room-ana.png") });
      } else {
        skip("viewer reply", "no view link on this relay");
      }
    }
    for (const p of R.peers) check(`room ${rep}: no page errors for ${p.name}`, p.errors.length === 0, p.errors.slice(0, 2).join(" ; "));
  } catch (e) {
    check(`room ${rep} threw`, false, String((e && e.stack) || e).slice(0, 600));
  } finally {
    if (R) await closeRoom(R);
    for (const p of everyone.splice(0)) await p.ctx.close().catch(() => {});
  }
}

// ====================================================================================
// 2. An old relay (round 16), new editors: behaviour as before, nothing breaks
// ====================================================================================
if (!haveOldRelay || process.env.E2E_ONLY_NEW) {
  skip("2. old relay", `E2E_OLD_RELAY_BIN not set or missing`);
} else {
  note("2. old relay (round 16), new editors");
  let R = null;
  try {
    R = await openRoom({ ownerBase: OLD_RELAY, relay: OLD_RELAY, joinBase: OLD_RELAY });
    check("old relay: the room converged", R.converged);
    for (const p of R.peers) check(`old relay: ${p.name}'s welcome has no lists`, p.welcome && p.welcome.lists === undefined, JSON.stringify(p.welcome && p.welcome.lists));
    await resetOrder(R);
    await Promise.all([dispatch(R.ana, { op: "reorder", ids: [R.a], to: "front" }), dispatch(R.ben, { op: "reorder", ids: [R.c], to: "back" })]);
    const same = await converge(R.peers);
    const os = await Promise.all(R.peers.map((p) => order(R, p)));
    check("old relay: concurrent reorders converge (last writer wins, as before)", same.same && os.every((o) => o === os[0]), JSON.stringify(os));
    const cid = await newThread(R, "OLD-Q");
    await Promise.all([dispatch(R.ben, { op: "replyComment", id: cid, text: "BEN", author: "Ben", time: Date.now() }), dispatch(R.cai, { op: "replyComment", id: cid, text: "CAI", author: "Cai", time: Date.now() })]);
    const sr = await converge(R.peers);
    const ls = await Promise.all(R.peers.map((p) => texts(p, cid)));
    check("old relay: concurrent replies converge (one may be lost, as before)", sr.same && ls.every((l) => l.join() === ls[0].join() && l.length >= 2), JSON.stringify(ls));
    await dispatch(R.ana, { op: "reorder", ids: [R.t], to: "front" });
    await converge(R.peers);
    await dispatch(R.ben, { op: "reorder", ids: [R.b], to: "back" });
    await converge(R.peers);
    await dispatch(R.ana, { op: "undo" });
    const su = await converge(R.peers);
    check("old relay: undo of a reorder still converges", su.same);
    // Edits keep working both ways.
    await dispatch(R.cai, { op: "update", ids: [R.a], patch: { x: 77 } });
    await converge(R.peers);
    check("old relay: an edit reaches everyone", (await docOf(R.ana)).nodes[R.a].x === 77);
    for (const p of R.peers) check(`old relay: no page errors for ${p.name}`, p.errors.length === 0, p.errors.slice(0, 2).join(" ; "));
  } catch (e) {
    check("old relay threw", false, String((e && e.stack) || e).slice(0, 600));
  } finally {
    if (R) await closeRoom(R);
  }
}

// ====================================================================================
// 3. The new relay, an old editor (round 16) with two new ones
// ====================================================================================
if (!haveOldEditor || process.env.E2E_ONLY_NEW) {
  skip("3. old editor", `E2E_OLD_DIST not set or missing`);
} else {
  note("3. new relay, an old editor with two new ones");
  let R = null;
  try {
    R = await openRoom({ ownerBase: OLD_EDITOR, relay: NEW, joinBase: NEW });
    check("old editor: the room converged", R.converged);
    check("old editor: the new editors' welcome says lists", R.ben.welcome?.lists === true && R.cai.welcome?.lists === true);
    // New editors racing each other with an old editor in the room: replies and reorders both stay.
    const cid = await newThread(R, "MIX-Q");
    await Promise.all([dispatch(R.ben, { op: "replyComment", id: cid, text: "BEN", author: "Ben", time: Date.now() }), dispatch(R.cai, { op: "replyComment", id: cid, text: "CAI", author: "Cai", time: Date.now() })]);
    const s1 = await converge(R.peers);
    const l1 = await Promise.all(R.peers.map((p) => texts(p, cid)));
    check("mixed: two new editors' concurrent replies both stay, the old editor sees them", s1.same && l1.every((l) => l.length === 3 && l.includes("BEN") && l.includes("CAI")), JSON.stringify(l1));
    await resetOrder(R);
    await Promise.all([dispatch(R.ben, { op: "reorder", ids: [R.a], to: "front" }), dispatch(R.cai, { op: "reorder", ids: [R.c], to: "back" })]);
    const s2 = await converge(R.peers);
    const os = await Promise.all(R.peers.map((p) => order(R, p)));
    check("mixed: two new editors' concurrent reorders both apply (C,B,T,A), the old editor follows", s2.same && os.every((o) => o === "C,B,T,A"), JSON.stringify(os));
    // The old editor's reply and a new editor's, in turn: both stay.
    await dispatch(R.ana, { op: "replyComment", id: cid, text: "ANA-OLD", author: "Ana", time: Date.now() });
    await converge(R.peers);
    await dispatch(R.ben, { op: "replyComment", id: cid, text: "BEN-2", author: "Ben", time: Date.now() });
    const s3 = await converge(R.peers);
    const l3 = await Promise.all(R.peers.map((p) => texts(p, cid)));
    check("mixed: the old editor's reply and a new editor's, one after the other, both stay", s3.same && l3.every((l) => l.length === 5 && l.includes("ANA-OLD") && l.includes("BEN-2")), JSON.stringify(l3));
    // An old editor's reply racing a new editor's: converges (an old editor sends the whole thread).
    const c3 = await newThread(R, "MIX-R");
    await Promise.all([dispatch(R.ana, { op: "replyComment", id: c3, text: "OLD-RACE", author: "Ana", time: Date.now() }), dispatch(R.ben, { op: "replyComment", id: c3, text: "NEW-RACE", author: "Ben", time: Date.now() })]);
    const s4 = await converge(R.peers);
    const l4 = await Promise.all(R.peers.map((p) => texts(p, c3)));
    check("mixed: an old editor's reply racing a new one's converges", s4.same && l4.every((l) => l.join() === l4[0].join() && l.length >= 2), JSON.stringify(l4));
    // Reorder: the old editor's whole list against a new editor's move.
    await resetOrder(R);
    await Promise.all([dispatch(R.ana, { op: "reorder", ids: [R.a], to: "front" }), dispatch(R.ben, { op: "reorder", ids: [R.c], to: "back" })]);
    const s5 = await converge(R.peers);
    const os5 = await Promise.all(R.peers.map((p) => order(R, p)));
    check("mixed: an old editor's reorder racing a new one's converges", s5.same && os5.every((o) => o === os5[0]), JSON.stringify(os5));
    // Variables and styles: the old editor binds / applies (it can't prune), new editors delete.
    await danglingCases(R, "mixed-old-binds", { binder: R.ana, deleter: R.ben });
    // And the old editor deletes while a new one binds.
    await danglingCases(R, "mixed-old-deletes", { binder: R.cai, deleter: R.ana });
    await R.ben.page.screenshot({ path: path.join(OUT, "mixed-ben.png") });
    for (const p of R.peers) check(`mixed: no page errors for ${p.name}`, p.errors.length === 0, p.errors.slice(0, 2).join(" ; "));
  } catch (e) {
    check("mixed threw", false, String((e && e.stack) || e).slice(0, 600));
  } finally {
    if (R) await closeRoom(R);
  }
}

await browser.close();
for (const c of children) c.kill();
// The killed relays may still be writing room files for a moment; retry, and never fail the run on clean-up.
for (const d of tmp) {
  try {
    fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (e) {
    console.log(`note: could not remove ${d}: ${e.code}`);
  }
}
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
