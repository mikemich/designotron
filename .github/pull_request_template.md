## What changed

## Why

## How I tested it

- [ ] `cargo test --workspace` and `cargo clippy --workspace --all-targets -- -D warnings`
- [ ] `cd web && npm run typecheck`
- [ ] `npm run e2e` (and `bridge-e2e` / `collab-e2e` if relevant)
- [ ] Rebuilt `web/src/wasm/pkg` if the engine changed
- [ ] Updated `STATUS.md`
