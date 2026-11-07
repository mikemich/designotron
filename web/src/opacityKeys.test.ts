import { describe, expect, it } from "vitest";
import { nextOpacity } from "./opacityKeys";

describe("nextOpacity", () => {
  it("1-9 are 10-90 percent and 0 is 100", () => {
    expect(nextOpacity(null, 1, 0).value).toBe(0.1);
    expect(nextOpacity(null, 9, 0).value).toBe(0.9);
    expect(nextOpacity(null, 0, 0).value).toBe(1);
  });
  it("two digits within 500 ms make an exact percent", () => {
    const a = nextOpacity(null, 0, 1000);
    expect(nextOpacity(a.pending, 5, 1300).value).toBe(0.05);
    const b = nextOpacity(null, 4, 0);
    expect(nextOpacity(b.pending, 5, 400).value).toBe(0.45);
    const c = nextOpacity(nextOpacity(null, 0, 0).pending, 0, 100);
    expect(c.value).toBe(0);
  });
  it("a second digit after the window starts over", () => {
    const a = nextOpacity(null, 4, 0);
    expect(nextOpacity(a.pending, 5, 600).value).toBe(0.5);
  });
  it("a third digit starts a new number", () => {
    const a = nextOpacity(null, 4, 0);
    const b = nextOpacity(a.pending, 5, 100);
    expect(nextOpacity(b.pending, 2, 200).value).toBe(0.2);
  });
});
