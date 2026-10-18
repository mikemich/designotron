// Bridge integration test: editor (via Vite dev server) + bridge + MCP.
// Requires `npm run dev` (5173) and the bridge (5174) running.
// Set E2E_CLAUDE=1 to also run one real Claude Code chat turn (uses your Claude login).

import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const URL = process.env.E2E_URL ?? "http://localhost:5173";
const MCP = process.env.E2E_MCP ?? "http://127.0.0.1:5174/mcp";
const OUT = process.env.E2E_OUT ?? "test-results";
fs.mkdirSync(OUT, { recursive: true });

const launch = { headless: true, args: ["--no-sandbox"] };
if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";
if (process.env.HTTPS_PROXY) launch.proxy = { server: process.env.HTTPS_PROXY, bypass: "localhost,127.0.0.1" };

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

let rpcId = 1;
async function mcp(method, params) {
  const r = await fetch(MCP, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
  });
  return r.json();
}

const browser = await chromium.launch(launch);
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 }, ignoreHTTPSErrors: true })).newPage();
try {
  await page.goto(URL);
  await page.waitForSelector(".files");
  await page.click("text=Open sample").catch(() => page.click(".file-card"));
  await page.waitForSelector("#dt-canvas");
  await page.waitForFunction(() => window.__dt.chat().bridgeStatus === "connected", null, { timeout: 15000 });
  check("editor connects to bridge", true);

  const init = await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
  check("MCP initialize", init.result?.serverInfo?.name === "designotron");

  const created = await mcp("tools/call", {
    name: "create_nodes",
    arguments: { nodes: [{ type: "frame", name: "From MCP", x: 0, y: -400, width: 300, height: 200, fill: "#14AE5C", cornerRadius: 24 }] },
  });
  const id = JSON.parse(created.result.content.at(-1).text).created[0].id;
  await page.waitForTimeout(200);
  const inEditor = await page.evaluate((id) => window.__dt.doc().nodes[id]?.name, id);
  check("MCP tool call edits the live editor", inEditor === "From MCP", id);

  const shot = await mcp("tools/call", { name: "get_screenshot", arguments: { id } });
  const img = shot.result.content.find((c) => c.type === "image");
  check("MCP get_screenshot returns PNG", !!img && img.data.length > 500, img ? `${img.data.length} b64 chars` : JSON.stringify(shot).slice(0, 200));

  const undoable = await page.evaluate(() => window.__dt.state().canUndo);
  check("MCP edits are undoable in the editor", undoable);

  if (process.env.E2E_CLAUDE) {
    await page.keyboard.press("Control+/");
    await page.waitForSelector(".chat textarea");
    await page.fill(".chat textarea", "Use get_document, then answer in one short sentence: how many top-level layers are on this page?");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => {
      const s = window.__dt.chat();
      return !s.running && s.items.some((i) => i.kind === "system" || i.kind === "error");
    }, null, { timeout: 240000 });
    const items = await page.evaluate(() => window.__dt.chat().items);
    const tools = items.filter((i) => i.kind === "tool").map((i) => i.name);
    const answer = items.filter((i) => i.kind === "assistant").map((i) => i.text).join(" ");
    const errors = items.filter((i) => i.kind === "error").map((i) => i.text);
    check("Claude Code chat used the design tools", tools.includes("get_document"), tools.join(", "));
    check("Claude Code chat answered", answer.length > 0 && !errors.length, (answer || errors.join(" | ")).slice(0, 200));
    await page.screenshot({ path: path.join(OUT, "bridge-chat.png") });
  }
} catch (err) {
  check("unexpected exception", false, String(err));
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
