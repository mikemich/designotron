// Auto layout inference for HTML import. Pure functions (no DOM): `browserTools.ts` turns the
// rendered page into a `BoxNode` tree, `planTree` decides which containers become auto layout,
// and `emitSpec` writes create_nodes specs. A container only gets auto layout when a simulation
// of the engine's layout (mirroring `crates/engine/src/layout.rs`) puts every child within
// `TOL` px of where the browser drew it; otherwise its children stay absolutely positioned.

export type Spec = Record<string, any>;

/** Max distance (px) between the browser's box and the engine's for a layout to be accepted. */
export const TOL = 2;
/** Extra trailing space (px) beyond CSS padding that still counts as padding (a last child's margin). */
const SLACK = 64;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The computed CSS a layout decision needs. `inset` is padding + border: [top, right, bottom, left]. */
export interface Css {
  display: string;
  position: string;
  float: string;
  flexDirection: string;
  flexWrap: string;
  justifyContent: string;
  alignItems: string;
  alignSelf: string;
  flexGrow: number;
  rowGap: number;
  columnGap: number;
  textAlign: string;
  gridColumns: number;
  inset: [number, number, number, number];
}

export interface BoxNode {
  kind: "frame" | "text" | "leaf";
  /** Page coordinates. Text uses its line boxes (lines × line height), not the glyph box. */
  rect: Rect;
  /** Visual properties only (no geometry or children). */
  spec: Spec;
  css: Css;
  children: BoxNode[];
  /** Text sized by its content (single line); otherwise its width is fixed and it wraps. */
  hugText?: boolean;
  plan?: Plan;
}

export interface Layout {
  direction: "horizontal" | "vertical";
  gap: number;
  counterGap: number;
  padding: [number, number, number, number];
  align: "start" | "center" | "end" | "space-between";
  crossAlign: "start" | "center" | "end";
  wrap: boolean;
}

type Size = "fixed" | "hug" | "fill";

export interface Plan {
  layout: Layout;
  /** In-flow children in layout order. */
  flow: BoxNode[];
  sizing: Map<BoxNode, { w: Size; h: Size }>;
  /** Whether the engine's hug size matches the browser's on each axis. */
  canHug: { w: boolean; h: boolean };
}

export const DEFAULT_CSS: Css = {
  display: "block",
  position: "static",
  float: "none",
  flexDirection: "row",
  flexWrap: "nowrap",
  justifyContent: "normal",
  alignItems: "normal",
  alignSelf: "auto",
  flexGrow: 0,
  rowGap: 0,
  columnGap: 0,
  textAlign: "left",
  gridColumns: 0,
  inset: [0, 0, 0, 0],
};

/** Plans auto layout bottom-up for a whole tree (children first, so their hug sizes are known). */
export function planTree(node: BoxNode) {
  for (const c of node.children) planTree(c);
  if (node.kind === "frame") node.plan = planContainer(node) ?? undefined;
}

/** Writes the create_nodes spec for a planned tree. `parent` is the parent's page rect. */
export function emitSpec(node: BoxNode, parent: Rect, sizing?: { w: Size; h: Size }, absolute = false): Spec {
  const spec: Spec = { ...node.spec, x: round(node.rect.x - parent.x), y: round(node.rect.y - parent.y) };
  if (absolute) spec.absolute = true;
  const own = sizing ?? defaultSizing(node);
  if (node.kind === "text") {
    if (own.w === "fill") spec.width = "fill";
    else if (!node.hugText) spec.width = round(node.rect.w);
    return spec;
  }
  spec.width = own.w === "fixed" ? round(node.rect.w) : own.w;
  spec.height = own.h === "fixed" ? round(node.rect.h) : own.h;
  if (node.kind !== "frame") return spec;
  const plan = node.plan;
  if (!plan) {
    spec.children = node.children.map((c) => emitSpec(c, node.rect));
    return spec;
  }
  const l = plan.layout;
  spec.layout = { direction: l.direction, gap: round(l.gap), padding: l.padding.map(round), align: l.align, crossAlign: l.crossAlign };
  if (l.wrap) {
    spec.layout.wrap = true;
    spec.layout.counterGap = round(l.counterGap);
  }
  // Out-of-flow children keep their DOM slot (paint order); flow children take layout order.
  const flow = [...plan.flow];
  spec.children = node.children.map((c) =>
    inFlow(c) ? emitFlowChild(flow.shift()!, node.rect, plan) : emitSpec(c, node.rect, undefined, true),
  );
  return spec;
}

/** Decides auto layout for one frame, or null to keep its children absolutely positioned. */
export function planContainer(node: BoxNode): Plan | null {
  const flow = node.children.filter(inFlow);
  if (!flow.length) return null;
  for (const mode of modes(node, flow)) {
    const plan = mode.wrap ? tryWrap(node, flow) : tryStack(node, flow, mode.horizontal);
    if (plan) return plan;
  }
  return null;
}

/** Simulates the engine's auto layout. Returns child rects relative to the frame and its size. */
export function simulate(l: Layout, items: SimItem[], w: number, h: number, hugMain: boolean, hugCross: boolean): { rects: Rect[]; w: number; h: number } {
  const horizontal = l.direction === "horizontal";
  const [pt, pr, pb, pl] = l.padding;
  const [ps, pe, pcs, pce] = horizontal ? [pl, pr, pt, pb] : [pt, pb, pl, pr];
  const n = items.length;
  const its = items.map((i) => ({ ...i }));
  const gapTotal = n > 1 && l.align !== "space-between" ? l.gap * (n - 1) : 0;
  let main = horizontal ? w : h;
  let cross = horizontal ? h : w;
  const wrap = l.wrap && horizontal && !hugMain;
  if (hugMain) {
    main = its.reduce((s, i) => s + i.main, 0) + gapTotal + ps + pe;
  } else if (!wrap) {
    const inner = main - ps - pe;
    const fixed = its.filter((i) => !i.fillMain).reduce((s, i) => s + i.main, 0);
    const fills = its.filter((i) => i.fillMain);
    const each = Math.max(1, (inner - fixed - gapTotal) / Math.max(1, fills.length));
    for (const i of fills) i.main = each;
  }
  if (hugCross && !wrap) {
    const fixed = its.filter((i) => !i.fillCross).map((i) => i.cross);
    cross = (fixed.length ? Math.max(...fixed) : Math.max(0, ...its.map((i) => i.cross))) + pcs + pce;
  }
  const innerCross = cross - pcs - pce;
  if (!(hugCross && wrap)) for (const i of its.filter((i) => i.fillCross)) i.cross = Math.max(1, innerCross);
  const rects: Rect[] = [];
  const place = (i: { main: number; cross: number }, m: number, c: number) =>
    rects.push(horizontal ? { x: m, y: c, w: i.main, h: i.cross } : { x: c, y: m, w: i.cross, h: i.main });
  if (wrap) {
    const inner = main - pl - pr;
    const rows: (typeof its)[] = [[]];
    let rowW = 0;
    for (const it of its) {
      const row = rows[rows.length - 1];
      const add = row.length ? l.gap + it.main : it.main;
      if (row.length && rowW + add > inner + 0.01) {
        rows.push([it]);
        rowW = it.main;
      } else {
        row.push(it);
        rowW += add;
      }
    }
    let y = pt;
    for (const row of rows) {
      const rowH = Math.max(0, ...row.map((i) => i.cross));
      const used = row.reduce((s, i) => s + i.main, 0) + l.gap * (Math.max(1, row.length) - 1);
      let x = pl + (l.align === "center" ? (inner - used) / 2 : l.align === "end" ? inner - used : 0);
      for (const it of row) {
        const cy = l.crossAlign === "center" ? y + (rowH - it.cross) / 2 : l.crossAlign === "end" ? y + rowH - it.cross : y;
        place(it, x, cy);
        x += it.main + l.gap;
      }
      y += rowH + l.counterGap;
    }
    if (hugCross) cross = y - l.counterGap + pb;
  } else {
    const innerMain = main - ps - pe;
    const sum = its.reduce((s, i) => s + i.main, 0);
    const free = innerMain - sum - gapTotal;
    let cursor = ps;
    let gap = l.gap;
    if (l.align === "center") cursor += free / 2;
    else if (l.align === "end") cursor += free;
    else if (l.align === "space-between") gap = n > 1 ? (innerMain - sum) / (n - 1) : 0;
    for (const it of its) {
      const c = l.crossAlign === "center" ? pcs + (innerCross - it.cross) / 2 : l.crossAlign === "end" ? pcs + innerCross - it.cross : pcs;
      place(it, cursor, c);
      cursor += it.main + gap;
    }
  }
  return horizontal ? { rects, w: main, h: cross } : { rects, w: cross, h: main };
}

export interface SimItem {
  main: number;
  cross: number;
  fillMain: boolean;
  fillCross: boolean;
}

// ---------------------------------------------------------------------------------------------

function emitFlowChild(c: BoxNode, parentRect: Rect, plan: Plan): Spec {
  return emitSpec(c, parentRect, plan.sizing.get(c));
}

function defaultSizing(node: BoxNode): { w: Size; h: Size } {
  const hug = node.plan?.canHug;
  return { w: hug?.w && contentSized(node.css) ? "hug" : "fixed", h: hug?.h ? "hug" : "fixed" };
}

export function inFlow(c: BoxNode): boolean {
  return c.css.position !== "absolute" && c.css.position !== "fixed";
}

/** Layout modes to try, most likely first. */
function modes(node: BoxNode, flow: BoxNode[]): { horizontal: boolean; wrap: boolean }[] {
  const d = node.css.display;
  const multiRow = rowsOf(node, flow).length > 1;
  if (d.endsWith("flex")) {
    const horizontal = node.css.flexDirection.startsWith("row");
    const out = [{ horizontal, wrap: false }];
    if (horizontal && node.css.flexWrap !== "nowrap" && multiRow) out.unshift({ horizontal: true, wrap: true });
    out.push({ horizontal: !horizontal, wrap: false });
    return out;
  }
  if (d.endsWith("grid")) {
    if (node.css.gridColumns > 1 && multiRow) return [{ horizontal: true, wrap: true }, { horizontal: false, wrap: false }];
    return node.css.gridColumns > 1
      ? [{ horizontal: true, wrap: false }, { horizontal: false, wrap: false }]
      : [{ horizontal: false, wrap: false }, { horizontal: true, wrap: false }];
  }
  // Block flow stacks vertically; a single box or a line of inline-blocks may be a row.
  const inlineish = d.startsWith("inline") || d === "table-cell";
  const out = inlineish && flow.length === 1 ? [{ horizontal: true, wrap: false }, { horizontal: false, wrap: false }] : [{ horizontal: false, wrap: false }, { horizontal: true, wrap: false }];
  if (multiRow) out.push({ horizontal: true, wrap: true });
  return out;
}

/** A single row or column. */
function tryStack(node: BoxNode, flowDom: BoxNode[], horizontal: boolean): Plan | null {
  const W = node.rect.w;
  const H = node.rect.h;
  const rel = (c: BoxNode) => relRect(c, node);
  const mainOf = (r: Rect) => (horizontal ? [r.x, r.w] : [r.y, r.h]);
  const crossOf = (r: Rect) => (horizontal ? [r.y, r.h] : [r.x, r.w]);
  const flow = [...flowDom].sort((a, b) => mainOf(rel(a))[0] - mainOf(rel(b))[0]);
  const rects = flow.map(rel);
  for (let i = 1; i < rects.length; i++) {
    const [s] = mainOf(rects[i]);
    const [ps, pl] = mainOf(rects[i - 1]);
    if (s < ps + pl - 0.5) return null;
  }
  const gaps = rects.slice(1).map((r, i) => mainOf(r)[0] - mainOf(rects[i]).reduce((a, b) => a + b));
  const cssGap = horizontal ? node.css.columnGap : node.css.rowGap;
  const gap = pickGap(gaps, cssGap);
  if (gap === null) return null;

  const [it, ir, ib, il] = node.css.inset;
  const [cssS, cssE, cssCS, cssCE] = horizontal ? [il, ir, it, ib] : [it, ib, il, ir];
  const mainSize = horizontal ? W : H;
  const crossSize = horizontal ? H : W;
  const first = mainOf(rects[0])[0];
  const lastEnd = mainOf(rects[rects.length - 1]).reduce((a, b) => a + b);
  const last = mainSize - lastEnd;
  if (first < -0.5 || last < -0.5) return null;

  const isFlex = node.css.display.endsWith("flex");
  const reverse = isFlex && node.css.flexDirection.endsWith("reverse");
  const aligns = mainAligns(node, horizontal, reverse, flow.length);
  const crossAligns = crossAlignsFor(node, horizontal);
  const growers = isFlex && node.css.flexDirection.startsWith("row") === horizontal ? flow.filter((c) => c.css.flexGrow > 0) : [];

  for (const align of aligns) {
    const mainPad = mainPadding(align, first, last, cssS, cssE);
    if (!mainPad) continue;
    for (const crossAlign of crossAligns) {
      for (const useGrow of growers.length ? [true, false] : [false]) {
        const fillCross = flow.map((c, i) => stretches(c, node, horizontal) && crossFits(crossOf(rects[i]), crossSize, cssCS, cssCE));
        const crossPad = crossPadding(crossAlign, flow.map((_, i) => crossOf(rects[i])), fillCross, crossSize, cssCS, cssCE);
        if (!crossPad) continue;
        const [ps, pe] = mainPad;
        const [pcs, pce] = crossPad;
        const layout: Layout = {
          direction: horizontal ? "horizontal" : "vertical",
          gap: align === "space-between" ? 0 : gap,
          counterGap: 0,
          padding: horizontal ? [pcs, pe, pce, ps] : [ps, pce, pe, pcs],
          align,
          crossAlign,
          wrap: false,
        };
        const sizing = new Map<BoxNode, { w: Size; h: Size }>();
        flow.forEach((c, i) => {
          const fm = useGrow && growers.includes(c);
          const main: Size = fm ? "fill" : hugs(c, horizontal, node, true) ? "hug" : "fixed";
          const cross: Size = fillCross[i] ? "fill" : hugs(c, !horizontal, node, false) ? "hug" : "fixed";
          sizing.set(c, horizontal ? { w: main, h: cross } : { w: cross, h: main });
        });
        const plan = validate(node, flow, layout, sizing);
        if (plan) return plan;
      }
    }
  }
  return null;
}

/** Rows of a wrapping layout (horizontal only, fixed child sizes). */
function tryWrap(node: BoxNode, flowDom: BoxNode[]): Plan | null {
  const rows = rowsOf(node, flowDom);
  if (rows.length < 2 || rows.every((r) => r.length < 2)) return null;
  const W = node.rect.w;
  const H = node.rect.h;
  const gaps: number[] = [];
  for (const row of rows) {
    for (let i = 1; i < row.length; i++) {
      const a = relRect(row[i - 1], node);
      const b = relRect(row[i], node);
      if (b.x < a.x + a.w - 0.5) return null;
      gaps.push(b.x - a.x - a.w);
    }
  }
  const bounds = rows.map((row) => {
    const rs = row.map((c) => relRect(c, node));
    return { top: Math.min(...rs.map((r) => r.y)), bottom: Math.max(...rs.map((r) => r.y + r.h)), left: rs[0].x, right: rs[rs.length - 1].x + rs[rs.length - 1].w };
  });
  const rowGaps = bounds.slice(1).map((b, i) => b.top - bounds[i].bottom);
  const gap = gaps.length ? pickGap(gaps, node.css.columnGap) : node.css.columnGap;
  const counterGap = pickGap(rowGaps, node.css.rowGap);
  if (gap === null || counterGap === null || counterGap < 0) return null;
  const [, ir, ib, il] = node.css.inset;
  const top = bounds[0].top;
  const bottom = H - bounds[bounds.length - 1].bottom;
  const minLeft = Math.min(...bounds.map((b) => b.left));
  const maxRight = W - Math.max(...bounds.map((b) => b.right));
  if (top < -0.5 || bottom < -0.5 || minLeft < -0.5 || maxRight < -0.5) return null;
  const flow = rows.flat();
  const candidates: { align: Layout["align"]; pl: number; pr: number }[] = [];
  for (const align of ["start", "center", "end"] as const) {
    const pads = align === "start" ? [minLeft, ir] : align === "end" ? [il, maxRight] : [il, ir];
    candidates.push({ align, pl: pads[0], pr: pads[1] });
    // The tightest padding reproduces the browser's line breaks (each row was as full as it could get).
    candidates.push({ align, pl: align === "end" ? pads[0] : minLeft, pr: align === "start" ? maxRight : pads[1] });
  }
  for (const c of candidates) {
    for (const crossAlign of ["start", "center", "end"] as const) {
      const layout: Layout = {
        direction: "horizontal",
        gap,
        counterGap,
        padding: [top, c.pr, bottom >= ib - 0.5 && bottom - ib <= SLACK ? bottom : ib, c.pl],
        align: c.align,
        crossAlign,
        wrap: true,
      };
      const sizing = new Map<BoxNode, { w: Size; h: Size }>();
      for (const ch of flow) sizing.set(ch, { w: hugs(ch, true, node, true) ? "hug" : "fixed", h: hugs(ch, false, node, false) ? "hug" : "fixed" });
      const plan = validate(node, flow, layout, sizing);
      // The engine only wraps frames with a fixed (or fill) width.
      if (plan) return { ...plan, canHug: { w: false, h: plan.canHug.h } };
    }
  }
  return null;
}

/** Runs the engine simulation and accepts the layout when every child lands within TOL. */
function validate(node: BoxNode, flow: BoxNode[], layout: Layout, sizing: Map<BoxNode, { w: Size; h: Size }>): Plan | null {
  const horizontal = layout.direction === "horizontal";
  const items: SimItem[] = flow.map((c) => {
    const s = sizing.get(c)!;
    const [w, h] = predictedSize(c);
    return horizontal
      ? { main: w, cross: h, fillMain: s.w === "fill", fillCross: s.h === "fill" }
      : { main: h, cross: w, fillMain: s.h === "fill", fillCross: s.w === "fill" };
  });
  const W = node.rect.w;
  const H = node.rect.h;
  const sim = simulate(layout, items, W, H, false, false);
  for (let i = 0; i < flow.length; i++) {
    const want = relRect(flow[i], node);
    const got = sim.rects[i];
    const s = sizing.get(flow[i])!;
    if (Math.abs(got.x - want.x) > TOL || Math.abs(got.y - want.y) > TOL) return null;
    // Fill sizes come from the engine, so they must match too; other sizes are the child's own.
    if (s.w === "fill" && Math.abs(got.w - want.w) > TOL) return null;
    if (s.h === "fill" && Math.abs(got.h - want.h) > TOL) return null;
  }
  // Hugging: the engine's content size must match the browser's (and not undo fill children).
  const hugMain = simulate(layout, items, W, H, true, false);
  const hugCross = simulate(layout, items, W, H, false, true);
  const mainOk = !items.some((i) => i.fillMain) && Math.abs((horizontal ? hugMain.w : hugMain.h) - (horizontal ? W : H)) <= TOL;
  // When every child fills the cross axis the engine hugs their own content, which we can't predict.
  const crossOk = !items.every((i) => i.fillCross) && Math.abs((horizontal ? hugCross.h : hugCross.w) - (horizontal ? H : W)) <= TOL && rectsMatch(hugCross.rects, flow.map((c) => relRect(c, node)));
  return { layout, flow, sizing, canHug: horizontal ? { w: mainOk, h: crossOk } : { w: crossOk, h: mainOk } };
}

function rectsMatch(a: Rect[], b: Rect[]) {
  return a.every((r, i) => Math.abs(r.x - b[i].x) <= TOL && Math.abs(r.y - b[i].y) <= TOL);
}

/** The size the engine will give a child: auto-width text rounds up; hugging frames match. */
function predictedSize(c: BoxNode): [number, number] {
  if (c.kind === "text") return [c.hugText ? Math.ceil(c.rect.w) : c.rect.w, Math.ceil(c.rect.h - 0.01)];
  return [c.rect.w, c.rect.h];
}

/** Main-axis alignment candidates from CSS, then the purely geometric fallback (start). */
function mainAligns(node: BoxNode, horizontal: boolean, reverse: boolean, n: number): Layout["align"][] {
  const css = node.css;
  let mapped: Layout["align"] = "start";
  if (css.display.endsWith("flex")) {
    const j = css.justifyContent;
    if (j === "center") mapped = "center";
    else if (j === "space-between" && n > 1) mapped = "space-between";
    else if (/(^|-)end$|right/.test(j)) mapped = reverse ? "start" : "end";
    else if (/start|normal|left|stretch/.test(j)) mapped = reverse ? "end" : "start";
  } else if (horizontal) {
    if (css.textAlign === "center") mapped = "center";
    else if (css.textAlign === "right" || css.textAlign === "end") mapped = "end";
  }
  return [...new Set<Layout["align"]>([mapped, "start", "center", "end"])];
}

function crossAlignsFor(node: BoxNode, horizontal: boolean): Layout["crossAlign"][] {
  const css = node.css;
  let mapped: Layout["crossAlign"] = "start";
  if (css.display.endsWith("flex")) {
    const a = css.alignItems;
    if (a === "center") mapped = "center";
    else if (/(^|-)end$/.test(a)) mapped = "end";
  } else if (!horizontal) {
    if (css.textAlign === "center") mapped = "center";
    else if (css.textAlign === "right" || css.textAlign === "end") mapped = "end";
  }
  return [...new Set<Layout["crossAlign"]>([mapped, "start", "center", "end"])];
}

/** Main-axis padding for an alignment: CSS padding where it explains the free space, else geometry. */
function mainPadding(align: Layout["align"], first: number, last: number, cssS: number, cssE: number): [number, number] | null {
  const trail = (geo: number, css: number) => (geo >= css - 0.5 && geo - css <= SLACK ? geo : css);
  switch (align) {
    case "start":
      return [first, trail(last, cssE)];
    case "end":
      return [trail(first, cssS), last];
    case "space-between":
      return [first, last];
    case "center":
      return Math.abs(first - cssS - (last - cssE)) <= TOL ? [cssS, cssE] : [first, last];
  }
}

/** Cross-axis padding for an alignment, or null when the children don't share it. */
function crossPadding(
  align: Layout["crossAlign"],
  spans: number[][],
  fill: boolean[],
  size: number,
  cssS: number,
  cssE: number,
): [number, number] | null {
  const fixed = spans.filter((_, i) => !fill[i]);
  const filled = spans.filter((_, i) => fill[i]);
  const starts = spans.map((s) => s[0]);
  const ends = spans.map((s) => size - s[0] - s[1]);
  const minStart = Math.min(...starts);
  const minEnd = Math.min(...ends);
  if (minStart < -0.5 || minEnd < -0.5) return null;
  // Fill children pin both paddings.
  if (filled.length) {
    const s = filled[0][0];
    const e = size - filled[0][0] - filled[0][1];
    if (filled.some((f) => Math.abs(f[0] - s) > TOL || Math.abs(size - f[0] - f[1] - e) > TOL)) return null;
    return [s, e];
  }
  if (!fixed.length) return [cssS, cssE];
  const trail = (geo: number, css: number) => (geo >= css - 0.5 && geo - css <= SLACK ? geo : css);
  switch (align) {
    case "start":
      return [minStart, trail(minEnd, cssE)];
    case "end":
      return [trail(minStart, cssS), minEnd];
    case "center": {
      const mid = (cssS + size - cssE) / 2;
      const centred = fixed.every((s) => Math.abs(s[0] + s[1] / 2 - mid) <= TOL);
      return centred ? [cssS, cssE] : [minStart, minEnd];
    }
  }
}

/** Picks the gap between consecutive children: CSS gap if it fits, else their (rounded) common gap. */
function pickGap(gaps: number[], cssGap: number): number | null {
  if (!gaps.length) return cssGap;
  if (gaps.every((g) => Math.abs(g - cssGap) <= TOL / 2)) return cssGap;
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  if (gaps.some((g) => Math.abs(g - mean) > TOL / 2)) return null;
  return Math.abs(mean - Math.round(mean)) < 0.3 ? Math.round(mean) : mean;
}

/** Whether a child stretches across its parent's cross axis in CSS. */
function stretches(c: BoxNode, parent: BoxNode, horizontal: boolean): boolean {
  const d = parent.css.display;
  if (c.kind === "text" && c.hugText) return false;
  if (d.endsWith("flex")) {
    const a = c.css.alignSelf === "auto" ? parent.css.alignItems : c.css.alignSelf;
    if (a === "stretch" || a === "normal") return true;
    // `width: 100%` in a column also spans the parent.
    return !horizontal && c.kind !== "text";
  }
  if (d.endsWith("grid")) return true;
  if (horizontal) return false;
  return isBlockLevel(c);
}

function crossFits(span: number[], size: number, cssS: number, cssE: number): boolean {
  // Spans the content box, or the whole box minus symmetric margins.
  return Math.abs(span[1] - (size - cssS - cssE)) <= 0.5 || (span[1] > size * 0.5 && Math.abs(span[0] - (size - span[0] - span[1])) <= 0.5);
}

/** Whether a child should hug its content on an axis (only when the engine reproduces its size). */
function hugs(c: BoxNode, horizontal: boolean, parent: BoxNode, main: boolean): boolean {
  if (c.kind === "text") return horizontal ? !!c.hugText : true;
  if (c.kind !== "frame" || !c.plan) return false;
  if (!horizontal) return c.plan.canHug.h;
  if (!c.plan.canHug.w) return false;
  // Width hugs for boxes that CSS sizes to their content: flex items along a row, inline-level boxes.
  return contentSized(c.css) || (parent.css.display.endsWith("flex") && main) || !isBlockLevel(c);
}

function contentSized(css: Css): boolean {
  return css.display.startsWith("inline") || css.float !== "none" || css.position === "absolute" || css.position === "fixed";
}

function isBlockLevel(c: BoxNode): boolean {
  if (c.css.float !== "none") return false;
  return ["block", "flex", "grid", "list-item", "table", "flow-root"].includes(c.css.display);
}

/** Groups children into visual rows (top to bottom, each sorted left to right). */
function rowsOf(node: BoxNode, flow: BoxNode[]): BoxNode[][] {
  const sorted = [...flow].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  const rows: BoxNode[][] = [];
  let bottom = -Infinity;
  for (const c of sorted) {
    if (!rows.length || c.rect.y >= bottom - 0.5) {
      rows.push([c]);
      bottom = c.rect.y + c.rect.h;
    } else {
      rows[rows.length - 1].push(c);
      bottom = Math.max(bottom, c.rect.y + c.rect.h);
    }
  }
  void node;
  return rows.map((r) => r.sort((a, b) => a.rect.x - b.rect.x));
}

function relRect(c: BoxNode, parent: BoxNode): Rect {
  return { x: c.rect.x - parent.rect.x, y: c.rect.y - parent.rect.y, w: c.rect.w, h: c.rect.h };
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}
