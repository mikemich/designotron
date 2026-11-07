// What plugins may put in tool inputs, and the editor's frame policy. No imports: both are
// checked by tests (`pluginPolicy.test.ts`) against the files that use them.

/** The editor page's Content-Security-Policy (the `<meta>` in `index.html` says exactly this).
 *  Only `frame-src`, so nothing else in the editor is affected. It is what stops a plugin's
 *  sandboxed frame from navigating itself to the web: the browser refuses the navigation before
 *  any request is made. srcdoc frames (plugins, `import_html`) are not fetches and still load;
 *  the localhost entries are the app preview. There is deliberately no `'self'`: nothing in the
 *  editor frames its own origin, and a plugin must not be able to load the editor in its frame. */
export const EDITOR_FRAME_SRC = "frame-src http://localhost:* http://127.0.0.1:*";

/** Namespace declarations (`xmlns="…"`, `xmlns:xlink="…"`) for exactly these URLs are markup, not
 *  web addresses. Anything else, or the same URL with more appended, is not exempt. */
const NAMESPACE_DECL = /\bxmlns(?::[\w.-]+)?\s*=\s*(["'])http:\/\/www\.w3\.org\/(?:2000\/svg|1999\/xlink|1999\/xhtml|XML\/1998\/namespace)\1/g;

const WEB_ADDRESS = /https?:\/\//i;

/** True when any string in `input` (walked, not its JSON text) contains a web address, ignoring
 *  exact SVG/XHTML namespace declarations. Plugins can't use web addresses (no network). */
export function hasWebAddress(input: unknown, depth = 0): boolean {
  if (typeof input === "string") return WEB_ADDRESS.test(input.replace(NAMESPACE_DECL, ""));
  if (depth > 200 || input === null || typeof input !== "object") return false;
  if (Array.isArray(input)) return input.some((v) => hasWebAddress(v, depth + 1));
  // Keys count too: they end up as JSON text on the engine side as well.
  return Object.entries(input).some(([k, v]) => hasWebAddress(k, depth + 1) || hasWebAddress(v, depth + 1));
}
