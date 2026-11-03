#!/usr/bin/env node
// A stand-in for the `claude` CLI, for testing the bridge's chat plumbing without a real turn
// (set CLAUDE_BIN to this file). It answers `--version`, reads the MCP server entry from
// `--mcp-config` (inline JSON or a file), calls create_nodes through the bridge's MCP endpoint
// with the headers from that entry, and prints stream-json events like Claude Code does.
//
// The prompt can steer it:
//   [tag=X]        names of the layers it makes: X-0, X-1, ... (default L)
//   [calls=N]      how many create_nodes calls (default 3)
//   [delay=MS]     pause before each call (default 0)
//   [tool=NAME]    make one call of this tool (empty arguments) instead, e.g. get_screenshot
//   [fail]         end with an error result
// It says which tab and turn it was configured for ("conn=4 turn=2") in its reply.

import fs from "node:fs";

const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  console.log("2.1.999 (fake)");
  process.exit(0);
}

const prompt = argv[argv.indexOf("-p") + 1] ?? "";
const opt = (name, fallback) => prompt.match(new RegExp(`\\[${name}=([^\\]]*)\\]`))?.[1] ?? fallback;
const tag = opt("tag", "L");
const calls = Number(opt("calls", 3));
const delay = Number(opt("delay", 0));
const tool = opt("tool", "");

const raw = argv[argv.indexOf("--mcp-config") + 1] ?? "{}";
const config = JSON.parse(raw.trim().startsWith("{") ? raw : fs.readFileSync(raw, "utf8"));
const server = config.mcpServers?.designotron ?? {};
const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", ...(server.headers ?? {}) };

const emit = (event) => console.log(JSON.stringify(event));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let rpc = 1;

async function callTool(name, args) {
  const started = Date.now();
  const res = await fetch(server.url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: rpc++, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await res.json();
  return { ...body.result, ms: Date.now() - started };
}

emit({
  type: "system",
  subtype: "init",
  session_id: "fake-session",
  mcp_servers: [{ name: "designotron", status: server.url ? "connected" : "failed" }],
  alwaysLoad: server.alwaysLoad === true,
});
emit({ type: "assistant", message: { content: [{ type: "text", text: `conn=${headers["X-Designotron-Editor"]} turn=${headers["X-Designotron-Turn"]}` }] } });

const started = Date.now();
for (let i = 0; i < (tool ? 1 : calls); i++) {
  await sleep(delay);
  const name = tool || "create_nodes";
  const args = tool ? {} : { nodes: [{ type: "frame", name: `${tag}-${i}`, x: i * 120, y: 0, width: 100, height: 100, fill: "#4F46E5" }] };
  const id = `toolu_${i}`;
  emit({ type: "assistant", message: { content: [{ type: "tool_use", id, name: `mcp__designotron__${name}`, input: args }] } });
  const out = await callTool(name, args);
  const text = out.content?.map((c) => c.text ?? "").join("") ?? "";
  emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: !!out.isError, content: text }] } });
}
emit({ type: "assistant", message: { content: [{ type: "text", text: "Made it." }] } });
emit({
  type: "result",
  subtype: prompt.includes("[fail]") ? "error" : "success",
  is_error: prompt.includes("[fail]"),
  result: prompt.includes("[fail]") ? "fake failure" : "Made it.",
  duration_ms: Date.now() - started,
  total_cost_usd: 0.0123,
  session_id: "fake-session",
});
