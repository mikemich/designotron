import { describe, expect, it } from "vitest";
import { cssFamily, familiesIn, fontLabel, fontNote, fontStatus, resetFontStatus, type Measure } from "./fontStatus";

describe("familiesIn", () => {
  const base = { fontFamily: "Inter", characters: "Hello world" };
  it("lists the base family and the runs' own", () => {
    expect(familiesIn({ ...base, runs: [] })).toEqual(["Inter"]);
    expect(familiesIn({ ...base, runs: [{ start: 0, end: 5, fontFamily: "Avenir" }] })).toEqual(["Avenir", "Inter"]);
    // A run over everything replaces the base.
    expect(familiesIn({ ...base, runs: [{ start: 0, end: 11, fontFamily: "Avenir" }] })).toEqual(["Avenir"]);
    // Two missing families in one text.
    expect(
      familiesIn({
        ...base,
        runs: [
          { start: 0, end: 5, fontFamily: "Avenir" },
          { start: 6, end: 11, fontFamily: "Gill Sans" },
        ],
      }),
    ).toEqual(["Avenir", "Gill Sans", "Inter"]);
  });
  it("looks only at the range asked for", () => {
    const t = { ...base, runs: [{ start: 0, end: 5, fontFamily: "Avenir" }] };
    expect(familiesIn(t, 0, 5)).toEqual(["Avenir"]);
    expect(familiesIn(t, 6, 11)).toEqual(["Inter"]);
    expect(familiesIn(t, 3, 8)).toEqual(["Avenir", "Inter"]);
  });
});

const BUNDLED = ["Inter", "Roboto"];

/** A canvas whose fonts are `known`: a known family measures differently from the generic it falls back to. */
function canvas(known: Record<string, number>): Measure {
  return (font, text) => {
    const m = /^40px (?:("(?:[^"\\]|\\.)*"), )?(monospace|serif)$/.exec(font);
    if (!m) throw new Error("unexpected font " + font);
    const base = m[2] === "monospace" ? 10 : 8;
    const fam = m[1] ? (JSON.parse(m[1]) as string) : null;
    return text.length * (fam && fam in known ? known[fam] : base);
  };
}

describe("fontStatus", () => {
  it("never probes the bundled families or generic names", () => {
    const boom: Measure = () => {
      throw new Error("probed");
    };
    expect(fontStatus("Inter", BUNDLED, boom)).toBe("bundled");
    expect(fontStatus("sans-serif", BUNDLED, boom)).toBe("bundled");
  });

  it("matches bundled families without regard to case", () => {
    const boom: Measure = () => {
      throw new Error("probed");
    };
    expect(fontStatus("inter", BUNDLED, boom)).toBe("bundled");
    expect(fontStatus(" ROBOTO ", BUNDLED, boom)).toBe("bundled");
  });

  it("calls a family the browser draws differently local, and one it can't draw missing", () => {
    resetFontStatus();
    const m = canvas({ Georgia: 9, "Helvetica Neue": 11 });
    expect(fontStatus("Georgia", BUNDLED, m)).toBe("local");
    expect(fontStatus("Helvetica Neue", BUNDLED, m)).toBe("local");
    expect(fontStatus("Nonexistent Sans", BUNDLED, m)).toBe("missing");
  });

  it("sees a font that matches only one fallback", () => {
    // 10 per glyph is the monospace fallback: a font that happens to equal it still differs from serif.
    expect(fontStatus("Courier-ish", BUNDLED, canvas({ "Courier-ish": 10 }))).toBe("local");
    expect(fontStatus("Times-ish", BUNDLED, canvas({ "Times-ish": 8 }))).toBe("local");
  });

  it("escapes quotes, backslashes and commas in the family", () => {
    expect(cssFamily('A "B", C')).toBe('"A \\"B\\", C"');
    expect(cssFamily("A\\B")).toBe('"A\\\\B"');
    const m = canvas({ 'Odd "name", x': 9 });
    expect(fontStatus('Odd "name", x', BUNDLED, m)).toBe("local");
    expect(fontStatus('Other "name", x', BUNDLED, m)).toBe("missing");
  });
});

describe("fontLabel and fontNote", () => {
  it("labels", () => {
    expect(fontLabel("Helvetica Neue", "missing")).toBe("Helvetica Neue (missing)");
    expect(fontLabel("Georgia", "local")).toBe("Georgia (this computer only)");
    expect(fontLabel("Inter", "bundled")).toBe("Inter");
  });

  it("writes one line for one or two families", () => {
    expect(fontNote([{ family: "Inter", status: "bundled" }])).toBeNull();
    expect(fontNote([{ family: "Helvetica Neue", status: "missing" }])).toBe("Helvetica Neue isn't available, so a fallback font is shown. Pick a font to replace it.");
    expect(
      fontNote([
        { family: "Avenir", status: "missing" },
        { family: "Gill Sans", status: "missing" },
        { family: "Inter", status: "bundled" },
      ]),
    ).toBe("Avenir and Gill Sans aren't available, so fallback fonts are shown. Pick a font to replace them.");
    expect(fontNote([{ family: "Georgia", status: "local" }])).toBe("Georgia is on this computer only; others see a fallback.");
    // Missing wins over local.
    expect(
      fontNote([
        { family: "Georgia", status: "local" },
        { family: "Avenir", status: "missing" },
      ]),
    ).toContain("Avenir isn't available");
  });
});
