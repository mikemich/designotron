import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Folder as FolderIcon, MoreHorizontal } from "lucide-react";
import { childrenOf, type Folder } from "../folders";

/** What is being dragged (HTML5 drag data can't be read until the drop, so the dashboard keeps it here). */
export const dragState: { current: { kind: "file" | "folder"; id: string } | null } = { current: null };

/** A text field that commits on Enter or blur and cancels on Escape; always ends with `onDone`. */
export function NameInput(props: { value: string; label: string; onDone: (name: string | null) => boolean | void; className?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    // A refused name keeps the field open for another try.
    if (props.onDone(name) === false) {
      done.current = false;
      setTimeout(() => ref.current?.focus(), 0);
    }
  };
  return (
    <input
      ref={ref}
      className={"name-input" + (props.className ? " " + props.className : "")}
      aria-label={props.label}
      defaultValue={props.value}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          finish(e.currentTarget.value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(null);
        }
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
    />
  );
}

export interface TopRow {
  id: string;
  label: string;
  icon: ReactNode;
}

export interface TreeProps {
  label?: string;
  /** The element that names the tree (instead of `label`). */
  labelledBy?: string;
  folders: Folder[];
  /** Fixed rows above the projects (All files, Drafts). */
  top: TopRow[];
  /** The current (nav) or chosen (pick) location. */
  current: string | null;
  open: Set<string>;
  onToggle: (id: string) => void;
  onActivate: (id: string) => void;
  mode: "nav" | "pick";
  disabled?: Set<string>;
  renaming?: string | null;
  onRenameDone?: (id: string, name: string | null) => boolean | void;
  onRenameStart?: (id: string) => void;
  onDelete?: (id: string) => void;
  onMenu?: (id: string, x: number, y: number) => void;
  canDrop?: (id: string) => boolean;
  onDrop?: (id: string) => void;
}

interface Row {
  id: string;
  label: string;
  depth: number;
  pos: number;
  size: number;
  parent: string | null;
  kids: number;
  icon?: ReactNode;
  folder?: Folder;
}

/** Rows to draw: the fixed rows, then the projects with every open folder's children. */
function buildRows(folders: Folder[], top: TopRow[], open: Set<string>): Row[] {
  const projects = childrenOf(folders, null);
  const size = top.length + projects.length;
  const rows: Row[] = top.map((t, i) => ({ id: t.id, label: t.label, depth: 0, pos: i + 1, size, parent: null, kids: 0, icon: t.icon }));
  const walk = (list: Folder[], depth: number, parent: string | null, base: number, total: number) => {
    list.forEach((f, i) => {
      const kids = childrenOf(folders, f.id);
      rows.push({ id: f.id, label: f.name, depth, pos: base + i + 1, size: total, parent, kids: kids.length, folder: f });
      if (kids.length && open.has(f.id)) walk(kids, depth + 1, f.id, 0, kids.length);
    });
  };
  walk(projects, 0, null, top.length, size);
  return rows;
}

/** Indent per level, capped like the layers panel so deep trees stay readable. */
const indent = (depth: number) => Math.min(depth, 6) * 14;

/** The projects tree: the sidebar's navigation and the Move to picker. One Tab stop; arrows move,
 * → and ← open and close or step in and out, Enter picks, F2 renames, Delete deletes. */
export function ProjectTree(props: TreeProps) {
  const { folders, top, current, open, mode, disabled } = props;
  const rows = buildRows(folders, top, open);
  const [focus, setFocus] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const stop = rows.some((r) => r.id === focus) ? focus : rows.some((r) => r.id === current) ? current : rows[0]?.id;

  const focusRow = (id: string) =>
    requestAnimationFrame(() => box.current?.querySelector<HTMLElement>(`[data-loc="${CSS.escape(id)}"]`)?.focus({ preventScroll: false }));

  const onKey = (e: React.KeyboardEvent, i: number) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const r = rows[i];
    const go = (j: number) => {
      e.preventDefault();
      const to = rows[Math.max(0, Math.min(rows.length - 1, j))];
      if (to) focusRow(to.id);
    };
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
        if (!r.kids) return;
        e.preventDefault();
        if (!open.has(r.id)) props.onToggle(r.id);
        else go(i + 1);
        return;
      case "ArrowLeft":
        if (r.kids && open.has(r.id)) {
          e.preventDefault();
          props.onToggle(r.id);
        } else if (r.parent) go(rows.findIndex((x) => x.id === r.parent));
        return;
      case "Enter":
      case " ":
        e.preventDefault();
        if (!disabled?.has(r.id)) props.onActivate(r.id);
        return;
      case "F2":
        if (r.folder && props.onRenameStart) (e.preventDefault(), props.onRenameStart(r.id));
        return;
      case "Delete":
      case "Backspace":
        if (r.folder && props.onDelete) (e.preventDefault(), props.onDelete(r.id));
        return;
    }
  };

  return (
    <div className="ptree" role="tree" aria-label={props.labelledBy ? undefined : props.label} aria-labelledby={props.labelledBy} ref={box}>
      {rows.map((r, i) => {
        const off = !!disabled?.has(r.id);
        const isOpen = open.has(r.id);
        return (
          <div
            key={r.id}
            data-loc={r.id}
            role="treeitem"
            aria-level={r.depth + 1}
            aria-setsize={r.size}
            aria-posinset={r.pos}
            aria-expanded={r.kids ? isOpen : undefined}
            aria-current={mode === "nav" && r.id === current ? "page" : undefined}
            aria-selected={mode === "pick" ? r.id === current : undefined}
            aria-disabled={off || undefined}
            aria-label={r.label}
            title={r.label}
            tabIndex={r.id === stop ? 0 : -1}
            className={"ptree-row" + (r.id === current ? " current" : "") + (off ? " disabled" : "") + (over === r.id ? " drop-ok" : "")}
            style={{ paddingLeft: 8 + indent(r.depth) }}
            onFocus={(e) => {
              if (e.target === e.currentTarget) setFocus(r.id);
            }}
            onKeyDown={(e) => onKey(e, i)}
            onClick={() => !off && props.onActivate(r.id)}
            onDoubleClick={() => mode === "pick" && r.kids && props.onToggle(r.id)}
            onContextMenu={(e) => {
              if (!r.folder || !props.onMenu) return;
              e.preventDefault();
              props.onMenu(r.id, e.clientX, e.clientY);
            }}
            onDragOver={(e) => {
              if (!props.canDrop) return;
              // (Asked now: what is being dragged changes without this tree re-rendering.)
              if (props.canDrop(r.id)) {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (over !== r.id) setOver(r.id);
              } else e.dataTransfer.dropEffect = "none";
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((o) => (o === r.id ? null : o));
            }}
            onDrop={(e) => {
              setOver(null);
              if (!props.canDrop?.(r.id)) return;
              e.preventDefault();
              props.onDrop?.(r.id);
            }}
          >
            <span
              className="twisty"
              aria-hidden="true"
              onClick={(e) => {
                e.stopPropagation();
                if (r.kids) props.onToggle(r.id);
              }}
            >
              {r.kids > 0 && (isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
            </span>
            <span className="icon" aria-hidden="true">
              {r.icon ?? <FolderIcon size={14} />}
            </span>
            {props.renaming === r.id && r.folder ? (
              <NameInput
                value={r.label}
                label="Folder name"
                onDone={(n) => {
                  const ok = props.onRenameDone?.(r.id, n);
                  if (ok !== false) focusRow(r.id);
                  return ok;
                }}
              />
            ) : (
              <span className="name">{r.label}</span>
            )}
            {mode === "nav" && r.folder && props.onMenu && (
              <button
                className="ibtn more"
                tabIndex={-1}
                aria-label={`Sidebar actions for ${r.label}`}
                aria-haspopup="menu"
                onClick={(e) => {
                  e.stopPropagation();
                  const b = e.currentTarget.getBoundingClientRect();
                  props.onMenu!(r.id, b.left, b.bottom + 4);
                }}
              >
                <MoreHorizontal size={14} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
