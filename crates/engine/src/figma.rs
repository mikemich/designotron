//! Figma import: converts Figma REST API file JSON (`GET /v1/files/:key?geometry=paths`
//! or `/nodes?ids=…`) into Designotron pages and layers.
//!
//! Instances of components defined in the same file stay linked: Figma ids of
//! instance children (`I<instance>;<master>`) name their master node, which gives
//! `master_id`, and differences from the master become overrides. Instances of
//! library components become plain frames.

use std::collections::{BTreeMap, HashMap};

use serde_json::{json, Map, Value};

use crate::components::ROOT_KEY;
use crate::doc::IdGen;
use crate::geom::Point;
use crate::model::{Document, InstanceInfo, Node, NodeId, NodeType, Page};

pub struct Import<'a> {
  doc: &'a mut Document,
  gen: &'a mut IdGen,
  /// Figma imageRef → URL or `asset:` id.
  images: &'a BTreeMap<String, String>,
  /// Figma node id → our id.
  map: HashMap<String, NodeId>,
  /// Our id → Figma id.
  figma_id: HashMap<NodeId, String>,
  /// (our instance id, Figma componentId).
  instances: Vec<(NodeId, String)>,
  /// (our node id, Figma destination id) for prototype links.
  links: Vec<(NodeId, String, String)>,
  warnings: Vec<String>,
  count: usize,
}

/// Imports every page (canvas) of a Figma file, or the nodes of a `/nodes` response.
pub fn import(doc: &mut Document, gen: &mut IdGen, file: &Value, images: &BTreeMap<String, String>) -> Result<Value, String> {
  let mut imp = Import {
    doc,
    gen,
    images,
    map: HashMap::new(),
    figma_id: HashMap::new(),
    instances: Vec::new(),
    links: Vec::new(),
    warnings: Vec::new(),
    count: 0,
  };
  // (name, top-level layers, background, flow starting points)
  type PageSrc = (String, Vec<Value>, Option<String>, Vec<Value>);
  let mut pages: Vec<PageSrc> = Vec::new();
  if let Some(canvases) = file.pointer("/document/children").and_then(|v| v.as_array()) {
    for c in canvases {
      let kids = c.get("children").and_then(|v| v.as_array()).cloned().unwrap_or_default();
      let bg = c.get("backgroundColor").map(color_hex);
      let flows = c.get("flowStartingPoints").and_then(|v| v.as_array()).cloned().unwrap_or_default();
      pages.push((str_of(c, "name").unwrap_or("Page").to_string(), kids, bg, flows));
    }
  } else if let Some(nodes) = file.get("nodes").and_then(|v| v.as_object()) {
    let kids: Vec<Value> = nodes.values().filter_map(|n| n.get("document").cloned()).collect();
    pages.push((str_of(file, "name").unwrap_or("Figma import").to_string(), kids, None, vec![]));
  } else {
    return Err("not a Figma file: expected the JSON from the Figma REST API (/v1/files/:key)".into());
  }
  let mut page_ids = Vec::new();
  for (name, kids, bg, flows) in pages {
    let pid = imp.gen.next("p_");
    imp.doc.pages.push(Page {
      id: pid.clone(),
      name,
      children: Vec::new(),
      background: bg.unwrap_or_else(|| "#F5F5F5".into()),
      flow_start: None,
      guides: Vec::new(),
    });
    for k in &kids {
      imp.convert(k, None, &pid, None);
    }
    if let Some(start) = flows
      .first()
      .and_then(|f| str_of(f, "nodeId"))
      .and_then(|id| imp.map.get(id).cloned())
    {
      if let Some(p) = imp.doc.page_mut(&pid) {
        p.flow_start = Some(start);
      }
    }
    page_ids.push(pid);
  }
  imp.link_instances();
  imp.link_prototypes();
  Ok(json!({ "pages": page_ids, "layers": imp.count, "warnings": imp.warnings }))
}

fn str_of<'v>(v: &'v Value, k: &str) -> Option<&'v str> {
  v.get(k).and_then(|x| x.as_str())
}

fn num(v: &Value, k: &str) -> Option<f64> {
  v.get(k).and_then(|x| x.as_f64())
}

fn hex2(v: f64) -> String {
  format!("{:02X}", (v.clamp(0.0, 1.0) * 255.0).round() as u8)
}

/// Figma RGBA (0..1) → `#RRGGBB` or `#RRGGBBAA`.
fn color_hex(c: &Value) -> String {
  let r = num(c, "r").unwrap_or(0.0);
  let g = num(c, "g").unwrap_or(0.0);
  let b = num(c, "b").unwrap_or(0.0);
  let a = num(c, "a").unwrap_or(1.0);
  let base = format!("#{}{}{}", hex2(r), hex2(g), hex2(b));
  if a < 0.999 {
    format!("{base}{}", hex2(a))
  } else {
    base
  }
}

fn camel(s: &str) -> String {
  let mut out = String::new();
  for (i, part) in s.split('_').enumerate() {
    let lower = part.to_ascii_lowercase();
    if i == 0 {
      out.push_str(&lower);
    } else {
      let mut ch = lower.chars();
      if let Some(f) = ch.next() {
        out.push(f.to_ascii_uppercase());
        out.extend(ch);
      }
    }
  }
  out
}

impl Import<'_> {
  fn paints(&self, list: Option<&Value>, w: f64, h: f64) -> Vec<Value> {
    let mut out = Vec::new();
    for p in list.and_then(|v| v.as_array()).cloned().unwrap_or_default() {
      let visible = p.get("visible").and_then(|v| v.as_bool()).unwrap_or(true);
      let opacity = num(&p, "opacity").unwrap_or(1.0);
      let stops = || -> Vec<Value> {
        p.get("gradientStops")
          .and_then(|v| v.as_array())
          .map(|a| {
            a.iter()
              .map(|s| json!({ "color": s.get("color").map(color_hex).unwrap_or_default(), "position": num(s, "position").unwrap_or(0.0) }))
              .collect()
          })
          .unwrap_or_default()
      };
      let paint = match str_of(&p, "type").unwrap_or("") {
        "SOLID" => {
          let c = p.get("color").cloned().unwrap_or(json!({}));
          let a = num(&c, "a").unwrap_or(1.0);
          let mut solid = c.clone();
          if let Some(o) = solid.as_object_mut() {
            o.insert("a".into(), json!(1.0));
          }
          json!({ "type": "solid", "color": color_hex(&solid), "opacity": opacity * a, "visible": visible })
        }
        "GRADIENT_LINEAR" => {
          let hs = p
            .get("gradientHandlePositions")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
          let angle = if hs.len() >= 2 {
            let (x0, y0) = (num(&hs[0], "x").unwrap_or(0.0) * w, num(&hs[0], "y").unwrap_or(0.0) * h);
            let (x1, y1) = (num(&hs[1], "x").unwrap_or(0.0) * w, num(&hs[1], "y").unwrap_or(1.0) * h);
            (x1 - x0).atan2(-(y1 - y0)).to_degrees().rem_euclid(360.0)
          } else {
            180.0
          };
          json!({ "type": "linearGradient", "stops": stops(), "angle": angle, "opacity": opacity, "visible": visible })
        }
        "GRADIENT_RADIAL" | "GRADIENT_ANGULAR" | "GRADIENT_DIAMOND" => {
          json!({ "type": "radialGradient", "stops": stops(), "opacity": opacity, "visible": visible })
        }
        "IMAGE" => {
          let reference = str_of(&p, "imageRef").unwrap_or("");
          let src = self.images.get(reference).cloned().unwrap_or_default();
          if src.is_empty() {
            continue;
          }
          let mode = match str_of(&p, "scaleMode").unwrap_or("FILL") {
            "FIT" => "fit",
            "TILE" => "tile",
            "STRETCH" => "stretch",
            _ => "fill",
          };
          json!({ "type": "image", "src": src, "scaleMode": mode, "opacity": opacity, "visible": visible })
        }
        _ => continue,
      };
      out.push(paint);
    }
    out
  }

  fn effects(&self, list: Option<&Value>) -> Vec<Value> {
    let mut out = Vec::new();
    for e in list.and_then(|v| v.as_array()).cloned().unwrap_or_default() {
      let visible = e.get("visible").and_then(|v| v.as_bool()).unwrap_or(true);
      let kind = match str_of(&e, "type").unwrap_or("") {
        "DROP_SHADOW" => "dropShadow",
        "INNER_SHADOW" => "innerShadow",
        "LAYER_BLUR" => "layerBlur",
        "BACKGROUND_BLUR" => "backgroundBlur",
        _ => continue,
      };
      out.push(json!({
        "type": kind,
        "color": e.get("color").map(color_hex).unwrap_or_else(|| "#00000040".into()),
        "x": e.pointer("/offset/x").and_then(|v| v.as_f64()).unwrap_or(0.0),
        "y": e.pointer("/offset/y").and_then(|v| v.as_f64()).unwrap_or(0.0),
        "blur": num(&e, "radius").unwrap_or(0.0),
        "spread": num(&e, "spread").unwrap_or(0.0),
        "visible": visible,
      }));
    }
    out
  }

  /// Size and placement (x, y, rotation, flips) in parent coordinates.
  fn placement(&self, f: &Value, parent_box: Option<(f64, f64)>) -> (f64, f64, f64, f64, f64, bool) {
    let bb = f.get("absoluteBoundingBox");
    let (bw, bh) = (
      bb.and_then(|b| num(b, "width")).unwrap_or(0.0),
      bb.and_then(|b| num(b, "height")).unwrap_or(0.0),
    );
    let w = f.pointer("/size/x").and_then(|v| v.as_f64()).unwrap_or(bw);
    let h = f.pointer("/size/y").and_then(|v| v.as_f64()).unwrap_or(bh);
    if let Some(t) = f.get("relativeTransform").and_then(|v| v.as_array()).filter(|t| t.len() == 2) {
      let row = |r: usize, c: usize| t[r].get(c).and_then(|v| v.as_f64()).unwrap_or(0.0);
      let (a, c, e) = (row(0, 0), row(0, 1), row(0, 2));
      let (b, d, ff) = (row(1, 0), row(1, 1), row(1, 2));
      let flip = a * d - b * c < 0.0;
      let rot = if flip { (-b).atan2(-a) } else { b.atan2(a) }.to_degrees();
      let rot = if rot.abs() < 1e-6 { 0.0 } else { rot };
      // Our transform rotates about the centre; Figma's maps the top-left to (e, f).
      let m = crate::geom::local_matrix(0.0, 0.0, w, h, rot, flip, false);
      let o = m.apply(Point::new(0.0, 0.0));
      return (e - o.x, ff - o.y, w, h, rot, flip);
    }
    let (px, py) = parent_box.unwrap_or((0.0, 0.0));
    let x = bb.and_then(|b| num(b, "x")).unwrap_or(0.0) - px;
    let y = bb.and_then(|b| num(b, "y")).unwrap_or(0.0) - py;
    (x, y, w, h, 0.0, false)
  }

  fn convert(&mut self, f: &Value, parent: Option<&str>, page: &str, parent_box: Option<(f64, f64)>) -> Option<NodeId> {
    let ftype = str_of(f, "type").unwrap_or("");
    let kind = match ftype {
      "FRAME" | "SECTION" => "frame",
      "GROUP" => "group",
      "COMPONENT" => "component",
      "COMPONENT_SET" => "componentSet",
      "INSTANCE" => "instance",
      "RECTANGLE" => "rectangle",
      "ELLIPSE" if f.get("arcData").map(full_arc).unwrap_or(true) => "ellipse",
      "LINE" => "line",
      "TEXT" => "text",
      "ELLIPSE" | "VECTOR" | "BOOLEAN_OPERATION" | "STAR" | "REGULAR_POLYGON" => "vector",
      "SLICE" => return None,
      other => {
        self.warnings.push(format!("{other} layers are imported as frames"));
        "frame"
      }
    };
    let id = self.gen.next("n_");
    let fid = str_of(f, "id").unwrap_or("").to_string();
    let (x, y, w, h, rot, flip) = self.placement(f, parent_box);
    let mut n = Map::new();
    n.insert("id".into(), json!(id));
    n.insert("type".into(), json!(kind));
    n.insert("name".into(), json!(str_of(f, "name").unwrap_or(kind)));
    n.insert("x".into(), json!(x));
    n.insert("y".into(), json!(y));
    n.insert("width".into(), json!(w.max(0.01)));
    n.insert("height".into(), json!(h.max(0.01)));
    n.insert("rotation".into(), json!(rot));
    n.insert("flipX".into(), json!(flip));
    n.insert("visible".into(), json!(f.get("visible").and_then(|v| v.as_bool()).unwrap_or(true)));
    n.insert("locked".into(), json!(f.get("locked").and_then(|v| v.as_bool()).unwrap_or(false)));
    n.insert("opacity".into(), json!(num(f, "opacity").unwrap_or(1.0)));
    if let Some(bm) = str_of(f, "blendMode") {
      let m = camel(bm);
      const OK: &[&str] = &[
        "multiply",
        "screen",
        "overlay",
        "darken",
        "lighten",
        "colorDodge",
        "colorBurn",
        "hardLight",
        "softLight",
        "difference",
        "exclusion",
        "hue",
        "saturation",
        "color",
        "luminosity",
      ];
      if OK.contains(&m.as_str()) {
        n.insert("blendMode".into(), json!(m));
      }
    }
    let vector_like = kind == "vector";
    let text = kind == "text";
    let mut fills = self.paints(f.get("fills"), w, h);
    let mut strokes = self.paints(f.get("strokes"), w, h);
    let stroke_weight = num(f, "strokeWeight").unwrap_or(1.0);
    if vector_like {
      let geo = |k: &str| -> Option<(String, String)> {
        let list = f.get(k)?.as_array()?;
        if list.is_empty() {
          return None;
        }
        let d = list.iter().filter_map(|g| str_of(g, "path")).collect::<Vec<_>>().join(" ");
        let rule = if list.iter().any(|g| str_of(g, "windingRule") == Some("EVENODD")) {
          "evenodd"
        } else {
          "nonzero"
        };
        Some((d, rule.to_string()))
      };
      match (geo("fillGeometry").filter(|_| !fills.is_empty()), geo("strokeGeometry")) {
        (Some((d, rule)), _) => {
          n.insert(
            "vector".into(),
            json!({ "subpaths": [], "raw": { "d": d, "viewBox": [0, 0, w.max(0.01), h.max(0.01)], "fillRule": rule } }),
          );
        }
        (None, Some((d, rule))) if !strokes.is_empty() => {
          // Stroke-only shapes: Figma's outlined stroke geometry, filled with the stroke paint.
          n.insert(
            "vector".into(),
            json!({ "subpaths": [], "raw": { "d": d, "viewBox": [0, 0, w.max(0.01), h.max(0.01)], "fillRule": rule } }),
          );
          fills = std::mem::take(&mut strokes);
        }
        _ => {
          self.warnings.push(format!(
            "“{}” has no vector geometry (export the file with geometry=paths)",
            str_of(f, "name").unwrap_or("")
          ));
          n.insert("type".into(), json!("rectangle"));
        }
      }
    }
    n.insert("fills".into(), json!(fills));
    n.insert("strokes".into(), json!(strokes));
    n.insert("strokeWeight".into(), json!(if strokes_empty(&n) { 0.0 } else { stroke_weight }));
    if let Some(a) = str_of(f, "strokeAlign") {
      n.insert(
        "strokeAlign".into(),
        json!(match a {
          "CENTER" => "center",
          "OUTSIDE" => "outside",
          _ => "inside",
        }),
      );
    }
    if let Some(d) = f
      .get("strokeDashes")
      .filter(|d| d.as_array().map(|a| !a.is_empty()).unwrap_or(false))
    {
      n.insert("strokeDash".into(), d.clone());
    }
    if let Some(r) = num(f, "cornerRadius") {
      n.insert("cornerRadius".into(), json!(r));
    }
    if let Some(rs) = f.get("rectangleCornerRadii").and_then(|v| v.as_array()).filter(|a| a.len() == 4) {
      n.insert("cornerRadii".into(), json!(rs));
    }
    n.insert("effects".into(), json!(self.effects(f.get("effects"))));
    n.insert(
      "clipContent".into(),
      json!(f.get("clipsContent").and_then(|v| v.as_bool()).unwrap_or(false)),
    );
    if f.get("isMask").and_then(|v| v.as_bool()).unwrap_or(false) {
      n.insert("isMask".into(), json!(true));
    }
    if let Some(c) = f.get("constraints") {
      let h = match str_of(c, "horizontal").unwrap_or("LEFT") {
        "RIGHT" => "right",
        "CENTER" => "center",
        "LEFT_RIGHT" => "leftRight",
        "SCALE" => "scale",
        _ => "left",
      };
      let v = match str_of(c, "vertical").unwrap_or("TOP") {
        "BOTTOM" => "bottom",
        "CENTER" => "center",
        "TOP_BOTTOM" => "topBottom",
        "SCALE" => "scale",
        _ => "top",
      };
      n.insert("constraints".into(), json!({ "horizontal": h, "vertical": v }));
    }
    // Auto layout on this frame.
    let layout_mode = str_of(f, "layoutMode").unwrap_or("NONE");
    if layout_mode == "HORIZONTAL" || layout_mode == "VERTICAL" {
      let align = |v: Option<&str>| match v.unwrap_or("MIN") {
        "CENTER" => "center",
        "MAX" => "end",
        "SPACE_BETWEEN" => "spaceBetween",
        _ => "start",
      };
      n.insert(
        "layout".into(),
        json!({
          "direction": if layout_mode == "HORIZONTAL" { "horizontal" } else { "vertical" },
          "gap": num(f, "itemSpacing").unwrap_or(0.0),
          "paddingTop": num(f, "paddingTop").unwrap_or(0.0),
          "paddingRight": num(f, "paddingRight").unwrap_or(0.0),
          "paddingBottom": num(f, "paddingBottom").unwrap_or(0.0),
          "paddingLeft": num(f, "paddingLeft").unwrap_or(0.0),
          "primaryAlign": align(str_of(f, "primaryAxisAlignItems")),
          "counterAlign": align(str_of(f, "counterAxisAlignItems")),
          "wrap": str_of(f, "layoutWrap") == Some("WRAP"),
          "counterGap": num(f, "counterAxisSpacing").unwrap_or(0.0),
        }),
      );
    }
    let sizing = |v: Option<&str>| match v {
      Some("HUG") => Some("hug"),
      Some("FILL") => Some("fill"),
      Some("FIXED") => Some("fixed"),
      _ => None,
    };
    if let Some(s) = sizing(str_of(f, "layoutSizingHorizontal")) {
      n.insert("sizingH".into(), json!(s));
    }
    if let Some(s) = sizing(str_of(f, "layoutSizingVertical")) {
      n.insert("sizingV".into(), json!(s));
    }
    if str_of(f, "layoutPositioning") == Some("ABSOLUTE") {
      n.insert("absolutePosition".into(), json!(true));
    }
    if text {
      n.insert("text".into(), self.text(f));
    }
    if kind == "component" {
      let mut variant = Map::new();
      if parent
        .and_then(|p| self.doc.get(p))
        .map(|p| p.kind == NodeType::ComponentSet)
        .unwrap_or(false)
      {
        for part in str_of(f, "name").unwrap_or("").split(',') {
          if let Some((k, v)) = part.split_once('=') {
            variant.insert(k.trim().to_string(), json!(v.trim()));
          }
        }
      }
      n.insert(
        "component".into(),
        json!({ "description": str_of(f, "description").unwrap_or(""), "variantProps": variant }),
      );
    }
    if kind == "instance" {
      n.insert("instance".into(), json!({ "componentId": "", "overrides": {} }));
    }
    let node: Node = match serde_json::from_value(Value::Object(n)) {
      Ok(node) => node,
      Err(e) => {
        self.warnings.push(format!("skipped “{}”: {e}", str_of(f, "name").unwrap_or("")));
        return None;
      }
    };
    self.doc.insert(node, parent, page, None);
    self.count += 1;
    self.map.insert(fid.clone(), id.clone());
    self.figma_id.insert(id.clone(), fid);
    if kind == "instance" {
      self
        .instances
        .push((id.clone(), str_of(f, "componentId").unwrap_or("").to_string()));
    }
    if let Some(dest) = str_of(f, "transitionNodeID") {
      self.links.push((id.clone(), dest.to_string(), "dissolve".to_string()));
    }
    // Children are positioned relative to this node's bounding box when there is no relativeTransform.
    let my_box = f
      .get("absoluteBoundingBox")
      .map(|b| (num(b, "x").unwrap_or(0.0), num(b, "y").unwrap_or(0.0)));
    // Boolean operations arrive as their result geometry; their inputs aren't separate layers here.
    if let Some(kids) = f.get("children").and_then(|v| v.as_array()).filter(|_| !vector_like) {
      for k in kids {
        self.convert(k, Some(&id), page, my_box);
      }
    }
    // Figma groups have no own transform; their children are in the group's parent space.
    if kind == "group" && f.get("relativeTransform").is_some() {
      let kids = self.doc.get(&id).map(|n| n.children.clone()).unwrap_or_default();
      let (gx, gy) = self.doc.get(&id).map(|n| (n.x, n.y)).unwrap_or((0.0, 0.0));
      for k in kids {
        if let Some(c) = self.doc.get_mut(&k) {
          c.x -= gx;
          c.y -= gy;
        }
      }
    }
    Some(id)
  }

  fn text(&self, f: &Value) -> Value {
    let st = f.get("style").cloned().unwrap_or(json!({}));
    let chars = str_of(f, "characters").unwrap_or("").to_string();
    let lh = match str_of(&st, "lineHeightUnit") {
      Some("INTRINSIC_%") | None => None,
      _ => num(&st, "lineHeightPx"),
    };
    let mut t = json!({
      "characters": chars,
      "fontFamily": str_of(&st, "fontFamily").unwrap_or("Inter"),
      "fontSize": num(&st, "fontSize").unwrap_or(14.0),
      "fontWeight": num(&st, "fontWeight").unwrap_or(400.0) as u32,
      "italic": st.get("italic").and_then(|v| v.as_bool()).unwrap_or(false),
      "lineHeight": lh,
      "letterSpacing": num(&st, "letterSpacing").unwrap_or(0.0),
      "paragraphSpacing": num(&st, "paragraphSpacing").unwrap_or(0.0),
      "alignH": match str_of(&st, "textAlignHorizontal") { Some("CENTER") => "center", Some("RIGHT") => "right", Some("JUSTIFIED") => "justify", _ => "left" },
      "alignV": match str_of(&st, "textAlignVertical") { Some("CENTER") => "middle", Some("BOTTOM") => "bottom", _ => "top" },
      "autoResize": match str_of(&st, "textAutoResize") { Some("WIDTH_AND_HEIGHT") => "width", Some("HEIGHT") => "height", _ => "none" },
      "decoration": match str_of(&st, "textDecoration") { Some("UNDERLINE") => "underline", Some("STRIKETHROUGH") => "strikethrough", _ => "none" },
      "case": match str_of(&st, "textCase") { Some("UPPER") => "upper", Some("LOWER") => "lower", Some("TITLE") => "title", _ => "original" },
      "runs": [],
    });
    // Per-character overrides are indexed in UTF-16 units; runs use code points.
    let overrides = f
      .get("characterStyleOverrides")
      .and_then(|v| v.as_array())
      .cloned()
      .unwrap_or_default();
    let table = f.get("styleOverrideTable").and_then(|v| v.as_object()).cloned().unwrap_or_default();
    if !overrides.is_empty() && !table.is_empty() {
      let mut runs: Vec<Value> = Vec::new();
      let mut unit = 0usize;
      let mut cur: Option<(String, usize)> = None;
      let ids: Vec<String> = chars
        .chars()
        .map(|ch| {
          let id = overrides
            .get(unit)
            .map(|v| v.to_string().trim_matches('"').to_string())
            .unwrap_or_else(|| "0".into());
          unit += ch.len_utf16();
          id
        })
        .collect();
      let mut push = |id: &str, start: usize, end: usize| {
        let Some(s) = table.get(id) else { return };
        let mut r = json!({ "start": start, "end": end });
        let o = r.as_object_mut().unwrap();
        if let Some(v) = str_of(s, "fontFamily") {
          o.insert("fontFamily".into(), json!(v));
        }
        if let Some(v) = num(s, "fontSize") {
          o.insert("fontSize".into(), json!(v));
        }
        if let Some(v) = num(s, "fontWeight") {
          o.insert("fontWeight".into(), json!(v as u32));
        }
        if let Some(v) = s.get("italic").and_then(|v| v.as_bool()) {
          o.insert("italic".into(), json!(v));
        }
        if let Some(v) = num(s, "letterSpacing") {
          o.insert("letterSpacing".into(), json!(v));
        }
        if let Some(v) = str_of(s, "textDecoration") {
          o.insert(
            "decoration".into(),
            json!(match v {
              "UNDERLINE" => "underline",
              "STRIKETHROUGH" => "strikethrough",
              _ => "none",
            }),
          );
        }
        if let Some(c) = s
          .get("fills")
          .and_then(|v| v.as_array())
          .and_then(|a| a.first())
          .and_then(|p| p.get("color"))
        {
          o.insert("color".into(), json!(color_hex(c)));
        }
        if let Some(url) = s.pointer("/hyperlink/url").and_then(|v| v.as_str()) {
          o.insert("link".into(), json!(url));
        }
        if o.len() > 2 {
          runs.push(r);
        }
      };
      for (i, id) in ids.iter().enumerate() {
        match &cur {
          Some((c, _)) if c == id => {}
          _ => {
            if let Some((c, s)) = cur.take() {
              if c != "0" {
                push(&c, s, i);
              }
            }
            cur = Some((id.clone(), i));
          }
        }
      }
      if let Some((c, s)) = cur {
        if c != "0" {
          push(&c, s, ids.len());
        }
      }
      t["runs"] = json!(runs);
    }
    t
  }

  /// Links instances to their main components (same file) or turns them into frames.
  fn link_instances(&mut self) {
    // Outer instances first, so nested ones can tell whether they live inside a linked instance.
    let mut list = self.instances.clone();
    list.sort_by_key(|(id, _)| self.doc.ancestors(id).len());
    for (inst, fig_comp) in list {
      let inside_linked = self.doc.ancestors(&inst).iter().any(|a| {
        self
          .doc
          .get(a)
          .map(|n| n.kind == NodeType::Instance && n.instance.as_ref().map(|i| !i.component_id.is_empty()).unwrap_or(false))
          .unwrap_or(false)
      });
      let comp = self
        .map
        .get(&fig_comp)
        .cloned()
        .filter(|c| self.doc.get(c).map(|n| n.kind == NodeType::Component).unwrap_or(false));
      if inside_linked {
        // Copies inside a linked instance take their link from the master they mirror.
        let info = self
          .doc
          .get(&inst)
          .and_then(|n| n.master_id.clone())
          .and_then(|m| self.doc.get(&m))
          .and_then(|m| m.instance.clone());
        match (info, comp) {
          (Some(info), _) => self.doc.get_mut(&inst).unwrap().instance = Some(info),
          (None, Some(c)) => {
            self.doc.get_mut(&inst).unwrap().instance = Some(InstanceInfo {
              component_id: c,
              overrides: BTreeMap::new(),
            })
          }
          (None, None) => self.detach(&inst),
        }
        continue;
      }
      let Some(comp) = comp else {
        self.detach(&inst);
        continue;
      };
      let inst_fig = self.figma_id.get(&inst).cloned().unwrap_or_default();
      // Map each descendant to its master through the Figma id path.
      let subtree = self.doc.subtree(&inst);
      for d in subtree.iter().skip(1) {
        let Some(fid) = self.figma_id.get(d) else { continue };
        let master_fig = master_figma_id(fid, &inst_fig);
        let master = master_fig.and_then(|m| self.map.get(&m).cloned());
        if let Some(n) = self.doc.get_mut(d) {
          n.master_id = master;
        }
      }
      let mut overrides: BTreeMap<NodeId, Value> = BTreeMap::new();
      for d in subtree.iter().skip(1) {
        let Some(n) = self.doc.get(d).cloned() else { continue };
        let Some(mid) = n.master_id.clone() else { continue };
        let Some(mut m) = self.doc.get(&mid).cloned() else { continue };
        m.id = n.id.clone();
        m.parent = n.parent.clone();
        m.children = n.children.clone();
        m.page = n.page.clone();
        m.master_id = n.master_id.clone();
        m.component = None;
        if m.kind == NodeType::Component {
          m.kind = NodeType::Frame;
        }
        if n.kind == NodeType::Instance {
          m.instance = n.instance.clone();
        }
        let diff = crate::ai::diff_patch(&m, &n);
        if diff.as_object().map(|o| !o.is_empty()).unwrap_or(false) {
          overrides.insert(mid, diff);
        }
      }
      // Root: visual differences from the main component (size, fills, …), not placement.
      if let (Some(root), Some(mut c)) = (self.doc.get(&inst).cloned(), self.doc.get(&comp).cloned()) {
        c.id = root.id.clone();
        c.kind = root.kind;
        c.name = root.name.clone();
        c.parent = root.parent.clone();
        c.children = root.children.clone();
        c.page = root.page.clone();
        c.component = None;
        c.instance = root.instance.clone();
        c.master_id = root.master_id.clone();
        let mut diff = crate::ai::diff_patch(&c, &root);
        if let Some(o) = diff.as_object_mut() {
          for k in [
            "x",
            "y",
            "rotation",
            "flipX",
            "flipY",
            "visible",
            "locked",
            "constraints",
            "absolutePosition",
            "sizingH",
            "sizingV",
            "interactions",
          ] {
            o.remove(k);
          }
          if !o.is_empty() {
            overrides.insert(ROOT_KEY.to_string(), diff);
          }
        }
      }
      if let Some(n) = self.doc.get_mut(&inst) {
        n.instance = Some(InstanceInfo {
          component_id: comp,
          overrides,
        });
      }
    }
  }

  fn detach(&mut self, id: &str) {
    if let Some(n) = self.doc.get_mut(id) {
      n.kind = NodeType::Frame;
      n.instance = None;
    }
  }

  fn link_prototypes(&mut self) {
    for (from, dest, transition) in std::mem::take(&mut self.links) {
      let Some(to) = self.map.get(&dest).cloned() else { continue };
      if let Some(n) = self.doc.get_mut(&from) {
        if let Ok(i) =
          serde_json::from_value(json!({ "trigger": "onClick", "action": "navigate", "destination": to, "transition": transition }))
        {
          n.interactions.push(i);
        }
      }
    }
  }
}

fn strokes_empty(n: &Map<String, Value>) -> bool {
  n.get("strokes").and_then(|v| v.as_array()).map(|a| a.is_empty()).unwrap_or(true)
}

fn full_arc(a: &Value) -> bool {
  let start = num(a, "startingAngle").unwrap_or(0.0);
  let end = num(a, "endingAngle").unwrap_or(std::f64::consts::TAU);
  let inner = num(a, "innerRadius").unwrap_or(0.0);
  inner == 0.0 && ((end - start).abs() - std::f64::consts::TAU).abs() < 1e-3
}

/// Figma id of the master node an instance child mirrors: `I<inst>;A` → `A`, `I<inst>;A;B` → `IA;B`.
fn master_figma_id(child: &str, inst: &str) -> Option<String> {
  let rest = child.strip_prefix('I')?;
  let inst_path = inst.strip_prefix('I').unwrap_or(inst);
  let tail = rest.strip_prefix(inst_path)?.strip_prefix(';')?;
  if tail.contains(';') {
    Some(format!("I{tail}"))
  } else {
    Some(tail.to_string())
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::doc::new_document;

  fn file() -> Value {
    json!({
      "name": "Test",
      "document": { "id": "0:0", "type": "DOCUMENT", "children": [{
        "id": "0:1", "type": "CANVAS", "name": "Screens", "backgroundColor": { "r": 0.9, "g": 0.9, "b": 0.9, "a": 1 },
        "children": [
          { "id": "1:1", "type": "COMPONENT", "name": "Button", "absoluteBoundingBox": { "x": 0, "y": 0, "width": 120, "height": 40 },
            "size": { "x": 120, "y": 40 }, "relativeTransform": [[1, 0, 0], [0, 1, 0]],
            "fills": [{ "type": "SOLID", "color": { "r": 0.427, "g": 0.29, "b": 1, "a": 1 } }], "cornerRadius": 8,
            "layoutMode": "HORIZONTAL", "itemSpacing": 4, "paddingLeft": 16, "paddingRight": 16, "paddingTop": 10, "paddingBottom": 10,
            "primaryAxisAlignItems": "CENTER", "counterAxisAlignItems": "CENTER",
            "children": [{ "id": "1:2", "type": "TEXT", "name": "Label", "characters": "Buy now",
              "absoluteBoundingBox": { "x": 16, "y": 10, "width": 88, "height": 20 }, "size": { "x": 88, "y": 20 }, "relativeTransform": [[1, 0, 16], [0, 1, 10]],
              "fills": [{ "type": "SOLID", "color": { "r": 1, "g": 1, "b": 1, "a": 1 } }],
              "style": { "fontFamily": "Inter", "fontWeight": 600, "fontSize": 14, "textAutoResize": "WIDTH_AND_HEIGHT", "lineHeightUnit": "INTRINSIC_%" },
              "characterStyleOverrides": [0, 0, 0, 0, 1, 1, 1], "styleOverrideTable": { "1": { "fontWeight": 800 } } }] },
          { "id": "2:1", "type": "FRAME", "name": "Home", "absoluteBoundingBox": { "x": 200, "y": 0, "width": 393, "height": 852 },
            "size": { "x": 393, "y": 852 }, "relativeTransform": [[1, 0, 200], [0, 1, 0]],
            "fills": [{ "type": "GRADIENT_LINEAR", "gradientHandlePositions": [{ "x": 0.5, "y": 0 }, { "x": 0.5, "y": 1 }, { "x": 0, "y": 0 }],
              "gradientStops": [{ "color": { "r": 1, "g": 1, "b": 1, "a": 1 }, "position": 0 }, { "color": { "r": 0, "g": 0, "b": 0, "a": 0.5 }, "position": 1 }] }],
            "children": [
              { "id": "3:1", "type": "INSTANCE", "name": "Button", "componentId": "1:1", "absoluteBoundingBox": { "x": 220, "y": 700, "width": 120, "height": 40 },
                "size": { "x": 120, "y": 40 }, "relativeTransform": [[1, 0, 20], [0, 1, 700]], "transitionNodeID": "1:1",
                "fills": [{ "type": "SOLID", "color": { "r": 0.427, "g": 0.29, "b": 1, "a": 1 } }], "cornerRadius": 8,
                "layoutMode": "HORIZONTAL", "itemSpacing": 4, "paddingLeft": 16, "paddingRight": 16, "paddingTop": 10, "paddingBottom": 10,
                "primaryAxisAlignItems": "CENTER", "counterAxisAlignItems": "CENTER",
                "children": [{ "id": "I3:1;1:2", "type": "TEXT", "name": "Label", "characters": "Checkout",
                  "absoluteBoundingBox": { "x": 236, "y": 710, "width": 88, "height": 20 }, "size": { "x": 88, "y": 20 }, "relativeTransform": [[1, 0, 16], [0, 1, 10]],
                  "fills": [{ "type": "SOLID", "color": { "r": 1, "g": 1, "b": 1, "a": 1 } }],
                  "style": { "fontFamily": "Inter", "fontWeight": 600, "fontSize": 14, "textAutoResize": "WIDTH_AND_HEIGHT", "lineHeightUnit": "INTRINSIC_%" } }] },
              { "id": "3:2", "type": "INSTANCE", "name": "Library icon", "componentId": "99:1", "absoluteBoundingBox": { "x": 220, "y": 20, "width": 24, "height": 24 },
                "size": { "x": 24, "y": 24 }, "relativeTransform": [[0, 1, 44], [-1, 0, 20]], "children": [] },
              { "id": "3:3", "type": "VECTOR", "name": "Check", "absoluteBoundingBox": { "x": 260, "y": 20, "width": 10, "height": 10 },
                "size": { "x": 10, "y": 10 }, "relativeTransform": [[1, 0, 60], [0, 1, 20]],
                "fills": [], "strokes": [{ "type": "SOLID", "color": { "r": 0, "g": 0, "b": 0, "a": 1 } }], "strokeWeight": 2,
                "fillGeometry": [], "strokeGeometry": [{ "path": "M0 5L4 9L10 0L9 0L4 8L1 5Z", "windingRule": "NONZERO" }] }
            ] }
        ] }] }
    })
  }

  #[test]
  fn imports_pages_layout_text_and_instances() {
    let mut gen = IdGen::new(7);
    let mut doc = new_document(&mut gen, "x");
    let r = import(&mut doc, &mut gen, &file(), &BTreeMap::new()).unwrap();
    assert_eq!(r["layers"], 7, "{r}");
    let page = doc.pages.iter().find(|p| p.name == "Screens").unwrap();
    assert_eq!(page.background, "#E6E6E6");
    let by_name = |name: &str| doc.nodes.values().find(|n| n.name == name).unwrap().clone();
    let button = doc.nodes.values().find(|n| n.kind == NodeType::Component).unwrap().clone();
    assert_eq!(button.name, "Button");
    assert_eq!(button.layout.as_ref().unwrap().padding_left, 16.0);
    let label = doc.get(&button.children[0]).unwrap();
    let t = label.text.as_ref().unwrap();
    assert_eq!(
      (t.runs.len(), t.runs[0].start, t.runs[0].end, t.runs[0].font_weight),
      (1, 4, 7, Some(800))
    );

    let home = by_name("Home");
    assert!(matches!(&home.fills[0], crate::model::Paint::LinearGradient { angle, .. } if (*angle - 180.0).abs() < 1e-6));
    let inst = doc.get(&home.children[0]).unwrap();
    assert_eq!(inst.kind, NodeType::Instance);
    let info = inst.instance.as_ref().unwrap();
    assert_eq!(info.component_id, button.id);
    assert_eq!(info.overrides[&button.children[0]]["text"]["characters"], "Checkout");
    assert_eq!(
      doc.get(&inst.children[0]).unwrap().master_id.as_deref(),
      Some(button.children[0].as_str())
    );
    assert_eq!(inst.interactions.len(), 1, "prototype link");

    let lib = doc.get(&home.children[1]).unwrap();
    assert_eq!(lib.kind, NodeType::Frame, "library instances become frames");
    assert!((lib.rotation + 90.0).abs() < 1e-6, "rotation {}", lib.rotation);
    // Rotation about the centre must land the top-left where Figma put it.
    let m = crate::geom::local_matrix(lib.x, lib.y, lib.width, lib.height, lib.rotation, lib.flip_x, false);
    let tl = m.apply(Point::new(0.0, 0.0));
    assert!((tl.x - 44.0).abs() < 1e-6 && (tl.y - 20.0).abs() < 1e-6, "{tl:?}");

    let check = doc.get(&home.children[2]).unwrap();
    assert!(
      check.vector.as_ref().unwrap().raw.is_some() && check.strokes.is_empty() && !check.fills.is_empty(),
      "stroke geometry becomes a filled path"
    );
  }

  #[test]
  fn imported_overrides_survive_editing_the_main_component() {
    use crate::engine::{Command, Engine};
    let mut e = Engine::new(Box::new(crate::text::HeuristicMeasurer), 3);
    e.dispatch(Command::ImportFigma {
      file: file(),
      images: BTreeMap::new(),
    })
    .unwrap();
    let comp = e.doc.nodes.values().find(|n| n.kind == NodeType::Component).unwrap().id.clone();
    e.dispatch(Command::Update {
      ids: vec![comp],
      patch: json!({ "cornerRadius": 20 }),
    })
    .unwrap();
    let inst = e.doc.nodes.values().find(|n| n.kind == NodeType::Instance).unwrap().clone();
    assert_eq!(inst.corner_radius, 20.0, "instance re-synced from its main");
    let label = e.doc.get(&inst.children[0]).unwrap();
    assert_eq!(label.text.as_ref().unwrap().characters, "Checkout", "text override kept");
  }

  #[test]
  fn master_ids_follow_figma_paths() {
    assert_eq!(master_figma_id("I3:1;1:2", "3:1").as_deref(), Some("1:2"));
    assert_eq!(master_figma_id("I3:1;5:6;1:2", "3:1").as_deref(), Some("I5:6;1:2"));
    assert_eq!(master_figma_id("I9:9;5:6;1:2", "I9:9;5:6").as_deref(), Some("1:2"));
    assert_eq!(master_figma_id("4:4", "3:1"), None);
  }
}
