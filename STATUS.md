# Status

Last updated: 2026-10-18. Keep this file current: move items between sections in the same
change that finishes, starts or breaks them.

## In progress

- Working through [ROADMAP.md](ROADMAP.md) in order. Next: variables and modes.

## To do

Ordered by impact on "replace Figma for a small team".

| #  | Item                                   | Notes                                                                 |
|----|----------------------------------------|-----------------------------------------------------------------------|
| 1  | Real-time multiplayer                  | CRDT (Yjs/Automerge or a Rust CRDT) over the bridge or a hosted relay |
| 2  | Accounts, cloud files, sharing links   | Needs a hosted backend; today files are local (IndexedDB + `.dtron`)  |
| 3  | Comments                               | Pins on canvas, threads, mentions; needs (2) for teams                |
| 4  | Cloud version history                  | Local named/auto versions shipped; sync them once files are in the cloud |
| 6  | Live boolean groups                    | Booleans are destructive today (one vector); keep the inputs editable |
| 7  | Performance for large files            | Incremental render, canvas/WebGL path, persistent maps for undo       |
| 8  | Figma file import                      | `.fig` / Figma REST API JSON to Designotron model                     |
| 9  | Variables and modes                    | Colour/number/string tokens with light/dark modes                     |
| 10 | Vector editing completeness            | Add/delete points, bend tool, renormalise bounds after edits          |
| 12 | Smart animate                          | Interpolate matching layers between frames (currently a dissolve)     |
| 13 | Plugin API                             | Sandboxed JS plugins over the same Command/Query surface              |
| 14 | Canvas gradient and image-crop handles | Edit gradients and crops directly on the canvas                       |
| 15 | Auto layout extras                     | Min/max width, baseline alignment, per-child margins                  |
| 16 | Auto layout inference for HTML import  | Map flex/grid containers to auto layout instead of absolute layers    |
| 17 | Enable the hosted editor               | Workflow exists; repo owner must set Settings → Pages → GitHub Actions |
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
| Import          | HTML/CSS to editable layers (`import_html` tool and File menu), live websites by URL (`import_url`)  |
| Distribution    | Single `designotron` binary with the editor embedded, release workflow (5 targets), `install.sh`, `npx designotron`, Pages workflow |
| Onboarding      | Template gallery (mobile, landing, dashboard, design system), first-run tour, empty-file prompt      |
| Text            | Mixed styles inside one text layer (font, size, weight, italic, colour, decoration, links); ⌘B/I/U  |
| Code export     | Semantic tags (h1–h3, button, nav, header, …), `<img>` for image layers, responsive roots           |
| Review          | Design lint (contrast, tiny text, clipped text, off-grid, tap targets, names, near-duplicate colours, unlinked styles) with one-click and bulk fixes; Claude critique |
| Claude actions  | Paste/drop/attach images in chat (both modes), quick actions (flows, variants, responsive, dark mode, content, rename, code sync, tokens from code), "Rebuild as editable layers" on image layers |
| Versions        | History tab: named versions, automatic version every 10 min of editing, restore (undoable), rename, duplicate as file |
| Precision       | Rulers (⇧R) with selection extents, page guides dragged from rulers (move, drag back to delete), layout grids on frames (columns/rows/grid, ⇧⌘4), snapping to guides and grid lines |
| Vector ops      | Union, subtract, intersect, exclude (i_overlay), flatten keeping curves, outline stroke (inside/center/outside), use as mask (alpha masks, ⌥⌘M); SVG path parser for imported icons |
| Live app        | App tab: write the generated project to `workspace/app` (or keep it in sync), run `npm run dev` through the bridge, preview at mobile/desktop width, logs, "Ask Claude to fix it" |
| Docs            | AGENTS.md, STATUS.md, ROADMAP.md, README                                                             |

## What works (verified)

Verified on 2026-10-18 in this repo's environment (headless Chromium, Claude Code 2.1.302).

| Check                                                  | How it was verified                          |
|--------------------------------------------------------|----------------------------------------------|
| 65 engine + bridge unit tests                          | `cargo test --workspace`                     |
| Files dashboard, sample file, canvas render            | `web/scripts/e2e.mjs`                        |
| Draw rectangle, drag, undo, property updates           | `web/scripts/e2e.mjs`                        |
| Text tool, Shift+A auto layout, ⌥⌘K component, pen    | `web/scripts/e2e.mjs`                        |
| React and project export                               | `web/scripts/e2e.mjs`                        |
| AI `create_nodes`, `get_screenshot`, `import_html`     | `web/scripts/e2e.mjs`                        |
| Presenter hotspots and prototype navigation            | `web/scripts/e2e.mjs`                        |
| Autosave survives reload, Claude panel opens           | `web/scripts/e2e.mjs`                        |
| Templates, tour, empty prompt, ⌘B on a word, Review fixes | `web/scripts/e2e.mjs`                     |
| Chat image attachment and quick actions menu           | `web/scripts/e2e.mjs`                        |
| Ruler guide drag, layout grid overlay, version restore | `web/scripts/e2e.mjs`                        |
| Boolean subtract from the toolbar, mask rendering      | `web/scripts/e2e.mjs` (36/36 passing)        |
| Production build served by the bridge                  | `E2E_URL=http://127.0.0.1:5174 npm run e2e`  |
| Release binaries download and serve the editor         | `install.sh` and `npx designotron` on Linux  |
| Exported Landing/Dashboard projects build and match    | `tsc` + `vite build`, compared screenshots   |
| MCP initialize, tools/list, tools/call (headless)      | curl against the bridge                      |
| MCP rejects foreign `Origin` and `Host`                | curl (403) + `security.rs` tests             |
| MCP call edits the live editor and is undoable         | `web/scripts/bridge-e2e.mjs`                 |
| MCP `get_screenshot` returns a PNG from the editor     | `web/scripts/bridge-e2e.mjs`                 |
| `import_url` fetches a page through the bridge         | `web/scripts/bridge-e2e.mjs`                 |
| App tab writes, installs, runs and stops the app       | `web/scripts/bridge-e2e.mjs`                 |
| In-app chat through local Claude Code uses the tools   | `bridge-e2e.mjs` with `E2E_CLAUDE=1`         |

Not verified here: API-key chat mode against the live API (no key in this environment). The
code follows the SDK's streaming tool-loop pattern and type-checks, but treat it as untested
until someone runs it with a real key.

## What doesn't work yet / known limitations

| Area             | Limitation                                                                                               |
|------------------|----------------------------------------------------------------------------------------------------------|
| Collaboration    | Single user. No multiplayer, accounts, sharing or comments; versions live only in this browser           |
| Storage          | Files live in the browser (IndexedDB). Clearing site data deletes them; save `.dtron` files to keep them |
| Scale            | Each change re-renders the page as SVG and snapshots the document; thousands of layers will feel slow    |
| Text             | No OpenType features or per-range line height; widths depend on the web font having loaded               |
| URL import       | Scripts don't run, so sites rendered by JavaScript come in mostly empty; very long pages make many layers |
| Headless text    | Bridge headless mode measures text with a heuristic, so layout can differ slightly from the editor       |
| Strokes          | Inside/outside alignment is exact for rectangles/ellipses; other shapes clip or fall back to center      |
| Effects          | Background blur is not drawn on the canvas (exported to code as `backdrop-filter`)                       |
| Vectors          | Can move points and handles, cannot add/delete points; boolean results are flattened (not live) and curves become polylines; text can't be flattened |
| Masks in code    | A frame or group containing a mask is exported to code as inline SVG                                     |
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
| Version history            | Local       | Named + automatic, per browser          |
| Plugins                    | No          | MCP covers AI automation today          |
| AI                         | Yes         | Claude Code (Pro/Max) and API key       |
