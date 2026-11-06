import { create } from "zustand";
import { X } from "lucide-react";
import { ALT, MOD, SHIFT, useDialog, ALT_MOD, SHIFT_MOD, FRONT_MOD } from "../ui/controls";
import { TIDY_KBD } from "../canvas/contextMenu";

export const useShortcuts = create<{ open: boolean }>(() => ({ open: false }));

const GROUPS: { title: string; items: [string, string][] }[] = [
  {
    title: "Tools",
    items: [
      ["Move", "V"],
      ["Frame", "F or A"],
      ["Rectangle / ellipse", "R / O"],
      ["Line / arrow", `L / ${SHIFT}L`],
      ["Pen / pencil", `P / ${SHIFT}P`],
      ["Text", "T"],
      ["Hand", "H or hold Space"],
      ["Comment", "C"],
      ["Scale (resizes strokes, type and spacing too) / eyedropper", "K / I"],
      ["Enter with a shape, text or frame tool inserts a layer", "Enter"],
      ["Insert inside the selected frame", `${MOD}Enter`],
    ],
  },
  {
    title: "Edit",
    items: [
      ["Undo / redo", `${MOD}Z / ${SHIFT_MOD}Z`],
      ["Duplicate", `${MOD}D`],
      ["Group / ungroup", `${MOD}G / ${SHIFT_MOD}G`],
      ["Frame selection", `${ALT_MOD}G`],
      ["Auto layout", `${SHIFT}A`],
      ["Create component", `${ALT_MOD}K`],
      ["Detach instance", `${ALT_MOD}B`],
      ["Bring forward / back", `${MOD}] / ${MOD}[`],
      ["Bring to front / send to back", `${FRONT_MOD}] / ${FRONT_MOD}[`],
      ["Flip horizontal / vertical", `${SHIFT}H / ${SHIFT}V`],
      ["Hide / lock", `${SHIFT_MOD}H / ${SHIFT_MOD}L`],
      ["Flatten / outline stroke", `${MOD}E / ${SHIFT_MOD}O`],
      ["Use as mask", `${ALT_MOD}M`],
      ["Copy / paste properties", `${ALT_MOD}C / ${ALT_MOD}V`],
      ["Paste to replace", `${SHIFT_MOD}R`],
      ["Paste over selection", `${SHIFT_MOD}V`],
      ["Select matching layers / invert selection", `${ALT_MOD}A / ${SHIFT_MOD}A`],
      ["Tidy up (Linux and ChromeOS take Ctrl+Alt+T: use Edit menu > Tidy up)", TIDY_KBD],
      ["Align left / right / top / bottom", `${ALT}A ${ALT}D ${ALT}W ${ALT}S`],
    ],
  },
  {
    title: "Vector editing",
    items: [
      ["Edit a path's points", "Double-click"],
      ["Add a point", "Click the path"],
      ["Select points", `Click, ${SHIFT}click, drag`],
      ["Select all points", `${MOD}A`],
      ["Delete points", "Delete / Backspace"],
      ["Move points", "Drag or arrows"],
      ["Sharp / smooth point", "Double-click a point"],
      ["Move one handle only", `${ALT}drag`],
      ["Continue an open path", "Pen on its end"],
      ["Done", "Esc / Enter"],
    ],
  },
  {
    title: "View",
    items: [
      ["Zoom to fit / selection", `${SHIFT}1 / ${SHIFT}2`],
      ["Zoom to 100%", `${SHIFT}0`],
      ["Zoom in / out", `${MOD}+ / ${MOD}−`],
      ["Rulers / layout grids", `${SHIFT}R / ${SHIFT_MOD}4`],
      ["Claude panel", `${MOD}/`],
      ["Cursor chat (with others in the file)", "/"],
      ["Stop following someone", "Esc"],
      ["Save in this browser", `${MOD}S`],
      ["Download a .dtron file", `${SHIFT_MOD}S`],
      ["This list", "?"],
    ],
  },
  {
    title: "Keyboard navigation",
    items: [
      ["Next / previous sibling layer", "Tab / ⇧Tab"],
      ["Select children / parent", "Enter / ⇧Enter"],
      ["Select parent", "\\"],
      ["Clear the selection", "Esc"],
      ["Add to / remove from the selection", `${SHIFT}click`],
      ["Move along one axis", `${SHIFT}drag`],
      ["Move between panels and canvas", `F6 / ${SHIFT}F6`],
      ["Next / previous page", `${ALT}Page Down / ${ALT}Page Up`],
      ["Layers: move and select", "↑ ↓ Home End"],
      ["Layers: expand / collapse", "→ / ←"],
      ["Rename the selected layer", "F2"],
      ["Layers: rename", "F2"],
      ["Layers: select the row / delete", "Space / Delete"],
      ["Layers: reorder", `${ALT}${SHIFT}↑ / ${ALT}${SHIFT}↓`],
      ["Layers: focus the canvas", "Enter"],
      ["Pages: move / switch / rename", "↑ ↓ / Enter / F2"],
      ["Pages: reorder", `${ALT}${SHIFT}↑ / ${ALT}${SHIFT}↓`],
    ],
  },
];

export function ShortcutsDialog() {
  const open = useShortcuts((s) => s.open);
  const close = () => useShortcuts.setState({ open: false });
  const dialogRef = useDialog(close, open);
  if (!open) return null;
  return (
    <div className="modal-bg" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={dialogRef} className="modal shortcuts-dialog" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
        <div className="modal-head">
          <b>Keyboard shortcuts</b>
          <button className="ibtn" title="Close" onClick={close} style={{ marginLeft: "auto" }}>
            <X size={14} />
          </button>
        </div>
        <div className="shortcuts-body" tabIndex={0} role="region" aria-label="Shortcut list">
          {GROUPS.map((g) => (
            <div key={g.title}>
              <div className="section-head">{g.title}</div>
              {g.items.map(([label, keys]) => (
                <div key={label} className="shortcut-row">
                  <span>{label}</span>
                  <kbd>{keys}</kbd>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
