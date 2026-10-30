---
name: designotron
description: Design with Designotron, a free open-source Figma-style editor, through its MCP server "designotron". Use when the user asks to design, mock up, edit or critique a UI, screen, flow, component or design system, or to turn a design into code, and Designotron is running.
---

# Designing with Designotron

Designotron is a design editor (frames, auto layout, components, variables, prototypes)
whose open file you can read and change through the `designotron` MCP tools. The person
watches your changes appear live in the editor.

## Before you start

The tools need the Designotron bridge running on this computer (it serves
`http://127.0.0.1:5174`). If the tools fail to connect, tell the person to install and
start it:

```bash
curl -fsSL https://raw.githubusercontent.com/mikemich/designotron/main/install.sh | sh
```

then open the editor at http://127.0.0.1:5174 (or https://mikemich.github.io/designotron).

## How to work

1. Call `get_document` first to see pages, frames and existing components, so you build
   on what is there instead of duplicating it.
2. Create screens as top-level frames (for example 1440 wide for desktop, 390 for
   mobile) placed to the right of existing content. Use auto layout (`add_auto_layout`, or
   `layout` in `create_nodes`) for anything list- or stack-shaped so it resizes cleanly.
3. Make repeated elements components (`create_component`) and use instances
   (`create_instance`); combine states into variants with `combine_variants`. Give
   components Boolean (show/hide a layer), Text and Instance swap properties with
   `set_component_props`; instances set them, and code export turns them into React props.
4. Use real copy, consistent spacing (multiples of 4 or 8) and a small palette. Define
   colours and type as styles or variables (`define_styles`, `define_variables`) when you
   create a design system.
5. Link screens with `set_prototype` when the person asks for a flow or prototype (`open_overlay` / `swap_overlay` / `close_overlay` for modals, menus and sheets).
6. Check your work: take a screenshot of what you made (`get_screenshot` when available),
   compare it with what was asked, and fix spacing, alignment and contrast. `lint_design`
   finds common problems and `fix_issues` applies the fixes.
7. To build the design as an app, use `export_code` (React + Tailwind) and refine the
   generated project.

Keep edits focused: change only what was asked, and say briefly what you changed.
