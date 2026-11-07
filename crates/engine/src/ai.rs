//! AI tools: one definition list and one executor shared by the in-app
//! Claude chat (API mode), the MCP server for Claude Code and headless runs.
//!
//! Node specs are a forgiving, CSS-flavoured JSON shape so models can write
//! whole screens in one call; they are converted into real nodes here.

use std::collections::{HashSet, VecDeque};
use std::sync::Arc;

use serde_json::{json, Map, Value};

use self::parse::{Ctx, Dim, Radius};
use crate::codegen;
use crate::engine::{Command, Engine};
use crate::geom::Point;
use crate::model::{
  Action, Align, AutoLayout, ColorStyle, Document, Effect, EffectStyle, EffectType, GradientHandles, GradientStop, GridStyle, Interaction,
  LayoutDirection, LayoutGrid, Node, NodeId, NodeType, Overflow, OverlayBackground, OverlayPosition, OverlaySettings, Paint, RawPath,
  ScaleMode, ScrollBehavior, Sizing, StrokeAlign, StrokeJoin, SubPath, TextAlignH, TextAlignV, TextAutoResize, TextCase, TextDecoration,
  TextStyle, Transition, Trigger, VectorData, VectorPoint,
};
use crate::ops::{self, AlignHow, ReorderTo};
use crate::render;

mod mini_regex;
mod parse;
mod photos;
#[cfg(test)]
mod tool_tests;

/// Tools that need a browser (rasterising, DOM). The web shell executes them.
pub const BROWSER_TOOLS: &[&str] = &[
  "get_screenshot",
  "import_html",
  "import_url",
  "save_plugin",
  "search_photos",
  "place_photo",
];

/// Layers `get_document` outlines before it cuts the tree (deeper levels collapse to a count).
const OUTLINE_CAP: usize = 250;
/// Top-level layers `create_nodes` describes one by one; past it the answer is ids only.
const CREATED_CAP: usize = 300;
/// Ids listed when a create is past `CREATED_CAP`.
const CREATED_IDS_CAP: usize = 300;
/// Children of one created layer (and of each child) that are listed.
const CHILDREN_CAP: usize = 50;
/// Children and grandchildren a whole `create_nodes` answer lists.
const CREATED_LISTED: usize = 150;
/// Work a `find_nodes` regex may spend over all layers: this much per character of layer name
/// (so it scales with the file, not with the pattern), between the floor and the ceiling.
const REGEX_STEPS_PER_CHAR: u64 = 40;
const REGEX_BUDGET_MIN: u64 = 3_000_000;
const REGEX_BUDGET_MAX: u64 = 30_000_000;
/// Named descendants `create_nodes` reports.
const NAMES_CAP: usize = 300;
/// Characters of a text layer `get_nodes` returns.
const TEXT_CAP: usize = 2000;
/// Most layers `find_nodes` returns in one call.
const FIND_MAX: usize = 500;
const FIND_DEFAULT: usize = 50;

pub const SYSTEM_PROMPT: &str = "You are the design copilot inside Designotron, a Figma-style design tool. You edit the open document \
through tools. Coordinates are pixels; children are positioned relative to their parent; top-level frames are screens. Place new \
screens to the right of existing content so nothing overlaps.\n\
New designs stay editable: plan the structure first, then build in as few create_nodes calls as you can (nest children). For \
changes to existing layers do only what was asked: no new tokens or components, no fix_issues, at most one screenshot. Reuse the \
file's variables, styles and components before defining new ones; don't retrofit existing layers unless asked.\n\
- Tokens: before building, call define_variables (colours; a Light and a Dark mode when a theme or dark mode is asked for) and \
define_styles (the type scale) in the same message. Bind fills with bind: {fill: 'Theme/Surface'}, set type with textStyle (a text \
style name) and use fillStyle only for colour styles from define_styles, never for a variable. Raw hex only where no token fits.\n\
- Components: anything that appears 2+ times with the same structure (cards, rows, nav items, buttons, inputs) is built once as a \
component (type 'component', or arrange create_component), kept on the canvas beside the screens, and placed as instances \
(type 'instance' + componentId, or create_instance). To change the copy inside instances, give the component Text properties \
and set them for every instance in one set_component_props call. Never copy and paste layers.\n\
- Variants: the states of one control (default, hover, error, disabled) are variants of one component (arrange combine_variants).\n\
- Themes: for dark mode, duplicate the frame and set variableModes (e.g. {Theme: 'Dark'}) on the copy; don't recolour by hand.\n\
- Layout: auto layout for every stack and row (width/height 'fill' or 'hug'); absolute only for overlays and decoration. Name \
layers semantically (Header, Nav, Card, Button, Input): code export reads the names. App and site screens: set device on the frame.\n\
- Images: for products, people and places call search_photos then place_photo into the image layer (keeps its size); never emoji.\n\
Use real copy, a 4/8 grid, a clear type scale and accessible contrast. Recreate attached mockups as editable layers. If the \
context line says \"Page is empty.\", skip get_document. Build every screen and state that was asked for. Finish a new design: if \
the page had nothing else on it before this turn, call fix_issues once (it lints itself); otherwise call lint_design and fix only \
your new layers with update_nodes. Then take one get_screenshot of the new frame, fix only clear defects, and take no second \
screenshot unless the layout changed.\n\
In Designotron's chat panel, reply in at most 3 short plain-text sentences (under 50 words, no Markdown, headings or lists): what \
you built and anything you left out.";

fn spec_schema() -> Value {
  json!({
    "type": "object",
    "description": "A layer. Unknown keys are reported in the result's `warnings` and ignored; wrong values are errors that name the field.",
    "properties": {
      "type": { "type": "string", "enum": ["frame", "rectangle", "ellipse", "text", "line", "polygon", "star", "vector", "group", "image", "instance", "component", "svg"], "description": "svg: a full SVG document as editable layers (give `svg`). Default frame (with a warning when missing). Also accepted: div, container, screen (frame), rect, circle, triangle, icon, path" },
      "name": { "type": "string" },
      "x": { "type": "number", "description": "Relative to the parent layer (for a layer inside a group too; the editor's X field measures from the frame instead)" },
      "y": { "type": "number", "description": "Relative to the parent layer, like x" },
      "width": { "description": "number (px), or 'fill' / 'hug' inside auto layout. Percentages other than '100%' are not supported", "type": ["number", "string"] },
      "height": { "description": "number (px), or 'fill' / 'hug'", "type": ["number", "string"] },
      "fill": { "description": "Hex colour like '#7C5CFF' (rgb()/rgba() also work), a CSS linear-gradient(...), radial-gradient(...) or conic-gradient(from 90deg at 50% 50%, ...) string, a paint object (type solid, linearGradient, radialGradient, angularGradient, diamondGradient with stops [{color, position}] and optional handles {start, end, width} in 0..1 box units), or 'none'", "type": ["string", "object"] },
      "stroke": { "type": ["string", "object"], "description": "Hex colour, or the same paint forms as fill" },
      "strokeWidth": { "type": "number" },
      "strokeAlign": { "type": "string", "enum": ["inside", "center", "outside"] },
      "strokeWeights": { "description": "Individual strokes for rectangles and frames: [top, right, bottom, left] or {top, right, bottom, left}; null goes back to strokeWidth", "type": ["array", "object"] },
      "strokeJoin": { "type": "string", "enum": ["miter", "bevel", "round"] },
      "cornerRadius": { "description": "number, [r] or [topLeft, topRight, bottomRight, bottomLeft], or {topLeft|tl, topRight|tr, bottomRight|br, bottomLeft|bl}", "type": ["number", "array", "object"] },
      "opacity": { "type": "number" },
      "rotation": { "type": "number" },
      "shadow": { "description": "{x, y, blur, spread, color} or an array of them; inset: true for inner shadow. A CSS box-shadow string also works", "type": ["object", "array", "string"] },
      "blur": { "type": "number", "description": "Layer blur radius" },
      "backgroundBlur": { "type": "number" },
      "clip": { "type": "boolean" },
      "overflow": { "type": "string", "enum": ["none", "horizontal", "vertical", "both"], "description": "Frames: which directions the content scrolls in the prototype (the frame also clips). Needs content taller or wider than the frame" },
      "scrollBehavior": { "type": "string", "enum": ["scroll", "fixed"], "description": "Layers inside a scrolling frame: scroll with the content (default) or stay put (a fixed header or tab bar). Sticky is not supported" },
      "layout": {
        "type": "object",
        "description": "Auto layout for frames",
        "properties": {
          "direction": { "type": "string", "enum": ["horizontal", "vertical"], "description": "Also accepted: row, column (any case)" },
          "gap": { "type": "number" },
          "padding": { "description": "number, [vertical, horizontal], [top, right, bottom, left] or {top, right, bottom, left, vertical, horizontal}", "type": ["number", "array", "object"] },
          "align": { "type": "string", "enum": ["start", "center", "end", "space-between"], "description": "Main axis. space-around/space-evenly are not supported" },
          "crossAlign": { "type": "string", "enum": ["start", "center", "end", "baseline"], "description": "Cross axis; baseline lines up the first text baselines of a horizontal layout. For stretch, set the children's width/height to 'fill'" },
          "wrap": { "type": "boolean" },
          "counterGap": { "type": "number", "description": "Gap between wrapped rows (default: gap)" }
        }
      },
      "absolute": { "type": "boolean", "description": "Ignore parent auto layout" },
      "minWidth": { "type": "number", "description": "Minimum width for hug/fill in auto layout (0 clears)" },
      "maxWidth": { "type": "number", "description": "Maximum width; auto-width text wraps at it (0 clears)" },
      "minHeight": { "type": "number" },
      "maxHeight": { "type": "number" },
      "maxLines": { "type": "number", "description": "Text: show at most this many lines, ending in an ellipsis when cut" },
      "truncate": { "type": "boolean", "description": "Text: cut what doesn't fit with an ellipsis" },
      "paragraphSpacing": { "type": "number", "description": "Text: extra space between paragraphs (lines split by newline)" },
      "text": { "type": "string", "description": "Text content (type text)" },
      "spans": { "type": "array", "description": "Mixed-style text instead of `text`: [{text, fontWeight, italic, color, fontSize, fontFamily, decoration, link}]", "items": { "type": "object" } },
      "fontSize": { "type": "number" },
      "fontWeight": { "description": "100-900, or thin, light, regular, medium, semibold, bold, extrabold, black", "type": ["number", "string"] },
      "fontFamily": { "type": "string", "description": "Inter, Roboto, Poppins, Montserrat, Playfair Display, DM Sans, Space Grotesk, JetBrains Mono, Lato, Open Sans" },
      "lineHeight": { "description": "px (24); a number below 4 is a multiple of fontSize (1.5); \"150%\", \"1.5em\" and \"24px\" also work; \"auto\" or 0 is automatic", "type": ["number", "string"] },
      "letterSpacing": { "type": ["number", "string"], "description": "px (2), or \"10%\" / \"0.05em\" of fontSize" },
      "textAlign": { "type": "string", "enum": ["left", "center", "right", "justify"] },
      "color": { "type": "string", "description": "Text colour" },
      "italic": { "type": "boolean" },
      "textCase": { "type": "string", "enum": ["original", "upper", "lower", "title"] },
      "imageUrl": { "type": "string", "description": "Image fill: http(s) URL, data:image/ URL or asset:<id>. For stock photos use search_photos + place_photo instead" },
      "fillStyle": { "type": ["string", "null"], "description": "Colour style name or id (from define_styles): sets the fill (the text colour on text) and links the layer to it; null unlinks" },
      "strokeStyle": { "type": ["string", "null"], "description": "Colour style name or id: sets the stroke colour and links the stroke to it; null unlinks" },
      "effectStyle": { "type": ["string", "null"], "description": "Effect style name or id (from define_styles effects): sets the layer's effects and links it; null unlinks" },
      "gridStyle": { "type": ["string", "null"], "description": "Grid style name or id (from define_styles grids): sets a frame's layout grids and links it; null unlinks" },
      "textStyle": { "type": ["string", "null"], "description": "Text style name or id (from define_styles): sets font, size, weight, line height and letter spacing and links the layer to it; null unlinks" },
      "svg": { "type": "string", "description": "Full SVG markup for an editable icon or illustration (type svg): paths, shapes and groups become vector layers with their fills, strokes and gradients; width/height scale it. Text, images, filters and masks are refused" },
      "svgPath": { "type": "string", "description": "SVG path data for an icon (type vector)" },
      "viewBox": { "type": "array", "description": "[minX, minY, width, height] for svgPath, default [0,0,24,24]" },
      "componentId": { "type": "string", "description": "For type instance" },
      "notes": { "type": "string", "description": "Developer annotation" },
      "bind": { "type": "object", "description": "Property → variable name, e.g. {fill: 'Theme/Surface'}; null unbinds" },
      "variableModes": { "type": "object", "description": "Collection → mode for this frame and its children, e.g. {Theme: 'Dark'}" },
      "device": { "type": ["string", "object", "null"], "description": "Top-level screens: a device preset id (iphone-17-pro, iphone-16, iphone-se, pixel-9, android-compact, ipad-air-11, macbook-pro-14, mac-window, browser-1440…) or {preset, theme:'light'|'dark', statusBar, homeIndicator, chrome, nav:'gesture'|'buttons', url}. Sizes the frame unless width/height are given and adds the system UI as locked, fixed layers that code export leaves out. Safe-area insets are added to layout padding, so give padding from the safe area. null removes it." },
      "layoutGrids": { "type": "array", "description": "Frame layout grids, e.g. [{pattern:'columns', count:12, gutter:24, margin:80}] or [{pattern:'grid', size:8}]", "items": { "type": "object" } },
      "children": { "type": "array", "items": { "type": "object" } }
    },
    "required": ["type"]
  })
}

/// An `update_nodes` item: the spec properties (not type or children), plus `id` and `patch`.
/// Only the types and enums are copied; `create_nodes` carries the descriptions (they cost
/// prompt tokens on every turn).
fn update_item_schema(spec: &Value) -> Value {
  let mut props = spec["properties"].as_object().cloned().unwrap_or_default();
  props.remove("type");
  props.remove("children");
  for p in props.values_mut() {
    strip_descriptions(p);
  }
  props.insert("id".into(), json!({ "type": "string", "description": "The layer to change" }));
  props.insert(
    "patch".into(),
    json!({ "type": "object", "description": "Raw model fields to merge (advanced)" }),
  );
  json!({ "type": "object", "properties": props, "required": ["id"] })
}

fn strip_descriptions(v: &mut Value) {
  match v {
    Value::Object(m) => {
      m.remove("description");
      m.values_mut().for_each(strip_descriptions);
    }
    Value::Array(a) => a.iter_mut().for_each(strip_descriptions),
    _ => {}
  }
}

/// Actions of the `arrange` tool.
const ARRANGE_ACTIONS: &[&str] = &[
  "group",
  "ungroup",
  "frame",
  "duplicate",
  "create_component",
  "combine_variants",
  "detach_instance",
  "add_auto_layout",
  "remove_auto_layout",
  "bring_to_front",
  "send_to_back",
  "align_left",
  "align_center",
  "align_right",
  "align_top",
  "align_middle",
  "align_bottom",
  "distribute_horizontal",
  "distribute_vertical",
  "union",
  "subtract",
  "intersect",
  "exclude",
  "flatten",
  "outline_stroke",
  "mask",
];

/// JSON tool definitions (Anthropic tool format: name, description, input_schema).
pub fn tool_defs() -> Value {
  let spec = spec_schema();
  let update_item = update_item_schema(&spec);
  let mut defs = json!([
    {
      "name": "get_document",
      "description": "Overview of the open design: pages, current page layer tree (to a depth), selection, components and styles. Call first, unless the editor context says the page is empty.",
      "input_schema": { "type": "object", "properties": { "depth": { "type": "integer", "description": "Tree depth (default 3)" } } }
    },
    {
      "name": "get_nodes",
      "description": "Full properties of specific layers plus their subtree outline.",
      "input_schema": { "type": "object", "properties": { "ids": { "type": "array", "items": { "type": "string" } }, "depth": { "type": "integer" } }, "required": ["ids"] }
    },
    {
      "name": "find_nodes",
      "description": "Find layers without reading the whole tree: by name (case-insensitive substring, or /regex/), type, text content, instances of a componentId, or a linked style name. Filters combine (all must match). Returns {total, nodes:[{id,type,name,parentId,page,w,h,text?}]}.",
      "input_schema": { "type": "object", "properties": {
        "name": { "type": "string", "description": "Substring of the layer name, or /regex/ (e.g. /^Button/)" },
        "type": { "type": "string", "description": "frame, rectangle, ellipse, text, line, polygon, star, vector, group, component, component_set, instance, image (a rectangle with an image fill)" },
        "text": { "type": "string", "description": "Substring of a text layer's characters" },
        "componentId": { "type": "string", "description": "Only instances of this main component" },
        "style": { "type": "string", "description": "Name or id of a colour or text style the layer is linked to" },
        "within": { "type": "string", "description": "Only inside this layer's subtree" },
        "page": { "type": "string", "description": "Page id, or \"all\" (default: the current page)" },
        "limit": { "type": "integer", "description": "Default 50, max 500" }
      } }
    },
    {
      "name": "create_nodes",
      "description": "Create layers (with nested children) on the current page or inside parentId; build whole screens in one call. Types: frame, text, rectangle, ellipse, vector (svgPath icons), svg (whole SVG markup as editable layers), group, component (a main component: build anything repeated once) and instance (+ componentId: a linked copy; create the component first, then place instances in a second call). Link tokens with bind (variables), textStyle / fillStyle (style names from define_styles; fillStyle takes colour styles only, a variable name is an error) and variableModes (theme of a frame). Returns ids for the created layers.",
      "input_schema": { "type": "object", "properties": { "parentId": { "type": "string" }, "nodes": { "type": "array", "items": spec } }, "required": ["nodes"] }
    },
    {
      "name": "update_nodes",
      "description": "Change properties of existing layers. Each update is {id, ...any create_nodes property except children}. Use 'patch' for raw model fields.",
      "input_schema": { "type": "object", "properties": { "updates": { "type": "array", "items": update_item } }, "required": ["updates"] }
    },
    {
      "name": "delete_nodes",
      "description": "Delete layers.",
      "input_schema": { "type": "object", "properties": { "ids": { "type": "array", "items": { "type": "string" } } }, "required": ["ids"] }
    },
    {
      "name": "move_nodes",
      "description": "Reparent/reorder layers (parentId null = page root), or move them to page coordinates x/y.",
      "input_schema": { "type": "object", "properties": { "ids": { "type": "array", "items": { "type": "string" } }, "parentId": { "type": ["string", "null"] }, "index": { "type": "integer" }, "x": { "type": "number" }, "y": { "type": "number" } }, "required": ["ids"] }
    },
    {
      "name": "arrange",
      "description": "Structural actions on layers: group, ungroup, frame, duplicate, create_component (turns each selected layer into its own main component, so several ids make several components; to make ONE component from several layers, `frame` them first, then create_component the frame; use it for anything that repeats, then place instances), combine_variants (merges components that are states of one control into one component set; name them 'State=Default', 'State=Error' or 'Input/Default', 'Input/Error' first, then rename the resulting set), detach_instance, add_auto_layout, remove_auto_layout, bring_to_front, send_to_back, align_left, align_center, align_right, align_top, align_middle, align_bottom, distribute_horizontal, distribute_vertical, union, subtract (bottom layer minus the rest), intersect, exclude, flatten, outline_stroke, mask (bottom layer masks the others).",
      "input_schema": { "type": "object", "properties": { "action": { "type": "string", "enum": ARRANGE_ACTIONS }, "ids": { "type": "array", "items": { "type": "string" } } }, "required": ["action", "ids"] }
    },
    {
      "name": "create_instance",
      "description": "Place an instance of a main component.",
      "input_schema": { "type": "object", "properties": { "componentId": { "type": "string" }, "parentId": { "type": "string" }, "x": { "type": "number" }, "y": { "type": "number" } }, "required": ["componentId"] }
    },
    {
      "name": "set_component_props",
      "description": "Component properties, like Figma's: define Boolean (hides/shows a layer), Text (a text layer's characters) and Instance swap (which component a nested instance is) properties on a main component or component set, bind its layers to them, and set values on instances. `ops` run in order as one undo step: {op:'add', component, name, kind:'boolean'|'text'|'instanceSwap', default?, bind?:layerId} (bind makes it from that layer of the main component and starts from its state; instance swap needs a default component id); {op:'update', component, prop, name?, default?, options?:[componentId]} (a new default changes the bound layers of the main component); {op:'delete', component, prop}; {op:'bind', node:layerId, field:'visible'|'characters'|'swap', prop|null}; {op:'set', instance, prop, value|null} (null restores the main component's value; swap takes a component id); {op:'expose', instance, expose:boolean} (an instance inside a main component shows its properties on instances of the outer component). `component` is a main component or set id (a variant's properties are its set's); `prop` is a property id or name. Properties show in get_nodes (`component.props`, `propRefs` on layers, `componentProps` on components and instances) and become React props in code export.",
      "input_schema": { "type": "object", "properties": { "ops": { "type": "array", "items": { "type": "object", "properties": { "op": { "type": "string", "enum": ["add", "update", "delete", "bind", "set", "expose"] } }, "required": ["op"] } } }, "required": ["ops"] }
    },
    {
      "name": "set_prototype",
      "description": "Add a prototype interaction: by default clicking nodeId navigates to destinationId (a top-level frame), goes back, opens a URL, or works with overlays. open_overlay shows destinationId (a top-level frame, e.g. a modal, menu or sheet) on top of the current screen; close_overlay closes the topmost overlay (put it on a close button inside the overlay); swap_overlay replaces the topmost overlay with destinationId. Overlays default to centred, a 30% black dimmed background and closing when clicking outside; change that with `overlay`.",
      "input_schema": { "type": "object", "properties": {
        "nodeId": { "type": "string" }, "destinationId": { "type": "string" },
        "action": { "type": "string", "enum": ["navigate", "back", "open_url", "open_overlay", "close_overlay", "swap_overlay", "scroll_to", "change_to"], "description": "scroll_to scrolls the player to destinationId (a layer in the same top-level frame); change_to switches the instance holding nodeId to destinationId, a variant of the same component set (put it on a variant of the set, or a layer inside one)" }, "url": { "type": "string" },
        "overlay": { "type": "object", "description": "For open_overlay / swap_overlay", "properties": {
          "position": { "type": "string", "enum": ["center", "top_left", "top_center", "top_right", "bottom_left", "bottom_center", "bottom_right", "manual"] },
          "offsetX": { "type": "number", "description": "manual: x from the top-left of nodeId" },
          "offsetY": { "type": "number", "description": "manual: y from the top-left of nodeId" },
          "closeOnClickOutside": { "type": "boolean" },
          "background": { "type": ["string", "null"], "description": "Dim colour behind the overlay (hex, default #000000); null or \"none\" for no dimming" },
          "backgroundOpacity": { "type": "number", "description": "0-1, default 0.3" }
        } },
        "trigger": { "type": "string", "enum": ["click", "hover", "press", "delay", "mouse_enter", "mouse_leave", "mouse_down", "mouse_up", "key"], "description": "hover and press revert when the pointer leaves or lets go; key needs `key`" },
        "key": { "type": "string", "description": "For trigger key: a key or combination such as 'Enter', 'ArrowRight' or 'Shift+K'" },
        "transition": { "type": "string", "enum": ["instant", "dissolve", "smart_animate", "slide_left", "slide_right", "slide_up", "slide_down", "move_in", "move_out", "push"], "description": "smart_animate matches the direct children of both screens by name" },
        "direction": { "type": "string", "enum": ["left", "right", "up", "down"], "description": "For move_in, move_out and push (default left)" },
        "easing": { "type": "string", "enum": ["linear", "ease_in", "ease_out", "ease_in_out", "ease_in_back", "ease_out_back", "ease_in_out_back"], "description": "Default ease_out" },
        "duration": { "type": "number", "description": "Transition milliseconds (default 300)" },
        "clear": { "type": "boolean", "description": "Remove existing interactions first" },
        "delay": { "type": "number", "description": "Milliseconds before a delay trigger fires (default 800)" }
      }, "required": ["nodeId"] }
    },
    {
      "name": "save_plugin",
      "description": "Save a Designotron plugin the user can run from the Plugins menu. The code is the body of an async function with a `dt` API: await dt.tool(name, input) calls these same tools; dt.selection() returns the selected nodes (full JSON); dt.getDocument(depth); dt.getNodes(ids); dt.notify(text); dt.ui.show(html, {width, height}) shows a panel whose scripts can call dt; dt.on('selectionchange', fn); dt.close(). No DOM or storage access outside the plugin's own UI.",
      "input_schema": { "type": "object", "properties": { "name": { "type": "string" }, "description": { "type": "string" }, "code": { "type": "string" } }, "required": ["name", "code"] }
    },
    {
      "name": "get_comments",
      "description": "Open comment threads from collaborators (all pages), with the layer each one is attached to. Address them, then reply_comment and resolve_comment.",
      "input_schema": { "type": "object", "properties": { "includeResolved": { "type": "boolean" } } }
    },
    {
      "name": "reply_comment",
      "description": "Reply to a comment thread, e.g. to say what you changed.",
      "input_schema": { "type": "object", "properties": { "id": { "type": "string" }, "text": { "type": "string" } }, "required": ["id", "text"] }
    },
    {
      "name": "resolve_comment",
      "description": "Mark a comment thread resolved (or reopen it with resolved: false).",
      "input_schema": { "type": "object", "properties": { "id": { "type": "string" }, "resolved": { "type": "boolean" } }, "required": ["id"] }
    },
    {
      "name": "define_variables",
      "description": "Create or update a variable collection with modes and colour/number/string/boolean variables. For a theme or dark mode, use modes [\"Light\", \"Dark\"] and give each colour `values` {Light, Dark}. Bind layer properties with bind: {fill: 'Theme/Background', cornerRadius: 'Radius/md'} in create_nodes/update_nodes (bindable: fill, stroke, cornerRadius, gap, counterGap, padding, paddingTop/Right/Bottom/Left, opacity, width, height, strokeWeight, fontSize, fontFamily, fontWeight, lineHeight, letterSpacing, paragraphSpacing, characters, visible); switch a frame (and its children) to a mode with variableModes: {Theme: 'Dark'}, e.g. on a duplicate of a screen, instead of recolouring it. Bound variables become CSS variables in exported code.",
      "input_schema": { "type": "object", "properties": {
        "collection": { "type": "string" },
        "modes": { "type": "array", "items": { "type": "string" }, "description": "Mode names; the first is the default. Default: [\"Default\"]" },
        "variables": { "type": "array", "items": { "type": "object", "properties": {
          "name": { "type": "string" },
          "type": { "type": "string", "enum": ["color", "number", "string", "boolean"] },
          "value": { "description": "Same value in every mode; {\"alias\": \"Collection/name\"} makes it an alias of another variable of the same type" },
          "values": { "type": "object", "description": "Mode name → value (or an alias object)" },
          "scopes": { "type": "array", "items": { "type": "string", "enum": ["fill", "stroke", "cornerRadius", "size", "gap", "opacity", "strokeWidth", "textContent", "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "paragraphSpacing"] }, "description": "Limit where the variable is offered in the editor (default: everywhere its type fits). Binding it elsewhere only warns." }
        }, "required": ["name", "type"] } }
      }, "required": ["collection", "variables"] }
    },
    {
      "name": "define_styles",
      "description": "Create shared colour, text, effect and grid styles (design tokens), e.g. a type scale like Heading/H1, Body/Regular, or Shadow/Card. Link layers to them by name with textStyle / fillStyle / strokeStyle (colour styles only), effectStyle and gridStyle in create_nodes/update_nodes, or in bulk with fix_issues (kinds: [\"unlinkedStyle\"]). A name with slashes shows as a folder in the Assets panel. Variables are bound with bind, not styles.",
      "input_schema": { "type": "object", "properties": {
        "colors": { "type": "array", "items": { "type": "object", "properties": { "name": { "type": "string" }, "color": { "type": "string", "description": "Hex colour; anything unreadable is an error" } }, "required": ["name", "color"] } },
        "texts": { "type": "array", "items": { "type": "object", "properties": { "name": { "type": "string" }, "fontFamily": { "type": "string" }, "fontSize": { "type": "number" }, "fontWeight": { "type": ["number", "string"] }, "lineHeight": { "type": ["number", "string"], "description": "px, or a multiple of fontSize below 4" }, "letterSpacing": { "type": ["number", "string"], "description": "px, or \"10%\" / \"0.05em\" of fontSize" } }, "required": ["name", "fontSize"] } },
        "effects": { "type": "array", "description": "Effect styles: {name, description, shadow: {x, y, blur, spread, color, inset} or an array of them, blur (layer blur px), backgroundBlur (px)}", "items": { "type": "object", "properties": { "name": { "type": "string" }, "description": { "type": "string" }, "shadow": { "type": ["object", "array", "string"] }, "blur": { "type": "number" }, "backgroundBlur": { "type": "number" } }, "required": ["name"] } },
        "grids": { "type": "array", "description": "Grid styles: {name, description, grids: [{pattern:'columns'|'rows'|'grid', count, gutter, margin, size}]}", "items": { "type": "object", "properties": { "name": { "type": "string" }, "description": { "type": "string" }, "grids": { "type": "array", "items": { "type": "object" } } }, "required": ["name", "grids"] } }
      } }
    },
    {
      "name": "pages",
      "description": "Manage pages: add, rename, delete or switch.",
      "input_schema": { "type": "object", "properties": { "action": { "type": "string", "enum": ["add", "rename", "delete", "switch"] }, "id": { "type": "string" }, "name": { "type": "string" } }, "required": ["action"] }
    },
    {
      "name": "select",
      "description": "Select layers in the editor (and scroll them into view) to show the user what you mean.",
      "input_schema": { "type": "object", "properties": { "ids": { "type": "array", "items": { "type": "string" } } }, "required": ["ids"] }
    },
    {
      "name": "export_code",
      "description": "Generate code for a layer: react (React + Tailwind), html, or svg. Use 'project' to get a full Vite + React + Tailwind project as a file list.",
      "input_schema": { "type": "object", "properties": { "id": { "type": "string" }, "format": { "type": "string", "enum": ["react", "html", "svg", "project"] } }, "required": ["format"] }
    },
    {
      "name": "lint_design",
      "description": "Check the current page for accessibility and consistency problems (contrast, tiny text, off-grid spacing, near-duplicate colours, small tap targets, clipped text, default layer names). Each issue may include a `fix` command; apply fixes with update_nodes or fix_issues.",
      "input_schema": { "type": "object", "properties": {} }
    },
    {
      "name": "fix_issues",
      "description": "Apply the automatic fixes from lint_design. Pass `kinds` to limit which kinds are fixed (e.g. [\"lowContrast\"]).",
      "input_schema": { "type": "object", "properties": { "kinds": { "type": "array", "items": { "type": "string" } } } }
    },
    {
      "name": "get_screenshot",
      "description": "PNG screenshot of a layer (default: current selection or page) so you can visually verify the design. The long side is capped at 1600 px, so a big frame at scale 2 is downscaled; screenshot a section by id to see detail.",
      "input_schema": { "type": "object", "properties": { "id": { "type": "string" }, "scale": { "type": "number", "description": "Default 1, max 2" } } }
    },
    {
      "name": "import_url",
      "description": "Load a live web page (through the local bridge) and convert it into editable layers at a 1440 px wide viewport unless `width` says otherwise (use 390 for a mobile layout). Good for redesigning an existing site.",
      "input_schema": { "type": "object", "properties": { "url": { "type": "string" }, "width": { "type": "number", "description": "Viewport width, default 1440" }, "x": { "type": "number" }, "y": { "type": "number" }, "autoLayout": { "type": "boolean", "description": "Map flex, grid and stacked blocks to auto layout (default true); false keeps absolutely positioned layers" } }, "required": ["url"] }
    },
    {
      "name": "import_html",
      "description": "Render an HTML+CSS snippet (inline styles or <style>) at a width and convert it into editable layers, with flex/grid/stacked blocks mapped to auto layout. Good for complex layouts.",
      "input_schema": { "type": "object", "properties": { "html": { "type": "string" }, "width": { "type": "number" }, "x": { "type": "number" }, "y": { "type": "number" }, "parentId": { "type": "string" }, "name": { "type": "string" }, "autoLayout": { "type": "boolean", "description": "Map flex, grid and stacked blocks to auto layout (default true); false keeps absolutely positioned layers" } }, "required": ["html"] }
    }
  ]);
  if let Some(list) = defs.as_array_mut() {
    list.extend(photos::defs());
  }
  defs
}

fn define_variables(e: &mut Engine, input: &Value) -> Result<Value, String> {
  use crate::variables::{Collection, VarKind, VarMode, Variable};
  let name = input.get("collection").and_then(|v| v.as_str()).ok_or("collection is required")?;
  let mut all: Vec<Collection> = crate::variables::plain(&e.doc.variables);
  let idx = match all.iter().position(|c| c.name == name || c.id == name) {
    Some(i) => i,
    None => {
      all.push(Collection {
        id: e.gen.next("vc_"),
        name: name.to_string(),
        ..Default::default()
      });
      all.len() - 1
    }
  };
  let mut mode_names: Vec<String> = input
    .get("modes")
    .and_then(|v| v.as_array())
    .map(|a| a.iter().filter_map(|m| m.as_str().map(String::from)).collect())
    .unwrap_or_default();
  if mode_names.is_empty() && all[idx].modes.is_empty() {
    mode_names.push("Default".into());
  }
  for m in mode_names {
    if !all[idx].modes.iter().any(|x| x.name == m) {
      let id = e.gen.next("vm_");
      all[idx].modes.push(VarMode { id, name: m });
    }
  }
  let modes = all[idx].modes.clone();
  for spec in input.get("variables").and_then(|v| v.as_array()).cloned().unwrap_or_default() {
    let vname = spec
      .get("name")
      .and_then(|v| v.as_str())
      .ok_or("each variable needs a name")?
      .to_string();
    let kind: VarKind = serde_json::from_value(spec.get("type").cloned().unwrap_or(json!("color"))).map_err(|e| format!("{vname}: {e}"))?;
    let coll = &mut all[idx];
    let pos = match coll.variables.iter().position(|v| v.name == vname) {
      Some(p) => p,
      None => {
        coll.variables.push(Arc::new(Variable {
          id: e.gen.next("v_"),
          name: vname.clone(),
          ..Default::default()
        }));
        coll.variables.len() - 1
      }
    };
    let var = Arc::make_mut(&mut coll.variables[pos]);
    var.kind = kind;
    if let Some(sc) = spec.get("scopes").filter(|v| !v.is_null()) {
      let list: Vec<String> = sc
        .as_array()
        .ok_or_else(|| format!("{vname}: scopes must be an array of names"))?
        .iter()
        .filter_map(|x| x.as_str().map(String::from))
        .collect();
      if let Some(bad) = list.iter().find(|x| !crate::variables::SCOPES.contains(&x.as_str())) {
        return Err(format!(
          "{vname}: unknown scope '{bad}'. Scopes: {}",
          crate::variables::SCOPES.join(", ")
        ));
      }
      var.scopes = list;
    }
    // A value must fit the variable's type; the error names the variable and the mode.
    let norm = |v: &Value, mode: &str| -> Result<Value, String> {
      crate::variables::check_value(kind, v).map_err(|m| format!("{vname} ({mode}): {m}"))
    };
    if let Some(v) = spec.get("value") {
      for m in &modes {
        var.values.insert(m.id.clone(), norm(v, &m.name)?);
      }
    }
    if let Some(obj) = spec.get("values").and_then(|v| v.as_object()) {
      for (mk, v) in obj {
        let mode = modes
          .iter()
          .find(|m| &m.name == mk || &m.id == mk)
          .ok_or_else(|| format!("{vname}: no mode {mk}"))?;
        var.values.insert(mode.id.clone(), norm(v, &mode.name)?);
      }
    }
  }
  // Aliases are written by name ("Collection/name"); store the variable id.
  let lookup = all.clone();
  for v in all.iter_mut().flat_map(|c| c.variables.iter_mut()) {
    if !v.values.values().any(|x| x.get("alias").is_some()) {
      continue;
    }
    let v = Arc::make_mut(v);
    for val in v.values.values_mut() {
      let Some(target) = val.get("alias").and_then(|a| a.as_str()).map(String::from) else {
        continue;
      };
      let found = lookup.iter().flat_map(|c| c.variables.iter().map(move |x| (c, x))).find(|(c, x)| {
        x.id == target || format!("{}/{}", c.name, x.name) == target || (x.name == target && !c.variables.iter().any(|y| y.id == target))
      });
      match found {
        Some((_, x)) if x.kind == v.kind => *val = json!({ "alias": x.id }),
        Some((_, x)) => {
          return Err(format!(
            "{}: alias '{target}' is a {} variable, expected {}",
            v.name,
            kind_word(x.kind),
            kind_word(v.kind)
          ))
        }
        None => return Err(format!("{}: no variable '{target}' to alias", v.name)),
      }
    }
  }
  e.dispatch_inner(Command::SetVariables { collections: all })?;
  Ok(crate::variables::summary(&e.doc))
}

fn kind_word(k: crate::variables::VarKind) -> String {
  format!("{k:?}").to_lowercase()
}

/// `shadow` input (an object, an array of them, a CSS box-shadow string, null or "none") to effects.
fn parse_shadows(cx: &mut Ctx, sh: &Value) -> Result<Vec<Effect>, String> {
  let list: Vec<Value> = match sh {
    Value::Array(a) => a.clone(),
    Value::Null => vec![],
    Value::Object(_) => vec![sh.clone()],
    Value::String(css) if css.trim().eq_ignore_ascii_case("none") => vec![],
    Value::String(css) => parse::css_shadow(cx, "shadow", css)?,
    other => {
      return Err(cx.err(
        "shadow",
        format!(
          "must be {{x, y, blur, spread, color}} or an array of them, got {}",
          parse::kind_of(other)
        ),
      ))
    }
  };
  let mut effects = Vec::new();
  for (i, item) in list.iter().enumerate() {
    let mark = cx.enter(&format!("shadow[{i}]"));
    if !item.is_object() {
      return Err(cx.err(
        "",
        format!("must be an object {{x, y, blur, spread, color}}, got {}", parse::kind_of(item)),
      ));
    }
    effects.push(Effect {
      kind: if item.get("inset").and_then(|v| v.as_bool()).unwrap_or(false) {
        EffectType::InnerShadow
      } else {
        EffectType::DropShadow
      },
      color: match item.get("color") {
        Some(c) if !c.is_null() => parse::color(cx, "color", c)?,
        _ => crate::color::normalize("#00000026"),
      },
      x: parse::opt_number(cx, item, "x")?.unwrap_or(0.0),
      y: parse::opt_number(cx, item, "y")?.unwrap_or(4.0),
      blur: parse::opt_number(cx, item, "blur")?.unwrap_or(12.0),
      spread: parse::opt_number(cx, item, "spread")?.unwrap_or(0.0),
      visible: true,
    });
    cx.leave(mark);
  }
  Ok(effects)
}

/// Executes a tool against the engine. Browser-only tools return an error here.
pub fn execute(e: &mut Engine, tool: &str, input: &Value) -> Result<Value, String> {
  match tool {
    "get_document" => Ok(summary(e, input.get("depth").and_then(|v| v.as_u64()).unwrap_or(3) as usize)),
    "get_nodes" => {
      let ids = str_list(input.get("ids"));
      let depth = input.get("depth").and_then(|v| v.as_u64()).unwrap_or(2) as usize;
      let out: Vec<Value> = ids
        .iter()
        .map(|id| match e.doc.get(id) {
          Some(n) => {
            let mut v = serde_json::to_value(n).unwrap_or(Value::Null);
            if let Value::Object(m) = &mut v {
              cap_text(m);
              m.insert("outline".into(), outline(e, id, depth));
              m.insert("absoluteBounds".into(), json!(e.doc.abs_bounds(id)));
              let props = crate::props::describe(&e.doc, id);
              if matches!(props["mode"].as_str(), Some("main" | "instance")) {
                m.insert("componentProps".into(), props);
              }
            }
            v
          }
          None => json!({ "id": id, "error": "not found" }),
        })
        .collect();
      Ok(json!(out))
    }
    "find_nodes" => find_nodes(e, input),
    "create_nodes" => {
      let specs = input
        .get("nodes")
        .and_then(|v| v.as_array())
        .cloned()
        .ok_or("nodes must be an array of layer objects")?;
      let r = insert_specs_ex(e, &specs, input.get("parentId").and_then(|v| v.as_str()))?;
      Ok(r.into_json())
    }
    "update_nodes" => update_nodes(e, input),
    "delete_nodes" => {
      let ids = str_list(input.get("ids"));
      let (found, missing) = split_known(e, &ids);
      if found.is_empty() {
        return Err(not_found(&ids, "delete"));
      }
      ops::delete(&mut e.doc, &found);
      let mut r = json!({ "deleted": found });
      if !missing.is_empty() {
        r["notFound"] = json!(missing);
      }
      Ok(r)
    }
    "move_nodes" => move_nodes(e, input),
    "arrange" => arrange(e, input),
    "create_instance" => {
      let comp = input
        .get("componentId")
        .and_then(|v| v.as_str())
        .ok_or("componentId required")?
        .to_string();
      let parent = input.get("parentId").and_then(|v| v.as_str()).map(String::from);
      let (x, y) = (num(input.get("x")).unwrap_or(0.0), num(input.get("y")).unwrap_or(0.0));
      let page = e.page.clone();
      let id = crate::components::create_instance(&mut e.doc, &comp, parent.as_deref(), &page, x, y, &mut e.gen)
        .ok_or("componentId is not a component")?;
      Ok(json!({ "id": id }))
    }
    "set_component_props" => {
      let ops = input.get("ops").and_then(|v| v.as_array()).ok_or("ops must be an array")?;
      let mut results = Vec::new();
      for (i, op) in ops.iter().enumerate() {
        let op = resolve_prop_names(e, op);
        let edit: crate::props::PropsOp = serde_json::from_value(op).map_err(|er| format!("ops[{i}]: invalid op: {er}"))?;
        results.push(
          e.dispatch_inner(Command::ComponentProps { edit })
            .map_err(|er| format!("ops[{i}]: {er}"))?,
        );
      }
      Ok(json!({ "results": results }))
    }
    "set_prototype" => set_prototype(e, input),
    "define_variables" => define_variables(e, input),
    "get_comments" => Ok(crate::comments::list(
      &e.doc,
      None,
      input.get("includeResolved").and_then(|v| v.as_bool()).unwrap_or(false),
    )),
    "reply_comment" => e.dispatch_inner(Command::ReplyComment {
      id: input.get("id").and_then(|v| v.as_str()).ok_or("id is required")?.to_string(),
      text: input.get("text").and_then(|v| v.as_str()).ok_or("text is required")?.to_string(),
      author: "Claude".into(),
      time: input.get("time").and_then(|v| v.as_f64()).unwrap_or(0.0),
    }),
    "resolve_comment" => e.dispatch_inner(Command::ResolveComment {
      id: input.get("id").and_then(|v| v.as_str()).ok_or("id is required")?.to_string(),
      resolved: input.get("resolved").and_then(|v| v.as_bool()).unwrap_or(true),
    }),
    "define_styles" => define_styles(e, input),
    "pages" => {
      let id = input.get("id").and_then(|v| v.as_str()).map(String::from);
      let name = input.get("name").and_then(|v| v.as_str()).map(String::from);
      match input.get("action").and_then(|v| v.as_str()).unwrap_or("") {
        "add" => e.dispatch_inner(Command::AddPage { name }),
        "rename" => e.dispatch_inner(Command::RenamePage {
          id: id.ok_or("id required")?,
          name: name.ok_or("name required")?,
        }),
        "delete" => e.dispatch_inner(Command::DeletePage {
          id: id.ok_or("id required")?,
        }),
        "switch" => {
          let id = id.ok_or("id required")?;
          if e.doc.page(&id).is_none() {
            return Err("no such page".into());
          }
          e.page = id;
          e.selection.clear();
          Ok(json!({ "ok": true }))
        }
        other => Err(format!("unknown pages action '{other}'")),
      }
    }
    "select" => {
      let ids: Vec<NodeId> = str_list(input.get("ids"))
        .into_iter()
        .filter(|i| e.doc.nodes.contains_key(i))
        .collect();
      if let Some(n) = ids.first().and_then(|i| e.doc.get(i)) {
        e.page = n.page.clone();
      }
      e.selection = ids.clone();
      Ok(json!({ "selected": ids }))
    }
    "export_code" => {
      let format = input.get("format").and_then(|v| v.as_str()).unwrap_or("react").to_lowercase();
      let format = format.as_str();
      if !matches!(format, "react" | "html" | "svg" | "project") {
        return Err(format!("unknown format '{format}'; use react, html, svg or project"));
      }
      let m = e.measurer();
      if format == "project" {
        let files: Vec<Value> = codegen::export_project(&e.doc, m)
          .into_iter()
          .map(|f| json!({ "path": f.path, "content": f.content }))
          .collect();
        return Ok(json!({ "files": files }));
      }
      let id = input
        .get("id")
        .and_then(|v| v.as_str())
        .map(String::from)
        .or_else(|| e.selection.first().cloned())
        .ok_or("id required")?;
      if e.doc.get(&id).is_none() {
        return Err(format!("no node {id}"));
      }
      let code = match format {
        "html" => codegen::export_html(&e.doc, &id, m),
        "svg" => render::export_svg(&e.doc, &id, m),
        _ => codegen::export_react(&e.doc, &id, m),
      };
      Ok(json!({ "format": format, "code": code }))
    }
    "lint_design" => {
      let page = e.page.clone();
      Ok(json!({ "issues": crate::lint::lint_page(&e.doc, &page, e.measurer()) }))
    }
    "fix_issues" => {
      let kinds = str_list(input.get("kinds"));
      if let Some(bad) = kinds.iter().find(|k| !crate::lint::KINDS.contains(&k.as_str())) {
        return Err(format!("unknown issue kind '{bad}'. Kinds: {}", crate::lint::KINDS.join(", ")));
      }
      let page = e.page.clone();
      let mut fixed = 0;
      // Fixes can surface follow-ups; repeat a few passes with fresh layout.
      for _ in 0..4 {
        let issues = crate::lint::lint_page(&e.doc, &page, e.measurer());
        let todo: Vec<Value> = issues
          .into_iter()
          .filter(|i| kinds.is_empty() || kinds.iter().any(|k| k == i.kind))
          .filter_map(|i| i.fix)
          .collect();
        if todo.is_empty() {
          break;
        }
        for fix in todo {
          let cmd: Command = serde_json::from_value(fix).map_err(|e| e.to_string())?;
          e.dispatch_inner(cmd)?;
          fixed += 1;
        }
        crate::layout::relayout_all(&mut e.doc, e.measurer.as_ref());
      }
      Ok(json!({ "fixed": fixed }))
    }
    "search_photos" | "place_photo" => Err(photos::NEEDS_EDITOR.to_string()),
    t if BROWSER_TOOLS.contains(&t) => Err(format!("{t} needs the Designotron editor open in a browser")),
    other => Err(format!("unknown tool '{other}'")),
  }
}

/// Lets a property op name its property instead of giving its id.
fn resolve_prop_names(e: &Engine, op: &Value) -> Value {
  let mut op = op.clone();
  let anchor = ["component", "instance", "node"]
    .iter()
    .find_map(|k| op.get(*k).and_then(|v| v.as_str()));
  let comp = anchor.and_then(|a| match e.doc.get(a) {
    Some(n) if n.instance.is_some() => n.instance.as_ref().map(|i| i.component_id.clone()),
    // A set owns its properties itself (it has no enclosing component).
    Some(n) if n.kind == NodeType::ComponentSet => Some(n.id.clone()),
    Some(n) => crate::components::enclosing_component(&e.doc, &n.id),
    None => None,
  });
  let by_name = comp.and_then(|c| {
    let want = op.get("prop").and_then(|v| v.as_str())?.to_string();
    let defs = crate::props::props_of(&e.doc, &c);
    if defs.iter().any(|d| d.id == want) {
      return None;
    }
    defs.into_iter().find(|d| d.name == want).map(|d| d.id)
  });
  if let (Some(id), Value::Object(m)) = (by_name, &mut op) {
    m.insert("prop".into(), json!(id));
  }
  op
}

fn arrange(e: &mut Engine, input: &Value) -> Result<Value, String> {
  let ids = str_list(input.get("ids"));
  let action = input.get("action").and_then(|v| v.as_str()).unwrap_or("");
  let (ids, missing) = split_known(e, &ids);
  if !missing.is_empty() && ids.is_empty() {
    return Err(not_found(&missing, action));
  }
  let mut warnings: Vec<String> = Vec::new();
  let mut ids = ids;
  if action == "create_component" {
    // A main component (or a set) is already one: wrapping it would nest main components.
    let mains: Vec<NodeId> = ids
      .iter()
      .filter(|i| {
        e.doc
          .get(i)
          .is_some_and(|n| matches!(n.kind, NodeType::Component | NodeType::ComponentSet))
      })
      .cloned()
      .collect();
    if !mains.is_empty() {
      let names: Vec<String> = mains
        .iter()
        .filter_map(|i| e.doc.get(i))
        .map(|n| format!("'{}' ({})", n.name, n.id))
        .collect();
      warnings.push(format!("{} already a main component; left as it is", names.join(", ")));
      ids.retain(|i| !mains.contains(i));
      if ids.is_empty() {
        e.selection = mains.clone();
        return Ok(json!({ "id": mains[0], "ids": mains, "selection": e.selection, "warnings": warnings }));
      }
    }
  }
  let multi = ids.len() > 1;
  let cmd = match action {
    // Several layers: one component each (use `frame` first to make them one component).
    "create_component" if multi => Command::CreateComponents { ids },
    "group" => Command::Group { ids },
    "ungroup" => Command::Ungroup { ids },
    "frame" => Command::FrameSelection { ids },
    "duplicate" => Command::Duplicate { ids },
    "create_component" => Command::CreateComponent { ids },
    "union" => Command::BooleanOp {
      ids,
      operation: crate::paths::BoolOp::Union,
    },
    "subtract" => Command::BooleanOp {
      ids,
      operation: crate::paths::BoolOp::Subtract,
    },
    "intersect" => Command::BooleanOp {
      ids,
      operation: crate::paths::BoolOp::Intersect,
    },
    "exclude" => Command::BooleanOp {
      ids,
      operation: crate::paths::BoolOp::Exclude,
    },
    "flatten" => Command::Flatten { ids },
    "outline_stroke" => Command::OutlineStroke { ids },
    "mask" => Command::UseAsMask { ids },
    "combine_variants" => Command::CombineVariants { ids },
    "detach_instance" => Command::DetachInstance { ids },
    "add_auto_layout" => Command::AddAutoLayout { ids },
    "remove_auto_layout" => Command::RemoveAutoLayout { ids },
    "bring_to_front" => Command::Reorder { ids, to: ReorderTo::Front },
    "send_to_back" => Command::Reorder { ids, to: ReorderTo::Back },
    "align_left" => Command::Align { ids, how: AlignHow::Left },
    "align_center" => Command::Align {
      ids,
      how: AlignHow::HCenter,
    },
    "align_right" => Command::Align { ids, how: AlignHow::Right },
    "align_top" => Command::Align { ids, how: AlignHow::Top },
    "align_middle" => Command::Align {
      ids,
      how: AlignHow::VCenter,
    },
    "align_bottom" => Command::Align {
      ids,
      how: AlignHow::Bottom,
    },
    "distribute_horizontal" => Command::Distribute { ids, horizontal: true },
    "distribute_vertical" => Command::Distribute { ids, horizontal: false },
    other => return Err(format!("unknown arrange action '{other}'")),
  };
  let mut r = e.dispatch_inner(cmd)?;
  if let Value::Object(m) = &mut r {
    m.insert("selection".into(), json!(e.selection));
    if !missing.is_empty() {
      m.insert("notFound".into(), json!(missing));
    }
    if !warnings.is_empty() {
      m.insert("warnings".into(), json!(warnings));
    }
  }
  Ok(r)
}

fn update_nodes(e: &mut Engine, input: &Value) -> Result<Value, String> {
  let updates = input
    .get("updates")
    .and_then(|v| v.as_array())
    .cloned()
    .ok_or("updates must be an array of {id, ...} objects")?;
  let mut cx = Ctx::new();
  let mut done = Vec::new();
  for (i, u) in updates.iter().enumerate() {
    let mark = cx.enter(&format!("updates[{i}]"));
    if !u.is_object() {
      return Err(cx.err("", format!("must be an object {{id, ...}}, got {}", parse::kind_of(u))));
    }
    let id = u
      .get("id")
      .and_then(|v| v.as_str())
      .ok_or_else(|| cx.err("id", "each update needs an id"))?;
    let before = e.doc.get(id).cloned().ok_or_else(|| cx.err("id", format!("no layer {id}")))?;
    let mut spec = u.clone();
    if spec.get("children").is_some() {
      cx.warn("children can't be changed with update_nodes; use create_nodes with parentId, or move_nodes");
    }
    if let Some(t) = u.get("type").and_then(|v| v.as_str()) {
      if parse_kind(&cx, &t.to_lowercase()).ok() != Some(before.kind) {
        cx.warn(format!(
          "type can't be changed with update_nodes ('{t}' ignored; the layer is a {})",
          before.kind.label()
        ));
      }
    }
    if (u.get("x").is_some() || u.get("y").is_some())
      && in_auto_layout(e, &before)
      && !matches!(parse::opt_bool(&cx, u, "absolute"), Ok(Some(true)))
    {
      cx.warn("x/y ignored: the parent has auto layout; set absolute:true, or reorder with move_nodes index");
      if let Value::Object(m) = &mut spec {
        m.remove("x");
        m.remove("y");
      }
    }
    let mut after = before.clone();
    apply_spec(&mut cx, &e.doc, &mut after, &spec, false)?;
    if let Some(p) = u.get("patch") {
      crate::patch::apply(&mut after, p).map_err(|er| cx.err("patch", er))?;
      check_paint_sources(&after.fills).map_err(|er| cx.err("patch.fills", er))?;
      check_paint_sources(&after.strokes).map_err(|er| cx.err("patch.strokes", er))?;
    }
    let diff = diff_patch(&before, &after);
    if !diff.as_object().map(|m| m.is_empty()).unwrap_or(true) {
      e.dispatch_inner(Command::Update {
        ids: vec![id.to_string()],
        patch: diff,
      })?;
      // Changing the fill, stroke, effects or grids detaches a style, so a style named in the same
      // update is linked again.
      if let Some(n) = e.doc.get_mut(id) {
        let named = |k: &str| spec.get(k).is_some_and(|v| v.is_string());
        if named("fillStyle") {
          n.fill_style = after.fill_style.clone();
        }
        if named("strokeStyle") {
          n.stroke_style = after.stroke_style.clone();
        }
        if named("effectStyle") {
          n.effect_style = after.effect_style.clone();
        }
        if named("gridStyle") {
          n.grid_style = after.grid_style.clone();
        }
      }
    }
    // A merge patch can't delete map entries: unbound properties and unpinned collections go
    // through their own commands.
    // Stale keys (a property this build doesn't know, a collection that is gone) are dropped
    // directly instead of failing the whole update.
    for prop in before.bindings.keys().filter(|p| !after.bindings.contains_key(*p)) {
      if crate::variables::property_kind(prop).is_some() {
        e.dispatch_inner(Command::BindVariable {
          ids: vec![id.to_string()],
          property: prop.clone(),
          variable: None,
        })?;
      } else {
        e.doc.modify(id, |n| {
          n.bindings.remove(prop);
        });
      }
    }
    for coll in before.variable_modes.keys().filter(|c| !after.variable_modes.contains_key(*c)) {
      if e.doc.variables.iter().any(|c| c.id == *coll || c.name == *coll) {
        e.dispatch_inner(Command::SetVariableMode {
          ids: vec![id.to_string()],
          collection: coll.clone(),
          mode: None,
        })?;
      } else {
        e.doc.modify(id, |n| {
          n.variable_modes.remove(coll);
        });
      }
    }
    // Auto layout added or removed (or new padding given) on a device frame: its chrome joins or leaves
    // the flow and the safe area follows. This runs before a device change, which works from `applied`.
    if before.device.is_some() {
      let layout_now = e.doc.get(id).is_some_and(|n| n.layout.is_some());
      if layout_now != before.layout.is_some() {
        crate::devices::refresh(&mut e.doc, &mut e.gen, id);
      } else if u.get("layout").is_some_and(|l| l.get("padding").is_some()) {
        keep_safe_area(e, id);
      }
    }
    if let Some(d) = u.get("device") {
      let device = crate::devices::parse_spec(d, before.device.as_ref()).map_err(|m| cx.err("device", m))?;
      let sized = u.get("width").is_some() || u.get("height").is_some();
      // A new preset sizes the frame (unless the update gives a size); the same one only restyles.
      let new_preset = device
        .as_ref()
        .is_some_and(|n| before.device.as_ref().map(|b| &b.preset) != Some(&n.preset));
      e.dispatch_inner(Command::SetDevice {
        id: id.to_string(),
        device,
        resize: !sized && new_preset,
      })
      .map_err(|m| cx.err("device", m))?;
    }
    done.push(id.to_string());
    cx.leave(mark);
  }
  let mut r = json!({ "updated": done });
  let warnings = cx.into_warnings();
  if !warnings.is_empty() {
    r["warnings"] = json!(warnings);
  }
  Ok(r)
}

/// New padding given to a device frame is the content's: its safe area goes on top again.
fn keep_safe_area(e: &mut Engine, id: &str) {
  let Some(applied) = e.doc.get(id).and_then(|n| n.device.as_ref()).map(|d| d.applied) else {
    return;
  };
  if let Some(l) = e.doc.get_mut(id).and_then(|n| n.layout.as_mut()) {
    l.padding_top += applied[0];
    l.padding_right += applied[1];
    l.padding_bottom += applied[2];
    l.padding_left += applied[3];
  }
}

fn move_nodes(e: &mut Engine, input: &Value) -> Result<Value, String> {
  let ids = str_list(input.get("ids"));
  let (found, missing) = split_known(e, &ids);
  if found.is_empty() {
    return Err(not_found(&ids, "move"));
  }
  let parent = match input.get("parentId") {
    None | Some(Value::Null) => None,
    Some(Value::String(p)) => {
      let pn = e.doc.get(p).ok_or_else(|| format!("no parent layer {p}; nothing was moved"))?;
      if !pn.kind.is_container() {
        return Err(format!("{p} is a {} and cannot have children; nothing was moved", pn.kind.label()));
      }
      Some(p.clone())
    }
    Some(other) => return Err(format!("parentId must be a layer id or null, got {}", parse::kind_of(other))),
  };
  if let Some(p) = &parent {
    let chain: Vec<String> = std::iter::once(p.clone()).chain(e.doc.ancestors(p)).collect();
    if let Some(id) = found.iter().find(|id| chain.contains(id)) {
      let what = if id == p { "itself" } else { "one of its own descendants" };
      return Err(format!("can't move {id} into {what} ({p}); nothing was moved"));
    }
  }
  let reparent = input.get("parentId").is_some() || input.get("index").is_some();
  let mut cx = Ctx::new();
  let mut moved = found.clone();
  let (x, y) = (parse::opt_number(&cx, input, "x")?, parse::opt_number(&cx, input, "y")?);
  if let (Some(x), Some(y)) = (x, y) {
    let mut skipped = Vec::new();
    for id in &found {
      if e.doc.get(id).is_some_and(|n| in_auto_layout(e, n)) {
        cx.warn(format!(
          "{id}: x/y ignored: the parent has auto layout; set absolute:true with update_nodes, or use index"
        ));
        skipped.push(id.clone());
      } else {
        ops::move_abs_to(&mut e.doc, id, x, y);
      }
    }
    if !reparent {
      moved.retain(|id| !skipped.contains(id));
    }
  } else if x.is_some() != y.is_some() {
    cx.warn("x and y must be given together; ignored");
  }
  if reparent {
    let index = parse::opt_number(&cx, input, "index")?.filter(|i| *i >= 0.0).map(|i| i as usize);
    e.dispatch_inner(Command::MoveToParent { ids: found, parent, index })?;
  }
  let mut r = json!({ "moved": moved });
  if !missing.is_empty() {
    r["notFound"] = json!(missing);
  }
  let warnings = cx.into_warnings();
  if !warnings.is_empty() {
    r["warnings"] = json!(warnings);
  }
  Ok(r)
}

/// Whether auto layout positions this layer (its parent has one and it isn't absolute).
fn in_auto_layout(e: &Engine, n: &Node) -> bool {
  !n.absolute_position && n.parent.as_ref().and_then(|p| e.doc.get(p)).is_some_and(|p| p.layout.is_some())
}

/// The ids that exist, and the ones that don't.
fn split_known(e: &Engine, ids: &[String]) -> (Vec<String>, Vec<String>) {
  ids.iter().cloned().partition(|id| e.doc.nodes.contains_key(id))
}

fn not_found(ids: &[String], verb: &str) -> String {
  if ids.is_empty() {
    "ids must be a non-empty array of layer ids".into()
  } else {
    format!("no layer with id {}; nothing to {verb}", ids.join(", "))
  }
}

fn set_prototype(e: &mut Engine, input: &Value) -> Result<Value, String> {
  let cx = Ctx::new();
  let id = input.get("nodeId").and_then(|v| v.as_str()).ok_or("nodeId required")?;
  if e.doc.get(id).is_none() {
    return Err(format!("no layer {id}"));
  }
  // A url alone means "open this link".
  let default_action = if input.get("action").is_none_or(|a| a.is_null()) && input.get("url").is_some_and(|u| u.is_string()) {
    Action::OpenUrl
  } else {
    Action::Navigate
  };
  let action = parse::exact(
    &cx,
    "action",
    input.get("action"),
    default_action,
    &[
      ("navigate", Action::Navigate),
      ("back", Action::Back),
      ("open_url", Action::OpenUrl),
      ("open_overlay", Action::OpenOverlay),
      ("close_overlay", Action::CloseOverlay),
      ("swap_overlay", Action::SwapOverlay),
      ("scroll_to", Action::ScrollTo),
      ("change_to", Action::ChangeTo),
    ],
  )?;
  let trigger = parse::exact(
    &cx,
    "trigger",
    input.get("trigger"),
    Trigger::OnClick,
    &[
      ("click", Trigger::OnClick),
      ("hover", Trigger::OnHover),
      ("press", Trigger::OnPress),
      ("delay", Trigger::AfterDelay),
      ("mouse_enter", Trigger::MouseEnter),
      ("mouse_leave", Trigger::MouseLeave),
      ("mouse_down", Trigger::MouseDown),
      ("mouse_up", Trigger::MouseUp),
      ("key", Trigger::Key),
    ],
  )?;
  let key = match input.get("key").filter(|v| !v.is_null()) {
    Some(k) => Some(normalize_key(k.as_str().ok_or("key must be text like 'Shift+K'")?)?),
    None => None,
  };
  if trigger == Trigger::Key && key.is_none() {
    return Err("trigger key needs `key`, a key or combination such as 'Enter' or 'Shift+K'".into());
  }
  let key = if trigger == Trigger::Key { key } else { None };
  let direction = parse::exact(
    &cx,
    "direction",
    input.get("direction"),
    crate::model::Direction::Left,
    &[
      ("left", crate::model::Direction::Left),
      ("right", crate::model::Direction::Right),
      ("up", crate::model::Direction::Up),
      ("down", crate::model::Direction::Down),
    ],
  )?;
  let easing = parse::exact(
    &cx,
    "easing",
    input.get("easing"),
    crate::model::Easing::EaseOut,
    &[
      ("linear", crate::model::Easing::Linear),
      ("ease_in", crate::model::Easing::EaseIn),
      ("ease_out", crate::model::Easing::EaseOut),
      ("ease_in_out", crate::model::Easing::EaseInOut),
      ("ease_in_back", crate::model::Easing::EaseInBack),
      ("ease_out_back", crate::model::Easing::EaseOutBack),
      ("ease_in_out_back", crate::model::Easing::EaseInOutBack),
    ],
  )?;
  let duration_ms = match input.get("duration").filter(|v| !v.is_null()) {
    Some(v) => parse::number(&cx, "duration", v).and_then(|d| {
      if (0.0..=60000.0).contains(&d) {
        Ok(d)
      } else {
        Err(cx.err("duration", "must be between 0 and 60000 milliseconds"))
      }
    })?,
    None => 300.0,
  };
  let transition = parse::exact(
    &cx,
    "transition",
    input.get("transition"),
    Transition::Dissolve,
    &[
      ("instant", Transition::Instant),
      ("dissolve", Transition::Dissolve),
      ("smart_animate", Transition::SmartAnimate),
      ("slide_left", Transition::SlideLeft),
      ("slide_right", Transition::SlideRight),
      ("slide_up", Transition::SlideUp),
      ("slide_down", Transition::SlideDown),
      ("move_in", Transition::MoveIn),
      ("move_out", Transition::MoveOut),
      ("push", Transition::Push),
    ],
  )?;
  let url = input.get("url").and_then(|v| v.as_str());
  if let Some(url) = url {
    crate::model::safe_link(url).ok_or("url must be an http(s), mailto: or tel: link")?;
  }
  if action == Action::OpenUrl && url.is_none() {
    return Err("open_url needs a url".into());
  }
  let destination = input.get("destinationId").and_then(|v| v.as_str()).map(String::from);
  if matches!(action, Action::Navigate | Action::OpenOverlay | Action::SwapOverlay) {
    let what = if action == Action::Navigate {
      "the screen to go to"
    } else {
      "the overlay frame"
    };
    let d = destination.as_deref().ok_or_else(|| {
      format!(
        "destinationId ({what}) is required for {}",
        input["action"].as_str().unwrap_or("navigate")
      )
    })?;
    match e.doc.get(d) {
      None => return Err(format!("destinationId {d} doesn't exist")),
      Some(n) if n.parent.is_some() || !matches!(n.kind, NodeType::Frame | NodeType::Component) => {
        return Err(format!(
          "destinationId {d} must be a top-level frame, not a {} inside another layer",
          n.kind.label()
        ));
      }
      Some(_) => {}
    }
  }
  match action {
    Action::ScrollTo => {
      let d = destination
        .as_deref()
        .ok_or("destinationId (the layer to scroll to) is required for scroll_to")?;
      if e.doc.get(d).is_none() {
        return Err(format!("destinationId {d} doesn't exist"));
      }
      if e.doc.top_level_of(d) != e.doc.top_level_of(id) {
        return Err(format!("destinationId {d} must be inside the same top-level frame as {id}"));
      }
    }
    Action::ChangeTo => {
      let d = destination
        .as_deref()
        .ok_or("destinationId (the variant to change to) is required for change_to")?;
      let dest_set = e
        .doc
        .get(d)
        .filter(|v| v.kind == NodeType::Component)
        .and_then(|v| v.parent.as_deref())
        .filter(|p| e.doc.get(p).is_some_and(|p| p.kind == NodeType::ComponentSet))
        .ok_or_else(|| format!("destinationId {d} must be a variant (a component inside a component set)"))?;
      let sets = enclosing_sets(&e.doc, id);
      if sets.is_empty() {
        return Err(format!(
          "{id} isn't a variant or inside one (or inside an instance of one), so there is nothing to change"
        ));
      }
      if !sets.iter().any(|s| s == dest_set) {
        let name = |s: &str| e.doc.get(s).map(|n| n.name.clone()).unwrap_or_default();
        return Err(format!(
          "destinationId {d} belongs to the set '{}'; {id} can only change to a variant of '{}'",
          name(dest_set),
          name(&sets[0])
        ));
      }
    }
    _ => {}
  }
  let overlay = overlay_settings(input.get("overlay"))?;
  let delay_ms = match input.get("delay").filter(|v| !v.is_null()) {
    Some(v) => parse::number(&cx, "delay", v).and_then(|d| {
      if d >= 0.0 {
        Ok(d)
      } else {
        Err(cx.err("delay", "must be 0 or more milliseconds"))
      }
    })?,
    None => 800.0,
  };
  let n = e.doc.get_mut(id).ok_or("no such node")?;
  if input.get("clear").and_then(|v| v.as_bool()).unwrap_or(false) {
    n.interactions.clear();
  }
  // A second interaction with the same trigger would never play, so it replaces the first
  // (key triggers are told apart by their key).
  let (replaced, kept): (Vec<Interaction>, Vec<Interaction>) = std::mem::take(&mut n.interactions)
    .into_iter()
    .partition(|i| i.trigger == trigger && (trigger != Trigger::Key || i.key == key));
  n.interactions = kept;
  n.interactions.push(Interaction {
    trigger,
    delay_ms,
    action,
    destination,
    url: url.map(String::from),
    transition,
    duration_ms,
    key,
    direction,
    easing,
    overlay,
  });
  let mut r = json!({ "ok": true });
  if !replaced.is_empty() {
    r["replaced"] = json!(replaced
      .iter()
      .map(|i| json!({ "trigger": i.trigger, "action": i.action, "destinationId": i.destination }))
      .collect::<Vec<_>>());
  }
  Ok(r)
}

/// Creates colour and text styles; a name that already exists is updated in place (its layers follow).
fn define_styles(e: &mut Engine, input: &Value) -> Result<Value, String> {
  let mut cx = Ctx::new();
  let (mut created, mut updated) = (Vec::new(), Vec::new());
  for (i, c) in input
    .get("colors")
    .and_then(|v| v.as_array())
    .cloned()
    .unwrap_or_default()
    .iter()
    .enumerate()
  {
    let mark = cx.enter(&format!("colors[{i}]"));
    let name = style_name(&cx, c)?;
    let color = match c.get("color") {
      Some(v) => parse::color(&cx, "color", v)?,
      None => return Err(cx.err("color", "required")),
    };
    match e.doc.styles.colors.iter().find(|s| s.name == name).map(|s| s.id.clone()) {
      Some(id) => {
        e.dispatch_inner(Command::UpdateColorStyle {
          id: id.clone(),
          name: None,
          color: Some(color),
        })?;
        updated.push(json!(id));
      }
      None => {
        let r = e.dispatch_inner(Command::AddColorStyle { name, color })?;
        created.push(r["id"].clone());
      }
    }
    cx.leave(mark);
  }
  for (i, t) in input
    .get("texts")
    .and_then(|v| v.as_array())
    .cloned()
    .unwrap_or_default()
    .iter()
    .enumerate()
  {
    let mark = cx.enter(&format!("texts[{i}]"));
    let name = style_name(&cx, t)?;
    let existing = e.doc.styles.texts.iter().find(|s| s.name == name).cloned();
    let size = parse::opt_number(&cx, t, "fontSize")?;
    let font_size = size.or(existing.as_ref().map(|s| s.font_size)).unwrap_or(16.0);
    let weight = match t.get("fontWeight").filter(|v| !v.is_null()) {
      Some(w) => Some(parse::font_weight(&cx, "fontWeight", w)?),
      None => None,
    };
    let line_height = match t.get("lineHeight").filter(|v| !v.is_null()) {
      Some(l) => Some(parse::line_height(&cx, "lineHeight", l, font_size)?),
      None => None,
    };
    let spacing = match t.get("letterSpacing").filter(|v| !v.is_null()) {
      Some(l) => Some(parse::letter_spacing(&cx, "letterSpacing", l, font_size)?),
      None => None,
    };
    let family = t.get("fontFamily").and_then(|v| v.as_str()).map(String::from);
    match existing {
      Some(s) => {
        e.dispatch_inner(Command::UpdateTextStyle {
          id: s.id.clone(),
          name: None,
          font_family: family,
          font_size: size,
          font_weight: weight,
          line_height: line_height.flatten(),
          auto_line_height: line_height == Some(None),
          letter_spacing: spacing,
        })?;
        updated.push(json!(s.id));
      }
      None => {
        let id = e.gen.next("s_");
        e.doc.styles_mut().texts.push(TextStyle {
          id: id.clone(),
          name,
          font_family: family.unwrap_or_else(|| "Inter".into()),
          font_size,
          font_weight: weight.unwrap_or(400),
          line_height: line_height.flatten(),
          letter_spacing: spacing.unwrap_or(0.0),
        });
        created.push(json!(id));
      }
    }
    cx.leave(mark);
  }
  for (i, f) in input
    .get("effects")
    .and_then(|v| v.as_array())
    .cloned()
    .unwrap_or_default()
    .iter()
    .enumerate()
  {
    let mark = cx.enter(&format!("effects[{i}]"));
    let name = style_name(&cx, f)?;
    let mut effects = Vec::new();
    if let Some(sh) = f.get("shadow").filter(|v| !v.is_null()) {
      effects.extend(parse_shadows(&mut cx, sh)?);
    }
    if let Some(b) = parse::opt_number(&cx, f, "blur")?.filter(|b| *b > 0.0) {
      effects.push(Effect {
        kind: EffectType::LayerBlur,
        blur: b,
        ..Default::default()
      });
    }
    if let Some(b) = parse::opt_number(&cx, f, "backgroundBlur")?.filter(|b| *b > 0.0) {
      effects.push(Effect {
        kind: EffectType::BackgroundBlur,
        blur: b,
        ..Default::default()
      });
    }
    let description = f.get("description").and_then(|v| v.as_str()).map(String::from);
    match e.doc.styles.effects.iter().find(|s| s.name == name).map(|s| s.id.clone()) {
      Some(id) => {
        e.dispatch_inner(Command::UpdateEffectStyle {
          id: id.clone(),
          name: None,
          effects: (!effects.is_empty()).then_some(effects),
          description,
        })?;
        updated.push(json!(id));
      }
      None => {
        if effects.is_empty() {
          return Err(cx.err("", "give a shadow, blur or backgroundBlur"));
        }
        let id = e.gen.next("s_");
        e.doc.styles_mut().effects.push(EffectStyle {
          id: id.clone(),
          name,
          effects,
          description: description.unwrap_or_default(),
        });
        created.push(json!(id));
      }
    }
    cx.leave(mark);
  }
  for (i, g) in input
    .get("grids")
    .and_then(|v| v.as_array())
    .cloned()
    .unwrap_or_default()
    .iter()
    .enumerate()
  {
    let mark = cx.enter(&format!("grids[{i}]"));
    let name = style_name(&cx, g)?;
    let grids: Vec<LayoutGrid> = match g.get("grids") {
      Some(v) => serde_json::from_value(v.clone()).map_err(|er| cx.err("grids", er))?,
      None => return Err(cx.err("grids", "required")),
    };
    let description = g.get("description").and_then(|v| v.as_str()).map(String::from);
    match e.doc.styles.grids.iter().find(|s| s.name == name).map(|s| s.id.clone()) {
      Some(id) => {
        e.dispatch_inner(Command::UpdateGridStyle {
          id: id.clone(),
          name: None,
          grids: Some(grids),
          description,
        })?;
        updated.push(json!(id));
      }
      None => {
        let id = e.gen.next("s_");
        e.doc.styles_mut().grids.push(GridStyle {
          id: id.clone(),
          name,
          grids,
          description: description.unwrap_or_default(),
        });
        created.push(json!(id));
      }
    }
    cx.leave(mark);
  }
  let mut r = json!({ "created": created });
  if !updated.is_empty() {
    r["updated"] = json!(updated);
  }
  Ok(r)
}

fn style_name(cx: &Ctx, v: &Value) -> Result<String, String> {
  match v.get("name").and_then(|n| n.as_str()).map(str::trim) {
    Some(n) if !n.is_empty() => Ok(n.to_string()),
    _ => Err(cx.err("name", "each style needs a name")),
  }
}

/// Searches the document without reading the tree.
fn find_nodes(e: &Engine, input: &Value) -> Result<Value, String> {
  let cx = Ctx::new();
  let text_filter = |key: &str| -> Result<Option<String>, String> {
    match input.get(key).filter(|v| !v.is_null()) {
      Some(Value::String(s)) if !s.is_empty() => Ok(Some(s.clone())),
      Some(Value::String(_)) => Ok(None),
      Some(other) => Err(cx.err(key, format!("must be a string, got {}", parse::kind_of(other)))),
      None => Ok(None),
    }
  };
  enum NameMatch {
    Substring(String),
    Pattern(mini_regex::Regex),
  }
  let name = match text_filter("name")? {
    Some(n) if n.len() > 2 && n.starts_with('/') && n.ends_with('/') => Some(NameMatch::Pattern(
      mini_regex::Regex::new(&n[1..n.len() - 1]).map_err(|er| cx.err("name", format!("bad regex: {er}")))?,
    )),
    Some(n) => Some(NameMatch::Substring(n.to_lowercase())),
    None => None,
  };
  let kind = match text_filter("type")? {
    Some(t) => Some(find_type(&cx, &t)?),
    None => None,
  };
  let text = text_filter("text")?.map(|t| t.to_lowercase());
  let component = text_filter("componentId")?;
  if let Some(c) = &component {
    if !e.doc.get(c).is_some_and(|n| n.kind == NodeType::Component) {
      return Err(cx.err("componentId", format!("{c} is not a main component")));
    }
  }
  let style = text_filter("style")?;
  let within = text_filter("within")?;
  if let Some(w) = &within {
    if e.doc.get(w).is_none() {
      return Err(cx.err("within", format!("no layer {w}")));
    }
  }
  let limit = match input.get("limit").filter(|v| !v.is_null()) {
    Some(v) => (parse::number(&cx, "limit", v)?.max(1.0) as usize).min(FIND_MAX),
    None => FIND_DEFAULT,
  };
  // Ids a style name stands for (a name can be shared by a colour and a text style).
  let style_ids: Option<Vec<&str>> = style.as_ref().map(|s| {
    let l = s.to_lowercase();
    e.doc
      .styles
      .colors
      .iter()
      .map(|c| (c.id.as_str(), c.name.as_str()))
      .chain(e.doc.styles.texts.iter().map(|t| (t.id.as_str(), t.name.as_str())))
      .filter(|(id, n)| *id == s || n.to_lowercase() == l)
      .map(|(id, _)| id)
      .collect()
  });
  if let (Some(ids), Some(s)) = (&style_ids, &style) {
    if ids.is_empty() {
      let mut names: Vec<String> = e.doc.styles.colors.iter().map(|c| c.name.clone()).collect();
      names.extend(e.doc.styles.texts.iter().map(|t| t.name.clone()));
      return Err(cx.err("style", format!("no style '{s}'. Styles: {}", parse::listed(&names, "none"))));
    }
  }
  let pages: Vec<String> = match input.get("page").and_then(|v| v.as_str()) {
    None => vec![e.page.clone()],
    Some("all") => e.doc.pages.iter().map(|p| p.id.clone()).collect(),
    Some(p) if e.doc.page(p).is_some() => vec![p.to_string()],
    Some(p) => return Err(cx.err("page", format!("no page {p}; use a page id or \"all\""))),
  };
  if let Some(w) = &within {
    let page = e.doc.get(w).map(|n| n.page.clone()).unwrap_or_default();
    if !pages.contains(&page) {
      return Err(cx.err("within", format!("{w} is on page {page}; pass page: \"{page}\" (or \"all\")")));
    }
  }
  let candidates: Vec<String> = match &within {
    Some(w) => e.doc.subtree(w),
    None => pages.iter().flat_map(|p| e.doc.page_nodes(p)).collect(),
  };
  let name_chars: u64 = match name {
    Some(NameMatch::Pattern(_)) => candidates
      .iter()
      .filter_map(|id| e.doc.get(id))
      .map(|n| n.name.chars().count() as u64)
      .sum(),
    _ => 0,
  };
  let mut budget = (name_chars * REGEX_STEPS_PER_CHAR).clamp(REGEX_BUDGET_MIN, REGEX_BUDGET_MAX);
  let (mut total, mut out) = (0usize, Vec::new());
  for id in &candidates {
    let Some(n) = e.doc.get(id) else { continue };
    if !pages.contains(&n.page) {
      continue;
    }
    if !kind.as_ref().is_none_or(|k| k.matches(n)) {
      continue;
    }
    let name_ok = match &name {
      None => true,
      Some(NameMatch::Substring(s)) => n.name.to_lowercase().contains(s.as_str()),
      Some(NameMatch::Pattern(r)) => r.is_match(&n.name, &mut budget).map_err(|_| {
        cx.err(
          "name",
          "the pattern is too complex for this many layers; simplify it or narrow the search with within/type",
        )
      })?,
    };
    if !name_ok {
      continue;
    }
    if let Some(t) = &text {
      if !n.text.as_ref().is_some_and(|tp| tp.characters.to_lowercase().contains(t.as_str())) {
        continue;
      }
    }
    if let Some(c) = &component {
      if n.instance.as_ref().map(|i| i.component_id.as_str()) != Some(c.as_str()) {
        continue;
      }
    }
    if let Some(ids) = &style_ids {
      let linked = |s: &Option<String>| s.as_deref().is_some_and(|s| ids.contains(&s));
      if !(linked(&n.fill_style) || linked(&n.text_style) || linked(&n.stroke_style) || linked(&n.effect_style) || linked(&n.grid_style)) {
        continue;
      }
    }
    total += 1;
    if out.len() < limit {
      let mut m = json!({
        "id": n.id, "type": n.kind, "name": n.name, "parentId": n.parent, "page": n.page,
        "w": round(n.width), "h": round(n.height),
      });
      if let Some(t) = &n.text {
        m["text"] = json!(t.characters.chars().take(80).collect::<String>());
      }
      if let Some(i) = &n.instance {
        m["componentId"] = json!(i.component_id);
      }
      out.push(m);
    }
  }
  Ok(json!({ "total": total, "nodes": out }))
}

/// What `find_nodes` `type` can select.
enum FindType {
  Kind(NodeType),
  /// A rectangle painted with an image.
  Image,
}

impl FindType {
  fn matches(&self, n: &Node) -> bool {
    match self {
      FindType::Kind(k) => n.kind == *k,
      FindType::Image => n.kind == NodeType::Rectangle && n.fills.iter().any(|p| matches!(p, Paint::Image { .. })),
    }
  }
}

fn find_type(cx: &Ctx, t: &str) -> Result<FindType, String> {
  Ok(match t.trim().to_lowercase().replace(['_', '-', ' '], "").as_str() {
    "frame" | "div" | "container" | "screen" => FindType::Kind(NodeType::Frame),
    "group" => FindType::Kind(NodeType::Group),
    "rectangle" | "rect" => FindType::Kind(NodeType::Rectangle),
    "ellipse" | "circle" => FindType::Kind(NodeType::Ellipse),
    "line" => FindType::Kind(NodeType::Line),
    "polygon" | "triangle" => FindType::Kind(NodeType::Polygon),
    "star" => FindType::Kind(NodeType::Star),
    "vector" | "icon" | "path" => FindType::Kind(NodeType::Vector),
    "text" => FindType::Kind(NodeType::Text),
    "component" => FindType::Kind(NodeType::Component),
    "componentset" => FindType::Kind(NodeType::ComponentSet),
    "instance" => FindType::Kind(NodeType::Instance),
    "image" => FindType::Image,
    _ => {
      return Err(cx.err(
        "type",
        format!("unknown layer type '{t}'; use frame, group, rectangle, ellipse, line, polygon, star, vector, text, component, component_set, instance or image"),
      ))
    }
  })
}

/// Cuts a very long text layer's characters (and the style runs past them) for the model.
fn cap_text(m: &mut Map<String, Value>) {
  let Some(Value::Object(t)) = m.get_mut("text") else { return };
  let len = t.get("characters").and_then(|c| c.as_str()).map(|c| c.chars().count()).unwrap_or(0);
  if len <= TEXT_CAP {
    return;
  }
  if let Some(Value::String(c)) = t.get_mut("characters") {
    *c = c.chars().take(TEXT_CAP).collect();
  }
  if let Some(Value::Array(runs)) = t.get_mut("runs") {
    runs.retain(|r| r.get("start").and_then(|s| s.as_u64()).is_some_and(|s| (s as usize) < TEXT_CAP));
    for r in runs.iter_mut() {
      if r.get("end").and_then(|e| e.as_u64()).is_some_and(|e| e as usize > TEXT_CAP) {
        r["end"] = json!(TEXT_CAP);
      }
    }
  }
  m.insert("textTruncated".into(), json!(true));
  m.insert("textLength".into(), json!(len));
}

/// Compact tree of the current page for the model. It lists layers breadth first until about
/// `OUTLINE_CAP`; a layer with children left out shows `childCount`, and `moreLayers` counts the
/// top-level layers left out. `truncated` says how to read the rest.
pub fn summary(e: &Engine, depth: usize) -> Value {
  let page = e.doc.page(&e.page);
  let roots = page.map(|p| p.children.clone()).unwrap_or_default();
  let (included, cut) = outline_plan(e, &roots, depth);
  let layers: Vec<Value> = roots
    .iter()
    .filter(|r| included.contains(r.as_str()))
    .map(|r| outline_in(e, r, depth, Some(&included)))
    .collect();
  let mut v = json!({
    "document": e.doc.name,
    "pages": e.doc.pages.iter().map(|p| json!({ "id": p.id, "name": p.name, "current": p.id == e.page, "layers": p.children.len() })).collect::<Vec<_>>(),
    "currentPage": e.page,
    "selection": e.selection.iter().filter_map(|s| e.doc.get(s)).map(|n| json!({ "id": n.id, "type": n.kind, "name": n.name })).collect::<Vec<_>>(),
    "layers": layers,
    "components": e.doc.components().iter().map(|c| component_summary(e, c)).collect::<Vec<_>>(),
    "colorStyles": e.doc.styles.colors,
    "textStyles": e.doc.styles.texts.iter().map(|t| json!({ "id": t.id, "name": t.name, "font": text_style_label(t) })).collect::<Vec<_>>(),
    "effectStyles": e.doc.styles.effects.iter().map(|s| json!({ "id": s.id, "name": s.name, "effects": s.effects.len() })).collect::<Vec<_>>(),
    "gridStyles": e.doc.styles.grids.iter().map(|s| json!({ "id": s.id, "name": s.name, "grids": s.grids.len() })).collect::<Vec<_>>(),
    "variables": crate::variables::summary(&e.doc),
    "openComments": e.doc.comments.values().filter(|c| !c.resolved).count(),
    "nextFreeX": roots.iter().map(|r| e.doc.abs_bounds(r).right()).fold(0.0, f64::max) + if roots.is_empty() { 0.0 } else { 100.0 },
  });
  if cut {
    let left_out = roots.len() - v["layers"].as_array().map_or(0, |l| l.len());
    if left_out > 0 {
      v["moreLayers"] = json!(left_out);
    }
    v["truncated"] = json!(format!(
      "the outline lists about {OUTLINE_CAP} layers, level by level; layers with children left out show childCount; use get_nodes or find_nodes for the rest"
    ));
  }
  v
}

/// "Inter 600 24/32" for a text style.
fn text_style_label(t: &TextStyle) -> String {
  match t.line_height {
    Some(l) => format!("{} {} {}/{}", t.font_family, t.font_weight, round(t.font_size), round(l)),
    None => format!("{} {} {}", t.font_family, t.font_weight, round(t.font_size)),
  }
}

/// The layers an outline lists: breadth first from the roots down to `depth`, until the cap.
/// Also whether anything was left out because of the cap.
fn outline_plan(e: &Engine, roots: &[NodeId], depth: usize) -> (HashSet<String>, bool) {
  let mut included = HashSet::new();
  let mut queue: VecDeque<(&str, usize)> = roots.iter().map(|r| (r.as_str(), 0)).collect();
  while let Some((id, d)) = queue.pop_front() {
    if included.len() >= OUTLINE_CAP {
      return (included, true);
    }
    included.insert(id.to_string());
    if d < depth {
      if let Some(n) = e.doc.get(id) {
        queue.extend(n.children.iter().map(|c| (c.as_str(), d + 1)));
      }
    }
  }
  (included, false)
}

fn component_summary(e: &Engine, c: &Node) -> Value {
  let mut m = json!({ "id": c.id, "name": c.name, "width": c.width, "height": c.height });
  let props = crate::props::props_of(&e.doc, &c.id);
  if !props.is_empty() {
    m["props"] = json!(props
      .iter()
      .map(|p| json!({ "id": p.id, "name": p.name, "kind": p.kind }))
      .collect::<Vec<_>>());
  }
  m
}

fn outline(e: &Engine, id: &str, depth: usize) -> Value {
  outline_in(e, id, depth, None)
}

/// A layer and its descendants down to `depth`; with `only`, just the layers in that set.
fn outline_in(e: &Engine, id: &str, depth: usize, only: Option<&HashSet<String>>) -> Value {
  let Some(n) = e.doc.get(id) else { return Value::Null };
  let mut m = Map::new();
  m.insert("id".into(), json!(n.id));
  m.insert("type".into(), json!(n.kind));
  m.insert("name".into(), json!(n.name));
  m.insert("x".into(), json!(round(n.x)));
  m.insert("y".into(), json!(round(n.y)));
  m.insert("w".into(), json!(round(n.width)));
  m.insert("h".into(), json!(round(n.height)));
  if !n.visible {
    m.insert("hidden".into(), json!(true));
  }
  if let Some(Paint::Solid { color, .. }) = n.fills.iter().find(|p| p.visible()) {
    m.insert("fill".into(), json!(color));
  }
  if let Some(t) = &n.text {
    let s: String = t.characters.chars().take(80).collect();
    m.insert("text".into(), json!(s));
    m.insert("font".into(), json!(format!("{} {} {}", t.font_family, t.font_weight, t.font_size)));
  }
  if let Some(l) = &n.layout {
    m.insert(
      "layout".into(),
      json!(format!(
        "{} gap {} pad {} {} {} {}",
        if l.direction == LayoutDirection::Horizontal {
          "row"
        } else {
          "column"
        },
        l.gap,
        l.padding_top,
        l.padding_right,
        l.padding_bottom,
        l.padding_left
      )),
    );
  }
  if let Some(d) = &n.device {
    m.insert("device".into(), json!(d.preset));
  }
  if let Some(i) = &n.instance {
    m.insert("componentId".into(), json!(i.component_id));
    if let Some(values) = crate::props::values_summary(&e.doc, n) {
      m.insert("props".into(), values);
    }
  }
  if !n.children.is_empty() {
    let shown: Vec<Value> = if depth > 0 {
      n.children
        .iter()
        .filter(|c| only.is_none_or(|o| o.contains(c.as_str())))
        .map(|c| match e.doc.get(c).and_then(|c| c.device_part.as_ref().map(|part| (c, part))) {
          // The system UI of a device frame: one line per part, not its layers.
          Some((part_node, part)) => json!({ "id": part_node.id, "name": part_node.name, "devicePart": part }),
          None => outline_in(e, c, depth - 1, only),
        })
        .collect()
    } else {
      Vec::new()
    };
    if !shown.is_empty() {
      m.insert("children".into(), json!(shown));
    }
    if shown.len() < n.children.len() {
      m.insert("childCount".into(), json!(n.children.len()));
    }
  }
  Value::Object(m)
}

fn round(v: f64) -> f64 {
  (v * 10.0).round() / 10.0
}

/// What `create_nodes` made.
pub struct Inserted {
  /// The top-level layers: id, name, type and size.
  pub created: Vec<Value>,
  /// Named layers below them, name → id (the first of a name wins), capped.
  pub names: Map<String, Value>,
  pub names_truncated: bool,
  pub warnings: Vec<String>,
}

impl Inserted {
  fn into_json(self) -> Value {
    let mut m = Map::new();
    if self.created.len() > CREATED_CAP {
      // A huge create: id and name only, so the answer stays small.
      let ids: Vec<Value> = self
        .created
        .iter()
        .take(CREATED_IDS_CAP)
        .map(|c| json!({ "id": c["id"], "name": c["name"] }))
        .collect();
      m.insert("createdCount".into(), json!(self.created.len()));
      m.insert("createdTruncated".into(), json!(true));
      m.insert("created".into(), json!(ids));
    } else {
      m.insert("created".into(), json!(self.created));
    }
    if !self.names.is_empty() {
      m.insert("names".into(), Value::Object(self.names));
    }
    if self.names_truncated {
      m.insert("namesTruncated".into(), json!(true));
    }
    if !self.warnings.is_empty() {
      m.insert("warnings".into(), json!(self.warnings));
    }
    Value::Object(m)
  }
}

/// Inserts specs under `parent` (or the page root). Returns the created top-level layers.
pub fn insert_specs(e: &mut Engine, specs: &[Value], parent: Option<&str>) -> Result<Vec<Value>, String> {
  insert_specs_ex(e, specs, parent).map(|r| r.created)
}

/// `insert_specs` with the named descendants and the warnings about the input.
pub fn insert_specs_ex(e: &mut Engine, specs: &[Value], parent: Option<&str>) -> Result<Inserted, String> {
  if let Some(p) = parent {
    let pn = e.doc.get(p).ok_or_else(|| format!("no parent layer {p}"))?;
    if !pn.kind.is_container() {
      return Err(format!("{p} is a {} and cannot have children", pn.kind.label()));
    }
    if crate::devices::in_part(&e.doc, p) {
      return Err(format!(
        "{p} is system UI of a device frame and cannot have children; use parentId {}",
        crate::devices::host_of(&e.doc, p)
      ));
    }
  }
  let page = parent
    .and_then(|p| e.doc.get(p))
    .map(|n| n.page.clone())
    .unwrap_or_else(|| e.page.clone());
  let mut cx = Ctx::new();
  let mut roots = Vec::new();
  for (i, spec) in specs.iter().enumerate() {
    let mark = cx.enter(&format!("nodes[{i}]"));
    roots.push(build(e, &mut cx, spec, parent, &page, 0)?);
    cx.leave(mark);
  }
  for r in &roots {
    settle_fill_in_hug(&mut e.doc, r);
  }
  crate::layout::relayout_all(&mut e.doc, e.measurer.as_ref());
  let mut left = CREATED_LISTED;
  let created = roots.iter().map(|r| brief(e, r, &mut left)).collect();
  let mut names = Map::new();
  let mut names_truncated = false;
  for (name, id) in std::mem::take(&mut cx.names) {
    if names.contains_key(&name) {
      continue;
    }
    if names.len() >= NAMES_CAP {
      names_truncated = true;
      break;
    }
    names.insert(name, json!(id));
  }
  Ok(Inserted {
    created,
    names,
    names_truncated,
    warnings: cx.into_warnings(),
  })
}

/// A few lines about a layer: id, name, type, size, and its children and theirs (id, name, type
/// each). `left` is what the whole answer may still list, so a big create stays small.
fn brief(e: &Engine, id: &str, left: &mut usize) -> Value {
  let Some(n) = e.doc.get(id) else { return Value::Null };
  let mut m = json!({ "id": n.id, "name": n.name, "type": n.kind, "w": round(n.width), "h": round(n.height) });
  if n.children.is_empty() {
    return m;
  }
  let mut kids: Vec<Value> = Vec::new();
  for c in n.children.iter().take(CHILDREN_CAP).filter_map(|c| e.doc.get(c)) {
    if *left == 0 {
      break;
    }
    *left -= 1;
    kids.push(json!({ "id": c.id, "name": c.name, "type": c.kind }));
  }
  // Grandchildren after the children, with whatever the answer has room for.
  for (kid, c) in kids.iter_mut().zip(n.children.iter()) {
    let Some(c) = e.doc.get(c) else { continue };
    if c.children.is_empty() {
      continue;
    }
    let mut grand: Vec<Value> = Vec::new();
    for g in c.children.iter().take(CHILDREN_CAP).filter_map(|g| e.doc.get(g)) {
      if *left == 0 {
        break;
      }
      *left -= 1;
      grand.push(json!({ "id": g.id, "name": g.name, "type": g.kind }));
    }
    if !grand.is_empty() {
      kid["children"] = json!(grand);
    }
    if grand_len(kid) < c.children.len() {
      kid["childCount"] = json!(c.children.len());
    }
  }
  m["children"] = json!(kids);
  m["childCount"] = json!(n.children.len());
  m
}

fn grand_len(v: &Value) -> usize {
  v["children"].as_array().map_or(0, |a| a.len())
}

/// A layer that fills the main axis of an auto layout frame that hugs on that axis has nothing
/// to fill: it hugs its content (auto layout frames, text) or keeps its size (anything else).
/// Applied to what a tool just created, top-down so chains of them settle. Parents with a min or
/// max on that axis (fill under a held-back hug frame is meaningful) and wrap parents are left
/// alone, as is fill on the cross axis.
fn settle_fill_in_hug(doc: &mut crate::model::Document, id: &str) {
  let Some(p) = doc.get(id) else { return };
  if p.kind == NodeType::Instance {
    return;
  }
  let children = p.children.clone();
  if let Some(al) = p.layout.as_ref() {
    let horizontal = al.direction == LayoutDirection::Horizontal;
    let (sizing, lo, hi) = if horizontal {
      (p.sizing_h, p.min_width, p.max_width)
    } else {
      (p.sizing_v, p.min_height, p.max_height)
    };
    if sizing == Sizing::Hug && lo.is_none() && hi.is_none() && !(al.wrap && horizontal) {
      for c in &children {
        let Some(cn) = doc.get_mut(c) else { continue };
        if cn.absolute_position {
          continue;
        }
        let hugs = (cn.kind.is_frame_like() && cn.layout.is_some()) || cn.kind == NodeType::Text;
        let s = if horizontal { &mut cn.sizing_h } else { &mut cn.sizing_v };
        if *s == Sizing::Fill {
          *s = if hugs { Sizing::Hug } else { Sizing::Fixed };
        }
      }
    }
  }
  for c in &children {
    settle_fill_in_hug(doc, c);
  }
}

fn build(e: &mut Engine, cx: &mut Ctx, spec: &Value, parent: Option<&str>, page: &str, depth: usize) -> Result<NodeId, String> {
  if !spec.is_object() {
    return Err(cx.err(
      "",
      format!(
        "must be a layer object like {{\"type\": \"frame\", \"name\": \"Card\", ...}}, got {}",
        parse::kind_of(spec)
      ),
    ));
  }
  let kind_str = match spec.get("type") {
    None | Some(Value::Null) => {
      cx.warn("missing type; created a frame");
      "frame".to_string()
    }
    Some(Value::String(t)) => t.trim().to_lowercase(),
    Some(other) => return Err(cx.err("type", format!("must be a string, got {}", parse::kind_of(other)))),
  };
  let svg_markup = spec.get("svg").and_then(|v| v.as_str());
  let id = if let Some(markup) = svg_markup {
    build_svg(e, cx, spec, markup, parent, page)?
  } else if kind_str == "instance" {
    let comp = spec
      .get("componentId")
      .and_then(|v| v.as_str())
      .ok_or_else(|| cx.err("componentId", "an instance needs a componentId"))?;
    let (x, y) = (
      parse::opt_number(cx, spec, "x")?.unwrap_or(0.0),
      parse::opt_number(cx, spec, "y")?.unwrap_or(0.0),
    );
    let id = crate::components::create_instance(&mut e.doc, comp, parent, page, x, y, &mut e.gen)
      .ok_or_else(|| cx.err("componentId", format!("{comp} is not a main component")))?;
    let mut n = e.doc.get(&id).cloned().unwrap();
    apply_spec(cx, &e.doc, &mut n, spec, true)?;
    let before = e.doc.get(&id).cloned().unwrap();
    let diff = diff_patch(&before, &n);
    *e.doc.get_mut(&id).unwrap() = n;
    crate::components::record_override(&mut e.doc, &id, &diff);
    id
  } else {
    let kind = parse_kind(cx, &kind_str)?;
    let name = spec
      .get("name")
      .and_then(|v| v.as_str())
      .map(String::from)
      .unwrap_or_else(|| e.doc.next_name(kind.label()));
    let mut n = ops::default_node(kind, e.gen.next("n_"), name);
    if kind == NodeType::Frame {
      // AI frames start transparent unless a fill is given; screens get white.
      if parent.is_some() {
        n.fills.clear();
      }
      n.clip_content = parent.is_none();
    }
    if kind == NodeType::Group {
      n.width = 1.0;
      n.height = 1.0;
    }
    apply_spec(cx, &e.doc, &mut n, spec, true)?;
    if kind_str == "image" && n.fills.is_empty() {
      n.fills = vec![Paint::solid("#E5E7EB")];
    }
    let id = n.id.clone();
    let index = parent.and_then(|p| crate::devices::before_chrome(&e.doc, p));
    e.doc.insert(n, parent, page, index);
    match spec.get("children") {
      None | Some(Value::Null) => {}
      // An empty list is fine on any layer (models often send `children: []` everywhere).
      Some(Value::Array(c)) if c.is_empty() => {}
      Some(Value::Array(children)) => {
        if !kind.is_container() {
          return Err(cx.err("children", format!("{} layers cannot have children; use a frame", kind.label())));
        }
        for (i, c) in children.iter().enumerate() {
          let mark = cx.enter(&format!("children[{i}]"));
          build(e, cx, c, Some(&id), page, depth + 1)?;
          cx.leave(mark);
        }
      }
      Some(other) => {
        return Err(cx.err(
          "children",
          format!("must be an array of layer objects, got {}", parse::kind_of(other)),
        ))
      }
    }
    if let Some(d) = spec.get("device").filter(|d| !d.is_null()) {
      let device = crate::devices::parse_spec(d, None).map_err(|m| cx.err("device", m))?;
      let sized = spec.get("width").is_some() || spec.get("height").is_some();
      crate::devices::apply(&mut e.doc, &mut e.gen, &id, device, !sized).map_err(|m| cx.err("device", m))?;
    }
    id
  };
  if depth > 0 {
    if let Some(name) = spec.get("name").and_then(|v| v.as_str()) {
      cx.names.push((name.to_string(), id.clone()));
    }
  }
  Ok(id)
}

/// `svg` on a layer spec: SVG markup read into a frame of editable layers (see `svg_import`).
fn build_svg(e: &mut Engine, cx: &mut Ctx, spec: &Value, markup: &str, parent: Option<&str>, page: &str) -> Result<NodeId, String> {
  let size = |k: &str| spec.get(k).and_then(|v| v.as_f64()).filter(|v| *v > 0.0);
  let opts = crate::svg_import::Options {
    name: spec.get("name").and_then(|v| v.as_str()).map(String::from),
    width: size("width"),
    height: size("height"),
  };
  let imported = crate::svg_import::import(markup, &mut e.gen, &opts).map_err(|reason| {
    let why = if reason == crate::svg_import::NOTHING_TO_DRAW {
      "this SVG has no shapes the importer can draw".to_string()
    } else {
      format!("this SVG uses {reason}")
    };
    cx.err(
      "svg",
      format!("can't be imported as vectors: {why}. Use svgPath for path data, or build the layers directly"),
    )
  })?;
  for w in &imported.warnings {
    cx.warn(format!("svg: {w}"));
  }
  const USED: [&str; 9] = ["type", "svg", "name", "x", "y", "width", "height", "opacity", "rotation"];
  let ignored: Vec<&str> = spec
    .as_object()
    .map(|o| o.keys().map(String::as_str).filter(|k| !USED.contains(k)).collect())
    .unwrap_or_default();
  if !ignored.is_empty() {
    cx.warn(format!(
      "svg: {} ignored on an svg layer; style the layers inside it with update_nodes",
      ignored.join(", ")
    ));
  }
  let mut nodes = imported.nodes.into_iter();
  let mut root = nodes.next().ok_or_else(|| cx.err("svg", "nothing to import"))?;
  root.x = parse::opt_number(cx, spec, "x")?.unwrap_or(0.0);
  root.y = parse::opt_number(cx, spec, "y")?.unwrap_or(0.0);
  if let Some(o) = parse::opt_number(cx, spec, "opacity")? {
    root.opacity = o.clamp(0.0, 1.0);
  }
  if let Some(r) = parse::opt_number(cx, spec, "rotation")? {
    root.rotation = r;
  }
  if opts.name.is_none() {
    root.name = e.doc.next_name("SVG");
  }
  let id = root.id.clone();
  let index = parent.and_then(|p| crate::devices::before_chrome(&e.doc, p));
  e.doc.insert(root, parent, page, index);
  for mut n in nodes {
    n.page = page.to_string();
    e.doc.nodes.insert(n.id.clone(), Arc::new(n));
  }
  Ok(id)
}

fn parse_kind(cx: &Ctx, s: &str) -> Result<NodeType, String> {
  Ok(match s {
    "frame" | "div" | "container" | "screen" => NodeType::Frame,
    "rectangle" | "rect" | "image" => NodeType::Rectangle,
    "ellipse" | "circle" => NodeType::Ellipse,
    "text" => NodeType::Text,
    "line" => NodeType::Line,
    "polygon" | "triangle" => NodeType::Polygon,
    "star" => NodeType::Star,
    "vector" | "icon" | "path" => NodeType::Vector,
    "group" => NodeType::Group,
    "component" => NodeType::Component,
    other => {
      return Err(cx.err(
        "type",
        format!(
          "unknown layer type '{other}'; use frame, rectangle, ellipse, text, line, polygon, star, vector, group, image, instance or component"
        ),
      ))
    }
  })
}

/// Applies friendly spec properties onto a node. `doc` is read for variables and styles.
pub fn apply_spec(cx: &mut Ctx, doc: &Document, n: &mut Node, s: &Value, creating: bool) -> Result<(), String> {
  let mapped = parse::desugar(cx, s, n.kind);
  let s = mapped.as_ref().unwrap_or(s);
  if let Some(v) = s.get("name").and_then(|v| v.as_str()) {
    n.name = v.to_string();
  }
  if let Some(v) = parse::opt_number(cx, s, "x")? {
    n.x = v;
  }
  if let Some(v) = parse::opt_number(cx, s, "y")? {
    n.y = v;
  }
  let dim_w = parse::dimension(cx, "width", s.get("width"))?;
  let dim_h = parse::dimension(cx, "height", s.get("height"))?;
  apply_dimension(n, dim_w, true);
  apply_dimension(n, dim_h, false);
  if let Some(v) = parse::opt_number(cx, s, "rotation")? {
    n.rotation = v;
  }
  if let Some(v) = parse::opt_number(cx, s, "opacity")? {
    // 0 to 1; a whole number from 2 up to 100 is most likely a percentage.
    let o = if (2.0..=100.0).contains(&v) {
      cx.warn(format!("opacity {v} read as {v}%; opacity is 0 to 1"));
      v / 100.0
    } else {
      if !(0.0..=1.0).contains(&v) {
        cx.warn(format!("opacity {v} is outside 0 to 1; clamped"));
      }
      v
    };
    n.opacity = o.clamp(0.0, 1.0);
  }
  if let Some(v) = parse::opt_bool(cx, s, "visible")? {
    n.visible = v;
  }
  if let Some(v) = parse::opt_bool(cx, s, "locked")? {
    n.locked = v;
  }
  if let Some(v) = parse::opt_bool(cx, s, "clip")? {
    n.clip_content = v;
  }
  if let Some(v) = s.get("overflow").filter(|v| !v.is_null()) {
    n.overflow = parse::choice(
      cx,
      "overflow",
      v,
      &[
        (&["none"], Overflow::None),
        (&["horizontal"], Overflow::Horizontal),
        (&["vertical"], Overflow::Vertical),
        (&["both"], Overflow::Both),
      ],
      &parse::no_hint,
    )?;
  }
  if let Some(v) = s.get("scrollBehavior").filter(|v| !v.is_null()) {
    if v.as_str().is_some_and(|t| t.trim().eq_ignore_ascii_case("sticky")) {
      cx.warn(
        "scrollBehavior \"sticky\" is not supported; the layer keeps its current behaviour (use \"fixed\" to keep it in place)".to_string(),
      );
    } else {
      n.scroll_behavior = parse::choice(
        cx,
        "scrollBehavior",
        v,
        &[(&["scroll"], ScrollBehavior::Scroll), (&["fixed"], ScrollBehavior::Fixed)],
        &parse::no_hint,
      )?;
    }
  }
  if let Some(v) = parse::opt_bool(cx, s, "absolute")? {
    n.absolute_position = v;
  }
  for (key, slot) in [
    ("minWidth", &mut n.min_width),
    ("maxWidth", &mut n.max_width),
    ("minHeight", &mut n.min_height),
    ("maxHeight", &mut n.max_height),
  ] {
    if s.get(key).is_some() {
      *slot = parse::opt_number(cx, s, key)?.filter(|v| *v > 0.0);
    }
  }
  match s.get("bind") {
    None | Some(Value::Null) => {}
    Some(Value::Object(b)) => {
      for (prop, var) in b {
        match var {
          Value::Null => {
            n.bindings.remove(prop);
          }
          Value::String(name) => {
            check_binding(cx, doc, prop, name)?;
            n.bindings.insert(prop.clone(), name.clone());
          }
          other => {
            return Err(cx.err(
              &format!("bind.{prop}"),
              format!("must be a variable name or null, got {}", parse::kind_of(other)),
            ))
          }
        }
      }
    }
    Some(other) => {
      return Err(cx.err(
        "bind",
        format!("must be an object like {{fill: 'Theme/Surface'}}, got {}", parse::kind_of(other)),
      ))
    }
  }
  match s.get("variableModes") {
    None | Some(Value::Null) => {}
    Some(Value::Object(m)) => {
      for (coll, mode) in m {
        match mode {
          Value::Null => {
            n.variable_modes.remove(coll);
            if let Some(c) = doc.variables.iter().find(|c| c.id == *coll || c.name == *coll) {
              n.variable_modes.remove(&c.id);
              n.variable_modes.remove(&c.name);
            }
          }
          Value::String(name) => {
            // Stored by id, replacing a pin under either key: a name key next to the id key of
            // the same collection would otherwise lose to the older pin.
            let (cid, mid) = check_mode(cx, doc, coll, name)?;
            n.variable_modes.remove(coll);
            n.variable_modes.remove(&cid);
            n.variable_modes.insert(cid, mid);
          }
          other => {
            return Err(cx.err(
              &format!("variableModes.{coll}"),
              format!("must be a mode name or null, got {}", parse::kind_of(other)),
            ))
          }
        }
      }
    }
    Some(other) => {
      return Err(cx.err(
        "variableModes",
        format!("must be an object like {{Theme: 'Dark'}}, got {}", parse::kind_of(other)),
      ))
    }
  }
  if let Some(v) = s.get("layoutGrids") {
    n.layout_grids = serde_json::from_value(v.clone()).map_err(|e| cx.err("layoutGrids", e))?;
  }
  if let Some(v) = s.get("notes").and_then(|v| v.as_str()) {
    n.notes = v.to_string();
  }
  let text_kind = n.kind == NodeType::Text;
  // Text colour goes to fills on text layers.
  let fill_key = if text_kind && s.get("color").is_some() {
    Some("color")
  } else if s.get("fill").is_some() {
    Some("fill")
  } else if s.get("background").is_some() {
    Some("background")
  } else {
    None
  };
  if let Some(key) = fill_key {
    n.fills = parse_fills(&s[key]).map_err(|e| cx.err(key, e))?;
  }
  if let Some(f) = s.get("fills") {
    n.fills = parse_fills(f).map_err(|e| cx.err("fills", e))?;
  }
  if let Some(url) = s.get("imageUrl").or(s.get("src")).and_then(|v| v.as_str()) {
    parse::image_url(cx, if s.get("imageUrl").is_some() { "imageUrl" } else { "src" }, url)?;
    n.fills = vec![Paint::Image {
      credit: None,
      src: url.to_string(),
      scale_mode: ScaleMode::Fill,
      opacity: 1.0,
      visible: true,
      crop: None,
    }];
  }
  match s.get("fillStyle") {
    None => {}
    Some(Value::Null) => n.fill_style = None,
    Some(Value::String(name)) => {
      let st = find_color_style(cx, doc, "fillStyle", name)?;
      n.fills = vec![Paint::solid(&st.color)];
      n.fill_style = Some(st.id.clone());
    }
    Some(other) => {
      return Err(cx.err(
        "fillStyle",
        format!("must be a colour style name or null, got {}", parse::kind_of(other)),
      ))
    }
  }
  let mut stroked = false;
  if let Some(st) = s.get("stroke") {
    n.strokes = parse_fills(st).map_err(|e| cx.err("stroke", e))?;
    stroked = true;
  }
  match s.get("strokeStyle") {
    None => {}
    Some(Value::Null) => n.stroke_style = None,
    Some(Value::String(name)) => {
      let st = find_color_style(cx, doc, "strokeStyle", name)?;
      n.strokes = vec![Paint::solid(&st.color)];
      n.stroke_style = Some(st.id.clone());
      stroked = true;
    }
    Some(other) => return Err(cx.err("strokeStyle", format!("must be a colour style name, got {}", parse::kind_of(other)))),
  }
  if stroked && creating && s.get("strokeWidth").is_none() && n.stroke_weight == 0.0 {
    n.stroke_weight = 1.0;
  }
  if let Some(v) = parse::opt_number(cx, s, "strokeWidth")? {
    n.stroke_weight = v;
  }
  if let Some(v) = s.get("strokeAlign").filter(|v| !v.is_null()) {
    n.stroke_align = parse::choice(
      cx,
      "strokeAlign",
      v,
      &[
        (&["inside"], StrokeAlign::Inside),
        (&["center", "middle", "centre"], StrokeAlign::Center),
        (&["outside"], StrokeAlign::Outside),
      ],
      &parse::no_hint,
    )?;
  }
  match s.get("strokeDash") {
    None | Some(Value::Null) => {}
    Some(Value::Array(arr)) => {
      n.stroke_dash = arr.iter().map(|v| parse::number(cx, "strokeDash", v)).collect::<Result<_, _>>()?;
    }
    Some(other) => {
      return Err(cx.err(
        "strokeDash",
        format!("must be an array of numbers like [4, 2], got {}", parse::kind_of(other)),
      ))
    }
  }
  match s.get("strokeWeights") {
    None => {}
    Some(Value::Null) => n.stroke_weights = None,
    Some(v) => n.stroke_weights = Some(parse_stroke_weights(cx, v)?),
  }
  match s.get("strokeJoin") {
    None => {}
    Some(Value::Null) => n.stroke_join = None,
    Some(v) => {
      n.stroke_join = Some(parse::choice(
        cx,
        "strokeJoin",
        v,
        &[
          (&["miter"], StrokeJoin::Miter),
          (&["bevel"], StrokeJoin::Bevel),
          (&["round"], StrokeJoin::Round),
        ],
        &parse::no_hint,
      )?)
    }
  }
  if let Some(v) = s.get("cornerRadius").filter(|v| !v.is_null()) {
    match parse::radius(cx, "cornerRadius", v)? {
      Radius::All(r) => {
        n.corner_radius = r;
        n.corner_radii = None;
      }
      Radius::Each(r) => n.corner_radii = Some(r),
    }
  }
  if let Some(sh) = s.get("shadow") {
    let effects = parse_shadows(cx, sh)?;
    n.effects
      .retain(|e| !matches!(e.kind, EffectType::DropShadow | EffectType::InnerShadow));
    n.effects.extend(effects);
  }
  if let Some(b) = parse::opt_number(cx, s, "blur")? {
    n.effects.retain(|e| e.kind != EffectType::LayerBlur);
    if b > 0.0 {
      n.effects.push(Effect {
        kind: EffectType::LayerBlur,
        blur: b,
        ..Default::default()
      });
    }
  }
  if let Some(b) = parse::opt_number(cx, s, "backgroundBlur")? {
    n.effects.retain(|e| e.kind != EffectType::BackgroundBlur);
    if b > 0.0 {
      n.effects.push(Effect {
        kind: EffectType::BackgroundBlur,
        blur: b,
        ..Default::default()
      });
    }
  }
  // Effect and grid styles come after the explicit effects, so the named style wins.
  match s.get("effectStyle") {
    None => {}
    Some(Value::Null) => n.effect_style = None,
    Some(Value::String(name)) => {
      let st = find_effect_style(cx, doc, "effectStyle", name)?;
      n.effects = st.effects.clone();
      n.effect_style = Some(st.id.clone());
    }
    Some(other) => {
      return Err(cx.err(
        "effectStyle",
        format!("must be an effect style name or null, got {}", parse::kind_of(other)),
      ))
    }
  }
  match s.get("gridStyle") {
    None => {}
    Some(Value::Null) => n.grid_style = None,
    Some(Value::String(name)) => {
      let st = find_grid_style(cx, doc, "gridStyle", name)?;
      n.layout_grids = st.grids.clone();
      n.grid_style = Some(st.id.clone());
    }
    Some(other) => {
      return Err(cx.err(
        "gridStyle",
        format!("must be a grid style name or null, got {}", parse::kind_of(other)),
      ))
    }
  }
  apply_layout(cx, n, s, dim_w.is_some(), dim_h.is_some(), creating)?;
  if text_kind {
    apply_text(cx, doc, n, s, creating, dim_w)?;
  }
  if let Some(d) = s.get("svgPath").and_then(|v| v.as_str()) {
    let vb = s
      .get("viewBox")
      .and_then(|v| v.as_array())
      .map(|a| a.iter().map(|x| x.as_f64().unwrap_or(0.0)).collect::<Vec<_>>())
      .filter(|a| a.len() == 4)
      .unwrap_or(vec![0.0, 0.0, 24.0, 24.0]);
    n.vector = Some(VectorData {
      subpaths: vec![],
      raw: Some(RawPath {
        d: d.to_string(),
        view_box: [vb[0], vb[1], vb[2], vb[3]],
        fill_rule: String::new(),
      }),
    });
    if creating {
      if s.get("width").is_none() {
        n.width = 24.0;
      }
      if s.get("height").is_none() {
        n.height = 24.0;
      }
      if s.get("fill").is_none() && s.get("stroke").is_none() {
        n.fills = vec![Paint::solid("#111827")];
        n.strokes.clear();
      } else if s.get("stroke").is_none() {
        n.strokes.clear();
      }
    }
  }
  if let Some(pts) = s.get("points").and_then(|v| v.as_array()) {
    let points: Vec<VectorPoint> = pts
      .iter()
      .filter_map(|p| p.as_array())
      .filter(|p| p.len() >= 2)
      .map(|p| VectorPoint::at(p[0].as_f64().unwrap_or(0.0), p[1].as_f64().unwrap_or(0.0)))
      .collect();
    let closed = s.get("closed").and_then(|v| v.as_bool()).unwrap_or(false);
    if let Some((x0, y0, x1, y1)) = crate::shapes::subpaths_bounds(&[SubPath {
      points: points.clone(),
      closed,
    }]) {
      if creating && s.get("width").is_none() {
        n.width = (x1 - x0).max(1.0);
        n.height = (y1 - y0).max(1.0);
      }
      let pts = points.into_iter().map(|p| VectorPoint::at(p.x - x0, p.y - y0)).collect();
      n.vector = Some(VectorData {
        subpaths: vec![SubPath { points: pts, closed }],
        raw: None,
      });
    }
  }
  if let Some(v) = parse::opt_number(cx, s, "pointCount")? {
    n.shape.get_or_insert_with(Default::default).point_count = v as u32;
  }
  Ok(())
}

/// The `layout` object: direction, gap, padding and alignment of an auto layout frame.
fn apply_layout(cx: &mut Ctx, n: &mut Node, s: &Value, sized_w: bool, sized_h: bool, creating: bool) -> Result<(), String> {
  let l = match s.get("layout") {
    None => return Ok(()),
    Some(Value::Null) | Some(Value::Bool(false)) => {
      n.layout = None;
      return Ok(());
    }
    Some(Value::Bool(true)) => json!({}),
    // "row" / "column" as shorthand for the direction.
    Some(Value::String(d)) => json!({ "direction": d }),
    Some(o @ Value::Object(_)) => o.clone(),
    Some(other) => {
      return Err(cx.err(
        "layout",
        format!(
          "must be an object like {{direction, gap, padding, align, crossAlign}}, got {}",
          parse::kind_of(other)
        ),
      ))
    }
  };
  let mark = cx.enter("layout");
  for k in l.as_object().into_iter().flat_map(|o| o.keys()) {
    if !parse::LAYOUT_OBJECT_KEYS.contains(&k.as_str()) {
      cx.warn(format!(
        "unknown key '{k}' ignored (layout takes direction, gap, counterGap, padding, align, crossAlign, wrap)"
      ));
    }
  }
  let mut al = n.layout.clone().unwrap_or(AutoLayout {
    gap: 0.0,
    padding_top: 0.0,
    padding_right: 0.0,
    padding_bottom: 0.0,
    padding_left: 0.0,
    ..Default::default()
  });
  if let Some(d) = l.get("direction").filter(|v| !v.is_null()) {
    al.direction = parse::choice(
      cx,
      "direction",
      d,
      &[
        (&["horizontal", "row", "x", "h", "horiz"], LayoutDirection::Horizontal),
        (&["vertical", "column", "col", "y", "v"], LayoutDirection::Vertical),
      ],
      &parse::no_hint,
    )?;
  }
  if let Some(g) = parse::opt_number(cx, &l, "gap")? {
    al.gap = g;
    al.counter_gap = g;
  }
  if let Some(g) = parse::opt_number(cx, &l, "counterGap")? {
    al.counter_gap = g;
  }
  if let Some(p) = l.get("padding").filter(|v| !v.is_null()) {
    let [t, r, b, lft] = parse::padding(cx, "padding", p)?;
    al.padding_top = t;
    al.padding_right = r;
    al.padding_bottom = b;
    al.padding_left = lft;
  }
  if let Some((key, a)) = ["align", "justify", "justifyContent"]
    .iter()
    .find_map(|k| l.get(*k).filter(|v| !v.is_null()).map(|v| (*k, v)))
  {
    al.primary_align = parse::choice(
      cx,
      key,
      a,
      &[
        (&["start", "flex-start", "left", "top", "begin"], Align::Start),
        (&["center", "middle", "centre"], Align::Center),
        (&["end", "flex-end", "right", "bottom"], Align::End),
        (&["space-between", "between"], Align::SpaceBetween),
      ],
      &align_hint,
    )?;
  }
  if let Some((key, a)) = ["crossAlign", "alignItems"]
    .iter()
    .find_map(|k| l.get(*k).filter(|v| !v.is_null()).map(|v| (*k, v)))
  {
    al.counter_align = parse::choice(
      cx,
      key,
      a,
      &[
        (&["start", "flex-start", "left", "top", "begin"], Align::Start),
        (&["center", "middle", "centre"], Align::Center),
        (&["end", "flex-end", "right", "bottom"], Align::End),
        (&["baseline"], Align::Baseline),
      ],
      &align_hint,
    )?;
  }
  if let Some(w) = parse::opt_bool(cx, &l, "wrap")? {
    al.wrap = w;
  }
  cx.leave(mark);
  let fresh = n.layout.is_none();
  n.layout = Some(al);
  if fresh && creating {
    if !sized_w {
      n.sizing_h = Sizing::Hug;
    }
    if !sized_h {
      n.sizing_v = Sizing::Hug;
    }
  }
  Ok(())
}

/// Advice for alignment values other tools use that the layout engine doesn't have.
fn align_hint(v: &str) -> Option<String> {
  match v {
    "stretch" => Some("to stretch children, set their width/height to 'fill' instead".into()),
    "space-around" | "space-evenly" => Some("only space-between spreads children; otherwise use gap and padding".into()),
    _ => None,
  }
}

/// Text properties: a linked style first, so explicit properties in the same spec win.
fn apply_text(cx: &mut Ctx, doc: &Document, n: &mut Node, s: &Value, creating: bool, dim_w: Option<Dim>) -> Result<(), String> {
  match s.get("textStyle") {
    None => {}
    Some(Value::Null) => n.text_style = None,
    Some(Value::String(name)) => {
      let st = find_text_style(cx, doc, "textStyle", name)?;
      let t = n.text.get_or_insert_with(Default::default);
      t.font_family = st.font_family.clone();
      t.font_size = st.font_size;
      t.font_weight = st.font_weight;
      t.line_height = st.line_height;
      t.letter_spacing = st.letter_spacing;
      n.text_style = Some(st.id.clone());
    }
    Some(other) => {
      return Err(cx.err(
        "textStyle",
        format!("must be a text style name or null, got {}", parse::kind_of(other)),
      ))
    }
  }
  let t = n.text.get_or_insert_with(Default::default);
  if let Some(v) = s.get("text").or(s.get("characters")).filter(|v| !v.is_null()) {
    let key = if s.get("text").is_some() { "text" } else { "characters" };
    t.characters = parse::string(cx, key, v)?;
    if creating && s.get("name").is_none() {
      n.name = t.characters.chars().take(40).collect();
    }
  }
  if let Some(spans) = s.get("spans").filter(|v| !v.is_null()) {
    let spans = spans
      .as_array()
      .ok_or_else(|| cx.err("spans", format!("must be an array of {{text, ...}}, got {}", parse::kind_of(spans))))?;
    let layer_size = parse::opt_number(cx, s, "fontSize")?.unwrap_or_else(|| n.text.as_ref().map_or(16.0, |t| t.font_size));
    let (characters, runs) = spans_to_runs(cx, spans, layer_size)?;
    if creating && s.get("name").is_none() {
      n.name = characters.chars().take(40).collect();
    }
    let t = n.text.as_mut().unwrap();
    t.characters = characters;
    t.runs = runs;
  }
  let t = n.text.as_mut().unwrap();
  if let Some(v) = parse::opt_number(cx, s, "fontSize")? {
    t.font_size = v;
  }
  if let Some(v) = s.get("fontWeight").filter(|v| !v.is_null()) {
    t.font_weight = parse::font_weight(cx, "fontWeight", v)?;
  }
  if let Some(v) = s.get("fontFamily").and_then(|v| v.as_str()) {
    t.font_family = v.to_string();
  }
  if let Some(v) = s.get("lineHeight").filter(|v| !v.is_null()) {
    t.line_height = parse::line_height(cx, "lineHeight", v, t.font_size)?;
  }
  if let Some(v) = s.get("letterSpacing").filter(|v| !v.is_null()) {
    t.letter_spacing = parse::letter_spacing(cx, "letterSpacing", v, t.font_size)?;
  }
  if let Some(v) = parse::opt_bool(cx, s, "italic")? {
    t.italic = v;
  }
  if let Some(v) = s.get("textAlign").filter(|v| !v.is_null()) {
    t.align_h = parse::choice(
      cx,
      "textAlign",
      v,
      &[
        (&["left", "start"], TextAlignH::Left),
        (&["center", "centre", "middle"], TextAlignH::Center),
        (&["right", "end"], TextAlignH::Right),
        (&["justify", "justified"], TextAlignH::Justify),
      ],
      &parse::no_hint,
    )?;
  }
  if let Some(v) = s.get("verticalAlign").filter(|v| !v.is_null()) {
    t.align_v = parse::choice(
      cx,
      "verticalAlign",
      v,
      &[
        (&["top", "start"], TextAlignV::Top),
        (&["middle", "center", "centre"], TextAlignV::Middle),
        (&["bottom", "end"], TextAlignV::Bottom),
      ],
      &parse::no_hint,
    )?;
  }
  if let Some(v) = s.get("textCase").filter(|v| !v.is_null()) {
    t.case = parse::choice(
      cx,
      "textCase",
      v,
      &[
        (&["original", "none", "normal"], TextCase::Original),
        (&["upper", "uppercase"], TextCase::Upper),
        (&["lower", "lowercase"], TextCase::Lower),
        (&["title", "capitalize"], TextCase::Title),
      ],
      &parse::no_hint,
    )?;
  }
  if let Some(v) = s.get("decoration").filter(|v| !v.is_null()) {
    t.decoration = parse_decoration(cx, "decoration", v)?;
  }
  if matches!(dim_w, Some(Dim::Px(_)) | Some(Dim::Fill)) {
    t.auto_resize = TextAutoResize::Height;
  }
  if let Some(v) = s.get("autoResize").filter(|v| !v.is_null()) {
    t.auto_resize = parse::choice(
      cx,
      "autoResize",
      v,
      &[
        (&["none", "fixed"], TextAutoResize::None),
        (&["height"], TextAutoResize::Height),
        (&["width", "auto", "hug", "width-and-height"], TextAutoResize::Width),
      ],
      &parse::no_hint,
    )?;
  }
  if s.get("maxLines").is_some() {
    t.max_lines = parse::opt_number(cx, s, "maxLines")?.filter(|v| *v >= 1.0).map(|v| v as u32);
  }
  if let Some(v) = parse::opt_bool(cx, s, "truncate")? {
    t.truncate = v;
  }
  if let Some(v) = parse::opt_number(cx, s, "paragraphSpacing")? {
    t.paragraph_spacing = v.max(0.0);
  }
  Ok(())
}

fn parse_decoration(cx: &Ctx, key: &str, v: &Value) -> Result<TextDecoration, String> {
  parse::choice(
    cx,
    key,
    v,
    &[
      (&["none"], TextDecoration::None),
      (&["underline"], TextDecoration::Underline),
      (&["strikethrough", "line-through", "strike"], TextDecoration::Strikethrough),
    ],
    &parse::no_hint,
  )
}

/// A binding must name an existing variable of the kind the property takes.
fn check_binding(cx: &mut Ctx, doc: &Document, prop: &str, name: &str) -> Result<(), String> {
  let key = format!("bind.{prop}");
  let kind = crate::variables::property_kind(prop).ok_or_else(|| {
    let props: Vec<&str> = crate::variables::PROPERTIES.iter().map(|(p, _)| *p).collect();
    cx.err(&key, format!("{prop} can't be bound to a variable; bindable: {}", props.join(", ")))
  })?;
  match crate::variables::find(doc, name) {
    Some((_, v)) if v.kind == kind => {
      if !crate::variables::in_scope(v, prop) {
        cx.warn(format!(
          "variable '{name}' is scoped to {} and isn't offered for {prop} in the editor; bound anyway",
          v.scopes.join(", ")
        ));
      }
      Ok(())
    }
    Some((_, v)) => Err(cx.err(
      &key,
      format!(
        "variable '{name}' is a {} variable but {prop} needs a {} one",
        format!("{:?}", v.kind).to_lowercase(),
        format!("{kind:?}").to_lowercase()
      ),
    )),
    None => {
      let all: Vec<String> = doc
        .variables
        .iter()
        .flat_map(|c| {
          c.variables
            .iter()
            .filter(|v| v.kind == kind)
            .map(|v| format!("{}/{}", c.name, v.name))
        })
        .collect();
      let hint = if doc.variables.is_empty() {
        "no variables exist yet; create them with define_variables first".to_string()
      } else {
        format!(
          "{} variables: {}",
          format!("{kind:?}").to_lowercase(),
          parse::listed(&parse::closest(name, &all, 5), "none")
        )
      };
      Err(cx.err(&key, format!("no variable '{name}'. {hint}")))
    }
  }
}

/// A frame's mode override must name an existing collection and one of its modes.
/// Returns the collection and mode ids.
fn check_mode(cx: &Ctx, doc: &Document, coll: &str, mode: &str) -> Result<(String, String), String> {
  let key = format!("variableModes.{coll}");
  let Some(c) = doc.variables.iter().find(|c| c.id == coll || c.name == coll) else {
    let names: Vec<String> = doc.variables.iter().map(|c| c.name.clone()).collect();
    return Err(cx.err(
      &key,
      format!(
        "no variable collection '{coll}'. Collections: {}",
        parse::listed(&parse::closest(coll, &names, 5), "none; create one with define_variables")
      ),
    ));
  };
  if let Some(m) = c.modes.iter().find(|m| m.id == mode || m.name == mode) {
    return Ok((c.id.clone(), m.id.clone()));
  }
  let modes: Vec<String> = c.modes.iter().map(|m| m.name.clone()).collect();
  Err(cx.err(
    &key,
    format!("collection '{}' has no mode '{mode}'. Modes: {}", c.name, modes.join(", ")),
  ))
}

/// A colour style by id, name or name ignoring case.
fn find_color_style<'a>(cx: &Ctx, doc: &'a Document, key: &str, name: &str) -> Result<&'a ColorStyle, String> {
  let all = &doc.styles.colors;
  all
    .iter()
    .find(|s| s.id == name)
    .or_else(|| all.iter().find(|s| s.name == name))
    .or_else(|| all.iter().find(|s| s.name.eq_ignore_ascii_case(name)))
    .ok_or_else(|| {
      let names: Vec<String> = all.iter().map(|s| s.name.clone()).collect();
      cx.err(
        key,
        format!(
          "no colour style '{name}'. Colour styles: {} (define_styles creates them)",
          parse::listed(&parse::closest(name, &names, 8), "none")
        ),
      )
    })
}

fn find_effect_style<'a>(cx: &Ctx, doc: &'a Document, key: &str, name: &str) -> Result<&'a EffectStyle, String> {
  let all = &doc.styles.effects;
  all
    .iter()
    .find(|s| s.id == name)
    .or_else(|| all.iter().find(|s| s.name == name))
    .or_else(|| all.iter().find(|s| s.name.eq_ignore_ascii_case(name)))
    .ok_or_else(|| {
      let names: Vec<String> = all.iter().map(|s| s.name.clone()).collect();
      cx.err(
        key,
        format!(
          "no effect style '{name}'. Effect styles: {} (define_styles creates them)",
          parse::listed(&parse::closest(name, &names, 8), "none")
        ),
      )
    })
}

fn find_grid_style<'a>(cx: &Ctx, doc: &'a Document, key: &str, name: &str) -> Result<&'a GridStyle, String> {
  let all = &doc.styles.grids;
  all
    .iter()
    .find(|s| s.id == name)
    .or_else(|| all.iter().find(|s| s.name == name))
    .or_else(|| all.iter().find(|s| s.name.eq_ignore_ascii_case(name)))
    .ok_or_else(|| {
      let names: Vec<String> = all.iter().map(|s| s.name.clone()).collect();
      cx.err(
        key,
        format!(
          "no grid style '{name}'. Grid styles: {} (define_styles creates them)",
          parse::listed(&parse::closest(name, &names, 8), "none")
        ),
      )
    })
}

fn find_text_style<'a>(cx: &Ctx, doc: &'a Document, key: &str, name: &str) -> Result<&'a TextStyle, String> {
  let all = &doc.styles.texts;
  all
    .iter()
    .find(|s| s.id == name)
    .or_else(|| all.iter().find(|s| s.name == name))
    .or_else(|| all.iter().find(|s| s.name.eq_ignore_ascii_case(name)))
    .ok_or_else(|| {
      let names: Vec<String> = all.iter().map(|s| s.name.clone()).collect();
      cx.err(
        key,
        format!(
          "no text style '{name}'. Text styles: {} (define_styles creates them)",
          parse::listed(&parse::closest(name, &names, 8), "none")
        ),
      )
    })
}

/// `[{text, fontWeight, ...}]` to characters plus style runs.
fn spans_to_runs(cx: &mut Ctx, spans: &[Value], layer_size: f64) -> Result<(String, Vec<crate::model::TextRun>), String> {
  let mut text = String::new();
  let mut runs = Vec::new();
  for (i, sp) in spans.iter().enumerate() {
    let mark = cx.enter(&format!("spans[{i}]"));
    if !sp.is_object() {
      return Err(cx.err("", format!("must be an object {{text, ...}}, got {}", parse::kind_of(sp))));
    }
    let piece = match sp.get("text").filter(|v| !v.is_null()) {
      Some(v) => parse::string(cx, "text", v)?,
      None => String::new(),
    };
    let start = text.chars().count();
    text.push_str(&piece);
    let end = text.chars().count();
    let decoration = match sp.get("decoration").filter(|v| !v.is_null()) {
      Some(d) => Some(parse_decoration(cx, "decoration", d)?),
      None => None,
    };
    let font_size = parse::opt_number(cx, sp, "fontSize")?;
    let letter_spacing = match sp.get("letterSpacing").filter(|v| !v.is_null()) {
      Some(l) => Some(parse::letter_spacing(cx, "letterSpacing", l, font_size.unwrap_or(layer_size))?),
      None => None,
    };
    runs.push(crate::model::TextRun {
      start,
      end,
      font_family: sp.get("fontFamily").and_then(|v| v.as_str()).map(String::from),
      font_size,
      font_weight: match sp.get("fontWeight").filter(|v| !v.is_null()) {
        Some(w) => Some(parse::font_weight(cx, "fontWeight", w)?),
        None => None,
      },
      italic: parse::opt_bool(cx, sp, "italic")?,
      color: match sp.get("color").filter(|v| !v.is_null()) {
        Some(c) => Some(parse::color(cx, "color", c)?),
        None => None,
      },
      decoration,
      letter_spacing,
      link: match sp.get("link").and_then(|v| v.as_str()) {
        Some(url) => {
          Some(crate::model::safe_link(url).ok_or_else(|| cx.err("link", "a span link must be an http(s), mailto: or tel: link"))?)
        }
        None => None,
      },
    });
    cx.leave(mark);
  }
  let len = text.chars().count();
  crate::text::normalize_runs(&mut runs, len);
  Ok((text, runs))
}

fn apply_dimension(n: &mut Node, d: Option<Dim>, horizontal: bool) {
  let Some(d) = d else { return };
  let sizing = match d {
    Dim::Px(x) => {
      if horizontal {
        n.width = x;
      } else {
        n.height = if n.kind == NodeType::Line { 0.0 } else { x };
      }
      Sizing::Fixed
    }
    Dim::Fill => Sizing::Fill,
    Dim::Hug => Sizing::Hug,
  };
  if horizontal {
    n.sizing_h = sizing;
  } else {
    n.sizing_v = sizing;
  }
}

/// Image paints may only use sources `paint::safe_image_src` accepts: the editor fetches them.
fn check_paint_sources(paints: &[Paint]) -> Result<(), String> {
  for p in paints {
    if let Paint::Image { src, .. } = p {
      if !crate::paint::safe_image_src(src) {
        return Err("image src must be an absolute http(s):// URL (no spaces), a data:image/ URL or an asset: id".into());
      }
    }
  }
  Ok(())
}

/// Parses `fill` values: hex, CSS gradients, paint objects, arrays, or "none".
pub fn parse_fills(v: &Value) -> Result<Vec<Paint>, String> {
  match v {
    Value::Null => Ok(vec![]),
    Value::String(s) => parse_fill_str(s).map(|p| p.into_iter().collect()),
    Value::Array(a) => {
      let mut out = Vec::new();
      for x in a {
        out.extend(parse_fills(x)?);
      }
      Ok(out)
    }
    Value::Object(_) => {
      let p = serde_json::from_value::<Paint>(v.clone()).map_err(|e| format!("invalid paint: {e}"))?;
      check_paint_sources(std::slice::from_ref(&p))?;
      Ok(vec![p])
    }
    _ => Err("invalid fill".into()),
  }
}

fn parse_fill_str(s: &str) -> Result<Option<Paint>, String> {
  let t = s.trim();
  if t.is_empty() || t == "none" || t == "transparent" {
    return Ok(None);
  }
  if let Some(inner) = t.strip_prefix("linear-gradient(").and_then(|r| r.strip_suffix(')')) {
    let parts = split_top_level(inner);
    let mut angle = 180.0;
    let mut stops_src: &[String] = &parts;
    if let Some(first) = parts.first() {
      let f = first.trim();
      if let Some(deg) = f.strip_suffix("deg") {
        angle = deg.trim().parse().unwrap_or(180.0);
        stops_src = &parts[1..];
      } else if let Some(dir) = f.strip_prefix("to ") {
        angle = match dir.trim() {
          "top" => 0.0,
          "right" => 90.0,
          "bottom" => 180.0,
          "left" => 270.0,
          "bottom right" | "right bottom" => 135.0,
          "top right" | "right top" => 45.0,
          "bottom left" | "left bottom" => 225.0,
          "top left" | "left top" => 315.0,
          _ => 180.0,
        };
        stops_src = &parts[1..];
      }
    }
    if stops_src.len() < 2 {
      return Err(format!("gradient '{t}' needs at least two colour stops"));
    }
    return Ok(Some(Paint::LinearGradient {
      stops: parse_stops(stops_src),
      angle,
      opacity: 1.0,
      visible: true,
      handles: None,
    }));
  }
  if let Some(inner) = t.strip_prefix("radial-gradient(").and_then(|r| r.strip_suffix(')')) {
    let parts = split_top_level(inner);
    let stops_src: Vec<String> = parts
      .into_iter()
      .filter(|p| crate::color::parse(parse::tokens(p).first().map(String::as_str).unwrap_or("")).is_some())
      .collect();
    if stops_src.len() < 2 {
      return Err(format!("gradient '{t}' needs at least two colour stops"));
    }
    return Ok(Some(Paint::RadialGradient {
      stops: parse_stops(&stops_src),
      opacity: 1.0,
      visible: true,
      handles: None,
    }));
  }
  if let Some(inner) = t.strip_prefix("conic-gradient(").and_then(|r| r.strip_suffix(')')) {
    return parse_conic(t, &split_top_level(inner)).map(Some);
  }
  let c = crate::color::parse(t).ok_or_else(|| format!("unrecognised colour '{t}'"))?;
  Ok(Some(Paint::Solid {
    color: c.hex6(),
    opacity: c.a,
    visible: true,
  }))
}

/// `strokeWeights`: `[top, right, bottom, left]` or `{top, right, bottom, left}` (a missing side is 0).
fn parse_stroke_weights(cx: &parse::Ctx, v: &Value) -> Result<[f64; 4], String> {
  let bad = || {
    cx.err(
      "strokeWeights",
      format!(
        "must be [top, right, bottom, left] or {{top, right, bottom, left}}, got {}",
        parse::kind_of(v)
      ),
    )
  };
  let side = |x: &Value| parse::number(cx, "strokeWeights", x).map(|w| w.max(0.0));
  match v {
    Value::Array(a) if a.len() == 4 => Ok([side(&a[0])?, side(&a[1])?, side(&a[2])?, side(&a[3])?]),
    Value::Object(o) => {
      let get = |k: &str| o.get(k).map_or(Ok(0.0), side);
      Ok([get("top")?, get("right")?, get("bottom")?, get("left")?])
    }
    _ => Err(bad()),
  }
}

/// `conic-gradient([from <angle>] [at <x> <y>], stops...)`. The start angle and centre become
/// handles (the angle is taken on a square box: the string doesn't know the layer's size).
fn parse_conic(src: &str, parts: &[String]) -> Result<Paint, String> {
  let mut from = 0.0_f64;
  let mut at = [0.5, 0.5];
  let mut custom = false;
  let mut stops_src = parts;
  if let Some(first) = parts.first() {
    let f = first.trim();
    if f.starts_with("from ") || f.starts_with("at ") {
      custom = true;
      stops_src = &parts[1..];
      let toks: Vec<&str> = f.split_whitespace().collect();
      let mut i = 0;
      while i < toks.len() {
        match toks[i] {
          "from" => {
            from = toks
              .get(i + 1)
              .and_then(|t| t.strip_suffix("deg"))
              .and_then(|t| t.parse().ok())
              .unwrap_or(0.0);
            i += 2;
          }
          "at" => {
            let pos = |t: Option<&&str>| match t.copied() {
              Some("left") | Some("top") => Some(0.0),
              Some("center") => Some(0.5),
              Some("right") | Some("bottom") => Some(1.0),
              Some(v) => v.strip_suffix('%').and_then(|v| v.parse::<f64>().ok()).map(|v| v / 100.0),
              None => None,
            };
            at = [pos(toks.get(i + 1)).unwrap_or(0.5), pos(toks.get(i + 2)).unwrap_or(0.5)];
            i += 3;
          }
          _ => i += 1,
        }
      }
    }
  }
  if stops_src.len() < 2 {
    return Err(format!("gradient '{src}' needs at least two colour stops"));
  }
  let handles = custom.then(|| {
    let a = from.to_radians();
    let (dx, dy) = (a.sin() * 0.5, -a.cos() * 0.5);
    GradientHandles {
      start: at,
      end: [at[0] + dx, at[1] + dy],
      width: [at[0] - dy, at[1] + dx],
    }
  });
  Ok(Paint::AngularGradient {
    stops: parse_stops(stops_src),
    opacity: 1.0,
    visible: true,
    handles,
  })
}

fn split_top_level(s: &str) -> Vec<String> {
  let mut out = Vec::new();
  let mut depth = 0;
  let mut cur = String::new();
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
      ',' if depth == 0 => out.push(std::mem::take(&mut cur).trim().to_string()),
      _ => cur.push(c),
    }
  }
  if !cur.trim().is_empty() {
    out.push(cur.trim().to_string());
  }
  out
}

fn parse_stops(parts: &[String]) -> Vec<GradientStop> {
  let n = parts.len().max(1);
  parts
    .iter()
    .enumerate()
    .map(|(i, p)| {
      // Colour may contain spaces (rgba(...)); the position is the trailing token.
      let (color, pos) = match p.rsplit_once(' ') {
        Some((c, pos)) if pos.ends_with('%') => (
          c.trim().to_string(),
          pos.trim_end_matches('%').parse::<f64>().ok().map(|v| v / 100.0),
        ),
        _ => (p.trim().to_string(), None),
      };
      GradientStop {
        color: crate::color::normalize(&color),
        position: pos.unwrap_or(if n == 1 { 0.0 } else { i as f64 / (n - 1) as f64 }),
      }
    })
    .collect()
}

/// Top-level keys whose values differ, as a merge patch.
pub fn diff_patch(before: &Node, after: &Node) -> Value {
  let b = serde_json::to_value(before).unwrap_or(Value::Null);
  let a = serde_json::to_value(after).unwrap_or(Value::Null);
  let mut out = Map::new();
  if let (Value::Object(bm), Value::Object(am)) = (b, a) {
    for (k, v) in &am {
      if bm.get(k) != Some(v) {
        out.insert(k.clone(), v.clone());
      }
    }
    // Links that are left out of saved nodes when unset: a removed one is an explicit null.
    for k in ["effectStyle", "gridStyle", "strokeStyle"] {
      if bm.contains_key(k) && !am.contains_key(k) {
        out.insert(k.into(), Value::Null);
      }
    }
  }
  Value::Object(out)
}

/// Component sets a layer can change variants in, nearest first: the set of the variant it is
/// in, or of the instance it is in (or is).
fn enclosing_sets(doc: &Document, id: &str) -> Vec<String> {
  let mut out = Vec::new();
  let mut at = doc.get(id);
  while let Some(n) = at {
    let comp = match n.kind {
      NodeType::Component => Some(n.id.as_str()),
      NodeType::Instance => n.instance.as_ref().map(|i| i.component_id.as_str()),
      _ => None,
    };
    if let Some(set) = comp.and_then(|c| doc.get(c)).and_then(|c| c.parent.as_deref()) {
      if doc.get(set).is_some_and(|s| s.kind == NodeType::ComponentSet) && !out.iter().any(|o| o == set) {
        out.push(set.to_string());
      }
    }
    at = n.parent.as_deref().and_then(|p| doc.get(p));
  }
  out
}

/// "shift+k" → "Shift+K": modifiers ordered Ctrl, Alt, Shift, Meta, then one key (a letter,
/// digit, or a name such as Enter or ArrowRight). Mirrors `keyName` in web/src/prototype.ts.
fn normalize_key(s: &str) -> Result<String, String> {
  const NAMED: &[&str] = &[
    "Enter",
    "Escape",
    "Space",
    "Tab",
    "Backspace",
    "Delete",
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    "ArrowDown",
    "Home",
    "End",
    "PageUp",
    "PageDown",
  ];
  let (mut ctrl, mut alt, mut shift, mut meta) = (false, false, false, false);
  let mut key: Option<String> = None;
  let parts: Vec<&str> = if s.trim() == "+" {
    vec!["+"]
  } else {
    s.split('+').map(str::trim).collect()
  };
  for p in parts {
    match p.to_lowercase().as_str() {
      "ctrl" | "control" => ctrl = true,
      "alt" | "option" => alt = true,
      "shift" => shift = true,
      "meta" | "cmd" | "command" => meta = true,
      "" => return Err(format!("key '{s}' isn't a key or combination like 'Shift+K'")),
      l => {
        let name = match l {
          "esc" => Some("Escape"),
          "return" => Some("Enter"),
          "del" => Some("Delete"),
          "left" => Some("ArrowLeft"),
          "right" => Some("ArrowRight"),
          "up" => Some("ArrowUp"),
          "down" => Some("ArrowDown"),
          _ => NAMED.iter().find(|n| n.to_lowercase() == l).copied(),
        };
        let k = match name {
          Some(n) => n.to_string(),
          None if p.chars().count() == 1 => p.to_uppercase(),
          None => {
            return Err(format!(
              "key '{p}' isn't supported; use a single character or one of {}",
              NAMED.join(", ")
            ))
          }
        };
        if key.replace(k).is_some() {
          return Err(format!(
            "key '{s}' has more than one key; use modifiers plus one key, like 'Shift+K'"
          ));
        }
      }
    }
  }
  let key = key.ok_or_else(|| format!("key '{s}' has no key, only modifiers"))?;
  let mut out = String::new();
  for (on, m) in [(ctrl, "Ctrl"), (alt, "Alt"), (shift, "Shift"), (meta, "Meta")] {
    if on {
      out.push_str(m);
      out.push('+');
    }
  }
  out.push_str(&key);
  Ok(out)
}

/// `set_prototype`'s `overlay` options; anything left out keeps Figma's defaults.
fn overlay_settings(v: Option<&Value>) -> Result<OverlaySettings, String> {
  let mut s = OverlaySettings::default();
  let Some(v) = v.filter(|v| !v.is_null()) else { return Ok(s) };
  if let Some(p) = v.get("position").and_then(|p| p.as_str()) {
    s.position = match p.replace(['_', '-', ' '], "").to_lowercase().as_str() {
      "center" | "centre" => OverlayPosition::Center,
      "topleft" => OverlayPosition::TopLeft,
      "topcenter" | "top" => OverlayPosition::TopCenter,
      "topright" => OverlayPosition::TopRight,
      "bottomleft" => OverlayPosition::BottomLeft,
      "bottomcenter" | "bottom" => OverlayPosition::BottomCenter,
      "bottomright" => OverlayPosition::BottomRight,
      "manual" => OverlayPosition::Manual,
      _ => return Err(format!("unknown overlay position '{p}'")),
    };
  }
  s.offset_x = num(v.get("offsetX")).unwrap_or(0.0);
  s.offset_y = num(v.get("offsetY")).unwrap_or(0.0);
  if let Some(c) = v.get("closeOnClickOutside").and_then(|c| c.as_bool()) {
    s.close_on_click_outside = c;
  }
  match v.get("background") {
    Some(Value::Null) => s.background = None,
    Some(Value::String(c)) if c.eq_ignore_ascii_case("none") => s.background = None,
    Some(Value::String(c)) => {
      let rgba = crate::color::parse(c).ok_or_else(|| format!("background '{c}' is not a colour"))?;
      // A colour with alpha ("#0000004D") carries its own opacity.
      s.background = Some(OverlayBackground {
        color: rgba.hex6(),
        opacity: if rgba.a < 0.999 { rgba.a } else { 0.3 },
      });
    }
    _ => {}
  }
  if let (Some(b), Some(o)) = (s.background.as_mut(), num(v.get("backgroundOpacity"))) {
    b.opacity = o.clamp(0.0, 1.0);
  }
  Ok(s)
}

fn num(v: Option<&Value>) -> Option<f64> {
  v.and_then(|v| v.as_f64())
}

fn str_list(v: Option<&Value>) -> Vec<String> {
  match v {
    Some(Value::Array(a)) => a.iter().filter_map(|x| x.as_str().map(String::from)).collect(),
    Some(Value::String(s)) => vec![s.clone()],
    _ => vec![],
  }
}

#[allow(dead_code)]
fn center_of(e: &Engine, id: &str) -> Point {
  e.doc.abs_bounds(id).center()
}

#[cfg(test)]
mod tests {

  fn created_geometry(e: &Engine) -> std::collections::BTreeMap<String, (f64, f64, f64, f64)> {
    e.doc
      .nodes
      .values()
      .map(|n| (n.name.clone(), (n.x, n.y, n.width, n.height)))
      .collect()
  }

  #[test]
  fn fill_children_of_a_hug_axis_settle_when_created() {
    let mut e = Engine::new(Box::new(crate::text::HeuristicMeasurer), 3);
    let spec = json!({ "type": "frame", "name": "Col", "width": 320, "height": "hug",
      "layout": { "direction": "vertical", "gap": 8, "padding": 16 },
      "children": [{ "type": "frame", "name": "F", "width": "fill", "height": "fill",
        "layout": { "direction": "vertical", "padding": [12, 24], "gap": 8 },
        "children": [
          { "type": "text", "name": "T", "width": "fill", "fontSize": 14, "lineHeight": 30,
            "text": "a layout dog dog I over a jumps Mm and a few more words to wrap" },
          { "type": "rectangle", "name": "R", "width": 100, "height": "fill", "fill": "#ccc" } ] }] });
    e.dispatch(Command::Ai {
      tool: "create_nodes".into(),
      input: json!({ "nodes": [spec] }),
    })
    .unwrap();
    let by = |e: &Engine, name: &str| e.doc.nodes.values().find(|n| n.name == name).unwrap().clone();
    let (col, f, t, r) = (by(&e, "Col"), by(&e, "F"), by(&e, "T"), by(&e, "R"));
    assert_eq!(
      (f.sizing_h, f.sizing_v),
      (Sizing::Fill, Sizing::Hug),
      "main axis hugs, cross axis keeps fill"
    );
    assert_eq!((r.sizing_h, r.sizing_v), (Sizing::Fixed, Sizing::Fixed));
    assert_eq!(
      (t.sizing_h, t.sizing_v),
      (Sizing::Fill, Sizing::Fixed),
      "text height follows its wrapping"
    );
    assert_eq!(r.height, 100.0, "the rectangle keeps its size");
    assert!(t.height >= 60.0, "the text wraps at the frame's width: {}", t.height);
    assert_eq!(f.height, 12.0 + t.height + 8.0 + 100.0 + 12.0, "the frame hugs its content");
    assert_eq!(col.height, 16.0 + f.height + 16.0);
    // Saved, loaded and laid out again: nothing moves.
    let before = created_geometry(&e);
    let json = e.to_json();
    e.load(&json).unwrap();
    e.dispatch(Command::Relayout).unwrap();
    assert_eq!(created_geometry(&e), before);
  }

  #[test]
  fn fill_under_a_held_back_hug_frame_stays_fill() {
    let mut e = Engine::new(Box::new(crate::text::HeuristicMeasurer), 3);
    let spec = json!({ "type": "frame", "name": "Row", "width": "hug", "height": "hug", "maxWidth": 200,
      "layout": { "direction": "horizontal", "gap": 0, "padding": 0 },
      "children": [{ "type": "text", "name": "T", "width": "fill", "text": "a fairly long sentence that needs several lines" }] });
    e.dispatch(Command::Ai {
      tool: "create_nodes".into(),
      input: json!({ "nodes": [spec] }),
    })
    .unwrap();
    let t = e.doc.nodes.values().find(|n| n.name == "T").unwrap().clone();
    assert_eq!(t.sizing_h, Sizing::Fill);
    let row = e.doc.nodes.values().find(|n| n.name == "Row").unwrap().clone();
    assert_eq!(row.width, 200.0);
    assert_eq!(t.width, 200.0);
    // A hug row without a max still settles its fill text to hug.
    let spec = json!({ "type": "frame", "name": "Row2", "width": "hug", "height": "hug",
      "layout": { "direction": "horizontal", "gap": 0, "padding": 0 },
      "children": [{ "type": "text", "name": "T2", "width": "fill", "text": "short" }] });
    e.dispatch(Command::Ai {
      tool: "create_nodes".into(),
      input: json!({ "nodes": [spec] }),
    })
    .unwrap();
    assert_eq!(e.doc.nodes.values().find(|n| n.name == "T2").unwrap().sizing_h, Sizing::Hug);
  }
  use super::*;
  use crate::text::HeuristicMeasurer;

  fn engine() -> Engine {
    Engine::new(Box::new(HeuristicMeasurer), 77)
  }

  #[test]
  fn system_prompt_asks_for_editable_designs_and_stays_short() {
    for word in [
      "component",
      "variant",
      "variableModes",
      "define_variables",
      "define_styles",
      "plain-text",
    ] {
      assert!(SYSTEM_PROMPT.contains(word), "SYSTEM_PROMPT should mention {word}");
    }
    assert!(SYSTEM_PROMPT.len() < 2900, "{} chars", SYSTEM_PROMPT.len());
    // fix_issues changes the whole page, so it is only for a page that had nothing else on it.
    assert!(SYSTEM_PROMPT.contains("had nothing else on it") && SYSTEM_PROMPT.contains("fix only your new layers"));
    // Edits to existing layers stay small, and the short-reply rule is scoped to the chat panel
    // (terminal Claude Code gets this text through the MCP instructions too).
    assert!(SYSTEM_PROMPT.contains("do only what was asked"));
    assert!(SYSTEM_PROMPT.contains("In Designotron's chat panel, reply"));
  }

  #[test]
  fn tool_descriptions_name_the_editable_building_blocks() {
    let defs = tool_defs();
    let text = |name: &str| {
      let tool = defs.as_array().unwrap().iter().find(|t| t["name"] == name).unwrap();
      tool["description"].as_str().unwrap().to_string()
    };
    assert!(text("create_nodes").contains("instance") && text("create_nodes").contains("component"));
    assert!(text("arrange").contains("combine_variants (merges"));
    assert!(text("define_variables").contains("variableModes") && text("define_variables").contains("Dark"));
    assert!(text("get_screenshot").contains("1600"));
    assert!(text("import_url").contains("1440"));
  }

  #[test]
  fn empty_children_are_fine_on_any_layer() {
    let mut e = engine();
    let r = execute(
      &mut e,
      "create_nodes",
      &json!({ "nodes": [{ "type": "rectangle", "width": 10, "height": 10, "children": [] }] }),
    );
    assert!(r.is_ok(), "{r:?}");
  }

  #[test]
  fn create_screen_from_spec() {
    let mut e = engine();
    let input = json!({ "nodes": [{
      "type": "frame", "name": "Login", "width": 390, "height": 844, "fill": "#FFFFFF",
      "layout": { "direction": "vertical", "gap": 16, "padding": 24 },
      "children": [
        { "type": "text", "text": "Welcome back", "fontSize": 28, "fontWeight": 700, "color": "#111827" },
        { "type": "frame", "name": "Button", "width": "fill", "height": 48, "fill": "linear-gradient(90deg, #7C5CFF 0%, #4F46E5 100%)", "cornerRadius": 12,
          "layout": { "direction": "horizontal", "align": "center", "crossAlign": "center" },
          "shadow": { "y": 8, "blur": 24, "color": "#4F46E540" },
          "children": [{ "type": "text", "text": "Sign in", "color": "#FFFFFF", "fontWeight": 600 }] },
        { "type": "vector", "svgPath": "M12 2L2 22h20L12 2z" }
      ]
    }]});
    let r = e
      .dispatch(Command::Ai {
        tool: "create_nodes".into(),
        input,
      })
      .unwrap();
    let root = r["created"][0]["id"].as_str().unwrap().to_string();
    let f = e.doc.get(&root).unwrap();
    assert_eq!(f.children.len(), 3);
    let btn = e.doc.get(&f.children[1]).unwrap();
    assert_eq!(btn.width, 390.0 - 48.0);
    assert!(matches!(btn.fills[0], Paint::LinearGradient { angle, .. } if angle == 90.0));
    let label = e.doc.get(&btn.children[0]).unwrap();
    assert!((label.x - (btn.width - label.width) / 2.0).abs() < 0.01);
    // One AI call = one undo step.
    e.dispatch(Command::Undo).unwrap();
    assert!(e.doc.get(&root).is_none());
  }

  #[test]
  fn wrap_layout_takes_a_separate_row_gap() {
    let mut e = engine();
    let cell = json!({ "type": "rectangle", "width": 100, "height": 50 });
    let input = json!({ "nodes": [{
      "type": "frame", "width": 250, "height": "hug",
      "layout": { "direction": "horizontal", "gap": 10, "counterGap": 30, "padding": 0, "wrap": true },
      "children": [cell, cell, cell]
    }]});
    let r = e
      .dispatch(Command::Ai {
        tool: "create_nodes".into(),
        input,
      })
      .unwrap();
    let root = r["created"][0]["id"].as_str().unwrap().to_string();
    let f = e.doc.get(&root).unwrap();
    let al = f.layout.as_ref().unwrap();
    assert_eq!((al.gap, al.counter_gap), (10.0, 30.0));
    let third = e.doc.get(&f.children[2]).unwrap();
    assert_eq!((third.x, third.y), (0.0, 80.0));
    assert_eq!(f.height, 130.0);
  }

  #[test]
  fn update_records_and_errors() {
    let mut e = engine();
    let r = e
      .dispatch(Command::Ai {
        tool: "create_nodes".into(),
        input: json!({ "nodes": [{ "type": "rectangle", "width": 10, "height": 10 }] }),
      })
      .unwrap();
    let id = r["created"][0]["id"].as_str().unwrap().to_string();
    e.dispatch(Command::Ai {
      tool: "update_nodes".into(),
      input: json!({ "updates": [{ "id": id, "fill": "#FF0000", "cornerRadius": 4 }] }),
    })
    .unwrap();
    assert_eq!(e.doc.get(&id).unwrap().corner_radius, 4.0);
    assert!(e
      .dispatch(Command::Ai {
        tool: "create_nodes".into(),
        input: json!({ "nodes": [{ "type": "blob" }] })
      })
      .is_err());
    assert!(e
      .dispatch(Command::Ai {
        tool: "get_screenshot".into(),
        input: json!({})
      })
      .is_err());
  }

  #[test]
  fn spans_create_mixed_text() {
    let mut e = engine();
    let r = e
      .dispatch(Command::Ai {
        tool: "create_nodes".into(),
        input: json!({ "nodes": [{ "type": "text", "spans": [{ "text": "Save " }, { "text": "40%", "fontWeight": 800, "color": "#16A34A" }, { "text": " today" }] }] }),
      })
      .unwrap();
    let id = r["created"][0]["id"].as_str().unwrap().to_string();
    let t = e.doc.get(&id).unwrap().text.clone().unwrap();
    assert_eq!(t.characters, "Save 40% today");
    assert_eq!(t.runs.len(), 1);
    assert_eq!((t.runs[0].start, t.runs[0].end), (5, 8));
    let react = crate::codegen::export_react(&e.doc, &id, &HeuristicMeasurer);
    assert!(
      react.contains("<span className=\"font-[800] text-[#16A34A]\">{\"40%\"}</span>"),
      "{react}"
    );
  }

  #[test]
  fn tool_defs_are_valid() {
    let defs = tool_defs();
    let names: Vec<&str> = defs.as_array().unwrap().iter().map(|d| d["name"].as_str().unwrap()).collect();
    assert!(names.contains(&"create_nodes") && names.contains(&"get_screenshot"));
    for d in defs.as_array().unwrap() {
      assert_eq!(d["input_schema"]["type"], "object");
    }
  }

  mod overlays {
    use super::*;
    use crate::model::{OverlayPosition, OverlaySettings};

    #[test]
    fn open_overlay_with_defaults() {
      let (mut e, ids) = screens();
      let (home, modal, btn) = (&ids[0], &ids[1], &ids[3]);
      e.dispatch(Command::Ai {
        tool: "set_prototype".into(),
        input: json!({ "nodeId": btn, "action": "open_overlay", "destinationId": modal }),
      })
      .unwrap();
      let i = &e.doc.get(btn).unwrap().interactions[0];
      assert_eq!(i.action, Action::OpenOverlay);
      assert_eq!(i.destination.as_deref(), Some(modal.as_str()));
      assert_eq!(i.overlay, OverlaySettings::default());
      // One undo step, like every AI call.
      e.dispatch(Command::Undo).unwrap();
      assert!(e.doc.get(btn).unwrap().interactions.is_empty());
      assert!(e.doc.get(home).is_some());
    }

    #[test]
    fn overlay_options_close_and_swap() {
      let (mut e, ids) = screens();
      let (modal, menu, btn) = (&ids[1], &ids[2], &ids[3]);
      execute(
        &mut e,
        "set_prototype",
        &json!({ "nodeId": btn, "action": "open_overlay", "destinationId": menu,
          "overlay": { "position": "top_right", "closeOnClickOutside": false, "background": "none" } }),
      )
      .unwrap();
      execute(
        &mut e,
        "set_prototype",
        &json!({ "nodeId": btn, "action": "swap_overlay", "destinationId": modal, "trigger": "hover",
          "overlay": { "position": "manual", "offsetX": 12, "offsetY": -4, "background": "#1E293B", "backgroundOpacity": 0.6 } }),
      )
      .unwrap();
      execute(&mut e, "set_prototype", &json!({ "nodeId": modal, "action": "close_overlay" })).unwrap();
      let b = e.doc.get(btn).unwrap();
      let open = &b.interactions[0].overlay;
      assert_eq!(open.position, OverlayPosition::TopRight);
      assert!(!open.close_on_click_outside);
      assert!(open.background.is_none());
      let swap = &b.interactions[1];
      assert_eq!(swap.action, Action::SwapOverlay);
      assert_eq!(swap.overlay.position, OverlayPosition::Manual);
      assert_eq!((swap.overlay.offset_x, swap.overlay.offset_y), (12.0, -4.0));
      let bg = swap.overlay.background.as_ref().unwrap();
      assert_eq!((bg.color.as_str(), bg.opacity), ("#1E293B", 0.6));
      assert_eq!(e.doc.get(modal).unwrap().interactions[0].action, Action::CloseOverlay);
    }

    #[test]
    fn overlay_needs_a_top_level_frame() {
      let (mut e, ids) = screens();
      let btn = &ids[3];
      for input in [
        json!({ "nodeId": btn, "action": "open_overlay" }),
        json!({ "nodeId": btn, "action": "open_overlay", "destinationId": btn }),
        json!({ "nodeId": btn, "action": "swap_overlay", "destinationId": "missing" }),
        json!({ "nodeId": btn, "action": "open_overlay", "destinationId": ids[1], "overlay": { "position": "middle" } }),
      ] {
        assert!(execute(&mut e, "set_prototype", &input).is_err(), "{input}");
      }
      assert!(e.doc.get(btn).unwrap().interactions.is_empty());
    }

    /// Home (with a button), Modal and Menu frames: ids [home, modal, menu, button].
    fn screens() -> (Engine, Vec<String>) {
      let mut e = engine();
      let r = execute(
        &mut e,
        "create_nodes",
        &json!({ "nodes": [
          { "type": "frame", "name": "Home", "width": 390, "height": 844,
            "children": [{ "type": "rectangle", "name": "Open", "width": 120, "height": 40 }] },
          { "type": "frame", "name": "Modal", "x": 500, "width": 300, "height": 200 },
          { "type": "frame", "name": "Menu", "x": 900, "width": 200, "height": 240 }
        ] }),
      )
      .unwrap();
      let id = |i: usize| r["created"][i]["id"].as_str().unwrap().to_string();
      let home = id(0);
      let btn = e.doc.get(&home).unwrap().children[0].clone();
      (e, vec![home, id(1), id(2), btn])
    }
  }
}
