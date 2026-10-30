//! AI tools: one definition list and one executor shared by the in-app
//! Claude chat (API mode), the MCP server for Claude Code and headless runs.
//!
//! Node specs are a forgiving, CSS-flavoured JSON shape so models can write
//! whole screens in one call; they are converted into real nodes here.

use serde_json::{json, Map, Value};

use crate::codegen;
use crate::engine::{Command, Engine};
use crate::geom::Point;
use crate::model::{
  Action, Align, AutoLayout, Effect, EffectType, GradientStop, Interaction, LayoutDirection, Node, NodeId, NodeType, OverlayBackground,
  OverlayPosition, OverlaySettings, Paint, RawPath, ScaleMode, Sizing, StrokeAlign, SubPath, TextAlignH, TextAlignV, TextAutoResize,
  TextCase, TextDecoration, Transition, Trigger, VectorData, VectorPoint,
};
use crate::ops::{self, AlignHow, ReorderTo};
use crate::render;

/// Tools that need a browser (rasterising, DOM). The web shell executes them.
pub const BROWSER_TOOLS: &[&str] = &["get_screenshot", "import_html", "import_url", "save_plugin"];

pub const SYSTEM_PROMPT: &str = "You are the design copilot inside Designotron, a Figma-style design tool. \
You edit the open document directly through tools. Coordinates are pixels; children are positioned relative to their parent; \
top-level frames are screens/artboards. Prefer auto layout (layout: {direction, gap, padding, align, crossAlign}) with width/height \
'fill' or 'hug' for real UI so it converts cleanly to code. Build complete, polished designs in as few create_nodes calls as possible \
(nest children). Use real copy, consistent spacing (4/8 grid), a clear type scale and accessible contrast. After building, call \
get_screenshot to check the result visually and fix problems. Place new screens to the right of existing ones so nothing overlaps. \
When the user attaches a screenshot or mockup, recreate it as editable layers (not an image) and compare with get_screenshot. \
Use import_url to bring in a live website, and lint_design / fix_issues to check accessibility and consistency before you finish.";

fn spec_schema() -> Value {
  json!({
    "type": "object",
    "description": "A layer. Unknown keys are ignored.",
    "properties": {
      "type": { "type": "string", "enum": ["frame", "rectangle", "ellipse", "text", "line", "polygon", "star", "vector", "group", "image", "instance"] },
      "name": { "type": "string" },
      "x": { "type": "number" }, "y": { "type": "number" },
      "width": { "description": "number, or 'fill' / 'hug' inside auto layout", "type": ["number", "string"] },
      "height": { "description": "number, or 'fill' / 'hug'", "type": ["number", "string"] },
      "fill": { "description": "Hex colour like '#7C5CFF', a CSS linear-gradient(...) string, or 'none'", "type": "string" },
      "stroke": { "type": "string", "description": "Hex colour" },
      "strokeWidth": { "type": "number" },
      "strokeAlign": { "type": "string", "enum": ["inside", "center", "outside"] },
      "cornerRadius": { "description": "number or [tl, tr, br, bl]", "type": ["number", "array"] },
      "opacity": { "type": "number" },
      "rotation": { "type": "number" },
      "shadow": { "description": "{x, y, blur, spread, color} or an array of them; inset: true for inner shadow", "type": ["object", "array"] },
      "blur": { "type": "number", "description": "Layer blur radius" },
      "backgroundBlur": { "type": "number" },
      "clip": { "type": "boolean" },
      "layout": {
        "type": "object",
        "description": "Auto layout for frames",
        "properties": {
          "direction": { "type": "string", "enum": ["horizontal", "vertical"] },
          "gap": { "type": "number" },
          "padding": { "description": "number, [vertical, horizontal] or [top, right, bottom, left]", "type": ["number", "array"] },
          "align": { "type": "string", "enum": ["start", "center", "end", "space-between"], "description": "Main axis" },
          "crossAlign": { "type": "string", "enum": ["start", "center", "end", "baseline"], "description": "Cross axis; baseline lines up the first text baselines of a horizontal layout" },
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
      "fontWeight": { "type": "number" },
      "fontFamily": { "type": "string", "description": "Inter, Roboto, Poppins, Montserrat, Playfair Display, DM Sans, Space Grotesk, JetBrains Mono, Lato, Open Sans" },
      "lineHeight": { "type": "number", "description": "px" },
      "letterSpacing": { "type": "number", "description": "px" },
      "textAlign": { "type": "string", "enum": ["left", "center", "right", "justify"] },
      "color": { "type": "string", "description": "Text colour" },
      "italic": { "type": "boolean" },
      "textCase": { "type": "string", "enum": ["original", "upper", "lower", "title"] },
      "imageUrl": { "type": "string", "description": "Image fill (URL or data URL)" },
      "svgPath": { "type": "string", "description": "SVG path data for an icon (type vector)" },
      "viewBox": { "type": "array", "description": "[minX, minY, width, height] for svgPath, default [0,0,24,24]" },
      "componentId": { "type": "string", "description": "For type instance" },
      "notes": { "type": "string", "description": "Developer annotation" },
      "bind": { "type": "object", "description": "Property → variable name, e.g. {fill: 'Theme/Surface'}; null unbinds" },
      "variableModes": { "type": "object", "description": "Collection → mode for this frame and its children, e.g. {Theme: 'Dark'}" },
      "layoutGrids": { "type": "array", "description": "Frame layout grids, e.g. [{pattern:'columns', count:12, gutter:24, margin:80}] or [{pattern:'grid', size:8}]", "items": { "type": "object" } },
      "children": { "type": "array", "items": { "type": "object" } }
    },
    "required": ["type"]
  })
}

/// JSON tool definitions (Anthropic tool format: name, description, input_schema).
pub fn tool_defs() -> Value {
  let spec = spec_schema();
  json!([
    {
      "name": "get_document",
      "description": "Overview of the open design: pages, current page layer tree (to a depth), selection, components and styles. Call first.",
      "input_schema": { "type": "object", "properties": { "depth": { "type": "integer", "description": "Tree depth (default 3)" } } }
    },
    {
      "name": "get_nodes",
      "description": "Full properties of specific layers plus their subtree outline.",
      "input_schema": { "type": "object", "properties": { "ids": { "type": "array", "items": { "type": "string" } }, "depth": { "type": "integer" } }, "required": ["ids"] }
    },
    {
      "name": "create_nodes",
      "description": "Create layers (with nested children) on the current page or inside parentId. Returns created ids. Build whole screens in one call.",
      "input_schema": { "type": "object", "properties": { "parentId": { "type": "string" }, "nodes": { "type": "array", "items": spec } }, "required": ["nodes"] }
    },
    {
      "name": "update_nodes",
      "description": "Change properties of existing layers. Each update is {id, ...any create_nodes property except children}. Use 'patch' for raw model fields.",
      "input_schema": { "type": "object", "properties": { "updates": { "type": "array", "items": { "type": "object", "properties": { "id": { "type": "string" }, "patch": { "type": "object" } }, "required": ["id"] } } }, "required": ["updates"] }
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
      "description": "Structural actions on layers: group, ungroup, frame, duplicate, create_component, combine_variants, detach_instance, add_auto_layout, remove_auto_layout, bring_to_front, send_to_back, align_left, align_center, align_right, align_top, align_middle, align_bottom, distribute_horizontal, distribute_vertical, union, subtract (bottom layer minus the rest), intersect, exclude, flatten, outline_stroke, mask (bottom layer masks the others).",
      "input_schema": { "type": "object", "properties": { "action": { "type": "string" }, "ids": { "type": "array", "items": { "type": "string" } } }, "required": ["action", "ids"] }
    },
    {
      "name": "create_instance",
      "description": "Place an instance of a main component.",
      "input_schema": { "type": "object", "properties": { "componentId": { "type": "string" }, "parentId": { "type": "string" }, "x": { "type": "number" }, "y": { "type": "number" } }, "required": ["componentId"] }
    },
    {
      "name": "set_prototype",
      "description": "Add a prototype interaction: clicking nodeId navigates to destinationId (a top-level frame), goes back, opens a URL, or works with overlays. open_overlay shows destinationId (a top-level frame, e.g. a modal, menu or sheet) on top of the current screen; close_overlay closes the topmost overlay (put it on a close button inside the overlay); swap_overlay replaces the topmost overlay with destinationId. Overlays default to centred, a 30% black dimmed background and closing when clicking outside; change that with `overlay`.",
      "input_schema": { "type": "object", "properties": {
        "nodeId": { "type": "string" }, "destinationId": { "type": "string" },
        "action": { "type": "string", "enum": ["navigate", "back", "open_url", "open_overlay", "close_overlay", "swap_overlay"] }, "url": { "type": "string" },
        "overlay": { "type": "object", "description": "For open_overlay / swap_overlay", "properties": {
          "position": { "type": "string", "enum": ["center", "top_left", "top_center", "top_right", "bottom_left", "bottom_center", "bottom_right", "manual"] },
          "offsetX": { "type": "number", "description": "manual: x from the top-left of nodeId" },
          "offsetY": { "type": "number", "description": "manual: y from the top-left of nodeId" },
          "closeOnClickOutside": { "type": "boolean" },
          "background": { "type": ["string", "null"], "description": "Dim colour behind the overlay (hex, default #000000); null or \"none\" for no dimming" },
          "backgroundOpacity": { "type": "number", "description": "0-1, default 0.3" }
        } },
        "trigger": { "type": "string", "enum": ["click", "hover", "press", "delay"] },
        "transition": { "type": "string", "enum": ["instant", "dissolve", "smart_animate", "slide_left", "slide_right", "slide_up", "slide_down"] },
        "clear": { "type": "boolean", "description": "Remove existing interactions first" }
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
      "description": "Create or update a variable collection with modes (e.g. Light/Dark) and colour/number/string/boolean variables. Bind layer properties with bind: {fill: 'Theme/Background', cornerRadius: 'Radius/md'} in create_nodes/update_nodes (bindable: fill, stroke, cornerRadius, gap, padding, opacity, width, height, strokeWeight, fontSize, characters, visible), and switch a frame's mode with variableModes: {Theme: 'Dark'}. Bound variables become CSS variables in exported code.",
      "input_schema": { "type": "object", "properties": {
        "collection": { "type": "string" },
        "modes": { "type": "array", "items": { "type": "string" }, "description": "Mode names; the first is the default. Default: [\"Default\"]" },
        "variables": { "type": "array", "items": { "type": "object", "properties": {
          "name": { "type": "string" },
          "type": { "type": "string", "enum": ["color", "number", "string", "boolean"] },
          "value": { "description": "Same value in every mode" },
          "values": { "type": "object", "description": "Mode name → value" }
        }, "required": ["name", "type"] } }
      }, "required": ["collection", "variables"] }
    },
    {
      "name": "define_styles",
      "description": "Create shared colour and text styles (design tokens). Then link layers to them with fix_issues (kinds: [\"unlinkedStyle\"]).",
      "input_schema": { "type": "object", "properties": {
        "colors": { "type": "array", "items": { "type": "object", "properties": { "name": { "type": "string" }, "color": { "type": "string" } }, "required": ["name", "color"] } },
        "texts": { "type": "array", "items": { "type": "object", "properties": { "name": { "type": "string" }, "fontFamily": { "type": "string" }, "fontSize": { "type": "number" }, "fontWeight": { "type": "number" }, "lineHeight": { "type": "number" }, "letterSpacing": { "type": "number" } }, "required": ["name", "fontSize"] } }
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
      "description": "PNG screenshot of a layer (default: current selection or page) so you can visually verify the design.",
      "input_schema": { "type": "object", "properties": { "id": { "type": "string" }, "scale": { "type": "number", "description": "Default 1, max 2" } } }
    },
    {
      "name": "import_url",
      "description": "Load a live web page (through the local bridge) and convert it into editable layers. Good for redesigning an existing site.",
      "input_schema": { "type": "object", "properties": { "url": { "type": "string" }, "width": { "type": "number", "description": "Viewport width, default 1440" }, "x": { "type": "number" }, "y": { "type": "number" }, "autoLayout": { "type": "boolean", "description": "Map flex, grid and stacked blocks to auto layout (default true); false keeps absolutely positioned layers" } }, "required": ["url"] }
    },
    {
      "name": "import_html",
      "description": "Render an HTML+CSS snippet (inline styles or <style>) at a width and convert it into editable layers, with flex/grid/stacked blocks mapped to auto layout. Good for complex layouts.",
      "input_schema": { "type": "object", "properties": { "html": { "type": "string" }, "width": { "type": "number" }, "x": { "type": "number" }, "y": { "type": "number" }, "parentId": { "type": "string" }, "name": { "type": "string" }, "autoLayout": { "type": "boolean", "description": "Map flex, grid and stacked blocks to auto layout (default true); false keeps absolutely positioned layers" } }, "required": ["html"] }
    }
  ])
}

fn define_variables(e: &mut Engine, input: &Value) -> Result<Value, String> {
  use crate::variables::{Collection, VarKind, VarMode, Variable};
  let name = input.get("collection").and_then(|v| v.as_str()).ok_or("collection is required")?;
  let mut all = e.doc.variables.clone();
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
        coll.variables.push(Variable {
          id: e.gen.next("v_"),
          name: vname.clone(),
          ..Default::default()
        });
        coll.variables.len() - 1
      }
    };
    let var = &mut coll.variables[pos];
    var.kind = kind;
    let norm = |v: &Value| -> Value {
      match (kind, v.as_str()) {
        (VarKind::Color, Some(c)) => json!(crate::color::normalize(c)),
        _ => v.clone(),
      }
    };
    if let Some(v) = spec.get("value") {
      for m in &modes {
        var.values.insert(m.id.clone(), norm(v));
      }
    }
    if let Some(obj) = spec.get("values").and_then(|v| v.as_object()) {
      for (mk, v) in obj {
        let mode = modes
          .iter()
          .find(|m| &m.name == mk || &m.id == mk)
          .ok_or_else(|| format!("{vname}: no mode {mk}"))?;
        var.values.insert(mode.id.clone(), norm(v));
      }
    }
  }
  e.dispatch_inner(Command::SetVariables { collections: all })?;
  Ok(crate::variables::summary(&e.doc))
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
              m.insert("outline".into(), outline(e, id, depth));
              m.insert("absoluteBounds".into(), json!(e.doc.abs_bounds(id)));
            }
            v
          }
          None => json!({ "id": id, "error": "not found" }),
        })
        .collect();
      Ok(json!(out))
    }
    "create_nodes" => {
      let specs = input
        .get("nodes")
        .and_then(|v| v.as_array())
        .cloned()
        .ok_or("nodes must be an array")?;
      let created = insert_specs(e, &specs, input.get("parentId").and_then(|v| v.as_str()))?;
      Ok(json!({ "created": created }))
    }
    "update_nodes" => {
      let updates = input
        .get("updates")
        .and_then(|v| v.as_array())
        .cloned()
        .ok_or("updates must be an array")?;
      let mut done = Vec::new();
      for u in &updates {
        let id = u.get("id").and_then(|v| v.as_str()).ok_or("each update needs an id")?;
        let before = e.doc.get(id).cloned().ok_or_else(|| format!("no node {id}"))?;
        let mut after = before.clone();
        apply_spec(&mut after, u, false)?;
        if let Some(p) = u.get("patch") {
          crate::patch::apply(&mut after, p)?;
        }
        let diff = diff_patch(&before, &after);
        if !diff.as_object().map(|m| m.is_empty()).unwrap_or(true) {
          e.dispatch_inner(Command::Update {
            ids: vec![id.to_string()],
            patch: diff,
          })?;
        }
        done.push(id.to_string());
      }
      Ok(json!({ "updated": done }))
    }
    "delete_nodes" => {
      let ids = str_list(input.get("ids"));
      ops::delete(&mut e.doc, &ids);
      Ok(json!({ "deleted": ids }))
    }
    "move_nodes" => {
      let ids = str_list(input.get("ids"));
      if let (Some(x), Some(y)) = (num(input.get("x")), num(input.get("y"))) {
        for id in &ids {
          ops::move_abs_to(&mut e.doc, id, x, y);
        }
      }
      if input.get("parentId").is_some() || input.get("index").is_some() {
        let parent = input.get("parentId").and_then(|v| v.as_str()).map(String::from);
        let index = input.get("index").and_then(|v| v.as_u64()).map(|v| v as usize);
        e.dispatch_inner(Command::MoveToParent {
          ids: ids.clone(),
          parent,
          index,
        })?;
      }
      Ok(json!({ "moved": ids }))
    }
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
    "set_prototype" => {
      let id = input.get("nodeId").and_then(|v| v.as_str()).ok_or("nodeId required")?;
      if let Some(url) = input.get("url").and_then(|v| v.as_str()) {
        crate::model::safe_link(url).ok_or("url must be an http(s), mailto: or tel: link")?;
      }
      let action = match input.get("action").and_then(|v| v.as_str()).unwrap_or("navigate") {
        "back" => Action::Back,
        "open_url" => Action::OpenUrl,
        "open_overlay" => Action::OpenOverlay,
        "close_overlay" => Action::CloseOverlay,
        "swap_overlay" => Action::SwapOverlay,
        _ => Action::Navigate,
      };
      let destination = input.get("destinationId").and_then(|v| v.as_str()).map(String::from);
      if matches!(action, Action::OpenOverlay | Action::SwapOverlay) {
        let d = destination.as_deref().ok_or("destinationId (the overlay frame) is required")?;
        if e
          .doc
          .get(d)
          .map(|n| n.parent.is_some() || !matches!(n.kind, NodeType::Frame | NodeType::Component))
          .unwrap_or(true)
        {
          return Err("destinationId must be a top-level frame".into());
        }
      }
      let overlay = overlay_settings(input.get("overlay"))?;
      let trigger = match input.get("trigger").and_then(|v| v.as_str()).unwrap_or("click") {
        "hover" => Trigger::OnHover,
        "press" => Trigger::OnPress,
        "delay" => Trigger::AfterDelay,
        _ => Trigger::OnClick,
      };
      let transition = match input.get("transition").and_then(|v| v.as_str()).unwrap_or("dissolve") {
        "instant" => Transition::Instant,
        "smart_animate" => Transition::SmartAnimate,
        "slide_left" => Transition::SlideLeft,
        "slide_right" => Transition::SlideRight,
        "slide_up" => Transition::SlideUp,
        "slide_down" => Transition::SlideDown,
        _ => Transition::Dissolve,
      };
      let n = e.doc.get_mut(id).ok_or("no such node")?;
      if input.get("clear").and_then(|v| v.as_bool()).unwrap_or(false) {
        n.interactions.clear();
      }
      n.interactions.push(Interaction {
        trigger,
        delay_ms: 800.0,
        action,
        destination,
        url: input.get("url").and_then(|v| v.as_str()).map(String::from),
        transition,
        duration_ms: 300.0,
        overlay,
      });
      Ok(json!({ "ok": true }))
    }
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
    "define_styles" => {
      let mut ids = Vec::new();
      for c in input.get("colors").and_then(|v| v.as_array()).cloned().unwrap_or_default() {
        let name = c.get("name").and_then(|v| v.as_str()).unwrap_or("Color").to_string();
        let color = c.get("color").and_then(|v| v.as_str()).unwrap_or("#000000").to_string();
        let r = e.dispatch_inner(Command::AddColorStyle { name, color })?;
        ids.push(r["id"].clone());
      }
      for t in input.get("texts").and_then(|v| v.as_array()).cloned().unwrap_or_default() {
        let id = e.gen.next("s_");
        e.doc.styles.texts.push(crate::model::TextStyle {
          id: id.clone(),
          name: t.get("name").and_then(|v| v.as_str()).unwrap_or("Text").to_string(),
          font_family: t.get("fontFamily").and_then(|v| v.as_str()).unwrap_or("Inter").to_string(),
          font_size: num(t.get("fontSize")).unwrap_or(16.0),
          font_weight: num(t.get("fontWeight")).unwrap_or(400.0) as u32,
          line_height: num(t.get("lineHeight")),
          letter_spacing: num(t.get("letterSpacing")).unwrap_or(0.0),
        });
        ids.push(json!(id));
      }
      Ok(json!({ "created": ids }))
    }
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
      let format = input.get("format").and_then(|v| v.as_str()).unwrap_or("react");
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
    t if BROWSER_TOOLS.contains(&t) => Err(format!("{t} needs the Designotron editor open in a browser")),
    other => Err(format!("unknown tool '{other}'")),
  }
}

fn arrange(e: &mut Engine, input: &Value) -> Result<Value, String> {
  let ids = str_list(input.get("ids"));
  let action = input.get("action").and_then(|v| v.as_str()).unwrap_or("");
  let cmd = match action {
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
  }
  Ok(r)
}

/// Compact tree of the current page for the model.
pub fn summary(e: &Engine, depth: usize) -> Value {
  let page = e.doc.page(&e.page);
  let roots = page.map(|p| p.children.clone()).unwrap_or_default();
  json!({
    "document": e.doc.name,
    "pages": e.doc.pages.iter().map(|p| json!({ "id": p.id, "name": p.name, "current": p.id == e.page, "layers": p.children.len() })).collect::<Vec<_>>(),
    "currentPage": e.page,
    "selection": e.selection.iter().filter_map(|s| e.doc.get(s)).map(|n| json!({ "id": n.id, "type": n.kind, "name": n.name })).collect::<Vec<_>>(),
    "layers": roots.iter().map(|r| outline(e, r, depth)).collect::<Vec<_>>(),
    "components": e.doc.components().iter().map(|c| json!({ "id": c.id, "name": c.name, "width": c.width, "height": c.height })).collect::<Vec<_>>(),
    "colorStyles": e.doc.styles.colors,
    "variables": crate::variables::summary(&e.doc),
    "openComments": e.doc.comments.values().filter(|c| !c.resolved).count(),
    "nextFreeX": roots.iter().map(|r| e.doc.abs_bounds(r).right()).fold(0.0, f64::max) + if roots.is_empty() { 0.0 } else { 100.0 },
  })
}

fn outline(e: &Engine, id: &str, depth: usize) -> Value {
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
  if let Some(i) = &n.instance {
    m.insert("componentId".into(), json!(i.component_id));
  }
  if !n.children.is_empty() {
    if depth > 0 {
      m.insert(
        "children".into(),
        json!(n.children.iter().map(|c| outline(e, c, depth - 1)).collect::<Vec<_>>()),
      );
    } else {
      m.insert("childCount".into(), json!(n.children.len()));
    }
  }
  Value::Object(m)
}

fn round(v: f64) -> f64 {
  (v * 10.0).round() / 10.0
}

/// Inserts specs under `parent` (or the page root). Returns created root outlines.
pub fn insert_specs(e: &mut Engine, specs: &[Value], parent: Option<&str>) -> Result<Vec<Value>, String> {
  if let Some(p) = parent {
    let pn = e.doc.get(p).ok_or_else(|| format!("no parent {p}"))?;
    if !pn.kind.is_container() {
      return Err(format!("{p} is a {} and cannot have children", pn.kind.label()));
    }
  }
  let page = parent
    .and_then(|p| e.doc.get(p))
    .map(|n| n.page.clone())
    .unwrap_or_else(|| e.page.clone());
  let mut roots = Vec::new();
  for spec in specs {
    let id = build(e, spec, parent, &page)?;
    roots.push(id);
  }
  for r in &roots {
    settle_fill_in_hug(&mut e.doc, r);
  }
  crate::layout::relayout_all(&mut e.doc, e.measurer.as_ref());
  Ok(roots.iter().map(|r| outline(e, r, 2)).collect())
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

fn build(e: &mut Engine, spec: &Value, parent: Option<&str>, page: &str) -> Result<NodeId, String> {
  let kind_str = spec.get("type").and_then(|v| v.as_str()).unwrap_or("frame").to_lowercase();
  if kind_str == "instance" {
    let comp = spec
      .get("componentId")
      .and_then(|v| v.as_str())
      .ok_or("instance needs componentId")?;
    let (x, y) = (num(spec.get("x")).unwrap_or(0.0), num(spec.get("y")).unwrap_or(0.0));
    let id =
      crate::components::create_instance(&mut e.doc, comp, parent, page, x, y, &mut e.gen).ok_or("componentId is not a component")?;
    let mut n = e.doc.get(&id).cloned().unwrap();
    apply_spec(&mut n, spec, true)?;
    let before = e.doc.get(&id).cloned().unwrap();
    let diff = diff_patch(&before, &n);
    *e.doc.get_mut(&id).unwrap() = n;
    crate::components::record_override(&mut e.doc, &id, &diff);
    return Ok(id);
  }
  let kind = parse_kind(&kind_str)?;
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
  apply_spec(&mut n, spec, true)?;
  if kind_str == "image" && n.fills.is_empty() {
    n.fills = vec![Paint::solid("#E5E7EB")];
  }
  let id = n.id.clone();
  e.doc.insert(n, parent, page, None);
  // An empty list is fine on any layer (models often send `children: []` everywhere).
  if let Some(children) = spec.get("children").and_then(|v| v.as_array()).filter(|c| !c.is_empty()) {
    if !kind.is_container() {
      return Err(format!("{} layers cannot have children; use a frame", kind.label()));
    }
    for c in children {
      build(e, c, Some(&id), page)?;
    }
  }
  Ok(id)
}

fn parse_kind(s: &str) -> Result<NodeType, String> {
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
    other => return Err(format!("unknown layer type '{other}'")),
  })
}

/// Applies friendly spec properties onto a node.
pub fn apply_spec(n: &mut Node, s: &Value, creating: bool) -> Result<(), String> {
  if let Some(v) = s.get("name").and_then(|v| v.as_str()) {
    n.name = v.to_string();
  }
  if let Some(v) = num(s.get("x")) {
    n.x = v;
  }
  if let Some(v) = num(s.get("y")) {
    n.y = v;
  }
  apply_dimension(n, s.get("width"), true);
  apply_dimension(n, s.get("height"), false);
  if let Some(v) = num(s.get("rotation")) {
    n.rotation = v;
  }
  if let Some(v) = num(s.get("opacity")) {
    n.opacity = v.clamp(0.0, 1.0);
  }
  if let Some(v) = s.get("visible").and_then(|v| v.as_bool()) {
    n.visible = v;
  }
  if let Some(v) = s.get("locked").and_then(|v| v.as_bool()) {
    n.locked = v;
  }
  if let Some(v) = s.get("clip").and_then(|v| v.as_bool()) {
    n.clip_content = v;
  }
  if let Some(v) = s.get("absolute").and_then(|v| v.as_bool()) {
    n.absolute_position = v;
  }
  for (key, slot) in [
    ("minWidth", &mut n.min_width),
    ("maxWidth", &mut n.max_width),
    ("minHeight", &mut n.min_height),
    ("maxHeight", &mut n.max_height),
  ] {
    if let Some(v) = s.get(key) {
      *slot = num(Some(v)).filter(|v| *v > 0.0);
    }
  }
  if let Some(b) = s.get("bind").and_then(|v| v.as_object()) {
    for (prop, var) in b {
      if crate::variables::property_kind(prop).is_none() {
        return Err(format!("{prop} can't be bound to a variable"));
      }
      match var.as_str() {
        Some(name) => n.bindings.insert(prop.clone(), name.to_string()),
        None => n.bindings.remove(prop),
      };
    }
  }
  if let Some(m) = s.get("variableModes").and_then(|v| v.as_object()) {
    for (coll, mode) in m {
      match mode.as_str() {
        Some(name) => n.variable_modes.insert(coll.clone(), name.to_string()),
        None => n.variable_modes.remove(coll),
      };
    }
  }
  if let Some(v) = s.get("layoutGrids") {
    n.layout_grids = serde_json::from_value(v.clone()).map_err(|e| format!("layoutGrids: {e}"))?;
  }
  if let Some(v) = s.get("notes").and_then(|v| v.as_str()) {
    n.notes = v.to_string();
  }
  let text_kind = n.kind == NodeType::Text;
  // Text colour goes to fills on text layers.
  let fill_key = if text_kind && s.get("color").is_some() {
    s.get("color")
  } else {
    s.get("fill").or(s.get("background"))
  };
  if let Some(f) = fill_key {
    n.fills = parse_fills(f)?;
  }
  if let Some(f) = s.get("fills") {
    n.fills = parse_fills(f)?;
  }
  if let Some(url) = s.get("imageUrl").or(s.get("src")).and_then(|v| v.as_str()) {
    n.fills = vec![Paint::Image {
      src: url.to_string(),
      scale_mode: ScaleMode::Fill,
      opacity: 1.0,
      visible: true,
    }];
  }
  if let Some(st) = s.get("stroke") {
    n.strokes = parse_fills(st)?;
    if creating && s.get("strokeWidth").is_none() && n.stroke_weight == 0.0 {
      n.stroke_weight = 1.0;
    }
  }
  if let Some(v) = num(s.get("strokeWidth")) {
    n.stroke_weight = v;
  }
  if let Some(v) = s.get("strokeAlign").and_then(|v| v.as_str()) {
    n.stroke_align = match v {
      "center" => StrokeAlign::Center,
      "outside" => StrokeAlign::Outside,
      _ => StrokeAlign::Inside,
    };
  }
  if let Some(arr) = s.get("strokeDash").and_then(|v| v.as_array()) {
    n.stroke_dash = arr.iter().filter_map(|v| v.as_f64()).collect();
  }
  match s.get("cornerRadius") {
    Some(Value::Number(r)) => {
      n.corner_radius = r.as_f64().unwrap_or(0.0);
      n.corner_radii = None;
    }
    Some(Value::Array(a)) if a.len() == 4 => {
      let r: Vec<f64> = a.iter().map(|v| v.as_f64().unwrap_or(0.0)).collect();
      n.corner_radii = Some([r[0], r[1], r[2], r[3]]);
    }
    _ => {}
  }
  if let Some(sh) = s.get("shadow") {
    n.effects
      .retain(|e| !matches!(e.kind, EffectType::DropShadow | EffectType::InnerShadow));
    let list = match sh {
      Value::Array(a) => a.clone(),
      Value::Null => vec![],
      other => vec![other.clone()],
    };
    for e in list {
      n.effects.push(Effect {
        kind: if e.get("inset").and_then(|v| v.as_bool()).unwrap_or(false) {
          EffectType::InnerShadow
        } else {
          EffectType::DropShadow
        },
        color: crate::color::normalize(e.get("color").and_then(|v| v.as_str()).unwrap_or("#00000026")),
        x: num(e.get("x")).unwrap_or(0.0),
        y: num(e.get("y")).unwrap_or(4.0),
        blur: num(e.get("blur")).unwrap_or(12.0),
        spread: num(e.get("spread")).unwrap_or(0.0),
        visible: true,
      });
    }
  }
  if let Some(b) = num(s.get("blur")) {
    n.effects.retain(|e| e.kind != EffectType::LayerBlur);
    if b > 0.0 {
      n.effects.push(Effect {
        kind: EffectType::LayerBlur,
        blur: b,
        ..Default::default()
      });
    }
  }
  if let Some(b) = num(s.get("backgroundBlur")) {
    n.effects.retain(|e| e.kind != EffectType::BackgroundBlur);
    if b > 0.0 {
      n.effects.push(Effect {
        kind: EffectType::BackgroundBlur,
        blur: b,
        ..Default::default()
      });
    }
  }
  if let Some(l) = s.get("layout") {
    if l.is_null() || l.as_bool() == Some(false) {
      n.layout = None;
    } else {
      let mut al = n.layout.clone().unwrap_or(AutoLayout {
        gap: 0.0,
        padding_top: 0.0,
        padding_right: 0.0,
        padding_bottom: 0.0,
        padding_left: 0.0,
        ..Default::default()
      });
      if let Some(d) = l.get("direction").and_then(|v| v.as_str()) {
        al.direction = if matches!(d, "horizontal" | "row" | "x") {
          LayoutDirection::Horizontal
        } else {
          LayoutDirection::Vertical
        };
      }
      if let Some(g) = num(l.get("gap")) {
        al.gap = g;
        al.counter_gap = g;
      }
      if let Some(g) = num(l.get("counterGap")) {
        al.counter_gap = g;
      }
      if let Some(p) = l.get("padding") {
        let [t, r, b, lft] = parse_box(p);
        al.padding_top = t;
        al.padding_right = r;
        al.padding_bottom = b;
        al.padding_left = lft;
      }
      if let Some(a) = l.get("align").or(l.get("justify")).and_then(|v| v.as_str()) {
        al.primary_align = parse_align(a);
      }
      if let Some(a) = l.get("crossAlign").or(l.get("alignItems")).and_then(|v| v.as_str()) {
        al.counter_align = parse_align(a);
      }
      if let Some(w) = l.get("wrap").and_then(|v| v.as_bool()) {
        al.wrap = w;
      }
      let fresh = n.layout.is_none();
      n.layout = Some(al);
      if fresh && creating {
        if !matches!(s.get("width"), Some(Value::Number(_)) | Some(Value::String(_))) {
          n.sizing_h = Sizing::Hug;
        }
        if !matches!(s.get("height"), Some(Value::Number(_)) | Some(Value::String(_))) {
          n.sizing_v = Sizing::Hug;
        }
      }
    }
  }
  if text_kind {
    let t = n.text.get_or_insert_with(Default::default);
    if let Some(v) = s.get("text").or(s.get("characters")).and_then(|v| v.as_str()) {
      t.characters = v.to_string();
      if creating && s.get("name").is_none() {
        n.name = v.chars().take(40).collect();
      }
    }
    if let Some(spans) = s.get("spans").and_then(|v| v.as_array()) {
      let (characters, runs) = spans_to_runs(spans)?;
      if creating && s.get("name").is_none() {
        n.name = characters.chars().take(40).collect();
      }
      let t = n.text.as_mut().unwrap();
      t.characters = characters;
      t.runs = runs;
    }
    let t = n.text.as_mut().unwrap();
    if let Some(v) = num(s.get("fontSize")) {
      t.font_size = v;
    }
    if let Some(v) = num(s.get("fontWeight")) {
      t.font_weight = v as u32;
    }
    if let Some(v) = s.get("fontFamily").and_then(|v| v.as_str()) {
      t.font_family = v.to_string();
    }
    if let Some(v) = num(s.get("lineHeight")) {
      t.line_height = Some(if v < 4.0 { v * t.font_size } else { v });
    }
    if let Some(v) = num(s.get("letterSpacing")) {
      t.letter_spacing = v;
    }
    if let Some(v) = s.get("italic").and_then(|v| v.as_bool()) {
      t.italic = v;
    }
    if let Some(v) = s.get("textAlign").and_then(|v| v.as_str()) {
      t.align_h = match v {
        "center" => TextAlignH::Center,
        "right" => TextAlignH::Right,
        "justify" => TextAlignH::Justify,
        _ => TextAlignH::Left,
      };
    }
    if let Some(v) = s.get("verticalAlign").and_then(|v| v.as_str()) {
      t.align_v = match v {
        "middle" | "center" => TextAlignV::Middle,
        "bottom" => TextAlignV::Bottom,
        _ => TextAlignV::Top,
      };
    }
    if let Some(v) = s.get("textCase").and_then(|v| v.as_str()) {
      t.case = match v {
        "upper" => TextCase::Upper,
        "lower" => TextCase::Lower,
        "title" => TextCase::Title,
        _ => TextCase::Original,
      };
    }
    if let Some(v) = s.get("decoration").and_then(|v| v.as_str()) {
      t.decoration = match v {
        "underline" => TextDecoration::Underline,
        "strikethrough" | "line-through" => TextDecoration::Strikethrough,
        _ => TextDecoration::None,
      };
    }
    match s.get("width") {
      Some(Value::Number(_)) => t.auto_resize = TextAutoResize::Height,
      Some(Value::String(w)) if w == "fill" => t.auto_resize = TextAutoResize::Height,
      _ => {}
    }
    if let Some(v) = s.get("autoResize").and_then(|v| v.as_str()) {
      t.auto_resize = match v {
        "none" | "fixed" => TextAutoResize::None,
        "height" => TextAutoResize::Height,
        _ => TextAutoResize::Width,
      };
    }
    if let Some(v) = s.get("maxLines") {
      t.max_lines = num(Some(v)).filter(|v| *v >= 1.0).map(|v| v as u32);
    }
    if let Some(v) = s.get("truncate").and_then(|v| v.as_bool()) {
      t.truncate = v;
    }
    if let Some(v) = num(s.get("paragraphSpacing")) {
      t.paragraph_spacing = v.max(0.0);
    }
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
  if let Some(v) = num(s.get("pointCount")) {
    n.shape.get_or_insert_with(Default::default).point_count = v as u32;
  }
  Ok(())
}

/// `[{text, fontWeight, ...}]` to characters plus style runs.
fn spans_to_runs(spans: &[Value]) -> Result<(String, Vec<crate::model::TextRun>), String> {
  let mut text = String::new();
  let mut runs = Vec::new();
  for sp in spans {
    let piece = sp.get("text").and_then(|v| v.as_str()).unwrap_or("");
    let start = text.chars().count();
    text.push_str(piece);
    let end = text.chars().count();
    let decoration = sp.get("decoration").and_then(|v| v.as_str()).map(|d| match d {
      "underline" => TextDecoration::Underline,
      "strikethrough" | "line-through" => TextDecoration::Strikethrough,
      _ => TextDecoration::None,
    });
    runs.push(crate::model::TextRun {
      start,
      end,
      font_family: sp.get("fontFamily").and_then(|v| v.as_str()).map(String::from),
      font_size: num(sp.get("fontSize")),
      font_weight: num(sp.get("fontWeight")).map(|v| v as u32),
      italic: sp.get("italic").and_then(|v| v.as_bool()),
      color: sp.get("color").and_then(|v| v.as_str()).map(crate::color::normalize),
      decoration,
      letter_spacing: num(sp.get("letterSpacing")),
      link: match sp.get("link").and_then(|v| v.as_str()) {
        Some(url) => Some(crate::model::safe_link(url).ok_or("a span link must be an http(s), mailto: or tel: link")?),
        None => None,
      },
    });
  }
  let len = text.chars().count();
  crate::text::normalize_runs(&mut runs, len);
  Ok((text, runs))
}

fn apply_dimension(n: &mut Node, v: Option<&Value>, horizontal: bool) {
  let Some(v) = v else { return };
  let sizing = match v {
    Value::Number(x) => {
      let x = x.as_f64().unwrap_or(0.0);
      if horizontal {
        n.width = x;
      } else {
        n.height = if n.kind == NodeType::Line { 0.0 } else { x };
      }
      Sizing::Fixed
    }
    Value::String(s) if s == "fill" || s == "100%" => Sizing::Fill,
    Value::String(s) if s == "hug" || s == "auto" => Sizing::Hug,
    _ => return,
  };
  if horizontal {
    n.sizing_h = sizing;
  } else {
    n.sizing_v = sizing;
  }
}

fn parse_align(s: &str) -> Align {
  match s {
    "center" | "middle" => Align::Center,
    "end" | "right" | "bottom" | "flex-end" => Align::End,
    "space-between" | "between" => Align::SpaceBetween,
    "baseline" => Align::Baseline,
    _ => Align::Start,
  }
}

fn parse_box(v: &Value) -> [f64; 4] {
  match v {
    Value::Number(n) => [n.as_f64().unwrap_or(0.0); 4],
    Value::Array(a) => {
      let f: Vec<f64> = a.iter().map(|x| x.as_f64().unwrap_or(0.0)).collect();
      match f.len() {
        1 => [f[0]; 4],
        2 => [f[0], f[1], f[0], f[1]],
        3 => [f[0], f[1], f[2], f[1]],
        4 => [f[0], f[1], f[2], f[3]],
        _ => [0.0; 4],
      }
    }
    Value::Object(o) => {
      let g = |k: &str| o.get(k).and_then(|v| v.as_f64()).unwrap_or(0.0);
      [g("top"), g("right"), g("bottom"), g("left")]
    }
    _ => [0.0; 4],
  }
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
    Value::Object(_) => serde_json::from_value::<Paint>(v.clone())
      .map(|p| vec![p])
      .map_err(|e| format!("invalid paint: {e}")),
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
    return Ok(Some(Paint::LinearGradient {
      stops: parse_stops(stops_src),
      angle,
      opacity: 1.0,
      visible: true,
    }));
  }
  if let Some(inner) = t.strip_prefix("radial-gradient(").and_then(|r| r.strip_suffix(')')) {
    let parts = split_top_level(inner);
    let stops_src: Vec<String> = parts
      .into_iter()
      .filter(|p| crate::color::parse(p.split_whitespace().next().unwrap_or("")).is_some())
      .collect();
    return Ok(Some(Paint::RadialGradient {
      stops: parse_stops(&stops_src),
      opacity: 1.0,
      visible: true,
    }));
  }
  let c = crate::color::parse(t).ok_or_else(|| format!("unrecognised colour '{t}'"))?;
  Ok(Some(Paint::Solid {
    color: c.hex6(),
    opacity: c.a,
    visible: true,
  }))
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
    for (k, v) in am {
      if bm.get(&k) != Some(&v) {
        out.insert(k, v);
      }
    }
  }
  Value::Object(out)
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
        &json!({ "nodeId": btn, "action": "swap_overlay", "destinationId": modal,
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
