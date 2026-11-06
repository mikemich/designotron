import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Figma, FilePlus, FileStack, Folder as FolderIcon, FolderOpen, FolderPlus, Github, LayoutGrid, Loader2, Menu as MenuIcon, MoreHorizontal, Plus, Search, Sparkles, X } from "lucide-react";
import { askWhenOpen } from "./Editor";
import { claudeReady } from "./ai/chatState";
import { REPO_URL } from "./panels/GuestBar";
import {
  createFolder,
  deleteFile,
  deleteFolder,
  duplicateFile,
  importDtron,
  listFiles,
  listFolders,
  moveFiles,
  moveFolder,
  newFileId,
  onIndexChange,
  pickFile,
  renameFile,
  renameFolder,
  saveFile,
  type FileMeta,
  type Folder,
} from "./files";
import { ancestors, canMoveFolder, childrenOf, compareNames, contents, deleteSummary, normalizeName, pathLabel, resolveFolder } from "./folders";
import { bootEngine, getEngine, newEngine, dispatch, toast, useBoot, useStore } from "./store";
import { TEMPLATES, type Template } from "./templates";
import { isEmptyFile, persistentStorage } from "./files";
import { Menu, useDialog, type MenuItem } from "./ui/controls";
import { attempt, reportFailure } from "./errors";
import { ProjectTree, NameInput, dragState } from "./dashboard/ProjectTree";
import { ConfirmDialog } from "./dashboard/ConfirmDialog";
import { MoveDialog, type MoveTarget } from "./dashboard/MoveDialog";
import { isPhone } from "./panels/PhoneNote";

/** "just now", "5 minutes ago", "yesterday", or a date. */
function edited(t: number): string {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  if (h < 48) return "yesterday";
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

/** Where the dashboard is looking: "all", "drafts" or a folder id (kept in the hash). */
function parseLoc(): string {
  const h = location.hash;
  if (h === "#/drafts") return "drafts";
  const m = h.match(/^#\/folder\/([\w-]+)/);
  return m ? m[1] : "all";
}
const hashFor = (id: string) => (id === "all" ? "#/" : id === "drafts" ? "#/drafts" : `#/folder/${id}`);
const go = (id: string) => {
  location.hash = hashFor(id);
};

const lsGet = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const lsSet = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* no storage */
  }
};

type Sort = "edited" | "name";
/** What a menu, rename, confirm or move is about. */
type Target = { kind: "file" | "folder"; id: string };

export function Dashboard({ onOpen }: { onOpen: (id: string) => void }) {
  const [files, setFiles] = useState<FileMeta[] | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loc, setLoc] = useState(parseLoc);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>(() => (lsGet("dt:files:sort") === "name" ? "name" : "edited"));
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[]; label: string } | null>(null);
  /** What is being renamed, and whether its input is in the sidebar or on a card. */
  const [renaming, setRenaming] = useState<(Target & { in: "tree" | "card" }) | null>(null);
  const [confirm, setConfirm] = useState<Target | null>(null);
  const [moving, setMoving] = useState<Target | null>(null);
  const [sheet, setSheet] = useState(false);
  const [phone, setPhone] = useState(isPhone);
  const [dropOver, setDropOver] = useState<string | null>(null);
  const [openSet, setOpenSet] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(lsGet("dt:files:open") ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const t = useStore((s) => s.toast);
  const engineError = useBoot((s) => s.error);
  /** The file being created while the engine loads ("new" or a template id). */
  const [opening, setOpening] = useState<string | null>(null);

  // --- Loading and keeping up with other tabs ---
  const gen = useRef(0);
  const last = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const stale = useRef(false);
  const refresh = useCallback(async () => {
    const mine = ++gen.current;
    last.current = Date.now();
    stale.current = false;
    try {
      const [f, d] = await Promise.all([listFiles(), listFolders()]);
      if (mine === gen.current) {
        setFiles(f);
        setFolders(d);
        // Folders that are gone drop out of the remembered open state.
        setOpenSet((s) => {
          const keep = [...s].filter((id) => d.some((x) => x.id === id));
          if (keep.length === s.size) return s;
          lsSet("dt:files:open", JSON.stringify(keep));
          return new Set(keep);
        });
      }
    } catch {
      /* keep what is shown */
    }
  }, []);
  /** A refresh for a change somewhere else: at most one every 300 ms, and none while the tab is hidden. */
  const refreshSoon = useCallback(() => {
    if (document.visibilityState === "hidden") {
      stale.current = true;
      return;
    }
    if (timer.current !== undefined) return;
    timer.current = window.setTimeout(
      () => {
        timer.current = undefined;
        refresh();
      },
      Math.max(0, 300 - (Date.now() - last.current)),
    );
  }, [refresh]);
  useEffect(() => {
    refresh();
    const off = onIndexChange(refreshSoon);
    const tabs = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("dt-files");
    if (tabs) tabs.onmessage = refreshSoon;
    const vis = () => {
      if (document.visibilityState === "visible" && stale.current) refreshSoon();
    };
    const hash = () => {
      setLoc(parseLoc());
      setQuery("");
      setSheet(false);
    };
    const mq = window.matchMedia("(max-width: 820px)");
    const mqChange = () => setPhone(mq.matches);
    document.addEventListener("visibilitychange", vis);
    window.addEventListener("hashchange", hash);
    mq.addEventListener("change", mqChange);
    return () => {
      off();
      tabs?.close();
      document.removeEventListener("visibilitychange", vis);
      window.removeEventListener("hashchange", hash);
      mq.removeEventListener("change", mqChange);
      window.clearTimeout(timer.current);
      timer.current = undefined;
    };
  }, [refresh, refreshSoon]);

  // --- What to show ---
  /** Files with a folder that doesn't exist count as Drafts. */
  const all = useMemo(() => (files ?? []).map((f) => (f.folder && !resolveFolder(folders, f.folder) ? { ...f, folder: undefined } : f)), [files, folders]);
  const folderOf = (id: string) => folders.find((f) => f.id === id);
  const current = loc !== "all" && loc !== "drafts" ? folderOf(loc) : undefined;
  const missing = files !== null && loc !== "all" && loc !== "drafts" && !current;
  const currentFolder = current?.id;
  const path = useMemo(() => ancestors(folders, current?.id), [folders, current]);
  const open = openSet;
  // Arriving somewhere opens its parents once (they can be closed again afterwards).
  useEffect(() => {
    if (!current) return;
    const above = ancestors(folders, current.id).slice(0, -1).map((f) => f.id);
    setOpenSet((s) => {
      if (above.every((id) => s.has(id))) return s;
      const n = new Set([...s, ...above]);
      lsSet("dt:files:open", JSON.stringify([...n]));
      return n;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc, current?.id]);
  // Closing the phone sheet ends a rename that was going on in it.
  const sheetWas = useRef(false);
  useEffect(() => {
    if (sheetWas.current && !sheet) setRenaming((r) => (r?.in === "tree" ? null : r));
    sheetWas.current = sheet;
  }, [sheet]);
  const toggle = (id: string) =>
    setOpenSet((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      lsSet("dt:files:open", JSON.stringify([...n]));
      return n;
    });
  const reveal = (id: string) =>
    setOpenSet((s) => {
      if (s.has(id)) return s;
      const n = new Set(s).add(id);
      lsSet("dt:files:open", JSON.stringify([...n]));
      return n;
    });

  const q = query.trim().toLowerCase();
  const byName = (a: FileMeta, b: FileMeta) => (sort === "name" ? compareNames(a.name, b.name) : b.updatedAt - a.updatedAt);
  let shownFiles: FileMeta[] = [];
  let shownFolders: Folder[] = [];
  if (q) {
    shownFiles = all.filter((f) => f.name.toLowerCase().includes(q)).sort(byName);
    shownFolders = folders.filter((f) => f.name.toLowerCase().includes(q)).sort((a, b) => compareNames(a.name, b.name));
  } else if (loc === "all") shownFiles = [...all].sort(byName);
  else if (loc === "drafts") shownFiles = all.filter((f) => !f.folder).sort(byName);
  else if (current) {
    shownFiles = all.filter((f) => f.folder === current.id).sort(byName);
    shownFolders = childrenOf(folders, current.id);
  }
  const place = (f: FileMeta) => `in ${pathLabel(folders, f.folder)}`;

  // --- Creating ---
  const designWithClaude = async (prompt: string) => {
    if (!prompt.trim() || opening) return;
    askWhenOpen(prompt.trim());
    // Without a Claude connection the prompt just waits in the editor. Trying again then reuses
    // the empty file that was made for it, instead of stacking up "Untitled" files.
    if (!claudeReady()) {
      const draft = await emptyClaudeDraft();
      if (draft) return onOpen(draft);
    }
    if (!(await create(null, "claude"))) askWhenOpen(null);
  };
  const [idea, setIdea] = useState("");

  /** Creates and opens a file in the folder being viewed (Drafts from All files and Drafts); false when it couldn't be created. */
  const create = async (template: Template | null, key?: string): Promise<boolean> => {
    setOpening(key ?? template?.id ?? "new");
    try {
      try {
        await bootEngine();
      } catch {
        return false; // the engine error box offers a retry
      }
      newEngine();
      if (template) template.build();
      else dispatch({ op: "setDocName", name: "Untitled" });
      const id = newFileId();
      const json = getEngine().save();
      await saveFile(id, JSON.parse(json).name, json, { folder: currentFolder });
      if (key === "claude" && !claudeReady()) {
        try {
          sessionStorage.setItem(CLAUDE_DRAFT, id);
        } catch {
          /* private mode: no reuse */
        }
      }
      onOpen(id);
      return true;
    } catch (err) {
      // Storage refused the new file: stay here instead of waiting on "Loading editor…".
      reportFailure("create the file", err);
      return false;
    } finally {
      setOpening(null);
    }
  };

  const importFile = async () => {
    const f = await pickFile(".dtron,.json");
    if (!f) return;
    try {
      onOpen(await importDtron(await f.text(), f.name.replace(/\.(dtron|json)$/, ""), currentFolder));
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    }
  };
  // --- Dropping .dtron files from the computer ---
  const [fileDrag, setFileDrag] = useState(false);
  const carriesFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes("Files");
  const fileDragProps = {
    onDragEnter: (e: React.DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      setFileDrag(true);
    },
    onDragOver: (e: React.DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setFileDrag(true);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFileDrag(false);
    },
    onDrop: (e: React.DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      setFileDrag(false);
      void dropFiles(Array.from(e.dataTransfer.files));
    },
  };
  const dropFiles = async (files: File[]) => {
    const ours = files.filter((f) => /\.(dtron|json)$/i.test(f.name));
    if (!ours.length) {
      toast("Only .dtron files open here. Drop images onto a file's canvas.", "error");
      return;
    }
    const ids: string[] = [];
    for (const f of ours) {
      try {
        ids.push(await importDtron(await f.text(), f.name.replace(/\.(dtron|json)$/i, ""), currentFolder));
      } catch (err) {
        // A Figma REST export is also .json: point to where it opens.
        let figma = false;
        try {
          const j = JSON.parse(await f.text());
          figma = !!(j && (j.document || (j.nodes && !j.pages)));
        } catch {
          /* not JSON: the error above stands */
        }
        toast(figma ? `${f.name} looks like a Figma export. Open a file and use File > Import from Figma instead.` : `${f.name}: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }
    if (ids.length === 1 && ours.length === 1) onOpen(ids[0]);
    else if (ids.length) {
      toast(`Imported ${ids.length} file${ids.length === 1 ? "" : "s"}${ours.length < files.length ? ". Other file types were skipped" : ""}`);
      await refresh();
    }
  };
  const importFigma = async () => {
    useStore.setState({ figmaOpen: "new" });
    if (!(await create(null))) useStore.setState({ figmaOpen: false });
  };

  /** A new project (parent null) or folder; its name is typed in place. */
  const addFolder = async (parent: string | null, where: "tree" | "card") => {
    const f = await attempt(parent === null ? "create the project" : "create the folder", () => createFolder(parent));
    if (!f) return;
    if (parent) reveal(parent);
    // From a card of a subfolder the new folder isn't on this page: go to where it is.
    if (where === "card" && parent !== null && parent !== currentFolder) go(parent);
    await refresh();
    setRenaming({ kind: "folder", id: f.id, in: where });
  };

  // --- Renaming, deleting, moving ---
  const finishRename = async (target: Target, name: string | null) => {
    setRenaming(null);
    if (name === null) return;
    const clean = normalizeName(name);
    const old = target.kind === "folder" ? folderOf(target.id)?.name : all.find((f) => f.id === target.id)?.name;
    if (!clean) return toast(`A ${target.kind === "folder" ? "folder" : "file"} needs a name`, "error");
    if (clean === old) return;
    if (target.kind === "folder") await attempt("rename the folder", () => renameFolder(target.id, clean));
    else await attempt("rename the file", () => renameFile(target.id, clean));
    refresh();
  };

  /** The input's end: a blank name is refused (false keeps the field open), anything else is applied. */
  const renameDone = (target: Target, name: string | null): boolean | void => {
    if (name !== null && !normalizeName(name)) {
      toast(`A ${target.kind === "folder" ? "folder" : "file"} needs a name`, "error");
      return false;
    }
    finishRename(target, name);
  };

  const runDelete = async (target: Target) => {
    setConfirm(null);
    if (target.kind === "file") {
      await attempt("delete the file", () => deleteFile(target.id));
      return refresh();
    }
    const name = folderOf(target.id)?.name ?? "folder";
    const parent = folderOf(target.id)?.parent ?? null;
    const inside = path.some((f) => f.id === target.id);
    const r = await attempt("delete the folder", () => deleteFolder(target.id));
    if (r) {
      toast(r.moved ? `Deleted “${name}”. ${r.moved} file${r.moved === 1 ? "" : "s"} moved to Drafts.` : `Deleted “${name}”.`);
      if (inside) go(parent ?? "all");
    }
    refresh();
  };

  const runMove = async (target: Target, to: MoveTarget) => {
    setMoving(null);
    if (target.kind === "file") {
      const name = all.find((f) => f.id === target.id)?.name ?? "file";
      const ok = await attempt("move the file", async () => {
        await moveFiles([target.id], to ?? undefined);
        return true;
      });
      if (ok) toast(`Moved “${name}” to ${pathLabel(folders, to ?? undefined)}`);
    } else {
      const name = folderOf(target.id)?.name ?? "folder";
      const ok = await attempt("move the folder", async () => {
        await moveFolder(target.id, to ?? null);
        return true;
      });
      if (ok) {
        if (to) reveal(to);
        toast(`Moved “${name}” to ${to ? pathLabel(folders, to) : "the top level"}`);
      }
    }
    refresh();
  };

  // --- Drag and drop (mouse; touch uses Move to…) ---
  const canDrop = (to: string): boolean => {
    const d = dragState.current;
    if (!d || to === "all") return false;
    if (d.kind === "file") {
      const f = all.find((x) => x.id === d.id);
      return !!f && (to === "drafts" ? !!f.folder : !!folderOf(to) && f.folder !== to);
    }
    const f = folderOf(d.id);
    return !!f && to !== "drafts" && !!folderOf(to) && f.parent !== to && canMoveFolder(folders, d.id, to);
  };
  const dropOn = async (to: string) => {
    const d = dragState.current;
    const valid = canDrop(to);
    dragState.current = null;
    setDropOver(null);
    if (!d || !valid) return;
    await runMove({ kind: d.kind, id: d.id }, to === "drafts" ? undefined : to);
  };
  const dropProps = (to: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (canDrop(to)) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (dropOver !== to) setDropOver(to);
      } else if (dragState.current) e.dataTransfer.dropEffect = "none";
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropOver((o) => (o === to ? null : o));
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      dropOn(to);
    },
  });
  const dragProps = (kind: "file" | "folder", id: string) => ({
    draggable: renaming?.id !== id,
    onDragStart: (e: React.DragEvent) => {
      dragState.current = { kind, id };
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData(kind === "file" ? "application/x-dt-file" : "application/x-dt-folder", id);
    },
    onDragEnd: () => {
      dragState.current = null;
      setDropOver(null);
    },
  });

  // --- Menus ---
  // The phone's sheet closes first, so a dialog never opens under it.
  const askDelete = (t: Target) => {
    setSheet(false);
    setConfirm(t);
  };
  const askMove = (t: Target) => {
    setSheet(false);
    setMoving(t);
  };
  const openMenu = (x: number, y: number, label: string, items: MenuItem[]) => setMenu({ x, y, items, label });
  const folderMenu = (id: string, x: number, y: number, where: "tree" | "card") =>
    openMenu(x, y, "Folder actions", [
      { label: "Open", onClick: () => go(id) },
      { label: "New folder", onClick: () => addFolder(id, where) },
      { label: "Rename", onClick: () => setRenaming({ kind: "folder", id, in: where }) },
      { label: "Move to…", onClick: () => askMove({ kind: "folder", id }) },
      { sep: true },
      { label: "Delete", onClick: () => askDelete({ kind: "folder", id }) },
    ]);
  const fileMenu = (f: FileMeta, x: number, y: number) =>
    openMenu(x, y, "File actions", [
      { label: "Open", onClick: () => onOpen(f.id) },
      { label: "Rename", onClick: () => setRenaming({ kind: "file", id: f.id, in: "card" }) },
      {
        label: "Duplicate",
        onClick: async () => {
          await attempt("duplicate the file", () => duplicateFile(f.id));
          refresh();
        },
      },
      { label: "Move to…", onClick: () => askMove({ kind: "file", id: f.id }) },
      { sep: true },
      { label: "Delete", onClick: () => askDelete({ kind: "file", id: f.id }) },
    ]);
  const newMenu = (x: number, y: number) =>
    openMenu(x, y, "New", [
      { label: "New design file", onClick: () => create(null) },
      ...TEMPLATES.map((tp) => ({ label: `${tp.name} template`, onClick: () => create(tp) })),
      { sep: true },
      { label: "Open .dtron…", onClick: importFile },
      { label: "Import from Figma", onClick: importFigma },
    ]);

  // --- Pieces ---
  const crumbs = (
    <nav className="crumbs" aria-label="Location">
      {loc === "all" && <span aria-current="page">All files</span>}
      {loc === "drafts" && <span aria-current="page">Drafts</span>}
      {loc !== "all" && loc !== "drafts" && (
        <>
          <a href="#/" className="crumb">
            All files
          </a>
          {path.map((f, i) => (
            <span key={f.id} className="crumb-wrap">
              <ChevronRight size={12} aria-hidden="true" />
              {i === path.length - 1 ? (
                <span aria-current="page">{f.name}</span>
              ) : (
                <a href={hashFor(f.id)} className={"crumb" + (dropOver === f.id && canDrop(f.id) ? " drop-ok" : "")} {...dropProps(f.id)}>
                  {f.name}
                </a>
              )}
            </span>
          ))}
        </>
      )}
    </nav>
  );

  const sideLink = (id: "all" | "drafts", label: string, icon: React.ReactNode) => (
    <a
      href={hashFor(id)}
      draggable={false}
      className={"side-link" + (loc === id ? " current" : "") + (id === "drafts" && dropOver === "drafts" && canDrop("drafts") ? " drop-ok" : "")}
      aria-current={loc === id ? "page" : undefined}
      onClick={() => setSheet(false)}
      {...(id === "drafts" ? dropProps("drafts") : {})}
    >
      {icon}
      {label}
    </a>
  );
  const sidebar = (
    <>
      <div className="side-links">
        {sideLink("all", "All files", <LayoutGrid size={14} />)}
        {sideLink("drafts", "Drafts", <FileStack size={14} />)}
      </div>
      <div className="side-head">
        <span className="section-head" id="projects-h">
          Projects
        </span>
        <button className="ibtn" aria-label="New project" title="New project" onClick={() => addFolder(null, "tree")}>
          <Plus size={14} />
        </button>
      </div>
      <ProjectTree
        labelledBy="projects-h"
        mode="nav"
        folders={folders}
        top={[]}
        current={loc}
        open={open}
        onToggle={toggle}
        onActivate={(id) => {
          go(id);
          setSheet(false);
        }}
        renaming={renaming?.in === "tree" && renaming.kind === "folder" ? renaming.id : null}
        onRenameStart={(id) => setRenaming({ kind: "folder", id, in: "tree" })}
        onRenameDone={(id, name) => renameDone({ kind: "folder", id }, name)}
        onDelete={(id) => askDelete({ kind: "folder", id })}
        onMenu={(id, x, y) => folderMenu(id, x, y, "tree")}
        canDrop={canDrop}
        onDrop={dropOn}
      />
      {folders.length === 0 && files !== null && (
        <button className="btn side-create" onClick={() => addFolder(null, "tree")}>
          <FolderPlus size={14} /> Create a project
        </button>
      )}
    </>
  );

  const folderCard = (f: Folder, note?: string) => {
    const c = contents(folders, all, f.id);
    const summary = `${c.files} file${c.files === 1 ? "" : "s"} · ${c.folders} folder${c.folders === 1 ? "" : "s"}`;
    const renamingHere = renaming?.kind === "folder" && renaming.id === f.id && renaming.in === "card";
    return (
      <div key={f.id} className={"folder-card" + (dropOver === f.id && canDrop(f.id) ? " drop-ok" : "")} {...dragProps("folder", f.id)} {...dropProps(f.id)}>
        {renamingHere ? (
          <div className="folder-open">
            <FolderIcon size={22} aria-hidden="true" />
            <div className="meta">
              <NameInput value={f.name} label="Folder name" onDone={(n) => renameDone({ kind: "folder", id: f.id }, n)} />
              <div className="muted small">{summary}</div>
            </div>
          </div>
        ) : (
          <button className="folder-open" aria-label={`${f.name}, ${summary}`} onClick={() => go(f.id)}>
            <FolderIcon size={22} aria-hidden="true" />
            <div className="meta">
              <div className="n">{f.name}</div>
              <div className="muted small">{note ?? summary}</div>
            </div>
          </button>
        )}
        <button
          className="ibtn more"
          aria-label={`More actions for folder ${f.name}`}
          aria-haspopup="menu"
          onClick={(e) => {
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            folderMenu(f.id, r.left, r.bottom + 4, "card");
          }}
        >
          <MoreHorizontal size={14} />
        </button>
      </div>
    );
  };

  const fileCard = (f: FileMeta, showPlace: boolean) => (
    <div key={f.id} className="file-card" {...dragProps("file", f.id)}>
      <button className="file-open" onClick={() => onOpen(f.id)}>
        <div className="thumb">{f.thumbnail ? <img src={f.thumbnail} alt="" draggable={false} /> : <span className="muted">No preview yet</span>}</div>
        <div className="meta">
          <div className="n">{f.name}</div>
          <div className="muted small" title={new Date(f.updatedAt).toLocaleString()}>
            Edited {edited(f.updatedAt)}
          </div>
          {showPlace && <div className="muted small loc-line">{place(f)}</div>}
        </div>
      </button>
      {renaming?.kind === "file" && renaming.id === f.id && (
        <div className="rename-over">
          <NameInput value={f.name} label="File name" onDone={(n) => renameDone({ kind: "file", id: f.id }, n)} />
        </div>
      )}
      <button
        className="ibtn more"
        aria-label={`More actions for ${f.name}`}
        aria-haspopup="menu"
        onClick={(e) => {
          e.stopPropagation();
          // At the button (a keyboard click has no pointer position to use).
          const r = e.currentTarget.getBoundingClientRect();
          fileMenu(f, r.left, r.bottom + 4);
        }}
      >
        <MoreHorizontal size={14} />
      </button>
    </div>
  );

  const inFolder = !!current;
  const view = q ? "search" : loc;
  const confirmText = (() => {
    if (!confirm) return null;
    if (confirm.kind === "folder") return { title: "Delete folder", message: deleteSummary(folders, all, confirm.id), label: "Delete" };
    const f = all.find((x) => x.id === confirm.id);
    return { title: "Delete file", message: `Delete “${f?.name ?? "this file"}”? This cannot be undone.`, label: "Delete" };
  })();
  const moveItem = moving ? (moving.kind === "file" ? all.find((f) => f.id === moving.id) : folderOf(moving.id)) : null;
  const locName = loc === "all" ? "All files" : loc === "drafts" ? "Drafts" : (current?.name ?? "Folder");

  return (
    <div className="dash" {...fileDragProps}>
      {fileDrag && (
        <div className="dash-drop" role="status">
          Drop .dtron files to open them
        </div>
      )}
      {!phone && (
        <nav className="dash-side" aria-label="Files">
          {sidebar}
        </nav>
      )}
      <main className="files dash-main">
        <div className="files-head">
          <div className="logo">D</div>
          <h1>Designotron</h1>
          <span className="muted head-tag">Free, open-source design tool with Claude built in</span>
          <div style={{ flex: 1 }} />
          <a className="btn" href={REPO_URL} target="_blank" rel="noreferrer" title="Designotron is free and open source. A star helps others find it">
            <Github size={14} /> Star
          </a>
          {inFolder ? (
            <>
              <button className="btn" onClick={() => addFolder(current!.id, "card")}>
                <FolderPlus size={14} /> New folder
              </button>
              <button
                className="btn primary"
                aria-haspopup="menu"
                disabled={!!opening}
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  newMenu(r.left, r.bottom + 4);
                }}
              >
                {opening ? <Loader2 size={14} className="spin" /> : <FilePlus size={14} />} {opening ? "Loading editor…" : "New"} ▾
              </button>
            </>
          ) : (
            <>
              <button className="btn" onClick={importFile}>
                <FolderOpen size={14} /> Open .dtron
              </button>
              <button className="btn" onClick={importFigma}>
                <Figma size={14} /> Import from Figma
              </button>
              <button className="btn primary" onClick={() => create(null)} disabled={!!opening}>
                {opening === "new" ? <Loader2 size={14} className="spin" /> : <FilePlus size={14} />} {opening === "new" ? "Loading editor…" : "New design file"}
              </button>
            </>
          )}
        </div>
        {engineError && (
          <div className="error-box" style={{ marginBottom: 16, display: "flex", alignItems: "center", gap: 12 }}>
            <span>The editor engine couldn't load. Check your connection; your files are safe.</span>
            <button className="btn" onClick={() => bootEngine().catch(() => {})}>
              Retry
            </button>
          </div>
        )}
        {!persistentStorage() && (
          <div className="hero" style={{ padding: 14 }}>
            <span className="muted">This browser isn't keeping files between visits here. Use Save as .dtron from the editor menu to keep your work.</span>
          </div>
        )}
        <div className="files-bar">
          {phone && (
            <button className="btn loc-btn" aria-haspopup="dialog" aria-label={`Location: ${locName}. Change location`} onClick={() => setSheet(true)}>
              <MenuIcon size={14} /> {locName}
            </button>
          )}
          {!phone && crumbs}
          <div style={{ flex: 1 }} />
          <label className="search-box">
            <Search size={13} aria-hidden="true" />
            <input
              type="search"
              aria-label="Search files and folders"
              placeholder="Search all files"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && query) {
                  e.preventDefault();
                  e.stopPropagation();
                  setQuery("");
                }
              }}
            />
          </label>
          <select
            className="textinput sort-select"
            aria-label="Sort files"
            value={sort}
            onChange={(e) => {
              const v = e.target.value === "name" ? "name" : "edited";
              setSort(v);
              lsSet("dt:files:sort", v);
            }}
          >
            <option value="edited">Last edited</option>
            <option value="name">Name</option>
          </select>
        </div>
        {phone && loc !== "all" && loc !== "drafts" && !q && crumbs}

        {view === "all" && (
          <>
            <div className="start-prompt">
              <div className="start-title">What do you want to design?</div>
              <div className="start-row">
                <textarea
                  className="textinput"
                  rows={2}
                  aria-label="What do you want to design?"
                  placeholder="Describe a screen, a flow or a whole app. Claude builds it on the canvas, as editable layers."
                  value={idea}
                  onChange={(e) => setIdea(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      designWithClaude(idea);
                    }
                  }}
                />
                <button className="btn primary" onClick={() => designWithClaude(idea)} disabled={!idea.trim() || !!opening}>
                  {opening === "claude" ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />} Design with Claude
                </button>
              </div>
              <div className="suggestions">
                {["A landing page for a coffee subscription", "A habit tracker mobile app, 3 screens", "A music player with a lyrics view"].map((i) => (
                  <button key={i} onClick={() => designWithClaude(i)} disabled={!!opening}>
                    {i}
                  </button>
                ))}
              </div>
            </div>
            <div className="section-head" style={{ marginBottom: 12, fontSize: 14 }}>
              Or start from a template
            </div>
            <div className="files-grid" style={{ marginBottom: 32 }}>
              {TEMPLATES.map((tp) => (
                <div key={tp.id} className="file-card">
                  <button className="file-open" onClick={() => !opening && create(tp)}>
                    <TemplateThumb t={tp} />
                    <div className="meta">
                      <div className="n">{tp.name}</div>
                      <div className="muted small">{opening === tp.id ? "Loading editor…" : tp.description}</div>
                    </div>
                  </button>
                </div>
              ))}
            </div>
          </>
        )}

        {missing && (
          <div className="empty-state" role="status">
            <div>This folder was deleted.</div>
            <a href="#/" className="btn">
              Go to All files
            </a>
          </div>
        )}

        {!missing && (
          <>
            <div className="section-head" style={{ marginBottom: 12, fontSize: 14 }}>
              {q ? `Results for “${query.trim()}”` : loc === "all" ? "Your files" : loc === "drafts" ? "Drafts" : shownFolders.length && shownFiles.length ? "Folders and files" : shownFolders.length ? "Folders" : "Files"}
            </div>
            {shownFolders.length > 0 && (
              <div className="files-grid folders-grid" aria-label="Folders">
                {shownFolders.map((f) => folderCard(f, q ? (f.parent ? `in ${pathLabel(folders, f.parent)}` : "Project") : undefined))}
              </div>
            )}
            {files && shownFiles.length === 0 && shownFolders.length === 0 && (
              <div className="muted empty-note" style={{ marginBottom: 20 }}>
                {q ? (
                  `No files match “${query.trim()}”.`
                ) : loc === "drafts" ? (
                  "No drafts. Files you create from All files land here."
                ) : loc === "all" ? (
                  "No files yet. Pick a template above or create a new file."
                ) : (
                  <>
                    This folder is empty.
                    <br />
                    Create a design file with New, or drag files here from another folder.
                  </>
                )}
              </div>
            )}
            {shownFiles.length > 0 && (
              <div className="files-grid" style={shownFolders.length ? { marginTop: 20 } : undefined}>
                {shownFiles.map((f) => fileCard(f, loc === "all" || !!q))}
              </div>
            )}
          </>
        )}
        {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
        {confirm && confirmText && <ConfirmDialog title={confirmText.title} message={confirmText.message} confirmLabel={confirmText.label} onCancel={() => setConfirm(null)} onConfirm={() => runDelete(confirm)} />}
        {moving && moveItem && (
          <MoveDialog
            name={moveItem.name}
            kind={moving.kind}
            folderId={moving.kind === "folder" ? moving.id : undefined}
            folders={folders}
            from={moving.kind === "file" ? (moveItem as FileMeta).folder : ((moveItem as Folder).parent ?? undefined)}
            onCancel={() => setMoving(null)}
            onMove={(to) => runMove(moving, to)}
          />
        )}
        {sheet && (
          <LocationSheet onClose={() => setSheet(false)}>
            {sidebar}
          </LocationSheet>
        )}
        <div role="status" aria-live="polite">
          {t && <div className={"toast " + t.kind}>{t.text}</div>}
        </div>
      </main>
    </div>
  );
}

/** The phone's version of the sidebar: the tree in a sheet that closes when a location is picked
 * (the dashboard closes it on the hash change). */
function LocationSheet(props: { onClose: () => void; children: React.ReactNode }) {
  const ref = useDialog(props.onClose);
  return (
    <div className="modal-bg sheet-bg" onPointerDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div ref={ref} className="modal side-sheet" role="dialog" aria-modal="true" aria-label="Locations">
        <div className="modal-head">
          <b>Locations</b>
          <button className="ibtn" aria-label="Close" title="Close" onClick={props.onClose} style={{ marginLeft: "auto" }}>
            <X size={14} />
          </button>
        </div>
        <div className="sheet-body">{props.children}</div>
      </div>
    </div>
  );
}

/** Small schematic preview of a template. */
function TemplateThumb({ t }: { t: Template }) {
  const [bg, accent] = t.colors;
  const block = (style: React.CSSProperties, key?: number) => <div key={key} style={{ position: "absolute", borderRadius: 4, ...style }} />;
  return (
    <div className="thumb" style={{ position: "relative", background: bg }}>
      {t.id === "mobile" && (
        <>
          {block({ left: "30%", top: 14, width: "18%", height: 112, background: "#0E0B1F", border: `2px solid ${accent}` })}
          {block({ left: "52%", top: 14, width: "18%", height: 112, background: "#F6F5FB" })}
          {block({ left: "33%", top: 96, width: "12%", height: 10, background: accent })}
        </>
      )}
      {t.id === "landing" && (
        <>
          {block({ left: "12%", top: 16, width: "76%", height: 46, background: "#1E293B" })}
          {block({ left: "36%", top: 50, width: "28%", height: 8, background: accent })}
          {[0, 1, 2].map((i) => block({ left: `${12 + i * 26}%`, top: 72, width: "23%", height: 50, background: "#F8FAFC" }, i))}
        </>
      )}
      {t.id === "dashboard" && (
        <>
          {block({ left: "10%", top: 14, width: "16%", height: 112, background: "#0F172A" })}
          {[0, 1, 2].map((i) => block({ left: `${30 + i * 20}%`, top: 14, width: "17%", height: 24, background: "#FFFFFF", border: "1px solid #E2E8F0" }, i))}
          {block({ left: "30%", top: 46, width: "57%", height: 80, background: "#FFFFFF", border: "1px solid #E2E8F0" })}
          {[0, 1, 2, 3, 4, 5].map((i) => block({ left: `${34 + i * 8.5}%`, top: 120 - (20 + ((i * 37) % 50)), width: "5%", height: 20 + ((i * 37) % 50), background: accent }, i))}
        </>
      )}
      {t.id === "system" && (
        <>
          {["#F97316", "#C2410C", "#1C1917", "#78716C", "#16A34A"].map((c, i) => block({ left: `${12 + i * 15}%`, top: 22, width: "12%", height: 34, background: c }, i))}
          {block({ left: "12%", top: 72, width: "22%", height: 18, background: accent, borderRadius: 6 })}
          {block({ left: "38%", top: 72, width: "22%", height: 18, background: "#FFFFFF", border: "1px solid #D6D3D1", borderRadius: 6 })}
          {block({ left: "12%", top: 100, width: "48%", height: 6, background: "#D6D3D1" })}
        </>
      )}
    </div>
  );
}

/** The file "Design with Claude" last made while Claude wasn't connected. */
const CLAUDE_DRAFT = "dt:claudeDraft";

/** That file's id, if it still exists and has no layers; otherwise null. */
async function emptyClaudeDraft(): Promise<string | null> {
  try {
    const id = sessionStorage.getItem(CLAUDE_DRAFT);
    if (!id) return null;
    return (await isEmptyFile(id)) ? id : null;
  } catch {
    return null;
  }
}
