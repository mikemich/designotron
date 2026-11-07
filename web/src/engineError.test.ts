import { describe, expect, it } from "vitest";
import { isEngineTrap } from "./engineError";

describe("isEngineTrap", () => {
  it("is true for a wasm RuntimeError and for the errors a trapped instance throws", () => {
    expect(isEngineTrap(new WebAssembly.RuntimeError("unreachable"))).toBe(true);
    expect(isEngineTrap(new Error("recursive use of an object detected which would lead to unsafe aliasing in rust"))).toBe(true);
    expect(isEngineTrap(new RangeError("Out of memory"))).toBe(true);
  });
  it("is false for command errors, which are plain strings echoing the input", () => {
    expect(isEngineTrap("unknown arrange action 'unreachable'")).toBe(false);
    expect(isEngineTrap("no layer named Unreachable out of memory")).toBe(false);
    expect(isEngineTrap(new Error("unknown arrange action 'unreachable'"))).toBe(false);
  });
});
