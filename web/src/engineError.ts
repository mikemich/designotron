/** Whether `err` is the wasm engine itself stopping: a `WebAssembly.RuntimeError`, or the
 *  errors a trapped instance throws from then on (a re-entry guard, an allocation failure). */
export function isEngineTrap(err: unknown): boolean {
  if (typeof WebAssembly !== "undefined" && err instanceof WebAssembly.RuntimeError) return true;
  return err instanceof Error && /recursive use of an object|out of memory/i.test(err.message);
}
