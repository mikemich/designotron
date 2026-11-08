// A searchable, foldered list of styles, variables or alias targets, in a popover (or in place).
// The rows come from tokenPicker.ts; this file draws them and handles the keys.

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, Grid3x3, Hash, Palette, Search, Sparkles, ToggleLeft, Type as TypeIcon } from "lucide-react";
import { Popover } from "../ui/controls";
import { cssColor } from "../ui/color";
import { firstItem, folderKeys, moveActive, OPEN_UP_TO, pickerRows, type PickerItem, type PickerPreview, type PickerRow } from "./tokenPicker";

export type { PickerItem } from "./tokenPicker";

/** A command above the list ("Detach"). */
export interface PickerAction {
  label: string;
  onClick: () => void;
}

interface ListProps {
  items: PickerItem[];
  /** The item that is applied now (checked, and its folders start open). */
  selectedId?: string | null;
  actions?: PickerAction[];
  placeholder?: string;
  emptyText?: string;
  label: string;
  onPick: (item: PickerItem) => void;
  /** Tab (the popover closes and focus goes back to its button). Left out for a list drawn in place. */
  onClose?: () => void;
  /** Max height of the list in px. */
  maxHeight?: number;
  /** Focus the search field on mount (default). A list drawn inside another popover leaves focus alone. */
  autoFocus?: boolean;
}

/** The search field and list, without a popover around it (the colour picker draws it in place). */
export function TokenList({ items, selectedId, actions = [], placeholder = "Search", emptyText = "Nothing here yet", label, onPick, onClose, maxHeight = 300, autoFocus = true }: ListProps) {
  const id = useId();
  const [query, setQuery] = useState("");
  const defaultOpen = items.length <= OPEN_UP_TO;
  // Folders the person opened or folded, against the default; the selected item's folders start open.
  const [toggled, setToggled] = useState<Set<string>>(() => {
    const sel = selectedId ? items.find((i) => i.id === selectedId) : undefined;
    return new Set(!defaultOpen && sel ? folderKeys(sel) : []);
  });
  const [active, setActive] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);
  const model = useMemo(() => pickerRows(items, query, (key) => defaultOpen !== toggled.has(key)), [items, query, toggled, defaultOpen]);
  const rows: PickerRow[] = useMemo(
    () => [...(query.trim() ? [] : actions.map((a, i): PickerRow => ({ type: "action", key: "a:" + i, label: a.label }))), ...model.rows],
    [actions, model.rows, query],
  );
  const toggle = (key: string) =>
    setToggled((t) => {
      const next = new Set(t);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const run = (r: PickerRow) => {
    if (r.type === "item") onPick(r.item);
    else if (r.type === "action") actions[Number(r.key.slice(2))]?.onClick();
    else if (r.type === "folder" || r.type === "group") {
      if (!query.trim()) toggle(r.key);
    }
  };
  useEffect(() => {
    if (active >= 0) listRef.current?.querySelector<HTMLElement>(`[data-row="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
      e.preventDefault();
      e.stopPropagation();
      setActive(moveActive(rows, active, e.key));
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      const at = active >= 0 ? active : query.trim() ? firstItem(rows) : -1;
      if (at >= 0) run(rows[at]);
    } else if (e.key === "Escape") {
      // The first Escape clears the search; the next one reaches the popover and closes it.
      if (query) {
        e.preventDefault();
        e.stopPropagation();
        setQuery("");
        setActive(-1);
      }
    } else if (e.key === "Tab" && onClose) {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };
  const rowId = (i: number) => `${id}-r${i}`;
  return (
    <div className="tp" data-token-picker>
      <div className="tp-search">
        <Search size={13} aria-hidden="true" />
        <input
          type="search"
          className="textinput"
          role="combobox"
          aria-label={`Search ${label}`}
          aria-expanded="true"
          aria-controls={id}
          aria-activedescendant={active >= 0 ? rowId(active) : undefined}
          placeholder={placeholder}
          value={query}
          autoFocus={autoFocus}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(-1);
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className="sr-only" role="status" aria-live="polite">
        {query.trim() ? `${model.matched} match${model.matched === 1 ? "" : "es"}` : ""}
      </div>
      <div ref={listRef} id={id} className="tp-list" role="listbox" aria-label={label} style={{ maxHeight }}>
        {rows.map((r, i) => (
          <Row key={r.key} r={r} i={i} id={rowId(i)} active={i === active} selected={r.type === "item" && r.item.id === selectedId} onRun={() => run(r)} />
        ))}
        {!model.matched && (
          <div className="tp-empty muted small">{items.length ? `No matches for “${query.trim()}”` : emptyText}</div>
        )}
      </div>
    </div>
  );
}

function Row({ r, i, id, active, selected, onRun }: { r: PickerRow; i: number; id: string; active: boolean; selected: boolean; onRun: () => void }) {
  if (r.type === "more")
    return (
      <div className="tp-more muted small" data-tp-more>
        {r.hidden.toLocaleString()} more. Search to narrow the list.
      </div>
    );
  const common = {
    id,
    "data-row": i,
    role: "option" as const,
    "aria-selected": selected || undefined,
    // Keeping the pointer from taking focus leaves the caret in the search field.
    onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
    onClick: onRun,
  };
  if (r.type === "action")
    return (
      <div {...common} className={"tp-row tp-action" + (active ? " active" : "")} data-tp-action={r.label}>
        <span className="tp-name">{r.label}</span>
      </div>
    );
  if (r.type === "item") {
    const { item } = r;
    return (
      <div {...common} className={"tp-row" + (active ? " active" : "") + (selected ? " on" : "")} style={{ paddingLeft: 6 + r.depth * 12 }} title={item.description ? `${item.name}\n${item.description}` : item.name} data-tp-item={item.id} data-tp-name={item.name}>
        <Preview p={item.preview} />
        <span className="tp-name">{r.label}</span>
        {r.hint && <span className="tp-hint muted small">{r.hint}</span>}
        {selected && <Check size={12} className="tp-check" aria-label="Applied" />}
      </div>
    );
  }
  return (
    <div {...common} aria-expanded={r.open} className={"tp-row tp-folder" + (r.type === "group" ? " tp-group" : "") + (r.fixed ? " tp-fixed" : "") + (active ? " active" : "")} style={{ paddingLeft: 4 + r.depth * 12 }} data-tp-folder={r.label}>
      {r.open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      <span className="tp-name">{r.label}</span>
      <span className="muted small">{r.count}</span>
    </div>
  );
}

function Preview({ p }: { p?: PickerPreview }) {
  if (!p) return <span className="tp-pre" />;
  if (p.type === "color")
    return (
      <span className="swatch tp-pre" aria-hidden="true">
        <i style={{ background: cssColor(p.color) }} />
      </span>
    );
  if (p.type === "text")
    return (
      <span className="tp-pre tp-ag" style={{ fontFamily: p.family, fontWeight: p.weight }} aria-hidden="true">
        Ag
      </span>
    );
  const Icon = { effect: Sparkles, grid: Grid3x3, color: Palette, number: Hash, string: TypeIcon, boolean: ToggleLeft }[p.icon];
  return (
    <span className="tp-pre muted" aria-hidden="true">
      <Icon size={12} />
    </span>
  );
}

/** The picker as a popover anchored at a button. It closes after a pick. */
export function TokenPicker({ anchor, onClose, onPick, width = 280, actions, ...rest }: Omit<ListProps, "onPick" | "onClose"> & { anchor: DOMRect; width?: number; onPick: (item: PickerItem) => void; onClose: () => void }) {
  return (
    <Popover anchor={anchor} onClose={onClose} label={rest.label} width={width} focusOnOpen={false}>
      <TokenList
        {...rest}
        actions={actions?.map((a) => ({
          ...a,
          onClick: () => {
            a.onClick();
            onClose();
          },
        }))}
        onClose={onClose}
        onPick={(item) => {
          onPick(item);
          onClose();
        }}
      />
    </Popover>
  );
}
