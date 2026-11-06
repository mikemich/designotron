import { useState } from "react";
import {
  ArrowUpRight,
  ChevronDown,
  Combine,
  MessageCircle,
  Users,
  Circle,
  Hand,
  Hash,
  Image as ImageIcon,
  Minus,
  MousePointer2,
  Pencil,
  PenTool,
  Pipette,
  Play,
  Redo2,
  Scaling,
  Sparkles,
  Square,
  Star,
  Triangle,
  Type,
  Undo2,
} from "lucide-react";
import * as A from "../actions";
import {
  dispatch,
  setTool,
  toast,
  toggleView,
  useDoc,
  useStore,
  zoomBy,
  zoomToFit,
  zoomToSelection,
} from "../store";
import type { Tool } from "../types";
import { Menu, MOD, SHIFT, type MenuItem, ALT_MOD, SHIFT_MOD } from "../ui/controls";
import { runPlugin, usePlugins } from "../plugins";
import { myColor, useCollab } from "../collab";
import { startSpotlight, stopSpotlight, toggleFollow, useFollow } from "../follow";
import { userName } from "../canvas/Comments";
import { persistentStorage } from "../files";
import { claudeReady, useChat } from "../ai/chatState";
import { FileLocation } from "./FileLocation";
import { useShortcuts } from "./ShortcutsDialog";
import { useImport } from "./ImportDialog";
import { startFrame } from "../prototype";
import { pasteOverSelection, SAME_PROPS, TIDY_KBD } from "../canvas/contextMenu";

const SHAPES: { tool: Tool; label: string; key: string; icon: JSX.Element }[] =
  [
    {
      tool: "rectangle",
      label: "Rectangle",
      key: "R",
      icon: <Square size={16} />,
    },
    { tool: "line", label: "Line", key: "L", icon: <Minus size={16} /> },
    {
      tool: "arrow",
      label: "Arrow",
      key: "⇧L",
      icon: <ArrowUpRight size={16} />,
    },
    { tool: "ellipse", label: "Ellipse", key: "O", icon: <Circle size={16} /> },
    {
      tool: "polygon",
      label: "Polygon",
      key: "",
      icon: <Triangle size={16} />,
    },
    { tool: "star", label: "Star", key: "", icon: <Star size={16} /> },
  ];

export function Toolbar({ onHome }: { onHome: () => void }) {
  const tool = useStore((s) => s.tool);
  const es = useStore((s) => s.es);
  const multi = es.selection.length > 1;
  const zoom = useStore((s) => s.viewport.zoom);
  const dirty = useStore((s) => s.dirty);
  const saveFailed = useStore((s) => s.saveFailed);
  const chatOpen = useStore((s) => s.chatOpen);
  const claudeOn = useChat((s) => claudeReady(s));
  const doc = useDoc();
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    items: MenuItem[];
    label: string;
  } | null>(null);
  const [lastShape, setLastShape] = useState<Tool>("rectangle");
  const shape = SHAPES.find(
    (s) => s.tool === (SHAPES.some((x) => x.tool === tool) ? tool : lastShape),
  )!;

  const open = (e: React.MouseEvent, label: string, items: MenuItem[]) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ x: r.left, y: r.bottom + 4, items, label });
  };
  /** Attributes for a button that opens a menu. */
  const opens = (label: string) => ({ "aria-haspopup": "menu" as const, "aria-expanded": menu?.label === label });

  const mainMenu: MenuItem[] = [
    { label: "Back to files", onClick: onHome },
    { sep: true },
    { heading: "File" },
    { label: "Open .dtron file…", onClick: A.openDtron },
    { label: "Save as .dtron", kbd: `${SHIFT_MOD}S`, onClick: A.saveDtron },
    { label: "Save locally", kbd: `${MOD}S`, onClick: () => void A.saveLocally() },
    {
      label: "Import from Figma…",
      onClick: () => useStore.setState({ figmaOpen: true }),
    },
    { label: "Import website or HTML…", onClick: () => useImport.setState({ open: true }) },
    { label: "Place image…", kbd: `${SHIFT_MOD}K`, onClick: A.placeImage },
    { label: "Export React project (.zip)", onClick: A.exportProject },
    { sep: true },
    { heading: "Edit" },
    { label: "Undo", kbd: `${MOD}Z`, onClick: A.undo },
    { label: "Redo", kbd: `${SHIFT_MOD}Z`, onClick: A.redo },
    { label: "Paste over selection", kbd: `${SHIFT_MOD}V`, onClick: () => void pasteOverSelection() },
    { label: "Select all", kbd: `${MOD}A`, onClick: A.selectAll },
    { label: "Select matching layers", kbd: `${ALT_MOD}A`, onClick: A.selectMatching },
    { label: "Invert selection", kbd: `${SHIFT_MOD}A`, onClick: A.invertSelection },
    ...SAME_PROPS.map(([prop, label]) => ({ label, onClick: () => A.selectSame(prop) })),
    { label: "Select all instances", onClick: () => A.selectInstances(false) },
    { label: "Duplicate", kbd: `${MOD}D`, onClick: A.duplicate },
    { label: "Tidy up", kbd: TIDY_KBD, onClick: A.tidyUp },
    { sep: true },
    { heading: "Object" },
    { label: "Group", kbd: `${MOD}G`, onClick: A.group },
    { label: "Ungroup", kbd: `${SHIFT_MOD}G`, onClick: A.ungroup },
    {
      label: "Frame selection",
      kbd: `${ALT_MOD}G`,
      onClick: A.frameSelection,
    },
    { label: "Add auto layout", kbd: `${SHIFT}A`, onClick: A.addAutoLayout },
    {
      label: "Create component",
      kbd: `${ALT_MOD}K`,
      onClick: A.createComponent,
    },
    {
      label: "Detach instance",
      kbd: `${ALT_MOD}B`,
      onClick: A.detachInstance,
    },
    { sep: true },
    { heading: "View" },
    { label: "Zoom to fit", kbd: `${SHIFT}1`, onClick: zoomToFit },
    { label: "Zoom to selection", kbd: `${SHIFT}2`, onClick: zoomToSelection },
    {
      label: "Zoom to 100%",
      kbd: `${SHIFT}0`,
      onClick: () => zoomBy(1 / useStore.getState().viewport.zoom),
    },
    {
      label: `${useStore.getState().showRulers ? "Hide" : "Show"} rulers`,
      kbd: `${SHIFT}R`,
      onClick: () => toggleView("showRulers"),
    },
    {
      label: `${useStore.getState().showGrids ? "Hide" : "Show"} layout grids`,
      kbd: `${SHIFT_MOD}4`,
      onClick: () => toggleView("showGrids"),
    },
    {
      label: "Version history",
      onClick: () => useStore.setState({ leftTab: "history" }),
    },
    {
      label: "Variables…",
      onClick: () => useStore.setState({ variablesOpen: true }),
    },
    {
      label: "Keyboard shortcuts",
      kbd: "?",
      onClick: () => useShortcuts.setState({ open: true }),
    },
    { sep: true },
    { heading: "Plugins" },
    ...usePlugins
      .getState()
      .list.slice(0, 8)
      .map((p) => ({ label: p.name, onClick: () => runPlugin(p) })),
    {
      label: "Manage plugins…",
      onClick: () => usePlugins.setState({ dialogOpen: true }),
    },
  ];

  const toolBtn = (t: Tool, title: string, icon: JSX.Element) => (
    <button
      className={"tbtn" + (tool === t ? " active" : "")}
      title={title}
      aria-pressed={tool === t}
      onClick={() => setTool(t)}
    >
      {icon}
    </button>
  );

  return (
    <header className="topbar">
      <h1 className="sr-only">Designotron editor</h1>
      <div className="group">
        <button
          className="tbtn"
          onClick={(e) => open(e, "Main menu", mainMenu)}
          title="Main menu"
          {...opens("Main menu")}
        >
          <div className="logo">D</div>
          <ChevronDown size={12} data-phone="hide" />
        </button>
        {toolBtn("move", "Move (V)", <MousePointer2 size={16} />)}
        {/* Drawing tools are hidden on phones (view, comment, present and Claude only). */}
        <span className="draw-tools">
          {toolBtn("frame", "Frame (F)", <Hash size={16} />)}
          <button
            className={
              "tbtn" + (SHAPES.some((s) => s.tool === tool) ? " active" : "")
            }
            aria-pressed={SHAPES.some((s) => s.tool === tool)}
            title={`${shape.label} (${shape.key})`}
            onClick={() => setTool(shape.tool)}
          >
            {shape.icon}
          </button>
          <button
            className="tbtn"
            style={{ minWidth: 16, padding: 0 }}
            title="Shape tools"
            {...opens("Shape tools")}
            onClick={(e) =>
              open(e, "Shape tools", [
                ...SHAPES.map((s) => ({
                  label: s.label,
                  kbd: s.key,
                  onClick: () => {
                    setLastShape(s.tool);
                    setTool(s.tool);
                  },
                })),
                { sep: true },
                {
                  label: "Image…",
                  kbd: `${SHIFT_MOD}K`,
                  onClick: A.placeImage,
                },
              ])
            }
          >
            <ChevronDown size={12} />
          </button>
          {toolBtn("pen", "Pen (P)", <PenTool size={16} />)}
          {toolBtn("pencil", "Pencil (⇧P)", <Pencil size={16} />)}
          {toolBtn("text", "Text (T)", <Type size={16} />)}
          <button
            className="tbtn"
            title={`Place image (${SHIFT_MOD}K)`}
            onClick={A.placeImage}
          >
            <ImageIcon size={16} />
          </button>
          {toolBtn("scale", "Scale (K)", <Scaling size={16} />)}
          {toolBtn("eyedropper", "Eyedropper (I)", <Pipette size={16} />)}
        </span>
        {toolBtn("hand", "Hand (H)", <Hand size={16} />)}
        {toolBtn("comment", "Comment (C)", <MessageCircle size={16} />)}
        {multi && (
          <button
            className="tbtn"
            title="Boolean operations"
            {...opens("Boolean operations")}
            onClick={(e) =>
              open(e, "Boolean operations", [
                {
                  label: "Union selection",
                  onClick: () => A.booleanOp("union"),
                },
                {
                  label: "Subtract selection",
                  onClick: () => A.booleanOp("subtract"),
                },
                {
                  label: "Intersect selection",
                  onClick: () => A.booleanOp("intersect"),
                },
                {
                  label: "Exclude selection",
                  onClick: () => A.booleanOp("exclude"),
                },
                { sep: true },
                { label: "Flatten", kbd: `${MOD}E`, onClick: A.flatten },
                {
                  label: "Use as mask",
                  kbd: `${ALT_MOD}M`,
                  onClick: A.useAsMask,
                },
              ])
            }
          >
            <Combine size={16} />
            <ChevronDown size={12} />
          </button>
        )}
      </div>
      <div className="center">
        <FileLocation />
        <input
          className="filename"
          aria-label="File name"
          key={doc.name}
          defaultValue={doc.name}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          onBlur={(e) =>
            e.target.value.trim() &&
            e.target.value !== doc.name &&
            dispatch({ op: "setDocName", name: e.target.value.trim() })
          }
        />
        <span className="small save-state" role="status">
          {saveFailed
            ? "Not saved, retrying"
            : !persistentStorage()
              ? "Not saved (browser storage unavailable)"
              : dirty
                ? "Saving…"
                : "Saved locally"}
        </span>
      </div>
      <div className="group">
        <button
          className="tbtn"
          title="Undo"
          data-phone="hide"
          disabled={!es.canUndo}
          onClick={A.undo}
        >
          <Undo2 size={16} />
        </button>
        <button
          className="tbtn"
          title="Redo"
          data-phone="hide"
          disabled={!es.canRedo}
          onClick={A.redo}
        >
          <Redo2 size={16} />
        </button>
        <button
          className="tbtn"
          title="Zoom"
          {...opens("Zoom")}
          onClick={(e) =>
            open(e, "Zoom", [
              { label: "Zoom in", kbd: `${MOD}+`, onClick: () => zoomBy(1.25) },
              { label: "Zoom out", kbd: `${MOD}-`, onClick: () => zoomBy(0.8) },
              { label: "Zoom to fit", kbd: `${SHIFT}1`, onClick: zoomToFit },
              {
                label: "Zoom to selection",
                kbd: `${SHIFT}2`,
                onClick: zoomToSelection,
              },
              {
                label: "50%",
                onClick: () => zoomBy(0.5 / useStore.getState().viewport.zoom),
              },
              {
                label: "100%",
                kbd: `${SHIFT}0`,
                onClick: () => zoomBy(1 / useStore.getState().viewport.zoom),
              },
              {
                label: "200%",
                onClick: () => zoomBy(2 / useStore.getState().viewport.zoom),
              },
            ])
          }
        >
          {Math.round(zoom * 100)}% <ChevronDown size={12} />
        </button>
        <button
          className={"tbtn" + (chatOpen ? " active" : "")}
          id="claude-toggle"
          aria-pressed={chatOpen}
          title={`Claude (${MOD}/)`}
          onClick={() => useStore.setState({ chatOpen: !chatOpen })}
        >
          <Sparkles size={16} /> <span className="label">Claude</span>
          <span
            className="status-dot"
            style={{ background: claudeOn ? "#14ae5c" : "#666" }}
            title={claudeOn ? "Claude is connected" : "Claude isn't connected yet"}
          />
        </button>
        <button
          className="tbtn"
          title="Present"
          onClick={() => {
            const page = doc.pages.find((p) => p.id === es.page);
            const first = startFrame(doc, page?.id);
            if (first) useStore.setState({ presenting: first });
            else toast("Nothing to present yet: add a frame (F) first. Presenting plays your frames as a clickable prototype.");
          }}
        >
          <Play size={16} />
        </button>
        <ShareButton />
        <button
          className="tbtn primary desk-only"
          onClick={A.exportProject}
          title="Export the design as a React + Tailwind project"
        >
          Export code
        </button>
      </div>
      {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
    </header>
  );
}

/** Collaborator avatars plus the Share button. Clicking a person's avatar follows them; your
 *  own opens a menu with Spotlight. */
function ShareButton() {
  const { peers, role, status, me, viewer } = useCollab();
  const { leader, spotlight } = useFollow();
  const doc = useDoc();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const list = Object.values(peers);
  const followers = list.filter((p) => me != null && p.presence?.following === me).length;
  const pageName = (id?: string) => doc.pages.find((x) => x.id === id)?.name;
  return (
    <>
      {viewer && (
        <span className="view-badge" title="You can view this file but not edit it">
          View only
        </span>
      )}
      {role && status === "live" && list.length > 0 && (
        <button
          className={"avatar me" + (spotlight ? " spotlighting" : "")}
          aria-label={`You${userName() ? ` (${userName()})` : ""}${spotlight ? ", spotlighting" : ""}`}
          aria-haspopup={viewer ? undefined : "menu"}
          aria-expanded={menu != null}
          title={spotlight ? `You're spotlighting: ${followers} following` : "You"}
          data-me="true"
          disabled={viewer}
          style={{ width: 24, height: 24, background: myColor, fontSize: 11 }}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({ x: r.left, y: r.bottom + 4 });
          }}
        >
          {(userName() || "You")[0].toUpperCase()}
          {spotlight > 0 && <span className="spot-count">{followers}</span>}
        </button>
      )}
      {list.length > 0 && (
        <div className="peer-avatars">
          {list.slice(0, 5).map((p) => {
            const here = pageName(p.presence?.page);
            return (
              <button
                key={p.id}
                className={"avatar" + (leader === p.id ? " followed" : "")}
                data-peer={p.id}
                aria-pressed={leader === p.id}
                aria-label={`${p.name}${p.role ? " (viewing)" : ""}${here ? `, on ${here}` : ""}. ${leader === p.id ? "Stop following" : "Follow"}`}
                title={`${p.name}${p.role ? " (view only)" : ""}${here ? ` · ${here}` : ""}. Click to ${leader === p.id ? "stop following" : "follow"}`}
                style={{
                  width: 24,
                  height: 24,
                  background: p.color,
                  fontSize: 11,
                  ["--ring" as string]: p.color,
                }}
                onClick={() => toggleFollow(p.id)}
              >
                {p.name[0]?.toUpperCase()}
              </button>
            );
          })}
          {list.length > 5 && (
            <span className="avatar more" title={list.slice(5).map((p) => p.name).join(", ")}>
              +{list.length - 5}
            </span>
          )}
        </div>
      )}
      {menu && (
        <Menu
          x={menu.x}
          y={menu.y}
          label="You"
          onClose={() => setMenu(null)}
          items={[
            spotlight
              ? { label: "Stop spotlight", onClick: stopSpotlight }
              : { label: "Spotlight me", onClick: startSpotlight, disabled: list.length === 0 },
          ]}
        />
      )}
      {role && status === "connecting" && (
        <span className="reconnecting" role="status" title="Your changes are kept and sent when the connection is back">
          Reconnecting…
        </span>
      )}
      <button
        className={"tbtn" + (role ? " active" : "")}
        title={
          role
            ? status === "live"
              ? "Shared: live"
              : "Shared: reconnecting…"
            : "Share for live editing"
        }
        onClick={() => useCollab.setState({ dialogOpen: true })}
      >
        <Users size={16} />
        {/* Phones show how many people are here instead of avatars (no room for both). */}
        {list.length > 0 && <span className="share-count">{list.length + 1}</span>}
      </button>
    </>
  );
}
