// Where the canvas moves when a comment is clicked in the Comments list.

/** A layer smaller than this on screen is too small to see where the comment is. */
export const MIN_LAYER_PX = 8;

interface View {
  x: number;
  y: number;
  zoom: number;
}

/** Pans so the pin is at the centre of the canvas and keeps the zoom. When the layer the comment
 *  is on would be under 8 screen px it goes to 100% first. A comment on no layer passes `layerSize` 0. */
export function panToComment(v: View, pin: { x: number; y: number }, layerSize: number, canvas: { w: number; h: number }): View {
  const zoom = layerSize > 0 && layerSize * v.zoom < MIN_LAYER_PX ? 1 : v.zoom;
  return { zoom, x: canvas.w / 2 - pin.x * zoom, y: canvas.h / 2 - pin.y * zoom };
}
