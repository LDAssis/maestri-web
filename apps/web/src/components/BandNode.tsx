"use client";

import React from "react";
import { Handle, Position, NodeResizer, useStore } from "@xyflow/react";
import { Users } from "lucide-react";
import DeleteNodeButton from "./DeleteNodeButton";
import { NOTE_STYLE, ICON_MAP } from "./palette";

export interface BandData extends Record<string, unknown> {
  title: string;
  members?: string[];
  color?: string;
  icon?: string;
}

// Banda: grupo de agentes onde todo membro alcança os outros (regras no servidor). Lista os membros;
// criar/alterar é pelo CLI (`maestri band ...`) — apagar o nó aqui equivale a dissolver a banda.
export default function BandNode({ id, data }: { id: string; data: BandData }) {
  const ids = data.members ?? [];
  // Títulos dos membros; seletor estável (string única) para não re-renderizar a cada arrasto
  const titles = useStore((s) => ids.map((m) => String(s.nodeLookup.get(m)?.data?.title ?? "")).filter(Boolean).join("\n"));
  const Icon = (data.icon && ICON_MAP[data.icon]) || Users;
  const colorStyles = NOTE_STYLE[data.color ?? "violet"] ?? NOTE_STYLE.violet;
  const list = titles ? titles.split("\n") : [];
  return (
    <div className={`w-full h-full min-w-[200px] min-h-[120px] rounded-2xl border border-dashed p-3 shadow-xl font-sans flex flex-col ${colorStyles}`}>
      <NodeResizer minWidth={200} minHeight={120} isVisible lineClassName="!border-violet-400" handleClassName="!h-3 !w-3 !bg-violet-400 !border-2 !border-slate-900 !rounded" />
      <Handle type="target" position={Position.Top} className="!w-3 !h-3 !bg-violet-400 !border-2 !border-slate-900" />
      <Handle type="source" position={Position.Bottom} className="!w-3 !h-3 !bg-violet-400 !border-2 !border-slate-900" />
      <div className="flex items-center justify-between pb-2 mb-2 border-b border-white/10 text-xs shrink-0">
        <div className="flex items-center gap-1.5 font-semibold min-w-0">
          <Icon className="h-3.5 w-3.5 opacity-80 shrink-0" />
          <span className="truncate">{data.title || "Banda"}</span>
          <span className="opacity-60 font-normal">({list.length})</span>
        </div>
        <div className="nodrag">
          <DeleteNodeButton id={id} />
        </div>
      </div>
      <ul className="text-[11px] space-y-0.5 overflow-y-auto nowheel min-h-0" aria-label="Membros da banda">
        {list.map((t, i) => (
          <li key={`${t}-${i}`} className="truncate">· {t}</li>
        ))}
        {list.length === 0 && <li className="opacity-60">Sem membros</li>}
      </ul>
    </div>
  );
}
