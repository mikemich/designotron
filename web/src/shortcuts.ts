import * as A from "./actions";
import { copySelection, pasteHere } from "./canvas/contextMenu";
import { selection, setTool, toggleView, useStore, zoomBy, zoomToFit, zoomToSelection } from "./store";

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement;
  return !!t && (t.matches("input, textarea, select") || t.isContentEditable);
}

/** Global keyboard shortcuts (Figma-compatible where possible). */
export function installShortcuts(): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (isTyping(e) || useStore.getState().presenting) return;
    const mod = e.metaKey || e.ctrlKey;
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
      if (k === "y") return run(A.redo);
      if (k === "d") return run(A.duplicate);
      if (k === "a") return run(A.selectAll);
      if (k === "s") return run(A.saveDtron);
      if (k === "/") return run(() => useStore.setState({ chatOpen: !st.chatOpen }));
      if (k === "g" && e.altKey) return run(A.frameSelection);
      if (k === "g" && e.shiftKey) return run(A.ungroup);
      if (k === "g") return run(A.group);
      if (k === "k" && e.altKey) return run(A.createComponent);
      if (k === "k" && e.shiftKey) return run(A.placeImage);
      if (k === "b" && e.altKey) return run(A.detachInstance);
      if (k === "h" && e.shiftKey) return run(() => A.toggleVisibility());
      if (k === "l" && e.shiftKey) return run(() => A.toggleLock());
      if (k === "]") return run(() => A.reorder(e.altKey ? "front" : "forward"));
      if (k === "[") return run(() => A.reorder(e.altKey ? "back" : "backward"));
      if (k === "=" || k === "+") return run(() => zoomBy(1.25));
      if (k === "-") return run(() => zoomBy(0.8));
      if (k === "0") return run(() => zoomBy(1 / st.viewport.zoom));
      return;
    }

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
    switch (e.key) {
      case "ArrowLeft":
        return has && run(() => A.nudge(-step, 0));
      case "ArrowRight":
        return has && run(() => A.nudge(step, 0));
      case "ArrowUp":
        return has && run(() => A.nudge(0, -step));
      case "ArrowDown":
        return has && run(() => A.nudge(0, step));
      case "Delete":
      case "Backspace":
        return has && run(A.deleteSelection);
      case "Escape":
        if (st.tool !== "move") return run(() => setTool("move"));
        return run(() => (has ? A.selectParent() : null));
      case "Enter":
        return has && run(A.selectChildren);
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
    };
    if (tools[k]) return run(() => setTool(tools[k]));
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
  window.addEventListener("keydown", onKey);
  window.addEventListener("copy", onCopy);
  window.addEventListener("cut", onCut);
  window.addEventListener("paste", onPaste);
  return () => {
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("copy", onCopy);
    window.removeEventListener("cut", onCut);
    window.removeEventListener("paste", onPaste);
  };
}
