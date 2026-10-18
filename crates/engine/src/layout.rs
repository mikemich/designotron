//! Auto layout, hug/fill sizing, text auto-resize, group bounds and constraints.

use crate::geom::Rect;
use crate::model::{Align, ConstraintH, ConstraintV, Document, LayoutDirection, NodeId, NodeType, Sizing, TextAutoResize};
use crate::text::{layout_for_node, TextMeasurer};

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
  let lay = layout_for_node(&props, n.width, m);
  let n = doc.get_mut(id).unwrap();
  match props.auto_resize {
    TextAutoResize::Width => {
      n.width = lay.width.ceil().max(1.0);
      n.height = lay.height.ceil().max(1.0);
    }
    TextAutoResize::Height => n.height = lay.height.ceil().max(1.0),
    TextAutoResize::None => {}
  }
  n.text = Some(props);
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
  let flow: Vec<NodeId> = frame
    .children
    .iter()
    .filter(|c| doc.get(c).map(|n| n.visible && !n.absolute_position).unwrap_or(false))
    .cloned()
    .collect();

  let item_of = |doc: &Document, cid: &str| -> Item {
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
  };
  let mut items: Vec<Item> = flow.iter().map(|c| item_of(doc, c)).collect();
  let n = items.len();
  let gap_total = if n > 1 && al.primary_align != Align::SpaceBetween {
    al.gap * (n as f64 - 1.0)
  } else {
    0.0
  };

  // Main axis frame size.
  let mut main_size = if horizontal { frame.width } else { frame.height };
  let mut cross_size = if horizontal { frame.height } else { frame.width };
  let wrap = al.wrap && horizontal && main_sizing != Sizing::Hug;

  if main_sizing == Sizing::Hug {
    // Fill children can't fill a frame that hugs them: they hug their own content instead.
    for it in items.iter_mut().filter(|i| i.fill_main) {
      let size = hug_size(doc, &it.id, horizontal, m);
      set_size(doc, &it.id, horizontal, Some(size), None);
      layout_node(doc, &it.id, m);
      *it = item_of(doc, &it.id);
      it.main = size;
    }
    let sum: f64 = items.iter().map(|i| i.main).sum();
    main_size = sum + gap_total + pad_main_start + pad_main_end;
  } else if !wrap {
    let inner = main_size - pad_main_start - pad_main_end;
    let fixed: f64 = items.iter().filter(|i| !i.fill_main).map(|i| i.main).sum();
    let fills = items.iter().filter(|i| i.fill_main).count();
    if fills > 0 {
      let each = ((inner - fixed - gap_total) / fills as f64).max(1.0);
      for it in items.iter_mut().filter(|i| i.fill_main) {
        it.main = each;
        set_size(doc, &it.id, horizontal, Some(each), None);
        layout_node(doc, &it.id, m);
        *it = item_of(doc, &it.id);
        it.main = each;
      }
    }
  }

  // Cross axis. A hugging frame wraps its other children and fill children stretch to
  // match; when every child fills, the frame hugs their own content.
  let hug_cross = cross_sizing == Sizing::Hug;
  if hug_cross && !wrap {
    let fixed = items.iter().filter(|i| !i.fill_counter).map(|i| i.counter).reduce(f64::max);
    let max_c = match fixed {
      Some(c) => c,
      None => {
        let fills: Vec<NodeId> = items.iter().filter(|i| i.fill_counter).map(|i| i.id.clone()).collect();
        fills.iter().map(|c| hug_size(doc, c, !horizontal, m)).fold(0.0, f64::max)
      }
    };
    cross_size = max_c + pad_cross_start + pad_cross_end;
  }
  let inner_cross_fixed = cross_size - pad_cross_start - pad_cross_end;
  if !(hug_cross && wrap) {
    for it in items.iter_mut().filter(|i| i.fill_counter) {
      set_size(doc, &it.id, horizontal, None, Some(inner_cross_fixed.max(1.0)));
      layout_node(doc, &it.id, m);
      let main = it.main;
      *it = item_of(doc, &it.id);
      it.main = main;
    }
  }

  if wrap {
    arrange_wrapped(doc, id, &items, main_size, hug_cross);
    return;
  }

  // Position items.
  let inner_main = main_size - pad_main_start - pad_main_end;
  let inner_cross = cross_size - pad_cross_start - pad_cross_end;
  let used: f64 = items.iter().map(|i| i.main).sum::<f64>() + gap_total;
  let free = inner_main - used;
  let (mut cursor, gap) = match al.primary_align {
    Align::Start => (pad_main_start, al.gap),
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
  for it in &items {
    let cross = match al.counter_align {
      Align::Center => pad_cross_start + (inner_cross - it.counter) / 2.0,
      Align::End => pad_cross_start + inner_cross - it.counter,
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

/// Size a fill child would have if it hugged its content along one axis (used when its
/// parent hugs): text measures unwrapped (or at its width, for height), auto layout frames
/// lay out as hug, and other layers have no content to hug so they keep their size.
fn hug_size(doc: &mut Document, id: &str, horizontal: bool, m: &dyn TextMeasurer) -> f64 {
  let Some(n) = doc.get(id).cloned() else { return 1.0 };
  let size = match (n.kind, n.text.clone()) {
    (NodeType::Text, Some(mut t)) => {
      if horizontal {
        t.auto_resize = TextAutoResize::Width;
      }
      let lay = layout_for_node(&t, n.width, m);
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
  if horizontal {
    size
      .max(n.min_width.unwrap_or(0.0))
      .min(n.max_width.unwrap_or(f64::INFINITY))
      .max(1.0)
  } else {
    size.max(1.0)
  }
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
    doc.get_mut(id).unwrap().height = h.max(1.0);
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
