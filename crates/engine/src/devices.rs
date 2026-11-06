//! Device presets and the system UI of device frames (status bars, home indicators, window and
//! browser chrome), built as plain locked layers that code export leaves out.
//!
//! The chrome is rebuilt from (preset, theme, toggles) every time, so it is always the same;
//! `Node::device_part` marks the roots. Insets (the safe area) are added to a device frame's
//! auto layout padding and remembered in `DeviceFrame::applied`, so changing the device later
//! only shifts the padding by the difference.
//!
//! Values marked "unverified" below were taken from commonly used design-kit numbers or derived
//! from screen specs and have not been checked against Apple's or Google's own tables.

use serde_json::{json, Value};

use crate::doc::IdGen;
use crate::model::{
  Align, AutoLayout, ConstraintH, ConstraintV, Constraints, DeviceFrame, Document, LayoutDirection, Node, NodeId, NodeType, Paint, RawPath,
  ScrollBehavior, Sizing, StrokeAlign, TextProps, VectorData,
};
use crate::ops::default_node;

/// Which system UI a preset gets.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
  /// iPhone with a Dynamic Island.
  IosIsland,
  /// iPhone with a notch.
  IosNotch,
  /// iPhone with a home button: a status bar and no home indicator.
  IosHome,
  IpadHome,
  Android,
  MacWindow,
  Browser,
  /// A plain size (social, print, slides, bare desktop).
  Plain,
}

pub struct Preset {
  pub id: &'static str,
  pub group: &'static str,
  pub label: &'static str,
  pub w: f64,
  pub h: f64,
  pub kind: Kind,
  /// Safe area: top, right, bottom, left.
  pub insets: [f64; 4],
}

const fn p(id: &'static str, group: &'static str, label: &'static str, w: f64, h: f64, kind: Kind, insets: [f64; 4]) -> Preset {
  Preset {
    id,
    group,
    label,
    w,
    h,
    kind,
    insets,
  }
}

const NO_INSETS: [f64; 4] = [0.0; 4];
const fn phone(top: f64, bottom: f64) -> [f64; 4] {
  [top, 0.0, bottom, 0.0]
}

/// Browser chrome: tab strip 40 plus toolbar 44 (a generic look, not a spec; unverified).
const BROWSER_BAR: f64 = 84.0;
/// macOS title bar height (unverified; check against Apple's macOS Figma kit).
const TITLE_BAR: f64 = 28.0;
/// Android navigation bar: gesture 24dp, three buttons 48dp (AOSP dimens).
const NAV_GESTURE: f64 = 24.0;
const NAV_BUTTONS: f64 = 48.0;
const GROUP_PHONE: &str = "Phone";
const GROUP_TABLET: &str = "Tablet";
const GROUP_DESKTOP: &str = "Desktop";
const GROUP_WEB: &str = "Web";
const GROUP_SOCIAL: &str = "Social";
const GROUP_PRINT: &str = "Print";
const GROUP_SLIDES: &str = "Presentation";

use Kind::{Android, Browser, IosHome, IosIsland, IosNotch, IpadHome, MacWindow, Plain};

/// Sizes in pt/dp/px. Notes: iPhone 16 and 17 sizes and insets come from useyourloaf's screen
/// size tables; iPhone 16e insets are the iPhone 14's and iPhone SE's top 20 is unverified; all
/// Android sizes and insets are unverified (24dp status bar and gesture bar from AOSP; devices
/// with cutouts report a taller status bar); iPad sizes are from a secondary chart and the 24/20
/// insets are verified for the iPad mini 6 only; MacBook sizes are the default scaled
/// resolutions (the Air 13" is contested: spec sites say 1280x832, and the 15" is unverified);
/// social sizes follow Hootsuite and Buffer; print is points at 72 dpi.
pub const PRESETS: &[Preset] = &[
  p("iphone-17", GROUP_PHONE, "iPhone 17", 402.0, 874.0, IosIsland, phone(62.0, 34.0)),
  p(
    "iphone-17-pro",
    GROUP_PHONE,
    "iPhone 17 Pro",
    402.0,
    874.0,
    IosIsland,
    phone(62.0, 34.0),
  ),
  p(
    "iphone-17-pro-max",
    GROUP_PHONE,
    "iPhone 17 Pro Max",
    440.0,
    956.0,
    IosIsland,
    phone(62.0, 34.0),
  ),
  p("iphone-air", GROUP_PHONE, "iPhone Air", 420.0, 912.0, IosIsland, phone(68.0, 34.0)),
  p("iphone-16", GROUP_PHONE, "iPhone 16", 393.0, 852.0, IosIsland, phone(59.0, 34.0)),
  p(
    "iphone-16-plus",
    GROUP_PHONE,
    "iPhone 16 Plus",
    430.0,
    932.0,
    IosIsland,
    phone(59.0, 34.0),
  ),
  p("iphone-16e", GROUP_PHONE, "iPhone 16e", 390.0, 844.0, IosNotch, phone(47.0, 34.0)),
  p("iphone-se", GROUP_PHONE, "iPhone SE", 375.0, 667.0, IosHome, phone(20.0, 0.0)),
  p(
    "android-compact",
    GROUP_PHONE,
    "Android compact",
    360.0,
    800.0,
    Android,
    phone(24.0, 24.0),
  ),
  p(
    "android-medium",
    GROUP_PHONE,
    "Android medium",
    412.0,
    917.0,
    Android,
    phone(24.0, 24.0),
  ),
  p("pixel-9", GROUP_PHONE, "Pixel 9", 412.0, 923.0, Android, phone(24.0, 24.0)),
  p("galaxy-s25", GROUP_PHONE, "Galaxy S25", 360.0, 780.0, Android, phone(24.0, 24.0)),
  p("ipad-mini", GROUP_TABLET, "iPad mini", 744.0, 1133.0, IpadHome, phone(24.0, 20.0)),
  p(
    "ipad-air-11",
    GROUP_TABLET,
    "iPad Air 11\"",
    820.0,
    1180.0,
    IpadHome,
    phone(24.0, 20.0),
  ),
  p(
    "ipad-air-13",
    GROUP_TABLET,
    "iPad Air 13\"",
    1024.0,
    1366.0,
    IpadHome,
    phone(24.0, 20.0),
  ),
  p(
    "ipad-pro-11",
    GROUP_TABLET,
    "iPad Pro 11\"",
    834.0,
    1210.0,
    IpadHome,
    phone(24.0, 20.0),
  ),
  p(
    "ipad-pro-13",
    GROUP_TABLET,
    "iPad Pro 13\"",
    1032.0,
    1376.0,
    IpadHome,
    phone(24.0, 20.0),
  ),
  p("macbook-pro-14", GROUP_DESKTOP, "MacBook Pro 14\"", 1512.0, 982.0, Plain, NO_INSETS),
  p(
    "macbook-pro-16",
    GROUP_DESKTOP,
    "MacBook Pro 16\"",
    1728.0,
    1117.0,
    Plain,
    NO_INSETS,
  ),
  p("macbook-air-13", GROUP_DESKTOP, "MacBook Air 13\"", 1470.0, 956.0, Plain, NO_INSETS),
  p(
    "macbook-air-15",
    GROUP_DESKTOP,
    "MacBook Air 15\"",
    1710.0,
    1112.0,
    Plain,
    NO_INSETS,
  ),
  p("desktop-1440", GROUP_DESKTOP, "Desktop", 1440.0, 1024.0, Plain, NO_INSETS),
  p("desktop-1920", GROUP_DESKTOP, "Desktop HD", 1920.0, 1080.0, Plain, NO_INSETS),
  p(
    "mac-window",
    GROUP_DESKTOP,
    "Mac window",
    1280.0,
    800.0,
    MacWindow,
    [TITLE_BAR, 0.0, 0.0, 0.0],
  ),
  p(
    "browser-1280",
    GROUP_WEB,
    "Browser 1280",
    1280.0,
    800.0,
    Browser,
    [BROWSER_BAR, 0.0, 0.0, 0.0],
  ),
  p(
    "browser-1366",
    GROUP_WEB,
    "Browser 1366",
    1366.0,
    768.0,
    Browser,
    [BROWSER_BAR, 0.0, 0.0, 0.0],
  ),
  p(
    "browser-1440",
    GROUP_WEB,
    "Browser 1440",
    1440.0,
    900.0,
    Browser,
    [BROWSER_BAR, 0.0, 0.0, 0.0],
  ),
  p(
    "browser-1536",
    GROUP_WEB,
    "Browser 1536",
    1536.0,
    864.0,
    Browser,
    [BROWSER_BAR, 0.0, 0.0, 0.0],
  ),
  p(
    "browser-1920",
    GROUP_WEB,
    "Browser 1920",
    1920.0,
    1080.0,
    Browser,
    [BROWSER_BAR, 0.0, 0.0, 0.0],
  ),
  p("x-header", GROUP_SOCIAL, "X header", 1500.0, 500.0, Plain, NO_INSETS),
  p("youtube-banner", GROUP_SOCIAL, "YouTube banner", 2560.0, 1440.0, Plain, NO_INSETS),
  p(
    "youtube-thumbnail",
    GROUP_SOCIAL,
    "YouTube thumbnail",
    1280.0,
    720.0,
    Plain,
    NO_INSETS,
  ),
  p("linkedin-banner", GROUP_SOCIAL, "LinkedIn banner", 1584.0, 396.0, Plain, NO_INSETS),
  p(
    "linkedin-company",
    GROUP_SOCIAL,
    "LinkedIn company",
    1128.0,
    191.0,
    Plain,
    NO_INSETS,
  ),
  p("facebook-cover", GROUP_SOCIAL, "Facebook cover", 851.0, 315.0, Plain, NO_INSETS),
  p("instagram-square", GROUP_SOCIAL, "Instagram post", 1080.0, 1080.0, Plain, NO_INSETS),
  p(
    "instagram-portrait",
    GROUP_SOCIAL,
    "Instagram portrait",
    1080.0,
    1350.0,
    Plain,
    NO_INSETS,
  ),
  p("instagram-story", GROUP_SOCIAL, "Instagram story", 1080.0, 1920.0, Plain, NO_INSETS),
  p("open-graph", GROUP_SOCIAL, "Open Graph", 1200.0, 630.0, Plain, NO_INSETS),
  p("a4", GROUP_PRINT, "A4", 595.0, 842.0, Plain, NO_INSETS),
  p("letter", GROUP_PRINT, "Letter", 612.0, 792.0, Plain, NO_INSETS),
  p("business-card-us", GROUP_PRINT, "Business card US", 252.0, 144.0, Plain, NO_INSETS),
  p("business-card-eu", GROUP_PRINT, "Business card EU", 241.0, 156.0, Plain, NO_INSETS),
  p("slide-16-9", GROUP_SLIDES, "Slide 16:9", 1920.0, 1080.0, Plain, NO_INSETS),
  p("slide-4-3", GROUP_SLIDES, "Slide 4:3", 1024.0, 768.0, Plain, NO_INSETS),
];

pub const PARTS: &[&str] = &["statusBar", "homeIndicator", "navBar", "titleBar", "browserBar"];

// Chrome geometry (unverified, from commonly used Apple-kit values): Dynamic Island 126x37 with
// radius 18.5, 11 from the top; home indicator 134x5 (iPad 315x5), 8 from the bottom.
const ISLAND: (f64, f64, f64) = (126.0, 37.0, 11.0);
const NOTCH: (f64, f64) = (162.0, 30.0);
const HOME_BAR: f64 = 134.0;
const HOME_BAR_IPAD: f64 = 315.0;
const HOME_BAR_BOTTOM: f64 = 8.0;

pub fn find(id: &str) -> Option<&'static Preset> {
  PRESETS.iter().find(|p| p.id == id)
}

/// Up to five preset ids that look like `id`, for error messages.
pub fn suggest(id: &str) -> Vec<&'static str> {
  let want = id.to_lowercase();
  let tokens: Vec<&str> = want.split(|c: char| !c.is_alphanumeric()).filter(|t| !t.is_empty()).collect();
  let mut scored: Vec<(usize, &'static str)> = PRESETS
    .iter()
    .map(|p| {
      let hay = format!("{} {}", p.id, p.label.to_lowercase());
      (tokens.iter().filter(|t| hay.contains(**t)).count(), p.id)
    })
    .filter(|(s, _)| *s > 0)
    .collect();
  scored.sort_by_key(|s| std::cmp::Reverse(s.0));
  let mut out: Vec<&'static str> = scored.into_iter().map(|(_, id)| id).take(5).collect();
  if out.is_empty() {
    out = PRESETS.iter().filter(|p| p.kind != Plain).map(|p| p.id).take(5).collect();
  }
  out
}

/// The preset table for the preset pickers.
pub fn presets_json() -> Value {
  Value::Array(
    PRESETS
      .iter()
      .map(|p| {
        json!({
          "id": p.id,
          "group": p.group,
          "label": p.label,
          "w": p.w,
          "h": p.h,
          "kind": kind_name(p.kind),
          "insets": p.insets,
        })
      })
      .collect(),
  )
}

fn kind_name(k: Kind) -> &'static str {
  match k {
    IosIsland => "iosIsland",
    IosNotch => "iosNotch",
    IosHome => "iosHome",
    IpadHome => "ipadHome",
    Android => "android",
    MacWindow => "macWindow",
    Browser => "browser",
    Plain => "none",
  }
}

/// Reads the `device` property of an AI spec: a preset id, `{preset, theme, ...}` or null (none).
/// `base` is the frame's current device; unnamed settings stay as they are.
pub fn parse_spec(v: &Value, base: Option<&DeviceFrame>) -> Result<Option<DeviceFrame>, String> {
  let mut d = base.cloned().unwrap_or_default();
  let obj = match v {
    Value::Null => return Ok(Option::None),
    Value::String(s) => {
      d.preset = s.trim().to_lowercase();
      None
    }
    Value::Object(m) => Some(m),
    other => {
      return Err(format!(
        "must be a preset id, an object {{preset, theme, ...}} or null, got {}",
        kind_of(other)
      ))
    }
  };
  if let Some(m) = obj {
    if let Some(s) = m.get("preset") {
      d.preset = s.as_str().ok_or("device.preset must be a preset id")?.trim().to_lowercase();
    } else if base.is_none() {
      return Err("device.preset is required".into());
    }
    if let Some(t) = m.get("theme") {
      match t.as_str() {
        Some(x @ ("light" | "dark")) => d.theme = x.into(),
        _ => return Err("device.theme must be 'light' or 'dark'".into()),
      }
    }
    if let Some(n) = m.get("nav") {
      match n.as_str() {
        Some(x @ ("gesture" | "buttons")) => d.nav = x.into(),
        _ => return Err("device.nav must be 'gesture' or 'buttons'".into()),
      }
    }
    if let Some(u) = m.get("url") {
      d.url = u.as_str().ok_or("device.url must be a string")?.to_string();
    }
    for (key, slot) in [
      ("statusBar", &mut d.status_bar),
      ("homeIndicator", &mut d.home_indicator),
      ("chrome", &mut d.chrome),
      ("pad", &mut d.pad),
    ] {
      if let Some(b) = m.get(key) {
        *slot = b.as_bool().ok_or_else(|| format!("device.{key} must be true or false"))?;
      }
    }
  }
  if find(&d.preset).is_none() {
    return Err(format!(
      "unknown device preset '{}'; close ids: {}",
      d.preset,
      suggest(&d.preset).join(", ")
    ));
  }
  Ok(Some(d))
}

fn kind_of(v: &Value) -> &'static str {
  match v {
    Value::Null => "null",
    Value::Bool(_) => "a boolean",
    Value::Number(_) => "a number",
    Value::String(_) => "a string",
    Value::Array(_) => "an array",
    Value::Object(_) => "an object",
  }
}

/// The safe area of a device with the given toggles: top, right, bottom, left.
pub fn insets(p: &Preset, d: &DeviceFrame) -> [f64; 4] {
  let [t, r, b, l] = p.insets;
  match p.kind {
    IosIsland | IosNotch | IpadHome => [if d.status_bar { t } else { 0.0 }, r, if d.home_indicator { b } else { 0.0 }, l],
    IosHome => [if d.status_bar { t } else { 0.0 }, r, 0.0, l],
    Android => [
      if d.status_bar { t } else { 0.0 },
      r,
      match (d.home_indicator, d.nav == "buttons") {
        (false, _) => 0.0,
        (true, true) => NAV_BUTTONS,
        (true, false) => NAV_GESTURE,
      },
      l,
    ],
    MacWindow | Browser => [if d.chrome { t } else { 0.0 }, r, b, l],
    Plain => NO_INSETS,
  }
}

/// A device frame's safe area as its toggles stand now (for guides and snapping).
pub fn safe_insets(n: &Node) -> Option<[f64; 4]> {
  let d = n.device.as_ref()?;
  let preset = find(&d.preset)?;
  Some(insets(preset, d))
}

/// Whether `id` is a system UI part or lies inside one.
pub fn in_part(doc: &Document, id: &str) -> bool {
  let mut cur = doc.get(id);
  while let Some(n) = cur {
    if n.device_part.is_some() {
      return true;
    }
    cur = n.parent.as_deref().and_then(|p| doc.get(p));
  }
  false
}

/// Whether the device is an iPhone, iPad or Android phone (safe-area insets mean something there).
pub fn is_mobile(d: &DeviceFrame) -> bool {
  find(&d.preset).is_some_and(|p| matches!(p.kind, IosIsland | IosNotch | IosHome | IpadHome | Android))
}

/// Puts `device` on a frame or main component (or takes it off with `None`): the system UI
/// layers are rebuilt as its last children, `resize` sets the preset's size, and the safe area
/// moves into the auto layout padding. The `applied` of `device` is ignored.
pub fn apply(doc: &mut Document, gen: &mut IdGen, id: &str, device: Option<DeviceFrame>, resize: bool) -> Result<(), String> {
  let n = doc.get(id).ok_or("no such layer")?;
  if !matches!(n.kind, NodeType::Frame | NodeType::Component) || doc.instance_ancestor(id).is_some() {
    return Err("a device goes on a frame or a main component".into());
  }
  let page = n.page.clone();
  let old_dev = n.device.clone();
  let old_applied = old_dev.as_ref().map(|d| d.applied).unwrap_or([0.0; 4]);
  let old_preset = old_dev.as_ref().and_then(|d| find(&d.preset));
  // Every part of this frame, wherever it ended up in the subtree, so none can be left behind.
  let old_parts: Vec<NodeId> = doc
    .subtree(id)
    .into_iter()
    .filter(|c| c != id && doc.get(c).is_some_and(|c| c.device_part.is_some()))
    .collect();
  let time = text_of(doc, &old_parts, "Time");
  let title = text_of(doc, &old_parts, "Title");
  let preset = match &device {
    Some(d) => {
      Some(find(&d.preset).ok_or_else(|| format!("unknown device preset '{}'; close ids: {}", d.preset, suggest(&d.preset).join(", ")))?)
    }
    Option::None => Option::None,
  };
  for part in old_parts {
    doc.remove(&part);
  }
  // Light/dark is the system UI's theme. The screen's own fill follows it only while the screen
  // is empty: under real content it would turn the default black text invisible.
  let empty = doc.get(id).is_some_and(|f| f.children.is_empty());
  let (Some(mut dev), Some(preset)) = (device, preset) else {
    let f = doc.get_mut(id).ok_or("no such layer")?;
    shift_padding(f, old_applied, [0.0; 4]);
    f.device = Option::None;
    return Ok(());
  };
  if dev.theme != "dark" {
    dev.theme = "light".into();
  }
  if dev.nav != "buttons" {
    dev.nav = "gesture".into();
  }
  // The clock keeps its text only between phones of one family (9:41 is not an Android time).
  let time = time.filter(|_| old_preset.is_some_and(|o| (o.kind == Android) == (preset.kind == Android)));
  let f = doc.get_mut(id).ok_or("no such layer")?;
  if resize {
    f.width = preset.w;
    f.height = preset.h;
    f.sizing_h = Sizing::Fixed;
    f.sizing_v = Sizing::Fixed;
    if preset.kind == MacWindow && f.corner_radius == 0.0 && f.corner_radii.is_none() {
      f.corner_radius = 10.0;
    }
  }
  if let Some(o) = old_preset.filter(|o| o.id != preset.id) {
    // A frame still named after its old device takes the new one's name; the window radius goes.
    if f.name == o.label {
      f.name = preset.label.to_string();
    }
    if o.kind == MacWindow && preset.kind != MacWindow && f.corner_radius == 10.0 {
      f.corner_radius = 0.0;
    }
  }
  // Light and dark: an empty frame still filled with the other theme's plain colour follows; a custom fill stays.
  let was_dark = old_dev.as_ref().is_some_and(|d| d.theme == "dark");
  if empty && was_dark != (dev.theme == "dark") && f.fill_style.is_none() && !f.bindings.contains_key("fill") {
    let (from, to) = if dev.theme == "dark" {
      ("#FFFFFF", "#000000")
    } else {
      ("#000000", "#FFFFFF")
    };
    // A new device frame also takes the plain fill when it has none; a transparent frame stays so.
    let plain = (old_dev.is_none() && f.fills.is_empty())
      || matches!(f.fills.as_slice(), [Paint::Solid { color, opacity, visible: true }] if color.eq_ignore_ascii_case(from) && *opacity == 1.0);
    if plain {
      f.fills = vec![Paint::solid(to)];
    }
  }
  let in_layout = f.layout.is_some();
  let (w, h) = (f.width, f.height);
  let ins = if dev.pad && in_layout { insets(preset, &dev) } else { [0.0; 4] };
  shift_padding(f, old_applied, ins);
  dev.applied = ins;
  f.device = Some(dev.clone());
  let mut g = Gen {
    ids: gen,
    page: page.clone(),
  };
  for mut part in chrome(&mut g, preset, &dev, w, h, time, title) {
    part.n.locked = true;
    part.n.scroll_behavior = ScrollBehavior::Fixed;
    part.n.absolute_position = in_layout;
    put(doc, part, id, &page);
  }
  Ok(())
}

/// The device frame that holds `id` when it is system UI (or inside it); `id` itself otherwise.
pub fn host_of(doc: &Document, id: &str) -> NodeId {
  let mut cur = doc.get(id);
  while let Some(n) = cur {
    if n.device_part.is_some() {
      if let Some(p) = n.parent.clone() {
        return p;
      }
    }
    cur = n.parent.as_deref().and_then(|p| doc.get(p));
  }
  id.to_string()
}

/// Where a new child of `parent` goes so a device frame's system UI stays on top of it.
pub fn before_chrome(doc: &Document, parent: &str) -> Option<usize> {
  let p = doc.get(parent)?;
  p.children.iter().position(|c| doc.get(c).is_some_and(|c| c.device_part.is_some()))
}

/// Puts a device frame's system UI back after every other child (the order it keeps otherwise).
pub fn raise_chrome(doc: &mut Document, id: &str) {
  let Some(n) = doc.get(id) else { return };
  let is_part = |c: &NodeId| doc.get(c).is_some_and(|c| c.device_part.is_some());
  let (parts, rest): (Vec<NodeId>, Vec<NodeId>) = n.children.iter().cloned().partition(is_part);
  let ordered: Vec<NodeId> = rest.into_iter().chain(parts).collect();
  if ordered != n.children {
    if let Some(n) = doc.get_mut(id) {
      n.children = ordered;
    }
  }
}

/// (device frame, part) for each system UI part among `ids`.
pub fn parts_among(doc: &Document, ids: &[NodeId]) -> Vec<(NodeId, String)> {
  ids
    .iter()
    .filter_map(|id| {
      let n = doc.get(id)?;
      let part = n.device_part.clone()?;
      let frame = n.parent.clone().filter(|p| doc.get(p).is_some_and(|p| p.device.is_some()))?;
      Some((frame, part))
    })
    .collect()
}

/// Turns the toggle of a deleted part off, so the Device section, the padding and the guides agree.
pub fn turn_off(doc: &mut Document, gen: &mut IdGen, frame: &str, part: &str) {
  let Some(mut dev) = doc.get(frame).and_then(|n| n.device.clone()) else {
    return;
  };
  match part {
    "statusBar" => dev.status_bar = false,
    "homeIndicator" | "navBar" => dev.home_indicator = false,
    _ => dev.chrome = false,
  }
  let _ = apply(doc, gen, frame, Some(dev), false);
}

/// Re-runs `apply` for a device frame whose auto layout was added or removed.
pub fn refresh(doc: &mut Document, gen: &mut IdGen, id: &str) {
  let Some(dev) = doc.get(id).and_then(|n| n.device.clone()) else {
    return;
  };
  if doc.get(id).is_some_and(|n| n.layout.is_some()) {
    // A screen keeps its device size; hugging its content would collapse it.
    if let Some(n) = doc.get_mut(id) {
      n.sizing_h = Sizing::Fixed;
      n.sizing_v = Sizing::Fixed;
    }
  }
  let _ = apply(doc, gen, id, Some(dev), false);
}

/// Moves the padding from `old` insets to `new` ones.
fn shift_padding(f: &mut Node, old: [f64; 4], new: [f64; 4]) {
  let Some(l) = f.layout.as_mut() else { return };
  l.padding_top = (l.padding_top - old[0] + new[0]).max(0.0);
  l.padding_right = (l.padding_right - old[1] + new[1]).max(0.0);
  l.padding_bottom = (l.padding_bottom - old[2] + new[2]).max(0.0);
  l.padding_left = (l.padding_left - old[3] + new[3]).max(0.0);
}

/// The text of the layer called `name` inside the old parts (kept across rebuilds).
fn text_of(doc: &Document, parts: &[NodeId], name: &str) -> Option<String> {
  parts
    .iter()
    .flat_map(|p| doc.subtree(p))
    .filter_map(|id| doc.get(&id))
    .find(|n| n.name == name && n.text.is_some())
    .and_then(|n| n.text.as_ref().map(|t| t.characters.clone()))
}

fn put(doc: &mut Document, t: Tree, parent: &str, page: &str) {
  let id = t.n.id.clone();
  doc.insert(t.n, Some(parent), page, None);
  for k in t.kids {
    put(doc, k, &id, page);
  }
}

// ---------- Building ----------

struct Tree {
  n: Node,
  kids: Vec<Tree>,
}

struct Gen<'a> {
  ids: &'a mut IdGen,
  page: String,
}

struct Colors {
  fg: &'static str,
  /// Title bar (macOS) or toolbar (browser).
  bar: &'static str,
  /// Browser tab strip.
  strip: &'static str,
  /// Browser address field.
  field: &'static str,
  /// Hairline under bars.
  line: &'static str,
}

fn colors(dark: bool) -> Colors {
  if dark {
    Colors {
      fg: "#FFFFFF",
      bar: "#2B2B2B",
      strip: "#202124",
      field: "#202124",
      line: "#FFFFFF",
    }
  } else {
    Colors {
      fg: "#000000",
      bar: "#ECECEC",
      strip: "#DEE1E6",
      field: "#FFFFFF",
      line: "#000000",
    }
  }
}

const TRAFFIC: [(&str, &str); 3] = [("Close", "#FF5F57"), ("Minimize", "#FEBC2E"), ("Zoom", "#28C840")];

const BACK_PATH: &str = "M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z";
const FORWARD_PATH: &str = "M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8z";
const RELOAD_PATH: &str = "M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z";
const WIFI_PATH: &str = "M1 9l2 2c4.97-4.97 13.03-4.97 18 0l2-2C16.93 2.93 7.08 2.93 1 9zm8 8l3 3 3-3a4.237 4.237 0 00-6 0zm-4-4l2 2a7.074 7.074 0 0110 0l2-2C15.14 9.14 8.87 9.14 5 13z";

fn chrome(g: &mut Gen, p: &Preset, d: &DeviceFrame, w: f64, h: f64, time: Option<String>, title: Option<String>) -> Vec<Tree> {
  let c = colors(d.theme == "dark");
  let mut out = Vec::new();
  match p.kind {
    IosIsland | IosNotch | IosHome | IpadHome => {
      if d.status_bar {
        out.push(ios_status_bar(g, p, &c, w, time.as_deref().unwrap_or("9:41")));
      }
      if d.home_indicator && p.insets[2] > 0.0 {
        let bw = if p.kind == IpadHome { HOME_BAR_IPAD } else { HOME_BAR };
        let mut n = rect(g, "Home indicator", bw.min(w), 5.0, 2.5, c.fg);
        n.x = (w - n.width) / 2.0;
        n.y = h - HOME_BAR_BOTTOM - 5.0;
        n.constraints = constraints(ConstraintH::Center, ConstraintV::Bottom);
        n.device_part = Some("homeIndicator".into());
        out.push(leaf(n));
      }
    }
    Android => {
      if d.status_bar {
        out.push(android_status_bar(g, p, &c, w, time.as_deref().unwrap_or("12:30")));
      }
      if d.home_indicator {
        out.push(android_nav(g, &c, w, h, d.nav == "buttons"));
      }
    }
    MacWindow => {
      if d.chrome {
        out.push(title_bar(g, &c, w, title.as_deref().unwrap_or("Untitled")));
      }
    }
    Browser => {
      if d.chrome {
        out.push(browser_bar(g, &c, w, &d.url));
      }
    }
    Plain => {}
  }
  out
}

fn ios_status_bar(g: &mut Gen, p: &Preset, c: &Colors, w: f64, time: &str) -> Tree {
  let top = p.insets[0];
  let mut bar = bar_frame(g, "Status bar", w, top, "statusBar");
  let mut kids = Vec::new();
  match p.kind {
    IosIsland | IosNotch => {
      let island = p.kind == IosIsland;
      let cut_w = if island { ISLAND.0 } else { NOTCH.0 };
      // The time sits in the middle of the left ear, the indicators in the right one.
      let ear = ((w - cut_w) / 2.0).max(0.0);
      // Centre the glyphs on the Dynamic Island (or in the notch's height).
      let centre = if island { ISLAND.2 + ISLAND.1 / 2.0 } else { NOTCH.1 / 2.0 + 2.0 };
      row(
        &mut bar,
        0.0,
        [
          0.0,
          ((ear - 76.0) / 2.0).max(0.0),
          (top - 2.0 * centre).max(0.0),
          ((ear - 40.0) / 2.0).max(0.0),
        ],
        Align::SpaceBetween,
        Align::Center,
      );
      kids.push(leaf(clock(g, time, "Inter", 17.0, 600, c.fg)));
      kids.push(indicators(g, c, true, 6.0));
      let mut cut = if island {
        let mut n = rect(g, "Dynamic Island", ISLAND.0, ISLAND.1, ISLAND.1 / 2.0, "#000000");
        n.y = ISLAND.2;
        n
      } else {
        let mut n = rect(g, "Notch", NOTCH.0, NOTCH.1, 0.0, "#000000");
        n.corner_radii = Some([0.0, 0.0, 20.0, 20.0]);
        n
      };
      cut.x = (w - cut.width) / 2.0;
      cut.absolute_position = true;
      cut.constraints = constraints(ConstraintH::Center, ConstraintV::Top);
      kids.push(leaf(cut));
    }
    IosHome => {
      row(&mut bar, 0.0, [0.0, 7.0, 0.0, 7.0], Align::SpaceBetween, Align::Center);
      // Equal ends keep the time centred.
      let mut l = side(g, "Left", 90.0, Align::Start);
      if let Some(al) = l.n.layout.as_mut() {
        al.gap = 4.0;
      }
      l.kids.push(signal_bars(g, c));
      l.kids
        .push(leaf(vector(g, "Wi-Fi", WIFI_PATH, [1.0, 4.0, 22.0, 16.0], 17.0, 12.0, c.fg)));
      let mut r = side(g, "Right", 90.0, Align::End);
      r.kids.push(battery(g, c));
      kids.push(l);
      kids.push(leaf(clock(g, time, "Inter", 12.0, 600, c.fg)));
      kids.push(r);
    }
    _ => {
      // iPad: time and date on the left, indicators on the right.
      row(&mut bar, 0.0, [0.0, 24.0, 0.0, 24.0], Align::SpaceBetween, Align::Center);
      let mut left = side(g, "Left", 0.0, Align::Start);
      left.n.sizing_h = Sizing::Hug;
      if let Some(l) = left.n.layout.as_mut() {
        l.gap = 8.0;
      }
      left.kids.push(leaf(clock(g, time, "Inter", 13.0, 600, c.fg)));
      let mut date = clock(g, "Tue Jan 9", "Inter", 13.0, 500, c.fg);
      date.name = "Date".into();
      left.kids.push(leaf(date));
      kids.push(left);
      kids.push(indicators(g, c, true, 6.0));
    }
  }
  bar_tree(bar, kids)
}

fn android_status_bar(g: &mut Gen, p: &Preset, c: &Colors, w: f64, time: &str) -> Tree {
  let mut bar = bar_frame(g, "Status bar", w, p.insets[0], "statusBar");
  row(&mut bar, 0.0, [0.0, 16.0, 0.0, 16.0], Align::SpaceBetween, Align::Center);
  let mut hole = ellipse(g, "Camera", 10.0, "#000000");
  hole.x = (w - 10.0) / 2.0;
  hole.y = 7.0;
  hole.absolute_position = true;
  hole.constraints = constraints(ConstraintH::Center, ConstraintV::Top);
  let kids = vec![
    leaf(clock(g, time, "Roboto", 14.0, 500, c.fg)),
    indicators(g, c, true, 6.0),
    leaf(hole),
  ];
  bar_tree(bar, kids)
}

fn android_nav(g: &mut Gen, c: &Colors, w: f64, h: f64, buttons: bool) -> Tree {
  let bar_h = if buttons { NAV_BUTTONS } else { NAV_GESTURE };
  let mut bar = frame(g, "Navigation bar", w, bar_h);
  bar.x = 0.0;
  bar.y = h - bar_h;
  bar.constraints = constraints(ConstraintH::LeftRight, ConstraintV::Bottom);
  bar.device_part = Some("navBar".into());
  let mut kids = Vec::new();
  if buttons {
    row(&mut bar, 72.0, [0.0; 4], Align::Center, Align::Center);
    kids.push(leaf(vector(g, "Back", "M15 5L6 12l9 7z", [0.0, 0.0, 24.0, 24.0], 20.0, 20.0, c.fg)));
    let mut home = ellipse(g, "Home", 18.0, c.fg);
    home.fills.clear();
    home.strokes = vec![Paint::solid(c.fg)];
    home.stroke_weight = 2.0;
    kids.push(leaf(home));
    let mut recents = rect(g, "Recents", 16.0, 16.0, 3.0, c.fg);
    recents.fills.clear();
    recents.strokes = vec![Paint::solid(c.fg)];
    recents.stroke_weight = 2.0;
    kids.push(leaf(recents));
  } else {
    let mut pill = rect(g, "Gesture bar", 108.0, 4.0, 2.0, c.fg);
    pill.x = (w - 108.0) / 2.0;
    pill.y = (bar_h - 4.0) / 2.0;
    pill.constraints = constraints(ConstraintH::Center, ConstraintV::Center);
    kids.push(leaf(pill));
  }
  Tree { n: bar, kids }
}

fn title_bar(g: &mut Gen, c: &Colors, w: f64, title: &str) -> Tree {
  let mut bar = bar_frame(g, "Title bar", w, TITLE_BAR, "titleBar");
  bar.fills = vec![Paint::solid(c.bar)];
  bar.strokes = vec![faded(c.line, 0.12)];
  bar.stroke_weights = Some([0.0, 0.0, 1.0, 0.0]);
  bar.stroke_align = StrokeAlign::Inside;
  row(&mut bar, 8.0, [0.0, 14.0, 0.0, 14.0], Align::Start, Align::Center);
  let mut kids: Vec<Tree> = TRAFFIC.iter().map(|(name, color)| leaf(ellipse(g, name, 12.0, color))).collect();
  // The title fills the bar behind the lights and centres its text.
  let mut label = frame(g, "Title", w, TITLE_BAR);
  label.absolute_position = true;
  label.constraints = constraints(ConstraintH::LeftRight, ConstraintV::Top);
  row(&mut label, 0.0, [0.0; 4], Align::Center, Align::Center);
  let mut t = clock(g, title, "Inter", 13.0, 600, c.fg);
  t.name = "Title".into();
  t.fills = vec![faded(c.fg, 0.85)];
  kids.push(Tree {
    n: label,
    kids: vec![leaf(t)],
  });
  Tree { n: bar, kids }
}

fn browser_bar(g: &mut Gen, c: &Colors, w: f64, url: &str) -> Tree {
  let dark = c.fg == "#FFFFFF";
  let toolbar_fill = if dark { "#35363A" } else { "#F1F3F4" };
  let mut root = bar_frame(g, "Browser toolbar", w, BROWSER_BAR, "browserBar");
  root.fills = vec![Paint::solid(toolbar_fill)];
  root.layout = Some(AutoLayout {
    direction: LayoutDirection::Vertical,
    gap: 0.0,
    padding_top: 0.0,
    padding_right: 0.0,
    padding_bottom: 0.0,
    padding_left: 0.0,
    ..AutoLayout::default()
  });

  // Tab strip: traffic lights and the open tab.
  let mut strip = frame(g, "Tab strip", w, 40.0);
  strip.fills = vec![Paint::solid(c.strip)];
  strip.sizing_h = Sizing::Fill;
  row(&mut strip, 8.0, [8.0, 12.0, 0.0, 12.0], Align::Start, Align::End);
  let mut lights = frame(g, "Traffic lights", 60.0, 32.0);
  row(&mut lights, 8.0, [0.0; 4], Align::Start, Align::Center);
  let light_kids = TRAFFIC.iter().map(|(name, color)| leaf(ellipse(g, name, 12.0, color))).collect();
  let mut tab = frame(g, "Tab", 220.0, 32.0);
  tab.fills = vec![Paint::solid(toolbar_fill)];
  tab.corner_radii = Some([8.0, 8.0, 0.0, 0.0]);
  row(&mut tab, 8.0, [0.0, 12.0, 0.0, 12.0], Align::Start, Align::Center);
  let mut icon = ellipse(g, "Favicon", 14.0, c.fg);
  icon.fills = vec![faded(c.fg, 0.35)];
  let mut label = clock(g, "New Tab", "Inter", 12.0, 500, c.fg);
  label.name = "Tab title".into();
  let strip = Tree {
    n: strip,
    kids: vec![
      Tree {
        n: lights,
        kids: light_kids,
      },
      Tree {
        n: tab,
        kids: vec![leaf(icon), leaf(label)],
      },
    ],
  };

  // Toolbar: back, forward, reload and the address field.
  let mut bar = frame(g, "Toolbar", w, 44.0);
  bar.sizing_h = Sizing::Fill;
  row(&mut bar, 12.0, [0.0, 12.0, 0.0, 12.0], Align::Start, Align::Center);
  let mut field = frame(g, "Address bar", 200.0, 30.0);
  field.fills = vec![Paint::solid(c.field)];
  field.corner_radius = 15.0;
  field.sizing_h = Sizing::Fill;
  row(&mut field, 8.0, [0.0, 14.0, 0.0, 14.0], Align::Start, Align::Center);
  let mut address = clock(g, url, "Inter", 13.0, 400, c.fg);
  address.name = "URL".into();
  let nav = |g: &mut Gen, name: &str, d: &str| leaf(vector(g, name, d, [0.0, 0.0, 24.0, 24.0], 18.0, 18.0, c.fg));
  let toolbar = Tree {
    n: bar,
    kids: vec![
      nav(g, "Back", BACK_PATH),
      nav(g, "Forward", FORWARD_PATH),
      nav(g, "Reload", RELOAD_PATH),
      Tree {
        n: field,
        kids: vec![leaf(address)],
      },
    ],
  };
  Tree {
    n: root,
    kids: vec![strip, toolbar],
  }
}

/// Signal, Wi-Fi and battery in a row.
fn indicators(g: &mut Gen, c: &Colors, signal: bool, gap: f64) -> Tree {
  let mut n = frame(g, "Indicators", 60.0, 13.0);
  n.sizing_h = Sizing::Hug;
  n.sizing_v = Sizing::Hug;
  row(&mut n, gap, [0.0; 4], Align::Start, Align::Center);
  let mut kids = Vec::new();
  if signal {
    kids.push(signal_bars(g, c));
  }
  kids.push(leaf(vector(g, "Wi-Fi", WIFI_PATH, [1.0, 4.0, 22.0, 16.0], 17.0, 12.0, c.fg)));
  kids.push(battery(g, c));
  Tree { n, kids }
}

fn signal_bars(g: &mut Gen, c: &Colors) -> Tree {
  let mut n = frame(g, "Signal", 18.0, 12.0);
  let mut kids = Vec::new();
  for (i, bar_h) in [4.0, 6.5, 9.0, 12.0].into_iter().enumerate() {
    let mut b = rect(g, "Bar", 3.0, bar_h, 1.0, c.fg);
    b.x = i as f64 * 5.0;
    b.y = 12.0 - bar_h;
    kids.push(leaf(b));
  }
  n.clip_content = false;
  Tree { n, kids }
}

fn battery(g: &mut Gen, c: &Colors) -> Tree {
  let n = frame(g, "Battery", 27.0, 13.0);
  let mut body = rect(g, "Body", 25.0, 13.0, 4.0, c.fg);
  body.fills.clear();
  body.strokes = vec![faded(c.fg, 0.35)];
  body.stroke_weight = 1.0;
  let mut level = rect(g, "Level", 21.0, 9.0, 2.5, c.fg);
  level.x = 2.0;
  level.y = 2.0;
  let mut nub = rect(g, "Nub", 1.5, 4.0, 0.75, c.fg);
  nub.fills = vec![faded(c.fg, 0.4)];
  nub.x = 25.5;
  nub.y = 4.5;
  Tree {
    n,
    kids: vec![leaf(body), leaf(level), leaf(nub)],
  }
}

// ---------- Node helpers ----------

fn leaf(n: Node) -> Tree {
  Tree { n, kids: Vec::new() }
}

fn bar_tree(bar: Node, kids: Vec<Tree>) -> Tree {
  Tree { n: bar, kids }
}

/// A transparent frame (no fill, no clipping).
fn frame(g: &mut Gen, name: &str, w: f64, h: f64) -> Node {
  let mut n = default_node(NodeType::Frame, g.ids.next("n_"), name.to_string());
  n.fills.clear();
  n.clip_content = false;
  n.width = w;
  n.height = h;
  n.page = g.page.clone();
  n
}

/// A full-width bar frame at the top of the screen that follows its width.
fn bar_frame(g: &mut Gen, name: &str, w: f64, h: f64, part: &str) -> Node {
  let mut n = frame(g, name, w, h);
  n.constraints = constraints(ConstraintH::LeftRight, ConstraintV::Top);
  n.device_part = Some(part.into());
  n
}

fn constraints(horizontal: ConstraintH, vertical: ConstraintV) -> Constraints {
  Constraints { horizontal, vertical }
}

/// Horizontal auto layout.
fn row(n: &mut Node, gap: f64, pad: [f64; 4], primary: Align, counter: Align) {
  n.layout = Some(AutoLayout {
    direction: LayoutDirection::Horizontal,
    gap,
    padding_top: pad[0],
    padding_right: pad[1],
    padding_bottom: pad[2],
    padding_left: pad[3],
    primary_align: primary,
    counter_align: counter,
    wrap: false,
    counter_gap: 0.0,
  });
}

/// A fixed-width row at one end of a bar.
fn side(g: &mut Gen, name: &str, w: f64, primary: Align) -> Tree {
  let mut n = frame(g, name, w, 14.0);
  row(&mut n, 0.0, [0.0; 4], primary, Align::Center);
  n.sizing_v = Sizing::Hug;
  Tree { n, kids: Vec::new() }
}

fn rect(g: &mut Gen, name: &str, w: f64, h: f64, radius: f64, color: &str) -> Node {
  let mut n = default_node(NodeType::Rectangle, g.ids.next("n_"), name.to_string());
  n.fills = vec![Paint::solid(color)];
  n.width = w;
  n.height = h;
  n.corner_radius = radius;
  n.page = g.page.clone();
  n
}

fn ellipse(g: &mut Gen, name: &str, d: f64, color: &str) -> Node {
  let mut n = default_node(NodeType::Ellipse, g.ids.next("n_"), name.to_string());
  n.fills = vec![Paint::solid(color)];
  n.width = d;
  n.height = d;
  n.page = g.page.clone();
  n
}

fn vector(g: &mut Gen, name: &str, d: &str, view_box: [f64; 4], w: f64, h: f64, color: &str) -> Node {
  let mut n = default_node(NodeType::Vector, g.ids.next("n_"), name.to_string());
  n.vector = Some(VectorData {
    subpaths: Vec::new(),
    raw: Some(RawPath {
      d: d.to_string(),
      view_box,
      fill_rule: String::new(),
    }),
  });
  n.fills = vec![Paint::solid(color)];
  n.strokes.clear();
  n.width = w;
  n.height = h;
  n.page = g.page.clone();
  n
}

/// A text layer (auto width) whose box is a rough guess until layout measures it.
fn clock(g: &mut Gen, chars: &str, family: &str, size: f64, weight: u32, color: &str) -> Node {
  let mut n = default_node(NodeType::Text, g.ids.next("n_"), "Time".to_string());
  n.text = Some(TextProps {
    characters: chars.to_string(),
    font_family: family.into(),
    font_size: size,
    font_weight: weight,
    ..TextProps::default()
  });
  n.fills = vec![Paint::solid(color)];
  n.width = chars.chars().count() as f64 * size * 0.55;
  n.height = size * 1.25;
  n.page = g.page.clone();
  n
}

fn faded(color: &str, opacity: f64) -> Paint {
  Paint::Solid {
    color: color.into(),
    opacity,
    visible: true,
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::engine::{Command, Engine};
  use crate::model::NodeType;
  use crate::text::HeuristicMeasurer;
  use serde_json::json;
  use std::collections::HashSet;

  fn engine() -> Engine {
    Engine::new(Box::new(HeuristicMeasurer), 7)
  }

  fn frame_id(e: &mut Engine) -> String {
    let r = e
      .dispatch(Command::CreateShape {
        kind: NodeType::Frame,
        x: 0.0,
        y: 0.0,
        width: 300.0,
        height: 600.0,
        parent: None,
      })
      .unwrap();
    r["id"].as_str().unwrap().to_string()
  }

  fn set(e: &mut Engine, id: &str, preset: &str, resize: bool) {
    let d = DeviceFrame {
      preset: preset.into(),
      ..DeviceFrame::default()
    };
    e.dispatch(Command::SetDevice {
      id: id.into(),
      device: Some(d),
      resize,
    })
    .unwrap();
  }

  fn parts(e: &Engine, id: &str) -> Vec<Node> {
    let n = e.doc.get(id).unwrap();
    n.children
      .iter()
      .filter_map(|c| e.doc.get(c))
      .filter(|c| c.device_part.is_some())
      .cloned()
      .collect()
  }

  fn find_named(e: &Engine, id: &str, name: &str) -> Option<Node> {
    e.doc
      .subtree(id)
      .iter()
      .filter_map(|i| e.doc.get(i))
      .find(|n| n.name == name)
      .cloned()
  }

  fn pad(e: &Engine, id: &str) -> [f64; 4] {
    let l = e.doc.get(id).unwrap().layout.clone().unwrap();
    [l.padding_top, l.padding_right, l.padding_bottom, l.padding_left]
  }

  #[test]
  fn the_preset_table_is_sane() {
    let mut seen = HashSet::new();
    for p in PRESETS {
      assert!(seen.insert(p.id), "duplicate id {}", p.id);
      assert!(p.w > 0.0 && p.h > 0.0);
      assert!(p.insets[0] + p.insets[2] < p.h / 2.0, "{} insets", p.id);
      assert!(!p.label.is_empty() && !p.group.is_empty());
    }
    assert!(find("iphone-17-pro").is_some() && find("nope").is_none());
    assert!(suggest("iphone 17 prp").contains(&"iphone-17-pro"));
    assert!(suggest("zzz").len() <= 5);
  }

  #[test]
  fn parts_are_locked_fixed_and_absolute_in_auto_layout() {
    let mut e = engine();
    let f = frame_id(&mut e);
    set(&mut e, &f, "iphone-17-pro", true);
    let n = e.doc.get(&f).unwrap();
    assert_eq!((n.width, n.height), (402.0, 874.0));
    let ps = parts(&e, &f);
    let names: Vec<&str> = ps.iter().map(|p| p.name.as_str()).collect();
    assert_eq!(names, ["Status bar", "Home indicator"]);
    assert!(ps
      .iter()
      .all(|p| p.locked && p.scroll_behavior == ScrollBehavior::Fixed && !p.absolute_position));
    assert!(find_named(&e, &f, "Dynamic Island").is_some());
    // They are the frame's last children.
    let last: Vec<&str> = n
      .children
      .iter()
      .rev()
      .take(2)
      .filter_map(|c| e.doc.get(c))
      .map(|c| c.name.as_str())
      .collect();
    assert_eq!(last, ["Home indicator", "Status bar"]);
    e.dispatch(Command::AddAutoLayout { ids: vec![f.clone()] }).unwrap();
    assert!(parts(&e, &f).iter().all(|p| p.absolute_position && p.locked));
    let n = e.doc.get(&f).unwrap();
    assert_eq!(
      (n.sizing_h, n.sizing_v, n.width, n.height),
      (Sizing::Fixed, Sizing::Fixed, 402.0, 874.0)
    );
  }

  #[test]
  fn padding_round_trips_through_presets() {
    let mut e = engine();
    let f = frame_id(&mut e);
    e.dispatch(Command::AddAutoLayout { ids: vec![f.clone()] }).unwrap();
    e.dispatch(Command::Update {
      ids: vec![f.clone()],
      patch: json!({ "layout": { "paddingTop": 16, "paddingRight": 16, "paddingBottom": 16, "paddingLeft": 16 } }),
    })
    .unwrap();
    set(&mut e, &f, "iphone-16", true);
    assert_eq!(pad(&e, &f), [75.0, 16.0, 50.0, 16.0]);
    set(&mut e, &f, "iphone-17-pro", true);
    assert_eq!(pad(&e, &f), [78.0, 16.0, 50.0, 16.0]);
    assert_eq!(e.doc.get(&f).unwrap().device.as_ref().unwrap().applied, [62.0, 0.0, 34.0, 0.0]);
    e.dispatch(Command::SetDevice {
      id: f.clone(),
      device: None,
      resize: false,
    })
    .unwrap();
    assert_eq!(pad(&e, &f), [16.0; 4]);
    let n = e.doc.get(&f).unwrap();
    assert!(n.device.is_none() && parts(&e, &f).is_empty());
  }

  #[test]
  fn toggling_a_bar_off_removes_it_and_its_inset() {
    let mut e = engine();
    let f = frame_id(&mut e);
    e.dispatch(Command::AddAutoLayout { ids: vec![f.clone()] }).unwrap();
    set(&mut e, &f, "iphone-17-pro", true);
    assert_eq!(pad(&e, &f)[0], 72.0);
    let mut d = e.doc.get(&f).unwrap().device.clone().unwrap();
    d.status_bar = false;
    e.dispatch(Command::SetDevice {
      id: f.clone(),
      device: Some(d),
      resize: false,
    })
    .unwrap();
    assert_eq!(pad(&e, &f)[0], 10.0);
    assert!(parts(&e, &f).iter().all(|p| p.device_part.as_deref() != Some("statusBar")));
  }

  #[test]
  fn android_buttons_need_a_taller_inset() {
    let p = find("pixel-9").unwrap();
    let mut d = DeviceFrame::default();
    assert_eq!(insets(p, &d), [24.0, 0.0, 24.0, 0.0]);
    d.nav = "buttons".into();
    assert_eq!(insets(p, &d)[2], 48.0);
    d.home_indicator = false;
    assert_eq!(insets(p, &d)[2], 0.0);
  }

  #[test]
  fn a_theme_rebuild_keeps_the_time_and_recolours_the_glyphs() {
    let mut e = engine();
    let f = frame_id(&mut e);
    set(&mut e, &f, "iphone-17", true);
    let time = find_named(&e, &f, "Time").unwrap();
    e.dispatch(Command::Update {
      ids: vec![time.id.clone()],
      patch: json!({ "text": { "characters": "10:02" } }),
    })
    .unwrap();
    let mut d = e.doc.get(&f).unwrap().device.clone().unwrap();
    d.theme = "dark".into();
    e.dispatch(Command::SetDevice {
      id: f.clone(),
      device: Some(d),
      resize: false,
    })
    .unwrap();
    let time = find_named(&e, &f, "Time").unwrap();
    assert_eq!(time.text.unwrap().characters, "10:02");
    assert!(matches!(&time.fills[0], Paint::Solid { color, .. } if color == "#FFFFFF"));
  }

  #[test]
  fn resizing_the_frame_keeps_the_parts_anchored() {
    let mut e = engine();
    let f = frame_id(&mut e);
    set(&mut e, &f, "iphone-17", true);
    e.dispatch(Command::Update {
      ids: vec![f.clone()],
      patch: json!({ "width": 500, "height": 1000 }),
    })
    .unwrap();
    let bar = find_named(&e, &f, "Status bar").unwrap();
    assert_eq!((bar.x, bar.y, bar.width), (0.0, 0.0, 500.0));
    let home = find_named(&e, &f, "Home indicator").unwrap();
    assert_eq!(home.y, 1000.0 - 13.0);
    assert!((home.x - (500.0 - 134.0) / 2.0).abs() < 1e-9);
    let island = find_named(&e, &f, "Dynamic Island").unwrap();
    assert!(
      (island.x - (500.0 - 126.0) / 2.0).abs() < 1e-9,
      "island stays centred: {}",
      island.x
    );
    // The same holds when the frame has auto layout.
    e.dispatch(Command::AddAutoLayout { ids: vec![f.clone()] }).unwrap();
    e.dispatch(Command::Update {
      ids: vec![f.clone()],
      patch: json!({ "width": 420 }),
    })
    .unwrap();
    let bar = find_named(&e, &f, "Status bar").unwrap();
    let island = find_named(&e, &f, "Dynamic Island").unwrap();
    assert_eq!(bar.width, 420.0);
    assert!((island.x - (420.0 - 126.0) / 2.0).abs() < 1e-9, "{}", island.x);
  }

  #[test]
  fn the_status_bar_glyphs_sit_in_the_ears() {
    let mut e = engine();
    let f = frame_id(&mut e);
    set(&mut e, &f, "iphone-17-pro", true);
    let time = find_named(&e, &f, "Time").unwrap();
    let battery = find_named(&e, &f, "Battery").unwrap();
    assert!(
      time.x + time.width < (402.0 - 126.0) / 2.0,
      "time left of the island: {} {}",
      time.x,
      time.width
    );
    assert!(battery.x > (402.0 + 126.0) / 2.0 || e.doc.abs_bounds(&battery.id).x > (402.0 + 126.0) / 2.0);
  }

  #[test]
  fn one_undo_step_covers_the_whole_change() {
    let mut e = engine();
    let f = frame_id(&mut e);
    let before = e.doc.nodes.len();
    set(&mut e, &f, "iphone-17", true);
    assert!(e.doc.nodes.len() > before + 10);
    e.dispatch(Command::Undo).unwrap();
    assert_eq!(e.doc.nodes.len(), before);
    let n = e.doc.get(&f).unwrap();
    assert!(n.device.is_none() && n.width == 300.0);
    e.dispatch(Command::Redo).unwrap();
    assert!(e.doc.get(&f).unwrap().device.is_some());
  }

  #[test]
  fn browser_and_mac_chrome_follow_their_toggles() {
    let mut e = engine();
    let f = frame_id(&mut e);
    set(&mut e, &f, "browser-1440", true);
    assert_eq!(parts(&e, &f).len(), 1);
    assert_eq!(find_named(&e, &f, "URL").unwrap().text.unwrap().characters, "example.com");
    assert_eq!(e.doc.get(&f).unwrap().height, 900.0);
    assert_eq!(find_named(&e, &f, "Browser toolbar").unwrap().height, BROWSER_BAR);
    set(&mut e, &f, "mac-window", true);
    assert_eq!(parts(&e, &f)[0].device_part.as_deref(), Some("titleBar"));
    assert_eq!(e.doc.get(&f).unwrap().corner_radius, 10.0);
    let lights: Vec<f64> = ["Close", "Minimize", "Zoom"]
      .iter()
      .map(|n| {
        let l = find_named(&e, &f, n).unwrap();
        e.doc.abs_bounds(&l.id).x + l.width / 2.0
      })
      .collect();
    assert_eq!(lights, [20.0, 40.0, 60.0]);
    // A preset without chrome takes the parts off again.
    e.dispatch(Command::SetDevice {
      id: f.clone(),
      device: None,
      resize: false,
    })
    .unwrap();
    assert!(parts(&e, &f).is_empty());
  }

  #[test]
  fn instances_and_unknown_presets_are_refused() {
    let mut e = engine();
    let f = frame_id(&mut e);
    let bad = e.dispatch(Command::SetDevice {
      id: f.clone(),
      device: Some(DeviceFrame {
        preset: "iphone".into(),
        ..DeviceFrame::default()
      }),
      resize: true,
    });
    assert!(bad.unwrap_err().contains("iphone-17"));
    let r = e
      .dispatch(Command::CreateShape {
        kind: NodeType::Rectangle,
        x: 0.0,
        y: 0.0,
        width: 10.0,
        height: 10.0,
        parent: None,
      })
      .unwrap();
    let rect = r["id"].as_str().unwrap().to_string();
    let err = e
      .dispatch(Command::SetDevice {
        id: rect,
        device: Some(DeviceFrame {
          preset: "iphone-17".into(),
          ..DeviceFrame::default()
        }),
        resize: false,
      })
      .unwrap_err();
    assert!(err.contains("frame"));
  }

  #[test]
  fn a_device_travels_to_peers_and_undo_keeps_their_other_edits() {
    use crate::collab::{apply, delta};
    let mut a = engine();
    let f = frame_id(&mut a);
    let mut b = Engine::new(Box::new(HeuristicMeasurer), 8);
    b.load(&a.to_json()).unwrap();
    let base = a.doc.clone();
    set(&mut a, &f, "iphone-17-pro", true);
    apply(&mut b.doc, &delta(&base, &a.doc, true, true)).unwrap();
    let theirs = b.doc.get(&f).unwrap();
    assert_eq!(theirs.device.as_ref().map(|d| d.preset.as_str()), Some("iphone-17-pro"));
    assert_eq!(parts(&b, &f).len(), 2);
    assert!(parts(&b, &f).iter().all(|p| p.locked && p.device_part.is_some()));
    // B draws a layer elsewhere; A's undo takes the device off and leaves it.
    let base_b = b.doc.clone();
    let other = frame_id(&mut b);
    a.dispatch(Command::ApplyRemote {
      delta: delta(&base_b, &b.doc, true, true),
      local: false,
    })
    .unwrap();
    a.dispatch(Command::Undo).unwrap();
    assert!(a.doc.get(&f).unwrap().device.is_none() && parts(&a, &f).is_empty());
    assert_eq!(a.doc.get(&f).unwrap().width, 300.0);
    assert!(a.doc.get(&other).is_some(), "their layer survives my undo");
    a.dispatch(Command::Redo).unwrap();
    assert_eq!(parts(&a, &f).len(), 2);
  }

  /// A phone screen with a heading and 16 px padding around it.
  fn exported_screen(preset: &str) -> (Engine, String) {
    let mut e = engine();
    let f = frame_id(&mut e);
    e.dispatch(Command::AddAutoLayout { ids: vec![f.clone()] }).unwrap();
    e.dispatch(Command::Update {
      ids: vec![f.clone()],
      patch: json!({ "name": "Home", "layout": { "paddingTop": 16, "paddingRight": 16, "paddingBottom": 16, "paddingLeft": 16 } }),
    })
    .unwrap();
    e.dispatch(Command::CreateText {
      x: 20.0,
      y: 120.0,
      characters: "Welcome".into(),
      parent: Some(f.clone()),
    })
    .unwrap();
    set(&mut e, &f, preset, true);
    (e, f)
  }

  #[test]
  fn code_export_leaves_the_chrome_out_and_maps_the_safe_area_to_env() {
    use crate::codegen::{export_html, export_project, export_react};
    let (e, f) = exported_screen("iphone-17-pro");
    let m = HeuristicMeasurer;
    let react = export_react(&e.doc, &f, &m);
    let html = export_html(&e.doc, &f, &m);
    let project: String = export_project(&e.doc, &m)
      .iter()
      .filter(|p| p.path != "design.dtron.json")
      .map(|p| p.content.clone())
      .collect::<Vec<_>>()
      .join("\n");
    for (what, src) in [("react", &react), ("html", &html), ("project", &project)] {
      assert!(
        !src.contains("Status bar") && !src.contains("9:41") && !src.contains("Home indicator"),
        "{what} has chrome"
      );
      assert!(src.contains("Welcome"), "{what} lost the content");
    }
    assert!(react.contains("pt-[calc(16px_+_env(safe-area-inset-top,_0px))]"), "{react}");
    assert!(react.contains("pb-[calc(16px_+_env(safe-area-inset-bottom,_0px))]"), "{react}");
    assert!(
      html.contains("padding: calc(16px + env(safe-area-inset-top, 0px)) 16px calc(16px + env(safe-area-inset-bottom, 0px)) 16px"),
      "{html}"
    );
    assert!(html.contains("viewport-fit=cover") && project.contains("viewport-fit=cover"));
  }

  #[test]
  fn browser_frames_export_plain_padding_and_no_viewport_fit() {
    use crate::codegen::{export_html, export_project};
    let (e, f) = exported_screen("browser-1440");
    let m = HeuristicMeasurer;
    let html = export_html(&e.doc, &f, &m);
    assert!(!html.contains("env(") && !html.contains("viewport-fit") && !html.contains("Browser toolbar"));
    assert!(html.contains("padding: 16px"), "{html}");
    let project: String = export_project(&e.doc, &m)
      .iter()
      .filter(|p| p.path != "design.dtron.json")
      .map(|p| p.content.clone())
      .collect::<Vec<_>>()
      .join("\n");
    assert!(!project.contains("viewport-fit") && !project.contains("example.com"));
    // A plain frame exports as it always did.
    let mut plain = engine();
    let p = frame_id(&mut plain);
    assert!(!export_html(&plain.doc, &p, &m).contains("viewport-fit"));
  }

  #[test]
  fn lint_skips_the_system_ui() {
    let mut e = engine();
    let f = frame_id(&mut e);
    set(&mut e, &f, "iphone-17", true);
    let mut d = e.doc.get(&f).unwrap().device.clone().unwrap();
    d.theme = "dark".into();
    e.dispatch(Command::SetDevice {
      id: f.clone(),
      device: Some(d),
      resize: false,
    })
    .unwrap();
    // White glyphs on the white page would be a contrast issue anywhere else.
    let page = e.doc.get(&f).unwrap().page.clone();
    let issues = crate::lint::lint_page(&e.doc, &page, &HeuristicMeasurer);
    let chrome: HashSet<NodeId> = e.doc.subtree(&f).into_iter().filter(|i| in_part(&e.doc, i)).collect();
    assert!(!chrome.is_empty());
    assert!(
      issues.iter().all(|i| !chrome.contains(&i.node_id)),
      "{:?}",
      issues.iter().map(|i| &i.message).collect::<Vec<_>>()
    );
  }

  fn set_theme(e: &mut Engine, f: &str, theme: &str) {
    let mut d = e.doc.get(f).unwrap().device.clone().unwrap();
    d.theme = theme.into();
    e.dispatch(Command::SetDevice {
      id: f.into(),
      device: Some(d),
      resize: false,
    })
    .unwrap();
  }

  fn fill(e: &Engine, id: &str) -> Option<String> {
    match e.doc.get(id).unwrap().fills.first() {
      Some(Paint::Solid { color, .. }) => Some(color.clone()),
      _ => Option::None,
    }
  }

  #[test]
  fn the_frame_fill_follows_the_theme_unless_it_is_custom() {
    let mut e = engine();
    let f = frame_id(&mut e);
    set(&mut e, &f, "iphone-17", true);
    set_theme(&mut e, &f, "dark");
    assert_eq!(fill(&e, &f).as_deref(), Some("#000000"));
    set_theme(&mut e, &f, "light");
    assert_eq!(fill(&e, &f).as_deref(), Some("#FFFFFF"));
    e.dispatch(Command::Update {
      ids: vec![f.clone()],
      patch: json!({ "fills": [{ "type": "solid", "color": "#FF0000" }] }),
    })
    .unwrap();
    set_theme(&mut e, &f, "dark");
    assert_eq!(fill(&e, &f).as_deref(), Some("#FF0000"), "a custom fill stays");
    // One undo step undoes the theme and the fill together.
    e.dispatch(Command::Undo).unwrap();
    assert_eq!(e.doc.get(&f).unwrap().device.as_ref().unwrap().theme, "light");
    // A frame created dark starts black.
    let g = frame_id(&mut e);
    let d = DeviceFrame {
      preset: "pixel-9".into(),
      theme: "dark".into(),
      ..DeviceFrame::default()
    };
    e.dispatch(Command::SetDevice {
      id: g.clone(),
      device: Some(d),
      resize: true,
    })
    .unwrap();
    assert_eq!(fill(&e, &g).as_deref(), Some("#000000"));
  }

  #[test]
  fn a_frame_with_content_keeps_its_fill_on_a_theme_switch() {
    let mut e = engine();
    let f = frame_id(&mut e);
    set(&mut e, &f, "iphone-17", true);
    let r = e
      .dispatch(Command::CreateText {
        x: 20.0,
        y: 120.0,
        characters: "Your cart".into(),
        parent: Some(f.clone()),
      })
      .unwrap();
    let t = r["id"].as_str().unwrap().to_string();
    let black = e.doc.get(&t).unwrap().fills.clone();
    assert!(matches!(black.as_slice(), [Paint::Solid { color, .. }] if color.eq_ignore_ascii_case("#000000")));
    set_theme(&mut e, &f, "dark");
    assert_eq!(fill(&e, &f).as_deref(), Some("#FFFFFF"), "black text stays readable");
    assert_eq!(e.doc.get(&f).unwrap().device.as_ref().unwrap().theme, "dark");
    // The system UI still follows the theme.
    assert!(find_named(&e, &f, "Status bar").is_some());
  }

  #[test]
  fn switching_device_kind_renames_the_frame_and_resets_the_clock() {
    let mut e = engine();
    let f = frame_id(&mut e);
    set(&mut e, &f, "iphone-17", true);
    e.dispatch(Command::Update {
      ids: vec![f.clone()],
      patch: json!({ "name": "iPhone 17" }),
    })
    .unwrap();
    set(&mut e, &f, "iphone-17-pro", true);
    assert_eq!(e.doc.get(&f).unwrap().name, "iPhone 17 Pro");
    assert_eq!(find_named(&e, &f, "Time").unwrap().text.unwrap().characters, "9:41");
    set(&mut e, &f, "pixel-9", true);
    assert_eq!(e.doc.get(&f).unwrap().name, "Pixel 9");
    assert_eq!(find_named(&e, &f, "Time").unwrap().text.unwrap().characters, "12:30");
    e.dispatch(Command::Update {
      ids: vec![f.clone()],
      patch: json!({ "name": "Home screen" }),
    })
    .unwrap();
    set(&mut e, &f, "mac-window", true);
    assert_eq!(e.doc.get(&f).unwrap().name, "Home screen", "a name the user chose stays");
    assert_eq!(e.doc.get(&f).unwrap().corner_radius, 10.0);
    set(&mut e, &f, "browser-1440", true);
    assert_eq!(e.doc.get(&f).unwrap().corner_radius, 0.0);
  }

  #[test]
  fn layers_stay_out_of_the_chrome_and_below_it() {
    let mut e = engine();
    let f = frame_id(&mut e);
    set(&mut e, &f, "iphone-17", true);
    let bar = find_named(&e, &f, "Status bar").unwrap();
    // Drawn on the status bar: it goes into the device frame, under the system UI.
    let r = e
      .dispatch(Command::CreateShape {
        kind: NodeType::Rectangle,
        x: 20.0,
        y: 10.0,
        width: 50.0,
        height: 20.0,
        parent: Option::None,
      })
      .unwrap();
    let id = r["id"].as_str().unwrap().to_string();
    assert_eq!(e.doc.get(&id).unwrap().parent.as_deref(), Some(f.as_str()));
    let last: Vec<&str> = e
      .doc
      .get(&f)
      .unwrap()
      .children
      .iter()
      .rev()
      .take(2)
      .filter_map(|c| e.doc.get(c))
      .map(|c| c.name.as_str())
      .collect();
    assert_eq!(last, ["Home indicator", "Status bar"]);
    // An explicit parent inside the chrome is the device frame instead.
    let r = e
      .dispatch(Command::CreateShape {
        kind: NodeType::Rectangle,
        x: 0.0,
        y: 0.0,
        width: 5.0,
        height: 5.0,
        parent: Some(bar.id.clone()),
      })
      .unwrap();
    assert_eq!(e.doc.get(r["id"].as_str().unwrap()).unwrap().parent.as_deref(), Some(f.as_str()));
    // Bring to front and moves keep the chrome last.
    e.dispatch(Command::Reorder {
      ids: vec![id.clone()],
      to: crate::ops::ReorderTo::Front,
    })
    .unwrap();
    let kids = e.doc.get(&f).unwrap().children.clone();
    let pos = |n: &str| kids.iter().position(|c| e.doc.get(c).unwrap().name == n).unwrap();
    assert!(kids.iter().position(|c| *c == id).unwrap() < pos("Status bar") && pos("Status bar") < pos("Home indicator"));
    // The chrome itself can't be moved into another layer or be a parent.
    assert!(e
      .dispatch(Command::MoveToParent {
        ids: vec![id.clone()],
        parent: Some(bar.id.clone()),
        index: Option::None
      })
      .is_err());
  }

  #[test]
  fn deleting_a_part_turns_its_toggle_off_and_chrome_cannot_be_duplicated() {
    let mut e = engine();
    let f = frame_id(&mut e);
    e.dispatch(Command::AddAutoLayout { ids: vec![f.clone()] }).unwrap();
    set(&mut e, &f, "iphone-17", true);
    assert_eq!(pad(&e, &f)[2], 44.0);
    let home = find_named(&e, &f, "Home indicator").unwrap();
    let before = e.doc.nodes.len();
    assert!(e
      .dispatch(Command::Duplicate {
        ids: vec![home.id.clone()]
      })
      .is_err());
    assert_eq!(e.doc.nodes.len(), before);
    e.dispatch(Command::Delete {
      ids: vec![home.id.clone()],
    })
    .unwrap();
    let d = e.doc.get(&f).unwrap().device.clone().unwrap();
    assert!(!d.home_indicator && d.status_bar);
    assert_eq!(d.applied, [62.0, 0.0, 0.0, 0.0]);
    assert_eq!(pad(&e, &f)[2], 10.0);
    assert!(find_named(&e, &f, "Home indicator").is_none() && find_named(&e, &f, "Status bar").is_some());
    e.dispatch(Command::Undo).unwrap();
    assert!(e.doc.get(&f).unwrap().device.as_ref().unwrap().home_indicator && find_named(&e, &f, "Home indicator").is_some());
  }

  #[test]
  fn structural_commands_refuse_system_ui() {
    let mut e = engine();
    let f = frame_id(&mut e);
    set(&mut e, &f, "iphone-17", true);
    let bar = find_named(&e, &f, "Status bar").unwrap().id;
    let home = find_named(&e, &f, "Home indicator").unwrap().id;
    let before = e.doc.clone();
    let ids = vec![bar.clone(), home.clone()];
    let cmds = vec![
      Command::Group { ids: ids.clone() },
      Command::Ungroup { ids: ids.clone() },
      Command::FrameSelection { ids: ids.clone() },
      Command::AddAutoLayout { ids: ids.clone() },
      Command::CreateComponent { ids: ids.clone() },
      Command::BooleanOp {
        ids: ids.clone(),
        operation: serde_json::from_value(json!("union")).unwrap(),
      },
      Command::Flatten { ids: ids.clone() },
      Command::OutlineStroke { ids: ids.clone() },
      Command::UseAsMask { ids: ids.clone() },
    ];
    for c in cmds {
      let name = format!("{c:?}");
      let err = e.dispatch(c).unwrap_err();
      assert!(err.contains("system UI"), "{name}: {err}");
      assert!(e.doc == before, "{name} changed the document");
    }
    // Claude's arrange tool gets the same error.
    for action in ["group", "flatten", "frame"] {
      let err = e
        .dispatch(Command::Ai {
          tool: "arrange".into(),
          input: json!({ "action": action, "ids": [home] }),
        })
        .unwrap_err();
      assert!(err.contains("system UI"), "{action}: {err}");
    }
    assert!(e.doc == before);
    // Content next to the chrome still groups; the chrome is left out of it.
    let r = e
      .dispatch(Command::CreateShape {
        kind: NodeType::Rectangle,
        x: 10.0,
        y: 200.0,
        width: 30.0,
        height: 30.0,
        parent: Option::None,
      })
      .unwrap();
    let rect = r["id"].as_str().unwrap().to_string();
    e.dispatch(Command::Group {
      ids: vec![rect, home.clone()],
    })
    .unwrap();
    assert_eq!(e.doc.get(&home).unwrap().parent.as_deref(), Some(f.as_str()));
    // A theme switch leaves exactly one of each part.
    set_theme(&mut e, &f, "dark");
    assert_eq!(
      e.doc
        .nodes
        .values()
        .filter(|n| n.device_part.as_deref() == Some("homeIndicator"))
        .count(),
      1
    );
  }

  #[test]
  fn a_transparent_frame_stays_transparent_on_a_theme_switch() {
    let mut e = engine();
    let f = frame_id(&mut e);
    e.dispatch(Command::Update {
      ids: vec![f.clone()],
      patch: json!({ "fills": [] }),
    })
    .unwrap();
    set(&mut e, &f, "iphone-17", true);
    set_theme(&mut e, &f, "dark");
    assert!(fill(&e, &f).is_none());
  }

  #[test]
  fn a_pasted_part_is_an_ordinary_layer() {
    let mut e = engine();
    let f = frame_id(&mut e);
    set(&mut e, &f, "iphone-17", true);
    let bar = find_named(&e, &f, "Status bar").unwrap();
    let data = e.copy(std::slice::from_ref(&bar.id));
    let r = e
      .dispatch(Command::Paste {
        data,
        parent: Option::None,
        x: Some(600.0),
        y: Some(0.0),
      })
      .unwrap();
    let copy = e.doc.get(r["created"][0].as_str().unwrap()).unwrap();
    assert!(copy.device_part.is_none() && !copy.locked);
    // Pasting the whole device frame keeps its system UI.
    let data = e.copy(std::slice::from_ref(&f));
    let r = e
      .dispatch(Command::Paste {
        data,
        parent: Option::None,
        x: Some(1200.0),
        y: Some(0.0),
      })
      .unwrap();
    let frame2 = r["created"][0].as_str().unwrap().to_string();
    assert_eq!(parts(&e, &frame2).len(), 2);
  }

  #[test]
  fn old_files_load_and_the_empty_fields_are_not_written() {
    let n: Node = serde_json::from_value(json!({ "id": "a", "name": "A" })).unwrap();
    assert!(n.device.is_none() && n.device_part.is_none());
    let v = serde_json::to_value(&n).unwrap();
    assert!(v.get("device").is_none() && v.get("devicePart").is_none());
    let d: DeviceFrame = serde_json::from_value(json!({ "preset": "pixel-9", "theme": "dark" })).unwrap();
    assert!(d.status_bar && d.pad && d.nav == "gesture" && d.theme == "dark");
    let back = serde_json::to_value(&d).unwrap();
    assert_eq!(back["statusBar"], json!(true));
  }

  #[test]
  fn device_specs_parse_with_helpful_errors() {
    assert!(parse_spec(&json!(null), None).unwrap().is_none());
    let d = parse_spec(&json!("iphone-17-pro"), None).unwrap().unwrap();
    assert_eq!(d.preset, "iphone-17-pro");
    let d = parse_spec(
      &json!({ "preset": "pixel-9", "theme": "dark", "nav": "buttons", "statusBar": false }),
      None,
    )
    .unwrap()
    .unwrap();
    assert!(d.theme == "dark" && d.nav == "buttons" && !d.status_bar);
    let d2 = parse_spec(&json!({ "theme": "light" }), Some(&d)).unwrap().unwrap();
    assert_eq!((d2.preset.as_str(), d2.theme.as_str()), ("pixel-9", "light"));
    assert!(parse_spec(&json!({ "theme": "pink", "preset": "pixel-9" }), None)
      .unwrap_err()
      .contains("theme"));
    assert!(parse_spec(&json!("ihpone-17-pro"), None).unwrap_err().contains("close ids"));
    assert!(parse_spec(&json!(5), None).unwrap_err().contains("a number"));
  }
}
