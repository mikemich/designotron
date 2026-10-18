//! Design lint: finds accessibility and consistency problems and proposes
//! fixes as ready-to-dispatch commands.

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::{json, Value};

use crate::color::{self, Rgba};
use crate::model::{Document, Node, NodeId, NodeType, Paint, TextAutoResize, Trigger};
use crate::text::{layout_for_node, TextMeasurer};

const MIN_TEXT: f64 = 12.0;
const MIN_TAP: f64 = 44.0;
/// Spacing scale; odd pixel values usually mean a nudge went wrong.
const GRID: f64 = 2.0;
const DEFAULT_NAMES: &[&str] = &["Frame", "Rectangle", "Ellipse", "Group", "Vector", "Polygon", "Star", "Line"];

#[derive(Serialize, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub enum Severity {
  Error,
  Warning,
  Info,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
  pub node_id: NodeId,
  pub node_name: String,
  pub kind: &'static str,
  pub severity: Severity,
  pub message: String,
  /// Short label for the fix button.
  pub fix_label: Option<String>,
  /// Engine command that fixes the issue.
  pub fix: Option<Value>,
}

/// Lints every layer on a page.
pub fn lint_page(doc: &Document, page: &str, m: &dyn TextMeasurer) -> Vec<Issue> {
  let mut out = Vec::new();
  let page_bg = doc.page(page).map(|p| p.background.clone()).unwrap_or_else(|| "#FFFFFF".into());
  let nodes = doc.page_nodes(page);
  for id in &nodes {
    let Some(n) = doc.get(id) else { continue };
    if !n.visible || doc.instance_ancestor(id).is_some() {
      continue;
    }
    if n.kind == NodeType::Text {
      check_text(doc, n, &page_bg, m, &mut out);
    }
    check_spacing(n, &mut out);
    check_tap_target(doc, n, &mut out);
    check_name(n, &mut out);
  }
  check_colors(doc, &nodes, &mut out);
  out.sort_by(|a, b| a.severity.cmp(&b.severity));
  out
}

fn issue(n: &Node, kind: &'static str, severity: Severity, message: String, fix: Option<(&str, Value)>) -> Issue {
  Issue {
    node_id: n.id.clone(),
    node_name: n.name.clone(),
    kind,
    severity,
    message,
    fix_label: fix.as_ref().map(|(l, _)| l.to_string()),
    fix: fix.map(|(_, v)| v),
  }
}

fn update(id: &str, patch: Value) -> Value {
  json!({ "op": "update", "ids": [id], "patch": patch })
}

fn check_text(doc: &Document, n: &Node, page_bg: &str, m: &dyn TextMeasurer, out: &mut Vec<Issue>) {
  let Some(t) = n.text.as_ref() else { return };
  if t.characters.trim().is_empty() {
    return;
  }
  if t.font_size < MIN_TEXT {
    out.push(issue(
      n,
      "tinyText",
      Severity::Warning,
      format!("Text is {}px; under {MIN_TEXT}px is hard to read.", t.font_size),
      Some(("Set to 12px", update(&n.id, json!({ "text": { "fontSize": MIN_TEXT } })))),
    ));
  }
  let disabled = std::iter::once(n.id.clone())
    .chain(doc.ancestors(&n.id))
    .filter_map(|a| doc.get(&a).map(|x| x.name.to_lowercase()))
    .any(|name| name.contains("disabled"));
  if disabled {
    // WCAG exempts inactive controls from contrast requirements.
  } else if let (Some(fg), Some((bg, bg_node))) = (solid(&n.fills), background_of(doc, n, page_bg)) {
    let ratio = contrast(fg, bg);
    let large = t.font_size >= 24.0 || (t.font_size >= 18.66 && t.font_weight >= 700);
    let needed = if large { 3.0 } else { 4.5 };
    if ratio < needed {
      let dark = Rgba {
        r: 17,
        g: 24,
        b: 39,
        a: 1.0,
      };
      let light = Rgba {
        r: 255,
        g: 255,
        b: 255,
        a: 1.0,
      };
      let better = if contrast(dark, bg) >= contrast(light, bg) { dark } else { light };
      let fix = if contrast(better, bg) >= needed && better.hex6() != fg.hex6() {
        let hex = better.hex6();
        Some((
          format!("Use {hex}"),
          update(&n.id, json!({ "fills": [{ "type": "solid", "color": hex }] })),
        ))
      } else {
        // The text colour is already the best choice: adjust the background instead.
        bg_node.and_then(|bid| {
          let adjusted = adjust_for_contrast(fg, bg, needed)?;
          let hex = adjusted.hex6();
          Some((
            format!("Background {hex}"),
            update(&bid, json!({ "fills": [{ "type": "solid", "color": hex }] })),
          ))
        })
      };
      out.push(issue(
        n,
        "lowContrast",
        Severity::Error,
        format!("Contrast {:.1}:1 against {}; WCAG AA needs {needed}:1.", ratio, bg.hex6()),
        fix.as_ref().map(|(l, v)| (l.as_str(), v.clone())),
      ));
    }
  }
  if t.auto_resize == TextAutoResize::None {
    let lay = layout_for_node(t, n.width, m);
    if lay.height > n.height + 1.0 {
      out.push(issue(
        n,
        "clippedText",
        Severity::Warning,
        "Text is taller than its fixed box and gets cut off.".into(),
        Some(("Auto height", update(&n.id, json!({ "text": { "autoResize": "height" } })))),
      ));
    }
  }
}

fn check_spacing(n: &Node, out: &mut Vec<Issue>) {
  let Some(al) = n.layout.as_ref() else { return };
  let vals = [al.gap, al.padding_top, al.padding_right, al.padding_bottom, al.padding_left];
  if vals.iter().any(|v| (v % GRID).abs() > 0.01 && (GRID - v % GRID).abs() > 0.01) {
    let snap = |v: f64| (v / GRID).round() * GRID;
    out.push(issue(
      n,
      "offGrid",
      Severity::Info,
      format!(
        "Spacing {} isn't on the {GRID}px grid.",
        vals.iter().map(|v| crate::geom::fmt(*v)).collect::<Vec<_>>().join("/")
      ),
      Some((
        "Snap to grid",
        update(
          &n.id,
          json!({ "layout": {
            "gap": snap(al.gap), "paddingTop": snap(al.padding_top), "paddingRight": snap(al.padding_right),
            "paddingBottom": snap(al.padding_bottom), "paddingLeft": snap(al.padding_left)
          } }),
        ),
      )),
    ));
  }
}

fn check_tap_target(doc: &Document, n: &Node, out: &mut Vec<Issue>) {
  let clickable = n
    .interactions
    .iter()
    .any(|i| matches!(i.trigger, Trigger::OnClick | Trigger::OnPress));
  if !clickable {
    return;
  }
  let screen_w = doc.get(&doc.top_level_of(&n.id)).map(|s| s.width).unwrap_or(0.0);
  if screen_w >= 600.0 || (n.width >= MIN_TAP && n.height >= MIN_TAP) {
    return;
  }
  out.push(issue(
    n,
    "smallTapTarget",
    Severity::Warning,
    format!(
      "Tap target is {}×{}; aim for at least {MIN_TAP}×{MIN_TAP} on touch screens.",
      n.width.round(),
      n.height.round()
    ),
    Some((
      "Make 44px",
      update(
        &n.id,
        json!({ "width": n.width.max(MIN_TAP), "height": n.height.max(MIN_TAP), "sizingH": "fixed", "sizingV": "fixed" }),
      ),
    )),
  ));
}

fn check_name(n: &Node, out: &mut Vec<Issue>) {
  if !n.kind.is_container() || n.children.len() < 2 {
    return;
  }
  let default = DEFAULT_NAMES.iter().any(|d| {
    n.name == *d
      || n
        .name
        .strip_prefix(d)
        .map(|r| r.trim().chars().all(|c| c.is_ascii_digit()))
        .unwrap_or(false)
  });
  if default {
    out.push(issue(
      n,
      "defaultName",
      Severity::Info,
      format!(
        "\"{}\" has a default name; descriptive names make better code and components.",
        n.name
      ),
      None,
    ));
  }
}

/// Near-duplicate solid colours (visually indistinguishable but not equal).
fn check_colors(doc: &Document, nodes: &[NodeId], out: &mut Vec<Issue>) {
  let mut counts: BTreeMap<String, usize> = BTreeMap::new();
  for id in nodes {
    if let Some(n) = doc.get(id) {
      for p in &n.fills {
        if let Paint::Solid { color, .. } = p {
          *counts.entry(color::normalize(color)).or_default() += 1;
        }
      }
    }
  }
  let colors: Vec<(String, usize)> = counts.into_iter().collect();
  let mut unlinked: BTreeMap<String, Vec<NodeId>> = BTreeMap::new();
  for id in nodes {
    let Some(n) = doc.get(id) else { continue };
    if n.fill_style.is_some() || doc.instance_ancestor(id).is_some() {
      continue;
    }
    let Some(Paint::Solid { color, .. }) = n.fills.iter().find(|p| p.visible()) else {
      continue;
    };
    let mine = color::normalize(color);
    let my_count = colors.iter().find(|(c, _)| *c == mine).map(|(_, k)| *k).unwrap_or(0);
    // A more common colour that is almost identical.
    let near = colors
      .iter()
      .filter(|(c, k)| *c != mine && *k > my_count && distance(c, &mine) < 2.5)
      .max_by_key(|(_, k)| *k);
    if let Some((target, _)) = near {
      out.push(issue(
        n,
        "nearDuplicateColor",
        Severity::Info,
        format!("{mine} is almost {target}, which is used more often."),
        Some((
          &format!("Use {target}"),
          update(&n.id, json!({ "fills": [{ "type": "solid", "color": target }] })),
        )),
      ));
      continue;
    }
    if let Some(style) = doc.styles.colors.iter().find(|s| color::normalize(&s.color) == mine) {
      unlinked.entry(style.id.clone()).or_default().push(n.id.clone());
    }
  }
  report_unlinked(doc, unlinked, out);
}

/// One issue per colour style whose colour is used without linking the style.
fn report_unlinked(doc: &Document, unlinked: BTreeMap<String, Vec<NodeId>>, out: &mut Vec<Issue>) {
  for (style_id, ids) in unlinked {
    let (Some(style), Some(first)) = (
      doc.styles.colors.iter().find(|s| s.id == style_id),
      ids.first().and_then(|i| doc.get(i)),
    ) else {
      continue;
    };
    let mut i = issue(
      first,
      "unlinkedStyle",
      Severity::Info,
      format!(
        "{} layer(s) use the colour of \"{}\" without linking the style.",
        ids.len(),
        style.name
      ),
      Some(("Link style", json!({ "op": "applyStyle", "ids": ids, "styleId": style.id }))),
    );
    i.node_name = format!("{} and others", first.name);
    out.push(i);
  }
}

fn solid(paints: &[Paint]) -> Option<Rgba> {
  paints.iter().rev().find(|p| p.visible()).and_then(|p| match p {
    Paint::Solid { color, opacity, .. } => color::parse(color).map(|c| c.with_alpha(*opacity)),
    Paint::LinearGradient { stops, .. } | Paint::RadialGradient { stops, .. } => stops.first().and_then(|s| color::parse(&s.color)),
    Paint::Image { .. } => None,
  })
}

/// Darkens (for light text) or lightens (for dark text) a background until it passes.
fn adjust_for_contrast(fg: Rgba, bg: Rgba, needed: f64) -> Option<Rgba> {
  let toward_black = luminance(fg) > luminance(bg);
  for step in 1..=50 {
    let k = step as f64 * 0.02;
    let mix = |c: u8| {
      let target = if toward_black { 0.0 } else { 255.0 };
      (c as f64 + (target - c as f64) * k).round() as u8
    };
    let c = Rgba {
      r: mix(bg.r),
      g: mix(bg.g),
      b: mix(bg.b),
      a: 1.0,
    };
    if contrast(fg, c) >= needed {
      return Some(c);
    }
  }
  None
}

/// The colour behind a node (and the layer that paints it, unless it is the page):
/// covering siblings below it, then filled ancestors, then the page.
fn background_of(doc: &Document, n: &Node, page_bg: &str) -> Option<(Rgba, Option<NodeId>)> {
  let bounds = doc.abs_bounds(&n.id);
  let mut cur = n.id.clone();
  loop {
    let siblings = doc.siblings_of(&cur);
    let idx = siblings.iter().position(|s| *s == cur).unwrap_or(0);
    for s in siblings[..idx].iter().rev() {
      let Some(sn) = doc.get(s) else { continue };
      if sn.visible && sn.kind != NodeType::Text && doc.abs_bounds(s).contains_rect(&bounds) {
        if let Some(c) = solid(&sn.fills).filter(|c| c.a > 0.9) {
          return Some((c, Some(s.clone())));
        }
      }
    }
    let parent = doc.get(&cur).and_then(|x| x.parent.clone());
    match parent {
      Some(p) => {
        if let Some(c) = doc.get(&p).and_then(|pn| solid(&pn.fills)).filter(|c| c.a > 0.9) {
          return Some((c, Some(p)));
        }
        cur = p;
      }
      None => return color::parse(page_bg).map(|c| (c, None)),
    }
  }
}

fn luminance(c: Rgba) -> f64 {
  let ch = |v: u8| {
    let s = v as f64 / 255.0;
    if s <= 0.03928 {
      s / 12.92
    } else {
      ((s + 0.055) / 1.055).powf(2.4)
    }
  };
  0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b)
}

/// WCAG contrast ratio, blending a translucent foreground over the background.
pub fn contrast(fg: Rgba, bg: Rgba) -> f64 {
  let blend = |f: u8, b: u8| (f as f64 * fg.a + b as f64 * (1.0 - fg.a)).round() as u8;
  let fg = Rgba {
    r: blend(fg.r, bg.r),
    g: blend(fg.g, bg.g),
    b: blend(fg.b, bg.b),
    a: 1.0,
  };
  let (a, b) = (luminance(fg), luminance(bg));
  (a.max(b) + 0.05) / (a.min(b) + 0.05)
}

fn distance(a: &str, b: &str) -> f64 {
  match (color::parse(a), color::parse(b)) {
    (Some(x), Some(y)) => {
      (((x.r as f64 - y.r as f64).powi(2) + (x.g as f64 - y.g as f64).powi(2) + (x.b as f64 - y.b as f64).powi(2)) / 3.0).sqrt()
    }
    _ => f64::MAX,
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::engine::{Command, Engine};
  use crate::text::HeuristicMeasurer;

  fn has(issues: &[Issue], kind: &str) -> bool {
    issues.iter().any(|i| i.kind == kind)
  }

  #[test]
  fn wcag_contrast_values() {
    let black = Rgba { r: 0, g: 0, b: 0, a: 1.0 };
    let white = Rgba {
      r: 255,
      g: 255,
      b: 255,
      a: 1.0,
    };
    assert!((contrast(black, white) - 21.0).abs() < 0.01);
    assert!((contrast(white, white) - 1.0).abs() < 0.01);
  }

  #[test]
  fn white_on_mid_purple_darkens_background() {
    let mut e = Engine::new(Box::new(HeuristicMeasurer), 6);
    e.dispatch(Command::Ai {
      tool: "create_nodes".into(),
      input: json!({ "nodes": [{ "type": "frame", "name": "Button", "fill": "#7C5CFF", "layout": { "padding": 12 },
        "children": [{ "type": "text", "text": "Get started", "color": "#FFFFFF" }] }] }),
    })
    .unwrap();
    let page = e.page.clone();
    let issues = lint_page(&e.doc, &page, &HeuristicMeasurer);
    let i = issues.iter().find(|i| i.kind == "lowContrast").expect("contrast issue");
    assert!(i.fix_label.as_deref().unwrap().starts_with("Background"));
    let cmd: Command = serde_json::from_value(i.fix.clone().unwrap()).unwrap();
    e.dispatch(cmd).unwrap();
    assert!(!lint_page(&e.doc, &page, &HeuristicMeasurer).iter().any(|i| i.kind == "lowContrast"));
  }

  #[test]
  fn finds_and_fixes_issues() {
    let mut e = Engine::new(Box::new(HeuristicMeasurer), 5);
    e.dispatch(Command::Ai {
      tool: "create_nodes".into(),
      input: json!({ "nodes": [{
        "type": "frame", "name": "Frame 1", "width": 390, "height": 400, "fill": "#FFFFFF",
        "layout": { "direction": "vertical", "gap": 7, "padding": 15 },
        "children": [
          { "type": "text", "text": "Faint", "color": "#DDDDDD" },
          { "type": "text", "text": "Tiny", "fontSize": 9, "color": "#111111" },
          { "type": "rectangle", "width": 20, "height": 20, "fill": "#7C5CFF" },
          { "type": "rectangle", "width": 20, "height": 20, "fill": "#7C5CFF" },
          { "type": "rectangle", "width": 20, "height": 20, "fill": "#7D5CFE" }
        ]
      }] }),
    })
    .unwrap();
    let page = e.page.clone();
    let issues = lint_page(&e.doc, &page, &HeuristicMeasurer);
    for k in ["lowContrast", "tinyText", "offGrid", "defaultName", "nearDuplicateColor"] {
      assert!(has(&issues, k), "missing {k}: {issues:?}");
    }
    // Apply every fix; the fixable issues disappear.
    for i in issues.iter().filter(|i| i.fix.is_some()) {
      let cmd: Command = serde_json::from_value(i.fix.clone().unwrap()).unwrap();
      e.dispatch(cmd).unwrap();
    }
    let after = lint_page(&e.doc, &page, &HeuristicMeasurer);
    assert!(after.iter().all(|i| i.fix.is_none()), "{after:?}");
  }
}
