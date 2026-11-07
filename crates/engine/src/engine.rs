//! The engine facade: owns the document, selection and undo history and
//! exposes every mutation as a serialisable [`Command`] and every read as a
//! [`Query`]. The WASM wrapper and the bridge both drive this type.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::components;
use crate::devices;
use crate::doc::{new_document, IdGen};
use crate::geom::{Mat, Point, Rect};
use crate::interact::{self, Handle};
use crate::layout;
use crate::model::{
  AutoLayout, Axis, ColorStyle, DeviceFrame, Document, Effect, EffectStyle, GridStyle, Interaction, LayoutDirection, LayoutGrid, Node,
  NodeId, NodeType, Page, Paint, RulerGuide, Sizing, SubPath, TextStyle, VectorData, VectorPoint,
};
use crate::ops::{self, AlignHow, ReorderTo};
use crate::render::{self, Mode, RenderOptions};
use crate::text::TextMeasurer;
use crate::{ai, arrange, codegen, patch, svg_import, vector_edit};

const MAX_HISTORY: usize = 300;
pub const CLIPBOARD_TAG: &str = "designotron/nodes";
/// Screen pixels from a path within which vector edit mode offers to add a point.
const VECTOR_SEGMENT_TOLERANCE: f64 = 6.0;
/// A hit this close (screen px) to a segment's end anchor is the anchor's, not the segment's
/// (never more than a quarter of the segment's length, so short segments still take points).
const VECTOR_ANCHOR_MARGIN: f64 = 5.0;

/// One undo step: the state before it and the document right after it. Undo applies the
/// reverse of before→after to the *current* document, so collaborators' later edits stay.
/// The page and selection right after the step let redo return to them (adding a page
/// leaves the new one current).
struct Step {
  before: Snapshot,
  after: Document,
  after_page: String,
  after_selection: Vec<NodeId>,
  /// Steps of one AI chat turn share a group (see `Command::SetHistoryGroup`); undo and redo
  /// move through the whole group at once.
  group: Option<String>,
}

#[derive(Clone)]
struct Snapshot {
  doc: Document,
  selection: Vec<NodeId>,
  page: String,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum SelectMode {
  #[default]
  Replace,
  Add,
  Toggle,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Command {
  /// Re-measures text and re-runs layout without an undo step (e.g. after web fonts load).
  Relayout,
  /// Turns the read-only mode on or off: while on, every command that would change the file is
  /// refused (selecting, switching page, comments and receiving collaborators' changes still
  /// work). Used for view-only links. Not an edit: no revision bump.
  SetReadOnly {
    on: bool,
  },
  Undo,
  Redo,
  /// Tags the steps that `Command::Ai` pushes from now on with `group` (`None` stops), so a
  /// whole chat turn undoes and redoes as one step. Not an edit: no revision bump and the redo
  /// stack stays. Other commands, and AI commands inside a gesture, are never grouped.
  SetHistoryGroup {
    group: Option<String>,
  },
  BeginGesture,
  /// Within a gesture: makes the current document the base that gesture-relative commands
  /// (translate, resize, rotate) work from, while undo still returns to where the gesture
  /// began. Used by Alt-drag: paste the copies, rebase, then move them; one undo step.
  RebaseGesture,
  EndGesture,
  CancelGesture,
  Select {
    ids: Vec<NodeId>,
    #[serde(default)]
    mode: SelectMode,
  },
  SelectAll,
  SetPage {
    id: String,
  },
  AddPage {
    name: Option<String>,
  },
  RenamePage {
    id: String,
    name: String,
  },
  DeletePage {
    id: String,
  },
  /// Moves a page to `index` in the pages list.
  MovePage {
    id: String,
    index: usize,
  },
  /// Copies a page with all its layers ("<name> copy", right after it) and makes it current.
  DuplicatePage {
    id: String,
  },
  /// Moves layers to the top level of another page (keeping x/y); the page becomes current.
  MoveToPage {
    ids: Vec<NodeId>,
    page: String,
  },
  /// Arranges top-level layers into a grid with equal spacing (median gap unless given).
  TidyUp {
    ids: Vec<NodeId>,
    #[serde(default)]
    spacing: Option<f64>,
  },
  /// Scales layers and everything inside them by `factor` around `anchor` (default: the
  /// selection's top-left): the Scale tool with a number.
  ScaleNodes {
    ids: Vec<NodeId>,
    factor: f64,
    #[serde(default)]
    anchor: Option<Point>,
  },
  SetPageBackground {
    id: String,
    color: String,
  },
  /// Replaces the page's ruler guides (current page when `page` is None).
  SetGuides {
    #[serde(default)]
    page: Option<String>,
    guides: Vec<RulerGuide>,
  },
  /// Replaces all variable collections (the variables editor sends the whole set).
  SetVariables {
    collections: Vec<crate::variables::Collection>,
  },
  /// Binds a layer property to a variable (None unbinds).
  BindVariable {
    ids: Vec<NodeId>,
    property: String,
    #[serde(default)]
    variable: Option<String>,
  },
  /// Sets which mode of a collection a layer and its children use (None inherits).
  SetVariableMode {
    ids: Vec<NodeId>,
    collection: String,
    #[serde(default)]
    mode: Option<String>,
  },
  /// Starts a comment thread at a page position, attached to `node` when given.
  AddComment {
    #[serde(default)]
    page: Option<String>,
    x: f64,
    y: f64,
    #[serde(default)]
    node: Option<NodeId>,
    text: String,
    author: String,
    #[serde(default)]
    time: f64,
  },
  ReplyComment {
    id: String,
    text: String,
    author: String,
    #[serde(default)]
    time: f64,
  },
  ResolveComment {
    id: String,
    resolved: bool,
  },
  DeleteComment {
    id: String,
  },
  /// Imports a Figma REST API file (or /nodes response) as new pages.
  ImportFigma {
    file: Value,
    /// Figma imageRef → URL or `asset:` id.
    #[serde(default)]
    images: std::collections::BTreeMap<String, String>,
  },
  /// Merges a collaborator's delta (see `collab::delta`); not an undo step. With `local`,
  /// the change is this editor's own (made while offline): it goes into the document and is
  /// sent with the next `collab_delta`.
  ApplyRemote {
    delta: Value,
    #[serde(default)]
    local: bool,
  },
  /// The relay ordered this editor's oldest unacknowledged delta (or `rejected` it).
  CollabAck {
    #[serde(default)]
    rejected: bool,
  },
  /// Swaps in a whole document as one undoable step (restoring a version). With
  /// `keep_comments` the current comments stay, as in Figma: a restore reverts layers, not
  /// the conversation. A comment on a layer the new document lacks becomes a page comment
  /// where it was; one on a missing page moves to the first page.
  ReplaceDocument {
    doc: Value,
    #[serde(default)]
    keep_comments: bool,
  },
  SetDocName {
    name: String,
  },
  CreateShape {
    kind: NodeType,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    parent: Option<NodeId>,
  },
  CreateText {
    x: f64,
    y: f64,
    characters: String,
    parent: Option<NodeId>,
  },
  CreateVector {
    points: Vec<VectorPoint>,
    closed: bool,
    parent: Option<NodeId>,
  },
  /// Vector edit mode: inserts an anchor on segment `seg` of subpath `sub` at curve
  /// parameter `t` without changing the shape.
  InsertVectorPoint {
    id: NodeId,
    sub: usize,
    seg: usize,
    t: f64,
  },
  /// Deletes anchors (`[subpath, index]` pairs), joining their neighbours. Deleting all
  /// but one anchor deletes the layer.
  DeleteVectorPoints {
    id: NodeId,
    points: Vec<[usize; 2]>,
  },
  /// Makes anchors smooth (handles along their neighbours) or sharp (no handles).
  SetVectorPointsSmooth {
    id: NodeId,
    points: Vec<[usize; 2]>,
    smooth: bool,
  },
  /// Moves anchors with their handles by a page-space delta.
  MoveVectorPoints {
    id: NodeId,
    points: Vec<[usize; 2]>,
    dx: f64,
    dy: f64,
  },
  /// Continues an open subpath from its start (`prepend`) or end with page-space anchors,
  /// listed in drawing order outwards from that end; `close` joins it to its other end.
  ExtendVector {
    id: NodeId,
    sub: usize,
    #[serde(default)]
    prepend: bool,
    points: Vec<VectorPoint>,
    #[serde(default)]
    close: bool,
  },
  /// Refits a vector's box to its path without moving it on the page (after point drags).
  FitVectorBounds {
    id: NodeId,
  },
  CreateImage {
    src: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    name: Option<String>,
    parent: Option<NodeId>,
  },
  /// Reads SVG markup into editable layers (see `svg_import`): a frame centred on `x`, `y`
  /// (inside the frame under that point, or `parent`). Refused markup leaves the file untouched
  /// and the error says why, so the caller can place the SVG as an image instead.
  ImportSvg {
    svg: String,
    x: f64,
    y: f64,
    #[serde(default)]
    parent: Option<NodeId>,
    #[serde(default)]
    name: Option<String>,
  },
  InsertSpecs {
    specs: Vec<Value>,
    parent: Option<NodeId>,
  },
  Paste {
    data: String,
    parent: Option<NodeId>,
    x: Option<f64>,
    y: Option<f64>,
  },
  Update {
    ids: Vec<NodeId>,
    patch: Value,
  },
  SetText {
    id: NodeId,
    characters: String,
  },
  /// Applies style overrides to characters `start..end` of a text layer.
  /// `style` uses TextRun field names; `clear` lists overrides to remove.
  StyleText {
    id: NodeId,
    start: usize,
    end: usize,
    #[serde(default)]
    style: Value,
    #[serde(default)]
    clear: Vec<String>,
  },
  Delete {
    ids: Vec<NodeId>,
  },
  Duplicate {
    ids: Vec<NodeId>,
  },
  /// Gesture-relative translate (total delta since BeginGesture).
  Translate {
    ids: Vec<NodeId>,
    dx: f64,
    dy: f64,
    #[serde(default)]
    snap: bool,
    #[serde(default = "one")]
    zoom: f64,
    /// Shift held: the move stays on this axis, and snapping only runs along it.
    #[serde(default)]
    axis: Option<Axis>,
  },
  Nudge {
    ids: Vec<NodeId>,
    dx: f64,
    dy: f64,
  },
  DropInto {
    ids: Vec<NodeId>,
    x: f64,
    y: f64,
  },
  MoveToParent {
    ids: Vec<NodeId>,
    parent: Option<NodeId>,
    index: Option<usize>,
  },
  Resize {
    ids: Vec<NodeId>,
    handle: Handle,
    dx: f64,
    dy: f64,
    #[serde(default)]
    keep_aspect: bool,
    #[serde(default)]
    from_center: bool,
    #[serde(default)]
    snap: bool,
    #[serde(default = "one")]
    zoom: f64,
    /// The Scale tool: the handle drag scales the layers and everything inside them
    /// proportionally (the aspect is always locked).
    #[serde(default)]
    scale: bool,
  },
  /// Gesture-relative rotation in degrees around a page-space pivot.
  Rotate {
    ids: Vec<NodeId>,
    angle: f64,
    pivot_x: f64,
    pivot_y: f64,
  },
  Group {
    ids: Vec<NodeId>,
  },
  /// Union/subtract/intersect/exclude into one vector (bottom layer's style).
  BooleanOp {
    ids: Vec<NodeId>,
    operation: crate::paths::BoolOp,
  },
  /// Merges shapes into one editable vector, keeping curves.
  Flatten {
    ids: Vec<NodeId>,
  },
  /// Converts strokes into filled vector shapes.
  OutlineStroke {
    ids: Vec<NodeId>,
  },
  /// One layer: toggles it as a mask. Several: groups them, bottom layer masks the rest.
  UseAsMask {
    ids: Vec<NodeId>,
  },
  Ungroup {
    ids: Vec<NodeId>,
  },
  FrameSelection {
    ids: Vec<NodeId>,
  },
  /// Puts a device (preset, theme, system UI toggles) on a screen frame or takes it off with
  /// `None`; `resize` also gives the frame the preset's size. One undo step.
  SetDevice {
    id: NodeId,
    device: Option<DeviceFrame>,
    #[serde(default)]
    resize: bool,
  },
  AddAutoLayout {
    ids: Vec<NodeId>,
  },
  RemoveAutoLayout {
    ids: Vec<NodeId>,
  },
  CreateComponent {
    ids: Vec<NodeId>,
  },
  /// One main component per layer (Figma's "Create multiple components"), as one undo step.
  CreateComponents {
    ids: Vec<NodeId>,
  },
  CombineVariants {
    ids: Vec<NodeId>,
  },
  CreateInstance {
    component_id: NodeId,
    /// Top-left of the instance in page coordinates.
    x: f64,
    y: f64,
    parent: Option<NodeId>,
    /// Page point that picks the parent frame when `parent` is unset (the pointer for a
    /// drop, the viewport centre for a click). Defaults to the top-left.
    #[serde(default)]
    anchor: Option<Point>,
    /// Let the auto-chosen parent be a main component or set (drops, not clicks).
    #[serde(default)]
    into_components: bool,
  },
  DetachInstance {
    ids: Vec<NodeId>,
  },
  ResetInstance {
    ids: Vec<NodeId>,
  },
  /// Puts property groups (see `components::OVERRIDE_GROUPS`; all when empty) of layers inside
  /// instances back to what their main components say.
  ResetOverrideGroups {
    ids: Vec<NodeId>,
    #[serde(default)]
    groups: Vec<String>,
  },
  /// Rebuilds the deleted main component of an instance from the instances that remain.
  RestoreComponent {
    id: NodeId,
  },
  SwapComponent {
    id: NodeId,
    component_id: NodeId,
  },
  SetVariant {
    id: NodeId,
    prop: String,
    value: String,
  },
  /// Component properties: define them, bind layers, set instance values (see `props.rs`).
  ComponentProps {
    edit: crate::props::PropsOp,
  },
  Align {
    ids: Vec<NodeId>,
    how: AlignHow,
  },
  Distribute {
    ids: Vec<NodeId>,
    horizontal: bool,
  },
  Reorder {
    ids: Vec<NodeId>,
    to: ReorderTo,
  },
  Flip {
    ids: Vec<NodeId>,
    horizontal: bool,
  },
  AddInteraction {
    id: NodeId,
    interaction: Interaction,
  },
  SetInteractions {
    id: NodeId,
    interactions: Vec<Interaction>,
  },
  SetFlowStart {
    page: String,
    id: Option<NodeId>,
  },
  AddColorStyle {
    name: String,
    color: String,
  },
  AddTextStyle {
    name: String,
    from: NodeId,
  },
  UpdateColorStyle {
    id: String,
    name: Option<String>,
    color: Option<String>,
  },
  /// Edits a text style in place (keeping its id) and updates every layer that uses it.
  UpdateTextStyle {
    id: String,
    name: Option<String>,
    font_family: Option<String>,
    font_size: Option<f64>,
    font_weight: Option<u32>,
    line_height: Option<f64>,
    /// Clears the line height (back to auto).
    #[serde(default)]
    auto_line_height: bool,
    letter_spacing: Option<f64>,
  },
  /// Saves a layer's effects as a named effect style and links the layer to it.
  AddEffectStyle {
    name: String,
    from: NodeId,
    #[serde(default)]
    description: String,
  },
  /// Saves a frame's layout grids as a named grid style and links the layer to it.
  AddGridStyle {
    name: String,
    from: NodeId,
    #[serde(default)]
    description: String,
  },
  /// Edits an effect style in place and rewrites the effects of every linked layer.
  UpdateEffectStyle {
    id: String,
    name: Option<String>,
    effects: Option<Vec<Effect>>,
    description: Option<String>,
  },
  /// Edits a grid style in place and rewrites the grids of every linked layer.
  UpdateGridStyle {
    id: String,
    name: Option<String>,
    grids: Option<Vec<LayoutGrid>>,
    description: Option<String>,
  },
  DeleteStyle {
    id: String,
  },
  /// Unlinks layers from a style and keeps their values. `kind` picks the link of a colour style
  /// (`fill`, the default, or `stroke`); other styles have one link each.
  DetachStyle {
    ids: Vec<NodeId>,
    style_id: String,
    #[serde(default)]
    kind: Option<String>,
  },
  /// Applies a style. A colour style goes to the fill, or to the stroke when `kind` is `stroke`.
  ApplyStyle {
    ids: Vec<NodeId>,
    style_id: String,
    #[serde(default)]
    kind: Option<String>,
  },
  Ai {
    tool: String,
    input: Value,
  },
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "q", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Query {
  /// How many layers of an instance differ from its main component.
  OverrideCount {
    id: NodeId,
  },
  /// The property groups a layer inside an instance overrides (`{ groups: [{ key, label }] }`).
  OverrideGroups {
    id: NodeId,
  },
  /// The layers inside instance `id` that carry overrides, in tree order, capped at 20:
  /// `{ layers: [{ id, name, groups: [{ key, label }] }], more }`.
  OverriddenLayers {
    id: NodeId,
  },
  /// Component properties for the design panel: of a main component or set, the controls of
  /// an instance, or what a layer of a main component can bind to.
  ComponentProps {
    id: NodeId,
  },
  Pick {
    x: f64,
    y: f64,
    zoom: f64,
    #[serde(default)]
    deep: bool,
  },
  Drill {
    x: f64,
    y: f64,
    zoom: f64,
    container: NodeId,
  },
  Hit {
    x: f64,
    y: f64,
    zoom: f64,
  },
  Marquee {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
  },
  /// Per-line geometry (char ranges, x positions) of a text layer, all lines, for the editor's
  /// caret and selection.
  TextLayout {
    id: NodeId,
    /// Only measure the lines touching these chars (and one line either side).
    #[serde(default)]
    from: Option<usize>,
    #[serde(default)]
    to: Option<usize>,
  },
  Bounds {
    ids: Vec<NodeId>,
    /// Also give each item's `painted` bounds: everything it draws (shadows, outside strokes, blurs),
    /// which is what an export of it covers. Costs a walk of the subtree, so it is opt-in.
    #[serde(default)]
    painted: bool,
  },
  FrameAt {
    x: f64,
    y: f64,
    #[serde(default)]
    exclude: Vec<NodeId>,
  },
  /// Where dropping `ids` at the page point (x, y) would insert them when the frame there is an
  /// auto layout one they would enter: `{frame, index, line: [x1, y1, x2, y2]}` (page space), else null.
  DropSlot {
    ids: Vec<NodeId>,
    x: f64,
    y: f64,
  },
  SnapPoint {
    x: f64,
    y: f64,
    zoom: f64,
    #[serde(default)]
    exclude: Vec<NodeId>,
  },
  /// Alt-hover distances from `ids` (default: the selection) to the hovered layer `target`; without
  /// a usable one (none, or it is the selection) to the layer enclosing the selection at the page
  /// point (x, y): `{target, lines, extends}` or null.
  Measure {
    #[serde(default)]
    ids: Vec<NodeId>,
    #[serde(default)]
    target: Option<NodeId>,
    #[serde(default)]
    x: f64,
    #[serde(default)]
    y: f64,
    #[serde(default = "one")]
    zoom: f64,
  },
  /// Vector edit mode: the point on vector `id`'s path nearest to a page point, within a
  /// few screen pixels: `{sub, seg, t, x, y}` (page coordinates) or null.
  VectorSegmentAt {
    id: NodeId,
    x: f64,
    y: f64,
    zoom: f64,
  },
  /// Layers identical to `ids` in the other top-level frames or groups of their page.
  MatchingLayers {
    ids: Vec<NodeId>,
  },
  /// Layers on the page of `id` with the same fill / stroke / effect / text / font / instance.
  SameProperty {
    id: NodeId,
    prop: String,
  },
  /// Instances of a main component (or of an instance's component) on the current page or all.
  Instances {
    component: NodeId,
    #[serde(default)]
    all_pages: bool,
  },
  /// Comment threads on a page with resolved page positions.
  Comments {
    #[serde(default)]
    page: Option<String>,
    #[serde(default)]
    include_resolved: bool,
  },
  /// Visible layout grids on a page, for the canvas overlay.
  GridOverlay {
    #[serde(default)]
    page: Option<String>,
  },
  /// Safe-area bands of the selected device frames on a page, for the canvas overlay.
  SafeAreas {
    #[serde(default)]
    page: Option<String>,
  },
  /// The device preset table: id, group, label, size, kind and insets.
  DevicePresets,
  /// A device frame's safe area as its toggles stand: `[top, right, bottom, left]` or null.
  DeviceInsets {
    id: NodeId,
  },
  Copy {
    ids: Vec<NodeId>,
  },
  ExportSvg {
    id: NodeId,
    /// Layers (with what is inside them) left out of the picture; the prototype player draws them elsewhere.
    #[serde(default)]
    hide: Vec<NodeId>,
    /// Only the children, cropped to what they paint; answers `{svg, x, y, width, height}`.
    #[serde(default)]
    children_only: bool,
    /// Answer `{svg, x, y, width, height}` (the crop in page space) for the whole layer too.
    #[serde(default)]
    with_bounds: bool,
  },
  ExportHtml {
    id: NodeId,
  },
  ExportReact {
    id: NodeId,
  },
  ExportProject,
  /// Names the exported code gives the document's styles and variables (for the Code tab's Inspect).
  InspectNames,
  ToolDefs,
  SystemPrompt,
  /// Design lint issues for a page (default: current page).
  Lint {
    #[serde(default)]
    page: Option<String>,
  },
  Summary {
    #[serde(default = "three")]
    depth: usize,
  },
}

/// `[x, y, width, height]`, the form rects take towards the editor.
fn rect_array(r: &Rect) -> [f64; 4] {
  [r.x, r.y, r.width, r.height]
}

fn one() -> f64 {
  1.0
}

fn three() -> usize {
  3
}

/// The error for an edit in read-only mode.
pub const READ_ONLY: &str = "You can view this file but not edit it";

/// Commands a read-only engine still runs: moving around, comments (people with a view link
/// may comment), changes from collaborators and the bookkeeping around them.
fn allowed_read_only(cmd: &Command) -> bool {
  matches!(
    cmd,
    Command::Relayout
      | Command::Select { .. }
      | Command::SelectAll
      | Command::SetPage { .. }
      | Command::ApplyRemote { .. }
      | Command::CollabAck { .. }
      | Command::ReplaceDocument { .. }
      | Command::SetReadOnly { .. }
      | Command::SetHistoryGroup { .. }
      | Command::BeginGesture
      | Command::EndGesture
      | Command::CancelGesture
      | Command::Undo
      | Command::Redo
      | Command::AddComment { .. }
      | Command::ReplyComment { .. }
      | Command::ResolveComment { .. }
  )
}

/// `current`'s comments as they sit in `restored`: on their layer if it exists there, else a
/// page comment at the position it had on the page; on the first page if its page is gone.
fn carry_comments(current: &Document, restored: &Document) -> std::collections::BTreeMap<String, crate::model::Comment> {
  let mut out = current.comments.clone();
  for c in out.values_mut() {
    if let Some(id) = c.node.clone() {
      if restored.get(&id).is_none() {
        if current.get(&id).is_some() {
          let b = current.abs_bounds(&id);
          c.x += b.x;
          c.y += b.y;
        }
        c.node = None;
      }
    }
    match c.node.as_ref().and_then(|id| restored.get(id)) {
      Some(n) => c.page = n.page.clone(),
      None if restored.page(&c.page).is_none() => c.page = restored.pages[0].id.clone(),
      None => {}
    }
  }
  out
}

/// Where a layer dropped into an auto layout frame goes: its index among the frame's children and
/// the insertion line `[x1, y1, x2, y2]` in page space.
struct FlowSlot {
  index: usize,
  /// The flow child the layers go in front of; `None` puts them at the end.
  anchor: Option<NodeId>,
  line: [f64; 4],
}

pub struct Engine {
  pub doc: Document,
  pub selection: Vec<NodeId>,
  pub page: String,
  pub rev: u64,
  /// Bumped whenever the document itself changes (not selection, page or gesture
  /// bookkeeping), so the editor can tell "needs saving" from "was clicked".
  pub doc_rev: u64,
  /// View-only: `dispatch` refuses commands that change the file (see `Command::SetReadOnly`).
  read_only: bool,
  past: Vec<Step>,
  future: Vec<Step>,
  /// Group for the steps of `Command::Ai` (see `Command::SetHistoryGroup`).
  history_group: Option<String>,
  gesture: Option<Snapshot>,
  /// Where undo returns to when the gesture was rebased (`RebaseGesture`).
  gesture_undo: Option<Snapshot>,
  /// Latest `Translate` delta of the open gesture (where an auto layout child was dragged to).
  drag_delta: Option<Point>,
  pub(crate) gen: IdGen,
  pub(crate) measurer: Box<dyn TextMeasurer>,
  fingerprints: HashMap<NodeId, u64>,
  render_cache: RenderCache,
  /// Document as last sent to the editor UI (see `doc_delta`).
  synced: Option<Document>,
  /// Document as last sent to collaborators (see `collab_delta`).
  collab_synced: Option<Document>,
  /// With a relay that orders changes: the room's document as of every change it has
  /// ordered so far, and this editor's changes it hasn't yet (oldest first). The document
  /// is always `collab_confirmed` with `collab_pending` on top, so once nothing is pending
  /// it equals the room's.
  collab_confirmed: Option<Document>,
  collab_pending: std::collections::VecDeque<Value>,
  /// The room understands pages, styles and variables as per-id changes.
  collab_granular: bool,
}

/// Per-root SVG from the last canvas render, and the document it was made from.
#[derive(Default)]
struct RenderCache {
  page: String,
  hidden: Vec<NodeId>,
  editing: Option<NodeId>,
  doc: Option<Document>,
  roots: HashMap<NodeId, String>,
  /// Everything each root paints, in page coordinates (what the canvas culls against).
  bounds: HashMap<NodeId, Rect>,
}

impl Engine {
  pub fn new(measurer: Box<dyn TextMeasurer>, seed: u64) -> Self {
    let mut gen = IdGen::new(seed);
    let doc = new_document(&mut gen, "Untitled");
    let page = doc.pages[0].id.clone();
    Engine {
      doc,
      selection: vec![],
      page,
      rev: 1,
      doc_rev: 1,
      read_only: false,
      past: vec![],
      future: vec![],
      history_group: None,
      gesture: None,
      gesture_undo: None,
      drag_delta: None,
      gen,
      measurer,
      fingerprints: HashMap::new(),
      render_cache: RenderCache::default(),
      synced: None,
      collab_synced: None,
      collab_confirmed: None,
      collab_pending: Default::default(),
      collab_granular: false,
    }
  }

  /// A second engine on the same document, in O(1) (the node table is persistent): no history,
  /// no selection, no collaboration state. The prototype player runs its own copy so playing
  /// never touches the editor's. The copy starts as already sent to the UI, so its first
  /// `doc_delta(false)` carries only what the player changed.
  pub fn fork(&self, measurer: Box<dyn TextMeasurer>) -> Engine {
    let mut e = Engine::new(measurer, 0);
    e.doc = self.doc.clone();
    e.page = self.page.clone();
    e.gen = self.gen.clone();
    e.fingerprints = self.fingerprints.clone();
    e.synced = Some(self.doc.clone());
    e
  }

  /// Replaces the document (opening a file). Clears history.
  pub fn load(&mut self, json: &str) -> Result<(), String> {
    let mut doc: Document = serde_json::from_str(json).map_err(|e| format!("not a Designotron file: {e}"))?;
    if doc.pages.is_empty() {
      return Err("document has no pages".into());
    }
    // Files and links can come from anyone: never let a parent cycle hang layout or rendering.
    let ids: Vec<NodeId> = doc.nodes.keys().cloned().collect();
    doc.break_parent_cycles(&ids);
    components::repair_masters(&mut doc);
    self.page = doc.pages[0].id.clone();
    self.doc = doc;
    self.selection.clear();
    self.past.clear();
    self.future.clear();
    self.history_group = None;
    self.gesture = None;
    self.gesture_undo = None;
    self.collab_confirmed = None;
    self.collab_pending.clear();
    self.fingerprints.clear();
    self.refresh_fingerprints();
    layout::relayout_all(&mut self.doc, self.measurer.as_ref());
    self.render_cache = RenderCache::default();
    self.rev += 1;
    self.doc_rev += 1;
    Ok(())
  }

  pub fn to_json(&self) -> String {
    let mut buf: Vec<u8> = Vec::with_capacity(self.doc.nodes.len() * 1000 + 4096);
    if serde_json::to_writer(&mut buf, &self.doc).is_err() {
      return String::new();
    }
    String::from_utf8(buf).unwrap_or_default()
  }

  pub fn state(&self) -> Value {
    json!({
      "rev": self.rev,
      "docRev": self.doc_rev,
      "page": self.page,
      "selection": self.selection,
      "canUndo": !self.past.is_empty(),
      "canRedo": !self.future.is_empty(),
      "inGesture": self.gesture.is_some(),
      "readOnly": self.read_only,
    })
  }

  /// Changes since the previous call, for keeping a JS copy of the document current:
  /// `{full: doc}` the first time (or when `full`), `{same: true}` when nothing changed (selecting,
  /// say: the copy stays the same object), else `{nodes: {id: node}, removed: [ids], meta}` where
  /// `meta` carries the small document-level fields (pages, styles, variables, name).
  pub fn doc_delta(&mut self, full: bool) -> Value {
    serde_json::from_str(&self.doc_delta_json(full)).unwrap_or(Value::Null)
  }

  /// `doc_delta` as JSON text, written node by node: building a `Value` tree first costs more
  /// than the serialising on a large change (the undo of a big delete).
  pub fn doc_delta_json(&mut self, full: bool) -> String {
    use std::io::Write;
    let out = match (&self.synced, full) {
      (Some(prev), false) if *prev == self.doc => return "{\"same\":true}".into(),
      (Some(prev), false) => {
        let mut buf: Vec<u8> = Vec::with_capacity(1024);
        buf.extend_from_slice(b"{\"nodes\":{");
        let mut first = true;
        let mut removed = Vec::new();
        for item in prev.nodes.diff(&self.doc.nodes) {
          match item {
            imbl::ordmap::DiffItem::Add(k, v) | imbl::ordmap::DiffItem::Update { new: (k, v), .. } => {
              if !first {
                buf.push(b',');
              }
              first = false;
              let _ = serde_json::to_writer(&mut buf, k);
              buf.push(b':');
              let at = buf.len();
              if serde_json::to_writer(&mut buf, v).is_err() {
                buf.truncate(at);
                buf.extend_from_slice(b"null");
              }
            }
            imbl::ordmap::DiffItem::Remove(k, _) => removed.push(k.clone()),
          }
        }
        buf.extend_from_slice(b"},\"removed\":");
        let _ = serde_json::to_writer(&mut buf, &removed);
        // Every document-level field except the node table (cheap: the node map clone is O(1)).
        let mut shell = self.doc.clone();
        shell.nodes = imbl::OrdMap::new();
        let mut meta = serde_json::to_value(&shell).unwrap_or(Value::Null);
        if let Some(m) = meta.as_object_mut() {
          m.remove("nodes");
        }
        let _ = write!(buf, ",\"meta\":{meta}}}");
        buf
      }
      _ => {
        // One buffer, sized for the document: a growing String plus a `format!` copy of it
        // peaked at about five times the JSON on a 20k-layer file.
        let mut buf: Vec<u8> = Vec::with_capacity(self.doc.nodes.len() * 1000 + 4096);
        buf.extend_from_slice(b"{\"full\":");
        let at = buf.len();
        if serde_json::to_writer(&mut buf, &self.doc).is_err() {
          buf.truncate(at);
          buf.extend_from_slice(b"null");
        }
        buf.push(b'}');
        buf
      }
    };
    self.synced = Some(self.doc.clone());
    String::from_utf8(out).unwrap_or_default()
  }

  /// Local changes since the last call, for collaborators (`collab::delta` format).
  /// The first call returns `{full: doc}`.
  pub fn collab_delta(&mut self) -> Value {
    let ordered = self.collab_confirmed.is_some();
    let out = match &self.collab_synced {
      Some(base) => crate::collab::delta(base, &self.doc, ordered, self.collab_granular),
      None => json!({ "full": self.doc }),
    };
    self.collab_synced = Some(self.doc.clone());
    if ordered && out.get("full").is_none() && !crate::collab::is_empty(&out) {
      self.collab_pending.push_back(out.clone());
    }
    out
  }

  /// Starts a collaboration baseline at the current document without producing a delta.
  /// `ordered`: the relay acknowledges every change in the order it applies them (and
  /// understands per-property patches). `granular`: it also understands pages, styles and
  /// variables as per-id changes (`collab::delta`).
  pub fn collab_reset(&mut self, ordered: bool, granular: bool) {
    self.collab_granular = ordered && granular;
    self.collab_synced = Some(self.doc.clone());
    self.collab_confirmed = ordered.then(|| self.doc.clone());
    self.collab_pending.clear();
  }

  /// This editor's changes the relay hasn't acknowledged, plus any not yet sent, oldest
  /// first (to re-apply on top of the room's document after reconnecting).
  pub fn collab_unsent(&mut self) -> Value {
    let mut out: Vec<Value> = self.collab_pending.drain(..).collect();
    if let Some(base) = &self.collab_synced {
      let d = crate::collab::delta(base, &self.doc, self.collab_confirmed.is_some(), self.collab_granular);
      if !crate::collab::is_empty(&d) {
        out.push(d);
      }
    }
    Value::Array(out)
  }

  /// The confirmed document with every pending change on top.
  fn collab_rebuild(&self) -> Option<Document> {
    let mut doc = self.collab_confirmed.clone()?;
    for d in &self.collab_pending {
      let _ = crate::collab::apply(&mut doc, d);
    }
    Some(doc)
  }

  /// Forgets cached canvas SVG (the next incremental render returns every root).
  pub fn reset_render_cache(&mut self) {
    self.render_cache = RenderCache::default();
  }

  /// Canvas render that re-renders only top-level layers changed since the last call.
  /// Returns `{order: [root ids], changed: {id: svg}, moved: {id: transform}, bounds: {id: [x, y,
  /// w, h]}, texts: {id: count}}` (`bounds` is what a root paints in page coordinates and `texts`
  /// its number of text layers, for the roots that changed or moved), or `{full: svg}` when the
  /// page uses top-level masks (which span roots).
  pub fn render_incremental(&mut self, page: &str, hidden: &[NodeId], editing: Option<&str>) -> Value {
    let roots = self.doc.page(page).map(|p| p.children.clone()).unwrap_or_default();
    if roots
      .iter()
      .any(|r| self.doc.get(r).map(|n| n.is_mask && n.visible).unwrap_or(false))
    {
      self.render_cache = RenderCache::default();
      return json!({ "full": self.render(page, hidden, editing) });
    }
    let mut cache = std::mem::take(&mut self.render_cache);
    let mut dirty: Vec<NodeId> = Vec::new();
    // Roots whose only change is the root's own position: the client just updates a transform.
    let mut moved = serde_json::Map::new();
    let mut bounds = serde_json::Map::new();
    let mut texts = serde_json::Map::new();
    match &cache.doc {
      Some(prev) if cache.page == page => {
        for (root, ids) in self.changed_by_root(prev) {
          let only_moved = self.only_moved(prev, &root, &ids);
          if only_moved
            && cache.roots.contains_key(&root)
            && !hidden
              .iter()
              .chain(editing.map(|e| e.to_string()).iter())
              .any(|h| self.doc.ancestors(h).last() == Some(&root) || *h == root)
          {
            if let (Some(n), Some(old)) = (self.doc.get(&root), prev.get(&root)) {
              moved.insert(root.clone(), json!(self.doc.local_matrix(n).svg()));
              if let Some(b) = cache.bounds.get_mut(&root) {
                b.x += n.x - old.x;
                b.y += n.y - old.y;
                bounds.insert(root.clone(), json!(rect_array(b)));
              }
            }
          } else {
            dirty.push(root);
          }
        }
        // Hiding or showing a layer (text editing) repaints its root.
        for h in cache.hidden.iter().chain(hidden.iter()) {
          if cache.hidden.contains(h) != hidden.contains(h) {
            let root = self.doc.ancestors(h).last().cloned().unwrap_or_else(|| h.clone());
            moved.remove(&root);
            dirty.push(root);
          }
        }
        // Starting, ending or switching the text being edited repaints its root(s).
        if cache.editing.as_deref() != editing {
          for h in cache.editing.iter().map(|s| s.as_str()).chain(editing) {
            if self.doc.get(h).is_some() {
              let root = self.doc.ancestors(h).last().cloned().unwrap_or_else(|| h.to_string());
              moved.remove(&root);
              dirty.push(root);
            }
          }
        }
      }
      _ => {
        cache.roots.clear();
        cache.bounds.clear();
      }
    }
    let mut changed = serde_json::Map::new();
    for r in &roots {
      if dirty.contains(r) || !cache.roots.contains_key(r) {
        let svg = render::render_root(
          &self.doc,
          r,
          self.measurer.as_ref(),
          RenderOptions {
            mode: Mode::Canvas,
            hidden,
            editing,
          },
        );
        texts.insert(r.clone(), json!(svg.matches("<text").count()));
        changed.insert(r.clone(), json!(svg));
        cache.roots.insert(r.clone(), svg);
        moved.remove(r);
        let b = render::render_bounds(&self.doc, r, self.measurer.as_ref());
        bounds.insert(r.clone(), json!(rect_array(&b)));
        cache.bounds.insert(r.clone(), b);
      }
    }
    cache.roots.retain(|k, _| roots.contains(k));
    cache.bounds.retain(|k, _| roots.contains(k));
    cache.doc = Some(self.doc.clone());
    cache.page = page.to_string();
    cache.hidden = hidden.to_vec();
    cache.editing = editing.map(|s| s.to_string());
    self.render_cache = cache;
    json!({ "order": roots, "changed": changed, "moved": moved, "bounds": bounds, "texts": texts })
  }

  pub fn render(&self, page: &str, hidden: &[NodeId], editing: Option<&str>) -> String {
    render::render_page(
      &self.doc,
      page,
      self.measurer.as_ref(),
      RenderOptions {
        mode: Mode::Canvas,
        hidden,
        editing,
      },
    )
  }

  fn snapshot(&self) -> Snapshot {
    Snapshot {
      doc: self.doc.clone(),
      selection: self.selection.clone(),
      page: self.page.clone(),
    }
  }

  fn restore(&mut self, s: Snapshot) {
    self.doc = s.doc;
    self.selection = s.selection;
    self.page = s.page;
  }

  /// Executes a command. Mutations become one undo step (or join the open gesture).
  pub fn dispatch(&mut self, cmd: Command) -> Result<Value, String> {
    if let Command::SetReadOnly { on } = cmd {
      if self.read_only != on {
        self.read_only = on;
        // The document is unchanged (doc_rev stays), but the editor's state isn't.
        self.rev += 1;
      }
      return Ok(json!({}));
    }
    if self.read_only && !allowed_read_only(&cmd) {
      return Err(READ_ONLY.into());
    }
    match cmd {
      Command::Relayout => {
        let prev = self.doc.clone();
        layout::relayout_all(&mut self.doc, self.measurer.as_ref());
        // Text measurement may have changed (fonts loaded): repaint everything.
        self.render_cache = RenderCache::default();
        self.rev += 1;
        // Fonts finishing to load re-run this on every open: only a real change is an edit.
        if prev != self.doc {
          self.doc_rev += 1;
        }
        return Ok(json!({}));
      }
      Command::Undo => {
        if let Some(step) = self.past.pop() {
          let group = step.group.clone();
          self.undo_step(step);
          // The rest of a chat turn's steps go with it.
          while group.is_some() && self.past.last().is_some_and(|s| s.group == group) {
            let step = self.past.pop().unwrap();
            self.undo_step(step);
          }
          self.doc_rev += 1;
        }
        self.rev += 1;
        return Ok(json!({}));
      }
      Command::Redo => {
        if let Some(step) = self.future.pop() {
          let group = step.group.clone();
          self.redo_step(step);
          while group.is_some() && self.future.last().is_some_and(|s| s.group == group) {
            let step = self.future.pop().unwrap();
            self.redo_step(step);
          }
          self.doc_rev += 1;
        }
        self.rev += 1;
        return Ok(json!({}));
      }
      Command::SetHistoryGroup { group } => {
        self.history_group = group.filter(|g| !g.is_empty());
        return Ok(json!({}));
      }
      Command::ApplyRemote { delta, local } => {
        // A collaborator's change: merged into the document (and the open gesture's base),
        // never recorded in local history. Callers flush their own delta first.
        let prev = self.doc.clone();
        if local {
          crate::collab::apply(&mut self.doc, &delta)?;
          self.after_mutation(&prev);
          self.rev += 1;
          self.doc_rev += 1;
          return Ok(json!({}));
        }
        if let Some(c) = self.collab_confirmed.as_mut() {
          // In the relay's order, under this editor's own changes it hasn't ordered yet.
          crate::collab::apply(c, &delta)?;
          self.doc = self.collab_rebuild().unwrap();
        } else {
          crate::collab::apply(&mut self.doc, &delta)?;
        }
        if let Some(g) = self.gesture.as_mut() {
          let _ = crate::collab::apply(&mut g.doc, &delta);
        }
        if let Some(g) = self.gesture_undo.as_mut() {
          let _ = crate::collab::apply(&mut g.doc, &delta);
        }
        self.refresh_fingerprints();
        self.after_mutation(&prev);
        self.collab_synced = Some(self.doc.clone());
        self.rev += 1;
        self.doc_rev += 1;
        return Ok(json!({}));
      }
      Command::CollabAck { rejected } => {
        let Some(d) = self.collab_pending.pop_front() else {
          return Ok(json!({}));
        };
        if !rejected {
          if let Some(c) = self.collab_confirmed.as_mut() {
            let _ = crate::collab::apply(c, &d);
          }
          return Ok(json!({}));
        }
        // The relay didn't take it: everyone else's copy lacks it, so this one drops it too.
        let Some(doc) = self.collab_rebuild() else { return Ok(json!({})) };
        let prev = std::mem::replace(&mut self.doc, doc);
        self.refresh_fingerprints();
        self.after_mutation(&prev);
        self.collab_synced = Some(self.doc.clone());
        self.rev += 1;
        self.doc_rev += 1;
        return Ok(json!({}));
      }
      Command::BeginGesture => {
        self.gesture = Some(self.snapshot());
        self.gesture_undo = None;
        self.drag_delta = None;
        return Ok(json!({}));
      }
      Command::RebaseGesture => {
        if let Some(base) = self.gesture.take() {
          self.gesture_undo.get_or_insert(base);
          self.gesture = Some(self.snapshot());
          self.drag_delta = None;
        }
        return Ok(json!({}));
      }
      Command::EndGesture => {
        let gesture = self.gesture.take();
        if let Some(base) = self.gesture_undo.take().or(gesture) {
          if base.doc != self.doc {
            self.push_past(base, None);
          }
        }
        self.rev += 1;
        return Ok(json!({}));
      }
      Command::CancelGesture => {
        let gesture = self.gesture.take();
        if let Some(base) = self.gesture_undo.take().or(gesture) {
          let prev = self.doc.clone();
          self.restore(base);
          if prev != self.doc {
            self.doc_rev += 1;
          }
        }
        self.rev += 1;
        return Ok(json!({}));
      }
      Command::Select { ids, mode } => {
        let ids: Vec<NodeId> = ids.into_iter().filter(|i| self.doc.nodes.contains_key(i)).collect();
        match mode {
          SelectMode::Replace => self.selection = ids,
          SelectMode::Add => {
            for i in ids {
              if !self.selection.contains(&i) {
                self.selection.push(i);
              }
            }
          }
          SelectMode::Toggle => {
            for i in ids {
              if let Some(p) = self.selection.iter().position(|s| *s == i) {
                self.selection.remove(p);
              } else {
                self.selection.push(i);
              }
            }
          }
        }
        if let Some(first) = self.selection.first() {
          if let Some(n) = self.doc.get(first) {
            self.page = n.page.clone();
          }
        }
        self.rev += 1;
        return Ok(json!({ "selection": self.selection }));
      }
      Command::SelectAll => {
        let scope = self
          .selection
          .first()
          .and_then(|s| self.doc.get(s))
          .map(|n| (n.parent.clone(), n.page.clone()));
        self.selection = match scope {
          Some((parent, page)) => self.doc.child_ids(parent.as_deref(), &page),
          None => self.doc.page(&self.page).map(|p| p.children.clone()).unwrap_or_default(),
        };
        self
          .selection
          .retain(|i| self.doc.get(i).map(|n| n.visible && !n.locked).unwrap_or(false));
        self.rev += 1;
        return Ok(json!({ "selection": self.selection }));
      }
      Command::SetPage { id } => {
        if self.doc.page(&id).is_some() {
          self.page = id;
          self.selection.clear();
        }
        self.rev += 1;
        return Ok(json!({}));
      }
      _ => {}
    }

    // O(1) with the persistent node map; diffed later to find what needs layout.
    let prev = self.doc.clone();
    let group = if matches!(cmd, Command::Ai { .. }) {
      self.history_group.clone()
    } else {
      None
    };
    let gesture_relative = matches!(cmd, Command::Translate { .. } | Command::Resize { .. } | Command::Rotate { .. });
    // Inside a gesture there's no undo snapshot, but a command that fails still has to leave
    // nothing behind: AI tools change several layers before they can fail on a later one.
    let rollback = self.gesture.is_some().then(|| self.snapshot());
    if gesture_relative {
      if let Some(base) = self.gesture.clone() {
        self.doc = base.doc;
      }
    }
    let before = if self.gesture.is_none() { Some(self.snapshot()) } else { None };
    let result = self.apply(cmd);
    let out = match result {
      Ok(v) => {
        self.after_mutation(&prev);
        if let Some(b) = before {
          if b.doc != self.doc {
            self.push_past(b, group);
          }
        }
        self.rev += 1;
        Ok(v)
      }
      Err(e) => {
        if let Some(b) = before.or(rollback) {
          self.restore(b);
        }
        Err(e)
      }
    };
    // Selecting through an AI tool or a no-op patch leaves the document as it was (equality
    // is pointer-fast on shared nodes), and must not look like an edit to autosave.
    if prev != self.doc {
      self.doc_rev += 1;
    }
    out
  }

  fn push_past(&mut self, s: Snapshot, group: Option<String>) {
    // A step of the same group that starts exactly where the last one ended (nothing in
    // between, remote edits included) extends it: a chat turn or plugin run is one step.
    if group.is_some() {
      if let Some(last) = self.past.last_mut() {
        if last.group == group && last.after == s.doc {
          last.after = self.doc.clone();
          last.after_page = self.page.clone();
          last.after_selection = self.selection.clone();
          self.future.clear();
          return;
        }
      }
    }
    self.past.push(Step {
      before: s,
      after: self.doc.clone(),
      after_page: self.page.clone(),
      after_selection: self.selection.clone(),
      group,
    });
    if self.past.len() > MAX_HISTORY {
      self.past.remove(0);
    }
    self.future.clear();
  }

  /// Reverts one step on the current document (collaborators' later edits stay) and queues
  /// it for redo.
  fn undo_step(&mut self, step: Step) {
    let prev = self.doc.clone();
    // Nobody else changed anything since: the saved state is exact (and laid out).
    let exact = self.doc == step.after;
    self.doc = if exact {
      step.before.doc.clone()
    } else {
      crate::collab::revert(&self.doc, &step.after, &step.before.doc)
    };
    self.selection = step
      .before
      .selection
      .iter()
      .filter(|id| self.doc.get(id).is_some())
      .cloned()
      .collect();
    if self.doc.page(&step.before.page).is_some() {
      self.page = step.before.page.clone();
    }
    self.refresh_fingerprints();
    if !exact {
      self.after_mutation(&prev);
    }
    self.future.push(step);
  }

  /// Re-applies one undone step. As for undo, re-running layout on the saved state could
  /// move a value by a rounding error, so an untouched document is taken as is.
  fn redo_step(&mut self, step: Step) {
    let prev = self.doc.clone();
    let exact = self.doc == step.before.doc;
    self.doc = if exact {
      step.after.clone()
    } else {
      crate::collab::revert(&self.doc, &step.before.doc, &step.after)
    };
    self.selection = step
      .after_selection
      .iter()
      .filter(|id| self.doc.get(id).is_some())
      .cloned()
      .collect();
    if self.doc.page(&step.after_page).is_some() {
      self.page = step.after_page.clone();
    }
    self.refresh_fingerprints();
    if !exact {
      self.after_mutation(&prev);
    }
    self.past.push(step);
  }

  /// Keeps derived state consistent: instances, layout, selection.
  /// Changed node ids grouped by the top-level layer they belong to.
  fn changed_by_root(&self, prev: &Document) -> HashMap<NodeId, Vec<NodeId>> {
    let mut out: HashMap<NodeId, Vec<NodeId>> = HashMap::new();
    let root_in = |doc: &Document, id: &str| doc.ancestors(id).last().cloned().unwrap_or_else(|| id.to_string());
    for item in prev.nodes.diff(&self.doc.nodes) {
      let (root, id) = match item {
        imbl::ordmap::DiffItem::Add(k, _) => (root_in(&self.doc, k), k),
        imbl::ordmap::DiffItem::Update { new: (k, _), .. } => (root_in(&self.doc, k), k),
        imbl::ordmap::DiffItem::Remove(k, _) => (root_in(prev, k), k),
      };
      out.entry(root).or_default().push(id.clone());
    }
    out
  }

  /// True when the only difference in `root`'s tree is the root's own position.
  fn only_moved(&self, prev: &Document, root: &str, changed: &[NodeId]) -> bool {
    changed.len() == 1
      && changed[0] == root
      && match (prev.get(root), self.doc.get(root)) {
        (Some(a), Some(b)) => {
          let mut a = a.clone();
          a.x = b.x;
          a.y = b.y;
          a == *b
        }
        _ => false,
      }
  }

  fn after_mutation(&mut self, prev: &Document) {
    // Layers added to or reordered in a device frame stay below its system UI (before instances
    // of a main device frame sync from it).
    let device_frames: Vec<NodeId> = self
      .changed_by_root(prev)
      .values()
      .flatten()
      .filter(|id| self.doc.get(id).is_some_and(|n| n.device.is_some()))
      .cloned()
      .collect();
    for id in &device_frames {
      devices::raise_chrome(&mut self.doc, id);
    }
    crate::props::follow_variants(&mut self.doc, prev);
    crate::variables::normalize(&mut self.doc);
    crate::variables::apply(&mut self.doc);
    for _ in 0..4 {
      let changed = self.changed_components(prev);
      if changed.is_empty() {
        break;
      }
      let instances: Vec<NodeId> = self
        .doc
        .nodes
        .values()
        .filter(|n| n.kind == NodeType::Instance)
        .filter(|n| n.instance.as_ref().map(|i| changed.contains(&i.component_id)).unwrap_or(false))
        .map(|n| n.id.clone())
        .collect();
      // Copies inside other instances follow through their outermost instance; one swapped
      // through it no longer comes from that instance's main, so it re-syncs the outermost.
      let mut outers: Vec<NodeId> = Vec::new();
      for id in instances {
        if self.doc.instance_ancestor(&id).is_none() {
          components::sync_instance(&mut self.doc, &id, &mut self.gen);
        } else if components::is_swapped_nested(&self.doc, &id) {
          let outer = self
            .doc
            .ancestors(&id)
            .into_iter()
            .rev()
            .find(|a| self.doc.get(a).map(|n| n.kind == NodeType::Instance).unwrap_or(false));
          if let Some(o) = outer.filter(|o| !outers.contains(o)) {
            outers.push(o);
          }
        }
      }
      for id in outers {
        components::sync_instance(&mut self.doc, &id, &mut self.gen);
      }
    }
    // Instances just synced from their mains resolve variables in their own mode context.
    crate::variables::apply(&mut self.doc);
    // Only trees that changed need layout (layout never reaches across top-level layers),
    // and moving a whole top-level layer changes nothing inside it.
    let by_root = self.changed_by_root(prev);
    for (root, changed) in by_root {
      if !self.only_moved(prev, &root, &changed) {
        layout::layout_node(&mut self.doc, &root, self.measurer.as_ref());
      }
    }
    self.selection.retain(|i| self.doc.nodes.contains_key(i));
    if self.doc.page(&self.page).is_none() {
      if let Some(p) = self.doc.pages.first() {
        self.page = p.id.clone();
      }
    }
  }

  /// Main components whose subtree changed since `prev` (only those containing changed nodes
  /// are fingerprinted, so unrelated edits in big files stay cheap).
  fn changed_components(&mut self, prev: &Document) -> Vec<NodeId> {
    let mut comps: Vec<NodeId> = Vec::new();
    for item in prev.nodes.diff(&self.doc.nodes) {
      // A set's properties belong to every variant: only a change of those reaches them (moving
      // or renaming the set leaves the variants alone).
      let props_changed = matches!(&item, imbl::ordmap::DiffItem::Update { old, new } if old.1.component != new.1.component);
      let (doc, k) = match item {
        imbl::ordmap::DiffItem::Add(k, _) | imbl::ordmap::DiffItem::Update { new: (k, _), .. } => (&self.doc, k),
        imbl::ordmap::DiffItem::Remove(k, _) => (prev, k),
      };
      for id in std::iter::once(k.clone()).chain(doc.ancestors(k)) {
        match self.doc.get(&id) {
          Some(n) if n.kind == NodeType::Component => {
            if !comps.contains(&id) {
              comps.push(id);
            }
          }
          Some(n) if n.kind == NodeType::ComponentSet && id == *k && props_changed => {
            for c in n
              .children
              .iter()
              .filter(|c| self.doc.get(c).map(|c| c.kind == NodeType::Component).unwrap_or(false))
            {
              if !comps.contains(c) {
                comps.push(c.clone());
              }
            }
          }
          _ => {}
        }
      }
    }
    // Instances copy their main's size, so the mains settle (text re-measured, hug applied)
    // before they are fingerprinted and synced, not after: otherwise instances land one edit behind.
    let mut roots: Vec<NodeId> = Vec::new();
    for c in &comps {
      if let Some(r) = self.doc.path(c).into_iter().next().filter(|r| !roots.contains(r)) {
        roots.push(r);
      }
    }
    for r in &roots {
      layout::layout_node(&mut self.doc, r, self.measurer.as_ref());
    }
    let mut changed = Vec::new();
    for c in comps {
      let fp = components::fingerprint(&self.doc, &c);
      if self.fingerprints.get(&c) != Some(&fp) {
        if self.fingerprints.contains_key(&c) {
          changed.push(c.clone());
        }
        self.fingerprints.insert(c, fp);
      }
    }
    changed
  }

  fn refresh_fingerprints(&mut self) {
    self.fingerprints = self
      .doc
      .components()
      .iter()
      .map(|c| (c.id.clone(), components::fingerprint(&self.doc, &c.id)))
      .collect();
  }

  /// Edits an editable (non-raw) vector's path in place, then optionally refits its box and
  /// records the change as an override when the vector is inside an instance.
  fn edit_vector<T>(&mut self, id: &str, fit: bool, f: impl FnOnce(&mut VectorData) -> Result<T, String>) -> Result<T, String> {
    let n = self.doc.get_mut(id).ok_or("no such layer")?;
    let v = match n.vector.as_mut() {
      Some(v) if n.kind == NodeType::Vector && v.raw.is_none() => v,
      _ => return Err("not an editable vector".into()),
    };
    let out = f(v)?;
    if fit {
      vector_edit::fit_bounds(n);
    }
    let p = json!({ "vector": n.vector, "x": n.x, "y": n.y, "width": n.width, "height": n.height });
    components::record_override(&mut self.doc, id, &p);
    Ok(out)
  }

  /// Inserts a vector built from page-space subpaths, styled like `style`, under `parent`.
  fn insert_vector(&mut self, style: &Node, page_sps: Vec<SubPath>, parent: Option<NodeId>, index: Option<usize>, name: &str) -> NodeId {
    let inv = parent.as_deref().map(|p| self.doc.abs_matrix(p).invert()).unwrap_or_default();
    let local: Vec<SubPath> = page_sps.iter().map(|sp| crate::paths::transform(sp, &inv)).collect();
    let r = |v: f64| (v * 1000.0).round() / 1000.0;
    let (x0, y0, x1, y1) = crate::paths::bounds(&local).unwrap_or((0.0, 0.0, 1.0, 1.0));
    let (x0, y0, x1, y1) = (r(x0), r(y0), r(x1), r(y1));
    let shift = Mat::translate(-x0, -y0);
    let id = self.gen.next("n_");
    let n = Node {
      id: id.clone(),
      kind: NodeType::Vector,
      name: if name.is_empty() { "Vector".into() } else { name.to_string() },
      x: x0,
      y: y0,
      width: (x1 - x0).max(0.01),
      height: (y1 - y0).max(0.01),
      fills: style.fills.clone(),
      strokes: style.strokes.clone(),
      stroke_weight: style.stroke_weight,
      stroke_align: style.stroke_align,
      effects: style.effects.clone(),
      opacity: style.opacity,
      blend_mode: style.blend_mode,
      vector: Some(crate::model::VectorData {
        subpaths: local.iter().map(|sp| crate::paths::transform(sp, &shift)).collect(),
        raw: None,
      }),
      ..Default::default()
    };
    let page = self.page.clone();
    self.doc.insert(n, parent.as_deref(), &page, index);
    id
  }

  /// Replaces layers (paint order) with one vector placed where the top one was.
  fn replace_with_vector(&mut self, ids: &[NodeId], page_sps: Vec<SubPath>, name: &str) -> Result<NodeId, String> {
    let top = ids.last().ok_or("nothing selected")?;
    let parent = self.doc.get(top).and_then(|n| n.parent.clone());
    let index = self.doc.index_in_parent(top).map(|i| i + 1);
    // Style comes from the bottom layer (its first shape if it is a group).
    let mut style_id = ids[0].clone();
    while let Some(n) = self.doc.get(&style_id) {
      match (n.kind, n.children.first()) {
        (NodeType::Group, Some(c)) => style_id = c.clone(),
        _ => break,
      }
    }
    let style = self.doc.get(&style_id).cloned().ok_or("no such layer")?;
    let id = self.insert_vector(&style, page_sps, parent, index, name);
    ops::delete(&mut self.doc, ids);
    self.selection = vec![id.clone()];
    Ok(id)
  }

  /// Parent for newly drawn content: the deepest frame under the point.
  fn auto_parent(&self, explicit: Option<NodeId>, x: f64, y: f64) -> Option<NodeId> {
    explicit
      .filter(|p| self.doc.nodes.contains_key(p))
      .map(|p| devices::host_of(&self.doc, &p))
      .or_else(|| ops::frame_at(&self.doc, &self.page, Point::new(x, y), &[], true))
  }

  /// Inserts a node given in page coordinates under `parent`.
  fn insert_abs(&mut self, mut n: Node, parent: Option<&str>) -> NodeId {
    if let Some(p) = parent {
      let inv = self.doc.abs_matrix(p).invert();
      let tl = inv.apply(Point::new(n.x, n.y));
      n.x = tl.x;
      n.y = tl.y;
    }
    let id = n.id.clone();
    let page = self.page.clone();
    let index = parent.and_then(|p| devices::before_chrome(&self.doc, p));
    self.doc.insert(n, parent, &page, index);
    id
  }

  /// Structural commands never take a device frame's system UI: those layers are dropped from the
  /// command, and it fails when nothing is left (the Device section turns system UI on and off).
  fn without_chrome(&self, mut cmd: Command) -> Result<Command, String> {
    let wrap = match &cmd {
      Command::AddAutoLayout { ids } => !(ids.len() == 1 && self.doc.get(&ids[0]).is_some_and(|n| n.kind.is_frame_like())),
      _ => true,
    };
    let ids = match &mut cmd {
      Command::Group { ids }
      | Command::Ungroup { ids }
      | Command::FrameSelection { ids }
      | Command::CreateComponent { ids }
      | Command::CreateComponents { ids }
      | Command::BooleanOp { ids, .. }
      | Command::Flatten { ids }
      | Command::OutlineStroke { ids }
      | Command::UseAsMask { ids }
      | Command::MoveToPage { ids, .. } => ids,
      Command::AddAutoLayout { ids } if wrap => ids,
      _ => return Ok(cmd),
    };
    let before = ids.len();
    ids.retain(|i| !devices::in_part(&self.doc, i));
    if before > 0 && ids.is_empty() {
      return Err("system UI of a device frame can't be changed this way; turn it on or off in the Device section".into());
    }
    Ok(cmd)
  }

  /// Applies a command without touching history (used by AI tools inside one step).
  pub(crate) fn dispatch_inner(&mut self, cmd: Command) -> Result<Value, String> {
    self.apply(cmd)
  }

  fn apply(&mut self, cmd: Command) -> Result<Value, String> {
    let cmd = self.without_chrome(cmd)?;
    match cmd {
      Command::AddPage { name } => {
        let id = self.gen.next("p_");
        let name = name.unwrap_or_else(|| format!("Page {}", self.doc.pages.len() + 1));
        self.doc.pages.push(Page {
          id: id.clone(),
          name,
          children: vec![],
          background: "#F5F5F5".into(),
          flow_start: None,
          guides: Vec::new(),
        });
        self.page = id.clone();
        self.selection.clear();
        Ok(json!({ "id": id }))
      }
      Command::RenamePage { id, name } => {
        self.doc.page_mut(&id).ok_or("no such page")?.name = name;
        Ok(json!({}))
      }
      Command::DeletePage { id } => {
        if self.doc.pages.len() <= 1 {
          return Err("a document needs at least one page".into());
        }
        let ids: Vec<NodeId> = self.doc.page(&id).ok_or("no such page")?.children.clone();
        for nid in ids {
          self.doc.remove(&nid);
        }
        self.doc.pages.retain(|p| p.id != id);
        Ok(json!({}))
      }
      Command::MovePage { id, index } => {
        arrange::move_page(&mut self.doc, &id, index)?;
        Ok(json!({}))
      }
      Command::DuplicatePage { id } => {
        let new_id = arrange::duplicate_page(&mut self.doc, &mut self.gen, &id)?;
        self.page = new_id.clone();
        self.selection.clear();
        Ok(json!({ "id": new_id }))
      }
      Command::MoveToPage { ids, page } => {
        let moved = arrange::move_to_page(&mut self.doc, &ids, &page)?;
        if moved.is_empty() {
          return Err("nothing to move".into());
        }
        self.page = page;
        self.selection = moved.clone();
        Ok(json!({ "ids": moved }))
      }
      Command::TidyUp { ids, spacing } => {
        arrange::tidy_up(&mut self.doc, &ids, spacing)?;
        Ok(json!({}))
      }
      Command::ScaleNodes { ids, factor, anchor } => {
        if !(factor.is_finite() && factor > 0.0) {
          return Err("the scale factor must be above zero".into());
        }
        let ids = arrange::scalable(&self.doc, &ids);
        let anchor = match anchor {
          Some(a) => a,
          None => {
            let b = self.doc.bounds_of_many(&ids).ok_or("nothing to scale")?;
            Point::new(b.x, b.y)
          }
        };
        arrange::scale_nodes(&mut self.doc, &ids, factor, anchor);
        Ok(json!({}))
      }
      Command::SetPageBackground { id, color } => {
        self.doc.page_mut(&id).ok_or("no such page")?.background = crate::color::normalize(&color);
        Ok(json!({}))
      }
      Command::SetGuides { page, guides } => {
        let id = page.unwrap_or_else(|| self.page.clone());
        self.doc.page_mut(&id).ok_or("no such page")?.guides = guides;
        Ok(json!({}))
      }
      Command::SetVariables { mut collections } => {
        // A mode removed from a collection takes its values with it.
        for c in &mut collections {
          let modes: Vec<String> = c.modes.iter().map(|m| m.id.clone()).collect();
          for v in &mut c.variables {
            v.values.retain(|m, _| modes.contains(m));
          }
        }
        crate::variables::validate(&collections, &self.doc.variables)?;
        self.doc.variables = collections;
        crate::variables::prune(&mut self.doc);
        Ok(json!({}))
      }
      Command::BindVariable { ids, property, variable } => {
        let want = crate::variables::property_kind(&property).ok_or_else(|| format!("{property} can't be bound to a variable"))?;
        let var_id = match &variable {
          Some(key) => {
            let (_, v) = crate::variables::find(&self.doc, key).ok_or_else(|| format!("no variable {key}"))?;
            if v.kind != want {
              return Err(format!(
                "{property} needs a {} variable, {} is {}",
                format!("{want:?}").to_lowercase(),
                v.name,
                format!("{:?}", v.kind).to_lowercase()
              ));
            }
            Some(v.id.clone())
          }
          None => None,
        };
        for id in &ids {
          crate::variables::set_binding(&mut self.doc, id, &property, var_id.as_deref())?;
        }
        Ok(json!({}))
      }
      Command::SetVariableMode { ids, collection, mode } => {
        let coll = self
          .doc
          .variables
          .iter()
          .find(|c| c.id == collection || c.name == collection)
          .ok_or_else(|| format!("no collection {collection}"))?;
        let cid = coll.id.clone();
        let mid = match &mode {
          Some(m) => Some(
            coll
              .modes
              .iter()
              .find(|x| &x.id == m || &x.name == m)
              .map(|x| x.id.clone())
              .ok_or_else(|| format!("no mode {m} in {}", coll.name))?,
          ),
          None => None,
        };
        for id in &ids {
          let n = self.doc.get_mut(id).ok_or_else(|| format!("no node {id}"))?;
          let had = match &mid {
            Some(m) => n.variable_modes.insert(cid.clone(), m.clone()),
            None => n.variable_modes.remove(&cid),
          };
          if had.is_some() || mid.is_some() {
            let pin = json!({ "variableModes": { cid.clone(): mid } });
            components::record_override(&mut self.doc, id, &pin);
          }
        }
        Ok(json!({}))
      }
      Command::AddComment {
        page,
        x,
        y,
        node,
        text,
        author,
        time,
      } => {
        let page = page.unwrap_or_else(|| self.page.clone());
        if self.doc.page(&page).is_none() {
          return Err("no such page".into());
        }
        let node = node.filter(|n| self.doc.get(n).is_some());
        // Attached comments store their offset from the layer so they move with it.
        let (cx, cy) = match &node {
          Some(n) => {
            let b = self.doc.abs_bounds(n);
            (x - b.x, y - b.y)
          }
          None => (x, y),
        };
        let id = self.gen.next("c_");
        self.doc.comments.insert(
          id.clone(),
          crate::model::Comment {
            id: id.clone(),
            page,
            x: cx,
            y: cy,
            node,
            resolved: false,
            messages: vec![crate::model::CommentMessage { author, text, time }],
          },
        );
        Ok(json!({ "id": id }))
      }
      Command::ReplyComment { id, text, author, time } => {
        let c = self.doc.comments.get_mut(&id).ok_or("no such comment")?;
        c.messages.push(crate::model::CommentMessage { author, text, time });
        Ok(json!({}))
      }
      Command::ResolveComment { id, resolved } => {
        self.doc.comments.get_mut(&id).ok_or("no such comment")?.resolved = resolved;
        Ok(json!({}))
      }
      Command::DeleteComment { id } => {
        self.doc.comments.remove(&id).ok_or("no such comment")?;
        Ok(json!({}))
      }
      Command::ImportFigma { file, images } => {
        // Importing into a brand-new file replaces its empty starter page.
        let empty_start = (self.doc.pages.len() == 1 && self.doc.pages[0].children.is_empty()).then(|| self.doc.pages[0].id.clone());
        let r = crate::figma::import(&mut self.doc, &mut self.gen, &file, &images)?;
        if let Some(pid) = empty_start {
          self.doc.pages.retain(|p| p.id != pid);
          if let Some(name) = file.get("name").and_then(|v| v.as_str()) {
            self.doc.name = name.to_string();
          }
        }
        if let Some(first) = r["pages"].as_array().and_then(|p| p.first()).and_then(|p| p.as_str()) {
          self.page = first.to_string();
          self.selection.clear();
        }
        Ok(r)
      }
      Command::ReplaceDocument { doc, keep_comments } => {
        let mut doc: Document = serde_json::from_value(doc).map_err(|e| format!("not a Designotron document: {e}"))?;
        if doc.pages.is_empty() {
          return Err("document has no pages".into());
        }
        if keep_comments {
          doc.comments = carry_comments(&self.doc, &doc);
        }
        if doc.page(&self.page).is_none() {
          self.page = doc.pages[0].id.clone();
        }
        self.doc = doc;
        self.selection.clear();
        self.refresh_fingerprints();
        layout::relayout_all(&mut self.doc, self.measurer.as_ref());
        Ok(json!({}))
      }
      Command::SetDocName { name } => {
        self.doc.name = name;
        Ok(json!({}))
      }
      Command::CreateShape {
        kind,
        x,
        y,
        width,
        height,
        parent,
      } => {
        let parent = self.auto_parent(parent, x, y);
        let name = self.doc.next_name(kind.label());
        let mut n = ops::default_node(kind, self.gen.next("n_"), name);
        n.x = x;
        n.y = y;
        n.width = width.max(if kind == NodeType::Line { 1.0 } else { 0.0 });
        n.height = if kind == NodeType::Line { 0.0 } else { height };
        if kind == NodeType::Component {
          n.component = Some(Default::default());
        }
        let id = self.insert_abs(n, parent.as_deref());
        self.selection = vec![id.clone()];
        Ok(json!({ "id": id }))
      }
      Command::CreateText { x, y, characters, parent } => {
        let parent = self.auto_parent(parent, x, y);
        let mut n = ops::default_node(NodeType::Text, self.gen.next("n_"), String::new());
        n.name = if characters.is_empty() {
          "Text".into()
        } else {
          characters.chars().take(40).collect()
        };
        n.x = x;
        n.y = y;
        n.text.as_mut().unwrap().characters = characters;
        let empty = n.text.as_ref().is_some_and(|t| t.characters.is_empty());
        let id = self.insert_abs(n, parent.as_deref());
        // New text (tool click, Enter) starts white on a dark backdrop; typed text and paste keep black.
        if empty && crate::lint::dark_backdrop(&self.doc, &id, &self.page) {
          if let Some(n) = self.doc.get_mut(&id) {
            n.fills = vec![Paint::solid("#FFFFFF")];
          }
        }
        self.selection = vec![id.clone()];
        Ok(json!({ "id": id }))
      }
      Command::CreateVector { points, closed, parent } => {
        let first = points.first().copied().unwrap_or_default();
        let parent = self.auto_parent(parent, first.x, first.y);
        let n = interact::vector_from_points(&self.doc, &mut self.gen, parent.as_deref(), &points, closed)
          .ok_or("a path needs at least two points")?;
        let id = n.id.clone();
        let page = self.page.clone();
        self.doc.insert(n, parent.as_deref(), &page, None);
        self.selection = vec![id.clone()];
        Ok(json!({ "id": id }))
      }
      Command::InsertVectorPoint { id, sub, seg, t } => {
        let index = self.edit_vector(&id, false, |v| {
          let sp = v.subpaths.get_mut(sub).ok_or("no such subpath")?;
          vector_edit::insert_point(sp, seg, t)
        })?;
        Ok(json!({ "index": index }))
      }
      Command::DeleteVectorPoints { id, points } => {
        // Decide on a copy first: a refused delete must leave the path (and any open
        // gesture or recorded override) untouched.
        let would_leave = match self.doc.get(&id) {
          Some(n) => match n.vector.as_ref() {
            Some(v) if n.kind == NodeType::Vector && v.raw.is_none() => vector_edit::delete_points(&mut v.clone(), &points),
            _ => return Err("not an editable vector".into()),
          },
          None => return Err("no such layer".into()),
        };
        if !would_leave && self.doc.instance_ancestor(&id).is_some() {
          return Err("a path inside an instance needs at least two points".into());
        }
        let mut left = true;
        self.edit_vector(&id, true, |v| {
          left = vector_edit::delete_points(v, &points);
          Ok(())
        })?;
        if !left {
          ops::delete(&mut self.doc, std::slice::from_ref(&id));
        }
        Ok(json!({ "deleted": !left }))
      }
      Command::SetVectorPointsSmooth { id, points, smooth } => {
        self.edit_vector(&id, true, |v| {
          vector_edit::set_smooth(v, &points, smooth);
          Ok(())
        })?;
        Ok(json!({}))
      }
      Command::MoveVectorPoints { id, points, dx, dy } => {
        let d = self.doc.abs_matrix(&id).invert().apply_vec(Point::new(dx, dy));
        self.edit_vector(&id, true, |v| {
          vector_edit::move_points(v, &points, d.x, d.y);
          Ok(())
        })?;
        Ok(json!({}))
      }
      Command::ExtendVector {
        id,
        sub,
        prepend,
        points,
        close,
      } => {
        let local = vector_edit::to_local(&points, &self.doc.abs_matrix(&id).invert());
        self.edit_vector(&id, true, |v| vector_edit::extend(v, sub, prepend, &local, close))?;
        self.selection = vec![id];
        Ok(json!({}))
      }
      Command::FitVectorBounds { id } => {
        self.edit_vector(&id, true, |_| Ok(()))?;
        Ok(json!({}))
      }
      Command::CreateImage {
        src,
        x,
        y,
        width,
        height,
        name,
        parent,
      } => {
        // The frame under the image's centre takes it, like a drop.
        let parent = self.auto_parent(parent, x + width / 2.0, y + height / 2.0);
        let mut n = ops::default_node(NodeType::Rectangle, self.gen.next("n_"), name.unwrap_or_else(|| "Image".into()));
        n.x = x;
        n.y = y;
        n.width = width;
        n.height = height;
        n.fills = vec![Paint::Image {
          credit: None,
          src,
          scale_mode: Default::default(),
          opacity: 1.0,
          visible: true,
          crop: None,
        }];
        let id = self.insert_abs(n, parent.as_deref());
        self.selection = vec![id.clone()];
        Ok(json!({ "id": id }))
      }
      Command::ImportSvg { svg, x, y, parent, name } => self.import_svg(&svg, x, y, parent, name),
      Command::InsertSpecs { specs, parent } => {
        let created = ai::insert_specs(self, &specs, parent.as_deref())?;
        self.selection = created
          .iter()
          .filter_map(|c| c.get("id").and_then(|v| v.as_str()).map(String::from))
          .collect();
        Ok(json!({ "created": created }))
      }
      Command::Paste { data, parent, x, y } => self.paste(&data, parent, x, y),
      Command::Update { ids, patch: p } => {
        // Before anything records the patch (as an instance override, say).
        let p = without_unsafe_links(p);
        let detached = crate::variables::unbind_for_patch(&mut self.doc, &ids, &p);
        for id in &ids {
          let before = self.doc.get(id).cloned().ok_or_else(|| format!("no node {id}"))?;
          patch::apply(self.doc.get_mut(id).unwrap(), &p)?;
          components::record_override(&mut self.doc, id, &p);
          // The detach of a layer inside an instance is an override too (`bindings: {x: null}`).
          if let Some((_, gone)) = detached.iter().find(|(d, _)| d == id) {
            let unbound: serde_json::Map<String, Value> = gone.iter().map(|g| (g.clone(), Value::Null)).collect();
            components::record_override(&mut self.doc, id, &json!({ "bindings": unbound }));
          }
          let keys = before
            .text
            .as_ref()
            .filter(|t| !t.runs.is_empty())
            .map(|t| layer_run_keys(&p, t))
            .unwrap_or_default();
          if !keys.is_empty() {
            if let Some(tp) = self.doc.get_mut(id).and_then(|n| n.text.as_mut()) {
              let len = tp.characters.chars().count();
              tp.runs = crate::text::style_range(&tp.runs, len, 0, len, &crate::model::TextRun::default(), &keys);
              let runs = json!({ "text": { "runs": tp.runs } });
              components::record_override(&mut self.doc, id, &runs);
            }
          }
          drop_unsafe_links(self.doc.get_mut(id).unwrap());
          self.scale_group_to_patch(id, &before);
          let after = self.doc.get(id).unwrap().clone();
          if after.kind.is_frame_like() && (after.width != before.width || after.height != before.height) {
            layout::apply_constraints(&mut self.doc, id, before.width, before.height);
          }
          // Editing a linked layer's fill, stroke, effects or grids by hand detaches it (Styles, W3-C);
          // on an instance layer the unlink is an override too, so a main edit doesn't relink it.
          let mut unlinked = serde_json::Map::new();
          // A variable bound in the same patch replaces the style, unless the patch names one too.
          let binds = |prop: &str, style: &str| {
            p.get("bindings").and_then(|b| b.get(prop)).is_some_and(|v| v.is_string()) && !p.get(style).is_some_and(|v| v.is_string())
          };
          if after.fill_style.is_some() && (before.fills != after.fills || binds("fill", "fillStyle")) {
            self.doc.get_mut(id).unwrap().fill_style = None;
            unlinked.insert("fillStyle".into(), Value::Null);
          }
          if after.stroke_style.is_some() && (before.strokes != after.strokes || binds("stroke", "strokeStyle")) {
            self.doc.get_mut(id).unwrap().stroke_style = None;
            unlinked.insert("strokeStyle".into(), Value::Null);
          }
          if after.effect_style.is_some() && before.effects != after.effects {
            self.doc.get_mut(id).unwrap().effect_style = None;
            unlinked.insert("effectStyle".into(), Value::Null);
          }
          if after.grid_style.is_some() && before.layout_grids != after.layout_grids {
            self.doc.get_mut(id).unwrap().grid_style = None;
            unlinked.insert("gridStyle".into(), Value::Null);
          }
          if !unlinked.is_empty() {
            components::record_override(&mut self.doc, id, &Value::Object(unlinked));
          }
        }
        Ok(json!({}))
      }
      Command::SetText { id, characters } => {
        // A textarea reads line breaks as "\n": keep the stored text in the same form so the
        // editor's indices and the engine's agree.
        let characters = characters.replace("\r\n", "\n").replace('\r', "\n");
        let (old, runs) = self
          .doc
          .get(&id)
          .and_then(|n| n.text.as_ref())
          .map(|t| (t.characters.clone(), t.runs.clone()))
          .unwrap_or_default();
        let runs = crate::text::remap_runs(&old, &characters, &runs);
        let p = json!({ "text": { "characters": characters, "runs": runs } });
        let n = self.doc.get_mut(&id).ok_or("no such node")?;
        patch::apply(n, &p)?;
        // The name follows the text until the user renames the layer.
        let auto_name = |s: &str| -> String { s.trim_start().chars().take(40).collect() };
        let old_name: String = old.chars().take(40).collect();
        if n.name.is_empty() || n.name == "Text" || n.name == old_name || n.name == auto_name(&old) {
          n.name = auto_name(&characters);
        }
        components::record_override(&mut self.doc, &id, &p);
        Ok(json!({}))
      }
      Command::StyleText {
        id,
        start,
        end,
        style,
        clear,
      } => {
        let t = self.doc.get(&id).and_then(|n| n.text.clone()).ok_or("not a text layer")?;
        let len = t.characters.chars().count();
        let mut patch_run: crate::model::TextRun = serde_json::from_value(style).map_err(|e| format!("invalid text style: {e}"))?;
        if let Some(l) = patch_run.link.as_mut() {
          *l = crate::model::safe_link(l).ok_or("a link must start with http://, https://, mailto: or tel:")?;
        }
        if let Some(c) = patch_run.color.as_mut() {
          *c = crate::color::normalize(c);
        }
        let clear: Vec<&str> = clear.iter().map(|s| s.as_str()).collect();
        let runs = if start == 0 && end >= len && clear.is_empty() && patch_run.link.is_none() {
          // Whole text: fold the style into the base props instead of a run.
          let mut tp = t.clone();
          fold_into_base(&mut tp, &patch_run);
          let runs = crate::text::style_range(&t.runs, len, 0, len, &crate::model::TextRun::default(), &patch_keys(&patch_run));
          let p = json!({ "text": { "fontFamily": tp.font_family, "fontSize": tp.font_size, "fontWeight": tp.font_weight, "italic": tp.italic, "letterSpacing": tp.letter_spacing, "decoration": tp.decoration, "runs": runs } });
          let mut p = p;
          if let Some(c) = &patch_run.color {
            p["fills"] = json!([{ "type": "solid", "color": c }]);
          }
          patch::apply(self.doc.get_mut(&id).unwrap(), &p)?;
          components::record_override(&mut self.doc, &id, &p);
          return Ok(json!({}));
        } else {
          crate::text::style_range(&t.runs, len, start, end, &patch_run, &clear)
        };
        let p = json!({ "text": { "runs": runs } });
        patch::apply(self.doc.get_mut(&id).unwrap(), &p)?;
        components::record_override(&mut self.doc, &id, &p);
        Ok(json!({}))
      }
      Command::Delete { ids } => {
        let ids: Vec<NodeId> = ids.into_iter().filter(|i| self.doc.instance_ancestor(i).is_none()).collect();
        let parts = devices::parts_among(&self.doc, &ids);
        ops::delete(&mut self.doc, &ids);
        // Deleting a system UI part is turning it off in the Device section.
        for (frame, part) in parts {
          devices::turn_off(&mut self.doc, &mut self.gen, &frame, &part);
        }
        Ok(json!({}))
      }
      Command::Duplicate { ids } => {
        let ids: Vec<NodeId> = ids.into_iter().filter(|i| !devices::in_part(&self.doc, i)).collect();
        if ids.is_empty() {
          return Err("system UI can't be duplicated; turn it on or off in the Device section".into());
        }
        let created = ops::duplicate(&mut self.doc, &ids, &mut self.gen, Point::new(0.0, 0.0));
        // Offset only when it would land exactly on top of a page-level original.
        for (orig, new) in ids.iter().zip(created.iter()) {
          if self.doc.get(orig).map(|n| n.parent.is_none()).unwrap_or(false) {
            let w = self.doc.get(new).map(|n| n.width).unwrap_or(0.0);
            ops::move_by(&mut self.doc, std::slice::from_ref(new), w + 40.0, 0.0);
          }
        }
        self.selection = created.clone();
        Ok(json!({ "created": created }))
      }
      Command::Translate {
        ids,
        dx,
        dy,
        snap,
        zoom,
        axis,
      } => self.translate(&ids, dx, dy, snap, zoom, axis),
      Command::Nudge { ids, dx, dy } => {
        ops::move_by(&mut self.doc, &ids, dx, dy);
        Ok(json!({}))
      }
      Command::DropInto { ids, x, y } => {
        // Layer order, not selection order, so a bottom-up shift-selection lands as it was stacked.
        let ids = ops::paint_order(&self.doc, &ops::top_most(&self.doc, &ids));
        let pt = Point::new(x, y);
        let target = ops::frame_at(&self.doc, &self.page, pt, &ids, true);
        // One place for the whole drop, so several layers keep their order.
        let anchor = target.as_ref().and_then(|t| self.flow_slot(t, &ids, pt)).map(|s| s.anchor);
        for id in &ids {
          let Some(leaves_flow) = self.drop_move(id, target.as_deref(), pt) else {
            continue;
          };
          if leaves_flow {
            self.place_dragged(id);
          }
          // Dropping into auto layout inserts at the pointer position.
          let index = target.as_ref().zip(anchor.as_ref()).map(|(t, a)| self.anchor_index(t, id, a));
          self.doc.reparent(id, target.as_deref(), index, true);
          // Fill only means something in auto layout; outside it the layer keeps its size.
          if leaves_flow && index.is_none() {
            if let Some(n) = self.doc.get_mut(id) {
              for s in [&mut n.sizing_h, &mut n.sizing_v] {
                if *s == Sizing::Fill {
                  *s = Sizing::Fixed;
                }
              }
            }
          }
        }
        Ok(json!({ "parent": target }))
      }
      Command::MoveToParent { ids, parent, index } => {
        if let Some(p) = parent.as_deref() {
          let kind = self.doc.get(p).map(|n| n.kind).ok_or_else(|| format!("no parent layer {p}"))?;
          if !kind.is_container() {
            return Err(format!("{p} is a {} and cannot have children", kind.label()));
          }
        }
        if let Some(missing) = ids.iter().find(|id| self.doc.get(id).is_none()) {
          return Err(format!("no layer {missing}"));
        }
        if parent.as_deref().is_some_and(|p| devices::in_part(&self.doc, p)) {
          return Err("system UI of a device frame can't hold layers; use the device frame".into());
        }
        if ids.iter().any(|id| devices::in_part(&self.doc, id)) {
          return Err("system UI of a device frame can't be moved; turn it on or off in the Device section".into());
        }
        let ids = ops::paint_order(&self.doc, &ops::top_most(&self.doc, &ids));
        if components::would_nest_under(&self.doc, &ids, parent.as_deref()) {
          return Err("a component can't contain an instance of itself".into());
        }
        let mut idx = index;
        for id in ids.iter().rev() {
          let same_parent = self.doc.get(id).map(|n| n.parent == parent).unwrap_or(false);
          let cur_index = self.doc.index_in_parent(id);
          let target = match (idx, same_parent, cur_index) {
            (Some(i), true, Some(ci)) if ci < i => Some(i - 1),
            (i, _, _) => i,
          };
          self.doc.reparent(id, parent.as_deref(), target, true);
          if let Some(i) = idx.as_mut() {
            let _ = i;
          }
          idx = target;
        }
        Ok(json!({}))
      }
      Command::Resize {
        ids,
        handle,
        dx,
        dy,
        keep_aspect,
        from_center,
        snap,
        zoom,
        scale,
      } => {
        if scale {
          self.resize_scale(&ids, handle, dx, dy, from_center)
        } else {
          self.resize(&ids, handle, dx, dy, keep_aspect, from_center, snap, zoom)
        }
      }
      Command::Rotate {
        ids,
        angle,
        pivot_x,
        pivot_y,
      } => {
        ops::rotate(&mut self.doc, &ids, angle, Point::new(pivot_x, pivot_y));
        Ok(json!({}))
      }
      Command::BooleanOp { ids, operation: op } => {
        let ids = ops::paint_order(&self.doc, &ops::top_most(&self.doc, &ids));
        if ids.len() < 2 {
          return Err("select at least two layers".into());
        }
        let shapes: Vec<Vec<Vec<[f64; 2]>>> = ids
          .iter()
          .map(|id| crate::paths::to_contours(&crate::paths::page_outline(&self.doc, id)).0)
          .collect();
        if shapes.iter().any(|s| s.is_empty()) {
          return Err("boolean operations need closed shapes (text and lines can't be combined)".into());
        }
        let result = crate::paths::boolean(&shapes, op);
        if result.is_empty() {
          return Err("the result is empty".into());
        }
        let name = match op {
          crate::paths::BoolOp::Union => "Union",
          crate::paths::BoolOp::Subtract => "Subtract",
          crate::paths::BoolOp::Intersect => "Intersect",
          crate::paths::BoolOp::Exclude => "Exclude",
        };
        let id = self.replace_with_vector(&ids, crate::paths::contours_to_subpaths(&result), name)?;
        Ok(json!({ "id": id }))
      }
      Command::Flatten { ids } => {
        let ids = ops::paint_order(&self.doc, &ops::top_most(&self.doc, &ids));
        let sps: Vec<SubPath> = ids.iter().flat_map(|id| crate::paths::page_outline(&self.doc, id)).collect();
        if sps.is_empty() {
          return Err("nothing to flatten (text can't be flattened yet)".into());
        }
        let name = if ids.len() == 1 {
          self.doc.get(&ids[0]).map(|n| n.name.clone()).unwrap_or_default()
        } else {
          "Vector".into()
        };
        let id = self.replace_with_vector(&ids, sps, &name)?;
        Ok(json!({ "id": id }))
      }
      Command::OutlineStroke { ids } => {
        let mut created = Vec::new();
        for id in ops::top_most(&self.doc, &ids) {
          let Some(n) = self.doc.get(&id).cloned() else { continue };
          let strokes: Vec<Paint> = n.strokes.iter().filter(|p| p.visible()).cloned().collect();
          if strokes.is_empty() || n.stroke_weight <= 0.0 || n.kind == NodeType::Group {
            continue;
          }
          let outline = crate::paths::page_outline(&self.doc, &id);
          let ring = crate::paths::stroke_outline(&n, &outline);
          if ring.is_empty() {
            continue;
          }
          let mut style = n.clone();
          style.fills = strokes;
          style.strokes.clear();
          // The new shape is filled with the stroke's colour, so it takes over the stroke's style link.
          style.fill_style = style.stroke_style.take();
          let keep = n.fills.iter().any(|p| p.visible());
          let new_id = self.insert_vector(
            &style,
            crate::paths::contours_to_subpaths(&ring),
            n.parent.clone(),
            self.doc.index_in_parent(&id).map(|i| i + 1),
            &n.name,
          );
          if keep {
            if let Some(m) = self.doc.get_mut(&id) {
              m.strokes.clear();
              m.stroke_style = None;
            }
          } else {
            ops::delete(&mut self.doc, std::slice::from_ref(&id));
          }
          created.push(new_id);
        }
        if created.is_empty() {
          return Err("select layers with a visible stroke".into());
        }
        self.selection = created.clone();
        Ok(json!({ "ids": created }))
      }
      Command::UseAsMask { ids } => {
        let ids = ops::paint_order(&self.doc, &ops::top_most(&self.doc, &ids));
        match ids.len() {
          0 => Err("nothing selected".into()),
          1 => {
            let n = self.doc.get_mut(&ids[0]).ok_or("no such layer")?;
            n.is_mask = !n.is_mask;
            Ok(json!({ "id": ids[0], "isMask": n.is_mask }))
          }
          _ => {
            let group = ops::group(&mut self.doc, &ids, &mut self.gen).ok_or("could not group the selection")?;
            if let Some(g) = self.doc.get_mut(&group) {
              g.name = "Mask group".into();
            }
            if let Some(m) = self.doc.get_mut(&ids[0]) {
              m.is_mask = true;
            }
            self.selection = vec![group.clone()];
            Ok(json!({ "id": group }))
          }
        }
      }
      Command::Group { ids } => {
        let id = ops::group(&mut self.doc, &ids, &mut self.gen).ok_or("nothing to group")?;
        self.selection = vec![id.clone()];
        Ok(json!({ "id": id }))
      }
      Command::Ungroup { ids } => {
        let mut sel = Vec::new();
        for id in ids {
          sel.extend(ops::ungroup(&mut self.doc, &id));
        }
        self.selection = sel;
        Ok(json!({}))
      }
      Command::FrameSelection { ids } => {
        let id = ops::wrap_in_frame(&mut self.doc, &ids, &mut self.gen, NodeType::Frame).ok_or("nothing to frame")?;
        if let Some(n) = self.doc.get_mut(&id) {
          n.fills.clear();
        }
        self.selection = vec![id.clone()];
        Ok(json!({ "id": id }))
      }
      Command::AddAutoLayout { ids } => {
        let target = if ids.len() == 1 && self.doc.get(&ids[0]).map(|n| n.kind.is_frame_like()).unwrap_or(false) {
          ids[0].clone()
        } else {
          let id = ops::wrap_in_frame(&mut self.doc, &ids, &mut self.gen, NodeType::Frame).ok_or("nothing selected")?;
          if let Some(n) = self.doc.get_mut(&id) {
            n.fills.clear();
          }
          id
        };
        let horizontal = self.infer_direction(&target);
        // Hugging nothing collapses the frame to its padding: an empty frame keeps its size.
        let in_flow = self
          .doc
          .get(&target)
          .map(|n| n.children.clone())
          .unwrap_or_default()
          .iter()
          .any(|c| self.doc.get(c).is_some_and(|c| c.visible && !c.absolute_position));
        let n = self.doc.get_mut(&target).ok_or("missing")?;
        n.layout = Some(AutoLayout {
          direction: if horizontal {
            LayoutDirection::Horizontal
          } else {
            LayoutDirection::Vertical
          },
          ..Default::default()
        });
        if in_flow {
          n.sizing_h = Sizing::Hug;
          n.sizing_v = Sizing::Hug;
        }
        // A screen keeps its device size, takes the safe area as padding and its chrome leaves the flow.
        devices::refresh(&mut self.doc, &mut self.gen, &target);
        self.selection = vec![target.clone()];
        Ok(json!({ "id": target }))
      }
      Command::SetDevice { id, device, resize } => {
        devices::apply(&mut self.doc, &mut self.gen, &id, device, resize)?;
        Ok(json!({}))
      }
      Command::RemoveAutoLayout { ids } => {
        for id in ids {
          // Fill and hug only mean something inside auto layout: children keep the size they
          // have as fixed. The frame itself keeps Fill when its own parent is auto layout.
          let in_flow = self
            .doc
            .get(&id)
            .and_then(|n| n.parent.as_ref())
            .and_then(|p| self.doc.get(p))
            .map(|p| p.layout.is_some())
            .unwrap_or(false);
          let children = self.doc.get(&id).map(|n| n.children.clone()).unwrap_or_default();
          for c in children {
            if let Some(cn) = self.doc.get_mut(&c) {
              if cn.sizing_h == Sizing::Fill {
                cn.sizing_h = Sizing::Fixed;
              }
              if cn.sizing_v == Sizing::Fill {
                cn.sizing_v = Sizing::Fixed;
              }
            }
          }
          if let Some(n) = self.doc.get_mut(&id) {
            n.layout = None;
            if n.sizing_h != Sizing::Fill || !in_flow {
              n.sizing_h = Sizing::Fixed;
            }
            if n.sizing_v != Sizing::Fill || !in_flow {
              n.sizing_v = Sizing::Fixed;
            }
          }
          // The safe area leaves the padding, and the chrome stops being absolute.
          devices::refresh(&mut self.doc, &mut self.gen, &id);
        }
        Ok(json!({}))
      }
      Command::CreateComponent { ids } => {
        let already = ids.len() == 1
          && self
            .doc
            .get(&ids[0])
            .is_some_and(|n| matches!(n.kind, NodeType::Component | NodeType::ComponentSet));
        if let (false, Some(inner)) = (already, components::main_inside(&self.doc, &ids)) {
          return Err(format!(
            "'{inner}' is a main component inside the selection; a component can't contain another main component"
          ));
        }
        let id = components::create_component(&mut self.doc, &ids, &mut self.gen).ok_or("select a frame, group or layers")?;
        self.selection = vec![id.clone()];
        Ok(json!({ "id": id }))
      }
      Command::CreateComponents { ids } => {
        let mut made = Vec::new();
        for id in &ids {
          // Main components and sets are skipped: they are components already.
          if self
            .doc
            .get(id)
            .is_none_or(|n| matches!(n.kind, NodeType::Component | NodeType::ComponentSet))
          {
            continue;
          }
          if components::main_inside(&self.doc, std::slice::from_ref(id)).is_some() {
            continue;
          }
          if let Some(c) = components::create_component(&mut self.doc, std::slice::from_ref(id), &mut self.gen) {
            made.push(c);
          }
        }
        if made.is_empty() {
          return Err("select layers to turn into components".into());
        }
        self.selection = made.clone();
        Ok(json!({ "ids": made }))
      }
      Command::CombineVariants { ids } => {
        let id = components::combine_as_variants(&mut self.doc, &ids, &mut self.gen).ok_or("select two or more components")?;
        self.selection = vec![id.clone()];
        Ok(json!({ "id": id }))
      }
      Command::CreateInstance {
        component_id,
        x,
        y,
        parent,
        anchor,
        into_components,
      } => {
        if self.doc.get(&component_id).map(|c| c.kind == NodeType::Component) != Some(true) {
          return Err("not a component".into());
        }
        let explicit = parent.filter(|p| self.doc.nodes.contains_key(p));
        let anchor = anchor.unwrap_or(Point::new(x, y));
        let auto = explicit.is_none();
        let chosen = explicit.or_else(|| ops::frame_at(&self.doc, &self.page, anchor, &[], into_components));
        let page = self.page.clone();
        let place = |e: &mut Self, parent: Option<&str>| {
          let l = match parent {
            Some(p) => e.doc.abs_matrix(p).invert().apply(Point::new(x, y)),
            None => Point::new(x, y),
          };
          components::create_instance(&mut e.doc, &component_id, parent, &page, l.x, l.y, &mut e.gen)
        };
        let mut made = place(self, chosen.as_deref());
        if made.is_none() && auto && chosen.is_some() {
          // The frame under the anchor can't hold this instance (it is inside the component's
          // own main): place it on the page instead of failing.
          made = place(self, None);
        }
        let id = made.ok_or("a component can't contain an instance of itself")?;
        self.selection = vec![id.clone()];
        Ok(json!({ "id": id }))
      }
      Command::DetachInstance { ids } => {
        for id in ids {
          components::detach_instance(&mut self.doc, &id);
        }
        Ok(json!({}))
      }
      Command::ResetInstance { ids } => {
        for id in ids {
          components::reset_overrides(&mut self.doc, &id, &mut self.gen);
        }
        Ok(json!({}))
      }
      Command::ResetOverrideGroups { ids, groups } => {
        let mut changed = false;
        for id in ids {
          changed |= components::reset_override_groups(&mut self.doc, &id, &groups, &mut self.gen);
        }
        Ok(json!({ "changed": changed }))
      }
      Command::RestoreComponent { id } => {
        let comp = components::restore_component(&mut self.doc, &id, &mut self.gen)?;
        self.selection = vec![comp.clone()];
        Ok(json!({ "id": comp }))
      }
      Command::SwapComponent { id, component_id } => {
        components::swap_component(&mut self.doc, &id, &component_id, &mut self.gen);
        Ok(json!({}))
      }
      Command::ComponentProps { edit } => crate::props::apply_op(&mut self.doc, &mut self.gen, edit),
      Command::SetVariant { id, prop, value } => {
        let comp = self
          .doc
          .get(&id)
          .and_then(|n| n.instance.as_ref())
          .map(|i| i.component_id.clone())
          .ok_or("not an instance")?;
        let target = components::find_variant(&self.doc, &comp, &prop, &value).ok_or("no matching variant")?;
        components::swap_component(&mut self.doc, &id, &target, &mut self.gen);
        Ok(json!({}))
      }
      Command::Align { ids, how } => {
        ops::align(&mut self.doc, &ids, how);
        Ok(json!({}))
      }
      Command::Distribute { ids, horizontal } => {
        ops::distribute(&mut self.doc, &ids, horizontal);
        Ok(json!({}))
      }
      Command::Reorder { ids, to } => {
        ops::reorder(&mut self.doc, &ids, to);
        Ok(json!({}))
      }
      Command::Flip { ids, horizontal } => {
        ops::flip(&mut self.doc, &ids, horizontal);
        Ok(json!({}))
      }
      Command::AddInteraction { id, interaction } => {
        self.doc.get_mut(&id).ok_or("no such node")?.interactions.push(interaction);
        Ok(json!({}))
      }
      Command::SetInteractions { id, interactions } => {
        self.doc.get_mut(&id).ok_or("no such node")?.interactions = interactions;
        Ok(json!({}))
      }
      Command::SetFlowStart { page, id } => {
        if let Some(start) = &id {
          let n = self.doc.get(start).ok_or("no such node")?;
          if n.parent.is_some() || n.page != page || !matches!(n.kind, NodeType::Frame | NodeType::Component) {
            return Err("a flow can only start on a top-level frame".into());
          }
        }
        self.doc.page_mut(&page).ok_or("no such page")?.flow_start = id;
        Ok(json!({}))
      }
      Command::AddColorStyle { name, color } => {
        let id = self.gen.next("s_");
        self.doc.styles.colors.push(ColorStyle {
          id: id.clone(),
          name,
          color: crate::color::normalize(&color),
        });
        Ok(json!({ "id": id }))
      }
      Command::AddTextStyle { name, from } => {
        let t = self.doc.get(&from).and_then(|n| n.text.clone()).ok_or("select a text layer")?;
        let id = self.gen.next("s_");
        self.doc.styles.texts.push(TextStyle {
          id: id.clone(),
          name,
          font_family: t.font_family,
          font_size: t.font_size,
          font_weight: t.font_weight,
          line_height: t.line_height,
          letter_spacing: t.letter_spacing,
        });
        if let Some(n) = self.doc.get_mut(&from) {
          n.text_style = Some(id.clone());
        }
        Ok(json!({ "id": id }))
      }
      Command::UpdateColorStyle { id, name, color } => {
        let style = self.doc.styles.colors.iter_mut().find(|s| s.id == id).ok_or("no such style")?;
        if let Some(n) = name {
          style.name = n;
        }
        if let Some(c) = color {
          style.color = crate::color::normalize(&c);
        }
        let color = style.color.clone();
        self.doc.update_where(
          |n| n.fill_style.as_deref() == Some(id.as_str()),
          |n| n.fills = vec![Paint::solid(&color)],
        );
        self
          .doc
          .update_where(|n| n.stroke_style.as_deref() == Some(id.as_str()), |n| recolor_stroke(n, &color));
        Ok(json!({}))
      }
      Command::AddEffectStyle { name, from, description } => {
        let effects = self.doc.get(&from).map(|n| n.effects.clone()).ok_or("no such node")?;
        if effects.is_empty() {
          return Err("the layer has no effects to save as a style".into());
        }
        let id = self.gen.next("s_");
        self.doc.styles.effects.push(EffectStyle {
          id: id.clone(),
          name,
          effects,
          description,
        });
        self.doc.get_mut(&from).unwrap().effect_style = Some(id.clone());
        Ok(json!({ "id": id }))
      }
      Command::AddGridStyle { name, from, description } => {
        let grids = self.doc.get(&from).map(|n| n.layout_grids.clone()).ok_or("no such node")?;
        if grids.is_empty() {
          return Err("the layer has no layout grids to save as a style".into());
        }
        let id = self.gen.next("s_");
        self.doc.styles.grids.push(GridStyle {
          id: id.clone(),
          name,
          grids,
          description,
        });
        self.doc.get_mut(&from).unwrap().grid_style = Some(id.clone());
        Ok(json!({ "id": id }))
      }
      Command::UpdateEffectStyle {
        id,
        name,
        effects,
        description,
      } => {
        let style = self.doc.styles.effects.iter_mut().find(|s| s.id == id).ok_or("no such style")?;
        if let Some(v) = name {
          style.name = v;
        }
        if let Some(v) = effects {
          style.effects = v;
        }
        if let Some(v) = description {
          style.description = v;
        }
        let effects = style.effects.clone();
        self
          .doc
          .update_where(|n| n.effect_style.as_deref() == Some(id.as_str()), |n| n.effects = effects.clone());
        Ok(json!({}))
      }
      Command::UpdateGridStyle {
        id,
        name,
        grids,
        description,
      } => {
        let style = self.doc.styles.grids.iter_mut().find(|s| s.id == id).ok_or("no such style")?;
        if let Some(v) = name {
          style.name = v;
        }
        if let Some(v) = grids {
          style.grids = v;
        }
        if let Some(v) = description {
          style.description = v;
        }
        let grids = style.grids.clone();
        self
          .doc
          .update_where(|n| n.grid_style.as_deref() == Some(id.as_str()), |n| n.layout_grids = grids.clone());
        Ok(json!({}))
      }
      Command::DeleteStyle { id } => {
        self.doc.styles.colors.retain(|s| s.id != id);
        self.doc.styles.texts.retain(|s| s.id != id);
        self.doc.styles.effects.retain(|s| s.id != id);
        self.doc.styles.grids.retain(|s| s.id != id);
        let is = |l: &Option<String>| l.as_deref() == Some(id.as_str());
        let uses = |n: &Node| is(&n.fill_style) || is(&n.text_style) || is(&n.stroke_style) || is(&n.effect_style) || is(&n.grid_style);
        self.doc.update_where(uses, |n| {
          for l in [
            &mut n.fill_style,
            &mut n.text_style,
            &mut n.stroke_style,
            &mut n.effect_style,
            &mut n.grid_style,
          ] {
            if l.as_deref() == Some(id.as_str()) {
              *l = None;
            }
          }
        });
        Ok(json!({}))
      }
      Command::DetachStyle { ids, style_id, kind } => {
        let stroke = kind.as_deref() == Some("stroke");
        for id in &ids {
          let Some(n) = self.doc.get_mut(id) else { continue };
          for (link, is_stroke_link) in [
            (&mut n.fill_style, false),
            (&mut n.text_style, false),
            (&mut n.effect_style, false),
            (&mut n.grid_style, false),
            (&mut n.stroke_style, true),
          ] {
            // The same colour style can be linked as fill and as stroke: `kind` picks one.
            if link.as_deref() == Some(style_id.as_str()) && (kind.is_none() || stroke == is_stroke_link) {
              *link = None;
            }
          }
        }
        Ok(json!({}))
      }
      Command::UpdateTextStyle {
        id,
        name,
        font_family,
        font_size,
        font_weight,
        line_height,
        auto_line_height,
        letter_spacing,
      } => {
        let style = self.doc.styles.texts.iter_mut().find(|s| s.id == id).ok_or("no such style")?;
        if let Some(v) = name {
          style.name = v;
        }
        if let Some(v) = font_family {
          style.font_family = v;
        }
        if let Some(v) = font_size {
          style.font_size = v.max(1.0);
        }
        if let Some(v) = font_weight {
          style.font_weight = v;
        }
        if auto_line_height {
          style.line_height = None;
        } else if let Some(v) = line_height {
          style.line_height = Some(v);
        }
        if let Some(v) = letter_spacing {
          style.letter_spacing = v;
        }
        let t = style.clone();
        self.doc.update_where(
          |n| n.text_style.as_deref() == Some(id.as_str()),
          |n| {
            if let Some(tp) = n.text.as_mut() {
              tp.font_family = t.font_family.clone();
              tp.font_size = t.font_size;
              tp.font_weight = t.font_weight;
              tp.line_height = t.line_height;
              tp.letter_spacing = t.letter_spacing;
            }
          },
        );
        Ok(json!({}))
      }
      Command::ApplyStyle { ids, style_id, kind } => {
        // What each layer got, recorded as an override when it lives in an instance.
        let mut applied: Vec<(NodeId, Value)> = Vec::new();
        if let Some(c) = self.doc.styles.colors.iter().find(|s| s.id == style_id).cloned() {
          let stroke = kind.as_deref() == Some("stroke");
          for id in &ids {
            if let Some(n) = self.doc.get_mut(id) {
              // One source per paint: a style replaces the variable bound to the same fill or stroke.
              let prop = if stroke { "stroke" } else { "fill" };
              let was_bound = n.bindings.remove(prop).is_some();
              let mut rec = if stroke {
                set_stroke_color(n, &c.color);
                n.stroke_style = Some(style_id.clone());
                json!({ "strokes": n.strokes, "strokeWeight": n.stroke_weight, "strokeStyle": style_id })
              } else {
                n.fills = vec![Paint::solid(&c.color)];
                n.fill_style = Some(style_id.clone());
                json!({ "fills": n.fills, "fillStyle": style_id })
              };
              if let (Some(m), true) = (rec.as_object_mut(), was_bound) {
                m.insert("bindings".into(), json!({ prop: null }));
              }
              applied.push((id.clone(), rec));
            }
          }
        } else if let Some(e) = self.doc.styles.effects.iter().find(|s| s.id == style_id).cloned() {
          for id in &ids {
            if let Some(n) = self.doc.get_mut(id) {
              n.effects = e.effects.clone();
              n.effect_style = Some(style_id.clone());
              applied.push((id.clone(), json!({ "effects": n.effects, "effectStyle": style_id })));
            }
          }
        } else if let Some(g) = self.doc.styles.grids.iter().find(|s| s.id == style_id).cloned() {
          for id in &ids {
            if let Some(n) = self.doc.get_mut(id).filter(|n| n.kind.is_frame_like()) {
              n.layout_grids = g.grids.clone();
              n.grid_style = Some(style_id.clone());
              applied.push((id.clone(), json!({ "layoutGrids": n.layout_grids, "gridStyle": style_id })));
            }
          }
        } else if let Some(t) = self.doc.styles.texts.iter().find(|s| s.id == style_id).cloned() {
          for id in &ids {
            if let Some(tp) = self.doc.get_mut(id).and_then(|n| n.text.as_mut()) {
              tp.font_family = t.font_family.clone();
              tp.font_size = t.font_size;
              tp.font_weight = t.font_weight;
              tp.line_height = t.line_height;
              tp.letter_spacing = t.letter_spacing;
            }
            if let Some(n) = self.doc.get_mut(id) {
              n.text_style = Some(style_id.clone());
              if let Some(tp) = &n.text {
                let text = json!({ "fontFamily": tp.font_family, "fontSize": tp.font_size, "fontWeight": tp.font_weight, "lineHeight": tp.line_height, "letterSpacing": tp.letter_spacing });
                applied.push((id.clone(), json!({ "text": text, "textStyle": style_id })));
              }
            }
          }
        } else {
          return Err("no such style".into());
        }
        for (id, p) in &applied {
          components::record_override(&mut self.doc, id, p);
        }
        Ok(json!({}))
      }
      Command::Ai { tool, input } => ai::execute(self, &tool, &input),
      // Handled in dispatch.
      Command::Relayout
      | Command::Undo
      | Command::Redo
      | Command::SetHistoryGroup { .. }
      | Command::BeginGesture
      | Command::RebaseGesture
      | Command::EndGesture
      | Command::CancelGesture
      | Command::Select { .. }
      | Command::SelectAll
      | Command::ApplyRemote { .. }
      | Command::CollabAck { .. }
      | Command::SetPage { .. }
      | Command::SetReadOnly { .. } => Ok(json!({})),
    }
  }

  fn infer_direction(&self, id: &str) -> bool {
    let Some(n) = self.doc.get(id) else { return false };
    let rects: Vec<Rect> = n
      .children
      .iter()
      .filter_map(|c| self.doc.get(c))
      .map(|c| Rect::new(c.x, c.y, c.width, c.height))
      .collect();
    if rects.len() < 2 {
      return false;
    }
    let spread_x = rects.iter().map(|r| r.center().x).fold(f64::NEG_INFINITY, f64::max)
      - rects.iter().map(|r| r.center().x).fold(f64::INFINITY, f64::min);
    let spread_y = rects.iter().map(|r| r.center().y).fold(f64::NEG_INFINITY, f64::max)
      - rects.iter().map(|r| r.center().y).fold(f64::INFINITY, f64::min);
    spread_x > spread_y
  }

  fn translate(&mut self, ids: &[NodeId], dx: f64, dy: f64, snap: bool, zoom: f64, axis: Option<Axis>) -> Result<Value, String> {
    let (dx, dy) = match axis {
      Some(Axis::X) => (dx, 0.0),
      Some(Axis::Y) => (0.0, dy),
      None => (dx, dy),
    };
    let ids = ops::top_most(&self.doc, ids);
    // Children flowing in auto layout reorder instead of moving freely.
    let (flow, free): (Vec<NodeId>, Vec<NodeId>) = ids.iter().cloned().partition(|id| self.in_auto_layout_flow(id));
    for id in &flow {
      self.reorder_in_flow(id, dx, dy);
    }
    self.drag_delta = Some(Point::new(dx, dy));
    let mut guides = Vec::new();
    let mut gaps = Vec::new();
    let (mut fdx, mut fdy) = (dx, dy);
    if snap && !free.is_empty() {
      let s = interact::snap_move_on(&self.doc, &self.page, &free, dx, dy, zoom, axis);
      fdx = s.dx;
      fdy = s.dy;
      guides = s.guides;
      gaps = s.gaps;
    }
    ops::move_by(&mut self.doc, &free, fdx, fdy);
    Ok(json!({ "dx": fdx, "dy": fdy, "guides": guides, "gaps": gaps }))
  }

  /// A group's size is its children's bounds, so typing a new W or H scales the children like
  /// the resize handles do (`before` is the group as it was ahead of the patch). Inside an
  /// instance each scaled child is recorded as an override, so a main component sync keeps it.
  fn scale_group_to_patch(&mut self, id: &str, before: &Node) {
    let Some(now) = self.doc.get(id) else { return };
    if before.kind != NodeType::Group || (now.width == before.width && now.height == before.height) {
      return;
    }
    let (cw, ch) = (now.width != before.width, now.height != before.height);
    let w = if cw { now.width.max(1.0) } else { before.width };
    let h = if ch { now.height.max(1.0) } else { before.height };
    let (x, y) = (now.x, now.y);
    interact::set_geometry(&mut self.doc, before, x, y, w, h, cw, ch);
    if self.doc.instance_ancestor(id).is_none() {
      return;
    }
    for d in self.doc.subtree(id).into_iter().skip(1) {
      let Some(n) = self.doc.get(&d) else { continue };
      let p = json!({ "x": n.x, "y": n.y, "width": n.width, "height": n.height });
      components::record_override(&mut self.doc, &d, &p);
    }
  }

  /// Whether `id` is positioned by its parent's auto layout (not absolutely placed).
  fn in_auto_layout_flow(&self, id: &str) -> bool {
    let Some(n) = self.doc.get(id) else { return false };
    !n.absolute_position && n.parent.as_ref().and_then(|p| self.doc.get(p)).is_some_and(|p| p.layout.is_some())
  }

  /// Insertion slot in an auto layout frame for a page-space point, ignoring the layers in
  /// `exclude` (the ones being placed): the index among the frame's children and the line to show.
  /// A wrapping frame picks the row under the pointer first, then the place inside the row.
  fn flow_slot(&self, frame: &str, exclude: &[NodeId], p: Point) -> Option<FlowSlot> {
    let f = self.doc.get(frame)?;
    let layout = f.layout.as_ref()?;
    let horizontal = layout.direction == LayoutDirection::Horizontal;
    let kids: Vec<&NodeId> = f.children.iter().filter(|c| !exclude.contains(c)).collect();
    let flow: Vec<(usize, Rect)> = kids
      .iter()
      .enumerate()
      .filter(|(_, c)| self.doc.get(c).is_some_and(|n| n.visible && !n.absolute_position))
      .map(|(i, c)| (i, self.doc.abs_bounds(c)))
      .collect();
    let frame_box = self.doc.abs_bounds(frame);
    let inner = Rect::new(
      frame_box.x + layout.padding_left,
      frame_box.y + layout.padding_top,
      (frame_box.width - layout.padding_left - layout.padding_right).max(0.0),
      (frame_box.height - layout.padding_top - layout.padding_bottom).max(0.0),
    );
    // Rows as indices into `flow`. Only a wrapping frame has more than one: a row starts when a
    // layer is not to the right of the one before it, or is below the row so far. Any other
    // layout is a single run (along x for a row, along y for a column).
    let wraps = layout.wrap && horizontal;
    let mut rows: Vec<Vec<usize>> = Vec::new();
    let mut row_bottom = f64::NEG_INFINITY;
    for k in 0..flow.len() {
      let r = &flow[k].1;
      let new_row = wraps && k > 0 && (r.x <= flow[k - 1].1.x || r.y >= row_bottom - 0.01);
      if rows.is_empty() || new_row {
        rows.push(Vec::new());
        row_bottom = f64::NEG_INFINITY;
      }
      rows.last_mut().unwrap().push(k);
      row_bottom = row_bottom.max(r.y + r.height);
    }
    let main_of = |r: &Rect| if horizontal { (r.x, r.x + r.width) } else { (r.y, r.y + r.height) };
    let span_of = |row: &[usize]| {
      let top = row.iter().map(|&k| flow[k].1.y).fold(f64::INFINITY, f64::min);
      let bottom = row
        .iter()
        .map(|&k| flow[k].1.y + flow[k].1.height)
        .fold(f64::NEG_INFINITY, f64::max);
      (top, bottom)
    };
    // The nearest row by y, then the place in it by x.
    let row = if rows.len() > 1 {
      let dist = |r: &[usize]| {
        let (t, b) = span_of(r);
        (t - p.y).max(p.y - b).max(0.0)
      };
      (0..rows.len())
        .min_by(|&a, &b| dist(&rows[a]).total_cmp(&dist(&rows[b])))
        .unwrap_or(0)
    } else {
      0
    };
    let pos = if horizontal { p.x } else { p.y };
    let members: &[usize] = rows.get(row).map(|r| r.as_slice()).unwrap_or(&[]);
    let in_row = members
      .iter()
      .filter(|&&k| {
        let (a, b) = main_of(&flow[k].1);
        (a + b) / 2.0 < pos
      })
      .count();
    let slot = rows.iter().take(row).map(|r| r.len()).sum::<usize>() + in_row;
    // Index among the children: in front of the flow child that follows, else behind the last.
    let index = match flow.get(slot) {
      Some((i, _)) => *i,
      None => flow.last().map(|(i, _)| i + 1).unwrap_or(kids.len()),
    };
    let anchor = flow.get(slot).map(|(i, _)| kids[*i].clone());
    // The line sits halfway between the neighbours inside the row, or half a gap outside them.
    let half_gap = layout.gap / 2.0;
    let prev = (in_row > 0).then(|| main_of(&flow[members[in_row - 1]].1).1);
    let next = members.get(in_row).map(|&k| main_of(&flow[k].1).0);
    let at = match (prev, next) {
      (Some(a), Some(b)) => (a + b) / 2.0,
      (None, Some(b)) => b - half_gap,
      (Some(a), None) => a + half_gap,
      (None, None) if horizontal => inner.x,
      (None, None) => inner.y,
    };
    let (lo, hi) = if horizontal && !members.is_empty() {
      span_of(members)
    } else if horizontal {
      (inner.y, inner.y + inner.height)
    } else {
      (inner.x, inner.x + inner.width)
    };
    let line = if horizontal { [at, lo, at, hi] } else { [lo, at, hi, at] };
    Some(FlowSlot { index, anchor, line })
  }

  /// The auto layout frame a drop of `ids` at `p` would insert them into, with the slot.
  fn drop_slot(&self, ids: &[NodeId], p: Point) -> Option<Value> {
    let ids = ops::top_most(&self.doc, ids);
    let target = ops::frame_at(&self.doc, &self.page, p, &ids, true)?;
    // Layers placed absolutely don't take a place in the flow.
    let enters = ids
      .iter()
      .any(|id| self.doc.get(id).is_some_and(|n| !n.absolute_position) && self.drop_move(id, Some(&target), p).is_some());
    if !enters {
      return None;
    }
    let slot = self.flow_slot(&target, &ids, p)?;
    Some(json!({ "frame": target, "index": slot.index, "line": slot.line }))
  }

  /// What `DropInto` does with `id` for a drop at `p` on `target`: `None` leaves it where it is,
  /// `Some(leaves_flow)` moves it into `target` (`leaves_flow`: out of its auto layout parent).
  fn drop_move(&self, id: &str, target: Option<&str>, p: Point) -> Option<bool> {
    let n = self.doc.get(id)?;
    if self.doc.instance_ancestor(id).is_some()
      || devices::in_part(&self.doc, id)
      || components::would_nest_under(&self.doc, std::slice::from_ref(&id.to_string()), target)
    {
      return None;
    }
    let cur = n.parent.as_deref();
    let cur_node = cur.and_then(|c| self.doc.get(c));
    let in_flow = cur_node.is_some_and(|c| c.layout.is_some()) && !n.absolute_position;
    // Inside its auto layout parent a drag reorders; dropped outside, the layer leaves.
    let leaves_flow = in_flow && cur.is_some_and(|c| !self.contains_point(c, p));
    let moves = cur != target && (!in_flow || leaves_flow) && cur_node.is_none_or(|c| c.kind != NodeType::Group);
    moves.then_some(leaves_flow)
  }

  /// Child index in `frame` (once `id` is out of it) for a layer going in front of `anchor`.
  fn anchor_index(&self, frame: &str, id: &str, anchor: &Option<NodeId>) -> usize {
    let kids: Vec<&NodeId> = self
      .doc
      .get(frame)
      .map(|f| f.children.iter().filter(|c| *c != id).collect())
      .unwrap_or_default();
    match anchor {
      Some(a) => kids.iter().position(|c| *c == a).unwrap_or(kids.len()),
      None => kids.len(),
    }
  }

  /// True when a page-space point lies inside a node's (possibly rotated) box.
  fn contains_point(&self, id: &str, p: Point) -> bool {
    let Some(n) = self.doc.get(id) else { return false };
    let l = self.doc.abs_matrix(id).invert().apply(p);
    l.x >= 0.0 && l.y >= 0.0 && l.x <= n.width && l.y <= n.height
  }

  /// Moves an auto layout child (which only reordered while dragged) to where the
  /// open gesture's drag would have put it, so it can leave the flow in place.
  fn place_dragged(&mut self, id: &str) {
    let (Some(base), Some(d)) = (self.gesture.as_ref(), self.drag_delta) else {
      return;
    };
    if base.doc.get(id).is_none() {
      return;
    }
    let from = base.doc.abs_matrix(id).apply(Point::new(0.0, 0.0));
    let now = self.doc.abs_matrix(id).apply(Point::new(0.0, 0.0));
    ops::move_by(&mut self.doc, &[id.to_string()], from.x + d.x - now.x, from.y + d.y - now.y);
  }

  fn reorder_in_flow(&mut self, id: &str, dx: f64, dy: f64) {
    let Some(n) = self.doc.get(id) else { return };
    let Some(parent) = n.parent.clone() else { return };
    let c = self.doc.abs_bounds(id).center();
    let Some(slot) = self.flow_slot(&parent, &[id.to_string()], Point::new(c.x + dx, c.y + dy)) else {
      return;
    };
    let index = self.anchor_index(&parent, id, &slot.anchor);
    self.doc.reparent(id, Some(&parent), Some(index), false);
  }

  #[allow(clippy::too_many_arguments)]
  fn resize(
    &mut self,
    ids: &[NodeId],
    handle: Handle,
    dx: f64,
    dy: f64,
    keep_aspect: bool,
    from_center: bool,
    snap: bool,
    zoom: f64,
  ) -> Result<Value, String> {
    let ids = ops::top_most(&self.doc, ids);
    let mut guides = Vec::new();
    let mut gaps = Vec::new();
    let (mut dx, mut dy) = (dx, dy);
    let (fx, fy) = handle.factors();
    // Snap the moving edges of the axis-aligned selection box.
    let single_rotated = ids.len() == 1 && self.doc.get(&ids[0]).map(|n| n.rotation != 0.0).unwrap_or(false);
    let from = self.doc.bounds_of_many(&ids).ok_or("nothing selected")?;
    if snap && !single_rotated {
      let mut r = from;
      if fx < 0.0 {
        r.x += dx;
        r.width -= dx;
      } else if fx > 0.0 {
        r.width += dx;
      }
      if fy < 0.0 {
        r.y += dy;
        r.height -= dy;
      } else if fy > 0.0 {
        r.height += dy;
      }
      let edges = [fx < 0.0, fx > 0.0, fy < 0.0, fy > 0.0];
      // Equal gaps only for free layers resized from an edge: not auto layout children (the
      // layout decides their gaps), nor from the centre or with the aspect locked.
      let in_flow = ids.iter().any(|id| self.in_auto_layout_flow(id));
      let spacing = !in_flow && !from_center && !keep_aspect;
      let (snapped, g, spaced) = interact::snap_rect(&self.doc, &self.page, &ids, r, edges, zoom, spacing);
      guides = g;
      gaps = spaced;
      if fx < 0.0 {
        dx += snapped.x - r.x;
      } else if fx > 0.0 {
        dx += snapped.width - r.width;
      }
      if fy < 0.0 {
        dy += snapped.y - r.y;
      } else if fy > 0.0 {
        dy += snapped.height - r.height;
      }
      if guides.is_empty() && gaps.is_empty() {
        dx = dx.round();
        dy = dy.round();
      }
    }
    if ids.len() == 1 {
      let start = self.doc.get(&ids[0]).cloned().ok_or("missing node")?;
      interact::resize_node(&mut self.doc, &start, handle, Point::new(dx, dy), keep_aspect, from_center);
    } else {
      let mut to = from;
      let mult = if from_center { 2.0 } else { 1.0 };
      let mut w = from.width + fx * dx * mult;
      let mut h = from.height + fy * dy * mult;
      if keep_aspect && from.height > 0.0 {
        let ratio = from.width / from.height;
        if fx != 0.0 {
          h = h.signum() * (w / ratio).abs();
        } else {
          w = w.signum() * (h * ratio).abs();
        }
      }
      to.width = w.abs().max(1.0);
      to.height = h.abs().max(1.0);
      if from_center {
        to.x = from.center().x - to.width / 2.0;
        to.y = from.center().y - to.height / 2.0;
      } else {
        // Dragged past the opposite edge, the box flips over it and follows the cursor.
        if fx < 0.0 {
          to.x = if w < 0.0 { from.right() } else { from.right() - to.width };
        } else if fx > 0.0 && w < 0.0 {
          to.x = from.x - to.width;
        }
        if fy < 0.0 {
          to.y = if h < 0.0 { from.bottom() } else { from.bottom() - to.height };
        } else if fy > 0.0 && h < 0.0 {
          to.y = from.y - to.height;
        }
      }
      let starts: Vec<Node> = ids.iter().filter_map(|i| self.doc.get(i).cloned()).collect();
      interact::resize_many(&mut self.doc, &starts, from, to);
    }
    Ok(json!({ "guides": guides, "gaps": gaps }))
  }

  /// The Scale tool's handle drag: proportional (the larger change wins at a corner), around
  /// the opposite handle, or the centre.
  fn resize_scale(&mut self, ids: &[NodeId], handle: Handle, dx: f64, dy: f64, from_center: bool) -> Result<Value, String> {
    let ids = arrange::scalable(&self.doc, ids);
    let from = self.doc.bounds_of_many(&ids).ok_or("nothing to scale")?;
    let (fx, fy) = handle.factors();
    let mult = if from_center { 2.0 } else { 1.0 };
    let kx = if from.width > 0.0 {
      (from.width + fx * dx * mult) / from.width
    } else {
      1.0
    };
    let ky = if from.height > 0.0 {
      (from.height + fy * dy * mult) / from.height
    } else {
      1.0
    };
    let k = match (fx != 0.0, fy != 0.0) {
      (true, true) => {
        if (kx - 1.0).abs() >= (ky - 1.0).abs() {
          kx
        } else {
          ky
        }
      }
      (true, false) => kx,
      _ => ky,
    }
    .max(0.01);
    let c = from.center();
    let anchor = if from_center {
      c
    } else {
      Point::new(
        if fx < 0.0 {
          from.right()
        } else if fx > 0.0 {
          from.x
        } else {
          c.x
        },
        if fy < 0.0 {
          from.bottom()
        } else if fy > 0.0 {
          from.y
        } else {
          c.y
        },
      )
    };
    arrange::scale_nodes(&mut self.doc, &ids, k, anchor);
    Ok(json!({ "guides": [], "gaps": [], "scale": k }))
  }

  fn import_svg(&mut self, svg: &str, x: f64, y: f64, parent: Option<NodeId>, name: Option<String>) -> Result<Value, String> {
    let opts = svg_import::Options {
      name,
      ..Default::default()
    };
    let imported = svg_import::import(svg, &mut self.gen, &opts)?;
    let parent = self.auto_parent(parent, x, y).filter(|p| {
      self
        .doc
        .get(p)
        .is_some_and(|n| n.kind.is_frame_like() && n.kind != NodeType::Instance)
    });
    let page = self.page.clone();
    let mut nodes = imported.nodes.into_iter();
    let mut root = nodes.next().ok_or("nothing to import")?;
    root.x = x - root.width / 2.0;
    root.y = y - root.height / 2.0;
    let id = self.insert_abs(root, parent.as_deref());
    for mut n in nodes {
      n.page = page.clone();
      self.doc.nodes.insert(n.id.clone(), Arc::new(n));
    }
    self.selection = vec![id.clone()];
    Ok(json!({ "id": id, "warnings": imported.warnings }))
  }

  fn paste(&mut self, data: &str, parent: Option<NodeId>, x: Option<f64>, y: Option<f64>) -> Result<Value, String> {
    let v: Value = serde_json::from_str(data).map_err(|_| "clipboard does not contain Designotron layers")?;
    if v.get("type").and_then(|t| t.as_str()) != Some(CLIPBOARD_TAG) {
      return Err("clipboard does not contain Designotron layers".into());
    }
    let mut nodes: Vec<Node> = serde_json::from_value(v["nodes"].clone()).map_err(|e| e.to_string())?;
    let roots: Vec<NodeId> = serde_json::from_value(v["roots"].clone()).map_err(|e| e.to_string())?;
    let mut comps: Vec<Node> = v
      .get("components")
      .and_then(|c| serde_json::from_value(c.clone()).ok())
      .unwrap_or_default();
    // Variables and styles the layers use but this file lacks come along (and the layers follow
    // their new ids), before anything is inserted.
    let added = crate::clipboard::merge_tokens(&mut self.doc, &v, &mut self.gen, &mut nodes, &mut comps)?;
    let mut map: HashMap<NodeId, NodeId> = HashMap::new();
    for n in &nodes {
      map.insert(n.id.clone(), self.gen.next("n_"));
    }
    let parent = parent.map(|p| devices::host_of(&self.doc, &p)).filter(|p| {
      self
        .doc
        .get(p)
        .map(|n| n.kind.is_frame_like() && n.kind != NodeType::Instance)
        .unwrap_or(false)
    });
    let pasted: Vec<&Node> = nodes.iter().collect();
    if components::would_nest_nodes(&self.doc, &pasted, parent.as_deref()) {
      return Err("a component can't contain an instance of itself".into());
    }
    let bounds = Rect::union_all(
      nodes
        .iter()
        .filter(|n| roots.contains(&n.id))
        .map(|n| Rect::new(n.x, n.y, n.width, n.height)),
    );
    let (ox, oy) = match (x, y, bounds) {
      (Some(x), Some(y), Some(b)) => (x - b.x, y - b.y),
      _ => (0.0, 0.0),
    };
    let page = self.page.clone();
    let mut created = Vec::new();
    for n in &nodes {
      let mut c = n.clone();
      c.id = map[&n.id].clone();
      c.children = n.children.iter().filter_map(|ch| map.get(ch).cloned()).collect();
      c.page = page.clone();
      if roots.contains(&n.id) {
        // Roots carry page-space positions in the clipboard.
        c.x += ox;
        c.y += oy;
        c.parent = None;
        c.master_id = None;
        // A copied piece of system UI is an ordinary layer from here on (code export includes it).
        if c.device_part.take().is_some() {
          c.locked = false;
        }
        let id = c.id.clone();
        self.doc.insert(c, None, &page, None);
        if let Some(p) = &parent {
          self.doc.reparent(&id, Some(p), None, true);
        }
        created.push(id);
      } else {
        c.parent = n.parent.as_ref().and_then(|p| map.get(p).cloned());
        self.doc.nodes.insert(c.id.clone(), Arc::new(c));
      }
    }
    // Instances whose main component isn't in this file: bring it from the clipboard, or
    // detach them so they keep their look instead of showing "Missing component".
    let mut side = None;
    for n in nodes.iter().filter(|n| n.kind == NodeType::Instance) {
      let new_id = map[&n.id].clone();
      let Some(cid) = n.instance.as_ref().map(|i| i.component_id.clone()) else {
        continue;
      };
      if self.is_component(&cid) {
        continue;
      }
      // A component copied along with its instance stands in for it.
      if let Some(copy) = map.get(&cid).filter(|c| self.is_component(c)).cloned() {
        if let Some(info) = self.doc.get_mut(&new_id).and_then(|i| i.instance.as_mut()) {
          info.component_id = copy;
        }
      } else if !self.paste_component(&cid, &comps, &mut side) {
        components::detach_instance(&mut self.doc, &new_id);
      }
    }
    self.selection = created.clone();
    Ok(json!({ "created": created, "added": added.to_json() }))
  }

  fn is_component(&self, id: &str) -> bool {
    self.doc.get(id).map(|n| n.kind == NodeType::Component).unwrap_or(false)
  }

  /// Inserts main component `cid` from the clipboard's `components`, keeping its ids so
  /// pasted instances (and their overrides) still match it. Components are stacked off to
  /// the right of the page's content; `side` tracks where the next one goes. Returns false
  /// when the component isn't there or its ids are taken in this file.
  fn paste_component(&mut self, cid: &str, comps: &[Node], side: &mut Option<Point>) -> bool {
    if self.is_component(cid) {
      return true;
    }
    let Some(start) = comps.iter().position(|n| n.id == cid && n.kind == NodeType::Component) else {
      return false;
    };
    // The clipboard lists each component's subtree in pre-order, from its detached root.
    let sub: Vec<Node> = std::iter::once(comps[start].clone())
      .chain(comps[start + 1..].iter().take_while(|n| n.parent.is_some()).cloned())
      .collect();
    if sub.iter().any(|n| self.doc.nodes.contains_key(&n.id)) {
      return false;
    }
    let page = self.page.clone();
    let at = *side.get_or_insert_with(|| {
      let b = self
        .doc
        .bounds_of_many(&self.doc.page(&page).map(|p| p.children.clone()).unwrap_or_default());
      b.map(|b| Point::new(b.right() + 100.0, b.y)).unwrap_or_default()
    });
    for (i, n) in sub.iter().enumerate() {
      let mut c = n.clone();
      c.page = page.clone();
      if i == 0 {
        c.x = at.x;
        c.y = at.y;
        c.parent = None;
        side.replace(Point::new(at.x, at.y + c.height + 40.0));
        self.doc.insert(c, None, &page, None);
      } else {
        self.doc.nodes.insert(c.id.clone(), Arc::new(c));
      }
    }
    // Instances inside the component need their own mains too.
    for n in sub.iter().filter(|n| n.kind == NodeType::Instance) {
      let inner = n.instance.as_ref().map(|i| i.component_id.clone()).unwrap_or_default();
      if !self.paste_component(&inner, comps, side) {
        components::detach_instance(&mut self.doc, &n.id);
      }
    }
    true
  }

  /// Read-only queries.
  pub fn query(&self, q: Query) -> Result<Value, String> {
    let m = self.measurer.as_ref();
    Ok(match q {
      Query::Pick { x, y, zoom, deep } => json!(interact::pick(&self.doc, &self.page, Point::new(x, y), zoom, &self.selection, deep)),
      Query::Drill { x, y, zoom, container } => json!(interact::drill(&self.doc, &self.page, Point::new(x, y), zoom, &container)),
      Query::Hit { x, y, zoom } => json!(interact::hit_test(&self.doc, &self.page, Point::new(x, y), zoom)),
      Query::Marquee { x, y, width, height } => json!(interact::marquee(&self.doc, &self.page, Rect::new(x, y, width, height))),
      Query::Bounds { ids, painted } => {
        let items: Vec<Value> = ids
          .iter()
          .filter_map(|id| self.doc.get(id).map(|n| (id, n)))
          .map(|(id, n)| {
            let mut item = json!({ "id": id, "matrix": self.doc.abs_matrix(id), "width": n.width, "height": n.height, "bounds": self.doc.abs_bounds(id) });
            if painted {
              item["painted"] = json!(render::render_bounds(&self.doc, id, self.measurer.as_ref()));
            }
            item
          })
          .collect();
        json!({ "items": items, "union": self.doc.bounds_of_many(&ids) })
      }
      Query::Measure { ids, target, x, y, zoom } => {
        let ids = if ids.is_empty() { self.selection.clone() } else { ids };
        json!(interact::measure_at(
          &self.doc,
          &self.page,
          &ids,
          target.as_deref(),
          Point::new(x, y),
          zoom
        ))
      }
      Query::TextLayout { id, from, to } => match self.doc.get(&id).and_then(|n| n.text.as_ref().map(|t| (n, t))) {
        Some((n, t)) => {
          let range = from.map(|a| (a, to.unwrap_or(a)));
          json!(crate::text::caret_geometry(n, t, self.measurer.as_ref(), true, range))
        }
        None => Value::Null,
      },
      Query::OverrideGroups { id } => {
        let groups: Vec<Value> = components::override_groups(&self.doc, &id)
          .into_iter()
          .map(|(key, label)| json!({ "key": key, "label": label }))
          .collect();
        json!({ "groups": groups })
      }
      Query::OverriddenLayers { id } => {
        let (layers, more) = components::overridden_layers(&self.doc, &id, 20);
        let layers: Vec<Value> = layers
          .into_iter()
          .map(|(lid, name, groups)| {
            let groups: Vec<Value> = groups
              .into_iter()
              .map(|(key, label)| json!({ "key": key, "label": label }))
              .collect();
            json!({ "id": lid, "name": name, "groups": groups })
          })
          .collect();
        json!({ "layers": layers, "more": more })
      }
      Query::OverrideCount { id } => json!({ "count": components::override_count(&self.doc, &id) }),
      Query::ComponentProps { id } => crate::props::describe(&self.doc, &id),
      Query::FrameAt { x, y, exclude } => json!(ops::frame_at(&self.doc, &self.page, Point::new(x, y), &exclude, true)),
      Query::DropSlot { ids, x, y } => json!(self.drop_slot(&ids, Point::new(x, y))),
      Query::SnapPoint { x, y, zoom, exclude } => {
        let (r, guides, _) = interact::snap_rect(
          &self.doc,
          &self.page,
          &exclude,
          Rect::new(x, y, 0.0, 0.0),
          [true, false, true, false],
          zoom,
          false,
        );
        json!({ "x": r.x, "y": r.y, "guides": guides })
      }
      Query::VectorSegmentAt { id, x, y, zoom } => {
        let Some(v) = self.doc.get(&id).and_then(|n| n.vector.as_ref()) else {
          return Ok(Value::Null);
        };
        let m = self.doc.abs_matrix(&id);
        let local = m.invert().apply(Point::new(x, y));
        let z = zoom.max(1e-6);
        match vector_edit::nearest_segment(v, local, VECTOR_SEGMENT_TOLERANCE / z) {
          Some(h) if vector_edit::near_segment_end(v, &h, VECTOR_ANCHOR_MARGIN / z) => Value::Null,
          Some(h) => {
            let p = m.apply(Point::new(h.x, h.y));
            json!({ "sub": h.sub, "seg": h.seg, "t": h.t, "x": p.x, "y": p.y })
          }
          None => Value::Null,
        }
      }
      Query::Comments { page, include_resolved } => crate::comments::list(&self.doc, page.as_deref(), include_resolved),
      Query::GridOverlay { page } => crate::grids::overlay(&self.doc, page.as_deref().unwrap_or(&self.page)),
      Query::SafeAreas { page } => crate::grids::safe_areas(&self.doc, page.as_deref().unwrap_or(&self.page), &self.selection),
      Query::DevicePresets => crate::devices::presets_json(),
      Query::DeviceInsets { id } => json!(self.doc.get(&id).and_then(crate::devices::safe_insets)),
      Query::Copy { ids } => json!(self.copy(&ids)),
      Query::MatchingLayers { ids } => json!(arrange::matching_layers(&self.doc, &ids)),
      Query::SameProperty { id, prop } => {
        let prop = arrange::SameProp::parse(&prop).ok_or_else(|| format!("unknown property {prop}"))?;
        json!(arrange::same_property(&self.doc, &id, prop))
      }
      Query::Instances { component, all_pages } => json!(arrange::instances_of(&self.doc, &component, &self.page, all_pages)),
      Query::ExportSvg {
        id,
        hide,
        children_only,
        with_bounds,
      } => {
        let with_bounds = with_bounds || children_only;
        if hide.is_empty() && !with_bounds {
          json!(render::export_svg(&self.doc, &id, m))
        } else {
          let c = render::export_svg_parts(&self.doc, &id, m, &hide, children_only);
          if with_bounds {
            json!({ "svg": c.svg, "x": c.bounds.x, "y": c.bounds.y, "width": c.bounds.width, "height": c.bounds.height })
          } else {
            json!(c.svg)
          }
        }
      }
      Query::ExportHtml { id } => json!(codegen::export_html(&self.doc, &id, m)),
      Query::ExportReact { id } => json!(codegen::export_react(&self.doc, &id, m)),
      Query::ExportProject => {
        let files: Vec<Value> = codegen::export_project(&self.doc, m)
          .into_iter()
          .map(|f| json!({ "path": f.path, "content": f.content }))
          .collect();
        json!(files)
      }
      Query::InspectNames => codegen::inspect_names(&self.doc),
      Query::ToolDefs => ai::tool_defs(),
      Query::SystemPrompt => json!(ai::SYSTEM_PROMPT),
      Query::Lint { page } => json!(crate::lint::lint_page(&self.doc, page.as_deref().unwrap_or(&self.page), m)),
      Query::Summary { depth } => ai::summary(self, depth),
    })
  }

  /// Serialises the selection (with page-space root positions) for the clipboard.
  /// Main components of copied instances (not copied themselves) ride along in `components`
  /// so a paste into another file can bring them in.
  pub fn copy(&self, ids: &[NodeId]) -> String {
    let roots = ops::paint_order(&self.doc, &ops::top_most(&self.doc, ids));
    let mut nodes: Vec<Node> = roots.iter().flat_map(|r| self.clipboard_subtree(r)).collect();
    let mut seen: HashSet<NodeId> = nodes.iter().map(|n| n.id.clone()).collect();
    let mut wanted: Vec<NodeId> = nodes
      .iter()
      .filter_map(|n| n.instance.as_ref())
      .map(|i| i.component_id.clone())
      .collect();
    let mut components: Vec<Node> = Vec::new();
    while let Some(cid) = wanted.pop() {
      if seen.contains(&cid) || self.doc.get(&cid).map(|c| c.kind != NodeType::Component).unwrap_or(true) {
        continue;
      }
      let sub = self.clipboard_subtree(&cid);
      seen.extend(sub.iter().map(|n| n.id.clone()));
      // Components can hold instances of other components.
      wanted.extend(sub.iter().filter_map(|n| n.instance.as_ref()).map(|i| i.component_id.clone()));
      components.extend(sub);
    }
    let tokens = crate::clipboard::attach(&self.doc, &mut nodes, &mut components);
    let mut out = json!({ "type": CLIPBOARD_TAG, "roots": roots, "nodes": nodes, "components": components });
    for (key, value) in tokens {
      out[key] = value;
    }
    out.to_string()
  }

  /// A subtree for the clipboard: the root detached, at its page-space position.
  fn clipboard_subtree(&self, root: &str) -> Vec<Node> {
    let b = self.doc.abs_bounds(root);
    let mut out = Vec::new();
    for nid in self.doc.subtree(root) {
      if let Some(n) = self.doc.get(&nid) {
        let mut c = n.clone();
        if nid == root {
          let local = self.doc.local_matrix(n).bounds_of(n.width, n.height);
          c.x = b.x + (n.x - local.x);
          c.y = b.y + (n.y - local.y);
          c.parent = None;
          // A variant copied out of its set stands alone: it brings the set's properties it uses.
          if n.kind == NodeType::Component {
            let own = crate::props::standalone_props(&self.doc, root);
            if !own.is_empty() {
              c.component.get_or_insert_with(Default::default).props = own;
            }
          }
        }
        out.push(c);
      }
    }
    out
  }

  pub fn measurer(&self) -> &dyn TextMeasurer {
    self.measurer.as_ref()
  }
}

/// A patch with the unsafe links of its text runs removed (runs left with no style go too).
fn without_unsafe_links(mut p: Value) -> Value {
  let Some(runs) = p.pointer_mut("/text/runs").and_then(|r| r.as_array_mut()) else {
    return p;
  };
  for r in runs.iter_mut() {
    let bad = r
      .get("link")
      .is_some_and(|l| l.as_str().is_none_or(|l| crate::model::safe_link(l).is_none()));
    if bad {
      if let Some(o) = r.as_object_mut() {
        o.remove("link");
      }
    }
  }
  runs.retain(|r| r.as_object().is_none_or(|o| o.keys().any(|k| k != "start" && k != "end")));
  p
}

/// Sets the first stroke paint to a solid colour (adding a 1 px stroke when the layer has none).
pub(crate) fn set_stroke_color(n: &mut Node, color: &str) {
  match n.strokes.first_mut() {
    Some(Paint::Solid { color: c, .. }) => *c = color.to_string(),
    Some(first) => *first = Paint::solid(color),
    None => n.strokes.push(Paint::solid(color)),
  }
  if n.stroke_weight <= 0.0 {
    n.stroke_weight = 1.0;
  }
}

/// Recolours the first stroke paint (style propagation never adds a stroke).
fn recolor_stroke(n: &mut Node, color: &str) {
  match n.strokes.first_mut() {
    Some(Paint::Solid { color: c, .. }) => *c = color.to_string(),
    Some(first) => *first = Paint::solid(color),
    None => {}
  }
}

/// Removes links a text's runs may not carry (anything but http(s), mailto and tel), so a
/// patch from an AI tool, a plugin or a peer can't plant a `javascript:` link.
fn drop_unsafe_links(n: &mut Node) {
  let Some(t) = n.text.as_mut() else { return };
  if t
    .runs
    .iter()
    .all(|r| r.link.as_deref().is_none_or(|l| crate::model::safe_link(l).is_some()))
  {
    return;
  }
  for r in t.runs.iter_mut() {
    if r.link.as_deref().is_some_and(|l| crate::model::safe_link(l).is_none()) {
      r.link = None;
    }
  }
  let len = t.characters.chars().count();
  crate::text::normalize_runs(&mut t.runs, len);
}

/// Applies a run's overrides to the base text props.
fn fold_into_base(t: &mut crate::model::TextProps, r: &crate::model::TextRun) {
  if let Some(v) = &r.font_family {
    t.font_family = v.clone();
  }
  if let Some(v) = r.font_size {
    t.font_size = v;
  }
  if let Some(v) = r.font_weight {
    t.font_weight = v;
  }
  if let Some(v) = r.italic {
    t.italic = v;
  }
  if let Some(v) = r.letter_spacing {
    t.letter_spacing = v;
  }
  if let Some(v) = r.decoration {
    t.decoration = v;
  }
}

/// Run overrides that a whole-layer `Update` replaces: the text style keys it sets (and run
/// colours when it sets the fill), so a layer set to Regular/18 doesn't keep a 700/32 word.
/// A patch carrying its own changed runs (whole-object edits) only replaces keys it changes.
fn layer_run_keys(p: &Value, before: &crate::model::TextProps) -> Vec<&'static str> {
  const KEYS: [&str; 6] = ["fontFamily", "fontSize", "fontWeight", "italic", "letterSpacing", "decoration"];
  let mut keys = Vec::new();
  if let Some(t) = p.get("text").and_then(|t| t.as_object()) {
    let old = serde_json::to_value(before).unwrap_or(Value::Null);
    match t.get("runs") {
      None => keys.extend(KEYS.iter().filter(|k| t.contains_key(**k))),
      Some(runs) if *runs == old["runs"] => keys.extend(KEYS.iter().filter(|k| t.get(**k).is_some_and(|v| *v != old[**k]))),
      Some(_) => {}
    }
  }
  if p.get("fills").is_some() {
    keys.push("color");
  }
  keys
}

/// Field names a run sets (so existing runs stop overriding them).
fn patch_keys(r: &crate::model::TextRun) -> Vec<&'static str> {
  let mut k = Vec::new();
  if r.font_family.is_some() {
    k.push("fontFamily");
  }
  if r.font_size.is_some() {
    k.push("fontSize");
  }
  if r.font_weight.is_some() {
    k.push("fontWeight");
  }
  if r.italic.is_some() {
    k.push("italic");
  }
  if r.color.is_some() {
    k.push("color");
  }
  if r.decoration.is_some() {
    k.push("decoration");
  }
  if r.letter_spacing.is_some() {
    k.push("letterSpacing");
  }
  k
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::text::HeuristicMeasurer;

  fn engine() -> Engine {
    Engine::new(Box::new(HeuristicMeasurer), 42)
  }

  /// Frame "Card" (300,0,200x100), a main "Btn" (0,0,100x40) and a main "Other" (0,200,100x40).
  fn instance_fixture() -> (Engine, String, String, String) {
    let mut e = Engine::new(Box::new(HeuristicMeasurer), 3);
    let frame = |e: &mut Engine, x: f64, y: f64, w: f64, h: f64| {
      let r = e
        .dispatch(Command::CreateShape {
          kind: NodeType::Frame,
          x,
          y,
          width: w,
          height: h,
          parent: None,
        })
        .unwrap();
      id_of(&r)
    };
    let card = frame(&mut e, 300.0, 0.0, 200.0, 100.0);
    let btn = frame(&mut e, 0.0, 0.0, 100.0, 40.0);
    let btn = id_of(&e.dispatch(Command::CreateComponent { ids: vec![btn] }).unwrap());
    let other = frame(&mut e, 0.0, 200.0, 100.0, 40.0);
    let other = id_of(&e.dispatch(Command::CreateComponent { ids: vec![other] }).unwrap());
    (e, card, btn, other)
  }

  fn place(e: &mut Engine, comp: &str, x: f64, y: f64, anchor: Option<Point>, into_components: bool) -> Result<String, String> {
    e.dispatch(Command::CreateInstance {
      component_id: comp.into(),
      x,
      y,
      parent: None,
      anchor,
      into_components,
    })
    .map(|r| id_of(&r))
  }

  #[test]
  fn instance_click_over_a_main_goes_to_the_page() {
    let (mut e, _, btn, other) = instance_fixture();
    // Anchor over another main: a click never nests into a main component.
    let a = place(&mut e, &btn, 0.0, 200.0, Some(Point::new(50.0, 220.0)), false).unwrap();
    assert_eq!(e.doc.get(&a).unwrap().parent, None);
    // Over its own main: still the page, no error.
    let b = place(&mut e, &btn, 0.0, 0.0, Some(Point::new(50.0, 20.0)), false).unwrap();
    assert_eq!(e.doc.get(&b).unwrap().parent, None);
    assert!(e.doc.get(&other).unwrap().children.is_empty());
  }

  #[test]
  fn instance_drop_onto_a_main_nests_unless_it_is_its_own() {
    let (mut e, _, btn, other) = instance_fixture();
    let a = place(&mut e, &btn, 0.0, 200.0, Some(Point::new(50.0, 220.0)), true).unwrap();
    assert_eq!(e.doc.get(&a).unwrap().parent.as_deref(), Some(other.as_str()));
    // Onto its own main the recursion check refuses it, so it lands on the page.
    let b = place(&mut e, &btn, 0.0, 0.0, Some(Point::new(50.0, 20.0)), true).unwrap();
    assert_eq!(e.doc.get(&b).unwrap().parent, None);
    assert!(e
      .doc
      .get(&btn)
      .unwrap()
      .children
      .iter()
      .all(|c| e.doc.get(c).unwrap().instance.is_none()));
  }

  #[test]
  fn instance_parent_follows_the_anchor_not_the_corner() {
    let (mut e, card, btn, _) = instance_fixture();
    // Pointer inside the frame, top-left outside it: nested in the frame.
    let a = place(&mut e, &btn, 280.0, -10.0, Some(Point::new(340.0, 10.0)), true).unwrap();
    assert_eq!(e.doc.get(&a).unwrap().parent.as_deref(), Some(card.as_str()));
    // Without an anchor the top-left decides, as before.
    let b = place(&mut e, &btn, 280.0, -10.0, None, true).unwrap();
    assert_eq!(e.doc.get(&b).unwrap().parent, None);
    let c = place(&mut e, &btn, 320.0, 10.0, None, false).unwrap();
    assert_eq!(e.doc.get(&c).unwrap().parent.as_deref(), Some(card.as_str()));
  }

  fn slot_at(e: &Engine, ids: Vec<NodeId>, x: f64, y: f64) -> Value {
    e.query(Query::DropSlot { ids, x, y }).unwrap()
  }

  fn id_of(v: &Value) -> String {
    v["id"].as_str().unwrap().to_string()
  }

  fn update_ids(e: &mut Engine, ids: Vec<NodeId>, patch: Value) {
    e.dispatch(Command::Update { ids, patch }).unwrap();
  }

  fn rect(e: &mut Engine, x: f64, y: f64, w: f64, h: f64, parent: Option<NodeId>) -> String {
    let r = e
      .dispatch(Command::CreateShape {
        kind: NodeType::Rectangle,
        x,
        y,
        width: w,
        height: h,
        parent,
      })
      .unwrap();
    id_of(&r)
  }

  fn ai(e: &mut Engine, tool: &str, input: Value) -> Value {
    e.dispatch(Command::Ai { tool: tool.into(), input }).unwrap()
  }

  #[test]
  fn moving_a_child_of_a_flipped_group_keeps_the_others_on_the_page() {
    let mut e = engine();
    let a = rect(&mut e, 100.0, 100.0, 40.0, 40.0, None);
    let b = rect(&mut e, 300.0, 100.0, 40.0, 40.0, None);
    let g = id_of(
      &e.dispatch(Command::Group {
        ids: vec![a.clone(), b.clone()],
      })
      .unwrap(),
    );
    e.dispatch(Command::Flip {
      ids: vec![g],
      horizontal: true,
    })
    .unwrap();
    let page_x = |e: &Engine, id: &str| e.doc.abs_bounds(id).x;
    assert_eq!((page_x(&e, &a), page_x(&e, &b)), (300.0, 100.0));
    // Own x 250 mirrors to page x 50: the sibling must not move when the group refits.
    e.dispatch(Command::Update {
      ids: vec![a.clone()],
      patch: json!({ "x": 250 }),
    })
    .unwrap();
    assert_eq!((page_x(&e, &a), page_x(&e, &b)), (50.0, 100.0));
  }

  #[test]
  fn read_only_refuses_edits_but_allows_looking_and_comments() {
    let mut e = engine();
    let id = rect(&mut e, 0.0, 0.0, 5.0, 5.0, None);
    let rev = e.doc_rev;
    e.dispatch(Command::SetReadOnly { on: true }).unwrap();
    assert_eq!(e.doc_rev, rev, "switching the mode isn't an edit");
    assert_eq!(e.state()["readOnly"], true);
    let update = Command::Update {
      ids: vec![id.clone()],
      patch: json!({ "name": "x" }),
    };
    assert_eq!(e.dispatch(update.clone()).unwrap_err(), READ_ONLY);
    let ai = Command::Ai {
      tool: "get_selection".into(),
      input: json!({}),
    };
    assert_eq!(e.dispatch(ai).unwrap_err(), READ_ONLY);
    let nodes = e.doc.nodes.clone();
    e.dispatch(Command::Select {
      ids: vec![id.clone()],
      mode: SelectMode::Replace,
    })
    .unwrap();
    assert_eq!(e.selection, vec![id]);
    let comment = Command::AddComment {
      page: None,
      x: 1.0,
      y: 2.0,
      node: None,
      text: "hi".into(),
      author: "Viewer".into(),
      time: 1.0,
    };
    e.dispatch(comment).unwrap();
    assert_eq!(e.doc.comments.len(), 1);
    assert_eq!(e.doc.nodes, nodes);
    e.dispatch(Command::SetReadOnly { on: false }).unwrap();
    e.dispatch(update).unwrap();
  }

  #[test]
  fn undo_reverts_a_whole_ai_group() {
    let mut e = engine();
    let group = |e: &mut Engine, g: Option<&str>| {
      e.dispatch(Command::SetHistoryGroup { group: g.map(Into::into) }).unwrap();
    };
    let add = |e: &mut Engine, name: &str| {
      ai(
        e,
        "create_nodes",
        json!({ "nodes": [{ "type": "frame", "name": name, "width": 10, "height": 10 }] }),
      );
    };
    let names = |e: &Engine| {
      let mut v: Vec<String> = e.doc.nodes.values().map(|n| n.name.clone()).collect();
      v.sort();
      v
    };
    group(&mut e, Some("t1"));
    add(&mut e, "a1");
    add(&mut e, "a2");
    add(&mut e, "a3");
    group(&mut e, None);
    let user = rect(&mut e, 0.0, 0.0, 5.0, 5.0, None);
    group(&mut e, Some("t2"));
    add(&mut e, "b1");
    add(&mut e, "b2");
    group(&mut e, None);
    assert_eq!(e.past.len(), 3, "each turn is one step, the user's edit another");

    e.dispatch(Command::Undo).unwrap();
    assert_eq!(
      names(&e),
      ["Rectangle 1", "a1", "a2", "a3"].map(String::from),
      "t2 is gone as one step"
    );
    e.dispatch(Command::Undo).unwrap();
    assert!(e.doc.get(&user).is_none(), "then the user's own edit");
    assert_eq!(names(&e).len(), 3);
    e.dispatch(Command::Undo).unwrap();
    assert!(names(&e).is_empty(), "then all of t1");
    assert!(!e.state()["canUndo"].as_bool().unwrap());

    e.dispatch(Command::Redo).unwrap();
    assert_eq!(names(&e), ["a1", "a2", "a3"].map(String::from), "redo restores t1 fully");
    e.dispatch(Command::Redo).unwrap();
    assert!(e.doc.get(&user).is_some());
    e.dispatch(Command::Redo).unwrap();
    assert_eq!(names(&e).len(), 6);
    assert!(!e.state()["canRedo"].as_bool().unwrap());
  }

  #[test]
  fn ten_grouped_steps_make_one_and_undo_redo_are_exact() {
    let mut e = engine();
    let base = e.doc.clone();
    e.dispatch(Command::SetHistoryGroup { group: Some("t".into()) }).unwrap();
    for i in 0..10 {
      ai(
        &mut e,
        "create_nodes",
        json!({ "nodes": [{ "type": "frame", "name": format!("n{i}"), "width": 10, "height": 10 }] }),
      );
    }
    e.dispatch(Command::SetHistoryGroup { group: None }).unwrap();
    assert_eq!(e.past.len(), 1);
    let done = e.doc.clone();
    e.dispatch(Command::Undo).unwrap();
    assert!(e.doc == base, "exact undo equals the before document");
    assert!(!e.state()["canUndo"].as_bool().unwrap());
    e.dispatch(Command::Redo).unwrap();
    assert!(e.doc == done, "redo reapplies the whole turn");
  }

  #[test]
  fn remote_edit_between_grouped_steps_prevents_merging() {
    let mut e = engine();
    let a = rect(&mut e, 0.0, 0.0, 50.0, 50.0, None);
    e.dispatch(Command::SetHistoryGroup { group: Some("t".into()) }).unwrap();
    ai(&mut e, "update_nodes", json!({ "updates": [{ "id": a, "opacity": 0.5 }] }));
    let mut theirs = e.doc.clone();
    theirs.get_mut(&a).unwrap().x = 77.0;
    let d = crate::collab::delta(&e.doc, &theirs, false, false);
    e.dispatch(Command::ApplyRemote { delta: d, local: false }).unwrap();
    let steps = e.past.len();
    ai(&mut e, "update_nodes", json!({ "updates": [{ "id": a, "opacity": 0.25 }] }));
    assert_eq!(e.past.len(), steps + 1, "a collaborator's edit in between splits the turn");
    e.dispatch(Command::SetHistoryGroup { group: None }).unwrap();
    // Undo takes the turn's steps together but keeps the remote edit.
    e.dispatch(Command::Undo).unwrap();
    let n = e.doc.get(&a).unwrap();
    assert_eq!(n.x, 77.0, "the remote edit stays");
    assert_eq!(n.opacity, 1.0);
  }

  #[test]
  fn relayout_of_a_laid_out_document_copies_nothing() {
    let mut e = engine();
    ai(
      &mut e,
      "create_nodes",
      json!({ "nodes": [{ "type": "frame", "name": "F", "width": 200, "layout": { "direction": "vertical", "gap": 4, "padding": 8 },
        "children": [{ "type": "text", "text": "Hello" }, { "type": "rectangle", "width": 20, "height": 20 }] }] }),
    );
    let before = e.doc.nodes.clone();
    e.dispatch(Command::Relayout).unwrap();
    assert!(before.ptr_eq(&e.doc.nodes), "no node was rewritten");
  }

  #[test]
  fn render_after_move_delete_page_switch_and_undo_matches_a_fresh_render() {
    let mut e = engine();
    let a = rect(&mut e, 0.0, 0.0, 50.0, 50.0, None);
    let p1 = e.page.clone();
    e.render_incremental(&p1, &[], None);
    ai(&mut e, "update_nodes", json!({ "updates": [{ "id": a, "x": 300 }] }));
    e.render_incremental(&p1, &[], None);
    e.dispatch(Command::Delete { ids: vec![a.clone()] }).unwrap();
    e.render_incremental(&p1, &[], None);
    e.dispatch(Command::AddPage { name: None }).unwrap();
    let p2 = e.page.clone();
    e.render_incremental(&p2, &[], None);
    e.dispatch(Command::Undo).unwrap();
    e.dispatch(Command::Undo).unwrap();
    let inc = e.render_incremental(&p1, &[], None);
    let fresh = render::render_root(
      &e.doc,
      &a,
      e.measurer.as_ref(),
      RenderOptions {
        mode: Mode::Canvas,
        hidden: &[],
        editing: None,
      },
    );
    assert_eq!(inc["changed"][&a].as_str().unwrap(), fresh, "markup carries the move");
  }

  #[test]
  fn ungrouped_ai_steps_are_still_one_each() {
    let mut e = engine();
    for n in ["a", "b", "c"] {
      ai(&mut e, "create_nodes", json!({ "nodes": [{ "type": "frame", "name": n }] }));
    }
    e.dispatch(Command::Undo).unwrap();
    assert_eq!(e.doc.nodes.len(), 2);
    // A group only tags AI commands: a user edit inside it is its own step.
    e.dispatch(Command::SetHistoryGroup { group: Some("t".into()) }).unwrap();
    ai(&mut e, "create_nodes", json!({ "nodes": [{ "type": "frame", "name": "d" }] }));
    rect(&mut e, 0.0, 0.0, 5.0, 5.0, None);
    ai(&mut e, "create_nodes", json!({ "nodes": [{ "type": "frame", "name": "e" }] }));
    e.dispatch(Command::SetHistoryGroup { group: None }).unwrap();
    e.dispatch(Command::Undo).unwrap();
    assert_eq!(e.doc.nodes.len(), 4, "the last AI step alone");
    e.dispatch(Command::Undo).unwrap();
    assert_eq!(e.doc.nodes.len(), 3, "the user's rectangle splits the turn");
  }

  #[test]
  fn set_history_group_is_not_an_edit() {
    let mut e = engine();
    rect(&mut e, 0.0, 0.0, 5.0, 5.0, None);
    e.dispatch(Command::Undo).unwrap();
    assert!(e.state()["canRedo"].as_bool().unwrap());
    let (rev, doc_rev, future) = (e.rev, e.doc_rev, e.future.len());
    e.dispatch(Command::SetHistoryGroup { group: Some("t".into()) }).unwrap();
    e.dispatch(Command::SetHistoryGroup { group: None }).unwrap();
    assert_eq!((e.rev, e.doc_rev, e.future.len()), (rev, doc_rev, future));
  }

  #[test]
  fn failed_ai_in_gesture_leaves_no_partial_change() {
    let mut e = engine();
    let a = rect(&mut e, 0.0, 0.0, 50.0, 50.0, None);
    e.dispatch(Command::BeginGesture).unwrap();
    let before = e.doc.clone();
    let r = e.dispatch(Command::Ai {
      tool: "update_nodes".into(),
      input: json!({ "updates": [{ "id": a, "patch": { "width": 99 } }, { "id": "n_missing", "patch": { "width": 1 } }] }),
    });
    assert!(r.is_err());
    assert!(e.doc == before, "the first update was rolled back");
    let steps = e.past.len();
    e.dispatch(Command::EndGesture).unwrap();
    assert_eq!(e.past.len(), steps, "nothing changed, so no step");
  }

  #[test]
  fn flow_start_is_a_top_level_frame_and_cleared_when_deleted() {
    let mut e = engine();
    let page = e.doc.pages[0].id.clone();
    let shape = |e: &mut Engine, kind, x, parent| {
      id_of(
        &e.dispatch(Command::CreateShape {
          kind,
          x,
          y: 0.0,
          width: 100.0,
          height: 100.0,
          parent,
        })
        .unwrap(),
      )
    };
    let a = shape(&mut e, NodeType::Frame, 0.0, None);
    let b = shape(&mut e, NodeType::Frame, 500.0, None);
    let inner = shape(&mut e, NodeType::Frame, 10.0, Some(a.clone()));
    let r = rect(&mut e, 900.0, 0.0, 10.0, 10.0, None);
    let set = |e: &mut Engine, id: Option<&str>| {
      e.dispatch(Command::SetFlowStart {
        page: page.clone(),
        id: id.map(Into::into),
      })
    };
    assert!(set(&mut e, Some(&r)).is_err(), "a rectangle can't start a flow");
    assert!(set(&mut e, Some(&inner)).is_err(), "a nested frame can't start a flow");
    assert!(set(&mut e, Some("nope")).is_err());
    assert_eq!(e.doc.pages[0].flow_start, None);
    set(&mut e, Some(&b)).unwrap();
    assert_eq!(e.doc.pages[0].flow_start.as_deref(), Some(b.as_str()));
    // Deleting another layer keeps the start; deleting the start clears it, and undo restores it.
    e.dispatch(Command::Delete { ids: vec![a] }).unwrap();
    assert_eq!(e.doc.pages[0].flow_start.as_deref(), Some(b.as_str()));
    e.dispatch(Command::Delete { ids: vec![b.clone()] }).unwrap();
    assert_eq!(e.doc.pages[0].flow_start, None);
    e.dispatch(Command::Undo).unwrap();
    assert_eq!(e.doc.pages[0].flow_start.as_deref(), Some(b.as_str()));
    // The AI delete tool clears it too.
    ai(&mut e, "delete_nodes", json!({ "ids": [b.clone()] }));
    assert_eq!(e.doc.pages[0].flow_start, None);
    e.dispatch(Command::Undo).unwrap();
    set(&mut e, None).unwrap();
    assert_eq!(e.doc.pages[0].flow_start, None);
  }

  #[test]
  fn incremental_render_reports_what_each_root_paints() {
    let mut e = engine();
    let page = e.doc.pages[0].id.clone();
    let a = rect(&mut e, 100.0, 50.0, 40.0, 20.0, None);
    let b = rect(&mut e, 300.0, 50.0, 40.0, 20.0, None);
    let bounds = |r: &Value, id: &str| -> Vec<f64> { r["bounds"][id].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect() };
    let t = ai(
      &mut e,
      "create_nodes",
      json!({ "nodes": [{ "type": "frame", "name": "F", "x": 0, "y": 300, "width": 100, "height": 100, "children": [
      { "type": "text", "text": "one" }, { "type": "text", "text": "two" }] }] }),
    )["created"][0]["id"]
      .as_str()
      .unwrap()
      .to_string();
    let first = e.render_incremental(&page, &[], None);
    assert_eq!(bounds(&first, &a), vec![100.0, 50.0, 40.0, 20.0]);
    assert_eq!(bounds(&first, &b), vec![300.0, 50.0, 40.0, 20.0]);
    assert_eq!(
      (first["texts"][&a].as_u64(), first["texts"][&t].as_u64()),
      (Some(0), Some(2)),
      "text layers are counted per root"
    );
    // A drop shadow reaches past the box and the bounds say so.
    e.dispatch(Command::Update {
      ids: vec![a.clone()],
      patch: json!({ "effects": [{ "type": "dropShadow", "x": 0, "y": 10, "blur": 10, "spread": 0, "color": "#000000", "visible": true }] }),
    })
    .unwrap();
    let second = e.render_incremental(&page, &[], None);
    assert!(second["changed"].get(&a).is_some() && second["changed"].get(&b).is_none());
    assert!(second["bounds"].get(&b).is_none(), "untouched roots keep the bounds the editor has");
    let shadowed = bounds(&second, &a);
    assert!(shadowed[0] < 100.0 && shadowed[3] > 20.0, "{shadowed:?}");
    // Moving a root only shifts its bounds.
    e.dispatch(Command::Update {
      ids: vec![a.clone()],
      patch: json!({ "x": 130.0, "y": 80.0 }),
    })
    .unwrap();
    let third = e.render_incremental(&page, &[], None);
    assert!(third["moved"].get(&a).is_some());
    let moved = bounds(&third, &a);
    assert_eq!(
      (moved[0] - shadowed[0], moved[1] - shadowed[1], moved[2], moved[3]),
      (30.0, 30.0, shadowed[2], shadowed[3])
    );
  }

  #[test]
  fn doc_delta_says_when_nothing_changed() {
    let mut e = engine();
    let a = rect(&mut e, 0.0, 0.0, 10.0, 10.0, None);
    assert!(e.doc_delta(true).get("full").is_some());
    assert_eq!(e.doc_delta(false), json!({ "same": true }), "nothing happened since the last call");
    e.dispatch(Command::Select {
      ids: vec![a.clone()],
      mode: SelectMode::Replace,
    })
    .unwrap();
    assert_eq!(e.doc_delta(false), json!({ "same": true }), "selecting doesn't change the document");
    e.dispatch(Command::Update {
      ids: vec![a.clone()],
      patch: json!({ "x": 5.0 }),
    })
    .unwrap();
    let d = e.doc_delta(false);
    assert!(d.get("same").is_none() && d["nodes"].get(&a).is_some());
    assert_eq!(e.doc_delta(false), json!({ "same": true }));
  }

  #[test]
  fn doc_rev_ignores_selection_and_tracks_edits() {
    let mut e = engine();
    let a = rect(&mut e, 0.0, 0.0, 50.0, 50.0, None);
    let b = rect(&mut e, 100.0, 0.0, 50.0, 50.0, None);
    let base = e.doc_rev;
    for ids in [vec![a.clone()], vec![b.clone()], vec![a.clone(), b.clone()]] {
      e.dispatch(Command::Select {
        ids,
        mode: SelectMode::Replace,
      })
      .unwrap();
    }
    e.dispatch(Command::SelectAll).unwrap();
    ai(&mut e, "select", json!({ "ids": [a.clone()] }));
    assert_eq!(e.doc_rev, base, "selection never counts as an edit");
    assert_eq!(e.state()["docRev"], json!(base));
    let rev = e.rev;
    e.dispatch(Command::Select {
      ids: vec![b.clone()],
      mode: SelectMode::Replace,
    })
    .unwrap();
    assert!(e.rev > rev, "the UI revision still moves on selection");

    e.dispatch(Command::Update {
      ids: vec![a.clone()],
      patch: json!({ "x": 10.0 }),
    })
    .unwrap();
    let after_edit = e.doc_rev;
    assert!(after_edit > base);
    e.dispatch(Command::Undo).unwrap();
    assert!(e.doc_rev > after_edit, "undo changes the document");
    let after_undo = e.doc_rev;
    e.dispatch(Command::Redo).unwrap();
    assert!(e.doc_rev > after_undo, "redo changes the document");
  }

  #[test]
  fn doc_rev_ignores_relayout_that_changes_nothing() {
    let mut e = engine();
    rect(&mut e, 0.0, 0.0, 50.0, 50.0, None);
    ai(
      &mut e,
      "create_nodes",
      json!({ "nodes": [{ "type": "text", "name": "T", "text": "Hello", "x": 0, "y": 80 }] }),
    );
    e.dispatch(Command::Relayout).unwrap();
    let base = e.doc_rev;
    e.dispatch(Command::Relayout).unwrap();
    e.dispatch(Command::Relayout).unwrap();
    assert_eq!(e.doc_rev, base, "a relayout of a laid-out document is not an edit");
    e.dispatch(Command::BeginGesture).unwrap();
    e.dispatch(Command::CancelGesture).unwrap();
    assert_eq!(e.doc_rev, base, "cancelling a gesture that changed nothing is not an edit");
  }

  #[test]
  fn doc_rev_counts_remote_changes_and_gestures() {
    let mut e = engine();
    let a = rect(&mut e, 0.0, 0.0, 50.0, 50.0, None);
    let before = e.doc_rev;
    let mut moved = e.doc.clone();
    moved.get_mut(&a).unwrap().x = 77.0;
    let theirs = crate::collab::delta(&e.doc, &moved, false, false);
    e.dispatch(Command::ApplyRemote {
      delta: theirs,
      local: false,
    })
    .unwrap();
    assert!(e.doc_rev > before, "a collaborator's change is unsaved work");

    let mid = e.doc_rev;
    e.dispatch(Command::BeginGesture).unwrap();
    e.dispatch(Command::Translate {
      ids: vec![a.clone()],
      dx: 5.0,
      dy: 0.0,
      snap: false,
      zoom: 1.0,
      axis: None,
    })
    .unwrap();
    assert!(e.doc_rev > mid);
    let dragged = e.doc_rev;
    e.dispatch(Command::CancelGesture).unwrap();
    assert!(e.doc_rev > dragged, "cancelling a drag puts the document back");
  }

  #[test]
  fn comments_follow_their_layer_and_claude_can_resolve_them() {
    let mut e = engine();
    let card = rect(&mut e, 100.0, 100.0, 50.0, 50.0, None);
    let id = id_of(
      &e.dispatch(Command::AddComment {
        page: None,
        x: 110.0,
        y: 105.0,
        node: Some(card.clone()),
        text: "Make this bigger".into(),
        author: "Ana".into(),
        time: 1.0,
      })
      .unwrap(),
    );
    e.dispatch(Command::Translate {
      ids: vec![card.clone()],
      dx: 50.0,
      dy: 0.0,
      snap: false,
      zoom: 1.0,
      axis: None,
    })
    .unwrap();
    let list = ai(&mut e, "get_comments", json!({}));
    assert_eq!(
      (list[0]["x"].as_f64(), list[0]["y"].as_f64()),
      (Some(160.0), Some(105.0)),
      "pin moved with the layer"
    );
    assert_eq!(list[0]["nodeId"], card);
    ai(&mut e, "reply_comment", json!({ "id": id, "text": "Done: 80×80" }));
    ai(&mut e, "resolve_comment", json!({ "id": id }));
    let c = &e.doc.comments[&id];
    assert!(c.resolved && c.messages[1].author == "Claude");
    assert_eq!(
      ai(&mut e, "get_comments", json!({})).as_array().unwrap().len(),
      0,
      "resolved threads are hidden by default"
    );
  }

  #[test]
  fn variables_follow_modes_and_export_as_css() {
    let mut e = engine();
    ai(
      &mut e,
      "define_variables",
      json!({ "collection": "Theme", "modes": ["Light", "Dark"], "variables": [
        { "name": "Surface", "type": "color", "values": { "Light": "#FFFFFF", "Dark": "#111111" } },
        { "name": "Radius", "type": "number", "value": 12 }
      ]}),
    );
    let r = ai(
      &mut e,
      "create_nodes",
      json!({ "nodes": [{ "type": "frame", "name": "Screen", "width": 200, "height": 200, "children": [
        { "type": "rectangle", "name": "Card", "width": 100, "height": 100, "bind": { "fill": "Theme/Surface", "cornerRadius": "Radius" } }
      ]}]}),
    );
    let frame = r["created"][0]["id"].as_str().unwrap().to_string();
    let card = e.doc.get(&frame).unwrap().children[0].clone();
    let fill = |e: &Engine| match &e.doc.get(&card).unwrap().fills[0] {
      Paint::Solid { color, .. } => color.clone(),
      _ => String::new(),
    };
    assert_eq!(fill(&e), "#FFFFFF");
    assert_eq!(e.doc.get(&card).unwrap().corner_radius, 12.0);
    assert!(
      e.doc.get(&card).unwrap().bindings["fill"].starts_with("v_"),
      "names are normalised to ids"
    );

    ai(
      &mut e,
      "update_nodes",
      json!({ "updates": [{ "id": frame, "variableModes": { "Theme": "Dark" } }] }),
    );
    assert_eq!(fill(&e), "#111111");

    // Generated code uses the CSS variable and switches mode with a data attribute.
    let files = e.query(Query::ExportProject).unwrap();
    let all: String = files
      .as_array()
      .unwrap()
      .iter()
      .map(|f| f["content"].as_str().unwrap().to_string())
      .collect();
    assert!(
      all.contains("--surface: #FFFFFF") && all.contains("[data-theme=\"dark\"]"),
      "tokens.css"
    );
    assert!(
      all.contains("bg-[color:var(--surface)]") && all.contains("data-theme=\"dark\""),
      "{all}"
    );

    // Editing the bound fill directly detaches the variable.
    e.dispatch(Command::Update {
      ids: vec![card.clone()],
      patch: json!({ "fills": [{ "type": "solid", "color": "#FF0000", "opacity": 1, "visible": true }] }),
    })
    .unwrap();
    assert_eq!(fill(&e), "#FF0000");
    assert!(!e.doc.get(&card).unwrap().bindings.contains_key("fill"));
  }

  #[test]
  fn instances_resolve_variables_in_their_own_mode() {
    let mut e = engine();
    ai(
      &mut e,
      "define_variables",
      json!({ "collection": "Theme", "modes": ["Light", "Dark"], "variables": [
        { "name": "Accent", "type": "color", "values": { "Light": "#6D4AFF", "Dark": "#B8A6FF" } }
      ]}),
    );
    let r = ai(
      &mut e,
      "create_nodes",
      json!({ "nodes": [{ "type": "rectangle", "name": "Chip", "width": 40, "height": 20, "bind": { "fill": "Accent" } }] }),
    );
    let chip = r["created"][0]["id"].as_str().unwrap().to_string();
    let comp = ai(&mut e, "arrange", json!({ "action": "create_component", "ids": [chip] }))["id"]
      .as_str()
      .unwrap()
      .to_string();
    let r = ai(
      &mut e,
      "create_nodes",
      json!({ "nodes": [{ "type": "frame", "name": "Dark screen", "x": 300, "width": 200, "height": 200, "variableModes": { "Theme": "Dark" },
        "children": [{ "type": "instance", "componentId": comp }] }] }),
    );
    let screen = r["created"][0]["id"].as_str().unwrap().to_string();
    let inst = e.doc.get(&screen).unwrap().children[0].clone();
    let colors: Vec<String> = e
      .doc
      .subtree(&inst)
      .iter()
      .filter_map(|id| match e.doc.get(id).unwrap().fills.first() {
        Some(Paint::Solid { color, .. }) => Some(color.clone()),
        _ => None,
      })
      .collect();
    assert!(colors.contains(&"#B8A6FF".to_string()), "{colors:?}");
  }

  #[test]
  fn boolean_subtract_makes_one_vector_with_a_hole() {
    let mut e = engine();
    let outer = rect(&mut e, 0.0, 0.0, 100.0, 100.0, None);
    let inner = rect(&mut e, 25.0, 25.0, 50.0, 50.0, None);
    e.doc.get_mut(&outer).unwrap().fills = vec![Paint::solid("#FF0000")];
    let r = e
      .dispatch(Command::BooleanOp {
        ids: vec![inner.clone(), outer.clone()],
        operation: crate::paths::BoolOp::Subtract,
      })
      .unwrap();
    let id = id_of(&r);
    let n = e.doc.get(&id).unwrap();
    assert_eq!(n.kind, NodeType::Vector);
    assert_eq!(n.vector.as_ref().unwrap().subpaths.len(), 2, "outer contour + hole");
    assert_eq!((n.x, n.y, n.width, n.height), (0.0, 0.0, 100.0, 100.0));
    assert!(
      matches!(&n.fills[0], Paint::Solid { color, .. } if color == "#FF0000"),
      "bottom layer's style"
    );
    assert!(e.doc.get(&outer).is_none() && e.doc.get(&inner).is_none());
    e.dispatch(Command::Undo).unwrap();
    assert!(e.doc.get(&outer).is_some() && e.doc.get(&id).is_none());
  }

  #[test]
  fn flatten_and_outline_stroke() {
    let mut e = engine();
    let a = rect(&mut e, 0.0, 0.0, 10.0, 10.0, None);
    let b = id_of(
      &e.dispatch(Command::CreateShape {
        kind: NodeType::Ellipse,
        x: 20.0,
        y: 0.0,
        width: 10.0,
        height: 10.0,
        parent: None,
      })
      .unwrap(),
    );
    let flat = id_of(&e.dispatch(Command::Flatten { ids: vec![a, b] }).unwrap());
    let n = e.doc.get(&flat).unwrap();
    assert_eq!(n.vector.as_ref().unwrap().subpaths.len(), 2);
    assert_eq!(n.width, 30.0);

    let s = rect(&mut e, 0.0, 50.0, 40.0, 40.0, None);
    {
      let n = e.doc.get_mut(&s).unwrap();
      n.fills.clear();
      n.strokes = vec![Paint::solid("#000000")];
      n.stroke_weight = 4.0;
      n.stroke_align = crate::model::StrokeAlign::Inside;
    }
    let r = e.dispatch(Command::OutlineStroke { ids: vec![s.clone()] }).unwrap();
    let out = r["ids"][0].as_str().unwrap().to_string();
    let v = e.doc.get(&out).unwrap();
    assert!(e.doc.get(&s).is_none(), "a stroke-only layer is replaced");
    assert_eq!(
      (v.x, v.y, v.width, v.height),
      (0.0, 50.0, 40.0, 40.0),
      "inside stroke stays within the box"
    );
    assert!(v.strokes.is_empty() && !v.fills.is_empty());
  }

  #[test]
  fn use_as_mask_groups_and_masks_siblings_above() {
    let mut e = engine();
    let m = id_of(
      &e.dispatch(Command::CreateShape {
        kind: NodeType::Ellipse,
        x: 0.0,
        y: 0.0,
        width: 50.0,
        height: 50.0,
        parent: None,
      })
      .unwrap(),
    );
    let img = rect(&mut e, 0.0, 0.0, 80.0, 80.0, None);
    let g = id_of(&e.dispatch(Command::UseAsMask { ids: vec![img, m.clone()] }).unwrap());
    assert!(e.doc.get(&m).unwrap().is_mask);
    assert_eq!(e.doc.get(&g).unwrap().children[0], m);
    let page = e.page.clone();
    let svg = e.render(&page, &[], None);
    assert!(svg.contains("<mask id=") && svg.contains("mask=\"url(#"), "{svg}");
  }

  #[test]
  fn moves_snap_to_ruler_guides() {
    let mut e = engine();
    let id = rect(&mut e, 1000.0, 1000.0, 50.0, 50.0, None);
    e.dispatch(Command::SetGuides {
      page: None,
      guides: vec![RulerGuide {
        axis: crate::model::Axis::X,
        position: 1104.0,
      }],
    })
    .unwrap();
    // Right edge lands 2px short of the guide and snaps onto it.
    let r = e
      .dispatch(Command::Translate {
        ids: vec![id.clone()],
        dx: 52.0,
        dy: 0.0,
        snap: true,
        zoom: 1.0,
        axis: None,
      })
      .unwrap();
    assert_eq!(e.doc.get(&id).unwrap().x, 1054.0, "{r}");
    e.dispatch(Command::Undo).unwrap();
    e.dispatch(Command::Undo).unwrap();
    assert!(e.doc.page(&e.page).unwrap().guides.is_empty(), "guides are undoable");
  }

  #[test]
  fn translate_reports_equal_gaps_and_measure_query_uses_the_selection() {
    let mut e = engine();
    let a = rect(&mut e, -300.0, -300.0, 100.0, 100.0, None);
    let b = rect(&mut e, -100.0, -260.0, 80.0, 60.0, None);
    let c = rect(&mut e, 100.0, -300.0, 60.0, 60.0, None);
    e.dispatch(Command::Select {
      ids: vec![b.clone()],
      mode: SelectMode::Replace,
    })
    .unwrap();
    let r = e
      .dispatch(Command::Translate {
        ids: vec![b.clone()],
        dx: 7.0,
        dy: 0.0,
        snap: true,
        zoom: 1.0,
        axis: None,
      })
      .unwrap();
    assert_eq!(e.doc.get(&b).unwrap().x, -90.0, "{r}");
    assert_eq!(r["gaps"].as_array().map(|g| g.len()), Some(2), "{r}");
    // Alt-hover over A from the selected B: horizontal distance to A and the vertical one.
    let m = e
      .query(Query::Measure {
        ids: vec![],
        target: None,
        x: -250.0,
        y: -250.0,
        zoom: 1.0,
      })
      .unwrap();
    assert_eq!(m["target"], json!(a));
    assert_eq!(m["lines"].as_array().map(|l| l.len()), Some(2), "{m}");
    // Hovering the selection itself, or an explicit target, behaves as expected.
    let own = e
      .query(Query::Measure {
        ids: vec![],
        target: None,
        x: -50.0,
        y: -70.0,
        zoom: 1.0,
      })
      .unwrap();
    assert!(own.is_null(), "{own}");
    // The hover the editor picked, with the pointer on it.
    let t = e
      .query(Query::Measure {
        ids: vec![],
        target: Some(c),
        x: 130.0,
        y: -270.0,
        zoom: 1.0,
      })
      .unwrap();
    assert_eq!(t["lines"][0]["value"], json!(110.0), "{t}");
  }

  fn resize_east(e: &mut Engine, id: &str, dx: f64, from_center: bool, keep_aspect: bool) -> Value {
    e.dispatch(Command::BeginGesture).unwrap();
    let r = e
      .dispatch(Command::Resize {
        ids: vec![id.to_string()],
        handle: Handle::E,
        dx,
        dy: 0.0,
        keep_aspect,
        from_center,
        snap: true,
        zoom: 1.0,
        scale: false,
      })
      .unwrap();
    e.dispatch(Command::CancelGesture).unwrap();
    r
  }

  #[test]
  fn resize_spacing_snaps_only_free_edge_resizes() {
    let mut e = engine();
    let a = rect(&mut e, 0.0, 0.0, 50.0, 50.0, None);
    let b = rect(&mut e, 90.0, 0.0, 50.0, 50.0, None);
    let _c = rect(&mut e, 260.0, 0.0, 50.0, 50.0, None);
    // From an edge the right side lands on the equal 40px gap (width 130).
    let r = resize_east(&mut e, &b, 77.0, false, false);
    assert_eq!(r["gaps"].as_array().map(|g| g.len()), Some(2), "{r}");
    // From the centre or with the aspect locked the moving edges aren't the whole story: no spacing.
    for (centre, aspect) in [(true, false), (false, true)] {
      let r = resize_east(&mut e, &b, 77.0, centre, aspect);
      assert_eq!(
        r["gaps"].as_array().map(|g| g.len()),
        Some(0),
        "centre {centre} aspect {aspect}: {r}"
      );
    }
    let _ = a;
  }

  #[test]
  fn resize_of_an_auto_layout_child_has_no_spacing_snap() {
    let mut e = engine();
    ai(
      &mut e,
      "create_nodes",
      json!({ "nodes": [{ "type": "frame", "name": "F", "x": 0, "y": 0, "width": 400, "height": 100,
        "layout": { "direction": "horizontal", "gap": 10, "padding": 10 },
        "children": [
          { "type": "rectangle", "name": "a", "width": 50, "height": 50 },
          { "type": "rectangle", "name": "b", "width": 50, "height": 50 },
          { "type": "rectangle", "name": "c", "width": 50, "height": 50 } ] }] }),
    );
    let b = e.doc.nodes.values().find(|n| n.name == "b").unwrap().id.clone();
    // +2px would otherwise "snap" back to the 10px gap and show false markers.
    let r = resize_east(&mut e, &b, 2.0, false, false);
    assert_eq!(r["gaps"].as_array().map(|g| g.len()), Some(0), "{r}");
  }

  #[test]
  fn moves_snap_to_layout_grid_columns() {
    let mut e = engine();
    let frame = id_of(
      &e.dispatch(Command::CreateShape {
        kind: NodeType::Frame,
        x: 0.0,
        y: 0.0,
        width: 1000.0,
        height: 600.0,
        parent: None,
      })
      .unwrap(),
    );
    e.doc.get_mut(&frame).unwrap().layout_grids = vec![crate::model::LayoutGrid {
      count: 4,
      gutter: 20.0,
      margin: 40.0,
      ..Default::default()
    }];
    let child = rect(&mut e, 300.0, 300.0, 20.0, 20.0, Some(frame.clone()));
    // Column 2 starts at 40 + 215 + 20 = 275; move the left edge to 277.
    e.dispatch(Command::Translate {
      ids: vec![child.clone()],
      dx: -23.0,
      dy: 0.0,
      snap: true,
      zoom: 1.0,
      axis: None,
    })
    .unwrap();
    assert_eq!(e.doc.abs_bounds(&child).x, 275.0);
    let overlay = e.query(Query::GridOverlay { page: None }).unwrap();
    assert_eq!(overlay[0]["bands"].as_array().unwrap().len(), 4);
  }

  #[test]
  fn layer_names_match_the_full_scan_through_edits_and_undo() {
    // The count `next_name` replaced: every layer whose name starts with the base.
    let scan = |e: &Engine, base: &str| format!("{base} {}", e.doc.nodes.values().filter(|n| n.name.starts_with(base)).count() + 1);
    let check = |e: &Engine, step: &str| {
      for base in ["Rectangle", "Ellipse", "Text", "Rect", "R", "Frame", "Copy", ""] {
        assert_eq!(e.doc.next_name(base), scan(e, base), "{step}: base {base:?}");
      }
    };
    let mut e = engine();
    check(&e, "empty");
    let a = rect(&mut e, 0.0, 0.0, 10.0, 10.0, None);
    let b = rect(&mut e, 20.0, 0.0, 10.0, 10.0, None);
    check(&e, "created");
    let name = e.doc.next_name("Rectangle");
    assert_eq!(name, "Rectangle 3");
    e.dispatch(Command::Update {
      ids: vec![a.clone()],
      patch: json!({ "name": "Rect copy" }),
    })
    .unwrap();
    check(&e, "renamed");
    e.dispatch(Command::Duplicate { ids: vec![b.clone()] }).unwrap();
    check(&e, "duplicated");
    e.dispatch(Command::Delete { ids: vec![b.clone()] }).unwrap();
    check(&e, "deleted");
    e.dispatch(Command::Undo).unwrap();
    check(&e, "undone delete");
    e.dispatch(Command::Undo).unwrap();
    e.dispatch(Command::Undo).unwrap();
    check(&e, "undone rename");
    e.dispatch(Command::Redo).unwrap();
    check(&e, "redone");
    ai(
      &mut e,
      "create_nodes",
      json!({ "nodes": [{ "type": "text", "text": "Hi" }, { "type": "text", "text": "Yo" }, { "type": "ellipse" }, { "type": "ellipse", "name": "Ellipse 9" }] }),
    );
    check(&e, "ai created");
    // Different bases asked in between keep their own counts as the document changes.
    assert_eq!(e.doc.next_name("Ellipse"), scan(&e, "Ellipse"));
    rect(&mut e, 0.0, 50.0, 10.0, 10.0, None);
    assert_eq!(e.doc.next_name("Ellipse"), scan(&e, "Ellipse"));
    // Loading another document, a clone and a remote change all start from the right count.
    let snapshot: Value = serde_json::from_str(&e.to_json()).unwrap();
    assert!(snapshot.get("names").is_none(), "the cache is not saved");
    let copy = e.doc.clone();
    e.dispatch(Command::Delete { ids: vec![a] }).unwrap();
    assert_eq!(
      copy.next_name("Rect"),
      scan(
        &Engine {
          doc: copy.clone(),
          ..engine()
        },
        "Rect"
      )
    );
    check(&e, "deleted again");
    e.dispatch(Command::ReplaceDocument {
      doc: snapshot,
      keep_comments: false,
    })
    .unwrap();
    check(&e, "replaced");
    e.dispatch(Command::Undo).unwrap();
    check(&e, "undone replace");
  }

  fn comment(e: &mut Engine, node: Option<&str>, x: f64, y: f64) -> String {
    let r = e
      .dispatch(Command::AddComment {
        page: None,
        x,
        y,
        node: node.map(String::from),
        text: "hi".into(),
        author: "a".into(),
        time: 1.0,
      })
      .unwrap();
    r["id"].as_str().unwrap().to_string()
  }

  #[test]
  fn restore_with_keep_comments_keeps_every_comment() {
    let mut e = engine();
    let snapshot: Value = serde_json::from_str(&e.to_json()).unwrap();
    let kept = rect(&mut e, 100.0, 50.0, 10.0, 10.0, None);
    let on_layer = comment(&mut e, Some(&kept), 103.0, 54.0);
    let on_page = comment(&mut e, None, 7.0, 8.0);
    e.dispatch(Command::ReplaceDocument {
      doc: snapshot.clone(),
      keep_comments: true,
    })
    .unwrap();
    assert!(e.doc.get(&kept).is_none());
    assert_eq!(e.doc.comments.len(), 2);
    let c = &e.doc.comments[&on_layer];
    assert_eq!(
      (c.node.clone(), c.x, c.y),
      (None, 103.0, 54.0),
      "orphan: page comment at its old spot"
    );
    assert_eq!((e.doc.comments[&on_page].x, e.doc.comments[&on_page].y), (7.0, 8.0));
    // Undoing the restore brings the layer back and leaves the comments alone.
    e.dispatch(Command::Undo).unwrap();
    assert!(e.doc.get(&kept).is_some());
    assert_eq!(e.doc.comments.len(), 2);
    assert_eq!(e.doc.comments[&on_layer].node.as_deref(), Some(kept.as_str()));
    // Without the flag the comments go with the document.
    e.dispatch(Command::ReplaceDocument {
      doc: snapshot,
      keep_comments: false,
    })
    .unwrap();
    assert!(e.doc.comments.is_empty());
  }

  #[test]
  fn replace_document_is_undoable() {
    let mut e = engine();
    let before = e.to_json();
    let id = rect(&mut e, 0.0, 0.0, 10.0, 10.0, None);
    let snapshot: Value = serde_json::from_str(&before).unwrap();
    e.dispatch(Command::ReplaceDocument {
      doc: snapshot,
      keep_comments: false,
    })
    .unwrap();
    assert!(e.doc.get(&id).is_none());
    e.dispatch(Command::Undo).unwrap();
    assert!(e.doc.get(&id).is_some());
  }

  #[test]
  fn create_undo_redo() {
    let mut e = engine();
    let r = e
      .dispatch(Command::CreateShape {
        kind: NodeType::Rectangle,
        x: 10.0,
        y: 10.0,
        width: 50.0,
        height: 50.0,
        parent: None,
      })
      .unwrap();
    let id = id_of(&r);
    assert!(e.doc.get(&id).is_some());
    e.dispatch(Command::Undo).unwrap();
    assert!(e.doc.get(&id).is_none());
    e.dispatch(Command::Redo).unwrap();
    assert!(e.doc.get(&id).is_some());
  }

  #[test]
  fn gesture_is_one_undo_step_and_relative() {
    let mut e = engine();
    let id = id_of(
      &e.dispatch(Command::CreateShape {
        kind: NodeType::Rectangle,
        x: 0.0,
        y: 0.0,
        width: 50.0,
        height: 50.0,
        parent: None,
      })
      .unwrap(),
    );
    e.dispatch(Command::BeginGesture).unwrap();
    for i in 1..=10 {
      e.dispatch(Command::Translate {
        ids: vec![id.clone()],
        dx: i as f64 * 10.0,
        dy: 0.0,
        snap: false,
        zoom: 1.0,
        axis: None,
      })
      .unwrap();
    }
    e.dispatch(Command::EndGesture).unwrap();
    assert_eq!(e.doc.get(&id).unwrap().x, 100.0);
    e.dispatch(Command::Undo).unwrap();
    assert_eq!(e.doc.get(&id).unwrap().x, 0.0);
  }

  /// A frame with a shadow, a column grid and a stroke, and a second frame to link.
  fn styled_frames(e: &mut Engine) -> (String, String) {
    let mut frame = |x: f64| {
      id_of(
        &e.dispatch(Command::CreateShape {
          kind: NodeType::Frame,
          x,
          y: 0.0,
          width: 100.0,
          height: 100.0,
          parent: None,
        })
        .unwrap(),
      )
    };
    let (a, b) = (frame(0.0), frame(200.0));
    e.dispatch(Command::Update {
      ids: vec![a.clone()],
      patch: json!({
        "effects": [{ "type": "dropShadow", "blur": 12 }],
        "layoutGrids": [{ "pattern": "columns", "count": 4 }],
        "strokes": [{ "type": "solid", "color": "#112233" }],
        "strokeWeight": 2,
      }),
    })
    .unwrap();
    (a, b)
  }

  #[test]
  fn effect_styles_link_update_detach_and_delete() {
    let mut e = engine();
    let (a, b) = styled_frames(&mut e);
    let id = id_of(
      &e.dispatch(Command::AddEffectStyle {
        name: "Shadow/Card".into(),
        from: a.clone(),
        description: "Cards".into(),
      })
      .unwrap(),
    );
    assert_eq!(e.doc.get(&a).unwrap().effect_style.as_deref(), Some(id.as_str()));
    e.dispatch(Command::ApplyStyle {
      ids: vec![b.clone()],
      style_id: id.clone(),
      kind: None,
    })
    .unwrap();
    assert_eq!(e.doc.get(&b).unwrap().effects, e.doc.get(&a).unwrap().effects);
    let before_b = e.doc.get(&b).unwrap().clone();
    let big = vec![crate::model::Effect {
      blur: 40.0,
      ..Default::default()
    }];
    e.dispatch(Command::UpdateEffectStyle {
      id: id.clone(),
      name: None,
      effects: Some(big.clone()),
      description: None,
    })
    .unwrap();
    for n in [&a, &b] {
      assert_eq!(e.doc.get(n).unwrap().effects, big);
    }
    let after_b = e.doc.get(&b).unwrap().clone();
    assert_eq!(
      Node {
        effects: before_b.effects.clone(),
        ..after_b
      },
      before_b,
      "nothing but the effects changed"
    );
    // Editing a linked layer's effects by hand detaches it; other edits keep the link.
    e.dispatch(Command::Update {
      ids: vec![b.clone()],
      patch: json!({ "opacity": 0.5 }),
    })
    .unwrap();
    assert!(e.doc.get(&b).unwrap().effect_style.is_some());
    e.dispatch(Command::Update {
      ids: vec![b.clone()],
      patch: json!({ "effects": [] }),
    })
    .unwrap();
    assert!(e.doc.get(&b).unwrap().effect_style.is_none());
    assert!(e.doc.get(&a).unwrap().effect_style.is_some());
    // Deleting the style unlinks and keeps the values.
    e.dispatch(Command::DeleteStyle { id: id.clone() }).unwrap();
    assert!(e.doc.styles.effects.is_empty());
    let n = e.doc.get(&a).unwrap();
    assert!(n.effect_style.is_none() && n.effects == big);
    // Detach keeps the values too.
    let id2 = id_of(
      &e.dispatch(Command::AddEffectStyle {
        name: "S2".into(),
        from: a.clone(),
        description: String::new(),
      })
      .unwrap(),
    );
    e.dispatch(Command::DetachStyle {
      ids: vec![a.clone()],
      style_id: id2,
      kind: None,
    })
    .unwrap();
    assert!(e.doc.get(&a).unwrap().effect_style.is_none());
    assert!(
      e.dispatch(Command::AddEffectStyle {
        name: "x".into(),
        from: b,
        description: String::new()
      })
      .is_err(),
      "no effects to save"
    );
  }

  #[test]
  fn grid_and_stroke_styles_follow_the_same_rules() {
    let mut e = engine();
    let (a, b) = styled_frames(&mut e);
    let g = id_of(
      &e.dispatch(Command::AddGridStyle {
        name: "Grid/4".into(),
        from: a.clone(),
        description: String::new(),
      })
      .unwrap(),
    );
    e.dispatch(Command::ApplyStyle {
      ids: vec![b.clone()],
      style_id: g.clone(),
      kind: None,
    })
    .unwrap();
    assert_eq!(e.doc.get(&b).unwrap().layout_grids.len(), 1);
    e.dispatch(Command::UpdateGridStyle {
      id: g.clone(),
      name: None,
      grids: Some(vec![crate::model::LayoutGrid {
        count: 6,
        ..Default::default()
      }]),
      description: None,
    })
    .unwrap();
    assert_eq!(e.doc.get(&a).unwrap().layout_grids[0].count, 6);
    assert_eq!(e.doc.get(&b).unwrap().layout_grids[0].count, 6);
    e.dispatch(Command::Update {
      ids: vec![b.clone()],
      patch: json!({ "layoutGrids": [] }),
    })
    .unwrap();
    assert!(e.doc.get(&b).unwrap().grid_style.is_none());
    // A colour style applied as a stroke links `stroke_style`, not `fill_style`.
    let c = id_of(
      &e.dispatch(Command::AddColorStyle {
        name: "Brand".into(),
        color: "#FF0000".into(),
      })
      .unwrap(),
    );
    e.dispatch(Command::ApplyStyle {
      ids: vec![b.clone()],
      style_id: c.clone(),
      kind: Some("stroke".into()),
    })
    .unwrap();
    let n = e.doc.get(&b).unwrap();
    assert_eq!(n.stroke_style.as_deref(), Some(c.as_str()));
    assert!(n.fill_style.is_none());
    assert_eq!(n.strokes, vec![Paint::solid("#FF0000")]);
    e.dispatch(Command::UpdateColorStyle {
      id: c.clone(),
      name: None,
      color: Some("#00FF00".into()),
    })
    .unwrap();
    assert_eq!(e.doc.get(&b).unwrap().strokes, vec![Paint::solid("#00FF00")]);
    assert_ne!(e.doc.get(&b).unwrap().fills, vec![Paint::solid("#00FF00")], "the fill is untouched");
    e.dispatch(Command::Update {
      ids: vec![b.clone()],
      patch: json!({ "strokes": [{ "type": "solid", "color": "#0000FF" }] }),
    })
    .unwrap();
    assert!(e.doc.get(&b).unwrap().stroke_style.is_none());
    e.dispatch(Command::ApplyStyle {
      ids: vec![b.clone()],
      style_id: c.clone(),
      kind: Some("stroke".into()),
    })
    .unwrap();
    e.dispatch(Command::DeleteStyle { id: c }).unwrap();
    let n = e.doc.get(&b).unwrap();
    assert!(n.stroke_style.is_none());
    assert_eq!(n.strokes, vec![Paint::solid("#00FF00")], "the stroke keeps its colour");
  }

  #[test]
  fn files_without_the_new_style_fields_round_trip_unchanged() {
    let mut e = engine();
    rect(&mut e, 0.0, 0.0, 10.0, 10.0, None);
    e.dispatch(Command::AddColorStyle {
      name: "A".into(),
      color: "#111111".into(),
    })
    .unwrap();
    let before = e.to_json();
    for k in [
      "effectStyle",
      "gridStyle",
      "strokeStyle",
      "\"effects\":[{",
      "\"grids\":[{",
      "scopes",
    ] {
      assert!(!before.contains(k), "{k} must not be written when unused");
    }
    let mut e2 = engine();
    e2.load(&before).unwrap();
    assert_eq!(e2.to_json(), before);
  }

  /// A component with one instance, and an effect style made from a shadowed frame.
  fn instance_with_style() -> (Engine, String, String, String) {
    let mut e = engine();
    let (shadowed, _) = styled_frames(&mut e);
    let style = id_of(
      &e.dispatch(Command::AddEffectStyle {
        name: "Shadow".into(),
        from: shadowed,
        description: String::new(),
      })
      .unwrap(),
    );
    let f = id_of(
      &e.dispatch(Command::CreateShape {
        kind: NodeType::Frame,
        x: 0.0,
        y: 500.0,
        width: 100.0,
        height: 40.0,
        parent: None,
      })
      .unwrap(),
    );
    let comp = id_of(&e.dispatch(Command::CreateComponent { ids: vec![f] }).unwrap());
    let inst = place(&mut e, &comp, 300.0, 500.0, None, false).unwrap();
    (e, comp, inst, style)
  }

  #[test]
  fn a_style_applied_to_an_instance_survives_edits_of_the_main() {
    let (mut e, comp, inst, style) = instance_with_style();
    e.dispatch(Command::ApplyStyle {
      ids: vec![inst.clone()],
      style_id: style.clone(),
      kind: None,
    })
    .unwrap();
    let want = e.doc.get(&inst).unwrap().effects.clone();
    assert!(!want.is_empty());
    e.dispatch(Command::Update {
      ids: vec![comp],
      patch: json!({ "cornerRadius": 8 }),
    })
    .unwrap();
    let n = e.doc.get(&inst).unwrap();
    assert_eq!(
      (n.effect_style.as_deref(), &n.effects),
      (Some(style.as_str()), &want),
      "the link and its effects stay"
    );
  }

  #[test]
  fn detaching_a_style_on_an_instance_survives_edits_of_the_main() {
    let (mut e, comp, inst, style) = instance_with_style();
    e.dispatch(Command::ApplyStyle {
      ids: vec![comp.clone()],
      style_id: style,
      kind: None,
    })
    .unwrap();
    assert!(e.doc.get(&inst).unwrap().effect_style.is_some(), "the instance follows the main");
    e.dispatch(Command::Update {
      ids: vec![inst.clone()],
      patch: json!({ "effects": [] }),
    })
    .unwrap();
    assert!(e.doc.get(&inst).unwrap().effect_style.is_none());
    e.dispatch(Command::Update {
      ids: vec![comp],
      patch: json!({ "cornerRadius": 8 }),
    })
    .unwrap();
    let n = e.doc.get(&inst).unwrap();
    assert!(n.effect_style.is_none() && n.effects.is_empty(), "a main edit doesn't relink it");
  }

  #[test]
  fn outlining_a_stroke_unlinks_the_stroke_style_and_propagation_never_adds_strokes() {
    let mut e = engine();
    let (a, b) = styled_frames(&mut e);
    let c = id_of(
      &e.dispatch(Command::AddColorStyle {
        name: "Ink".into(),
        color: "#FF0000".into(),
      })
      .unwrap(),
    );
    e.dispatch(Command::ApplyStyle {
      ids: vec![a.clone()],
      style_id: c.clone(),
      kind: Some("stroke".into()),
    })
    .unwrap();
    e.dispatch(Command::OutlineStroke { ids: vec![a.clone()] }).unwrap();
    let n = e.doc.get(&a).unwrap();
    assert!(
      n.stroke_style.is_none() && n.strokes.is_empty(),
      "the kept original has no stroke and no link"
    );
    // Recolouring the style doesn't give the stroke-less layers a stroke.
    e.dispatch(Command::UpdateColorStyle {
      id: c,
      name: None,
      color: Some("#00FF00".into()),
    })
    .unwrap();
    assert!(e.doc.get(&a).unwrap().strokes.is_empty() && e.doc.get(&b).unwrap().strokes.is_empty());
  }

  #[test]
  fn updating_a_text_style_keeps_its_id_and_updates_its_layers() {
    let mut e = engine();
    let t = id_of(
      &e.dispatch(Command::CreateText {
        x: 0.0,
        y: 0.0,
        characters: "Heading".into(),
        parent: None,
      })
      .unwrap(),
    );
    e.doc.styles.texts.push(crate::model::TextStyle {
      id: "ts1".into(),
      name: "H1".into(),
      font_family: "Inter".into(),
      font_size: 32.0,
      font_weight: 700,
      line_height: None,
      letter_spacing: 0.0,
    });
    e.dispatch(Command::ApplyStyle {
      ids: vec![t.clone()],
      style_id: "ts1".into(),
      kind: None,
    })
    .unwrap();
    e.dispatch(Command::UpdateTextStyle {
      id: "ts1".into(),
      name: Some("Display".into()),
      font_family: None,
      font_size: Some(48.0),
      font_weight: None,
      line_height: Some(56.0),
      auto_line_height: false,
      letter_spacing: None,
    })
    .unwrap();
    let s = &e.doc.styles.texts[0];
    assert_eq!((s.id.as_str(), s.name.as_str(), s.font_size), ("ts1", "Display", 48.0));
    let tp = e.doc.get(&t).unwrap().text.clone().unwrap();
    assert_eq!((tp.font_size, tp.font_weight, tp.line_height), (48.0, 700, Some(56.0)));
    e.dispatch(Command::Undo).unwrap();
    assert_eq!(e.doc.get(&t).unwrap().text.as_ref().unwrap().font_size, 32.0);
  }

  #[test]
  fn rebased_gesture_moves_new_layers_and_undoes_in_one_step() {
    // Alt-drag: the copy is made inside the gesture, then the gesture is rebased so the
    // drag moves it; one undo removes the whole thing.
    let mut e = engine();
    e.dispatch(Command::BeginGesture).unwrap();
    let id = id_of(
      &e.dispatch(Command::CreateShape {
        kind: NodeType::Rectangle,
        x: 0.0,
        y: 0.0,
        width: 50.0,
        height: 50.0,
        parent: None,
      })
      .unwrap(),
    );
    e.dispatch(Command::RebaseGesture).unwrap();
    for i in 1..=3 {
      e.dispatch(Command::Translate {
        ids: vec![id.clone()],
        dx: i as f64 * 20.0,
        dy: 0.0,
        snap: false,
        zoom: 1.0,
        axis: None,
      })
      .unwrap();
    }
    e.dispatch(Command::EndGesture).unwrap();
    assert_eq!(e.doc.get(&id).unwrap().x, 60.0);
    e.dispatch(Command::Undo).unwrap();
    assert!(e.doc.get(&id).is_none());
    assert!(e.past.is_empty());
  }

  #[test]
  fn shapes_drawn_inside_frames_are_parented() {
    let mut e = engine();
    let f = id_of(
      &e.dispatch(Command::CreateShape {
        kind: NodeType::Frame,
        x: 100.0,
        y: 100.0,
        width: 400.0,
        height: 400.0,
        parent: None,
      })
      .unwrap(),
    );
    let r = id_of(
      &e.dispatch(Command::CreateShape {
        kind: NodeType::Rectangle,
        x: 150.0,
        y: 150.0,
        width: 10.0,
        height: 10.0,
        parent: None,
      })
      .unwrap(),
    );
    assert_eq!(e.doc.get(&r).unwrap().parent.as_deref(), Some(f.as_str()));
    assert_eq!(e.doc.get(&r).unwrap().x, 50.0);
  }

  fn frame_with_fill(e: &mut Engine, fill: &str) -> String {
    let f = id_of(
      &e.dispatch(Command::CreateShape {
        kind: NodeType::Frame,
        x: 100.0,
        y: 100.0,
        width: 200.0,
        height: 200.0,
        parent: None,
      })
      .unwrap(),
    );
    e.doc.get_mut(&f).unwrap().fills = vec![Paint::solid(fill)];
    f
  }

  #[test]
  fn image_takes_the_frame_under_its_centre() {
    let mut e = engine();
    let f = frame_with_fill(&mut e, "#FFFFFF");
    let mk = |e: &mut Engine, x: f64| {
      id_of(
        &e.dispatch(Command::CreateImage {
          src: "asset:a".into(),
          x,
          y: 150.0,
          width: 300.0,
          height: 100.0,
          name: None,
          parent: None,
        })
        .unwrap(),
      )
    };
    // Top-left inside the frame, centre outside: stays top-level.
    let out = mk(&mut e, 250.0);
    assert_eq!(e.doc.get(&out).unwrap().parent, None);
    // Top-left outside, centre inside: joins the frame.
    let inside = mk(&mut e, -20.0);
    assert_eq!(e.doc.get(&inside).unwrap().parent.as_deref(), Some(f.as_str()));
  }

  #[test]
  fn importing_an_svg_is_one_undo_step_and_a_refusal_changes_nothing() {
    let mut e = engine();
    let svg = r##"<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#000"><path d="M2 2L22 22"/><circle cx="12" cy="12" r="5"/></svg>"##;
    let before = e.doc.clone();
    let r = e
      .dispatch(Command::ImportSvg {
        svg: svg.into(),
        x: 100.0,
        y: 100.0,
        parent: None,
        name: Some("icon".into()),
      })
      .unwrap();
    let id = id_of(&r);
    let frame = e.doc.get(&id).unwrap();
    assert_eq!(
      (frame.name.as_str(), frame.x, frame.y, frame.children.len()),
      ("icon", 88.0, 88.0, 2)
    );
    assert_eq!(e.selection, vec![id.clone()]);
    let kids = e.doc.subtree(&id);
    assert_eq!(kids.len(), 3);
    assert!(kids.iter().all(|k| e.doc.get(k).unwrap().page == e.page));
    e.dispatch(Command::Undo).unwrap();
    assert_eq!(e.doc, before, "one undo removes the frame and its layers");
    e.dispatch(Command::Redo).unwrap();
    assert!(e.doc.get(&id).is_some());
    // Refused markup: an error naming why, and the document is untouched.
    let doc = e.doc.clone();
    let err = e
      .dispatch(Command::ImportSvg {
        svg: "<svg width='9' height='9'><text>hi</text></svg>".into(),
        x: 0.0,
        y: 0.0,
        parent: None,
        name: None,
      })
      .unwrap_err();
    assert_eq!(err, "text");
    assert_eq!(e.doc, doc);
  }

  #[test]
  fn an_imported_svg_lands_inside_the_frame_under_its_centre() {
    let mut e = engine();
    let f = id_of(
      &e.dispatch(Command::CreateShape {
        kind: NodeType::Frame,
        x: 0.0,
        y: 0.0,
        width: 400.0,
        height: 400.0,
        parent: None,
      })
      .unwrap(),
    );
    let id = id_of(
      &e.dispatch(Command::ImportSvg {
        svg: r#"<svg width="20" height="20"><rect width="20" height="20"/></svg>"#.into(),
        x: 50.0,
        y: 60.0,
        parent: None,
        name: None,
      })
      .unwrap(),
    );
    let n = e.doc.get(&id).unwrap();
    assert_eq!((n.parent.as_deref(), n.x, n.y), (Some(f.as_str()), 40.0, 50.0));
  }

  #[test]
  fn new_text_is_white_on_a_dark_backdrop_only() {
    let mut e = engine();
    let dark = frame_with_fill(&mut e, "#000000");
    let text = |e: &mut Engine, chars: &str| {
      id_of(
        &e.dispatch(Command::CreateText {
          x: 120.0,
          y: 120.0,
          characters: chars.into(),
          parent: None,
        })
        .unwrap(),
      )
    };
    let t = text(&mut e, "");
    assert_eq!(e.doc.get(&t).unwrap().parent.as_deref(), Some(dark.as_str()));
    assert_eq!(e.doc.get(&t).unwrap().fills, vec![Paint::solid("#FFFFFF")]);
    let typed = text(&mut e, "Pasted");
    assert_eq!(e.doc.get(&typed).unwrap().fills, vec![Paint::solid("#000000")]);
    e.doc.get_mut(&dark).unwrap().fills = vec![Paint::solid("#FFFFFF")];
    let t2 = text(&mut e, "");
    assert_eq!(e.doc.get(&t2).unwrap().fills, vec![Paint::solid("#000000")]);
  }

  #[test]
  fn copy_paste_roundtrip() {
    let mut e = engine();
    let f = id_of(
      &e.dispatch(Command::CreateShape {
        kind: NodeType::Frame,
        x: 100.0,
        y: 100.0,
        width: 200.0,
        height: 200.0,
        parent: None,
      })
      .unwrap(),
    );
    e.dispatch(Command::CreateText {
      x: 120.0,
      y: 120.0,
      characters: "Hello".into(),
      parent: None,
    })
    .unwrap();
    let data = e.copy(std::slice::from_ref(&f));
    let res = e
      .dispatch(Command::Paste {
        data,
        parent: None,
        x: Some(500.0),
        y: Some(100.0),
      })
      .unwrap();
    let new_id = res["created"][0].as_str().unwrap().to_string();
    let n = e.doc.get(&new_id).unwrap();
    assert_eq!((n.x, n.y), (500.0, 100.0));
    assert_eq!(n.children.len(), 1);
    assert_ne!(n.children[0], e.doc.get(&f).unwrap().children[0]);
  }

  #[test]
  fn pasting_an_instance_into_another_file_brings_its_component() {
    let mut src = engine();
    let f = id_of(
      &src
        .dispatch(Command::CreateShape {
          kind: NodeType::Frame,
          x: 0.0,
          y: 0.0,
          width: 100.0,
          height: 40.0,
          parent: None,
        })
        .unwrap(),
    );
    rect(&mut src, 10.0, 10.0, 20.0, 20.0, Some(f.clone()));
    src.doc.get_mut(&f).unwrap().fills = vec![Paint::solid("#FF0000")];
    let comp = id_of(&src.dispatch(Command::CreateComponent { ids: vec![f] }).unwrap());
    let inst = id_of(
      &src
        .dispatch(Command::CreateInstance {
          component_id: comp.clone(),
          x: 300.0,
          y: 0.0,
          parent: None,
          anchor: None,
          into_components: false,
        })
        .unwrap(),
    );
    let data = src.copy(std::slice::from_ref(&inst));

    let mut dst = Engine::new(Box::new(HeuristicMeasurer), 7);
    rect(&mut dst, 0.0, 0.0, 500.0, 200.0, None);
    let paste = |e: &mut Engine, data: &str| {
      let r = e
        .dispatch(Command::Paste {
          data: data.to_string(),
          parent: None,
          x: Some(50.0),
          y: Some(50.0),
        })
        .unwrap();
      r["created"][0].as_str().unwrap().to_string()
    };
    let pasted = paste(&mut dst, &data);
    let main = dst.doc.get(&pasted).unwrap().instance.clone().unwrap().component_id;
    let m = dst.doc.get(&main).expect("main component pasted along");
    assert_eq!(m.kind, NodeType::Component);
    assert_eq!(m.page, dst.page);
    assert!(dst.doc.abs_bounds(&main).x >= 550.0, "placed off to the side of the content");
    assert_eq!(dst.doc.get(&pasted).unwrap().fills, vec![Paint::solid("#FF0000")]);
    // A second paste reuses it, and it drives the instances like any main component.
    paste(&mut dst, &data);
    assert_eq!(dst.doc.components().len(), 1);
    dst
      .dispatch(Command::Update {
        ids: vec![main],
        patch: json!({ "fills": [{ "type": "solid", "color": "#00FF00" }] }),
      })
      .unwrap();
    assert_eq!(dst.doc.get(&pasted).unwrap().fills, vec![Paint::solid("#00FF00")]);

    // Without the component in the clipboard the instance is detached, keeping its look.
    let mut old: Value = serde_json::from_str(&data).unwrap();
    old.as_object_mut().unwrap().remove("components");
    let mut other = Engine::new(Box::new(HeuristicMeasurer), 9);
    let pasted = paste(&mut other, &old.to_string());
    let n = other.doc.get(&pasted).unwrap();
    assert_eq!((n.kind, n.instance.is_none()), (NodeType::Frame, true));
    assert_eq!(n.fills, vec![Paint::solid("#FF0000")]);
    assert!(other.doc.components().is_empty());
  }

  #[test]
  fn instance_updates_when_component_changes() {
    let mut e = engine();
    let f = id_of(
      &e.dispatch(Command::CreateShape {
        kind: NodeType::Frame,
        x: 0.0,
        y: 0.0,
        width: 100.0,
        height: 40.0,
        parent: None,
      })
      .unwrap(),
    );
    let comp = id_of(&e.dispatch(Command::CreateComponent { ids: vec![f] }).unwrap());
    let inst = id_of(
      &e.dispatch(Command::CreateInstance {
        component_id: comp.clone(),
        x: 300.0,
        y: 0.0,
        parent: None,
        anchor: None,
        into_components: false,
      })
      .unwrap(),
    );
    e.dispatch(Command::Update {
      ids: vec![comp.clone()],
      patch: json!({ "fills": [{ "type": "solid", "color": "#FF0000" }] }),
    })
    .unwrap();
    assert_eq!(e.doc.get(&inst).unwrap().fills, vec![Paint::solid("#FF0000")]);
    // Instance override of fill survives further component edits.
    e.dispatch(Command::Update {
      ids: vec![inst.clone()],
      patch: json!({ "fills": [{ "type": "solid", "color": "#00FF00" }] }),
    })
    .unwrap();
    e.dispatch(Command::Update {
      ids: vec![comp],
      patch: json!({ "cornerRadius": 8 }),
    })
    .unwrap();
    let i = e.doc.get(&inst).unwrap();
    assert_eq!(i.fills, vec![Paint::solid("#00FF00")]);
    assert_eq!(i.corner_radius, 8.0);
    assert_eq!(i.x, 300.0);
  }

  #[test]
  fn styled_text_survives_typing() {
    let mut e = engine();
    let id = id_of(
      &e.dispatch(Command::CreateText {
        x: 0.0,
        y: 0.0,
        characters: "Hello world".into(),
        parent: None,
      })
      .unwrap(),
    );
    e.dispatch(Command::StyleText {
      id: id.clone(),
      start: 6,
      end: 11,
      style: json!({ "fontWeight": 700, "color": "#ff0000" }),
      clear: vec![],
    })
    .unwrap();
    // Typing happens one edit at a time: insert at the start, then append.
    e.dispatch(Command::SetText {
      id: id.clone(),
      characters: "Oh, Hello world".into(),
    })
    .unwrap();
    e.dispatch(Command::SetText {
      id: id.clone(),
      characters: "Oh, Hello world!".into(),
    })
    .unwrap();
    let t = e.doc.get(&id).unwrap().text.clone().unwrap();
    assert_eq!(t.runs.len(), 1);
    assert_eq!((t.runs[0].start, t.runs[0].end), (10, 16));
    // Typing letter by letter keeps the name in step with the text.
    assert_eq!(e.doc.get(&id).unwrap().name, "Oh, Hello world!");
    assert_eq!(t.runs[0].color.as_deref(), Some("#FF0000"));
    // Styling everything folds into the base style and removes conflicting runs.
    e.dispatch(Command::StyleText {
      id: id.clone(),
      start: 0,
      end: 99,
      style: json!({ "fontWeight": 300 }),
      clear: vec![],
    })
    .unwrap();
    let t = e.doc.get(&id).unwrap().text.clone().unwrap();
    assert_eq!(t.font_weight, 300);
    assert!(t.runs.iter().all(|r| r.font_weight.is_none()));
    let svg = e.render(&e.page.clone(), &[], None);
    assert!(svg.contains("fill=\"#FF0000\""));
  }

  #[test]
  fn resizing_a_selection_past_its_edge_flips() {
    let mut e = engine();
    let a = rect(&mut e, 0.0, 0.0, 50.0, 50.0, None);
    let b = rect(&mut e, 100.0, 0.0, 50.0, 50.0, None);
    e.dispatch(Command::Resize {
      ids: vec![a.clone(), b.clone()],
      handle: Handle::E,
      dx: -200.0,
      dy: 0.0,
      keep_aspect: false,
      from_center: false,
      snap: false,
      zoom: 1.0,
      scale: false,
    })
    .unwrap();
    let u = e.doc.bounds_of_many(&[a, b]).unwrap();
    assert!((u.x + 50.0).abs() < 0.02 && (u.width - 50.0).abs() < 0.02, "{u:?}");
  }

  #[test]
  fn layer_text_style_overrides_styled_ranges() {
    let mut e = engine();
    let id = id_of(
      &e.dispatch(Command::CreateText {
        x: 0.0,
        y: 0.0,
        characters: "Hello bold world".into(),
        parent: None,
      })
      .unwrap(),
    );
    e.dispatch(Command::StyleText {
      id: id.clone(),
      start: 6,
      end: 10,
      style: json!({ "fontWeight": 700, "fontSize": 32, "italic": true, "color": "#FF0000" }),
      clear: vec![],
    })
    .unwrap();
    let update = |e: &mut Engine, patch: Value| {
      e.dispatch(Command::Update {
        ids: vec![id.clone()],
        patch,
      })
      .unwrap()
    };
    update(
      &mut e,
      json!({ "text": { "fontWeight": 400, "fontSize": 18, "fontFamily": "Roboto" } }),
    );
    let t = e.doc.get(&id).unwrap().text.clone().unwrap();
    assert_eq!((t.font_weight, t.font_size, t.font_family.as_str()), (400, 18.0, "Roboto"));
    assert_eq!(t.runs.len(), 1, "the run keeps what the layer didn't set");
    let run = &t.runs[0];
    assert_eq!((run.font_weight, run.font_size, run.font_family.clone()), (None, None, None));
    assert_eq!((run.italic, run.color.as_deref()), (Some(true), Some("#FF0000")));
    // A layer fill recolours every range; runs left with no overrides are dropped.
    update(&mut e, json!({ "fills": [{ "type": "solid", "color": "#00FF00" }] }));
    assert_eq!(e.doc.get(&id).unwrap().text.as_ref().unwrap().runs[0].color, None);
    update(&mut e, json!({ "text": { "italic": false } }));
    assert!(e.doc.get(&id).unwrap().text.as_ref().unwrap().runs.is_empty());
  }

  #[test]
  fn removing_auto_layout_makes_fill_children_fixed() {
    let mut e = engine();
    let a = rect(&mut e, 0.0, 0.0, 50.0, 50.0, None);
    let b = rect(&mut e, 100.0, 0.0, 50.0, 50.0, None);
    let f = id_of(
      &e.dispatch(Command::AddAutoLayout {
        ids: vec![a.clone(), b.clone()],
      })
      .unwrap(),
    );
    update_ids(&mut e, vec![f.clone()], json!({ "sizingH": "fixed", "width": 300 }));
    update_ids(&mut e, vec![a.clone()], json!({ "sizingH": "fill", "sizingV": "fill" }));
    let w = e.doc.get(&a).unwrap().width;
    assert!(w > 100.0, "fill child stretched: {w}");
    e.dispatch(Command::RemoveAutoLayout { ids: vec![f.clone()] }).unwrap();
    let c = e.doc.get(&a).unwrap();
    assert_eq!((c.sizing_h, c.sizing_v), (Sizing::Fixed, Sizing::Fixed), "no hidden fill");
    assert_eq!(c.width, w, "keeps the size it had");
    let fr = e.doc.get(&f).unwrap();
    assert!(fr.layout.is_none());
    assert_eq!((fr.sizing_h, fr.sizing_v), (Sizing::Fixed, Sizing::Fixed));
    // Undo brings the layout and the fill sizing back in one step.
    e.dispatch(Command::Undo).unwrap();
    assert_eq!(e.doc.get(&a).unwrap().sizing_h, Sizing::Fill);
    assert!(e.doc.get(&f).unwrap().layout.is_some());
  }

  #[test]
  fn removing_auto_layout_keeps_fill_in_an_auto_layout_parent() {
    let mut e = engine();
    let a = rect(&mut e, 0.0, 0.0, 50.0, 50.0, None);
    let inner = id_of(&e.dispatch(Command::AddAutoLayout { ids: vec![a.clone()] }).unwrap());
    let other = rect(&mut e, 200.0, 0.0, 50.0, 50.0, None);
    let outer = id_of(
      &e.dispatch(Command::AddAutoLayout {
        ids: vec![inner.clone(), other],
      })
      .unwrap(),
    );
    update_ids(&mut e, vec![inner.clone()], json!({ "sizingH": "fill" }));
    e.dispatch(Command::RemoveAutoLayout { ids: vec![inner.clone()] }).unwrap();
    assert!(e.doc.get(&outer).unwrap().layout.is_some());
    assert_eq!(e.doc.get(&inner).unwrap().sizing_h, Sizing::Fill, "still fills its parent");
    assert_eq!(e.doc.get(&inner).unwrap().sizing_v, Sizing::Fixed);
  }

  #[test]
  fn text_links_are_restricted_to_safe_urls() {
    let mut e = engine();
    let id = id_of(
      &e.dispatch(Command::CreateText {
        x: 0.0,
        y: 0.0,
        characters: "Read the docs now".into(),
        parent: None,
      })
      .unwrap(),
    );
    let link = |e: &mut Engine, start: usize, end: usize, url: &str| {
      e.dispatch(Command::StyleText {
        id: id.clone(),
        start,
        end,
        style: json!({ "link": url }),
        clear: vec![],
      })
    };
    for bad in [
      "javascript:alert(1)",
      "data:text/html,x",
      "file:///etc/passwd",
      "ftp://x",
      "example.com",
    ] {
      assert!(link(&mut e, 9, 13, bad).is_err(), "{bad}");
    }
    assert!(e.doc.get(&id).unwrap().text.as_ref().unwrap().runs.is_empty());
    link(&mut e, 9, 13, " https://example.com/docs ").unwrap();
    let t = e.doc.get(&id).unwrap().text.clone().unwrap();
    assert_eq!(t.runs.len(), 1);
    assert_eq!((t.runs[0].start, t.runs[0].end), (9, 13));
    assert_eq!(t.runs[0].link.as_deref(), Some("https://example.com/docs"));
    // The whole text can carry a link too, and it can be removed again.
    link(&mut e, 0, 99, "mailto:hi@example.com").unwrap();
    let t = e.doc.get(&id).unwrap().text.clone().unwrap();
    assert_eq!((t.runs[0].start, t.runs[0].end), (0, 17));
    e.dispatch(Command::StyleText {
      id: id.clone(),
      start: 0,
      end: 17,
      style: json!({}),
      clear: vec!["link".into()],
    })
    .unwrap();
    assert!(e.doc.get(&id).unwrap().text.as_ref().unwrap().runs.is_empty());
    // A raw patch (AI tool, plugin, peer) can't plant a script link either.
    update_ids(
      &mut e,
      vec![id.clone()],
      json!({ "text": { "runs": [
        { "start": 0, "end": 4, "link": "javascript:alert(1)" },
        { "start": 5, "end": 8, "link": "tel:+123", "fontWeight": 700 }
      ] } }),
    );
    let t = e.doc.get(&id).unwrap().text.clone().unwrap();
    assert_eq!(t.runs.len(), 1);
    assert_eq!(t.runs[0].link.as_deref(), Some("tel:+123"));
  }

  #[test]
  fn unsafe_links_never_reach_instance_overrides_or_create_nodes() {
    let mut e = engine();
    // create_nodes spans are checked.
    let r = e.dispatch(Command::Ai {
      tool: "create_nodes".into(),
      input: json!({ "nodes": [{ "type": "text", "name": "Bad", "spans": [{ "text": "x", "link": "javascript:alert(1)" }] }] }),
    });
    assert!(r.is_err(), "{r:?}");
    let ok = ai(
      &mut e,
      "create_nodes",
      json!({ "nodes": [{ "type": "text", "name": "Good", "spans": [{ "text": "go", "link": "https://example.com" }] }] }),
    );
    let good = ok["created"][0]["id"].as_str().or(ok["created"][0].as_str()).unwrap().to_string();
    assert_eq!(
      e.doc.get(&good).unwrap().text.as_ref().unwrap().runs[0].link.as_deref(),
      Some("https://example.com")
    );
    // A patch on a layer inside an instance is stored as an override: it must be clean first.
    let comp = id_of(
      &e.dispatch(Command::CreateText {
        x: 0.0,
        y: 0.0,
        characters: "Label".into(),
        parent: None,
      })
      .unwrap(),
    );
    let main = id_of(&e.dispatch(Command::CreateComponent { ids: vec![comp] }).unwrap());
    let inst = id_of(
      &e.dispatch(Command::CreateInstance {
        component_id: main,
        x: 300.0,
        y: 0.0,
        parent: None,
        anchor: None,
        into_components: false,
      })
      .unwrap(),
    );
    let inner = e.doc.get(&inst).unwrap().children[0].clone();
    update_ids(
      &mut e,
      vec![inner.clone()],
      json!({ "text": { "runs": [{ "start": 0, "end": 3, "link": "javascript:alert(1)" }, { "start": 3, "end": 5, "link": "tel:+1" }] } }),
    );
    let stored = serde_json::to_string(&e.doc.get(&inst).unwrap().instance).unwrap();
    assert!(!stored.contains("javascript"), "{stored}");
    assert!(stored.contains("tel:+1"), "{stored}");
    assert!(!serde_json::to_string(&e.doc.get(&inner).unwrap().text)
      .unwrap()
      .contains("javascript"));
  }

  /// A hugging main "Card" holding one text, and an instance of it.
  fn hug_main(e: &mut Engine) -> (String, String, String) {
    let text = id_of(
      &e.dispatch(Command::CreateText {
        x: 0.0,
        y: 0.0,
        characters: "Hi".into(),
        parent: None,
      })
      .unwrap(),
    );
    let frame = id_of(&e.dispatch(Command::AddAutoLayout { ids: vec![text.clone()] }).unwrap());
    let main = id_of(&e.dispatch(Command::CreateComponent { ids: vec![frame] }).unwrap());
    let inst = id_of(
      &e.dispatch(Command::CreateInstance {
        component_id: main.clone(),
        x: 400.0,
        y: 0.0,
        parent: None,
        anchor: None,
        into_components: false,
      })
      .unwrap(),
    );
    (main, inst, text)
  }

  #[test]
  fn an_instance_of_a_hugging_main_hugs_and_follows_the_main_in_the_same_edit() {
    let mut e = engine();
    let (main, inst, text) = hug_main(&mut e);
    let i = e.doc.get(&inst).unwrap();
    assert_eq!((i.sizing_h, i.sizing_v), (Sizing::Hug, Sizing::Hug));
    // A second instance, set to fixed sizing, copies the main's size all the same.
    let fixed = id_of(
      &e.dispatch(Command::CreateInstance {
        component_id: main.clone(),
        x: 400.0,
        y: 200.0,
        parent: None,
        anchor: None,
        into_components: false,
      })
      .unwrap(),
    );
    update_ids(&mut e, vec![fixed.clone()], json!({ "sizingH": "fixed" }));
    update_ids(
      &mut e,
      vec![text],
      json!({ "text": { "characters": "A much longer label than before" } }),
    );
    let w = e.doc.get(&main).unwrap().width;
    assert!(w > 100.0, "main hugged its new text: {w}");
    assert_eq!(e.doc.get(&inst).unwrap().width, w, "hug instance is not one edit behind");
    assert_eq!(e.doc.get(&fixed).unwrap().width, w, "fixed instance is not one edit behind");
  }

  #[test]
  fn an_instance_of_a_variant_is_named_after_its_set() {
    let mut e = engine();
    let a = rect(&mut e, 0.0, 0.0, 50.0, 20.0, None);
    let b = rect(&mut e, 100.0, 0.0, 50.0, 20.0, None);
    let a = id_of(&e.dispatch(Command::CreateComponent { ids: vec![a] }).unwrap());
    let b = id_of(&e.dispatch(Command::CreateComponent { ids: vec![b] }).unwrap());
    update_ids(&mut e, vec![a.clone()], json!({ "name": "Style=Primary" }));
    update_ids(&mut e, vec![b.clone()], json!({ "name": "Style=Ghost" }));
    let set = id_of(&e.dispatch(Command::CombineVariants { ids: vec![a.clone(), b] }).unwrap());
    update_ids(&mut e, vec![set.clone()], json!({ "name": "Button" }));
    let inst = id_of(
      &e.dispatch(Command::CreateInstance {
        component_id: a,
        x: 400.0,
        y: 0.0,
        parent: None,
        anchor: None,
        into_components: false,
      })
      .unwrap(),
    );
    assert_eq!(e.doc.get(&inst).unwrap().name, "Button");
  }

  #[test]
  fn add_auto_layout_on_an_empty_frame_keeps_its_size() {
    let mut e = engine();
    let f = id_of(
      &e.dispatch(Command::CreateShape {
        kind: NodeType::Frame,
        x: 0.0,
        y: 0.0,
        width: 320.0,
        height: 200.0,
        parent: None,
      })
      .unwrap(),
    );
    e.dispatch(Command::AddAutoLayout { ids: vec![f.clone()] }).unwrap();
    let n = e.doc.get(&f).unwrap();
    assert!(n.layout.is_some());
    assert_eq!((n.width, n.height), (320.0, 200.0));
    assert_eq!((n.sizing_h, n.sizing_v), (Sizing::Fixed, Sizing::Fixed));
  }

  #[test]
  fn an_axis_locked_translate_keeps_the_locked_delta_at_zero_under_snapping() {
    let mut e = engine();
    let a = rect(&mut e, 0.0, 0.0, 50.0, 50.0, None);
    // Another layer whose top edge sits 3 px below A's: a free move would snap to it.
    rect(&mut e, 200.0, 3.0, 50.0, 50.0, None);
    let r = e
      .dispatch(Command::Translate {
        ids: vec![a.clone()],
        dx: 120.0,
        dy: 0.0,
        snap: true,
        zoom: 1.0,
        axis: Some(Axis::X),
      })
      .unwrap();
    assert_eq!(r["dy"], json!(0.0), "{r}");
    assert_eq!(e.doc.get(&a).unwrap().y, 0.0);
    assert_eq!(e.doc.get(&a).unwrap().x, 120.0);
    // The same move without the lock snaps to the neighbour's top edge.
    let r = e
      .dispatch(Command::Translate {
        ids: vec![a.clone()],
        dx: 120.0,
        dy: 0.0,
        snap: true,
        zoom: 1.0,
        axis: None,
      })
      .unwrap();
    assert_eq!(r["dy"], json!(3.0), "{r}");
    // `axis` is optional in the wire format.
    let c: Command = serde_json::from_value(json!({ "op": "translate", "ids": [a], "dx": 1.0, "dy": 2.0 })).unwrap();
    assert!(matches!(c, Command::Translate { axis: None, .. }));
  }

  #[test]
  fn truncation_renders_an_ellipsis() {
    let mut e = engine();
    let id = id_of(
      &e.dispatch(Command::CreateText {
        x: 0.0,
        y: 0.0,
        characters: "one two three four five six seven eight nine ten eleven twelve".into(),
        parent: None,
      })
      .unwrap(),
    );
    update_ids(
      &mut e,
      vec![id.clone()],
      json!({ "width": 100, "text": { "autoResize": "height" } }),
    );
    let tall = e.doc.get(&id).unwrap().height;
    update_ids(&mut e, vec![id.clone()], json!({ "text": { "maxLines": 2 } }));
    let n = e.doc.get(&id).unwrap();
    assert_eq!(n.height, (2.0_f64 * 16.0 * 1.2).ceil(), "two lines tall");
    assert!(n.height < tall);
    let svg = e.render(&e.page.clone(), &[], None);
    assert!(svg.contains('\u{2026}'), "{svg}");
    // Clearing the limit brings the text back.
    update_ids(&mut e, vec![id.clone()], json!({ "text": { "maxLines": null } }));
    assert_eq!(e.doc.get(&id).unwrap().height, tall);
    assert!(!e.render(&e.page.clone(), &[], None).contains('\u{2026}'));
  }

  #[test]
  fn editing_text_renders_every_line_without_an_ellipsis() {
    let mut e = engine();
    let id = id_of(
      &e.dispatch(Command::CreateText {
        x: 0.0,
        y: 0.0,
        characters: "one two three four five six seven eight nine ten eleven twelve".into(),
        parent: None,
      })
      .unwrap(),
    );
    update_ids(
      &mut e,
      vec![id.clone()],
      json!({ "width": 100, "text": { "autoResize": "height", "maxLines": 1 } }),
    );
    let page = e.page.clone();
    let cut = e.render(&page, &[], None);
    assert!(cut.contains('\u{2026}'));
    let live = e.render(&page, &[], Some(&id));
    assert!(!live.contains('\u{2026}'), "{live}");
    assert!(!live.contains("visibility=\"hidden\""), "editing text stays visible");
    assert!(live.contains("twelve"));
  }

  #[test]
  fn render_incremental_repaints_the_root_when_editing_changes() {
    let mut e = engine();
    let id = id_of(
      &e.dispatch(Command::CreateText {
        x: 0.0,
        y: 0.0,
        characters: "one two three four five six seven eight".into(),
        parent: None,
      })
      .unwrap(),
    );
    update_ids(
      &mut e,
      vec![id.clone()],
      json!({ "width": 60, "text": { "autoResize": "height", "maxLines": 1 } }),
    );
    let page = e.page.clone();
    let first = e.render_incremental(&page, &[], None);
    assert!(first["changed"][&id].as_str().unwrap().contains('\u{2026}'));
    let quiet = e.render_incremental(&page, &[], None);
    assert!(quiet["changed"].as_object().unwrap().is_empty());
    let start = e.render_incremental(&page, &[], Some(&id));
    assert!(!start["changed"][&id].as_str().unwrap().contains('\u{2026}'), "{start}");
    let same = e.render_incremental(&page, &[], Some(&id));
    assert!(same["changed"].as_object().unwrap().is_empty());
    let end = e.render_incremental(&page, &[], None);
    assert!(end["changed"][&id].as_str().unwrap().contains('\u{2026}'));
  }

  #[test]
  fn text_layout_query_has_the_caret_geometry_shape() {
    let mut e = engine();
    let id = id_of(
      &e.dispatch(Command::CreateText {
        x: 0.0,
        y: 0.0,
        characters: "ab\ncd".into(),
        parent: None,
      })
      .unwrap(),
    );
    let v = e
      .query(Query::TextLayout {
        id: id.clone(),
        from: None,
        to: None,
      })
      .unwrap();
    let lines = v["lines"].as_array().unwrap();
    assert_eq!(lines.len(), 2, "{v}");
    assert_eq!((lines[0]["start"].as_u64(), lines[0]["end"].as_u64()), (Some(0), Some(2)));
    assert_eq!((lines[1]["start"].as_u64(), lines[1]["end"].as_u64()), (Some(3), Some(5)));
    assert_eq!(lines[0]["xs"].as_array().unwrap().len(), 3);
    assert!(lines[1]["top"].as_f64().unwrap() > 0.0 && v["height"].as_f64().unwrap() > 0.0);
    assert!(e
      .query(Query::TextLayout {
        id: "nope".into(),
        from: None,
        to: None
      })
      .unwrap()
      .is_null());
  }

  #[test]
  fn set_text_stores_line_breaks_as_newlines() {
    let mut e = engine();
    let id = id_of(
      &e.dispatch(Command::CreateText {
        x: 0.0,
        y: 0.0,
        characters: "".into(),
        parent: None,
      })
      .unwrap(),
    );
    e.dispatch(Command::SetText {
      id: id.clone(),
      characters: "ab\r\ncd\ref".into(),
    })
    .unwrap();
    assert_eq!(e.doc.get(&id).unwrap().text.as_ref().unwrap().characters, "ab\ncd\nef");
  }

  #[test]
  fn set_text_names_the_layer_from_the_trimmed_text() {
    let mut e = engine();
    let id = id_of(
      &e.dispatch(Command::CreateText {
        x: 0.0,
        y: 0.0,
        characters: "".into(),
        parent: None,
      })
      .unwrap(),
    );
    e.dispatch(Command::SetText {
      id: id.clone(),
      characters: " plus".into(),
    })
    .unwrap();
    assert_eq!(e.doc.get(&id).unwrap().name, "plus");
  }

  #[test]
  fn auto_layout_reorders_on_drag() {
    let mut e = engine();
    let a = id_of(
      &e.dispatch(Command::CreateShape {
        kind: NodeType::Rectangle,
        x: 0.0,
        y: 0.0,
        width: 50.0,
        height: 50.0,
        parent: None,
      })
      .unwrap(),
    );
    let b = id_of(
      &e.dispatch(Command::CreateShape {
        kind: NodeType::Rectangle,
        x: 100.0,
        y: 0.0,
        width: 50.0,
        height: 50.0,
        parent: None,
      })
      .unwrap(),
    );
    let f = id_of(
      &e.dispatch(Command::AddAutoLayout {
        ids: vec![a.clone(), b.clone()],
      })
      .unwrap(),
    );
    assert_eq!(
      e.doc.get(&f).unwrap().layout.as_ref().unwrap().direction,
      LayoutDirection::Horizontal
    );
    e.dispatch(Command::BeginGesture).unwrap();
    e.dispatch(Command::Translate {
      ids: vec![a.clone()],
      dx: 80.0,
      dy: 0.0,
      snap: true,
      zoom: 1.0,
      axis: None,
    })
    .unwrap();
    e.dispatch(Command::EndGesture).unwrap();
    assert_eq!(e.doc.get(&f).unwrap().children, vec![b, a]);
  }

  /// Q's fixture: a 300 px wrap frame (gap 10, padding 10) with six 60x40 tiles, four to a row.
  fn wrap_fixture() -> (Engine, String, Vec<String>) {
    let mut e = engine();
    let tiles: Vec<String> = (0..6)
      .map(|i| rect(&mut e, 20.0 + i as f64 * 70.0, 20.0, 60.0, 40.0, None))
      .collect();
    let f = id_of(&e.dispatch(Command::AddAutoLayout { ids: tiles.clone() }).unwrap());
    update_ids(
      &mut e,
      vec![f.clone()],
      json!({ "width": 300, "sizingH": "fixed", "layout": { "wrap": true, "gap": 10, "counterGap": 10,
        "paddingLeft": 10, "paddingRight": 10, "paddingTop": 10, "paddingBottom": 10 } }),
    );
    (e, f, tiles)
  }

  fn drag_onto(e: &mut Engine, id: &str, target: &str) {
    let (from, to) = (e.doc.abs_bounds(id).center(), e.doc.abs_bounds(target).center());
    e.dispatch(Command::BeginGesture).unwrap();
    e.dispatch(Command::Translate {
      ids: vec![id.to_string()],
      dx: to.x - from.x,
      dy: to.y - from.y,
      snap: false,
      zoom: 1.0,
      axis: None,
    })
    .unwrap();
    e.dispatch(Command::DropInto {
      ids: vec![id.to_string()],
      x: to.x,
      y: to.y,
    })
    .unwrap();
    e.dispatch(Command::EndGesture).unwrap();
  }

  #[test]
  fn wrap_reorder_follows_the_row_under_the_pointer() {
    let (mut e, f, t) = wrap_fixture();
    assert_eq!(e.doc.get(&t[4]).unwrap().y, 60.0, "T5 starts the second row");
    drag_onto(&mut e, &t[0], &t[5]);
    let order = |e: &Engine| e.doc.get(&f).unwrap().children.clone();
    assert_eq!(
      order(&e),
      vec![t[1].clone(), t[2].clone(), t[3].clone(), t[4].clone(), t[0].clone(), t[5].clone()]
    );
    // Onto T5 (first of row two) it goes in front of it.
    let (mut e, f, t) = wrap_fixture();
    drag_onto(&mut e, &t[0], &t[4]);
    assert_eq!(
      e.doc.get(&f).unwrap().children,
      vec![t[1].clone(), t[2].clone(), t[3].clone(), t[0].clone(), t[4].clone(), t[5].clone()]
    );
    // Dragging up to the first row moves back.
    drag_onto(&mut e, &t[5], &t[1]);
    assert_eq!(e.doc.get(&f).unwrap().children[0], t[5]);
  }

  #[test]
  fn drop_into_a_wrap_frame_inserts_at_the_row_and_column() {
    let (mut e, f, t) = wrap_fixture();
    let free = rect(&mut e, 600.0, 0.0, 30.0, 30.0, None);
    let p = e.doc.abs_bounds(&t[4]).center();
    e.dispatch(Command::DropInto {
      ids: vec![free.clone()],
      x: p.x,
      y: p.y,
    })
    .unwrap();
    let kids = e.doc.get(&f).unwrap().children.clone();
    assert_eq!(kids.iter().position(|k| *k == free), Some(4), "in front of T5: {kids:?}");
  }

  #[test]
  fn drop_slot_gives_the_index_and_a_line_for_layers_entering() {
    let (mut e, f, t) = wrap_fixture();
    let free = rect(&mut e, 600.0, 0.0, 30.0, 30.0, None);
    // Between T4 (end of row one) and T5 (start of row two): in front of T5, at the row's left.
    let t5 = e.doc.abs_bounds(&t[4]);
    let r = slot_at(&e, vec![free.clone()], t5.x + 5.0, t5.y + 20.0);
    assert_eq!(r["frame"], json!(f));
    assert_eq!(r["index"], 4);
    let l: Vec<f64> = r["line"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
    assert_eq!(l[0], l[2], "vertical line");
    assert!(l[0] < t5.x && l[1] <= t5.y && l[3] >= t5.bottom() - 0.01, "{l:?}");
    // Between T2 and T3 the line sits in the gap and spans the row.
    let (a, b) = (e.doc.abs_bounds(&t[1]), e.doc.abs_bounds(&t[2]));
    let r = slot_at(&e, vec![free.clone()], b.x + 1.0, b.y + 5.0);
    assert_eq!(r["index"], 2);
    assert!((r["line"][0].as_f64().unwrap() - (a.right() + b.x) / 2.0).abs() < 1e-6);
    // Layers already in the frame reorder with the live reflow instead, and a plain frame has no slot.
    let q = slot_at(&e, vec![t[0].clone()], b.x, b.y);
    assert!(q.is_null());
    let plain = id_of(
      &e.dispatch(Command::CreateShape {
        kind: NodeType::Frame,
        x: 800.0,
        y: 0.0,
        width: 200.0,
        height: 200.0,
        parent: None,
      })
      .unwrap(),
    );
    let _ = plain;
    assert!(slot_at(&e, vec![free], 850.0, 50.0).is_null());
  }

  #[test]
  fn column_and_single_row_reorders_are_unchanged() {
    let mut e = engine();
    let a = rect(&mut e, 0.0, 0.0, 50.0, 50.0, None);
    let b = rect(&mut e, 0.0, 100.0, 50.0, 50.0, None);
    let c = rect(&mut e, 0.0, 200.0, 50.0, 50.0, None);
    let list = id_of(
      &e.dispatch(Command::AddAutoLayout {
        ids: vec![a.clone(), b.clone(), c.clone()],
      })
      .unwrap(),
    );
    update_ids(&mut e, vec![list.clone()], json!({ "layout": { "direction": "vertical" } }));
    drag_onto(&mut e, &a, &c);
    assert_eq!(e.doc.get(&list).unwrap().children, vec![b, a, c]);
  }

  #[test]
  fn typing_a_group_size_scales_its_children() {
    let mut e = engine();
    let a = rect(&mut e, 0.0, 0.0, 100.0, 40.0, None);
    let b = rect(&mut e, 140.0, 0.0, 100.0, 40.0, None);
    let g = id_of(
      &e.dispatch(Command::Group {
        ids: vec![a.clone(), b.clone()],
      })
      .unwrap(),
    );
    assert_eq!(e.doc.get(&g).unwrap().width, 240.0);
    update_ids(&mut e, vec![g.clone()], json!({ "width": 400 }));
    assert_eq!(e.doc.get(&g).unwrap().width, 400.0);
    let (na, nb) = (e.doc.get(&a).unwrap(), e.doc.get(&b).unwrap());
    assert!((na.width - 100.0 * 400.0 / 240.0).abs() < 1e-6);
    assert!((nb.x - 140.0 * 400.0 / 240.0).abs() < 1e-6);
    update_ids(&mut e, vec![g.clone()], json!({ "height": 80 }));
    assert_eq!((e.doc.get(&g).unwrap().height, e.doc.get(&a).unwrap().height), (80.0, 80.0));
    e.dispatch(Command::Undo).unwrap();
    assert_eq!(e.doc.get(&g).unwrap().height, 40.0);
    e.dispatch(Command::Undo).unwrap();
    assert_eq!((e.doc.get(&g).unwrap().width, e.doc.get(&a).unwrap().width), (240.0, 100.0));
  }

  #[test]
  fn a_non_wrapping_row_reorders_by_x_whatever_the_heights() {
    let mut e = engine();
    let a = rect(&mut e, 0.0, 0.0, 40.0, 100.0, None);
    let b = rect(&mut e, 50.0, 0.0, 40.0, 30.0, None);
    let c = rect(&mut e, 100.0, 0.0, 40.0, 30.0, None);
    let f = id_of(
      &e.dispatch(Command::AddAutoLayout {
        ids: vec![a.clone(), b.clone(), c.clone()],
      })
      .unwrap(),
    );
    let gap_x = {
      let (bb, cb) = (e.doc.abs_bounds(&b), e.doc.abs_bounds(&c));
      (bb.right() + cb.x) / 2.0
    };
    let dx = gap_x - e.doc.abs_bounds(&a).center().x;
    e.dispatch(Command::BeginGesture).unwrap();
    // Straight along the row: the pointer is below the short layers' row, but it is still one row.
    e.dispatch(Command::Translate {
      ids: vec![a.clone()],
      dx,
      dy: 0.0,
      snap: false,
      zoom: 1.0,
      axis: None,
    })
    .unwrap();
    e.dispatch(Command::EndGesture).unwrap();
    assert_eq!(e.doc.get(&f).unwrap().children, vec![b.clone(), a.clone(), c.clone()]);
    // A free layer dropped in the frame's top padding goes by x too.
    let free = rect(&mut e, 600.0, 0.0, 10.0, 10.0, None);
    let top = e.doc.abs_bounds(&f).y;
    let x = e.doc.abs_bounds(&b).center().x - 1.0;
    e.dispatch(Command::DropInto {
      ids: vec![free.clone()],
      x,
      y: top + 1.0,
    })
    .unwrap();
    assert_eq!(e.doc.get(&f).unwrap().children, vec![free, b, a, c]);
  }

  #[test]
  fn full_width_wrap_rows_are_separate_rows() {
    let mut e = engine();
    let tiles: Vec<String> = (0..3)
      .map(|i| rect(&mut e, 10.0, 10.0 + i as f64 * 50.0, 280.0, 40.0, None))
      .collect();
    let f = id_of(&e.dispatch(Command::AddAutoLayout { ids: tiles.clone() }).unwrap());
    update_ids(
      &mut e,
      vec![f.clone()],
      json!({ "width": 300, "sizingH": "fixed", "layout": { "direction": "horizontal", "wrap": true, "gap": 10, "counterGap": 10,
        "paddingLeft": 10, "paddingRight": 10, "paddingTop": 10, "paddingBottom": 10 } }),
    );
    assert_eq!(e.doc.get(&tiles[2]).unwrap().y, 110.0);
    let free = rect(&mut e, 600.0, 0.0, 20.0, 20.0, None);
    let mid = e.doc.abs_bounds(&tiles[1]);
    for (x, want) in [(mid.x + 5.0, 1), (mid.right() - 5.0, 2)] {
      let r = slot_at(&e, vec![free.clone()], x, mid.y + 20.0);
      assert_eq!(r["index"], want, "x = {x}");
    }
  }

  #[test]
  fn dropping_several_layers_keeps_their_order() {
    let mut e = engine();
    let a = rect(&mut e, 0.0, 0.0, 50.0, 40.0, None);
    let b = rect(&mut e, 0.0, 50.0, 50.0, 40.0, None);
    let c = rect(&mut e, 0.0, 100.0, 50.0, 40.0, None);
    let list = id_of(
      &e.dispatch(Command::AddAutoLayout {
        ids: vec![a.clone(), b.clone(), c.clone()],
      })
      .unwrap(),
    );
    update_ids(
      &mut e,
      vec![list.clone()],
      json!({ "layout": { "direction": "vertical", "gap": 10 } }),
    );
    let (x1, x2) = (
      rect(&mut e, 400.0, 0.0, 20.0, 20.0, None),
      rect(&mut e, 430.0, 0.0, 20.0, 20.0, None),
    );
    let (ab, bb) = (e.doc.abs_bounds(&a), e.doc.abs_bounds(&b));
    let y = (ab.bottom() + bb.y) / 2.0;
    e.dispatch(Command::DropInto {
      ids: vec![x1.clone(), x2.clone()],
      x: ab.x + 10.0,
      y,
    })
    .unwrap();
    assert_eq!(
      e.doc.get(&list).unwrap().children,
      vec![a.clone(), x1.clone(), x2.clone(), b.clone(), c.clone()]
    );
    // One of the dragged layers already lives in the target: it stays, the other goes in front of C.
    let x3 = rect(&mut e, 500.0, 0.0, 20.0, 20.0, None);
    let cb = e.doc.abs_bounds(&c);
    let bb = e.doc.abs_bounds(&b);
    e.dispatch(Command::DropInto {
      ids: vec![b.clone(), x3.clone()],
      x: cb.x + 10.0,
      y: (bb.bottom() + cb.y) / 2.0,
    })
    .unwrap();
    assert_eq!(e.doc.get(&list).unwrap().children, vec![a, x1, x2, b, x3, c]);
  }

  #[test]
  fn typing_a_height_for_a_flat_group_keeps_its_zero_height() {
    let mut e = engine();
    let l1 = e
      .dispatch(Command::CreateShape {
        kind: NodeType::Line,
        x: 0.0,
        y: 0.0,
        width: 100.0,
        height: 0.0,
        parent: None,
      })
      .unwrap();
    let l2 = e
      .dispatch(Command::CreateShape {
        kind: NodeType::Line,
        x: 0.0,
        y: 0.0,
        width: 60.0,
        height: 0.0,
        parent: None,
      })
      .unwrap();
    let g = id_of(
      &e.dispatch(Command::Group {
        ids: vec![id_of(&l1), id_of(&l2)],
      })
      .unwrap(),
    );
    let flat = e.doc.get(&g).unwrap().height;
    assert!(flat < 1.0, "{flat}");
    update_ids(&mut e, vec![g.clone()], json!({ "width": 200 }));
    assert_eq!((e.doc.get(&g).unwrap().width, e.doc.get(&g).unwrap().height), (200.0, flat));
  }

  #[test]
  fn dragging_out_of_auto_layout_reparents() {
    let mut e = engine();
    let a = rect(&mut e, 0.0, 0.0, 50.0, 50.0, None);
    let b = rect(&mut e, 100.0, 0.0, 50.0, 50.0, None);
    let c = rect(&mut e, 200.0, 0.0, 50.0, 50.0, None);
    let list = id_of(
      &e.dispatch(Command::AddAutoLayout {
        ids: vec![a.clone(), b.clone(), c.clone()],
      })
      .unwrap(),
    );
    let target = id_of(
      &e.dispatch(Command::CreateShape {
        kind: NodeType::Frame,
        x: 400.0,
        y: 0.0,
        width: 300.0,
        height: 300.0,
        parent: None,
      })
      .unwrap(),
    );
    let drag = |e: &mut Engine, id: &str, dx: f64, dy: f64| {
      let from = e.doc.abs_bounds(id).center();
      e.dispatch(Command::BeginGesture).unwrap();
      e.dispatch(Command::Translate {
        ids: vec![id.to_string()],
        dx,
        dy,
        snap: false,
        zoom: 1.0,
        axis: None,
      })
      .unwrap();
      e.dispatch(Command::DropInto {
        ids: vec![id.to_string()],
        x: from.x + dx,
        y: from.y + dy,
      })
      .unwrap();
      e.dispatch(Command::EndGesture).unwrap();
    };
    // Into the frame under the pointer, where the drag put it.
    let start = e.doc.abs_bounds(&a);
    drag(&mut e, &a, 450.0, 100.0);
    assert_eq!(e.doc.get(&a).unwrap().parent.as_deref(), Some(target.as_str()));
    let end = e.doc.abs_bounds(&a);
    assert_eq!((end.x, end.y), (start.x + 450.0, start.y + 100.0));
    assert_eq!(e.doc.get(&list).unwrap().children, vec![b.clone(), c.clone()]);
    // Onto the empty page.
    let start = e.doc.abs_bounds(&b);
    drag(&mut e, &b, 0.0, 500.0);
    assert_eq!(e.doc.get(&b).unwrap().parent, None);
    assert_eq!(e.doc.abs_bounds(&b).y, start.y + 500.0);
    // Inside the parent it still only reorders.
    let d = rect(&mut e, 300.0, 0.0, 50.0, 50.0, None);
    e.dispatch(Command::MoveToParent {
      ids: vec![d.clone()],
      parent: Some(list.clone()),
      index: None,
    })
    .unwrap();
    drag(&mut e, &c, 80.0, 0.0);
    assert_eq!(e.doc.get(&list).unwrap().children, vec![d, c]);
  }

  mod vector_editing {
    use super::*;

    #[test]
    fn inserting_a_point_keeps_the_path_and_undoes() {
      let mut e = engine();
      let id = path(&mut e, false);
      let before = e.doc.get(&id).unwrap().clone();
      let d_before = crate::shapes::vector_d(&before);
      let r = e
        .dispatch(Command::InsertVectorPoint {
          id: id.clone(),
          sub: 0,
          seg: 0,
          t: 0.5,
        })
        .unwrap();
      assert_eq!(r["index"], 1);
      let n = e.doc.get(&id).unwrap();
      assert_eq!(points(&e, &id).len(), 4);
      assert_eq!((n.x, n.y, n.width, n.height), (before.x, before.y, before.width, before.height));
      assert_ne!(crate::shapes::vector_d(n), d_before);
      e.dispatch(Command::Undo).unwrap();
      assert_eq!(crate::shapes::vector_d(e.doc.get(&id).unwrap()), d_before);
      e.dispatch(Command::Redo).unwrap();
      assert_eq!(points(&e, &id).len(), 4);
    }

    #[test]
    fn deleting_points_refits_the_box_and_undoes() {
      let mut e = engine();
      let id = path(&mut e, false);
      let abs = |e: &Engine| {
        let m = e.doc.abs_matrix(&id);
        points(e, &id).iter().map(|p| m.apply(Point::new(p.x, p.y))).collect::<Vec<_>>()
      };
      let before = abs(&e);
      let r = e
        .dispatch(Command::DeleteVectorPoints {
          id: id.clone(),
          points: vec![[0, 1]],
        })
        .unwrap();
      assert_eq!(r["deleted"], false);
      let after = abs(&e);
      assert_eq!(after.len(), 2);
      for (a, b) in [before[0], before[2]].iter().zip(&after) {
        assert!((a.x - b.x).abs() < 1e-9 && (a.y - b.y).abs() < 1e-9, "points stay put on the page");
      }
      let n = e.doc.get(&id).unwrap();
      assert_eq!(
        (n.x, n.y, n.width, n.height),
        (100.0, 100.0, 100.0, 1.0),
        "box fits the shorter path"
      );
      e.dispatch(Command::Undo).unwrap();
      assert_eq!(points(&e, &id).len(), 3);
      assert_eq!(e.doc.get(&id).unwrap().height, 50.0);
    }

    #[test]
    fn deleting_a_closed_paths_point_keeps_it_closed() {
      let mut e = engine();
      let id = path(&mut e, true);
      e.dispatch(Command::InsertVectorPoint {
        id: id.clone(),
        sub: 0,
        seg: 2,
        t: 0.5,
      })
      .unwrap();
      e.dispatch(Command::DeleteVectorPoints {
        id: id.clone(),
        points: vec![[0, 1]],
      })
      .unwrap();
      let sp = &e.doc.get(&id).unwrap().vector.as_ref().unwrap().subpaths[0];
      assert!(sp.closed && sp.points.len() == 3);
    }

    #[test]
    fn deleting_all_but_one_point_deletes_the_layer() {
      let mut e = engine();
      let id = path(&mut e, false);
      let r = e
        .dispatch(Command::DeleteVectorPoints {
          id: id.clone(),
          points: vec![[0, 0], [0, 1]],
        })
        .unwrap();
      assert_eq!(r["deleted"], true);
      assert!(e.doc.get(&id).is_none());
      e.dispatch(Command::Undo).unwrap();
      assert_eq!(points(&e, &id).len(), 3);
    }

    #[test]
    fn smooth_move_and_extend_are_single_steps() {
      let mut e = engine();
      let id = path(&mut e, false);
      e.dispatch(Command::SetVectorPointsSmooth {
        id: id.clone(),
        points: vec![[0, 1]],
        smooth: true,
      })
      .unwrap();
      assert!(vector_edit::is_smooth(&points(&e, &id)[1]));
      e.dispatch(Command::MoveVectorPoints {
        id: id.clone(),
        points: vec![[0, 1]],
        dx: 0.0,
        dy: 10.0,
      })
      .unwrap();
      let m = e.doc.abs_matrix(&id);
      let p = points(&e, &id)[1];
      assert_eq!(m.apply(Point::new(p.x, p.y)), Point::new(150.0, 160.0));
      e.dispatch(Command::ExtendVector {
        id: id.clone(),
        sub: 0,
        prepend: false,
        points: vec![VectorPoint::at(200.0, 200.0)],
        close: true,
      })
      .unwrap();
      let sp = e.doc.get(&id).unwrap().vector.clone().unwrap().subpaths[0].clone();
      assert!(sp.closed && sp.points.len() == 4);
      assert_eq!(e.doc.get(&id).unwrap().y + e.doc.get(&id).unwrap().height, 200.0);
      for _ in 0..3 {
        e.dispatch(Command::Undo).unwrap();
      }
      assert!(!vector_edit::is_smooth(&points(&e, &id)[1]));
      assert_eq!(points(&e, &id).len(), 3);
    }

    #[test]
    fn segment_query_finds_the_path_under_the_pointer() {
      let mut e = engine();
      let id = path(&mut e, false);
      // The first segment runs from (100,100) to (150,150).
      let q = |e: &Engine, x: f64, y: f64, zoom: f64| {
        e.query(Query::VectorSegmentAt {
          id: id.clone(),
          x,
          y,
          zoom,
        })
        .unwrap()
      };
      let hit = q(&e, 127.0, 123.0, 1.0);
      assert_eq!((hit["sub"].as_u64(), hit["seg"].as_u64()), (Some(0), Some(0)));
      assert!((hit["t"].as_f64().unwrap() - 0.5).abs() < 1e-3, "{hit}");
      assert!((hit["x"].as_f64().unwrap() - 125.0).abs() < 1e-3);
      assert!(q(&e, 130.0, 120.0, 1.0).is_null());
      assert!(q(&e, 130.0, 120.0, 0.5).is_object(), "tolerance grows when zoomed out");
      assert!(q(&e, 140.0, 110.0, 1.0).is_null());
      e.dispatch(Command::InsertVectorPoint {
        id: id.clone(),
        sub: 0,
        seg: 0,
        t: hit["t"].as_f64().unwrap(),
      })
      .unwrap();
      let p = points(&e, &id)[1];
      let m = e.doc.abs_matrix(&id);
      let a = m.apply(Point::new(p.x, p.y));
      assert!((a.x - 125.0).abs() < 1e-3 && (a.y - 125.0).abs() < 1e-3);
    }

    #[test]
    fn segment_query_ignores_hits_on_the_anchors() {
      let mut e = engine();
      let id = path(&mut e, false);
      let q = |e: &Engine, x: f64, y: f64, zoom: f64| {
        e.query(Query::VectorSegmentAt {
          id: id.clone(),
          x,
          y,
          zoom,
        })
        .unwrap()
      };
      // On, just beside and just past the open path's ends: the anchor owns the click.
      assert!(q(&e, 100.0, 100.0, 1.0).is_null());
      assert!(q(&e, 103.0, 103.0, 1.0).is_null());
      assert!(q(&e, 96.0, 97.0, 1.0).is_null(), "past the start");
      assert!(q(&e, 203.0, 98.0, 1.0).is_null(), "past the end");
      assert!(q(&e, 150.0, 150.0, 1.0).is_null(), "an inner anchor too");
      // The margin is in screen pixels, so zooming in frees the segment next to the anchor.
      assert!(q(&e, 103.0, 103.0, 4.0).is_object());
      assert!(q(&e, 127.0, 123.0, 1.0).is_object());
    }

    #[test]
    fn short_segments_take_points_in_their_middle() {
      let mut e = engine();
      let r = e
        .dispatch(Command::CreateVector {
          points: vec![
            VectorPoint::at(100.0, 100.0),
            VectorPoint::at(104.0, 100.0),
            VectorPoint::at(108.0, 100.0),
          ],
          closed: false,
          parent: None,
        })
        .unwrap();
      let id = id_of(&r);
      let q = |e: &Engine, x: f64, y: f64, zoom: f64| {
        e.query(Query::VectorSegmentAt {
          id: id.clone(),
          x,
          y,
          zoom,
        })
        .unwrap()
      };
      // A 4px segment at 100% zoom: its middle takes a point, its ends belong to the anchors.
      let hit = q(&e, 102.0, 101.0, 1.0);
      assert_eq!((hit["sub"].as_u64(), hit["seg"].as_u64()), (Some(0), Some(0)), "{hit}");
      assert!((hit["t"].as_f64().unwrap() - 0.5).abs() < 1e-3);
      assert!(q(&e, 106.0, 100.0, 1.0).is_object(), "the next segment too");
      assert!(q(&e, 100.0, 100.0, 1.0).is_null());
      assert!(q(&e, 104.0, 100.0, 1.0).is_null(), "the shared anchor");
      // Clicks beyond the open path's ends still return null, whatever the segment length.
      assert!(q(&e, 95.0, 100.0, 1.0).is_null(), "5px before the start");
      assert!(q(&e, 113.0, 100.0, 1.0).is_null(), "5px past the end");
      assert!(q(&e, 108.0, 100.0, 1.0).is_null());
      e.dispatch(Command::InsertVectorPoint {
        id: id.clone(),
        sub: 0,
        seg: 0,
        t: hit["t"].as_f64().unwrap(),
      })
      .unwrap();
      assert_eq!(points(&e, &id).len(), 4);
    }

    #[test]
    fn a_long_curve_between_close_anchors_keeps_the_full_margin() {
      let mut e = engine();
      // A horseshoe: anchors 4px apart, handles 144px long, so the segment is a few hundred px.
      let (p0, p3) = ((100.0, 100.0), (104.0, 100.0));
      let (c1, c2) = ((20.0, -20.0), (184.0, -20.0));
      let mut a = VectorPoint::at(p0.0, p0.1);
      (a.out_x, a.out_y) = (c1.0 - p0.0, c1.1 - p0.1);
      let mut b = VectorPoint::at(p3.0, p3.1);
      (b.in_x, b.in_y) = (c2.0 - p3.0, c2.1 - p3.1);
      let r = e
        .dispatch(Command::CreateVector {
          points: vec![a, b],
          closed: false,
          parent: None,
        })
        .unwrap();
      let id = id_of(&r);
      let at = |t: f64| {
        let u = 1.0 - t;
        let f = |p: f64, c1: f64, c2: f64, q: f64| u * u * u * p + 3.0 * u * u * t * c1 + 3.0 * u * t * t * c2 + t * t * t * q;
        (f(p0.0, c1.0, c2.0, p3.0), f(p0.1, c1.1, c2.1, p3.1))
      };
      let q = |e: &Engine, (x, y): (f64, f64)| {
        e.query(Query::VectorSegmentAt {
          id: id.clone(),
          x,
          y,
          zoom: 1.0,
        })
        .unwrap()
      };
      // 4px along the curve from either end is still the anchor's; the middle takes a point.
      let near = at(0.01);
      assert!((near.0 - p0.0).hypot(near.1 - p0.1) < 5.0);
      assert!(q(&e, near).is_null());
      let near = at(0.99);
      assert!((near.0 - p3.0).hypot(near.1 - p3.1) < 5.0);
      assert!(q(&e, near).is_null());
      assert!(q(&e, at(0.5)).is_object());
    }

    #[test]
    fn nearest_segment_skips_far_segments_without_changing_hits() {
      let mut e = engine();
      let id = path(&mut e, true);
      let v = e.doc.get(&id).unwrap().vector.clone().unwrap();
      // Node-local points are (0,0), (50,50), (100,0); the closing segment runs back along y = 0.
      let h = vector_edit::nearest_segment(&v, Point::new(50.0, 3.0), 6.0).unwrap();
      assert_eq!((h.sub, h.seg), (0, 2));
      assert!((h.t - 0.5).abs() < 1e-6 && (h.dist - 3.0).abs() < 1e-6);
      assert!(vector_edit::nearest_segment(&v, Point::new(50.0, -9.0), 6.0).is_none());
    }

    #[test]
    fn refused_delete_in_an_instance_leaves_no_trace_in_an_open_gesture() {
      let mut e = engine();
      let vec = path(&mut e, false);
      let comp = id_of(&e.dispatch(Command::CreateComponent { ids: vec![vec] }).unwrap());
      let inst = id_of(
        &e.dispatch(Command::CreateInstance {
          component_id: comp,
          x: 400.0,
          y: 0.0,
          parent: None,
          anchor: None,
          into_components: false,
        })
        .unwrap(),
      );
      let inner = e
        .doc
        .subtree(&inst)
        .into_iter()
        .find(|i| e.doc.get(i).map(|n| n.kind == NodeType::Vector).unwrap_or(false))
        .expect("the instance has a vector");
      let before = e.doc.clone();
      let undo_depth = e.past.len();
      e.dispatch(Command::BeginGesture).unwrap();
      let err = e.dispatch(Command::DeleteVectorPoints {
        id: inner.clone(),
        points: vec![[0, 0], [0, 1]],
      });
      assert!(err.is_err());
      assert_eq!(points(&e, &inner).len(), 3, "the path was not touched");
      e.dispatch(Command::EndGesture).unwrap();
      assert!(e.doc == before, "the refused delete left nothing behind");
      assert_eq!(e.past.len(), undo_depth, "and no undo step");
      // A delete that keeps two points is still allowed inside the instance.
      e.dispatch(Command::DeleteVectorPoints {
        id: inner.clone(),
        points: vec![[0, 1]],
      })
      .unwrap();
      assert_eq!(points(&e, &inner).len(), 2);
    }

    #[test]
    fn raw_paths_are_not_editable() {
      let mut e = engine();
      let id = path(&mut e, false);
      e.doc.get_mut(&id).unwrap().vector.as_mut().unwrap().raw = Some(Default::default());
      assert!(e.dispatch(Command::DeleteVectorPoints { id, points: vec![[0, 0]] }).is_err());
    }

    /// A V-shaped path through (100,100), (150,150), (200,100), optionally closed.
    fn path(e: &mut Engine, closed: bool) -> String {
      let r = e
        .dispatch(Command::CreateVector {
          points: vec![
            VectorPoint::at(100.0, 100.0),
            VectorPoint::at(150.0, 150.0),
            VectorPoint::at(200.0, 100.0),
          ],
          closed,
          parent: None,
        })
        .unwrap();
      id_of(&r)
    }

    fn points(e: &Engine, id: &str) -> Vec<VectorPoint> {
      e.doc.get(id).unwrap().vector.as_ref().unwrap().subpaths[0].points.clone()
    }
  }
}
