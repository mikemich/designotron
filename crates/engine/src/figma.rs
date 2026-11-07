//! Figma import: converts Figma REST API file JSON (`GET /v1/files/:key?geometry=paths`
//! or `/nodes?ids=…`) into Designotron pages and layers.
//!
//! Instances of components defined in the same file stay linked: Figma ids of
//! instance children (`I<instance>;<master>`) name their master node, which gives
//! `master_id`, and differences from the master become overrides. Instances of
//! library components become plain frames.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

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
  /// Prototype links read from the file, waiting for every layer to exist.
  links: Vec<(NodeId, PendingInteraction)>,
  /// Figma frame id → its overlay fields (position, background, close on click outside).
  overlays: HashMap<String, Map<String, Value>>,
  /// Prototype things left out or approximated: what happened → how many times.
  proto_notes: BTreeMap<String, usize>,
  warnings: Vec<String>,
  count: usize,
  slices: usize,
  /// Top-level instances turned into frames because their main component isn't in the file.
  library_instances: usize,
}

/// An interaction as Figma wrote it, mapped to ours except for the destination, which is a
/// Figma id until every layer has been converted.
struct PendingInteraction {
  /// Our interaction as JSON, without `destination` and `overlay`.
  json: Map<String, Value>,
  destination: Option<String>,
  /// `overlayRelativePosition` of a manual overlay.
  manual: Option<(f64, f64)>,
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
    overlays: HashMap::new(),
    proto_notes: BTreeMap::new(),
    warnings: Vec::new(),
    count: 0,
    slices: 0,
    library_instances: 0,
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
    imp.doc.pages.push(Arc::new(Page {
      id: pid.clone(),
      name,
      children: Vec::new(),
      background: bg.unwrap_or_else(|| "#F5F5F5".into()),
      flow_start: None,
      guides: Vec::new(),
    }));
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
  imp.report();
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
          let mut linear = json!({ "type": "linearGradient", "stops": stops(), "angle": angle, "opacity": opacity, "visible": visible });
          if let (Some(hd), Some(o)) = (handles(&p), linear.as_object_mut()) {
            o.insert("handles".into(), hd);
          }
          linear
        }
        "GRADIENT_RADIAL" | "GRADIENT_ANGULAR" | "GRADIENT_DIAMOND" => {
          let kind = match str_of(&p, "type") {
            Some("GRADIENT_ANGULAR") => "angularGradient",
            Some("GRADIENT_DIAMOND") => "diamondGradient",
            _ => "radialGradient",
          };
          let mut radial = json!({ "type": kind, "stops": stops(), "opacity": opacity, "visible": visible });
          if let (Some(hd), Some(o)) = (handles(&p), radial.as_object_mut()) {
            o.insert("handles".into(), hd);
          }
          radial
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
            "CROP" => "crop",
            _ => "fill",
          };
          let mut image = json!({ "type": "image", "src": src, "scaleMode": mode, "opacity": opacity, "visible": visible });
          if mode == "crop" {
            match crop_rect(&p) {
              Some(c) => image["crop"] = c,
              // A rotated or skewed crop can't be kept: fill is the closest.
              None => image["scaleMode"] = json!("fill"),
            }
          }
          image
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
      "SLICE" => {
        self.slices += 1;
        return None;
      }
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
    if let Some(w) = f.get("individualStrokeWeights") {
      let side = |k: &str| num(w, k).unwrap_or(0.0);
      n.insert(
        "strokeWeights".into(),
        json!([side("top"), side("right"), side("bottom"), side("left")]),
      );
    }
    if let Some(j) = str_of(f, "strokeJoin") {
      n.insert(
        "strokeJoin".into(),
        json!(match j {
          "BEVEL" => "bevel",
          "ROUND" => "round",
          _ => "miter",
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
    self.read_interactions(&id, f);
    self.read_overlay(&fid_of(f), f);
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
              ..Default::default()
            })
          }
          (None, None) => self.detach(&inst),
        }
        continue;
      }
      let Some(comp) = comp else {
        self.library_instances += 1;
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
          ..Default::default()
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

  /// Reads a layer's prototype links: `interactions` (REST, times in ms), else `reactions`
  /// (Plugin API, times in seconds), else the legacy `transitionNodeID`.
  fn read_interactions(&mut self, id: &str, f: &Value) {
    let list = |k: &str| f.get(k).and_then(|v| v.as_array()).filter(|a| !a.is_empty());
    let legacy = str_of(f, "transitionNodeID").map(str::to_string);
    let (source, unit) = match (list("interactions"), list("reactions")) {
      (Some(a), _) => (a.clone(), 1.0),
      (None, Some(a)) => (a.clone(), 1000.0),
      (None, None) => {
        // Only the legacy fields: a click that navigates.
        if let Some(dest) = legacy {
          let mut t = json!({ "type": "DISSOLVE", "easing": { "type": str_of(f, "transitionEasing").unwrap_or("EASE_OUT") } });
          if let (Some(ms), Some(o)) = (num(f, "transitionDuration"), t.as_object_mut()) {
            o.insert("duration".into(), json!(ms));
          }
          let it = json!({ "trigger": { "type": "ON_CLICK" }, "actions": [{ "type": "NODE", "destinationId": dest, "navigation": "NAVIGATE", "transition": t }] });
          if let Some(p) = self.interaction(&it, 1.0, None) {
            self.links.push((id.to_string(), p));
          }
        }
        return;
      }
    };
    for r in &source {
      if let Some(p) = self.interaction(r, unit, legacy.as_deref()) {
        self.links.push((id.to_string(), p));
      }
    }
  }

  /// One Figma interaction (`trigger` plus `actions`, or the plugin's single `action`) as ours.
  /// `unit` turns Figma's times into milliseconds; `legacy` is the layer's `transitionNodeID`.
  fn interaction(&mut self, r: &Value, unit: f64, legacy: Option<&str>) -> Option<PendingInteraction> {
    let trigger = r.get("trigger").unwrap_or(&Value::Null);
    let ttype = str_of(trigger, "type").unwrap_or("ON_CLICK");
    let mut it = Map::new();
    match ttype {
      "ON_CLICK" | "ON_HOVER" | "ON_PRESS" | "MOUSE_ENTER" | "MOUSE_LEAVE" | "MOUSE_DOWN" | "MOUSE_UP" => {
        it.insert("trigger".into(), json!(camel(ttype)));
      }
      "AFTER_TIMEOUT" => {
        it.insert("trigger".into(), json!("afterDelay"));
        it.insert(
          "delayMs".into(),
          json!(num(trigger, "timeout").map(|v| to_ms(v, unit)).unwrap_or(800.0)),
        );
      }
      "ON_KEY_DOWN" => match key_name(trigger) {
        Some(k) => {
          it.insert("trigger".into(), json!("key"));
          it.insert("key".into(), json!(k));
        }
        None => {
          self.note("Key triggers Designotron can't use were skipped");
          return None;
        }
      },
      other => {
        self.note(&format!(
          "The {other} trigger isn't supported, so interactions using it were skipped"
        ));
        return None;
      }
    }
    // The plugin's older shape has one `action`; the REST and current plugin shape an `actions` list.
    let actions: Vec<Value> = match r.get("actions").and_then(|a| a.as_array()) {
      Some(a) => a.clone(),
      None => r.get("action").cloned().into_iter().collect(),
    };
    let mut kept: Option<PendingInteraction> = None;
    let mut extra = false;
    for a in &actions {
      let atype = str_of(a, "type").unwrap_or("");
      let mut pending = PendingInteraction {
        json: it.clone(),
        destination: None,
        manual: None,
      };
      let ok = match atype {
        "NODE" => {
          let action = match str_of(a, "navigation").unwrap_or("NAVIGATE") {
            "NAVIGATE" => "navigate",
            "OVERLAY" => "openOverlay",
            "SWAP" => "swapOverlay",
            "SCROLL_TO" => "scrollTo",
            "CHANGE_TO" => "changeTo",
            other => {
              self.note(&format!(
                "The {other} navigation isn't supported, so those interactions were skipped"
              ));
              continue;
            }
          };
          pending.json.insert("action".into(), json!(action));
          // A NODE action can arrive without its destination; the layer's own field has it.
          pending.destination = str_of(a, "destinationId").or(legacy).map(str::to_string);
          if let Some(o) = a.get("overlayRelativePosition") {
            pending.manual = Some((num(o, "x").unwrap_or(0.0), num(o, "y").unwrap_or(0.0)));
          }
          true
        }
        "BACK" => {
          pending.json.insert("action".into(), json!("back"));
          true
        }
        "CLOSE" => {
          pending.json.insert("action".into(), json!("closeOverlay"));
          true
        }
        "URL" => {
          pending.json.insert("action".into(), json!("openUrl"));
          let url = str_of(a, "url").unwrap_or("");
          match crate::model::safe_link(url) {
            Some(u) => {
              pending.json.insert("url".into(), json!(u));
              true
            }
            None => {
              self.note("Links that aren't http, https, mailto or tel were skipped");
              false
            }
          }
        }
        other => {
          self.note(&format!("The {other} action isn't supported and was skipped"));
          false
        }
      };
      if !ok {
        continue;
      }
      if kept.is_some() {
        extra = true;
        continue;
      }
      self.motion(a.get("transition"), unit, &mut pending.json);
      kept = Some(pending);
    }
    if extra {
      self.note("Interactions with several actions keep only the first one");
    }
    kept
  }

  /// The transition of an action: type, direction, duration and easing.
  fn motion(&mut self, t: Option<&Value>, unit: f64, out: &mut Map<String, Value>) {
    let t = t.filter(|t| !t.is_null());
    let ttype = t.and_then(|t| str_of(t, "type")).unwrap_or("");
    let dir = t
      .and_then(|t| str_of(t, "direction"))
      .map(|d| match d {
        "RIGHT" => "right",
        "TOP" => "up",
        "BOTTOM" => "down",
        _ => "left",
      })
      .unwrap_or("left");
    let kind = match ttype {
      "DISSOLVE" => "dissolve",
      "SMART_ANIMATE" => "smartAnimate",
      "MOVE_IN" => "moveIn",
      "MOVE_OUT" => "moveOut",
      "PUSH" => "push",
      "SLIDE_IN" | "SLIDE_OUT" => {
        self.note("Slide in/out transitions were approximated as Move in/out");
        if ttype == "SLIDE_IN" {
          "moveIn"
        } else {
          "moveOut"
        }
      }
      _ => "instant",
    };
    out.insert("transition".into(), json!(kind));
    if matches!(kind, "moveIn" | "moveOut" | "push") {
      out.insert("direction".into(), json!(dir));
    }
    if kind != "instant" {
      // A transition without a duration plays for 300 ms, like Figma's default.
      let d = t.and_then(|t| num(t, "duration")).map(|d| to_ms(d, unit)).unwrap_or(300.0);
      out.insert("durationMs".into(), json!(d));
      let easing = match t.and_then(|t| t.get("easing")).and_then(|e| str_of(e, "type")) {
        None | Some("EASE_OUT") => None,
        Some("EASE_IN") => Some("easeIn"),
        Some("EASE_IN_AND_OUT") => Some("easeInOut"),
        Some("LINEAR") => Some("linear"),
        Some("EASE_IN_BACK") => Some("easeInBack"),
        Some("EASE_OUT_BACK") => Some("easeOutBack"),
        Some("EASE_IN_AND_OUT_BACK") => Some("easeInOutBack"),
        Some(_) => {
          self.note("Springs, custom curves and named easings play as Ease out");
          None
        }
      };
      if let Some(e) = easing {
        out.insert("easing".into(), json!(e));
      }
    }
  }

  /// Remembers a frame's overlay settings; they belong to the frame, not to the links that open it.
  fn read_overlay(&mut self, fid: &str, f: &Value) {
    let mut m = Map::new();
    for k in ["overlayPositionType", "overlayBackground", "overlayBackgroundInteraction"] {
      if let Some(v) = f.get(k) {
        m.insert(k.to_string(), v.clone());
      }
    }
    if !m.is_empty() {
      self.overlays.insert(fid.to_string(), m);
    }
  }

  /// Overlay settings for a link, from the overlay frame's fields (Figma's defaults when it has none).
  fn overlay_settings(&self, dest: &str, manual: Option<(f64, f64)>) -> Value {
    let o = self.overlays.get(dest);
    let get = |k: &str| o.and_then(|o| o.get(k));
    let position = match get("overlayPositionType").and_then(|v| v.as_str()) {
      Some("TOP_LEFT") => "topLeft",
      Some("TOP_CENTER") => "topCenter",
      Some("TOP_RIGHT") => "topRight",
      Some("BOTTOM_LEFT") => "bottomLeft",
      Some("BOTTOM_CENTER") => "bottomCenter",
      Some("BOTTOM_RIGHT") => "bottomRight",
      Some("MANUAL") => "manual",
      _ if manual.is_some() => "manual",
      _ => "center",
    };
    let background = match get("overlayBackground") {
      Some(b) if str_of(b, "type") == Some("SOLID_COLOR") => {
        let c = b.get("color").unwrap_or(&Value::Null);
        let rgb = format!(
          "#{}{}{}",
          hex2(num(c, "r").unwrap_or(0.0)),
          hex2(num(c, "g").unwrap_or(0.0)),
          hex2(num(c, "b").unwrap_or(0.0))
        );
        json!({ "color": rgb, "opacity": num(c, "a").unwrap_or(1.0) })
      }
      _ => Value::Null,
    };
    let (dx, dy) = if position == "manual" {
      manual.unwrap_or((0.0, 0.0))
    } else {
      (0.0, 0.0)
    };
    json!({
      "position": position,
      "offsetX": dx,
      "offsetY": dy,
      "closeOnClickOutside": get("overlayBackgroundInteraction").and_then(|v| v.as_str()) == Some("CLOSE_ON_CLICK_OUTSIDE"),
      "background": background,
    })
  }

  fn link_prototypes(&mut self) {
    for (from, p) in std::mem::take(&mut self.links) {
      let mut json = p.json;
      let action = json.get("action").and_then(|a| a.as_str()).unwrap_or("navigate").to_string();
      let needs_destination = matches!(
        action.as_str(),
        "navigate" | "openOverlay" | "swapOverlay" | "scrollTo" | "changeTo"
      );
      if needs_destination {
        let Some(fig_dest) = p.destination else {
          self.note("Interactions without a destination were skipped");
          continue;
        };
        let Some(to) = self.map.get(&fig_dest).cloned() else {
          self.note("Interactions whose destination isn't in this import were skipped");
          continue;
        };
        if action == "changeTo" {
          let is_variant = self.doc.get(&to).is_some_and(|d| {
            d.kind == NodeType::Component
              && d
                .parent
                .as_ref()
                .and_then(|p| self.doc.get(p))
                .is_some_and(|p| p.kind == NodeType::ComponentSet)
          });
          if !is_variant {
            self.note("Change to interactions whose destination isn't a variant were skipped");
            continue;
          }
        }
        if matches!(action.as_str(), "openOverlay" | "swapOverlay") {
          json.insert("overlay".into(), self.overlay_settings(&fig_dest, p.manual));
        }
        json.insert("destination".into(), json!(to));
      }
      if let Some(n) = self.doc.get_mut(&from) {
        if let Ok(i) = serde_json::from_value(Value::Object(json)) {
          n.interactions.push(i);
        }
      }
    }
  }

  fn note(&mut self, template: &str) {
    *self.proto_notes.entry(template.to_string()).or_insert(0) += 1;
  }

  /// Adds what the import left out or changed to the warnings, one line each with its count.
  fn report(&mut self) {
    if self.slices > 0 {
      let n = self.slices;
      self.warnings.push(if n == 1 {
        "1 slice was skipped (Designotron has no slices)".to_string()
      } else {
        format!("{n} slices were skipped (Designotron has no slices)")
      });
    }
    if self.library_instances > 0 {
      let n = self.library_instances;
      self.warnings.push(if n == 1 {
        "1 instance of a library component became a frame (its main component isn't in this file)".to_string()
      } else {
        format!("{n} instances of library components became frames (their main components aren't in this file)")
      });
    }
    for (reason, n) in std::mem::take(&mut self.proto_notes) {
      self.warnings.push(if n == 1 { reason } else { format!("{reason} (×{n})") });
    }
  }
}

/// A Figma time as milliseconds, kept within 0 to 10 s. The plugin API counts seconds (`unit`
/// 1000); REST counts ms, but a value under 20 there can only be seconds (a 20 ms transition
/// isn't one anyone draws).
fn to_ms(v: f64, unit: f64) -> f64 {
  // REST values are whole milliseconds; a small fractional one (0.3) was written in seconds.
  // "After delay 1 ms" is a common auto-advance trick, so a whole 1 stays 1 ms.
  let ms = if unit == 1.0 && v > 0.0 && v < 20.0 && v.fract() != 0.0 {
    v * 1000.0
  } else {
    v * unit
  };
  if ms.is_finite() {
    ms.clamp(0.0, 10_000.0).round()
  } else {
    0.0
  }
}

fn fid_of(f: &Value) -> String {
  str_of(f, "id").unwrap_or("").to_string()
}

/// A key trigger's `keyCodes` (modifier codes and one key) as the key name the player uses ("Shift+K").
fn key_name(trigger: &Value) -> Option<String> {
  let (mut ctrl, mut alt, mut shift, mut meta) = (false, false, false, false);
  let mut key: Option<String> = None;
  for c in trigger.get("keyCodes")?.as_array()? {
    let code = c.as_u64()?;
    let k = match code {
      16 => {
        shift = true;
        continue;
      }
      17 => {
        ctrl = true;
        continue;
      }
      18 => {
        alt = true;
        continue;
      }
      91 | 93 | 224 => {
        meta = true;
        continue;
      }
      8 => "Backspace".to_string(),
      9 => "Tab".to_string(),
      13 => "Enter".to_string(),
      27 => "Escape".to_string(),
      32 => "Space".to_string(),
      33 => "PageUp".to_string(),
      34 => "PageDown".to_string(),
      35 => "End".to_string(),
      36 => "Home".to_string(),
      37 => "ArrowLeft".to_string(),
      38 => "ArrowUp".to_string(),
      39 => "ArrowRight".to_string(),
      40 => "ArrowDown".to_string(),
      46 => "Delete".to_string(),
      48..=57 | 65..=90 => char::from_u32(code as u32)?.to_string(),
      _ => return None,
    };
    if key.replace(k).is_some() {
      return None;
    }
  }
  let key = key?;
  let mut out = String::new();
  for (on, m) in [(ctrl, "Ctrl"), (alt, "Alt"), (shift, "Shift"), (meta, "Meta")] {
    if on {
      out.push_str(m);
      out.push('+');
    }
  }
  out.push_str(&key);
  Some(out)
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

/// `gradientHandlePositions` (start, end, width in the layer's unit box) as our handles.
fn handles(p: &Value) -> Option<Value> {
  let hs = p.get("gradientHandlePositions")?.as_array()?;
  if hs.len() < 3 {
    return None;
  }
  let pt = |i: usize| json!([num(&hs[i], "x").unwrap_or(0.0), num(&hs[i], "y").unwrap_or(0.0)]);
  Some(json!({ "start": pt(0), "end": pt(1), "width": pt(2) }))
}

/// Where the whole image sits in the layer for a `CROP` paint: `imageTransform` maps layer
/// units to image units, so the image rectangle is its inverse. Only without rotation.
fn crop_rect(p: &Value) -> Option<Value> {
  let t = p.get("imageTransform")?.as_array()?;
  let at = |r: usize, c: usize| t.get(r).and_then(|row| row.get(c)).and_then(|v| v.as_f64());
  let (a, b, tx, c, d, ty) = (at(0, 0)?, at(0, 1)?, at(0, 2)?, at(1, 0)?, at(1, 1)?, at(1, 2)?);
  if a.abs() < 1e-6 || d.abs() < 1e-6 || b.abs() > 1e-6 || c.abs() > 1e-6 {
    return None;
  }
  Some(json!({ "x": -tx / a, "y": -ty / d, "w": 1.0 / a, "h": 1.0 / d }))
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

  #[test]
  fn imports_angular_gradients_individual_strokes_and_crop() {
    let stops = json!([
      { "position": 0, "color": { "r": 1, "g": 0, "b": 0, "a": 1 } },
      { "position": 1, "color": { "r": 0, "g": 0, "b": 1, "a": 1 } }
    ]);
    let file = json!({
      "name": "Paint",
      "document": { "id": "0:0", "type": "DOCUMENT", "children": [{
        "id": "0:1", "type": "CANVAS", "name": "P", "children": [
          { "id": "1:1", "type": "RECTANGLE", "name": "Sweep",
            "absoluteBoundingBox": { "x": 0, "y": 0, "width": 100, "height": 60 }, "size": { "x": 100, "y": 60 },
            "relativeTransform": [[1, 0, 0], [0, 1, 0]],
            "fills": [
              { "type": "GRADIENT_ANGULAR", "gradientStops": stops,
                "gradientHandlePositions": [{ "x": 0.5, "y": 0.5 }, { "x": 1, "y": 0.5 }, { "x": 0.5, "y": 1 }] },
              { "type": "GRADIENT_DIAMOND", "gradientStops": stops }
            ],
            "strokes": [{ "type": "SOLID", "color": { "r": 0, "g": 0, "b": 0, "a": 1 } }], "strokeWeight": 4,
            "individualStrokeWeights": { "top": 4, "right": 0, "bottom": 1, "left": 2 }, "strokeJoin": "BEVEL" }
        ] }] }
    });
    let mut gen = IdGen::new(7);
    let mut doc = new_document(&mut gen, "x");
    import(&mut doc, &mut gen, &file, &BTreeMap::new()).unwrap();
    let n = doc.nodes.values().find(|n| n.name == "Sweep").unwrap();
    match &n.fills[0] {
      crate::model::Paint::AngularGradient { handles: Some(h), .. } => assert_eq!(h.end, [1.0, 0.5]),
      other => panic!("{other:?}"),
    }
    assert!(matches!(&n.fills[1], crate::model::Paint::DiamondGradient { handles: None, .. }));
    assert_eq!(n.stroke_weights, Some([4.0, 0.0, 1.0, 2.0]));
    assert_eq!(n.stroke_join, Some(crate::model::StrokeJoin::Bevel));
  }

  #[test]
  fn crop_transforms_invert_into_image_rectangles() {
    let p = json!({ "imageTransform": [[0.5, 0, 0.25], [0, 0.5, 0.1]] });
    let c = crop_rect(&p).unwrap();
    assert_eq!((c["x"].as_f64(), c["w"].as_f64()), (Some(-0.5), Some(2.0)));
    assert!((c["y"].as_f64().unwrap() + 0.2).abs() < 1e-9);
    assert!(crop_rect(&json!({ "imageTransform": [[0, 1, 0], [1, 0, 0]] })).is_none());
  }

  // ---------- prototype interactions ----------

  fn rect(id: &str, name: &str, extra: Value) -> Value {
    let mut v = json!({
      "id": id, "type": "RECTANGLE", "name": name,
      "absoluteBoundingBox": { "x": 0, "y": 0, "width": 50, "height": 20 }, "size": { "x": 50, "y": 20 },
      "relativeTransform": [[1, 0, 0], [0, 1, 0]]
    });
    v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    v
  }

  fn frame(id: &str, name: &str, extra: Value, kids: Vec<Value>) -> Value {
    let mut v = json!({
      "id": id, "type": "FRAME", "name": name,
      "absoluteBoundingBox": { "x": 0, "y": 0, "width": 300, "height": 400 }, "size": { "x": 300, "y": 400 },
      "relativeTransform": [[1, 0, 0], [0, 1, 0]], "children": kids
    });
    v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    v
  }

  fn proto_file(kids: Vec<Value>) -> Value {
    json!({ "name": "P", "document": { "id": "0:0", "type": "DOCUMENT", "children": [{ "id": "0:1", "type": "CANVAS", "name": "C", "children": kids }] } })
  }

  fn run(file: &Value) -> (Document, Value) {
    let mut gen = IdGen::new(7);
    let mut doc = new_document(&mut gen, "x");
    let r = import(&mut doc, &mut gen, file, &BTreeMap::new()).unwrap();
    (doc, r)
  }

  fn named(doc: &Document, name: &str) -> Node {
    // `copy_of` takes a `&Node` or a `&Arc<Node>` alike.
    fn copy_of(n: &Node) -> Node {
      n.clone()
    }
    copy_of(
      doc
        .nodes
        .values()
        .find(|n| n.name == name)
        .unwrap_or_else(|| panic!("no layer {name}")),
    )
  }

  fn warnings(r: &Value) -> Vec<String> {
    r["warnings"]
      .as_array()
      .unwrap()
      .iter()
      .map(|w| w.as_str().unwrap().to_string())
      .collect()
  }

  fn click(actions: Value) -> Value {
    json!({ "interactions": [{ "trigger": { "type": "ON_CLICK" }, "actions": actions }] })
  }

  fn go(id: &str) -> Value {
    json!([{ "type": "NODE", "destinationId": id, "navigation": "NAVIGATE" }])
  }

  #[test]
  fn imports_rest_interactions_field_by_field() {
    use crate::model::{Action, Direction, Easing, OverlayPosition, Transition, Trigger};
    let file = proto_file(vec![
      frame(
        "1:1",
        "Home",
        json!({}),
        vec![
          rect(
            "1:2",
            "Open",
            click(json!([{
              "type": "NODE", "destinationId": "5:1", "navigation": "OVERLAY",
              "overlayRelativePosition": { "x": 10, "y": 20 },
              "transition": { "type": "MOVE_IN", "direction": "BOTTOM", "duration": 250, "easing": { "type": "EASE_IN_AND_OUT" } }
            }])),
          ),
          rect(
            "1:3",
            "Hover",
            json!({ "interactions": [{ "trigger": { "type": "ON_HOVER" }, "actions": [{
          "type": "NODE", "destinationId": "2:1", "navigation": "NAVIGATE",
          "transition": { "type": "SMART_ANIMATE", "duration": 300, "easing": { "type": "EASE_IN_AND_OUT" } }
        }] }] }),
          ),
          rect(
            "1:4",
            "Wait",
            json!({ "interactions": [{ "trigger": { "type": "AFTER_TIMEOUT", "timeout": 1500 }, "actions": go("2:1") }] }),
          ),
          rect(
            "1:5",
            "Key",
            json!({ "interactions": [{ "trigger": { "type": "ON_KEY_DOWN", "device": "KEYBOARD", "keyCodes": [16, 75] }, "actions": go("2:1") }] }),
          ),
          rect("1:6", "Back", click(json!([{ "type": "BACK" }]))),
          rect("1:7", "Link", click(json!([{ "type": "URL", "url": "https://example.com/x" }]))),
          rect(
            "1:8",
            "Variant",
            click(
              json!([{ "type": "NODE", "destinationId": "7:2", "navigation": "CHANGE_TO", "transition": { "type": "DISSOLVE", "duration": 200 } }]),
            ),
          ),
          rect("1:9", "Close", click(json!([{ "type": "CLOSE" }]))),
          rect(
            "1:10",
            "Swap",
            click(json!([{ "type": "NODE", "destinationId": "5:1", "navigation": "SWAP" }])),
          ),
          rect(
            "1:11",
            "Scroll",
            click(
              json!([{ "type": "NODE", "destinationId": "1:2", "navigation": "SCROLL_TO", "transition": { "type": "SCROLL_ANIMATE" } }]),
            ),
          ),
        ],
      ),
      frame("2:1", "Next", json!({}), vec![]),
      frame(
        "5:1",
        "Dialog",
        json!({
          "overlayPositionType": "MANUAL",
          "overlayBackground": { "type": "SOLID_COLOR", "color": { "r": 0, "g": 0, "b": 1, "a": 0.5 } },
          "overlayBackgroundInteraction": "CLOSE_ON_CLICK_OUTSIDE"
        }),
        vec![],
      ),
      json!({ "id": "7:0", "type": "COMPONENT_SET", "name": "Toggle", "absoluteBoundingBox": { "x": 0, "y": 0, "width": 100, "height": 40 }, "children": [
        { "id": "7:1", "type": "COMPONENT", "name": "State=Off", "absoluteBoundingBox": { "x": 0, "y": 0, "width": 40, "height": 40 }, "children": [] },
        { "id": "7:2", "type": "COMPONENT", "name": "State=On", "absoluteBoundingBox": { "x": 50, "y": 0, "width": 40, "height": 40 }, "children": [] }
      ] }),
    ]);
    let (doc, r) = run(&file);
    assert!(warnings(&r).is_empty(), "{:?}", warnings(&r));
    let only = |name: &str| {
      let n = named(&doc, name);
      assert_eq!(n.interactions.len(), 1, "{name}");
      n.interactions[0].clone()
    };
    let id_of = |name: &str| named(&doc, name).id;

    let open = only("Open");
    assert_eq!((open.trigger, open.action), (Trigger::OnClick, Action::OpenOverlay));
    assert_eq!(open.destination, Some(id_of("Dialog")));
    assert_eq!(
      (open.transition, open.direction, open.duration_ms, open.easing),
      (Transition::MoveIn, Direction::Down, 250.0, Easing::EaseInOut)
    );
    assert_eq!(open.overlay.position, OverlayPosition::Manual);
    assert_eq!((open.overlay.offset_x, open.overlay.offset_y), (10.0, 20.0));
    assert!(open.overlay.close_on_click_outside);
    let bg = open.overlay.background.clone().unwrap();
    assert_eq!((bg.color.as_str(), bg.opacity), ("#0000FF", 0.5));

    let hover = only("Hover");
    assert_eq!(
      (hover.trigger, hover.action, hover.destination.clone()),
      (Trigger::OnHover, Action::Navigate, Some(id_of("Next")))
    );
    assert_eq!(
      (hover.transition, hover.duration_ms, hover.easing),
      (Transition::SmartAnimate, 300.0, Easing::EaseInOut)
    );

    let wait = only("Wait");
    assert_eq!(
      (wait.trigger, wait.delay_ms, wait.transition),
      (Trigger::AfterDelay, 1500.0, Transition::Instant)
    );

    let key = only("Key");
    assert_eq!((key.trigger, key.key.as_deref()), (Trigger::Key, Some("Shift+K")));

    assert_eq!(only("Back").action, Action::Back);
    let link = only("Link");
    assert_eq!((link.action, link.url.as_deref()), (Action::OpenUrl, Some("https://example.com/x")));
    let variant = only("Variant");
    assert_eq!(
      (variant.action, variant.destination.clone(), variant.transition, variant.duration_ms),
      (Action::ChangeTo, Some(id_of("State=On")), Transition::Dissolve, 200.0)
    );
    assert_eq!(only("Close").action, Action::CloseOverlay);
    let swap = only("Swap");
    assert_eq!((swap.action, swap.overlay.position), (Action::SwapOverlay, OverlayPosition::Manual));
    let scroll = only("Scroll");
    assert_eq!((scroll.action, scroll.transition), (Action::ScrollTo, Transition::Instant));
  }

  #[test]
  fn plugin_reactions_use_seconds_and_a_single_action() {
    use crate::model::{Action, Easing, Transition};
    // The shape the QA round's figma-rich.json uses: `reactions`, one `action`, seconds.
    let file = proto_file(vec![
      frame(
        "1:1",
        "Home",
        json!({}),
        vec![rect(
          "1:2",
          "Go",
          json!({ "reactions": [{
        "trigger": { "type": "ON_CLICK" },
        "action": { "type": "NODE", "destinationId": "2:1", "navigation": "NAVIGATE", "transition": { "type": "DISSOLVE", "duration": 0.3, "easing": { "type": "EASE_OUT" } } }
      }, {
        "trigger": { "type": "AFTER_TIMEOUT", "timeout": 2 },
        "actions": [{ "type": "NODE", "destinationId": "2:1", "navigation": "NAVIGATE", "transition": { "type": "PUSH", "direction": "RIGHT", "duration": 0.5, "easing": { "type": "LINEAR" } } }]
      }] }),
        )],
      ),
      frame("2:1", "Next", json!({}), vec![]),
    ]);
    let (doc, r) = run(&file);
    assert!(warnings(&r).is_empty());
    let go = named(&doc, "Go");
    assert_eq!(go.interactions.len(), 2);
    let a = &go.interactions[0];
    assert_eq!(
      (a.action, a.transition, a.duration_ms, a.easing),
      (Action::Navigate, Transition::Dissolve, 300.0, Easing::EaseOut)
    );
    let b = &go.interactions[1];
    assert_eq!(
      (b.delay_ms, b.transition, b.duration_ms, b.easing),
      (2000.0, Transition::Push, 500.0, Easing::Linear)
    );
    assert_eq!(b.direction, crate::model::Direction::Right);
  }

  #[test]
  fn transition_node_id_alone_still_links_and_fills_in_a_null_destination() {
    use crate::model::{Action, Transition};
    let mut null = rect(
      "1:3",
      "Null",
      click(json!([{ "type": "NODE", "destinationId": null, "navigation": "NAVIGATE" }])),
    );
    null.as_object_mut().unwrap().insert("transitionNodeID".into(), json!("2:1"));
    let file = proto_file(vec![
      frame(
        "1:1",
        "Home",
        json!({}),
        vec![
          rect(
            "1:2",
            "Legacy",
            json!({ "transitionNodeID": "2:1", "transitionDuration": 400, "transitionEasing": "EASE_IN" }),
          ),
          null,
          // Real interactions win over the legacy field.
          rect(
            "1:4",
            "Both",
            json!({ "transitionNodeID": "1:1", "interactions": [{ "trigger": { "type": "ON_PRESS" }, "actions": go("2:1") }] }),
          ),
        ],
      ),
      frame("2:1", "Next", json!({}), vec![]),
    ]);
    let (doc, r) = run(&file);
    assert!(warnings(&r).is_empty(), "{:?}", warnings(&r));
    let next = named(&doc, "Next").id;
    let legacy = &named(&doc, "Legacy").interactions;
    assert_eq!(legacy.len(), 1);
    assert_eq!(
      (
        legacy[0].action,
        legacy[0].destination.clone(),
        legacy[0].transition,
        legacy[0].duration_ms
      ),
      (Action::Navigate, Some(next.clone()), Transition::Dissolve, 400.0)
    );
    assert_eq!(legacy[0].easing, crate::model::Easing::EaseIn);
    let null = &named(&doc, "Null").interactions;
    assert_eq!((null.len(), null[0].destination.clone()), (1, Some(next.clone())));
    let both = &named(&doc, "Both").interactions;
    assert_eq!(
      (both.len(), both[0].trigger, both[0].destination.clone()),
      (1, crate::model::Trigger::OnPress, Some(next))
    );
  }

  #[test]
  fn unsupported_triggers_actions_and_destinations_warn_with_counts() {
    let drag = |id: &str, name: &str| {
      rect(
        id,
        name,
        json!({ "interactions": [{ "trigger": { "type": "ON_DRAG" }, "actions": go("1:1") }] }),
      )
    };
    let nav = |t: Value| click(json!([{ "type": "NODE", "destinationId": "1:1", "navigation": "NAVIGATE", "transition": t }]));
    let file = proto_file(vec![frame(
      "1:1",
      "Home",
      json!({}),
      vec![
        drag("1:2", "Drag"),
        drag("1:3", "Drag2"),
        rect("1:4", "Var", click(json!([{ "type": "SET_VARIABLE", "variableId": "v" }]))),
        rect(
          "1:5",
          "Mixed",
          click(
            json!([{ "type": "SET_VARIABLE" }, { "type": "NODE", "destinationId": "1:1", "navigation": "NAVIGATE" }, { "type": "BACK" }]),
          ),
        ),
        rect("1:6", "Gone", click(go("9:9"))),
        rect(
          "1:7",
          "NotVariant",
          click(json!([{ "type": "NODE", "destinationId": "1:1", "navigation": "CHANGE_TO" }])),
        ),
        rect("1:8", "Spring", nav(json!({ "type": "DISSOLVE", "easing": { "type": "GENTLE" } }))),
        rect("1:9", "Slide", nav(json!({ "type": "SLIDE_IN", "direction": "TOP" }))),
        rect(
          "1:10",
          "Keys",
          json!({ "interactions": [{ "trigger": { "type": "ON_KEY_DOWN", "keyCodes": [112] }, "actions": go("1:1") }] }),
        ),
      ],
    )]);
    let (doc, r) = run(&file);
    let w = warnings(&r);
    let has = |s: &str| w.iter().any(|x| x.contains(s));
    assert!(w.iter().any(|x| x.contains("ON_DRAG") && x.ends_with("(×2)")), "{w:?}");
    assert!(has("SET_VARIABLE action isn't supported"), "{w:?}");
    assert!(has("several actions keep only the first"), "{w:?}");
    assert!(has("destination isn't in this import"), "{w:?}");
    assert!(has("isn't a variant"), "{w:?}");
    assert!(has("named easings"), "{w:?}");
    assert!(has("Slide in/out"), "{w:?}");
    assert!(has("Key triggers"), "{w:?}");
    // What can be kept is kept.
    assert_eq!(named(&doc, "Drag").interactions.len(), 0);
    assert_eq!(named(&doc, "Var").interactions.len(), 0);
    let mixed = named(&doc, "Mixed").interactions;
    assert_eq!((mixed.len(), mixed[0].action), (1, crate::model::Action::Navigate));
    let slide = &named(&doc, "Slide").interactions[0];
    assert_eq!(
      (slide.transition, slide.direction),
      (crate::model::Transition::MoveIn, crate::model::Direction::Up)
    );
  }

  #[test]
  fn overlay_frames_without_settings_use_figmas_defaults() {
    let file = proto_file(vec![
      frame(
        "1:1",
        "Home",
        json!({}),
        vec![rect(
          "1:2",
          "Open",
          click(json!([{ "type": "NODE", "destinationId": "5:1", "navigation": "OVERLAY" }])),
        )],
      ),
      frame("5:1", "Plain", json!({}), vec![]),
    ]);
    let (doc, _) = run(&file);
    let o = &named(&doc, "Open").interactions[0].overlay;
    assert_eq!(o.position, crate::model::OverlayPosition::Center);
    assert!(o.background.is_none() && !o.close_on_click_outside);
  }

  #[test]
  fn warns_about_slices_and_library_instances_with_counts() {
    let lib = |id: &str| {
      json!({
        "id": id, "type": "INSTANCE", "name": "Lib", "componentId": "99:1",
        "absoluteBoundingBox": { "x": 0, "y": 0, "width": 24, "height": 24 }, "size": { "x": 24, "y": 24 }, "children": []
      })
    };
    let slice = |id: &str| json!({ "id": id, "type": "SLICE", "name": "Slice", "absoluteBoundingBox": { "x": 0, "y": 0, "width": 24, "height": 24 } });
    let (_, r) = run(&proto_file(vec![frame(
      "1:1",
      "Home",
      json!({}),
      vec![lib("1:2"), lib("1:3"), lib("1:4"), slice("1:5"), slice("1:6")],
    )]));
    let w = warnings(&r);
    assert!(
      w.contains(&"3 instances of library components became frames (their main components aren't in this file)".to_string()),
      "{w:?}"
    );
    assert!(
      w.contains(&"2 slices were skipped (Designotron has no slices)".to_string()),
      "{w:?}"
    );
    let (_, r) = run(&proto_file(vec![frame("1:1", "Home", json!({}), vec![lib("1:2"), slice("1:5")])]));
    let w = warnings(&r);
    assert!(w.iter().any(|x| x.starts_with("1 instance of a library component")), "{w:?}");
    assert!(w.iter().any(|x| x.starts_with("1 slice was skipped")), "{w:?}");
    // The sample file has one library instance and nothing else to report.
    let (_, r) = run(&file());
    assert_eq!(warnings(&r).len(), 1, "{:?}", warnings(&r));
  }

  #[test]
  fn key_codes_become_key_names() {
    let k = |codes: Value| key_name(&json!({ "keyCodes": codes }));
    assert_eq!(k(json!([13])).as_deref(), Some("Enter"));
    assert_eq!(k(json!([27])).as_deref(), Some("Escape"));
    assert_eq!(k(json!([32])).as_deref(), Some("Space"));
    assert_eq!(k(json!([8])).as_deref(), Some("Backspace"));
    assert_eq!(k(json!([9])).as_deref(), Some("Tab"));
    assert_eq!(k(json!([37])).as_deref(), Some("ArrowLeft"));
    assert_eq!(k(json!([40])).as_deref(), Some("ArrowDown"));
    assert_eq!(k(json!([48])).as_deref(), Some("0"));
    assert_eq!(k(json!([65])).as_deref(), Some("A"));
    assert_eq!(k(json!([17, 18, 16, 91, 75])).as_deref(), Some("Ctrl+Alt+Shift+Meta+K"));
    assert_eq!(k(json!([75, 16])).as_deref(), Some("Shift+K"));
    assert_eq!(k(json!([112])), None);
    assert_eq!(k(json!([16])), None, "a modifier alone");
    assert_eq!(k(json!([65, 66])), None, "two keys");
    assert_eq!(key_name(&json!({})), None);
  }

  #[test]
  fn times_are_clamped_and_rest_seconds_are_recognised() {
    assert_eq!(to_ms(0.3, 1000.0), 300.0);
    assert_eq!(to_ms(300.0, 1.0), 300.0);
    assert_eq!(to_ms(0.3, 1.0), 300.0, "a fractional REST value under 20 is seconds");
    assert_eq!(to_ms(1.0, 1.0), 1.0, "After delay 1 ms stays 1 ms");
    assert_eq!(to_ms(16.0, 1.0), 16.0);
    assert_eq!(to_ms(1e9, 1.0), 10_000.0);
    assert_eq!(to_ms(-5.0, 1.0), 0.0);
    assert_eq!(to_ms(f64::NAN, 1.0), 0.0);
    let file = proto_file(vec![frame(
      "1:1",
      "Home",
      json!({}),
      vec![
        rect(
          "1:2",
          "A",
          click(json!([{ "type": "NODE", "destinationId": "1:1", "navigation": "NAVIGATE", "transition": { "type": "DISSOLVE" } }])),
        ),
        rect("1:3", "B", click(json!([{ "type": "URL", "url": "javascript:alert(1)" }]))),
        rect("1:4", "C", click(json!([{ "type": "URL", "url": "https://example.com" }]))),
      ],
    )]);
    let (doc, r) = run(&file);
    assert_eq!(named(&doc, "A").interactions[0].duration_ms, 300.0, "a missing duration is 300 ms");
    assert_eq!(named(&doc, "B").interactions.len(), 0);
    assert!(warnings(&r).iter().any(|w| w.contains("aren't http")), "{:?}", warnings(&r));
    assert_eq!(named(&doc, "C").interactions[0].url.as_deref(), Some("https://example.com"));
  }
}
