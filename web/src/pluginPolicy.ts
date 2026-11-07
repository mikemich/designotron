// What plugins may put in tool inputs, and the editor's frame policy. No imports: both are
// checked by tests (`pluginPolicy.test.ts`) against the files that use them.

/** The editor page's Content-Security-Policy (the `<meta>` in `index.html` says exactly this).
 *  Only `frame-src`, so nothing else in the editor is affected. It is what stops a plugin's
 *  sandboxed frame from navigating itself to the web: the browser refuses the navigation before
 *  any request is made. srcdoc frames (plugins, `import_html`) are not fetches and still load;
 *  the localhost entries are the app preview. There is deliberately no `'self'`, but that alone
 *  doesn't keep the editor out of a plugin frame: local installs serve the editor on those same
 *  localhost origins, so `main.tsx` also refuses to boot in a frame with an opaque origin. */
export const EDITOR_FRAME_SRC = "frame-src http://localhost:* http://127.0.0.1:*";

/** Namespace declarations (`xmlns="…"`, `xmlns:xlink="…"`) for exactly these URLs are markup, not
 *  web addresses. Anything else, or the same URL with more appended, is not exempt. */
const NAMESPACE_DECL = /\bxmlns(?::[\w.-]+)?\s*=\s*(["'])http:\/\/www\.w3\.org\/(?:2000\/svg|1999\/xlink|1999\/xhtml|XML\/1998\/namespace)\1/g;

const WEB_ADDRESS = /https?:\/\//i;

/** Keys whose string value is plain text: nothing fetches it and nothing makes it a link, so a web
 *  address there is just words (a text layer reading "See https://example.com/docs", a layer name,
 *  a span's text, a comment). Everything else (image sources, links, prototype URLs, SVG markup,
 *  variable values) stays refused. Only the key's direct string value is exempt: an object or array
 *  under such a key is still walked, and keys themselves are always checked. */
const PLAIN_TEXT_KEYS = new Set(["text", "characters", "name", "description"]);

/** What the editor tells a plugin whose input was refused. */
export const WEB_ADDRESS_REFUSAL = "plugins can't use web addresses outside text (no links, image URLs or fetching)";

/** True when any string in `input` (walked, not its JSON text) contains a web address, ignoring
 *  exact SVG/XHTML namespace declarations and the plain-text keys above. */
export function hasWebAddress(input: unknown, depth = 0, key?: string): boolean {
  if (typeof input === "string") {
    if (key !== undefined && PLAIN_TEXT_KEYS.has(key)) return false;
    return WEB_ADDRESS.test(input.replace(NAMESPACE_DECL, ""));
  }
  if (depth > 200) return true; // too deep to look through: refuse
  if (input === null || typeof input !== "object") return false;
  // Array elements inherit no key: `spans: [{ text }]` reaches `text` through the object.
  if (Array.isArray(input)) return input.some((v) => hasWebAddress(v, depth + 1));
  // Keys count too: they end up as JSON text on the engine side as well.
  return Object.entries(input).some(([k, v]) => hasWebAddress(k, depth + 1) || hasWebAddress(v, depth + 1, k));
}
