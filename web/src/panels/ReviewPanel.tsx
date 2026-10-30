import { useMemo } from "react";
import { AlertCircle, AlertTriangle, Info, Sparkles, Wand2 } from "lucide-react";
import { dispatch, query, useStore, zoomToSelection } from "../store";
import { Section } from "../ui/controls";
import { askClaude } from "../ai/chatState";

interface Issue {
  nodeId: string;
  nodeName: string;
  kind: string;
  severity: "error" | "warning" | "info";
  message: string;
  fixLabel: string | null;
  fix: Record<string, unknown> | null;
}

const KIND_LABEL: Record<string, string> = {
  lowContrast: "Low contrast",
  tinyText: "Tiny text",
  clippedText: "Clipped text",
  offGrid: "Off-grid spacing",
  smallTapTarget: "Small tap target",
  defaultName: "Default layer name",
  nearDuplicateColor: "Near-duplicate colour",
  unlinkedStyle: "Unlinked colour style",
};

/** Design lint results with one-click fixes, plus a Claude critique. */
export function ReviewPanel() {
  const docRev = useStore((s) => s.es.docRev);
  const page = useStore((s) => s.es.page);
  const issues = useMemo(() => query<Issue[]>({ q: "lint", page }), [docRev, page]);
  const fixable = issues.filter((i) => i.fix);
  const fixAll = () => {
    dispatch({ op: "beginGesture" });
    try {
      // Fixes can surface follow-ups (e.g. a new colour near an existing one); repeat a few passes.
      for (let pass = 0; pass < 4; pass++) {
        const todo = query<Issue[]>({ q: "lint", page }).filter((x) => x.fix);
        if (!todo.length) break;
        for (const i of todo) dispatch(i.fix!, { quiet: true });
      }
    } finally {
      dispatch({ op: "endGesture" });
    }
  };
  const counts = { error: 0, warning: 0, info: 0 };
  for (const i of issues) counts[i.severity]++;
  return (
    <div className="scroll">
      <Section title="Review this page">
        <div className="muted small" style={{ marginBottom: 10 }}>
          {issues.length === 0
            ? "No problems found: contrast, text size, spacing, colours and tap targets look good."
            : `${counts.error} errors · ${counts.warning} warnings · ${counts.info} suggestions`}
        </div>
        {fixable.length > 0 && (
          <button className="btn block" style={{ marginBottom: 6 }} onClick={fixAll}>
            <Wand2 size={13} /> Fix {fixable.length} automatically
          </button>
        )}
        <button
          className="btn block primary"
          onClick={() =>
            askClaude(
              "Critique the design on this page like a senior product designer. Call lint_design and get_screenshot first. Cover visual hierarchy, spacing rhythm, typography, colour, contrast and consistency. Then fix the most important problems directly, and list what you changed.",
            )
          }
        >
          <Sparkles size={13} /> Ask Claude for a critique
        </button>
      </Section>
      {issues.map((i, n) => (
        <div key={n} className="section issue" onClick={() => (dispatch({ op: "select", ids: [i.nodeId] }), zoomToSelection())}>
          <div className="row" style={{ alignItems: "flex-start" }}>
            <span className={"sev " + i.severity}>
              {i.severity === "error" ? <AlertCircle size={14} /> : i.severity === "warning" ? <AlertTriangle size={14} /> : <Info size={14} />}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{KIND_LABEL[i.kind] ?? i.kind}</div>
              <div className="muted small" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {i.nodeName}
              </div>
              <div className="small" style={{ marginTop: 4, lineHeight: 1.5 }}>
                {i.message}
              </div>
            </div>
          </div>
          {i.fix && (
            <button
              className="btn"
              style={{ marginTop: 6 }}
              onClick={(e) => {
                e.stopPropagation();
                dispatch(i.fix!);
              }}
            >
              {i.fixLabel ?? "Fix"}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
