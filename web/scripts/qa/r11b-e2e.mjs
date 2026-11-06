// Round 11, P2: a version restore keeps every comment for everyone in a room, and undo never
// drops a variable or style that another person's layer uses (no "Missing variable"), while
// single-user undo still removes pasted tokens nobody uses. Two people in a live local room.
// Starts its own relay (E2E_RELAY_BIN, default ../target/debug/designotron-relay) on E2E_PORT
// (default 5924) with a temp --data dir, serving web/dist, and stops it when done.
// Usage: cd web && npm run build && node scripts/qa/r11b-e2e.mjs      Screenshots: E2E_OUT.

import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.E2E_PORT ?? 5924);
const BASE = `http://127.0.0.1:${PORT}`;
const BIN = process.env.E2E_RELAY_BIN ?? path.resolve("../target/debug/designotron-relay");
const OUT = process.env.E2E_OUT ?? "/tmp/r11b-shots";
fs.mkdirSync(OUT, { recursive: true });
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "r11b-rooms-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
};
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
const relay = spawn(BIN, ["--port", String(PORT), "--static", "dist", "--data", DATA], { stdio: "ignore" });
const launch = { headless: true, args: ["--no-sandbox"] };
if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";
const LOCAL = /^(https?:\/\/(localhost|127\.0\.0\.1)[:/])|^(data|blob|ws|wss):/;
async function person(browser, name) {
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
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  return { name, ctx, page, errors };
}
const doc = (p) => p.page.evaluate(() => window.__dt.doc());
const ai = (p, tool, input) => p.page.evaluate(([t, i]) => window.__dt.dispatch({ op: "ai", tool: t, input: i }), [tool, input]);
const undo = (p) => p.page.evaluate(() => window.__dt.dispatch({ op: "undo" }));
const redo = (p) => p.page.evaluate(() => window.__dt.dispatch({ op: "redo" }));
const commentTexts = (p) => p.page.evaluate(() => Object.values(window.__dt.doc().comments).map((c) => c.messages[0].text).sort());
const varNames = async (p) => (await doc(p)).variables.flatMap((c) => c.variables.map((v) => `${c.name}/${v.name}`)).sort();
const named = async (p, name) => Object.values((await doc(p)).nodes).find((n) => n.name === name);
const newFile = async (p) => {
  await p.page.goto(BASE);
  await p.page.click("button:has-text('New design file')");
  await p.page.waitForSelector("#dt-canvas");
};

await waitUntil(() => fetch(`${BASE}/health`).then((r) => r.ok, () => false), 10000, 100);
const browser = await chromium.launch(launch);
try {
  const O = await person(browser, "Olga"), G = await person(browser, "Gina"), V = await person(browser, "Vik"), L = await person(browser, "Solo");
  await newFile(O);
  await ai(O, "create_nodes", { nodes: [{ type: "frame", name: "Hero", x: 0, y: 0, width: 480, height: 320, fill: "#FFFFFF" }] });
  await O.page.click(".tbtn[title='Share for live editing']");
  await O.page.click("button:has-text('Share online')");
  await O.page.waitForFunction(() => window.__dt.collab().status === "live");
  const { link, viewId } = await O.page.evaluate(() => ({ link: window.__dt.collab().link, viewId: window.__dt.collab().viewId }));
  await O.page.keyboard.press("Escape");
  await O.page.locator(".modal-bg").waitFor({ state: "detached" }).catch(() => {});
  await G.page.goto(link);
  await waitUntil(() => G.page.evaluate(() => window.__dt.collab().status === "live"), 20000);
  await V.page.goto(`${BASE}/?view=${viewId}`);
  await waitUntil(() => V.page.evaluate(() => window.__dt.collab().status === "live"), 20000);
  await sleep(1000);

  // ---------------- B2: restore keeps comments ----------------
  await O.page.getByRole("tab", { name: /history/i }).click();
  await O.page.locator(".history input.textinput").first().fill("Before comments");
  await O.page.locator(".history button.btn.primary", { hasText: "Save" }).first().click();
  await O.page.locator(".version").first().waitFor();
  const heroId = (await named(O, "Hero")).id;
  await ai(O, "create_nodes", { nodes: [{ type: "rectangle", name: "Late", x: 600, y: 40, width: 100, height: 100 }] });
  const lateId = (await named(O, "Late")).id;
  await O.page.evaluate(([n]) => window.__dt.dispatch({ op: "addComment", x: 650, y: 90, node: n, text: "On the late layer", author: "Olga", time: Date.now() }), [lateId]);
  await O.page.evaluate(([n]) => window.__dt.dispatch({ op: "addComment", x: 20, y: 20, node: n, text: "On Hero", author: "Olga", time: Date.now() }), [heroId]);
  await G.page.evaluate(() => window.__dt.dispatch({ op: "addComment", x: 900, y: 900, text: "Gina on the page", author: "Gina", time: Date.now() }));
  await sleep(1200);
  const resolvedId = Object.values((await doc(G)).comments).find((c) => c.messages[0].text === "Gina on the page").id;
  await G.page.evaluate((id) => window.__dt.dispatch({ op: "resolveComment", id, resolved: true }), resolvedId);
  await sleep(1000);
  const all = ["Gina on the page", "On Hero", "On the late layer"];
  check("setup: both people see three comments", JSON.stringify(await commentTexts(O)) === JSON.stringify(all) && JSON.stringify(await commentTexts(G)) === JSON.stringify(all), JSON.stringify(await commentTexts(G)));

  // Hit target of the restore button: at least 24x24 while the row is hovered.
  const row = O.page.locator(".version").first();
  await O.page.mouse.move(600, 600);
  const idle = await row.evaluate((r) => r.getBoundingClientRect().height);
  await row.hover();
  const hov = await row.evaluate((r) => r.getBoundingClientRect().height);
  const rb = await row.locator("button[title='Restore this version']").boundingBox();
  check("restore button is at least 24x24", !!rb && rb.width >= 24 && rb.height >= 24, rb ? `${rb.width}x${rb.height}` : "hidden");
  check("the row doesn't change height on hover", Math.abs(idle - hov) < 0.5, `${idle} vs ${hov}`);
  const rowBox = await row.boundingBox();
  await O.page.screenshot({ path: `${OUT}/history-hover.png`, clip: { x: rowBox.x, y: Math.max(0, rowBox.y - 40), width: rowBox.width, height: 120 } });

  await row.locator("button[title='Restore this version']").click();
  await waitUntil(async () => !(await named(O, "Late")), 8000);
  await sleep(1500);
  check("restore: the late layer is gone (version restored)", !(await named(O, "Late")));
  for (const p of [O, G, V]) {
    check(`restore: ${p.name} still sees all three comments`, JSON.stringify(await commentTexts(p)) === JSON.stringify(all), JSON.stringify(await commentTexts(p)));
  }
  const cs = Object.values((await doc(G)).comments);
  const orphan = cs.find((c) => c.messages[0].text === "On the late layer");
  check("restore: a comment on a vanished layer becomes a page comment at its old spot", orphan && orphan.node == null && Math.abs(orphan.x - 650) < 0.5 && Math.abs(orphan.y - 90) < 0.5, JSON.stringify(orphan && { node: orphan.node, x: orphan.x, y: orphan.y }));
  check("restore: a resolved comment stays resolved", cs.find((c) => c.messages[0].text === "Gina on the page")?.resolved === true);
  check("restore: a comment on a surviving layer stays attached", cs.find((c) => c.messages[0].text === "On Hero")?.node === heroId);
  await O.page.screenshot({ path: `${OUT}/after-restore.png` });
  // Gina replies to and resolves the re-homed comment before Olga undoes the restore.
  const orphanId = orphan.id;
  await G.page.evaluate((id) => {
    window.__dt.dispatch({ op: "replyComment", id, text: "Gina reply", author: "Gina", time: Date.now() });
    window.__dt.dispatch({ op: "resolveComment", id, resolved: true });
  }, orphanId);
  await sleep(1200);
  await undo(O);
  await sleep(1500);
  check("undo of the restore brings the layer back and keeps the comments", !!(await named(O, "Late")) && (await commentTexts(O)).length === 3);
  for (const p of [O, G, V]) {
    const c = (await doc(p)).comments[orphanId];
    check(`undo of the restore: ${p.name} keeps Gina's reply and resolve, and the comment is back on its layer`, c && c.messages.length === 2 && c.resolved && c.node === lateId, c && JSON.stringify({ n: c.messages.length, r: c.resolved, node: c.node }));
  }

  // ---------------- B3: undo keeps tokens a peer uses ----------------
  await ai(O, "define_variables", { collection: "Primitives", variables: [{ name: "Gray", type: "color", value: "#222222" }] });
  await ai(O, "define_variables", { collection: "Theme", modes: ["Light", "Dark"], variables: [{ name: "Surface", type: "color", values: { Light: { alias: "Primitives/Gray" }, Dark: "#000000" } }] });
  await ai(O, "define_styles", { colors: [{ name: "Brand", color: "#6D4AFF" }] });
  await waitUntil(async () => (await varNames(G)).length === 2, 8000);
  await ai(G, "create_nodes", { nodes: [{ type: "rectangle", name: "Gina box", x: 700, y: 400, width: 120, height: 80, bind: { fill: "Theme/Surface" }, fillStyle: "Brand" }] });
  await sleep(1200);
  const ginaId = (await named(G, "Gina box")).id;
  await undo(O);
  await undo(O);
  await undo(O);
  await sleep(1500);
  for (const p of [O, G]) {
    const names = await varNames(p);
    const d = await doc(p);
    check(`undo: ${p.name} still has Theme/Surface and its alias target`, names.includes("Theme/Surface") && names.includes("Primitives/Gray"), names.join(", "));
    check(`undo: ${p.name} still has the Brand style`, d.styles.colors.some((s) => s.name === "Brand"));
    const sid = d.variables.flatMap((c) => c.variables).find((v) => v.name === "Surface")?.id;
    check(`undo: ${p.name}'s copy of Gina's layer is still bound`, !!sid && d.nodes[ginaId]?.bindings?.fill === sid);
  }
  await G.page.evaluate((id) => window.__dt.dispatch({ op: "select", ids: [id] }), ginaId);
  await G.page.getByRole("tab", { name: /design/i }).first().click().catch(() => {});
  await sleep(500);
  const chip = G.page.locator("[data-bound-chip=fill]");
  await chip.waitFor({ timeout: 5000 }).catch(() => {});
  const chipText = (await chip.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  check("undo: Gina's Inspector shows the variable name, not Missing variable", chipText.includes("Surface") && !/Missing variable/.test(await G.page.locator("body").innerText()), chipText);
  await G.page.screenshot({ path: `${OUT}/gina-inspector.png` });
  for (let i = 0; i < 3; i++) await redo(O);
  await sleep(1500);
  check("redo: no duplicate tokens on either side", JSON.stringify(await varNames(O)) === JSON.stringify(await varNames(G)) && (await varNames(O)).length === 2 && (await doc(O)).styles.colors.length === 1, (await varNames(O)).join(", "));

  // Paste into the room, Gina binds, Olga undoes the paste.
  await newFile(L);
  await ai(L, "define_variables", { collection: "Kit", variables: [{ name: "Ink", type: "color", value: "#101010" }] });
  await ai(L, "define_styles", { colors: [{ name: "Kit accent", color: "#FF5500" }], texts: [{ name: "Kit body", fontSize: 14 }] });
  await ai(L, "create_nodes", { nodes: [{ type: "frame", name: "Card", width: 200, height: 100, bind: { fill: "Kit/Ink" }, fillStyle: "Kit accent", children: [{ type: "text", name: "T", text: "Hi", textStyle: "Kit body" }] }] });
  const cardId = (await named(L, "Card")).id;
  const clip = await L.page.evaluate((id) => window.__dt.query({ q: "copy", ids: [id] }), cardId);
  const data = typeof clip === "string" ? clip : JSON.stringify(clip);
  await O.page.evaluate((d) => window.__dt.dispatch({ op: "paste", data: d, parent: null, x: 1000, y: 0 }), data);
  await sleep(1500);
  check("paste: the tokens arrive for both people", (await varNames(G)).includes("Kit/Ink"), (await varNames(G)).join(", "));
  const inkId = (await doc(G)).variables.flatMap((c) => c.variables).find((v) => v.name === "Ink").id;
  const kitStyle = (await doc(G)).styles.colors.find((s) => s.name === "Kit accent").id;
  await ai(G, "create_nodes", { nodes: [{ type: "rectangle", name: "Gina chip", x: 1000, y: 300, width: 40, height: 40 }] });
  const chipId = (await named(G, "Gina chip")).id;
  await G.page.evaluate(([id, v, s]) => window.__dt.dispatch({ op: "update", ids: [id], patch: { bindings: { fill: v }, fillStyle: s } }), [chipId, inkId, kitStyle]);
  await sleep(1200);
  await undo(O);
  await sleep(1500);
  for (const p of [O, G]) {
    const d = await doc(p);
    const names = await varNames(p);
    check(`paste undo: ${p.name} keeps Kit/Ink and the Kit accent style Gina's chip uses`, names.includes("Kit/Ink") && d.styles.colors.some((s) => s.name === "Kit accent"), names.join(", "));
    check(`paste undo: ${p.name} loses the pasted layers and the unused text style`, !Object.values(d.nodes).some((n) => n.name === "Card") && !d.styles.texts.some((s) => s.name === "Kit body"));
    check(`paste undo: ${p.name} keeps Gina's chip`, Object.values(d.nodes).some((n) => n.name === "Gina chip"));
  }

  // ---------------- single user: undo removes unused pasted tokens ----------------
  const S = await person(browser, "Solo2");
  await newFile(S);
  await S.page.evaluate((d) => window.__dt.dispatch({ op: "paste", data: d, parent: null, x: 0, y: 0 }), data);
  await sleep(500);
  check("single user: the paste brought the tokens", (await varNames(S)).includes("Kit/Ink") && (await doc(S)).styles.colors.length === 1);
  await undo(S);
  await sleep(400);
  const sd = await doc(S);
  check("single user: undo removes the pasted layers, variables, collections and styles", !Object.values(sd.nodes).some((n) => n.name === "Card") && sd.variables.length === 0 && sd.styles.colors.length === 0 && sd.styles.texts.length === 0, `${sd.variables.length} collections, ${sd.styles.colors.length} colour styles`);
  await redo(S);
  await sleep(300);
  check("single user: redo brings them back", (await varNames(S)).includes("Kit/Ink"));

  for (const p of [O, G, V, L, S]) check(`${p.name}: no page errors`, p.errors.length === 0, p.errors.join(" | "));
} catch (e) {
  failed++;
  console.log("FAIL  script error: " + (e?.stack ?? e));
} finally {
  await browser.close();
  relay.kill("SIGTERM");
  fs.rmSync(DATA, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} FAILED` : "\nALL PASSED");
process.exit(failed ? 1 : 0);
