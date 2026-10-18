# Launch kit

Ready-to-post copy for launching Designotron. Edit the voice to sound like you; keep the
claims true (everything below is shipped today).

## Before you post

- [ ] Release binaries exist: Actions → Release → Run workflow → `0.2.0`.
- [ ] The public relay runs the latest image: Render → designotron-relay → Manual Deploy →
      Deploy latest reference (its `/health` shows a `memory` field).
- [ ] Open https://mikemich.github.io/designotron in a private window: the demo replay, a
      template, Share → Online with a second browser, and Send a copy all work.
- [ ] Record a 30–60 s screen capture (script below); export a GIF for X and the README.
- [ ] Pin a short "Start here" issue for feedback and bug reports.

## Where to list it (free, permanent traffic)

- Claude Code plugin: users run `/plugin install designotron --marketplace mikemich/designotron`
  (this repo is the marketplace). Share that line everywhere Claude Code users are.
- MCP directories: the official MCP Registry, `awesome-mcp-servers`, `awesome-claude-code`,
  and similar curated lists (open a PR adding one line each).
- Open-source directories: `awesome-design-tools`, AlternativeTo (as a Figma alternative),
  OpenAlternative.
- GitHub topics on the repo: `figma-alternative`, `design-tool`, `claude`, `mcp`, `rust`,
  `webassembly`, `prototyping`.

## Hacker News (Show HN)

**Title:** Show HN: Designotron – an open-source Figma alternative that Claude can design in

**Text:**

> I built Designotron, a free, open-source design editor (frames, auto layout, components,
> variables, prototypes, live multiplayer) with Claude built in. The engine is Rust compiled
> to WebAssembly; the editor runs entirely in your browser.
>
> Claude works through your own Claude Code (Pro/Max) or an API key: it reads the open file,
> builds screens, critiques spacing and contrast, and exports React + Tailwind. Claude Code
> users can also install it as a plugin and drive the canvas from the terminal over MCP.
>
> Try it without installing anything: https://mikemich.github.io/designotron (there's a
> replay of Claude designing a page if you haven't connected Claude). Sharing works three
> ways: live rooms through a small open-source relay, a "send a copy" link that carries the
> whole file in the URL fragment (no server), or your local network.
>
> Code (MIT): https://github.com/mikemich/designotron. I'd love feedback on what would make
> you switch for real work.

## Product Hunt

- **Tagline:** Open-source Figma alternative with Claude built in
- **Description:** Design screens, components and clickable prototypes in your browser,
  edit live with others, and let Claude design, critique and turn it into React code. Free
  and MIT-licensed.
- **First comment:** why you built it, what's different (Claude works through your own
  plan, the file never leaves your browser unless you share it, no account), what's next,
  and a direct ask: "Tell me the one thing that stops you from using it instead of Figma."

## X / Bluesky thread

1. I built an open-source Figma alternative that Claude can design in. Free, no account,
   runs in your browser. [GIF] https://mikemich.github.io/designotron
2. Describe a screen and Claude builds it on the canvas: real frames, auto layout and
   components, not a flat image. Then ask it to critique spacing and contrast, or export
   React + Tailwind.
3. Multiplayer: share a link and edit together with live cursors. Or "send a copy": the
   whole file is packed into the link itself, so no server ever sees it.
4. Claude Code users: `/plugin install designotron --marketplace mikemich/designotron` and
   drive the canvas from your terminal.
5. Rust + WebAssembly engine, MIT licensed. Stars and issues welcome:
   https://github.com/mikemich/designotron

## Reddit

Post as a maker sharing work, follow each subreddit's self-promotion rules, and reply to
every comment.

- **r/ClaudeAI:** "I made an open-source design tool Claude can work in (MCP + Claude Code
  plugin)". Lead with the Claude Code workflow and the plugin install line.
- **r/opensource, r/rust, r/webdev:** lead with the architecture (Rust/WASM engine,
  persistent data structures, relay in Rust, URL-fragment file links).
- **r/SideProject, r/InternetIsBeautiful:** lead with the live link and the demo replay.

## 45-second demo script

1. (0–5 s) Empty canvas: type "A pricing page for a coffee subscription", press Enter.
2. (5–20 s) Claude builds it; speed up 2×. Show the layers panel filling with real frames.
3. (20–28 s) "Critique this design" → one-click fixes.
4. (28–36 s) Share → Online; a second window joins, cursors move.
5. (36–45 s) Code tab → React; end card with the URL and "free and open source".
