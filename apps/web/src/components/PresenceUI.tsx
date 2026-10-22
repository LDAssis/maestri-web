"use client";

import React, { useMemo, useState } from "react";
import { Node, ViewportPortal, useStore } from "@xyflow/react";
import { Avatar } from "./EntryGate";
import { Peer, PresenceSnapshot, usePresence } from "@/lib/presence";

const MAX_AVATARS = 5;

interface ProjectRef {
  id: string;
  name: string;
}

const activityText = (peer: Peer, snap: PresenceSnapshot) => {
  const title =
    (peer.projectId === snap.projectId && peer.activeNodeId && snap.nodeTitles[peer.activeNodeId]) || "um nó";
  if (peer.activeNodeId) {
    if (peer.activity === "typing") return `digitando no ${title}`;
    if (peer.activity === "editing") return `editando ${title}`;
    if (peer.activity === "dragging") return `movendo ${title}`;
  }
  return peer.projectId ? "vendo o canvas" : "ocioso";
};

// Pilha de avatares no header + painel "Online agora"
export function PresenceStack({
  me,
  projects,
  onGoTo,
}: {
  me: string;
  projects: ProjectRef[];
  onGoTo: (peer: Peer) => void;
}) {
  const snap = usePresence();
  const [open, setOpen] = useState(false);
  const projectName = (id: string | null) => projects.find((p) => p.id === id)?.name || "sem projeto";

  // Mesma pessoa em várias abas vira uma entrada (prefere a aba que está em algum projeto)
  const people = useMemo(() => {
    const byUser = new Map<string, Peer>();
    for (const p of snap.peers) {
      if (p.user.id === me) continue;
      const cur = byUser.get(p.user.id);
      if (!cur || (!cur.projectId && p.projectId)) byUser.set(p.user.id, p);
    }
    return Array.from(byUser.values());
  }, [snap.peers, me]);

  if (people.length === 0) return null;
  const shown = people.slice(0, MAX_AVATARS);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center -space-x-2 rounded-full hover:opacity-90 transition"
        aria-label="Online agora"
      >
        {shown.map((p) => (
          <span
            key={p.user.id}
            className="rounded-full ring-2 ring-slate-950"
            title={`${p.user.name} — ${projectName(p.projectId)}`}
          >
            <Avatar user={p.user} size={26} />
          </span>
        ))}
        {people.length > MAX_AVATARS && (
          <span className="h-[26px] min-w-[26px] px-1 rounded-full bg-slate-800 ring-2 ring-slate-950 text-[10px] text-slate-200 flex items-center justify-center">
            +{people.length - MAX_AVATARS}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-10 w-72 rounded-xl border border-slate-800 bg-slate-950 shadow-2xl py-1 z-50">
          <div className="px-3 py-1.5 text-[10px] font-mono uppercase text-slate-500 border-b border-slate-800/80">
            Online agora
          </div>
          <div className="max-h-72 overflow-y-auto">
            {people.map((p) => (
              <div key={p.user.id} className="flex items-center gap-2.5 px-3 py-2">
                <Avatar user={p.user} size={28} />
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium text-slate-100 truncate">{p.user.name}</div>
                  <div className="text-[11px] text-slate-500 truncate">
                    {projectName(p.projectId)} · {activityText(p, snap)}
                  </div>
                </div>
                {p.projectId && (
                  <button
                    onClick={() => {
                      onGoTo(p);
                      setOpen(false);
                    }}
                    className="px-2 py-1 rounded-lg text-[11px] font-medium text-indigo-300 hover:bg-slate-900 transition"
                  >
                    Ir até
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function PresenceToasts() {
  const { toasts } = usePresence();
  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 z-[60] flex flex-col items-end gap-2 pointer-events-none" role="status">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="rounded-lg border border-slate-800 bg-slate-900/95 px-3 py-1.5 text-xs text-slate-200 shadow-xl backdrop-blur-md"
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}

// Dentro do <ReactFlow>: cursores remotos e anéis de nós ativos, em coordenadas do flow (acompanham pan/zoom)
export function PresenceLayer({ nodes, projectId }: { nodes: Node<any>[]; projectId: string }) {
  const { peers } = usePresence();
  const zoom = useStore((s) => s.transform[2]);
  const here = peers.filter((p) => p.projectId === projectId);

  return (
    <ViewportPortal>
      {here.map((p) => {
        const node = p.activeNodeId ? nodes.find((n) => n.id === p.activeNodeId) : undefined;
        return (
          <React.Fragment key={p.connId}>
            {node && (
              <div
                className="absolute pointer-events-none rounded-2xl"
                style={{
                  left: node.position.x - 4,
                  top: node.position.y - 4,
                  width: Number(node.measured?.width ?? node.width ?? node.style?.width ?? 300) + 8,
                  height: Number(node.measured?.height ?? node.height ?? node.style?.height ?? 200) + 8,
                  border: `2px solid ${p.user.color}`,
                  boxShadow: `0 0 12px ${p.user.color}66`,
                }}
              >
                <span className="absolute -top-3 -right-3 rounded-full ring-2 ring-slate-950">
                  <Avatar user={p.user} size={20} />
                </span>
              </div>
            )}
            {p.cursor && (
              <div
                className="absolute left-0 top-0 pointer-events-none"
                style={{
                  transform: `translate(${p.cursor.x}px, ${p.cursor.y}px) scale(${1 / zoom})`,
                  transformOrigin: "0 0",
                  transition: "transform 80ms linear",
                }}
              >
                <svg width="18" height="18" viewBox="0 0 18 18" fill={p.user.color} stroke="#0f172a" strokeWidth="1">
                  <path d="M1 1 L1 15 L5 11 L8 17 L10.5 16 L7.5 10 L13 10 Z" />
                </svg>
                <span
                  className="ml-3 -mt-1 inline-block rounded px-1.5 py-0.5 text-[10px] font-medium text-white whitespace-nowrap"
                  style={{ background: p.user.color }}
                >
                  {p.user.name}
                </span>
              </div>
            )}
          </React.Fragment>
        );
      })}
    </ViewportPortal>
  );
}
