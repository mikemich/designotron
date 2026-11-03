#!/usr/bin/env bash
# CLAUDE_BIN for the eval: runs the real `claude` with a fixed model, budget and isolation, and
# keeps a copy of its stream-json output as $EVAL_OUT/<prompt id>.jsonl. `--version` passes
# straight through (the bridge probes it at start-up). Not used by anything but claude-eval.mjs.
#
# claude is exec'd, so it is the bridge's direct child: when the bridge stops or kills the turn,
# the signal reaches claude itself (a SIGKILL can't be forwarded by a wrapper process). tee runs
# as a separate process fed by the pipe and ends when claude does.
real="${EVAL_REAL_CLAUDE:-claude}"

if [ "$1" = "--version" ]; then
  exec "$real" "$@"
fi

if [ -n "$EVAL_OUT" ]; then
  id=$(cat "$EVAL_OUT/.current" 2>/dev/null || echo x)
  exec > >(tee -a "$EVAL_OUT/$id.jsonl")
fi

# Isolation, so the numbers don't depend on the machine running the eval:
#   --strict-mcp-config            only the designotron MCP server from the bridge
#   --disable-slash-commands       no skills or commands
#   --setting-sources project,local  no user settings, plugins, hooks or memory
#   --disallowedTools              nothing that writes code or reaches the internet; the eval is about the design tools
exec "$real" \
  --model "${EVAL_MODEL:-haiku}" \
  --max-budget-usd "${EVAL_MAX_USD:-1.00}" \
  --strict-mcp-config \
  --disable-slash-commands \
  --setting-sources project,local \
  --disallowedTools "Bash,Write,Edit,WebFetch,WebSearch,NotebookEdit,Task,Agent" \
  "$@"
