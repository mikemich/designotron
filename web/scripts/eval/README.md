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
The bridge runs `claude-wrapper.sh` instead of `claude`. The wrapper `exec`s the real
`claude` (so a kill reaches it) and tees its stream-json to `<prompt>.jsonl`. It adds
`--model`, `--max-budget-usd`, and isolation so the numbers don't depend on the machine:
`--strict-mcp-config` (only the designotron MCP server), `--disable-slash-commands`,
`--setting-sources project,local` (no user settings, plugins, hooks or memory) and
`--disallowedTools Bash,Write,Edit,WebFetch,WebSearch,NotebookEdit,Task,Agent`. The bridge itself is
started without the `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_REMOTE_SESSION_ID`,
`CLAUDE_CODE_CHILD_SESSION` and `CLAUDE_CODE_MESSAGING_*` variables, so the spawned `claude`
doesn't believe it is a child of the Claude Code session you run this from.

Each turn's `init` event (model, MCP servers, plugins, agents, tool count) is saved in
`results.json`, and the run warns about any MCP server besides designotron and any plugin.
It also warns about a turn that ends without a result event (killed or crashed; it is
counted as spending `EVAL_MAX_USD`), a turn over `EVAL_MAX_USD`, and a timeout.

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

`results.json` (per-prompt metrics, run numbers and warnings, plus a summary), `<n>.doc.json`
(the final document and lint issues), `<n>.png` (screenshot of the editor), `<n>.jsonl` and a
markdown table on stdout. The temporary bridge workspace is removed at the end.

```bash
node scripts/eval/claude-eval.mjs --compare before/results.json after/results.json
node scripts/eval/claude-eval.mjs --rescore <out dir>   # recompute the metrics from the saved documents into rescore.json, no Claude
```

## Score (0-100)

`25 * autoLayout + 25 * repeatsAsInstances + 20 * tokenUse + 15 * (1 - absoluteRatio) + 15 * max(0, 1 - lintPer100 / 10)`

- autoLayout: frames with 2+ children that use auto layout.
- absoluteRatio: children of non-auto-layout frames with 2+ children, plus `absolute`
  children, over all non-root layers.
- repeatsAsInstances: layers that repeat 3+ times with the same structure (2+ layers each,
  text and position ignored) are either copies or instances of one component; this is the
  instance share. An instance group only counts when its main component has 2+ layers too
  (a one-layer "Dot" component placed three times earns nothing). 0 when nothing repeats or
  nothing is shared.
- tokenUse: the mean of two shares: solid fills and text colours bound to a variable or
  linked to a colour style, and text layers linked to a text style (colour only, when
  there is no text).
- lintPer100: `lint_design` issues per 100 layers after the turn.
- Layers inside instances are ignored (they come from the component).

Guards: the score is 0 when the document is empty, the turn ended in an error or no result
event, or it timed out. It is capped at 60 when there are 6+ text layers in a single font size, or 15+ in fewer than 3
distinct font sizes (no type hierarchy). `results.json` says why in `metrics.scoreNote`.

The score can't see everything (a pricing card that lost its highlight, a design that is
ugly but tidy): read the screenshots before trusting a few points. Haiku is noisy, so compare
the mean over all four prompts. Also reported: components, component sets, colour/text styles,
variables and modes, time to the first canvas change, total time, tool calls and errors,
ToolSearch calls, reply word count and cost.

## Smoke test without Claude

`fake-claude.mjs` is a stand-in for `claude` that builds one screen and costs nothing:
`EVAL_REAL_CLAUDE=$PWD/scripts/eval/fake-claude.mjs EVAL_CLAUDE=1 EVAL_PROMPTS=1 node scripts/eval/claude-eval.mjs`.
`FAKE_MODE=empty|error|noresult|expensive|extras|flat` exercises the scoring guards and
the warnings (see the top of the file).
