import { describe, expect, it } from "vitest";
import { parseLetterSpacing, parseLineHeight } from "./textUnits";

describe("parseLineHeight", () => {
  it("reads empty, auto, normal and 0 as Auto", () => {
    for (const raw of ["", "  ", "auto", "Auto", "normal", "0", "0px", "0%"]) expect(parseLineHeight(raw, 16)).toBeNull();
  });
  it("reads %, em and px", () => {
    expect(parseLineHeight("150%", 16)).toBe(24);
    expect(parseLineHeight("1.5em", 16)).toBe(24);
    expect(parseLineHeight("24px", 16)).toBe(24);
    expect(parseLineHeight("24 px", 16)).toBe(24);
  });
  it("reads a bare number below 4 as a multiple and others as px", () => {
    expect(parseLineHeight("1.5", 16)).toBe(24);
    expect(parseLineHeight("2", 20)).toBe(40);
    expect(parseLineHeight("3.9", 10)).toBe(39);
    expect(parseLineHeight("4", 16)).toBe(4);
    expect(parseLineHeight("24", 16)).toBe(24);
  });
  it("keeps simple arithmetic on bare numbers", () => {
    expect(parseLineHeight("24+8", 16)).toBe(32);
    expect(parseLineHeight("100/4", 16)).toBe(25);
  });
  it("rounds to 0.01", () => {
    expect(parseLineHeight("133%", 15)).toBe(19.95);
    expect(parseLineHeight("1.333", 16)).toBe(21.33);
  });
  it("rejects what isn't a value", () => {
    for (const raw of ["abc", "12abc", "-10", "%", "1.5 x"]) expect(parseLineHeight(raw, 16)).toBeUndefined();
  });
});

describe("parseLetterSpacing", () => {
  it("reads %, em, px and bare numbers", () => {
    expect(parseLetterSpacing("10%", 16)).toBe(1.6);
    expect(parseLetterSpacing("0.05em", 20)).toBe(1);
    expect(parseLetterSpacing("2px", 16)).toBe(2);
    expect(parseLetterSpacing("2", 16)).toBe(2);
    expect(parseLetterSpacing("-0.5", 16)).toBe(-0.5);
    expect(parseLetterSpacing("-5%", 20)).toBe(-1);
  });
  it("rounds to 0.01 and rejects text", () => {
    expect(parseLetterSpacing("3%", 15)).toBe(0.45);
    expect(parseLetterSpacing("", 16)).toBeUndefined();
    expect(parseLetterSpacing("wide", 16)).toBeUndefined();
  });
});
