// Collaborators' carets and selections inside the text layer they are editing: a 2 px bar in their
// colour with a name flag, and their selection tinted at 20 %. Each peer sends the characters their
// selection starts and ends after (presence `text`); this maps them to indices in this editor's own
// copy of the text and draws them from the engine's line layout, as the local editor does.

import { useEffect, useMemo, useState } from "react";
import { useCollab, type Peer, type TextPresence } from "../collab";
import { getDoc, query, useStore } from "../store";
import type { Mat } from "../types";
import { PresenceBoundary } from "./PresenceBoundary";
import { caretRect, selectionRects, type CaretGeometry } from "./textCaret";

type View = { x: number; y: number; zoom: number };

export function RemoteTextCarets({ v }: { v: View }) {
  return (
    <PresenceBoundary>
      <Carets v={v} />
    </PresenceBoundary>
  );
}

function Carets({ v }: { v: View }) {
  const peers = useCollab((s) => s.peers);
  const page = useStore((s) => s.es.page);
  const now = useStore((s) => s.rev);
  // Measured at most once a frame, however fast the document changes (every keystroke and ack bumps `rev`).
  const [rev, setRev] = useState(now);
  useEffect(() => {
    const h = requestAnimationFrame(() => setRev(now));
    return () => cancelAnimationFrame(h);
  }, [now]);
  const doc = getDoc();
  return (
    <>
      {Object.values(peers).map((p) => {
        const t = p.presence?.page === page ? p.presence.text : undefined;
        if (!t || !doc.nodes[t.id]?.text) return null;
        return <PeerCaret key={p.id} peer={p} t={t} v={v} rev={rev} />;
      })}
    </>
  );
}

interface Placed {
  g: CaretGeometry;
  m: Mat;
  anchor: number;
  focus: number;
}

function place(t: TextPresence): Placed | null {
  try {
    return measure(t);
  } catch {
    // (A peer's caret the engine can't place is left out, not everyone's.)
    return null;
  }
}

function measure(t: TextPresence): Placed | null {
  const at = query<{ indices: (number | null)[] } | null>({ q: "textIndices", id: t.id, anchors: [t.a, t.f] });
  if (!at || at.indices[0] == null || at.indices[1] == null) return null;
  const [anchor, focus] = at.indices as number[];
  const g = query<CaretGeometry | null>({ q: "textLayout", id: t.id, from: Math.min(anchor, focus), to: Math.max(anchor, focus) });
  const m = query<{ items: { matrix: Mat }[] }>({ q: "bounds", ids: [t.id] }).items[0]?.matrix;
  return g && m ? { g, m, anchor, focus } : null;
}

function PeerCaret({ peer, t, v, rev }: { peer: Peer; t: TextPresence; v: View; rev: number }) {
  const key = JSON.stringify([t.id, t.a, t.f]);
  // Measured when the document or their caret changes, not with the viewport.
  const placed = useMemo(() => place(t), [rev, key]);
  if (!placed) return null;
  const { g, m, anchor, focus } = placed;
  const transform = `matrix(${m.a * v.zoom},${m.b * v.zoom},${m.c * v.zoom},${m.d * v.zoom},${m.e * v.zoom + v.x},${m.f * v.zoom + v.y})`;
  // One screen pixel in layer units.
  const px = 1 / (v.zoom * (Math.hypot(m.a, m.b) || 1));
  const rects = selectionRects(g, anchor, focus);
  const caret = caretRect(g, focus);
  const name = peer.name || "Guest";
  const shown = name.length > 20 ? `${name.slice(0, 19)}…` : name;
  const flagW = Math.min(140, name.length * 6.4 + 12);
  return (
    <svg className="remote-text" aria-hidden="true" style={{ left: 0, top: 0, transform }}>
      {rects.map((r, i) => (
        <rect key={i} className="remote-text-sel" data-peer={peer.id} x={r.x} y={r.top} width={r.width} height={r.height} fill={peer.color} fillOpacity={0.2} />
      ))}
      {caret && (
        <>
          <rect className="remote-text-bar" data-text-caret="" data-peer={peer.id} data-index={focus} x={caret.x - px} y={caret.top} width={2 * px} height={caret.height} fill={peer.color} />
          <g className="remote-text-flag" data-peer={peer.id} transform={`translate(${caret.x - px} ${caret.top}) scale(${px})`}>
            <rect y={-16} width={flagW} height={16} rx={3} fill={peer.color} />
            <text x={5} y={-4} fontSize={11} fontWeight={600} fill="#fff">
              {shown}
            </text>
          </g>
        </>
      )}
    </svg>
  );
}
