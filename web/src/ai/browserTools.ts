// Tools that need a real browser: screenshots and HTML → layers import.

import { addAsset, readFileAsDataUrl } from "../assets";
import { screenshotBase64 } from "../exporter";
import { dispatchOrThrow, getDoc, selection, useStore, FONTS } from "../store";
import { bridgeHttpBase } from "./bridgeClient";

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
}

type Spec = Record<string, any>;

/** Fetches a live page through the local bridge (no CORS there) and imports it. */
export async function importUrl(input: { url: string; width?: number; x?: number; y?: number }) {
  let url: URL;
  try {
    url = new URL(input.url.includes("://") ? input.url : `https://${input.url}`);
  } catch {
    throw new Error(`not a valid URL: ${input.url}`);
  }
  let res: Response;
  try {
    res = await fetch(`${bridgeHttpBase()}/bridge/fetch?url=${encodeURIComponent(url.href)}`);
  } catch {
    throw new Error("importing a website needs the Designotron bridge running (setup steps in the Claude panel)");
  }
  if (!res.ok) throw new Error(await res.text());
  let html = await res.text();
  // Resolve relative stylesheets and images against the page. Scripts never run (sandboxed iframe).
  const base = `<base href="${url.href.replace(/"/g, "&quot;")}">`;
  html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + base) : `<!doctype html><html><head>${base}</head><body>${html}</body></html>`;
  return importHtml({ html, width: input.width ?? 1440, x: input.x, y: input.y, name: url.hostname });
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
    const root: Spec = {
      type: "frame",
      name: input.name || doc.title || "Imported HTML",
      x: input.x ?? 0,
      y: input.y ?? 0,
      width,
      height: total,
      fill: bodyBg ?? "#FFFFFF",
      clip: true,
      children: [],
    };
    const origin = { x: 0, y: 0 };
    for (const child of Array.from(body.childNodes)) await walk(child, win, root, origin);
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

async function walk(node: globalThis.Node, win: Window, parent: Spec, origin: { x: number; y: number }) {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = (node.textContent ?? "").replace(/\s+/g, " ");
    if (!text.trim()) return;
    const el = node.parentElement!;
    const cs = win.getComputedStyle(el);
    const range = node.ownerDocument!.createRange();
    range.selectNodeContents(node);
    const r = range.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const fontSize = parseFloat(cs.fontSize) || 16;
    const lh = cs.lineHeight === "normal" ? fontSize * 1.2 : parseFloat(cs.lineHeight);
    const lines = Math.round(r.height / lh);
    const family = cs.fontFamily.split(",")[0].replace(/["']/g, "").trim();
    const spec: Spec = {
      type: "text",
      text: cs.textTransform === "uppercase" ? text.trim().toUpperCase() : text.trim(),
      x: r.left - origin.x,
      y: r.top - origin.y,
      fontSize,
      fontWeight: parseInt(cs.fontWeight) || 400,
      fontFamily: family,
      lineHeight: lh,
      color: cs.color,
      italic: cs.fontStyle === "italic",
      textAlign: ["center", "right", "justify"].includes(cs.textAlign) ? cs.textAlign : "left",
    };
    if (cs.letterSpacing !== "normal") spec.letterSpacing = parseFloat(cs.letterSpacing) || 0;
    if (lines > 1) spec.width = Math.ceil(r.width) + 1;
    parent.children.push(spec);
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();
  if (["script", "style", "head", "meta", "link", "title", "noscript"].includes(tag)) return;
  const cs = win.getComputedStyle(el);
  if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) return;
  const r = el.getBoundingClientRect();
  const box = { x: r.left - origin.x, y: r.top - origin.y, width: r.width, height: r.height };

  if (tag === "img") {
    const src = (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src;
    parent.children.push({ type: "rectangle", name: el.getAttribute("alt") || "Image", ...box, imageUrl: await toAsset(src), cornerRadius: parseFloat(cs.borderTopLeftRadius) || 0 });
    return;
  }
  if (tag === "svg") {
    const clone = el.cloneNode(true) as SVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("width", String(r.width));
    clone.setAttribute("height", String(r.height));
    if (!clone.getAttribute("color")) clone.setAttribute("color", cs.color);
    const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(clone.outerHTML.replace(/currentColor/g, cs.color));
    parent.children.push({ type: "rectangle", name: "Icon", ...box, fills: [{ type: "image", src: "asset:" + addAsset(url), scaleMode: "fit" }] });
    return;
  }

  const bg = parseBg(cs);
  const bgImage = cs.backgroundImage.match(/url\("?([^")]+)"?\)/)?.[1];
  const bw = parseFloat(cs.borderTopWidth) || 0;
  const hasBorder = bw > 0 && cs.borderTopStyle !== "none";
  const shadow = parseShadow(cs.boxShadow);
  const radius = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map((v) => parseFloat(v) || 0);
  const visual = bg || bgImage || hasBorder || shadow;
  if (!visual) {
    for (const c of Array.from(el.childNodes)) await walk(c, win, parent, origin);
    return;
  }
  const spec: Spec = {
    type: "frame",
    name: el.id || el.className?.toString().split(" ")[0] || tag,
    ...box,
    fill: bg ?? "none",
    children: [],
    clip: cs.overflow === "hidden",
  };
  if (bgImage) spec.imageUrl = await toAsset(bgImage);
  if (hasBorder) {
    spec.stroke = cs.borderTopColor;
    spec.strokeWidth = bw;
  }
  if (shadow) spec.shadow = shadow;
  if (radius.some((v) => v > 0)) spec.cornerRadius = radius.every((v) => v === radius[0]) ? radius[0] : radius;
  const op = parseFloat(cs.opacity);
  if (op < 1) spec.opacity = op;
  parent.children.push(spec);
  for (const c of Array.from(el.childNodes)) await walk(c, win, spec, { x: r.left, y: r.top });
}
