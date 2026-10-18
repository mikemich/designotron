# Roadmap

How Designotron gets from a working v1 to a tool people switch to. [STATUS.md](STATUS.md)
tracks the detailed state; this file is the strategy and the order of work.

## Positioning

Do not pitch "a free Figma clone". Figma is free to start and very good; a clone loses.
Pitch what Figma structurally cannot be:

> **The design tool for people who build with Claude.** Open source, local-first, and
> designs that turn into working code. Claude Code designs in it, and you design with
> Claude.

Three promises, in this order:

1. **Design → working app in one click** (already true; make it excellent).
2. **AI-native**: Claude designs, critiques and edits beside you, using your own Pro/Max
   plan, with no extra subscription.
3. **Yours**: free, open source, files on your disk, works offline, scriptable over MCP.

## Where it stands

| Works today                                          | Weak or missing                                        |
|------------------------------------------------------|--------------------------------------------------------|
| Core vector editing, auto layout, constraints        | One text style per layer (no bold word mid-sentence)   |
| Components, variants, overrides                      | No multiplayer, sharing, comments or version history   |
| Prototyping + presenter                              | No Figma import, so switching costs are high           |
| React/Tailwind/HTML export, full project zip         | Generated code is correct but mechanical               |
| Claude chat via Claude Code (Pro/Max) and API key    | Large files will get slow (full SVG re-render)         |
| MCP server for Claude Code in any terminal           | Install needs Rust + Node; no hosted version           |
| Local files with autosave, `.dtron` format           | No boolean ops, masks, rulers, layout grids            |

## Phase 1: Make the first ten minutes great (weeks 1-3)

Goal: someone who has never seen it gets a "wow" moment before they close the tab.

| Item                                   | Why                                                            |
|----------------------------------------|----------------------------------------------------------------|
| Hosted editor (GitHub Pages / Vercel)  | Try without installing anything; the bridge stays optional     |
| `npx designotron` one-line install     | Prebuilt bridge binaries per OS, no Rust needed                |
| First-run onboarding                   | 3-step guided tour; "Describe an app" prompt on an empty file  |
| Templates gallery                      | Landing page, dashboard, mobile app, design system starters    |
| Fix everything found in real use       | Every bug a new user hits in minute one costs a user           |
| Mixed text styles                      | The most-felt editing gap                                      |
| Better generated code                  | Semantic tags, responsive layouts, extracted components        |

## Phase 2: AI features nobody else has (weeks 3-8)

Goal: features worth posting about. These are the "popular" drivers.

| Feature                          | What it does                                                                  |
|----------------------------------|-------------------------------------------------------------------------------|
| Screenshot → editable design     | Paste any screenshot or URL; Claude rebuilds it as real layers                |
| Code → design                    | Point at a React repo; get its screens and components as an editable file     |
| Two-way sync                     | Edit the design, Claude Code updates the app, and back again                   |
| Design system from codebase      | Read Tailwind config/CSS tokens into colour/text styles and components        |
| Claude critique mode             | Accessibility, contrast, spacing and consistency review with one-click fixes  |
| Flow generation                  | "Checkout flow, 5 screens, linked" builds screens with prototype links        |
| Variants on demand               | Select a component: "make hover, disabled, dark mode variants"                |
| Live app preview panel           | Run the generated app next to the canvas and click through it                 |

## Phase 3: Make switching from Figma possible (weeks 6-12)

| Item                         | Why                                                                |
|------------------------------|--------------------------------------------------------------------|
| Figma import                 | Via the Figma REST API (token) first, `.fig` later                 |
| Boolean ops, masks, flatten  | Required for icon and illustration work                            |
| Version history              | Named snapshots; restore and compare                               |
| Rulers, guides, layout grids | Expected by every professional designer                            |
| Variables and modes          | Light/dark themes, tokens that flow into code                      |
| Performance                  | Incremental rendering, canvas/WebGL path for 5k+ layer files       |

## Phase 4: Teams (months 3-6)

| Item                          | Notes                                                               |
|-------------------------------|---------------------------------------------------------------------|
| Real-time multiplayer         | CRDT document; self-hostable relay plus an optional hosted one      |
| Sharing links and comments    | View/comment links; comments Claude can read and resolve            |
| Accounts and cloud files      | Optional; local-first stays the default                             |
| Plugin API                    | JS plugins over the same Command/Query surface Claude uses          |
| Desktop app                   | Tauri bundle of editor + bridge                                     |

Sustainability: keep the editor free and open source forever. If it needs funding later,
charge only for hosted extras (cloud sync, team relay, hosted AI credits) and keep
self-hosting free.

## Growth plan

Popularity comes from one sharp demo, easy trying, and showing up where the audience
already is.

**Before launch (Phase 1 done)**

- A 60-second demo video: type a prompt, watch a 3-screen app appear, click Build, the
  running app opens. No narration needed.
- README with that video at the top, the hosted link, and one-line install.
- 10 good templates and 5 example prompts that reliably impress.
- Good-first-issue labels on 20 small tasks; CONTRIBUTING.md; a Discord or GitHub
  Discussions.

**Launch week**

| Channel                         | Angle                                                                |
|---------------------------------|----------------------------------------------------------------------|
| Hacker News (Show HN)           | Open-source design tool, Rust/WASM engine, Claude Code via MCP       |
| X / Bluesky                     | The demo video; tag the Claude and Claude Code communities           |
| Reddit                          | r/ClaudeAI, r/webdev, r/rust, r/UI_Design, r/opensource              |
| Product Hunt                    | Free AI design tool; schedule after HN feedback fixes                |
| MCP / plugin directories        | List the `designotron` MCP server where Claude Code users look       |
| Dev.to / blog post              | "How we built a Figma-style engine in Rust and WASM"                 |

**After launch**

- Ship something visible every week and post it (a changelog thread works).
- Turn every impressive user creation into a template, with credit.
- Fix bugs reported in public fast, and say so in the thread.
- Write one technical post per month (renderer, auto layout, MCP design) for the Rust and
  web-dev audiences.

**Measure**

| Metric                               | Why                                                    |
|--------------------------------------|--------------------------------------------------------|
| Hosted-editor visitors → sample open | Is the first impression working                        |
| Prompts sent per new user            | Is the AI the hook                                     |
| "Build" clicks                       | Is design-to-code the reason people stay               |
| GitHub stars, contributors           | Community momentum                                     |
| Week-2 return rate                   | The only number that says people actually switched    |

## This week

1. Use it for a real project for an hour and list every rough edge.
2. Fix that list.
3. Set up the hosted editor and `npx designotron`.
4. Record the 60-second demo.
5. Start Phase 1 items in order.
