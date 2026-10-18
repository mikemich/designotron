//! Document model. Everything here is plain serde data so it round-trips
//! through JSON to the web shell, the bridge, AI tools and `.dtron` files.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: u32 = 1;

pub type NodeId = String;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Document {
  pub id: String,
  pub name: String,
  #[serde(default = "schema_version")]
  pub schema: u32,
  pub pages: Vec<Page>,
  /// Persistent map: clones share structure, so undo snapshots and diffs are cheap.
  pub nodes: imbl::OrdMap<NodeId, Node>,
  #[serde(default)]
  pub styles: Styles,
  /// Variable collections (tokens with modes).
  #[serde(default)]
  pub variables: Vec<crate::variables::Collection>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Page {
  pub id: String,
  pub name: String,
  #[serde(default)]
  pub children: Vec<NodeId>,
  #[serde(default = "default_page_bg")]
  pub background: String,
  #[serde(default)]
  pub flow_start: Option<NodeId>,
  /// Ruler guides drawn across the whole page.
  #[serde(default)]
  pub guides: Vec<RulerGuide>,
}

/// A page guide: a vertical line at `position` for axis X, horizontal for Y.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RulerGuide {
  pub axis: Axis,
  pub position: f64,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Axis {
  X,
  Y,
}

/// Figma-style layout grid on a frame: columns, rows or a square grid.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct LayoutGrid {
  pub pattern: GridPattern,
  pub count: u32,
  pub gutter: f64,
  pub margin: f64,
  /// Cell size for `grid`; column/row size when not stretched.
  pub size: f64,
  pub alignment: GridAlign,
  pub color: String,
  pub visible: bool,
}

impl Default for LayoutGrid {
  fn default() -> Self {
    LayoutGrid {
      pattern: GridPattern::Columns,
      count: 12,
      gutter: 20.0,
      margin: 0.0,
      size: 8.0,
      alignment: GridAlign::Stretch,
      color: "#FF00001A".into(),
      visible: true,
    }
  }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GridPattern {
  Columns,
  Rows,
  Grid,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GridAlign {
  Stretch,
  Start,
  Center,
  End,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
#[derive(Default)]
pub enum NodeType {
  Frame,
  Group,
  #[default]
  Rectangle,
  Ellipse,
  Line,
  Polygon,
  Star,
  Vector,
  Text,
  Component,
  ComponentSet,
  Instance,
}

impl NodeType {
  /// Node types that own children and render like a frame.
  pub fn is_frame_like(self) -> bool {
    matches!(
      self,
      NodeType::Frame | NodeType::Component | NodeType::ComponentSet | NodeType::Instance
    )
  }

  pub fn is_container(self) -> bool {
    self.is_frame_like() || self == NodeType::Group
  }

  pub fn label(self) -> &'static str {
    match self {
      NodeType::Frame => "Frame",
      NodeType::Group => "Group",
      NodeType::Rectangle => "Rectangle",
      NodeType::Ellipse => "Ellipse",
      NodeType::Line => "Line",
      NodeType::Polygon => "Polygon",
      NodeType::Star => "Star",
      NodeType::Vector => "Vector",
      NodeType::Text => "Text",
      NodeType::Component => "Component",
      NodeType::ComponentSet => "Component Set",
      NodeType::Instance => "Instance",
    }
  }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Node {
  pub id: NodeId,
  #[serde(rename = "type")]
  pub kind: NodeType,
  pub name: String,
  /// Owning page id.
  pub page: String,
  /// Parent node id; `None` means the node is a root of its page.
  pub parent: Option<NodeId>,
  pub children: Vec<NodeId>,

  pub x: f64,
  pub y: f64,
  pub width: f64,
  pub height: f64,
  /// Degrees, clockwise, around the node centre.
  pub rotation: f64,
  pub flip_x: bool,
  pub flip_y: bool,

  pub visible: bool,
  pub locked: bool,
  pub opacity: f64,
  pub blend_mode: BlendMode,

  pub fills: Vec<Paint>,
  pub strokes: Vec<Paint>,
  pub stroke_weight: f64,
  pub stroke_align: StrokeAlign,
  pub stroke_dash: Vec<f64>,
  pub corner_radius: f64,
  /// Independent corners: top-left, top-right, bottom-right, bottom-left.
  pub corner_radii: Option<[f64; 4]>,
  pub effects: Vec<Effect>,

  pub clip_content: bool,
  pub layout: Option<AutoLayout>,
  pub sizing_h: Sizing,
  pub sizing_v: Sizing,
  /// Opt out of the parent's auto layout flow.
  pub absolute_position: bool,
  pub constraints: Constraints,
  pub min_width: Option<f64>,
  pub max_width: Option<f64>,

  pub text: Option<TextProps>,
  pub vector: Option<VectorData>,
  pub shape: Option<ShapeProps>,
  pub component: Option<ComponentInfo>,
  pub instance: Option<InstanceInfo>,
  /// For nodes living inside an instance: id of the matching node in the main component.
  pub master_id: Option<NodeId>,

  pub fill_style: Option<String>,
  pub text_style: Option<String>,

  pub interactions: Vec<Interaction>,
  pub export_settings: Vec<ExportSetting>,
  /// Free-form notes for developers / AI ("dev mode" annotations).
  pub notes: String,
  /// Layout grids (frames only); editor overlay and snapping, never rendered.
  pub layout_grids: Vec<LayoutGrid>,
  /// Masks the siblings painted above it (Figma "Use as mask"); not drawn itself.
  pub is_mask: bool,
  /// Property → variable id (see `variables::PROPERTIES`).
  pub bindings: BTreeMap<String, String>,
  /// Collection id → mode id for this layer and its descendants.
  pub variable_modes: BTreeMap<String, String>,
}

impl Default for Node {
  fn default() -> Self {
    Node {
      id: String::new(),
      kind: NodeType::Rectangle,
      name: String::new(),
      page: String::new(),
      parent: None,
      children: Vec::new(),
      x: 0.0,
      y: 0.0,
      width: 100.0,
      height: 100.0,
      rotation: 0.0,
      flip_x: false,
      flip_y: false,
      visible: true,
      locked: false,
      opacity: 1.0,
      blend_mode: BlendMode::Normal,
      fills: Vec::new(),
      strokes: Vec::new(),
      stroke_weight: 1.0,
      stroke_align: StrokeAlign::Inside,
      stroke_dash: Vec::new(),
      corner_radius: 0.0,
      corner_radii: None,
      effects: Vec::new(),
      clip_content: false,
      layout: None,
      sizing_h: Sizing::Fixed,
      sizing_v: Sizing::Fixed,
      absolute_position: false,
      constraints: Constraints::default(),
      min_width: None,
      max_width: None,
      text: None,
      vector: None,
      shape: None,
      component: None,
      instance: None,
      master_id: None,
      fill_style: None,
      text_style: None,
      interactions: Vec::new(),
      export_settings: Vec::new(),
      notes: String::new(),
      layout_grids: Vec::new(),
      is_mask: false,
      bindings: BTreeMap::new(),
      variable_modes: BTreeMap::new(),
    }
  }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum BlendMode {
  #[default]
  Normal,
  Multiply,
  Screen,
  Overlay,
  Darken,
  Lighten,
  ColorDodge,
  ColorBurn,
  HardLight,
  SoftLight,
  Difference,
  Exclusion,
  Hue,
  Saturation,
  Color,
  Luminosity,
}

impl BlendMode {
  pub fn css(self) -> &'static str {
    match self {
      BlendMode::Normal => "normal",
      BlendMode::Multiply => "multiply",
      BlendMode::Screen => "screen",
      BlendMode::Overlay => "overlay",
      BlendMode::Darken => "darken",
      BlendMode::Lighten => "lighten",
      BlendMode::ColorDodge => "color-dodge",
      BlendMode::ColorBurn => "color-burn",
      BlendMode::HardLight => "hard-light",
      BlendMode::SoftLight => "soft-light",
      BlendMode::Difference => "difference",
      BlendMode::Exclusion => "exclusion",
      BlendMode::Hue => "hue",
      BlendMode::Saturation => "saturation",
      BlendMode::Color => "color",
      BlendMode::Luminosity => "luminosity",
    }
  }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Paint {
  #[serde(rename_all = "camelCase")]
  Solid {
    color: String,
    #[serde(default = "one")]
    opacity: f64,
    #[serde(default = "yes")]
    visible: bool,
  },
  #[serde(rename_all = "camelCase")]
  LinearGradient {
    stops: Vec<GradientStop>,
    /// Degrees, CSS convention (0 = bottom to top, 90 = left to right).
    #[serde(default = "default_angle")]
    angle: f64,
    #[serde(default = "one")]
    opacity: f64,
    #[serde(default = "yes")]
    visible: bool,
  },
  #[serde(rename_all = "camelCase")]
  RadialGradient {
    stops: Vec<GradientStop>,
    #[serde(default = "one")]
    opacity: f64,
    #[serde(default = "yes")]
    visible: bool,
  },
  #[serde(rename_all = "camelCase")]
  Image {
    src: String,
    #[serde(default)]
    scale_mode: ScaleMode,
    #[serde(default = "one")]
    opacity: f64,
    #[serde(default = "yes")]
    visible: bool,
  },
}

impl Paint {
  pub fn solid(color: &str) -> Paint {
    Paint::Solid {
      color: color.to_string(),
      opacity: 1.0,
      visible: true,
    }
  }

  pub fn visible(&self) -> bool {
    match self {
      Paint::Solid { visible, .. }
      | Paint::LinearGradient { visible, .. }
      | Paint::RadialGradient { visible, .. }
      | Paint::Image { visible, .. } => *visible,
    }
  }

  pub fn opacity(&self) -> f64 {
    match self {
      Paint::Solid { opacity, .. }
      | Paint::LinearGradient { opacity, .. }
      | Paint::RadialGradient { opacity, .. }
      | Paint::Image { opacity, .. } => *opacity,
    }
  }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GradientStop {
  pub color: String,
  /// 0..1
  pub position: f64,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum ScaleMode {
  #[default]
  Fill,
  Fit,
  Stretch,
  Tile,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum StrokeAlign {
  #[default]
  Inside,
  Center,
  Outside,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[derive(Default)]
pub enum EffectType {
  #[default]
  DropShadow,
  InnerShadow,
  LayerBlur,
  BackgroundBlur,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Effect {
  #[serde(rename = "type")]
  pub kind: EffectType,
  pub color: String,
  pub x: f64,
  pub y: f64,
  pub blur: f64,
  pub spread: f64,
  pub visible: bool,
}

impl Default for Effect {
  fn default() -> Self {
    Effect {
      kind: EffectType::DropShadow,
      color: "#00000040".into(),
      x: 0.0,
      y: 4.0,
      blur: 8.0,
      spread: 0.0,
      visible: true,
    }
  }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum Sizing {
  #[default]
  Fixed,
  Hug,
  Fill,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum LayoutDirection {
  #[default]
  Horizontal,
  Vertical,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum Align {
  #[default]
  Start,
  Center,
  End,
  SpaceBetween,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AutoLayout {
  pub direction: LayoutDirection,
  pub gap: f64,
  pub padding_top: f64,
  pub padding_right: f64,
  pub padding_bottom: f64,
  pub padding_left: f64,
  /// Main-axis distribution.
  pub primary_align: Align,
  /// Cross-axis alignment (`SpaceBetween` is treated as `Start`).
  pub counter_align: Align,
  pub wrap: bool,
  pub counter_gap: f64,
}

impl Default for AutoLayout {
  fn default() -> Self {
    AutoLayout {
      direction: LayoutDirection::Vertical,
      gap: 10.0,
      padding_top: 10.0,
      padding_right: 10.0,
      padding_bottom: 10.0,
      padding_left: 10.0,
      primary_align: Align::Start,
      counter_align: Align::Start,
      wrap: false,
      counter_gap: 10.0,
    }
  }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum ConstraintH {
  #[default]
  Left,
  Right,
  LeftRight,
  Center,
  Scale,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum ConstraintV {
  #[default]
  Top,
  Bottom,
  TopBottom,
  Center,
  Scale,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Constraints {
  pub horizontal: ConstraintH,
  pub vertical: ConstraintV,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum TextAlignH {
  #[default]
  Left,
  Center,
  Right,
  Justify,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum TextAlignV {
  #[default]
  Top,
  Middle,
  Bottom,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum TextAutoResize {
  None,
  #[default]
  Width,
  Height,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum TextDecoration {
  #[default]
  None,
  Underline,
  Strikethrough,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum TextCase {
  #[default]
  Original,
  Upper,
  Lower,
  Title,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct TextProps {
  pub characters: String,
  pub font_family: String,
  pub font_size: f64,
  pub font_weight: u32,
  pub italic: bool,
  /// Line height in px; `None` means auto (1.2 × font size).
  pub line_height: Option<f64>,
  pub letter_spacing: f64,
  pub paragraph_spacing: f64,
  pub align_h: TextAlignH,
  pub align_v: TextAlignV,
  pub auto_resize: TextAutoResize,
  pub decoration: TextDecoration,
  pub case: TextCase,
  /// Style overrides for character ranges (mixed styles), sorted and non-overlapping.
  pub runs: Vec<TextRun>,
}

/// Overrides the text layer's base style for characters `start..end` (char offsets).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TextRun {
  pub start: usize,
  pub end: usize,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub font_family: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub font_size: Option<f64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub font_weight: Option<u32>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub italic: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub color: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub decoration: Option<TextDecoration>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub letter_spacing: Option<f64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub link: Option<String>,
}

impl TextRun {
  /// True when the run overrides nothing.
  pub fn is_plain(&self) -> bool {
    self.font_family.is_none()
      && self.font_size.is_none()
      && self.font_weight.is_none()
      && self.italic.is_none()
      && self.color.is_none()
      && self.decoration.is_none()
      && self.letter_spacing.is_none()
      && self.link.is_none()
  }

  pub fn same_style(&self, o: &TextRun) -> bool {
    self.font_family == o.font_family
      && self.font_size == o.font_size
      && self.font_weight == o.font_weight
      && self.italic == o.italic
      && self.color == o.color
      && self.decoration == o.decoration
      && self.letter_spacing == o.letter_spacing
      && self.link == o.link
  }
}

impl Default for TextProps {
  fn default() -> Self {
    TextProps {
      characters: String::new(),
      font_family: "Inter".into(),
      font_size: 16.0,
      font_weight: 400,
      italic: false,
      line_height: None,
      letter_spacing: 0.0,
      paragraph_spacing: 0.0,
      align_h: TextAlignH::Left,
      align_v: TextAlignV::Top,
      auto_resize: TextAutoResize::Width,
      decoration: TextDecoration::None,
      case: TextCase::Original,
      runs: Vec::new(),
    }
  }
}

impl TextProps {
  pub fn line_height_px(&self) -> f64 {
    self.line_height.unwrap_or(self.font_size * 1.2)
  }

  pub fn display_text(&self) -> String {
    match self.case {
      TextCase::Original => self.characters.clone(),
      TextCase::Upper => self.characters.to_uppercase(),
      TextCase::Lower => self.characters.to_lowercase(),
      TextCase::Title => title_case(&self.characters),
    }
  }
}

fn title_case(s: &str) -> String {
  let mut out = String::with_capacity(s.len());
  let mut start = true;
  for c in s.chars() {
    if start && c.is_alphabetic() {
      out.extend(c.to_uppercase());
      start = false;
    } else {
      out.push(c);
      if c.is_whitespace() {
        start = true;
      }
    }
  }
  out
}

/// Vector geometry in node-local coordinates (0..width, 0..height).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct VectorData {
  pub subpaths: Vec<SubPath>,
  /// Raw SVG path data (imported icons). Scaled from `view_box` to the node size.
  pub raw: Option<RawPath>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SubPath {
  pub points: Vec<VectorPoint>,
  pub closed: bool,
}

/// An anchor with optional bezier handles stored as offsets from the anchor.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct VectorPoint {
  pub x: f64,
  pub y: f64,
  pub in_x: f64,
  pub in_y: f64,
  pub out_x: f64,
  pub out_y: f64,
}

impl VectorPoint {
  pub fn at(x: f64, y: f64) -> Self {
    VectorPoint {
      x,
      y,
      ..Default::default()
    }
  }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RawPath {
  pub d: String,
  pub view_box: [f64; 4],
  pub fill_rule: String,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum StrokeCap {
  #[default]
  None,
  Round,
  Square,
  Arrow,
  Circle,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ShapeProps {
  pub point_count: u32,
  /// Star inner radius as a ratio of the outer radius.
  pub inner_radius: f64,
  pub start_cap: StrokeCap,
  pub end_cap: StrokeCap,
}

impl Default for ShapeProps {
  fn default() -> Self {
    ShapeProps {
      point_count: 5,
      inner_radius: 0.38,
      start_cap: StrokeCap::None,
      end_cap: StrokeCap::None,
    }
  }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ComponentInfo {
  pub description: String,
  /// Variant properties when the component lives in a component set, e.g. {"Size": "Large"}.
  pub variant_props: BTreeMap<String, String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct InstanceInfo {
  pub component_id: NodeId,
  /// Property overrides keyed by the master node id inside the component.
  pub overrides: BTreeMap<NodeId, serde_json::Value>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum Trigger {
  #[default]
  OnClick,
  OnHover,
  OnPress,
  AfterDelay,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum Action {
  #[default]
  Navigate,
  Back,
  OpenUrl,
  ScrollTo,
  OpenOverlay,
  CloseOverlay,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum Transition {
  Instant,
  #[default]
  Dissolve,
  SmartAnimate,
  SlideLeft,
  SlideRight,
  SlideUp,
  SlideDown,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Interaction {
  pub trigger: Trigger,
  pub delay_ms: f64,
  pub action: Action,
  pub destination: Option<NodeId>,
  pub url: Option<String>,
  pub transition: Transition,
  pub duration_ms: f64,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum ExportFormat {
  #[default]
  Png,
  Jpg,
  Svg,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ExportSetting {
  pub format: ExportFormat,
  pub scale: f64,
  pub suffix: String,
}

impl Default for ExportSetting {
  fn default() -> Self {
    ExportSetting {
      format: ExportFormat::Png,
      scale: 1.0,
      suffix: String::new(),
    }
  }
}

/// Shared design tokens.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Styles {
  pub colors: Vec<ColorStyle>,
  pub texts: Vec<TextStyle>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ColorStyle {
  pub id: String,
  pub name: String,
  pub color: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TextStyle {
  pub id: String,
  pub name: String,
  pub font_family: String,
  pub font_size: f64,
  pub font_weight: u32,
  pub line_height: Option<f64>,
  pub letter_spacing: f64,
}

fn schema_version() -> u32 {
  SCHEMA_VERSION
}

fn default_page_bg() -> String {
  "#F5F5F5".into()
}

fn one() -> f64 {
  1.0
}

fn yes() -> bool {
  true
}

fn default_angle() -> f64 {
  180.0
}

// Defaults required by `#[serde(default)]` on structs holding these enums.
