// Tools that need a real browser: screenshots and HTML → layers import.

import { addAsset, readFileAsDataUrl } from "../assets";
import { screenshotBase64 } from "../exporter";
import { dispatchOrThrow, getDoc, selection, useStore, FONTS } from "../store";
import { bridgeChecked, bridgeHttpBase } from "./bridgeClient";
import { DEFAULT_CSS, emitSpec, planTree, type BoxNode, type Css, type Rect } from "./htmlLayout";

/** Picks what to screenshot when no id is given: selection, else the newest top-level frame. */
export async function getScreenshot(id?: string, scale = 1) {
  const doc = getDoc();
  let target = id && doc.nodes[id] ? id : selection()[0];
  if (!target) {
    const page = doc.pages.find((p) => p.id === useStore.getState().es.page);
    target = [...(page?.children ?? [])].reverse().find((c) => doc.nodes[c]?.visible) ?? "";
  }
  if (!target) throw new Error("nothing to screenshot: the page is empty");
  const shot = await screenshotBase64(target, Math.min(2, Math.max(0.25, scale || 1)));
  return { id: target, ...shot };
}

interface ImportInput {
  html: string;
  width?: number;
  x?: number;
  y?: number;
  parentId?: string;
  name?: string;
  /** Map flex/grid/block flow to auto layout (default). `false` keeps every layer absolutely positioned. */
  autoLayout?: boolean;
}

type Spec = Record<string, any>;

/** Fetches a live page through the local bridge (no CORS there) and imports it. `typed`:
 *  the person entered the address themselves, so pages on their own machine or network are
 *  allowed (Claude's imports reach only the public internet). */
export async function importUrl(input: { url: string; width?: number; x?: number; y?: number; autoLayout?: boolean }, typed = false) {
  let url: URL;
  try {
    url = new URL(input.url.includes("://") ? input.url : `https://${input.url}`);
  } catch {
    throw new Error(`not a valid URL: ${input.url}`);
  }
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
  return importHtml({ html, width: input.width ?? 1440, x: input.x, y: input.y, name: url.hostname, autoLayout: input.autoLayout });
}

/** Renders HTML in a hidden iframe and converts the box tree into layer specs. */
export async function importHtml(input: ImportInput) {
  if (!input.html) throw new Error("html is required");
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
      spec: { type: "frame", name: input.name || doc.title || "Imported HTML", fill: bodyBg ?? "#FFFFFF", clip: true },
      css: { ...readCss(win.getComputedStyle(body)), inset: [0, 0, 0, 0] },
      children,
    };
    if (input.autoLayout !== false) planTree(rootBox);
    const root = emitSpec(rootBox, rootBox.rect, { w: "fixed", h: rootBox.plan?.canHug.h ? "hug" : "fixed" });
    root.x = input.x ?? 0;
    root.y = input.y ?? 0;
    const r = dispatchOrThrow({ op: "ai", tool: "create_nodes", input: { parentId: input.parentId, nodes: [root] } });
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
    const box = textBox(node as Text, win);
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

  const kids: BoxNode[] = [];
  for (const c of Array.from(el.childNodes)) kids.push(...(await walk(c, win, auto)));
  const bg = parseBg(cs);
  const bgImage = cs.backgroundImage.match(/url\("?([^")]+)"?\)/)?.[1];
  const bw = parseFloat(cs.borderTopWidth) || 0;
  const hasBorder = bw > 0 && cs.borderTopStyle !== "none";
  const shadow = parseShadow(cs.boxShadow);
  const name = el.id || el.className?.toString().split(" ")[0] || tag;
  if (!(bg || bgImage || hasBorder || shadow)) {
    if (!kids.length) return [];
    const inline = cs.display === "inline" || cs.display === "contents";
    // With auto layout a padded wrapper stays: its padding is what positions the box inside it.
    const padded = css.inset.some((v) => v > 0.5);
    if (!inline && (kids.length > 1 || (auto && padded && kids[0].css.position !== "fixed"))) return [{ kind: "frame", rect, css, children: kids, spec: { type: "frame", name } }];
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

function textBox(node: Text, win: Window): BoxNode | null {
  const text = (node.textContent ?? "").replace(/\s+/g, " ");
  if (!text.trim()) return null;
  const el = node.parentElement!;
  const cs = win.getComputedStyle(el);
  const range = node.ownerDocument!.createRange();
  range.selectNodeContents(node);
  const r = range.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  const fontSize = parseFloat(cs.fontSize) || 16;
  const normal = cs.lineHeight === "normal";
  let lh = normal ? fontSize * 1.2 : parseFloat(cs.lineHeight);
  const lines = Math.max(1, Math.round(r.height / lh));
  // With `normal` the rect is the real line pitch, which is slightly more than 1.2 em for most fonts.
  if (normal) lh = r.height / lines;
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
  // The engine centres glyphs in each line box (like CSS half-leading), so place the line boxes.
  const h = lines * lh;
  const rect = { x: r.left, y: r.top - (h - r.height) / 2, w: lines > 1 ? Math.ceil(r.width) + 1 : r.width, h };
  return { kind: "text", rect, spec, css: { ...DEFAULT_CSS, display: "inline" }, children: [], hugText: lines === 1 };
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
