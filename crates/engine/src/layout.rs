//! Auto layout, hug/fill sizing, text auto-resize, group bounds and constraints.

use crate::geom::Rect;
use crate::model::{Align, ConstraintH, ConstraintV, Document, LayoutDirection, Node, NodeId, NodeType, Sizing, TextAutoResize};
use crate::text::{first_baseline, layout_for_box, layout_of_node, TextMeasurer};

/// Recomputes derived geometry for every page.
pub fn relayout_all(doc: &mut Document, m: &dyn TextMeasurer) {
  let roots: Vec<NodeId> = doc.pages.iter().flat_map(|p| p.children.clone()).collect();
  for r in roots {
    layout_node(doc, &r, m);
  }
}

/// Lays out a node and its subtree bottom-up.
pub fn layout_node(doc: &mut Document, id: &str, m: &dyn TextMeasurer) {
  let Some(node) = doc.get(id) else { return };
  let kind = node.kind;
  let children = node.children.clone();
  match kind {
    NodeType::Text => size_text(doc, id, m),
    NodeType::Group => {
      for c in &children {
        layout_node(doc, c, m);
      }
      normalize_group(doc, id);
    }
    k if k.is_frame_like() => {
      for c in &children {
        layout_node(doc, c, m);
      }
      if doc.get(id).map(|n| n.layout.is_some()).unwrap_or(false) {
        arrange(doc, id, m);
      }
    }
    _ => {}
  }
}

fn size_text(doc: &mut Document, id: &str, m: &dyn TextMeasurer) {
  let Some(n) = doc.get(id) else { return };
  let Some(props) = n.text.clone() else { return };
  let mut props = props;
  // A text that fills its auto layout parent horizontally wraps instead of growing.
  if n.sizing_h == Sizing::Fill && props.auto_resize == TextAutoResize::Width && parent_has_layout(doc, id) {
    props.auto_resize = TextAutoResize::Height;
  }
  let lay = layout_of_node(n, &props, m);
  let min_w = bounds(n, true).0;
  let (min_h, max_h) = bounds(n, false);
  let n = doc.get_mut(id).unwrap();
  match props.auto_resize {
    TextAutoResize::Width => {
      n.width = clamp_to(lay.width.ceil(), (min_w, f64::INFINITY)).max(1.0);
      n.height = clamp_to(lay.height.ceil(), (min_h, max_h)).max(1.0);
    }
    TextAutoResize::Height => n.height = clamp_to(lay.height.ceil(), (min_h, max_h)).max(1.0),
    TextAutoResize::None => {}
  }
  n.text = Some(props);
}

/// The (min, max) size limits of a layer along one axis.
fn bounds(n: &Node, horizontal: bool) -> (f64, f64) {
  let (lo, hi) = if horizontal {
    (n.min_width, n.max_width)
  } else {
    (n.min_height, n.max_height)
  };
  (lo.unwrap_or(0.0), hi.unwrap_or(f64::INFINITY))
}

/// Limits a size to its bounds; the minimum wins when they cross.
fn clamp_to(v: f64, (lo, hi): (f64, f64)) -> f64 {
  v.min(hi).max(lo)
}

fn parent_has_layout(doc: &Document, id: &str) -> bool {
  doc
    .get(id)
    .and_then(|n| n.parent.as_ref())
    .and_then(|p| doc.get(p))
    .map(|p| p.layout.is_some())
    .unwrap_or(false)
}

/// Shrinks/grows a group to tightly wrap its children without moving them on the page.
pub fn normalize_group(doc: &mut Document, id: &str) {
  let Some(g) = doc.get(id) else { return };
  let children = g.children.clone();
  let bounds = Rect::union_all(
    children
      .iter()
      .filter_map(|c| doc.get(c))
      .map(|c| doc.local_matrix(c).bounds_of(c.width, c.height)),
  );
  let Some(b) = bounds else { return };
  if b.x != 0.0 || b.y != 0.0 {
    for c in &children {
      if let Some(cn) = doc.get_mut(c) {
        cn.x -= b.x;
        cn.y -= b.y;
      }
    }
  }
  let g = doc.get_mut(id).unwrap();
  g.x += b.x;
  g.y += b.y;
  g.width = b.width.max(0.01);
  g.height = b.height.max(0.01);
  g.rotation = 0.0;
}

struct Item {
  id: NodeId,
  main: f64,
  counter: f64,
  fill_main: bool,
  fill_counter: bool,
}

/// Geometry shared by the passes of one `arrange`.
struct Axes {
  horizontal: bool,
  wrap: bool,
  /// Padding along the main and the cross axis (both sides added).
  pad_main: f64,
  pad_cross: f64,
  gap_total: f64,
}

fn arrange(doc: &mut Document, id: &str, m: &dyn TextMeasurer) {
  let frame = doc.get(id).unwrap().clone();
  let al = frame.layout.clone().unwrap();
  let horizontal = al.direction == LayoutDirection::Horizontal;
  let (pad_main_start, pad_main_end, pad_cross_start, pad_cross_end) = if horizontal {
    (al.padding_left, al.padding_right, al.padding_top, al.padding_bottom)
  } else {
    (al.padding_top, al.padding_bottom, al.padding_left, al.padding_right)
  };
  let (main_sizing, cross_sizing) = if horizontal {
    (frame.sizing_h, frame.sizing_v)
  } else {
    (frame.sizing_v, frame.sizing_h)
  };
  let main_bounds = bounds(&frame, horizontal);
  let cross_bounds = bounds(&frame, !horizontal);
  let flow: Vec<NodeId> = frame
    .children
    .iter()
    .filter(|c| doc.get(c).map(|n| n.visible && !n.absolute_position).unwrap_or(false))
    .cloned()
    .collect();

  let mut items: Vec<Item> = flow.iter().map(|c| item_of(doc, c, horizontal)).collect();
  let n = items.len();
  let gap_total = if n > 1 && al.primary_align != Align::SpaceBetween {
    al.gap * (n as f64 - 1.0)
  } else {
    0.0
  };

  let mut main_size = if horizontal { frame.width } else { frame.height };
  let mut cross_size = if horizontal { frame.height } else { frame.width };
  let wrap = al.wrap && horizontal && main_sizing != Sizing::Hug;
  let mut ax = Axes {
    horizontal,
    wrap,
    pad_main: pad_main_start + pad_main_end,
    pad_cross: pad_cross_start + pad_cross_end,
    gap_total,
  };
  // A hugging frame with wrap and a max width wraps once its content passes the max.
  let wrap_at_max = al.wrap && horizontal && main_sizing == Sizing::Hug && main_bounds.1.is_finite();
  let mut offsets: Vec<f64> = vec![0.0; n];

  // Widths settle before heights (wrapping text grows taller when narrower), so a vertical
  // layout resolves its cross axis (width) first and a horizontal one its main axis.
  let mut wrap = wrap;
  if horizontal {
    if main_pass(doc, m, &ax, &mut items, &mut main_size, main_sizing, main_bounds, wrap_at_max) {
      wrap = true;
      ax.wrap = true;
    }
    // Baseline alignment only exists across a single row.
    if al.counter_align == Align::Baseline && !wrap {
      offsets = baseline_offsets(doc, m, &items);
    }
    cross_pass(doc, m, &ax, &mut items, &mut cross_size, cross_sizing, cross_bounds, &offsets);
  } else {
    cross_pass(doc, m, &ax, &mut items, &mut cross_size, cross_sizing, cross_bounds, &offsets);
    main_pass(doc, m, &ax, &mut items, &mut main_size, main_sizing, main_bounds, false);
  }
  let baseline = al.counter_align == Align::Baseline && horizontal && !wrap;

  if wrap {
    if main_sizing == Sizing::Hug {
      doc.get_mut(id).unwrap().width = main_size.max(1.0);
    }
    arrange_wrapped(doc, id, &items, main_size, cross_sizing == Sizing::Hug);
    return;
  }

  // Position items.
  let inner_main = main_size - ax.pad_main;
  let inner_cross = cross_size - ax.pad_cross;
  let used: f64 = items.iter().map(|i| i.main).sum::<f64>() + gap_total;
  let free = inner_main - used;
  let (mut cursor, gap) = match al.primary_align {
    Align::Start | Align::Baseline => (pad_main_start, al.gap),
    Align::Center => (pad_main_start + free / 2.0, al.gap),
    Align::End => (pad_main_start + free, al.gap),
    Align::SpaceBetween => {
      let g = if n > 1 {
        (inner_main - items.iter().map(|i| i.main).sum::<f64>()) / (n as f64 - 1.0)
      } else {
        0.0
      };
      (pad_main_start, g)
    }
  };
  for (i, it) in items.iter().enumerate() {
    let cross = match al.counter_align {
      Align::Center => pad_cross_start + (inner_cross - it.counter) / 2.0,
      Align::End => pad_cross_start + inner_cross - it.counter,
      Align::Baseline if baseline => pad_cross_start + offsets[i],
      _ => pad_cross_start,
    };
    if let Some(c) = doc.get_mut(&it.id) {
      c.rotation = 0.0;
      if horizontal {
        c.x = cursor;
        c.y = cross;
      } else {
        c.y = cursor;
        c.x = cross;
      }
    }
    cursor += it.main + gap;
  }

  let f = doc.get_mut(id).unwrap();
  if horizontal {
    f.width = main_size.max(1.0);
    f.height = cross_size.max(1.0);
  } else {
    f.height = main_size.max(1.0);
    f.width = cross_size.max(1.0);
  }
}

fn item_of(doc: &Document, cid: &str, horizontal: bool) -> Item {
  let c = doc.get(cid).unwrap();
  let (main, counter) = if horizontal { (c.width, c.height) } else { (c.height, c.width) };
  let (sm, sc) = if horizontal {
    (c.sizing_h, c.sizing_v)
  } else {
    (c.sizing_v, c.sizing_h)
  };
  Item {
    id: cid.to_string(),
    main,
    counter,
    fill_main: sm == Sizing::Fill,
    fill_counter: sc == Sizing::Fill,
  }
}

/// Resolves the frame's size along the main axis and the main size of its fill children.
/// Returns true when a hugging frame is held back by its max width and `wrap_at_max` asks its
/// children to wrap into rows instead of sharing the width.
#[allow(clippy::too_many_arguments)]
fn main_pass(
  doc: &mut Document,
  m: &dyn TextMeasurer,
  ax: &Axes,
  items: &mut [Item],
  main_size: &mut f64,
  sizing: Sizing,
  limits: (f64, f64),
  wrap_at_max: bool,
) -> bool {
  let horizontal = ax.horizontal;
  if sizing == Sizing::Hug {
    // Fill children can't fill a frame that hugs them: they hug their own content instead.
    for it in items.iter_mut().filter(|i| i.fill_main) {
      let size = hug_size(doc, &it.id, horizontal, m);
      set_size(doc, &it.id, horizontal, Some(size), None);
      layout_node(doc, &it.id, m);
      *it = item_of(doc, &it.id, horizontal);
      it.main = size;
    }
    let natural = items.iter().map(|i| i.main).sum::<f64>() + ax.gap_total + ax.pad_main;
    *main_size = clamp_to(natural, limits);
    // Held back by a maximum (or pushed out by a minimum): fill children share what is left.
    if *main_size < natural && wrap_at_max {
      return true;
    }
    if *main_size != natural {
      share_main(doc, m, ax, items, *main_size - ax.pad_main);
    }
  } else if !ax.wrap {
    share_main(doc, m, ax, items, *main_size - ax.pad_main);
  }
  false
}

/// Splits `inner` (main axis, padding excluded) between the fill children after the fixed
/// ones and the gaps. A child that would pass its max or min size keeps that size and the
/// others share the rest.
fn share_main(doc: &mut Document, m: &dyn TextMeasurer, ax: &Axes, items: &mut [Item], inner: f64) {
  let fixed: f64 = items.iter().filter(|i| !i.fill_main).map(|i| i.main).sum();
  let fills: Vec<usize> = (0..items.len()).filter(|i| items[*i].fill_main).collect();
  if fills.is_empty() {
    return;
  }
  let limits: Vec<(f64, f64)> = fills
    .iter()
    .map(|i| bounds(doc.get(&items[*i].id).unwrap(), ax.horizontal))
    .collect();
  let mut size: Vec<Option<f64>> = vec![None; fills.len()];
  let avail = inner - fixed - ax.gap_total;
  loop {
    let held: f64 = size.iter().flatten().sum();
    let open = size.iter().filter(|s| s.is_none()).count();
    if open == 0 {
      break;
    }
    let each = ((avail - held) / open as f64).max(1.0);
    let mut frozen = false;
    for (j, s) in size.iter_mut().enumerate().filter(|(_, s)| s.is_none()) {
      let (lo, hi) = limits[j];
      if each > hi {
        *s = Some(hi.max(lo));
        frozen = true;
      } else if each < lo {
        *s = Some(lo);
        frozen = true;
      }
    }
    if !frozen {
      for s in size.iter_mut().filter(|s| s.is_none()) {
        *s = Some(each);
      }
      break;
    }
  }
  for (j, i) in fills.iter().enumerate() {
    let each = size[j].unwrap_or(1.0).max(1.0);
    let it = &mut items[*i];
    set_size(doc, &it.id, ax.horizontal, Some(each), None);
    layout_node(doc, &it.id, m);
    *it = item_of(doc, &it.id, ax.horizontal);
    it.main = each;
  }
}

/// Resolves the frame's size along the cross axis and the cross size of its fill children. A
/// hugging frame wraps its other children and fill children stretch to match; when every
/// child fills, the frame hugs their own content.
#[allow(clippy::too_many_arguments)]
fn cross_pass(
  doc: &mut Document,
  m: &dyn TextMeasurer,
  ax: &Axes,
  items: &mut [Item],
  cross_size: &mut f64,
  sizing: Sizing,
  limits: (f64, f64),
  offsets: &[f64],
) {
  let horizontal = ax.horizontal;
  let hug_cross = sizing == Sizing::Hug;
  if hug_cross && !ax.wrap {
    let fixed = items
      .iter()
      .enumerate()
      .filter(|(_, i)| !i.fill_counter)
      .map(|(k, i)| i.counter + offsets[k])
      .reduce(f64::max);
    let max_c = match fixed {
      Some(c) => c,
      None => {
        let fills: Vec<NodeId> = items.iter().filter(|i| i.fill_counter).map(|i| i.id.clone()).collect();
        fills.iter().map(|c| hug_size(doc, c, !horizontal, m)).fold(0.0, f64::max)
      }
    };
    *cross_size = clamp_to(max_c + ax.pad_cross, limits);
  }
  let inner_cross = (*cross_size - ax.pad_cross).max(1.0);
  if !(hug_cross && ax.wrap) {
    for it in items.iter_mut().filter(|i| i.fill_counter) {
      let size = clamp_to(inner_cross, bounds(doc.get(&it.id).unwrap(), !horizontal));
      set_size(doc, &it.id, horizontal, None, Some(size));
      layout_node(doc, &it.id, m);
      *it = item_of(doc, &it.id, horizontal);
    }
  }
}

/// How far each item sits below the row's top so their first baselines line up (items that
/// stretch across the row keep offset 0 and don't take part).
fn baseline_offsets(doc: &Document, m: &dyn TextMeasurer, items: &[Item]) -> Vec<f64> {
  let bases: Vec<Option<f64>> = items
    .iter()
    .map(|i| {
      if i.fill_counter {
        None
      } else {
        Some(baseline_of(doc, &i.id, m, 0))
      }
    })
    .collect();
  let top = bases.iter().flatten().cloned().fold(0.0, f64::max);
  bases.iter().map(|b| b.map(|b| top - b).unwrap_or(0.0)).collect()
}

/// First baseline of a layer measured from its top: text has one, a frame takes its first
/// flowing child's, anything else sits on its bottom edge.
fn baseline_of(doc: &Document, id: &str, m: &dyn TextMeasurer, depth: usize) -> f64 {
  let Some(n) = doc.get(id) else { return 0.0 };
  if let (NodeType::Text, Some(t)) = (n.kind, n.text.as_ref()) {
    return first_baseline(n, t, m);
  }
  if depth < 8 && n.kind.is_frame_like() && n.layout.is_some() {
    let first = n
      .children
      .iter()
      .filter_map(|c| doc.get(c))
      .find(|c| c.visible && !c.absolute_position);
    if let Some(c) = first {
      return c.y + baseline_of(doc, &c.id, m, depth + 1);
    }
  }
  n.height
}

/// Size a fill child would have if it hugged its content along one axis (used when its
/// parent hugs): text measures unwrapped (or at its width, for height), auto layout frames
/// lay out as hug, and other layers have no content to hug so they keep their size. The
/// result stays within the child's min and max size.
fn hug_size(doc: &mut Document, id: &str, horizontal: bool, m: &dyn TextMeasurer) -> f64 {
  let Some(n) = doc.get(id).cloned() else { return 1.0 };
  let size = match (n.kind, n.text.clone()) {
    (NodeType::Text, Some(mut t)) => {
      if horizontal {
        t.auto_resize = TextAutoResize::Width;
      }
      let lay = layout_for_box(&t, n.width, Some(n.height), None, m);
      if horizontal {
        lay.width.ceil()
      } else {
        lay.height.ceil()
      }
    }
    (k, _) if k.is_frame_like() && n.layout.is_some() => {
      // Lay it out as hug on that axis, read the size, then put its sizing back.
      let set = |doc: &mut Document, s: Sizing| {
        if let Some(c) = doc.get_mut(id) {
          if horizontal {
            c.sizing_h = s;
          } else {
            c.sizing_v = s;
          }
        }
      };
      set(doc, Sizing::Hug);
      layout_node(doc, id, m);
      let c = doc.get(id).unwrap();
      let size = if horizontal { c.width } else { c.height };
      set(doc, Sizing::Fill);
      size
    }
    _ if horizontal => n.width,
    _ => n.height,
  };
  clamp_to(size, bounds(&n, horizontal)).max(1.0)
}

fn arrange_wrapped(doc: &mut Document, id: &str, items: &[Item], width: f64, hug_cross: bool) {
  let al = doc.get(id).unwrap().layout.clone().unwrap();
  let inner = width - al.padding_left - al.padding_right;
  let mut rows: Vec<Vec<&Item>> = vec![Vec::new()];
  let mut row_w = 0.0;
  for it in items {
    let row = rows.last_mut().unwrap();
    let add = if row.is_empty() { it.main } else { al.gap + it.main };
    if !row.is_empty() && row_w + add > inner + 0.01 {
      rows.push(vec![it]);
      row_w = it.main;
    } else {
      row.push(it);
      row_w += add;
    }
  }
  let mut y = al.padding_top;
  for row in &rows {
    let row_h = row.iter().map(|i| i.counter).fold(0.0, f64::max);
    let used: f64 = row.iter().map(|i| i.main).sum::<f64>() + al.gap * (row.len().max(1) as f64 - 1.0);
    let mut x = al.padding_left
      + match al.primary_align {
        Align::Center => (inner - used) / 2.0,
        Align::End => inner - used,
        _ => 0.0,
      };
    for it in row {
      let cy = match al.counter_align {
        Align::Center => y + (row_h - it.counter) / 2.0,
        Align::End => y + row_h - it.counter,
        _ => y,
      };
      if let Some(c) = doc.get_mut(&it.id) {
        c.x = x;
        c.y = cy;
        c.rotation = 0.0;
      }
      x += it.main + al.gap;
    }
    y += row_h + al.counter_gap;
  }
  if hug_cross {
    let h = y - al.counter_gap + al.padding_bottom;
    let f = doc.get_mut(id).unwrap();
    f.height = clamp_to(h, (f.min_height.unwrap_or(0.0), f.max_height.unwrap_or(f64::INFINITY))).max(1.0);
  }
}

fn set_size(doc: &mut Document, id: &str, horizontal: bool, main: Option<f64>, cross: Option<f64>) {
  if let Some(c) = doc.get_mut(id) {
    let (w, h) = if horizontal { (main, cross) } else { (cross, main) };
    if let Some(w) = w {
      c.width = w;
    }
    if let Some(h) = h {
      c.height = h;
    }
  }
}

/// Applies child constraints after a (non auto layout) frame changes size.
pub fn apply_constraints(doc: &mut Document, frame_id: &str, old_w: f64, old_h: f64) {
  let Some(f) = doc.get(frame_id) else { return };
  if f.layout.is_some() || !f.kind.is_frame_like() {
    return;
  }
  let (nw, nh) = (f.width, f.height);
  let (dw, dh) = (nw - old_w, nh - old_h);
  if dw == 0.0 && dh == 0.0 {
    return;
  }
  let sx = if old_w > 0.0 { nw / old_w } else { 1.0 };
  let sy = if old_h > 0.0 { nh / old_h } else { 1.0 };
  for cid in f.children.clone() {
    let Some(c) = doc.get_mut(&cid) else { continue };
    let (cw, ch) = (c.width, c.height);
    match c.constraints.horizontal {
      ConstraintH::Left => {}
      ConstraintH::Right => c.x += dw,
      ConstraintH::LeftRight => c.width = (c.width + dw).max(1.0),
      ConstraintH::Center => c.x += dw / 2.0,
      ConstraintH::Scale => {
        c.x *= sx;
        c.width = (c.width * sx).max(1.0);
      }
    }
    match c.constraints.vertical {
      ConstraintV::Top => {}
      ConstraintV::Bottom => c.y += dh,
      ConstraintV::TopBottom => c.height = (c.height + dh).max(1.0),
      ConstraintV::Center => c.y += dh / 2.0,
      ConstraintV::Scale => {
        c.y *= sy;
        c.height = (c.height * sy).max(1.0);
      }
    }
    let kind = c.kind;
    if kind.is_frame_like() {
      apply_constraints(doc, &cid, cw, ch);
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::doc::{new_document, IdGen};
  use crate::model::{AutoLayout, Node};
  use crate::text::HeuristicMeasurer;

  fn setup() -> (Document, String) {
    let mut ids = IdGen::new(1);
    let doc = new_document(&mut ids, "t");
    let page = doc.pages[0].id.clone();
    (doc, page)
  }

  #[test]
  fn horizontal_hug() {
    let (mut doc, page) = setup();
    let frame = Node {
      id: "f".into(),
      kind: NodeType::Frame,
      layout: Some(AutoLayout {
        direction: LayoutDirection::Horizontal,
        gap: 10.0,
        ..Default::default()
      }),
      sizing_h: Sizing::Hug,
      sizing_v: Sizing::Hug,
      ..Default::default()
    };
    doc.insert(frame, None, &page, None);
    for (i, w) in [50.0, 30.0].iter().enumerate() {
      let n = Node {
        id: format!("c{i}"),
        width: *w,
        height: 20.0 + i as f64 * 10.0,
        ..Default::default()
      };
      doc.insert(n, Some("f"), &page, None);
    }
    relayout_all(&mut doc, &HeuristicMeasurer);
    let f = doc.get("f").unwrap();
    assert_eq!(f.width, 10.0 + 50.0 + 10.0 + 30.0 + 10.0);
    assert_eq!(f.height, 10.0 + 30.0 + 10.0);
    assert_eq!(doc.get("c1").unwrap().x, 70.0);
  }

  #[test]
  fn fill_children_share_space() {
    let (mut doc, page) = setup();
    let frame = Node {
      id: "f".into(),
      kind: NodeType::Frame,
      width: 220.0,
      height: 100.0,
      layout: Some(AutoLayout {
        direction: LayoutDirection::Horizontal,
        gap: 0.0,
        padding_left: 10.0,
        padding_right: 10.0,
        ..Default::default()
      }),
      ..Default::default()
    };
    doc.insert(frame, None, &page, None);
    for i in 0..2 {
      let n = Node {
        id: format!("c{i}"),
        sizing_h: Sizing::Fill,
        sizing_v: Sizing::Fill,
        ..Default::default()
      };
      doc.insert(n, Some("f"), &page, None);
    }
    relayout_all(&mut doc, &HeuristicMeasurer);
    assert_eq!(doc.get("c0").unwrap().width, 100.0);
    assert_eq!(doc.get("c1").unwrap().x, 110.0);
    assert_eq!(doc.get("c1").unwrap().height, 80.0);
  }

  #[test]
  fn hug_parent_sizes_fill_children_to_their_content() {
    let (mut doc, page) = setup();
    // A 700 px card whose text fills its width.
    let card = Node {
      id: "card".into(),
      kind: NodeType::Frame,
      width: 700.0,
      layout: Some(AutoLayout::default()),
      sizing_v: Sizing::Hug,
      ..Default::default()
    };
    doc.insert(card, None, &page, None);
    let props = crate::model::TextProps {
      characters: "Hello".into(),
      ..Default::default()
    };
    let natural = crate::text::layout_text(&props, None, &HeuristicMeasurer).width.ceil();
    let label = Node {
      id: "label".into(),
      kind: NodeType::Text,
      sizing_h: Sizing::Fill,
      text: Some(props),
      ..Default::default()
    };
    doc.insert(label, Some("card"), &page, None);
    relayout_all(&mut doc, &HeuristicMeasurer);
    assert_eq!(doc.get("label").unwrap().width, 680.0);
    doc.get_mut("card").unwrap().sizing_h = Sizing::Hug;
    relayout_all(&mut doc, &HeuristicMeasurer);
    assert_eq!(
      doc.get("card").unwrap().width,
      natural + 20.0,
      "hugs the text, not its old fill width"
    );
    assert_eq!(doc.get("label").unwrap().width, natural);
    // With a fixed sibling the card hugs that, and the fill child stretches to match.
    let bar = Node {
      id: "bar".into(),
      width: 200.0,
      height: 4.0,
      ..Default::default()
    };
    doc.insert(bar, Some("card"), &page, None);
    relayout_all(&mut doc, &HeuristicMeasurer);
    assert_eq!(doc.get("card").unwrap().width, 220.0);
    assert_eq!(doc.get("label").unwrap().width, 200.0);

    // Main axis: a row that hugs, with a fill child that is itself an auto layout frame.
    let row = Node {
      id: "row".into(),
      kind: NodeType::Frame,
      width: 700.0,
      layout: Some(AutoLayout {
        direction: LayoutDirection::Horizontal,
        ..Default::default()
      }),
      sizing_v: Sizing::Hug,
      ..Default::default()
    };
    doc.insert(row, None, &page, None);
    let icon = Node {
      id: "icon".into(),
      width: 50.0,
      height: 50.0,
      ..Default::default()
    };
    doc.insert(icon, Some("row"), &page, None);
    let body = Node {
      id: "body".into(),
      kind: NodeType::Frame,
      layout: Some(AutoLayout {
        padding_top: 0.0,
        padding_right: 0.0,
        padding_bottom: 0.0,
        padding_left: 0.0,
        ..Default::default()
      }),
      sizing_h: Sizing::Fill,
      sizing_v: Sizing::Hug,
      ..Default::default()
    };
    doc.insert(body, Some("row"), &page, None);
    let dot = Node {
      id: "dot".into(),
      width: 30.0,
      height: 30.0,
      ..Default::default()
    };
    doc.insert(dot, Some("body"), &page, None);
    relayout_all(&mut doc, &HeuristicMeasurer);
    assert_eq!(doc.get("body").unwrap().width, 620.0);
    doc.get_mut("row").unwrap().sizing_h = Sizing::Hug;
    relayout_all(&mut doc, &HeuristicMeasurer);
    assert_eq!(doc.get("body").unwrap().width, 30.0);
    assert_eq!(doc.get("row").unwrap().width, 10.0 + 50.0 + 10.0 + 30.0 + 10.0);
  }

  fn row(id: &str, width: f64, sizing_h: Sizing) -> Node {
    Node {
      id: id.into(),
      kind: NodeType::Frame,
      width,
      height: 100.0,
      layout: Some(AutoLayout {
        direction: LayoutDirection::Horizontal,
        gap: 0.0,
        padding_top: 0.0,
        padding_right: 0.0,
        padding_bottom: 0.0,
        padding_left: 0.0,
        ..Default::default()
      }),
      sizing_h,
      ..Default::default()
    }
  }

  #[test]
  fn fill_clamps_at_max_and_min() {
    let (mut doc, page) = setup();
    doc.insert(row("f", 300.0, Sizing::Fixed), None, &page, None);
    for (i, (min, max)) in [(None, Some(50.0)), (None, None), (Some(160.0), None)].into_iter().enumerate() {
      let n = Node {
        id: format!("c{i}"),
        sizing_h: Sizing::Fill,
        min_width: min,
        max_width: max,
        ..Default::default()
      };
      doc.insert(n, Some("f"), &page, None);
    }
    relayout_all(&mut doc, &HeuristicMeasurer);
    // c0 stops at its max, c2 keeps its min; the middle one gets what remains.
    assert_eq!(doc.get("c0").unwrap().width, 50.0);
    assert_eq!(doc.get("c2").unwrap().width, 160.0);
    assert_eq!(doc.get("c1").unwrap().width, 90.0);
    assert_eq!(doc.get("c1").unwrap().x, 50.0);
    assert_eq!(doc.get("c2").unwrap().x, 140.0);
    // Only a max on every fill child leaves free space instead of stretching them.
    doc.get_mut("c1").unwrap().max_width = Some(30.0);
    doc.get_mut("c2").unwrap().min_width = None;
    doc.get_mut("c2").unwrap().max_width = Some(40.0);
    relayout_all(&mut doc, &HeuristicMeasurer);
    assert_eq!(
      [
        doc.get("c0").unwrap().width,
        doc.get("c1").unwrap().width,
        doc.get("c2").unwrap().width
      ],
      [50.0, 30.0, 40.0]
    );
  }

  #[test]
  fn hug_respects_min_and_max() {
    let (mut doc, page) = setup();
    doc.insert(row("f", 0.0, Sizing::Hug), None, &page, None);
    {
      let f = doc.get_mut("f").unwrap();
      f.min_width = Some(120.0);
      f.sizing_v = Sizing::Hug;
      f.min_height = Some(60.0);
    }
    let kid = Node {
      id: "k".into(),
      width: 40.0,
      height: 20.0,
      ..Default::default()
    };
    doc.insert(kid, Some("f"), &page, None);
    relayout_all(&mut doc, &HeuristicMeasurer);
    let f = doc.get("f").unwrap();
    assert_eq!((f.width, f.height), (120.0, 60.0), "grows to its minimum");
    // A max below the content holds it back, and a fill child wraps inside what is left.
    let props = crate::model::TextProps {
      characters: "a fairly long sentence that needs several lines".into(),
      ..Default::default()
    };
    let label = Node {
      id: "l".into(),
      kind: NodeType::Text,
      sizing_h: Sizing::Fill,
      text: Some(props),
      ..Default::default()
    };
    doc.insert(label, Some("f"), &page, None);
    {
      let f = doc.get_mut("f").unwrap();
      f.min_width = None;
      f.min_height = None;
      f.max_width = Some(200.0);
    }
    relayout_all(&mut doc, &HeuristicMeasurer);
    let f = doc.get("f").unwrap();
    assert_eq!(f.width, 200.0);
    assert_eq!(doc.get("l").unwrap().width, 160.0, "text fills what the fixed child leaves");
    assert!(doc.get("l").unwrap().height > 20.0, "and wraps");
    assert_eq!(f.height, doc.get("l").unwrap().height.max(20.0));
  }

  #[test]
  fn vertical_hug_card_wraps_text_at_max_width() {
    let (mut doc, page) = setup();
    let card = Node {
      id: "card".into(),
      kind: NodeType::Frame,
      layout: Some(AutoLayout {
        padding_top: 0.0,
        padding_right: 0.0,
        padding_bottom: 0.0,
        padding_left: 0.0,
        ..Default::default()
      }),
      sizing_h: Sizing::Hug,
      sizing_v: Sizing::Hug,
      max_width: Some(150.0),
      ..Default::default()
    };
    doc.insert(card, None, &page, None);
    let props = crate::model::TextProps {
      characters: "a fairly long sentence that needs several lines".into(),
      ..Default::default()
    };
    let label = Node {
      id: "l".into(),
      kind: NodeType::Text,
      sizing_h: Sizing::Fill,
      text: Some(props),
      ..Default::default()
    };
    doc.insert(label, Some("card"), &page, None);
    relayout_all(&mut doc, &HeuristicMeasurer);
    let (card, l) = (doc.get("card").unwrap(), doc.get("l").unwrap());
    assert_eq!(card.width, 150.0);
    assert_eq!(l.width, 150.0);
    assert!(l.height > 19.2 * 2.0);
    assert_eq!(card.height, l.height, "the card is as tall as the wrapped text");
  }

  #[test]
  fn text_max_width_wraps_auto_width_text() {
    let (mut doc, page) = setup();
    let props = crate::model::TextProps {
      characters: "a fairly long sentence that needs several lines".into(),
      ..Default::default()
    };
    let t = Node {
      id: "t".into(),
      kind: NodeType::Text,
      text: Some(props),
      max_width: Some(120.0),
      ..Default::default()
    };
    doc.insert(t, None, &page, None);
    relayout_all(&mut doc, &HeuristicMeasurer);
    let t = doc.get("t").unwrap();
    assert!(t.width <= 120.0 && t.width > 60.0, "{}", t.width);
    assert!(t.height > 19.2 * 2.0);
  }

  #[test]
  fn baseline_aligns_texts_of_different_sizes() {
    let (mut doc, page) = setup();
    let mut r = row("f", 0.0, Sizing::Hug);
    r.sizing_v = Sizing::Hug;
    r.layout.as_mut().unwrap().counter_align = Align::Baseline;
    doc.insert(r, None, &page, None);
    for (id, size) in [("big", 40.0), ("small", 14.0)] {
      let props = crate::model::TextProps {
        characters: "Hg".into(),
        font_size: size,
        ..Default::default()
      };
      let t = Node {
        id: id.into(),
        kind: NodeType::Text,
        text: Some(props),
        ..Default::default()
      };
      doc.insert(t, Some("f"), &page, None);
    }
    relayout_all(&mut doc, &HeuristicMeasurer);
    let m = HeuristicMeasurer;
    let base = |id: &str| {
      let n = doc.get(id).unwrap();
      n.y + first_baseline(n, n.text.as_ref().unwrap(), &m)
    };
    assert!((base("big") - base("small")).abs() < 0.01, "{} vs {}", base("big"), base("small"));
    assert!(doc.get("small").unwrap().y > doc.get("big").unwrap().y, "the small text sits lower");
    assert_eq!(doc.get("big").unwrap().y, 0.0);
    // The row is as tall as the lowest bottom edge.
    let f = doc.get("f").unwrap();
    let small = doc.get("small").unwrap();
    assert_eq!(f.height, (small.y + small.height).max(doc.get("big").unwrap().height));
    // Start alignment puts both on top again.
    doc.get_mut("f").unwrap().layout.as_mut().unwrap().counter_align = Align::Start;
    relayout_all(&mut doc, &HeuristicMeasurer);
    assert_eq!(doc.get("small").unwrap().y, 0.0);
  }

  #[test]
  fn hug_frame_with_wrap_wraps_at_its_max_width() {
    let (mut doc, page) = setup();
    let mut r = row("f", 0.0, Sizing::Hug);
    r.sizing_v = Sizing::Hug;
    r.layout.as_mut().unwrap().wrap = true;
    r.layout.as_mut().unwrap().counter_gap = 5.0;
    r.max_width = Some(200.0);
    doc.insert(r, None, &page, None);
    for i in 0..5 {
      let n = Node {
        id: format!("c{i}"),
        width: 60.0,
        height: 20.0,
        ..Default::default()
      };
      doc.insert(n, Some("f"), &page, None);
    }
    relayout_all(&mut doc, &HeuristicMeasurer);
    let f = doc.get("f").unwrap();
    assert_eq!(f.width, 200.0, "held at the max");
    // Three children fit a 200 px row, two go to the next.
    assert_eq!(doc.get("c2").unwrap().y, 0.0);
    assert_eq!(doc.get("c3").unwrap().y, 25.0);
    assert_eq!(doc.get("c3").unwrap().x, 0.0);
    assert_eq!(f.height, 45.0);
    // Under the max it stays one row and hugs.
    doc.get_mut("f").unwrap().max_width = Some(400.0);
    relayout_all(&mut doc, &HeuristicMeasurer);
    let f = doc.get("f").unwrap();
    assert_eq!((f.width, f.height), (300.0, 20.0));
    assert_eq!(doc.get("c4").unwrap().x, 240.0);
  }

  #[test]
  fn constraints_right() {
    let (mut doc, page) = setup();
    doc.insert(
      Node {
        id: "f".into(),
        kind: NodeType::Frame,
        width: 200.0,
        height: 200.0,
        ..Default::default()
      },
      None,
      &page,
      None,
    );
    let mut c = Node {
      id: "c".into(),
      x: 150.0,
      width: 40.0,
      ..Default::default()
    };
    c.constraints.horizontal = ConstraintH::Right;
    doc.insert(c, Some("f"), &page, None);
    doc.get_mut("f").unwrap().width = 300.0;
    apply_constraints(&mut doc, "f", 200.0, 200.0);
    assert_eq!(doc.get("c").unwrap().x, 250.0);
  }
}
