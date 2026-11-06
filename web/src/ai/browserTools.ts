// Tools that need a real browser: screenshots and HTML → layers import.

import { addAsset, readFileAsDataUrl } from "../assets";
import { screenshotBase64 } from "../exporter";
import { aiDispatch, getDoc, selection, useStore, FONTS } from "../store";
import { bridgeChecked, bridgeHttpBase } from "./bridgeClient";
import { DEFAULT_CSS, countLines, emitSpec, mergeInlineRuns, planTree, type BoxNode, type Css, type InlinePiece, type Rect, type RunStyle } from "./htmlLayout";

/** Picks what to screenshot when no id is given: selection, else the newest top-level frame. */
export async function getScreenshot(id?: string, scale = 1) {
  const doc = getDoc();
  if (id && !doc.nodes[id]) throw new Error(`no layer ${id}`);
  let target = id || selection()[0];
  if (!target) {
    const page = doc.pages.find((p) => p.id === useStore.getState().es.page);
    target = [...(page?.children ?? [])].reverse().find((c) => doc.nodes[c]?.visible) ?? "";
  }
  if (!target) throw new Error("nothing to screenshot: the page is empty");
  const shot = await screenshotBase64(target, Math.min(2, Math.max(0.25, scale || 1)));
  return { id: target, ...shot };
}

/** What a call gets when the file it was working on has closed (see `executeTool`). */
export const LEFT_FILE = "The person left the file this chat turn was working on, so the turn was stopped. Don't retry.";

interface ImportInput {
  /** False once the file the call started in has closed: the import then writes nothing. */
  stillOpen?: () => boolean;
  html: string;
  width?: number;
  x?: number;
  y?: number;
  parentId?: string;
  name?: string;
  /** Names the frame when there is no `name` and the page has no <title>. */
  fallbackName?: string;
  /** Map flex/grid/block flow to auto layout (default). `false` keeps every layer absolutely positioned. */
  autoLayout?: boolean;
  /** Undo group of the chat turn this import belongs to. */
  group?: string;
}

type Spec = Record<string, any>;

/** Fetches a live page through the local bridge (no CORS there) and imports it. `typed`:
 *  the person entered the address themselves, so pages on their own machine or network are
 *  allowed (Claude's imports reach only the public internet). */
export async function importUrl(input: { url: string; width?: number; x?: number; y?: number; autoLayout?: boolean; group?: string; stillOpen?: () => boolean }, typed = false) {
  if (typeof input?.url !== "string" || !input.url.trim()) throw new Error("url must be a string like https://example.com");
  const raw = input.url.trim();
  if (/\s/.test(raw)) throw new Error(`not a valid URL: ${raw}`);
  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    throw new Error(`not a valid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`only http and https addresses can be imported: ${raw}`);
  let res: Response;
  try {
    await bridgeChecked();
    res = await fetch(`${bridgeHttpBase()}/bridge/fetch?url=${encodeURIComponent(url.href)}${typed ? "&local=true" : ""}`);
  } catch {
    throw new Error("importing a website needs the Designotron bridge running (setup steps in the Claude panel)");
  }
  const NEEDS_BRIDGE = "importing a website needs the Designotron bridge running (setup steps in the Claude panel)";
  // No bridge behind this address: a static host answers 404 or its own HTML page.
  if (res.status === 404 || res.status === 405) throw new Error(NEEDS_BRIDGE);
  if (!res.ok) throw new Error((await res.text()) || `couldn't fetch ${url.href} (HTTP ${res.status})`);
  let html = await res.text();
  // Resolve relative stylesheets and images against the page. Scripts never run (sandboxed iframe).
  const base = `<base href="${url.href.replace(/"/g, "&quot;")}">`;
  html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + base) : `<!doctype html><html><head>${base}</head><body>${html}</body></html>`;
  // The frame takes the page's <title>; the host name only names pages that have none.
  return importHtml({ html, width: input.width ?? 1440, x: input.x, y: input.y, fallbackName: url.hostname, autoLayout: input.autoLayout, group: input.group, stillOpen: input.stillOpen });
}

/** Renders HTML in a hidden iframe and converts the box tree into layer specs. */
export async function importHtml(input: ImportInput) {
  if (typeof input?.html !== "string") throw new Error("html must be a string of HTML");
  if (!input.html.trim()) throw new Error("html is required");
  const width = input.width ?? 1280;
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-same-origin");
  iframe.style.cssText = `position:fixed;left:-20000px;top:0;width:${width}px;height:50px;border:0;visibility:hidden`;
  const fonts = FONTS.map((f) => `family=${f.replace(/ /g, "+")}:wght@300;400;500;600;700;800`).join("&");
  const html = /<html[\s>]/i.test(input.html)
    ? input.html
    : `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?${fonts}&display=swap"><style>*{box-sizing:border-box}body{margin:0;font-family:Inter,sans-serif}</style></head><body>${input.html}</body></html>`;
  document.body.appendChild(iframe);
  try {
    await new Promise<void>((resolve) => {
      iframe.onload = () => resolve();
      iframe.srcdoc = html;
    });
    const doc = iframe.contentDocument!;
    await Promise.race([doc.fonts?.ready, new Promise((r) => setTimeout(r, 1500))]);
    const win = iframe.contentWindow!;
    const body = doc.body;
    const bm = win.getComputedStyle(body);
    const total = Math.max(1, Math.ceil(body.scrollHeight + (parseFloat(bm.marginTop) || 0) + (parseFloat(bm.marginBottom) || 0)));
    iframe.style.height = `${total}px`;
    const bodyBg = parseBg(win.getComputedStyle(body), win.getComputedStyle(doc.documentElement));
    // Box tree in page coordinates, then auto layout inference, then create_nodes specs.
    const children: BoxNode[] = [];
    for (const child of Array.from(body.childNodes)) children.push(...(await walk(child, win, input.autoLayout !== false)));
    const rootBox: BoxNode = {
      kind: "frame",
      rect: { x: 0, y: 0, w: width, h: total },
      spec: { type: "frame", name: input.name || doc.title.replace(/\s+/g, " ").trim().slice(0, 60) || input.fallbackName || "Imported HTML", fill: bodyBg ?? "#FFFFFF", clip: true },
      css: { ...readCss(win.getComputedStyle(body)), inset: [0, 0, 0, 0] },
      children,
    };
    if (input.autoLayout !== false) planTree(rootBox);
    const root = emitSpec(rootBox, rootBox.rect, { w: "fixed", h: rootBox.plan?.canHug.h ? "hug" : "fixed" });
    root.x = input.x ?? 0;
    root.y = input.y ?? 0;
    // Last await is behind us: don't write into a file the person has left meanwhile.
    if (input.stillOpen && !input.stillOpen()) throw new Error(LEFT_FILE);
    const r = aiDispatch("create_nodes", { parentId: input.parentId, nodes: [root] }, input.group);
    return r;
  } finally {
    iframe.remove();
  }
}

function parseBg(cs: CSSStyleDeclaration, fallback?: CSSStyleDeclaration): string | null {
  const img = cs.backgroundImage;
  if (img && img.startsWith("linear-gradient")) return img;
  const c = cs.backgroundColor;
  if (c && c !== "rgba(0, 0, 0, 0)" && c !== "transparent") return c;
  if (fallback) return parseBg(fallback);
  return null;
}

function parseShadow(s: string): Spec[] | null {
  if (!s || s === "none") return null;
  const parts = s.split(/,(?![^(]*\))/);
  return parts.map((p) => {
    const color = p.match(/rgba?\([^)]*\)|#[0-9a-f]+/i)?.[0] ?? "rgba(0,0,0,0.25)";
    const nums = p
      .replace(color, "")
      .trim()
      .split(/\s+/)
      .filter((t) => t.endsWith("px") || t === "0")
      .map((t) => parseFloat(t));
    return { color, x: nums[0] ?? 0, y: nums[1] ?? 0, blur: nums[2] ?? 0, spread: nums[3] ?? 0, inset: p.includes("inset") };
  });
}

async function toAsset(url: string): Promise<string> {
  if (url.startsWith("data:")) return "asset:" + addAsset(url);
  try {
    const blob = await (await fetch(url)).blob();
    return "asset:" + addAsset(await readFileAsDataUrl(blob));
  } catch {
    return url;
  }
}

const BLOCKISH = ["block", "list-item", "flow-root", "table-cell", "inline-block"];

/** Converts a DOM node into boxes in page coordinates. Elements without visuals are kept as
 *  transparent frames only when they group two or more boxes; otherwise their content moves up. */
async function walk(node: globalThis.Node, win: Window, auto: boolean): Promise<BoxNode[]> {
  if (node.nodeType === Node.TEXT_NODE) {
    const box = textBox(node as Text, win, auto);
    return box ? [box] : [];
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return [];
  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();
  if (["script", "style", "head", "meta", "link", "title", "noscript"].includes(tag)) return [];
  const cs = win.getComputedStyle(el);
  if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) return [];
  const r = el.getBoundingClientRect();
  const rect = { x: r.left, y: r.top, w: r.width, h: r.height };
  const css = readCss(cs);

  if (tag === "img") {
    const src = (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src;
    const spec = { type: "rectangle", name: el.getAttribute("alt") || "Image", imageUrl: await toAsset(src), cornerRadius: parseFloat(cs.borderTopLeftRadius) || 0 };
    return [{ kind: "leaf", rect, css, children: [], spec }];
  }
  if (tag === "svg") {
    const clone = el.cloneNode(true) as SVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("width", String(r.width));
    clone.setAttribute("height", String(r.height));
    if (!clone.getAttribute("color")) clone.setAttribute("color", cs.color);
    const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(clone.outerHTML.replace(/currentColor/g, cs.color));
    return [{ kind: "leaf", rect, css, children: [], spec: { type: "rectangle", name: "Icon", fills: [{ type: "image", src: "asset:" + addAsset(url), scaleMode: "fit" }] } }];
  }

  // A block of text with inline formatting is one text layer with mixed styles, not one per run.
  const runs = inlineText(el, cs, win, auto);
  const kids: BoxNode[] = runs ? [runs] : [];
  if (!runs) for (const c of Array.from(el.childNodes)) kids.push(...(await walk(c, win, auto)));
  const bg = parseBg(cs);
  const bgImage = cs.backgroundImage.match(/url\("?([^")]+)"?\)/)?.[1];
  const bw = parseFloat(cs.borderTopWidth) || 0;
  const hasBorder = bw > 0 && cs.borderTopStyle !== "none";
  const shadow = parseShadow(cs.boxShadow);
  const name = layerName(el, tag);
  if (!(bg || bgImage || hasBorder || shadow)) {
    if (!kids.length) return [];
    // Without auto layout every visual-less element dissolves into its parent (the original import).
    if (!auto) return kids;
    const inline = cs.display === "inline" || cs.display === "contents";
    // With auto layout a padded wrapper stays: its padding is what positions the box inside it.
    const padded = css.inset.some((v) => v > 0.5);
    if (!inline && (kids.length > 1 || (padded && kids[0].css.position !== "fixed"))) return [{ kind: "frame", rect, css, children: kids, spec: { type: "frame", name } }];
    if (!inline && kids.length === 1) adoptSoleChild(kids[0], el, cs, css, rect);
    return kids;
  }
  const radius = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map((v) => parseFloat(v) || 0);
  const spec: Spec = { type: "frame", name, fill: bg ?? "none", clip: cs.overflow === "hidden" };
  if (bgImage) spec.imageUrl = await toAsset(bgImage);
  if (hasBorder) {
    spec.stroke = cs.borderTopColor;
    spec.strokeWidth = bw;
  }
  if (shadow) spec.shadow = shadow;
  if (radius.some((v) => v > 0)) spec.cornerRadius = radius.every((v) => v === radius[0]) ? radius[0] : radius;
  const op = parseFloat(cs.opacity);
  if (op < 1) spec.opacity = op;
  return [{ kind: "frame", rect, css, children: kids, spec }];
}

/** Tag → layer name, and the whole words in a class or id that say the same thing. Code export picks
 *  button, nav, header, footer and so on from the words in a layer name (`container_tag` in codegen.rs),
 *  so a class is kept only when it matches the element's own tag: `<button class="menu-toggle">` is a
 *  "Button", not the nav that "menu" would make it. */
const LAYER_NAMES: Record<string, [string, string[]]> = {
  header: ["Header", ["header", "topbar"]],
  nav: ["Nav", ["nav", "navbar", "navigation", "menu"]],
  footer: ["Footer", ["footer"]],
  main: ["Main", ["main"]],
  section: ["Section", ["section", "hero", "features", "pricing", "testimonials", "faq"]],
  aside: ["Sidebar", ["sidebar"]],
  button: ["Button", ["button", "btn", "cta"]],
  form: ["Form", ["form"]],
  input: ["Input", ["input"]],
  a: ["Link", ["link"]],
  li: ["List item", ["item"]],
  ul: ["List", ["list", "nav", "navbar", "navigation", "menu"]],
  ol: ["List", ["list"]],
  article: ["Article", ["article"]],
  h1: ["Heading 1", []],
  h2: ["Heading 2", []],
  h3: ["Heading 3", []],
  h4: ["Heading 4", []],
  h5: ["Heading 5", []],
  h6: ["Heading 6", []],
};

function layerName(el: HTMLElement, tag: string): string {
  const own = el.id || el.className?.toString().trim().split(/\s+/)[0] || "";
  const known = LAYER_NAMES[tag];
  if (!known) return own || tag;
  const words = own.toLowerCase().split(/[^a-z0-9]+/);
  // Also no word that would make it another tag: `nav-link` on an <a> would export as a <nav>.
  const other = words.some((w) => CODE_WORDS.includes(w) && !known[1].includes(w));
  return own && !other && words.some((w) => known[1].includes(w)) ? own : known[0];
}

const CODE_WORDS = ["button", "btn", "cta", "nav", "navbar", "navigation", "menu", "header", "topbar", "footer", "sidebar", "main", "hero", "section", "features", "pricing", "testimonials", "faq"];

/** A wrapper that only holds one box hands its place in the layout to that box. Text that is
 *  the whole content of a block takes the block's content width, so it wraps and aligns the same. */
function adoptSoleChild(kid: BoxNode, el: HTMLElement, cs: CSSStyleDeclaration, css: Css, rect: Rect) {
  const outOfFlow = css.position === "absolute" || css.position === "fixed";
  if (kid.kind === "text" && BLOCKISH.includes(cs.display) && !outOfFlow && kid.css.position === "static") {
    const left = rect.x + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.paddingLeft) || 0);
    const inner = el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    if (inner > 0 && kid.rect.x >= left - 1 && kid.rect.x + kid.rect.w <= left + inner + 1) {
      if (!kid.hugText || inner - kid.rect.w > 1) {
        kid.rect.x = left;
        kid.rect.w = inner;
        kid.hugText = false;
      }
      kid.css = { ...css, inset: [0, 0, 0, 0] };
      return;
    }
  }
  if (outOfFlow) kid.css = { ...kid.css, position: css.position };
  else if (Math.abs(kid.rect.x - rect.x) < 0.5 && Math.abs(kid.rect.w - rect.w) < 0.5) {
    kid.css = { ...kid.css, display: css.display, flexGrow: css.flexGrow, alignSelf: css.alignSelf, float: css.float };
  }
}

function textBox(node: Text, win: Window, auto: boolean): BoxNode | null {
  const text = (node.textContent ?? "").replace(/\s+/g, " ");
  if (!text.trim()) return null;
  const el = node.parentElement!;
  const cs = win.getComputedStyle(el);
  const range = node.ownerDocument!.createRange();
  range.selectNodeContents(node);
  const r = range.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  const fontSize = parseFloat(cs.fontSize) || 16;
  let lh = cs.lineHeight === "normal" ? fontSize * 1.2 : parseFloat(cs.lineHeight);
  let lines = Math.round(r.height / lh);
  // Auto layout needs exact line boxes: count the lines from the browser's line rects (a tall
  // line-height makes height / lh undercount) and take `normal` line pitch from them.
  let top = r.top;
  let contentH = r.height;
  if (auto) {
    const rects = Array.from(range.getClientRects()).filter((q) => q.width > 0 && q.height > 0).sort((p, q) => p.top - q.top);
    if (rects.length) {
      const tops = [rects[0].top];
      for (const q of rects) if (q.top - tops[tops.length - 1] > 1) tops.push(q.top);
      lines = tops.length;
      contentH = rects[0].height;
      top = rects[0].top;
      if (cs.lineHeight === "normal") lh = lines > 1 ? (tops[lines - 1] - tops[0]) / (lines - 1) : contentH;
    }
    lines = Math.max(1, lines);
  }
  const family = cs.fontFamily.split(",")[0].replace(/["']/g, "").trim();
  const spec: Spec = {
    type: "text",
    text: cs.textTransform === "uppercase" ? text.trim().toUpperCase() : text.trim(),
    fontSize,
    fontWeight: parseInt(cs.fontWeight) || 400,
    fontFamily: family,
    lineHeight: lh,
    color: cs.color,
    italic: cs.fontStyle === "italic",
    textAlign: ["center", "right", "justify"].includes(cs.textAlign) ? cs.textAlign : "left",
  };
  if (cs.letterSpacing !== "normal") spec.letterSpacing = parseFloat(cs.letterSpacing) || 0;
  const w = lines > 1 ? Math.ceil(r.width) + 1 : r.width;
  // The engine centres glyphs in each line box (like CSS half-leading), so auto layout places line boxes.
  const rect = auto ? { x: r.left, y: top - (lh - contentH) / 2, w, h: lines * lh } : { x: r.left, y: r.top, w, h: r.height };
  return { kind: "text", rect, spec, css: { ...DEFAULT_CSS, display: "inline" }, children: [], hugText: lines <= 1 };
}

const NOT_INLINE_TEXT = ["img", "svg", "video", "canvas", "iframe", "input", "select", "textarea", "object", "embed", "picture", "audio"];
const TEXT_CONTAINERS = ["block", "list-item", "flow-root", "inline", "table-cell", "inline-block"];
const SAFE_LINK = /^(https?:\/\/|mailto:|tel:)/i;

interface InlineCtx {
  link?: string;
  decoration: RunStyle["decoration"];
  /** px per character that the chips around this text add with their horizontal padding and border. */
  extra: number;
}

/** One text box for a block whose content is only text, `<br>` and inline elements without their
 *  own box (strong, em, a, span, code without a background...). Null when the element has anything
 *  else (badges, images, nested blocks, flex/grid children) or nothing to merge, so the caller walks
 *  its children as before. */
function inlineText(el: HTMLElement, cs: CSSStyleDeclaration, win: Window, auto: boolean): BoxNode | null {
  if (!TEXT_CONTAINERS.includes(cs.display) || cs.whiteSpace.startsWith("pre") || cs.whiteSpace === "break-spaces") return null;
  if (NOT_INLINE_TEXT.includes(el.tagName.toLowerCase())) return null;
  const scan = { pieces: [] as InlinePiece[], structure: false };
  if (!gatherInline(el, cs, { link: linkOf(el), decoration: decorationOf(cs, undefined), extra: 0 }, win, scan)) return null;
  const merged = mergeInlineRuns(scan.pieces);
  if (!merged) return null;
  // A lone text node keeps the plain path unless it carries a link or a decoration.
  if (!scan.structure && !merged.spans.some((s) => s.link || s.decoration)) return null;

  const frags: DOMRect[] = [];
  for (const n of textNodesOf(el)) {
    if (!/\S/.test(n.textContent ?? "")) continue;
    const range = el.ownerDocument.createRange();
    range.selectNodeContents(n);
    frags.push(...Array.from(range.getClientRects()).filter((q) => q.width > 0 && q.height > 0));
  }
  if (!frags.length) return null;
  const left = Math.min(...frags.map((q) => q.left));
  const right = Math.max(...frags.map((q) => q.right));
  const topAll = Math.min(...frags.map((q) => q.top));
  const bottomAll = Math.max(...frags.map((q) => q.bottom));
  // Lines come from vertical positions only, so right-to-left and bidirectional text and blank
  // `<br>` lines count right.
  const fontSize = parseFloat(cs.fontSize) || 16;
  const glyphH = frags[0].height;
  let lh = cs.lineHeight === "normal" ? glyphH : parseFloat(cs.lineHeight);
  if (!Number.isFinite(lh) || lh <= 0) lh = glyphH;
  const { lines, starts } = countLines(frags.map((q) => (q.top + q.bottom) / 2), lh);
  if (cs.lineHeight === "normal" && lines > 1) lh = (starts[starts.length - 1] - starts[0]) / (lines - 1);
  // The block's content box is exact. Runs in another font can make a line box taller than the line
  // height, so the paragraph is then a little taller than lines × line height: keep the layer that
  // tall through its line height (it stays auto height and grows when edited). A box much taller
  // than its text (a button, a centred flex item) only says where the box is, not where the text is.
  let box: { top: number; h: number } | null = null;
  if (auto && cs.display !== "inline") {
    const b = el.getBoundingClientRect();
    const px = (v: string) => parseFloat(v) || 0;
    const h = b.height - px(cs.paddingTop) - px(cs.paddingBottom) - px(cs.borderTopWidth) - px(cs.borderBottomWidth);
    const top = b.top + px(cs.paddingTop) + px(cs.borderTopWidth);
    if (h > 0 && Math.abs(h - lines * lh) <= 0.1 * lines * lh + 1 && Math.abs(top - frags[0].top) <= Math.max(3, lh)) box = { top, h };
  }
  if (!Number.isFinite(lh) || lh < 0.8 * fontSize) lh = (box ? box.h : (bottomAll - topAll)) / lines;
  const lineHeight = box && Math.abs(box.h - lines * lh) > 0.5 ? Math.floor((box.h / lines) * 1000) / 1000 : lh;
  const style = (r: RunStyle): Spec => {
    const out: Spec = { fontWeight: r.fontWeight, italic: r.italic, color: r.color, fontSize: r.fontSize, fontFamily: r.fontFamily, letterSpacing: r.letterSpacing ?? 0 };
    // A link the page doesn't underline says so (code export underlines links that don't).
    if (r.decoration || r.link) out.decoration = r.decoration ?? "none";
    if (r.link) out.link = r.link;
    return out;
  };
  const one = merged.spans.length === 1 && !merged.spans[0].link ? merged.spans[0] : null;
  const spec: Spec = one
    ? { type: "text", text: merged.text, ...style(one), lineHeight }
    : {
        type: "text",
        spans: merged.spans.map((r) => ({ text: r.text, ...style(r) })),
        fontSize,
        fontWeight: parseInt(cs.fontWeight) || 400,
        fontFamily: firstFamily(cs),
        lineHeight,
        color: cs.color,
        italic: cs.fontStyle === "italic",
      };
  // `start` and `end` follow the writing direction.
  const rtl = cs.direction === "rtl";
  const align = cs.textAlign === "start" ? (rtl ? "right" : "left") : cs.textAlign === "end" ? (rtl ? "left" : "right") : cs.textAlign;
  spec.textAlign = ["center", "right", "justify"].includes(align) ? align : "left";
  if (!one && cs.letterSpacing !== "normal") spec.letterSpacing = parseFloat(cs.letterSpacing) || 0;
  const w = lines > 1 ? Math.ceil(right - left) + 1 : right - left;
  const rect = !auto
    ? { x: left, y: topAll, w, h: bottomAll - topAll }
    : box
      ? { x: left, y: box.top, w, h: box.h }
      : { x: left, y: frags[0].top - (lh - glyphH) / 2, w, h: lines * lh };
  return { kind: "text", rect, spec, css: { ...DEFAULT_CSS, display: "inline" }, children: [], hugText: lines <= 1 };
}

/** Collects the styled pieces of an inline formatting context. False when a child has its own box. */
function gatherInline(parent: HTMLElement, pcs: CSSStyleDeclaration, ctx: InlineCtx, win: Window, scan: { pieces: InlinePiece[]; structure: boolean }): boolean {
  for (const c of Array.from(parent.childNodes)) {
    if (c.nodeType === Node.TEXT_NODE) {
      const raw = c.textContent ?? "";
      scan.pieces.push({ text: pcs.textTransform === "uppercase" ? raw.toUpperCase() : raw, style: runStyle(pcs, ctx) });
      continue;
    }
    if (c.nodeType !== Node.ELEMENT_NODE) continue;
    const e = c as HTMLElement;
    const tag = e.tagName.toLowerCase();
    if (tag === "br") {
      scan.pieces.push({ br: true });
      scan.structure = true;
      continue;
    }
    const cs = win.getComputedStyle(e);
    if (cs.display === "none") continue;
    if (NOT_INLINE_TEXT.includes(tag) || cs.display !== "inline" || cs.position !== "static" || cs.float !== "none") return false;
    if (cs.visibility === "hidden" || parseFloat(cs.opacity) < 1 || cs.verticalAlign !== "baseline" || cs.whiteSpace.startsWith("pre")) return false;
    if (hasBoxVisuals(cs)) return false;
    // A chip is wider than its text by its horizontal padding and border. A run can't carry those, so
    // the width is spread over its characters as letter spacing: lines then break where the browser's do.
    let extra = ctx.extra;
    const sides = chipWidth(cs);
    if (sides > 0) {
      const chars = Array.from((e.textContent ?? "").replace(/\s+/g, " ").trim()).length;
      if (!chars) return false;
      extra += sides / chars;
    }
    scan.structure = true;
    if (!gatherInline(e, cs, { link: linkOf(e) ?? ctx.link, decoration: decorationOf(cs, ctx.decoration), extra }, win, scan)) return false;
  }
  return true;
}

/** An inline element with only a background colour, border, padding or radius (a code chip) joins
 *  the text as a run and loses that styling. Shadows, margins and background images (an inline icon)
 *  can't be carried by a run, so those elements stay boxes of their own. */
function hasBoxVisuals(cs: CSSStyleDeclaration): boolean {
  if (parseFloat(cs.marginLeft) || parseFloat(cs.marginRight) || parseFloat(cs.marginTop) || parseFloat(cs.marginBottom)) return true;
  return cs.boxShadow !== "none" || cs.backgroundImage !== "none";
}

/** Left and right padding plus border of an inline element: the width it adds to its text. */
function chipWidth(cs: CSSStyleDeclaration): number {
  const border = (side: "Left" | "Right") => (cs[`border${side}Style`] !== "none" ? parseFloat(cs[`border${side}Width`]) || 0 : 0);
  return (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) + border("Left") + border("Right");
}

function runStyle(cs: CSSStyleDeclaration, ctx: InlineCtx): RunStyle {
  return {
    letterSpacing: Math.round(((parseFloat(cs.letterSpacing) || 0) + ctx.extra) * 1000) / 1000,
    fontWeight: parseInt(cs.fontWeight) || 400,
    italic: cs.fontStyle === "italic" || cs.fontStyle === "oblique",
    color: cs.color,
    fontSize: parseFloat(cs.fontSize) || 16,
    fontFamily: firstFamily(cs),
    decoration: ctx.decoration,
    link: ctx.link,
  };
}

/** Text decorations paint over inline descendants, but the computed value isn't inherited. */
function decorationOf(cs: CSSStyleDeclaration, inherited: RunStyle["decoration"]): RunStyle["decoration"] {
  const line = cs.textDecorationLine;
  if (line.includes("underline")) return "underline";
  if (line.includes("line-through")) return "line-through";
  return inherited;
}

/** The link of an `<a href>`, or undefined when the engine wouldn't keep it. Only absolute web, mail
 *  and phone addresses count. A relative one resolves against the page only when the page brings its
 *  own `<base>` (a URL import); in pasted HTML it would resolve against the editor. */
function linkOf(el: HTMLElement): string | undefined {
  if (el.tagName.toLowerCase() !== "a") return undefined;
  const raw = (el.getAttribute("href") ?? "").trim();
  if (!raw) return undefined;
  let href = raw;
  if (!SAFE_LINK.test(raw)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || !el.ownerDocument.querySelector("base[href]")) return undefined;
    href = (el as HTMLAnchorElement).href;
    if (!SAFE_LINK.test(href)) return undefined;
  }
  try {
    new URL(href);
  } catch {
    return undefined;
  }
  return href;
}

function firstFamily(cs: CSSStyleDeclaration): string {
  return cs.fontFamily.split(",")[0].replace(/["']/g, "").trim();
}

function textNodesOf(el: HTMLElement): Text[] {
  const out: Text[] = [];
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  return out;
}

function readCss(cs: CSSStyleDeclaration): Css {
  const px = (v: string) => parseFloat(v) || 0;
  const tracks = cs.gridTemplateColumns && cs.gridTemplateColumns !== "none" ? cs.gridTemplateColumns.split(/\s+(?![^(]*\))/) : [];
  return {
    display: cs.display,
    position: cs.position,
    float: cs.float || "none",
    flexDirection: cs.flexDirection,
    flexWrap: cs.flexWrap,
    justifyContent: cs.justifyContent,
    alignItems: cs.alignItems,
    alignSelf: cs.alignSelf,
    flexGrow: px(cs.flexGrow),
    rowGap: px(cs.rowGap),
    columnGap: px(cs.columnGap),
    textAlign: cs.textAlign,
    gridColumns: tracks.filter((t) => /px$/.test(t)).length,
    inset: [
      px(cs.paddingTop) + px(cs.borderTopWidth),
      px(cs.paddingRight) + px(cs.borderRightWidth),
      px(cs.paddingBottom) + px(cs.borderBottomWidth),
      px(cs.paddingLeft) + px(cs.borderLeftWidth),
    ],
  };
}
