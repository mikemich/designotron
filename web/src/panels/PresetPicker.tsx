import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { query } from "../store";
import { filterPresets, groupPresets, nextIndex, type DevicePreset } from "./presetList";

let cache: DevicePreset[] | null = null;

/** The engine's preset table (read once). */
export function devicePresets(): DevicePreset[] {
  cache ??= query<DevicePreset[]>({ q: "devicePresets" });
  return cache;
}

/**
 * A search box over the presets, grouped (Phone, Tablet, Desktop, Web, Social, Print,
 * Presentation). Arrow keys move through the rows, Home and End jump, Enter picks the highlighted
 * row (or the first match), Escape clears the filter.
 */
export function PresetPicker(props: { onPick: (p: DevicePreset) => void; autoFocus?: boolean; label?: string }) {
  const uid = useId();
  const listId = `${uid}-list`;
  const optId = (id: string) => `${uid}-opt-${id}`;
  const [filter, setFilter] = useState("");
  const [active, setActive] = useState(-1);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const matches = useMemo(() => filterPresets(devicePresets(), filter), [filter]);
  const groups = useMemo(() => groupPresets(matches), [matches]);
  useEffect(() => {
    if (props.autoFocus) input.current?.focus();
  }, []);
  useEffect(() => {
    if (active >= 0) list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [active]);
  let index = -1;
  return (
    <div className="preset-picker">
      <label className="field preset-search">
        <Search size={12} />
        <input
          ref={input}
          type="search"
          value={filter}
          placeholder="Search devices and sizes"
          aria-label={props.label ?? "Search presets"}
          aria-controls={listId}
          aria-activedescendant={active >= 0 && matches[active] ? optId(matches[active].id) : undefined}
          onChange={(e) => {
            setFilter(e.target.value);
            setActive(-1);
          }}
          onKeyDown={(e) => {
            if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
              // Home and End move the caret while the field has text; the list takes them once a row is highlighted.
              if ((e.key === "Home" || e.key === "End") && active < 0 && filter) return e.stopPropagation();
              e.preventDefault();
              e.stopPropagation();
              setActive((a) => nextIndex(a, matches.length, e.key));
            } else if (e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              const pick = matches[active >= 0 ? active : 0];
              if (pick) props.onPick(pick);
            } else if (e.key === "Escape" && filter) {
              e.preventDefault();
              e.stopPropagation();
              setFilter("");
              setActive(-1);
            } else {
              e.stopPropagation();
            }
          }}
        />
      </label>
      <div ref={list} id={listId} className="frame-presets preset-list" role="listbox" aria-label="Presets">
        {groups.map((g) => (
          <div key={g.group} role="group" aria-label={g.group} className="preset-group">
            <div className="preset-group-label" aria-hidden="true">
              {g.group}
            </div>
            {g.items.map((p) => {
              const i = ++index;
              return (
                <button
                  key={p.id}
                  id={optId(p.id)}
                  data-index={i}
                  role="option"
                  aria-selected={i === active}
                  tabIndex={-1}
                  className={"btn block preset" + (i === active ? " active" : "")}
                  onClick={() => props.onPick(p)}
                >
                  <span>{p.label}</span>
                  <span className="muted small">
                    {p.w}×{p.h}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
        {!matches.length && <div className="muted small preset-empty">No preset matches "{filter}".</div>}
      </div>
    </div>
  );
}
