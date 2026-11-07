// TypeScript mirror of the Rust document model (crates/engine/src/model.rs).

export type NodeType =
  | "frame"
  | "group"
  | "rectangle"
  | "ellipse"
  | "line"
  | "polygon"
  | "star"
  | "vector"
  | "text"
  | "component"
  | "componentSet"
  | "instance";

export interface GradientStop {
  color: string;
  position: number;
}

/** W3-D paint: control points of a gradient in the layer's unit box (0..1, may lie outside it).
 *  Linear: start to end. Radial and diamond: centre `start`, axis ends `end` and `width`.
 *  Angular: centre `start`, the sweep begins towards `end`. */
export interface GradientHandles {
  start: [number, number];
  end: [number, number];
  width: [number, number];
}

/** Where the whole image sits relative to the layer box (the box is 0..1). */
export interface ImageCrop {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The seven image adjustments of an image fill, each -1..1 (mirrors `ImageFilters` in model.rs). */
export interface ImageFilters {
  exposure?: number;
  contrast?: number;
  saturation?: number;
  temperature?: number;
  tint?: number;
  highlights?: number;
  shadows?: number;
}

/** Where a stock photo came from and under which licence (mirrors `ImageCredit` in model.rs). */
export interface ImageCredit {
  provider: "openverse" | "unsplash" | "pexels" | string;
  photoId: string;
  title: string;
  alt: string;
  author: string;
  authorUrl: string;
  source: string;
  sourceUrl: string;
  license: string;
  licenseUrl: string;
  attributionRequired: boolean;
  nonCommercial: boolean;
}

export type GradientPaintType = "linearGradient" | "radialGradient" | "angularGradient" | "diamondGradient";

export type Paint =
  | { type: "solid"; color: string; opacity: number; visible: boolean }
  | { type: "linearGradient"; stops: GradientStop[]; angle: number; opacity: number; visible: boolean; handles?: GradientHandles }
  | { type: "radialGradient"; stops: GradientStop[]; opacity: number; visible: boolean; handles?: GradientHandles }
  | { type: "angularGradient"; stops: GradientStop[]; opacity: number; visible: boolean; handles?: GradientHandles }
  | { type: "diamondGradient"; stops: GradientStop[]; opacity: number; visible: boolean; handles?: GradientHandles }
  | { type: "image"; src: string; scaleMode: "fill" | "fit" | "stretch" | "tile" | "crop"; opacity: number; visible: boolean; crop?: ImageCrop; credit?: ImageCredit; scalingFactor?: number; rotation?: number; filters?: ImageFilters };

export type EffectType = "dropShadow" | "innerShadow" | "layerBlur" | "backgroundBlur";

export interface Effect {
  type: EffectType;
  color: string;
  x: number;
  y: number;
  blur: number;
  spread: number;
  visible: boolean;
}

export type Sizing = "fixed" | "hug" | "fill";
export type Align = "start" | "center" | "end" | "spaceBetween" | "baseline";

export interface AutoLayout {
  direction: "horizontal" | "vertical";
  gap: number;
  paddingTop: number;
  paddingRight: number;
  paddingBottom: number;
  paddingLeft: number;
  primaryAlign: Align;
  counterAlign: Align;
  wrap: boolean;
  counterGap: number;
}

export interface TextProps {
  characters: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  italic: boolean;
  lineHeight: number | null;
  letterSpacing: number;
  paragraphSpacing: number;
  alignH: "left" | "center" | "right" | "justify";
  alignV: "top" | "middle" | "bottom";
  autoResize: "none" | "width" | "height";
  decoration: "none" | "underline" | "strikethrough";
  case: "original" | "upper" | "lower" | "title";
  runs: TextRun[];
  /** Show at most this many lines; the last ends in "…" when text is cut. */
  maxLines?: number | null;
  /** Cut text that doesn't fit with "…" (fixed-size boxes show the lines that fit). */
  truncate?: boolean;
}

export interface TextRun {
  start: number;
  end: number;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number;
  italic?: boolean;
  color?: string;
  decoration?: "none" | "underline" | "strikethrough";
  letterSpacing?: number;
  link?: string;
}

export interface VectorPoint {
  x: number;
  y: number;
  inX: number;
  inY: number;
  outX: number;
  outY: number;
}

export interface Interaction {
  trigger: "onClick" | "onHover" | "onPress" | "afterDelay" | "mouseEnter" | "mouseLeave" | "mouseDown" | "mouseUp" | "key";
  delayMs: number;
  action: "navigate" | "back" | "openUrl" | "scrollTo" | "openOverlay" | "closeOverlay" | "swapOverlay" | "changeTo";
  destination: string | null;
  url: string | null;
  transition: "instant" | "dissolve" | "smartAnimate" | "slideLeft" | "slideRight" | "slideUp" | "slideDown" | "moveIn" | "moveOut" | "push";
  /** 0 in files from before durations were honoured: the player uses 300. */
  durationMs: number;
  /** Key trigger: a key or combination such as "Shift+K" (see `keyName` in player.ts). */
  key?: string;
  /** Move in, Move out and Push; the engine leaves the key out for "left". */
  direction?: Direction;
  /** The engine leaves the key out for "easeOut". */
  easing?: Easing;
  /** Placement and behaviour for openOverlay / swapOverlay. */
  overlay: OverlaySettings;
  /** Navigate to, Swap overlay and Change to: the screen that opens keeps the scroll position of the one it replaces. The engine leaves the key out when off. */
  preserveScroll?: boolean;
}

export type Direction = "left" | "right" | "up" | "down";
export type Easing = "linear" | "easeIn" | "easeOut" | "easeInOut" | "easeInBack" | "easeOutBack" | "easeInOutBack";
export type Overflow = "none" | "horizontal" | "vertical" | "both";

export type OverlayPosition = "center" | "topLeft" | "topCenter" | "topRight" | "bottomLeft" | "bottomCenter" | "bottomRight" | "manual";

export interface OverlaySettings {
  position: OverlayPosition;
  /** Manual position: offset from the top-left of the layer that opened the overlay. */
  offsetX: number;
  offsetY: number;
  closeOnClickOutside: boolean;
  /** Dims the frame underneath; null leaves it undimmed. */
  background: { color: string; opacity: number } | null;
}

export type PropKind = "boolean" | "text" | "instanceSwap";

/** A component property (on a main component, or on its set for variants). */
export interface PropDef {
  id: string;
  name: string;
  kind: PropKind;
  /** true/false, the text, or the id of the default component (instance swap). */
  default: boolean | string;
  /** Instance swap: the components it offers (empty: every component). */
  options?: string[];
}

export interface PropRefs {
  visible?: string;
  characters?: string;
  swap?: string;
}

/** A screen frame's device (mirrors `DeviceFrame` in model.rs). */
export interface DeviceFrame {
  preset: string;
  theme: "light" | "dark";
  statusBar: boolean;
  homeIndicator: boolean;
  chrome: boolean;
  nav: "gesture" | "buttons";
  url: string;
  pad: boolean;
  /** Insets currently added to the padding: top, right, bottom, left. */
  applied: [number, number, number, number];
}

export interface Node {
  id: string;
  type: NodeType;
  name: string;
  page: string;
  parent: string | null;
  children: string[];
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  flipX: boolean;
  flipY: boolean;
  visible: boolean;
  locked: boolean;
  opacity: number;
  blendMode: string;
  fills: Paint[];
  strokes: Paint[];
  strokeWeight: number;
  strokeAlign: "inside" | "center" | "outside";
  strokeDash: number[];
  // Strokes (W3-D)
  /** One weight per side (top, right, bottom, left); boxes only. Absent: `strokeWeight` on every side. */
  strokeWeights?: [number, number, number, number];
  /** Absent keeps the historical round joins. */
  strokeJoin?: "miter" | "bevel" | "round";
  cornerRadius: number;
  cornerRadii: [number, number, number, number] | null;
  effects: Effect[];
  clipContent: boolean;
  layout: AutoLayout | null;
  sizingH: Sizing;
  sizingV: Sizing;
  absolutePosition: boolean;
  /** Size limits for auto layout and text (absent when unset). */
  minWidth?: number | null;
  maxWidth?: number | null;
  minHeight?: number | null;
  maxHeight?: number | null;
  constraints: { horizontal: string; vertical: string };
  text: TextProps | null;
  vector: { subpaths: { points: VectorPoint[]; closed: boolean }[]; raw: { d: string; viewBox: number[] } | null } | null;
  shape: { pointCount: number; innerRadius: number; startCap: string; endCap: string } | null;
  component: { description: string; variantProps: Record<string, string>; props?: PropDef[] } | null;
  instance: {
    componentId: string;
    overrides: Record<string, unknown>;
    /** Values set on the component's boolean and text properties (property id → value). */
    propValues?: Record<string, boolean | string>;
    /** Nested in a main component: show its properties on instances of the outer component. */
    exposeProps?: boolean;
  } | null;
  /** Component properties this layer of a main component is bound to (property ids). */
  propRefs?: PropRefs | null;
  /** Screen frames: the device preset and its system UI (the engine leaves the key out when there is none). */
  device?: DeviceFrame;
  /** The root of a system UI part (statusBar, homeIndicator, navBar, titleBar, browserBar). */
  devicePart?: string;
  masterId: string | null;
  fillStyle: string | null;
  textStyle: string | null;
  // Styles (W3-C): the engine leaves these keys out while unset.
  effectStyle?: string | null;
  gridStyle?: string | null;
  strokeStyle?: string | null;
  interactions: Interaction[];
  // Prototype (W3-A)
  /** Frames: scrolling directions in the prototype player; the engine leaves the key out for "none". */
  overflow?: Overflow;
  /** Children of a scrolling frame; the engine leaves the key out for "scroll". */
  scrollBehavior?: "scroll" | "fixed";
  /** Export rows; the engine leaves the key out when there are none. */
  exportSettings?: ExportSetting[];
  notes: string;
  layoutGrids: LayoutGrid[];
  isMask: boolean;
  /** Property → variable id. */
  bindings: Record<string, string>;
  /** Collection id → mode id. */
  variableModes: Record<string, string>;
}

/** One row of the Export section; at most one of `width` / `height` is set (else `scale` applies). */
export interface ExportSetting {
  format: "png" | "jpg" | "svg";
  scale: number;
  suffix: string;
  width?: number;
  height?: number;
}

export interface CommentMessage {
  author: string;
  text: string;
  time: number;
}

export interface CommentThread {
  id: string;
  page: string;
  x: number;
  y: number;
  node: string | null;
  resolved: boolean;
  messages: CommentMessage[];
}

/** A thread as listed by the `comments` query (position resolved to page coordinates). */
export interface CommentPin {
  id: string;
  page: string;
  x: number;
  y: number;
  nodeId: string | null;
  nodeName: string | null;
  resolved: boolean;
  messages: CommentMessage[];
}

export type VarKind = "color" | "number" | "string" | "boolean";

export interface Variable {
  id: string;
  name: string;
  type: VarKind;
  /** Mode id → value (or {alias: variableId}). */
  values: Record<string, unknown>;
  description: string;
  /** Properties the variable is offered for (see variableScopes.ts); empty or missing = all. */
  scopes?: string[];
}

export interface VariableCollection {
  id: string;
  name: string;
  modes: { id: string; name: string }[];
  variables: Variable[];
}

export interface EffectStyle {
  id: string;
  name: string;
  effects: Effect[];
  description?: string;
}

export interface GridStyle {
  id: string;
  name: string;
  grids: LayoutGrid[];
  description?: string;
}

export interface LayoutGrid {
  pattern: "columns" | "rows" | "grid";
  count: number;
  gutter: number;
  margin: number;
  size: number;
  alignment: "stretch" | "start" | "center" | "end";
  color: string;
  visible: boolean;
}

export interface RulerGuide {
  axis: "x" | "y";
  position: number;
}

export interface Page {
  id: string;
  name: string;
  children: string[];
  background: string;
  flowStart: string | null;
  guides: RulerGuide[];
}

export interface Doc {
  id: string;
  name: string;
  schema: number;
  pages: Page[];
  nodes: Record<string, Node>;
  styles: {
    colors: { id: string; name: string; color: string }[];
    texts: { id: string; name: string; fontFamily: string; fontSize: number; fontWeight: number; lineHeight: number | null; letterSpacing: number }[];
    /** Left out of files that have none. */
    effects?: EffectStyle[];
    grids?: GridStyle[];
  };
  variables: VariableCollection[];
  comments: Record<string, CommentThread>;
}

export interface EngineState {
  rev: number;
  /** Counts changes to the document itself (not selection or page switches). */
  docRev: number;
  page: string;
  selection: string[];
  canUndo: boolean;
  canRedo: boolean;
  inGesture: boolean;
  /** View-only (a view link): the engine refuses edits. */
  readOnly?: boolean;
}

export interface Mat {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Guide {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** An equal-spacing hint or measured distance: a segment along one axis and its length. */
export interface Gap {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  value: number;
}

/** Alt-hover distances from the selection to the layer under the pointer (`measure` query). */
export interface Measurement {
  target: string;
  lines: Gap[];
  /** Dashed projections joining a distance line to the layer it ends at. */
  extends: Guide[];
}

export type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export type Tool =
  | "move"
  | "hand"
  | "frame"
  | "rectangle"
  | "ellipse"
  | "line"
  | "arrow"
  | "polygon"
  | "star"
  | "pen"
  | "pencil"
  | "text"
  | "comment"
  | "scale"
  | "eyedropper";
