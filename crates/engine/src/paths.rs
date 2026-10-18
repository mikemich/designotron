//! Path geometry: SVG path parsing, layer outlines as bezier subpaths,
//! boolean operations, flattening and stroke outlining.

use i_overlay::core::fill_rule::FillRule;
use i_overlay::core::overlay_rule::OverlayRule;
use i_overlay::float::single::SingleFloatOverlay;
use i_overlay::mesh::float::stroke::offset::StrokeOffset;
use i_overlay::mesh::float::style::{LineCap, LineJoin, StrokeStyle};
use serde::{Deserialize, Serialize};

use crate::geom::{Mat, Point};
use crate::model::{Document, Node, NodeType, StrokeAlign, SubPath, VectorPoint};
use crate::shapes;

/// Bezier circle constant.
const K: f64 = 0.552_284_749_830_793_4;

type Contour = Vec<[f64; 2]>;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BoolOp {
  Union,
  Subtract,
  Intersect,
  Exclude,
}

// ---------------------------------------------------------------- SVG paths

/// Parses SVG path data into subpaths (all commands, absolute and relative; arcs become cubics).
pub fn parse_svg_path(d: &str) -> Vec<SubPath> {
  let toks = tokenize(d);
  let mut out: Vec<SubPath> = Vec::new();
  let mut cur: Option<SubPath> = None;
  let (mut x, mut y) = (0.0, 0.0);
  let (mut sx, mut sy) = (0.0, 0.0);
  // Reflection point for S/T.
  let mut last_ctrl: Option<(f64, f64, char)> = None;
  let mut i = 0;
  let mut cmd = 'M';
  let num = |i: &mut usize| -> Option<f64> {
    match toks.get(*i) {
      Some(Tok::Num(v)) => {
        *i += 1;
        Some(*v)
      }
      _ => None,
    }
  };
  let flush = |cur: &mut Option<SubPath>, out: &mut Vec<SubPath>| {
    if let Some(sp) = cur.take() {
      if sp.points.len() > 1 || sp.closed {
        out.push(sp);
      }
    }
  };
  while i < toks.len() {
    if let Tok::Cmd(c) = toks[i] {
      cmd = c;
      i += 1;
    }
    let rel = cmd.is_ascii_lowercase();
    let (ox, oy) = if rel { (x, y) } else { (0.0, 0.0) };
    let start_len = i;
    match cmd.to_ascii_uppercase() {
      'M' => {
        let (Some(a), Some(b)) = (num(&mut i), num(&mut i)) else { break };
        flush(&mut cur, &mut out);
        x = ox + a;
        y = oy + b;
        sx = x;
        sy = y;
        cur = Some(SubPath {
          points: vec![VectorPoint::at(x, y)],
          closed: false,
        });
        // Further pairs after M are implicit L.
        cmd = if rel { 'l' } else { 'L' };
        last_ctrl = None;
      }
      'L' | 'H' | 'V' => {
        let up = cmd.to_ascii_uppercase();
        let (nx, ny) = match up {
          'L' => {
            let (Some(a), Some(b)) = (num(&mut i), num(&mut i)) else { break };
            (ox + a, oy + b)
          }
          'H' => {
            let Some(a) = num(&mut i) else { break };
            (if rel { x + a } else { a }, y)
          }
          _ => {
            let Some(b) = num(&mut i) else { break };
            (x, if rel { y + b } else { b })
          }
        };
        line_to(&mut cur, x, y, nx, ny);
        x = nx;
        y = ny;
        last_ctrl = None;
      }
      'C' | 'S' => {
        let smooth = cmd.eq_ignore_ascii_case(&'S');
        let (c1x, c1y) = if smooth {
          match last_ctrl {
            Some((lx, ly, 'C')) => (2.0 * x - lx, 2.0 * y - ly),
            _ => (x, y),
          }
        } else {
          let (Some(a), Some(b)) = (num(&mut i), num(&mut i)) else { break };
          (ox + a, oy + b)
        };
        let (Some(c), Some(dd), Some(e), Some(f)) = (num(&mut i), num(&mut i), num(&mut i), num(&mut i)) else {
          break;
        };
        let (c2x, c2y, nx, ny) = (ox + c, oy + dd, ox + e, oy + f);
        cubic_to(&mut cur, x, y, c1x, c1y, c2x, c2y, nx, ny);
        last_ctrl = Some((c2x, c2y, 'C'));
        x = nx;
        y = ny;
      }
      'Q' | 'T' => {
        let smooth = cmd.eq_ignore_ascii_case(&'T');
        let (qx, qy) = if smooth {
          match last_ctrl {
            Some((lx, ly, 'Q')) => (2.0 * x - lx, 2.0 * y - ly),
            _ => (x, y),
          }
        } else {
          let (Some(a), Some(b)) = (num(&mut i), num(&mut i)) else { break };
          (ox + a, oy + b)
        };
        let (Some(e), Some(f)) = (num(&mut i), num(&mut i)) else { break };
        let (nx, ny) = (ox + e, oy + f);
        let c1 = (x + 2.0 / 3.0 * (qx - x), y + 2.0 / 3.0 * (qy - y));
        let c2 = (nx + 2.0 / 3.0 * (qx - nx), ny + 2.0 / 3.0 * (qy - ny));
        cubic_to(&mut cur, x, y, c1.0, c1.1, c2.0, c2.1, nx, ny);
        last_ctrl = Some((qx, qy, 'Q'));
        x = nx;
        y = ny;
      }
      'A' => {
        let vals: Vec<f64> = (0..7).filter_map(|_| num(&mut i)).collect();
        if vals.len() < 7 {
          break;
        }
        let (nx, ny) = (ox + vals[5], oy + vals[6]);
        for (c1, c2, p) in arc_to_cubics(x, y, vals[0], vals[1], vals[2], vals[3] != 0.0, vals[4] != 0.0, nx, ny) {
          let (px, py) = cur.as_ref().and_then(|c| c.points.last()).map(|p| (p.x, p.y)).unwrap_or((x, y));
          cubic_to(&mut cur, px, py, c1.0, c1.1, c2.0, c2.1, p.0, p.1);
        }
        x = nx;
        y = ny;
        last_ctrl = None;
      }
      'Z' => {
        if let Some(sp) = cur.as_mut() {
          // A closing segment that returns exactly to the start merges into the first point.
          if sp.points.len() > 1 {
            let last = *sp.points.last().unwrap();
            if (last.x - sp.points[0].x).abs() < 1e-9 && (last.y - sp.points[0].y).abs() < 1e-9 {
              sp.points.pop();
              sp.points[0].in_x = last.in_x;
              sp.points[0].in_y = last.in_y;
            }
          }
          sp.closed = true;
        }
        flush(&mut cur, &mut out);
        x = sx;
        y = sy;
        last_ctrl = None;
      }
      _ => i += 1,
    }
    // Skip stray numbers that no command consumed.
    if i == start_len && matches!(toks.get(i), Some(Tok::Num(_))) {
      i += 1;
    }
  }
  flush(&mut cur, &mut out);
  out
}

#[derive(Debug, Clone, Copy)]
enum Tok {
  Cmd(char),
  Num(f64),
}

fn tokenize(d: &str) -> Vec<Tok> {
  let mut out = Vec::new();
  let b = d.as_bytes();
  let mut i = 0;
  // Arc flags may be written without separators ("a1 1 0 00 1 1"); track position within an A command.
  let mut arc_pos: Option<usize> = None;
  while i < b.len() {
    let c = b[i] as char;
    if c.is_ascii_alphabetic() && c != 'e' && c != 'E' {
      arc_pos = if c == 'A' || c == 'a' { Some(0) } else { None };
      out.push(Tok::Cmd(c));
      i += 1;
      continue;
    }
    if c.is_ascii_digit() || c == '.' || c == '-' || c == '+' {
      if let Some(p) = arc_pos {
        if (p % 7 == 3 || p % 7 == 4) && (c == '0' || c == '1') {
          out.push(Tok::Num(if c == '1' { 1.0 } else { 0.0 }));
          arc_pos = Some(p + 1);
          i += 1;
          continue;
        }
      }
      let start = i;
      i += 1;
      let mut seen_dot = c == '.';
      while i < b.len() {
        let ch = b[i] as char;
        if ch.is_ascii_digit() {
          i += 1;
        } else if ch == '.' && !seen_dot {
          seen_dot = true;
          i += 1;
        } else if (ch == 'e' || ch == 'E') && i + 1 < b.len() {
          i += 1;
          if b[i] == b'-' || b[i] == b'+' {
            i += 1;
          }
        } else {
          break;
        }
      }
      if let Ok(v) = d[start..i].parse::<f64>() {
        out.push(Tok::Num(v));
        if let Some(p) = arc_pos {
          arc_pos = Some(p + 1);
        }
      }
      continue;
    }
    i += 1;
  }
  out
}

fn line_to(cur: &mut Option<SubPath>, x: f64, y: f64, nx: f64, ny: f64) {
  let sp = cur.get_or_insert_with(|| SubPath {
    points: vec![VectorPoint::at(x, y)],
    closed: false,
  });
  sp.points.push(VectorPoint::at(nx, ny));
}

#[allow(clippy::too_many_arguments)]
fn cubic_to(cur: &mut Option<SubPath>, x: f64, y: f64, c1x: f64, c1y: f64, c2x: f64, c2y: f64, nx: f64, ny: f64) {
  let sp = cur.get_or_insert_with(|| SubPath {
    points: vec![VectorPoint::at(x, y)],
    closed: false,
  });
  if let Some(last) = sp.points.last_mut() {
    last.out_x = c1x - last.x;
    last.out_y = c1y - last.y;
  }
  sp.points.push(VectorPoint {
    in_x: c2x - nx,
    in_y: c2y - ny,
    ..VectorPoint::at(nx, ny)
  });
}

type Seg = ((f64, f64), (f64, f64), (f64, f64));

/// SVG elliptical arc to cubic segments (W3C implementation notes, F.6).
#[allow(clippy::too_many_arguments)]
fn arc_to_cubics(x1: f64, y1: f64, rx: f64, ry: f64, phi_deg: f64, large: bool, sweep: bool, x2: f64, y2: f64) -> Vec<Seg> {
  if (x1 - x2).abs() < 1e-12 && (y1 - y2).abs() < 1e-12 {
    return vec![];
  }
  let (mut rx, mut ry) = (rx.abs(), ry.abs());
  if rx < 1e-12 || ry < 1e-12 {
    return vec![((x1, y1), (x2, y2), (x2, y2))];
  }
  let phi = phi_deg.to_radians();
  let (cp, sp) = (phi.cos(), phi.sin());
  let dx = (x1 - x2) / 2.0;
  let dy = (y1 - y2) / 2.0;
  let x1p = cp * dx + sp * dy;
  let y1p = -sp * dx + cp * dy;
  let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if lambda > 1.0 {
    rx *= lambda.sqrt();
    ry *= lambda.sqrt();
  }
  let num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  let den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let mut coef = (num / den).max(0.0).sqrt();
  if large == sweep {
    coef = -coef;
  }
  let cxp = coef * rx * y1p / ry;
  let cyp = -coef * ry * x1p / rx;
  let cx = cp * cxp - sp * cyp + (x1 + x2) / 2.0;
  let cy = sp * cxp + cp * cyp + (y1 + y2) / 2.0;
  let ang = |ux: f64, uy: f64, vx: f64, vy: f64| -> f64 {
    let a = (ux * vx + uy * vy) / ((ux * ux + uy * uy).sqrt() * (vx * vx + vy * vy).sqrt());
    let s = if ux * vy - uy * vx < 0.0 { -1.0 } else { 1.0 };
    s * a.clamp(-1.0, 1.0).acos()
  };
  let theta1 = ang(1.0, 0.0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let mut dtheta = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if !sweep && dtheta > 0.0 {
    dtheta -= std::f64::consts::TAU;
  } else if sweep && dtheta < 0.0 {
    dtheta += std::f64::consts::TAU;
  }
  let n = (dtheta.abs() / (std::f64::consts::FRAC_PI_2) - 1e-9).ceil().max(1.0) as usize;
  let step = dtheta / n as f64;
  let t = 4.0 / 3.0 * (step / 4.0).tan();
  let point = |a: f64| -> (f64, f64) {
    let (ca, sa) = (a.cos(), a.sin());
    (cx + rx * ca * cp - ry * sa * sp, cy + rx * ca * sp + ry * sa * cp)
  };
  let deriv = |a: f64| -> (f64, f64) {
    let (ca, sa) = (a.cos(), a.sin());
    (-rx * sa * cp - ry * ca * sp, -rx * sa * sp + ry * ca * cp)
  };
  (0..n)
    .map(|k| {
      let a1 = theta1 + step * k as f64;
      let a2 = a1 + step;
      let (p1, p2) = (point(a1), point(a2));
      let (d1, d2) = (deriv(a1), deriv(a2));
      ((p1.0 + t * d1.0, p1.1 + t * d1.1), (p2.0 - t * d2.0, p2.1 - t * d2.1), p2)
    })
    .collect()
}

// ------------------------------------------------------------ layer outlines

/// A layer's outline in its own coordinates, or None for layers without geometry (text, empty groups).
pub fn local_outline(n: &Node) -> Option<Vec<SubPath>> {
  let (w, h) = (n.width, n.height);
  match n.kind {
    NodeType::Ellipse => {
      let (rx, ry) = (w / 2.0, h / 2.0);
      let p = |x: f64, y: f64, ix: f64, iy: f64| VectorPoint {
        in_x: ix,
        in_y: iy,
        out_x: -ix,
        out_y: -iy,
        ..VectorPoint::at(x, y)
      };
      Some(vec![SubPath {
        points: vec![
          p(rx, 0.0, -K * rx, 0.0),
          p(w, ry, 0.0, -K * ry),
          p(rx, h, K * rx, 0.0),
          p(0.0, ry, 0.0, K * ry),
        ],
        closed: true,
      }])
    }
    NodeType::Polygon | NodeType::Star => Some(vec![SubPath {
      points: shapes::polygon_points(n).into_iter().map(|p| VectorPoint::at(p.x, p.y)).collect(),
      closed: true,
    }]),
    NodeType::Line => Some(vec![SubPath {
      points: vec![VectorPoint::at(0.0, 0.0), VectorPoint::at(w, 0.0)],
      closed: false,
    }]),
    NodeType::Vector => {
      let v = n.vector.as_ref()?;
      if let Some(raw) = &v.raw {
        let [vx, vy, vw, vh] = raw.view_box;
        let sx = if vw > 0.0 { w / vw } else { 1.0 };
        let sy = if vh > 0.0 { h / vh } else { 1.0 };
        let m = Mat {
          a: sx,
          b: 0.0,
          c: 0.0,
          d: sy,
          e: -vx * sx,
          f: -vy * sy,
        };
        Some(parse_svg_path(&raw.d).iter().map(|sp| transform(sp, &m)).collect())
      } else {
        Some(v.subpaths.clone())
      }
    }
    NodeType::Text | NodeType::Group => None,
    _ => Some(vec![rounded_rect(w, h, shapes::corner_radii(n))]),
  }
}

fn rounded_rect(w: f64, h: f64, r: [f64; 4]) -> SubPath {
  let max = (w.min(h) / 2.0).max(0.0);
  let [tl, tr, br, bl] = r.map(|v| v.clamp(0.0, max));
  let mut pts = Vec::new();
  // Each corner contributes two points joined by a cubic quarter circle (or one sharp point).
  let mut corner = |a: (f64, f64), b: (f64, f64), out: (f64, f64), inn: (f64, f64), r: f64, sharp: (f64, f64)| {
    if r <= 0.0 {
      pts.push(VectorPoint::at(sharp.0, sharp.1));
    } else {
      pts.push(VectorPoint {
        out_x: out.0 * K * r,
        out_y: out.1 * K * r,
        ..VectorPoint::at(a.0, a.1)
      });
      pts.push(VectorPoint {
        in_x: inn.0 * K * r,
        in_y: inn.1 * K * r,
        ..VectorPoint::at(b.0, b.1)
      });
    }
  };
  corner((w - tr, 0.0), (w, tr), (1.0, 0.0), (0.0, -1.0), tr, (w, 0.0));
  corner((w, h - br), (w - br, h), (0.0, 1.0), (1.0, 0.0), br, (w, h));
  corner((bl, h), (0.0, h - bl), (-1.0, 0.0), (0.0, 1.0), bl, (0.0, h));
  corner((0.0, tl), (tl, 0.0), (0.0, -1.0), (-1.0, 0.0), tl, (0.0, 0.0));
  SubPath { points: pts, closed: true }
}

/// Applies an affine matrix to anchors and handles.
pub fn transform(sp: &SubPath, m: &Mat) -> SubPath {
  SubPath {
    points: sp
      .points
      .iter()
      .map(|p| {
        let a = m.apply(Point::new(p.x, p.y));
        let i = m.apply_vec(Point::new(p.in_x, p.in_y));
        let o = m.apply_vec(Point::new(p.out_x, p.out_y));
        VectorPoint {
          x: a.x,
          y: a.y,
          in_x: i.x,
          in_y: i.y,
          out_x: o.x,
          out_y: o.y,
        }
      })
      .collect(),
    closed: sp.closed,
  }
}

/// Page-space outline of a layer; groups contribute their children's outlines.
pub fn page_outline(doc: &Document, id: &str) -> Vec<SubPath> {
  let Some(n) = doc.get(id) else { return vec![] };
  if !n.visible {
    return vec![];
  }
  if n.kind == NodeType::Group {
    return n.children.iter().flat_map(|c| page_outline(doc, c)).collect();
  }
  let m = doc.abs_matrix(id);
  local_outline(n).unwrap_or_default().iter().map(|sp| transform(sp, &m)).collect()
}

// --------------------------------------------------------------- polygons

/// Samples subpaths into polygon contours (closed) and polylines (open).
pub fn to_contours(sps: &[SubPath]) -> (Vec<Contour>, Vec<Contour>) {
  let mut closed = Vec::new();
  let mut open = Vec::new();
  for sp in sps {
    let pts = &sp.points;
    if pts.len() < 2 && !(sp.closed && !pts.is_empty()) {
      continue;
    }
    let mut c: Contour = vec![[pts[0].x, pts[0].y]];
    let mut seg = |a: &VectorPoint, b: &VectorPoint| {
      if a.out_x == 0.0 && a.out_y == 0.0 && b.in_x == 0.0 && b.in_y == 0.0 {
        c.push([b.x, b.y]);
        return;
      }
      let p0 = (a.x, a.y);
      let p1 = (a.x + a.out_x, a.y + a.out_y);
      let p2 = (b.x + b.in_x, b.y + b.in_y);
      let p3 = (b.x, b.y);
      let len = dist(p0, p1) + dist(p1, p2) + dist(p2, p3);
      let n = ((len / 3.0).ceil() as usize).clamp(4, 64);
      for i in 1..=n {
        let t = i as f64 / n as f64;
        let u = 1.0 - t;
        c.push([
          u * u * u * p0.0 + 3.0 * u * u * t * p1.0 + 3.0 * u * t * t * p2.0 + t * t * t * p3.0,
          u * u * u * p0.1 + 3.0 * u * u * t * p1.1 + 3.0 * u * t * t * p2.1 + t * t * t * p3.1,
        ]);
      }
    };
    for w in pts.windows(2) {
      seg(&w[0], &w[1]);
    }
    if sp.closed {
      seg(&pts[pts.len() - 1], &pts[0]);
      c.pop();
      if c.len() >= 3 {
        closed.push(c);
      }
    } else {
      open.push(c);
    }
  }
  (closed, open)
}

fn dist(a: (f64, f64), b: (f64, f64)) -> f64 {
  ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)).sqrt()
}

/// Flattens clipper output, removing the float noise of its integer scaling (1/1000 px).
fn shapes_to_contours(shapes: Vec<Vec<Contour>>) -> Vec<Contour> {
  let r = |v: f64| (v * 1000.0).round() / 1000.0;
  shapes
    .into_iter()
    .flatten()
    .filter(|c| c.len() >= 3)
    .map(|c| c.into_iter().map(|p| [r(p[0]), r(p[1])]).collect())
    .collect()
}

/// Folds a boolean operation over shapes in paint order (bottom first).
pub fn boolean(shapes: &[Vec<Contour>], op: BoolOp) -> Vec<Contour> {
  let Some(first) = shapes.first() else { return vec![] };
  let rule = match op {
    BoolOp::Union => OverlayRule::Union,
    BoolOp::Subtract => OverlayRule::Difference,
    BoolOp::Intersect => OverlayRule::Intersect,
    BoolOp::Exclude => OverlayRule::Xor,
  };
  let mut acc = first.clone();
  for s in &shapes[1..] {
    if acc.is_empty() && op != BoolOp::Union && op != BoolOp::Exclude {
      break;
    }
    acc = shapes_to_contours(acc.overlay(s, rule, FillRule::NonZero));
  }
  // A single shape still gets normalised (self-overlaps resolved).
  if shapes.len() == 1 {
    acc = shapes_to_contours(acc.overlay(&Vec::<Contour>::new(), OverlayRule::Subject, FillRule::NonZero));
  }
  acc
}

/// Outlines a stroke into filled contours.
pub fn stroke_outline(n: &Node, sps: &[SubPath]) -> Vec<Contour> {
  let sw = n.stroke_weight.max(0.0);
  if sw <= 0.0 {
    return vec![];
  }
  let (closed, open) = to_contours(sps);
  let round_caps = n
    .shape
    .as_ref()
    .map(|s| s.start_cap == crate::model::StrokeCap::Round)
    .unwrap_or(false);
  let cap = || if round_caps { LineCap::Round(0.25) } else { LineCap::Butt };
  let width = match n.stroke_align {
    StrokeAlign::Center => sw,
    _ => sw * 2.0,
  };
  let style = || {
    StrokeStyle::new(width)
      .line_join(if closed.is_empty() {
        LineJoin::Round(0.25)
      } else {
        LineJoin::Miter(0.2)
      })
      .start_cap(cap())
      .end_cap(cap())
  };
  let mut out: Vec<Contour> = Vec::new();
  if !closed.is_empty() {
    let ring = shapes_to_contours(closed.stroke(style(), true));
    out.extend(match n.stroke_align {
      StrokeAlign::Center => ring,
      StrokeAlign::Inside => shapes_to_contours(ring.overlay(&closed, OverlayRule::Intersect, FillRule::NonZero)),
      StrokeAlign::Outside => shapes_to_contours(ring.overlay(&closed, OverlayRule::Difference, FillRule::NonZero)),
    });
  }
  for line in &open {
    let s = StrokeStyle::new(sw)
      .line_join(LineJoin::Round(0.25))
      .start_cap(cap())
      .end_cap(cap());
    out.extend(shapes_to_contours(line.stroke(s, false)));
  }
  out
}

/// Contours as closed straight-line subpaths.
pub fn contours_to_subpaths(cs: &[Contour]) -> Vec<SubPath> {
  cs.iter()
    .map(|c| SubPath {
      points: c.iter().map(|p| VectorPoint::at(p[0], p[1])).collect(),
      closed: true,
    })
    .collect()
}

/// Bounding box of subpath geometry (curves sampled).
pub fn bounds(sps: &[SubPath]) -> Option<(f64, f64, f64, f64)> {
  shapes::subpaths_bounds(sps)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn area(c: &Contour) -> f64 {
    let mut a = 0.0;
    for i in 0..c.len() {
      let (p, q) = (c[i], c[(i + 1) % c.len()]);
      a += p[0] * q[1] - q[0] * p[1];
    }
    a / 2.0
  }

  fn total_area(cs: &[Contour]) -> f64 {
    cs.iter().map(area).sum::<f64>().abs()
  }

  fn square(x: f64, y: f64, s: f64) -> Vec<Contour> {
    vec![vec![[x, y], [x + s, y], [x + s, y + s], [x, y + s]]]
  }

  #[test]
  fn parses_common_path_commands() {
    let sps = parse_svg_path("M10 10 h20 v20 H10 z m5 5 l1-1 c1 1 2 2 3 3 s4 4 5 5 q1 1 2 2 t3 3");
    assert_eq!(sps.len(), 2);
    assert!(sps[0].closed && sps[0].points.len() == 4);
    assert_eq!((sps[1].points[0].x, sps[1].points[0].y), (15.0, 15.0));
    assert_eq!(sps[1].points.len(), 6);
    // Compact arc flags: "a5 5 0 015 5".
    let arc = parse_svg_path("M0 0a5 5 0 0110 0");
    let last = arc[0].points.last().unwrap();
    assert!((last.x - 10.0).abs() < 1e-9 && last.y.abs() < 1e-9, "{last:?}");
  }

  #[test]
  fn booleans_have_expected_areas() {
    let a = square(0.0, 0.0, 10.0);
    let b = square(5.0, 5.0, 10.0);
    let shapes = [a, b];
    assert!((total_area(&boolean(&shapes, BoolOp::Union)) - 175.0).abs() < 0.01);
    assert!((total_area(&boolean(&shapes, BoolOp::Subtract)) - 75.0).abs() < 0.01);
    assert!((total_area(&boolean(&shapes, BoolOp::Intersect)) - 25.0).abs() < 0.01);
    assert!((total_area(&boolean(&shapes, BoolOp::Exclude)) - 150.0).abs() < 0.01);
  }

  #[test]
  fn ellipse_outline_is_round() {
    let n = Node {
      kind: NodeType::Ellipse,
      width: 100.0,
      height: 100.0,
      ..Default::default()
    };
    let (closed, _) = to_contours(&local_outline(&n).unwrap());
    let a = total_area(&closed);
    assert!((a - std::f64::consts::PI * 2500.0).abs() < 30.0, "{a}");
  }

  #[test]
  fn centered_stroke_outline_is_a_ring() {
    let n = Node {
      width: 100.0,
      height: 100.0,
      stroke_weight: 10.0,
      stroke_align: StrokeAlign::Center,
      ..Default::default()
    };
    let ring = stroke_outline(&n, &local_outline(&n).unwrap());
    // Outer 110² minus inner 90².
    let net: f64 = ring.iter().map(area).sum::<f64>().abs();
    assert!((net - (110.0 * 110.0 - 90.0 * 90.0)).abs() < 1.0, "{net}");
  }
}
