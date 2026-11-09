//! Variables import: Designotron `tokens.json` (an exact round trip of `variables::tokens_json`),
//! W3C design tokens (DTCG) and Tokens Studio files become variable collections, merged into the
//! file by name (by id for Designotron files). Matched variables take the imported values, new
//! ones are added and nothing is ever deleted.
//!
//! The text is read with an order-keeping JSON reader (`J`): `serde_json::Map` sorts its keys,
//! and the order of a token file is the order of its variables and token sets.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;

use serde_json::{json, Value};

use crate::doc::IdGen;
use crate::model::Document;
use crate::variables::{check_value, plain, Collection, VarKind, VarMode, Variable};

const EXT: &str = "com.designotron";
/// Skipped tokens the report lists one by one; the rest are only counted.
const LISTED: usize = 50;
/// How many aliases a value is followed through (as `variables::MAX_ALIAS_DEPTH`).
const DEPTH: usize = 8;
/// Bytes of JSON read at most (the dialog limits files to 5 MB as well).
const MAX_BYTES: usize = 8 * 1024 * 1024;
/// Modes per collection and themes per file that are read; more are skipped with a note.
const MAX_MODES: usize = 100;
/// Longest group or token key, and longest path, that are read. A token copies its whole path,
/// so one long key above many tokens would be copied into every one of them.
const MAX_KEY: usize = 256;
const MAX_PATH: usize = 1024;
/// Variables x modes an import may create. Every one is a value kept in memory (and in the undo
/// history), and a small file can ask for hundreds of millions.
const MAX_VALUES: usize = 1_000_000;
/// Collections one import may add or touch.
const MAX_COLLECTIONS: usize = 1000;

// ---------- Ordered JSON ----------

/// JSON with objects as ordered pairs.
#[derive(Debug, Clone, PartialEq)]
enum J {
  Null,
  Bool(bool),
  Num(f64),
  Str(String),
  Arr(Vec<J>),
  Obj(Vec<(String, J)>),
}

impl J {
  fn get(&self, key: &str) -> Option<&J> {
    match self {
      J::Obj(m) => m.iter().find(|(k, _)| k == key).map(|(_, v)| v),
      _ => None,
    }
  }
  fn str(&self) -> Option<&str> {
    match self {
      J::Str(s) => Some(s),
      _ => None,
    }
  }
  fn obj(&self) -> Option<&[(String, J)]> {
    match self {
      J::Obj(m) => Some(m),
      _ => None,
    }
  }
  fn arr(&self) -> Option<&[J]> {
    match self {
      J::Arr(a) => Some(a),
      _ => None,
    }
  }
  fn to_value(&self) -> Value {
    match self {
      J::Null => Value::Null,
      J::Bool(b) => json!(b),
      J::Num(n) => number(*n),
      J::Str(s) => json!(s),
      J::Arr(a) => Value::Array(a.iter().map(J::to_value).collect()),
      J::Obj(m) => Value::Object(m.iter().map(|(k, v)| (k.clone(), v.to_value())).collect()),
    }
  }
}

fn number(n: f64) -> Value {
  if n.fract() == 0.0 && n.abs() < 1e15 {
    json!(n as i64)
  } else {
    json!(n)
  }
}

struct Reader<'a> {
  b: &'a [u8],
  i: usize,
}

impl Reader<'_> {
  fn ws(&mut self) {
    while self.i < self.b.len() && matches!(self.b[self.i], b' ' | b'\t' | b'\n' | b'\r') {
      self.i += 1;
    }
  }
  fn err<T>(&self, what: &str) -> Result<T, String> {
    let line = self.b[..self.i.min(self.b.len())].iter().filter(|c| **c == b'\n').count() + 1;
    Err(format!("not valid JSON: {what} (line {line})"))
  }
  fn value(&mut self, depth: usize) -> Result<J, String> {
    if depth > 64 {
      return self.err("nested too deeply");
    }
    self.ws();
    let Some(&c) = self.b.get(self.i) else {
      return self.err("unexpected end");
    };
    match c {
      b'{' => {
        self.i += 1;
        let mut m: Vec<(String, J)> = Vec::new();
        // Key -> position, so a repeated key is found without scanning the object.
        let mut at: HashMap<String, usize> = HashMap::new();
        self.ws();
        if self.b.get(self.i) == Some(&b'}') {
          self.i += 1;
          return Ok(J::Obj(m));
        }
        loop {
          self.ws();
          let k = self.string()?;
          self.ws();
          if self.b.get(self.i) != Some(&b':') {
            return self.err("expected ':'");
          }
          self.i += 1;
          let v = self.value(depth + 1)?;
          // A key written twice keeps the last value in its first position.
          match at.get(&k) {
            Some(i) => m[*i].1 = v,
            None => {
              at.insert(k.clone(), m.len());
              m.push((k, v));
            }
          }
          self.ws();
          match self.b.get(self.i) {
            Some(b',') => self.i += 1,
            Some(b'}') => {
              self.i += 1;
              return Ok(J::Obj(m));
            }
            _ => return self.err("expected ',' or '}'"),
          }
        }
      }
      b'[' => {
        self.i += 1;
        let mut a = Vec::new();
        self.ws();
        if self.b.get(self.i) == Some(&b']') {
          self.i += 1;
          return Ok(J::Arr(a));
        }
        loop {
          a.push(self.value(depth + 1)?);
          self.ws();
          match self.b.get(self.i) {
            Some(b',') => self.i += 1,
            Some(b']') => {
              self.i += 1;
              return Ok(J::Arr(a));
            }
            _ => return self.err("expected ',' or ']'"),
          }
        }
      }
      b'"' => Ok(J::Str(self.string()?)),
      b't' if self.b[self.i..].starts_with(b"true") => {
        self.i += 4;
        Ok(J::Bool(true))
      }
      b'f' if self.b[self.i..].starts_with(b"false") => {
        self.i += 5;
        Ok(J::Bool(false))
      }
      b'n' if self.b[self.i..].starts_with(b"null") => {
        self.i += 4;
        Ok(J::Null)
      }
      b'-' | b'0'..=b'9' => {
        let start = self.i;
        while self.i < self.b.len() && matches!(self.b[self.i], b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9') {
          self.i += 1;
        }
        match std::str::from_utf8(&self.b[start..self.i]).ok().and_then(|s| s.parse::<f64>().ok()) {
          Some(n) if n.is_finite() => Ok(J::Num(n)),
          _ => self.err("bad number"),
        }
      }
      _ => self.err("unexpected character"),
    }
  }
  /// Four hex digits (no sign: `from_str_radix` would take "+041").
  fn try_hex4(&mut self) -> Option<u32> {
    let d = self.b.get(self.i..self.i + 4).filter(|d| d.iter().all(u8::is_ascii_hexdigit))?;
    let n = u32::from_str_radix(std::str::from_utf8(d).ok()?, 16).ok()?;
    self.i += 4;
    Some(n)
  }
  fn hex4(&mut self) -> Result<u32, String> {
    match self.try_hex4() {
      Some(n) => Ok(n),
      None => self.err("bad \\u escape"),
    }
  }
  fn string(&mut self) -> Result<String, String> {
    if self.b.get(self.i) != Some(&b'"') {
      return self.err("expected a string");
    }
    self.i += 1;
    let mut out: Vec<u8> = Vec::new();
    loop {
      let Some(&c) = self.b.get(self.i) else {
        return self.err("unterminated string");
      };
      self.i += 1;
      match c {
        b'"' => break,
        b'\\' => {
          let Some(&e) = self.b.get(self.i) else {
            return self.err("unterminated string");
          };
          self.i += 1;
          let ch = match e {
            b'"' => '"',
            b'\\' => '\\',
            b'/' => '/',
            b'b' => '\u{8}',
            b'f' => '\u{c}',
            b'n' => '\n',
            b'r' => '\r',
            b't' => '\t',
            b'u' => {
              let n = self.hex4()?;
              if (0xD800..0xDC00).contains(&n) {
                // A high half takes a following low half; anything else leaves it alone (U+FFFD)
                // and the next escape is read on its own.
                let mark = self.i;
                let low = if self.b[self.i..].starts_with(b"\\u") {
                  self.i += 2;
                  self.try_hex4().filter(|lo| (0xDC00..0xE000).contains(lo))
                } else {
                  None
                };
                match low {
                  Some(lo) => char::from_u32(0x10000 + ((n - 0xD800) << 10) + (lo - 0xDC00)).unwrap_or('\u{FFFD}'),
                  None => {
                    self.i = mark;
                    '\u{FFFD}'
                  }
                }
              } else {
                char::from_u32(n).unwrap_or('\u{FFFD}')
              }
            }
            _ => return self.err("bad escape"),
          };
          let mut buf = [0u8; 4];
          out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
        }
        c => out.push(c),
      }
    }
    String::from_utf8(out).or_else(|_| self.err("invalid UTF-8"))
  }
}

fn read_json(text: &str) -> Result<J, String> {
  if text.len() > MAX_BYTES {
    return Err("the file is too big to import (over 8 MB)".into());
  }
  let text = text.strip_prefix('\u{feff}').unwrap_or(text);
  let mut r = Reader { b: text.as_bytes(), i: 0 };
  let v = r.value(0)?;
  r.ws();
  if r.i != r.b.len() {
    return r.err("extra text after the value");
  }
  Ok(v)
}

// ---------- Report ----------

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Report {
  pub collections_added: usize,
  pub modes_added: usize,
  pub variables_added: usize,
  pub variables_updated: usize,
  /// (token path, reason), the first `LISTED`.
  pub skipped: Vec<(String, String)>,
  pub skipped_count: usize,
}

impl Report {
  fn skip(&mut self, path: impl Into<String>, reason: impl Into<String>) {
    self.skipped_count += 1;
    if self.skipped.len() < LISTED {
      self.skipped.push((path.into(), reason.into()));
    }
  }

  pub fn to_json(&self) -> Value {
    json!({
      "collectionsAdded": self.collections_added,
      "modesAdded": self.modes_added,
      "variablesAdded": self.variables_added,
      "variablesUpdated": self.variables_updated,
      "skipped": self.skipped.iter().map(|(p, r)| json!({ "path": p, "reason": r })).collect::<Vec<_>>(),
      "skippedCount": self.skipped_count,
    })
  }
}

// ---------- What a file says ----------

#[derive(Debug, Clone)]
enum IVal {
  Lit(Value),
  /// (collection, variable) of the same import.
  Alias(usize, usize),
}

#[derive(Debug, Clone)]
struct IVar {
  id: Option<String>,
  name: String,
  kind: VarKind,
  description: String,
  scopes: Vec<String>,
  /// Imported mode index -> value.
  values: BTreeMap<usize, IVal>,
}

#[derive(Debug, Clone)]
struct IColl {
  id: Option<String>,
  name: String,
  modes: Vec<String>,
  vars: Vec<IVar>,
  /// The file has no modes of its own (`modes` is the made-up "Default"): into a collection the
  /// file already has, it writes the first mode instead of adding one.
  synthetic: bool,
}

/// A token as written in the file.
#[derive(Debug, Clone)]
struct Tok {
  /// Path of group keys down to the token.
  path: Vec<String>,
  ty: Option<String>,
  value: J,
  desc: String,
  ext: Option<J>,
}

/// Collects the tokens under a group. A token is an object with `$value` (DTCG) or, for Tokens
/// Studio, `value`. `$type` on a group is inherited.
fn flatten(
  group: &J,
  inherited: Option<&str>,
  path: &mut Vec<String>,
  ts: bool,
  out: &mut Vec<Tok>,
  skipped: &mut Vec<String>,
  depth: usize,
) {
  let Some(entries) = group.obj() else { return };
  if depth > 32 {
    return;
  }
  let ty = group.get("$type").and_then(J::str).or(inherited);
  for (k, child) in entries {
    if (k.starts_with('$') && k != "$root") || child.obj().is_none() {
      continue;
    }
    if k.len() > MAX_KEY || path.iter().map(String::len).sum::<usize>() + k.len() > MAX_PATH {
      skipped.push(short(k));
      continue;
    }
    path.push(k.clone());
    match leaf_value(child, ts) {
      Some(value) => {
        let own = child
          .get("$type")
          .or_else(|| if ts { child.get("type") } else { None })
          .and_then(J::str);
        let desc = child
          .get("$description")
          .or_else(|| if ts { child.get("description") } else { None })
          .and_then(J::str)
          .unwrap_or("");
        out.push(Tok {
          path: path.clone(),
          ty: own.or(ty).map(String::from),
          value: value.clone(),
          desc: desc.into(),
          ext: child.get("$extensions").cloned(),
        });
      }
      None => flatten(child, ty, path, ts, out, skipped, depth + 1),
    }
    path.pop();
  }
}

fn leaf_value(v: &J, ts: bool) -> Option<&J> {
  v.get("$value").or_else(|| if ts { v.get("value") } else { None })
}

/// Reports the keys `flatten` left out (too long).
fn note_long_keys(skipped: Vec<String>, report: &mut Report) {
  for k in skipped {
    report.skip(k, format!("its key or path is longer than {MAX_KEY} characters"));
  }
}

/// `{a.b.c}` as the whole value: the path inside.
fn alias_ref(v: &J) -> Option<&str> {
  let s = v.str()?.trim();
  let inner = s.strip_prefix('{')?.strip_suffix('}')?;
  (!inner.contains(['{', '}'])).then_some(inner.trim())
}

// ---------- Values ----------

fn colour(v: &J) -> Result<Value, String> {
  match v {
    J::Str(s) => {
      if s.contains('{') {
        return Err("a colour made from a reference".into());
      }
      check_value(VarKind::Color, &json!(s)).map_err(|_| {
        let s = short(s);
        format!("can't read the colour '{s}'")
      })
    }
    J::Obj(_) => {
      if let Some(h) = v.get("hex").and_then(J::str) {
        return check_value(VarKind::Color, &json!(h)).map_err(|_| {
          let h = short(h);
          format!("can't read the colour '{h}'")
        });
      }
      let space = v.get("colorSpace").and_then(J::str).unwrap_or("srgb");
      if space != "srgb" {
        return Err(format!("colour space {space} has no hex value"));
      }
      let comps = v.get("components").and_then(J::arr).ok_or("a colour object needs components")?;
      let ch = |i: usize| match comps.get(i) {
        Some(J::Num(n)) => Ok(n.clamp(0.0, 1.0)),
        Some(J::Str(s)) if s == "none" => Ok(0.0),
        _ => Err("a colour needs three components".to_string()),
      };
      let a = match v.get("alpha") {
        Some(J::Num(n)) => n.clamp(0.0, 1.0),
        _ => 1.0,
      };
      let to = |f: f64| (f * 255.0).round() as u8;
      let hex = format!("#{:02X}{:02X}{:02X}{:02X}", to(ch(0)?), to(ch(1)?), to(ch(2)?), to(a));
      Ok(json!(crate::color::normalize(&hex)))
    }
    _ => Err("a colour must be a string or an object".into()),
  }
}

/// A number with an optional unit suffix, as (number, lower-case unit): `12px`, `1.5rem`, `50%`.
/// The leading numeric run is scanned once; the rest is the unit.
fn number_unit(s: &str) -> Option<(f64, String)> {
  let s = s.trim();
  let b = s.as_bytes();
  let digits = |mut i: usize| {
    while b.get(i).is_some_and(u8::is_ascii_digit) {
      i += 1;
    }
    i
  };
  let mut i = usize::from(matches!(b.first(), Some(b'-' | b'+')));
  let int_end = digits(i);
  i = int_end;
  let mut frac = 0;
  if b.get(i) == Some(&b'.') {
    let f = digits(i + 1);
    frac = f - (i + 1);
    i = f;
  }
  if int_end == usize::from(matches!(b.first(), Some(b'-' | b'+'))) && frac == 0 {
    return None;
  }
  // An exponent only counts when digits follow ("1em" is one em, not an exponent).
  if matches!(b.get(i), Some(b'e' | b'E')) {
    let mut k = i + 1;
    if matches!(b.get(k), Some(b'-' | b'+')) {
      k += 1;
    }
    let e = digits(k);
    if e > k {
      i = e;
    }
  }
  let n: f64 = s[..i].parse().ok()?;
  n.is_finite().then(|| (n, s[i..].trim().to_lowercase()))
}

/// A value shortened for an error message.
fn short(s: &str) -> String {
  let mut t: String = s.chars().take(40).collect();
  if t.len() < s.len() {
    t.push('…');
  }
  t
}

fn dimension(v: &J) -> Result<Value, String> {
  let (n, unit) = match v {
    J::Num(n) => (*n, String::new()),
    J::Str(s) => number_unit(s).ok_or_else(|| {
      let s = short(s);
      format!("can't read '{s}' as a size")
    })?,
    J::Obj(_) => {
      let n = match v.get("value") {
        Some(J::Num(n)) => *n,
        _ => return Err("a dimension needs a numeric value".into()),
      };
      (n, v.get("unit").and_then(J::str).unwrap_or("px").to_lowercase())
    }
    _ => return Err("a dimension must be a number or a string like 16px".into()),
  };
  match unit.as_str() {
    "" | "px" => Ok(number(n)),
    "rem" => Ok(number(n * 16.0)),
    u => Err(format!("the unit {} can't become a number", short(u))),
  }
}

fn plain_number(v: &J) -> Result<Value, String> {
  match v {
    J::Num(n) => Ok(number(*n)),
    J::Str(s) => s.trim().parse::<f64>().ok().filter(|n| n.is_finite()).map(number).ok_or_else(|| {
      let s = short(s);
      format!("can't read '{s}' as a number")
    }),
    _ => Err("a number was expected".into()),
  }
}

fn font_weight(v: &J) -> Result<Value, String> {
  if let Ok(n) = plain_number(v) {
    return Ok(n);
  }
  let J::Str(s) = v else {
    return Err("a font weight must be a number or a name".into());
  };
  let key: String = s.to_lowercase().chars().filter(|c| c.is_ascii_alphanumeric()).collect();
  let n = match key.as_str() {
    "thin" | "hairline" => 100,
    "extralight" | "ultralight" => 200,
    "light" => 300,
    "normal" | "regular" | "book" => 400,
    "medium" => 500,
    "semibold" | "demibold" => 600,
    "bold" => 700,
    "extrabold" | "ultrabold" => 800,
    "black" | "heavy" => 900,
    "extrablack" | "ultrablack" => 950,
    _ => {
      return Err({
        let s = short(s);
        format!("unknown font weight '{s}'")
      })
    }
  };
  Ok(json!(n))
}

fn duration(v: &J) -> Result<Value, String> {
  let (n, unit) = match v {
    J::Num(n) => (*n, "ms".to_string()),
    J::Str(s) => number_unit(s).ok_or_else(|| {
      let s = short(s);
      format!("can't read '{s}' as a duration")
    })?,
    J::Obj(_) => match v.get("value") {
      Some(J::Num(n)) => (*n, v.get("unit").and_then(J::str).unwrap_or("ms").to_lowercase()),
      _ => return Err("a duration needs a numeric value".into()),
    },
    _ => return Err("a duration must be a number or a string like 200ms".into()),
  };
  match unit.as_str() {
    "" | "ms" => Ok(number(n)),
    "s" => Ok(number(n * 1000.0)),
    u => Err(format!("the unit {} isn't a duration", short(u))),
  }
}

fn text_of(v: &J, family: bool) -> Result<Value, String> {
  match v {
    J::Str(s) if s.contains('{') => Err("text made from a reference".into()),
    J::Str(s) => Ok(json!(s)),
    J::Arr(a) if family => a
      .first()
      .and_then(J::str)
      .map(|s| json!(s))
      .ok_or_else(|| "an empty font family list".into()),
    J::Num(n) if !family => Ok(json!(number(*n).to_string())),
    _ => Err("a string was expected".into()),
  }
}

fn boolean(v: &J) -> Result<Value, String> {
  match v {
    J::Bool(b) => Ok(json!(b)),
    J::Str(s) if s == "true" || s == "false" => Ok(json!(s == "true")),
    _ => Err("true or false was expected".into()),
  }
}

/// A token type as a variable type, or why it can't be one. `ts` picks the Tokens Studio names.
fn kind_of_type(ty: &str, ts: bool) -> Result<VarKind, String> {
  let t = ty.to_lowercase();
  let t = t.as_str();
  let k = if ts {
    match t {
      "color" => VarKind::Color,
      "sizing" | "spacing" | "borderradius" | "borderwidth" | "dimension" | "fontsizes" | "number" | "opacity" | "fontweights" => {
        VarKind::Number
      }
      "fontfamilies" | "text" | "other" | "string" => VarKind::String,
      "boolean" => VarKind::Boolean,
      _ => return Err(format!("{ty} tokens aren't supported")),
    }
  } else {
    match t {
      "color" => VarKind::Color,
      "dimension" | "number" | "fontweight" | "duration" => VarKind::Number,
      "fontfamily" | "string" => VarKind::String,
      "boolean" => VarKind::Boolean,
      "shadow" | "typography" | "border" | "gradient" | "transition" | "strokestyle" | "cubicbezier" => {
        return Err(format!("{ty} is a composite type and can't become a variable"))
      }
      _ => return Err(format!("{ty} tokens aren't supported")),
    }
  };
  Ok(k)
}

/// A literal token value as a variable value.
fn convert(ty: Option<&str>, v: &J, ts: bool) -> Result<(VarKind, Value), String> {
  if let J::Str(s) = v {
    // Math and references mixed into text can't be evaluated here.
    let texty = ty.is_some_and(|t| matches!(t.to_lowercase().as_str(), "text" | "other" | "string"));
    if s.contains('{') && alias_ref(v).is_none() && !texty {
      return Err("it uses a partial reference or math".into());
    }
  }
  let Some(ty) = ty else {
    return match v {
      J::Bool(b) => Ok((VarKind::Boolean, json!(b))),
      J::Num(n) => Ok((VarKind::Number, number(*n))),
      J::Str(_) => Ok(
        colour(v)
          .map(|c| (VarKind::Color, c))
          .unwrap_or_else(|_| (VarKind::String, v.to_value())),
      ),
      _ => Err("it has no type and its value isn't simple".into()),
    };
  };
  let kind = kind_of_type(ty, ts)?;
  let t = ty.to_lowercase();
  let value = match (kind, t.as_str()) {
    (VarKind::Color, _) => colour(v)?,
    (_, "dimension" | "sizing" | "spacing" | "borderradius" | "borderwidth" | "fontsizes") => dimension(v)?,
    (_, "opacity") => match v {
      J::Str(s) if s.trim().ends_with('%') => {
        let (n, _) = number_unit(s).ok_or_else(|| {
          let s = short(s);
          format!("can't read '{s}' as an opacity")
        })?;
        number(n / 100.0)
      }
      _ => plain_number(v)?,
    },
    (_, "fontweight" | "fontweights") => font_weight(v)?,
    (_, "duration") => duration(v)?,
    (VarKind::Number, _) => plain_number(v)?,
    (VarKind::Boolean, _) => boolean(v)?,
    (VarKind::String, "fontfamily" | "fontfamilies") => text_of(v, true)?,
    (VarKind::String, _) => text_of(v, false)?,
  };
  Ok((kind, value))
}

fn path_name(path: &[String]) -> String {
  path.iter().filter(|p| *p != "$root").cloned().collect::<Vec<_>>().join("/")
}

fn default_value(kind: VarKind) -> Value {
  match kind {
    VarKind::Color => json!("#000000"),
    VarKind::Number => json!(0),
    VarKind::String => json!(""),
    VarKind::Boolean => json!(false),
  }
}

// ---------- DTCG and Designotron ----------

/// Where a token's value comes from.
#[derive(Clone)]
enum Def {
  Lit(Value),
  /// Index of the token it aliases.
  To(usize),
}

struct Resolved {
  kind: VarKind,
  def: Def,
}

struct PTok {
  coll: usize,
  /// Dotted path from the file's root, the form references use.
  full: String,
  tok: Tok,
  /// Position the Designotron export wrote (`index` in its extension).
  order: usize,
  /// Variable type pinned by the Designotron extension.
  pinned: Option<String>,
}

fn ext_of(t: &Tok) -> Option<&J> {
  t.ext.as_ref().and_then(|e| e.get(EXT))
}

fn import_dtcg(root: &J, file_name: &str, report: &mut Report) -> Result<Vec<IColl>, String> {
  let entries = root.obj().unwrap_or(&[]);
  let designotron = entries.iter().any(|(_, g)| {
    g.get("$extensions")
      .and_then(|e| e.get(EXT))
      .is_some_and(|x| x.get("modes").is_some())
  });
  // Collections and their tokens, in file order.
  let mut colls: Vec<IColl> = Vec::new();
  let mut ptoks: Vec<PTok> = Vec::new();
  // Full path (from the file's root) of each token, for references.
  let mut index: HashMap<String, usize> = HashMap::new();
  let index_of = |ext: Option<&J>| {
    ext
      .and_then(|e| e.get("index"))
      .and_then(|n| if let J::Num(n) = n { Some(*n as usize) } else { None })
  };
  if designotron {
    // Collections in the order the export wrote down (older exports have none: file order).
    let mut groups: Vec<(&String, &J)> = entries
      .iter()
      .filter(|(k, g)| !k.starts_with('$') && g.obj().is_some() && k.len() <= MAX_KEY)
      .map(|(k, g)| (k, g))
      .collect();
    groups.sort_by_key(|(_, g)| index_of(g.get("$extensions").and_then(|e| e.get(EXT))).unwrap_or(usize::MAX));
    for (key, group) in groups {
      let ext = group.get("$extensions").and_then(|e| e.get(EXT));
      let modes: Vec<String> = ext
        .and_then(|e| e.get("modes"))
        .and_then(J::arr)
        .map(|a| a.iter().filter_map(J::str).take(MAX_MODES).map(String::from).collect())
        .filter(|m: &Vec<String>| !m.is_empty())
        .unwrap_or_else(|| vec!["Default".into()]);
      let ci = colls.len();
      colls.push(IColl {
        id: ext.and_then(|e| e.get("id")).and_then(J::str).map(String::from),
        name: ext.and_then(|e| e.get("name")).and_then(J::str).unwrap_or(key).into(),
        modes,
        vars: Vec::new(),
        synthetic: false,
      });
      let mut toks = Vec::new();
      let mut long = Vec::new();
      flatten(
        group,
        group.get("$type").and_then(J::str),
        &mut Vec::new(),
        false,
        &mut toks,
        &mut long,
        0,
      );
      note_long_keys(long, report);
      for t in toks {
        let full = format!("{key}.{}", t.path.join("."));
        let pinned = ext_of(&t).and_then(|e| e.get("type")).and_then(J::str).map(String::from);
        let order = index_of(ext_of(&t)).unwrap_or(usize::MAX);
        ptoks.push(PTok {
          coll: ci,
          full,
          tok: t,
          order,
          pinned,
        });
      }
    }
    // Variables in the order the export wrote down, within each collection (stable, so tokens
    // of an older export keep the file's order).
    ptoks.sort_by_key(|p| (p.coll, p.order));
  } else {
    let name = file_name.rsplit(['/', '\\']).next().unwrap_or(file_name);
    let name = name.strip_suffix(".json").unwrap_or(name).trim();
    colls.push(IColl {
      id: None,
      name: if name.is_empty() { "Tokens".into() } else { name.into() },
      modes: vec!["Default".into()],
      vars: Vec::new(),
      synthetic: true,
    });
    let mut toks = Vec::new();
    let mut long = Vec::new();
    flatten(
      root,
      root.get("$type").and_then(J::str),
      &mut Vec::new(),
      false,
      &mut toks,
      &mut long,
      0,
    );
    note_long_keys(long, report);
    for t in toks {
      ptoks.push(PTok {
        coll: 0,
        full: t.path.join("."),
        tok: t,
        order: 0,
        pinned: None,
      });
    }
  }
  // Values are tokens x modes at most; refuse before anything per mode is built.
  let modes = colls.iter().map(|c| c.modes.len()).max().unwrap_or(1);
  if ptoks.len().saturating_mul(modes) > MAX_VALUES {
    return Err(too_many(ptoks.len(), modes));
  }
  for (i, p) in ptoks.iter().enumerate() {
    index.insert(p.full.clone(), i);
  }
  // The variable name of each token, and the later one of two tokens that end up with the same
  // name in a collection (`x/y` and `x.y`) is left out.
  let names: Vec<String> = ptoks
    .iter()
    .map(|p| {
      ext_of(&p.tok)
        .and_then(|e| e.get("name"))
        .and_then(J::str)
        .map(String::from)
        .unwrap_or_else(|| path_name(&p.tok.path))
    })
    .collect();

  // What each token resolves to, or why it can't be a variable.
  let n = ptoks.len();
  let mut results: Vec<Result<Resolved, String>> = (0..n).map(|i| resolve_token(i, 0, &ptoks, &index)).collect();
  let mut seen_names: HashSet<(usize, &str)> = HashSet::new();
  for (i, p) in ptoks.iter().enumerate() {
    if results[i].is_ok() && !seen_names.insert((p.coll, names[i].as_str())) {
      results[i] = Err("another token has the same name".into());
    }
  }
  // An alias to a token that was skipped is skipped too: walk from each skipped token to the
  // tokens that alias it, so every token is looked at once.
  let mut dependents: Vec<Vec<usize>> = vec![Vec::new(); n];
  for (i, r) in results.iter().enumerate() {
    if let Ok(Resolved { def: Def::To(t), .. }) = r {
      dependents[*t].push(i);
    }
  }
  let mut queue: Vec<usize> = (0..n).filter(|i| results[*i].is_err()).collect();
  while let Some(skipped) = queue.pop() {
    for &d in &dependents[skipped] {
      if results[d].is_ok() {
        results[d] = Err("it refers to a token that was skipped".into());
        queue.push(d);
      }
    }
  }
  // Variable slots in file order.
  let mut slot: Vec<Option<(usize, usize)>> = vec![None; n];
  for (i, p) in ptoks.iter().enumerate() {
    match &results[i] {
      Ok(r) => {
        let ext = ext_of(&p.tok);
        let name = names[i].clone();
        let c = &mut colls[p.coll];
        slot[i] = Some((p.coll, c.vars.len()));
        c.vars.push(IVar {
          id: ext.and_then(|e| e.get("id")).and_then(J::str).map(String::from),
          name,
          kind: r.kind,
          description: p.tok.desc.clone(),
          scopes: ext
            .and_then(|e| e.get("scopes"))
            .and_then(J::arr)
            .map(|a| a.iter().filter_map(J::str).map(String::from).collect())
            .unwrap_or_default(),
          values: BTreeMap::new(),
        });
      }
      Err(why) => {
        let shown = if designotron {
          format!("{}/{}", colls[p.coll].name, path_name(&p.tok.path))
        } else {
          path_name(&p.tok.path)
        };
        report.skip(shown, why.clone());
      }
    }
  }
  // Values: the default mode from `$value`, the others from the extension.
  for (i, p) in ptoks.iter().enumerate() {
    let (Ok(r), Some((ci, vi))) = (&results[i], slot[i]) else {
      continue;
    };
    let skip_name = |mode: usize, colls: &[IColl]| {
      format!(
        "{} ({})",
        path_name(&p.tok.path),
        colls[ci].modes.get(mode).cloned().unwrap_or_default()
      )
    };
    let first = match &r.def {
      Def::Lit(v) => Some(IVal::Lit(v.clone())),
      Def::To(t) => slot[*t]
        .filter(|s| colls[s.0].vars[s.1].kind == r.kind)
        .map(|(c, v)| IVal::Alias(c, v)),
    };
    match first {
      Some(v) => {
        colls[ci].vars[vi].values.insert(0, v);
      }
      None => report.skip(skip_name(0, &colls), "it refers to a token of another type"),
    }
    let Some(modes) = ext_of(&p.tok).and_then(|e| e.get("modes")).and_then(J::obj) else {
      continue;
    };
    for (mname, mv) in modes {
      let Some(mi) = colls[ci].modes.iter().position(|m| m == mname) else {
        continue;
      };
      let outcome: Result<IVal, String> = if let Some(target) = alias_ref(mv) {
        index
          .get(target)
          .and_then(|t| slot[*t])
          .filter(|s| colls[s.0].vars[s.1].kind == r.kind)
          .map(|(c, v)| IVal::Alias(c, v))
          .ok_or_else(|| format!("it refers to {target}, which isn't a variable of the same type"))
      } else {
        let ty = pinned_or(p);
        match convert(ty.as_deref(), mv, false) {
          Ok((k, v)) if k == r.kind => Ok(IVal::Lit(v)),
          Ok(_) => Err("the value has another type than the token".into()),
          Err(why) => Err(why),
        }
      };
      match outcome {
        Ok(v) => {
          colls[ci].vars[vi].values.insert(mi, v);
        }
        Err(why) => report.skip(skip_name(mi, &colls), why),
      }
    }
  }
  Ok(colls)
}

fn too_many(tokens: usize, modes: usize) -> String {
  format!("too many values to import ({tokens} tokens × {modes} modes)")
}

fn pinned_or(p: &PTok) -> Option<String> {
  p.pinned.clone().or_else(|| p.tok.ty.clone())
}

fn resolve_token(i: usize, depth: usize, toks: &[PTok], index: &HashMap<String, usize>) -> Result<Resolved, String> {
  let p = &toks[i];
  let ty = pinned_or(p);
  if let Some(r) = alias_ref(&p.tok.value) {
    let Some(&target) = index.get(r) else {
      return Err(format!("the reference {{{r}}} points at nothing"));
    };
    // A token with a type of its own doesn't need to look at its target.
    let kind = match ty.as_deref() {
      Some(t) => kind_of_type(t, false)?,
      None => {
        if depth >= DEPTH {
          return Err("references go round in a circle".into());
        }
        resolve_token(target, depth + 1, toks, index)?.kind
      }
    };
    return Ok(Resolved {
      kind,
      def: Def::To(target),
    });
  }
  let (kind, value) = convert(ty.as_deref(), &p.tok.value, false)?;
  Ok(Resolved {
    kind,
    def: Def::Lit(value),
  })
}

// ---------- Tokens Studio ----------

fn unique(base: &str, taken: &[String]) -> String {
  let mut out = base.to_string();
  let mut k = 2;
  while taken.contains(&out) {
    out = format!("{base} {k}");
    k += 1;
  }
  out
}

struct TsSet {
  name: String,
  toks: Vec<Tok>,
  /// `dotted(path)` of each token, made once.
  keys: Vec<String>,
}

impl TsSet {
  fn new(name: String, toks: Vec<Tok>) -> Self {
    let keys = toks.iter().map(|t| dotted(&t.path)).collect();
    TsSet { name, toks, keys }
  }
}

/// The token sets of the file in order: `$metadata.tokenSetOrder`, then the rest in file order.
fn ts_sets(root: &J, report: &mut Report) -> Vec<TsSet> {
  let mut sets: Vec<TsSet> = Vec::new();
  let mut loose: Vec<Tok> = Vec::new();
  for (k, v) in root.obj().unwrap_or(&[]) {
    if k.starts_with('$') || v.obj().is_none() {
      continue;
    }
    if k.len() > MAX_KEY {
      report.skip(short(k), format!("its key or path is longer than {MAX_KEY} characters"));
      continue;
    }
    if let Some(value) = leaf_value(v, true) {
      loose.push(Tok {
        path: vec![k.clone()],
        ty: v.get("$type").or_else(|| v.get("type")).and_then(J::str).map(String::from),
        value: value.clone(),
        desc: v
          .get("description")
          .or_else(|| v.get("$description"))
          .and_then(J::str)
          .unwrap_or("")
          .into(),
        ext: None,
      });
      continue;
    }
    let mut toks = Vec::new();
    let mut long = Vec::new();
    flatten(v, v.get("$type").and_then(J::str), &mut Vec::new(), true, &mut toks, &mut long, 0);
    note_long_keys(long, report);
    sets.push(TsSet::new(k.clone(), toks));
  }
  if !loose.is_empty() {
    sets.push(TsSet::new("Tokens".into(), loose));
  }
  if let Some(order) = root.get("$metadata").and_then(|m| m.get("tokenSetOrder")).and_then(J::arr) {
    let mut want: HashMap<&str, usize> = HashMap::new();
    for (i, w) in order.iter().filter_map(J::str).enumerate() {
      want.entry(w).or_insert(i);
    }
    sets.sort_by_key(|s| want.get(s.name.as_str()).copied().unwrap_or(usize::MAX));
  }
  sets
}

fn dotted(path: &[String]) -> String {
  path.join(".")
}

/// A token followed through references to a literal; `find` looks a path up.
fn ts_literal<'a>(tok: &'a Tok, find: &dyn Fn(&str) -> Option<&'a Tok>, depth: usize) -> Result<(VarKind, Value), String> {
  if let Some(r) = alias_ref(&tok.value) {
    if depth >= DEPTH {
      return Err("references go round in a circle".into());
    }
    let t = find(r).ok_or_else(|| format!("the reference {{{r}}} points at nothing"))?;
    return ts_literal(t, find, depth + 1);
  }
  convert(tok.ty.as_deref(), &tok.value, true)
}

fn import_ts(root: &J, report: &mut Report) -> Result<Vec<IColl>, String> {
  let sets = ts_sets(root, report);
  let tokens: usize = sets.iter().map(|s| s.toks.len()).sum();
  let mut all: Vec<&J> = root
    .get("$themes")
    .and_then(J::arr)
    .map(|a| a.iter().filter(|t| t.obj().is_some()).collect())
    .unwrap_or_default();
  if all.is_empty() {
    return Ok(ts_without_themes(&sets, report));
  }
  if all.len() > MAX_MODES {
    report.skip("$themes", format!("only the first {MAX_MODES} themes are imported"));
    all.truncate(MAX_MODES);
  }
  // Every theme sees every token: refuse before the per-theme tables are built.
  if tokens.saturating_mul(all.len()) > MAX_VALUES {
    return Err(too_many(tokens, all.len()));
  }
  // Each theme with its sets' states looked up by name.
  type Theme<'a> = (&'a J, HashMap<&'a str, &'a str>);
  let themes: Vec<Theme> = all
    .into_iter()
    .map(|t| {
      let sel = t
        .get("selectedTokenSets")
        .and_then(J::obj)
        .map(|m| m.iter().filter_map(|(k, v)| v.str().map(|v| (k.as_str(), v))).collect())
        .unwrap_or_default();
      (t, sel)
    })
    .collect();
  // One collection per theme group; its themes are its modes.
  let mut groups: Vec<(String, Vec<&Theme>)> = Vec::new();
  for t in &themes {
    let g = t
      .0
      .get("group")
      .and_then(J::str)
      .filter(|g| !g.trim().is_empty())
      .unwrap_or("Tokens")
      .to_string();
    match groups.iter_mut().find(|(n, _)| *n == g) {
      Some((_, list)) => list.push(t),
      None => groups.push((g, vec![t])),
    }
  }
  fn status<'a>(theme: &Theme<'a>, set: &str) -> &'a str {
    theme.1.get(set).copied().unwrap_or("disabled")
  }
  let mut colls: Vec<IColl> = Vec::new();
  for (gname, gthemes) in &groups {
    let mut modes: Vec<String> = Vec::new();
    for t in gthemes {
      let n = unique(t.0.get("name").and_then(J::str).unwrap_or("Theme"), &modes);
      modes.push(n);
    }
    // Per theme: the tokens of its enabled sets (they give the values) and of its enabled and
    // source sets (they give alias targets); a later set wins.
    let mut enabled: Vec<HashMap<String, &Tok>> = Vec::new();
    let mut full: Vec<HashMap<String, &Tok>> = Vec::new();
    let mut paths: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for t in gthemes {
      let (mut en, mut fu) = (HashMap::new(), HashMap::new());
      for s in &sets {
        let st = status(t, &s.name);
        if st != "enabled" && st != "source" {
          continue;
        }
        for (tok, p) in s.toks.iter().zip(&s.keys) {
          let p = p.clone();
          if st == "enabled" {
            en.insert(p.clone(), tok);
            if seen.insert(p.clone()) {
              paths.push(p.clone());
            }
          }
          fu.insert(p, tok);
        }
      }
      enabled.push(en);
      full.push(fu);
    }
    // The variable's type: from the first theme that has it.
    let mut kinds: HashMap<&str, VarKind> = HashMap::new();
    let mut whys: HashMap<&str, String> = HashMap::new();
    for p in &paths {
      for mi in 0..gthemes.len() {
        let Some(tok) = enabled[mi].get(p.as_str()) else { continue };
        let find = |r: &str| full[mi].get(r).copied();
        match ts_literal(tok, &find, 0) {
          Ok((k, _)) => {
            kinds.insert(p, k);
            break;
          }
          Err(why) => {
            whys.entry(p).or_insert(why);
          }
        }
      }
    }
    let ci = colls.len();
    let mut var_at: HashMap<&str, usize> = HashMap::new();
    let mut vars: Vec<IVar> = Vec::new();
    let mut taken: HashSet<String> = HashSet::new();
    for p in &paths {
      match kinds.get(p.as_str()) {
        Some(k) => {
          let Some(tok) = enabled.iter().find_map(|e| e.get(p.as_str())) else {
            continue;
          };
          if !taken.insert(path_name(&tok.path)) {
            report.skip(format!("{gname}/{}", p.replace('.', "/")), "another token has the same name");
            continue;
          }
          var_at.insert(p, vars.len());
          vars.push(IVar {
            id: None,
            name: path_name(&tok.path),
            kind: *k,
            description: tok.desc.clone(),
            scopes: Vec::new(),
            values: BTreeMap::new(),
          });
        }
        None => report.skip(
          format!("{gname}/{}", p.replace('.', "/")),
          whys.remove(p.as_str()).unwrap_or_default(),
        ),
      }
    }
    for p in &paths {
      let Some(&vi) = var_at.get(p.as_str()) else { continue };
      let kind = vars[vi].kind;
      for (mi, mode) in modes.iter().enumerate() {
        let Some(tok) = enabled[mi].get(p.as_str()) else { continue };
        let find = |r: &str| full[mi].get(r).copied();
        if let Some(&tvi) = alias_ref(&tok.value).and_then(|r| var_at.get(r)) {
          if vars[tvi].kind == kind {
            vars[vi].values.insert(mi, IVal::Alias(ci, tvi));
            continue;
          }
        }
        let shown = format!("{gname}/{} ({mode})", p.replace('.', "/"));
        match ts_literal(tok, &find, 0) {
          Ok((k, v)) if k == kind => {
            vars[vi].values.insert(mi, IVal::Lit(v));
          }
          Ok(_) => report.skip(shown, "the value has another type than in the first theme"),
          Err(why) => report.skip(shown, why),
        }
      }
    }
    colls.push(IColl {
      id: None,
      name: gname.clone(),
      modes,
      vars,
      synthetic: false,
    });
  }
  Ok(colls)
}

fn ts_without_themes(sets: &[TsSet], report: &mut Report) -> Vec<IColl> {
  // The token each path means: the last set that has it.
  let mut table: HashMap<String, (usize, &Tok)> = HashMap::new();
  for (si, s) in sets.iter().enumerate() {
    for (t, k) in s.toks.iter().zip(&s.keys) {
      table.insert(k.clone(), (si, t));
    }
  }
  let find = |r: &str| table.get(r).map(|(_, t)| *t);
  let mut colls: Vec<IColl> = sets
    .iter()
    .map(|s| IColl {
      id: None,
      name: s.name.clone(),
      modes: vec!["Default".into()],
      vars: Vec::new(),
      synthetic: true,
    })
    .collect();
  let mut var_at: HashMap<String, (usize, usize)> = HashMap::new();
  // (set, token index) -> its literal, for the tokens that became variables.
  let mut lits: Vec<(usize, usize, VarKind, Value)> = Vec::new();
  let mut taken: HashSet<(usize, String)> = HashSet::new();
  for (si, s) in sets.iter().enumerate() {
    for (ti, t) in s.toks.iter().enumerate() {
      let p = s.keys[ti].clone();
      match ts_literal(t, &find, 0) {
        Ok(_) if !taken.insert((si, path_name(&t.path))) => {
          report.skip(format!("{}/{}", s.name, path_name(&t.path)), "another token has the same name")
        }
        Ok((kind, v)) => {
          if table.get(&p).is_some_and(|(owner, _)| *owner == si) {
            var_at.insert(p, (si, colls[si].vars.len()));
          }
          colls[si].vars.push(IVar {
            id: None,
            name: path_name(&t.path),
            kind,
            description: t.desc.clone(),
            scopes: Vec::new(),
            values: BTreeMap::new(),
          });
          lits.push((si, ti, kind, v));
        }
        Err(why) => report.skip(format!("{}/{}", s.name, path_name(&t.path)), why),
      }
    }
  }
  let mut next: HashMap<usize, usize> = HashMap::new();
  for (si, ti, kind, v) in lits {
    let vi = *next.entry(si).and_modify(|n| *n += 1).or_insert(0);
    let tok = &sets[si].toks[ti];
    let val = match alias_ref(&tok.value).and_then(|r| var_at.get(r)) {
      Some(&(tc, tv)) if colls[tc].vars[tv].kind == kind => IVal::Alias(tc, tv),
      _ => IVal::Lit(v),
    };
    colls[si].vars[vi].values.insert(0, val);
  }
  colls.retain(|c| !c.vars.is_empty());
  colls
}

// ---------- Merge ----------

/// Reads a tokens file and merges it into the document's variables. Returns the whole new set of
/// collections (untouched ones included) and what happened. Nothing in `doc` changes.
pub fn import(doc: &Document, text: &str, file_name: &str, gen: &mut IdGen) -> Result<(Vec<Collection>, Report), String> {
  let root = read_json(text)?;
  if root.obj().is_none() {
    return Err("a tokens file is a JSON object".into());
  }
  let mut report = Report::default();
  let root = without_styles(root, &mut report);
  let Some(entries) = root.obj() else {
    return Err("a tokens file is a JSON object".into());
  };
  // Tokens Studio writes `$themes` / `$metadata`, or `value` where DTCG writes `$value`.
  let ts = root.get("$themes").is_some()
    || root.get("$metadata").is_some()
    || entries.iter().filter(|(k, _)| !k.starts_with('$')).any(|(_, g)| {
      let plain = |t: &J| t.get("value").is_some() && t.get("$value").is_none();
      // `$type`, `$value` and the other `$` keys of a DTCG token are not tokens themselves.
      plain(g) || g.obj().is_some_and(|m| m.iter().any(|(k, c)| !k.starts_with('$') && plain(c)))
    });
  let mut imported = if ts {
    import_ts(&root, &mut report)?
  } else {
    import_dtcg(&root, file_name, &mut report)?
  };
  if imported.len() > MAX_COLLECTIONS {
    report.skip("collections", format!("only the first {MAX_COLLECTIONS} collections are imported"));
    imported.truncate(MAX_COLLECTIONS);
  }
  if imported.iter().all(|c| c.vars.is_empty()) {
    let why = if report.skipped_count > 0 {
      " (every token was skipped)"
    } else {
      ""
    };
    return Err(format!("no tokens found to import{why}"));
  }
  let out = merge(doc, imported, gen, &mut report);
  Ok((out, report))
}

/// Leaves out the group an export wrote for the colour and text styles (marked with the
/// `styles` extension): styles aren't variables, so the file's other groups import as before.
fn without_styles(root: J, report: &mut Report) -> J {
  let is_styles = |g: &J| {
    g.get("$extensions")
      .and_then(|e| e.get(EXT))
      .and_then(|x| x.get("styles"))
      .is_some_and(|s| *s == J::Bool(true))
  };
  let J::Obj(entries) = root else { return root };
  if !entries.iter().any(|(_, g)| is_styles(g)) {
    return J::Obj(entries);
  }
  let mut kept = Vec::with_capacity(entries.len());
  for (k, g) in entries {
    if is_styles(&g) {
      report.skip(short(&k), "styles aren't imported as variables");
    } else {
      kept.push((k, g));
    }
  }
  J::Obj(kept)
}

struct Plan {
  /// Index into the merged list.
  at: usize,
  /// Destination mode id for each imported mode.
  modes: Vec<String>,
  /// Final id of each imported variable (None: skipped).
  vars: Vec<Option<String>>,
  /// Position of each imported variable in its collection.
  pos: Vec<usize>,
}

/// `wanted` if no id in `used` is it, else a fresh one.
fn fresh(gen: &mut IdGen, prefix: &str, wanted: Option<&String>, used: &mut HashSet<String>) -> String {
  let id = match wanted.filter(|w| !used.contains(*w)) {
    Some(w) => w.clone(),
    None => loop {
      let id = gen.next(prefix);
      if !used.contains(&id) {
        break id;
      }
    },
  };
  used.insert(id.clone());
  id
}

fn merge(doc: &Document, imported: Vec<IColl>, gen: &mut IdGen, report: &mut Report) -> Vec<Collection> {
  let mut out = plain(&doc.variables);
  let mut used_colls: HashSet<String> = out.iter().map(|c| c.id.clone()).collect();
  let mut used_vars: HashSet<String> = out.iter().flat_map(|c| c.variables.iter().map(|v| v.id.clone())).collect();
  let mut used_modes: HashSet<String> = out.iter().flat_map(|c| c.modes.iter().map(|m| m.id.clone())).collect();
  let mut matched: HashSet<usize> = HashSet::new();
  // Collection names are unique in a file, so the name finds the collection.
  let mut coll_by_name: HashMap<String, usize> = HashMap::new();
  for (i, c) in out.iter().enumerate() {
    coll_by_name.entry(c.name.clone()).or_insert(i);
  }

  // Collections and modes.
  let mut plans: Vec<Plan> = Vec::new();
  for ic in &imported {
    let existing = coll_by_name.get(&ic.name).copied().filter(|i| !matched.contains(i));
    let at = match existing {
      Some(i) => {
        let c = &mut out[i];
        // A file without modes of its own writes the destination's first mode, not a new one.
        let wanted: Vec<String> = match c.modes.first() {
          Some(first) if ic.synthetic => vec![first.name.clone()],
          _ => ic.modes.clone(),
        };
        for mname in &wanted {
          if c.modes.iter().any(|m| m.name == *mname) {
            continue;
          }
          let id = fresh(gen, "vm_", None, &mut used_modes);
          // Every variable starts the new mode at its default value.
          let default = c.modes.first().map(|m| m.id.clone());
          for v in &mut c.variables {
            let first = default
              .as_ref()
              .and_then(|d| v.values.get(d))
              .or_else(|| v.values.values().next())
              .cloned();
            if let Some(val) = first {
              Arc::make_mut(v).values.insert(id.clone(), val);
            }
          }
          c.modes.push(VarMode { id, name: mname.clone() });
          report.modes_added += 1;
        }
        i
      }
      None => {
        let id = fresh(gen, "vc_", ic.id.as_ref(), &mut used_colls);
        let names: Vec<String> = if ic.modes.is_empty() {
          vec!["Default".into()]
        } else {
          ic.modes.clone()
        };
        let modes = names
          .into_iter()
          .map(|name| VarMode {
            id: fresh(gen, "vm_", None, &mut used_modes),
            name,
          })
          .collect();
        out.push(Collection::new(&id, &ic.name, modes, Vec::new()));
        coll_by_name.entry(ic.name.clone()).or_insert(out.len() - 1);
        report.collections_added += 1;
        out.len() - 1
      }
    };
    matched.insert(at);
    let c = &out[at];
    // Imported mode -> destination mode id: by name, or the first mode for a file without modes.
    let modes = ic
      .modes
      .iter()
      .map(|n| match c.modes.first() {
        Some(first) if ic.synthetic && !c.modes.iter().any(|m| m.name == *n) => first.id.clone(),
        _ => c.modes.iter().find(|m| m.name == *n).map(|m| m.id.clone()).unwrap_or_default(),
      })
      .collect();
    plans.push(Plan {
      at,
      modes,
      vars: vec![None; ic.vars.len()],
      pos: vec![0; ic.vars.len()],
    });
  }

  // Variables: matched by id (Designotron files), then by name.
  let mut is_new: Vec<Vec<bool>> = Vec::new();
  for (ci, ic) in imported.iter().enumerate() {
    let at = plans[ci].at;
    let mut news = vec![false; ic.vars.len()];
    let c = &mut out[at];
    let mut by_id: HashMap<String, usize> = HashMap::new();
    let mut by_name: HashMap<String, usize> = HashMap::new();
    for (i, v) in c.variables.iter().enumerate() {
      by_id.entry(v.id.clone()).or_insert(i);
      by_name.entry(v.name.clone()).or_insert(i);
    }
    for (vi, iv) in ic.vars.iter().enumerate() {
      let hit = iv
        .id
        .as_ref()
        .and_then(|id| by_id.get(id))
        .or_else(|| by_name.get(&iv.name))
        .copied();
      match hit {
        Some(i) if c.variables[i].kind != iv.kind => report.skip(
          format!("{}/{}", ic.name, iv.name),
          "the file already has a variable of this name with another type",
        ),
        Some(i) => {
          plans[ci].vars[vi] = Some(c.variables[i].id.clone());
          plans[ci].pos[vi] = i;
        }
        None => {
          let id = fresh(gen, "v_", iv.id.as_ref(), &mut used_vars);
          let i = c.variables.len();
          c.variables.push(Arc::new(Variable {
            id: id.clone(),
            name: iv.name.clone(),
            kind: iv.kind,
            values: BTreeMap::new(),
            description: iv.description.clone(),
            scopes: iv.scopes.clone(),
          }));
          by_id.insert(id.clone(), i);
          by_name.insert(iv.name.clone(), i);
          plans[ci].vars[vi] = Some(id);
          plans[ci].pos[vi] = i;
          news[vi] = true;
          report.variables_added += 1;
        }
      }
    }
    is_new.push(news);
  }

  // Values.
  for (ci, ic) in imported.iter().enumerate() {
    let at = plans[ci].at;
    let all_modes: Vec<String> = out[at].modes.iter().map(|m| m.id.clone()).collect();
    for (vi, iv) in ic.vars.iter().enumerate() {
      if plans[ci].vars[vi].is_none() {
        continue;
      }
      let mut values: BTreeMap<String, Value> = BTreeMap::new();
      for (mi, val) in &iv.values {
        let mode = plans[ci].modes[*mi].clone();
        let v = match val {
          IVal::Lit(v) => check_value(iv.kind, v).ok(),
          IVal::Alias(tc, tv) => plans
            .get(*tc)
            .and_then(|p| p.vars.get(*tv))
            .and_then(|t| t.as_ref())
            .map(|t| json!({ "alias": t })),
        };
        match v {
          Some(v) => {
            values.insert(mode, v);
          }
          None => report.skip(format!("{}/{}", ic.name, iv.name), "the value doesn't fit the variable's type"),
        }
      }
      let var = Arc::make_mut(&mut out[at].variables[plans[ci].pos[vi]]);
      if is_new[ci][vi] {
        // Modes the file doesn't have start at its first value.
        let first = iv.values.keys().next().and_then(|mi| values.get(&plans[ci].modes[*mi])).cloned();
        let fill = first.unwrap_or_else(|| default_value(iv.kind));
        for m in &all_modes {
          let v = values.get(m).cloned().unwrap_or_else(|| fill.clone());
          var.values.insert(m.clone(), v);
        }
      } else {
        let mut changed = false;
        for (m, v) in values {
          if var.values.get(&m) != Some(&v) {
            var.values.insert(m, v);
            changed = true;
          }
        }
        if changed {
          report.variables_updated += 1;
        }
      }
    }
  }
  out
}
