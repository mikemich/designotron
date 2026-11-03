#!/usr/bin/env node
// A stand-in for `claude` to smoke-test the eval plumbing without spending anything:
//   EVAL_REAL_CLAUDE=$PWD/scripts/eval/fake-claude.mjs EVAL_CLAUDE=1 node scripts/eval/claude-eval.mjs
// It prints canned stream-json and builds one card with the MCP server given in --mcp-config.
import fs from "node:fs";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("0.0.0 (fake)");
  process.exit(0);
}
const emit = (e) => console.log(JSON.stringify(e));
const i = args.indexOf("--mcp-config");
let cfg = args[i + 1] ?? "{}";
if (!cfg.trim().startsWith("{")) cfg = fs.readFileSync(cfg, "utf8");
const server = JSON.parse(cfg).mcpServers.designotron;

const call = async (name, input) => {
  const res = await fetch(server.url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(server.headers ?? {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: input } }),
  });
  return res.json();
};

emit({ type: "system", subtype: "init", session_id: "fake" });
emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "mcp__designotron__create_nodes", input: {} }] } });
await call("create_nodes", {
  nodes: [
    {
      type: "frame",
      name: "Screen",
      width: 390,
      height: 400,
      fill: "#FFFFFF",
      layout: { direction: "vertical", gap: 8, padding: 16 },
      children: [1, 2, 3].map((n) => ({ type: "frame", name: "Card", width: "fill", height: 80, fill: "#EEEEEE", children: [{ type: "text", text: `Card ${n}`, fontSize: 16 }] })),
    },
  ],
});
emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } });
emit({ type: "result", subtype: "success", is_error: false, result: "Built a screen with three cards.", total_cost_usd: 0, num_turns: 1, duration_ms: 1, session_id: "fake" });
