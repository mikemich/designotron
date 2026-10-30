import { create } from "zustand";
import { X } from "lucide-react";
import { ALT, MOD, SHIFT, useDialog } from "../ui/controls";

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
    ],
  },
  {
    title: "Edit",
    items: [
      ["Undo / redo", `${MOD}Z / ${SHIFT}${MOD}Z`],
      ["Duplicate", `${MOD}D`],
      ["Group / ungroup", `${MOD}G / ${SHIFT}${MOD}G`],
      ["Frame selection", `${ALT}${MOD}G`],
      ["Auto layout", `${SHIFT}A`],
      ["Create component", `${ALT}${MOD}K`],
      ["Detach instance", `${ALT}${MOD}B`],
      ["Bring forward / back", `${MOD}] / ${MOD}[`],
      ["Flip horizontal / vertical", `${SHIFT}H / ${SHIFT}V`],
      ["Hide / lock", `${SHIFT}${MOD}H / ${SHIFT}${MOD}L`],
      ["Flatten / outline stroke", `${MOD}E / ${SHIFT}${MOD}O`],
      ["Use as mask", `${ALT}${MOD}M`],
      ["Copy / paste properties", `${ALT}${MOD}C / ${ALT}${MOD}V`],
      ["Paste to replace", `${SHIFT}${MOD}R`],
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
      ["Rulers / layout grids", `${SHIFT}R / ${SHIFT}${MOD}4`],
      ["Claude panel", `${MOD}/`],
      ["Save .dtron file", `${MOD}S`],
      ["This list", "?"],
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
        <div className="shortcuts-body">
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
