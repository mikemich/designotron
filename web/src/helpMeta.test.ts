import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { APP_VERSION, MODEL_REVISION } from "./appInfo";

const root = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

describe("About", () => {
  it("shows the model revision the engine writes", () => {
    const n = Number(root("crates/engine/src/collab.rs").match(/pub const MODEL_REVISION: u32 = (\d+);/)?.[1]);
    expect(MODEL_REVISION).toBe(n);
  });

  it("shows the workspace version from the root Cargo.toml", () => {
    const section = root("Cargo.toml").match(/\[workspace\.package\]([\s\S]*?)(?:\n\[|$)/)?.[1] ?? "";
    expect(APP_VERSION).toBe(section.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1]);
  });
});
