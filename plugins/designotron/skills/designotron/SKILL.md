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

1. Call `get_document` first to see pages, frames and existing components, variables and
   styles, so you build on what is there instead of duplicating it. Skip it on a page you
   know is empty.
2. For a new design, define tokens before you build: colours with `define_variables` (a
   Light and a Dark mode when a theme or dark mode is asked for) and the type scale with
   `define_styles`, in the same message. Apply them while building: `bind` for variables,
   `textStyle` for text styles and `fillStyle` for colour styles (never a variable name).
   Raw hex only where no token fits. Reuse the file's existing variables, styles and
   components before defining new ones.
3. Create screens as top-level frames (for example 1440 wide for desktop, 390 for
   mobile) placed to the right of existing content. Use auto layout (`add_auto_layout`, or
   `layout` in `create_nodes`) for every stack and row; absolute positions only for
   overlays and decoration. Name layers semantically (Header, Nav, Card, Button, Input)
   because code export reads the names.
4. Anything that appears twice or more with the same structure (cards, list rows, nav
   items, buttons, inputs, table rows) is a component, not a copy: build it once as
   `type: "component"` (or `create_component`), keep it on the canvas beside the screens,
   and place instances (`type: "instance"` or `create_instance`). The states of one
   control (default, hover, error, disabled) are variants: `combine_variants`. Give
   components Boolean (show/hide a layer), Text and Instance swap properties with
   `set_component_props`; set the copy of every instance with one `set_component_props`
   call, and code export turns the properties into React props.
5. Dark mode or another theme: duplicate the frame and set `variableModes` (for example
   `{Theme: "Dark"}`) on the copy. Don't recolour by hand.
6. Use real copy and consistent spacing (multiples of 4 or 8).
7. Link screens with `set_prototype` when the person asks for a flow or prototype (`open_overlay` / `swap_overlay` / `close_overlay` for modals, menus and sheets).
8. Finish a new design: if the page had nothing else on it before you started, call
   `fix_issues` once (it lints itself); otherwise call `lint_design` and fix only your new
   layers with `update_nodes`, because `fix_issues` changes the whole page. Then take one
   `get_screenshot` of the new frame (when available): fix only clear defects, and take no
   second screenshot unless the layout changed.
9. To build the design as an app, use `export_code` (React + Tailwind) and refine the
   generated project.

For changes to existing layers do only what was asked: no new tokens or components, no
`fix_issues`, at most one screenshot, and don't retrofit existing layers unless asked.
Build every screen and state that was asked for, and say briefly what you changed.
