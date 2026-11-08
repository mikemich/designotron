import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Crosshair, Download, Hash, Info, Link2, Palette, Plus, Search, SlidersHorizontal, ToggleLeft, Trash2, Type as TypeIcon, Unlink, Upload, X } from "lucide-react";
import { dispatch, dispatchOrThrow, getDoc, toast, useDoc, useStore } from "../store";
import type { VarKind, Variable, VariableCollection } from "../types";
import { Menu, MOD, type MenuItem, Popover, useDialog } from "../ui/controls";
import { ConfirmDialog } from "../dashboard/ConfirmDialog";
import { cssColor } from "../ui/color";
import { exportTokensJson } from "../exporter";
import { useCollab } from "../collab";
import { selectLayersUsing } from "../componentOps";
import { FolderRenameInput, useFolderState } from "./FolderTree";
import { folderSize, groupBySlash, renameFolder, type Folder } from "./groupBySlash";
import { layersUsing } from "./layersUsing";
import { TokenPicker, type PickerItem } from "./TokenPicker";
import { aliasOf, deleteImpact, impactMessage, resolveValue } from "./variableImpact";
import { aliasCycle, SCOPES, SCOPES_FOR_KIND } from "./variableScopes";

const uid = (p: string) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

const DEFAULTS: Record<VarKind, unknown> = { color: "#6D4AFF", number: 16, string: "Text", boolean: true };

export const KIND_ICON: Record<VarKind, JSX.Element> = {
  color: <Palette size={12} />,
  number: <Hash size={12} />,
  string: <TypeIcon size={12} />,
  boolean: <ToggleLeft size={12} />,
};

function save(collections: VariableCollection[]) {
  return dispatch({ op: "setVariables", collections });
}

export { deleteImpact, impactMessage, resolveValue };

/** Text input that commits on blur or Enter (one undo step per edit). A refused edit goes back to the stored text. */
function Commit({ value, onCommit, className, type = "text", title, label, focusOnMount, onFocused }: { value: string; onCommit: (v: string) => void; className?: string; type?: string; title?: string; label?: string; focusOnMount?: boolean; onFocused?: () => void }) {
  const [v, setV] = useState(value);
  const latest = useRef(value);
  const ref = useRef<HTMLInputElement>(null);
  latest.current = value;
  useEffect(() => setV(value), [value]);
  // A variable that was just created: its name is focused and selected, ready to be typed over.
  useEffect(() => {
    if (!focusOnMount) return;
    ref.current?.focus();
    ref.current?.select();
    ref.current?.scrollIntoView({ block: "nearest" });
    onFocused?.();
  }, [focusOnMount]);
  return (
    <input
      ref={ref}
      className={className ?? "textinput"}
      type={type}
      title={title}
      aria-label={label}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setV(value);
      }}
      onBlur={() => {
        if (v === value) return;
        onCommit(v);
        // Changed values re-sync through `value`; when the edit was refused nothing changes, so put the stored text back.
        requestAnimationFrame(() => setV(latest.current));
      }}
    />
  );
}

function ValueCell({
  v,
  mode,
  modeName,
  defaultModeName,
  collections,
  onChange,
  onAlias,
}: {
  v: Variable;
  mode: string;
  modeName: string;
  /** What a missing alias target shows instead ("Missing variable (shows Light)"). */
  defaultModeName: string;
  collections: VariableCollection[];
  onChange: (val: unknown) => void;
  /** Opens the alias picker anchored at the button (a chip click re-targets the alias). */
  onAlias: (anchor: DOMRect) => void;
}) {
  const val = v.values[mode];
  const target = aliasOf(val);
  const aliasBtn = (
    <button className="ibtn" title="Alias to another variable…" aria-label={`Alias ${v.name} to another variable`} onClick={(e) => onAlias(e.currentTarget.getBoundingClientRect())}>
      <Link2 size={12} />
    </button>
  );
  if (target) {
    const found = collections.flatMap((c) => c.variables.map((x) => ({ c, x }))).find((y) => y.x.id === target);
    const resolved = resolveValue(collections, v.id, mode);
    return (
      <div className="row var-alias" style={{ gap: 6 }} data-alias={found?.x.name ?? "missing"}>
        <button
          type="button"
          className="wf-chip var-alias-chip"
          title={found ? `Alias of ${found.c.name} / ${found.x.name}. Click to point it at another variable.` : `The variable this pointed to is gone; it shows the ${defaultModeName} value. Click to pick another.`}
          aria-label={`${v.name}, ${modeName}: ${found ? `alias of ${found.x.name}` : "missing variable"}. Change the alias`}
          onClick={(e) => onAlias(e.currentTarget.getBoundingClientRect())}
        >
          <Link2 size={12} className="wf-purple" />
          <span className="wf-chip-name">{found ? found.x.name : `Missing variable (shows ${defaultModeName})`}</span>
        </button>
        {v.type === "color" && typeof resolved === "string" && (
          <span className="swatch" title={resolved}>
            <i style={{ background: cssColor(resolved) }} />
          </span>
        )}
        {v.type !== "color" && resolved !== undefined && <span className="muted small">{String(resolved)}</span>}
        <button className="ibtn" title="Detach alias (keep the current value)" aria-label={`Detach alias of ${v.name}`} onClick={() => onChange(resolved ?? DEFAULTS[v.type])}>
          <Unlink size={12} />
        </button>
      </div>
    );
  }
  let cell: JSX.Element;
  switch (v.type) {
    case "color": {
      const c = typeof val === "string" ? val : "#000000";
      cell = (
        <div className="row" style={{ gap: 6 }}>
          <label className="swatch" title="Pick colour">
            <i style={{ background: cssColor(c) }} />
            <input type="color" value={c.slice(0, 7)} onChange={(e) => onChange(e.target.value.toUpperCase())} style={{ position: "absolute", opacity: 0, width: 0, height: 0 }} />
          </label>
          {/* The engine checks the colour with its own parser (hex, rgb(), names) and the refusal is toasted. */}
          <Commit value={c} label={`${v.name}, ${modeName}`} onCommit={(x) => onChange(x.trim())} className="textinput mono" />
        </div>
      );
      break;
    }
    case "number":
      cell = <Commit value={String(val ?? 0)} label={`${v.name}, ${modeName}`} type="number" onCommit={(x) => onChange(Number(x) || 0)} />;
      break;
    case "boolean":
      cell = <input type="checkbox" checked={!!val} aria-label={v.name} onChange={(e) => onChange(e.target.checked)} />;
      break;
    default:
      cell = <Commit value={String(val ?? "")} label={`${v.name}, ${modeName}`} onCommit={onChange} />;
  }
  return (
    <div className="row var-cell" style={{ gap: 2 }}>
      <div style={{ flex: 1, minWidth: 0 }}>{cell}</div>
      {aliasBtn}
    </div>
  );
}

/** What `importVariables` reports. */
interface ImportReport {
  collectionsAdded: number;
  modesAdded: number;
  variablesAdded: number;
  variablesUpdated: number;
  skipped: { path: string; reason: string }[];
  skippedCount: number;
}

const IMPORT_MAX_BYTES = 5 * 1024 * 1024;

function plural(n: number, one: string, many = one + "s") {
  return `${n} ${n === 1 ? one : many}`;
}

/** One line for the report, and for the toast. */
export function importSummary(r: ImportReport): string {
  const parts = [
    r.collectionsAdded && plural(r.collectionsAdded, "collection") + " added",
    r.variablesAdded && plural(r.variablesAdded, "variable") + " added",
    r.variablesUpdated && plural(r.variablesUpdated, "variable") + " updated",
    r.modesAdded && plural(r.modesAdded, "mode") + " added",
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "Nothing changed";
}

/** Figma-style local variables editor: collections, modes as columns, variables as rows. */
export function VariablesDialog() {
  const doc = useDoc();
  const viewer = useCollab((s) => s.viewer);
  const tabView = useStore((s) => s.tabView);
  const fileRef = useRef<HTMLInputElement>(null);
  const [imported, setImported] = useState<{ file: string; report?: ImportReport; error?: string } | null>(null);
  const [showSkipped, setShowSkipped] = useState(false);
  const importFile = async (file: File) => {
    setShowSkipped(false);
    if (file.size > IMPORT_MAX_BYTES) {
      setImported({ file: file.name, error: "That file is over 5 MB." });
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      setImported({ file: file.name, error: "Couldn't read that file." });
      return;
    }
    try {
      const report = dispatchOrThrow<ImportReport>({ op: "importVariables", json: text, name: file.name });
      setImported({ file: file.name, report });
      toast(`Imported ${file.name}: ${importSummary(report)}${report.skippedCount ? `, ${report.skippedCount} skipped` : ""}`);
    } catch (err) {
      setImported({ file: file.name, error: String(err) });
    }
  };
  const collections = doc.variables ?? [];
  const [active, setActive] = useState<string | null>(collections[0]?.id ?? null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [modeDelete, setModeDelete] = useState<{ id: string; message: string } | null>(null);
  const [scopeFor, setScopeFor] = useState<{ id: string; anchor: DOMRect } | null>(null);
  const [detailsFor, setDetailsFor] = useState<{ id: string; anchor: DOMRect } | null>(null);
  /** The alias picker: which variable and mode it re-targets. */
  const [aliasPick, setAliasPick] = useState<{ v: Variable; mode: string; anchor: DOMRect } | null>(null);
  /** The variable just created, whose name field takes focus. */
  const [focusId, setFocusId] = useState<string | null>(null);
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null);
  const coll = collections.find((c) => c.id === active) ?? collections[0];
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLButtonElement>(null);
  const close = () => useStore.setState({ variablesOpen: false });
  // Escape in the search field clears the search first; the next Escape closes the dialog.
  const dialogRef = useDialog(() => {
    if (query && document.activeElement === searchRef.current) return setQuery("");
    close();
  });
  // The dialog opens on the search field (a long list is searched before it is read); useDialog's own
  // first focus goes to the collection name, so this one lands just after it.
  useEffect(() => {
    const t = setTimeout(() => searchRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, []);
  const folders = useFolderState("variables:" + (coll?.id ?? ""));
  const colSpan = (coll?.modes.length ?? 0) + 2;
  // Typing stays responsive with hundreds of rows: the filter follows a beat behind.
  const deferred = useDeferredValue(query);
  const q = deferred.trim().toLowerCase();
  const matches = (v: Variable) => v.name.toLowerCase().includes(q);
  const found = q && coll ? coll.variables.filter(matches) : [];
  /** Deletes variables and says what keeps depending on them (Figma doesn't ask; one Ctrl+Z brings them back). */
  const remove = (gone: Variable[], what: string, next: VariableCollection[]) => {
    const impact = deleteImpact(doc.nodes, collections, new Set(gone.map((v) => v.id)));
    if (save(next) === null) return;
    const msg = impactMessage(impact, gone.length === 1 ? gone[0].name : undefined);
    if (msg) toast(`Deleted ${what}. ${msg} ${MOD}Z undoes.`);
  };

  const variableRow = (v: Variable, label: string, folder: string, depth: number) => (
    <tr key={v.id} data-variable={v.name}>
      <td>
        <div className="row" style={{ gap: 6, paddingLeft: depth * 12 }}>
          <span className="muted">{KIND_ICON[v.type]}</span>
          <Commit
            title={v.description ? `${v.name}\n${v.description}` : v.name}
            label={`Variable name`}
            value={label}
            focusOnMount={focusId === v.id}
            onFocused={() => setFocusId(null)}
            onCommit={(name) => {
              const t = name.trim();
              if (!t) return;
              const full = folder ? `${folder}/${t}` : t;
              if (coll!.variables.some((x) => x.id !== v.id && x.name === full)) {
                toast(`${full} already exists in ${coll!.name}`, "error");
                return;
              }
              update((c) => ({ ...c, variables: c.variables.map((x) => (x.id === v.id ? { ...x, name: full } : x)) }));
            }}
          />
          {SCOPES_FOR_KIND[v.type].length > 0 && (
            <button
              className={"ibtn" + (v.scopes?.length ? " on" : "")}
              title={v.scopes?.length ? `Shown for: ${v.scopes.map((x) => SCOPES.find((y) => y.id === x)?.label ?? x).join(", ")}` : "Show in: all supported properties"}
              aria-label={`Where ${v.name} is offered`}
              onClick={(e) => setScopeFor({ id: v.id, anchor: e.currentTarget.getBoundingClientRect() })}
            >
              <SlidersHorizontal size={12} />
            </button>
          )}
          <button
            className={"ibtn" + (v.description ? " on" : "")}
            title={v.description ? `Details: ${v.description}` : "Details: description and usage"}
            aria-label={`Details of ${v.name}`}
            data-var-details
            onClick={(e) => setDetailsFor({ id: v.id, anchor: e.currentTarget.getBoundingClientRect() })}
          >
            <Info size={12} />
          </button>
        </div>
      </td>
      {coll!.modes.map((m) => (
        <td key={m.id}>
          <ValueCell
            v={v}
            mode={m.id}
            modeName={m.name}
            defaultModeName={coll!.modes[0]?.name ?? ""}
            collections={collections}
            onChange={(val) => setValue(v.id, m.id, val)}
            onAlias={(a) => setAliasPick({ v, mode: m.id, anchor: a })}
          />
        </td>
      ))}
      <td>
        <div className="row" style={{ gap: 0 }}>
          <button className="ibtn" title="Select layers using this" aria-label={`Select layers using ${v.name}`} data-var-select-users onClick={() => selectUsers(v)}>
            <Crosshair size={12} />
          </button>
          <button
            className="ibtn"
            title="Delete variable"
            aria-label={`Delete ${v.name}`}
            onClick={() => remove([v], v.name, collections.map((c) => (c.id === coll!.id ? { ...c, variables: c.variables.filter((x) => x.id !== v.id) } : c)))}
          >
            <Trash2 size={12} />
          </button>
        </div>
      </td>
    </tr>
  );

  /** Folders (names with a slash) as collapsible rows, then the loose variables. */
  const renderFolder = (f: Folder<Variable>, depth: number): JSX.Element[] => [
    ...f.folders.flatMap((g) => {
      const open = folders.isOpen(g.path);
      return [
        <tr key={"folder:" + g.path} className="var-folder">
          <td colSpan={colSpan}>
            {renamingFolder === g.path ? (
              <div className="asset-folder" style={{ paddingLeft: 4 + depth * 12 }}>
                <FolderRenameInput
                  path={g.path}
                  onDone={(to) => {
                    setRenamingFolder(null);
                    if (to) renameVariableFolder(g.path, to);
                  }}
                />
              </div>
            ) : (
              <>
                <button
                  className="asset-folder"
                  style={{ paddingLeft: 4 + depth * 12 }}
                  aria-expanded={open}
                  title={`${g.path}\nDouble-click or press F2 to rename`}
                  onClick={() => folders.toggle(g.path)}
                  onDoubleClick={() => setRenamingFolder(g.path)}
                  onKeyDown={(e) => e.key === "F2" && (e.preventDefault(), setRenamingFolder(g.path))}
                >
                  {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <span className="asset-folder-name">{g.name}</span>
                  <span className="muted small">{folderSize(g)}</span>
                </button>
                <button className="ibtn var-folder-add" title={`Create variable in ${g.path}`} aria-label={`Create variable in ${g.path}`} onClick={() => addVariable(firstKind(g), g.path)}>
                  <Plus size={12} />
                </button>
              </>
            )}
          </td>
        </tr>,
        ...(open ? renderFolder(g, depth + 1) : []),
      ];
    }),
    ...f.items.map((e) => variableRow(e.item, e.label, f.path, depth)),
  ];

  const update = (fn: (c: VariableCollection) => VariableCollection) => save(collections.map((c) => (c.id === coll.id ? fn(c) : c)));
  const addCollection = () => {
    let cn = collections.length + 1;
    while (collections.some((x) => x.name === `Collection ${cn}`)) cn++;
    const c: VariableCollection = { id: uid("vc_"), name: `Collection ${cn}`, modes: [{ id: uid("vm_"), name: "Default" }], variables: [] };
    save([...collections, c]);
    setActive(c.id);
  };
  /** Creates `color 3` (at the root, or inside `folder`) and focuses its name, selected, so it can be typed over. */
  const addVariable = (type: VarKind, folder = "") => {
    // A new variable must show up, whatever the search says, and a folded folder opens to show it.
    setQuery("");
    if (folder) {
      const parts = folder.split("/");
      for (let i = 1; i <= parts.length; i++) {
        const p = parts.slice(0, i).join("/");
        if (!folders.isOpen(p)) folders.toggle(p);
      }
    }
    const id = uid("v_");
    const ok = update((c) => {
      // The first free "color 3": counting alone collides after a delete or rename.
      const prefix = folder ? `${folder}/` : "";
      let n = c.variables.filter((v) => v.type === type).length + 1;
      while (c.variables.some((v) => v.name === `${prefix}${type} ${n}`)) n++;
      const values = Object.fromEntries(c.modes.map((m) => [m.id, DEFAULTS[type]]));
      return { ...c, variables: [...c.variables, { id, name: `${prefix}${type} ${n}`, type, values, description: "" }] };
    });
    if (ok !== null) setFocusId(id);
  };
  /** The kind of the first variable in a folder: "+" on a folder of numbers makes a number. */
  const firstKind = (f: Folder<Variable>): VarKind => {
    const first = f.items[0]?.item ?? f.folders.map((g) => g.items[0]?.item).find(Boolean);
    return first?.type ?? "color";
  };
  /** Renames a folder of variables: every variable inside gets the new prefix, in one change. A clash is refused. */
  const renameVariableFolder = (from: string, to: string) => {
    if (!coll) return;
    const { renames, collision } = renameFolder(coll.variables.map((v) => v.name), from, to);
    if (collision) return void toast(`${collision} already exists in ${coll.name}`, "error");
    if (!renames.length) return;
    const names = new Map(renames.map((r) => [coll.variables[r.index].id, r.name]));
    update((c) => ({ ...c, variables: c.variables.map((v) => (names.has(v.id) ? { ...v, name: names.get(v.id)! } : v)) }));
  };
  /** Closes the dialog and selects the layers on this page that use the variable. */
  const selectUsers = (v: Variable) => {
    close();
    selectLayersUsing(v.id, v.name);
  };
  /** Removes a mode and its values; layers pinned to it follow the engine's prune (back to the default mode). */
  const deleteMode = (id: string) =>
    update((c) => ({
      ...c,
      modes: c.modes.filter((x) => x.id !== id),
      variables: c.variables.map((v) => ({ ...v, values: Object.fromEntries(Object.entries(v.values).filter(([m]) => m !== id)) })),
    }));
  const askDeleteMode = (id: string) => {
    if (!coll) return;
    const at = coll.modes.findIndex((m) => m.id === id);
    const next = coll.modes.find((m) => m.id !== id);
    const pinned = Object.values(doc.nodes).filter((n) => n.variableModes?.[coll.id] === id).length;
    const parts = [`"${coll.modes[at].name}" and its values are removed from ${coll.variables.length} variable${coll.variables.length === 1 ? "" : "s"}.`];
    if (pinned) parts.push(`${pinned} layer${pinned === 1 ? " is" : "s are"} pinned to it and will follow the default mode instead.`);
    if (at === 0 && next) parts.push(`${next.name} becomes the default (Auto).`);
    setModeDelete({ id, message: parts.join(" ") });
  };
  const addMode = () =>
    update((c) => {
      const id = uid("vm_");
      const first = c.modes[0]?.id;
      // The first free "Mode 3": counting alone collides after a delete or rename.
      let n = c.modes.length + 1;
      while (c.modes.some((m) => m.name === `Mode ${n}`)) n++;
      return {
        ...c,
        modes: [...c.modes, { id, name: `Mode ${n}` }],
        variables: c.variables.map((v) => ({ ...v, values: { ...v.values, [id]: first ? v.values[first] : DEFAULTS[v.type] } })),
      };
    });
  /** The alias picker's rows: variables of the same type from any collection, never the variable itself. */
  const aliasItems = useMemo((): PickerItem[] => {
    if (!aliasPick) return [];
    const { v } = aliasPick;
    return collections.flatMap((c) =>
      c.variables
        .filter((x) => x.type === v.type && x.id !== v.id)
        .map((x): PickerItem => {
          const shown = v.type === "color" ? resolveValue(collections, x.id, c.modes[0]?.id ?? "") : undefined;
          return { id: x.id, name: x.name, group: c.name, description: x.description, preview: typeof shown === "string" ? { type: "color", color: shown } : { type: "icon", icon: v.type } };
        }),
    );
  }, [aliasPick]);
  const chooseAlias = (v: Variable, mode: string, targetId: string) => {
    const target = collections.flatMap((c) => c.variables).find((x) => x.id === targetId);
    if (!target) return;
    if (aliasCycle(collections, v.id, target.id)) {
      toast(`Can't alias ${v.name} to ${target.name}: ${target.name} already refers back to ${v.name}.`, "error");
      return;
    }
    // Pointing it where it already points is not a change.
    if (aliasOf(v.values[mode]) !== target.id) setValue(v.id, mode, { alias: target.id });
  };
  const setScopes = (vid: string, scopes: string[]) =>
    update((c) => ({ ...c, variables: c.variables.map((v) => (v.id === vid ? withScopes(v, scopes) : v)) }));
  const setValue = (vid: string, mode: string, val: unknown) =>
    update((c) => ({ ...c, variables: c.variables.map((v) => (v.id === vid ? { ...v, values: { ...v.values, [mode]: val } } : v)) }));

  return (
    <div className="modal-bg" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={dialogRef} className="modal variables-dialog" role="dialog" aria-modal="true" aria-label="Variables">
        <div className="modal-head">
          <b>Local variables</b>
          {!viewer && !tabView && (
            <>
              <input
                ref={fileRef}
                type="file"
                accept=".json,application/json"
                hidden
                aria-label="Import JSON file"
                data-var-import-input
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) void importFile(f);
                }}
              />
              <button
                ref={importRef}
                className="ibtn"
                title="Import JSON (design tokens, Tokens Studio or Designotron variables)"
                aria-label="Import JSON"
                onClick={() => fileRef.current?.click()}
                style={{ marginLeft: "auto" }}
              >
                <Upload size={14} />
              </button>
            </>
          )}
          <button className="ibtn" title="Export JSON (W3C design tokens)" aria-label="Export JSON" onClick={exportTokensJson} style={viewer || tabView ? { marginLeft: "auto" } : undefined}>
            <Download size={14} />
          </button>
          <button className="ibtn" title="Close" onClick={close}>
            <X size={14} />
          </button>
        </div>
        {imported && (
          <div className={"var-import-report" + (imported.error ? " error" : "")} role="status" data-var-import-report>
            <div className="var-import-line">
              <span>
                <b>{imported.file}</b>: {imported.error ?? importSummary(imported.report!)}
                {imported.report && imported.report.skippedCount > 0 && (
                  <>
                    {", "}
                    <button className="var-import-skipped-btn" aria-expanded={showSkipped} onClick={() => setShowSkipped(!showSkipped)}>
                      {imported.report.skippedCount} skipped {showSkipped ? "▾" : "▸"}
                    </button>
                  </>
                )}
                {imported.report && importSummary(imported.report) !== "Nothing changed" && ` · ${MOD}Z removes the import`}
              </span>
              <button className="ibtn" title="Dismiss" aria-label="Dismiss import report" onClick={() => {
                  setImported(null);
                  // The button that was pressed goes with the report: focus moves to Import (or to the search field).
                  requestAnimationFrame(() => (importRef.current ?? searchRef.current)?.focus());
                }}>
                <X size={12} />
              </button>
            </div>
            {showSkipped && imported.report && (
              <ul className="var-import-skipped">
                {imported.report.skipped.map((s, i) => (
                  <li key={i}>
                    <code>{s.path}</code> <span className="muted">{s.reason}</span>
                  </li>
                ))}
                {imported.report.skippedCount > imported.report.skipped.length && <li className="muted">and {imported.report.skippedCount - imported.report.skipped.length} more</li>}
              </ul>
            )}
          </div>
        )}
        <div className="variables-body">
          <div className="var-collections">
            {collections.map((c) => {
              const n = q ? c.variables.filter(matches).length : 0;
              return (
                <button key={c.id} className={"var-coll" + (c.id === coll?.id ? " active" : "") + (q && !n ? " dim" : "")} onClick={() => setActive(c.id)} data-matches={q ? n : undefined}>
                  <span className="var-coll-name">{c.name}</span>
                  {q && (
                    <span className="var-coll-count" aria-label={`${n} match${n === 1 ? "" : "es"}`}>
                      {n}
                    </span>
                  )}
                </button>
              );
            })}
            <button className="var-coll muted" onClick={addCollection}>
              <Plus size={12} /> New collection
            </button>
          </div>
          {coll ? (
            <div className="var-table-wrap">
              <div className="row" style={{ marginBottom: 8 }}>
                <Commit value={coll.name} label="Collection name" onCommit={(name) => name.trim() && update((c) => ({ ...c, name: name.trim() }))} />
                <button
                  className="ibtn"
                  title="Delete collection"
                  aria-label={`Delete collection ${coll.name}`}
                  onClick={() => remove(coll.variables, `collection ${coll.name}`, collections.filter((c) => c.id !== coll.id))}
                >
                  <Trash2 size={13} />
                </button>
              </div>
              <div className="var-search">
                <Search size={13} aria-hidden="true" />
                <input
                  ref={searchRef}
                  type="search"
                  className="textinput"
                  aria-label="Search variables"
                  placeholder="Search variables"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => e.stopPropagation()}
                />
              </div>
              <div className="sr-only" role="status" aria-live="polite" data-var-live>
                {q ? (found.length ? `${found.length} variable${found.length === 1 ? "" : "s"} match in ${coll.name}` : `0 variables match in ${coll.name}`) : ""}
              </div>
              <div className="var-table-scroll" tabIndex={-1}>
              <table className="var-table" style={{ "--modes": coll.modes.length } as React.CSSProperties}>
                <colgroup>
                  <col className="var-col-name" />
                  {coll.modes.map((m) => (
                    <col key={m.id} className="var-col-mode" />
                  ))}
                  <col className="var-col-del" />
                </colgroup>
                <thead>
                  <tr>
                    <th>Name</th>
                    {coll.modes.map((m) => (
                      <th key={m.id}>
                        <div className="row" style={{ gap: 2 }}>
                          <Commit value={m.name} label="Mode name" className="textinput head" onCommit={(name) => name.trim() && update((c) => ({ ...c, modes: c.modes.map((x) => (x.id === m.id ? { ...x, name: name.trim() } : x)) }))} />
                          {coll.modes.length > 1 && (
                            <button className="ibtn" title="Delete mode" aria-label={`Delete mode ${m.name}`} onClick={() => askDeleteMode(m.id)}>
                              <X size={11} />
                            </button>
                          )}
                        </div>
                      </th>
                    ))}
                    <th style={{ width: 32 }}>
                      <button className="ibtn" title="Add mode" onClick={addMode}>
                        <Plus size={13} />
                      </button>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {q ? (
                    found.length ? (
                      found.map((v) => variableRow(v, v.name, "", 0))
                    ) : (
                      <tr className="var-empty">
                        <td colSpan={colSpan}>
                          <div className="muted">
                            No variables match “{deferred.trim()}” in {coll.name}.
                          </div>
                        </td>
                      </tr>
                    )
                  ) : (
                    renderFolder(groupBySlash(coll.variables, (v) => v.name), 0)
                  )}
                </tbody>
              </table>
              </div>
              <button
                className="btn"
                style={{ marginTop: 8, alignSelf: "flex-start" }}
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setMenu({
                    x: r.left,
                    y: r.bottom + 4,
                    items: (["color", "number", "string", "boolean"] as VarKind[]).map((t) => ({ label: t[0].toUpperCase() + t.slice(1), onClick: () => addVariable(t) })),
                  });
                }}
              >
                <Plus size={13} /> Create variable
              </button>
            </div>
          ) : (
            <div className="var-table-wrap muted">
              Variables are reusable values (colours, sizes, text) with modes such as Light and Dark. Bind them to layer properties from the Design panel; exported code gets CSS variables.
              <div>
                <button className="btn primary" style={{ marginTop: 12 }} onClick={addCollection}>
                  <Plus size={13} /> Create collection
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
      {modeDelete && (
        <ConfirmDialog
          title="Delete mode?"
          message={modeDelete.message}
          confirmLabel="Delete mode"
          onCancel={() => setModeDelete(null)}
          onConfirm={() => {
            deleteMode(modeDelete.id);
            setModeDelete(null);
          }}
        />
      )}
      {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
      {aliasPick && (
        <TokenPicker
          anchor={aliasPick.anchor}
          label={`Alias ${aliasPick.v.name} to`}
          placeholder={`Search ${aliasPick.v.type} variables`}
          emptyText={`No other ${aliasPick.v.type} variables`}
          items={aliasItems}
          selectedId={aliasOf(aliasPick.v.values[aliasPick.mode])}
          onPick={(x) => chooseAlias(aliasPick.v, aliasPick.mode, x.id)}
          onClose={() => setAliasPick(null)}
        />
      )}
      {detailsFor && coll && (
        <DetailsPopover
          variable={coll.variables.find((v) => v.id === detailsFor.id)}
          anchor={detailsFor.anchor}
          onDescription={(description) => update((c) => ({ ...c, variables: c.variables.map((v) => (v.id === detailsFor.id ? { ...v, description } : v)) }))}
          onSelectUsers={selectUsers}
          onClose={() => setDetailsFor(null)}
        />
      )}
      {scopeFor && coll && (
        <ScopePopover
          variable={coll.variables.find((v) => v.id === scopeFor.id)}
          anchor={scopeFor.anchor}
          onChange={(scopes) => setScopes(scopeFor.id, scopes)}
          onClose={() => setScopeFor(null)}
        />
      )}
    </div>
  );
}

const withScopes = (v: Variable, scopes: string[]): Variable => {
  const { scopes: _drop, ...rest } = v;
  return scopes.length ? { ...rest, scopes } : rest;
};

/** Details of one variable: what it is for, and where it is used (counted when this opens). */
function DetailsPopover({ variable, anchor, onDescription, onSelectUsers, onClose }: { variable?: Variable; anchor: DOMRect; onDescription: (d: string) => void; onSelectUsers: (v: Variable) => void; onClose: () => void }) {
  const usage = useMemo(() => (variable ? layersUsing(getDoc(), useStore.getState().es.page, variable.id) : null), [variable?.id]);
  if (!variable || !usage) return null;
  const text = !usage.here.length && !usage.other ? "Not bound to any layer" : `Bound to ${usage.here.length} layer${usage.here.length === 1 ? "" : "s"} on this page` + (usage.other ? ` and ${usage.other} on other pages` : "");
  return (
    <Popover anchor={anchor} onClose={onClose} label={`Details of ${variable.name}`} width={260}>
      <div className="var-details">
        <div className="small muted">Description</div>
        <Commit value={variable.description ?? ""} label="Description" title="What this variable is for" onCommit={(d) => onDescription(d.trim())} />
        <div className="small muted" data-var-usage>
          {text}
        </div>
        {(usage.here.length > 0 || usage.other > 0) && (
          <button className="btn" onClick={() => onSelectUsers(variable)}>
            Select layers using this
          </button>
        )}
      </div>
    </Popover>
  );
}

/** "Show in" checkboxes: all supported properties (nothing ticked), or a subset. */
function ScopePopover({ variable, anchor, onChange, onClose }: { variable?: Variable; anchor: DOMRect; onChange: (scopes: string[]) => void; onClose: () => void }) {
  if (!variable) return null;
  const mine = SCOPES_FOR_KIND[variable.type];
  const on = variable.scopes ?? [];
  const toggle = (id: string) => onChange(on.includes(id) ? on.filter((x) => x !== id) : [...on, id]);
  return (
    <Popover anchor={anchor} onClose={onClose} label={`Show ${variable.name} in`}>
      <div className="var-scopes" role="group" aria-label={`Show ${variable.name} in`}>
        <label className="var-scope">
          <input type="checkbox" checked={on.length === 0} onChange={() => onChange([])} />
          <span>All supported properties</span>
        </label>
        {SCOPES.filter((sc) => mine.includes(sc.id)).map((sc) => (
          <label key={sc.id} className="var-scope">
            <input type="checkbox" checked={on.includes(sc.id)} onChange={() => toggle(sc.id)} />
            <span>{sc.label}</span>
          </label>
        ))}
      </div>
    </Popover>
  );
}
