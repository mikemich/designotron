import { describe, expect, it } from "vitest";
import type { Node } from "../types";
import { framePosition, ownCoordinate } from "./groupOffset";

const node = (id: string, type: string, x: number, y: number, parent: string | null, w = 10, h = 10, flipX = false, flipY = false) =>
  ({ id, type, x, y, parent, width: w, height: h, flipX, flipY }) as unknown as Node;
const index = (list: Node[]) => Object.fromEntries(list.map((n) => [n.id, n]));

describe("framePosition", () => {
  const nodes = index([
    node("f", "frame", 50, 50, null, 600, 400),
    node("g1", "group", 200, 100, "f", 100, 100),
    node("g2", "group", 20, 10, "g1", 50, 50),
    node("a", "rectangle", 5, 5, "g2"),
    node("b", "rectangle", 7, 7, "f"),
    node("c", "rectangle", 1, 1, null),
  ]);
  it("sums the group ancestors up to the first non-group", () => {
    expect(framePosition(nodes, nodes.a)).toMatchObject({ x: 225, y: 115, sx: 1, sy: 1 });
    expect(framePosition(nodes, nodes.g2)).toMatchObject({ x: 220, y: 110 });
  });
  it("is the layer's own x/y for a child of a frame and a top-level layer", () => {
    expect(framePosition(nodes, nodes.b)).toMatchObject({ x: 7, y: 7 });
    expect(framePosition(nodes, nodes.c)).toMatchObject({ x: 1, y: 1 });
  });
});

describe("flipped groups", () => {
  // A group at 100,0 of width 200, flipped horizontally; its child sits at x 20 (width 10) inside it.
  const nodes = index([node("f", "frame", 0, 0, null, 600, 400), node("g", "group", 100, 0, "f", 200, 50, true), node("a", "rectangle", 20, 5, "g")]);
  it("mirrors the child about the group's centre", () => {
    const p = framePosition(nodes, nodes.a);
    expect(p).toMatchObject({ x: 100 + 200 - 30, y: 5, sx: -1, sy: 1 });
  });
  it("writes the own coordinate so the child lands where typed", () => {
    const p = framePosition(nodes, nodes.a);
    const own = ownCoordinate(nodes.a, "x", p, 100);
    // Own x 190 inside the group puts its left edge at 100 + 200 - (190 + 10) = 100.
    expect(own).toBe(190);
    expect(ownCoordinate(nodes.a, "y", p, 7)).toBe(7);
  });
  it("two flips cancel", () => {
    const n = index([node("g1", "group", 0, 0, null, 100, 100, true), node("g2", "group", 10, 0, "g1", 50, 50, true), node("a", "rectangle", 5, 0, "g2")]);
    expect(framePosition(n, n.a).sx).toBe(1);
  });
});
