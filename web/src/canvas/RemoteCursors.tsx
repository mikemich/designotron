// Collaborators' cursors and selections on the canvas.

import { useCollab } from "../collab";
import { getDoc, query, useStore } from "../store";
import type { Mat } from "../types";
import { corners, polyPoints } from "./geometry";

type View = { x: number; y: number; zoom: number };

/** Width of a name tag for `name` at 11 px (an estimate: no text measuring per render). */
const tagWidth = (name: string) => Math.min(140, name.length * 6.4 + 12);

export function RemoteSelections({ v }: { v: View }) {
  const peers = useCollab((s) => s.peers);
  const page = useStore((s) => s.es.page);
  useStore((s) => s.rev);
  const doc = getDoc();
  return (
    <g>
      {Object.values(peers).map((p) => {
        const ids = (p.presence?.page === page ? p.presence.selection : []).filter((id) => doc.nodes[id]);
        if (!ids.length) return null;
        const items = query<{ items: { id: string; matrix: Mat; width: number; height: number }[] }>({ q: "bounds", ids }).items;
        // One name tag per person, at the top-left of everything they have selected.
        let left = Infinity;
        let top = Infinity;
        const outlines = items.map((it) => {
          const pts = corners(v, it.matrix, it.width, it.height);
          for (const q of pts) {
            left = Math.min(left, q.x);
            top = Math.min(top, q.y);
          }
          return <polygon key={`${p.id}-${it.id}`} points={polyPoints(pts)} fill="none" stroke={p.color} strokeWidth={1.5} />;
        });
        const name = p.name || "Guest";
        const w = tagWidth(name);
        return (
          <g key={p.id}>
            {outlines}
            {Number.isFinite(left) && (
              <g className="remote-tag" data-peer={p.id} transform={`translate(${left - 0.75} ${Math.max(0, top - 18)})`}>
                <rect width={w} height={17} rx={3} fill={p.color} />
                <text x={6} y={12} fontSize={11} fontWeight={600} fill="#fff">
                  {name.length > 20 ? `${name.slice(0, 19)}…` : name}
                </text>
              </g>
            )}
          </g>
        );
      })}
    </g>
  );
}

export function RemoteCursors({ v }: { v: View }) {
  const peers = useCollab((s) => s.peers);
  const page = useStore((s) => s.es.page);
  return (
    <>
      {Object.values(peers).map((p) => {
        const c = p.presence?.page === page ? p.presence.cursor : null;
        if (!c) return null;
        return (
          <div key={p.id} className="remote-cursor" style={{ left: c.x * v.zoom + v.x, top: c.y * v.zoom + v.y }}>
            <svg width="16" height="20" viewBox="0 0 16 20">
              <path d="M1 1L1 16L5 12L8 19L11 18L8 11L14 11Z" fill={p.color} stroke="#fff" strokeWidth="1.2" strokeLinejoin="round" />
            </svg>
            <span style={{ background: p.color }}>{p.name}</span>
          </div>
        );
      })}
    </>
  );
}
