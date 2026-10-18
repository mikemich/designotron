// API-key mode: a manual streaming tool loop against the Messages API,
// executed in the browser with the user's own key.

import Anthropic from "@anthropic-ai/sdk";
import { useChat, push, appendText, patchItem, showScreenshot } from "./chatState";
import { executeTool, systemPrompt, toolDefs } from "./tools";
import type { Attachment } from "./bridgeClient";

let messages: Anthropic.Beta.BetaMessageParam[] = [];
let controller: AbortController | null = null;

export function resetApiConversation() {
  messages = [];
}

export function abortApiAgent() {
  controller?.abort();
}

const MAX_TURNS = 40;

export async function runApiAgent(prompt: string, images: Attachment[] = []) {
  const { apiKey, model } = useChat.getState();
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const tools = toolDefs().map((t) => ({ ...t, eager_input_streaming: true })) as Anthropic.Beta.BetaTool[];
  const system = systemPrompt();
  messages.push({
    role: "user",
    content: images.length
      ? [
          ...images.map((a) => ({
            type: "image" as const,
            source: { type: "base64" as const, media_type: a.mediaType as "image/png", data: a.data },
          })),
          { type: "text" as const, text: prompt },
        ]
      : prompt,
  });
  controller = new AbortController();
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
      { signal: controller.signal },
    );
    stream.on("text", (delta) => {
      if (textItem === null) textItem = push({ kind: "assistant", text: "" });
      appendText(textItem, delta);
    });

    let msg: Anthropic.Beta.BetaMessage;
    try {
      msg = await stream.finalMessage();
      jsonRetries = 0;
    } catch (err) {
      // Only an unparseable streamed tool input is retried; API errors propagate.
      if (err instanceof Anthropic.APIError || controller.signal.aborted || jsonRetries++ >= 2) throw err;
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
    for (const use of uses) {
      const chip = push({ kind: "tool", name: use.name, ok: null });
      const out = await executeTool(use.name, use.input);
      patchItem(chip, { ok: out.ok, detail: out.ok ? undefined : String(out.result) });
      showScreenshot(out);
      const text = typeof out.result === "string" ? out.result : JSON.stringify(out.result);
      results.push({
        type: "tool_result",
        tool_use_id: use.id,
        is_error: !out.ok,
        content: out.image
          ? [
              { type: "image", source: { type: "base64", media_type: out.image.mediaType, data: out.image.data } },
              { type: "text", text },
            ]
          : text,
      });
    }
    messages.push({ role: "user", content: results });
  }
  push({ kind: "system", text: "Stopped after the maximum number of steps." });
}
