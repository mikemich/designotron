// Repeatable build-quality eval for Claude in Designotron. It sends a fixed set of design
// prompts through the real chat panel (so the real system prompt, tool descriptions and
// context line are used), then scores what ends up in the document.
//
// REAL CLAUDE TURNS COST MONEY. Run it by hand only; it refuses to start without
// EVAL_CLAUDE=1 and is never part of npm test, CI or the other e2e scripts. See README.md.
//
//   EVAL_CLAUDE=1 node scripts/eval/claude-eval.mjs
//   node scripts/eval/claude-eval.mjs --compare before/results.json after/results.json
//   node scripts/eval/claude-eval.mjs --rescore <out dir>      (no Claude, no browser)

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");

// ---------------------------------------------------------------- metrics (pure)

const INSTANCE_ROOTS = new Set(["instance"]);
const CONTAINERS = new Set(["frame", "component", "componentSet"]);

/** Scores one finished document. `doc` is `__dt.doc()`, `issues` the lint_design issue list. */
export function computeMetrics(doc, issues = []) {
  const nodes = doc.nodes ?? {};
  const roots = new Set(doc.pages.flatMap((p) => p.children));
  // Everything under an instance is derived from its component: ignore it.
  const derived = new Set();
  const markDerived = (id) => {
    for (const c of nodes[id]?.children ?? []) {
      derived.add(c);
      markDerived(c);
    }
  };
  for (const n of Object.values(nodes)) if (INSTANCE_ROOTS.has(n.type)) markDerived(n.id);
  const own = Object.values(nodes).filter((n) => !derived.has(n.id));

  const count = (t) => own.filter((n) => n.type === t).length;
  const ratio = (a, b) => (b ? a / b : 0);

  // Auto layout: frames with 2+ children that use it.
  const stacks = own.filter((n) => CONTAINERS.has(n.type) && (n.children?.length ?? 0) >= 2);
  const autoLayout = ratio(stacks.filter((n) => n.layout).length, stacks.length);

  // Absolute placement: children of non-auto-layout frames with 2+ children, and `absolute`
  // children of auto layout frames, over every non-root layer.
  let absolute = 0;
  let nonRoot = 0;
  for (const n of own) {
    if (roots.has(n.id)) continue;
    nonRoot++;
    const p = n.parent ? nodes[n.parent] : null;
    if (!p) continue;
    if (p.layout) {
      if (n.absolutePosition) absolute++;
    } else if (CONTAINERS.has(p.type) && p.children.length >= 2) absolute++;
  }
  const absoluteRatio = ratio(absolute, nonRoot);

  // Repeats: maximal subtrees (3+ layers) whose signature repeats 3+ times, against
  // instances of one component that appear 3+ times.
  const sizeOf = new Map();
  const sizeFn = (id) => {
    if (sizeOf.has(id)) return sizeOf.get(id);
    const n = nodes[id];
    const s = 1 + (n.type === "instance" ? 0 : n.children.reduce((a, c) => a + sizeFn(c), 0));
    sizeOf.set(id, s);
    return s;
  };
  const sigOf = new Map();
  const sigFn = (id) => {
    if (sigOf.has(id)) return sigOf.get(id);
    const n = nodes[id];
    const q = (v) => Math.round(v / 4) * 4;
    const fill = (n.fills ?? []).find((f) => f.type === "solid" && f.visible !== false);
    let s;
    if (n.type === "instance") s = `inst:${n.instance?.componentId}`;
    else if (n.type === "text") s = `text:${n.text?.fontSize}:${n.text?.fontWeight}:${fill?.color ?? ""}`;
    else {
      const w = n.sizingH === "fixed" ? q(n.width) : n.sizingH;
      const h = n.sizingV === "fixed" ? q(n.height) : n.sizingV;
      s = `${n.type}:${w}x${h}:${fill?.color ?? ""}:${n.layout?.direction ?? "-"}:${n.cornerRadius}[${n.children.map(sigFn).join(",")}]`;
    }
    sigOf.set(id, s);
    return s;
  };
  const groups = new Map();
  for (const n of own) {
    if (n.type === "instance" || n.type === "text" || sizeFn(n.id) < 3 || roots.has(n.id)) continue;
    // A main component is the definition, not a copy.
    if (n.type === "component" || n.type === "componentSet") continue;
    const k = sigFn(n.id);
    groups.set(k, [...(groups.get(k) ?? []), n.id]);
  }
  const repeating = new Set([...groups.values()].filter((g) => g.length >= 3).flat());
  let rawRepeats = 0;
  const walk = (id) => {
    if (repeating.has(id)) {
      rawRepeats++;
      return;
    }
    const n = nodes[id];
    if (n.type !== "instance") n.children.forEach(walk);
  };
  [...roots].filter((id) => nodes[id]).forEach(walk);
  const byComponent = new Map();
  for (const n of own) if (n.type === "instance") byComponent.set(n.instance.componentId, (byComponent.get(n.instance.componentId) ?? 0) + 1);
  const instanceRepeats = [...byComponent.values()].filter((c) => c >= 3).reduce((a, c) => a + c, 0);
  const repeatsAsInstances = ratio(instanceRepeats, instanceRepeats + rawRepeats);

  // Tokens: solid fills and text colours bound to a variable or linked to a style.
  let solids = 0;
  let tokens = 0;
  for (const n of own) {
    if (n.type === "line" || n.type === "group") continue;
    const solid = (n.fills ?? []).some((f) => f.type === "solid" && f.visible !== false);
    if (!solid) continue;
    solids++;
    if (n.fillStyle || Object.keys(n.bindings ?? {}).some((k) => k.startsWith("fill"))) tokens++;
  }
  const tokenUse = ratio(tokens, solids);
  const texts = own.filter((n) => n.type === "text");
  const textStyled = ratio(texts.filter((n) => n.textStyle).length, texts.length);

  const lintPer100 = (issues.length / Math.max(1, own.length)) * 100;
  const modeFrames = own.filter((n) => Object.keys(n.variableModes ?? {}).length > 0).length;
  const collectionsWithModes = (doc.variables ?? []).filter((c) => (c.modes ?? []).length >= 2).length;

  const score =
    25 * autoLayout +
    25 * repeatsAsInstances +
    20 * tokenUse +
    15 * (1 - absoluteRatio) +
    15 * Math.max(0, 1 - lintPer100 / 10);

  return {
    score: round(score, 1),
    nodes: own.length,
    autoLayout: round(autoLayout, 2),
    absoluteRatio: round(absoluteRatio, 2),
    repeatsAsInstances: round(repeatsAsInstances, 2),
    repeatedStructures: { rawMembers: rawRepeats, instanceMembers: instanceRepeats },
    components: count("component"),
    componentSets: count("componentSet"),
    instances: count("instance"),
    colorStyles: doc.styles?.colors?.length ?? 0,
    textStyles: doc.styles?.texts?.length ?? 0,
    variables: (doc.variables ?? []).reduce((a, c) => a + c.variables.length, 0),
    collectionsWithModes,
    modeFrames,
    tokenUse: round(tokenUse, 2),
    textStyled: round(textStyled, 2),
    lintIssues: issues.length,
    lintPer100: round(lintPer100, 1),
  };
}

/** Numbers from one turn's stream-json: cost, tool calls, errors, ToolSearch round trips, reply length. */
export function parseStream(text) {
  const out = { costUsd: 0, toolCalls: 0, toolErrors: 0, toolSearch: 0, replyWords: 0, turns: 0, durationMs: 0, isError: false, tools: {} };
  const ids = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "assistant") {
      for (const b of e.message?.content ?? []) {
        if (b.type !== "tool_use") continue;
        if (b.name === "ToolSearch") out.toolSearch++;
        out.toolCalls++;
        out.tools[b.name] = (out.tools[b.name] ?? 0) + 1;
        ids.set(b.id, b.name);
      }
    } else if (e.type === "user") {
      for (const b of e.message?.content ?? []) {
        if (b.type === "tool_result" && b.is_error && ids.has(b.tool_use_id)) out.toolErrors++;
      }
    } else if (e.type === "result") {
      out.costUsd = e.total_cost_usd ?? out.costUsd;
      out.turns = e.num_turns ?? out.turns;
      out.durationMs = e.duration_ms ?? out.durationMs;
      out.isError = !!e.is_error;
      out.replyWords = String(e.result ?? "").trim().split(/\s+/).filter(Boolean).length;
    }
  }
  return out;
}

const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

// ---------------------------------------------------------------- report

function table(results) {
  const rows = results.map((r) => ({ id: `${r.id} ${r.name}`, ...r.metrics, ...r.run }));
  const cols = [
    ["prompt", (r) => r.id],
    ["score", (r) => r.score],
    ["nodes", (r) => r.nodes],
    ["comp", (r) => `${r.components}/${r.componentSets}`],
    ["inst", (r) => r.instances],
    ["auto", (r) => r.autoLayout],
    ["abs", (r) => r.absoluteRatio],
    ["repeat", (r) => r.repeatsAsInstances],
    ["tokens", (r) => r.tokenUse],
    ["styles c/t", (r) => `${r.colorStyles}/${r.textStyles}`],
    ["vars", (r) => `${r.variables}${r.collectionsWithModes ? ` (${r.collectionsWithModes} modes, ${r.modeFrames} frames)` : ""}`],
    ["lint/100", (r) => r.lintPer100],
    ["first s", (r) => (r.firstChangeMs == null ? "-" : round(r.firstChangeMs / 1000, 0))],
    ["total s", (r) => round(r.totalMs / 1000, 0)],
    ["tools", (r) => `${r.toolCalls} (${r.toolErrors} err)`],
    ["search", (r) => r.toolSearch],
    ["words", (r) => r.replyWords],
    ["usd", (r) => round(r.costUsd, 2)],
  ];
  return markdown(cols.map((c) => c[0]), rows.map((r) => cols.map((c) => String(c[1](r)))));
}

function markdown(head, rows) {
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells) => `| ${cells.map((c, i) => c.padEnd(w[i])).join(" | ")} |`;
  return [line(head), `|${w.map((n) => "-".repeat(n + 2)).join("|")}|`, ...rows.map(line)].join("\n");
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function summarise(results) {
  const m = (f) => round(mean(results.map(f)), 2);
  return {
    prompts: results.length,
    meanScore: m((r) => r.metrics.score),
    meanComponents: m((r) => r.metrics.components + r.metrics.componentSets),
    meanAutoLayout: m((r) => r.metrics.autoLayout),
    meanRepeatsAsInstances: m((r) => r.metrics.repeatsAsInstances),
    meanTokenUse: m((r) => r.metrics.tokenUse),
    meanLintPer100: m((r) => r.metrics.lintPer100),
    meanFirstChangeS: round(mean(results.filter((r) => r.run.firstChangeMs != null).map((r) => r.run.firstChangeMs / 1000)), 0),
    meanTotalS: round(mean(results.map((r) => r.run.totalMs / 1000)), 0),
    meanToolSearch: m((r) => r.run.toolSearch),
    meanReplyWords: m((r) => r.run.replyWords),
    totalCostUsd: round(results.reduce((a, r) => a + r.run.costUsd, 0), 2),
  };
}

function compare(aPath, bPath) {
  const a = JSON.parse(fs.readFileSync(aPath, "utf8"));
  const b = JSON.parse(fs.readFileSync(bPath, "utf8"));
  const rows = [];
  for (const rb of b.results) {
    const ra = a.results.find((r) => r.id === rb.id);
    const fmt = (x, y) => (x == null ? `${y}` : `${x} -> ${y}`);
    rows.push([
      `${rb.id} ${rb.name}`,
      fmt(ra?.metrics.score, rb.metrics.score),
      fmt(ra && ra.metrics.components + ra.metrics.componentSets, rb.metrics.components + rb.metrics.componentSets),
      fmt(ra?.metrics.autoLayout, rb.metrics.autoLayout),
      fmt(ra?.metrics.repeatsAsInstances, rb.metrics.repeatsAsInstances),
      fmt(ra?.metrics.tokenUse, rb.metrics.tokenUse),
      fmt(ra?.metrics.lintPer100, rb.metrics.lintPer100),
      fmt(ra?.run.replyWords, rb.run.replyWords),
      fmt(ra && round(ra.run.costUsd, 2), round(rb.run.costUsd, 2)),
    ]);
  }
  console.log(markdown(["prompt", "score", "components", "auto", "repeat", "tokens", "lint/100", "words", "usd"], rows));
  console.log("\nsummary (before -> after)");
  for (const k of Object.keys(b.summary)) console.log(`  ${k}: ${a.summary?.[k] ?? "-"} -> ${b.summary[k]}`);
}

// ---------------------------------------------------------------- running

const args = process.argv.slice(2);
if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();

async function main() {
  const ci = args.indexOf("--compare");
  if (ci >= 0) return compare(args[ci + 1], args[ci + 2]);
  const ri = args.indexOf("--rescore");
  if (ri >= 0) return rescore(args[ri + 1]);

  if (process.env.EVAL_CLAUDE !== "1") {
    console.error("This sends real Claude turns, which cost money. Set EVAL_CLAUDE=1 to run it (see scripts/eval/README.md).");
    process.exit(2);
  }
  const model = process.env.EVAL_MODEL || "haiku";
  const maxUsd = process.env.EVAL_MAX_USD || "1.00";
  const port = Number(process.env.EVAL_PORT || 5332);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = path.resolve(process.env.EVAL_OUT || path.join(os.tmpdir(), `designotron-eval-${stamp}`));
  const prompts = JSON.parse(fs.readFileSync(path.join(here, "prompts.json"), "utf8"));
  const pick = (process.env.EVAL_PROMPTS || "").split(",").filter(Boolean).map(Number);
  const todo = pick.length ? prompts.filter((p) => pick.includes(p.id)) : prompts;
  const bin = process.env.EVAL_BRIDGE_BIN || path.join(process.env.CARGO_TARGET_DIR || path.join(repo, "target"), "debug", "designotron");
  const staticDir = path.resolve(process.env.EVAL_STATIC || path.join(repo, "web", "dist"));
  const budget = Number(process.env.EVAL_BUDGET_USD || 12);
  for (const [what, p] of [["bridge binary (EVAL_BRIDGE_BIN)", bin], ["web build (EVAL_STATIC)", path.join(staticDir, "index.html")]]) {
    if (!fs.existsSync(p)) {
      console.error(`missing ${what}: ${p}`);
      process.exit(2);
    }
  }
  if (await portInUse(port)) {
    console.error(`port ${port} is already in use; pick another with EVAL_PORT`);
    process.exit(2);
  }
  fs.mkdirSync(out, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "designotron-eval-ws-"));
  console.log(`eval: model=${model} prompts=${todo.map((p) => p.id).join(",")} out=${out}`);

  const bridge = spawn(bin, ["--port", String(port), "--workspace", workspace, "--static", staticDir, "--no-open"], {
    env: {
      ...process.env,
      CLAUDE_BIN: path.join(here, "claude-wrapper.mjs"),
      EVAL_OUT: out,
      EVAL_MODEL: model,
      EVAL_MAX_USD: maxUsd,
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  const stopBridge = () => bridge.kill("SIGTERM");
  process.on("exit", stopBridge);
  process.on("SIGINT", () => process.exit(130));

  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM || "/opt/pw-browsers/chromium",
    args: ["--no-sandbox"],
    headless: true,
  });
  const results = [];
  let spent = 0;
  try {
    await waitHttp(`http://127.0.0.1:${port}/`);
    for (const p of todo) {
      if (spent > budget) {
        console.error(`stopping: spent $${spent.toFixed(2)} which is over the $${budget} budget`);
        break;
      }
      fs.writeFileSync(path.join(out, ".current"), String(p.id));
      console.log(`\n[${p.id}] ${p.name}: ${p.prompt}`);
      const r = await runPrompt(browser, port, p, out);
      spent += r.run.costUsd;
      console.log(`  score ${r.metrics.score}, ${r.metrics.nodes} nodes, ${r.run.totalMs / 1000}s, $${r.run.costUsd.toFixed(2)} (spent $${spent.toFixed(2)})`);
      results.push(r);
      fs.writeFileSync(path.join(out, "results.json"), JSON.stringify({ model, results, summary: summarise(results) }, null, 2));
    }
  } finally {
    await browser.close();
    stopBridge();
  }
  report(out, model, results);
}

async function runPrompt(browser, port, p, out) {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  // Nothing leaves this machine except what the bridge's claude process does.
  await ctx.route(/^(?!http:\/\/(127\.0\.0\.1|localhost)[:/])/, (route) => route.abort());
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    try {
      localStorage.setItem("dt:tour-done", "1");
      localStorage.setItem("dt:chatMode", "bridge");
    } catch {}
  });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.click("button:has-text('New design file')");
  await page.waitForSelector("#dt-canvas");
  if (!(await page.$(".chat"))) await page.keyboard.press("Control+/");
  await page.waitForSelector(".chat textarea");
  await page.waitForFunction(() => {
    const c = window.__dt.chat();
    return c.bridgeStatus === "connected" && c.claude?.available;
  }, null, { timeout: 30000 });

  const nodeCount = () => page.evaluate(() => Object.keys(window.__dt.doc().nodes).length);
  await page.fill(".chat textarea", p.prompt);
  const t0 = Date.now();
  await page.keyboard.press("Enter");
  let firstChangeMs = null;
  let timedOut = false;
  for (;;) {
    await page.waitForTimeout(500);
    if (firstChangeMs == null && (await nodeCount()) > 0) firstChangeMs = Date.now() - t0;
    if (!(await page.evaluate(() => window.__dt.chat().running))) break;
    if (Date.now() - t0 > 6 * 60 * 1000) {
      timedOut = true;
      await page.evaluate(() => window.__dt.chat().running && document.querySelector(".chat .ibtn[title='Stop'], .chat button[title='Stop']")?.click());
      await page.waitForTimeout(1500);
      break;
    }
  }
  const totalMs = Date.now() - t0;
  await page.waitForTimeout(800);
  const doc = await page.evaluate(() => window.__dt.doc());
  const lint = await page.evaluate(() => window.__dt.tool("lint_design", {}));
  const issues = lint?.ok ? (lint.result?.issues ?? []) : [];
  fs.writeFileSync(path.join(out, `${p.id}.doc.json`), JSON.stringify({ doc, issues }));
  await page.screenshot({ path: path.join(out, `${p.id}.png`) });
  await ctx.close();

  const jsonl = path.join(out, `${p.id}.jsonl`);
  const stream = parseStream(fs.existsSync(jsonl) ? fs.readFileSync(jsonl, "utf8") : "");
  return { id: p.id, name: p.name, prompt: p.prompt, metrics: computeMetrics(doc, issues), run: { firstChangeMs, totalMs, timedOut, ...stream } };
}

function rescore(dir) {
  const prompts = JSON.parse(fs.readFileSync(path.join(here, "prompts.json"), "utf8"));
  const old = JSON.parse(fs.readFileSync(path.join(dir, "results.json"), "utf8"));
  const results = old.results.map((r) => {
    const { doc, issues } = JSON.parse(fs.readFileSync(path.join(dir, `${r.id}.doc.json`), "utf8"));
    return { ...r, name: prompts.find((p) => p.id === r.id)?.name ?? r.name, metrics: computeMetrics(doc, issues) };
  });
  report(dir, old.model, results);
}

function report(out, model, results) {
  const summary = summarise(results);
  fs.writeFileSync(path.join(out, "results.json"), JSON.stringify({ model, results, summary }, null, 2));
  console.log("\n" + table(results));
  console.log("\nmean: " + Object.entries(summary).map(([k, v]) => `${k}=${v}`).join(", "));
  console.log(`\nresults: ${path.join(out, "results.json")}`);
}

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    s.on("connect", () => (s.destroy(), resolve(true)));
    s.on("error", () => resolve(false));
  });
}

async function waitHttp(url) {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`bridge did not start: ${url}`);
}
