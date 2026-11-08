import { describe, expect, it } from "vitest";
import { PROMPT_NAME_CHARS, nameFromPrompt } from "./promptName";

describe("nameFromPrompt", () => {
  it("uses the first line, capitalised, without quotes", () => {
    expect(nameFromPrompt("a habit tracker\nwith streaks")).toBe("A habit tracker");
    expect(nameFromPrompt('  "pricing page" ')).toBe("Pricing page");
    expect(nameFromPrompt("\n\n  second line first  ")).toBe("Second line first");
  });

  it("keeps the dashboard idea whole when it fits", () => {
    expect(nameFromPrompt("A habit tracker mobile app, 3 screens")).toBe("A habit tracker mobile app, 3 screens");
  });

  it("cuts a long prompt at a word, with an ellipsis, within 40 characters", () => {
    const prompt = "A landing page for a coffee subscription with pricing and a footer";
    const name = nameFromPrompt(prompt);
    expect(name.length).toBeLessThanOrEqual(PROMPT_NAME_CHARS);
    expect(name).toBe("A landing page for a coffee…");
    expect(prompt.startsWith(name.slice(0, -1))).toBe(true);
  });

  it("falls back to Untitled", () => {
    expect(nameFromPrompt("")).toBe("Untitled");
    expect(nameFromPrompt('  ""  \n')).toBe("Untitled");
  });

  it("copes with 500 characters and with emoji", () => {
    const long = nameFromPrompt("x".repeat(500));
    expect([...long].length).toBeLessThanOrEqual(PROMPT_NAME_CHARS);
    expect(long.endsWith("…")).toBe(true);
    const emoji = nameFromPrompt("🎨".repeat(100));
    expect([...emoji].length).toBeLessThanOrEqual(PROMPT_NAME_CHARS);
    expect(emoji).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    expect(nameFromPrompt("🎨🎨")).toBe("🎨🎨");
  });
});
