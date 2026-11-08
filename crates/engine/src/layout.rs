//! Auto layout, hug/fill sizing, text auto-resize, group bounds and constraints.

use std::collections::HashSet;

use crate::geom::Rect;
use crate::model::{Align, ConstraintH, ConstraintV, Document, LayoutDirection, Node, NodeId, NodeType, Sizing, TextAutoResize};
use crate::text::{first_baseline, layout_for_box, layout_of_node, TextMeasurer};

/// Recomputes derived geometry for every page.
pub fn relayout_all(doc: &mut Document, m: &dyn TextMeasurer) {
  let roots: Vec<NodeId> = doc.pages.iter().flat_map(|p| p.children.clone()).collect();
  for r in roots {
    layout_root(doc, &r, m);
  }
}

/// Lays out a top-level layer. Auto layout can resize a frame (hug growth, Fill), and a frame's
/// children follow their constraints whenever it changes size, so the sizes of the frames that
/// have constrained children are noted on the way down (a frame is visited before its parent
/// arranges it, so the size is still the one before the pass) and compared once the whole pass
/// has settled. Applying inside the pass would run on its intermediate sizes (hug measuring,
/// then sharing).
pub fn layout_root(doc: &mut Document, id: &str, m: &dyn TextMeasurer) {
  layout_root_skipping(doc, id, m, &HashSet::new());
}

/// `layout_root` for a tree that has layers nobody has seen yet (`fresh`: just created by a
/// tool). A new frame's size is whatever its first layout makes it, not a resize, so its
/// children keep the positions they were given.
pub fn layout_root_skipping(doc: &mut Document, id: &str, m: &dyn TextMeasurer, fresh: &HashSet<NodeId>) {
  let mut before = Vec::new();
  layout_walk(doc, id, m, Some(&mut before));
  // Outermost first: a frame moved or resized by its parent's constraints is compared with
  // its own noted size, so its children move once, by the whole change.
  for (fid, ow, oh) in before {
    if fresh.contains(&fid) {
      continue;
    }
    let Some(f) = doc.get(&fid) else { continue };
    if (f.width - ow).abs() <= 0.001 && (f.height - oh).abs() <= 0.001 {
      continue;
    }
    let kids: Vec<(NodeId, f64, f64)> = f
      .children
      .iter()
      .filter_map(|c| doc.get(c).map(|c| (c.id.clone(), c.width, c.height)))
      .collect();
    apply_constraints_with(doc, &fid, ow, oh, false);
    // Children the constraints moved or resized settle their own content (hug, wrap, text, and
    // a group's bounds), so another layout pass changes nothing.
    for (cid, cw, ch) in kids {
      let Some(c) = doc.get(&cid) else { continue };
      let resized = (c.width - cw).abs() > 0.001 || (c.height - ch).abs() > 0.001;
      if resized {
        layout_node(doc, &cid, m);
      }
      // Float noise from a scale or a half step would make a file look edited on open.
      let r = |v: f64| (v * 1e6).round() / 1e6;
      if doc
        .get(&cid)
        .is_some_and(|c| [c.x, c.y, c.width, c.height].iter().any(|v| r(*v) != *v))
      {
        doc.modify(&cid, |c| {
          (c.x, c.y, c.width, c.height) = (r(c.x), r(c.y), r(c.width), r(c.height));
        });
      }
    }
  }
}

fn is_pinned(c: &Node) -> bool {
  c.constraints.horizontal != ConstraintH::Left || c.constraints.vertical != ConstraintV::Top
}

/// Lays out a node and its subtree bottom-up.
pub fn layout_node(doc: &mut Document, id: &str, m: &dyn TextMeasurer) {
  layout_walk(doc, id, m, None);
}

/// `layout_node`; with `note`, every frame that has a child following constraints is recorded
/// as (id, width, height) before its subtree is laid out.
fn layout_walk(doc: &mut Document, id: &str, m: &dyn TextMeasurer, mut note: Option<&mut Vec<(NodeId, f64, f64)>>) {
  let Some(node) = doc.get(id) else { return };
  let kind = node.kind;
  let children = node.children.clone();
  match kind {
    NodeType::Text => size_text(doc, id, m),
    NodeType::Group => {
      for c in &children {
        layout_walk(doc, c, m, note.as_deref_mut());
      }
      normalize_group(doc, id);
    }
    k if k.is_frame_like() => {
      if let Some(out) = note.as_deref_mut() {
        let n = doc.get(id).unwrap();
        let flow = n.layout.is_some();
        if children
          .iter()
          .any(|c| doc.get(c).is_some_and(|c| (!flow || c.absolute_position) && is_pinned(c)))
        {
          out.push((id.to_string(), n.width, n.height));
        }
      }
      for c in &children {
        layout_walk(doc, c, m, note.as_deref_mut());
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
  doc.modify(id, |n| {
    match props.auto_resize {
      TextAutoResize::Width => {
        n.width = clamp_to(lay.width.ceil(), (min_w, f64::INFINITY)).max(1.0);
        n.height = clamp_to(lay.height.ceil(), (min_h, max_h)).max(1.0);
      }
      TextAutoResize::Height => n.height = clamp_to(lay.height.ceil(), (min_h, max_h)).max(1.0),
      TextAutoResize::None => {}
    }
    n.text = Some(props);
  });
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
      doc.modify(c, |cn| {
        cn.x -= b.x;
        cn.y -= b.y;
      });
    }
  }
  doc.modify(id, |g| {
    // A flipped group mirrors its children about its centre, so the edge that stays put is the far one.
    g.x += if g.flip_x { g.width - b.x - b.width } else { b.x };
    g.y += if g.flip_y { g.height - b.y - b.height } else { b.y };
    g.width = b.width.max(0.01);
    g.height = b.height.max(0.01);
    g.rotation = 0.0;
  });
}

struct Item {
  id: NodeId,
  main: f64,
  /// The size a wrap frame breaks rows by: `main`, except for a fill child, which breaks at its
  /// minimum (0 without one) and then grows to share its row.
  line: f64,
  counter: f64,
  fill_main: bool,
  fill_counter: bool,
  /// Rotated off a multiple of 180 degrees: sized by its bounding box, top-aligned on baselines.
  rotated: bool,
  /// Offset from the slot's corner to the child's own (unrotated) box: the rotation pivots on
  /// the centre, so the box sits half the bounding box's excess inside the slot.
  dx: f64,
  dy: f64,
}

/// Geometry shared by the passes of one `arrange`.
struct Axes {
  horizontal: bool,
  wrap: bool,
  /// Padding along the main and the cross axis (both sides added).
  pad_main: f64,
  pad_cross: f64,
  gap_total: f64,
  gap: f64,
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
    // Space between wraps with no column gap, like the exported CSS: the rows spread instead.
    gap: if al.primary_align == Align::SpaceBetween { 0.0 } else { al.gap },
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
      doc.modify(id, |f| f.width = main_size.max(1.0));
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
    doc.modify(&it.id, |c| {
      if horizontal {
        c.x = cursor + it.dx;
        c.y = cross + it.dy;
      } else {
        c.y = cursor + it.dy;
        c.x = cross + it.dx;
      }
    });
    cursor += it.main + gap;
  }

  doc.modify(id, |f| {
    if horizontal {
      f.width = main_size.max(1.0);
      f.height = cross_size.max(1.0);
    } else {
      f.height = main_size.max(1.0);
      f.width = cross_size.max(1.0);
    }
  });
}

fn item_of(doc: &Document, cid: &str, horizontal: bool) -> Item {
  let c = doc.get(cid).unwrap();
  let rotated = is_tilted(c.rotation);
  let (bw, bh) = rotated_box(c.width, c.height, c.rotation);
  let (main, counter) = if horizontal { (bw, bh) } else { (bh, bw) };
  let (sm, sc) = if horizontal {
    (c.sizing_h, c.sizing_v)
  } else {
    (c.sizing_v, c.sizing_h)
  };
  Item {
    id: cid.to_string(),
    main,
    line: main,
    counter,
    // Fill can't stretch a tilted box: stored sizing stays, so turning it back restores Fill.
    fill_main: sm == Sizing::Fill && !rotated,
    fill_counter: sc == Sizing::Fill && !rotated,
    rotated,
    dx: (bw - c.width) / 2.0,
    dy: (bh - c.height) / 2.0,
  }
}

/// True when a rotation (degrees) isn't a multiple of 180: the bounding box then differs from
/// the box (at 180 it is the same).
pub fn is_tilted(rotation: f64) -> bool {
  let r = rotation.rem_euclid(180.0);
  r > 1e-6 && r < 180.0 - 1e-6
}

/// Size of the axis-aligned box around a `w` x `h` box rotated by `rotation` degrees.
pub fn rotated_box(w: f64, h: f64, rotation: f64) -> (f64, f64) {
  if !is_tilted(rotation) {
    return (w, h);
  }
  // A quarter turn swaps the sides exactly (no float noise in stored positions and sizes).
  if (rotation.rem_euclid(180.0) - 90.0).abs() < 1e-6 {
    return (h, w);
  }
  let (s, c) = rotation.to_radians().sin_cos();
  let (s, c) = (s.abs(), c.abs());
  (w * c + h * s, w * s + h * c)
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
      it.line = size;
    }
    let natural = items.iter().map(|i| i.main).sum::<f64>() + ax.gap_total + ax.pad_main;
    *main_size = clamp_to(natural, limits);
    // Held back by a maximum (or pushed out by a minimum): fill children share what is left.
    if *main_size < natural && wrap_at_max {
      return true;
    }
    if *main_size != natural {
      share_main(doc, m, ax, items, *main_size - ax.pad_main, ax.gap_total);
    }
  } else if !ax.wrap {
    share_main(doc, m, ax, items, *main_size - ax.pad_main, ax.gap_total);
  } else {
    share_wrapped(doc, m, ax, items, *main_size - ax.pad_main);
  }
  false
}

/// Splits `inner` (main axis, padding excluded) between the fill children after the fixed
/// ones and the gaps. A child that would pass its max or min size keeps that size and the
/// others share the rest.
fn share_main(doc: &mut Document, m: &dyn TextMeasurer, ax: &Axes, items: &mut [Item], inner: f64, gap_total: f64) {
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
  let avail = inner - fixed - gap_total;
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

/// Wrap rows form by `line` sizes (a fill child counts as its minimum), then each row's fill
/// children share that row's free space within their min and max, as flexbox does.
fn share_wrapped(doc: &mut Document, m: &dyn TextMeasurer, ax: &Axes, items: &mut [Item], inner: f64) {
  if !items.iter().any(|i| i.fill_main) {
    return;
  }
  for it in items.iter_mut().filter(|i| i.fill_main) {
    // The minimum (it wins over a smaller max, as in CSS and `share_main`).
    let (lo, _) = bounds(doc.get(&it.id).unwrap(), ax.horizontal);
    it.line = lo.max(1.0);
  }
  let rows = wrap_rows(items, inner, ax.gap);
  for r in rows {
    let lines: Vec<f64> = items[r.clone()].iter().map(|i| i.line).collect();
    let gap_total = ax.gap * (r.len() as f64 - 1.0);
    share_main(doc, m, ax, &mut items[r.clone()], inner, gap_total);
    for (it, l) in items[r].iter_mut().zip(lines) {
      it.line = l;
    }
  }
}

/// The index ranges of the rows a wrap frame breaks its children into.
fn wrap_rows(items: &[Item], inner: f64, gap: f64) -> Vec<std::ops::Range<usize>> {
  let mut rows = Vec::new();
  let (mut start, mut row_w) = (0, 0.0);
  for (i, it) in items.iter().enumerate() {
    if i > start && row_w + gap + it.line > inner + 0.01 {
      rows.push(start..i);
      start = i;
      row_w = it.line;
    } else {
      row_w += if i == start { it.line } else { gap + it.line };
    }
  }
  if start < items.len() {
    rows.push(start..items.len());
  }
  rows
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
      if i.fill_counter || i.rotated {
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
      // A tilted first child counts as its bounding box: its bottom edge.
      if is_tilted(c.rotation) {
        let (_, bh) = rotated_box(c.width, c.height, c.rotation);
        return c.y - (bh - c.height) / 2.0 + bh;
      }
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
        doc.modify(id, |c| {
          if horizontal {
            c.sizing_h = s;
          } else {
            c.sizing_v = s;
          }
        });
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
  let between = al.primary_align == Align::SpaceBetween;
  let gap = if between { 0.0 } else { al.gap };
  let mut rows: Vec<&[Item]> = wrap_rows(items, inner, gap).into_iter().map(|r| &items[r]).collect();
  if rows.is_empty() {
    rows.push(&[]);
  }
  let mut y = al.padding_top;
  if !hug_cross {
    // Rows sit in the frame as one block, placed by the counter axis alignment (Figma's
    // counterAxisAlignContent AUTO, CSS align-content). Overflowing rows stay at the top.
    let rows_h: f64 =
      rows.iter().map(|r| r.iter().map(|i| i.counter).fold(0.0, f64::max)).sum::<f64>() + al.counter_gap * (rows.len() as f64 - 1.0);
    let inner_h = doc.get(id).unwrap().height - al.padding_top - al.padding_bottom;
    y += wrap_block_offset(al.counter_align, inner_h, rows_h);
  }
  for row in &rows {
    let row_h = row.iter().map(|i| i.counter).fold(0.0, f64::max);
    let sum: f64 = row.iter().map(|i| i.main).sum();
    let used: f64 = sum + gap * (row.len().max(1) as f64 - 1.0);
    // A row of one item sits at the start; the others spread, never closer than touching.
    let step = if between && row.len() > 1 {
      ((inner - sum) / (row.len() as f64 - 1.0)).max(0.0)
    } else {
      gap
    };
    let mut x = al.padding_left
      + match al.primary_align {
        Align::Center => (inner - used) / 2.0,
        Align::End => inner - used,
        _ => 0.0,
      };
    for it in row.iter() {
      let cy = match al.counter_align {
        Align::Center => y + (row_h - it.counter) / 2.0,
        Align::End => y + row_h - it.counter,
        _ => y,
      };
      doc.modify(&it.id, |c| {
        c.x = x + it.dx;
        c.y = cy + it.dy;
      });
      x += it.main + step;
    }
    y += row_h + al.counter_gap;
  }
  if hug_cross {
    let h = y - al.counter_gap + al.padding_bottom;
    doc.modify(id, |f| {
      f.height = clamp_to(h, (f.min_height.unwrap_or(0.0), f.max_height.unwrap_or(f64::INFINITY))).max(1.0)
    });
  }
}

/// Offset of a wrap frame's block of rows from the inner top: start and baseline pack at the
/// top, center and end share out the free space. Never negative.
fn wrap_block_offset(align: Align, inner_h: f64, rows_h: f64) -> f64 {
  let free = (inner_h - rows_h).max(0.0);
  match align {
    Align::Center => free / 2.0,
    Align::End => free,
    _ => 0.0,
  }
}

fn set_size(doc: &mut Document, id: &str, horizontal: bool, main: Option<f64>, cross: Option<f64>) {
  doc.modify(id, |c| {
    let (w, h) = if horizontal { (main, cross) } else { (cross, main) };
    if let Some(w) = w {
      c.width = w;
    }
    if let Some(h) = h {
      c.height = h;
    }
  });
}

/// Applies child constraints after a frame changes size. In an auto layout frame only the
/// children that opted out of the flow (absolute position) have constraints; the others are
/// placed by the layout.
pub fn apply_constraints(doc: &mut Document, frame_id: &str, old_w: f64, old_h: f64) {
  apply_constraints_with(doc, frame_id, old_w, old_h, true);
}

/// `deep` also carries a resized child frame's own change down to its children; `layout_root`
/// passes false because it compares every such frame with its own noted size.
fn apply_constraints_with(doc: &mut Document, frame_id: &str, old_w: f64, old_h: f64, deep: bool) {
  let Some(f) = doc.get(frame_id) else { return };
  if !f.kind.is_frame_like() {
    return;
  }
  let flowing = f.layout.is_some();
  let (nw, nh) = (f.width, f.height);
  let (dw, dh) = (nw - old_w, nh - old_h);
  if dw == 0.0 && dh == 0.0 {
    return;
  }
  let sx = if old_w > 0.0 { nw / old_w } else { 1.0 };
  let sy = if old_h > 0.0 { nh / old_h } else { 1.0 };
  for cid in f.children.clone() {
    let Some(c) = doc.get_mut(&cid) else { continue };
    if flowing && !c.absolute_position {
      continue;
    }
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
    if deep && kind.is_frame_like() {
      apply_constraints_with(doc, &cid, cw, ch, true);
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
  fn wrapped_rows_align_as_a_block_in_a_fixed_height_frame() {
    // Three rows of 30 px with 10 px between them: 110 px of rows in a 200 px frame.
    let rows_y = |align: Align, sizing_v: Sizing| {
      let (mut doc, page) = setup();
      let mut r = row("f", 0.0, Sizing::Fixed);
      r.width = 100.0;
      r.height = 200.0;
      r.sizing_v = sizing_v;
      let l = r.layout.as_mut().unwrap();
      l.wrap = true;
      l.gap = 0.0;
      l.counter_gap = 10.0;
      l.counter_align = align;
      doc.insert(r, None, &page, None);
      for i in 0..3 {
        let n = Node {
          id: format!("c{i}"),
          width: 100.0,
          height: 30.0,
          ..Default::default()
        };
        doc.insert(n, Some("f"), &page, None);
      }
      relayout_all(&mut doc, &HeuristicMeasurer);
      (0..3).map(|i| doc.get(&format!("c{i}")).unwrap().y).collect::<Vec<_>>()
    };
    assert_eq!(rows_y(Align::Start, Sizing::Fixed), vec![0.0, 40.0, 80.0]);
    assert_eq!(rows_y(Align::Center, Sizing::Fixed), vec![45.0, 85.0, 125.0]);
    assert_eq!(rows_y(Align::End, Sizing::Fixed), vec![90.0, 130.0, 170.0]);
    // Hugging, the rows are the frame: nothing to share out.
    assert_eq!(rows_y(Align::Center, Sizing::Hug), vec![0.0, 40.0, 80.0]);
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

  #[test]
  fn auto_layout_frames_apply_constraints_to_absolute_children_only() {
    let (mut doc, page) = setup();
    doc.insert(
      Node {
        id: "f".into(),
        kind: NodeType::Frame,
        width: 200.0,
        height: 200.0,
        layout: Some(AutoLayout::default()),
        ..Default::default()
      },
      None,
      &page,
      None,
    );
    let child = |id: &str, absolute: bool, h: ConstraintH, v: ConstraintV| {
      let mut c = Node {
        id: id.into(),
        x: 150.0,
        y: 150.0,
        width: 40.0,
        height: 40.0,
        absolute_position: absolute,
        ..Default::default()
      };
      c.constraints.horizontal = h;
      c.constraints.vertical = v;
      c
    };
    doc.insert(child("abs", true, ConstraintH::Right, ConstraintV::Bottom), Some("f"), &page, None);
    doc.insert(child("scale", true, ConstraintH::Scale, ConstraintV::Scale), Some("f"), &page, None);
    doc.insert(
      child("flow", false, ConstraintH::Right, ConstraintV::Bottom),
      Some("f"),
      &page,
      None,
    );
    let f = doc.get_mut("f").unwrap();
    f.width = 400.0;
    f.height = 300.0;
    apply_constraints(&mut doc, "f", 200.0, 200.0);
    let abs = doc.get("abs").unwrap();
    assert_eq!(
      (abs.x, abs.y),
      (350.0, 250.0),
      "absolute child follows its Right/Bottom constraints"
    );
    let scale = doc.get("scale").unwrap();
    assert_eq!((scale.x, scale.y, scale.width, scale.height), (300.0, 225.0, 80.0, 60.0));
    let flow = doc.get("flow").unwrap();
    assert_eq!((flow.x, flow.y), (150.0, 150.0), "a child in the flow is left to the layout");
  }

  /// A frame "f" with auto layout and plain children `(id, w, h, rotation)`.
  fn flow(horizontal: bool, hug: bool, pad: f64, gap: f64, kids: &[(&str, f64, f64, f64)]) -> Document {
    let (mut doc, page) = setup();
    let sizing = if hug { Sizing::Hug } else { Sizing::Fixed };
    let frame = Node {
      id: "f".into(),
      kind: NodeType::Frame,
      width: 400.0,
      height: 300.0,
      layout: Some(AutoLayout {
        direction: if horizontal {
          LayoutDirection::Horizontal
        } else {
          LayoutDirection::Vertical
        },
        gap,
        padding_left: pad,
        padding_right: pad,
        padding_top: pad,
        padding_bottom: pad,
        ..Default::default()
      }),
      sizing_h: sizing,
      sizing_v: sizing,
      ..Default::default()
    };
    doc.insert(frame, None, &page, None);
    for (id, w, h, r) in kids {
      let n = Node {
        id: (*id).into(),
        width: *w,
        height: *h,
        rotation: *r,
        ..Default::default()
      };
      doc.insert(n, Some("f"), &page, None);
    }
    relayout_all(&mut doc, &HeuristicMeasurer);
    doc
  }

  /// Bounding box of a child of "f" in the frame's space.
  fn bbox(doc: &Document, id: &str) -> Rect {
    let c = doc.get(id).unwrap();
    doc.local_matrix(c).bounds_of(c.width, c.height)
  }

  fn near(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-6
  }

  #[test]
  fn a_quarter_turn_takes_its_bounding_box_in_a_horizontal_hug_frame() {
    // 40x80 turned 90 degrees is 80 wide and 40 tall: the frame grows by 80, not 40.
    let doc = flow(true, true, 10.0, 10.0, &[("a", 40.0, 80.0, 90.0), ("b", 30.0, 20.0, 0.0)]);
    let f = doc.get("f").unwrap();
    assert!(near(f.width, 10.0 + 80.0 + 10.0 + 30.0 + 10.0), "{}", f.width);
    assert!(near(f.height, 10.0 + 40.0 + 10.0), "{}", f.height);
    assert_eq!(doc.get("a").unwrap().rotation, 90.0);
    let b = bbox(&doc, "a");
    assert!(
      near(b.x, 10.0) && near(b.y, 10.0) && near(b.width, 80.0) && near(b.height, 40.0),
      "{b:?}"
    );
    assert!(near(doc.get("b").unwrap().x, 10.0 + 80.0 + 10.0));
  }

  #[test]
  fn a_quarter_turn_in_a_vertical_frame_and_a_half_turn_in_a_row() {
    let doc = flow(false, true, 0.0, 5.0, &[("a", 40.0, 80.0, 90.0), ("b", 30.0, 20.0, 0.0)]);
    let f = doc.get("f").unwrap();
    assert!(near(f.width, 80.0) && near(f.height, 40.0 + 5.0 + 20.0), "{}x{}", f.width, f.height);
    let b = bbox(&doc, "a");
    assert!(near(b.x, 0.0) && near(b.y, 0.0), "{b:?}");
    assert!(near(doc.get("b").unwrap().y, 45.0));
    // At 180 degrees the box is the same: it sits in its slot untouched and keeps the turn.
    let doc = flow(true, true, 10.0, 10.0, &[("a", 40.0, 80.0, 180.0), ("b", 30.0, 20.0, 0.0)]);
    let a = doc.get("a").unwrap();
    assert_eq!((a.x, a.y, a.rotation), (10.0, 10.0, 180.0));
    assert!(near(doc.get("f").unwrap().width, 10.0 + 40.0 + 10.0 + 30.0 + 10.0));
  }

  #[test]
  fn a_45_degree_child_is_laid_out_by_its_diagonal() {
    let doc = flow(true, true, 0.0, 0.0, &[("a", 40.0, 40.0, 45.0), ("b", 10.0, 10.0, 0.0)]);
    let side = 40.0 * 2f64.sqrt();
    let b = bbox(&doc, "a");
    assert!(
      near(b.x, 0.0) && near(b.y, 0.0) && near(b.width, side) && near(b.height, side),
      "{b:?}"
    );
    assert!(near(doc.get("f").unwrap().width, side + 10.0));
    assert!(near(doc.get("f").unwrap().height, side));
    assert!(near(doc.get("b").unwrap().x, side));
  }

  #[test]
  fn rotation_survives_every_layout_pass() {
    let mut doc = flow(true, true, 10.0, 10.0, &[("a", 40.0, 80.0, 90.0), ("b", 30.0, 20.0, 0.0)]);
    let before = (doc.get("a").unwrap().x, doc.get("a").unwrap().y);
    // A sibling grows: the rotated child is laid out again, in its new slot.
    doc.get_mut("b").unwrap().width = 100.0;
    relayout_all(&mut doc, &HeuristicMeasurer);
    relayout_all(&mut doc, &HeuristicMeasurer);
    let a = doc.get("a").unwrap();
    assert_eq!(a.rotation, 90.0);
    assert_eq!((a.x, a.y), before, "idempotent and unmoved");
    assert!(near(doc.get("f").unwrap().width, 10.0 + 80.0 + 10.0 + 100.0 + 10.0));
    // It also survives a save and reload.
    let json = serde_json::to_string(&doc).unwrap();
    let mut back: Document = serde_json::from_str(&json).unwrap();
    relayout_all(&mut back, &HeuristicMeasurer);
    assert_eq!(back.get("a").unwrap().rotation, 90.0);
    assert!(near(back.get("a").unwrap().x, before.0));
  }

  #[test]
  fn a_tilted_fill_child_acts_as_fixed_and_fills_again_once_straight() {
    let mut doc = flow(true, false, 0.0, 0.0, &[("a", 50.0, 20.0, 0.0), ("b", 50.0, 20.0, 30.0)]);
    for id in ["a", "b"] {
      let n = doc.get_mut(id).unwrap();
      n.sizing_h = Sizing::Fill;
      n.sizing_v = Sizing::Fill;
    }
    relayout_all(&mut doc, &HeuristicMeasurer);
    // The straight one takes everything the tilted one's bounding box leaves.
    let (bw, _) = rotated_box(50.0, 20.0, 30.0);
    assert!(near(doc.get("a").unwrap().width, 400.0 - bw), "{}", doc.get("a").unwrap().width);
    assert!(near(doc.get("a").unwrap().height, 300.0));
    let b = doc.get("b").unwrap();
    assert_eq!((b.width, b.height), (50.0, 20.0), "acts as Fixed");
    assert_eq!((b.sizing_h, b.sizing_v), (Sizing::Fill, Sizing::Fill), "stored sizing is untouched");
    // Straight again, Fill is back: they share the width.
    doc.get_mut("b").unwrap().rotation = 0.0;
    relayout_all(&mut doc, &HeuristicMeasurer);
    assert!(near(doc.get("a").unwrap().width, 200.0) && near(doc.get("b").unwrap().width, 200.0));
    // At 180 degrees Fill still works.
    doc.get_mut("b").unwrap().rotation = 180.0;
    relayout_all(&mut doc, &HeuristicMeasurer);
    assert!(near(doc.get("b").unwrap().width, 200.0));
    assert_eq!(doc.get("b").unwrap().rotation, 180.0);
  }

  #[test]
  fn wrap_rows_use_bounding_boxes() {
    let kids = [("a", 60.0, 20.0, 90.0), ("b", 60.0, 20.0, 0.0), ("c", 60.0, 20.0, 0.0)];
    let mut doc = flow(true, false, 0.0, 10.0, &kids);
    {
      let f = doc.get_mut("f").unwrap();
      f.width = 150.0;
      f.layout.as_mut().unwrap().wrap = true;
    }
    relayout_all(&mut doc, &HeuristicMeasurer);
    // a is 20 wide and 60 tall as a box: a and b share row one (20 + 10 + 60), c wraps.
    let a = bbox(&doc, "a");
    assert!(
      near(a.x, 0.0) && near(a.y, 0.0) && near(a.width, 20.0) && near(a.height, 60.0),
      "{a:?}"
    );
    let (b, c) = (doc.get("b").unwrap(), doc.get("c").unwrap());
    assert!(near(b.x, 30.0) && near(b.y, 0.0), "{} {}", b.x, b.y);
    assert!(
      near(c.x, 0.0) && near(c.y, 70.0),
      "row two sits under the 60 tall row: {} {}",
      c.x,
      c.y
    );
    assert_eq!(doc.get("a").unwrap().rotation, 90.0);
  }

  #[test]
  fn a_rotated_item_sits_on_the_top_of_a_baseline_row() {
    let (mut doc, page) = setup();
    let frame = Node {
      id: "f".into(),
      kind: NodeType::Frame,
      layout: Some(AutoLayout {
        direction: LayoutDirection::Horizontal,
        counter_align: Align::Baseline,
        ..Default::default()
      }),
      sizing_h: Sizing::Hug,
      sizing_v: Sizing::Hug,
      ..Default::default()
    };
    doc.insert(frame, None, &page, None);
    for (id, h, r) in [("a", 30.0, 90.0), ("b", 20.0, 0.0)] {
      let n = Node {
        id: id.into(),
        width: 30.0,
        height: h,
        rotation: r,
        ..Default::default()
      };
      doc.insert(n, Some("f"), &page, None);
    }
    relayout_all(&mut doc, &HeuristicMeasurer);
    let a = bbox(&doc, "a");
    // (default padding is 10)
    assert!(near(a.y, 10.0), "top aligned: {a:?}");
    assert!(near(doc.get("f").unwrap().height, 50.0));
    assert!(
      near(doc.get("b").unwrap().y, 10.0),
      "baseline offset of the straight one ignores the tilted one"
    );
  }

  #[test]
  fn absolute_children_keep_their_own_rotation_and_position() {
    let mut doc = flow(true, true, 0.0, 0.0, &[("a", 40.0, 80.0, 90.0), ("b", 30.0, 20.0, 33.0)]);
    {
      let b = doc.get_mut("b").unwrap();
      b.absolute_position = true;
      b.x = 123.0;
      b.y = 45.0;
    }
    relayout_all(&mut doc, &HeuristicMeasurer);
    let b = doc.get("b").unwrap();
    assert_eq!((b.x, b.y, b.rotation), (123.0, 45.0, 33.0));
    assert!(near(doc.get("f").unwrap().width, 80.0), "only the flow child counts");
  }

  #[test]
  fn quarter_turns_swap_the_sides_exactly() {
    for r in [90.0, 270.0, -90.0, 450.0] {
      assert_eq!(rotated_box(0.3, 1000.0, r), (1000.0, 0.3), "{r}");
      assert_eq!(rotated_box(12.5, 7.25, r), (7.25, 12.5), "{r}");
    }
    let doc = flow(true, true, 0.0, 0.0, &[("a", 12.5, 7.25, 90.0)]);
    let a = doc.get("a").unwrap();
    assert_eq!((a.x, a.y), (-2.625, 2.625));
    assert_eq!(doc.get("f").unwrap().width, 7.25);
  }

  #[test]
  fn a_tilted_first_child_gives_its_bounding_box_bottom_as_the_baseline() {
    let doc = flow(true, true, 0.0, 0.0, &[("a", 40.0, 80.0, 90.0)]);
    // The frame's first flowing child is tilted: 80 wide, 40 tall box, bottom edge at 40.
    assert!(near(baseline_of(&doc, "f", &HeuristicMeasurer, 0), 40.0));
  }

  /// A wrap frame `width` wide (padding `pad`, gap `gap`) with one child per `(sizing, width, min, max)`;
  /// returns each child's (x, y, width).
  #[allow(clippy::type_complexity)]
  fn wrap_fill(width: f64, pad: f64, gap: f64, align: Align, kids: &[(Sizing, f64, Option<f64>, Option<f64>)]) -> Vec<(f64, f64, f64)> {
    let (mut doc, page) = setup();
    let frame = Node {
      id: "f".into(),
      kind: NodeType::Frame,
      width,
      height: 100.0,
      sizing_v: Sizing::Hug,
      layout: Some(AutoLayout {
        direction: LayoutDirection::Horizontal,
        wrap: true,
        gap,
        counter_gap: gap,
        primary_align: align,
        padding_left: pad,
        padding_right: pad,
        padding_top: pad,
        padding_bottom: pad,
        ..Default::default()
      }),
      ..Default::default()
    };
    doc.insert(frame, None, &page, None);
    for (i, (sizing, w, min, max)) in kids.iter().enumerate() {
      let n = Node {
        id: format!("c{i}"),
        width: *w,
        height: 50.0,
        sizing_h: *sizing,
        min_width: *min,
        max_width: *max,
        ..Default::default()
      };
      doc.insert(n, Some("f"), &page, None);
    }
    relayout_all(&mut doc, &HeuristicMeasurer);
    (0..kids.len())
      .map(|i| {
        let n = doc.get(&format!("c{i}")).unwrap();
        (n.x, n.y, n.width)
      })
      .collect()
  }

  fn fills(n: usize, min: Option<f64>, max: Option<f64>) -> Vec<(Sizing, f64, Option<f64>, Option<f64>)> {
    vec![(Sizing::Fill, 100.0, min, max); n]
  }

  fn same(got: &[(f64, f64, f64)], want: &[(f64, f64)], width: &[f64]) {
    for (i, (g, (x, y))) in got.iter().zip(want).enumerate() {
      assert!(near(g.0, *x) && near(g.1, *y), "child {i}: {g:?} want {x},{y}");
      assert!(near(g.2, width[i.min(width.len() - 1)]), "child {i} width {}", g.2);
    }
  }

  #[test]
  fn wrap_fill_children_break_at_their_min_and_share_the_row_within_max() {
    // The features grid: inner 1344, gap 24, min 280, max 420.
    let got = wrap_fill(1440.0, 48.0, 24.0, Align::Start, &fills(6, Some(280.0), Some(420.0)));
    let y2 = got[4].1;
    assert!(y2 > got[0].1);
    same(
      &got,
      &[(48.0, 48.0), (390.0, 48.0), (732.0, 48.0), (1074.0, 48.0), (48.0, y2), (492.0, y2)],
      &[318.0, 318.0, 318.0, 318.0, 420.0, 420.0],
    );
    // Stats: inner 1136, gap 16, min 180: four in one row, 272 each.
    let got = wrap_fill(1200.0, 32.0, 16.0, Align::Start, &fills(4, Some(180.0), None));
    assert!(got.iter().all(|g| near(g.2, 272.0) && near(g.1, got[0].1)), "{got:?}");
    // No min width: all in one row, (1344 - 5 * 24) / 6 = 204.
    let got = wrap_fill(1440.0, 48.0, 24.0, Align::Start, &fills(6, None, None));
    assert!(got.iter().all(|g| near(g.2, 204.0) && near(g.1, got[0].1)), "{got:?}");
  }

  #[test]
  fn wrap_rows_mix_fixed_and_fill_and_place_leftover_space_by_alignment() {
    // Fixed 300 + fill (min 200) + fill (min 200) in 600: the third doesn't fit, so it wraps.
    let kids = [
      (Sizing::Fixed, 300.0, None, None),
      (Sizing::Fill, 100.0, Some(200.0), None),
      (Sizing::Fill, 100.0, Some(200.0), None),
    ];
    let got = wrap_fill(600.0, 0.0, 10.0, Align::Start, &kids);
    assert!(near(got[0].2, 300.0) && near(got[1].2, 290.0), "{got:?}");
    assert!(near(got[2].2, 600.0) && near(got[2].0, 0.0) && got[2].1 > got[0].1, "{got:?}");
    // All at max: free space stays, and the primary alignment places the row.
    let capped = fills(2, Some(50.0), Some(100.0));
    let start = wrap_fill(500.0, 0.0, 20.0, Align::Start, &capped);
    let centre = wrap_fill(500.0, 0.0, 20.0, Align::Center, &capped);
    let end = wrap_fill(500.0, 0.0, 20.0, Align::End, &capped);
    assert!(
      near(start[0].2, 100.0) && near(start[0].0, 0.0) && near(start[1].0, 120.0),
      "{start:?}"
    );
    assert!(near(centre[0].0, 140.0), "{centre:?}");
    assert!(near(end[0].0, 280.0), "{end:?}");
    // A min wider than the frame takes a row of its own and overflows.
    let wide = wrap_fill(300.0, 0.0, 10.0, Align::Start, &fills(2, Some(400.0), None));
    assert!(
      near(wide[0].2, 400.0) && near(wide[1].2, 400.0) && wide[1].1 > wide[0].1,
      "{wide:?}"
    );
  }

  #[test]
  fn wrap_space_between_spreads_each_row_like_the_export() {
    let kids = vec![(Sizing::Fixed, 80.0, None, None); 4];
    // 300 wide, gap 10 (a column gap is not used): three fit, spread 0 / 110 / 220, the fourth starts row two.
    let got = wrap_fill(300.0, 0.0, 10.0, Align::SpaceBetween, &kids);
    let xs: Vec<f64> = got.iter().map(|g| g.0).collect();
    assert_eq!(xs, [0.0, 110.0, 220.0, 0.0], "{got:?}");
    assert!(near(got[0].1, got[2].1));
    // The row gap is unchanged: counter_gap 10 below a 50 high row.
    assert!(near(got[3].1, 60.0), "{got:?}");
    // A single long item sits at the start.
    let one = wrap_fill(300.0, 0.0, 10.0, Align::SpaceBetween, &[(Sizing::Fixed, 400.0, None, None)]);
    assert_eq!(one[0].0, 0.0);
    // Padding moves the whole row.
    let padded = wrap_fill(320.0, 10.0, 10.0, Align::SpaceBetween, &kids);
    assert!(near(padded[0].0, 10.0) && near(padded[2].0, 230.0), "{padded:?}");
  }

  #[test]
  fn wrap_space_between_with_fill_children_leaves_no_space_to_spread() {
    let got = wrap_fill(300.0, 0.0, 10.0, Align::SpaceBetween, &fills(2, None, None));
    assert!(near(got[0].2, 150.0) && near(got[1].0, 150.0), "{got:?}");
  }

  fn pin(h: ConstraintH, v: ConstraintV) -> crate::model::Constraints {
    crate::model::Constraints {
      horizontal: h,
      vertical: v,
    }
  }

  /// A horizontal hug card: a flow child of width 50 and an absolute 20 x 20 badge at (40, 4)
  /// with the given constraints.
  fn badge_card(h: ConstraintH, v: ConstraintV) -> Document {
    let (mut doc, page) = setup();
    let card = Node {
      id: "card".into(),
      kind: NodeType::Frame,
      width: 70.0,
      height: 40.0,
      sizing_h: Sizing::Hug,
      sizing_v: Sizing::Hug,
      layout: Some(AutoLayout {
        direction: LayoutDirection::Horizontal,
        ..Default::default()
      }),
      ..Default::default()
    };
    doc.insert(card, None, &page, None);
    let label = Node {
      id: "label".into(),
      width: 50.0,
      height: 20.0,
      ..Default::default()
    };
    doc.insert(label, Some("card"), &page, None);
    let badge = Node {
      id: "badge".into(),
      x: 40.0,
      y: 4.0,
      width: 20.0,
      height: 20.0,
      absolute_position: true,
      constraints: pin(h, v),
      ..Default::default()
    };
    doc.insert(badge, Some("card"), &page, None);
    relayout_all(&mut doc, &HeuristicMeasurer);
    doc
  }

  #[test]
  fn a_hug_frame_that_grows_moves_its_absolute_children_by_their_constraints() {
    let grow = |h, v| {
      let mut doc = badge_card(h, v);
      let c = doc.get("card").unwrap();
      assert_eq!((c.width, c.height), (70.0, 40.0));
      doc.get_mut("label").unwrap().width = 208.0;
      doc.get_mut("label").unwrap().height = 60.0;
      relayout_all(&mut doc, &HeuristicMeasurer);
      let c = doc.get("card").unwrap();
      assert_eq!((c.width, c.height), (228.0, 80.0));
      let b = doc.get("badge").unwrap();
      let snap = (b.x, b.y, b.width, b.height);
      // A second pass changes nothing.
      relayout_all(&mut doc, &HeuristicMeasurer);
      let b = doc.get("badge").unwrap();
      assert_eq!(snap, (b.x, b.y, b.width, b.height));
      snap
    };
    assert_eq!(grow(ConstraintH::Left, ConstraintV::Top), (40.0, 4.0, 20.0, 20.0));
    assert_eq!(grow(ConstraintH::Right, ConstraintV::Bottom), (198.0, 44.0, 20.0, 20.0));
    assert_eq!(grow(ConstraintH::Center, ConstraintV::Center), (119.0, 24.0, 20.0, 20.0));
    assert_eq!(grow(ConstraintH::LeftRight, ConstraintV::TopBottom), (40.0, 4.0, 178.0, 60.0));
    // Scale applies once per real change: x and width grow by 228 / 70.
    let s = grow(ConstraintH::Scale, ConstraintV::Scale);
    assert!(near(s.0, 40.0 * 228.0 / 70.0) && near(s.2, 20.0 * 228.0 / 70.0), "{s:?}");
  }

  #[test]
  fn a_user_resize_moves_the_badge_exactly_once() {
    let mut doc = badge_card(ConstraintH::Right, ConstraintV::Top);
    {
      let c = doc.get_mut("card").unwrap();
      c.sizing_h = Sizing::Fixed;
      c.width = 400.0;
    }
    // What the Update arm does: constraints first (the width is already set), then layout.
    apply_constraints(&mut doc, "card", 70.0, 40.0);
    relayout_all(&mut doc, &HeuristicMeasurer);
    assert_eq!(doc.get("badge").unwrap().x, 370.0);
    assert_eq!(doc.get("card").unwrap().width, 400.0);
  }

  #[test]
  fn a_frame_resized_by_fill_moves_its_children_by_their_constraints() {
    let (mut doc, page) = setup();
    let stack = Node {
      id: "stack".into(),
      kind: NodeType::Frame,
      width: 300.0,
      height: 200.0,
      layout: Some(AutoLayout {
        direction: LayoutDirection::Vertical,
        ..Default::default()
      }),
      ..Default::default()
    };
    doc.insert(stack, None, &page, None);
    let panel = Node {
      id: "panel".into(),
      kind: NodeType::Frame,
      width: 280.0,
      height: 50.0,
      sizing_h: Sizing::Fill,
      ..Default::default()
    };
    doc.insert(panel, Some("stack"), &page, None);
    let dot = Node {
      id: "dot".into(),
      x: 250.0,
      width: 20.0,
      height: 20.0,
      constraints: pin(ConstraintH::Right, ConstraintV::Top),
      ..Default::default()
    };
    doc.insert(dot, Some("panel"), &page, None);
    relayout_all(&mut doc, &HeuristicMeasurer);
    let (pw, x0) = (doc.get("panel").unwrap().width, doc.get("dot").unwrap().x);
    assert_eq!(pw, 280.0);
    // The stack grows 300 -> 400 (a user resize: constraints on its own children first).
    doc.get_mut("stack").unwrap().width = 400.0;
    apply_constraints(&mut doc, "stack", 300.0, 200.0);
    relayout_all(&mut doc, &HeuristicMeasurer);
    assert_eq!(doc.get("panel").unwrap().width, 380.0);
    assert_eq!(doc.get("dot").unwrap().x, x0 + 100.0);
    relayout_all(&mut doc, &HeuristicMeasurer);
    assert_eq!(doc.get("dot").unwrap().x, x0 + 100.0);
  }

  #[test]
  fn nested_frames_follow_constraints_once_when_the_hug_parent_grows() {
    let (mut doc, page) = setup();
    let hug = Node {
      id: "hug".into(),
      kind: NodeType::Frame,
      width: 100.0,
      height: 100.0,
      sizing_h: Sizing::Hug,
      sizing_v: Sizing::Hug,
      layout: Some(AutoLayout {
        direction: LayoutDirection::Horizontal,
        padding_left: 0.0,
        padding_right: 0.0,
        padding_top: 0.0,
        padding_bottom: 0.0,
        ..Default::default()
      }),
      ..Default::default()
    };
    doc.insert(hug, None, &page, None);
    let sizer = Node {
      id: "sizer".into(),
      width: 100.0,
      height: 100.0,
      ..Default::default()
    };
    doc.insert(sizer, Some("hug"), &page, None);
    // An absolute plain frame pinned Left & right, holding a Right-pinned child.
    let inner = Node {
      id: "inner".into(),
      kind: NodeType::Frame,
      width: 100.0,
      height: 30.0,
      absolute_position: true,
      constraints: pin(ConstraintH::LeftRight, ConstraintV::Top),
      ..Default::default()
    };
    doc.insert(inner, Some("hug"), &page, None);
    let dot = Node {
      id: "dot".into(),
      x: 80.0,
      width: 20.0,
      height: 20.0,
      constraints: pin(ConstraintH::Right, ConstraintV::Top),
      ..Default::default()
    };
    doc.insert(dot, Some("inner"), &page, None);
    relayout_all(&mut doc, &HeuristicMeasurer);
    doc.get_mut("sizer").unwrap().width = 250.0;
    relayout_all(&mut doc, &HeuristicMeasurer);
    assert_eq!(doc.get("hug").unwrap().width, 250.0);
    assert_eq!(doc.get("inner").unwrap().width, 250.0);
    assert_eq!(doc.get("dot").unwrap().x, 230.0);
  }
}
