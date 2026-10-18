// Live app preview state, fed by the bridge (crates/bridge/src/preview.rs).

import { create } from "zustand";
import { bridge } from "./bridgeClient";
import { projectFiles } from "../exporter";
import { onDocChange } from "../store";

export type PreviewPhase = "stopped" | "installing" | "starting" | "running" | "failed";

interface PreviewStore {
  phase: PreviewPhase;
  url: string | null;
  /** Folder the preview runs in, or the one it would run in. */
  project: string | null;
  logs: string[];
  /** Rewrite the generated project on every design change. */
  liveSync: boolean;
  lastWrite: string | null;
}

export const usePreview = create<PreviewStore>(() => ({
  phase: "stopped",
  url: null,
  project: null,
  logs: [],
  liveSync: false,
  lastWrite: null,
}));

/** Handles `preview`, `preview_log` and `project_written` bridge messages. */
export function onPreviewMessage(m: any) {
  if (m.type === "preview") usePreview.setState({ phase: m.phase, url: m.url ?? null, project: m.project ?? null, logs: m.logs ?? [] });
  else if (m.type === "preview_log") usePreview.setState((s) => ({ logs: [...s.logs.slice(-399), m.line] }));
  else if (m.type === "project_written")
    usePreview.setState({ lastWrite: m.ok ? `${m.written} file${m.written === 1 ? "" : "s"} updated` : `Write failed: ${m.error}` });
}

export const startPreview = () => bridge.request({ type: "preview_start" });
export const stopPreview = () => bridge.request({ type: "preview_stop" });

/** Writes the generated React project into `workspace/app` (unchanged files are skipped). */
export function writeProject() {
  const { files, binaries } = projectFiles();
  bridge.request({
    type: "write_project",
    files: files.filter((f) => f.path !== "design.dtron.json"),
    binaries: binaries.map((b) => ({ path: b.path, data: b.dataUrl.split(",")[1] })),
  });
}

let syncTimer: ReturnType<typeof setTimeout> | null = null;
onDocChange(() => {
  if (!usePreview.getState().liveSync) return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(writeProject, 700);
});

export function setLiveSync(on: boolean) {
  usePreview.setState({ liveSync: on });
  if (on) writeProject();
}
