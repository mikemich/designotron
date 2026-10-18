# Designotron

A free, open-source design tool in the spirit of Figma, with Claude built in, from first
sketch to a running app.

- **Design**: frames, vector tools, auto layout, constraints, components and variants,
  styles, effects, prototyping with a presenter, PNG/SVG export.
- **Claude, your way**: chat in the editor through your own **Claude Code** install, so it
  runs on your **Claude Pro or Max** plan. You can also bring an API key. Claude edits the
  canvas live, takes screenshots to check its work, and imports HTML as layers.
- **Design to real code**: export React + Tailwind components, or a complete Vite project
  where prototype links become working navigation. Or ask Claude Code to build it in your
  workspace.
- **MCP server**: your designs are available to Claude Code in any terminal.

The engine is Rust, compiled to WebAssembly for the editor and linked natively into a small
local bridge server. See [STATUS.md](STATUS.md) for what works today and what is planned.

## Quick start

Requirements: Node 20+ and Rust (stable). The prebuilt WASM engine is committed, so you only
need the WASM toolchain when you change the engine.

```bash
git clone https://github.com/mikemich/designotron
cd designotron
./dev.sh
```

Open http://localhost:5173 and pick **Open sample**.

`dev.sh` starts the bridge on `127.0.0.1:5174` and the editor dev server on `:5173`. Without
the bridge the editor still works; only Claude Code chat and MCP need it.

## Using Claude

### With your Claude Pro or Max plan (Claude Code)

1. Install [Claude Code](https://code.claude.com) and sign in once: run `claude`, then `/login`.
2. Run `./dev.sh`. The bridge finds your `claude` CLI.
3. In the editor, press `⌘/` (or click **Claude**), choose **Claude Code · Pro/Max** and ask
   for something like "Design a 3-screen onboarding flow with prototype links".

The bridge runs `claude -p` in the `workspace/` folder with the editor attached as an MCP
server, so usage counts against whatever Claude Code is signed in with. Designotron never
sees your credentials. File edits inside `workspace/` and a short list of commands
(`npm`, `npx`, `node`, `ls`, `mkdir`, `cat`) are pre-approved. Add more with
`DESIGNOTRON_ALLOWED_TOOLS`.

### From your own terminal (MCP)

With the bridge running:

```bash
claude mcp add --transport http designotron http://127.0.0.1:5174/mcp
```

Claude Code now has `get_document`, `create_nodes`, `update_nodes`, `get_screenshot`,
`export_code` and the rest. Changes appear live in the open editor. With no editor open, the
tools edit `workspace/design.dtron.json` directly.

### With an API key

In the Claude panel choose **API key**, open settings and paste a key. Requests go straight
from your browser to the Anthropic API using the official SDK. The default model is Claude
Opus 5.5 with adaptive thinking, and server-side refusal fallback is enabled. The key is
stored in this browser's localStorage.

## Design to code

- **Code tab**: React + Tailwind, HTML/CSS, CSS or SVG for the selected layer.
- **Export code** (toolbar): a zip with a Vite + React + Tailwind project. Each top-level
  frame becomes a screen, components become React components, and prototype links become
  navigation.
- **Build with Claude Code** (Code tab): asks Claude Code to turn the design into a
  production-quality app in `workspace/`, run the build, and report back.

## Production build

```bash
cd web && npm run build      # outputs web/dist
cd .. && cargo run -p designotron-bridge --release
```

The bridge serves `web/dist`, so everything runs at http://127.0.0.1:5174.

## Keyboard shortcuts

| Action                 | Shortcut          | Action               | Shortcut        |
|------------------------|-------------------|----------------------|-----------------|
| Move                   | V                 | Group / ungroup      | ⌘G / ⇧⌘G        |
| Frame                  | F or A            | Frame selection      | ⌥⌘G             |
| Rectangle / ellipse    | R / O             | Auto layout          | ⇧A              |
| Line / arrow           | L / ⇧L            | Create component     | ⌥⌘K             |
| Pen / pencil           | P / ⇧P            | Detach instance      | ⌥⌘B             |
| Text                   | T                 | Duplicate            | ⌘D              |
| Hand (or hold Space)   | H                 | Bring forward / back | ⌘] / ⌘[         |
| Zoom to fit / select   | ⇧1 / ⇧2           | Align left/right/…   | ⌥A ⌥D ⌥W ⌥S     |
| Zoom 100%              | ⇧0                | Flip H / V           | ⇧H / ⇧V         |
| Undo / redo            | ⌘Z / ⇧⌘Z          | Hide / lock          | ⇧⌘H / ⇧⌘L       |
| Claude panel           | ⌘/                | Save `.dtron`        | ⌘S              |

## Architecture

```
┌──────────── browser ────────────┐        ┌────── bridge (Rust, 127.0.0.1:5174) ──────┐
│ React shell  ⇄  engine (WASM)   │◀─ ws ─▶│ editor relay · MCP server · headless engine│
│ canvas · panels · chat          │        │ spawns `claude -p` (Pro/Max or API key)    │
└─────────────────────────────────┘        └──────────────▲─────────────────────────────┘
                                                          │ MCP (HTTP)
                                                   Claude Code in any terminal
```

- `crates/engine`: document model, commands and undo, layout, components, rendering, code
  generation and the AI tool layer
- `crates/engine-wasm`: WebAssembly bindings
- `crates/bridge`: the local server
- `web`: the editor UI

Contributors and coding agents: read [AGENTS.md](AGENTS.md).

## File format

`.dtron` files are JSON: `{ "format": "designotron", "version": 1, "document": {...}, "assets": {...} }`.
The document schema is defined in `crates/engine/src/model.rs`.

## License

MIT
