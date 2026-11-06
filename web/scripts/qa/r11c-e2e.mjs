// Round 11, package P3: Claude chat bound to its file (L-01 to L-10), against the real bridge
// with the fake Claude CLI. Local servers only: every other request is aborted (the photo and API
// hosts are answered by routes in this file).
//
// Usage: build the bridge (`cargo build -p designotron-bridge`), start the editor with
//   DESIGNOTRON_PORT=<bridge port> npx vite --port <vite port> --strictPort
// then `E2E_URL=http://localhost:<vite port> BRIDGE_PORT=<bridge port> BRIDGE_BIN=<path to the
// designotron binary> node scripts/qa/r11c-e2e.mjs`. The script starts, kills and restarts its own
// bridge (never port+1: that is the LAN share listener).
// Env: E2E_URL (default http://localhost:5931), BRIDGE_PORT (5932), BRIDGE_BIN, CHROMIUM, SHOTS (a
// folder for screenshots).

import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installPhotoFixtures } from "./photos-fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const URL_ = process.env.E2E_URL ?? "http://localhost:5931";
const BRIDGE_PORT = Number(process.env.BRIDGE_PORT ?? 5932);
const BRIDGE_BIN = process.env.BRIDGE_BIN ?? path.join(process.env.CARGO_TARGET_DIR ?? path.join(ROOT, "target"), "debug/designotron");
const FAKE = path.join(ROOT, "web/scripts/fixtures/fake-claude.mjs");
const SHOTS = process.env.SHOTS;
const launch = { headless: true, args: ["--no-sandbox"] };
if (process.env.CHROMIUM) launch.executablePath = process.env.CHROMIUM;
else if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000, step = 100) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      if (await fn()) return true;
    } catch {
      /* keep waiting */
    }
    if (Date.now() > end) return false;
    await sleep(step);
  }
}

// ---- The bridge (started and stopped here; only this process's own child is ever killed) ----
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "r11c-ws-"));
let bridgeProc = null;
async function startBridge() {
  bridgeProc = spawn(BRIDGE_BIN, ["--port", String(BRIDGE_PORT), "--static", path.join(ROOT, "web/dist"), "--workspace", workspace, "--no-open"], {
    env: { ...process.env, CLAUDE_BIN: FAKE },
    stdio: "ignore",
  });
  const up = await until(async () => (await fetch(`http://127.0.0.1:${BRIDGE_PORT}/bridge/status`)).ok, 15000, 200);
  if (!up) throw new Error("the bridge did not start");
}
async function stopBridge() {
  const p = bridgeProc;
  bridgeProc = null;
  if (!p) return;
  const gone = new Promise((r) => p.once("exit", r));
  p.kill("SIGKILL");
  await gone;
}

// ---- The browser ----
const browser = await chromium.launch(launch);
const errors = [];
async function newContext(extra = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, ...extra });
  const fx = await installPhotoFixtures(ctx);
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem("dt:tour-done", "1");
    } catch {
      /* no storage */
    }
  });
  ctx.fx = fx;
  return ctx;
}
async function newPage(ctx) {
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(String(e)));
  return p;
}
const shot = async (p, name) => {
  if (SHOTS) await p.screenshot({ path: path.join(SHOTS, name + ".png") });
};

const names = (p) => p.evaluate(() => Object.values(window.__dt.doc().nodes).map((n) => n.name));
const count = async (p, prefix) => (await names(p)).filter((n) => n.startsWith(prefix)).length;
const chat = (p) => p.evaluate(() => window.__dt.chat());
const itemsText = async (p) => (await chat(p)).items.map((i) => (i.kind === "tool" ? `tool:${i.name}` : `${i.kind}:${i.text ?? ""}`));
const fileIdOf = (p) => p.evaluate(() => location.hash.match(/#\/file\/(\w+)/)?.[1]);
const connected = (p, ms = 15000) => until(() => p.evaluate(() => window.__dt.chat().bridgeStatus === "connected" && window.__dt.chat().claude?.available), ms);
const idle = (p, ms = 30000) => until(() => p.evaluate(() => !window.__dt.chat().running), ms);

async function openApp(p) {
  await p.goto(URL_ + "/", { waitUntil: "load" });
  await p.waitForSelector('button:has-text("New design file")');
}
async function newFile(p) {
  await p.click('button:has-text("New design file")');
  await p.waitForSelector("#dt-canvas");
  await until(() => p.evaluate(() => !!window.__dt.chat().chatFile));
}
async function backToFiles(p) {
  await p.click("button.tbtn >> nth=0");
  await p.click('[role=menuitem]:has-text("Back to files"), button:has-text("Back to files")');
  await p.waitForSelector('button:has-text("New design file")');
}
async function openChat(p) {
  if (!(await p.locator('textarea[aria-label="Message to Claude"]').count())) {
    await p.evaluate(() => document.activeElement?.blur());
    await p.keyboard.press("Control+/");
  }
  await p.waitForSelector('textarea[aria-label="Message to Claude"]');
}
async function say(p, text) {
  await openChat(p);
  const box = p.locator('textarea[aria-label="Message to Claude"]');
  await box.fill(text);
  await box.press("Enter");
}
const sentFrames = (p) => {
  const frames = [];
  frames.focus = 0;
  p.on("websocket", (ws) => {
    if (ws.url().includes("/bridge/ws")) ws.on("framesent", (f) => {
      const s = String(f.payload);
      if (s.includes('"type":"chat"')) frames.push(JSON.parse(s));
      if (s.includes('"type":"focus"')) frames.focus++;
    });
  });
  return frames;
};

try {
  await startBridge();
  const ctx = await newContext();
  const page = await newPage(ctx);
  const frames = sentFrames(page);
  await openApp(page);
  await connected(page);

  // ===== L-01 and L-02: a turn belongs to its file; each file has its own conversation =====
  await newFile(page);
  const A = await fileIdOf(page);
  await say(page, "build in A [calls=6][delay=800][tag=SA]");
  check("A: the turn is running and builds", await until(async () => (await count(page, "SA-")) >= 1, 8000));
  await until(async () => (await chat(page)).sessionId === "fake-session", 5000);
  const sessionInA = (await chat(page)).sessionId;
  await sleep(600);
  await shot(page, "01-a-mid-turn");
  await backToFiles(page);
  await newFile(page);
  const B = await fileIdOf(page);
  check("B is a different file", A && B && A !== B);
  const chatB = await chat(page);
  check("L-02: B starts with an empty conversation", chatB.items.length === 0 && chatB.sessionId === null && chatB.chatFile === B, JSON.stringify({ n: chatB.items.length, s: chatB.sessionId }));
  await sleep(6500);
  check("L-01: nothing of A's turn lands in B", (await count(page, "SA-")) === 0 && (await names(page)).filter((n) => n.startsWith("Frame") || n.startsWith("S")).length === 0, (await names(page)).join(","));
  check("L-01: B's chat shows nothing from A's turn", (await chat(page)).items.length === 0 && !(await chat(page)).running);
  await say(page, "build in B [calls=1][tag=SB]");
  check("B: its own turn runs", await until(async () => (await count(page, "SB-")) === 1, 10000) && (await idle(page)));
  check("L-02: B's first turn is sent with no session", frames.length >= 2 && frames[frames.length - 1].sessionId === null, JSON.stringify(frames.map((f) => f.sessionId)));
  check("B: the new session id is B's own", (await chat(page)).sessionId === "fake-session");
  await shot(page, "02-b-own-conversation");
  const bTranscript = (await itemsText(page)).join("|");

  // Back to A: the turn was stopped and nothing more was built.
  await backToFiles(page);
  await page.evaluate((id) => (location.hash = `#/file/${id}`), A);
  await page.waitForSelector("#dt-canvas");
  await until(async () => (await chat(page)).chatFile === A && (await chat(page)).items.length > 0, 8000);
  const saCount = await count(page, "SA-");
  await sleep(4000);
  check("L-01: A's layer count doesn't change after leaving", (await count(page, "SA-")) === saCount && saCount >= 1 && saCount < 6, `SA-${saCount}`);
  const chatA = await chat(page);
  const textA = (await itemsText(page)).join("|");
  check("L-02: A's conversation is back", /build in A/.test(textA) && !/build in B/.test(textA), textA.slice(0, 200));
  check("L-01: A's transcript says the turn stopped when the file closed", /Stopped: you left this file\./.test(textA));
  check("L-02: A has its Claude Code session again", chatA.sessionId === sessionInA && sessionInA === "fake-session");
  check("A isn't running", !chatA.running);
  await openChat(page);
  await shot(page, "03-a-restored");
  const chunk = await page.locator(".chat-log").innerText();
  check("L-02: A's chat panel shows it", /build in A/.test(chunk) && /Stopped: you left this file/.test(chunk));

  // A reload keeps the conversation (stored per file).
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector("#dt-canvas");
  await until(async () => (await chat(page)).items.length > 0, 8000);
  check("A: after a reload the transcript and session are still there", /build in A/.test((await itemsText(page)).join("|")) && (await chat(page)).sessionId === sessionInA);
  await backToFiles(page);
  await page.evaluate((id) => (location.hash = `#/file/${id}`), B);
  await page.waitForSelector("#dt-canvas");
  await until(async () => (await chat(page)).chatFile === B && (await chat(page)).items.length > 0, 8000);
  check("B: its conversation is restored too, unchanged", (await itemsText(page)).join("|") === bTranscript, (await itemsText(page)).join("|").slice(0, 160));
  const stored = await page.evaluate(async () => {
    const db = await new Promise((r) => {
      const q = indexedDB.open("keyval-store");
      q.onsuccess = () => r(q.result);
    });
    const keys = await new Promise((r) => {
      const q = db.transaction("keyval").objectStore("keyval").getAllKeys();
      q.onsuccess = () => r(q.result.map(String));
    });
    return keys.filter((k) => k.startsWith("dt:chat:"));
  });
  check("each file has its own stored record", stored.length === 2 && stored.includes(`dt:chat:${A}`) && stored.includes(`dt:chat:${B}`), stored.join(","));

  // ===== Failed tool chips say why; a failed result says "Failed" =====
  await say(page, "bad call [tool=no_such_tool][fail]");
  await idle(page);
  const failed = (await chat(page)).items;
  const chip = failed.find((i) => i.kind === "tool" && i.name === "no_such_tool");
  check("a failed tool chip carries its reason", chip && chip.ok === false && !!chip.detail, JSON.stringify(chip));
  check("a failed turn says Failed, not Done", failed.some((i) => i.kind === "system" && /^Failed after/.test(i.text)) && !failed.filter((i) => i.id > (failed.filter((u) => u.kind === "user").pop()?.id ?? 0)).some((i) => i.kind === "system" && /^Done in/.test(i.text)), failed.map((i) => i.text).join("|").slice(-120));

  // ===== L-08: photo results are labelled as results, not as a screenshot =====
  await newFileFromHere(page);
  await say(page, "a photo [photo=coffee beans]");
  await idle(page, 40000);
  const labels = (await chat(page)).items.filter((i) => i.kind === "shot").map((i) => i.label);
  check("L-08: the photo results grid is labelled as photo results", labels.length >= 1 && labels.every((l) => l === "Photo results Claude looked at"), JSON.stringify(labels));

  // ===== Quick action and critique show short labels =====
  await page.evaluate(() => window.__dt.tool("create_nodes", { nodes: [{ type: "frame", name: "Q", x: 0, y: 0, width: 100, height: 100, fill: "#4F46E5" }] }));
  await page.evaluate(() => window.__dt.chatSet({ items: [] }));
  await openChat(page);
  await page.click('button[aria-label="Quick actions"]');
  await page.click('[role=menuitem]:has-text("Rename layers semantically")');
  await until(async () => (await chat(page)).items.some((i) => i.kind === "user"), 5000);
  const userItem = (await chat(page)).items.find((i) => i.kind === "user");
  check("quick actions show their menu label in the bubble", userItem?.text === "Rename layers semantically" && /Rename the layers/.test(userItem.title ?? ""), JSON.stringify(userItem).slice(0, 160));
  await idle(page);

  // ===== L-10: the critique button needs something to critique =====
  await backToFiles(page);
  await newFile(page);
  await page.click('button[role=tab]:has-text("Review"), button:has-text("Review")');
  const critique = page.locator('button:has-text("Ask Claude for a critique")');
  check("L-10: critique is disabled on an empty page", await critique.isDisabled());
  check("L-10: and says why", /Nothing on this page to critique/.test((await critique.getAttribute("title")) ?? ""));
  await page.evaluate(() => window.__dt.tool("create_nodes", { nodes: [{ type: "frame", name: "C", x: 0, y: 0, width: 100, height: 100, fill: "#4F46E5" }] }));
  check("L-10: and enabled once the page has a layer", await until(async () => !(await critique.isDisabled()), 3000));
  await critique.click();
  await until(async () => (await chat(page)).items.some((i) => i.kind === "user"), 5000);
  check("the critique shows 'Critique this page'", (await chat(page)).items.find((i) => i.kind === "user")?.text === "Critique this page");
  await idle(page);

  // ===== Comment label has no internal id =====
  await page.evaluate(() => window.__dt.dispatch({ op: "addComment", x: 10, y: 10, text: "Make the header taller please", author: "Tester", time: Date.now() }));
  await page.evaluate(() => window.__dt.dispatch({ op: "addComment", x: 700, y: 400, text: "second", author: "Tester", time: Date.now() }));
  await page.click('button:has-text("Comments")').catch(() => {});
  await page.evaluate(() => window.__dt.chatSet({ items: [] }));
  const pin = page.locator('.comment-pin[title="Make the header taller please"]');
  await pin.click();
  await page.click('button[title="Ask Claude to handle this"]');
  await until(async () => (await chat(page)).items.some((i) => i.kind === "user"), 5000);
  const commentBubble = (await chat(page)).items.find((i) => i.kind === "user")?.text ?? "";
  check("comment bubble quotes the thread, with no c_ id", /^Address comment: “/.test(commentBubble) && !/c_[a-z0-9]{5}/.test(commentBubble), commentBubble);
  await idle(page);

  // ===== Lost session: the CLI doesn't have it any more =====
  await page.evaluate(() => window.__dt.chatSet({ items: [], sessionId: "missing-session" }));
  await say(page, "after the loss [calls=1][tag=LS]");
  check("a lost session is replaced and the message goes out again", await until(async () => (await count(page, "LS-")) === 1, 10000) && (await idle(page)));
  const lostItems = (await itemsText(page)).join("|");
  check("lost session: the note is shown, no error is", /Started a new Claude Code session/.test(lostItems) && !/error:/.test(lostItems) && !/No conversation found/.test(lostItems), lostItems.slice(0, 200));
  check("lost session: the new session id is kept", (await chat(page)).sessionId === "fake-session");

  // ===== L-06: New conversation ends the running turn =====
  await say(page, "slow one [calls=8][delay=700][tag=NC]");
  await until(async () => (await count(page, "NC-")) >= 1, 8000);
  await page.click('button[aria-label="New conversation"]');
  const ncAt = await count(page, "NC-");
  await sleep(3500);
  const after = await chat(page);
  check("L-06: + stops the turn", !after.running && (await count(page, "NC-")) <= ncAt + 1, `NC-${ncAt} then ${await count(page, "NC-")}`);
  check("L-06: the new conversation stays empty (no tool chips, no stray reply)", after.items.length === 0 && after.sessionId === null, JSON.stringify(after.items.map((i) => i.kind)));
  await shot(page, "04-new-conversation-during-turn");

  // ===== L-07: Stop returns a queued message to the box =====
  await say(page, "long [calls=8][delay=700][tag=QU]");
  await until(async () => (await chat(page)).running, 5000);
  const box = page.locator('textarea[aria-label="Message to Claude"]');
  await box.fill("then do this next");
  await page.click('button:has-text("Queue")');
  check("L-07: the message is queued", await until(async () => (await chat(page)).queued === "then do this next", 3000));
  await page.click('button:has-text("Stop")');
  await sleep(2000);
  const afterStop = await chat(page);
  check("L-07: nothing is sent after Stop", !afterStop.running && afterStop.queued === null && !afterStop.items.some((i) => i.kind === "user" && i.text === "then do this next"), JSON.stringify(afterStop.items.filter((i) => i.kind === "user").map((i) => i.text)));
  check("L-07: the composer holds the text", (await box.inputValue()) === "then do this next", await box.inputValue());
  await shot(page, "05-stop-returns-queue");
  await box.fill("");

  // ===== L-09: a corrupt image and a text file are explained; the good image still attaches =====
  await page.evaluate(() => window.__dt.chatSet({ items: [], pending: [] }));
  await page.evaluate(() => {
    const good = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([1, 2, 3, 4])], "corrupt.png", { type: "image/png" }));
    dt.items.add(new File(["hello"], "notes.txt", { type: "text/plain" }));
    dt.items.add(new File([good], "good.png", { type: "image/png" }));
    document.querySelector(".chat-input").dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await until(async () => (await chat(page)).items.filter((i) => i.kind === "error").length >= 2, 5000);
  const dropped = await chat(page);
  const errs = dropped.items.filter((i) => i.kind === "error").map((i) => i.text);
  check("L-09: one thumbnail (the good file)", dropped.pending.length === 1 && dropped.pending[0].name === "good.png", JSON.stringify(dropped.pending.map((p) => p.name)));
  check("L-09: the corrupt image is named", errs.some((e) => /corrupt\.png/.test(e)), errs.join("|"));
  check("L-09: the text file is named", errs.some((e) => /Only images can be attached \(notes\.txt\)/.test(e)), errs.join("|"));
  check("L-09: no uncaught page error", errors.length === 0, errors.join("|"));
  await shot(page, "06-bad-drop");
  await page.evaluate(() => window.__dt.chatSet({ items: [], pending: [] }));

  // ===== Settings hint uses the bridge this page talks to =====
  await page.click('button[aria-label="Settings"]');
  const hint = await page.locator(".chat").innerText();
  check("settings hint names this bridge's address, not 5174", hint.includes(`:${new globalThis.URL(URL_).port}/mcp`) && !hint.includes(":5174/mcp"), hint.match(/claude mcp add[^\n]*/s)?.[0]?.slice(0, 120));
  await page.click('button[aria-label="Settings"]');

  // ===== L-03: a read-only tab offers no Claude =====
  await backToFiles(page);
  await newFile(page);
  const R = await fileIdOf(page);
  const ro = await newPage(ctx);
  await ro.goto(`${URL_}/#/file/${R}`, { waitUntil: "load" });
  await ro.waitForSelector("#dt-canvas");
  await until(() => ro.evaluate(() => !!window.__dt.state().readOnly), 8000);
  await sleep(500);
  check("L-03: the read-only tab has no 'Design with Claude' card", (await ro.locator("#empty-prompt-input").count()) === 0 && (await ro.locator('button:has-text("Design with Claude")').count()) === 0);
  await ro.evaluate(() => window.__dt.send("hello [calls=1][tag=RO]"));
  await sleep(1500);
  const roChat = await chat(ro);
  check("L-03: sending in a read-only tab runs no turn and says so", !roChat.running && roChat.items.length === 0 && (await ro.locator(".toast").allInnerTexts()).join(" ").includes("view this file but not edit"), (await ro.locator(".toast").allInnerTexts()).join(" "));
  await shot(ro, "07-read-only-tab");
  await ro.close();

  // ===== Phone width: no "Enter to send" hint, and Connect card doesn't push the conversation =====
  const phone = await newPage(await newContext({ viewport: { width: 390, height: 800 }, hasTouch: true }));
  await openApp(phone);
  await connected(phone);
  await newFile(phone);
  await phone.evaluate(() => window.__dt.chatSet({ items: [{ id: 1, kind: "user", text: "hi" }] }));
  await openChat(phone);
  check("phone: no 'Enter to send' hint", !(await phone.locator(".chat-input .kbd-hint").isVisible()));
  await shot(phone, "08-phone-chat");
  await phone.context().close();

  // ===== L-04: the bridge dies mid-turn: the turn ends visibly, with Retry; restart and Retry =====
  const p4 = await newPage(await newContext());
  await openApp(p4);
  await connected(p4);
  await newFile(p4);
  await say(p4, "will be cut [calls=10][delay=700][tag=KL]");
  await until(async () => (await count(p4, "KL-")) >= 2, 8000);
  await stopBridge();
  check("L-04: the turn ends when the bridge goes", await until(async () => !(await chat(p4)).running && (await chat(p4)).bridgeStatus === "offline", 8000));
  const lost = (await chat(p4)).items.find((i) => i.kind === "error");
  check("L-04: the chat says the connection was lost and offers Retry", /Lost the connection to the bridge/.test(lost?.text ?? "") && lost?.retry === "will be cut [calls=10][delay=700][tag=KL]", JSON.stringify(lost));
  check("L-04: the Retry button is there", (await p4.locator("button.retry-btn:has-text('Retry')").count()) === 1);
  check("L-04: the Connect card doesn't open its steps mid-conversation", (await p4.locator(".bridge-setup details").evaluate((d) => d.open)) === false);
  await shot(p4, "09-bridge-lost");
  const built = await count(p4, "KL-");
  await startBridge();
  check("L-04: the page reconnects by itself", await connected(p4, 20000));
  await p4.click("button.retry-btn:has-text('Retry')");
  check("L-04: Retry runs the turn again", await until(async () => (await count(p4, "KL-")) > built, 10000));
  await idle(p4, 30000);
  check("L-04: the clicked Retry button is gone", (await p4.locator("button.retry-btn").count()) === 0);
  await p4.evaluate(() => window.__dt.chatSet({ items: [...window.__dt.chat().items, { id: 9999, kind: "error", text: "old failure", retry: "x" }] }));
  await sleep(900);
  await p4.reload({ waitUntil: "load" });
  await p4.waitForSelector("#dt-canvas");
  await until(async () => (await chat(p4)).items.length > 0, 8000);
  check("a Retry button isn't kept across a reload", (await itemsText(p4)).some((t) => t === "error:old failure") && (await p4.locator("button.retry-btn").count()) === 0);
  await p4.context().close();

  // ===== A call that waits (a photo download, an import's images) writes nothing once its file is closed =====
  const slow = { photo: false, image: false };
  await ctx.route(/^https:\/\/api\.openverse\.org\/v1\/images\/0000000\d-/, async (r) => {
    if (slow.photo) await sleep(2500);
    await r.fallback();
  });
  await ctx.route("**/__slow.png", async (r) => {
    if (slow.image) await sleep(2500);
    await r.fulfill({ status: 200, contentType: "image/png", body: Buffer.alloc(10) }).catch(() => {});
  });
  await backToFiles(page);
  await newFile(page);
  const W = await fileIdOf(page);
  slow.photo = true;
  slow.image = true;
  const photoCall = page.evaluate(() => window.__dt.tool("place_photo", { id: "openverse:00000001-aaaa-4bbb-8ccc-dddddddddddd" }));
  const importCall = page.evaluate(() => window.__dt.tool("import_html", { html: `<div style="width:200px;height:100px;background:#fc0"><img src="${location.origin}/__slow.png" width="50" height="50"></div>` }));
  await sleep(500);
  await backToFiles(page);
  await newFile(page);
  const photoOut = await photoCall;
  const importOut = await importCall;
  await sleep(500);
  check("a photo call that finishes after its file closed is refused", photoOut.ok === false && /left the file/.test(String(photoOut.result)), JSON.stringify(photoOut).slice(0, 160));
  check("an import that finishes after its file closed is refused", importOut.ok === false && /left the file/.test(String(importOut.result)), JSON.stringify(importOut).slice(0, 160));
  check("the next file got no layer from them", (await names(page)).filter((n) => /Photo|Imported|div/i.test(n)).length === 0 && (await page.evaluate(() => Object.keys(window.__dt.doc().nodes).length)) <= 2, (await names(page)).join(","));
  await backToFiles(page);
  await page.evaluate((id) => (location.hash = `#/file/${id}`), W);
  await page.waitForSelector("#dt-canvas");
  await sleep(300);
  check("and the file they started in got none either", (await page.evaluate(() => Object.keys(window.__dt.doc().nodes).length)) <= 2, (await names(page)).join(","));
  slow.photo = false;
  slow.image = false;

  // ===== Unsent text in the box waits in the file's draft (more than one visit) =====
  await openChat(page);
  await page.fill('textarea[aria-label="Message to Claude"]', "half typed idea");
  for (let visit = 1; visit <= 2; visit++) {
    await backToFiles(page);
    await page.evaluate((id) => (location.hash = `#/file/${id}`), W);
    await page.waitForSelector("#dt-canvas");
    await until(async () => (await chat(page)).chatFile === W, 5000);
    await openChat(page);
    const got = await until(async () => (await page.locator('textarea[aria-label="Message to Claude"]').inputValue()) === "half typed idea", 4000);
    check(`the typed text is back in the box after visit ${visit}`, got, await page.locator('textarea[aria-label="Message to Claude"]').inputValue());
  }
  await page.fill('textarea[aria-label="Message to Claude"]', "");

  // ===== The file list isn't the bridge's active tab =====
  await backToFiles(page);
  const focusBefore = frames.focus;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await sleep(500);
  check("a tab on the file list doesn't announce focus", frames.focus === focusBefore);

  // ===== Two tabs on one file: the read-only one never rolls back the editing tab's conversation =====
  await newFile(page);
  const T = await fileIdOf(page);
  await say(page, "first of two [calls=1][tag=T1]");
  await idle(page);
  await sleep(900);
  const tab2 = await newPage(ctx);
  await tab2.goto(`${URL_}/#/file/${T}`, { waitUntil: "load" });
  await tab2.waitForSelector("#dt-canvas");
  await until(() => tab2.evaluate(() => !!window.__dt.state().readOnly), 8000);
  await until(async () => (await chat(tab2)).items.length > 0, 8000);
  check("the read-only tab shows the stored conversation", /first of two/.test((await itemsText(tab2)).join("|")));
  await say(page, "second of two [calls=1][tag=T2]");
  await idle(page);
  await sleep(900);
  const stored2 = () =>
    page.evaluate(async (id) => {
      const db = await new Promise((r) => {
        const q = indexedDB.open("keyval-store");
        q.onsuccess = () => r(q.result);
      });
      return new Promise((r) => {
        const q = db.transaction("keyval").objectStore("keyval").get("dt:chat:" + id);
        q.onsuccess = () => r(JSON.stringify(q.result ?? null));
      });
    }, T);
  check("the editing tab stored both turns", /second of two/.test(await stored2()));
  await tab2.close();
  await sleep(500);
  check("closing the read-only tab last doesn't roll back or delete the record", /second of two/.test(await stored2()) && /first of two/.test(await stored2()));

  // The read-only tab takes over: it picks up the newer conversation. A turn running in the tab that loses the file stops.
  const tab3 = await newPage(ctx);
  await tab3.goto(`${URL_}/#/file/${T}`, { waitUntil: "load" });
  await tab3.waitForSelector("#dt-canvas");
  await until(() => tab3.evaluate(() => !!window.__dt.state().readOnly), 8000);
  await until(async () => (await chat(tab3)).items.length > 0, 8000);
  await say(page, "third of three [calls=8][delay=700][tag=T3]");
  await until(async () => (await chat(page)).running, 5000);
  await until(async () => (await count(page, "T3-")) >= 2, 8000);
  await tab3.getByRole("button", { name: "Edit here instead" }).click();
  check("the other tab becomes the editing tab", await until(async () => !(await tab3.evaluate(() => !!window.__dt.state().readOnly)), 15000));
  check("the tab that lost the file stops its turn and says so", await until(async () => !(await chat(page)).running && /no longer edit this file/.test((await itemsText(page)).join("|")), 15000), (await itemsText(page)).slice(-3).join("|"));
  await sleep(1000);
  check(
    "the new editing tab shows the stop note and the last tool chips of the old one",
    await until(async () => {
      const t = (await itemsText(tab3)).join("|");
      return /second of two/.test(t) && /no longer edit this file/.test(t) && /tool:create_nodes\|system:Stopped: you can no longer/.test(t);
    }, 6000),
    (await itemsText(tab3)).slice(-4).join("|"),
  );
  await tab3.close();

  // ===== L-05: a page loaded while the bridge is down finds it once it starts =====
  await stopBridge();
  const p5 = await newPage(await newContext());
  await openApp(p5);
  await sleep(2500);
  check("L-05: offline at first", (await chat(p5)).bridgeStatus === "offline");
  await startBridge();
  const t0 = Date.now();
  check("L-05: connected within 10 s, without a reload", await connected(p5, 10000), `${Date.now() - t0} ms`);
  await p5.context().close();

  // ===== API mode: the same file binding (Messages API answered by a route here) =====
  const apiCtx = await newContext();
  await apiCtx.addInitScript(() => {
    localStorage.setItem("dt:apiKey", "sk-ant-test");
    localStorage.setItem("dt:chatMode", "api");
  });
  const api = { requests: 0 };
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS" };
  const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  const toolReply = (id, name, input) =>
    sse([
      { type: "message_start", message: { id: "msg_" + id, type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
      { type: "message_stop" },
    ]);
  await apiCtx.route(/^https:\/\/api\.anthropic\.com\//, async (r) => {
    if (r.request().method() === "OPTIONS") return r.fulfill({ status: 204, headers: cors });
    api.requests++;
    const n = api.requests;
    // The first answer builds a layer at once; the second waits (the person leaves meanwhile).
    if (n === 1) return r.fulfill({ status: 200, headers: { ...cors, "content-type": "text/event-stream" }, body: toolReply("toolu_a1", "create_nodes", { nodes: [{ type: "frame", name: "API-0", x: 0, y: 0, width: 100, height: 100, fill: "#4F46E5" }] }) });
    await sleep(4000);
    await r.fulfill({ status: 200, headers: { ...cors, "content-type": "text/event-stream" }, body: toolReply("toolu_a2", "create_nodes", { nodes: [{ type: "frame", name: "API-1", x: 200, y: 0, width: 100, height: 100, fill: "#4F46E5" }] }) }).catch(() => {});
  });
  const pa = await newPage(apiCtx);
  await openApp(pa);
  await newFile(pa);
  const apiFileA = await fileIdOf(pa);
  await say(pa, "api build");
  check("API: the first call builds in A", await until(async () => (await count(pa, "API-")) === 1, 10000));
  await sleep(500);
  await backToFiles(pa);
  await newFile(pa);
  await sleep(6000);
  check("API: nothing lands in the next file", (await count(pa, "API-")) === 0 && (await chat(pa)).items.length === 0 && !(await chat(pa)).running, (await itemsText(pa)).join("|"));
  await pa.evaluate((id) => (location.hash = `#/file/${id}`), apiFileA);
  await pa.waitForSelector("#dt-canvas");
  await until(async () => (await chat(pa)).items.length > 0, 8000);
  check("API: A has one layer and its transcript, with the stop note", (await count(pa, "API-")) === 1 && /Stopped: you left this file\./.test((await itemsText(pa)).join("|")));
  check("API: reopening in the same session says nothing about lost messages (they are still in memory)", !/Claude doesn't have the messages above any more/.test((await itemsText(pa)).join("|")));
  await pa.reload({ waitUntil: "load" });
  await pa.waitForSelector("#dt-canvas");
  await until(async () => (await chat(pa)).items.length > 0, 8000);
  await say(pa, "api again");
  await sleep(500);
  check("API: after a reload the transcript is back and a note says Claude lost its messages", /Claude doesn't have the messages above any more/.test((await itemsText(pa)).join("|")));
  await pa.context().close();

  check("no uncaught page errors in the whole run", errors.length === 0, errors.join("|"));
} catch (err) {
  check("script ran to the end", false, String(err?.stack ?? err));
} finally {
  await stopBridge();
  await browser.close();
  fs.rmSync(workspace, { recursive: true, force: true });
}

async function newFileFromHere(p) {
  await backToFiles(p);
  await newFile(p);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
