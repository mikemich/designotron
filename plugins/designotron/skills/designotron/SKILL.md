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
   on what is there instead of duplicating it. Skip it on a page you know is empty.
2. Define tokens before you build, every time: colours with `define_variables` (a Light
   and a Dark mode when a theme or dark mode is asked for) and the type scale with
   `define_styles`. Apply them while building: `bind` for variables, `textStyle` and
   `fillStyle` (a style name) for styles. Raw hex only where no token fits.
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
   `set_component_props`; instances set them, and code export turns them into React props.
5. Dark mode or another theme: duplicate the frame and set `variableModes` (for example
   `{Theme: "Dark"}`) on the copy. Don't recolour by hand.
6. Use real copy and consistent spacing (multiples of 4 or 8).
7. Link screens with `set_prototype` when the person asks for a flow or prototype (`open_overlay` / `swap_overlay` / `close_overlay` for modals, menus and sheets).
8. Finish with `lint_design` and `fix_issues`, then one `get_screenshot` (when available):
   compare it with what was asked and fix spacing, alignment and contrast.
9. To build the design as an app, use `export_code` (React + Tailwind) and refine the
   generated project.

Keep edits focused: change only what was asked, and build every screen and state that was
asked for. Reply in at most three short plain-text sentences (under 50 words, no Markdown
headings or lists) saying what you built and anything you left out.
