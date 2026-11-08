// Placement maths for dropped and pasted images (pure: no store, no DOM).

/** Space between the images of a dropped batch. */
export const GRID_GAP = 20;

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Box extends Point, Size {}

/**
 * Top-left corners for a batch of images laid out in a grid centred on `at`: `ceil(sqrt(n))` columns,
 * rows left to right, each image at its own size in a cell as wide as the widest of its column and as
 * tall as the tallest of its row, `gap` between cells. The union of the images (not of the cells) is
 * what is centred. One image is just centred on the point.
 */
export function gridLayout(sizes: Size[], at: Point, gap = GRID_GAP): Point[] {
  const n = sizes.length;
  if (!n) return [];
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const colW = new Array<number>(cols).fill(0);
  const rowH = new Array<number>(rows).fill(0);
  sizes.forEach((s, i) => {
    colW[i % cols] = Math.max(colW[i % cols], s.width);
    rowH[Math.floor(i / cols)] = Math.max(rowH[Math.floor(i / cols)], s.height);
  });
  const colX: number[] = [];
  const rowY: number[] = [];
  let x = 0;
  for (const w of colW) {
    colX.push(x);
    x += w + gap;
  }
  let y = 0;
  for (const h of rowH) {
    rowY.push(y);
    y += h + gap;
  }
  const pos = sizes.map((_, i) => ({ x: colX[i % cols], y: rowY[Math.floor(i / cols)] }));
  const u = union(pos.map((p, i) => ({ ...p, ...sizes[i] })));
  const dx = at.x - (u.x + u.width / 2);
  const dy = at.y - (u.y + u.height / 2);
  return pos.map((p) => ({ x: p.x + dx, y: p.y + dy }));
}

/** The smallest box holding every box (at least one must be given). */
export function union(boxes: Box[]): Box {
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.width));
  const y1 = Math.max(...boxes.map((b) => b.y + b.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * Where a pasted image goes: the middle of the frame it is pasted into when any of that frame is in
 * view (`frame` is its page box), otherwise the middle of the view and no frame.
 */
export function pastePlacement(frame: Box | null, view: Box): { at: Point; inFrame: boolean } {
  const centre = { x: view.x + view.width / 2, y: view.y + view.height / 2 };
  if (!frame) return { at: centre, inFrame: false };
  const visible = frame.x <= view.x + view.width && frame.x + frame.width >= view.x && frame.y <= view.y + view.height && frame.y + frame.height >= view.y;
  if (!visible) return { at: centre, inFrame: false };
  return { at: { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 }, inFrame: true };
}

/** "Scaled 2 large images down to 4096 px to keep the file light." (one toast per drop or paste). */
export function scaledMessage(count: number, max: number): string {
  return `Scaled ${count === 1 ? "1 large image" : `${count} large images`} down to ${max} px to keep the file light.`;
}
