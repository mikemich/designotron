import { describe, expect, it } from "vitest";
import { queueJoin } from "./queue";

describe("queueJoin", () => {
  it("starts a queue", () => {
    expect(queueJoin(null, "one")).toBe("one");
    expect(queueJoin("", "one")).toBe("one");
    expect(queueJoin(undefined, "one")).toBe("one");
  });
  it("keeps earlier messages and orders them", () => {
    expect(queueJoin("one", "two")).toBe("one\n\ntwo");
    expect(queueJoin(queueJoin("one", "two"), "three")).toBe("one\n\ntwo\n\nthree");
  });
});
