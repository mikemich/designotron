import { describe, expect, it } from "vitest";
import { stillRelevant } from "./Tour";

describe("stillRelevant", () => {
  it("ends the Claude hint once the panel is open, whatever its condition says", () => {
    expect(stillRelevant({ id: "claude", when: () => true }, true)).toBe(false);
    expect(stillRelevant({ id: "claude", when: () => true }, false)).toBe(true);
  });

  it("ends any hint whose condition stopped holding", () => {
    expect(stillRelevant({ id: "layers", when: () => false }, false)).toBe(false);
    expect(stillRelevant({ id: "layers", when: () => true }, true)).toBe(true);
  });
});
