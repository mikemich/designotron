import { describe, expect, it } from "vitest";
import type { Node } from "../types";
import { groupOffset } from "./groupOffset";

const node = (id: string, type: string, x: number, y: number, parent: string | null) => ({ id, type, x, y, parent }) as unknown as Node;

describe("groupOffset", () => {
  const nodes = Object.fromEntries(
    [node("f", "frame", 50, 50, null), node("g1", "group", 200, 100, "f"), node("g2", "group", 20, 10, "g1"), node("a", "rectangle", 5, 5, "g2"), node("b", "rectangle", 7, 7, "f"), node("c", "rectangle", 1, 1, null)].map((n) => [n.id, n]),
  );
  it("sums the group ancestors up to the first non-group", () => {
    expect(groupOffset(nodes, nodes.a)).toEqual({ x: 220, y: 110 });
    expect(groupOffset(nodes, nodes.g2)).toEqual({ x: 200, y: 100 });
  });
  it("is zero for a child of a frame and for a top-level layer", () => {
    expect(groupOffset(nodes, nodes.b)).toEqual({ x: 0, y: 0 });
    expect(groupOffset(nodes, nodes.c)).toEqual({ x: 0, y: 0 });
  });
});
