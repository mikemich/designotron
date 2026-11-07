import { Fragment, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { HistoryPanel } from "./HistoryPanel";
import { CommentsPanel } from "./CommentsPanel";
import {
  ChevronDown,
  SquareDashed,
  ChevronRight,
  Circle,
  Component,
  Diamond,
  Eye,
  EyeOff,
  File,
  Frame,
  Hash,
  Image as ImageIcon,
  Lock,
  Minus,
  PenTool,
  ListFilter,
  Plus,
  Search,
  Square,
  Star,
  Triangle,
  Type,
  Unlock,
  X as XIcon,
  Group as GroupIcon,
} from "lucide-react";
import { dispatch, useDoc, useStore, zoomToSelection } from "../store";
import type { Doc, Node } from "../types";
import { ALT, ALT_MOD, IconButton, Menu, SHIFT, type MenuItem } from "../ui/controls";
import { canvasMenu } from "../canvas/contextMenu";
import { LAYER_FILTERS, LAYER_FILTER_LABELS, collapseAllLayers, descendantContainers, rangeIds, searchLayers, setLayerExpanded, useLayerTree, type LayerFilter, type LayerSearch } from "./layerTree";
import { PanelClose } from "./PanelChrome";
import * as A from "../actions";
import { viewportCenter } from "../actions";
import { ColorStylesSection, EffectStylesSection, GridStylesSection, TextStylesSection } from "./StyleControls";
import { FolderTree } from "./FolderTree";
import { useThumb } from "./assetThumbs";
import { orderedEntries, propertyOrder, swapGroups } from "../componentOps";
import { PhotoSearch } from "./PhotoSearch";
import { ImageAssets } from "./ImageAssets";
import { useCollab } from "../collab";

/** A mouse click on a row, page or tab leaves the keys with the canvas, as it did before these were
 * focusable: Space pans, arrows nudge, Enter selects children. Keyboard activation (detail 0) and
 * double-clicks (rename) keep their focus. */
function returnFocusToCanvas(e: React.MouseEvent) {
  if (e.detail === 1) document.getElementById("dt-canvas")?.focus({ preventScroll: true });
}

const LEFT_TABS = [
  ["layers", "Layers"],
  ["assets", "Assets"],
  ["history", "History"],
  ["comments", "Comments"],
] as const;

export function LeftPanel() {
  const tab = useStore((s) => s.leftTab);
  // Tabs are one tab stop; the arrow keys move between them (and switch, as a click does).
  const onTabKey = (e: React.KeyboardEvent) => {
    const at = LEFT_TABS.findIndex(([id]) => id === tab);
    const to = e.key === "ArrowRight" ? at + 1 : e.key === "ArrowLeft" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? LEFT_TABS.length - 1 : -1;
    if (to < 0 || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    e.stopPropagation();
    const [id] = LEFT_TABS[(to + LEFT_TABS.length) % LEFT_TABS.length];
    useStore.setState({ leftTab: id });
    requestAnimationFrame(() => document.getElementById(`left-tab-${id}`)?.focus());
  };
  return (
    <div className="panel" id="panel-left" role="region" aria-label="Layers panel">
      <PanelClose side="left" />
      <div className="tabs" role="tablist" aria-label="Left panel" onKeyDown={onTabKey}>
        {LEFT_TABS.map(([id, label]) => (
          <button
            key={id}
            role="tab"
            id={`left-tab-${id}`}
            aria-selected={tab === id}
            aria-controls="left-tabpanel"
            tabIndex={tab === id ? 0 : -1}
            className={"tab" + (tab === id ? " active" : "")}
            onClick={(e) => {
              useStore.setState({ leftTab: id });
              returnFocusToCanvas(e);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="tabpanel" role="tabpanel" id="left-tabpanel" aria-labelledby={`left-tab-${tab}`}>
        <h2 className="sr-only">{LEFT_TABS.find(([id]) => id === tab)?.[1]}</h2>
        {tab === "layers" ? (
          <>
            <Pages />
            <Layers />
          </>
        ) : tab === "assets" ? (
          <Assets />
        ) : tab === "comments" ? (
          <CommentsPanel />
        ) : (
          <HistoryPanel />
        )}
      </div>
    </div>
  );
}

function Pages() {
  const doc = useDoc();
  const page = useStore((s) => s.es.page);
  /** A view-only visitor can look through the pages but not add, rename, move or delete them. */
  const engineReadOnly = useStore((s) => !!s.es.readOnly);
  const viewing = useCollab((s) => s.viewer);
  const viewOnly = engineReadOnly || viewing;
  const [renaming, setRenaming] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [more, setMore] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  /** Where a dragged page or layer would land: on a page (layers) or before/after it (pages). */
  const [drop, setDrop] = useState<{ id: string; where: "before" | "after" | "on" } | null>(null);
  const dragPage = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const tabStop = focusId && doc.pages.some((p) => p.id === focusId) ? focusId : page;

  // "N more" cue for a list that scrolls (27 pages show 8).
  const measure = () => {
    const el = listRef.current;
    if (!el) return;
    const below = el.scrollHeight - el.scrollTop - el.clientHeight;
    const item = el.firstElementChild?.getBoundingClientRect().height || 28;
    setMore(below > 4 ? Math.max(1, Math.round(below / item)) : 0);
  };
  useEffect(() => {
    measure();
    const el = listRef.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [doc.pages.length]);

  const focusPage = (id: string) => {
    setFocusId(id);
    const el = listRef.current?.querySelector<HTMLElement>(`[data-page="${CSS.escape(id)}"]`);
    el?.focus();
    el?.scrollIntoView({ block: "nearest" });
  };
  const removePage = (id: string) => {
    const i = doc.pages.findIndex((p) => p.id === id);
    const next = doc.pages[i + 1] ?? doc.pages[i - 1];
    dispatch({ op: "deletePage", id });
    if (next) requestAnimationFrame(() => focusPage(next.id));
  };
  const onKey = (e: React.KeyboardEvent, id: string, i: number) => {
    // Alt+Shift+Arrow reorders, as it does in the layers tree.
    if (!viewOnly && e.target === e.currentTarget && e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      e.stopPropagation();
      A.movePage(id, i + (e.key === "ArrowUp" ? -1 : 1));
      requestAnimationFrame(() => focusPage(id));
      return;
    }
    if (e.target !== e.currentTarget || e.ctrlKey || e.metaKey || e.altKey) return;
    const go = (to: number) => {
      e.preventDefault();
      e.stopPropagation();
      const p = doc.pages[Math.max(0, Math.min(doc.pages.length - 1, to))];
      if (p) focusPage(p.id);
    };
    switch (e.key) {
      case "ArrowDown":
        return go(i + 1);
      case "ArrowUp":
        return go(i - 1);
      case "Home":
        return go(0);
      case "End":
        return go(doc.pages.length - 1);
      case "Enter":
      case " ":
        e.preventDefault();
        e.stopPropagation();
        return dispatch({ op: "setPage", id });
      case "F2":
        e.preventDefault();
        return viewOnly ? undefined : setRenaming(id);
      case "Delete":
      case "Backspace":
        e.preventDefault();
        e.stopPropagation();
        if (!viewOnly && doc.pages.length > 1) removePage(id);
    }
  };
  return (
    <div className="pages">
      <div className="section-head" style={{ marginBottom: 4, padding: "0 4px" }}>
        <span id="pages-label">Pages</span>
        {!viewOnly && (
          <IconButton title="Add page" onClick={() => dispatch({ op: "addPage", name: null })}>
            <Plus size={14} />
          </IconButton>
        )}
      </div>
      <div
        className="pages-list"
        role="listbox"
        aria-labelledby="pages-label"
        ref={listRef}
        onScroll={measure}
        onFocus={(e) => {
          const id = (e.target as HTMLElement).closest<HTMLElement>("[data-page]")?.dataset.page;
          if (id) setFocusId(id);
        }}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as globalThis.Node | null)) setFocusId(null);
        }}
      >
        {doc.pages.map((p, i) => (
          <div
            key={p.id}
            data-page={p.id}
            role="option"
            aria-selected={p.id === page}
            tabIndex={p.id === tabStop ? 0 : -1}
            className={"page-item" + (p.id === page ? " active" : "") + (drop?.id === p.id && drop.where === "on" ? " drop-into" : "")}
            onClick={(e) => {
              dispatch({ op: "setPage", id: p.id });
              returnFocusToCanvas(e);
            }}
            onDoubleClick={() => !viewOnly && setRenaming(p.id)}
            onKeyDown={(e) => onKey(e, p.id, i)}
            draggable={!viewOnly && renaming !== p.id}
            onDragStart={(e) => {
              dragPage.current = p.id;
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("application/x-designotron-page", p.id);
            }}
            onDragEnd={() => {
              dragPage.current = null;
              setDrop(null);
            }}
            onDragOver={(e) => {
              if (viewOnly) return;
              const isPage = e.dataTransfer.types.includes("application/x-designotron-page");
              if (!isPage && !e.dataTransfer.types.includes("application/x-designotron-layer")) return;
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              const where = isPage ? ((e.clientY - r.top) / r.height < 0.5 ? "before" : "after") : "on";
              if (drop?.id !== p.id || drop.where !== where) setDrop({ id: p.id, where });
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as globalThis.Node | null)) setDrop((d) => (d?.id === p.id ? null : d));
            }}
            onDrop={(e) => {
              e.preventDefault();
              const at = drop?.id === p.id ? drop.where : "on";
              setDrop(null);
              const pageId = e.dataTransfer.getData("application/x-designotron-page");
              if (pageId) {
                const from = doc.pages.findIndex((x) => x.id === pageId);
                const slot = i + (at === "after" ? 1 : 0);
                A.movePage(pageId, slot > from ? slot - 1 : slot);
                return;
              }
              const layer = e.dataTransfer.getData("application/x-designotron-layer");
              if (!layer || p.id === page) return;
              // Dragging a layer that is part of the selection takes the whole selection along.
              const sel = useStore.getState().es.selection;
              A.moveToPage(sel.includes(layer) ? sel : [layer], p.id);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              if (viewOnly) return;
              setMenu({
                x: e.clientX,
                y: e.clientY,
                items: [
                  { label: "Rename", onClick: () => setRenaming(p.id) },
                  { label: "Duplicate page", onClick: () => A.duplicatePage(p.id) },
                  { label: "Move up", disabled: i === 0, onClick: () => A.movePage(p.id, i - 1) },
                  { label: "Move down", disabled: i === doc.pages.length - 1, onClick: () => A.movePage(p.id, i + 1) },
                  { label: "Delete page", disabled: doc.pages.length < 2, onClick: () => dispatch({ op: "deletePage", id: p.id }) },
                ],
              });
            }}
          >
            {drop?.id === p.id && drop.where !== "on" && <div className="drop-line" style={{ top: drop.where === "before" ? -1 : undefined, bottom: drop.where === "after" ? -1 : undefined, left: 8 }} />}
            <File size={12} aria-hidden="true" />
            {renaming === p.id ? (
              <RenameInput
                value={p.name}
                label="Page name"
                onDone={(name, how) => {
                  setRenaming(null);
                  if (name && name !== p.name) dispatch({ op: "renamePage", id: p.id, name });
                  if (how !== "blur") requestAnimationFrame(() => focusPage(p.id));
                }}
              />
            ) : (
              <span style={{ flex: 1 }}>{p.name}</span>
            )}
          </div>
        ))}
      </div>
      {more > 0 && (
        <div className="pages-more" aria-hidden="true">
          {more} more below
        </div>
      )}
      {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** How a rename ended: Enter or Escape ("key", the caller returns focus to its row), focus leaving
 * ("blur"), or Tab / Shift+Tab ("next" / "prev", only when `tabs` is set). */
type RenameEnd = "key" | "blur" | "next" | "prev";

/** Rename field for a layer or page. `onDone` runs once. */
function RenameInput({ value, label, tabs, onDone }: { value: string; label: string; tabs?: boolean; onDone: (v: string, how: RenameEnd) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const finish = (v: string, how: RenameEnd) => {
    if (done.current) return;
    done.current = true;
    onDone(v, how);
  };
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      defaultValue={value}
      className="textinput"
      aria-label={label}
      style={{ padding: "2px 4px" }}
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => finish(e.target.value.trim(), "blur")}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish((e.target as HTMLInputElement).value.trim(), "key");
        if (e.key === "Escape") finish(value, "key");
        if (e.key === "Tab" && tabs) {
          e.preventDefault();
          finish((e.target as HTMLInputElement).value.trim(), e.shiftKey ? "prev" : "next");
        }
      }}
    />
  );
}

export function nodeIcon(n: Node, size = 13) {
  if (n.isMask) return <SquareDashed size={size} />;
  switch (n.type) {
    case "frame":
      return n.layout ? <Frame size={size} /> : <Hash size={size} />;
    case "group":
      return <GroupIcon size={size} />;
    case "rectangle":
      return n.fills.some((f) => f.type === "image") ? <ImageIcon size={size} /> : <Square size={size} />;
    case "ellipse":
      return <Circle size={size} />;
    case "line":
      return <Minus size={size} />;
    case "polygon":
      return <Triangle size={size} />;
    case "star":
      return <Star size={size} />;
    case "vector":
      return <PenTool size={size} />;
    case "text":
      return <Type size={size} />;
    case "component":
    case "componentSet":
      return <Component size={size} />;
    case "instance":
      return <Diamond size={size} />;
  }
}

type DropPos = { id: string; where: "before" | "after" | "into" } | null;

function Layers() {
  const doc = useDoc();
  const page = useStore((s) => s.es.page);
  const sel = useStore((s) => s.es.selection);
  const expanded = useLayerTree((s) => s.expanded);
  const viewer = useCollab((s) => s.viewer);
  const engineReadOnly = useStore((s) => !!s.es.readOnly);
  /** A read-only tab or a view-only visitor can look through the layers but not rename or move them. */
  const viewOnly = engineReadOnly || viewer;
  const [renaming, setRenaming] = useState<string | null>(null);
  const [drop, setDrop] = useState<DropPos>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const dragId = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Row with keyboard focus (the tree's one tab stop), and the row focus should move to once drawn. */
  const [focusId, setFocusId] = useState<string | null>(null);
  const pendingFocus = useRef<string | null>(null);
  /** Where Shift+Arrow ranges start. */
  const anchor = useRef<string | null>(null);
  /** The selection key (ids joined) this panel itself last made: it is already in view, so it isn't revealed,
   * and it keeps the anchor. Any other selection (canvas, Claude, a collaborator) resets the anchor. */
  const fromPanel = useRef<string | null>(null);
  const panelSelect = (ids: string[], mode?: "toggle") => {
    dispatch(mode ? { op: "select", ids, mode } : { op: "select", ids });
    fromPanel.current = useStore.getState().es.selection.join(",");
  };
  /** Whether the search results are showing, and what they hold (set below, read by callbacks). */
  const searchingRef = useRef(false);
  const foundRef = useRef<LayerSearch | null>(null);

  // F2 on the canvas: start renaming once the row is revealed and drawn. While searching, only a layer
  // that is in the results has a row to hold the field.
  const renameRequest = useStore((s) => s.renameRequest);
  useEffect(() => {
    if (!renameRequest) return;
    useStore.setState({ renameRequest: null });
    setTimeout(
      () =>
        requestAnimationFrame(() => {
          if (!doc.nodes[renameRequest] || viewOnly) return;
          if (searchingRef.current && !foundRef.current?.hits.some((h) => h.id === renameRequest)) return;
          setRenaming(renameRequest);
        }),
      0,
    );
  }, [renameRequest]);

  // Reveal selected layers: open their ancestors, then scroll once the rows exist (the expanded set
  // takes a render to show up in `rows`).
  const reveal = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (sel.join(",") === fromPanel.current) return;
    fromPanel.current = null;
    anchor.current = null;
    if (!sel.length) return;
    reveal.current = sel[0];
    setLayerExpanded((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const id of sel) {
        let p = doc.nodes[id]?.parent;
        while (p) {
          if (!next.has(p)) {
            next.add(p);
            changed = true;
          }
          p = doc.nodes[p]?.parent ?? null;
        }
      }
      return changed ? next : prev;
    });
  }, [sel.join(",")]);

  const rows = useMemo(() => {
    const out: { n: Node; depth: number; pos: number; size: number }[] = [];
    const walk = (ids: string[], depth: number) => {
      const shown = [...ids].reverse().filter((id) => doc.nodes[id]);
      shown.forEach((id, k) => {
        const n = doc.nodes[id];
        out.push({ n, depth, pos: k + 1, size: shown.length });
        if (n.children.length && expanded.has(id)) walk(n.children, depth + 1);
      });
    };
    walk(doc.pages.find((p) => p.id === page)?.children ?? [], 0);
    return out;
  }, [doc, page, expanded]);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  // Search and filter (current page). The query is kept per page for the session.
  const [searches, setSearches] = useState<Record<string, { q: string; f: LayerFilter[] }>>({});
  const search = searches[page] ?? { q: "", f: [] };
  const setSearch = (patch: Partial<{ q: string; f: LayerFilter[] }>) => setSearches((m) => ({ ...m, [page]: { ...(m[page] ?? { q: "", f: [] }), ...patch } }));
  // The debounced query belongs to a page: after a page switch the new page's own query counts at once.
  const [deb, setDeb] = useState({ page, q: "" });
  useEffect(() => {
    const t = setTimeout(() => setDeb({ page, q: search.q }), 120);
    return () => clearTimeout(t);
  }, [search.q, page]);
  const debounced = deb.page === page ? deb.q : search.q;
  // Emptying the field shows the tree at once; typing waits for the debounce.
  const activeQuery = search.q.trim() ? debounced : "";
  const filters = useMemo(() => new Set(search.f), [search.f]);
  // "Match text content" (the Filter menu): off searches layer names only. Kept per browser.
  const [content, setContentState] = useState(() => {
    try {
      return localStorage.getItem("dt:layer-search-content") !== "0";
    } catch {
      return true;
    }
  });
  const setContent = (on: boolean) => {
    setContentState(on);
    try {
      localStorage.setItem("dt:layer-search-content", on ? "1" : "0");
    } catch {
      /* private mode: the choice lasts until reload */
    }
  };
  const searching = activeQuery.trim() !== "" || filters.size > 0;
  const found = useMemo(() => (searching ? searchLayers(doc, page, activeQuery, filters, 500, { content }) : null), [searching, doc, page, activeQuery, filters, content]);
  searchingRef.current = searching;
  foundRef.current = found;

  // Scroll the selected row into view once it is in `rows`. By index, since rows are windowed.
  useLayoutEffect(() => {
    const id = reveal.current;
    const el = scrollRef.current;
    if (!id || !el || searching) return;
    if (renaming || dragId.current) {
      reveal.current = null;
      return;
    }
    const i = rows.findIndex((r) => r.n.id === id);
    if (i < 0) {
      // Still waiting for an ancestor to open? Otherwise the layer is not on this page.
      let p = doc.nodes[id]?.parent;
      while (p && expanded.has(p)) p = doc.nodes[p]?.parent ?? null;
      if (!p) reveal.current = null;
      return;
    }
    reveal.current = null;
    const nearest = () => {
      if (i * ROW < el.scrollTop) el.scrollTop = i * ROW;
      else if ((i + 1) * ROW > el.scrollTop + el.clientHeight) el.scrollTop = (i + 1) * ROW - el.clientHeight;
    };
    nearest();
    // Once more after layout settles: the panel's height can still change in the frame that drew the rows.
    requestAnimationFrame(nearest);
  }, [rows, sel, searching]);
  // Leaving the search shows the tree again with the selection in view.
  const wasSearching = useRef(false);
  useLayoutEffect(() => {
    if (wasSearching.current !== searching) setRenaming(null);
    if (wasSearching.current && !searching && sel.length) reveal.current = sel[0];
    wasSearching.current = searching;
  }, [searching]);

  // The tree has one tab stop: the row that has focus, else the first selected row, else the first row.
  const lastFocus = useRef<string | null>(null);
  const has = (id: string | null) => !!id && rows.some((r) => r.n.id === id);
  const selSet = useMemo(() => new Set(sel), [sel]);
  const tabStop = (has(focusId) ? focusId : null) ?? rows.find((r) => selSet.has(r.n.id))?.n.id ?? (has(lastFocus.current) ? lastFocus.current : null) ?? rows[0]?.n.id ?? null;
  /** The row that has DOM focus, so a row that leaves `rows` under it (deleted, collapsed, page switched)
   * can hand focus on. Cleared when focus goes anywhere else. */
  const rowFocus = useRef<string | null>(null);

  /** Moves keyboard focus to a row, drawing it first when a long list has it out of view. */
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const focusRow = (id: string) => {
    pendingFocus.current = id;
    setFocusId(id);
    redraw();
  };
  useEffect(() => {
    // The focused row left the list (deleted here or by a collaborator, collapsed, page switched):
    // focus the tab stop. Scrolling it out of the window doesn't count, it stays drawn.
    if (rowFocus.current && !has(rowFocus.current)) {
      rowFocus.current = null;
      const lost = !document.activeElement || document.activeElement === document.body;
      if (!pendingFocus.current && lost && tabStop) pendingFocus.current = tabStop;
    }
    const id = pendingFocus.current;
    const el = scrollRef.current;
    if (!id || !el) return;
    const row = el.querySelector<HTMLElement>(`[data-layer="${CSS.escape(id)}"]`);
    if (row) {
      pendingFocus.current = null;
      row.focus();
      row.scrollIntoView({ block: "nearest" });
      return;
    }
    const i = rows.findIndex((r) => r.n.id === id);
    if (i < 0) pendingFocus.current = null;
    else el.scrollTop = Math.max(0, i * ROW - el.clientHeight / 2);
  });

  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      if (!(e.target as HTMLElement | null)?.closest?.("[role=tree]")) rowFocus.current = null;
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, []);

  /** Selects `ids`, or with `extend` the rows between the anchor and `ids[0]` (top-most only). `list` is
   * the visible rows: the tree, or the search results. */
  const select = (ids: string[], extend: boolean, list: { n: Node }[] = rows, flat = false) => {
    const seen = (id: string | null | undefined) => !!id && list.some((r) => r.n.id === id);
    // With nothing selected a Shift-click selects just the row, whatever the anchor was.
    const a = !sel.length ? null : seen(anchor.current) ? anchor.current : sel.find(seen);
    if (extend && a) return panelSelect(rangeIds(list, a, ids[0], !flat));
    anchor.current = ids[0];
    panelSelect(ids);
  };

  /** Click on a row of the tree or of the search results: Shift selects the range from the anchor,
   * ⌘/Ctrl toggles one row and becomes the anchor, a plain click selects it. */
  const clickRow = (e: React.MouseEvent, id: string, list: { n: Node }[], flat = false) => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey) {
      anchor.current = id;
      panelSelect([id], "toggle");
    } else select([id], e.shiftKey, list, flat);
    returnFocusToCanvas(e);
  };

  const toggleExpanded = (id: string, open?: boolean) =>
    setLayerExpanded((prev) => {
      const next = new Set(prev);
      if (open ?? !next.has(id)) next.add(id);
      else next.delete(id);
      return next;
    });

  /** Alt-click on a twisty: the row and everything below it opens, or closes. */
  const toggleAll = (id: string) => {
    const open = !expanded.has(id);
    const all = [id, ...descendantContainers(doc, id)];
    setLayerExpanded((prev) => {
      const next = new Set(prev);
      for (const x of all) open ? next.add(x) : next.delete(x);
      return next;
    });
  };

  /** Right-click menu for a row: the layer commands of the canvas menu, with the panel's own on top. */
  const rowMenu = (e: React.MouseEvent, n: Node) => {
    e.preventDefault();
    if (!selSet.has(n.id)) panelSelect([n.id]);
    const panel: MenuItem[] = [
      ...(viewOnly ? [] : [{ label: "Rename", kbd: "F2", onClick: () => setRenaming(n.id) }]),
      { label: "Zoom to layer", kbd: `${SHIFT}2`, onClick: zoomToSelection },
      { label: "Collapse all layers", kbd: `${ALT}L`, onClick: collapseAllLayers },
      { sep: true },
    ];
    setMenu({ x: e.clientX, y: e.clientY, items: [...panel, ...canvasMenu(null)] });
  };

  /** Focus back on a layer's row (or its search hit) once its rename is over. */
  const focusAfterRename = (id: string) => {
    if (!searchingRef.current) return focusRow(id);
    document.querySelector<HTMLElement>(`[data-layer-hit="${CSS.escape(id)}"]`)?.focus();
  };

  /** Tab / Shift+Tab in a rename: the next (previous) row down the panel (or hit in the results) is renamed,
   * and it stops at the ends. */
  const renameNeighbour = (id: string, dir: 1 | -1) => {
    const ids = searchingRef.current && foundRef.current ? foundRef.current.hits.map((h) => h.id) : rowsRef.current.map((r) => r.n.id);
    const at = ids.indexOf(id);
    const to = ids[at + dir];
    if (at < 0 || !to) return focusAfterRename(id);
    anchor.current = to;
    panelSelect([to]);
    requestAnimationFrame(() => {
      setRenaming(to);
      // Out of the drawn window: scroll it in first so its row exists to hold the field.
      const el = scrollRef.current;
      const i = rowsRef.current.findIndex((r) => r.n.id === to);
      if (!searchingRef.current && el && i >= 0 && (i * ROW < el.scrollTop || (i + 1) * ROW > el.scrollTop + el.clientHeight)) el.scrollTop = Math.max(0, i * ROW - el.clientHeight / 2);
    });
  };

  /** A rename ended in the tree or in the search results. */
  const renameDone = (n: Node, name: string, how: RenameEnd) => {
    setRenaming(null);
    if (name && name !== n.name) dispatch({ op: "update", ids: [n.id], patch: { name } });
    if (how === "next" || how === "prev") renameNeighbour(n.id, how === "next" ? 1 : -1);
    else if (how === "key") requestAnimationFrame(() => focusAfterRename(n.id));
  };

  /** WAI-ARIA tree keys on a row. Keys not handled here (tool letters, Escape, ⌘ combos) go on to the global shortcuts. */
  const onRowKey = (e: React.KeyboardEvent, i: number) => {
    if (e.target !== e.currentTarget) return;
    const { n } = rows[i];
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    const go = (to: number) => {
      handled();
      const r = rows[Math.max(0, Math.min(rows.length - 1, to))];
      if (!r) return;
      select([r.n.id], e.shiftKey);
      focusRow(r.n.id);
    };
    if (e.altKey && e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      handled();
      if (!sel.includes(n.id)) select([n.id], false);
      return A.reorder(e.key === "ArrowUp" ? "forward" : "backward");
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key) {
      case "ArrowDown":
        return go(i + 1);
      case "ArrowUp":
        return go(i - 1);
      case "Home":
        return go(0);
      case "End":
        return go(rows.length - 1);
      case "ArrowRight":
        handled();
        if (!n.children.length) return;
        if (!expanded.has(n.id)) return toggleExpanded(n.id, true);
        return go(i + 1);
      case "ArrowLeft": {
        handled();
        if (n.children.length && expanded.has(n.id)) return toggleExpanded(n.id, false);
        const parent = rows.findIndex((r, j) => j < i && r.n.id === n.parent);
        return parent >= 0 ? go(parent) : undefined;
      }
      case "Enter":
        handled();
        if (!selSet.has(n.id)) select([n.id], false);
        return document.getElementById("dt-canvas")?.focus();
      case " ":
        handled();
        if (e.repeat) return;
        anchor.current = n.id;
        // Arrow keys already select the row: Space on a lone selection must not deselect it.
        if (sel.length === 1 && sel[0] === n.id) return;
        return panelSelect([n.id], "toggle");
      case "F2":
        handled();
        return viewOnly ? undefined : setRenaming(n.id);
      case "Delete":
      case "Backspace": {
        handled();
        if (!sel.includes(n.id)) select([n.id], false);
        // Focus goes to the next row that survives: not selected, and not inside a selected layer.
        const gone = new Set<string>();
        const mark = (id: string) => {
          gone.add(id);
          doc.nodes[id]?.children.forEach(mark);
        };
        useStore.getState().es.selection.forEach(mark);
        const next = [...rows.slice(i + 1), ...rows.slice(0, i).reverse()].find((r) => !gone.has(r.n.id));
        A.deleteSelection();
        if (next) focusRow(next.n.id);
        else document.getElementById("dt-canvas")?.focus();
      }
    }
  };

  // Long lists render only the rows in view (plus a margin): thousands of rows cost
  // ~100 ms per change otherwise.
  const [view, setView] = useState({ top: 0, height: 1000 });
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setView({ top: el.scrollTop, height: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const windowed = rows.length > WINDOW_FROM;
  const first = windowed ? Math.max(0, Math.floor(view.top / ROW) - 20) : 0;
  const last = windowed ? Math.min(rows.length, Math.ceil((view.top + view.height) / ROW) + 20) : rows.length;
  // Indices of the drawn rows: the window, plus the focused row when scrolled away from it so DOM
  // focus (and the wheel) survive scrolling.
  const focusAt = windowed && focusId ? rows.findIndex((r) => r.n.id === focusId) : -1;
  const drawn: number[] = [];
  if (focusAt >= 0 && focusAt < first) drawn.push(focusAt);
  for (let i = first; i < last; i++) drawn.push(i);
  if (focusAt >= last) drawn.push(focusAt);

  const selectedAncestors = useMemo(() => {
    const s = new Set<string>();
    for (const id of sel) for (let p = doc.nodes[id]?.parent; p; p = doc.nodes[p]?.parent ?? null) s.add(p);
    return s;
  }, [doc, sel]);

  const onDrop = () => {
    const id = dragId.current;
    dragId.current = null;
    if (viewOnly || !id || !drop || drop.id === id) return setDrop(null);
    const target = doc.nodes[drop.id];
    const ids = sel.includes(id) ? sel : [id];
    // Onto one of the moved layers, or into one of their descendants: nothing to do.
    if (ids.includes(drop.id)) return setDrop(null);
    for (let p = target.parent; p; p = doc.nodes[p]?.parent ?? null) if (ids.includes(p)) return setDrop(null);
    if (drop.where === "into") dispatch({ op: "moveToParent", ids, parent: target.id, index: null });
    else {
      const siblings = target.parent ? doc.nodes[target.parent].children : doc.pages.find((p) => p.id === target.page)!.children;
      const idx = siblings.indexOf(target.id);
      dispatch({ op: "moveToParent", ids, parent: target.parent, index: drop.where === "before" ? idx + 1 : idx });
    }
    setDrop(null);
  };

  const searchBar = (
    <LayerSearchBar
      query={search.q}
      filters={search.f}
      count={found ? found.total : null}
      content={content}
      onContent={setContent}
      onQuery={(q) => setSearch({ q })}
      onFilters={(f) => setSearch({ f })}
      onSelectAll={() => {
        // The field's own text, not the debounced copy: Enter right after typing counts.
        if (!search.q.trim() && !search.f.length) return;
        setDeb({ page, q: search.q });
        const ids = searchLayers(doc, page, search.q, filters, Infinity, { content }).hits.map((h) => h.id);
        if (ids.length) {
          anchor.current = ids[0];
          panelSelect(ids);
        }
      }}
      onToResults={() => document.querySelector<HTMLElement>("[data-layer-hit]")?.focus()}
    />
  );

  return (
    <>
      {searchBar}
      <div
        className="scroll"
        ref={scrollRef}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        onScroll={(e) => windowed && setView({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}
      >
      {found && (
        <SearchResults
          doc={doc}
          found={found}
          query={activeQuery}
          selSet={selSet}
          renaming={renaming}
          viewOnly={viewOnly}
          onRename={setRenaming}
          onRenameDone={renameDone}
          onPick={(id) => {
            anchor.current = id;
            panelSelect([id]);
          }}
          onClick={(e, id) => clickRow(e, id, found.hits.map((h) => ({ n: doc.nodes[h.id] })), true)}
          onMenu={rowMenu}
          onEscape={() => document.getElementById("layer-search")?.focus()}
        />
      )}
      {!searching && rows.length === 0 && <div className="muted" style={{ padding: 16 }}>No layers on this page yet.</div>}
      {!searching && rows.length > 0 && (
        <div
          role="tree"
          aria-label="Layers"
          aria-multiselectable="true"
          tabIndex={drawn.some((i) => rows[i].n.id === tabStop) ? undefined : 0}
          onFocus={(e) => {
            if (e.target === e.currentTarget) return tabStop && focusRow(tabStop);
            const id = (e.target as HTMLElement).closest<HTMLElement>("[data-layer]")?.dataset.layer;
            if (!id) return;
            lastFocus.current = id;
            rowFocus.current = id;
            setFocusId(id);
          }}
          onBlur={(e) => {
            const to = e.relatedTarget as globalThis.Node | null;
            if (e.currentTarget.contains(to)) return;
            if (to) {
              rowFocus.current = null;
              return setFocusId(null);
            }
            // Focus went nowhere: a row removed under it keeps its claim (the tree hands focus on),
            // while focus that really left (a click on empty space) drops it.
            const row = e.target as HTMLElement;
            setTimeout(() => {
              if (!row.isConnected) return;
              rowFocus.current = null;
              setFocusId(null);
            }, 0);
          }}
        >
          {drawn.map((at, k) => {
            const { n, depth, pos, size } = rows[at];
            const gap = at - (k ? drawn[k - 1] + 1 : 0);
            const isSel = selSet.has(n.id);
            const comp = n.type === "component" || n.type === "componentSet" || n.type === "instance";
            const inInstance = isInsideInstance(doc, n);
            const open = expanded.has(n.id);
            const label = (n.name || n.type) + (n.visible ? "" : ", hidden") + (n.locked ? ", locked" : "");
            return (
              <Fragment key={n.id}>
                {gap > 0 && <div style={{ height: gap * ROW }} aria-hidden="true" />}
                <div
                  data-layer={n.id}
                  role="treeitem"
                  aria-level={depth + 1}
                  aria-setsize={size}
                  aria-posinset={pos}
                  aria-selected={isSel}
                  aria-expanded={n.children.length ? open : undefined}
                  aria-label={label}
                  title={n.name || n.type}
                  tabIndex={n.id === tabStop ? 0 : -1}
                  className={
                    "layer" +
                    (isSel ? " selected" : selectedAncestors.has(n.id) ? "" : "") +
                    (!n.visible ? " hidden-layer" : "") +
                    (drop?.id === n.id && drop.where === "into" ? " drop-into" : "")
                  }
                  style={{ paddingLeft: 8 + indent(depth) }}
                  draggable={!viewOnly && !inInstance && renaming !== n.id}
                  onDragEnd={() => document.getElementById("dt-canvas")?.focus({ preventScroll: true })}
                  onKeyDown={(e) => onRowKey(e, at)}
                  onDragStart={(e) => {
                    dragId.current = n.id;
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("application/x-designotron-layer", n.id);
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    const y = (e.clientY - r.top) / r.height;
                    const container = ["frame", "group", "component", "componentSet"].includes(n.type) && !inInstance;
                    const where = container && y > 0.3 && y < 0.7 ? "into" : y < 0.5 ? "before" : "after";
                    if (drop?.id !== n.id || drop.where !== where) setDrop({ id: n.id, where });
                  }}
                  onClick={(e) => clickRow(e, n.id, rows)}
                  onDoubleClick={() => !viewOnly && setRenaming(n.id)}
                  onContextMenu={(e) => rowMenu(e, n)}
                >
                  {drop?.id === n.id && drop.where !== "into" && <div className="drop-line" style={{ top: drop.where === "before" ? -1 : undefined, bottom: drop.where === "after" ? -1 : undefined, left: 8 + indent(depth) }} />}
                  <span
                    className="twisty"
                    aria-hidden="true"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (e.altKey) toggleAll(n.id);
                      else toggleExpanded(n.id);
                    }}
                  >
                    {n.children.length > 0 && (open ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
                  </span>
                  <span className={"icon" + (comp ? " component" : "")} aria-hidden="true">
                    {nodeIcon(n)}
                  </span>
                  {renaming === n.id ? (
                    <RenameInput
                      value={n.name}
                      label="Layer name"
                      tabs
                      onDone={(name, how) => renameDone(n, name, how)}
                    />
                  ) : (
                    <span className={"name" + (comp ? " component" : "")}>{n.name || n.type}</span>
                  )}
                  <span className={"tools" + (n.locked || !n.visible ? " pinned" : "")}>
                    <button
                      className="ibtn"
                      tabIndex={-1}
                      title={n.locked ? "Unlock" : "Lock"}
                      onClick={(e) => {
                        e.stopPropagation();
                        dispatch({ op: "update", ids: [n.id], patch: { locked: !n.locked } });
                      }}
                    >
                      {n.locked ? <Lock size={12} /> : <Unlock size={12} />}
                    </button>
                    <button
                      className="ibtn"
                      tabIndex={-1}
                      title={n.visible ? "Hide" : "Show"}
                      onClick={(e) => {
                        e.stopPropagation();
                        dispatch({ op: "update", ids: [n.id], patch: { visible: !n.visible } });
                      }}
                    >
                      {n.visible ? <Eye size={12} /> : <EyeOff size={12} />}
                    </button>
                  </span>
                </div>
              </Fragment>
            );
          })}
          {drawn.length > 0 && drawn[drawn.length - 1] < rows.length - 1 && <div style={{ height: (rows.length - 1 - drawn[drawn.length - 1]) * ROW }} aria-hidden="true" />}
        </div>
      )}
      {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
      </div>
    </>
  );
}

/** The search field and filter menu above the layer list. */
function LayerSearchBar({
  query,
  filters,
  count,
  onQuery,
  onFilters,
  content,
  onContent,
  onSelectAll,
  onToResults,
}: {
  query: string;
  filters: LayerFilter[];
  /** Whether text layers also match by their content. */
  content: boolean;
  onContent: (on: boolean) => void;
  /** Matches while a search is active, else null. */
  count: number | null;
  onQuery: (q: string) => void;
  onFilters: (f: LayerFilter[]) => void;
  onSelectAll: () => void;
  onToResults: () => void;
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as globalThis.Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", down);
    return () => window.removeEventListener("pointerdown", down);
  }, [open]);
  const toggle = (f: LayerFilter) => onFilters(filters.includes(f) ? filters.filter((x) => x !== f) : [...filters, f]);
  return (
    <div
      className="layer-search"
      ref={boxRef}
      onKeyDown={(e) => {
        // Escape closes the filter popover first, and is not the canvas's "clear the selection".
        if (e.key === "Escape" && open) {
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
          boxRef.current?.querySelector<HTMLElement>(".layer-filter-btn")?.focus();
        }
      }}
      // Tab out of the popover closes it.
      onBlur={(e) => {
        if (open && !boxRef.current?.contains(e.relatedTarget as globalThis.Node | null)) setOpen(false);
      }}
    >
      <div className="layer-search-row">
        <div className="layer-search-field">
          <Search size={13} aria-hidden="true" />
          <input
            id="layer-search"
            type="text"
            value={query}
            placeholder={content ? "Search layers" : "Search layer names"}
            aria-label="Search layers"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={(e) => {
              // Typing here is not a canvas shortcut.
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                onSelectAll();
              } else if (e.key === "ArrowDown" && count !== null) {
                e.preventDefault();
                onToResults();
              } else if (e.key === "Escape") {
                e.preventDefault();
                if (query) onQuery("");
                else document.getElementById("dt-canvas")?.focus({ preventScroll: true });
              }
            }}
          />
          {query && (
            <button className="ibtn" aria-label="Clear search" title="Clear search" onClick={() => onQuery("")}>
              <XIcon size={12} />
            </button>
          )}
        </div>
        <button
          className={"ibtn layer-filter-btn" + (filters.length ? " active" : "")}
          aria-label="Filter layers"
          aria-haspopup="dialog"
          aria-controls="layer-filter-menu"
          aria-expanded={open}
          title="Filter layers"
          onClick={() => setOpen(!open)}
        >
          <ListFilter size={14} />
          {filters.length > 0 && <span className="layer-filter-count">{filters.length}</span>}
        </button>
      </div>
      {open && (
        <div className="layer-filter-menu" id="layer-filter-menu" role="group" aria-label="Layer filters">
          <label className="layer-filter-item" title="Also search the words inside text layers">
            <input type="checkbox" aria-label="Match text content" checked={content} onChange={(e) => onContent(e.target.checked)} />
            <span>Match text content</span>
          </label>
          <div className="layer-filter-sep" role="separator" />
          {LAYER_FILTERS.map((f) => (
            <label key={f} className="layer-filter-item">
              <input type="checkbox" checked={filters.includes(f)} onChange={() => toggle(f)} />
              <span>{LAYER_FILTER_LABELS[f]}</span>
            </label>
          ))}
          {filters.length > 0 && (
            <button className="layer-filter-clear" onClick={() => onFilters([])}>
              Clear filters
            </button>
          )}
        </div>
      )}
      {count !== null && (
        <div className="layer-search-count muted small" role="status">
          <span>
            {count} {count === 1 ? "match" : "matches"}
          </span>
          {count > 1 && (
            <button className="layer-select-all" onClick={onSelectAll}>
              Select all {count}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Flat list of search matches: icon, name with the match marked, and where the layer lives. */
function SearchResults({
  doc,
  found,
  query,
  selSet,
  renaming,
  viewOnly,
  onRename,
  onRenameDone,
  onPick,
  onClick,
  onMenu,
  onEscape,
}: {
  doc: Doc;
  found: LayerSearch;
  query: string;
  selSet: Set<string>;
  renaming: string | null;
  viewOnly: boolean;
  onRename: (id: string) => void;
  onRenameDone: (n: Node, name: string, how: RenameEnd) => void;
  /** Enter or Space on a hit: selects it and makes it the anchor. */
  onPick: (id: string) => void;
  onClick: (e: React.MouseEvent, id: string) => void;
  onMenu: (e: React.MouseEvent, n: Node) => void;
  onEscape: () => void;
}) {
  const q = query.trim().toLowerCase();
  // One tab stop in the list: the hit that has focus, else the first.
  const [focusHit, setFocusHit] = useState<string | null>(null);
  const tabHit = found.hits.some((h) => h.id === focusHit) ? focusHit : found.hits[0]?.id;
  const mark = (name: string) => {
    const at = q ? name.toLowerCase().indexOf(q) : -1;
    if (at < 0) return name;
    return (
      <>
        {name.slice(0, at)}
        <mark>{name.slice(at, at + q.length)}</mark>
        {name.slice(at + q.length)}
      </>
    );
  };
  const onKey = (e: React.KeyboardEvent, id: string) => {
    if (e.target !== e.currentTarget) return;
    const items = [...(e.currentTarget.parentElement?.querySelectorAll<HTMLElement>("[data-layer-hit]") ?? [])];
    const at = items.indexOf(e.currentTarget as HTMLElement);
    const go = (i: number) => {
      e.preventDefault();
      e.stopPropagation();
      items[Math.max(0, Math.min(items.length - 1, i))]?.focus();
    };
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(items.length - 1);
    else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onEscape();
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      onPick(id);
    } else if (e.key === "F2" && !viewOnly) {
      e.preventDefault();
      e.stopPropagation();
      onRename(id);
    }
  };
  if (!found.hits.length) return <div className="muted" style={{ padding: 16 }}>No layers match.</div>;
  return (
    <div role="listbox" aria-label="Layer search results" aria-multiselectable="true">
      {found.hits.map((h, i) => {
        const n = doc.nodes[h.id];
        if (!n) return null;
        const comp = n.type === "component" || n.type === "componentSet" || n.type === "instance";
        const isSel = selSet.has(n.id);
        const name = n.name || n.type;
        return (
          <div
            key={n.id}
            data-layer-hit={n.id}
            role="option"
            aria-selected={isSel}
            aria-label={name + (h.path.length ? `, in ${h.path.join(" / ")}` : "")}
            tabIndex={n.id === tabHit ? 0 : -1}
            className={"layer layer-hit" + (isSel ? " selected" : "") + (!n.visible ? " hidden-layer" : "")}
            title={[...h.path, name].join(" / ")}
            style={{ paddingLeft: 12 }}
            onKeyDown={(e) => onKey(e, n.id)}
            onFocus={(e) => e.target === e.currentTarget && setFocusHit(n.id)}
            onClick={(e) => onClick(e, n.id)}
            onDoubleClick={() => !viewOnly && onRename(n.id)}
            onContextMenu={(e) => onMenu(e, n)}
          >
            <span className={"icon" + (comp ? " component" : "")} aria-hidden="true">
              {nodeIcon(n)}
            </span>
            {renaming === n.id ? (
              <RenameInput value={n.name} label="Layer name" tabs onDone={(v, how) => onRenameDone(n, v, how)} />
            ) : (
              <span className={"name" + (comp ? " component" : "")}>{mark(name)}</span>
            )}
            {renaming !== n.id && h.path.length > 0 && <span className="hit-path muted small">{h.path.join(" / ")}</span>}
          </div>
        );
      })}
      {found.total > found.hits.length && (
        <div className="muted small" style={{ padding: "8px 12px" }}>
          {found.total - found.hits.length} more, refine the search
        </div>
      )}
    </div>
  );
}

/** Layer row height (`.layer` in styles.css) and the list length where windowing starts. */
const ROW = 30;
const WINDOW_FROM = 200;
/** Levels indented a full step before deeper ones get a narrow one, so names stay readable. */
const FULL_INDENT_LEVELS = 8;

/** Left indent (px) of a layer row at this nesting depth. */
function indent(depth: number): number {
  return Math.min(depth, FULL_INDENT_LEVELS) * 14 + Math.max(0, depth - FULL_INDENT_LEVELS) * 4;
}

function isInsideInstance(doc: Doc, n: Node): boolean {
  for (let p = n.parent; p; p = doc.nodes[p]?.parent ?? null) if (doc.nodes[p]?.type === "instance") return true;
  return false;
}

/** A component rendered small, drawn only once its row is in view. */
function Thumb({ id, size = 32 }: { id: string; size?: number }) {
  const { ref, url } = useThumb(id);
  return (
    <span ref={ref} className="asset-thumb" style={{ width: size, height: size }} data-thumb={url ? "ready" : "pending"}>
      {url ? <img src={url} alt="" draggable={false} /> : <Component size={13} />}
    </span>
  );
}

type AssetEntry = { set: Node | null; items: Node[] };

function Assets() {
  const doc = useDoc();
  const viewer = useCollab((s) => s.viewer);
  const [q, setQ] = useState("");
  const match = (s: string) => s.toLowerCase().includes(q.toLowerCase());
  // Variants are listed under their set (in the set's order), other components on their own.
  const groups = swapGroups(doc)
    .map((g) => ({ set: g.set, items: g.set && match(g.set.name) ? g.items : g.items.filter((c) => match(c.name)) }))
    .filter((g) => g.items.length);
  // One entry per set and per loose component, so "Buttons/Primary" style names fold into folders.
  const entries: AssetEntry[] = groups.flatMap((g) => (g.set ? [g] : g.items.map((c) => ({ set: null, items: [c] }))));
  const entryName = (e: AssetEntry) => (e.set ?? e.items[0]).name;
  const place = (c: Node) => {
    const p = viewportCenter();
    // The frame under the viewport centre takes it (never a main component or set).
    dispatch({ op: "createInstance", componentId: c.id, x: p.x - c.width / 2, y: p.y - c.height / 2, parent: null, anchor: p });
  };
  const row = (c: Node, label: string, indent: boolean) => {
    const description = c.component?.description?.trim();
    return (
      <div
        key={c.id}
        className="layer asset-row"
        draggable
        onDragStart={(e) => e.dataTransfer.setData("application/x-designotron-component", c.id)}
        onClick={() => place(c)}
        title={"Click or drag to place an instance" + (description ? `\n${description}` : "")}
      >
        <span style={{ marginLeft: indent ? 20 : 4, display: "flex" }}>
          <Thumb id={c.id} />
        </span>
        <span className="asset-text">
          <span className="name component">{label}</span>
          {description && <span className="asset-desc muted small">{description}</span>}
        </span>
        <span className="muted small">
          {Math.round(c.width)}×{Math.round(c.height)}
        </span>
      </div>
    );
  };
  const entryRow = (e: AssetEntry, label: string) => {
    // One property order per set, not one per variant row.
    const order = e.set ? propertyOrder(doc, e.set) : [];
    return e.set ? (
      <div key={e.set.id}>
        <div className="layer asset-set" title={"Component set: place one of its variants" + (e.set.component?.description ? `\n${e.set.component.description}` : "")}>
          <span className="icon component" style={{ marginLeft: 4 }}>
            <Component size={13} />
          </span>
          <span className="name component">{label}</span>
          <span className="asset-variants" aria-hidden>
            {e.items.slice(0, 4).map((v) => (
              <Thumb key={v.id} id={v.id} size={20} />
            ))}
          </span>
        </div>
        {e.items.map((c) => row(c, orderedEntries(c.component?.variantProps ?? {}, order).map(([, v]) => v).join(", ") || c.name, true))}
      </div>
    ) : (
      row(e.items[0], label, false)
    );
  };
  return (
    <div className="scroll">
      <div className="section">
        <input className="textinput" placeholder="Search assets" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      </div>
      <div className="section" data-styles="components">
        <div className="section-head">
          <span>Components</span>
        </div>
        {groups.length === 0 && <div className="muted small">Select layers and press {ALT_MOD}K to create a component.</div>}
        <FolderTree scope="components" items={entries} name={entryName} forceOpen={!!q.trim()} row={(e, label) => entryRow(e, label)} />
      </div>
      {!viewer && <ImageAssets filter={q} />}
      {!viewer && (
        <div className="section" data-testid="photos-section">
          <div className="section-head">
            <span>Photos</span>
          </div>
          <PhotoSearch mode={{ kind: "panel" }} />
        </div>
      )}
      <ColorStylesSection filter={q} />
      <TextStylesSection filter={q} />
      <EffectStylesSection filter={q} />
      <GridStylesSection filter={q} />
    </div>
  );
}
