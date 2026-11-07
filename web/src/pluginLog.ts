// The plugin console: what a plugin's run said (console.*, dt.notify, un-awaited failures, tool
// warnings), kept for the current or last run. The sandbox frame formats `console.*` arguments
// itself (pluginSandbox.ts has no imports) with the same code as `formatArgs` below; a test runs
// both on the same inputs.

import { create } from "zustand";

export type LogLevel = "log" | "info" | "warn" | "error" | "notify" | "tool";

export interface LogEntry {
  t: number;
  level: LogLevel;
  text: string;
  /** Line in the plugin's code the entry came from, when known. */
  line?: number;
}

/** Entries kept; older ones are dropped and counted. */
export const LOG_CAP = 500;
/** Characters kept per entry. */
export const ENTRY_CAP = 2000;

const LEVELS = new Set<string>(["log", "info", "warn", "error", "notify", "tool"]);
export const asLevel = (v: unknown): LogLevel => (typeof v === "string" && LEVELS.has(v) ? (v as LogLevel) : "log");

/** A line number from the frame is a plain integer within the plugin's code, or nothing. */
export function asLine(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 1_000_000 ? v : undefined;
}

// fmt:begin
const plain = (v: any, depth: number, seen: any[]): any => {
  if (v === null) return null;
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean") return v;
  if (t === "undefined") return "undefined";
  if (t === "function") return "[Function" + (v.name ? " " + v.name : "") + "]";
  if (t === "symbol") return String(v);
  if (t === "bigint") return v + "n";
  if (seen.includes(v)) return "[Circular]";
  if (v instanceof Error) return String(v.name) + ": " + String(v.message);
  if (depth >= 4) return Array.isArray(v) ? "[Array]" : "[Object]";
  seen.push(v);
  let out: any;
  if (Array.isArray(v)) out = v.slice(0, 100).map((x: any) => plain(x, depth + 1, seen));
  else {
    out = Object.create(null);
    let n = 0;
    for (const k of Object.keys(v)) {
      if (n++ >= 100) break;
      out[k] = plain(v[k], depth + 1, seen);
    }
  }
  seen.pop();
  return out;
};
const one = (v: any): string => {
  try {
    if (typeof v === "string") return v;
    if (v instanceof Error) return String(v.name) + ": " + String(v.message);
    const p = plain(v, 0, []);
    return typeof p === "string" ? p : JSON.stringify(p);
  } catch (e) {
    return "[unprintable]";
  }
};
export const formatArgs = (args: any[]): string => {
  const s = args.map(one).join(" ");
  return s.length > 2000 ? s.slice(0, 2000) + "…" : s;
};
// fmt:end

// pos:begin
/** `[line, column]` of the first frame of a stack that comes from code compiled with `new Function`
 *  (Chromium and WebKit say `<anonymous>:L:C`, Firefox `Function:L:C`), or null. The text is the
 *  plugin's to shape (`Error.prepareStackTrace`), so it is coerced and cut before it is read. */
export const stackPos = (stack: any): number[] | null => {
  let s: string;
  try {
    s = String(stack).slice(0, 20000);
  } catch (e) {
    return null;
  }
  const m = /(?:<anonymous>|Function|eval|@):(\d+):(\d+)/.exec(s);
  return m ? [Number(m[1]), Number(m[2])] : null;
};
// pos:end

/** The plugin's own line for a line in the compiled function: the wrapper's `offset` lines taken
 *  off, and nothing when that lands outside the code (`lines` long). */
export function mapLine(raw: number, offset: number, lines: number): number | undefined {
  const l = raw - offset;
  return Number.isInteger(l) && l >= 1 && l <= lines ? l : undefined;
}

interface LogState {
  entries: LogEntry[];
  /** Entries dropped from the front once `LOG_CAP` was reached. */
  dropped: number;
  /** The floating console of a plugin whose panel is open. */
  panelOpen: boolean;
  /** When the run the entries belong to started (entries show time since). */
  start: number;
}

export const usePluginLog = create<LogState>(() => ({ entries: [], dropped: 0, panelOpen: false, start: Date.now() }));

// Lines wait here and reach the store once per frame, so a burst (every notify, warning and console
// line of a busy run) copies the 500-entry list once, not once per line.
let queued: LogEntry[] = [];
let flushTimer = 0;

/** Moves the queued lines into the store now. */
export function logFlush() {
  clearTimeout(flushTimer);
  flushTimer = 0;
  if (!queued.length) return;
  const add = queued;
  queued = [];
  usePluginLog.setState((s) => {
    const entries = [...s.entries, ...add];
    const over = Math.max(0, entries.length - LOG_CAP);
    return over ? { entries: entries.slice(over), dropped: s.dropped + over } : { entries };
  });
}

export function logPush(level: LogLevel, text: string, line?: number) {
  queued.push({ t: Date.now(), level, text: text.length > ENTRY_CAP ? text.slice(0, ENTRY_CAP) + "…" : text, line });
  // Never hold more than the store could show.
  if (queued.length > LOG_CAP * 2) logFlush();
  else if (!flushTimer) flushTimer = globalThis.setTimeout(logFlush, 16) as unknown as number;
}

function dropQueued() {
  clearTimeout(flushTimer);
  flushTimer = 0;
  queued = [];
}

export function logClear() {
  dropQueued();
  usePluginLog.setState({ entries: [], dropped: 0 });
}

/** A new run starts: the console shows only it. */
export function logStart() {
  dropQueued();
  usePluginLog.setState({ entries: [], dropped: 0, start: Date.now(), panelOpen: false });
}
