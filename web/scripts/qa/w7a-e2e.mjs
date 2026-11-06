// Claude session plumbing (W7-A): per-tab routing, one undo step per chat turn, tab close,
// plain MCP calls following the focused tab, the headless file, and API-mode Stop + queue.
// No real Claude turn is sent: the bridge must run with CLAUDE_BIN pointing at the fake CLI.
//
//   CLAUDE_BIN=$PWD/web/scripts/fixtures/fake-claude.mjs designotron --port 5302 --workspace <ws> \
//     --static web/dist --no-open
//   E2E_URL=http://localhost:5301 E2E_MCP=http://127.0.0.1:5302/mcp E2E_WORKSPACE=<ws> \
//     node web/scripts/qa/w7a-e2e.mjs
//
// E2E_URL serves the editor (vite with DESIGNOTRON_PORT=<bridge>, or the bridge itself).

import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const URL = process.env.E2E_URL ?? "http://localhost:5301";
const MCP = process.env.E2E_MCP ?? "http://127.0.0.1:5302/mcp";
const WORKSPACE = process.env.E2E_WORKSPACE;
const launch = { headless: true, args: ["--no-sandbox"] };
if (process.env.CHROMIUM) launch.executablePath = process.env.CHROMIUM;
else if (fs.existsSync("/opt/pw-browsers/chromium")) launch.executablePath = "/opt/pw-browsers/chromium";

let failed = 0;
function check(name, ok, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let rpcId = 1;
async function mcp(name, args, headers = {}) {
  const started = Date.now();
  const r = await fetch(MCP, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name, arguments: args } }),
  });
  const j = await r.json();
  return { ...j.result, ms: Date.now() - started };
}

const browser = await chromium.launch(launch);
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
await context.route("**/*", (route) => {
  const u = route.request().url();
  if (u.startsWith("data:") || u.startsWith("blob:") || /^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(u)) return route.continue();
  return route.abort();
});

async function openTab(ctx = context) {
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    try {
      localStorage.setItem("dt:tour-done", "1");
    } catch {
      /* no storage */
    }
  });
  page.on("pageerror", (e) => check("no page errors", false, String(e)));
  await page.goto(URL);
  await page.click("button:has-text('New design file')");
  await page.waitForSelector("#dt-canvas");
  await page.waitForFunction(() => window.__dt.chat().bridgeStatus === "connected" && window.__dt.chat().claude?.available, null, { timeout: 15000 });
  return page;
}
/** The tab reports focus, as it does when the person switches to it. */
async function focusTab(page) {
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await sleep(300);
}
const names = (page, prefix) =>
  page.evaluate((p) => Object.values(window.__dt.doc().nodes).filter((n) => n.name.startsWith(p)).map((n) => n.name), prefix);
const chat = (page) => page.evaluate(() => window.__dt.chat());
const doneIn = (page, timeout = 30000) =>
  page.waitForFunction(() => !window.__dt.chat().running && window.__dt.chat().items.some((i) => i.text?.startsWith("Done in")), null, { timeout });
/** The secret of the turn's MCP config, as the fake CLI reported it. */
const connOf = async (page) => {
  const t = (await chat(page)).items.map((i) => i.text ?? "").join("\n");
  return t.match(/conn=([0-9a-f]+)/)?.[1] ?? "";
};
const undoCount = (page) => page.evaluate(() => window.__dt.state().canUndo);

try {
  const A = await openTab();
  const B = await openTab();
  await focusTab(A);

  // 1. A chat in tab A reaches tab A only.
  await A.keyboard.press("Control+/");
  await A.waitForSelector(".chat-input textarea");
  await A.fill(".chat-input textarea", "[tag=A] make three layers");
  await A.keyboard.press("Enter");
  await doneIn(A);
  const a1 = await chat(A);
  const b1 = await chat(B);
  check("tab A shows 3 tool chips and Done", a1.items.filter((i) => i.kind === "tool" && i.name === "create_nodes" && i.ok === true).length === 3);
  check("tab B gets no chat events and isn't running", b1.items.length === 0 && !b1.running, `items=${b1.items.length}`);
  check("A's document has the 3 layers", (await names(A, "A-")).length === 3);
  check("B's document has none", (await names(B, "A-")).length === 0 && (await names(B, "L-")).length === 0);
  const connA = await connOf(A);
  check("the fake CLI got a random run secret in the MCP config", /^[0-9a-f]{32}$/.test(connA), `conn=${connA}`);
  check("the Done line has no cost, the title carries it", await A.evaluate(() => {
    const d = window.__dt.chat().items.find((i) => i.text?.startsWith("Done in"));
    return !!d && !d.text.includes("$") && /API-equivalent, not billed/.test(d.title ?? "");
  }));

  // 2. One undo step for the whole turn; redo restores all.
  await A.evaluate(() => document.activeElement?.blur());
  await A.keyboard.press("Control+z");
  check("one Ctrl+Z removes all 3 layers", (await names(A, "A-")).length === 0);
  await A.keyboard.press("Control+Shift+z");
  check("one Ctrl+Shift+Z restores all 3", (await names(A, "A-")).length === 3);

  // The user's own edit in the middle of a turn is its own step.
  await A.evaluate(() => {
    const id = Object.values(window.__dt.doc().nodes).find((n) => n.name === "A-0").id;
    window.__dt.dispatch({ op: "update", ids: [id], patch: { name: "Renamed by hand" } });
  });
  await A.keyboard.press("Control+z");
  check("a hand edit after the turn is undone alone", (await names(A, "A-")).length === 3 && (await names(A, "Renamed")).length === 0);
  await A.keyboard.press("Control+z");
  check("then the turn", (await names(A, "A-")).length === 0);

  // 3. Chats in both tabs at once: neither is killed.
  await B.keyboard.press("Control+/");
  await Promise.all([
    A.evaluate(() => { window.__dt.send("[tag=A2][delay=700] go"); }),
    B.evaluate(() => { window.__dt.send("[tag=B2][delay=700] go"); }),
  ]);
  await Promise.all([doneIn(A), doneIn(B)]);
  const a3 = await chat(A);
  const b3 = await chat(B);
  check("both chats finished, neither was stopped or failed", ![...a3.items, ...b3.items].some((i) => i.kind === "error" || i.text === "Stopped."));
  check("each tab got its own 3 layers", (await names(A, "A2-")).length === 3 && (await names(B, "B2-")).length === 3 && (await names(A, "B2-")).length === 0 && (await names(B, "A2-")).length === 0);
  check("each chat had its own editor id", (await connOf(A)) !== (await connOf(B)));

  // 4. Closing a tab fails its pending call at once (no 180 s wait, no rerouting).
  const C = await openTab();
  await focusTab(C);
  await C.evaluate(() => { window.__dt.send("[tag=C] go"); });
  await doneIn(C);
  const connC = await connOf(C);
  const frame = await C.evaluate(() => Object.values(window.__dt.doc().nodes).find((n) => n.name === "C-0").id);
  // A busy page doesn't answer: the call (no secret, so it goes to the active tab C) is pending when the tab goes away.
  await C.evaluate(() => {
    setTimeout(() => {
      const t = Date.now();
      while (Date.now() - t < 4000);
    }, 0);
  });
  const pendingCall = mcp("get_screenshot", { id: frame });
  await sleep(300);
  const closing = C.close({ runBeforeUnload: false }).catch(() => {});
  const reply = await pendingCall;
  await closing;
  check("a call pending on a closed tab fails in under 5 s", reply.ms < 5000 && reply.isError === true, `${reply.ms} ms`);
  check("with the closed-before-answering message", /closed before it answered/.test(reply.content?.at(-1)?.text ?? ""), reply.content?.at(-1)?.text);
  const late = await mcp("get_document", {}, { "X-Designotron-Editor": connC });
  check("a later call for that tab fails instead of editing another tab", late.isError === true && /closed/.test(late.content?.[0]?.text ?? ""), late.content?.[0]?.text);
  check("the other tabs are still connected and did not receive it", (await names(A, "C-")).length === 0 && (await names(B, "C-")).length === 0);

  // 5. A call with no headers goes to the most recently focused tab.
  await focusTab(B);
  const toB = await mcp("create_nodes", { nodes: [{ type: "frame", name: "Plain-B", x: 0, y: 300, width: 50, height: 50 }] });
  await sleep(200);
  check("plain MCP call lands in the focused tab (B)", !toB.isError && (await names(B, "Plain-B")).length === 1 && (await names(A, "Plain-B")).length === 0);
  await focusTab(A);
  const toA = await mcp("create_nodes", { nodes: [{ type: "frame", name: "Plain-A", x: 0, y: 300, width: 50, height: 50 }] });
  await sleep(200);
  check("then in A after A is focused", !toA.isError && (await names(A, "Plain-A")).length === 1 && (await names(B, "Plain-A")).length === 0);
  check("a plain call is its own undo step", await A.evaluate(() => {
    window.__dt.dispatch({ op: "undo" });
    return !Object.values(window.__dt.doc().nodes).some((n) => n.name === "Plain-A") && Object.values(window.__dt.doc().nodes).some((n) => n.name === "A2-0");
  }));

  // 6. The headless file follows the focused tab (and only that tab).
  if (WORKSPACE) {
    const file = path.join(WORKSPACE, "design.dtron.json");
    const inFile = () => {
      const doc = JSON.parse(fs.readFileSync(file, "utf8")).document;
      return Object.values(doc.nodes).map((n) => n.name);
    };
    await focusTab(A);
    await sleep(500);
    let f = inFile();
    check("file holds the focused tab's document (A)", f.includes("A2-0") && !f.includes("B2-0"));
    await focusTab(B);
    await sleep(500);
    f = inFile();
    check("then B's after B is focused", f.includes("B2-0") && !f.includes("A2-0"));
    // An edit in the unfocused tab doesn't overwrite it.
    await A.evaluate(() => window.__dt.dispatch({ op: "update", ids: [Object.values(window.__dt.doc().nodes).find((n) => n.name === "A2-0").id], patch: { name: "A-late" } }));
    await sleep(1500);
    check("an unfocused tab's edit isn't written", !inFile().includes("A-late") && inFile().includes("B2-0"));
  } else {
    console.log("SKIP  headless file checks (set E2E_WORKSPACE)");
  }

  // A call that arrives during the person's drag waits for it, and survives the drag's next step.
  await focusTab(B);
  await B.evaluate(() => {
    window.__dt.tool("create_nodes", { nodes: [{ type: "rectangle", name: "Dragged", x: 200, y: 600, width: 120, height: 120, fill: "#f00" }] });
    window.__dt.zoomToFit();
  });
  await sleep(300);
  const at = async (x, y) => {
    const box = await B.locator("#dt-canvas").boundingBox();
    const v = await B.evaluate(() => window.__dt.viewport());
    return { x: box.x + v.x + x * v.zoom, y: box.y + v.y + y * v.zoom, zoom: v.zoom };
  };
  const from = await at(260, 660);
  await B.mouse.move(from.x, from.y);
  await B.mouse.down();
  for (let i = 1; i <= 5; i++) {
    await B.mouse.move(from.x + 10 * i, from.y);
    await sleep(15);
  }
  const during = mcp("create_nodes", { nodes: [{ type: "frame", name: "DuringDrag", x: 0, y: 900, width: 30, height: 30 }] });
  await sleep(500);
  check("the call waits while the drag is on", (await names(B, "DuringDrag")).length === 0);
  for (let i = 6; i <= 10; i++) {
    await B.mouse.move(from.x + 10 * i, from.y);
    await sleep(15);
  }
  await B.mouse.up();
  const dragReply = await during;
  await sleep(200);
  check("then it is applied", !dragReply.isError && (await names(B, "DuringDrag")).length === 1, JSON.stringify(dragReply.content?.at(-1)?.text).slice(0, 100));
  const movedX = await B.evaluate(() => Object.values(window.__dt.doc().nodes).find((n) => n.name === "Dragged").x);
  check("and the drag itself still landed", movedX > 200, `x=${movedX}`);

  // Editing text in place keeps a gesture open but is no drag: calls don't wait for it.
  await B.evaluate(() => {
    window.__dt.tool("create_nodes", { nodes: [{ type: "text", name: "Copy", text: "Hello", x: 400, y: 600, fontSize: 40 }] });
    window.__dt.zoomToFit();
  });
  await sleep(300);
  await B.evaluate(() => {
    const id = Object.values(window.__dt.doc().nodes).find((n) => n.name === "Copy").id;
    window.__dt.dispatch({ op: "select", ids: [id], mode: "replace" });
    document.activeElement?.blur();
  });
  await B.keyboard.press("Enter");
  await sleep(300);
  check("the text is being edited in place", await B.evaluate(() => !!document.querySelector("textarea, [contenteditable]")));
  const whileEditing = await mcp("create_nodes", { nodes: [{ type: "frame", name: "WhileEditing", x: 0, y: 1000, width: 20, height: 20 }] });
  check("a call during text editing runs promptly", !whileEditing.isError && whileEditing.ms < 500, `${whileEditing.ms} ms`);
  await B.keyboard.press("Escape");

  // 7. With every tab gone, MCP falls back to the headless document.
  await A.close();
  await B.close();
  await sleep(500);
  const headless = await mcp("get_document", {});
  check("with no tab open, MCP answers headless", !headless.isError, (headless.content?.[0]?.text ?? "").slice(0, 80));
  const noTab = await mcp("get_document", {}, { "X-Designotron-Editor": connA });
  check("but a call with a finished chat's secret still fails", noTab.isError === true && /closed/.test(noTab.content?.[0]?.text ?? ""));

  // 8. API mode with a stubbed Messages endpoint: Stop, then a queued message gets its reply.
  const apiCtx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await apiCtx.route("**/*", (route) => {
    const u = route.request().url();
    if (/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(u)) return route.continue();
    return route.abort();
  });
  const api = await apiCtx.newPage();
  await api.addInitScript(() => {
    try {
      localStorage.setItem("dt:tour-done", "1");
      localStorage.setItem("dt:chatMode", "api");
      localStorage.setItem("dt:apiKey", "sk-ant-stub");
      localStorage.setItem("dt:keyChecked", "1");
    } catch {
      /* no storage */
    }
  });
  const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  const message = (blocks, stop) => [
    { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [], model: "claude-opus-5-5", stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
    ...blocks.flatMap((b, index) =>
      b.type === "text"
        ? [
            { type: "content_block_start", index, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index, delta: { type: "text_delta", text: b.text } },
            { type: "content_block_stop", index },
          ]
        : [
            { type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } },
            { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } },
            { type: "content_block_stop", index },
          ],
    ),
    { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  ];
  const requests = [];
  const pairingErrors = [];
  let release = () => {};
  await api.route("**/v1/messages*", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const lastUser = JSON.stringify(body.messages?.at(-1)?.content ?? "");
    requests.push(lastUser);
    // Like the real API: every tool_use needs its tool_result in the very next message.
    const msgs = body.messages ?? [];
    for (let i = 0; i < msgs.length; i++) {
      const ids = (Array.isArray(msgs[i].content) && msgs[i].role === "assistant" ? msgs[i].content : []).filter((b) => b.type === "tool_use").map((b) => b.id);
      const next = msgs[i + 1];
      const got = (Array.isArray(next?.content) ? next.content : []).filter((b) => b.type === "tool_result").map((b) => b.tool_use_id);
      if (ids.length && !ids.every((id) => got.includes(id))) {
        pairingErrors.push(ids.join(","));
        return route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "tool_use ids were found without tool_result blocks immediately after" } }),
        });
      }
    }
    const respond = (blocks, stop) => route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: sse(message(blocks, stop)) });
    // The queued message joins the stopped prompt's turn, so both tags can be in one request.
    if (lastUser.includes("[hang]") && !lastUser.includes("[queued]")) {
      // Never answers: the page aborts it when the person presses Stop.
      await new Promise((r) => (release = r));
      return route.abort().catch(() => {});
    }
    if (lastUser.includes("[slowtool]") && !lastUser.includes("tool_result")) {
      return respond(
        [
          { type: "tool_use", id: "tu_s1", name: "import_html", input: { html: `<html><body><img src="${URL}/__slow.png"><p>slow</p></body></html>` } },
          { type: "tool_use", id: "tu_s2", name: "create_nodes", input: { nodes: [{ type: "frame", name: "AfterStop", width: 40, height: 40 }] } },
        ],
        "tool_use",
      );
    }
    if (lastUser.includes("[tools]") && !lastUser.includes("tool_result")) {
      return respond(
        [
          { type: "tool_use", id: "tu_1", name: "create_nodes", input: { nodes: [{ type: "frame", name: "Api-1", width: 40, height: 40 }] } },
          { type: "tool_use", id: "tu_2", name: "create_nodes", input: { nodes: [{ type: "frame", name: "Api-2", x: 60, width: 40, height: 40 }] } },
        ],
        "tool_use",
      );
    }
    return respond([{ type: "text", text: lastUser.includes("[queued]") ? "Reply to the queued message." : "All done." }], "end_turn");
  });
  api.on("pageerror", (e) => check("no page errors (api)", false, String(e)));
  await api.goto(URL);
  await api.click("button:has-text('New design file')");
  await api.waitForSelector("#dt-canvas");
  await api.keyboard.press("Control+/");
  await api.waitForSelector(".chat-input textarea");

  await api.evaluate(() => { window.__dt.send("[hang] first"); });
  await api.waitForFunction(() => window.__dt.chat().running);
  await sleep(300);
  await api.evaluate(() => { window.__dt.send("[queued] second"); });
  check("the message sent while running is queued", (await chat(api)).queued?.includes("[queued]"));
  await api.click(".chat-input button:has-text('Stop')");
  // Stop returns the queued message to the box (round 11); sending it from there is the same turn.
  await api.waitForFunction(() => document.querySelector(".chat-input textarea").value.includes("[queued]"));
  await api.press(".chat-input textarea", "Enter");
  await api
    .waitForFunction(() => window.__dt.chat().items.some((i) => i.kind === "assistant" && i.text.includes("Reply to the queued message")), null, { timeout: 15000 })
    .catch(async (e) => {
      console.log("requests:", JSON.stringify(requests), "chat:", JSON.stringify((await chat(api)).items), "running:", (await chat(api)).running);
      throw e;
    });
  const apiChat = await chat(api);
  check("Stop, then the queued message gets its reply", true);
  check("no 'aborted' error is shown", !apiChat.items.some((i) => i.kind === "error"), JSON.stringify(apiChat.items.filter((i) => i.kind === "error")));
  check("and the chat is idle afterwards", !apiChat.running);
  release();

  // Stop while a tool is running, with a message queued: the stopped calls are answered (the API
  // would refuse the queued request otherwise) and no further tool runs.
  await apiCtx.route("**/__slow*", async (route) => {
    await sleep(3500);
    await route.fulfill({ status: 200, contentType: "image/png", body: Buffer.alloc(10) }).catch(() => {});
  });
  await api.evaluate(() => { window.__dt.send("[slowtool] third"); });
  await sleep(1200);
  check("the slow tool is running", (await chat(api)).items.some((i) => i.kind === "tool" && i.name === "import_html" && i.ok === null));
  await api.evaluate(() => { window.__dt.send("[queued] fourth"); });
  await api.click(".chat-input button:has-text('Stop')");
  await api.waitForFunction(() => document.querySelector(".chat-input textarea").value.includes("[queued]"));
  await api.press(".chat-input textarea", "Enter");
  await api
    .waitForFunction(() => window.__dt.chat().items.filter((i) => i.kind === "assistant" && i.text.includes("Reply to the queued message")).length >= 2, null, { timeout: 15000 })
    .catch(async (e) => {
      console.log("requests:", JSON.stringify(requests), "pairing:", pairingErrors, "items:", JSON.stringify((await chat(api)).items.map((i) => [i.kind, i.name ?? i.text?.slice(0, 80)])));
      throw e;
    });
  check("the queued message after Stop during a tool is accepted and answered", pairingErrors.length === 0, pairingErrors.join(" | "));
  await sleep(4000);
  check("the stopped run runs no further tool", (await names(api, "AfterStop")).length === 0);
  check("and shows no error", !(await chat(api)).items.some((i) => i.kind === "error"), JSON.stringify((await chat(api)).items.filter((i) => i.kind === "error")));

  // API mode groups its tool calls too: one Ctrl+Z undoes the run.
  await api.evaluate(() => { window.__dt.send("[tools] build"); });
  await api.waitForFunction(() => !window.__dt.chat().running && window.__dt.chat().items.some((i) => i.kind === "assistant" && i.text === "All done."), null, { timeout: 15000 });
  check("API run made both layers", (await names(api, "Api-")).length === 2);
  await api.evaluate(() => document.activeElement?.blur());
  await api.keyboard.press("Control+z");
  check("one Ctrl+Z undoes the API run", (await names(api, "Api-")).length === 0);

  // An API error is shown as the API's message, not as raw JSON.
  await api.unroute("**/v1/messages*");
  await api.route("**/v1/messages*", (route) =>
    route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "max_tokens is too large for this model" } }) }),
  );
  await api.evaluate(() => { window.__dt.send("this one fails"); });
  await api.waitForFunction(() => window.__dt.chat().items.some((i) => i.kind === "error"), null, { timeout: 15000 });
  const err = (await chat(api)).items.find((i) => i.kind === "error").text;
  check("API errors show the message, not raw JSON", err.includes("max_tokens is too large") && !err.includes("{"), err);
} catch (e) {
  check("script ran to the end", false, String(e?.stack ?? e));
} finally {
  await browser.close();
}
console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
