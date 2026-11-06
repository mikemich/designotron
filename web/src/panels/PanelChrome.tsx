import { X } from "lucide-react";
import { togglePanel } from "../store";
import type { Panels } from "../panelState";

/** The side panels' shared pieces: the close button of an overlay panel (tablet widths only,
 * the CSS hides it in a column), and moving focus into a panel that was just opened. */

const LABEL: Record<keyof Panels, string> = { left: "Layers panel", right: "Design panel" };

export const panelSelector = (side: keyof Panels) => (side === "left" ? ".main > .panel:not(.right)" : ".main > .panel.right");

export function PanelClose({ side }: { side: keyof Panels }) {
  return (
    <button className="ibtn panel-close" title={`Close ${LABEL[side].toLowerCase()} (Esc)`} aria-label={`Close ${LABEL[side].toLowerCase()}`} onClick={() => closePanel(side)}>
      <X size={14} />
    </button>
  );
}

/** Closes a panel and gives focus back to the toolbar button that opens it. */
export function closePanel(side: keyof Panels) {
  togglePanel(side, false);
  document.getElementById(`panel-toggle-${side}`)?.focus({ preventScroll: true });
}

/** After the panel has rendered open: focus its selected tab. */
export function focusPanel(side: keyof Panels) {
  requestAnimationFrame(() => document.querySelector<HTMLElement>(`${panelSelector(side)} [role=tab][aria-selected=true]`)?.focus({ preventScroll: true }));
}
