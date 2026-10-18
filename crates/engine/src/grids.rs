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

/// Snap lines of a grid: band edges, or every cell line for square grids. Returns (xs, ys).
pub fn lines(frame: &Rect, g: &LayoutGrid) -> (Vec<f64>, Vec<f64>) {
  if g.pattern == GridPattern::Grid {
    let step = g.size.max(1.0);
    let xs = (0..=(frame.width / step) as usize)
      .take(MAX_GRID_LINES)
      .map(|i| frame.x + i as f64 * step)
      .collect();
    let ys = (0..=(frame.height / step) as usize)
      .take(MAX_GRID_LINES)
      .map(|i| frame.y + i as f64 * step)
      .collect();
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
    let (xs, ys) = lines(&Rect::new(0.0, 0.0, 16.0, 8.0), &sq);
    assert_eq!((xs, ys), (vec![0.0, 8.0, 16.0], vec![0.0, 8.0]));
  }
}
