import { useEffect, useMemo, useRef, useState } from "react";
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
  Plus,
  Square,
  Star,
  Triangle,
  Type,
  Unlock,
  Group as GroupIcon,
  Trash2,
} from "lucide-react";
import { dispatch, getDoc, useDoc, useStore, zoomToSelection } from "../store";
import type { Doc, Node } from "../types";
import { IconButton, Menu, type MenuItem } from "../ui/controls";
import { viewportCenter } from "../actions";
import { cssColor } from "../ui/color";

export function LeftPanel() {
  const tab = useStore((s) => s.leftTab);
  return (
    <div className="panel">
      <div className="tabs">
        <button className={"tab" + (tab === "layers" ? " active" : "")} onClick={() => useStore.setState({ leftTab: "layers" })}>
          Layers
        </button>
        <button className={"tab" + (tab === "assets" ? " active" : "")} onClick={() => useStore.setState({ leftTab: "assets" })}>
          Assets
        </button>
        <button className={"tab" + (tab === "history" ? " active" : "")} onClick={() => useStore.setState({ leftTab: "history" })}>
          History
        </button>
        <button className={"tab" + (tab === "comments" ? " active" : "")} onClick={() => useStore.setState({ leftTab: "comments" })}>
          Comments
        </button>
      </div>
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
  );
}

function Pages() {
  const doc = useDoc();
  const page = useStore((s) => s.es.page);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  return (
    <div className="pages">
      <div className="section-head" style={{ marginBottom: 4, padding: "0 4px" }}>
        <span>Pages</span>
        <IconButton title="Add page" onClick={() => dispatch({ op: "addPage", name: null })}>
          <Plus size={14} />
        </IconButton>
      </div>
      {doc.pages.map((p) => (
        <div
          key={p.id}
          className={"page-item" + (p.id === page ? " active" : "")}
          onClick={() => dispatch({ op: "setPage", id: p.id })}
          onDoubleClick={() => setRenaming(p.id)}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({
              x: e.clientX,
              y: e.clientY,
              items: [
                { label: "Rename", onClick: () => setRenaming(p.id) },
                { label: "Delete page", disabled: doc.pages.length < 2, onClick: () => dispatch({ op: "deletePage", id: p.id }) },
              ],
            });
          }}
        >
          <File size={12} />
          {renaming === p.id ? (
            <RenameInput
              value={p.name}
              onDone={(name) => {
                setRenaming(null);
                if (name && name !== p.name) dispatch({ op: "renamePage", id: p.id, name });
              }}
            />
          ) : (
            <span style={{ flex: 1 }}>{p.name}</span>
          )}
        </div>
      ))}
      {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

function RenameInput({ value, onDone }: { value: string; onDone: (v: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      defaultValue={value}
      className="textinput"
      style={{ padding: "2px 4px" }}
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => onDone(e.target.value.trim())}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") onDone(value);
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
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [drop, setDrop] = useState<DropPos>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const dragId = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Reveal selected layers.
  useEffect(() => {
    if (!sel.length) return;
    setExpanded((prev) => {
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
    requestAnimationFrame(() => {
      const el = scrollRef.current?.querySelector(`[data-layer="${sel[0]}"]`);
      el?.scrollIntoView({ block: "nearest" });
    });
  }, [sel.join(",")]);

  const rows = useMemo(() => {
    const out: { n: Node; depth: number }[] = [];
    const walk = (ids: string[], depth: number) => {
      for (const id of [...ids].reverse()) {
        const n = doc.nodes[id];
        if (!n) continue;
        out.push({ n, depth });
        if (n.children.length && expanded.has(id)) walk(n.children, depth + 1);
      }
    };
    walk(doc.pages.find((p) => p.id === page)?.children ?? [], 0);
    return out;
  }, [doc, page, expanded]);

  const selectedAncestors = useMemo(() => {
    const s = new Set<string>();
    for (const id of sel) for (let p = doc.nodes[id]?.parent; p; p = doc.nodes[p]?.parent ?? null) s.add(p);
    return s;
  }, [doc, sel]);

  const onDrop = () => {
    const id = dragId.current;
    dragId.current = null;
    if (!id || !drop || drop.id === id) return setDrop(null);
    const target = doc.nodes[drop.id];
    const ids = sel.includes(id) ? sel : [id];
    if (drop.where === "into") dispatch({ op: "moveToParent", ids, parent: target.id, index: null });
    else {
      const siblings = target.parent ? doc.nodes[target.parent].children : doc.pages.find((p) => p.id === target.page)!.children;
      const idx = siblings.indexOf(target.id);
      dispatch({ op: "moveToParent", ids, parent: target.parent, index: drop.where === "before" ? idx + 1 : idx });
    }
    setDrop(null);
  };

  return (
    <div className="scroll" ref={scrollRef} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      {rows.length === 0 && <div className="muted" style={{ padding: 16 }}>No layers on this page yet.</div>}
      {rows.map(({ n, depth }) => {
        const isSel = sel.includes(n.id);
        const comp = n.type === "component" || n.type === "componentSet" || n.type === "instance";
        const inInstance = isInsideInstance(doc, n);
        return (
          <div
            key={n.id}
            data-layer={n.id}
            className={
              "layer" +
              (isSel ? " selected" : selectedAncestors.has(n.id) ? "" : "") +
              (!n.visible ? " hidden-layer" : "") +
              (drop?.id === n.id && drop.where === "into" ? " drop-into" : "")
            }
            style={{ paddingLeft: 8 + depth * 14 }}
            draggable={!inInstance && renaming !== n.id}
            onDragStart={(e) => {
              dragId.current = n.id;
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => {
              e.preventDefault();
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              const y = (e.clientY - r.top) / r.height;
              const container = ["frame", "group", "component", "componentSet"].includes(n.type) && !inInstance;
              const where = container && y > 0.3 && y < 0.7 ? "into" : y < 0.5 ? "before" : "after";
              if (drop?.id !== n.id || drop.where !== where) setDrop({ id: n.id, where });
            }}
            onClick={(e) => {
              if (e.shiftKey || e.metaKey || e.ctrlKey) dispatch({ op: "select", ids: [n.id], mode: "toggle" });
              else dispatch({ op: "select", ids: [n.id] });
            }}
            onDoubleClick={() => setRenaming(n.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              if (!isSel) dispatch({ op: "select", ids: [n.id] });
              setMenu({
                x: e.clientX,
                y: e.clientY,
                items: [
                  { label: "Rename", onClick: () => setRenaming(n.id) },
                  { label: "Zoom to layer", kbd: "⇧2", onClick: zoomToSelection },
                  { label: "Delete", onClick: () => dispatch({ op: "delete", ids: useStore.getState().es.selection }) },
                ],
              });
            }}
          >
            {drop?.id === n.id && drop.where !== "into" && <div className="drop-line" style={{ top: drop.where === "before" ? -1 : undefined, bottom: drop.where === "after" ? -1 : undefined, left: 8 + depth * 14 }} />}
            <span
              className="twisty"
              onClick={(e) => {
                e.stopPropagation();
                setExpanded((prev) => {
                  const next = new Set(prev);
                  next.has(n.id) ? next.delete(n.id) : next.add(n.id);
                  return next;
                });
              }}
            >
              {n.children.length > 0 && (expanded.has(n.id) ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
            </span>
            <span className={"icon" + (comp ? " component" : "")}>{nodeIcon(n)}</span>
            {renaming === n.id ? (
              <RenameInput
                value={n.name}
                onDone={(name) => {
                  setRenaming(null);
                  if (name && name !== n.name) dispatch({ op: "update", ids: [n.id], patch: { name } });
                }}
              />
            ) : (
              <span className={"name" + (comp ? " component" : "")}>{n.name || n.type}</span>
            )}
            <span className={"tools" + (n.locked || !n.visible ? " pinned" : "")}>
              <button
                className="ibtn"
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
        );
      })}
      {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

function isInsideInstance(doc: Doc, n: Node): boolean {
  for (let p = n.parent; p; p = doc.nodes[p]?.parent ?? null) if (doc.nodes[p]?.type === "instance") return true;
  return false;
}

function Assets() {
  const doc = useDoc();
  const [q, setQ] = useState("");
  const comps = Object.values(doc.nodes).filter((n) => n.type === "component" && n.name.toLowerCase().includes(q.toLowerCase()));
  const sel = useStore((s) => s.es.selection);
  return (
    <div className="scroll">
      <div className="section">
        <input className="textinput" placeholder="Search assets" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      </div>
      <div className="section">
        <div className="section-head">
          <span>Components</span>
        </div>
        {comps.length === 0 && <div className="muted small">Select layers and press ⌥⌘K to create a component.</div>}
        {comps.map((c) => (
          <div
            key={c.id}
            className="layer"
            draggable
            onDragStart={(e) => e.dataTransfer.setData("application/x-designotron-component", c.id)}
            onClick={() => {
              const p = viewportCenter();
              dispatch({ op: "createInstance", componentId: c.id, x: p.x - c.width / 2, y: p.y - c.height / 2, parent: null });
            }}
            title="Click or drag to place an instance"
          >
            <span className="icon component" style={{ marginLeft: 4 }}>
              <Component size={13} />
            </span>
            <span className="name component">{c.name}</span>
            <span className="muted small">
              {Math.round(c.width)}×{Math.round(c.height)}
            </span>
          </div>
        ))}
      </div>
      <div className="section">
        <div className="section-head">
          <span>Colour styles</span>
          <IconButton
            title="Create colour style from selection"
            onClick={() => {
              const n = getDoc().nodes[sel[0]];
              const f = n?.fills.find((p) => p.type === "solid");
              const color = f && f.type === "solid" ? f.color : "#7C5CFF";
              const name = window.prompt("Style name", "Primary");
              if (name) {
                const r = dispatch<{ id: string }>({ op: "addColorStyle", name, color });
                if (r && n) dispatch({ op: "applyStyle", ids: [n.id], styleId: r.id });
              }
            }}
          >
            <Plus size={14} />
          </IconButton>
        </div>
        {doc.styles.colors.map((s) => (
          <div key={s.id} className="row" style={{ cursor: "pointer" }} onClick={() => sel.length && dispatch({ op: "applyStyle", ids: sel, styleId: s.id })} title="Apply to selection">
            <div className="swatch">
              <i style={{ background: cssColor(s.color) }} />
            </div>
            <span style={{ flex: 1 }}>{s.name}</span>
            <span className="muted small">{s.color}</span>
            <IconButton title="Delete style" onClick={(e) => (e.stopPropagation(), dispatch({ op: "deleteStyle", id: s.id }))}>
              <Trash2 size={12} />
            </IconButton>
          </div>
        ))}
      </div>
      <div className="section">
        <div className="section-head">
          <span>Text styles</span>
          <IconButton
            title="Create text style from selected text"
            onClick={() => {
              const n = getDoc().nodes[sel[0]];
              if (n?.type !== "text") return;
              const name = window.prompt("Style name", "Heading");
              if (name) dispatch({ op: "addTextStyle", name, from: n.id });
            }}
          >
            <Plus size={14} />
          </IconButton>
        </div>
        {doc.styles.texts.map((s) => (
          <div key={s.id} className="row" style={{ cursor: "pointer" }} onClick={() => sel.length && dispatch({ op: "applyStyle", ids: sel, styleId: s.id })}>
            <span style={{ fontFamily: s.fontFamily, fontWeight: s.fontWeight, flex: 1 }}>Ag {s.name}</span>
            <span className="muted small">
              {s.fontSize}/{s.fontWeight}
            </span>
            <IconButton title="Delete style" onClick={(e) => (e.stopPropagation(), dispatch({ op: "deleteStyle", id: s.id }))}>
              <Trash2 size={12} />
            </IconButton>
          </div>
        ))}
      </div>
    </div>
  );
}
