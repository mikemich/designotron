#!/usr/bin/env node
// CLAUDE_BIN for the eval: runs the real `claude` with a fixed model and budget, and
// keeps a copy of its stream-json output. `--version` passes straight through (the
// bridge probes it at start-up). Not used by anything except claude-eval.mjs.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const real = process.env.EVAL_REAL_CLAUDE || "claude";
const args = process.argv.slice(2);

if (args[0] === "--version") {
  const p = spawn(real, args, { stdio: "inherit" });
  p.on("exit", (c) => process.exit(c ?? 1));
} else {
  const out = process.env.EVAL_OUT;
  let tee = null;
  if (out) {
    let id = "x";
    try {
      id = fs.readFileSync(path.join(out, ".current"), "utf8").trim();
    } catch {}
    tee = fs.createWriteStream(path.join(out, `${id}.jsonl`), { flags: "a" });
  }
  // --strict-mcp-config: only the designotron server from the bridge, so the numbers don't
  // depend on whatever MCP servers or skills the person running the eval has installed.
  const extra = [
    "--model", process.env.EVAL_MODEL || "haiku",
    "--max-budget-usd", process.env.EVAL_MAX_USD || "1.00",
    "--strict-mcp-config",
    "--disable-slash-commands",
  ];
  const child = spawn(real, [...extra, ...args], { stdio: ["inherit", "pipe", "inherit"] });
  // The bridge stops reading after the result event and closes the pipe; that's expected.
  process.stdout.on("error", () => {});
  child.stdout.on("data", (d) => {
    tee?.write(d);
    process.stdout.write(d);
  });
  child.on("exit", (c) => {
    tee?.end();
    process.exit(c ?? 0);
  });
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => child.kill(sig));
}
