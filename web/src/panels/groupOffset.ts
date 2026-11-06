import type { Node } from "../types";

/** A layer's position measured from its nearest non-group ancestor (frame, section or page). */
export interface FramePosition {
  /** Left and top edge of the layer's box in the container's coordinates. */
  x: number;
  y: number;
  /** -1 on an axis when an odd number of group ancestors is flipped there: moving the shown value by d moves the layer's own x/y by d × this. */
  sx: 1 | -1;
  sy: 1 | -1;
}

/**
 * Walks up through the group ancestors (groups are never rotated; a flipped group mirrors its
 * children about its centre) and returns where the layer's box sits in the container, as Figma
 * measures X/Y. For a layer outside groups this is just its own x/y.
 */
export function framePosition(nodes: Record<string, Node>, n: Node): FramePosition {
  let x = n.x;
  let y = n.y;
  let w = n.width;
  let h = n.height;
  let sx: 1 | -1 = 1;
  let sy: 1 | -1 = 1;
  let parent = n.parent ? nodes[n.parent] : undefined;
  while (parent && parent.type === "group") {
    x = parent.flipX ? parent.x + parent.width - (x + w) : parent.x + x;
    y = parent.flipY ? parent.y + parent.height - (y + h) : parent.y + y;
    if (parent.flipX) sx = -sx as 1 | -1;
    if (parent.flipY) sy = -sy as 1 | -1;
    parent = parent.parent ? nodes[parent.parent] : undefined;
  }
  return { x, y, sx, sy };
}

/** The layer's own x or y that puts its box at `value` in the container, given where it is shown now. */
export function ownCoordinate(n: Node, axis: "x" | "y", pos: FramePosition, value: number): number {
  return n[axis] + (value - pos[axis]) * (axis === "x" ? pos.sx : pos.sy);
}
