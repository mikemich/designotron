/** Longest file name taken from a prompt, the "…" of a cut name included. */
export const PROMPT_NAME_CHARS = 40;

/** A file name from what the person asked Claude for: the first line, without surrounding quotes, its
 *  first letter in capitals, cut at a word boundary (with "…") when longer than 40 characters.
 *  "Untitled" when nothing is left. */
export function nameFromPrompt(prompt: string): string {
  let line = (prompt.split(/\r?\n/).find((l) => l.trim()) ?? "").replace(/\s+/g, " ").trim();
  line = line.replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "").trim();
  if (!line) return "Untitled";
  line = line.charAt(0).toUpperCase() + line.slice(1);
  // By code points, so an emoji is never split in half.
  const chars = [...line];
  if (chars.length <= PROMPT_NAME_CHARS) return line;
  const room = PROMPT_NAME_CHARS - 1;
  const head = chars.slice(0, room).join("");
  // A cut that lands exactly between two words keeps the whole head; otherwise back up to the last space
  // (a single long word is cut where it is).
  const atBoundary = /\s/.test(chars[room]);
  const at = head.lastIndexOf(" ");
  const kept = atBoundary || at < 8 ? head : head.slice(0, at);
  return kept.replace(/[\s.,;:!?-]+$/, "") + "…";
}
