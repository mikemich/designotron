import { describe, expect, it } from "vitest";
import { controlOwnsKey, isTextEntry } from "./keyTarget";

const el = (tagName: string, type: string | null = null, isContentEditable = false) => ({ tagName, isContentEditable, getAttribute: (n: string) => (n === "type" ? type : null) });
const key = (target: unknown, k: string, mod = false) => ({ target, key: k, ctrlKey: mod, metaKey: false });
const clicked = () => true;
const tabbed = () => false;

describe("controlOwnsKey", () => {
  it("lets Ctrl+Z reach the editor from a checkbox, clicked or tabbed", () => {
    const c = el("INPUT", "checkbox");
    expect(controlOwnsKey(key(c, "z", true), clicked)).toBe(false);
    expect(controlOwnsKey(key(c, "z", true), tabbed)).toBe(false);
  });
  it("lets a plain letter reach the editor from a clicked select, not a tabbed one", () => {
    const s = el("SELECT");
    expect(controlOwnsKey(key(s, "v"), clicked)).toBe(false);
    expect(controlOwnsKey(key(s, "v"), tabbed)).toBe(true);
  });
  it("keeps Space, Enter and arrows with a clicked control", () => {
    const s = el("INPUT", "range");
    for (const k of [" ", "Enter", "ArrowLeft", "ArrowDown"]) expect(controlOwnsKey(key(s, k), clicked)).toBe(true);
  });
  it("keeps every key in text entry, Ctrl combos included", () => {
    for (const t of [el("INPUT"), el("INPUT", "text"), el("INPUT", "number"), el("TEXTAREA"), el("DIV", null, true)]) {
      expect(isTextEntry(t)).toBe(true);
      expect(controlOwnsKey(key(t, "z", true), clicked)).toBe(true);
      expect(controlOwnsKey(key(t, "v"), clicked)).toBe(true);
    }
  });
  it("ignores other elements and a document target", () => {
    expect(controlOwnsKey(key(el("BUTTON"), "v"), tabbed)).toBe(false);
    expect(controlOwnsKey(key({}, "v"), tabbed)).toBe(false);
    expect(isTextEntry(el("INPUT", "checkbox"))).toBe(false);
    expect(isTextEntry(el("INPUT", "color"))).toBe(false);
  });
});
