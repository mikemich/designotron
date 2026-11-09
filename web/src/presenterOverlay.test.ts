import { describe, expect, it } from "vitest";
import { INSTANT, motionOf, reverseMotion, type Motion } from "./player";
import { closeMotion, closeVector, dimAt, dragTransform, leaveAnimation } from "./presenterOverlay";
import type { Interaction } from "./types";

const move = (transition: Interaction["transition"], direction: Interaction["direction"], ms = 300): Motion =>
  motionOf({ transition, direction, durationMs: ms, easing: "easeOut" } as Interaction);

describe("closeMotion", () => {
  it("reverses the way the overlay came in", () => {
    for (const [kind, dir, out] of [
      ["moveIn", "up", "down"],
      ["moveIn", "down", "up"],
      ["moveIn", "left", "right"],
      ["push", "right", "left"],
      ["slideUp", "up", "down"],
    ] as const) {
      const m = closeMotion(move(kind as Interaction["transition"], dir), null, false);
      expect([m.kind, m.dir]).toEqual(["moveOut", out]);
    }
    // The same answer as the player's own reverse for a Move in.
    const opened = move("moveIn", "up");
    expect(closeMotion(opened, null, false).dir).toBe(reverseMotion(opened).dir);
    expect(closeMotion(opened, null, false).ms).toBe(300);
  });

  it("fades a dissolve or smart opening and is instant for an instant one", () => {
    expect(closeMotion(move("dissolve", "left"), null, false).kind).toBe("dissolve");
    expect(closeMotion(move("smartAnimate", "left"), null, false).kind).toBe("dissolve");
    expect(closeMotion(INSTANT, null, false).kind).toBe("instant");
  });

  it("is instant under reduced motion and prefers the close interaction's own direction", () => {
    expect(closeMotion(move("moveIn", "up"), null, true).kind).toBe("instant");
    const own = closeMotion(move("moveIn", "up"), move("moveOut", "left", 120), false);
    expect([own.kind, own.dir, own.ms]).toEqual(["moveOut", "left", 120]);
    expect(closeMotion(INSTANT, move("moveOut", "down"), false).dir).toBe("down");
    // A plain dissolve on the close itself doesn't override the opening's direction.
    expect(closeMotion(move("moveIn", "up"), move("dissolve", "left"), false).dir).toBe("down");
  });
});

describe("closeVector, dragTransform, dimAt", () => {
  const size = { w: 390, h: 300 };
  it("is the overlay's size on the axis it leaves along", () => {
    expect(closeVector(closeMotion(move("moveIn", "up"), null, false), size)).toEqual({ x: 0, y: 300 });
    expect(closeVector(closeMotion(move("moveIn", "up"), null, false), size)).not.toEqual({ x: 0, y: 390 });
    expect(closeVector(closeMotion(move("moveIn", "right"), null, false), size)).toEqual({ x: -390, y: 0 });
    expect(closeVector(closeMotion(move("moveIn", "down"), null, false), size)).toEqual({ x: 0, y: -300 });
    expect(closeVector(closeMotion(move("moveIn", "left"), null, false), size)).toEqual({ x: 390, y: 0 });
  });
  it("has no vector for a fade or an instant close", () => {
    expect(closeVector(closeMotion(move("dissolve", "left"), null, false), size)).toBeNull();
    expect(closeVector(INSTANT, size)).toBeNull();
  });
  it("translates by the vector times the progress", () => {
    const v = { x: 0, y: 300 };
    expect(dragTransform(v, 0)).toBe("");
    expect(dragTransform(v, 0.5)).toBe("translate(0px, 150px)");
    expect(dragTransform(v, 1)).toBe("translate(0px, 300px)");
  });
  it("fades the dim with the drag", () => {
    expect(dimAt("rgba(0, 0, 0, 0.4)", 0)).toBe("rgba(0, 0, 0, 0.4)");
    expect(dimAt("rgba(0, 0, 0, 0.4)", 0.5)).toBe("rgba(0, 0, 0, 0.2)");
    expect(dimAt("rgba(0, 0, 0, 0.4)", 1)).toBe("rgba(0, 0, 0, 0)");
    expect(dimAt("transparent", 0.5)).toBe("transparent");
  });
  it("names the keyframes the leaving copy plays", () => {
    expect(leaveAnimation(closeMotion(move("moveIn", "up"), null, false))).toMatch(/^dt-out-down 300ms /);
    expect(leaveAnimation(closeMotion(move("dissolve", "up"), null, false))).toMatch(/^dt-fade-out /);
    expect(leaveAnimation(INSTANT)).toBeUndefined();
  });
});
