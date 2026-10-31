# Status

Last updated: 2026-10-30. Keep this file current: move items between sections in the same
change that finishes, starts or breaks them.

## In progress

- Roadmap phases 1–3 and most of 4 are done. Next steps and the launch checklist are in [ROADMAP.md](ROADMAP.md#next).
- Figma parity programme (from QA round 6): Waves 1 and 2 are done (below). Wave 3 is next: prototyping depth, presence (follow, spotlight, view-only live links), variables and styles extras, paint and vector tools, pages/tools/accessibility, and code/inspect. Performance follow-ups: a render cache below the top-level layer (a file inside one huge frame gets no culling or partial saves), per-layer bridge pushes and auto versions.

## To do

Ordered by impact on "replace Figma for a small team".

| #  | Item                                   | Notes                                                                 |
|----|----------------------------------------|-----------------------------------------------------------------------|
| 1  | Run a public relay                     | Free: Deploy to Render button (`render.yaml`) + `DT_RELAY_URL`; always-on: `relay-deploy.yml` to Fly. Someone has to click one. Per-property merging instead of per-layer |
| 2  | Accounts, cloud files, sharing links   | Needs a hosted backend; today files are local (IndexedDB + `.dtron`)  |
| 3  | Comment extras                         | Mentions and notifications; shared with teammates once (1)/(2) land   |
| 4  | Cloud version history                  | Local named/auto versions shipped; sync them once files are in the cloud |
| 6  | Live boolean groups                    | Booleans are destructive today (one vector); keep the inputs editable |
| 7  | Faster painting of huge files          | Engine and DOM updates are incremental; a canvas/WebGL renderer would cut paint cost at 10k+ layers |
| 8  | Figma import extras                    | `.fig` binary files, variables/styles from the Figma API, library components |
| 9  | Variable extras                        | Aliases in the editor UI, scoping, per-page modes, prototyping with variables |
| 10 | Vector editing completeness            | Bend tool, join/split paths, corner radius per point                  |
| 12 | Smart animate                          | Interpolate matching layers between frames (currently a dissolve)     |
| 13 | Plugin sharing                         | Install plugins from a URL or a community list; plugin manifests and permissions |
| 14 | Canvas gradient and image-crop handles | Edit gradients and crops directly on the canvas                       |
| 15 | Auto layout extras                     | Per-child margins; a fill child on a hug axis behaves as hug for user edits too (changes saved layouts, needs a release note); min/max clamping of manual resizes |
| 17 | Enable the hosted editor               | Workflow exists; repo owner must set Settings → Pages → GitHub Actions |
| 18 | Desktop app packaging                  | Tauri shell bundling the editor and bridge                            |
| 19 | Touch and tablet input                 | Pinch zoom, pen pressure                                              |

## Done

| Area            | What shipped                                                                                         |
|-----------------|------------------------------------------------------------------------------------------------------|
| Engine (Rust)   | Serde document model, pages, undo/redo with gesture coalescing, JSON merge-patch edits               |
| Layout          | Auto layout (direction, gap, padding, alignment, space-between, wrap), hug/fill/fixed, constraints   |
| Components      | Main components, instances with stable ids, overrides (also on instances nested in a main component, set through the outer instance, and a nested instance swapped through it; they survive main edits, save/load, undo and multiplayer), reset/detach, variants (component sets); a component can't be made to contain itself (instance placement, moves, paste, swaps; pasting a copy of a main into its own main is fine, it becomes a new component), swap instance (panel and context menu; overrides on layers with the same name path carry over to the new variant or component), add variant, rename variant properties and values; pasting an instance into another file brings its main component |
| QA round 6, Wave 1 | Autosave: one serialised save at a time, "Saved locally" only after a finished write of the current document revision (`docRev`; selection and no-op relayouts never write), thumbnails saved separately, failed writes show "Not saved, retrying" and keep a recovery copy, saves at least every 4 s (10 s for big files) under continuous editing, closing with unsaved work prompts. Picking: a lone selected top-level frame no longer captures clicks and drags on its children (auto layout children can be dragged to reorder); Assets click places at the viewport centre and drop at the pointer, never inside a main component. Undo/redo are three-way per property (also inside nested objects), per page field and per style or variable id, so a collaborator's newer value is never overwritten; redo restores the page and selection. Multiplayer heartbeat (ping every 10 s) shows "Reconnecting…" on a dead or offline connection without false drops in throttled background tabs. Share links say which editor they open (`localStorage["dt:editorUrl"]` overrides it) with "Preview here". Prototypes: one start-frame rule everywhere (flow start → first frame → first component; deleting the start clears it), flow starts only on top-level frames/components, "Missing destination" for links to deleted frames, While pressing acts on press and reverts on release (mouse, touch, one pointer), Enter commits the link URL, view links of files without frames show the page. Export: crops include strokes, shadows (1.5×blur + spread), blurs, overflowing fixed-size text and stop at masks; inner shadows and canvas filter regions match; oversized exports scale down to 16384 px / 268 Mpx with a toast; SVG export has no scale; SVG paste with a prolog/DOCTYPE/entities works; colour styles only from solid fills; `*/` escaped in CSS notes |
| QA round 6, Wave 2 | Alt-hover measurement to the hovered layer (red lines and distances in document px; Alt over the selection measures to its parent's inner edges) and equal-spacing snapping with pink gap markers (aligned siblings only; off in auto layout and for Alt/aspect resizes). Auto layout min/max width and height (hug and fill respect them; a hug frame with wrap wraps at its max width), text truncation with max lines, paragraph spacing, text links (⌘K; `http`, `https`, `mailto`, `tel` only), baseline alignment; long words break by character; Claude's `create_nodes` settles fill children of a hug axis to hug or fixed. Component properties: Boolean (layer visibility), Text and Instance swap on components and sets, bound to layers ("Apply component property"), set from the instance panel (edits to a bound layer inside an instance change the property), carried across variant swaps, exposed from nested instances, copied with variants that leave their set, AI `set_component_props`, React props in code export. Export rows per layer (format, scale or fixed width/height of the layer's own box, suffix; mixed selections show "Mixed export settings"; zip downloads keep `/` as folders and number duplicates), Copy as PNG/SVG/CSS, copy/paste properties (⌥⌘C/⌥⌘V), paste to replace (⇧⌘R). Storage failures outside autosave (create, rename, duplicate, delete, versions, remix, leave, Figma import cancel) show an error and reset the UI; a file that can't be read offers Try again; the view-only player's Remix opens on this editor. Multiplayer syncs pages, styles and variables per id (two people editing different ones both keep their change; older relays and editors fall back to whole lists); a document always keeps at least one page; undo restores the order of variables, collections, styles and pages |
| Big files (Wave 2) | Canvas level of detail (text under 5 px on screen drawn as bars, and all text while zooming a page with 400+ texts in view), layers outside the view hidden from layout, text widths cached in the engine, selection no longer triggers document listeners or saves. Saving writes one IndexedDB record per top-level layer plus a manifest in one transaction (older single-record files convert on their first edit): a write only builds on the manifest this tab last wrote, otherwise the whole file is written (last writer wins, never a mix); a plan made while a write is unfinished includes what that write changed; an older plan is never written after a newer one; a reopened file waits up to 15 s for the closing editor's last save and older editors' later saves are ignored; a missing layer record opens the rest, names it, and the next save repairs the file; a failed write retries (memory only when IndexedDB can't be used at all). 20k layers: Ctrl+wheel p95 ~450–530 → ~170–250 ms, Shift+Arrow longest task ~170–250 → ~60–140 ms, no autosave long tasks, reopen ~11 → ~9 s |
| Styles          | Colour and text styles: create, rename, edit in place (`UpdateColorStyle`, `UpdateTextStyle`), delete; style chips with detach in Fill and Text |
| Canvas          | Pan/zoom, Figma-style picking and drill-down, marquee, move/resize/rotate, smart-guide snapping      |
| Tools           | Frame, rectangle, ellipse, line, arrow, polygon, star, pen, pencil, text, image, hand                |
| Editing         | In-place text editing, vector point/handle editing (add, delete, sharp/smooth, marquee select, box refits after edits), alt-drag duplicate, drop into frames, clipboard  |
| Panels          | Layers tree (drag reorder, rename, lock, hide), pages, assets, design/prototype/code tabs            |
| Styling         | Multiple fills/strokes, solid/linear/radial/image paints, effects (shadows, blurs), blend, opacity    |
| Tokens          | Colour styles and text styles with apply/propagate                                                   |
| Prototyping     | Click/hover/press/delay triggers, navigate/back/URL, transitions, flow start, presenter mode; overlays (open/close/swap, 8 positions, close on outside click, background dim; stack, Escape and Back close the top one; dashed links on the canvas; AI `set_prototype`; same player in view links and embeds; code export keeps them as an overlay stack in `App.tsx`) |
| Export          | PNG/JPG/SVG (fonts embedded), React + Tailwind, HTML, full Vite project zip with working navigation  |
| Files           | Dashboard, IndexedDB autosave with thumbnails, `.dtron` open/save, sample file                       |
| Claude (API)    | In-browser tool loop with the user's key, screenshots fed back to Claude, refusal fallback enabled   |
| Claude Code     | Bridge spawns the user's `claude` CLI (Pro/Max login) for in-app chat with live tool chips           |
| MCP             | `designotron` MCP server for Claude Code in any terminal; headless mode edits `design.dtron.json`    |
| Import          | HTML/CSS to editable layers (`import_html` tool and File menu), live websites by URL (`import_url`); flex, grid and stacked blocks become auto layout (`autoLayout: false` keeps absolute layers) |
| Distribution    | Single `designotron` binary with the editor embedded, release workflow (5 targets, version from the tag), `install.sh` (also installs the background service), `npx designotron` (not on npm yet), Pages workflow, Fly relay deploy workflow |
| Background bridge | `designotron service install\|uninstall\|status`: launchd agent on macOS, systemd user unit on Linux, with the installing shell's PATH so `claude` is found; running `designotron` while it runs just opens the editor; the Claude panel shows setup steps while the bridge is offline |
| Growth loops    | Guests who open a shared link see who they're editing with, a "Make my own copy" button (keeps the file as theirs and leaves the room) and a GitHub star link; Share dialog hides the relay field when one is built in, with Copy feedback and the native Invite sheet; link previews (Open Graph/Twitter card, `web/public/og.png`); Star link on the dashboard; Share → Send a copy: a link with the whole file gzipped into its `#fragment` (`web/src/snapshot.ts`, no server; images dropped past ~400 KB), opened as the recipient's own file; view-only links (`#/view/…`, the prototype player with a Remix button and "Made with Designotron"), iframe embed code and an "Open in Designotron" README badge (`web/public/badge.svg`); a narrated demo replay of Claude building a landing page for visitors who haven't connected Claude (`web/src/Demo.tsx`, one undo step); Claude Code plugin marketplace (`/plugin install designotron --marketplace mikemich/designotron`); launch kit in `docs/launch.md` |
| Onboarding      | Template gallery (mobile, landing, dashboard, design system), empty-file prompt that queues the first Claude prompt until Claude is connected, one-time contextual hints (layers, design panel, Claude) instead of a tour, loading splash; the dashboard renders before the WASM engine loads |
| Phones          | Drawing tools hidden; hand tool by default, pinch to zoom and two-finger pan, comments, presenting, Claude as a full-screen sheet, a note that editing is best on a computer |
| Text            | Mixed styles inside one text layer (font, size, weight, italic, colour, decoration, links); ⌘B/I/U  |
| Code export     | Semantic tags (h1–h3, button, nav, header, …), `<img>` for image layers, responsive roots           |
| Review          | Design lint (contrast, tiny text, clipped text, off-grid, tap targets, names, near-duplicate colours, unlinked styles) with one-click and bulk fixes; Claude critique |
| Claude actions  | Paste/drop/attach images in chat (both modes), quick actions (flows, variants, responsive, dark mode, content, rename, code sync, tokens from code), "Rebuild as editable layers" on image layers |
| Versions        | History tab: named versions, automatic version every 10 min of editing, restore (undoable), rename, duplicate as file |
| Precision       | Rulers (⇧R) with selection extents, page guides dragged from rulers (move, drag back to delete), layout grids on frames (columns/rows/grid, ⇧⌘4), snapping to guides and grid lines |
| Vector ops      | Union, subtract, intersect, exclude (i_overlay), flatten keeping curves, outline stroke (inside/center/outside), use as mask (alpha masks, ⌥⌘M); SVG path parser for imported icons |
| Variables       | Collections with modes, colour/number/string/boolean variables (editor dialog), bindings for fill, stroke, radius, gap, padding, opacity, size, font size, text, visibility; per-frame modes inherited by children and instances; `tokens.css` + `var(--…)` + `data-<collection>` attributes in exported code; `define_variables`/`bind`/`variableModes` for Claude |
| Figma import    | File → Import from Figma (link + personal access token, or a saved REST JSON): pages, frames, auto layout, constraints, components/variants, instances with recovered overrides, mixed text, vectors from Figma geometry, gradients, images (downloaded into the file), effects, masks, prototype links |
| Performance     | Persistent node map (O(1) snapshots), diff-driven layout/component sync, per-root canvas render cache with transform-only moves, document deltas to JS, contained canvas layout |
| Comments        | Comment tool (C), pins that follow their layer, threads with replies, resolve/reopen, Comments tab; Claude reads them (`get_comments`), replies and resolves; "Ask Claude to address them" |
| Plugins         | Sandboxed iframe plugins (opaque origin) with a promise API over the same tools Claude uses, optional UI panel, one undo step per run; built-in examples; manager with editor; Claude writes plugins via `save_plugin` |
| Online sharing  | `designotron-relay` (crates/relay, Docker image, Fly/Render configs, GHCR workflow, release binaries) hosts rooms on the internet and serves the editor; Share → Online gives a link anyone can open; rooms saved to disk survive restarts, and on a relay without a disk (free Render) reconnecting editors put the file back. Hardened for a 512 MB host: memory budget over rooms and connection buffers (idle rooms unloaded LRU, then "relay is busy" for new rooms/joins; active rooms never dropped), per-address connection and new-room limits (HTTP 429, `X-Forwarded-For` behind `DESIGNOTRON_TRUST_PROXY`), per-connection message rate (presence dropped, changes slowed, flooding disconnected), slow readers disconnected instead of buffered, message size capped at the file limit; `/health` reports memory; the editor backs off when refused |
| Multiplayer     | Share (toolbar) hosts a live session through the bridge: secret LAN link (token-guarded listener that serves only the editor and the room), node-level deltas, tree repair for concurrent structure edits, selective undo that never reverts others' work, live cursors, selections, avatars, synced comments and images |
| Live app        | App tab: write the generated project to `workspace/app` (or keep it in sync), run `npm run dev` through the bridge, preview at mobile/desktop width, logs, "Ask Claude to fix it" |
| Docs            | AGENTS.md, STATUS.md, ROADMAP.md, README with screenshots and demo GIF (`web/scripts/media.mjs`), CONTRIBUTING, issue and PR templates |

## What works (verified)

Verified on 2026-10-26 in this repo's environment (headless Chromium, Claude Code 2.1.302).

| Check                                                  | How it was verified                          |
|--------------------------------------------------------|----------------------------------------------|
| 287 engine, bridge, rooms and relay tests (incl. randomised collaboration simulation) | `cargo test --workspace` |
| QA round 6 fixes and Wave 2 features: measurement/spacing, auto layout min/max and text, component properties, export rows and copy-as, storage errors and per-id multiplayer | `web/scripts/qa/w1b-e2e.mjs`, `w1d-e2e.mjs`, `export-e2e.mjs`, `autosave-e2e.mjs`, `w2a-e2e.mjs`, `w2b-e2e.mjs`, `w2c-e2e.mjs`, `w2e-e2e.mjs`; with `E2E_RELAY=…`: `W1-C-e2e.mjs`, `w2f-e2e.mjs`, `w2d-e2e.mjs` (big-file level of detail, culling, layered saving and save races) |
| Files dashboard, sample file, canvas render            | `web/scripts/e2e.mjs`                        |
| Draw rectangle, drag, undo, property updates           | `web/scripts/e2e.mjs`                        |
| Text tool, Shift+A auto layout, ⌥⌘K component, pen    | `web/scripts/e2e.mjs`                        |
| React and project export                               | `web/scripts/e2e.mjs`                        |
| AI `create_nodes`, `get_screenshot`, `import_html`     | `web/scripts/e2e.mjs`                        |
| HTML import auto layout inference (pure functions)     | `web/src/ai/htmlLayout.test.ts` (`npm test`) |
| Presenter hotspots and prototype navigation            | `web/scripts/e2e.mjs`                        |
| Prototype overlays (modal, menu, swap, stack, Escape, view link) | `web/scripts/overlays-e2e.mjs`     |
| Autosave survives reload, Claude panel opens           | `web/scripts/e2e.mjs`                        |
| Templates, tour, empty prompt, ⌘B on a word, Review fixes | `web/scripts/e2e.mjs`                     |
| Chat image attachment and quick actions menu           | `web/scripts/e2e.mjs`                        |
| Ruler guide drag, layout grid overlay, version restore | `web/scripts/e2e.mjs`                        |
| Boolean subtract from the toolbar, mask rendering      | `web/scripts/e2e.mjs`                        |
| Variables dialog, fill binding, frame mode switch      | `web/scripts/e2e.mjs`                        |
| Figma JSON import through the dialog                   | `web/scripts/e2e.mjs`                        |
| Comment on a layer, Claude replies and resolves        | `web/scripts/e2e.mjs`                        |
| Plugins: one undo step, UI panel, sandbox escape fails | `web/scripts/e2e.mjs` (42/42 passing)        |
| Two browsers: join by link, edits both ways, selective undo, cursors, comments, bad token refused | `web/scripts/collab-e2e.mjs` (9/9) |
| Same 9 checks online through the relay, locally and in the Docker image; with `E2E_RELAY_BIN` also a relay restart (rooms lost, editors put the file back) | `E2E_RELAY=… [E2E_RELAY_BIN=…] node scripts/collab-e2e.mjs` |
| Relay: rooms, late joiners, restart persistence, bad room ids | `cargo test -p designotron-relay`  |
| Relay limits: idle rooms unloaded over the memory budget (saved first, reload from disk), new rooms refused when full of active ones, per-address connections → 429 (forged `X-Forwarded-For` ignored), new rooms per hour → 429, presence dropped / changes slowed / flooding disconnected, slow readers disconnected, `/health` memory | `cargo test -p designotron-relay -p designotron-rooms` |
| Bridge reaches api.figma.com and real sites via proxy  | curl `/bridge/figma` (403 for a bad token), `/bridge/fetch` |
| Engine: drag step 0.13 ms, edit 0.3 ms on 6k layers    | `cargo run --release -p designotron-engine --example bench` (was 42 ms / 46 ms) |
| Browser drag on 6k layers: ~10 ms script, ~1 ms layout per frame | `web/scripts/perf.mjs` on the production build (was 25 ms script + 80 ms layout) |
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
| Background service | Linux unit tested; the macOS launchd agent hasn't been run on a real Mac yet. Windows has no background service (run `designotron.exe`) |
| Collaboration    | The public relay is a free Render instance (sleeps when idle, first share wakes it in up to a minute); concurrent edits to the same property of a layer, style, variable mode value or page field: the one the relay receives last wins (different ones both stick, and everyone ends up with the same file; older relays fall back to last writer wins per layer and per whole list); a collection's modes and a page's layer order travel whole; relays older than Wave 2 reject files and changes that use baseline alignment, so update the relay before editors use it; links are the only access control (no accounts); versions live only in each browser. Relay limits stop single clients, not distributed abuse; messages still uploading aren't counted in the memory budget; on the free relay one large file with several people can fill the budget on its own (WebSocket buffers keep a copy's worth per editor), so it caps shared files at 20 MB |
| Storage          | Files live in the browser (IndexedDB). Clearing site data deletes them; save `.dtron` files to keep them. A file whose content sits in one huge top-level frame rewrites that frame on every save; auto versions (every 10 min) and the bridge document push still serialise the whole file; two tabs saving one file at once end with one tab's document, whole; a Duplicate from the files list while the file's last save is still writing can miss the last edits |
| Scale            | Updates are incremental, but the canvas is one big SVG: painting 10k+ layers zoomed out is the limit. Text under 5 px on screen is drawn as bars and off-screen top-level layers aren't laid out; at 20k layers zoom p95 is ~200 ms and a few selection clicks still exceed 50 ms in software rendering |
| Text             | No OpenType features or per-range line height; widths depend on the web font having loaded               |
| URL import       | Scripts don't run, so sites rendered by JavaScript come in mostly empty; very long pages make many layers |
| Headless text    | Bridge headless mode measures text with a heuristic, so layout can differ slightly from the editor       |
| Strokes          | Inside/outside alignment is exact for rectangles/ellipses; other shapes clip or fall back to center      |
| Effects          | Background blur is not drawn on the canvas (exported to code as `backdrop-filter`)                       |
| Vectors          | Edit mode adds points (click a segment, exact Bézier split; segments only a few pixels long still take one in their middle, because anchors there shrink their hit area and hide their control handles until selected), deletes points (select, Delete), toggles sharp/smooth (double-click) and continues open paths with the pen; no bend tool yet; inside auto layout the box refit after an edit is overwritten by the layout; boolean results are flattened (not live) and curves become polylines; text can't be flattened |
| Masks in code    | A frame or group containing a mask is exported to code as inline SVG                                     |
| Components       | Layers are matched on a swap by their name path (repeated names pair up in order): an override on a layer the new component lacks, or whose name changed, is dropped; an edit that puts back the main component's value counts as no override |
| Components       | An instance swapped concurrently by two people can show a mix of both variants' layers (changes merge field by field) until it is next re-synced; everyone, and the relay, sees the same thing. Of two concurrent changes to one instance's component, overrides or property values the later in the relay's order wins as a whole. Component properties have no preferred values; bound layers inside an instance can't be bound again; only an instance placed directly in a main component can expose its properties; Figma import doesn't bring component properties |
| Multi-resize     | Resizing several rotated layers at once approximates their new boxes                                     |
| Prototyping      | Smart animate plays as a dissolve; no scroll-to or variables; text links aren't clickable in Presenter or the view link; overlays always render at the frame's design size and don't scroll |
| Images           | External `http` image URLs render on canvas but are missing from PNG export (assets are fine)            |
| HTML import      | Auto layout is only used where the engine reproduces the browser's boxes within 2px: uneven margins between siblings, per-child `align-self`, proportional `flex-grow`, inline text runs, fr-based grid sizing and tables stay absolute or fixed-size |
| Bridge sync      | If MCP edits happen with no editor open, reopening an older tab overwrites `design.dtron.json`           |
| Security         | API key (API mode) is stored in this browser's localStorage                                              |
| Input            | No touch/pen support; editor UI accessibility (keyboard-only, screen readers) is minimal                 |
| Figma            | Import needs the REST API (no `.fig` files); library components become frames; fonts missing locally fall back; FigJam and Slides are not implemented |
| Plugins          | Run in a sandboxed iframe; browsers that keep it in the editor's process (not Chromium) freeze the tab if a plugin loops forever. A plugin that stops answering is flagged with Stop |
| Figma API        | Not tested against a real Figma account here (no token); the converter is tested on REST-shaped JSON     |

## Figma parity snapshot

| Figma feature              | Designotron | Notes                                   |
|----------------------------|-------------|-----------------------------------------|
| Frames, shapes, text, pen  | Yes         |                                         |
| Auto layout                | Yes         | Min/max, wrap, baseline; no per-child margins |
| Constraints                | Yes         |                                         |
| Components and variants    | Yes         | Boolean/text/instance swap properties; overrides follow layer names on swap |
| Styles                     | Partial     | Colour + text; no effect/grid styles    |
| Variables                  | Yes         | Modes, bindings, CSS variables; no aliasing UI |
| Prototyping                | Partial     | No smart animate/scroll-to              |
| Export                     | Yes         | Plus code export Figma lacks            |
| Dev Mode / inspect         | Partial     | Code tab, notes                         |
| Multiplayer, comments      | Yes         | Online via relay or LAN; comments Claude can resolve |
| Version history            | Local       | Named + automatic, per browser          |
| Plugins                    | Yes         | Sandboxed JS over the AI tool API; no store yet |
| AI                         | Yes         | Claude Code (Pro/Max) and API key       |
