//! Lenient but loud parsing of tool input. Values models commonly get wrong (strings for numbers,
//! CSS spellings, Figma property names) are accepted when the meaning is clear and mapped with a
//! warning when they are not part of the schema; anything else is rejected with the path of the
//! field and the accepted values, so a wrong design never comes back as a success.

use std::fmt::Display;

use serde_json::{json, Map, Value};

use crate::model::NodeType;

/// Most warnings a call reports; the rest are counted.
const MAX_WARNINGS: usize = 20;

/// Every key a layer spec understands (plus the keys of `update_nodes` items).
pub const KNOWN_KEYS: &[&str] = &[
  "id",
  "patch",
  "type",
  "name",
  "x",
  "y",
  "width",
  "height",
  "rotation",
  "opacity",
  "visible",
  "locked",
  "clip",
  "overflow",
  "scrollBehavior",
  "absolute",
  "minWidth",
  "maxWidth",
  "minHeight",
  "maxHeight",
  "bind",
  "variableModes",
  "device",
  "layoutGrids",
  "notes",
  "color",
  "fill",
  "background",
  "fills",
  "imageUrl",
  "src",
  "stroke",
  "strokeWidth",
  "strokeAlign",
  "strokeDash",
  "strokeWeights",
  "strokeJoin",
  "cornerRadius",
  "shadow",
  "blur",
  "backgroundBlur",
  "layout",
  "text",
  "characters",
  "spans",
  "fontSize",
  "fontWeight",
  "fontFamily",
  "lineHeight",
  "letterSpacing",
  "italic",
  "textAlign",
  "verticalAlign",
  "textCase",
  "decoration",
  "autoResize",
  "maxLines",
  "truncate",
  "paragraphSpacing",
  "svgPath",
  "viewBox",
  "points",
  "closed",
  "pointCount",
  "children",
  "componentId",
  "fillStyle",
  "strokeStyle",
  "effectStyle",
  "gridStyle",
  "textStyle",
];

/// Keys that only mean something on text layers.
const TEXT_KEYS: &[&str] = &[
  "text",
  "characters",
  "spans",
  "fontSize",
  "fontWeight",
  "fontFamily",
  "lineHeight",
  "letterSpacing",
  "italic",
  "textAlign",
  "verticalAlign",
  "textCase",
  "decoration",
  "autoResize",
  "maxLines",
  "truncate",
  "paragraphSpacing",
  "textStyle",
];

/// Layout properties written at the top level of a frame instead of inside `layout`.
const LAYOUT_KEYS: &[&str] = &[
  "gap",
  "padding",
  "direction",
  "align",
  "crossAlign",
  "justify",
  "alignItems",
  "wrap",
  "counterGap",
];

/// Keys of the `layout` object.
pub const LAYOUT_OBJECT_KEYS: &[&str] = &[
  "direction",
  "gap",
  "counterGap",
  "padding",
  "align",
  "justify",
  "justifyContent",
  "crossAlign",
  "alignItems",
  "wrap",
];

/// Names other tools use for properties we have under another name.
const ALIASES: &[(&str, &str)] = &[
  ("layoutMode", "layout.direction"),
  ("itemSpacing", "layout.gap"),
  ("paddingLeft", "layout.padding"),
  ("paddingRight", "layout.padding"),
  ("paddingTop", "layout.padding"),
  ("paddingBottom", "layout.padding"),
  ("primaryAxisAlignItems", "layout.align"),
  ("counterAxisAlignItems", "layout.crossAlign"),
  ("layoutSizing", "width and height ('fill' or 'hug')"),
  ("backgroundColor", "fill"),
  ("bg", "fill"),
  ("borderRadius", "cornerRadius"),
  ("radius", "cornerRadius"),
  ("borderColor", "stroke"),
  ("borderWidth", "strokeWidth"),
  ("boxShadow", "shadow"),
  ("textColor", "color"),
  ("fontColor", "color"),
  ("w", "width"),
  ("h", "height"),
  ("content", "text"),
  ("label", "text"),
  ("font", "fontFamily"),
  ("size", "fontSize"),
  ("fontStyle", "italic"),
  ("itemSpacingVertical", "layout.gap"),
];

/// Where a value sits in the call (`nodes[0].children[2]`), the warnings so far and the named layers made.
pub struct Ctx {
  path: String,
  warnings: Vec<(String, String, usize)>,
  /// (name, id) of named layers below the top level of a create call, in creation order.
  pub names: Vec<(String, String)>,
}

impl Ctx {
  pub fn new() -> Ctx {
    Ctx {
      path: String::new(),
      warnings: Vec::new(),
      names: Vec::new(),
    }
  }

  /// Appends a path segment; hand the mark back to `leave`.
  pub fn enter(&mut self, seg: &str) -> usize {
    let mark = self.path.len();
    if !self.path.is_empty() && !seg.starts_with('[') {
      self.path.push('.');
    }
    self.path.push_str(seg);
    mark
  }

  pub fn leave(&mut self, mark: usize) {
    self.path.truncate(mark);
  }

  /// `path.key`, or just `key` at the top.
  pub fn field(&self, key: &str) -> String {
    match (self.path.is_empty(), key.is_empty()) {
      (true, _) => key.to_string(),
      (false, true) => self.path.clone(),
      (false, false) => format!("{}.{key}", self.path),
    }
  }

  pub fn err(&self, key: &str, msg: impl Display) -> String {
    let at = self.field(key);
    if at.is_empty() {
      msg.to_string()
    } else {
      format!("{at}: {msg}")
    }
  }

  /// Records a warning for the current layer; the same message on many layers is reported once.
  pub fn warn(&mut self, msg: impl Display) {
    let msg = msg.to_string();
    if let Some(w) = self.warnings.iter_mut().find(|w| w.1 == msg) {
      w.2 += 1;
    } else {
      self.warnings.push((self.path.clone(), msg, 1));
    }
  }

  pub fn into_warnings(self) -> Vec<String> {
    let total = self.warnings.len();
    let mut out: Vec<String> = self
      .warnings
      .into_iter()
      .take(MAX_WARNINGS)
      .map(|(path, msg, n)| {
        let more = if n > 1 {
          format!(" (and {} more layers)", n - 1)
        } else {
          String::new()
        };
        if path.is_empty() {
          format!("{msg}{more}")
        } else {
          format!("{path}: {msg}{more}")
        }
      })
      .collect();
    if total > MAX_WARNINGS {
      out.push(format!("...and {} more warnings", total - MAX_WARNINGS));
    }
    out
  }
}

impl Default for Ctx {
  fn default() -> Self {
    Ctx::new()
  }
}

/// A width or height: fixed pixels, fill the parent or hug the content.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Dim {
  Px(f64),
  Fill,
  Hug,
}

/// Corner radius: one value, or one per corner (top-left, top-right, bottom-right, bottom-left).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Radius {
  All(f64),
  Each([f64; 4]),
}

pub fn kind_of(v: &Value) -> &'static str {
  match v {
    Value::Null => "null",
    Value::Bool(_) => "a boolean",
    Value::Number(_) => "a number",
    Value::String(_) => "a string",
    Value::Array(_) => "an array",
    Value::Object(_) => "an object",
  }
}

/// A number: JSON number, numeric string or "24px".
pub fn number(cx: &Ctx, key: &str, v: &Value) -> Result<f64, String> {
  match v {
    Value::Number(n) => n
      .as_f64()
      .filter(|x| x.is_finite())
      .ok_or_else(|| cx.err(key, "must be a finite number")),
    Value::String(s) => px(s).ok_or_else(|| cx.err(key, format!("\"{s}\" isn't a number; use a number like 24 (or \"24px\")"))),
    other => Err(cx.err(key, format!("expected a number, got {}", kind_of(other)))),
  }
}

/// `spec[key]` as a number; absent and null are None.
pub fn opt_number(cx: &Ctx, s: &Value, key: &str) -> Result<Option<f64>, String> {
  match s.get(key) {
    None | Some(Value::Null) => Ok(None),
    Some(v) => number(cx, key, v).map(Some),
  }
}

/// `spec[key]` as a boolean; "true" and "false" are read too. Absent and null are None.
pub fn opt_bool(cx: &Ctx, s: &Value, key: &str) -> Result<Option<bool>, String> {
  match s.get(key) {
    None | Some(Value::Null) => Ok(None),
    Some(Value::Bool(b)) => Ok(Some(*b)),
    Some(Value::Number(n)) if n.as_f64() == Some(1.0) => Ok(Some(true)),
    Some(Value::Number(n)) if n.as_f64() == Some(0.0) => Ok(Some(false)),
    Some(Value::String(t)) if t.trim().eq_ignore_ascii_case("true") => Ok(Some(true)),
    Some(Value::String(t)) if t.trim().eq_ignore_ascii_case("false") => Ok(Some(false)),
    Some(other) => Err(cx.err(key, format!("must be true or false (or 1 or 0), got {}", kind_of(other)))),
  }
}

/// "8px 16px" style lengths as numbers (one to four of them).
fn css_lengths(cx: &Ctx, key: &str, s: &str) -> Result<Vec<f64>, String> {
  let parts: Vec<f64> = s
    .split_whitespace()
    .map(|t| px(t).ok_or_else(|| cx.err(key, format!("\"{s}\" isn't a number or a list of lengths like \"8px 16px\""))))
    .collect::<Result<_, _>>()?;
  if parts.is_empty() || parts.len() > 4 {
    return Err(cx.err(key, format!("\"{s}\" needs one to four lengths")));
  }
  Ok(parts)
}

/// "24", "24px", " 3.5 " as a number.
pub fn px(s: &str) -> Option<f64> {
  let t = s.trim();
  let t = t.strip_suffix("px").unwrap_or(t).trim();
  t.parse::<f64>().ok().filter(|x| x.is_finite())
}

/// A text value; numbers and booleans are written out.
pub fn string(cx: &Ctx, key: &str, v: &Value) -> Result<String, String> {
  match v {
    Value::String(s) => Ok(s.clone()),
    Value::Number(n) => Ok(n.to_string()),
    Value::Bool(b) => Ok(b.to_string()),
    other => Err(cx.err(key, format!("expected text, got {}", kind_of(other)))),
  }
}

pub fn dimension(cx: &Ctx, key: &str, v: Option<&Value>) -> Result<Option<Dim>, String> {
  let bad = |shown: String| cx.err(key, format!("{shown} isn't supported; use a number, \"fill\" or \"hug\""));
  Ok(match v {
    None | Some(Value::Null) => None,
    Some(Value::Number(n)) => Some(Dim::Px(n.as_f64().filter(|x| x.is_finite()).ok_or_else(|| bad(n.to_string()))?)),
    Some(Value::String(s)) => {
      let l = s.trim().to_lowercase();
      match l.as_str() {
        "fill" | "100%" | "fill-container" | "stretch" => Some(Dim::Fill),
        "hug" | "auto" | "fit-content" | "hug-contents" => Some(Dim::Hug),
        _ => Some(Dim::Px(px(&l).ok_or_else(|| bad(format!("\"{s}\"")))?)),
      }
    }
    Some(other) => return Err(bad(kind_of(other).to_string())),
  })
}

pub fn font_weight(cx: &Ctx, key: &str, v: &Value) -> Result<u32, String> {
  let hint = "use 100-900 or thin, light, regular, medium, semibold, bold, extrabold, black";
  let w = match v {
    Value::Number(n) => n.as_f64().unwrap_or(0.0),
    Value::String(s) => {
      let l = s.trim().to_lowercase().replace(['-', '_', ' '], "");
      match l.as_str() {
        "thin" | "hairline" => 100.0,
        "extralight" | "ultralight" => 200.0,
        "light" => 300.0,
        "regular" | "normal" | "book" => 400.0,
        "medium" => 500.0,
        "semibold" | "demibold" => 600.0,
        "bold" => 700.0,
        "extrabold" | "ultrabold" | "heavy" => 800.0,
        "black" => 900.0,
        _ => l
          .parse::<f64>()
          .map_err(|_| cx.err(key, format!("\"{s}\" isn't a font weight; {hint}")))?,
      }
    }
    other => return Err(cx.err(key, format!("expected a font weight, got {}; {hint}", kind_of(other)))),
  };
  if !(100.0..=1000.0).contains(&w) {
    return Err(cx.err(key, format!("{w} isn't a font weight; {hint}")));
  }
  Ok(w.round() as u32)
}

pub fn radius(cx: &Ctx, key: &str, v: &Value) -> Result<Radius, String> {
  let list = |a: &[Value]| -> Result<Vec<f64>, String> { a.iter().map(|x| number(cx, key, x)).collect() };
  match v {
    Value::Array(a) => {
      let r = list(a)?;
      match r.len() {
        1 => Ok(Radius::All(r[0])),
        2 => Ok(Radius::Each([r[0], r[1], r[0], r[1]])),
        3 => Ok(Radius::Each([r[0], r[1], r[2], r[1]])),
        4 => Ok(Radius::Each([r[0], r[1], r[2], r[3]])),
        n => Err(cx.err(
          key,
          format!("an array needs 1 or 4 values [topLeft, topRight, bottomRight, bottomLeft], got {n}"),
        )),
      }
    }
    Value::Object(o) => {
      let mut r = [0.0; 4];
      for (k, x) in o {
        let slot = match k.as_str() {
          "tl" | "topLeft" => 0,
          "tr" | "topRight" => 1,
          "br" | "bottomRight" => 2,
          "bl" | "bottomLeft" => 3,
          other => {
            return Err(cx.err(
              key,
              format!("unknown corner '{other}'; use topLeft (tl), topRight (tr), bottomRight (br), bottomLeft (bl)"),
            ))
          }
        };
        r[slot] = number(cx, &format!("{key}.{k}"), x)?;
      }
      Ok(Radius::Each(r))
    }
    Value::String(s) if s.split_whitespace().count() > 1 => {
      let r = css_lengths(cx, key, s)?;
      let at = |i: usize, fallback: usize| r.get(i).copied().unwrap_or(r[fallback]);
      Ok(Radius::Each([r[0], at(1, 0), at(2, 0), at(3, 1)]))
    }
    other => number(cx, key, other).map(Radius::All),
  }
}

/// Padding as [top, right, bottom, left].
pub fn padding(cx: &Ctx, key: &str, v: &Value) -> Result<[f64; 4], String> {
  match v {
    Value::Array(a) => {
      let f: Vec<f64> = a.iter().map(|x| number(cx, key, x)).collect::<Result<_, _>>()?;
      match f.len() {
        1 => Ok([f[0]; 4]),
        2 => Ok([f[0], f[1], f[0], f[1]]),
        3 => Ok([f[0], f[1], f[2], f[1]]),
        4 => Ok([f[0], f[1], f[2], f[3]]),
        n => Err(cx.err(
          key,
          format!("an array needs 1, 2 ([vertical, horizontal]) or 4 ([top, right, bottom, left]) values, got {n}"),
        )),
      }
    }
    Value::Object(o) => {
      let mut p = [0.0; 4];
      // Axes first so a side overrides them.
      for pass in 0..2 {
        for (k, x) in o {
          let sides: &[usize] = match (pass, k.as_str()) {
            (0, "vertical" | "y") => &[0, 2],
            (0, "horizontal" | "x") => &[1, 3],
            (1, "top") => &[0],
            (1, "right") => &[1],
            (1, "bottom") => &[2],
            (1, "left") => &[3],
            (_, "vertical" | "y" | "horizontal" | "x" | "top" | "right" | "bottom" | "left") => continue,
            (_, other) => {
              return Err(cx.err(
                key,
                format!("unknown side '{other}'; use top, right, bottom, left, vertical, horizontal"),
              ))
            }
          };
          let n = number(cx, &format!("{key}.{k}"), x)?;
          for s in sides {
            p[*s] = n;
          }
        }
      }
      Ok(p)
    }
    Value::String(s) if s.split_whitespace().count() > 1 => {
      let f = css_lengths(cx, key, s)?;
      Ok(match f.len() {
        2 => [f[0], f[1], f[0], f[1]],
        3 => [f[0], f[1], f[2], f[1]],
        _ => [f[0], f[1], f[2], f[3]],
      })
    }
    other => number(cx, key, other).map(|n| [n; 4]),
  }
}

/// `lineHeight`: a multiple of the font size when below 4, otherwise px; "150%", "24px" and
/// "normal" are accepted. None means automatic.
pub fn line_height(cx: &Ctx, key: &str, v: &Value, font_size: f64) -> Result<Option<f64>, String> {
  let bad = |n: f64| {
    cx.err(
      key,
      format!("{n} isn't a line height; use px (24), a multiple below 4 (1.5) or \"150%\""),
    )
  };
  let h = match v {
    Value::String(s) => {
      let t = s.trim().to_lowercase();
      if t == "normal" || t == "auto" {
        return Ok(None);
      }
      if let Some(p) = t.strip_suffix('%') {
        let p: f64 = p.trim().parse().map_err(|_| cx.err(key, format!("\"{s}\" isn't a line height")))?;
        p / 100.0 * font_size
      } else if t.ends_with("px") {
        number(cx, key, v)?
      } else if let Some(m) = t.strip_suffix("em") {
        let m: f64 = m.trim().parse().map_err(|_| cx.err(key, format!("\"{s}\" isn't a line height")))?;
        m * font_size
      } else {
        let n = number(cx, key, v)?;
        if n < 4.0 {
          n * font_size
        } else {
          n
        }
      }
    }
    other => {
      let n = number(cx, key, other)?;
      if n < 4.0 {
        n * font_size
      } else {
        n
      }
    }
  };
  if h <= 0.0 {
    return Err(bad(h));
  }
  Ok(Some(h))
}

/// `letterSpacing` in px; "0.05em" is relative to the font size.
pub fn letter_spacing(cx: &Ctx, key: &str, v: &Value, font_size: f64) -> Result<f64, String> {
  if let Value::String(s) = v {
    if let Some(e) = s.trim().to_lowercase().strip_suffix("em") {
      let e: f64 = e
        .trim()
        .parse()
        .map_err(|_| cx.err(key, format!("\"{s}\" isn't a letter spacing")))?;
      return Ok(e * font_size);
    }
  }
  number(cx, key, v)
}

/// An enum spelled one of several ways (case-insensitive, `_` and spaces as `-`). The first
/// name of each row is the one shown in the error. `hint` adds advice for known mistakes.
pub fn choice<T: Copy>(cx: &Ctx, key: &str, v: &Value, table: &[(&[&str], T)], hint: &dyn Fn(&str) -> Option<String>) -> Result<T, String> {
  let Some(s) = v.as_str() else {
    return Err(cx.err(key, format!("expected one of {}, got {}", shown(table), kind_of(v))));
  };
  let l = s.trim().to_lowercase().replace(['_', ' '], "-");
  for (names, t) in table {
    if names.contains(&l.as_str()) {
      return Ok(*t);
    }
  }
  let extra = hint(&l).map(|h| format!(" ({h})")).unwrap_or_default();
  Err(cx.err(key, format!("'{s}' isn't supported; use {}{extra}", shown(table))))
}

fn shown<T>(table: &[(&[&str], T)]) -> String {
  let names: Vec<&str> = table.iter().map(|(n, _)| n[0]).collect();
  match names.split_last() {
    Some((last, rest)) if !rest.is_empty() => format!("{} or {}", rest.join(", "), last),
    _ => names.join(", "),
  }
}

/// One of a fixed set of names, exactly (a typo is an error, never a guess). Absent means `default`.
pub fn exact<T: Copy>(cx: &Ctx, key: &str, v: Option<&Value>, default: T, table: &[(&str, T)]) -> Result<T, String> {
  let Some(v) = v.filter(|v| !v.is_null()) else { return Ok(default) };
  let names: Vec<&str> = table.iter().map(|(n, _)| *n).collect();
  let s = v
    .as_str()
    .ok_or_else(|| cx.err(key, format!("expected one of {}, got {}", names.join(", "), kind_of(v))))?;
  let l = s.trim().to_lowercase();
  table
    .iter()
    .find(|(n, _)| *n == l)
    .map(|(_, t)| *t)
    .ok_or_else(|| cx.err(key, format!("'{s}' isn't supported; use {}", names.join(", "))))
}

pub fn no_hint(_: &str) -> Option<String> {
  None
}

/// Colour as canonical hex, or an error naming the field.
pub fn color(cx: &Ctx, key: &str, v: &Value) -> Result<String, String> {
  let s = v
    .as_str()
    .ok_or_else(|| cx.err(key, format!("expected a colour like '#7C5CFF', got {}", kind_of(v))))?;
  crate::color::parse_strict(s).ok_or_else(|| cx.err(key, format!("unrecognised colour '{s}'; use hex like '#7C5CFF' or rgb()/rgba()")))
}

/// Image sources a layer may use.
pub fn image_url(cx: &Ctx, key: &str, url: &str) -> Result<(), String> {
  let l = url.trim().to_lowercase();
  if l.starts_with("http://") || l.starts_with("https://") || l.starts_with("data:image/") || l.starts_with("asset:") {
    Ok(())
  } else {
    Err(cx.err(key, "only http(s) URLs, data:image/ URLs and asset: ids are allowed"))
  }
}

/// Up to `n` of `options` nearest to `target` (substring matches first, then edit distance).
pub fn closest(target: &str, options: &[String], n: usize) -> Vec<String> {
  let t = target.to_lowercase();
  let mut scored: Vec<(usize, &String)> = options
    .iter()
    .map(|o| {
      let l = o.to_lowercase();
      let d = if !t.is_empty() && (l.contains(&t) || t.contains(&l)) {
        0
      } else {
        distance(&t, &l)
      };
      (d, o)
    })
    .collect();
  scored.sort_by_key(|(d, _)| *d);
  scored.into_iter().take(n).map(|(_, o)| o.clone()).collect()
}

/// "name1, name2, ..." for an error message, `none` when empty.
pub fn listed(names: &[String], none: &str) -> String {
  if names.is_empty() {
    none.to_string()
  } else {
    names.join(", ")
  }
}

/// Levenshtein distance.
pub fn distance(a: &str, b: &str) -> usize {
  let a: Vec<char> = a.chars().collect();
  let b: Vec<char> = b.chars().collect();
  let mut prev: Vec<usize> = (0..=b.len()).collect();
  for (i, ca) in a.iter().enumerate() {
    let mut cur = vec![i + 1];
    for (j, cb) in b.iter().enumerate() {
      let cost = usize::from(ca != cb);
      cur.push((prev[j] + cost).min(prev[j + 1] + 1).min(cur[j] + 1));
    }
    prev = cur;
  }
  prev[b.len()]
}

/// Rewrites what is clearly meant (layout properties at the top level of a frame, Figma's
/// `layoutSizing*`, `fontStyle`) into the keys we know, and warns about the rest of the keys
/// we don't. None when the spec needed no change.
pub fn desugar(cx: &mut Ctx, s: &Value, kind: NodeType) -> Option<Value> {
  let obj = s.as_object()?;
  let mut out: Option<Map<String, Value>> = None;
  let text = kind == NodeType::Text;
  let frame = kind.is_frame_like();
  for (k, v) in obj {
    let key = k.as_str();
    if LAYOUT_KEYS.contains(&key) && frame && !KNOWN_KEYS.contains(&key) {
      let m = out.get_or_insert_with(|| obj.clone());
      m.remove(key);
      let layout = m.entry("layout").or_insert_with(|| json!({}));
      match layout {
        Value::Object(l) => {
          let target = match key {
            "justify" => "align",
            "alignItems" => "crossAlign",
            k => k,
          };
          l.entry(target).or_insert(v.clone());
          cx.warn(format!("'{key}' is a layout property; used as layout.{target}"));
        }
        _ => cx.warn(format!("'{key}' is a layout property and was ignored; put it inside layout")),
      }
      continue;
    }
    match key {
      "layoutSizingHorizontal" | "layoutSizingVertical" => {
        let (dim, own) = if key.ends_with("Horizontal") {
          ("width", "width")
        } else {
          ("height", "height")
        };
        let m = out.get_or_insert_with(|| obj.clone());
        m.remove(key);
        let mapped = match v.as_str().map(|x| x.to_uppercase()).as_deref() {
          Some("FILL") => Some("fill"),
          Some("HUG") => Some("hug"),
          Some("FIXED") => None,
          _ => {
            cx.warn(format!(
              "'{key}' must be FILL, HUG or FIXED; ignored (use {dim}: number, \"fill\" or \"hug\")"
            ));
            continue;
          }
        };
        if let Some(d) = mapped {
          // The sizing mode wins over a pixel size given beside it (Figma keeps both).
          m.insert(own.to_string(), json!(d));
          cx.warn(format!("'{key}' is Figma's name; used as {own}: \"{d}\""));
        }
      }
      "fontStyle" => {
        let m = out.get_or_insert_with(|| obj.clone());
        m.remove(key);
        match v.as_str().map(|x| x.to_lowercase()).as_deref() {
          Some("italic") | Some("oblique") => {
            m.entry("italic").or_insert(json!(true));
            cx.warn("'fontStyle' used as italic: true");
          }
          Some("normal") => {
            m.entry("italic").or_insert(json!(false));
            cx.warn("'fontStyle' used as italic: false");
          }
          _ => cx.warn("unknown key 'fontStyle' (did you mean italic?)"),
        }
      }
      _ if KNOWN_KEYS.contains(&key) => {
        if !text && TEXT_KEYS.contains(&key) {
          cx.warn(format!(
            "'{key}' only applies to text layers; ignored on a {}",
            kind.label().to_lowercase()
          ));
        } else if text && key == "layout" {
          cx.warn("'layout' only applies to frames; ignored on a text layer");
        } else if !text && key == "color" {
          cx.warn("'color' only applies to text layers; use fill for the background");
        }
      }
      _ => {
        if let Some((_, to)) = ALIASES.iter().find(|(a, _)| *a == key) {
          cx.warn(format!("unknown key '{key}' ignored (did you mean {to}?)"));
        } else {
          let known: Vec<String> = KNOWN_KEYS.iter().map(|k| k.to_string()).collect();
          let near = closest(key, &known, 1);
          match near.first().filter(|n| distance(&key.to_lowercase(), &n.to_lowercase()) <= 2) {
            Some(n) => cx.warn(format!("unknown key '{key}' ignored (did you mean {n}?)")),
            None => cx.warn(format!("unknown key '{key}' ignored")),
          }
        }
      }
    }
  }
  out.map(Value::Object)
}

/// A CSS `box-shadow` string as shadow objects.
pub fn css_shadow(cx: &Ctx, key: &str, css: &str) -> Result<Vec<Value>, String> {
  let mut out = Vec::new();
  for part in super::split_top_level(css) {
    let mut lengths = Vec::new();
    let mut color: Option<String> = None;
    let mut inset = false;
    for tok in tokens(&part) {
      let l = tok.to_lowercase();
      if l == "inset" {
        inset = true;
      } else if let Some(n) = px(&l).or_else(|| (l == "0").then_some(0.0)) {
        lengths.push(n);
      } else if let Some(c) = crate::color::parse_strict(&tok) {
        color = Some(c);
      } else {
        return Err(cx.err(
          key,
          format!("can't read '{tok}' in the shadow; use {{x, y, blur, spread, color}} or CSS like '0 4px 12px rgba(0,0,0,0.1)'"),
        ));
      }
    }
    if lengths.len() < 2 {
      return Err(cx.err(key, "a shadow needs at least an x and a y offset"));
    }
    out.push(json!({
      "x": lengths[0], "y": lengths[1], "blur": lengths.get(2).copied().unwrap_or(0.0),
      "spread": lengths.get(3).copied().unwrap_or(0.0), "color": color.unwrap_or_else(|| "#00000040".into()), "inset": inset,
    }));
  }
  Ok(out)
}

/// Whitespace-separated tokens, keeping `rgba(0, 0, 0, 0.5)` whole.
pub fn tokens(s: &str) -> Vec<String> {
  let mut out = Vec::new();
  let mut cur = String::new();
  let mut depth = 0;
  for c in s.chars() {
    match c {
      '(' => {
        depth += 1;
        cur.push(c);
      }
      ')' => {
        depth -= 1;
        cur.push(c);
      }
      c if c.is_whitespace() && depth == 0 => {
        if !cur.is_empty() {
          out.push(std::mem::take(&mut cur));
        }
      }
      _ => cur.push(c),
    }
  }
  if !cur.is_empty() {
    out.push(cur);
  }
  out
}
