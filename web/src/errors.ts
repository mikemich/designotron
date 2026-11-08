import { toast } from "./store";

const STORAGE_FULL = "The browser's storage is full. Delete old files or versions, or save a .dtron copy (File menu).";
const STORAGE_BLOCKED = "This browser isn't allowing storage here (a private window or blocked site data).";
const STORAGE_UNREADABLE = "Stored data couldn't be read. Try again, or reload the page.";
const NO_CONNECTION = "Couldn't connect. Check your connection and try again.";

/** Whether a message already reads as a sentence for a person: it starts with a capital letter,
 * has a space, no `Error:` prefix and nothing that looks like a position or a stack. */
function readsAsSentence(msg: string): boolean {
  return /^[A-Z]/.test(msg) && msg.includes(" ") && !/^\w*Error:/.test(msg) && !/at position|\n\s+at /.test(msg);
}

/** One plain sentence for any thrown value; never empty and never a raw exception name.
 * Our own errors and messages that already read as sentences pass through unchanged. The raw
 * error stays in the console (`reportFailure` logs it). `jsonWhat` names what was being parsed
 * when a SyntaxError means "not valid JSON". */
export function plainError(err: unknown, jsonWhat?: string): string {
  const name = typeof err === "object" && err && "name" in err ? String((err as { name: unknown }).name) : "";
  const msg = (err instanceof Error ? err.message : typeof err === "string" ? err : "").trim();
  if (name === "QuotaExceededError" || /quota/i.test(msg)) return STORAGE_FULL;
  if (name === "SecurityError" || name === "InvalidStateError") return STORAGE_BLOCKED;
  if (["NotFoundError", "VersionError", "UnknownError", "DataError"].includes(name)) return STORAGE_UNREADABLE;
  if (name === "SyntaxError") return jsonWhat ?? "That file isn't valid JSON.";
  if (name === "AbortError") return "Cancelled.";
  if (name === "TypeError" && /failed to fetch|networkerror|load failed/i.test(msg)) return NO_CONNECTION;
  if (msg && readsAsSentence(msg)) return msg;
  return "Something went wrong.";
}

/** "Couldn't rename the file: <reason>" for a failed storage (or other) operation. */
export function failureText(what: string, err: unknown): string {
  const reason = plainError(err);
  // "Something went wrong." adds nothing after "Couldn't <what>".
  return reason === "Something went wrong." ? `Couldn't ${what}.` : `Couldn't ${what}: ${reason}`;
}

/** Shows a failed operation as an error toast. */
export function reportFailure(what: string, err: unknown) {
  console.error(err);
  toast(failureText(what, err), "error");
}

/** Runs `fn`; a failure shows as an error toast ("Couldn't <what>: …") instead of rejecting.
 *  Resolves to `fn`'s result, or `undefined` after a failure. */
export async function attempt<T>(what: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    reportFailure(what, err);
    return undefined;
  }
}
