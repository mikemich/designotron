// Words for a paint: the short label in the Fill row and what a screen reader says for its swatch.

import type { Paint } from "../types";

export function paintLabel(p: Paint): string {
  switch (p.type) {
    case "solid":
      return p.color.replace("#", "").slice(0, 6);
    case "linearGradient":
      return "Linear";
    case "radialGradient":
      return "Radial";
    case "angularGradient":
      return "Angular";
    case "diamondGradient":
      return "Diamond";
    case "image":
      return "Image";
  }
}

/** What a screen reader says for a paint: "Solid #3366FF, 100%", "Linear gradient", "Image (Fill)". */
export function paintAriaLabel(p: Paint): string {
  const pct = `${Math.round(p.opacity * 100)}%`;
  const hidden = p.visible === false ? ", hidden" : "";
  switch (p.type) {
    case "solid":
      return `Solid ${p.color.slice(0, 7).toUpperCase()}, ${pct}${hidden}`;
    case "image":
      return `Image (${p.scaleMode.charAt(0).toUpperCase() + p.scaleMode.slice(1)})${hidden}`;
    default:
      return `${paintLabel(p)} gradient${hidden}`;
  }
}
