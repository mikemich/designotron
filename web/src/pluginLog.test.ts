import { beforeEach, describe, expect, it } from "vitest";
import { BOOTSTRAP_SCRIPT } from "./pluginSandbox";
import { LOG_CAP, asLevel, asLine, formatArgs, logClear, logFlush, logPush, mapLine, stackPos, usePluginLog } from "./pluginLog";

describe("formatArgs", () => {
  it("prints strings as they are and joins arguments with spaces", () => {
    expect(formatArgs(["a", "b c", 3, true, null])).toBe("a b c 3 true null");
  });

  it("prints objects as JSON, nested strings quoted", () => {
    expect(formatArgs([{ a: 1, b: ["x", { c: null }] }, "x"])).toBe('{"a":1,"b":["x",{"c":null}]} x');
  });

  it("survives cycles", () => {
    const a: any = { name: "a" };
    a.self = a;
    a.list = [a, { back: a }];
    expect(formatArgs([a])).toBe('{"name":"a","self":"[Circular]","list":["[Circular]",{"back":"[Circular]"}]}');
  });

  it("prints Errors as name and message", () => {
    expect(formatArgs([new TypeError("nope")])).toBe("TypeError: nope");
    expect(formatArgs([{ e: new RangeError("r") }])).toBe('{"e":"RangeError: r"}');
  });

  it("cuts depth at 4 and long output at 2000 characters", () => {
    expect(formatArgs([{ a: { b: { c: { d: { e: 1 } } } } }])).toBe('{"a":{"b":{"c":{"d":"[Object]"}}}}');
    const long = formatArgs(["x".repeat(5000)]);
    expect(long.length).toBe(2001);
    expect(long.endsWith("…")).toBe(true);
  });

  it("handles undefined, symbols, functions, bigints and hostile getters", () => {
    expect(formatArgs([undefined, Symbol("s"), function foo() {}, 10n])).toBe("undefined Symbol(s) [Function foo] 10n");
    expect(formatArgs([{ u: undefined, f: () => 1 }])).toBe('{"u":"undefined","f":"[Function f]"}');
    const bad = {
      get x(): number {
        throw new Error("boom");
      },
    };
    expect(formatArgs([bad])).toBe("[unprintable]");
    expect(formatArgs([JSON.parse('{"__proto__": {"a": 1}}')])).toBe('{"__proto__":{"a":1}}');
  });

  it("is the same code the sandbox frame runs", () => {
    const src = BOOTSTRAP_SCRIPT.slice(BOOTSTRAP_SCRIPT.indexOf("// fmt:begin"), BOOTSTRAP_SCRIPT.indexOf("// fmt:end"));
    const inFrame = new Function(src + "\nreturn formatArgs;")() as typeof formatArgs;
    const cyc: any = { k: 1 };
    cyc.c = cyc;
    const samples: any[][] = [
      ["a", 1, { x: [1, 2, { y: 3 }] }],
      [cyc],
      [new Error("e")],
      [undefined, Symbol("q")],
      ["y".repeat(3000)],
      [{ a: { b: { c: { d: { e: 1 } } } } }],
      [Array.from({ length: 300 }, (_, i) => i)],
    ];
    for (const args of samples) expect(inFrame(args)).toBe(formatArgs(args));
  });
});

describe("stack positions", () => {
  const chromium = "Error\n    at call (about:srcdoc:20:9)\n    at Object.tool (about:srcdoc:44:7)\n    at eval (eval at <anonymous> (about:srcdoc:99:5), <anonymous>:7:11)";
  const firefox = "call@about:srcdoc:20:9\n@about:srcdoc line 99 > Function:7:11\n";
  const webkit = "call@about:srcdoc:20:9\nanonymous@:7:11\n";

  it("reads the first frame inside compiled plugin code", () => {
    expect(stackPos(chromium)).toEqual([7, 11]);
    expect(stackPos(firefox)).toEqual([7, 11]);
    expect(stackPos(webkit)).toEqual([7, 11]);
    expect(stackPos("TypeError: x\n    at <anonymous>:3:5")).toEqual([3, 5]);
  });

  it("finds nothing in text without such a frame, or in hostile values", () => {
    expect(stackPos("Error\n    at call (about:srcdoc:20:9)")).toBeNull();
    expect(stackPos(undefined)).toBeNull();
    const hostile = {
      toString: () => {
        throw new Error("x");
      },
    };
    expect(stackPos(hostile)).toBeNull();
    expect(stackPos("a".repeat(100000) + "<anonymous>:1:1")).toBeNull(); // cut before it is read
  });

  it("maps to the plugin's line and refuses lines outside the code", () => {
    expect(mapLine(7, 3, 10)).toBe(4);
    expect(mapLine(3, 3, 10)).toBeUndefined();
    expect(mapLine(14, 3, 10)).toBeUndefined();
    expect(mapLine(4, 3, 10)).toBe(1);
  });

  it("the frame reads positions with the same code", () => {
    const src = BOOTSTRAP_SCRIPT.slice(BOOTSTRAP_SCRIPT.indexOf("// pos:begin"), BOOTSTRAP_SCRIPT.indexOf("// pos:end"));
    const inFrame = new Function(src + "\nreturn stackPos;")() as typeof stackPos;
    for (const s of [chromium, firefox, webkit, "none", undefined]) expect(inFrame(s)).toEqual(stackPos(s));
  });
});

describe("the log store", () => {
  beforeEach(() => logClear());

  it("keeps entries in order with their level and line", () => {
    logPush("log", "a");
    logPush("error", "b", 3);
    expect(usePluginLog.getState().entries.length).toBe(0); // queued until the next frame
    logFlush();
    const { entries } = usePluginLog.getState();
    expect(entries.map((e) => [e.level, e.text, e.line])).toEqual([
      ["log", "a", undefined],
      ["error", "b", 3],
    ]);
  });

  it("caps at 500 and counts what was dropped", () => {
    for (let i = 0; i < LOG_CAP + 100; i++) logPush("log", String(i));
    logFlush();
    const s = usePluginLog.getState();
    expect(s.entries.length).toBe(LOG_CAP);
    expect(s.dropped).toBe(100);
    expect(s.entries[0].text).toBe("100");
    logClear();
    expect(usePluginLog.getState().dropped).toBe(0);
  });

  it("cuts a long entry", () => {
    logPush("log", "z".repeat(5000));
    logFlush();
    expect(usePluginLog.getState().entries[0].text.length).toBe(2001);
  });

  it("accepts only known levels and sane lines from the frame", () => {
    expect(asLevel("warn")).toBe("warn");
    expect(asLevel("bogus")).toBe("log");
    expect(asLevel({})).toBe("log");
    expect(asLine(4)).toBe(4);
    for (const bad of [0, -1, 1.5, "3", NaN, 1e9, null]) expect(asLine(bad)).toBeUndefined();
  });
});
