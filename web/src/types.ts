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

export type Paint =
  | { type: "solid"; color: string; opacity: number; visible: boolean }
  | { type: "linearGradient"; stops: GradientStop[]; angle: number; opacity: number; visible: boolean }
  | { type: "radialGradient"; stops: GradientStop[]; opacity: number; visible: boolean }
  | { type: "image"; src: string; scaleMode: "fill" | "fit" | "stretch" | "tile"; opacity: number; visible: boolean };

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
export type Align = "start" | "center" | "end" | "spaceBetween";

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
  trigger: "onClick" | "onHover" | "onPress" | "afterDelay";
  delayMs: number;
  action: "navigate" | "back" | "openUrl" | "scrollTo" | "openOverlay" | "closeOverlay" | "swapOverlay";
  destination: string | null;
  url: string | null;
  transition: "instant" | "dissolve" | "smartAnimate" | "slideLeft" | "slideRight" | "slideUp" | "slideDown";
  durationMs: number;
  /** Placement and behaviour for openOverlay / swapOverlay. */
  overlay: OverlaySettings;
}

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
  cornerRadius: number;
  cornerRadii: [number, number, number, number] | null;
  effects: Effect[];
  clipContent: boolean;
  layout: AutoLayout | null;
  sizingH: Sizing;
  sizingV: Sizing;
  absolutePosition: boolean;
  constraints: { horizontal: string; vertical: string };
  text: TextProps | null;
  vector: { subpaths: { points: VectorPoint[]; closed: boolean }[]; raw: { d: string; viewBox: number[] } | null } | null;
  shape: { pointCount: number; innerRadius: number; startCap: string; endCap: string } | null;
  component: { description: string; variantProps: Record<string, string> } | null;
  instance: { componentId: string; overrides: Record<string, unknown> } | null;
  masterId: string | null;
  fillStyle: string | null;
  textStyle: string | null;
  interactions: Interaction[];
  exportSettings: { format: "png" | "jpg" | "svg"; scale: number; suffix: string }[];
  notes: string;
  layoutGrids: LayoutGrid[];
  isMask: boolean;
  /** Property → variable id. */
  bindings: Record<string, string>;
  /** Collection id → mode id. */
  variableModes: Record<string, string>;
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
}

export interface VariableCollection {
  id: string;
  name: string;
  modes: { id: string; name: string }[];
  variables: Variable[];
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
  | "comment";
