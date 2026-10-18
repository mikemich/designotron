# Status

Last updated: 2026-10-18. Keep this file current: move items between sections in the same
change that finishes, starts or breaks them.

## In progress

- Nothing actively in progress. Pick the next item from **To do**.

## To do

Ordered by impact on "replace Figma for a small team".

| #  | Item                                   | Notes                                                                 |
|----|----------------------------------------|-----------------------------------------------------------------------|
| 1  | Real-time multiplayer                  | CRDT (Yjs/Automerge or a Rust CRDT) over the bridge or a hosted relay |
| 2  | Accounts, cloud files, sharing links   | Needs a hosted backend; today files are local (IndexedDB + `.dtron`)  |
| 3  | Comments                               | Pins on canvas, threads, mentions; needs (2) for teams                |
| 4  | Version history                        | Named snapshots in IndexedDB first, cloud later                       |
| 5  | Mixed text styles                      | Per-range font, weight, colour, links inside one text layer           |
| 6  | Boolean operations, flatten, masks     | Union/subtract/intersect/exclude, outline stroke, mask groups         |
| 7  | Performance for large files            | Incremental render, canvas/WebGL path, persistent maps for undo       |
| 8  | Figma file import                      | `.fig` / Figma REST API JSON to Designotron model                     |
| 9  | Variables and modes                    | Colour/number/string tokens with light/dark modes                     |
| 10 | Vector editing completeness            | Add/delete points, bend tool, renormalise bounds after edits          |
| 11 | Layout grids, rulers, guides           | Column/row grids on frames, draggable guides                          |
| 12 | Smart animate                          | Interpolate matching layers between frames (currently a dissolve)     |
| 13 | Plugin API                             | Sandboxed JS plugins over the same Command/Query surface              |
| 14 | Canvas gradient and image-crop handles | Edit gradients and crops directly on the canvas                       |
| 15 | Auto layout extras                     | Min/max width, baseline alignment, per-child margins                  |
| 16 | Auto layout inference for HTML import  | Map flex/grid containers to auto layout instead of absolute layers    |
| 17 | Hosted build of the editor             | Static deploy (GitHub Pages); bridge stays local                      |
| 18 | Desktop app packaging                  | Tauri shell bundling the editor and bridge                            |
| 19 | Touch and tablet input                 | Pinch zoom, pen pressure                                              |

## Done

| Area            | What shipped                                                                                         |
|-----------------|------------------------------------------------------------------------------------------------------|
| Engine (Rust)   | Serde document model, pages, undo/redo with gesture coalescing, JSON merge-patch edits               |
| Layout          | Auto layout (direction, gap, padding, alignment, space-between, wrap), hug/fill/fixed, constraints   |
| Components      | Main components, instances with stable ids, overrides, reset/detach, variants (component sets)       |
| Canvas          | Pan/zoom, Figma-style picking and drill-down, marquee, move/resize/rotate, smart-guide snapping      |
| Tools           | Frame, rectangle, ellipse, line, arrow, polygon, star, pen, pencil, text, image, hand                |
| Editing         | In-place text editing, vector point/handle editing, alt-drag duplicate, drop into frames, clipboard  |
| Panels          | Layers tree (drag reorder, rename, lock, hide), pages, assets, design/prototype/code tabs            |
| Styling         | Multiple fills/strokes, solid/linear/radial/image paints, effects (shadows, blurs), blend, opacity    |
| Tokens          | Colour styles and text styles with apply/propagate                                                   |
| Prototyping     | Click/hover/press/delay triggers, navigate/back/URL, transitions, flow start, presenter mode         |
| Export          | PNG/JPG/SVG (fonts embedded), React + Tailwind, HTML, full Vite project zip with working navigation  |
| Files           | Dashboard, IndexedDB autosave with thumbnails, `.dtron` open/save, sample file                       |
| Claude (API)    | In-browser tool loop with the user's key, screenshots fed back to Claude, refusal fallback enabled   |
| Claude Code     | Bridge spawns the user's `claude` CLI (Pro/Max login) for in-app chat with live tool chips           |
| MCP             | `designotron` MCP server for Claude Code in any terminal; headless mode edits `design.dtron.json`    |
| Import          | HTML/CSS to editable layers (`import_html` tool and File menu)                                       |
| Docs            | AGENTS.md, STATUS.md, README                                                                        |

## What works (verified)

Verified on 2026-10-18 in this repo's environment (headless Chromium, Claude Code 2.1.302).

| Check                                                  | How it was verified                          |
|--------------------------------------------------------|----------------------------------------------|
| 39 engine + bridge unit tests                          | `cargo test --workspace`                     |
| Files dashboard, sample file, canvas render            | `web/scripts/e2e.mjs`                        |
| Draw rectangle, drag, undo, property updates           | `web/scripts/e2e.mjs`                        |
| Text tool, Shift+A auto layout, ⌥⌘K component, pen    | `web/scripts/e2e.mjs`                        |
| React and project export                               | `web/scripts/e2e.mjs`                        |
| AI `create_nodes`, `get_screenshot`, `import_html`     | `web/scripts/e2e.mjs`                        |
| Presenter hotspots and prototype navigation            | `web/scripts/e2e.mjs`                        |
| Autosave survives reload, Claude panel opens           | `web/scripts/e2e.mjs` (22/22 passing)        |
| Production build served by the bridge (same 22 checks)| `E2E_URL=http://127.0.0.1:5174 npm run e2e`  |
| MCP initialize, tools/list, tools/call (headless)      | curl against the bridge                      |
| MCP rejects foreign `Origin` and `Host`                | curl (403) + `security.rs` tests             |
| MCP call edits the live editor and is undoable         | `web/scripts/bridge-e2e.mjs`                 |
| MCP `get_screenshot` returns a PNG from the editor     | `web/scripts/bridge-e2e.mjs`                 |
| In-app chat through local Claude Code uses the tools   | `bridge-e2e.mjs` with `E2E_CLAUDE=1`         |

Not verified here: API-key chat mode against the live API (no key in this environment). The
code follows the SDK's streaming tool-loop pattern and type-checks, but treat it as untested
until someone runs it with a real key.

## What doesn't work yet / known limitations

| Area             | Limitation                                                                                               |
|------------------|----------------------------------------------------------------------------------------------------------|
| Collaboration    | Single user. No multiplayer, accounts, sharing, comments or version history                              |
| Storage          | Files live in the browser (IndexedDB). Clearing site data deletes them; save `.dtron` files to keep them |
| Scale            | Each change re-renders the page as SVG and snapshots the document; thousands of layers will feel slow    |
| Text             | One style per text layer; no OpenType features; widths depend on the web font having loaded             |
| Headless text    | Bridge headless mode measures text with a heuristic, so layout can differ slightly from the editor       |
| Strokes          | Inside/outside alignment is exact for rectangles/ellipses; other shapes clip or fall back to center      |
| Effects          | Background blur is not drawn on the canvas (exported to code as `backdrop-filter`)                       |
| Vectors          | Can move points and handles, cannot add/delete points; no boolean ops, masks or outline stroke           |
| Components       | Overrides on nested instances through an outer instance are not preserved; variant swap drops overrides  |
| Multi-resize     | Resizing several rotated layers at once approximates their new boxes                                     |
| Prototyping      | Smart animate plays as a dissolve; no overlays, scroll-to or variables                                   |
| Images           | External `http` image URLs render on canvas but are missing from PNG export (assets are fine)            |
| HTML import      | Produces absolutely positioned layers; flex/grid is not mapped to auto layout                            |
| Bridge sync      | If MCP edits happen with no editor open, reopening an older tab overwrites `design.dtron.json`           |
| Security         | API key (API mode) is stored in this browser's localStorage                                              |
| Input            | No touch/pen support; editor UI accessibility (keyboard-only, screen readers) is minimal                 |
| Figma            | No `.fig` import; FigJam, Slides, Dev Mode annotations and plugins are not implemented                   |

## Figma parity snapshot

| Figma feature              | Designotron | Notes                                   |
|----------------------------|-------------|-----------------------------------------|
| Frames, shapes, text, pen  | Yes         |                                         |
| Auto layout                | Mostly      | No min/max, baseline                    |
| Constraints                | Yes         |                                         |
| Components and variants    | Yes         | Nested override limits                  |
| Styles                     | Partial     | Colour + text; no effect/grid styles    |
| Variables                  | No          |                                         |
| Prototyping                | Partial     | No smart animate/overlays               |
| Export                     | Yes         | Plus code export Figma lacks            |
| Dev Mode / inspect         | Partial     | Code tab, notes                         |
| Multiplayer, comments      | No          | Top of the to-do list                   |
| Version history            | No          |                                         |
| Plugins                    | No          | MCP covers AI automation today          |
| AI                         | Yes         | Claude Code (Pro/Max) and API key       |
