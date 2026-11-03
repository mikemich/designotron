#!/usr/bin/env node
// A stand-in for `claude` to smoke-test the eval plumbing without spending anything:
//   EVAL_REAL_CLAUDE=$PWD/scripts/eval/fake-claude.mjs EVAL_CLAUDE=1 node scripts/eval/claude-eval.mjs
// It prints canned stream-json and builds one screen with the MCP server given in --mcp-config.
// FAKE_MODE picks a failure to exercise the scoring and the warnings:
//   (unset)    builds three cards, ends normally
//   empty      ends normally but builds nothing                 -> score 0
//   error      builds, but the result event says is_error       -> score 0
//   noresult   builds, then exits without a result event        -> counted as the per-turn cap
//   expensive  builds, reports a cost over the per-turn cap     -> flagged
//   extras     reports an extra MCP server and a plugin         -> warnings
//   flat       builds 8 texts in a single font size             -> score capped at 60
import fs from "node:fs";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("0.0.0 (fake)");
  process.exit(0);
}
const mode = process.env.FAKE_MODE ?? "";
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

const servers = [{ name: "designotron", status: "connected" }];
if (mode === "extras") servers.push({ name: "figma", status: "connected" });
emit({ type: "system", subtype: "init", session_id: "fake", model: "fake", mcp_servers: servers, plugins: mode === "extras" ? [{ name: "design", path: "/x" }] : [], agents: [], tools: ["mcp__designotron__create_nodes"] });
emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "mcp__designotron__create_nodes", input: {} }] } });
if (mode !== "empty") {
  const card = (n) => ({ type: "frame", name: "Card", width: "fill", height: 80, fill: "#EEEEEE", children: [{ type: "text", text: `Card ${n}`, fontSize: mode === "flat" ? 16 : 16 + n * 4 }] });
  await call("create_nodes", {
    nodes: [
      {
        type: "frame",
        name: "Screen",
        width: 390,
        height: 400,
        fill: "#FFFFFF",
        layout: { direction: "vertical", gap: 8, padding: 16 },
        children: (mode === "flat" ? [1, 2, 3, 4, 5, 6, 7, 8] : [1, 2, 3]).map(card),
      },
    ],
  });
}
emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } });
if (mode !== "noresult") {
  emit({
    type: "result",
    subtype: "success",
    is_error: mode === "error",
    result: "Built a screen with three cards.",
    total_cost_usd: mode === "expensive" ? 5 : 0,
    num_turns: 1,
    duration_ms: 1,
    session_id: "fake",
  });
}
