// Multiplayer end to end: an owner shares through the bridge, a guest joins the link,
// both edit, presence shows, and undo never reverts the other person's work.
// LAN mode (default) needs the bridge serving the built editor on 5174.
// Online mode: E2E_RELAY=http://127.0.0.1:8787 node scripts/collab-e2e.mjs with
// `designotron-relay --static web/dist` running; the owner opens the editor from E2E_URL.
// With E2E_RELAY_BIN=target/debug/designotron-relay the script runs an in-memory relay
// itself and also restarts it mid-session (what free hosts do when they sleep).

import { spawn } from "node:child_process";
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const OWNER = process.env.E2E_URL ?? "http://127.0.0.1:5174";
const RELAY = process.env.E2E_RELAY ?? "";
const OUT = process.env.E2E_OUT ?? "test-results";
fs.mkdirSync(OUT, { recursive: true });
const launch = { headless: true, args: ["--no-sandbox"] };
if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";
if (process.env.HTTPS_PROXY) launch.proxy = { server: process.env.HTTPS_PROXY, bypass: "localhost,127.0.0.1,192.0.2.2,10.*,192.168.*,172.16.*" };

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
const init = () => {
  try {
    localStorage.setItem("dt:tour-done", "1");
  } catch {
    /* sandboxed frames */
  }
};

const RELAY_BIN = RELAY && process.env.E2E_RELAY_BIN;
let relay = null;
async function startRelay() {
  relay = spawn(RELAY_BIN, ["--port", new URL(RELAY).port, "--static", "dist"], { stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    if (await fetch(`${RELAY}/health`).then((r) => r.ok, () => false)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("relay didn't start");
}
if (RELAY_BIN) await startRelay();

const browser = await chromium.launch(launch);
const owner = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
const guest = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
await owner.addInitScript(init);
await guest.addInitScript(() => {
  try {
    localStorage.setItem("dt:tour-done", "1");
    localStorage.setItem("dt:userName", "Gina");
  } catch {
    /* sandboxed frames */
  }
});
const nodes = (p) => p.evaluate(() => window.__dt.doc().nodes);
try {
  await owner.goto(OWNER);
  await owner.click("button:has-text('New design file')");
  await owner.waitForSelector("#dt-canvas");
  const rect = await owner.evaluate(() => window.__dt.dispatch({ op: "ai", tool: "create_nodes", input: { nodes: [{ type: "rectangle", name: "Shared box", x: 0, y: 0, width: 120, height: 80, fill: "#6D4AFF" }] } }).created[0].id);
  await owner.click(".tbtn[title='Share for live editing']");
  await owner.fill(".share-dialog input.textinput >> nth=0", "Olga");
  if (RELAY) {
    await owner.fill(".share-dialog input.mono", RELAY);
    await owner.click("button:has-text('Share online')");
  } else {
    await owner.click("button:has-text('Share on this network')");
  }
  await owner.waitForFunction(() => window.__dt.collab().status === "live", null, { timeout: 10000 });
  const link = await owner.evaluate(() => window.__dt.collab().link);
  check(`owner starts a ${RELAY ? "online" : "LAN"} share link`, RELAY ? link.startsWith(RELAY + "/?room=") : /\/\?collab=[0-9a-f]{32}$/.test(link), link);
  await owner.keyboard.press("Escape");
  await owner.click(".modal-head .ibtn[title='Close']").catch(() => {});

  await guest.goto(link);
  await guest.waitForSelector("#dt-canvas");
  await guest.waitForFunction((id) => window.__dt.collab().status === "live" && !!window.__dt.doc().nodes[id], rect, { timeout: 15000 });
  check("guest joins and receives the file", true);

  await owner.evaluate((id) => window.__dt.dispatch({ op: "update", ids: [id], patch: { x: 200 } }), rect);
  await guest.waitForFunction((id) => window.__dt.doc().nodes[id]?.x === 200, rect, { timeout: 5000 }).catch(() => {});
  check("owner's edit appears for the guest", (await nodes(guest))[rect]?.x === 200);

  const theirs = await guest.evaluate(() => window.__dt.dispatch({ op: "ai", tool: "create_nodes", input: { nodes: [{ type: "ellipse", name: "Guest dot", x: 400, y: 0, width: 60, height: 60, fill: "#0FA958" }] } }).created[0].id);
  await owner.waitForFunction((id) => !!window.__dt.doc().nodes[id], theirs, { timeout: 5000 }).catch(() => {});
  check("guest's edit appears for the owner", !!(await nodes(owner))[theirs]);

  // Undo on the owner reverts the owner's move only.
  await owner.evaluate(() => window.__dt.dispatch({ op: "undo" }));
  const o = await nodes(owner);
  await guest.waitForFunction((id) => window.__dt.doc().nodes[id]?.x === 0, rect, { timeout: 5000 }).catch(() => {});
  const g = await nodes(guest);
  check("undo keeps the collaborator's work", o[rect]?.x === 0 && !!o[theirs] && g[rect]?.x === 0 && !!g[theirs], `owner x=${o[rect]?.x}, guest x=${g[rect]?.x}, dot ${!!o[theirs]}/${!!g[theirs]}`);

  // Presence: the owner's cursor shows up for the guest with their name.
  const box = await owner.locator("#dt-canvas").boundingBox();
  await owner.mouse.move(box.x + 300, box.y + 300);
  await owner.mouse.move(box.x + 320, box.y + 310);
  await guest.waitForSelector(".remote-cursor", { timeout: 5000 }).catch(() => {});
  const label = await guest.locator(".remote-cursor span").first().textContent().catch(() => "");
  check("owner's cursor appears for the guest", label === "Olga", label);
  const avatars = await owner.locator(".peer-avatars .avatar").count();
  check("owner sees the guest's avatar", avatars === 1, `${avatars}`);

  // Comments sync too.
  await guest.evaluate(() => window.__dt.dispatch({ op: "addComment", x: 10, y: 10, text: "Looks good", author: "Gina", time: Date.now() }));
  await owner.waitForFunction(() => Object.values(window.__dt.doc().comments).some((c) => c.messages[0].text === "Looks good"), null, { timeout: 5000 }).catch(() => {});
  check("comments sync between collaborators", await owner.evaluate(() => Object.values(window.__dt.doc().comments).some((c) => c.messages[0].text === "Looks good")));
  await guest.screenshot({ path: path.join(OUT, "collab-guest.png") });

  if (RELAY_BIN) {
    // The relay restarts and forgets every room; the editors reconnect and put the file back.
    relay.kill();
    await new Promise((r) => relay.once("exit", r));
    await startRelay();
    for (const p of [owner, guest]) {
      await p.waitForFunction(() => window.__dt.collab().status === "connecting", null, { timeout: 5000 }).catch(() => {});
      await p.waitForFunction(() => window.__dt.collab().status === "live", null, { timeout: 15000 }).catch(() => {});
    }
    const late = await (await browser.newContext()).newPage();
    await late.addInitScript(init);
    await late.goto(link);
    await late.waitForSelector("#dt-canvas");
    await late.waitForFunction(() => window.__dt.collab().status === "live", null, { timeout: 15000 }).catch(() => {});
    await late.waitForFunction(([a, b]) => !!window.__dt.doc().nodes[a] && !!window.__dt.doc().nodes[b], [rect, theirs], { timeout: 15000 }).catch(() => {});
    const n = await nodes(late);
    check("after a relay restart, a newcomer still gets the whole file", !!n[rect] && !!n[theirs]);
    await owner.evaluate((id) => window.__dt.dispatch({ op: "update", ids: [id], patch: { y: 150 } }), rect);
    await late.waitForFunction((id) => window.__dt.doc().nodes[id]?.y === 150, rect, { timeout: 5000 }).catch(() => {});
    check("edits flow again after the restart", (await nodes(late))[rect]?.y === 150);
  }

  // A wrong token (or a too-short room id) is refused.
  const bad = await guest.evaluate(async (url) => {
    const u = new URL(url);
    return new Promise((resolve) => {
      const ws = new WebSocket(u.searchParams.has("room") ? `ws://${u.host}/ws?room=nope` : `ws://${u.host}/collab/ws?token=nope`);
      ws.onopen = () => resolve("open");
      ws.onerror = () => resolve("refused");
    });
  }, link);
  check("share listener refuses a wrong token", bad === "refused", bad);
} catch (err) {
  check("unexpected exception", false, String(err));
} finally {
  await browser.close();
  relay?.kill();
}
process.exit(failed ? 1 : 0);
