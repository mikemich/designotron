// Which side panels (Layers, Design) are open. Below COMPACT_QUERY they are overlays that start
// closed and remember their own choice; above it they are columns that start open. Ctrl+\ hides
// both and brings back what was open (Figma's Show/Hide UI).

/** The phone layout: under 640 CSS px, or up to 820 px with a touch screen as the main pointer. A
 *  desktop at 200% zoom (720 px) keeps the tablet layout. The CSS phone queries must say the same. */
export const PHONE_QUERY = "(max-width: 639px), (max-width: 820px) and (pointer: coarse)";

/** Whether the window is a phone by the rule above (false where matchMedia is missing). */
export const isPhone = () => typeof window !== "undefined" && !!window.matchMedia?.(PHONE_QUERY).matches;

/** Tablet widths: the panels are overlays on the canvas. */
export const COMPACT_QUERY = "(max-width: 1100px)";
/** Up to here Claude's chat takes the Design panel's place (it has no room beside it). */
export const TIGHT_QUERY = "(max-width: 1280px)";

export interface Panels {
  left: boolean;
  right: boolean;
}

export interface PanelStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const key = (compact: boolean) => (compact ? "dt:panels-compact" : "dt:panels");

/** Both open on a desktop, both closed on a tablet. */
export function defaultPanels(compact: boolean): Panels {
  return { left: !compact, right: !compact };
}

/** What the person last chose in this mode, or the mode's default. Storage may be missing or broken. */
export function readPanels(compact: boolean, storage: PanelStorage | null): Panels {
  try {
    const raw = storage?.getItem(key(compact));
    if (raw) {
      const p = JSON.parse(raw);
      if (typeof p?.left === "boolean" && typeof p?.right === "boolean") return { left: p.left, right: p.right };
    }
  } catch {
    /* unreadable: use the default */
  }
  return defaultPanels(compact);
}

export function writePanels(compact: boolean, panels: Panels, storage: PanelStorage | null) {
  try {
    storage?.setItem(key(compact), JSON.stringify(panels));
  } catch {
    /* storage is full or blocked */
  }
}

/** Ctrl+\: hides what is open (remembering it), or brings the remembered panels back. With
 * nothing remembered a desktop opens both and a tablet only the Layers panel. */
export function toggleUi(panels: Panels, stash: Panels | null, compact: boolean): { panels: Panels; stash: Panels | null } {
  if (panels.left || panels.right) return { panels: { left: false, right: false }, stash: { ...panels } };
  const back = stash && (stash.left || stash.right) ? stash : compact ? { left: true, right: false } : defaultPanels(false);
  return { panels: { ...back }, stash: null };
}

/** Opens or closes one panel. Where Claude's chat would cover the Design panel (`chatCovers`),
 * opening the Design panel closes the chat: the one opened last wins. */
export function setPanel(
  panels: Panels,
  side: keyof Panels,
  open: boolean,
  chatOpen: boolean,
  chatCovers: boolean,
): { panels: Panels; chatOpen: boolean } {
  return { panels: { ...panels, [side]: open }, chatOpen: side === "right" && open && chatCovers ? false : chatOpen };
}

/** Whether a panel is on screen: the chat hides the Design panel where it covers it. */
export function panelShown(panels: Panels, side: keyof Panels, chatOpen: boolean, chatCovers: boolean): boolean {
  return panels[side] && !(side === "right" && chatOpen && chatCovers);
}
