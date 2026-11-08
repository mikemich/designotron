// The model behind the token picker (styles, bound variables, aliases): which rows to draw for a
// list of items, a search and the folders that are open. Pure, so the key handling, the search
// and the 200-row cap are tested without a browser. See TokenPicker.tsx for the popover.

import { folderSize, groupBySlash, type Folder } from "./groupBySlash";

/** Rows drawn at most; the rest is reached by searching or by opening folders. */
export const ROW_CAP = 200;
/** Up to this many items every folder starts open; a longer list starts folded. */
export const OPEN_UP_TO = 60;

/** What a row shows in front of its name. */
export type PickerPreview =
  | { type: "color"; color: string }
  | { type: "text"; family: string; weight: number }
  | { type: "icon"; icon: "effect" | "grid" | "color" | "number" | "string" | "boolean" };

export interface PickerItem {
  id: string;
  /** Full name with its slash folders ("Brand/Primary/500"). */
  name: string;
  /** Collection the item lives in (variables); the picker lists one heading per collection. */
  group?: string;
  description?: string;
  preview?: PickerPreview;
}

export type PickerRow =
  /** A collection heading (collapsible like a folder). */
  | { type: "group"; key: string; label: string; depth: 0; open: boolean; count: number; /** Held open by a search: the keys skip it. */ fixed: boolean }
  | { type: "folder"; key: string; label: string; depth: number; open: boolean; count: number; fixed: boolean }
  | { type: "item"; key: string; item: PickerItem; label: string; depth: number; /** Folder path, shown muted while searching. */ hint: string }
  /** A command before the list ("Detach"). */
  | { type: "action"; key: string; label: string }
  /** Rows left out by the cap. */
  | { type: "more"; key: string; hidden: number };

export interface PickerModel {
  rows: PickerRow[];
  /** Items that match the search (drawn or not). */
  matched: number;
  /** Items drawn. */
  drawn: number;
}

/** Lower case without accents, so "Écran" is found by "ecran". */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** True when every word of the query is in the item's name, collection or description. */
export function matchesQuery(item: PickerItem, query: string): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = fold([item.name, item.group ?? "", item.description ?? ""].join(" "));
  return words.every((w) => hay.includes(w));
}

/**
 * The rows for `items` under `query`. Items are grouped by collection, then by the folders in their
 * names, in the order they first appear. While searching every folder is open; otherwise `open`
 * says which are. At most `cap` rows are returned, with a final "more" row counting what was cut.
 */
export function pickerRows(items: PickerItem[], query: string, open: (key: string) => boolean, cap = ROW_CAP): PickerModel {
  const searching = query.trim() !== "";
  const hits = searching ? items.filter((i) => matchesQuery(i, query)) : items;
  const rows: PickerRow[] = [];
  const grouped = hits.some((i) => i.group !== undefined);
  const emit = (folder: Folder<PickerItem>, depth: number, scope: string) => {
    for (const f of folder.folders) {
      const key = `f:${scope}:${f.path}`;
      const isOpen = searching || open(key);
      rows.push({ type: "folder", key, label: f.name, depth, open: isOpen, count: folderSize(f), fixed: searching });
      if (isOpen) emit(f, depth + 1, scope);
    }
    for (const e of folder.items) {
      const cut = e.item.name.lastIndexOf("/");
      rows.push({ type: "item", key: "i:" + e.item.id, item: e.item, label: e.label || e.item.name || "Untitled", depth, hint: searching && cut > 0 ? e.item.name.slice(0, cut).trim() : "" });
    }
  };
  if (grouped) {
    const byGroup = new Map<string, PickerItem[]>();
    for (const i of hits) {
      const list = byGroup.get(i.group ?? "");
      if (list) list.push(i);
      else byGroup.set(i.group ?? "", [i]);
    }
    for (const [group, list] of byGroup) {
      const key = `c:${group}`;
      const isOpen = searching || open(key);
      rows.push({ type: "group", key, label: group || "Other", depth: 0, open: isOpen, count: list.length, fixed: searching });
      if (isOpen) emit(groupBySlash(list, (i) => i.name), 1, group);
    }
  } else {
    emit(groupBySlash(hits, (i) => i.name), 0, "");
  }
  const itemRows = (list: PickerRow[]) => list.filter((r) => r.type === "item").length;
  if (rows.length <= cap) return { rows, matched: hits.length, drawn: itemRows(rows) };
  const kept = rows.slice(0, cap);
  const hidden = itemRows(rows.slice(cap));
  kept.push({ type: "more", key: "more", hidden });
  return { rows: kept, matched: hits.length, drawn: itemRows(kept) };
}

/** The keys of the collection heading and folders that hold `item`, outermost first (what must be open to see it). */
export function folderKeys(item: PickerItem): string[] {
  const scope = item.group ?? "";
  const keys = item.group !== undefined ? [`c:${scope}`] : [];
  const segs = item.name.split("/").map((p) => p.trim()).filter((p) => p !== "");
  let path = "";
  for (const seg of segs.slice(0, -1)) {
    path = path ? `${path}/${seg}` : seg;
    keys.push(`f:${scope}:${path}`);
  }
  return keys;
}

/** Rows the keys can land on: items, actions, and folders and collection headings that can be toggled (not while searching). */
export const isStop = (r: PickerRow): boolean => r.type !== "more" && !((r.type === "folder" || r.type === "group") && r.fixed);

/**
 * The row an arrow key moves to. `at` is the current row (-1: none yet). Down from nothing lands on
 * the first row, Up from nothing on the last; the ends don't wrap.
 */
export function moveActive(rows: PickerRow[], at: number, key: "ArrowDown" | "ArrowUp" | "Home" | "End"): number {
  const stops = rows.map((r, i) => (isStop(r) ? i : -1)).filter((i) => i >= 0);
  if (!stops.length) return -1;
  if (key === "Home") return stops[0];
  if (key === "End") return stops[stops.length - 1];
  const pos = stops.indexOf(at);
  if (key === "ArrowDown") return pos < 0 ? (at < 0 ? stops[0] : (stops.find((i) => i > at) ?? stops[stops.length - 1])) : stops[Math.min(pos + 1, stops.length - 1)];
  return pos < 0 ? (at < 0 ? stops[stops.length - 1] : ([...stops].reverse().find((i) => i < at) ?? stops[0])) : stops[Math.max(pos - 1, 0)];
}

/** The first item row, for Enter pressed straight after typing. */
export function firstItem(rows: PickerRow[]): number {
  return rows.findIndex((r) => r.type === "item");
}
