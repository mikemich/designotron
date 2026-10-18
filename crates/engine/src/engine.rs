//! The engine facade: owns the document, selection and undo history and
//! exposes every mutation as a serialisable [`Command`] and every read as a
//! [`Query`]. The WASM wrapper and the bridge both drive this type.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::components;
use crate::doc::{new_document, IdGen};
use crate::geom::{Point, Rect};
use crate::interact::{self, Handle};
use crate::layout;
use crate::model::{
  AutoLayout, ColorStyle, Document, Interaction, LayoutDirection, Node, NodeId, NodeType, Page, Paint, Sizing, TextStyle,
  VectorPoint,
};
use crate::ops::{self, AlignHow, ReorderTo};
use crate::render::{self, Mode, RenderOptions};
use crate::text::TextMeasurer;
use crate::{ai, codegen, patch};

const MAX_HISTORY: usize = 300;
pub const CLIPBOARD_TAG: &str = "designotron/nodes";

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
  EndGesture,
  CancelGesture,
  Select { ids: Vec<NodeId>, #[serde(default)] mode: SelectMode },
  SelectAll,
  SetPage { id: String },
  AddPage { name: Option<String> },
  RenamePage { id: String, name: String },
  DeletePage { id: String },
  SetPageBackground { id: String, color: String },
  SetDocName { name: String },
  CreateShape { kind: NodeType, x: f64, y: f64, width: f64, height: f64, parent: Option<NodeId> },
  CreateText { x: f64, y: f64, characters: String, parent: Option<NodeId> },
  CreateVector { points: Vec<VectorPoint>, closed: bool, parent: Option<NodeId> },
  CreateImage { src: String, x: f64, y: f64, width: f64, height: f64, name: Option<String>, parent: Option<NodeId> },
  InsertSpecs { specs: Vec<Value>, parent: Option<NodeId> },
  Paste { data: String, parent: Option<NodeId>, x: Option<f64>, y: Option<f64> },
  Update { ids: Vec<NodeId>, patch: Value },
  SetText { id: NodeId, characters: String },
  Delete { ids: Vec<NodeId> },
  Duplicate { ids: Vec<NodeId> },
  /// Gesture-relative translate (total delta since BeginGesture).
  Translate { ids: Vec<NodeId>, dx: f64, dy: f64, #[serde(default)] snap: bool, #[serde(default = "one")] zoom: f64 },
  Nudge { ids: Vec<NodeId>, dx: f64, dy: f64 },
  DropInto { ids: Vec<NodeId>, x: f64, y: f64 },
  MoveToParent { ids: Vec<NodeId>, parent: Option<NodeId>, index: Option<usize> },
  Resize { ids: Vec<NodeId>, handle: Handle, dx: f64, dy: f64, #[serde(default)] keep_aspect: bool, #[serde(default)] from_center: bool, #[serde(default)] snap: bool, #[serde(default = "one")] zoom: f64 },
  /// Gesture-relative rotation in degrees around a page-space pivot.
  Rotate { ids: Vec<NodeId>, angle: f64, pivot_x: f64, pivot_y: f64 },
  Group { ids: Vec<NodeId> },
  Ungroup { ids: Vec<NodeId> },
  FrameSelection { ids: Vec<NodeId> },
  AddAutoLayout { ids: Vec<NodeId> },
  RemoveAutoLayout { ids: Vec<NodeId> },
  CreateComponent { ids: Vec<NodeId> },
  CombineVariants { ids: Vec<NodeId> },
  CreateInstance { component_id: NodeId, x: f64, y: f64, parent: Option<NodeId> },
  DetachInstance { ids: Vec<NodeId> },
  ResetInstance { ids: Vec<NodeId> },
  SwapComponent { id: NodeId, component_id: NodeId },
  SetVariant { id: NodeId, prop: String, value: String },
  Align { ids: Vec<NodeId>, how: AlignHow },
  Distribute { ids: Vec<NodeId>, horizontal: bool },
  Reorder { ids: Vec<NodeId>, to: ReorderTo },
  Flip { ids: Vec<NodeId>, horizontal: bool },
  AddInteraction { id: NodeId, interaction: Interaction },
  SetInteractions { id: NodeId, interactions: Vec<Interaction> },
  SetFlowStart { page: String, id: Option<NodeId> },
  AddColorStyle { name: String, color: String },
  AddTextStyle { name: String, from: NodeId },
  UpdateColorStyle { id: String, name: Option<String>, color: Option<String> },
  DeleteStyle { id: String },
  ApplyStyle { ids: Vec<NodeId>, style_id: String },
  Ai { tool: String, input: Value },
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "q", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Query {
  Pick { x: f64, y: f64, zoom: f64, #[serde(default)] deep: bool },
  Drill { x: f64, y: f64, zoom: f64, container: NodeId },
  Hit { x: f64, y: f64, zoom: f64 },
  Marquee { x: f64, y: f64, width: f64, height: f64 },
  Bounds { ids: Vec<NodeId> },
  FrameAt { x: f64, y: f64, #[serde(default)] exclude: Vec<NodeId> },
  SnapPoint { x: f64, y: f64, zoom: f64, #[serde(default)] exclude: Vec<NodeId> },
  Copy { ids: Vec<NodeId> },
  ExportSvg { id: NodeId },
  ExportHtml { id: NodeId },
  ExportReact { id: NodeId },
  ExportProject,
  ToolDefs,
  SystemPrompt,
  Summary { #[serde(default = "three")] depth: usize },
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
  past: Vec<Snapshot>,
  future: Vec<Snapshot>,
  gesture: Option<Snapshot>,
  pub(crate) gen: IdGen,
  pub(crate) measurer: Box<dyn TextMeasurer>,
  fingerprints: HashMap<NodeId, u64>,
}

impl Engine {
  pub fn new(measurer: Box<dyn TextMeasurer>, seed: u64) -> Self {
    let mut gen = IdGen::new(seed);
    let doc = new_document(&mut gen, "Untitled");
    let page = doc.pages[0].id.clone();
    Engine { doc, selection: vec![], page, rev: 1, past: vec![], future: vec![], gesture: None, gen, measurer, fingerprints: HashMap::new() }
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
    self.fingerprints.clear();
    self.refresh_fingerprints();
    layout::relayout_all(&mut self.doc, self.measurer.as_ref());
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

  pub fn render(&self, page: &str, hidden: &[NodeId]) -> String {
    render::render_page(&self.doc, page, self.measurer.as_ref(), RenderOptions { mode: Mode::Canvas, hidden })
  }

  fn snapshot(&self) -> Snapshot {
    Snapshot { doc: self.doc.clone(), selection: self.selection.clone(), page: self.page.clone() }
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
        self.rev += 1;
        return Ok(json!({}));
      }
      Command::Undo => {
        if let Some(prev) = self.past.pop() {
          let cur = self.snapshot();
          self.future.push(cur);
          self.restore(prev);
          self.refresh_fingerprints();
        }
        self.rev += 1;
        return Ok(json!({}));
      }
      Command::Redo => {
        if let Some(next) = self.future.pop() {
          let cur = self.snapshot();
          self.past.push(cur);
          self.restore(next);
          self.refresh_fingerprints();
        }
        self.rev += 1;
        return Ok(json!({}));
      }
      Command::BeginGesture => {
        self.gesture = Some(self.snapshot());
        return Ok(json!({}));
      }
      Command::EndGesture => {
        if let Some(base) = self.gesture.take() {
          if base.doc != self.doc {
            self.push_past(base);
          }
        }
        self.rev += 1;
        return Ok(json!({}));
      }
      Command::CancelGesture => {
        if let Some(base) = self.gesture.take() {
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
        let scope = self.selection.first().and_then(|s| self.doc.get(s)).map(|n| (n.parent.clone(), n.page.clone()));
        self.selection = match scope {
          Some((parent, page)) => self.doc.child_ids(parent.as_deref(), &page),
          None => self.doc.page(&self.page).map(|p| p.children.clone()).unwrap_or_default(),
        };
        self.selection.retain(|i| self.doc.get(i).map(|n| n.visible && !n.locked).unwrap_or(false));
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
        self.after_mutation();
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
    self.past.push(s);
    if self.past.len() > MAX_HISTORY {
      self.past.remove(0);
    }
    self.future.clear();
  }

  /// Keeps derived state consistent: instances, layout, selection.
  fn after_mutation(&mut self) {
    for _ in 0..4 {
      let changed = self.changed_components();
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
    layout::relayout_all(&mut self.doc, self.measurer.as_ref());
    self.selection.retain(|i| self.doc.nodes.contains_key(i));
    if self.doc.page(&self.page).is_none() {
      self.page = self.doc.pages[0].id.clone();
    }
  }

  fn changed_components(&mut self) -> Vec<NodeId> {
    let comps: Vec<NodeId> = self.doc.components().iter().map(|c| c.id.clone()).collect();
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
    self.fingerprints = self.doc.components().iter().map(|c| (c.id.clone(), components::fingerprint(&self.doc, &c.id))).collect();
  }

  /// Parent for newly drawn content: the deepest frame under the point.
  fn auto_parent(&self, explicit: Option<NodeId>, x: f64, y: f64) -> Option<NodeId> {
    explicit.filter(|p| self.doc.nodes.contains_key(p)).or_else(|| ops::frame_at(&self.doc, &self.page, Point::new(x, y), &[]))
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
        self.doc.pages.push(Page { id: id.clone(), name, children: vec![], background: "#F5F5F5".into(), flow_start: None });
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
      Command::SetDocName { name } => {
        self.doc.name = name;
        Ok(json!({}))
      }
      Command::CreateShape { kind, x, y, width, height, parent } => {
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
        n.name = if characters.is_empty() { "Text".into() } else { characters.chars().take(40).collect() };
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
        let n = interact::vector_from_points(&self.doc, &mut self.gen, parent.as_deref(), &points, closed).ok_or("a path needs at least two points")?;
        let id = n.id.clone();
        let page = self.page.clone();
        self.doc.insert(n, parent.as_deref(), &page, None);
        self.selection = vec![id.clone()];
        Ok(json!({ "id": id }))
      }
      Command::CreateImage { src, x, y, width, height, name, parent } => {
        let parent = self.auto_parent(parent, x, y);
        let mut n = ops::default_node(NodeType::Rectangle, self.gen.next("n_"), name.unwrap_or_else(|| "Image".into()));
        n.x = x;
        n.y = y;
        n.width = width;
        n.height = height;
        n.fills = vec![Paint::Image { src, scale_mode: Default::default(), opacity: 1.0, visible: true }];
        let id = self.insert_abs(n, parent.as_deref());
        self.selection = vec![id.clone()];
        Ok(json!({ "id": id }))
      }
      Command::InsertSpecs { specs, parent } => {
        let created = ai::insert_specs(self, &specs, parent.as_deref())?;
        self.selection = created.iter().filter_map(|c| c.get("id").and_then(|v| v.as_str()).map(String::from)).collect();
        Ok(json!({ "created": created }))
      }
      Command::Paste { data, parent, x, y } => self.paste(&data, parent, x, y),
      Command::Update { ids, patch: p } => {
        for id in &ids {
          let before = self.doc.get(id).cloned().ok_or_else(|| format!("no node {id}"))?;
          patch::apply(self.doc.get_mut(id).unwrap(), &p)?;
          components::record_override(&mut self.doc, id, &p);
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
        let p = json!({ "text": { "characters": characters } });
        let n = self.doc.get_mut(&id).ok_or("no such node")?;
        patch::apply(n, &p)?;
        if n.name.is_empty() || n.name == "Text" {
          n.name = characters.chars().take(40).collect();
        }
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
        let target = ops::frame_at(&self.doc, &self.page, Point::new(x, y), &ids);
        for id in &ids {
          let cur = self.doc.get(id).and_then(|n| n.parent.clone());
          if self.doc.instance_ancestor(id).is_some() {
            continue;
          }
          let in_flow = cur.as_ref().and_then(|p| self.doc.get(p)).map(|p| p.layout.is_some()).unwrap_or(false) && !self.doc.get(id).unwrap().absolute_position;
          if cur != target && !in_flow && cur.as_ref().map(|c| self.doc.get(c).map(|n| n.kind != NodeType::Group).unwrap_or(true)).unwrap_or(true) {
            // Dropping into auto layout inserts at the pointer position.
            let index = target.as_ref().and_then(|t| self.flow_index(t, Point::new(x, y)));
            self.doc.reparent(id, target.as_deref(), index, true);
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
      Command::Resize { ids, handle, dx, dy, keep_aspect, from_center, snap, zoom } => self.resize(&ids, handle, dx, dy, keep_aspect, from_center, snap, zoom),
      Command::Rotate { ids, angle, pivot_x, pivot_y } => {
        ops::rotate(&mut self.doc, &ids, angle, Point::new(pivot_x, pivot_y));
        Ok(json!({}))
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
        n.layout = Some(AutoLayout { direction: if horizontal { LayoutDirection::Horizontal } else { LayoutDirection::Vertical }, ..Default::default() });
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
      Command::CreateInstance { component_id, x, y, parent } => {
        let parent = self.auto_parent(parent, x, y);
        let (lx, ly) = match &parent {
          Some(p) => {
            let l = self.doc.abs_matrix(p).invert().apply(Point::new(x, y));
            (l.x, l.y)
          }
          None => (x, y),
        };
        let page = self.page.clone();
        let id = components::create_instance(&mut self.doc, &component_id, parent.as_deref(), &page, lx, ly, &mut self.gen).ok_or("not a component")?;
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
        let comp = self.doc.get(&id).and_then(|n| n.instance.as_ref()).map(|i| i.component_id.clone()).ok_or("not an instance")?;
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
        self.doc.styles.colors.push(ColorStyle { id: id.clone(), name, color: crate::color::normalize(&color) });
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
        for n in self.doc.nodes.values_mut() {
          if n.fill_style.as_deref() == Some(id.as_str()) {
            n.fills = vec![Paint::solid(&color)];
          }
        }
        Ok(json!({}))
      }
      Command::DeleteStyle { id } => {
        self.doc.styles.colors.retain(|s| s.id != id);
        self.doc.styles.texts.retain(|s| s.id != id);
        for n in self.doc.nodes.values_mut() {
          if n.fill_style.as_deref() == Some(id.as_str()) {
            n.fill_style = None;
          }
          if n.text_style.as_deref() == Some(id.as_str()) {
            n.text_style = None;
          }
        }
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
      | Command::EndGesture
      | Command::CancelGesture
      | Command::Select { .. }
      | Command::SelectAll
      | Command::SetPage { .. } => Ok(json!({})),
    }
  }

  fn infer_direction(&self, id: &str) -> bool {
    let Some(n) = self.doc.get(id) else { return false };
    let rects: Vec<Rect> = n.children.iter().filter_map(|c| self.doc.get(c)).map(|c| Rect::new(c.x, c.y, c.width, c.height)).collect();
    if rects.len() < 2 {
      return false;
    }
    let spread_x = rects.iter().map(|r| r.center().x).fold(f64::NEG_INFINITY, f64::max) - rects.iter().map(|r| r.center().x).fold(f64::INFINITY, f64::min);
    let spread_y = rects.iter().map(|r| r.center().y).fold(f64::NEG_INFINITY, f64::max) - rects.iter().map(|r| r.center().y).fold(f64::INFINITY, f64::min);
    spread_x > spread_y
  }

  fn translate(&mut self, ids: &[NodeId], dx: f64, dy: f64, snap: bool, zoom: f64) -> Result<Value, String> {
    let ids = ops::top_most(&self.doc, ids);
    // Children flowing in auto layout reorder instead of moving freely.
    let (flow, free): (Vec<NodeId>, Vec<NodeId>) = ids.iter().cloned().partition(|id| {
      let n = self.doc.get(id).unwrap();
      !n.absolute_position && n.parent.as_ref().and_then(|p| self.doc.get(p)).map(|p| p.layout.is_some()).unwrap_or(false)
    });
    for id in &flow {
      self.reorder_in_flow(id, dx, dy);
    }
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

  fn reorder_in_flow(&mut self, id: &str, dx: f64, dy: f64) {
    let Some(n) = self.doc.get(id).cloned() else { return };
    let Some(parent) = n.parent.clone() else { return };
    let horizontal = self.doc.get(&parent).and_then(|p| p.layout.as_ref()).map(|l| l.direction == LayoutDirection::Horizontal).unwrap_or(false);
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
  fn resize(&mut self, ids: &[NodeId], handle: Handle, dx: f64, dy: f64, keep_aspect: bool, from_center: bool, snap: bool, zoom: f64) -> Result<Value, String> {
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
      to.width = (from.width + fx * dx * mult).max(1.0);
      to.height = (from.height + fy * dy * mult).max(1.0);
      if keep_aspect && from.height > 0.0 {
        let ratio = from.width / from.height;
        if fx != 0.0 {
          to.height = to.width / ratio;
        } else {
          to.width = to.height * ratio;
        }
      }
      if from_center {
        to.x = from.center().x - to.width / 2.0;
        to.y = from.center().y - to.height / 2.0;
      } else {
        if fx < 0.0 {
          to.x = from.right() - to.width;
        }
        if fy < 0.0 {
          to.y = from.bottom() - to.height;
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
    let parent = parent.filter(|p| self.doc.get(p).map(|n| n.kind.is_frame_like() && n.kind != NodeType::Instance).unwrap_or(false));
    let bounds = Rect::union_all(nodes.iter().filter(|n| roots.contains(&n.id)).map(|n| Rect::new(n.x, n.y, n.width, n.height)));
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
    self.selection = created.clone();
    Ok(json!({ "created": created }))
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
        let (r, guides) = interact::snap_rect(&self.doc, &self.page, &exclude, Rect::new(x, y, 0.0, 0.0), [true, false, true, false], zoom);
        json!({ "x": r.x, "y": r.y, "guides": guides })
      }
      Query::Copy { ids } => json!(self.copy(&ids)),
      Query::ExportSvg { id } => json!(render::export_svg(&self.doc, &id, m)),
      Query::ExportHtml { id } => json!(codegen::export_html(&self.doc, &id, m)),
      Query::ExportReact { id } => json!(codegen::export_react(&self.doc, &id, m)),
      Query::ExportProject => {
        let files: Vec<Value> = codegen::export_project(&self.doc, m).into_iter().map(|f| json!({ "path": f.path, "content": f.content })).collect();
        json!(files)
      }
      Query::ToolDefs => ai::tool_defs(),
      Query::SystemPrompt => json!(ai::SYSTEM_PROMPT),
      Query::Summary { depth } => ai::summary(self, depth),
    })
  }

  /// Serialises the selection (with page-space root positions) for the clipboard.
  pub fn copy(&self, ids: &[NodeId]) -> String {
    let roots = ops::paint_order(&self.doc, &ops::top_most(&self.doc, ids));
    let mut nodes = Vec::new();
    for r in &roots {
      let b = self.doc.abs_bounds(r);
      for nid in self.doc.subtree(r) {
        if let Some(n) = self.doc.get(&nid) {
          let mut c = n.clone();
          if nid == *r {
            let local = self.doc.local_matrix(n).bounds_of(n.width, n.height);
            c.x = b.x + (n.x - local.x);
            c.y = b.y + (n.y - local.y);
            c.parent = None;
          }
          nodes.push(c);
        }
      }
    }
    json!({ "type": CLIPBOARD_TAG, "roots": roots, "nodes": nodes }).to_string()
  }

  pub fn measurer(&self) -> &dyn TextMeasurer {
    self.measurer.as_ref()
  }
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

  #[test]
  fn create_undo_redo() {
    let mut e = engine();
    let r = e.dispatch(Command::CreateShape { kind: NodeType::Rectangle, x: 10.0, y: 10.0, width: 50.0, height: 50.0, parent: None }).unwrap();
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
    let id = id_of(&e.dispatch(Command::CreateShape { kind: NodeType::Rectangle, x: 0.0, y: 0.0, width: 50.0, height: 50.0, parent: None }).unwrap());
    e.dispatch(Command::BeginGesture).unwrap();
    for i in 1..=10 {
      e.dispatch(Command::Translate { ids: vec![id.clone()], dx: i as f64 * 10.0, dy: 0.0, snap: false, zoom: 1.0 }).unwrap();
    }
    e.dispatch(Command::EndGesture).unwrap();
    assert_eq!(e.doc.get(&id).unwrap().x, 100.0);
    e.dispatch(Command::Undo).unwrap();
    assert_eq!(e.doc.get(&id).unwrap().x, 0.0);
  }

  #[test]
  fn shapes_drawn_inside_frames_are_parented() {
    let mut e = engine();
    let f = id_of(&e.dispatch(Command::CreateShape { kind: NodeType::Frame, x: 100.0, y: 100.0, width: 400.0, height: 400.0, parent: None }).unwrap());
    let r = id_of(&e.dispatch(Command::CreateShape { kind: NodeType::Rectangle, x: 150.0, y: 150.0, width: 10.0, height: 10.0, parent: None }).unwrap());
    assert_eq!(e.doc.get(&r).unwrap().parent.as_deref(), Some(f.as_str()));
    assert_eq!(e.doc.get(&r).unwrap().x, 50.0);
  }

  #[test]
  fn copy_paste_roundtrip() {
    let mut e = engine();
    let f = id_of(&e.dispatch(Command::CreateShape { kind: NodeType::Frame, x: 100.0, y: 100.0, width: 200.0, height: 200.0, parent: None }).unwrap());
    e.dispatch(Command::CreateText { x: 120.0, y: 120.0, characters: "Hello".into(), parent: None }).unwrap();
    let data = e.copy(&[f.clone()]);
    let res = e.dispatch(Command::Paste { data, parent: None, x: Some(500.0), y: Some(100.0) }).unwrap();
    let new_id = res["created"][0].as_str().unwrap().to_string();
    let n = e.doc.get(&new_id).unwrap();
    assert_eq!((n.x, n.y), (500.0, 100.0));
    assert_eq!(n.children.len(), 1);
    assert_ne!(n.children[0], e.doc.get(&f).unwrap().children[0]);
  }

  #[test]
  fn instance_updates_when_component_changes() {
    let mut e = engine();
    let f = id_of(&e.dispatch(Command::CreateShape { kind: NodeType::Frame, x: 0.0, y: 0.0, width: 100.0, height: 40.0, parent: None }).unwrap());
    let comp = id_of(&e.dispatch(Command::CreateComponent { ids: vec![f] }).unwrap());
    let inst = id_of(&e.dispatch(Command::CreateInstance { component_id: comp.clone(), x: 300.0, y: 0.0, parent: None }).unwrap());
    e.dispatch(Command::Update { ids: vec![comp.clone()], patch: json!({ "fills": [{ "type": "solid", "color": "#FF0000" }] }) }).unwrap();
    assert_eq!(e.doc.get(&inst).unwrap().fills, vec![Paint::solid("#FF0000")]);
    // Instance override of fill survives further component edits.
    e.dispatch(Command::Update { ids: vec![inst.clone()], patch: json!({ "fills": [{ "type": "solid", "color": "#00FF00" }] }) }).unwrap();
    e.dispatch(Command::Update { ids: vec![comp], patch: json!({ "cornerRadius": 8 }) }).unwrap();
    let i = e.doc.get(&inst).unwrap();
    assert_eq!(i.fills, vec![Paint::solid("#00FF00")]);
    assert_eq!(i.corner_radius, 8.0);
    assert_eq!(i.x, 300.0);
  }

  #[test]
  fn auto_layout_reorders_on_drag() {
    let mut e = engine();
    let a = id_of(&e.dispatch(Command::CreateShape { kind: NodeType::Rectangle, x: 0.0, y: 0.0, width: 50.0, height: 50.0, parent: None }).unwrap());
    let b = id_of(&e.dispatch(Command::CreateShape { kind: NodeType::Rectangle, x: 100.0, y: 0.0, width: 50.0, height: 50.0, parent: None }).unwrap());
    let f = id_of(&e.dispatch(Command::AddAutoLayout { ids: vec![a.clone(), b.clone()] }).unwrap());
    assert_eq!(e.doc.get(&f).unwrap().layout.as_ref().unwrap().direction, LayoutDirection::Horizontal);
    e.dispatch(Command::BeginGesture).unwrap();
    e.dispatch(Command::Translate { ids: vec![a.clone()], dx: 80.0, dy: 0.0, snap: true, zoom: 1.0 }).unwrap();
    e.dispatch(Command::EndGesture).unwrap();
    assert_eq!(e.doc.get(&f).unwrap().children, vec![b, a]);
  }
}
