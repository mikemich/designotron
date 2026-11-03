// Executes AI tool calls in the browser: engine tools go through the WASM
// engine (one undo step each), browser-only tools are handled here.

import { aiDispatch, getDoc, pointerDrag, query, selection, useStore, zoomToSelection } from "../store";
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
  const roots = (page?.children ?? []).map((id) => doc.nodes[id]).filter(Boolean);
  let layers = "Page is empty.";
  if (roots.length) {
    const shown = roots
      .slice(0, 8)
      .map((n) => `${n.id} "${n.name}" ${Math.round(n.width)}×${Math.round(n.height)}`)
      .join(", ");
    const nextX = Math.ceil(Math.max(...roots.map((n) => n.x + n.width)) / 10) * 10 + 80;
    layers = `Page has ${roots.length} top-level layer${roots.length === 1 ? "" : "s"}: ${shown}${roots.length > 8 ? ", …" : ""}; place new screens at x >= ${nextX}.`;
  }
  return `[Editor context] Document "${doc.name}", page "${page?.name}" (${page?.id}). ${layers} ${sel.length ? `Selected: ${sel.join(", ")}.` : "Nothing selected."}`;
}
(globalThis as any).__dt = { ...(globalThis as any).__dt, contextLine };

/** What a chat call gets when the person keeps dragging for too long. */
export const DRAG_BUSY = "The person is dragging on the canvas; try again in a moment";

/** Resolves true once the person isn't dragging on the canvas, false if they still are after
 *  `timeoutMs` (the caller must then not run the tool). A tool call that landed mid-drag would be
 *  undone by the drag's next step, which starts again from the gesture's base document. Only a
 *  pointer drag does that: other open gestures (editing text in place, a running plugin) don't
 *  rebase, so they don't wait. Chat calls wait here before `executeTool`; the cap stays under
 *  the bridge's 180 s call timeout. */
export async function whenCanvasIdle(timeoutMs = 45000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (pointerDrag.active) {
    if (Date.now() >= until) return false;
    await new Promise((r) => setTimeout(r, 40));
  }
  return true;
}

/** `opts.group`: undo group of the chat turn the call belongs to (see `aiDispatch`). */
export async function executeTool(name: string, input: any, opts: { group?: string } = {}): Promise<ToolOutcome> {
  try {
    if (name === "get_screenshot") {
      const shot = await getScreenshot(input?.id, input?.scale);
      return { ok: true, result: { nodeId: shot.id, width: shot.width, height: shot.height }, image: { data: shot.data, mediaType: "image/png" } };
    }
    if (name === "import_html") {
      return { ok: true, result: await importHtml({ ...(input ?? {}), group: opts.group }) };
    }
    if (name === "save_plugin") {
      const { savePlugin } = await import("../plugins");
      const id = "p_" + Date.now().toString(36);
      savePlugin({ id, name: String(input?.name ?? "Plugin"), description: String(input?.description ?? ""), code: String(input?.code ?? "") });
      return { ok: true, result: { id, saved: true, note: "The user can run it from the main menu > Plugins." } };
    }
    if (name === "import_url") {
      return { ok: true, result: await importUrl({ ...(input ?? {}), group: opts.group }) };
    }
    // The engine has no clock; stamp Claude's comment replies here.
    if (name === "reply_comment") input = { ...input, time: Date.now() };
    const result = aiDispatch(name, input ?? {}, opts.group);
    if (name === "select") setTimeout(zoomToSelection, 0);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, result: String(err instanceof Error ? err.message : err) };
  }
}

// Expose tool execution on the automation handle (see store.ts).
(globalThis as any).__dt = { ...(globalThis as any).__dt, tool: (name: string, input: unknown) => executeTool(name, input) };
