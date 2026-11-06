import { describe, expect, it } from "vitest";
import { defaultPanels, panelShown, readPanels, setPanel, toggleUi, writePanels, type PanelStorage } from "./panelState";

const memory = (): PanelStorage & { data: Record<string, string> } => {
  const data: Record<string, string> = {};
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) };
};

describe("panel defaults", () => {
  it("opens both on a desktop and neither on a tablet", () => {
    expect(defaultPanels(false)).toEqual({ left: true, right: true });
    expect(defaultPanels(true)).toEqual({ left: false, right: false });
    expect(readPanels(false, null)).toEqual({ left: true, right: true });
    expect(readPanels(true, memory())).toEqual({ left: false, right: false });
  });

  it("remembers each mode on its own", () => {
    const s = memory();
    writePanels(true, { left: true, right: false }, s);
    expect(readPanels(true, s)).toEqual({ left: true, right: false });
    expect(readPanels(false, s)).toEqual({ left: true, right: true });
    writePanels(false, { left: false, right: true }, s);
    expect(readPanels(false, s)).toEqual({ left: false, right: true });
    expect(readPanels(true, s)).toEqual({ left: true, right: false });
  });

  it("ignores broken storage", () => {
    const s = memory();
    s.data["dt:panels"] = "{nope";
    expect(readPanels(false, s)).toEqual({ left: true, right: true });
    s.data["dt:panels"] = JSON.stringify({ left: 1 });
    expect(readPanels(false, s)).toEqual({ left: true, right: true });
    const broken: PanelStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readPanels(true, broken)).toEqual({ left: false, right: false });
    expect(() => writePanels(true, { left: true, right: true }, broken)).not.toThrow();
  });
});

describe("Ctrl+\\ (show or hide the UI)", () => {
  it("hides what is open and brings the same panels back", () => {
    const hidden = toggleUi({ left: true, right: false }, null, false);
    expect(hidden.panels).toEqual({ left: false, right: false });
    const back = toggleUi(hidden.panels, hidden.stash, false);
    expect(back.panels).toEqual({ left: true, right: false });
    expect(back.stash).toBeNull();
  });

  it("with nothing remembered opens both on a desktop and the Layers panel on a tablet", () => {
    expect(toggleUi({ left: false, right: false }, null, false).panels).toEqual({ left: true, right: true });
    expect(toggleUi({ left: false, right: false }, null, true).panels).toEqual({ left: true, right: false });
  });

  it("does not restore a stash that was itself all closed", () => {
    expect(toggleUi({ left: false, right: false }, { left: false, right: false }, false).panels).toEqual({ left: true, right: true });
  });
});

describe("panels and Claude's chat", () => {
  it("opening the Design panel closes the chat where the chat covers it", () => {
    const r = setPanel({ left: false, right: false }, "right", true, true, true);
    expect(r).toEqual({ panels: { left: false, right: true }, chatOpen: false });
    expect(setPanel({ left: false, right: false }, "right", true, true, false).chatOpen).toBe(true);
    expect(setPanel({ left: false, right: false }, "left", true, true, true).chatOpen).toBe(true);
  });

  it("the chat hides the Design panel only where it covers it", () => {
    const p = { left: true, right: true };
    expect(panelShown(p, "right", true, true)).toBe(false);
    expect(panelShown(p, "right", true, false)).toBe(true);
    expect(panelShown(p, "left", true, true)).toBe(true);
  });
});
