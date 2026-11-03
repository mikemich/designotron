# Claude build-quality eval

Sends four fixed design prompts (`prompts.json`) through the real chat panel to a real
`claude`, then scores what ends up in the document: auto layout, repeats built as
component instances, colours bound to variables or styles, absolute positioning and lint
issues. Use it to compare two versions of the system prompt, the tool descriptions or the
context line.

**It spends real Claude turns.** Run it by hand. It is not part of `npm test`, CI or any
other e2e script, and it refuses to start unless `EVAL_CLAUDE=1` is set. Budget: 4 turns
per run (haiku, a few cents each); the QA round that built it capped itself at 16 turns.

## Run

```bash
cargo build -p designotron-bridge && (cd web && npm run build)   # the bridge embeds the prompts, web/dist the context line
cd web
EVAL_CLAUDE=1 node scripts/eval/claude-eval.mjs
```

It starts the bridge on `EVAL_PORT` (default 5332) with `--static web/dist`, opens the
editor in headless Chromium (every non-local request is aborted), creates a blank file per
prompt, types the prompt into the chat box and waits for the turn to end (6 minute cap).
The bridge runs `claude-wrapper.mjs` instead of `claude`: it adds `--model`,
`--max-budget-usd`, `--strict-mcp-config` (only the designotron MCP server, so your own MCP
servers don't change the numbers) and `--disable-slash-commands`, and keeps each turn's
stream-json as `<prompt>.jsonl`.

| Variable            | Default                          | Meaning                                         |
|---------------------|----------------------------------|-------------------------------------------------|
| `EVAL_CLAUDE`       | (required, `1`)                  | Confirms you mean to spend real turns           |
| `EVAL_MODEL`        | `haiku`                          | `haiku` or `sonnet`                             |
| `EVAL_PROMPTS`      | all                              | Subset, e.g. `1,2`                              |
| `EVAL_OUT`          | `$TMPDIR/designotron-eval-<ts>`  | Output folder                                   |
| `EVAL_MAX_USD`      | `1.00`                           | `--max-budget-usd` per turn                     |
| `EVAL_BUDGET_USD`   | `12`                             | Stop starting new prompts once the sum passes it |
| `EVAL_PORT`         | `5332`                           | Bridge port (must be free)                      |
| `EVAL_BRIDGE_BIN`   | `target/debug/designotron`       | Bridge binary (honours `CARGO_TARGET_DIR`)      |
| `EVAL_STATIC`       | `web/dist`                       | Editor build the bridge serves                  |

Keep a binary and `dist/` copy of the version you want to use as the baseline and point
`EVAL_BRIDGE_BIN` / `EVAL_STATIC` at them to compare against your working tree.

## Output

`results.json` (per-prompt metrics and run numbers, plus a summary), `<n>.doc.json` (the
final document and lint issues), `<n>.png` (screenshot of the editor), `<n>.jsonl` and a
markdown table on stdout.

```bash
node scripts/eval/claude-eval.mjs --compare before/results.json after/results.json
node scripts/eval/claude-eval.mjs --rescore <out dir>   # recompute the metrics from the saved documents, no Claude
```

## Score (0-100)

`25 * autoLayout + 25 * repeatsAsInstances + 20 * tokenUse + 15 * (1 - absoluteRatio) + 15 * max(0, 1 - lintPer100 / 10)`

- autoLayout: frames with 2+ children that use auto layout.
- absoluteRatio: children of non-auto-layout frames with 2+ children, plus `absolute`
  children, over all non-root layers.
- repeatsAsInstances: layers that repeat 3+ times with the same structure (3+ layers each,
  text and position ignored) are either copies or instances of one component; this is the
  instance share. 0 when nothing repeats or nothing is shared.
- tokenUse: solid fills and text colours bound to a variable or linked to a style.
- lintPer100: `lint_design` issues per 100 layers after the turn.
- Layers inside instances are ignored (they come from the component).

Also reported: components, component sets, colour/text styles, variables and modes, text
layers with a text style, time to the first canvas change, total time, tool calls and
errors, ToolSearch calls, reply word count and cost. Haiku is noisy: compare the mean over
all four prompts and look at the screenshots before trusting a few points.

`fake-claude.mjs` is a stand-in for `claude` that builds three cards and costs nothing:
`EVAL_REAL_CLAUDE=$PWD/scripts/eval/fake-claude.mjs EVAL_CLAUDE=1 EVAL_PROMPTS=1 node scripts/eval/claude-eval.mjs`
checks the plumbing.
