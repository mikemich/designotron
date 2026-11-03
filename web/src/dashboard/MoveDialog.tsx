import { useState } from "react";
import { FileStack, FolderTree, X } from "lucide-react";
import { ancestors, subtreeIds, type Folder } from "../folders";
import { useDialog } from "../ui/controls";
import { ProjectTree } from "./ProjectTree";

export const DRAFTS = "drafts";
export const TOP = "root";

/** What a move can go to: `string` is a folder id, `undefined` Drafts, `null` the top level. */
export type MoveTarget = string | undefined | null;

/**
 * "Move to…": the projects tree as a picker. Files go to Drafts or any folder. A folder goes
 * to any folder that isn't itself or inside it, or to the top level (becoming a project).
 * `from` is where the item is now (that row starts chosen, so Move stays off until it changes).
 */
export function MoveDialog(props: {
  name: string;
  kind: "file" | "folder";
  /** The folder being moved, for a folder move. */
  folderId?: string;
  folders: Folder[];
  /** Where the item is now: a folder id, or undefined for Drafts / top level. */
  from: string | undefined;
  onMove: (to: MoveTarget) => void;
  onCancel: () => void;
}) {
  const ref = useDialog(props.onCancel);
  const start = props.kind === "file" ? (props.from ?? DRAFTS) : (props.from ?? TOP);
  const [chosen, setChosen] = useState<string>(start);
  const [open, setOpen] = useState(() => new Set([...props.folders.map((f) => f.id)]));
  const disabled = new Set<string>();
  if (props.kind === "folder" && props.folderId) for (const id of subtreeIds(props.folders, props.folderId)) disabled.add(id);
  const top = props.kind === "file" ? [{ id: DRAFTS, label: "Drafts", icon: <FileStack size={14} /> }] : [{ id: TOP, label: "Top level (as a project)", icon: <FolderTree size={14} /> }];
  const path = chosen === DRAFTS ? "Drafts" : chosen === TOP ? "the top level" : ancestors(props.folders, chosen).map((f) => f.name).join(" / ");
  const go = () => {
    if (chosen === start) return;
    props.onMove(chosen === DRAFTS ? undefined : chosen === TOP ? null : chosen);
  };
  return (
    <div className="modal-bg" onPointerDown={(e) => e.target === e.currentTarget && props.onCancel()}>
      <div ref={ref} className="modal move-dialog" role="dialog" aria-modal="true" aria-label={`Move ${props.name}`}>
        <div className="modal-head">
          <b>Move “{props.name}” to…</b>
          <button className="ibtn" title="Close" aria-label="Close" onClick={props.onCancel} style={{ marginLeft: "auto" }}>
            <X size={14} />
          </button>
        </div>
        <div className="move-body">
          <ProjectTree
            label="Move to"
            mode="pick"
            folders={props.folders}
            top={top}
            current={chosen}
            open={open}
            disabled={disabled}
            onToggle={(id) => setOpen((o) => (o.has(id) ? new Set([...o].filter((x) => x !== id)) : new Set([...o, id])))}
            onActivate={setChosen}
          />
        </div>
        <div className="confirm-actions">
          <span className="muted small move-path" role="status">
            {chosen === start ? "Pick a new location" : `Move to ${path}`}
          </span>
          <button className="btn" onClick={props.onCancel}>
            Cancel
          </button>
          <button className="btn primary" disabled={chosen === start} onClick={go}>
            Move
          </button>
        </div>
      </div>
    </div>
  );
}
