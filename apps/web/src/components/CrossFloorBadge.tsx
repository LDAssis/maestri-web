"use client";

import React, { useContext, useState } from "react";
import { useStore } from "@xyflow/react";
import { ArrowUpDown } from "lucide-react";
import { FloorNavContext } from "@/lib/floorContext";

const GROUND = "Ground";
interface Link { id: string; title: string; floor: string }

// Badge "↕ N" num agente ligado a agentes de outros andares; a lista leva ao andar do outro nó
export default function CrossFloorBadge({ id, floor }: { id: string; floor?: string }) {
  const goTo = useContext(FloorNavContext);
  const [open, setOpen] = useState(false);
  const mine = floor || GROUND;
  const links = useStore(
    (s) => {
      const out: Link[] = [];
      for (const e of s.edges) {
        const other = e.source === id ? e.target : e.target === id ? e.source : null;
        const n = other ? s.nodeLookup.get(other) : undefined;
        const f = (n?.data as any)?.floor || GROUND;
        if (n && n.type === "agentTerminal" && f !== mine) out.push({ id: n.id, title: String((n.data as any)?.title ?? n.id), floor: f });
      }
      return out;
    },
    (a, b) => a.length === b.length && a.every((l, i) => l.id === b[i].id && l.title === b[i].title && l.floor === b[i].floor),
  );
  if (!links.length) return null;
  const label = links.map((l) => `${l.title} @ ${l.floor}`).join(", ");

  return (
    <div className="nodrag relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Ligado a agentes de outros andares: ${label}`}
        title={links.map((l) => `${l.title} @ ${l.floor}`).join("\n")}
        className="flex items-center gap-0.5 rounded-md border border-slate-800 bg-slate-900 px-1 py-0.5 text-[10px] text-sky-300 hover:border-sky-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400"
      >
        <ArrowUpDown className="h-3 w-3" />
        {links.length}
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-6 z-50 min-w-[160px] rounded-lg border border-slate-800 bg-slate-950 py-1 shadow-xl">
          {links.map((l) => (
            <button
              key={l.id}
              role="menuitem"
              onClick={() => {
                setOpen(false);
                goTo(l.floor);
              }}
              className="block w-full px-3 py-1 text-left text-[11px] text-slate-200 hover:bg-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400"
            >
              {l.title} <span className="text-slate-500">@ {l.floor}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
