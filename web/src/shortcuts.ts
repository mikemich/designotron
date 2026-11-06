import * as A from "./actions";
import { copySelection, pasteHere, pasteOverSelection, pasteReplace } from "./canvas/contextMenu";
import { closeEmptyPrompt, dispatch, getDoc, pointerDrag, selectSibling, selection, setTool, toggleUi, toggleView, useStore, zoomBy, zoomToFit, zoomToSelection } from "./store";
import { useShortcuts } from "./panels/ShortcutsDialog";
import { focusedByPointer, isMac } from "./ui/controls";
import { canOpenCursorChat, openCursorChat } from "./follow";

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement;
  return !!t && (t.matches("input, textarea, select") || t.isContentEditable);
}

/** Menus and dialogs own their keys; the canvas shortcuts stay out (⌘ combos still pass). */
function inOverlay(e: KeyboardEvent): boolean {
  return !!(e.target as HTMLElement | null)?.closest?.("[role=menu], .menu, [role=dialog]");
}

/** Focus on the canvas itself: Tab and Enter-insert belong to the design there, and to the focused
 * control (or the browser's focus order, from body) anywhere else. */
function onCanvas(e: KeyboardEvent): boolean {
  return (e.target as HTMLElement | null)?.id === "dt-canvas";
}

/** Focus on the canvas or on nothing: Enter still selects children or the parent. */
function onCanvasOrBody(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !t || t === document.body || t === document.documentElement || t.id === "dt-canvas";
}

/** The F6 regions in order, each with how to put focus in it (null: not shown right now). */
const REGIONS: { root: string; focus: () => HTMLElement | null }[] = [
  { root: ".topbar", focus: () => document.querySelector<HTMLElement>(".topbar button:not(:disabled)") },
  {
    root: ".main > .panel:not(.right)",
    focus: () =>
      document.querySelector<HTMLElement>(".main > .panel:not(.right) [role=tree] [tabindex='0']") ??
      document.querySelector<HTMLElement>(".main > .panel:not(.right) [role=tab][aria-selected=true]"),
  },
  { root: "#dt-canvas", focus: () => document.getElementById("dt-canvas") },
  { root: ".main > .panel.right", focus: () => document.querySelector<HTMLElement>(".main > .panel.right [role=tab][aria-selected=true]") },
  { root: ".main > .chat", focus: () => document.querySelector<HTMLElement>(".main > .chat textarea") },
];

/** F6 / Shift+F6: moves focus to the next (previous) region that is on screen. */
function cycleRegion(dir: 1 | -1) {
  // A closed panel keeps a zero-width column (desktop) or is not rendered (tablet).
  const shown = REGIONS.map((r) => ({ r, el: document.querySelector<HTMLElement>(r.root) })).filter((x) => x.el && [...x.el.getClientRects()].some((c) => c.width > 0));
  if (!shown.length) return;
  const at = shown.findIndex((x) => x.el!.contains(document.activeElement));
  for (let step = 1; step <= shown.length; step++) {
    const target = shown[(((at < 0 ? (dir > 0 ? -1 : 0) : at) + dir * step) % shown.length + shown.length) % shown.length].r.focus();
    if (target) return target.focus();
  }
}

/** Alt+PageDown / Alt+PageUp: the next / previous page. */
function stepPage(dir: 1 | -1) {
  const { pages } = getDoc();
  const at = pages.findIndex((p) => p.id === useStore.getState().es.page);
  const next = pages[at + dir];
  if (next) dispatch({ op: "setPage", id: next.id });
}

/** Global keyboard shortcuts (Figma-compatible where possible). */
export function installShortcuts(): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (isTyping(e) || useStore.getState().presenting) return;
    const mod = e.metaKey || e.ctrlKey;
    if (!mod && inOverlay(e)) return;
    const k = e.key.toLowerCase();
    const st = useStore.getState();
    const has = selection().length > 0;
    const run = (fn: () => unknown) => {
      e.preventDefault();
      fn();
    };

    if (mod) {
      if (e.shiftKey && e.code === "Digit4") return run(() => toggleView("showGrids"));
      if (k === "z") return run(e.shiftKey ? A.redo : A.undo);
      if (k === "e" && !e.shiftKey) return run(A.flatten);
      if (k === "o" && e.shiftKey) return run(A.outlineStroke);
      if (e.altKey && e.code === "KeyM") return run(A.useAsMask);
      // Alt changes the typed letter on some layouts, so these go by the physical key.
      if (e.altKey && e.code === "KeyC") return run(A.copyProperties);
      if (e.altKey && e.code === "KeyV") return run(A.pasteProperties);
      if (e.shiftKey && k === "r") return run(() => void pasteReplace());
      // Paste over selection: preventDefault keeps the browser's paste-as-plain-text from also firing.
      if (e.shiftKey && !e.altKey && k === "v") return run(() => void pasteOverSelection());
      // Selection commands go before Select all below, which takes every "a" whatever Alt and Shift say.
      if (e.altKey && e.code === "KeyA" && !st.editingVector) return run(A.selectMatching);
      if (e.shiftKey && !e.altKey && k === "a" && !st.editingVector) return run(A.invertSelection);
      if (e.ctrlKey && e.altKey && e.code === "KeyT") return run(A.tidyUp);
      if (k === "y") return run(A.redo);
      if (k === "d") return run(A.duplicate);
      if (k === "a") return run(st.editingVector ? () => !pointerDrag.active && A.selectAllVectorPoints() : A.selectAll);
      if (k === "s") return run(e.shiftKey ? A.saveDtron : A.saveLocally);
      if (k === "/") return run(() => useStore.setState({ chatOpen: !st.chatOpen }));
      // Show/hide the UI (Figma's Ctrl+\): the side panels. Plain \ stays "select parent".
      if (e.key === "\\" && !e.shiftKey && !e.altKey) return run(toggleUi);
      if (k === "g" && e.altKey) return run(A.frameSelection);
      if (k === "g" && e.shiftKey) return run(A.ungroup);
      if (k === "g") return run(A.group);
      if (k === "k" && e.altKey) return run(A.createComponent);
      if (k === "k" && e.shiftKey) return run(A.placeImage);
      if (k === "b" && e.altKey) return run(A.detachInstance);
      if (k === "h" && e.shiftKey) return run(() => A.toggleVisibility());
      if (k === "l" && e.shiftKey) return run(() => A.toggleLock());
      if (e.key === "Enter" && !e.shiftKey && !e.altKey && onCanvas(e) && A.canInsertWithKeyboard()) return run(() => A.insertDefaultLayer(true));
      // Zoom first: on some layouts (DE, ES, IT) the "]" key types "+".
      if (k === "=" || k === "+") return run(() => zoomBy(1.25));
      if (k === "-") return run(() => zoomBy(0.8));
      if (k === "0") return run(() => zoomBy(1 / st.viewport.zoom));
      // Front/back: Alt (⌥⌘] on a Mac) or Shift (Ctrl+Shift+] elsewhere, Figma's Windows chord). Shift turns
      // "]" into "}" on most layouts, so off a Mac that chord goes by the physical key. On a Mac ⌘⇧] is the
      // browser's next tab: left alone.
      const viaCode = e.shiftKey && !isMac;
      const right = k === "]" || (viaCode && e.code === "BracketRight");
      const left = k === "[" || (viaCode && e.code === "BracketLeft");
      const toEnd = e.altKey || viaCode;
      if (right && !(isMac && e.shiftKey && !e.altKey)) return run(() => A.reorder(toEnd ? "front" : "forward"));
      if (left && !(isMac && e.shiftKey && !e.altKey)) return run(() => A.reorder(toEnd ? "back" : "backward"));
      return;
    }

    if (e.altKey && !e.shiftKey && (e.key === "PageDown" || e.key === "PageUp")) return run(() => stepPage(e.key === "PageDown" ? 1 : -1));

    if (e.altKey && has) {
      const map: Record<string, () => unknown> = {
        a: () => A.align("left"),
        d: () => A.align("right"),
        w: () => A.align("top"),
        s: () => A.align("bottom"),
        h: () => A.align("hCenter"),
        v: () => A.align("vCenter"),
      };
      const code = e.code.replace("Key", "").toLowerCase();
      if (map[code]) return run(map[code]);
    }

    if (e.key === "F2" && has && !e.altKey && !e.shiftKey) return run(A.renameSelection);
    if (e.key === "?") return run(() => useShortcuts.setState({ open: true }));
    if (e.key === "/" && canOpenCursorChat()) return run(openCursorChat);

    if (e.shiftKey) {
      if (k === "a") return run(A.addAutoLayout);
      if (k === "r") return run(() => toggleView("showRulers"));
      if (k === "l") return run(() => setTool("arrow"));
      if (k === "p") return run(() => setTool("pencil"));
      if (k === "h" && has) return run(() => A.flip(true));
      if (k === "v" && has) return run(() => A.flip(false));
      if (e.code === "Digit1") return run(zoomToFit);
      if (e.code === "Digit2") return run(zoomToSelection);
      if (e.code === "Digit0") return run(() => zoomBy(1 / st.viewport.zoom));
    }

    const step = e.shiftKey ? 10 : 1;
    // Vector edit mode: arrows move the selected anchors instead of the layer.
    const pts = st.editingVector ? A.vectorPoints().length > 0 : false;
    // With no anchor selected they do nothing (not the whole layer); during a drag, nothing.
    const move = (dx: number, dy: number) => {
      if (!st.editingVector) return A.nudge(dx, dy);
      if (pts && !pointerDrag.active) A.nudgeVectorPoints(dx, dy);
    };
    switch (e.key) {
      case "ArrowLeft":
        return has && run(() => move(-step, 0));
      case "ArrowRight":
        return has && run(() => move(step, 0));
      case "ArrowUp":
        return has && run(() => move(0, -step));
      case "ArrowDown":
        return has && run(() => move(0, step));
      case "Delete":
      case "Backspace":
        // Editing vector points: delete the selected anchors, never the whole layer at once.
        if (st.editingVector) return run(() => !pointerDrag.active && A.deleteVectorPoints());
        return has && run(A.deleteSelection);
      case "Escape":
        if (st.editingVector) return run(() => useStore.setState({ editingVector: null }));
        // The canvas finishes the pen path on Escape (switching tools here would discard it).
        if (st.tool === "pen") return;
        // A drag in progress is not interrupted.
        if (pointerDrag.active) return;
        if (st.tool !== "move") return run(() => setTool("move"));
        // Esc clears the selection (as in Figma); \ and Shift+Enter select the parent.
        if (has) return run(() => dispatch({ op: "select", ids: [] }));
        return run(() => {
          const page = st.es.page;
          if (!getDoc().pages.find((p) => p.id === page)?.children.length) closeEmptyPrompt(page);
        });
      case "\\":
        return has && run(A.selectParent);
      case "Tab":
        // Sibling selection on the canvas; with nothing selected Tab moves on (no keyboard trap).
        return has && onCanvas(e) && !e.altKey && !st.editingVector && run(() => selectSibling(e.shiftKey ? -1 : 1));
      case "Enter":
        // A control reached by keyboard keeps Enter; one that was clicked doesn't, so Enter acts on
        // the design as it does on the canvas.
        if (!onCanvasOrBody(e) && !focusedByPointer(e.target as Element)) return;
        if (onCanvas(e) && !e.shiftKey && !e.altKey && A.canInsertWithKeyboard()) return run(() => A.insertDefaultLayer(false));
        return has && run(e.shiftKey ? A.selectParent : A.selectChildren);
    }
    if (e.shiftKey || e.altKey) return;
    const tools: Record<string, Parameters<typeof setTool>[0]> = {
      v: "move",
      f: "frame",
      a: "frame",
      r: "rectangle",
      o: "ellipse",
      l: "line",
      p: "pen",
      t: "text",
      h: "hand",
      c: "comment",
      k: "scale",
      i: "eyedropper",
    };
    if (tools[k]) return run(() => setTool(tools[k]));
  };

  // Region cycling works from anywhere, rename fields included (they stop their keys from bubbling),
  // except inside a dialog: so it listens first, on the way down.
  const onRegionKey = (e: KeyboardEvent) => {
    if (e.key !== "F6" || e.metaKey || e.ctrlKey || e.altKey || useStore.getState().presenting) return;
    if ((e.target as HTMLElement | null)?.closest?.("[role=dialog]")) return;
    e.preventDefault();
    cycleRegion(e.shiftKey ? -1 : 1);
  };

  const onCopy = (e: ClipboardEvent) => {
    if (isTyping(e as unknown as KeyboardEvent)) return;
    A.copyToClipboardData(e);
    copySelection();
  };
  const onCut = (e: ClipboardEvent) => {
    if (isTyping(e as unknown as KeyboardEvent)) return;
    A.cut(e);
  };
  const onPaste = (e: ClipboardEvent) => {
    if (isTyping(e as unknown as KeyboardEvent)) return;
    if (!e.clipboardData?.getData("text/plain") && !e.clipboardData?.files.length) {
      pasteHere();
      return;
    }
    A.pasteFromClipboardData(e);
  };
  window.addEventListener("keydown", onRegionKey, true);
  window.addEventListener("keydown", onKey);
  window.addEventListener("copy", onCopy);
  window.addEventListener("cut", onCut);
  window.addEventListener("paste", onPaste);
  return () => {
    window.removeEventListener("keydown", onRegionKey, true);
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("copy", onCopy);
    window.removeEventListener("cut", onCut);
    window.removeEventListener("paste", onPaste);
  };
}
