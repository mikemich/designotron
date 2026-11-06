// API-key mode: a manual streaming tool loop against the Messages API,
// executed in the browser with the user's own key.

import Anthropic from "@anthropic-ai/sdk";
import { useChat, push, appendText, patchItem, showScreenshot } from "./chatState";
import { DRAG_BUSY, executeTool, systemPrompt, toolDefs, whenCanvasIdle, type ToolOutcome } from "./tools";
import type { Attachment } from "./bridgeClient";

type Messages = Anthropic.Beta.BetaMessageParam[];
/** The messages of each file's conversation (in memory: a reload starts them fresh). */
const conversations = new Map<string, Messages>();
/** Files whose messages are kept in memory (the most recently used). */
const MAX_CONVERSATIONS = 5;
const conversationOf = (file: string | null): Messages => {
  const key = file ?? "";
  const m = conversations.get(key) ?? [];
  // Most recently used last; the oldest fall out.
  conversations.delete(key);
  conversations.set(key, m);
  while (conversations.size > MAX_CONVERSATIONS) conversations.delete(conversations.keys().next().value as string);
  return m;
};
/** Whether API mode still has this file's messages (it doesn't after a reload). */
export function hasApiConversation(file: string): boolean {
  return (conversations.get(file)?.length ?? 0) > 0;
}
/** The messages of the run that is running now (what `abortApiAgent` answers for). */
let messages: Messages = [];
let controller: AbortController | null = null;
let runCount = 0;
/** The tool calls of the reply being answered: what finished, and the call running now. */
let round: { done: Map<string, Anthropic.Beta.BetaToolResultBlockParam>; running: string | null } | null = null;

/** Forgets a file's messages (a new conversation). */
export function resetApiConversation(file: string | null) {
  conversations.delete(file ?? "");
}

/** Aborts the request that is running now (each run has its own controller, so a message sent
 *  right after this one is not affected). */
export function abortApiAgent() {
  if (!controller) return;
  controller.abort();
  controller = null;
  // Stopped between a reply with tool calls and their results: answer each call, so the next
  // message (it joins this user turn) is accepted. Calls that finished keep their results (so
  // Claude doesn't redo them), the one running may or may not have landed, the rest never ran.
  // The run itself runs no further tools.
  const last = messages[messages.length - 1];
  const finished = round;
  round = null;
  if (last?.role !== "assistant" || typeof last.content === "string") return;
  const calls = last.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
  if (!calls.length) return;
  const stopped = (id: string, text: string): Anthropic.Beta.BetaToolResultBlockParam => ({ type: "tool_result", tool_use_id: id, is_error: true, content: text });
  messages.push({
    role: "user",
    content: calls.map(
      (c) =>
        finished?.done.get(c.id) ??
        stopped(c.id, finished?.running === c.id ? "Stopped by the user; it may have been applied" : "Stopped by the user"),
    ),
  });
}

function aborted(): Error {
  return new DOMException("The run was stopped.", "AbortError");
}

const MAX_TURNS = 40;

export async function runApiAgent(prompt: string, images: Attachment[] = []) {
  const { apiKey, model, chatFile: file } = useChat.getState();
  // This run's file and messages stay its own if the person opens another file meanwhile.
  const messages = conversationOf(file);
  setActive(messages);
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const tools = toolDefs().map((t) => ({ ...t, eager_input_streaming: true })) as Anthropic.Beta.BetaTool[];
  const system = systemPrompt();
  const start = messages.length;
  const blocks: Anthropic.Beta.BetaContentBlockParam[] = [
    ...images.map((a) => ({
      type: "image" as const,
      source: { type: "base64" as const, media_type: a.mediaType as "image/png", data: a.data },
    })),
    { type: "text" as const, text: prompt },
  ];
  const last = messages[messages.length - 1];
  if (last?.role === "user") {
    // An earlier run stopped after sending tool results: this prompt joins that turn
    // (two user turns in a row aren't allowed).
    const prev = typeof last.content === "string" ? [{ type: "text" as const, text: last.content }] : last.content;
    last.content = [...prev, ...blocks];
  } else {
    messages.push({ role: "user", content: images.length ? blocks : prompt });
  }
  const mine = new AbortController();
  controller = mine;
  // One undo step per run: all its tool calls share the group.
  const run = ++runCount;
  const group = `api-${run}`;
  try {
    await runTurns(client, tools, system, model, mine.signal, group, file, messages);
  } catch (err) {
    // Nothing came back for this prompt: forget it, so retrying doesn't send it twice. Not when a
    // newer run has started since (a queued message after Stop): its prompt may sit in the
    // same message.
    if (run !== runCount) throw err;
    if (messages.length === start + 1 && messages[start].role === "user") messages.length = start;
    else if (messages.length === start && last?.role === "user") last.content = (last.content as Anthropic.Beta.BetaContentBlockParam[]).slice(0, -blocks.length);
    throw err;
  } finally {
    if (controller === mine) controller = null;
  }
}

function setActive(m: Messages) {
  messages = m;
}

async function runTurns(
  client: Anthropic,
  tools: Anthropic.Beta.BetaTool[],
  system: string,
  model: string,
  signal: AbortSignal,
  group: string,
  file: string | null,
  messages: Messages,
) {
  let jsonRetries = 0;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let textItem: number | null = null;
    const stream = client.beta.messages.stream(
      {
        model,
        max_tokens: 64000,
        system,
        tools,
        messages,
        thinking: { type: "adaptive" },
        output_config: { effort: "medium" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      },
      { signal },
    );
    stream.on("text", (delta) => {
      if (signal.aborted) return;
      if (textItem === null) textItem = push({ kind: "assistant", text: "" });
      appendText(textItem, delta);
    });

    let msg: Anthropic.Beta.BetaMessage;
    try {
      msg = await stream.finalMessage();
      jsonRetries = 0;
    } catch (err) {
      // Only an unparseable streamed tool input is retried; API errors propagate.
      if (err instanceof Anthropic.APIError || signal.aborted || jsonRetries++ >= 2) throw err;
      continue;
    }

    if (msg.stop_reason === "refusal") {
      push({ kind: "error", text: "Claude declined this request." });
      messages.push({ role: "assistant", content: msg.content });
      return;
    }
    messages.push({ role: "assistant", content: msg.content });
    const uses = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (!uses.length) return;
    if (msg.stop_reason === "max_tokens") throw new Error("Claude's tool call was cut off (max_tokens). Try a smaller request.");

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    const mine = { done: new Map<string, Anthropic.Beta.BetaToolResultBlockParam>(), running: null as string | null };
    round = mine;
    for (const use of uses) {
      // Stop pressed: no further tool runs (`abortApiAgent` already answered the calls).
      if (signal.aborted) throw aborted();
      if (useChat.getState().chatFile !== file) throw aborted();
      const chip = push({ kind: "tool", name: use.name, ok: null });
      mine.running = use.id;
      const idle = await whenCanvasIdle();
      if (signal.aborted) {
        patchItem(chip, { ok: false, detail: "Stopped" });
        throw aborted();
      }
      const out: ToolOutcome = idle ? await executeTool(use.name, use.input, { group, fileId: file }) : { ok: false, result: DRAG_BUSY };
      patchItem(chip, { ok: out.ok, detail: out.ok ? undefined : String(out.result) });
      showScreenshot(out, use.name);
      const text = typeof out.result === "string" ? out.result : JSON.stringify(out.result);
      const block: Anthropic.Beta.BetaToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: use.id,
        is_error: !out.ok,
        content: out.image
          ? [
              { type: "image", source: { type: "base64", media_type: out.image.mediaType, data: out.image.data } },
              { type: "text", text },
            ]
          : text,
      };
      mine.done.set(use.id, block);
      mine.running = null;
      results.push(block);
      if (signal.aborted) throw aborted();
    }
    round = null;
    messages.push({ role: "user", content: results });
  }
  push({ kind: "system", text: "Stopped after the maximum number of steps." });
}
