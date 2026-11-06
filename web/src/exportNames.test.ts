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
    expect(fileSafe("شعار")).toBe("شعار");
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
    expect(fileSafe("photo‮gnp.exe")).toBe("photognp.exe");
    expect(fileSafe("‪a‫‬‭‮b⁦c⁧d⁨e⁩")).toBe("abcde");
    expect(fileSafe("a​b‎c‏d﻿e؜f")).toBe("abcdef");
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
  it("gives a name that is empty after cleaning the name export", () => {
    expect(fileSafe("")).toBe("export");
    expect(fileSafe("   ")).toBe("export");
    expect(fileSafe('<>:"/\\|?*')).toBe("export");
    expect(fileSafe("‮‭")).toBe("export");
  });
  it("caps the length at 120 code points and never splits one", () => {
    expect(fileSafe("a".repeat(200))).toHaveLength(120);
    const emoji = fileSafe("😀".repeat(200));
    expect(Array.from(emoji)).toHaveLength(120);
    expect(emoji).toBe("😀".repeat(120));
    // A cut that ends on a dot or space is trimmed again.
    expect(fileSafe("a".repeat(119) + ".b")).toBe("a".repeat(119));
  });
  it("drops lone surrogates", () => {
    expect(fileSafe("a\uD800b")).toBe("ab");
    expect(fileSafe("a\uDC00b")).toBe("ab");
  });
  it("is idempotent", () => {
    for (const n of ["logo.v2", "CON", "..", "日本語", "a/../b", "x‮y"]) expect(fileSafe(fileSafe(n))).toBe(fileSafe(n));
  });
});

describe("stripUnsafe", () => {
  it("removes separators and controls from a suffix without trimming it", () => {
    expect(stripUnsafe("../x")).toBe("..x");
    expect(stripUnsafe(" @2x ")).toBe(" @2x ");
    expect(stripUnsafe("-a\\b‮")).toBe("-ab");
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
