//! SVG markup to editable layers: a frame holding groups, rectangles, ellipses and vector paths.
//!
//! SVG is untrusted input (clipboard, dropped files, Claude's `create_nodes`), so the reader is
//! small and closed by construction: its own XML scanner with no DOM, no DTD and no entity
//! expansion beyond the five predefined and numeric ones, and nothing is ever fetched (`href`s
//! other than a local `#id` are ignored). Input size, element count, nesting, `<use>` depth and
//! path points are all bounded; passing a limit refuses the import. Anything that can't be
//! represented (text, images, filters, masks, patterns, markers, clip paths that aren't one
//! rectangle) also refuses it, and the caller falls back to placing the SVG as an image.

use std::collections::{HashMap, HashSet};

use crate::color::{self, Rgba};
use crate::doc::IdGen;
use crate::geom::{Mat, Point};
use crate::model::{
  GradientHandles, GradientStop, Node, NodeType, Paint, ShapeProps, StrokeAlign, StrokeCap, StrokeJoin, SubPath, VectorData, VectorPoint,
};
use crate::{ops, paths, shapes, vector_edit};

pub const MAX_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_ELEMENTS: usize = 20_000;
pub const MAX_DEPTH: usize = 64;
pub const MAX_USE_DEPTH: usize = 8;
pub const MAX_POINTS: usize = 200_000;
/// Above this many subpaths in one evenodd path the holes are left as they are.
const EVENODD_MAX_SUBPATHS: usize = 500;
const MAX_COORD: f64 = 1e7;
const MAX_SIZE: f64 = 100_000.0;
const MAX_NAME: usize = 80;
const EPS: f64 = 1e-9;

/// What the caller can choose; everything else comes from the markup.
#[derive(Default, Clone, Debug)]
pub struct Options {
  /// Name of the frame (a file name); "SVG" otherwise.
  pub name: Option<String>,
  /// Size of the frame; the drawing is scaled into it like a browser scales `<svg width height>`.
  /// One of them alone keeps the aspect ratio.
  pub width: Option<f64>,
  pub height: Option<f64>,
}

#[derive(Debug)]
pub struct Imported {
  /// Pre-order, `nodes[0]` is the frame. Positions are relative to the parent (the frame sits at
  /// 0,0), ids are fresh, `page` is empty.
  pub nodes: Vec<Node>,
  /// Things that were approximated or left out (the import still succeeded).
  pub warnings: Vec<String>,
}

/// Reads `svg` into layers. `Err` holds the reason as the end of "this SVG uses ...".
pub fn import(svg: &str, ids: &mut IdGen, opts: &Options) -> Result<Imported, String> {
  if svg.len() > MAX_BYTES {
    return Err("more than 2 MB of markup".into());
  }
  let xml = parse_xml(svg)?;
  let mut cx = Cx::new(&xml);
  cx.collect();
  let root = 0;
  let decl = cx.declared(root);
  let st = cx.compute_style(&Style::initial(), &decl);

  // Frame size and the viewBox mapping.
  let vb = cx
    .attr(root, "viewBox")
    .map(numbers)
    .filter(|v| v.len() == 4 && v[2] > 0.0 && v[3] > 0.0 && v.iter().all(|x| x.is_finite()))
    .map(|v| [v[0], v[1], v[2], v[3]]);
  cx.vb_size = vb.map(|v| (v[2], v[3])).unwrap_or((100.0, 100.0));
  let length = |name: &str| -> Option<f64> {
    let v = cx.attr(root, name)?;
    match (v.trim().ends_with('%'), vb) {
      (true, Some(b)) => parse_length(v, if name == "width" { b[2] } else { b[3] }),
      (true, None) => None,
      _ => parse_length(v, 0.0),
    }
    .filter(|x| *x > 0.0)
  };
  let (aw, ah) = (length("width"), length("height"));
  // The natural size: width and height, else the viewBox, a missing one following the aspect ratio.
  let natural = match (aw, ah, vb) {
    (Some(w), Some(h), _) => Some((w, h)),
    (Some(w), None, Some(b)) => Some((w, w * b[3] / b[2])),
    (None, Some(h), Some(b)) => Some((h * b[2] / b[3], h)),
    (None, None, Some(b)) => Some((b[2], b[3])),
    (Some(w), None, None) => Some((w, w)),
    (None, Some(h), None) => Some((h, h)),
    (None, None, None) => None,
  };
  let (ow, oh) = (opts.width.filter(|v| *v > 0.0), opts.height.filter(|v| *v > 0.0));
  let size = match (natural, ow, oh) {
    (Some((nw, nh)), Some(w), None) => Some((w, w * nh / nw)),
    (Some((nw, nh)), None, Some(h)) => Some((h * nw / nh, h)),
    (_, Some(w), Some(h)) => Some((w, h)),
    (n, _, _) => n,
  };
  if let Some((w, h)) = size {
    if !(w.is_finite() && h.is_finite() && w >= 0.01 && h >= 0.01 && w <= MAX_SIZE && h <= MAX_SIZE) {
      return Err("a size that is out of range".into());
    }
  }
  let m = match (size, vb) {
    (Some((w, h)), Some(b)) => view_box_matrix(b, w, h, cx.attr(root, "preserveAspectRatio").unwrap_or("")),
    _ => Mat::IDENTITY,
  };
  let clips = cx.attr(root, "overflow").map(|v| v.trim() != "visible").unwrap_or(true);
  cx.viewport = size.filter(|_| clips).map(|(w, h)| (0.0, 0.0, w, h));

  let mut kids = Vec::new();
  for k in xml.els[root].kids.clone() {
    cx.walk(k, &m, &st, &mut kids)?;
  }
  if kids.is_empty() {
    return Err("nothing it can draw".into());
  }
  // No size anywhere: the frame is as big as the drawing.
  let (w, h) = size.unwrap_or_else(|| {
    let mut right = 1.0_f64;
    let mut bottom = 1.0_f64;
    for k in &kids {
      right = right.max(k.node.x + k.node.width);
      bottom = bottom.max(k.node.y + k.node.height);
    }
    (right.ceil(), bottom.ceil())
  });
  let mut frame = ops::default_node(NodeType::Frame, String::new(), opts.name.clone().unwrap_or_else(|| "SVG".into()));
  frame.fills.clear();
  frame.clip_content = clips;
  frame.width = w;
  frame.height = h;
  frame.opacity = opacity_of(&decl);
  let mut tree = B { node: frame, kids };
  fix_groups(&mut tree);
  let mut nodes = Vec::new();
  flatten(tree, None, (0.0, 0.0), ids, &mut nodes);
  Ok(Imported {
    nodes,
    warnings: cx.warnings,
  })
}

// ------------------------------------------------------------------ XML

struct El {
  name: String,
  attrs: Vec<(String, String)>,
  kids: Vec<usize>,
  /// Text of a `<style>` element (character data and CDATA); empty for the rest.
  text: String,
}

struct Xml {
  els: Vec<El>,
}

/// A small non-validating XML reader. DOCTYPEs with an internal subset, `<!ENTITY`, entities
/// other than the predefined and numeric ones, and malformed markup are all errors.
fn parse_xml(s: &str) -> Result<Xml, String> {
  let s = s.strip_prefix('\u{feff}').unwrap_or(s);
  let b = s.as_bytes();
  let mut els: Vec<El> = Vec::new();
  let mut stack: Vec<usize> = Vec::new();
  let mut closed_root = false;
  let mut i = 0;
  let bad = || "markup that can't be read".to_string();
  while i < b.len() {
    let lt = match s[i..].find('<') {
      Some(k) => i + k,
      None => {
        // Trailing text: only whitespace is fine outside the root.
        if !stack.is_empty() {
          return Err(bad());
        }
        break;
      }
    };
    if let Some(&top) = stack.last() {
      if els[top].name == "style" {
        els[top].text.push_str(&s[i..lt]);
      }
    }
    i = lt;
    let rest = &s[i..];
    if let Some(after) = rest.strip_prefix("<!--") {
      let end = after.find("-->").ok_or_else(bad)?;
      i += 4 + end + 3;
    } else if let Some(after) = rest.strip_prefix("<![CDATA[") {
      let end = after.find("]]>").ok_or_else(bad)?;
      if let Some(&top) = stack.last() {
        if els[top].name == "style" {
          els[top].text.push_str(&after[..end]);
        }
      }
      i += 9 + end + 3;
    } else if let Some(after) = rest.strip_prefix("<?") {
      let end = after.find("?>").ok_or_else(bad)?;
      i += 2 + end + 2;
    } else if rest.starts_with("<!") {
      if rest.len() >= 9 && rest[..9].eq_ignore_ascii_case("<!DOCTYPE") {
        let gt = rest.find('>').ok_or_else(bad)?;
        if rest[..gt].contains('[') {
          return Err("a DOCTYPE with an internal subset".into());
        }
        i += gt + 1;
      } else {
        return Err("a declaration (entities are not supported)".into());
      }
    } else if rest.starts_with("</") {
      let gt = rest.find('>').ok_or_else(bad)?;
      let name = local_name(rest[2..gt].trim());
      let top = stack.pop().ok_or_else(bad)?;
      if els[top].name != name {
        return Err(bad());
      }
      if stack.is_empty() {
        closed_root = true;
      }
      i += gt + 1;
    } else {
      if closed_root {
        return Err(bad());
      }
      // An opening tag.
      let mut j = i + 1;
      while j < b.len() && !b[j].is_ascii_whitespace() && b[j] != b'/' && b[j] != b'>' {
        j += 1;
      }
      let name = local_name(&s[i + 1..j]);
      if name.is_empty() || j >= b.len() {
        return Err(bad());
      }
      let mut attrs: Vec<(String, String)> = Vec::new();
      let self_closing;
      loop {
        while j < b.len() && b[j].is_ascii_whitespace() {
          j += 1;
        }
        if j >= b.len() {
          return Err(bad());
        }
        match b[j] {
          b'>' => {
            self_closing = false;
            j += 1;
            break;
          }
          b'/' => {
            if b.get(j + 1) != Some(&b'>') {
              return Err(bad());
            }
            self_closing = true;
            j += 2;
            break;
          }
          _ => {}
        }
        let start = j;
        while j < b.len() && b[j] != b'=' && !b[j].is_ascii_whitespace() && b[j] != b'>' && b[j] != b'/' {
          j += 1;
        }
        let key = &s[start..j];
        while j < b.len() && b[j].is_ascii_whitespace() {
          j += 1;
        }
        if key.is_empty() || b.get(j) != Some(&b'=') {
          return Err(bad());
        }
        j += 1;
        while j < b.len() && b[j].is_ascii_whitespace() {
          j += 1;
        }
        let q = *b.get(j).ok_or_else(bad)?;
        if q != b'"' && q != b'\'' {
          return Err(bad());
        }
        let vstart = j + 1;
        let vend = s[vstart..].find(q as char).map(|k| vstart + k).ok_or_else(bad)?;
        let value = decode_entities(&s[vstart..vend])?;
        j = vend + 1;
        if !(key == "xmlns" || key.starts_with("xmlns:")) {
          attrs.push((local_name(key), value));
        }
      }
      if els.len() >= MAX_ELEMENTS {
        return Err("too many elements".into());
      }
      if stack.len() >= MAX_DEPTH {
        return Err("elements nested too deeply".into());
      }
      let idx = els.len();
      if els.is_empty() && name != "svg" {
        return Err("a root element that isn't <svg>".into());
      }
      els.push(El {
        name,
        attrs,
        kids: Vec::new(),
        text: String::new(),
      });
      if let Some(&p) = stack.last() {
        els[p].kids.push(idx);
      }
      if self_closing {
        if stack.is_empty() {
          closed_root = true;
        }
      } else {
        stack.push(idx);
      }
      i = j;
    }
  }
  if !stack.is_empty() || els.is_empty() {
    return Err(bad());
  }
  Ok(Xml { els })
}

/// `svg:path` → `path`, `xlink:href` → `href`.
fn local_name(n: &str) -> String {
  n.rsplit(':').next().unwrap_or(n).to_string()
}

fn decode_entities(s: &str) -> Result<String, String> {
  if !s.contains('&') {
    return Ok(s.to_string());
  }
  let mut out = String::with_capacity(s.len());
  let mut rest = s;
  while let Some(p) = rest.find('&') {
    out.push_str(&rest[..p]);
    rest = &rest[p + 1..];
    let semi = rest
      .find(';')
      .filter(|k| *k <= 10)
      .ok_or_else(|| "an entity reference".to_string())?;
    let name = &rest[..semi];
    let ch = match name {
      "amp" => '&',
      "lt" => '<',
      "gt" => '>',
      "quot" => '"',
      "apos" => '\'',
      _ => {
        let code = if let Some(h) = name.strip_prefix("#x").or_else(|| name.strip_prefix("#X")) {
          u32::from_str_radix(h, 16).ok()
        } else {
          name.strip_prefix('#').and_then(|d| d.parse().ok())
        };
        code.and_then(char::from_u32).ok_or_else(|| "an entity reference".to_string())?
      }
    };
    out.push(ch);
    rest = &rest[semi + 1..];
  }
  out.push_str(rest);
  Ok(out)
}

// ------------------------------------------------------------------ CSS

struct Sel {
  tag: Option<String>,
  id: Option<String>,
  classes: Vec<String>,
}

struct Rule {
  sel: Sel,
  spec: u32,
  order: usize,
  decls: Vec<(String, String)>,
}

/// Properties read from presentation attributes (and from CSS).
const PROPS: &[&str] = &[
  "fill",
  "stroke",
  "stroke-width",
  "fill-rule",
  "fill-opacity",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "color",
  "opacity",
  "display",
  "visibility",
  "stop-color",
  "stop-opacity",
  "clip-path",
  "filter",
  "mask",
  "marker-start",
  "marker-mid",
  "marker-end",
];

/// Simple selectors only: `tag`, `.class`, `#id`, `*` and combinations without spaces. Anything
/// else is dropped (the caller warns).
fn parse_css(text: &str, rules: &mut Vec<Rule>, unsupported: &mut bool) {
  let mut clean = String::with_capacity(text.len());
  let mut rest = text;
  while let Some(p) = rest.find("/*") {
    clean.push_str(&rest[..p]);
    rest = match rest[p + 2..].find("*/") {
      Some(e) => &rest[p + 2 + e + 2..],
      None => "",
    };
  }
  clean.push_str(rest);
  let b = clean.as_bytes();
  let mut i = 0;
  while i < b.len() {
    let Some(stop) = clean[i..].find(['{', ';']).map(|k| i + k) else {
      break;
    };
    let prelude = clean[i..stop].trim();
    if b[stop] == b';' {
      // @import and @charset: nothing to apply (and nothing is ever fetched).
      i = stop + 1;
      continue;
    }
    // The block, balancing braces.
    let mut depth = 0;
    let mut end = stop;
    while end < b.len() {
      match b[end] {
        b'{' => depth += 1,
        b'}' => {
          depth -= 1;
          if depth == 0 {
            break;
          }
        }
        _ => {}
      }
      end += 1;
    }
    let body = &clean[stop + 1..end.min(clean.len())];
    i = end + 1;
    if prelude.starts_with('@') {
      continue;
    }
    let decls: Vec<(String, String)> = body
      .split(';')
      .filter_map(|d| {
        let (k, v) = d.split_once(':')?;
        let v = v.trim().trim_end_matches("!important").trim();
        Some((k.trim().to_ascii_lowercase(), v.to_string()))
      })
      .collect();
    for sel in prelude.split(',') {
      match parse_selector(sel.trim()) {
        Some(sel) => {
          let spec = if sel.id.is_some() { 100 } else { 0 } + 10 * sel.classes.len() as u32 + sel.tag.is_some() as u32;
          let order = rules.len();
          rules.push(Rule {
            sel,
            spec,
            order,
            decls: decls.clone(),
          });
        }
        None => *unsupported = true,
      }
    }
  }
}

fn parse_selector(s: &str) -> Option<Sel> {
  if s.is_empty() || s.contains([' ', '>', '+', '~', ':', '[', '(', '\t', '\n']) {
    return None;
  }
  let mut sel = Sel {
    tag: None,
    id: None,
    classes: Vec::new(),
  };
  let mut kind = 't';
  let mut cur = String::new();
  let commit = |kind: char, cur: &mut String, sel: &mut Sel| {
    if cur.is_empty() {
      return;
    }
    let v = std::mem::take(cur);
    match kind {
      '.' => sel.classes.push(v),
      '#' => sel.id = Some(v),
      _ if v != "*" => sel.tag = Some(v),
      _ => {}
    }
  };
  for c in s.chars() {
    if c == '.' || c == '#' {
      commit(kind, &mut cur, &mut sel);
      kind = c;
    } else {
      cur.push(c);
    }
  }
  commit(kind, &mut cur, &mut sel);
  Some(sel)
}

// ------------------------------------------------------------------ style

#[derive(Clone, Debug)]
enum SvgPaint {
  None,
  Current,
  Color(Rgba),
  Url(String, Option<Rgba>),
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Cap {
  Butt,
  Round,
  Square,
}

/// The inherited properties of an element.
#[derive(Clone, Debug)]
struct Style {
  fill: SvgPaint,
  stroke: SvgPaint,
  stroke_width: f64,
  evenodd: bool,
  fill_opacity: f64,
  stroke_opacity: f64,
  cap: Cap,
  join: StrokeJoin,
  dash: Vec<f64>,
  color: Rgba,
  visible: bool,
}

impl Style {
  fn initial() -> Style {
    Style {
      fill: SvgPaint::Color(Rgba::BLACK),
      stroke: SvgPaint::None,
      stroke_width: 1.0,
      evenodd: false,
      fill_opacity: 1.0,
      stroke_opacity: 1.0,
      cap: Cap::Butt,
      join: StrokeJoin::Miter,
      dash: Vec::new(),
      color: Rgba::BLACK,
      visible: true,
    }
  }
}

fn opacity_of(decl: &HashMap<String, String>) -> f64 {
  decl.get("opacity").and_then(|v| parse_opacity(v)).unwrap_or(1.0)
}

fn parse_opacity(v: &str) -> Option<f64> {
  let v = v.trim();
  let n = match v.strip_suffix('%') {
    Some(p) => p.trim().parse::<f64>().ok()? / 100.0,
    None => v.parse::<f64>().ok()?,
  };
  n.is_finite().then_some(n.clamp(0.0, 1.0))
}

// ------------------------------------------------------------------ the walk

/// A layer under construction, in the frame's coordinates (made relative at the end).
struct B {
  node: Node,
  kids: Vec<B>,
}

/// Where a shape's geometry comes from.
enum Geom {
  Rect { x: f64, y: f64, w: f64, h: f64, rx: f64, ry: f64 },
  Ellipse { cx: f64, cy: f64, rx: f64, ry: f64 },
  Path(Vec<SubPath>),
}

struct Cx<'a> {
  xml: &'a Xml,
  ids: HashMap<String, usize>,
  rules: Vec<Rule>,
  count: usize,
  points: usize,
  use_stack: Vec<usize>,
  viewport: Option<(f64, f64, f64, f64)>,
  vb_size: (f64, f64),
  warnings: Vec<String>,
  seen: HashSet<String>,
}

impl<'a> Cx<'a> {
  fn new(xml: &'a Xml) -> Cx<'a> {
    Cx {
      xml,
      ids: HashMap::new(),
      rules: Vec::new(),
      count: 0,
      points: 0,
      use_stack: Vec::new(),
      viewport: None,
      vb_size: (100.0, 100.0),
      warnings: Vec::new(),
      seen: HashSet::new(),
    }
  }

  /// Indexes ids and reads the `<style>` blocks.
  fn collect(&mut self) {
    let mut unsupported = false;
    for (i, el) in self.xml.els.iter().enumerate() {
      if let Some(id) = el.attrs.iter().find(|(k, _)| k == "id") {
        self.ids.entry(id.1.clone()).or_insert(i);
      }
      if el.name == "style" {
        let ty = self.attr(i, "type").unwrap_or("text/css");
        if ty.is_empty() || ty == "text/css" {
          parse_css(&el.text, &mut self.rules, &mut unsupported);
        }
      }
    }
    if unsupported {
      self.warn("some <style> selectors are not supported and were ignored");
    }
  }

  fn warn(&mut self, msg: &str) {
    if self.seen.insert(msg.to_string()) {
      self.warnings.push(msg.to_string());
    }
  }

  fn attr(&self, el: usize, name: &str) -> Option<&'a str> {
    self.xml.els[el].attrs.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
  }

  /// Presentation attributes, then matching style rules by specificity, then `style=""`.
  fn declared(&self, el: usize) -> HashMap<String, String> {
    let e = &self.xml.els[el];
    let mut out: HashMap<String, String> = HashMap::new();
    for (k, v) in &e.attrs {
      if PROPS.contains(&k.as_str()) {
        out.insert(k.clone(), v.trim().to_string());
      }
    }
    if !self.rules.is_empty() {
      let id = self.attr(el, "id");
      let classes: Vec<&str> = self.attr(el, "class").map(|c| c.split_whitespace().collect()).unwrap_or_default();
      let mut hits: Vec<&Rule> = self
        .rules
        .iter()
        .filter(|r| {
          r.sel.tag.as_deref().is_none_or(|t| t == e.name)
            && r.sel.id.as_deref().is_none_or(|i| Some(i) == id)
            && r.sel.classes.iter().all(|c| classes.contains(&c.as_str()))
        })
        .collect();
      hits.sort_by_key(|r| (r.spec, r.order));
      for r in hits {
        for (k, v) in &r.decls {
          out.insert(k.clone(), v.clone());
        }
      }
    }
    if let Some(style) = self.attr(el, "style") {
      for d in style.split(';') {
        if let Some((k, v)) = d.split_once(':') {
          out.insert(
            k.trim().to_ascii_lowercase(),
            v.trim().trim_end_matches("!important").trim().to_string(),
          );
        }
      }
    }
    out
  }

  fn compute_style(&mut self, parent: &Style, decl: &HashMap<String, String>) -> Style {
    let mut st = parent.clone();
    let get = |k: &str| decl.get(k).map(|v| v.trim()).filter(|v| *v != "inherit");
    if let Some(v) = get("color").and_then(color::parse) {
      st.color = v;
    }
    if let Some(v) = get("fill") {
      if let Some(p) = self.parse_paint(v) {
        st.fill = p;
      }
    }
    if let Some(v) = get("stroke") {
      if let Some(p) = self.parse_paint(v) {
        st.stroke = p;
      }
    }
    if let Some(v) = get("stroke-width").and_then(|v| parse_length(v, (self.vb_size.0 + self.vb_size.1) / 2.0)) {
      if v >= 0.0 {
        st.stroke_width = v;
      }
    }
    if let Some(v) = get("fill-rule") {
      st.evenodd = v == "evenodd";
    }
    if let Some(v) = get("fill-opacity").and_then(parse_opacity) {
      st.fill_opacity = v;
    }
    if let Some(v) = get("stroke-opacity").and_then(parse_opacity) {
      st.stroke_opacity = v;
    }
    if let Some(v) = get("stroke-linecap") {
      st.cap = match v {
        "round" => Cap::Round,
        "square" => Cap::Square,
        _ => Cap::Butt,
      };
    }
    if let Some(v) = get("stroke-linejoin") {
      st.join = match v {
        "round" => StrokeJoin::Round,
        "bevel" => StrokeJoin::Bevel,
        _ => StrokeJoin::Miter,
      };
    }
    if let Some(v) = get("stroke-dasharray") {
      let d: Vec<f64> = if v == "none" {
        Vec::new()
      } else {
        v.split([',', ' '])
          .filter(|p| !p.is_empty())
          .filter_map(|p| parse_length(p, 0.0))
          .collect()
      };
      st.dash = if d.iter().all(|x| *x >= 0.0) && d.iter().sum::<f64>() > 0.0 {
        d
      } else {
        Vec::new()
      };
    }
    if let Some(v) = get("visibility") {
      st.visible = v != "hidden" && v != "collapse";
    }
    st
  }

  /// `none`, `currentColor`, `url(#id) [fallback]` or a colour. `None` when it isn't valid (the
  /// property is then ignored, like a browser does).
  fn parse_paint(&mut self, v: &str) -> Option<SvgPaint> {
    let v = v.trim();
    let lower = v.to_ascii_lowercase();
    if lower == "none" {
      return Some(SvgPaint::None);
    }
    if lower == "currentcolor" {
      return Some(SvgPaint::Current);
    }
    if let Some(rest) = lower.strip_prefix("url(") {
      let close = rest.find(')')?;
      let target = v[4..4 + close].trim().trim_matches(['"', '\'']).to_string();
      let fallback = v[4 + close + 1..].trim();
      let fb = if fallback.is_empty() || fallback.eq_ignore_ascii_case("none") {
        None
      } else {
        color::parse(fallback)
      };
      return match target.strip_prefix('#') {
        Some(id) => Some(SvgPaint::Url(id.to_string(), fb)),
        None => {
          self.warn("a paint that points outside the document was left out");
          Some(fb.map_or(SvgPaint::None, SvgPaint::Color))
        }
      };
    }
    color::parse(v).map(SvgPaint::Color)
  }

  fn count(&mut self) -> Result<(), String> {
    self.count += 1;
    if self.count > MAX_ELEMENTS {
      return Err("too many elements".into());
    }
    Ok(())
  }

  fn name_of(&self, el: usize, fallback: &str) -> String {
    match self.attr(el, "id").map(str::trim).filter(|s| !s.is_empty()) {
      Some(id) => id.chars().take(MAX_NAME).collect(),
      None => fallback.to_string(),
    }
  }

  fn walk(&mut self, el: usize, m: &Mat, parent: &Style, out: &mut Vec<B>) -> Result<(), String> {
    self.count()?;
    let tag = self.xml.els[el].name.as_str();
    match tag {
      "g" | "a" | "svg" | "use" | "path" | "rect" | "circle" | "ellipse" | "line" | "polyline" | "polygon" => {}
      "text" | "tspan" | "textPath" => return Err("text".into()),
      "image" => return Err("an embedded image".into()),
      "switch" => return Err("a <switch> element".into()),
      // Defined for reference or not drawn at all.
      "defs" | "symbol" | "clipPath" | "linearGradient" | "radialGradient" | "stop" | "style" | "title" | "desc" | "metadata"
      | "script" | "foreignObject" | "filter" | "mask" | "pattern" | "marker" | "set" => return Ok(()),
      t if t.starts_with("animate") => return Ok(()),
      other => {
        let msg = format!("<{other}> is not supported and was left out");
        self.warn(&msg);
        return Ok(());
      }
    }
    let decl = self.declared(el);
    if decl.get("display").is_some_and(|v| v == "none") {
      return Ok(());
    }
    let refs = |k: &str| decl.get(k).is_some_and(|v| !v.is_empty() && v != "none");
    if refs("filter") {
      return Err("filters".into());
    }
    if refs("mask") {
      return Err("masks".into());
    }
    if refs("marker-start") || refs("marker-mid") || refs("marker-end") {
      return Err("markers".into());
    }
    let st = self.compute_style(parent, &decl);
    let opacity = opacity_of(&decl);
    let m2 = match self.attr(el, "transform") {
      None => *m,
      Some(t) => match parse_transform(t) {
        Some(tm) => m.mul(&tm),
        None => {
          self.warn("a transform that can't be read was ignored");
          *m
        }
      },
    };
    if !mat_ok(&m2) {
      // Collapsed to a line or a point: nothing is drawn.
      return Ok(());
    }
    let clip = self.clip_of(&decl, &m2)?;
    let name_fallback;
    let mut built: Vec<B> = Vec::new();
    let container;
    match tag {
      "g" | "a" | "svg" => {
        container = true;
        name_fallback = "Group";
        let mut m3 = m2;
        if tag == "svg" {
          let (x, y) = self.xy(el);
          m3 = m2.mul(&Mat::translate(x, y));
          if self.attr(el, "viewBox").is_some() {
            self.warn("the viewBox of a nested <svg> was ignored");
          }
        }
        for k in self.xml.els[el].kids.clone() {
          self.walk(k, &m3, &st, &mut built)?;
        }
      }
      "use" => {
        container = true;
        name_fallback = "Group";
        self.walk_use(el, &m2, &st, &mut built)?;
      }
      _ => {
        container = false;
        name_fallback = "";
        if !st.visible {
          return Ok(());
        }
        let name = self.name_of(el, "");
        let geom = self.geometry(el, tag)?;
        if let Some(b) = self.shape(geom, &m2, &st, opacity, &name)? {
          built.push(b);
        }
      }
    }
    if built.is_empty() {
      return Ok(());
    }
    let name = self.name_of(el, name_fallback);
    if container {
      let anonymous = self.attr(el, "id").is_none();
      match clip {
        Some(rect) => out.push(clip_frame(rect, &name, opacity, built)),
        None if anonymous && opacity >= 1.0 && built.len() == 1 => out.append(&mut built),
        None => {
          let mut g = ops::default_node(NodeType::Group, String::new(), name);
          g.opacity = opacity;
          out.push(B { node: g, kids: built });
        }
      }
    } else {
      match clip {
        Some(rect) => out.push(clip_frame(rect, &self.name_of(el, "Clip"), 1.0, built)),
        None => out.append(&mut built),
      }
    }
    Ok(())
  }

  fn xy(&self, el: usize) -> (f64, f64) {
    let (bw, bh) = self.vb_size;
    (
      self.attr(el, "x").and_then(|v| parse_length(v, bw)).unwrap_or(0.0),
      self.attr(el, "y").and_then(|v| parse_length(v, bh)).unwrap_or(0.0),
    )
  }

  fn walk_use(&mut self, el: usize, m: &Mat, st: &Style, out: &mut Vec<B>) -> Result<(), String> {
    let href = self.attr(el, "href").unwrap_or("").trim();
    let Some(id) = href.strip_prefix('#') else {
      self.warn("a <use> that points outside the document was left out");
      return Ok(());
    };
    let Some(&target) = self.ids.get(id) else {
      self.warn("a <use> of a missing element was left out");
      return Ok(());
    };
    if self.use_stack.contains(&target) || self.use_stack.len() >= MAX_USE_DEPTH {
      return Err("a <use> that repeats itself or nests too deeply".into());
    }
    let (x, y) = self.xy(el);
    let mut m2 = m.mul(&Mat::translate(x, y));
    self.use_stack.push(target);
    let res = if self.xml.els[target].name == "symbol" {
      // A symbol's viewBox maps onto the use's width and height when both are given.
      if let Some(b) = self
        .attr(target, "viewBox")
        .map(numbers)
        .filter(|v| v.len() == 4 && v[2] > 0.0 && v[3] > 0.0)
      {
        let (bw, bh) = self.vb_size;
        let w = self.attr(el, "width").and_then(|v| parse_length(v, bw));
        let h = self.attr(el, "height").and_then(|v| parse_length(v, bh));
        let par = self.attr(target, "preserveAspectRatio").unwrap_or("");
        m2 = match (w, h) {
          (Some(w), Some(h)) => m2.mul(&view_box_matrix([b[0], b[1], b[2], b[3]], w, h, par)),
          _ => m2.mul(&Mat::translate(-b[0], -b[1])),
        };
      }
      let mut r = Ok(());
      for k in self.xml.els[target].kids.clone() {
        r = self.walk(k, &m2, st, out);
        if r.is_err() {
          break;
        }
      }
      r
    } else {
      self.walk(target, &m2, st, out)
    };
    self.use_stack.pop();
    res
  }

  /// The clip rectangle (frame space) an element's `clip-path` asks for, or `None` when there is
  /// none or it only restates the frame's own clip.
  fn clip_of(&mut self, decl: &HashMap<String, String>, m: &Mat) -> Result<Option<(f64, f64, f64, f64)>, String> {
    const NOT_RECT: &str = "a clip path that isn't one rectangle";
    let Some(v) = decl.get("clip-path").map(|v| v.trim()).filter(|v| !v.is_empty() && *v != "none") else {
      return Ok(None);
    };
    let Some(inner) = v
      .strip_prefix("url(")
      .and_then(|r| r.split_once(')'))
      .map(|(a, _)| a.trim().trim_matches(['"', '\'']))
    else {
      return Err(NOT_RECT.into());
    };
    let Some(id) = inner.strip_prefix('#') else {
      self.warn("a clip path outside the document was ignored");
      return Ok(None);
    };
    let Some(&cp) = self.ids.get(id) else {
      self.warn("a missing clip path was ignored");
      return Ok(None);
    };
    if self.xml.els[cp].name != "clipPath" || self.attr(cp, "clipPathUnits") == Some("objectBoundingBox") {
      return Err(NOT_RECT.into());
    }
    let kids: Vec<usize> = self.xml.els[cp]
      .kids
      .iter()
      .copied()
      .filter(|k| !matches!(self.xml.els[*k].name.as_str(), "title" | "desc"))
      .collect();
    let [child] = kids[..] else { return Err(NOT_RECT.into()) };
    let mut cm = *m;
    for el in [cp, child] {
      if let Some(t) = self.attr(el, "transform") {
        cm = cm.mul(&parse_transform(t).ok_or(NOT_RECT)?);
      }
    }
    let (bw, bh) = self.vb_size;
    let corners: Vec<Point> = match self.xml.els[child].name.as_str() {
      "rect" => {
        let l = |n: &str, base: f64| self.attr(child, n).and_then(|v| parse_length(v, base)).unwrap_or(0.0);
        if l("rx", bw) > 0.0 || l("ry", bh) > 0.0 {
          return Err(NOT_RECT.into());
        }
        let (x, y, w, h) = (l("x", bw), l("y", bh), l("width", bw), l("height", bh));
        vec![
          Point::new(x, y),
          Point::new(x + w, y),
          Point::new(x + w, y + h),
          Point::new(x, y + h),
        ]
      }
      "path" => {
        let sps = paths::parse_svg_path(self.attr(child, "d").unwrap_or(""));
        match &sps[..] {
          [sp]
            if sp.closed
              && sp.points.len() == 4
              && sp
                .points
                .iter()
                .all(|p| p.in_x == 0.0 && p.in_y == 0.0 && p.out_x == 0.0 && p.out_y == 0.0) =>
          {
            sp.points.iter().map(|p| Point::new(p.x, p.y)).collect()
          }
          _ => return Err(NOT_RECT.into()),
        }
      }
      _ => return Err(NOT_RECT.into()),
    };
    let pts: Vec<Point> = corners.iter().map(|p| cm.apply(*p)).collect();
    // Edges must stay axis-aligned (no rotation or skew).
    for i in 0..4 {
      let (p, q) = (pts[i], pts[(i + 1) % 4]);
      if (p.x - q.x).abs() > 1e-6 && (p.y - q.y).abs() > 1e-6 {
        return Err(NOT_RECT.into());
      }
    }
    let x0 = pts.iter().map(|p| p.x).fold(f64::INFINITY, f64::min);
    let y0 = pts.iter().map(|p| p.y).fold(f64::INFINITY, f64::min);
    let x1 = pts.iter().map(|p| p.x).fold(f64::NEG_INFINITY, f64::max);
    let y1 = pts.iter().map(|p| p.y).fold(f64::NEG_INFINITY, f64::max);
    if !(x0.is_finite() && y0.is_finite() && x1.is_finite() && y1.is_finite()) || x1 - x0 < EPS || y1 - y0 < EPS {
      return Err(NOT_RECT.into());
    }
    if let Some((vx, vy, vw, vh)) = self.viewport {
      if x0 <= vx + 0.5 && y0 <= vy + 0.5 && x1 >= vx + vw - 0.5 && y1 >= vy + vh - 0.5 {
        return Ok(None);
      }
    }
    Ok(Some((x0, y0, x1 - x0, y1 - y0)))
  }

  fn geometry(&mut self, el: usize, tag: &str) -> Result<Geom, String> {
    let (bw, bh) = self.vb_size;
    let len = |cx: &Cx, n: &str, base: f64| cx.attr(el, n).and_then(|v| parse_length(v, base));
    let diag = ((bw * bw + bh * bh) / 2.0).sqrt();
    Ok(match tag {
      "path" => {
        let sps = paths::parse_svg_path(self.attr(el, "d").unwrap_or(""));
        self.points += sps.iter().map(|s| s.points.len()).sum::<usize>();
        if self.points > MAX_POINTS {
          return Err("too many path points".into());
        }
        Geom::Path(sps)
      }
      "rect" => {
        let (x, y) = (len(self, "x", bw).unwrap_or(0.0), len(self, "y", bh).unwrap_or(0.0));
        let (w, h) = (len(self, "width", bw).unwrap_or(0.0), len(self, "height", bh).unwrap_or(0.0));
        let (mut rx, mut ry) = (len(self, "rx", bw), len(self, "ry", bh));
        // One radius given stands for both; both are limited to half the side.
        if rx.is_none() {
          rx = ry.map(|_| 0.0);
        }
        if ry.is_none() {
          ry = rx;
        }
        if rx.is_some_and(|v| v < 0.0) {
          rx = None;
        }
        let (rx, ry) = match (rx, ry) {
          (Some(a), Some(b)) if a > 0.0 && b > 0.0 => (a.min(w / 2.0), b.min(h / 2.0)),
          (Some(a), None) | (None, Some(a)) if a > 0.0 => (a.min(w / 2.0), a.min(h / 2.0)),
          _ => (0.0, 0.0),
        };
        Geom::Rect { x, y, w, h, rx, ry }
      }
      "circle" => {
        let r = len(self, "r", diag).unwrap_or(0.0);
        Geom::Ellipse {
          cx: len(self, "cx", bw).unwrap_or(0.0),
          cy: len(self, "cy", bh).unwrap_or(0.0),
          rx: r,
          ry: r,
        }
      }
      "ellipse" => {
        let (rx, ry) = (len(self, "rx", bw), len(self, "ry", bh));
        let (rx, ry) = (rx.or(ry).unwrap_or(0.0), ry.or(rx).unwrap_or(0.0));
        Geom::Ellipse {
          cx: len(self, "cx", bw).unwrap_or(0.0),
          cy: len(self, "cy", bh).unwrap_or(0.0),
          rx,
          ry,
        }
      }
      "line" => {
        let (x1, y1) = (len(self, "x1", bw).unwrap_or(0.0), len(self, "y1", bh).unwrap_or(0.0));
        let (x2, y2) = (len(self, "x2", bw).unwrap_or(0.0), len(self, "y2", bh).unwrap_or(0.0));
        Geom::Path(vec![SubPath {
          points: vec![VectorPoint::at(x1, y1), VectorPoint::at(x2, y2)],
          closed: false,
        }])
      }
      _ => {
        // polyline, polygon
        let v = numbers(self.attr(el, "points").unwrap_or(""));
        let pts: Vec<VectorPoint> = v.chunks_exact(2).map(|c| VectorPoint::at(c[0], c[1])).collect();
        self.points += pts.len();
        if self.points > MAX_POINTS {
          return Err("too many path points".into());
        }
        if pts.len() < 2 {
          Geom::Path(Vec::new())
        } else {
          Geom::Path(vec![SubPath {
            points: pts,
            closed: tag == "polygon",
          }])
        }
      }
    })
  }

  /// One shape as a layer: a Rectangle or Ellipse when only translated and scaled, else a Vector.
  fn shape(&mut self, geom: Geom, m: &Mat, st: &Style, opacity: f64, name: &str) -> Result<Option<B>, String> {
    let straight = m.b.abs() < EPS && m.c.abs() < EPS && m.a > 0.0 && m.d > 0.0;
    let k = (m.a * m.d - m.b * m.c).abs().sqrt();
    let finite = |v: &[f64]| v.iter().all(|x| x.is_finite() && x.abs() <= MAX_COORD);
    // (kind, user-space bbox, built node)
    let (mut node, bbox, subs): (Node, (f64, f64, f64, f64), Vec<SubPath>) = match geom {
      Geom::Rect { x, y, w, h, rx, ry } => {
        if w <= 0.0 || h <= 0.0 || !finite(&[x, y, w, h, rx, ry]) {
          return Ok(None);
        }
        let radii_equal = (rx * m.a - ry * m.d).abs() < 1e-6;
        if straight && radii_equal {
          let mut n = ops::default_node(NodeType::Rectangle, String::new(), non_empty(name, "Rectangle"));
          n.x = m.a * x + m.e;
          n.y = m.d * y + m.f;
          n.width = m.a * w;
          n.height = m.d * h;
          n.corner_radius = rx * m.a;
          (n, (x, y, w, h), Vec::new())
        } else {
          let sps = paths::parse_svg_path(&rect_d(x, y, w, h, rx, ry));
          (vector_node(name), (x, y, w, h), sps)
        }
      }
      Geom::Ellipse { cx, cy, rx, ry } => {
        if rx <= 0.0 || ry <= 0.0 || !finite(&[cx, cy, rx, ry]) {
          return Ok(None);
        }
        let bbox = (cx - rx, cy - ry, 2.0 * rx, 2.0 * ry);
        if straight {
          let mut n = ops::default_node(NodeType::Ellipse, String::new(), non_empty(name, "Ellipse"));
          n.x = m.a * bbox.0 + m.e;
          n.y = m.d * bbox.1 + m.f;
          n.width = m.a * bbox.2;
          n.height = m.d * bbox.3;
          (n, bbox, Vec::new())
        } else {
          let d = format!(
            "M{} {}a{rx} {ry} 0 1 0 {} 0a{rx} {ry} 0 1 0 {} 0z",
            cx - rx,
            cy,
            2.0 * rx,
            -2.0 * rx
          );
          (vector_node(name), bbox, paths::parse_svg_path(&d))
        }
      }
      Geom::Path(sps) => {
        let Some(b) = vector_edit::path_bounds(&sps) else { return Ok(None) };
        let all: Vec<f64> = sps
          .iter()
          .flat_map(|s| s.points.iter().flat_map(|p| [p.x, p.y, p.in_x, p.in_y, p.out_x, p.out_y]))
          .collect();
        if !finite(&all) {
          return Err("coordinates that are out of range".into());
        }
        (vector_node(name), (b.0, b.1, b.2 - b.0, b.3 - b.1), sps)
      }
    };
    let is_vector = node.kind == NodeType::Vector;
    // Outline in frame space, for a vector.
    let mut subs: Vec<SubPath> = subs.iter().map(|s| paths::transform(s, m)).collect();
    if is_vector {
      if subs.is_empty() {
        return Ok(None);
      }
      let all: Vec<f64> = subs
        .iter()
        .flat_map(|s| s.points.iter().flat_map(|p| [p.x, p.y, p.in_x, p.in_y, p.out_x, p.out_y]))
        .collect();
      if !finite(&all) {
        return Err("coordinates that are out of range".into());
      }
      let fills = !matches!(st.fill, SvgPaint::None);
      if st.evenodd && fills && subs.len() > 1 {
        if subs.len() <= EVENODD_MAX_SUBPATHS {
          reorient_evenodd(&mut subs);
        } else {
          self.warn("a path with many holes was not adjusted, its holes may fill in");
        }
      }
      let Some((x0, y0, x1, y1)) = vector_edit::path_bounds(&subs) else {
        return Ok(None);
      };
      let (w, h) = ((x1 - x0).max(1.0), (y1 - y0).max(1.0));
      for sp in subs.iter_mut() {
        for p in sp.points.iter_mut() {
          p.x -= x0;
          p.y -= y0;
        }
      }
      node.x = x0;
      node.y = y0;
      node.width = w;
      node.height = h;
    }
    let nbox = (node.x, node.y, node.width, node.height);
    // Paints.
    let mut fills = Vec::new();
    if let Some(p) = self.paint(&st.fill, st.fill_opacity, st, m, bbox, nbox)? {
      fills.push(p);
    }
    let mut strokes = Vec::new();
    if st.stroke_width > 0.0 {
      if let Some(p) = self.paint(&st.stroke, st.stroke_opacity, st, m, bbox, nbox)? {
        strokes.push(p);
      }
    }
    if fills.is_empty() && strokes.is_empty() {
      return Ok(None);
    }
    node.fills = fills;
    node.strokes = strokes;
    node.stroke_weight = st.stroke_width * k;
    node.stroke_align = StrokeAlign::Center;
    node.stroke_join = Some(st.join);
    node.stroke_dash = dash_of(&st.dash, k);
    node.opacity = opacity;
    if is_vector {
      let open = subs.iter().any(|s| !s.closed);
      if open && !node.strokes.is_empty() {
        let end_cap = match st.cap {
          Cap::Round => StrokeCap::Round,
          Cap::Square => StrokeCap::Square,
          Cap::Butt => {
            self.warn("flat line ends are drawn round");
            StrokeCap::None
          }
        };
        node.shape = Some(ShapeProps {
          end_cap,
          ..Default::default()
        });
      }
      node.vector = Some(VectorData { subpaths: subs, raw: None });
    }
    Ok(Some(B { node, kids: Vec::new() }))
  }

  /// A fill or stroke as a paint; `None` for no paint (or one that can't be drawn).
  fn paint(
    &mut self,
    p: &SvgPaint,
    opacity: f64,
    st: &Style,
    m: &Mat,
    bbox: (f64, f64, f64, f64),
    nbox: (f64, f64, f64, f64),
  ) -> Result<Option<Paint>, String> {
    let solid = |c: Rgba| {
      Some(Paint::Solid {
        color: c.hex6(),
        opacity: (opacity * c.a).clamp(0.0, 1.0),
        visible: true,
      })
    };
    Ok(match p {
      SvgPaint::None => None,
      SvgPaint::Current => solid(st.color),
      SvgPaint::Color(c) => solid(*c),
      SvgPaint::Url(id, fallback) => match self.ids.get(id).copied() {
        Some(g) if matches!(self.xml.els[g].name.as_str(), "linearGradient" | "radialGradient") => {
          self.gradient(g, opacity, st, m, bbox, nbox)?
        }
        Some(g) if self.xml.els[g].name == "pattern" => return Err("patterns".into()),
        _ => fallback.and_then(solid),
      },
    })
  }

  /// Attribute of a gradient, following `href` to the gradients it builds on.
  fn grad_attr(&self, mut el: usize, name: &str) -> Option<&'a str> {
    for _ in 0..MAX_USE_DEPTH {
      if let Some(v) = self.attr(el, name) {
        return Some(v);
      }
      el = self.href_gradient(el)?;
    }
    None
  }

  fn href_gradient(&self, el: usize) -> Option<usize> {
    let id = self.attr(el, "href")?.trim().strip_prefix('#')?;
    let t = *self.ids.get(id)?;
    matches!(self.xml.els[t].name.as_str(), "linearGradient" | "radialGradient").then_some(t)
  }

  fn gradient(
    &mut self,
    g: usize,
    opacity: f64,
    st: &Style,
    m: &Mat,
    bbox: (f64, f64, f64, f64),
    nbox: (f64, f64, f64, f64),
  ) -> Result<Option<Paint>, String> {
    if self.grad_attr(g, "spreadMethod").is_some_and(|v| v.trim() != "pad") {
      return Err("a gradient that repeats or reflects".into());
    }
    // Stops come from the first gradient in the href chain that has any.
    let mut holder = g;
    let mut stops_el: Vec<usize> = Vec::new();
    for _ in 0..MAX_USE_DEPTH {
      stops_el = self.xml.els[holder]
        .kids
        .iter()
        .copied()
        .filter(|k| self.xml.els[*k].name == "stop")
        .collect();
      if !stops_el.is_empty() {
        break;
      }
      match self.href_gradient(holder) {
        Some(n) => holder = n,
        None => break,
      }
    }
    let mut stops: Vec<GradientStop> = Vec::new();
    let mut last = 0.0_f64;
    for s in stops_el {
      let decl = self.declared(s);
      let off = self
        .attr(s, "offset")
        .and_then(|v| {
          let v = v.trim();
          match v.strip_suffix('%') {
            Some(p) => p.trim().parse::<f64>().ok().map(|x| x / 100.0),
            None => v.parse::<f64>().ok(),
          }
        })
        .unwrap_or(0.0)
        .clamp(0.0, 1.0)
        .max(last);
      last = off;
      let c = match decl.get("stop-color").map(|v| v.trim()) {
        Some(v) if v.eq_ignore_ascii_case("currentcolor") => st.color,
        Some(v) => color::parse(v).unwrap_or(Rgba::BLACK),
        None => Rgba::BLACK,
      };
      let so = decl.get("stop-opacity").and_then(|v| parse_opacity(v)).unwrap_or(1.0);
      stops.push(GradientStop {
        color: c.with_alpha(so).hex(),
        position: off,
      });
    }
    match stops.len() {
      0 => return Ok(None),
      1 => {
        let c = color::parse(&stops[0].color).unwrap_or(Rgba::BLACK);
        return Ok(Some(Paint::Solid {
          color: c.hex6(),
          opacity: (opacity * c.a).clamp(0.0, 1.0),
          visible: true,
        }));
      }
      _ => {}
    }
    let bbox_units = self.grad_attr(g, "gradientUnits").map(str::trim) != Some("userSpaceOnUse");
    let (bx, by, bw, bh) = bbox;
    if bbox_units && (bw < EPS || bh < EPS) {
      // A bounding box with no area has no gradient (SVG leaves the element unpainted).
      return Ok(None);
    }
    let gt = match self.grad_attr(g, "gradientTransform") {
      Some(t) => parse_transform(t).unwrap_or(Mat::IDENTITY),
      None => Mat::IDENTITY,
    };
    let unit = if bbox_units {
      Mat {
        a: bw,
        d: bh,
        e: bx,
        f: by,
        ..Mat::IDENTITY
      }
    } else {
      Mat::IDENTITY
    };
    let full = m.mul(&unit).mul(&gt);
    let (nx, ny, nw, nh) = nbox;
    let to_unit = |p: Point| -> [f64; 2] {
      let a = full.apply(p);
      [(a.x - nx) / nw, (a.y - ny) / nh]
    };
    // Lengths: a plain number or a percentage (of the bbox, which is 0..1, or of the viewBox).
    let (vw, vh) = self.vb_size;
    let coord = |cx: &Cx, name: &str, default: f64, vert: bool| -> f64 {
      let Some(v) = cx.grad_attr(g, name) else { return default };
      let v = v.trim();
      if let Some(p) = v.strip_suffix('%') {
        let f = p.trim().parse::<f64>().unwrap_or(default * 100.0) / 100.0;
        return if bbox_units { f } else { f * if vert { vh } else { vw } };
      }
      parse_length(v, 0.0).unwrap_or(default)
    };
    let is_linear = self.xml.els[g].name == "linearGradient";
    let handles = if is_linear {
      let (x1, y1) = (coord(self, "x1", 0.0, false), coord(self, "y1", 0.0, true));
      let (x2, y2) = (
        coord(self, "x2", if bbox_units { 1.0 } else { vw }, false),
        coord(self, "y2", 0.0, true),
      );
      if (x1 - x2).abs() < EPS && (y1 - y2).abs() < EPS {
        // No direction: the last stop fills.
        let c = color::parse(&stops[stops.len() - 1].color).unwrap_or(Rgba::BLACK);
        return Ok(Some(Paint::Solid {
          color: c.hex6(),
          opacity: (opacity * c.a).clamp(0.0, 1.0),
          visible: true,
        }));
      }
      let (s, e) = (to_unit(Point::new(x1, y1)), to_unit(Point::new(x2, y2)));
      GradientHandles {
        start: s,
        end: e,
        width: s,
      }
    } else {
      let half = if bbox_units { 0.5 } else { 0.5 * vw };
      let halfy = if bbox_units { 0.5 } else { 0.5 * vh };
      let (cx, cy) = (coord(self, "cx", half, false), coord(self, "cy", halfy, true));
      let r = coord(self, "r", if bbox_units { 0.5 } else { 0.5 * (vw + vh) / 2.0 }, false);
      if r <= 0.0 {
        let c = color::parse(&stops[stops.len() - 1].color).unwrap_or(Rgba::BLACK);
        return Ok(Some(Paint::Solid {
          color: c.hex6(),
          opacity: (opacity * c.a).clamp(0.0, 1.0),
          visible: true,
        }));
      }
      if self.grad_attr(g, "fx").is_some() || self.grad_attr(g, "fy").is_some() {
        self.warn("the focal point of a radial gradient was ignored");
      }
      GradientHandles {
        start: to_unit(Point::new(cx, cy)),
        end: to_unit(Point::new(cx + r, cy)),
        width: to_unit(Point::new(cx, cy + r)),
      }
    };
    Ok(Some(if is_linear {
      Paint::LinearGradient {
        stops,
        angle: 180.0,
        opacity,
        visible: true,
        handles: Some(handles),
      }
    } else {
      Paint::RadialGradient {
        stops,
        opacity,
        visible: true,
        handles: Some(handles),
      }
    }))
  }
}

fn vector_node(name: &str) -> Node {
  let mut n = ops::default_node(NodeType::Vector, String::new(), non_empty(name, "Vector"));
  n.fills.clear();
  n.strokes.clear();
  n
}

fn non_empty(name: &str, fallback: &str) -> String {
  if name.is_empty() {
    fallback.into()
  } else {
    name.into()
  }
}

fn clip_frame(rect: (f64, f64, f64, f64), name: &str, opacity: f64, kids: Vec<B>) -> B {
  let mut f = ops::default_node(NodeType::Frame, String::new(), name.to_string());
  f.fills.clear();
  f.clip_content = true;
  f.x = rect.0;
  f.y = rect.1;
  f.width = rect.2;
  f.height = rect.3;
  f.opacity = opacity;
  B { node: f, kids }
}

/// Dash lengths scaled with the stroke; an odd list repeats, as SVG says.
fn dash_of(d: &[f64], k: f64) -> Vec<f64> {
  if d.is_empty() {
    return Vec::new();
  }
  let mut v: Vec<f64> = d.iter().map(|x| x * k).collect();
  if v.len() % 2 == 1 {
    v.extend(v.clone());
  }
  v
}

fn mat_ok(m: &Mat) -> bool {
  [m.a, m.b, m.c, m.d, m.e, m.f].iter().all(|v| v.is_finite()) && (m.a * m.d - m.b * m.c).abs() > 1e-12
}

/// A rounded rectangle as path data (elliptical corners as arcs).
fn rect_d(x: f64, y: f64, w: f64, h: f64, rx: f64, ry: f64) -> String {
  if rx <= 0.0 || ry <= 0.0 {
    return format!("M{x} {y}h{w}v{h}h{}z", -w);
  }
  format!(
    "M{} {y}h{}a{rx} {ry} 0 0 1 {rx} {ry}v{}a{rx} {ry} 0 0 1 {} {ry}h{}a{rx} {ry} 0 0 1 {} {}v{}a{rx} {ry} 0 0 1 {rx} {}z",
    x + rx,
    w - 2.0 * rx,
    h - 2.0 * ry,
    -rx,
    -(w - 2.0 * rx),
    -rx,
    -ry,
    -(h - 2.0 * ry),
    -ry
  )
}

// ------------------------------------------------------------------ layers

/// Groups take the box of their children (the engine does the same when it lays them out).
fn fix_groups(b: &mut B) {
  for k in b.kids.iter_mut() {
    fix_groups(k);
  }
  if b.node.kind == NodeType::Group {
    let mut it = b
      .kids
      .iter()
      .map(|k| (k.node.x, k.node.y, k.node.x + k.node.width, k.node.y + k.node.height));
    if let Some(first) = it.next() {
      let (x0, y0, x1, y1) = it.fold(first, |a, c| (a.0.min(c.0), a.1.min(c.1), a.2.max(c.2), a.3.max(c.3)));
      b.node.x = x0;
      b.node.y = y0;
      b.node.width = (x1 - x0).max(1.0);
      b.node.height = (y1 - y0).max(1.0);
    }
  }
}

/// Pre-order list with fresh ids and positions relative to the parent.
fn flatten(b: B, parent: Option<&str>, parent_abs: (f64, f64), ids: &mut IdGen, out: &mut Vec<Node>) -> String {
  let mut node = b.node;
  node.id = ids.next("n_");
  node.parent = parent.map(String::from);
  let abs = (node.x, node.y);
  node.x -= parent_abs.0;
  node.y -= parent_abs.1;
  let id = node.id.clone();
  let at = out.len();
  out.push(node);
  let kids: Vec<String> = b.kids.into_iter().map(|k| flatten(k, Some(&id), abs, ids, out)).collect();
  out[at].children = kids;
  id
}

// ------------------------------------------------------------------ evenodd

/// Rewinds subpaths so that the nonzero rule (what layers use) paints what evenodd would: a
/// subpath inside an even number of others runs clockwise, one inside an odd number the other
/// way. Exact for nested shapes (icons with holes); self-intersections can't be fixed.
fn reorient_evenodd(subs: &mut [SubPath]) {
  let polys: Vec<Vec<Point>> = subs.iter().map(shapes::flatten_subpath).collect();
  let boxes: Vec<(f64, f64, f64, f64)> = polys
    .iter()
    .map(|p| {
      p.iter()
        .fold((f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY), |a, q| {
          (a.0.min(q.x), a.1.min(q.y), a.2.max(q.x), a.3.max(q.y))
        })
    })
    .collect();
  for i in 0..subs.len() {
    if polys[i].len() < 3 {
      continue;
    }
    // A point on the first segment's curve, away from corners shared with neighbours.
    let probe = polys[i][polys[i].len().min(7) - 1];
    let mut depth = 0;
    for j in 0..subs.len() {
      if i == j || polys[j].len() < 3 {
        continue;
      }
      let b = boxes[j];
      if probe.x < b.0 || probe.x > b.2 || probe.y < b.1 || probe.y > b.3 {
        continue;
      }
      if inside(&polys[j], probe) {
        depth += 1;
      }
    }
    let want_positive = depth % 2 == 0;
    let area = signed_area(&polys[i]);
    if area.abs() > EPS && (area > 0.0) != want_positive {
      reverse(&mut subs[i]);
    }
  }
}

fn inside(poly: &[Point], p: Point) -> bool {
  let mut c = false;
  let mut j = poly.len() - 1;
  for i in 0..poly.len() {
    let (a, b) = (poly[i], poly[j]);
    if (a.y > p.y) != (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x {
      c = !c;
    }
    j = i;
  }
  c
}

fn signed_area(poly: &[Point]) -> f64 {
  let mut a = 0.0;
  for i in 0..poly.len() {
    let (p, q) = (poly[i], poly[(i + 1) % poly.len()]);
    a += p.x * q.y - q.x * p.y;
  }
  a / 2.0
}

fn reverse(sp: &mut SubPath) {
  sp.points.reverse();
  for p in sp.points.iter_mut() {
    std::mem::swap(&mut p.in_x, &mut p.out_x);
    std::mem::swap(&mut p.in_y, &mut p.out_y);
  }
}

// ------------------------------------------------------------------ numbers and transforms

/// The next number at `*i` (SVG syntax: `1.5.5` is two numbers, `1e3` has an exponent).
fn read_number(b: &[u8], i: &mut usize) -> Option<f64> {
  let start = *i;
  let mut j = *i;
  if j < b.len() && (b[j] == b'+' || b[j] == b'-') {
    j += 1;
  }
  let mut digits = 0;
  while j < b.len() && b[j].is_ascii_digit() {
    j += 1;
    digits += 1;
  }
  if j < b.len() && b[j] == b'.' {
    j += 1;
    while j < b.len() && b[j].is_ascii_digit() {
      j += 1;
      digits += 1;
    }
  }
  if digits == 0 {
    return None;
  }
  if j < b.len() && (b[j] == b'e' || b[j] == b'E') {
    let mut k = j + 1;
    if k < b.len() && (b[k] == b'+' || b[k] == b'-') {
      k += 1;
    }
    if k < b.len() && b[k].is_ascii_digit() {
      while k < b.len() && b[k].is_ascii_digit() {
        k += 1;
      }
      j = k;
    }
  }
  *i = j;
  std::str::from_utf8(&b[start..j]).ok()?.parse().ok()
}

/// Every number in a list like `0 0 24 24` or `1,2 3-4`.
fn numbers(s: &str) -> Vec<f64> {
  let b = s.as_bytes();
  let mut out = Vec::new();
  let mut i = 0;
  while i < b.len() {
    match read_number(b, &mut i) {
      Some(v) => out.push(v),
      None => i += 1,
    }
  }
  out
}

/// `12`, `12px`, `1.5em`, `50%` (of `pct_base`) in user units.
fn parse_length(s: &str, pct_base: f64) -> Option<f64> {
  let s = s.trim();
  let b = s.as_bytes();
  let mut i = 0;
  let v = read_number(b, &mut i)?;
  let unit = s[i..].trim();
  let k = match unit {
    "" | "px" => 1.0,
    "pt" => 4.0 / 3.0,
    "pc" => 16.0,
    "mm" => 96.0 / 25.4,
    "cm" => 96.0 / 2.54,
    "in" => 96.0,
    "em" | "rem" => 16.0,
    "ex" => 8.0,
    "%" => pct_base / 100.0,
    _ => return None,
  };
  let r = v * k;
  r.is_finite().then_some(r)
}

/// A `transform` attribute; `None` when it can't be read.
fn parse_transform(s: &str) -> Option<Mat> {
  let mut m = Mat::IDENTITY;
  let mut rest = s.trim();
  while !rest.is_empty() {
    let open = rest.find('(')?;
    let name = rest[..open].trim().trim_start_matches(',').trim();
    let close = rest[open..].find(')')? + open;
    let a = numbers(&rest[open + 1..close]);
    let t = match (name, a.len()) {
      ("matrix", 6) => Mat {
        a: a[0],
        b: a[1],
        c: a[2],
        d: a[3],
        e: a[4],
        f: a[5],
      },
      ("translate", 1) => Mat::translate(a[0], 0.0),
      ("translate", 2) => Mat::translate(a[0], a[1]),
      ("scale", 1) => Mat::scale(a[0], a[0]),
      ("scale", 2) => Mat::scale(a[0], a[1]),
      ("rotate", 1) => Mat::rotate_deg(a[0]),
      ("rotate", 3) => Mat::translate(a[1], a[2])
        .mul(&Mat::rotate_deg(a[0]))
        .mul(&Mat::translate(-a[1], -a[2])),
      ("skewX", 1) => Mat {
        c: a[0].to_radians().tan(),
        ..Mat::IDENTITY
      },
      ("skewY", 1) => Mat {
        b: a[0].to_radians().tan(),
        ..Mat::IDENTITY
      },
      _ => return None,
    };
    m = m.mul(&t);
    rest = rest[close + 1..].trim_start_matches([',', ' ', '\t', '\n', '\r']);
  }
  [m.a, m.b, m.c, m.d, m.e, m.f].iter().all(|v| v.is_finite()).then_some(m)
}

/// Maps a viewBox onto a `w × h` viewport (`preserveAspectRatio`, default xMidYMid meet).
fn view_box_matrix(b: [f64; 4], w: f64, h: f64, par: &str) -> Mat {
  let mut parts = par.split_whitespace().filter(|p| *p != "defer");
  let align = parts.next().unwrap_or("xMidYMid");
  let slice = parts.next() == Some("slice");
  let (sx, sy) = (w / b[2], h / b[3]);
  if align == "none" {
    return Mat {
      a: sx,
      d: sy,
      e: -b[0] * sx,
      f: -b[1] * sy,
      ..Mat::IDENTITY
    };
  }
  let s = if slice { sx.max(sy) } else { sx.min(sy) };
  let fx = if align.starts_with("xMin") {
    0.0
  } else if align.starts_with("xMax") {
    1.0
  } else {
    0.5
  };
  let fy = if align.ends_with("YMin") {
    0.0
  } else if align.ends_with("YMax") {
    1.0
  } else {
    0.5
  };
  Mat {
    a: s,
    d: s,
    e: (w - b[2] * s) * fx - b[0] * s,
    f: (h - b[3] * s) * fy - b[1] * s,
    ..Mat::IDENTITY
  }
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
  use super::*;

  fn run(svg: &str) -> Result<Imported, String> {
    import(svg, &mut IdGen::new(7), &Options::default())
  }

  fn ok(svg: &str) -> Imported {
    run(svg).unwrap_or_else(|e| panic!("refused: {e}"))
  }

  fn kids<'a>(i: &'a Imported, n: &Node) -> Vec<&'a Node> {
    n.children.iter().map(|c| i.nodes.iter().find(|x| x.id == *c).unwrap()).collect()
  }

  fn solid(p: &Paint) -> (String, f64) {
    match p {
      Paint::Solid { color, opacity, .. } => (color.clone(), *opacity),
      other => panic!("not solid: {other:?}"),
    }
  }

  const LUCIDE_SETTINGS: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-settings"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>"#;

  mod xml {
    use super::*;

    #[test]
    fn reads_both_quotes_entities_comments_cdata_and_self_closing() {
      let i = ok(
        r#"<?xml version="1.0"?><!-- hi --><svg viewBox='0 0 10 10' width="10" height="10"><style><![CDATA[.a{fill:#f00}]]></style>
        <rect class="a" width='5' height="5" id="a&amp;b&#x31;"/></svg>"#,
      );
      let r = &i.nodes[1];
      assert_eq!(r.kind, NodeType::Rectangle);
      assert_eq!(r.name, "a&b1");
      assert_eq!(solid(&r.fills[0]).0, "#FF0000");
    }

    #[test]
    fn a_doctype_with_entities_is_refused() {
      let evil = r#"<!DOCTYPE svg [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;">]><svg width="1" height="1"><rect width="1" height="1" id="&b;"/></svg>"#;
      assert!(run(evil).is_err());
      let ext = r#"<!DOCTYPE svg SYSTEM "http://example.com/x.dtd"><svg width="4" height="4"><rect width="4" height="4"/></svg>"#;
      assert!(run(ext).is_ok(), "a plain DOCTYPE is skipped and never fetched");
      assert!(run(r#"<svg width="4" height="4"><rect width="4" height="4" id="&nbsp;"/></svg>"#).is_err());
      assert!(run(r#"<!ENTITY x "y"><svg width="4" height="4"><rect width="4" height="4"/></svg>"#).is_err());
    }

    #[test]
    fn limits_refuse_instead_of_growing() {
      let big = format!(
        r#"<svg width="9" height="9"><path d="{}"/></svg>"#,
        "M0 0L1 1".repeat(MAX_BYTES / 8 + 10)
      );
      assert!(run(&big).unwrap_err().contains("2 MB"));
      let many = format!(
        r#"<svg width="9" height="9">{}</svg>"#,
        "<rect width='1' height='1'/>".repeat(MAX_ELEMENTS + 1)
      );
      assert!(run(&many).unwrap_err().contains("too many elements"));
      let deep = format!(
        r#"<svg width="9" height="9">{}<rect width="1" height="1"/>{}</svg>"#,
        "<g>".repeat(MAX_DEPTH + 1),
        "</g>".repeat(MAX_DEPTH + 1)
      );
      assert!(run(&deep).unwrap_err().contains("nested"));
      let points = format!(
        r#"<svg width="9" height="9"><path d="M0 0{}"/></svg>"#,
        "l1 1".repeat(MAX_POINTS + 5)
      );
      assert!(run(&points).unwrap_err().contains("points"));
    }

    #[test]
    fn a_recursive_use_is_refused() {
      let s =
        r##"<svg width="9" height="9"><defs><g id="a"><use href="#b"/></g><g id="b"><use href="#a"/></g></defs><use href="#a"/></svg>"##;
      assert!(run(s).unwrap_err().contains("<use>"));
      // A chain deeper than the limit is refused too, and a `use` fan-out hits the element budget.
      let mut chain = String::from(r##"<svg width="9" height="9"><defs><rect id="u0" width="1" height="1"/>"##);
      for n in 1..=MAX_USE_DEPTH + 2 {
        chain.push_str(&format!(r##"<g id="u{n}"><use href="#u{}"/></g>"##, n - 1));
      }
      chain.push_str(&format!(r##"</defs><use href="#u{}"/></svg>"##, MAX_USE_DEPTH + 2));
      assert!(run(&chain).is_err());
      let mut bomb = String::from(r##"<svg width="9" height="9"><defs><rect id="l0" width="1" height="1"/>"##);
      for n in 1..=6 {
        bomb.push_str(&format!(
          r##"<g id="l{n}">{}</g>"##,
          format!(r##"<use href="#l{}"/>"##, n - 1).repeat(12)
        ));
      }
      bomb.push_str(r##"</defs><use href="#l6"/></svg>"##);
      assert!(run(&bomb).is_err(), "12^6 expansions exceed the element budget");
    }
  }

  mod fidelity {
    use super::*;

    #[test]
    fn a_stroked_icon_keeps_its_stroke_settings() {
      let i = ok(LUCIDE_SETTINGS);
      let frame = &i.nodes[0];
      assert_eq!((frame.kind, frame.width, frame.height), (NodeType::Frame, 24.0, 24.0));
      assert!(frame.fills.is_empty() && frame.clip_content);
      let k = kids(&i, frame);
      assert_eq!(k.len(), 2);
      let path = k[0];
      assert_eq!(path.kind, NodeType::Vector);
      assert!(path.fills.is_empty());
      assert_eq!(solid(&path.strokes[0]).0, "#000000");
      assert_eq!(path.stroke_weight, 2.0);
      assert_eq!(path.stroke_join, Some(StrokeJoin::Round));
      assert!(!path.vector.as_ref().unwrap().subpaths.is_empty());
      // The circle with r=3 is an ellipse of 6x6 at (9, 9).
      let c = k[1];
      assert_eq!((c.kind, c.x, c.y, c.width, c.height), (NodeType::Ellipse, 9.0, 9.0, 6.0, 6.0));
      assert_eq!(c.stroke_weight, 2.0);
    }

    #[test]
    fn scaling_the_frame_scales_the_stroke() {
      let i = import(
        LUCIDE_SETTINGS,
        &mut IdGen::new(1),
        &Options {
          width: Some(48.0),
          height: Some(48.0),
          name: Some("settings".into()),
        },
      )
      .unwrap();
      assert_eq!((i.nodes[0].width, i.nodes[0].name.as_str()), (48.0, "settings"));
      assert_eq!(kids(&i, &i.nodes[0])[0].stroke_weight, 4.0);
      let one = import(
        LUCIDE_SETTINGS,
        &mut IdGen::new(1),
        &Options {
          width: Some(48.0),
          ..Default::default()
        },
      )
      .unwrap();
      assert_eq!(one.nodes[0].height, 48.0);
    }

    #[test]
    fn a_filled_icon_with_evenodd_holes_gets_opposite_windings() {
      // Two circles with the same winding, evenodd: a donut.
      let i = ok(
        r#"<svg viewBox="0 0 24 24" width="24" height="24"><path fill-rule="evenodd" clip-rule="evenodd" d="M12 2a10 10 0 1 1 0 20a10 10 0 1 1 0-20zM12 6a6 6 0 1 1 0 12a6 6 0 1 1 0-12z"/></svg>"#,
      );
      let v = kids(&i, &i.nodes[0])[0];
      let sps = &v.vector.as_ref().unwrap().subpaths;
      assert_eq!(sps.len(), 2);
      let area = |s: &SubPath| signed_area(&shapes::flatten_subpath(s));
      assert!(area(&sps[0]) * area(&sps[1]) < 0.0, "outer and hole run opposite ways");
      assert_eq!(solid(&v.fills[0]).0, "#000000");
    }

    #[test]
    fn an_island_in_a_hole_is_filled_again() {
      let sq = |x: f64, s: f64| format!("M{x} {x}h{s}v{s}h-{s}z");
      let d = format!("{}{}{}", sq(0.0, 30.0), sq(5.0, 20.0), sq(10.0, 10.0));
      let i = ok(&format!(
        r#"<svg viewBox="0 0 30 30" width="30" height="30"><path fill-rule="evenodd" d="{d}"/></svg>"#
      ));
      let sps = &kids(&i, &i.nodes[0])[0].vector.as_ref().unwrap().subpaths;
      let s: Vec<f64> = sps.iter().map(|p| signed_area(&shapes::flatten_subpath(p)).signum()).collect();
      assert_eq!(s[0], s[2]);
      assert_eq!(s[0], -s[1]);
    }

    #[test]
    fn a_figma_export_drops_the_viewport_clip() {
      let i = ok(
        r##"<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><g clip-path="url(#clip0_1_2)"><path d="M12 2L2 22H22L12 2Z" fill="#1E1E1E"/></g><defs><clipPath id="clip0_1_2"><rect width="24" height="24" fill="white"/></clipPath></defs></svg>"##,
      );
      assert_eq!(i.nodes.len(), 2, "frame + path, no extra frame or group");
      assert_eq!(i.nodes[1].kind, NodeType::Vector);
      assert_eq!(solid(&i.nodes[1].fills[0]).0, "#1E1E1E");
    }

    #[test]
    fn another_rectangle_clip_becomes_a_clipping_frame() {
      let i = ok(
        r##"<svg width="24" height="24" viewBox="0 0 24 24"><g clip-path="url(#c)"><rect width="30" height="30"/></g><defs><clipPath id="c"><rect x="4" y="4" width="10" height="10"/></clipPath></defs></svg>"##,
      );
      let f = &i.nodes[1];
      assert_eq!(
        (f.kind, f.x, f.y, f.width, f.height, f.clip_content),
        (NodeType::Frame, 4.0, 4.0, 10.0, 10.0, true)
      );
      let r = &i.nodes[2];
      assert_eq!((r.kind, r.x, r.y), (NodeType::Rectangle, -4.0, -4.0), "relative to the clip frame");
      assert!(run(r##"<svg width="9" height="9"><g clip-path="url(#c)"><rect width="3" height="3"/></g><clipPath id="c"><circle r="3"/></clipPath></svg>"##).is_err());
    }

    #[test]
    fn rectangles_rotations_and_circles() {
      let i = ok(
        r#"<svg width="40" height="40"><rect x="2" y="3" width="10" height="8" rx="4"/><rect x="0" y="0" width="10" height="10" transform="rotate(90 5 5)"/><circle cx="20" cy="20" r="5"/></svg>"#,
      );
      let k = kids(&i, &i.nodes[0]);
      assert_eq!(
        (k[0].kind, k[0].corner_radius, k[0].x, k[0].width),
        (NodeType::Rectangle, 4.0, 2.0, 10.0)
      );
      // rx larger than half a side is limited, like a browser does.
      assert_eq!(k[1].kind, NodeType::Vector);
      let pts: Vec<(f64, f64)> = k[1].vector.as_ref().unwrap().subpaths[0]
        .points
        .iter()
        .map(|p| (p.x + k[1].x, p.y + k[1].y))
        .collect();
      // A 90 degree turn about the centre maps the square onto itself; every corner is a corner.
      for c in [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)] {
        assert!(pts.iter().any(|p| (p.0 - c.0).abs() < 1e-6 && (p.1 - c.1).abs() < 1e-6), "{pts:?}");
      }
      assert_eq!((k[2].kind, k[2].x, k[2].width), (NodeType::Ellipse, 15.0, 10.0));
      let rot = ok(r#"<svg width="40" height="40"><rect x="10" y="0" width="10" height="4" transform="rotate(30)"/></svg>"#);
      let v = &rot.nodes[1];
      let p0 = &v.vector.as_ref().unwrap().subpaths[0].points[0];
      let (s, c) = 30f64.to_radians().sin_cos();
      assert!((p0.x + v.x - (10.0 * c)).abs() < 1e-6 && (p0.y + v.y - (10.0 * s)).abs() < 1e-6);
    }

    #[test]
    fn nested_transforms_compose_and_styles_inherit() {
      let i = ok(
        r##"<svg width="100" height="100" viewBox="0 0 100 100" fill="green"><style>.a{fill:#f00} #b{stroke:blue;stroke-width:3}</style>
        <g transform="translate(10 20) scale(2)" opacity=".5" id="outer"><g transform="translate(5 5)"><rect id="b" class="a" width="4" height="4"/><path d="M0 0h4v4z" style="fill:rgb(0,128,255);fill-opacity:.5"/><circle r="1" cx="2" cy="2"/></g></g></svg>"##,
      );
      let outer = &i.nodes[1];
      assert_eq!((outer.kind, outer.name.as_str(), outer.opacity), (NodeType::Group, "outer", 0.5));
      let inner = kids(&i, outer)[0];
      assert_eq!(inner.kind, NodeType::Group);
      let k = kids(&i, inner);
      // (5,5) then scale 2 then (10,20): x = 10 + 2*5 = 20, y = 30; width 8.
      assert_eq!(
        (outer.x + inner.x + k[0].x, outer.y + inner.y + k[0].y, k[0].width),
        (20.0, 30.0, 8.0)
      );
      assert_eq!(solid(&k[0].fills[0]).0, "#FF0000", "the class beats the inherited green");
      assert_eq!(k[0].stroke_weight, 6.0);
      assert_eq!(solid(&k[0].strokes[0]).0, "#0000FF");
      assert_eq!(solid(&k[1].fills[0]), ("#0080FF".to_string(), 0.5));
      assert_eq!(solid(&k[2].fills[0]).0, "#008000", "CSS green");
    }

    #[test]
    fn a_matrix_and_skew_transform_move_points() {
      let i =
        ok(r##"<svg width="50" height="50"><path d="M0 0L10 0L10 10" transform="matrix(1 0 0 2 5 6)" fill="none" stroke="#000"/></svg>"##);
      let v = &i.nodes[1];
      let pts: Vec<(f64, f64)> = v.vector.as_ref().unwrap().subpaths[0]
        .points
        .iter()
        .map(|p| (p.x + v.x, p.y + v.y))
        .collect();
      assert_eq!(pts, vec![(5.0, 6.0), (15.0, 6.0), (15.0, 26.0)]);
      assert_eq!(v.stroke_weight, 2f64.sqrt());
      let t = parse_transform("skewX(45) translate(1,2)").unwrap();
      assert!((t.c - 1.0).abs() < 1e-9 && (t.e - 3.0).abs() < 1e-9 && (t.f - 2.0).abs() < 1e-9);
    }

    #[test]
    fn the_view_box_maps_with_preserve_aspect_ratio() {
      let i = ok(r#"<svg width="200" height="100" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>"#);
      let r = &i.nodes[1];
      assert_eq!((r.x, r.y, r.width, r.height), (50.0, 0.0, 100.0, 100.0));
      let s = ok(
        r#"<svg width="200" height="100" viewBox="0 0 10 10" preserveAspectRatio="xMinYMin slice"><rect width="10" height="10"/></svg>"#,
      );
      assert_eq!((s.nodes[1].width, s.nodes[1].x), (200.0, 0.0));
      let none = ok(r#"<svg width="200" height="100" viewBox="0 0 10 10" preserveAspectRatio="none"><rect width="10" height="10"/></svg>"#);
      assert_eq!((none.nodes[1].width, none.nodes[1].height), (200.0, 100.0));
    }

    #[test]
    fn a_user_space_linear_gradient_gets_handles_in_the_box() {
      let i = ok(
        r##"<svg width="24" height="24" viewBox="0 0 24 24"><defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="12" y1="2" x2="12" y2="22"><stop stop-color="#f00"/><stop offset="1" stop-color="#00f" stop-opacity=".5"/></linearGradient></defs><path d="M12 2L2 22H22Z" fill="url(#g)"/></svg>"##,
      );
      let v = &i.nodes[1];
      let Paint::LinearGradient {
        stops, handles: Some(h), ..
      } = &v.fills[0]
      else {
        panic!("{:?}", v.fills)
      };
      assert_eq!(stops.len(), 2);
      assert_eq!(stops[1].color, "#0000FF80");
      // The path spans y 2..22, so the gradient runs the full height of the box at x = middle.
      assert!(
        (h.start[0] - 0.5).abs() < 1e-9 && h.start[1].abs() < 1e-9 && (h.end[1] - 1.0).abs() < 1e-9,
        "{h:?}"
      );
    }

    #[test]
    fn object_bounding_box_and_radial_gradients() {
      let i = ok(
        r##"<svg width="20" height="20"><defs><radialGradient id="r"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></radialGradient><linearGradient id="l" href="#r" x2="0" y2="1" gradientTransform="rotate(0)"/></defs><rect x="5" y="5" width="10" height="10" fill="url(#r)" stroke="url(#l)"/></svg>"##,
      );
      let r = &i.nodes[1];
      let Paint::RadialGradient { handles: Some(h), .. } = &r.fills[0] else {
        panic!()
      };
      assert_eq!((h.start, h.end, h.width), ([0.5, 0.5], [1.0, 0.5], [0.5, 1.0]));
      let Paint::LinearGradient {
        stops, handles: Some(l), ..
      } = &r.strokes[0]
      else {
        panic!()
      };
      assert_eq!(stops.len(), 2, "stops come through href");
      assert_eq!((l.start, l.end), ([0.0, 0.0], [0.0, 1.0]));
      assert!(run(r##"<svg width="9" height="9"><linearGradient id="g" spreadMethod="repeat"><stop/><stop offset="1"/></linearGradient><rect width="9" height="9" fill="url(#g)"/></svg>"##).is_err());
    }

    #[test]
    fn dashes_caps_and_open_paths() {
      let i = ok(
        r##"<svg width="20" height="20" fill="none" stroke="#123" stroke-width="2" stroke-dasharray="4 2 1" stroke-linecap="square"><path d="M2 2L18 2"/><path d="M2 8H18Z"/></svg>"##,
      );
      let k = kids(&i, &i.nodes[0]);
      assert_eq!(k[0].stroke_dash, vec![4.0, 2.0, 1.0, 4.0, 2.0, 1.0]);
      assert_eq!(k[0].shape.as_ref().unwrap().end_cap, StrokeCap::Square);
      assert!(k[1].shape.is_none(), "a closed path has no line ends");
      assert_eq!(solid(&k[0].strokes[0]).0, "#112233");
    }

    #[test]
    fn use_places_a_copy_and_symbols_keep_their_view_box() {
      let i = ok(
        r##"<svg width="40" height="40"><defs><path id="p" d="M0 0h4v4z"/><symbol id="s" viewBox="0 0 2 2"><rect width="2" height="2"/></symbol></defs><use href="#p" x="10" y="10" fill="red"/><use href="#s" x="20" y="20" width="10" height="10"/></svg>"##,
      );
      let p = &i.nodes[1];
      assert_eq!((p.kind, p.x, p.y), (NodeType::Vector, 10.0, 10.0));
      assert_eq!(solid(&p.fills[0]).0, "#FF0000");
      let r = &i.nodes[2];
      assert_eq!((r.kind, r.x, r.width), (NodeType::Rectangle, 20.0, 10.0));
    }
  }

  mod refusals {
    use super::*;

    fn refused(body: &str) -> String {
      run(&format!(r#"<svg width="10" height="10" viewBox="0 0 10 10">{body}</svg>"#))
        .err()
        .unwrap_or_else(|| panic!("accepted: {body}"))
    }

    #[test]
    fn text_images_filters_masks_patterns_and_markers_fall_back() {
      assert_eq!(refused("<text>hi</text>"), "text");
      assert_eq!(
        refused(r#"<image href="http://example.com/a.png" width="3" height="3"/>"#),
        "an embedded image"
      );
      assert_eq!(
        refused(r#"<image href="data:image/png;base64,AAAA" width="3" height="3"/>"#),
        "an embedded image"
      );
      assert_eq!(
        refused(r##"<filter id="f"><feGaussianBlur stdDeviation="2"/></filter><rect width="3" height="3" filter="url(#f)"/>"##),
        "filters"
      );
      assert_eq!(
        refused(r##"<mask id="m"><rect width="3" height="3"/></mask><rect width="3" height="3" mask="url(#m)"/>"##),
        "masks"
      );
      assert_eq!(
        refused(
          r##"<pattern id="p" width="2" height="2"><rect width="1" height="1"/></pattern><rect width="3" height="3" fill="url(#p)"/>"##
        ),
        "patterns"
      );
      assert_eq!(refused(r##"<path d="M0 0L5 5" marker-end="url(#a)" stroke="#000"/>"##), "markers");
      assert_eq!(refused(""), "nothing it can draw");
    }

    #[test]
    fn nothing_is_fetched_and_scripts_are_ignored() {
      let i = ok(
        r##"<svg width="10" height="10"><foreignObject width="5" height="5"><script>alert(1)</script></foreignObject><script>alert(2)</script>
        <use href="http://example.com/x.svg#a"/><use href="file:///etc/passwd#a"/><rect width="4" height="4" fill="url(http://example.com/a.svg#g) red"/><a href="javascript:alert(3)"><rect width="2" height="2"/></a></svg>"##,
      );
      assert_eq!(i.nodes.len(), 3, "the frame and the two rectangles");
      assert_eq!(solid(&i.nodes[1].fills[0]).0, "#FF0000", "falls back to the colour");
      assert!(i.warnings.iter().any(|w| w.contains("outside the document")));
      // No layer carries a link, a URL or an image paint.
      let json = serde_json::to_string(&i.nodes).unwrap();
      assert!(!json.contains("http") && !json.contains("file:") && !json.contains("javascript"));
    }

    #[test]
    fn hidden_things_are_skipped_not_refused() {
      let i = ok(
        r#"<svg width="10" height="10"><g display="none"><text>x</text></g><rect width="4" height="4" style="display:none"/><rect width="4" height="4" visibility="hidden"/><rect width="4" height="4" fill="none"/><rect width="3" height="3"/></svg>"#,
      );
      assert_eq!(i.nodes.len(), 2);
    }
  }

  mod fuzz {
    use super::*;

    /// A deterministic xorshift, so a failure can be replayed.
    struct Rng(u64);

    impl Rng {
      fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
      }
    }

    fn feed(s: &str) {
      // Must return (Ok or Err) and never panic or hang.
      let _ = run(s);
    }

    #[test]
    fn truncated_documents_never_panic() {
      let doc = LUCIDE_SETTINGS.to_string();
      for end in 0..doc.len() {
        if doc.is_char_boundary(end) {
          feed(&doc[..end]);
        }
      }
      let with_gradient = r##"<svg viewBox="0 0 24 24"><style>.a{fill:red}</style><defs><linearGradient id="g"><stop offset="0"/><stop offset="1"/></linearGradient><clipPath id="c"><rect width="9" height="9"/></clipPath></defs><g clip-path="url(#c)" transform="rotate(5)"><path class="a" d="M0 0a5 5 0 0 1 9 9z" fill="url(#g)"/></g></svg>"##;
      for end in 0..with_gradient.len() {
        feed(&with_gradient[..end]);
      }
    }

    #[test]
    fn garbled_documents_never_panic() {
      let base = r##"<svg width="24" height="24" viewBox="0 0 24 24"><style>.a{fill:red}</style><g transform="rotate(5) scale(2)" opacity="0.5"><path class="a" d="M1 2L3 4C5 6 7 8 9 10Z" stroke="url(#g)"/><circle r="4"/><use href="#x"/></g><linearGradient id="g"><stop offset="50%"/></linearGradient></svg>"##;
      let mut rng = Rng(0x9E3779B97F4A7C15);
      let alphabet: Vec<char> = "<>/=\"'&;#()-+.,0123456789 eEMmLlHhVvCcSsQqTtAaZz!?[]é\u{0}{}%".chars().collect();
      for round in 0..4000 {
        let mut s: Vec<char> = base.chars().collect();
        for _ in 0..1 + round % 8 {
          let at = (rng.next() as usize) % s.len();
          match rng.next() % 3 {
            0 => s[at] = alphabet[(rng.next() as usize) % alphabet.len()],
            1 => s.insert(at, alphabet[(rng.next() as usize) % alphabet.len()]),
            _ => {
              s.remove(at);
            }
          }
        }
        feed(&s.iter().collect::<String>());
      }
      for junk in [
        "",
        "<",
        "<svg",
        "<svg>",
        "<svg/>",
        "&",
        "<<<<",
        "\u{0}",
        "<svg width='1e999' height='-4'/>",
        "<svg><rect width='1e308' height='1e308'/></svg>",
        "<svg viewBox='0 0 0 0' width='5' height='5'><rect width='1' height='1'/></svg>",
        "<svg width='5' height='5'><path d='M1e999 0L5 5'/></svg>",
        "<svg width='5' height='5'><path d='M 0 0 A 1e-300 1e300 0 1 1 5 5'/></svg>",
        "<svg width='5' height='5'><rect width='3' height='3' transform='matrix(0 0 0 0 0 0)'/></svg>",
        "<svg width='5' height='5'><rect width='3' height='3' transform='scale(1e308)'/></svg>",
        "<svg width='5' height='5'><polygon points='1,2,3'/></svg>",
      ] {
        feed(junk);
      }
    }

    #[test]
    fn huge_inputs_stay_bounded() {
      // 2 MB of nested-looking markup, a very long attribute, a very long path of one command.
      feed(&format!("<svg width='9' height='9'>{}", "<g>".repeat(1_000_000)));
      feed(&format!(
        "<svg width='9' height='9'><path d='{}'/></svg>",
        "9".repeat(MAX_BYTES - 100)
      ));
      feed(&format!(
        "<svg width='9' height='9'><path d='M0 0{}'/></svg>",
        "L1 1 ".repeat(MAX_BYTES / 5 - 100)
      ));
      feed(&format!(
        "<svg width='9' height='9'><style>{}</style><rect width='4' height='4'/></svg>",
        ".a{fill:red}".repeat(100_000)
      ));
      feed(&format!(
        "<svg width='9' height='9'>{}</svg>",
        "<rect width='1' height='1' style='fill:red'/>".repeat(30_000)
      ));
      let many_holes = format!(
        "<svg width='99' height='99'><path fill-rule='evenodd' d='{}'/></svg>",
        "M0 0h3v3h-3z".repeat(499)
      );
      assert!(run(&many_holes).is_ok());
      let too_many_holes = format!(
        "<svg width='99' height='99'><path fill-rule='evenodd' d='{}'/></svg>",
        "M0 0h3v3h-3z".repeat(600)
      );
      assert!(run(&too_many_holes).unwrap().warnings.iter().any(|w| w.contains("holes")));
    }
  }
}
