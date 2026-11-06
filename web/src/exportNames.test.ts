import { describe, expect, it, vi } from "vitest";

// exporter.ts imports the store and the file helpers, which reach for the browser at import.
vi.mock("./store", () => ({ currentPage: () => "", getDoc: () => null, query: () => null, toast: () => {} }));
vi.mock("./files", () => ({ download: () => {} }));

import { fileSafe, formatExportSize, parseExportSize, stripUnsafe } from "./exporter";

describe("fileSafe", () => {
  it("keeps dots, spaces, digits and letters of any script", () => {
    expect(fileSafe("logo.v2")).toBe("logo.v2");
    expect(fileSafe("Café icon")).toBe("Café icon");
    expect(fileSafe("日本語")).toBe("日本語");
    expect(fileSafe("Привет мир")).toBe("Привет мир");
    expect(fileSafe("شع\u0627ر")).toBe("شع\u0627ر");
    expect(fileSafe("😀 party")).toBe("😀 party");
  });
  it("normalises to NFC", () => {
    expect(fileSafe("Café")).toBe("Café");
  });
  it("never lets dots make a path or a hidden file", () => {
    expect(fileSafe("..")).toBe("export");
    expect(fileSafe(".")).toBe("export");
    expect(fileSafe("...")).toBe("export");
    expect(fileSafe(".hidden")).toBe("hidden");
    expect(fileSafe("../../etc/passwd")).toBe("etcpasswd");
    expect(fileSafe("..\\..\\win")).toBe("win");
    expect(fileSafe("a/b")).toBe("ab");
  });
  it("trims trailing dots and spaces", () => {
    expect(fileSafe("name. . ")).toBe("name");
    expect(fileSafe("  spaced  out  ")).toBe("spaced out");
  });
  it("removes a leading dash so a name can't read as an option", () => {
    expect(fileSafe("-rf")).toBe("rf");
    expect(fileSafe("--help")).toBe("help");
    expect(fileSafe("a-b")).toBe("a-b");
    expect(fileSafe("-")).toBe("export");
  });
  it("removes characters Windows forbids, controls and bidi overrides", () => {
    expect(fileSafe('a<b>c:d"e|f?g*h')).toBe("abcdefgh");
    expect(fileSafe("tab\there\nnew\u0000nul\u007fdel\u0085nel")).toBe("tabherenewnuldelnel");
    // "gnp.exe" must not be able to pose as "exe.png".
    expect(fileSafe("photo\u202Egnp.exe")).toBe("photognp.exe");
    expect(fileSafe("\u202Aa\u202B\u202C\u202D\u202Eb\u2066c\u2067d\u2068e\u2069")).toBe("abcde");
    expect(fileSafe("a\u200Bb\u200Ec\u200Fd\uFEFFe\u061Cf")).toBe("abcdef");
  });
  it("collapses whitespace runs", () => {
    expect(fileSafe("a \t   b")).toBe("a b");
  });
  it("prefixes Windows device names, with or without an extension, in any case", () => {
    for (const n of ["CON", "con", "PRN", "Aux", "NUL", "COM1", "com9", "LPT1", "lpt9"]) expect(fileSafe(n)).toBe(`_${n}`);
    expect(fileSafe("nul.txt")).toBe("_nul.txt");
    expect(fileSafe("CON.")).toBe("_CON");
    expect(fileSafe("com1.tar.gz")).toBe("_com1.tar.gz");
    expect(fileSafe("console")).toBe("console");
    expect(fileSafe("COM10")).toBe("COM10");
    expect(fileSafe("com")).toBe("com");
  });
  it("catches the device names Windows reads loosely", () => {
    expect(fileSafe("con .png")).toBe("_con .png");
    expect(fileSafe("CONIN$")).toBe("_CONIN$");
    expect(fileSafe("conout$.txt")).toBe("_conout$.txt");
    expect(fileSafe("nul  ")).toBe("_nul");
    expect(fileSafe("conic")).toBe("conic");
  });
  it("maps look-alikes of separators to a dash", () => {
    expect(fileSafe("a\uFF0Fb")).toBe("a-b");
    expect(fileSafe("a\uFF3Cb\u2215c\uFF1Ad")).toBe("a-b-c-d");
    expect(fileSafe("a\uFF0E\uFF0Eb")).toBe("a--b");
  });
  it("keeps joiners between letters and drops stray ones", () => {
    expect(fileSafe("\u0645\u06CC\u200C\u062E\u0648\u0627\u0645")).toBe("\u0645\u06CC\u200C\u062E\u0648\u0627\u0645");
    expect(fileSafe("\u{1F468}\u200D\u{1F469}\u200D\u{1F467}")).toBe("\u{1F468}\u200D\u{1F469}\u200D\u{1F467}");
    expect(fileSafe("a\u200Cb ")).toBe("a\u200Cb");
    expect(fileSafe("\u200Da")).toBe("a");
    // A skin-tone modifier before the joiner (woman technologist, medium skin tone).
    expect(fileSafe("\u{1F469}\u{1F3FD}\u200D\u{1F4BB}")).toBe("\u{1F469}\u{1F3FD}\u200D\u{1F4BB}");
    expect(fileSafe("a\u200D ")).toBe("a");
  });
  it("caps the length in bytes so a suffix and extension still fit in 255", () => {
    const cjk = fileSafe("日".repeat(300));
    expect(new TextEncoder().encode(cjk).length).toBeLessThanOrEqual(200);
    expect(Array.from(cjk).length).toBe(66);
    expect(new TextEncoder().encode(`${cjk}@512w-2.png`).length).toBeLessThan(255);
    // An emoji family is cut whole, never in the middle of its joiners.
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    const cut = fileSafe(family.repeat(30));
    expect(new TextEncoder().encode(cut).length).toBeLessThanOrEqual(200);
    expect(cut.length % family.length).toBe(0);
  });
  it("gives a name that is empty after cleaning the name export", () => {
    expect(fileSafe("")).toBe("export");
    expect(fileSafe("   ")).toBe("export");
    expect(fileSafe('<>:"/\\|?*')).toBe("export");
    expect(fileSafe("\u202E\u202D")).toBe("export");
  });
  it("caps the length at 200 bytes and never splits a character", () => {
    expect(fileSafe("a".repeat(300))).toHaveLength(200);
    const emoji = fileSafe("\u{1F600}".repeat(200));
    expect(new TextEncoder().encode(emoji).length).toBeLessThanOrEqual(200);
    expect(emoji).toBe("\u{1F600}".repeat(50));
    // A cut that ends on a dot or space is trimmed again.
    expect(fileSafe("a".repeat(199) + ".b")).toBe("a".repeat(199));
  });
  it("drops lone surrogates", () => {
    expect(fileSafe("a\uD800b")).toBe("ab");
    expect(fileSafe("a\uDC00b")).toBe("ab");
  });
  it("is idempotent", () => {
    for (const n of ["logo.v2", "CON", "..", "日本語", "a/../b", "x\u202Ey"]) expect(fileSafe(fileSafe(n))).toBe(fileSafe(n));
  });
});

describe("stripUnsafe", () => {
  it("removes separators and controls from a suffix without trimming it", () => {
    expect(stripUnsafe("../x")).toBe("..x");
    expect(stripUnsafe(" @2x ")).toBe(" @2x ");
    expect(stripUnsafe("-a\\b\u202E")).toBe("-ab");
  });
});

describe("parseExportSize", () => {
  it("reads scales, with or without x", () => {
    expect(parseExportSize("2.5")).toEqual({ scale: 2.5 });
    expect(parseExportSize("2.5x")).toEqual({ scale: 2.5 });
    expect(parseExportSize(" 3X ")).toEqual({ scale: 3 });
    expect(parseExportSize(".5")).toEqual({ scale: 0.5 });
  });
  it("reads fixed widths and heights", () => {
    expect(parseExportSize("512w")).toEqual({ width: 512 });
    expect(parseExportSize("512W")).toEqual({ width: 512 });
    expect(parseExportSize("300h")).toEqual({ height: 300 });
    expect(parseExportSize("300.4 H")).toEqual({ height: 300 });
  });
  it("clamps scales to 0.01-32", () => {
    expect(parseExportSize("99")).toEqual({ scale: 32 });
    expect(parseExportSize("0.0001")).toEqual({ scale: 0.01 });
  });
  it("rejects anything else", () => {
    for (const bad of ["0", "0x", "0w", "abc", "", "x", "-2", "2..5", "2x3", "1e3", "Infinity", "2 px"]) expect(parseExportSize(bad)).toBeNull();
  });
  it("formats sizes the way they are typed", () => {
    expect(formatExportSize({ scale: 2 })).toBe("2x");
    expect(formatExportSize({ scale: 2.5 })).toBe("2.5x");
    expect(formatExportSize({ scale: 1, width: 512 })).toBe("512w");
    expect(formatExportSize({ scale: 1, height: 300 })).toBe("300h");
  });
});

describe("rowSuffix", () => {
  it("cleans and caps a typed suffix", async () => {
    const { rowSuffix } = await import("./exporter");
    expect(rowSuffix({ format: "png", scale: 1, suffix: "../x" })).toBe("..x");
    expect(Array.from(rowSuffix({ format: "png", scale: 1, suffix: "s".repeat(100) }))).toHaveLength(40);
  });
});
