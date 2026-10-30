import { toast } from "./store";

/** "Couldn't rename the file: <reason>" for a failed storage (or other) operation. */
export function failureText(what: string, err: unknown): string {
  const reason = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return reason ? `Couldn't ${what}: ${reason}` : `Couldn't ${what}.`;
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
