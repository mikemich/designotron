import { useMemo, useState } from "react";
import { Sparkles } from "lucide-react";
import { dispatch, query, useStore, zoomToSelection } from "../store";
import type { CommentPin } from "../types";
import { Avatar, ago, askClaudeAboutComments } from "../canvas/Comments";
import { Section } from "../ui/controls";

/** All comment threads in the file; click one to jump to it. */
export function CommentsPanel() {
  const rev = useStore((s) => s.rev);
  const [showResolved, setShowResolved] = useState(false);
  const all = useMemo(() => query<CommentPin[]>({ q: "comments", includeResolved: true }), [rev]);
  const open = all.filter((c) => !c.resolved);
  const list = showResolved ? all : open;
  const jump = (c: CommentPin) => {
    if (useStore.getState().es.page !== c.page) dispatch({ op: "setPage", id: c.page });
    if (c.nodeId) {
      dispatch({ op: "select", ids: [c.nodeId] });
      zoomToSelection();
    }
    useStore.setState({ openComment: c.id, draftComment: null });
  };
  return (
    <div className="scroll">
      <Section title={`${open.length} open comment${open.length === 1 ? "" : "s"}`}>
        <button className="btn block primary" disabled={!open.length} onClick={() => askClaudeAboutComments()}>
          <Sparkles size={13} /> Ask Claude to address them
        </button>
        <div className="muted small" style={{ marginTop: 8, lineHeight: 1.6 }}>
          Press C (or pick the comment tool) and click the canvas to comment. Comments on a layer move with it.
        </div>
        <label className="row small" style={{ gap: 6, marginTop: 6 }}>
          <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> Show resolved
        </label>
      </Section>
      {list.map((c) => (
        <div key={c.id} className={"section comment-row" + (c.resolved ? " resolved" : "")} onClick={() => jump(c)}>
          <div className="row" style={{ alignItems: "flex-start" }}>
            <Avatar name={c.messages[0]?.author ?? "?"} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="small">
                <b>{c.messages[0]?.author}</b> <span className="muted">{ago(c.messages[0]?.time ?? 0)}</span>
              </div>
              <div className="comment-text">{c.messages[0]?.text}</div>
              <div className="muted small">
                {c.nodeName ? `on ${c.nodeName}` : ""}
                {c.messages.length > 1 ? ` · ${c.messages.length - 1} repl${c.messages.length === 2 ? "y" : "ies"}` : ""}
                {c.resolved ? " · resolved" : ""}
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
