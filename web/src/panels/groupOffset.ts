import type { Node } from "../types";

/**
 * Where the layer's nearest non-group ancestor (frame, section or page) sits relative to the
 * layer's parent: the sum of `x`/`y` over the group ancestors. Groups are never rotated, so this
 * turns a group child's parent-relative position into one measured from its frame, as Figma does.
 */
export function groupOffset(nodes: Record<string, Node>, n: Node): { x: number; y: number } {
  let x = 0;
  let y = 0;
  let parent = n.parent ? nodes[n.parent] : undefined;
  while (parent && parent.type === "group") {
    x += parent.x;
    y += parent.y;
    parent = parent.parent ? nodes[parent.parent] : undefined;
  }
  return { x, y };
}
