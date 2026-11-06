//! Layout grid geometry, shared by the canvas overlay and snapping.

use serde_json::{json, Value};

use crate::geom::Rect;
use crate::model::{Document, GridAlign, GridPattern, LayoutGrid, NodeId};

/// Most lines a square grid contributes per axis (keeps huge frames cheap).
const MAX_GRID_LINES: usize = 400;

/// Column or row bands of a grid inside `frame` (page coordinates). Empty for square grids.
pub fn bands(frame: &Rect, g: &LayoutGrid) -> Vec<Rect> {
  let vertical = match g.pattern {
    GridPattern::Columns => true,
    GridPattern::Rows => false,
    GridPattern::Grid => return Vec::new(),
  };
  let count = g.count.max(1) as f64;
  let (start, len) = if vertical {
    (frame.x, frame.width)
  } else {
    (frame.y, frame.height)
  };
  let (offset, size) = match g.alignment {
    GridAlign::Stretch => (g.margin, ((len - 2.0 * g.margin - (count - 1.0) * g.gutter) / count).max(0.0)),
    GridAlign::Start => (g.margin, g.size),
    GridAlign::End => (len - g.margin - (count * g.size + (count - 1.0) * g.gutter), g.size),
    GridAlign::Center => ((len - (count * g.size + (count - 1.0) * g.gutter)) / 2.0, g.size),
  };
  (0..g.count.max(1))
    .map(|i| {
      let a = start + offset + i as f64 * (size + g.gutter);
      if vertical {
        Rect::new(a, frame.y, size, frame.height)
      } else {
        Rect::new(frame.x, a, frame.width, size)
      }
    })
    .collect()
}

/// Snap lines of a grid: band edges, or the cell lines of a square grid. Returns (xs, ys).
/// With `near` (the rect being moved), a square grid gives only the lines around its left,
/// centre and right (and top, middle and bottom), so the whole frame snaps however large it is;
/// without it the lines are capped at `MAX_GRID_LINES` per axis.
pub fn lines(frame: &Rect, g: &LayoutGrid, near: Option<&Rect>) -> (Vec<f64>, Vec<f64>) {
  if g.pattern == GridPattern::Grid {
    let step = g.size.max(1.0);
    let axis = |start: f64, len: f64, probes: Option<[f64; 3]>| -> Vec<f64> {
      let last = (len / step).floor() as usize;
      let Some(probes) = probes else {
        return (0..=last).take(MAX_GRID_LINES).map(|i| start + i as f64 * step).collect();
      };
      let mut idx: Vec<usize> = Vec::with_capacity(6);
      for p in probes {
        let k = ((p - start) / step).clamp(0.0, last as f64);
        idx.push(k.floor() as usize);
        idx.push((k.ceil() as usize).min(last));
      }
      idx.sort_unstable();
      idx.dedup();
      idx.into_iter().map(|i| start + i as f64 * step).collect()
    };
    let xs = axis(frame.x, frame.width, near.map(|r| [r.x, r.x + r.width / 2.0, r.right()]));
    let ys = axis(frame.y, frame.height, near.map(|r| [r.y, r.y + r.height / 2.0, r.bottom()]));
    return (xs, ys);
  }
  let edges: Vec<f64> = bands(frame, g)
    .iter()
    .flat_map(|b| {
      if g.pattern == GridPattern::Columns {
        [b.x, b.right()]
      } else {
        [b.y, b.bottom()]
      }
    })
    .collect();
  if g.pattern == GridPattern::Columns {
    (edges, Vec::new())
  } else {
    (Vec::new(), edges)
  }
}

/// Visible grids on a page for the canvas overlay. Scans node values (no tree walk with a
/// lookup per node) and only resolves ancestry for the few frames that have grids.
pub fn overlay(doc: &Document, page: &str) -> Value {
  let mut out = Vec::new();
  let with_grids: Vec<NodeId> = doc
    .nodes
    .values()
    .filter(|n| n.page == page && n.visible && n.layout_grids.iter().any(|g| g.visible))
    .map(|n| n.id.clone())
    .collect();
  for id in with_grids {
    if doc.ancestors(&id).iter().any(|a| doc.get(a).map(|n| !n.visible).unwrap_or(false)) {
      continue;
    }
    let Some(n) = doc.get(&id) else { continue };
    let r = doc.abs_bounds(&id);
    for g in n.layout_grids.iter().filter(|g| g.visible) {
      let item = if g.pattern == GridPattern::Grid {
        json!({ "frameId": id, "color": g.color, "cell": g.size.max(1.0), "frame": r })
      } else {
        json!({ "frameId": id, "color": g.color, "bands": bands(&r, g), "frame": r })
      };
      out.push(item);
    }
  }
  Value::Array(out)
}

/// Colour of the safe-area edge lines (drawn dashed, so the system UI keeps its own colours).
const SAFE_AREA_COLOR: &str = "#FF3B30";

/// The edges of a frame's safe area (page coordinates) as `[x1, y1, x2, y2]` lines, one for each
/// non-zero inset.
pub fn safe_lines(frame: &Rect, insets: [f64; 4]) -> Vec<[f64; 4]> {
  let [t, r, b, l] = insets;
  let mut out = Vec::new();
  if t > 0.0 {
    out.push([frame.x, frame.y + t, frame.right(), frame.y + t]);
  }
  if b > 0.0 {
    out.push([frame.x, frame.bottom() - b, frame.right(), frame.bottom() - b]);
  }
  if l > 0.0 {
    out.push([frame.x + l, frame.y, frame.x + l, frame.bottom()]);
  }
  if r > 0.0 {
    out.push([frame.right() - r, frame.y, frame.right() - r, frame.bottom()]);
  }
  out
}

/// Safe-area edge lines for the device frames that are selected, or contain a selected layer.
pub fn safe_areas(doc: &Document, page: &str, selection: &[NodeId]) -> Value {
  let mut frames: Vec<NodeId> = Vec::new();
  for id in selection {
    let Some(n) = doc.get(id) else { continue };
    if n.page != page {
      continue;
    }
    let top = std::iter::once(id.clone())
      .chain(doc.ancestors(id))
      .find(|i| doc.get(i).is_some_and(|n| n.device.is_some()));
    if let Some(t) = top.filter(|t| !frames.contains(t)) {
      frames.push(t);
    }
  }
  let out: Vec<Value> = frames
    .iter()
    .filter_map(|id| {
      let n = doc.get(id)?;
      let lines = safe_lines(&doc.abs_bounds(id), crate::devices::safe_insets(n)?);
      (!lines.is_empty()).then(|| json!({ "frameId": id, "color": SAFE_AREA_COLOR, "lines": lines, "frame": doc.abs_bounds(id) }))
    })
    .collect();
  Value::Array(out)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn stretch_columns_fill_the_frame() {
    let g = LayoutGrid {
      count: 4,
      gutter: 20.0,
      margin: 40.0,
      ..Default::default()
    };
    let b = bands(&Rect::new(0.0, 0.0, 1000.0, 500.0), &g);
    assert_eq!(b.len(), 4);
    assert_eq!(b[0].x, 40.0);
    assert!((b[3].right() - 960.0).abs() < 1e-9);
    assert!((b[0].width - 215.0).abs() < 1e-9);
  }

  #[test]
  fn safe_lines_mark_only_the_insets() {
    let l = safe_lines(&Rect::new(10.0, 20.0, 100.0, 200.0), [30.0, 0.0, 10.0, 0.0]);
    assert_eq!(l, vec![[10.0, 50.0, 110.0, 50.0], [10.0, 210.0, 110.0, 210.0]]);
    assert!(safe_lines(&Rect::new(0.0, 0.0, 10.0, 10.0), [0.0; 4]).is_empty());
  }

  #[test]
  fn centered_rows_and_square_grid() {
    let rows = LayoutGrid {
      pattern: GridPattern::Rows,
      count: 2,
      gutter: 10.0,
      size: 45.0,
      alignment: GridAlign::Center,
      ..Default::default()
    };
    let b = bands(&Rect::new(0.0, 0.0, 100.0, 200.0), &rows);
    assert_eq!((b[0].y, b[1].bottom()), (50.0, 150.0));
    let sq = LayoutGrid {
      pattern: GridPattern::Grid,
      size: 8.0,
      ..Default::default()
    };
    let (xs, ys) = lines(&Rect::new(0.0, 0.0, 16.0, 8.0), &sq, None);
    assert_eq!((xs, ys), (vec![0.0, 8.0, 16.0], vec![0.0, 8.0]));
    // Near a rect far from the origin only the lines around it come back, past the line cap.
    let fine = LayoutGrid { size: 2.0, ..sq.clone() };
    let (xs, _) = lines(&Rect::new(0.0, 0.0, 4000.0, 8.0), &fine, Some(&Rect::new(1900.6, 0.0, 1.0, 1.0)));
    assert!(xs.contains(&1900.0) && xs.contains(&1902.0) && xs.len() <= 6);
  }
}
