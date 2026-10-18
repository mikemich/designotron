// Collaborators' cursors and selections on the canvas.

import { useCollab } from "../collab";
import { getDoc, query, useStore } from "../store";
import type { Mat } from "../types";
import { corners, polyPoints } from "./geometry";

type View = { x: number; y: number; zoom: number };

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
        return items.map((it) => <polygon key={`${p.id}-${it.id}`} points={polyPoints(corners(v, it.matrix, it.width, it.height))} fill="none" stroke={p.color} strokeWidth={1.5} />);
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
