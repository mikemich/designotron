//! The engine facade: owns the document, selection and undo history and
//! exposes every mutation as a serialisable [`Command`] and every read as a
//! [`Query`]. The WASM wrapper and the bridge both drive this type.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::components;
use crate::doc::{new_document, IdGen};
use crate::geom::{Mat, Point, Rect};
use crate::interact::{self, Handle};
use crate::layout;
use crate::model::{
  AutoLayout, ColorStyle, Document, Interaction, LayoutDirection, Node, NodeId, NodeType, Page, Paint, RulerGuide, Sizing, SubPath,
  TextStyle, VectorPoint,
};
use crate::ops::{self, AlignHow, ReorderTo};
use crate::render::{self, Mode, RenderOptions};
use crate::text::TextMeasurer;
use crate::{ai, codegen, patch};

const MAX_HISTORY: usize = 300;
pub const CLIPBOARD_TAG: &str = "designotron/nodes";

/// One undo step: the state before it and the document right after it. Undo applies the
/// reverse of before→after to the *current* document, so collaborators' later edits stay.
struct Step {
  before: Snapshot,
  after: Document,
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
  Undo,
  Redo,
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
  /// Merges a collaborator's delta (see `collab::delta`); not an undo step.
  ApplyRemote {
    delta: Value,
  },
  /// Swaps in a whole document as one undoable step (restoring a version).
  ReplaceDocument {
    doc: Value,
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
  CreateImage {
    src: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    name: Option<String>,
    parent: Option<NodeId>,
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
  AddAutoLayout {
    ids: Vec<NodeId>,
  },
  RemoveAutoLayout {
    ids: Vec<NodeId>,
  },
  CreateComponent {
    ids: Vec<NodeId>,
  },
  CombineVariants {
    ids: Vec<NodeId>,
  },
  CreateInstance {
    component_id: NodeId,
    x: f64,
    y: f64,
    parent: Option<NodeId>,
  },
  DetachInstance {
    ids: Vec<NodeId>,
  },
  ResetInstance {
    ids: Vec<NodeId>,
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
  DeleteStyle {
    id: String,
  },
  ApplyStyle {
    ids: Vec<NodeId>,
    style_id: String,
  },
  Ai {
    tool: String,
    input: Value,
  },
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "q", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Query {
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
  Bounds {
    ids: Vec<NodeId>,
  },
  FrameAt {
    x: f64,
    y: f64,
    #[serde(default)]
    exclude: Vec<NodeId>,
  },
  SnapPoint {
    x: f64,
    y: f64,
    zoom: f64,
    #[serde(default)]
    exclude: Vec<NodeId>,
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
  Copy {
    ids: Vec<NodeId>,
  },
  ExportSvg {
    id: NodeId,
  },
  ExportHtml {
    id: NodeId,
  },
  ExportReact {
    id: NodeId,
  },
  ExportProject,
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

fn one() -> f64 {
  1.0
}

fn three() -> usize {
  3
}

pub struct Engine {
  pub doc: Document,
  pub selection: Vec<NodeId>,
  pub page: String,
  pub rev: u64,
  past: Vec<Step>,
  future: Vec<Step>,
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
}

/// Per-root SVG from the last canvas render, and the document it was made from.
#[derive(Default)]
struct RenderCache {
  page: String,
  hidden: Vec<NodeId>,
  doc: Option<Document>,
  roots: HashMap<NodeId, String>,
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
      past: vec![],
      future: vec![],
      gesture: None,
      gesture_undo: None,
      drag_delta: None,
      gen,
      measurer,
      fingerprints: HashMap::new(),
      render_cache: RenderCache::default(),
      synced: None,
      collab_synced: None,
    }
  }

  /// Replaces the document (opening a file). Clears history.
  pub fn load(&mut self, json: &str) -> Result<(), String> {
    let doc: Document = serde_json::from_str(json).map_err(|e| format!("not a Designotron file: {e}"))?;
    if doc.pages.is_empty() {
      return Err("document has no pages".into());
    }
    self.page = doc.pages[0].id.clone();
    self.doc = doc;
    self.selection.clear();
    self.past.clear();
    self.future.clear();
    self.gesture = None;
    self.gesture_undo = None;
    self.fingerprints.clear();
    self.refresh_fingerprints();
    layout::relayout_all(&mut self.doc, self.measurer.as_ref());
    self.render_cache = RenderCache::default();
    self.rev += 1;
    Ok(())
  }

  pub fn to_json(&self) -> String {
    serde_json::to_string(&self.doc).unwrap_or_default()
  }

  pub fn state(&self) -> Value {
    json!({
      "rev": self.rev,
      "page": self.page,
      "selection": self.selection,
      "canUndo": !self.past.is_empty(),
      "canRedo": !self.future.is_empty(),
      "inGesture": self.gesture.is_some(),
    })
  }

  /// Changes since the previous call, for keeping a JS copy of the document current:
  /// `{full: doc}` the first time (or when `full`), else `{nodes: {id: node}, removed: [ids], meta}`
  /// where `meta` carries the small document-level fields (pages, styles, variables, name).
  pub fn doc_delta(&mut self, full: bool) -> Value {
    let out = match (&self.synced, full) {
      (Some(prev), false) => {
        let mut nodes = serde_json::Map::new();
        let mut removed = Vec::new();
        for item in prev.nodes.diff(&self.doc.nodes) {
          match item {
            imbl::ordmap::DiffItem::Add(k, v) | imbl::ordmap::DiffItem::Update { new: (k, v), .. } => {
              nodes.insert(k.clone(), serde_json::to_value(v).unwrap_or(Value::Null));
            }
            imbl::ordmap::DiffItem::Remove(k, _) => removed.push(k.clone()),
          }
        }
        // Every document-level field except the node table (cheap: the node map clone is O(1)).
        let mut shell = self.doc.clone();
        shell.nodes = imbl::OrdMap::new();
        let mut meta = serde_json::to_value(&shell).unwrap_or(Value::Null);
        if let Some(m) = meta.as_object_mut() {
          m.remove("nodes");
        }
        json!({ "nodes": nodes, "removed": removed, "meta": meta })
      }
      _ => json!({ "full": self.doc }),
    };
    self.synced = Some(self.doc.clone());
    out
  }

  /// Local changes since the last call, for collaborators (`collab::delta` format).
  /// The first call returns `{full: doc}`.
  pub fn collab_delta(&mut self) -> Value {
    let out = match &self.collab_synced {
      Some(base) => crate::collab::delta(base, &self.doc),
      None => json!({ "full": self.doc }),
    };
    self.collab_synced = Some(self.doc.clone());
    out
  }

  /// Starts a collaboration baseline at the current document without producing a delta.
  pub fn collab_reset(&mut self) {
    self.collab_synced = Some(self.doc.clone());
  }

  /// Forgets cached canvas SVG (the next incremental render returns every root).
  pub fn reset_render_cache(&mut self) {
    self.render_cache = RenderCache::default();
  }

  /// Canvas render that re-renders only top-level layers changed since the last call.
  /// Returns `{order: [root ids], changed: {id: svg}}`, or `{full: svg}` when the page
  /// uses top-level masks (which span roots).
  pub fn render_incremental(&mut self, page: &str, hidden: &[NodeId]) -> Value {
    let roots = self.doc.page(page).map(|p| p.children.clone()).unwrap_or_default();
    if roots
      .iter()
      .any(|r| self.doc.get(r).map(|n| n.is_mask && n.visible).unwrap_or(false))
    {
      self.render_cache = RenderCache::default();
      return json!({ "full": self.render(page, hidden) });
    }
    let mut cache = std::mem::take(&mut self.render_cache);
    let mut dirty: Vec<NodeId> = Vec::new();
    // Roots whose only change is the root's own position: the client just updates a transform.
    let mut moved = serde_json::Map::new();
    match &cache.doc {
      Some(prev) if cache.page == page => {
        for (root, ids) in self.changed_by_root(prev) {
          let only_moved = self.only_moved(prev, &root, &ids);
          if only_moved
            && cache.roots.contains_key(&root)
            && !hidden.iter().any(|h| self.doc.ancestors(h).last() == Some(&root) || *h == root)
          {
            if let Some(n) = self.doc.get(&root) {
              moved.insert(root.clone(), json!(self.doc.local_matrix(n).svg()));
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
      }
      _ => cache.roots.clear(),
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
          },
        );
        changed.insert(r.clone(), json!(svg));
        cache.roots.insert(r.clone(), svg);
        moved.remove(r);
      }
    }
    cache.roots.retain(|k, _| roots.contains(k));
    cache.doc = Some(self.doc.clone());
    cache.page = page.to_string();
    cache.hidden = hidden.to_vec();
    self.render_cache = cache;
    json!({ "order": roots, "changed": changed, "moved": moved })
  }

  pub fn render(&self, page: &str, hidden: &[NodeId]) -> String {
    render::render_page(
      &self.doc,
      page,
      self.measurer.as_ref(),
      RenderOptions {
        mode: Mode::Canvas,
        hidden,
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
    match cmd {
      Command::Relayout => {
        layout::relayout_all(&mut self.doc, self.measurer.as_ref());
        // Text measurement may have changed (fonts loaded): repaint everything.
        self.render_cache = RenderCache::default();
        self.rev += 1;
        return Ok(json!({}));
      }
      Command::Undo => {
        if let Some(step) = self.past.pop() {
          let prev = self.doc.clone();
          self.doc = crate::collab::revert(&self.doc, &step.after, &step.before.doc);
          self.selection = step.before.selection.clone();
          if self.doc.page(&step.before.page).is_some() {
            self.page = step.before.page.clone();
          }
          self.refresh_fingerprints();
          self.after_mutation(&prev);
          self.future.push(step);
        }
        self.rev += 1;
        return Ok(json!({}));
      }
      Command::Redo => {
        if let Some(step) = self.future.pop() {
          let prev = self.doc.clone();
          self.doc = crate::collab::revert(&self.doc, &step.before.doc, &step.after);
          self.refresh_fingerprints();
          self.after_mutation(&prev);
          self.past.push(step);
        }
        self.rev += 1;
        return Ok(json!({}));
      }
      Command::ApplyRemote { delta } => {
        // A collaborator's change: merged into the document (and the open gesture's base),
        // never recorded in local history. Callers flush their own delta first.
        let prev = self.doc.clone();
        crate::collab::apply(&mut self.doc, &delta)?;
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
            self.push_past(base);
          }
        }
        self.rev += 1;
        return Ok(json!({}));
      }
      Command::CancelGesture => {
        let gesture = self.gesture.take();
        if let Some(base) = self.gesture_undo.take().or(gesture) {
          self.restore(base);
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
    let gesture_relative = matches!(cmd, Command::Translate { .. } | Command::Resize { .. } | Command::Rotate { .. });
    if gesture_relative {
      if let Some(base) = self.gesture.clone() {
        self.doc = base.doc;
      }
    }
    let before = if self.gesture.is_none() { Some(self.snapshot()) } else { None };
    let result = self.apply(cmd);
    match result {
      Ok(v) => {
        self.after_mutation(&prev);
        if let Some(b) = before {
          if b.doc != self.doc {
            self.push_past(b);
          }
        }
        self.rev += 1;
        Ok(v)
      }
      Err(e) => {
        if let Some(b) = before {
          self.restore(b);
        }
        Err(e)
      }
    }
  }

  fn push_past(&mut self, s: Snapshot) {
    self.past.push(Step {
      before: s,
      after: self.doc.clone(),
    });
    if self.past.len() > MAX_HISTORY {
      self.past.remove(0);
    }
    self.future.clear();
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
      for id in instances {
        if self.doc.instance_ancestor(&id).is_none() {
          components::sync_instance(&mut self.doc, &id, &mut self.gen);
        }
      }
    }
    // Instances just synced from their mains resolve variables in their own mode context.
    crate::variables::apply(&mut self.doc);
    // Only trees that changed need layout (layout never reaches across top-level layers),
    // and moving a whole top-level layer changes nothing inside it.
    for (root, changed) in self.changed_by_root(prev) {
      if !self.only_moved(prev, &root, &changed) {
        layout::layout_node(&mut self.doc, &root, self.measurer.as_ref());
      }
    }
    self.selection.retain(|i| self.doc.nodes.contains_key(i));
    if self.doc.page(&self.page).is_none() {
      self.page = self.doc.pages[0].id.clone();
    }
  }

  /// Main components whose subtree changed since `prev` (only those containing changed nodes
  /// are fingerprinted, so unrelated edits in big files stay cheap).
  fn changed_components(&mut self, prev: &Document) -> Vec<NodeId> {
    let mut comps: Vec<NodeId> = Vec::new();
    for item in prev.nodes.diff(&self.doc.nodes) {
      let (doc, k) = match item {
        imbl::ordmap::DiffItem::Add(k, _) | imbl::ordmap::DiffItem::Update { new: (k, _), .. } => (&self.doc, k),
        imbl::ordmap::DiffItem::Remove(k, _) => (prev, k),
      };
      for id in std::iter::once(k.clone()).chain(doc.ancestors(k)) {
        if !comps.contains(&id) && self.doc.get(&id).map(|n| n.kind == NodeType::Component).unwrap_or(false) {
          comps.push(id);
        }
      }
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
      .or_else(|| ops::frame_at(&self.doc, &self.page, Point::new(x, y), &[]))
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
    self.doc.insert(n, parent, &page, None);
    id
  }

  /// Applies a command without touching history (used by AI tools inside one step).
  pub(crate) fn dispatch_inner(&mut self, cmd: Command) -> Result<Value, String> {
    self.apply(cmd)
  }

  fn apply(&mut self, cmd: Command) -> Result<Value, String> {
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
      Command::SetPageBackground { id, color } => {
        self.doc.page_mut(&id).ok_or("no such page")?.background = crate::color::normalize(&color);
        Ok(json!({}))
      }
      Command::SetGuides { page, guides } => {
        let id = page.unwrap_or_else(|| self.page.clone());
        self.doc.page_mut(&id).ok_or("no such page")?.guides = guides;
        Ok(json!({}))
      }
      Command::SetVariables { collections } => {
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
              return Err(format!("{property} needs a {want:?} variable, {} is {:?}", v.name, v.kind).to_lowercase());
            }
            Some(v.id.clone())
          }
          None => None,
        };
        for id in &ids {
          let n = self.doc.get_mut(id).ok_or_else(|| format!("no node {id}"))?;
          match &var_id {
            Some(v) => n.bindings.insert(property.clone(), v.clone()),
            None => n.bindings.remove(&property),
          };
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
          match &mid {
            Some(m) => n.variable_modes.insert(cid.clone(), m.clone()),
            None => n.variable_modes.remove(&cid),
          };
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
      Command::ReplaceDocument { doc } => {
        let doc: Document = serde_json::from_value(doc).map_err(|e| format!("not a Designotron document: {e}"))?;
        if doc.pages.is_empty() {
          return Err("document has no pages".into());
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
        let id = self.insert_abs(n, parent.as_deref());
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
      Command::CreateImage {
        src,
        x,
        y,
        width,
        height,
        name,
        parent,
      } => {
        let parent = self.auto_parent(parent, x, y);
        let mut n = ops::default_node(NodeType::Rectangle, self.gen.next("n_"), name.unwrap_or_else(|| "Image".into()));
        n.x = x;
        n.y = y;
        n.width = width;
        n.height = height;
        n.fills = vec![Paint::Image {
          src,
          scale_mode: Default::default(),
          opacity: 1.0,
          visible: true,
        }];
        let id = self.insert_abs(n, parent.as_deref());
        self.selection = vec![id.clone()];
        Ok(json!({ "id": id }))
      }
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
        crate::variables::unbind_for_patch(&mut self.doc, &ids, &p);
        for id in &ids {
          let before = self.doc.get(id).cloned().ok_or_else(|| format!("no node {id}"))?;
          patch::apply(self.doc.get_mut(id).unwrap(), &p)?;
          components::record_override(&mut self.doc, id, &p);
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
          let after = self.doc.get(id).unwrap().clone();
          if after.kind.is_frame_like() && (after.width != before.width || after.height != before.height) {
            layout::apply_constraints(&mut self.doc, id, before.width, before.height);
          }
          if let Some(sid) = after.fill_style.clone() {
            if before.fills != after.fills {
              self.doc.get_mut(id).unwrap().fill_style = None;
              let _ = sid;
            }
          }
        }
        Ok(json!({}))
      }
      Command::SetText { id, characters } => {
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
        let auto_name: String = old.chars().take(40).collect();
        if n.name.is_empty() || n.name == "Text" || n.name == auto_name {
          n.name = characters.chars().take(40).collect();
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
        if let Some(c) = patch_run.color.as_mut() {
          *c = crate::color::normalize(c);
        }
        let clear: Vec<&str> = clear.iter().map(|s| s.as_str()).collect();
        let runs = if start == 0 && end >= len && clear.is_empty() {
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
        ops::delete(&mut self.doc, &ids);
        Ok(json!({}))
      }
      Command::Duplicate { ids } => {
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
      Command::Translate { ids, dx, dy, snap, zoom } => self.translate(&ids, dx, dy, snap, zoom),
      Command::Nudge { ids, dx, dy } => {
        ops::move_by(&mut self.doc, &ids, dx, dy);
        Ok(json!({}))
      }
      Command::DropInto { ids, x, y } => {
        let ids = ops::top_most(&self.doc, &ids);
        let pt = Point::new(x, y);
        let target = ops::frame_at(&self.doc, &self.page, pt, &ids);
        for id in &ids {
          let cur = self.doc.get(id).and_then(|n| n.parent.clone());
          if self.doc.instance_ancestor(id).is_some() {
            continue;
          }
          let in_flow = cur
            .as_ref()
            .and_then(|p| self.doc.get(p))
            .map(|p| p.layout.is_some())
            .unwrap_or(false)
            && !self.doc.get(id).unwrap().absolute_position;
          // Inside its auto layout parent a drag reorders; dropped outside, the layer leaves.
          let leaves_flow = in_flow && cur.as_deref().map(|p| !self.contains_point(p, pt)).unwrap_or(false);
          if leaves_flow {
            self.place_dragged(id);
          }
          if cur != target
            && (!in_flow || leaves_flow)
            && cur
              .as_ref()
              .map(|c| self.doc.get(c).map(|n| n.kind != NodeType::Group).unwrap_or(true))
              .unwrap_or(true)
          {
            // Dropping into auto layout inserts at the pointer position.
            let index = target.as_ref().and_then(|t| self.flow_index(t, Point::new(x, y)));
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
        }
        Ok(json!({ "parent": target }))
      }
      Command::MoveToParent { ids, parent, index } => {
        let ids = ops::paint_order(&self.doc, &ops::top_most(&self.doc, &ids));
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
      } => self.resize(&ids, handle, dx, dy, keep_aspect, from_center, snap, zoom),
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
        let n = self.doc.get_mut(&target).ok_or("missing")?;
        n.layout = Some(AutoLayout {
          direction: if horizontal {
            LayoutDirection::Horizontal
          } else {
            LayoutDirection::Vertical
          },
          ..Default::default()
        });
        n.sizing_h = Sizing::Hug;
        n.sizing_v = Sizing::Hug;
        self.selection = vec![target.clone()];
        Ok(json!({ "id": target }))
      }
      Command::RemoveAutoLayout { ids } => {
        for id in ids {
          if let Some(n) = self.doc.get_mut(&id) {
            n.layout = None;
            n.sizing_h = Sizing::Fixed;
            n.sizing_v = Sizing::Fixed;
          }
        }
        Ok(json!({}))
      }
      Command::CreateComponent { ids } => {
        let id = components::create_component(&mut self.doc, &ids, &mut self.gen).ok_or("select a frame, group or layers")?;
        self.selection = vec![id.clone()];
        Ok(json!({ "id": id }))
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
      } => {
        let parent = self.auto_parent(parent, x, y);
        let (lx, ly) = match &parent {
          Some(p) => {
            let l = self.doc.abs_matrix(p).invert().apply(Point::new(x, y));
            (l.x, l.y)
          }
          None => (x, y),
        };
        let page = self.page.clone();
        let id = components::create_instance(&mut self.doc, &component_id, parent.as_deref(), &page, lx, ly, &mut self.gen)
          .ok_or("not a component")?;
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
      Command::SwapComponent { id, component_id } => {
        components::swap_component(&mut self.doc, &id, &component_id, &mut self.gen);
        Ok(json!({}))
      }
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
        Ok(json!({}))
      }
      Command::DeleteStyle { id } => {
        self.doc.styles.colors.retain(|s| s.id != id);
        self.doc.styles.texts.retain(|s| s.id != id);
        let uses = |n: &Node| n.fill_style.as_deref() == Some(id.as_str()) || n.text_style.as_deref() == Some(id.as_str());
        self.doc.update_where(uses, |n| {
          if n.fill_style.as_deref() == Some(id.as_str()) {
            n.fill_style = None;
          }
          if n.text_style.as_deref() == Some(id.as_str()) {
            n.text_style = None;
          }
        });
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
      Command::ApplyStyle { ids, style_id } => {
        if let Some(c) = self.doc.styles.colors.iter().find(|s| s.id == style_id).cloned() {
          for id in &ids {
            if let Some(n) = self.doc.get_mut(id) {
              n.fills = vec![Paint::solid(&c.color)];
              n.fill_style = Some(style_id.clone());
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
            }
          }
        } else {
          return Err("no such style".into());
        }
        Ok(json!({}))
      }
      Command::Ai { tool, input } => ai::execute(self, &tool, &input),
      // Handled in dispatch.
      Command::Relayout
      | Command::Undo
      | Command::Redo
      | Command::BeginGesture
      | Command::RebaseGesture
      | Command::EndGesture
      | Command::CancelGesture
      | Command::Select { .. }
      | Command::SelectAll
      | Command::ApplyRemote { .. }
      | Command::SetPage { .. } => Ok(json!({})),
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

  fn translate(&mut self, ids: &[NodeId], dx: f64, dy: f64, snap: bool, zoom: f64) -> Result<Value, String> {
    let ids = ops::top_most(&self.doc, ids);
    // Children flowing in auto layout reorder instead of moving freely.
    let (flow, free): (Vec<NodeId>, Vec<NodeId>) = ids.iter().cloned().partition(|id| {
      let n = self.doc.get(id).unwrap();
      !n.absolute_position
        && n
          .parent
          .as_ref()
          .and_then(|p| self.doc.get(p))
          .map(|p| p.layout.is_some())
          .unwrap_or(false)
    });
    for id in &flow {
      self.reorder_in_flow(id, dx, dy);
    }
    self.drag_delta = Some(Point::new(dx, dy));
    let mut guides = Vec::new();
    let (mut fdx, mut fdy) = (dx, dy);
    if snap && !free.is_empty() {
      let s = interact::snap_move(&self.doc, &self.page, &free, dx, dy, zoom);
      fdx = s.dx;
      fdy = s.dy;
      guides = s.guides;
    }
    ops::move_by(&mut self.doc, &free, fdx, fdy);
    Ok(json!({ "dx": fdx, "dy": fdy, "guides": guides }))
  }

  /// Insertion index in an auto layout frame for a page-space point.
  fn flow_index(&self, frame: &str, p: Point) -> Option<usize> {
    let f = self.doc.get(frame)?;
    let horizontal = f.layout.as_ref()?.direction == LayoutDirection::Horizontal;
    let pos = if horizontal { p.x } else { p.y };
    Some(
      f.children
        .iter()
        .filter(|c| {
          let cc = self.doc.abs_bounds(c).center();
          (if horizontal { cc.x } else { cc.y }) < pos
        })
        .count(),
    )
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
    let Some(n) = self.doc.get(id).cloned() else { return };
    let Some(parent) = n.parent.clone() else { return };
    let horizontal = self
      .doc
      .get(&parent)
      .and_then(|p| p.layout.as_ref())
      .map(|l| l.direction == LayoutDirection::Horizontal)
      .unwrap_or(false);
    let b = self.doc.abs_bounds(id);
    let c = b.center();
    let pos = if horizontal { c.x + dx } else { c.y + dy };
    let siblings: Vec<NodeId> = self.doc.siblings_of(id).into_iter().filter(|s| s != id).collect();
    let mut index = 0;
    for s in &siblings {
      let sc = self.doc.abs_bounds(s).center();
      if (if horizontal { sc.x } else { sc.y }) < pos {
        index += 1;
      }
    }
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
      let (snapped, g) = interact::snap_rect(&self.doc, &self.page, &ids, r, edges, zoom);
      guides = g;
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
      if guides.is_empty() {
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
    Ok(json!({ "guides": guides }))
  }

  fn paste(&mut self, data: &str, parent: Option<NodeId>, x: Option<f64>, y: Option<f64>) -> Result<Value, String> {
    let v: Value = serde_json::from_str(data).map_err(|_| "clipboard does not contain Designotron layers")?;
    if v.get("type").and_then(|t| t.as_str()) != Some(CLIPBOARD_TAG) {
      return Err("clipboard does not contain Designotron layers".into());
    }
    let nodes: Vec<Node> = serde_json::from_value(v["nodes"].clone()).map_err(|e| e.to_string())?;
    let roots: Vec<NodeId> = serde_json::from_value(v["roots"].clone()).map_err(|e| e.to_string())?;
    let mut map: HashMap<NodeId, NodeId> = HashMap::new();
    for n in &nodes {
      map.insert(n.id.clone(), self.gen.next("n_"));
    }
    let parent = parent.filter(|p| {
      self
        .doc
        .get(p)
        .map(|n| n.kind.is_frame_like() && n.kind != NodeType::Instance)
        .unwrap_or(false)
    });
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
        let id = c.id.clone();
        self.doc.insert(c, None, &page, None);
        if let Some(p) = &parent {
          self.doc.reparent(&id, Some(p), None, true);
        }
        created.push(id);
      } else {
        c.parent = n.parent.as_ref().and_then(|p| map.get(p).cloned());
        self.doc.nodes.insert(c.id.clone(), c);
      }
    }
    // Instances whose main component isn't in this file: bring it from the clipboard, or
    // detach them so they keep their look instead of showing "Missing component".
    let comps: Vec<Node> = v
      .get("components")
      .and_then(|c| serde_json::from_value(c.clone()).ok())
      .unwrap_or_default();
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
    Ok(json!({ "created": created }))
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
        self.doc.nodes.insert(c.id.clone(), c);
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
      Query::Bounds { ids } => {
        let items: Vec<Value> = ids
          .iter()
          .filter_map(|id| self.doc.get(id).map(|n| (id, n)))
          .map(|(id, n)| json!({ "id": id, "matrix": self.doc.abs_matrix(id), "width": n.width, "height": n.height, "bounds": self.doc.abs_bounds(id) }))
          .collect();
        json!({ "items": items, "union": self.doc.bounds_of_many(&ids) })
      }
      Query::FrameAt { x, y, exclude } => json!(ops::frame_at(&self.doc, &self.page, Point::new(x, y), &exclude)),
      Query::SnapPoint { x, y, zoom, exclude } => {
        let (r, guides) = interact::snap_rect(
          &self.doc,
          &self.page,
          &exclude,
          Rect::new(x, y, 0.0, 0.0),
          [true, false, true, false],
          zoom,
        );
        json!({ "x": r.x, "y": r.y, "guides": guides })
      }
      Query::Comments { page, include_resolved } => crate::comments::list(&self.doc, page.as_deref(), include_resolved),
      Query::GridOverlay { page } => crate::grids::overlay(&self.doc, page.as_deref().unwrap_or(&self.page)),
      Query::Copy { ids } => json!(self.copy(&ids)),
      Query::ExportSvg { id } => json!(render::export_svg(&self.doc, &id, m)),
      Query::ExportHtml { id } => json!(codegen::export_html(&self.doc, &id, m)),
      Query::ExportReact { id } => json!(codegen::export_react(&self.doc, &id, m)),
      Query::ExportProject => {
        let files: Vec<Value> = codegen::export_project(&self.doc, m)
          .into_iter()
          .map(|f| json!({ "path": f.path, "content": f.content }))
          .collect();
        json!(files)
      }
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
    let nodes: Vec<Node> = roots.iter().flat_map(|r| self.clipboard_subtree(r)).collect();
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
    json!({ "type": CLIPBOARD_TAG, "roots": roots, "nodes": nodes, "components": components }).to_string()
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

  fn id_of(v: &Value) -> String {
    v["id"].as_str().unwrap().to_string()
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
    let svg = e.render(&page, &[]);
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
      })
      .unwrap();
    assert_eq!(e.doc.get(&id).unwrap().x, 1054.0, "{r}");
    e.dispatch(Command::Undo).unwrap();
    e.dispatch(Command::Undo).unwrap();
    assert!(e.doc.page(&e.page).unwrap().guides.is_empty(), "guides are undoable");
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
    })
    .unwrap();
    assert_eq!(e.doc.abs_bounds(&child).x, 275.0);
    let overlay = e.query(Query::GridOverlay { page: None }).unwrap();
    assert_eq!(overlay[0]["bands"].as_array().unwrap().len(), 4);
  }

  #[test]
  fn replace_document_is_undoable() {
    let mut e = engine();
    let before = e.to_json();
    let id = rect(&mut e, 0.0, 0.0, 10.0, 10.0, None);
    let snapshot: Value = serde_json::from_str(&before).unwrap();
    e.dispatch(Command::ReplaceDocument { doc: snapshot }).unwrap();
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
      })
      .unwrap();
    }
    e.dispatch(Command::EndGesture).unwrap();
    assert_eq!(e.doc.get(&id).unwrap().x, 100.0);
    e.dispatch(Command::Undo).unwrap();
    assert_eq!(e.doc.get(&id).unwrap().x, 0.0);
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
    let svg = e.render(&e.page.clone(), &[]);
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
    })
    .unwrap();
    e.dispatch(Command::EndGesture).unwrap();
    assert_eq!(e.doc.get(&f).unwrap().children, vec![b, a]);
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
}
