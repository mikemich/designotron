// Multiplayer end to end: an owner shares through the bridge, a guest joins the link,
// both edit, presence shows, and undo never reverts the other person's work.
// Needs the bridge serving the built editor: `npm run build` then the bridge on 5174.

import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const OWNER = process.env.E2E_URL ?? "http://127.0.0.1:5174";
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
  await owner.fill(".share-dialog input.textinput", "Olga");
  await owner.click("button:has-text('Start sharing')");
  await owner.waitForFunction(() => window.__dt.collab().status === "live", null, { timeout: 10000 });
  const link = await owner.evaluate(() => window.__dt.collab().link);
  check("owner starts a share link", /\/\?collab=[0-9a-f]{32}$/.test(link), link);
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

  // A wrong token is refused.
  const bad = await guest.evaluate(async (url) => {
    const u = new URL(url);
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://${u.host}/collab/ws?token=nope`);
      ws.onopen = () => resolve("open");
      ws.onerror = () => resolve("refused");
    });
  }, link);
  check("share listener refuses a wrong token", bad === "refused", bad);
} catch (err) {
  check("unexpected exception", false, String(err));
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
