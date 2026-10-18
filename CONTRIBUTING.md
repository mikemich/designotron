# Contributing to Designotron

Thanks for helping. Designotron is a Rust engine (compiled to WebAssembly) with a React
editor and a small Rust bridge server. [AGENTS.md](AGENTS.md) has the architecture rules and
code style, and [STATUS.md](STATUS.md) lists what is done, broken and planned. Read both
before a large change.

## Setup

You need Rust (stable, with the `wasm32-unknown-unknown` target), Node 20+ and
`wasm-bindgen-cli` 0.2.100 (`cargo install wasm-bindgen-cli --version 0.2.100`). Claude Code
is optional (only for chat).

```bash
git clone https://github.com/mikemich/designotron
cd designotron
./dev.sh          # bridge on :5174, editor on :5173
```

The prebuilt WASM engine is committed, so UI-only changes don't need Rust. After changing
anything in `crates/engine`, run `cd web && npm run wasm` and commit `web/src/wasm/pkg`.

## Before you open a pull request

```bash
cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cd web && npm run typecheck && npm run e2e     # e2e needs ./dev.sh running
```

- Engine behaviour gets a unit test next to the code.
- User-facing editor behaviour gets a check in `web/scripts/e2e.mjs`.
- Claude or bridge changes keep `web/scripts/bridge-e2e.mjs` passing; multiplayer changes keep
  `web/scripts/collab-e2e.mjs` passing.
- Update `STATUS.md` in the same pull request when you finish, start or break something.

## Good first issues

- Items in the **To do** table of `STATUS.md` marked small
- Rough edges you hit while using the editor (file a bug with steps first)
- Built-in plugins (`web/src/plugins.ts`) and templates (`web/src/templates.ts`)

## Reporting bugs

Use the bug report template. Include the steps, what you expected, what happened, your
browser and OS, and whether the bridge was running. A `.dtron` file that reproduces the
problem helps a lot (**File → Save as .dtron**).

## Security

The bridge can run Claude Code with write access to your workspace, so it only listens on
127.0.0.1 and checks `Origin`/`Host`. If you find a way around that, or out of the plugin
sandbox or the share listener, please report it privately to the maintainer instead of
opening a public issue.

## License

By contributing you agree that your contributions are licensed under the MIT License.
