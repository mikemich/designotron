// Executes AI tool calls in the browser: engine tools go through the WASM
// engine (one undo step each), browser-only tools are handled here.

import { dispatchOrThrow, getDoc, query, selection, useStore, zoomToSelection } from "../store";
import { getScreenshot, importHtml, importUrl } from "./browserTools";

export interface ToolOutcome {
  ok: boolean;
  /** JSON-serialisable result or error message. */
  result: unknown;
  image?: { data: string; mediaType: "image/png" };
}

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export function toolDefs(): ToolDef[] {
  return query<ToolDef[]>({ q: "toolDefs" });
}

export function systemPrompt(): string {
  return query<string>({ q: "systemPrompt" });
}

/** Short context line describing what the user is looking at. */
export function contextLine(): string {
  const doc = getDoc();
  const page = doc.pages.find((p) => p.id === useStore.getState().es.page);
  const sel = selection()
    .map((id) => doc.nodes[id])
    .filter(Boolean)
    .map((n) => `${n.id} (${n.type} "${n.name}")`);
  return `[Editor context] Document "${doc.name}", page "${page?.name}" (${page?.id}). ${sel.length ? `Selected: ${sel.join(", ")}.` : "Nothing selected."}`;
}

export async function executeTool(name: string, input: any): Promise<ToolOutcome> {
  try {
    if (name === "get_screenshot") {
      const shot = await getScreenshot(input?.id, input?.scale);
      return { ok: true, result: { nodeId: shot.id, width: shot.width, height: shot.height }, image: { data: shot.data, mediaType: "image/png" } };
    }
    if (name === "import_html") {
      return { ok: true, result: await importHtml(input ?? {}) };
    }
    if (name === "import_url") {
      return { ok: true, result: await importUrl(input ?? {}) };
    }
    // The engine has no clock; stamp Claude's comment replies here.
    if (name === "reply_comment") input = { ...input, time: Date.now() };
    const result = dispatchOrThrow({ op: "ai", tool: name, input: input ?? {} });
    if (name === "select") setTimeout(zoomToSelection, 0);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, result: String(err instanceof Error ? err.message : err) };
  }
}

// Expose tool execution on the automation handle (see store.ts).
(globalThis as any).__dt = { ...(globalThis as any).__dt, tool: (name: string, input: unknown) => executeTool(name, input) };
