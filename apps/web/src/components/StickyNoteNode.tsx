"use client";

import React, { useState } from "react";
import { Handle, Position, NodeResizer } from "@xyflow/react";
import { StickyNote, Edit3 } from "lucide-react";

export interface StickyNoteData extends Record<string, unknown> {
  title: string;
  content: string;
  author?: string;
  color?: "amber" | "indigo" | "emerald" | "rose";
}

export default function StickyNoteNode({
  data,
  selected,
}: {
  data: StickyNoteData;
  selected?: boolean;
}) {
  const [content, setContent] = useState(data.content || "");
  const [title, setTitle] = useState(data.title || "Nota Adesiva");
  const [isEditing, setIsEditing] = useState(false);

  const getColorStyles = () => {
    switch (data.color) {
      case "indigo":
        return "bg-indigo-950/80 border-indigo-700/80 text-indigo-100";
      case "emerald":
        return "bg-emerald-950/80 border-emerald-700/80 text-emerald-100";
      case "rose":
        return "bg-rose-950/80 border-rose-700/80 text-rose-100";
      default:
        return "bg-amber-950/70 border-amber-600/70 text-amber-100";
    }
  };

  return (
    <div
      className={`w-full h-full min-w-[240px] min-h-[160px] rounded-2xl border p-4 shadow-2xl backdrop-blur-md transition hover:shadow-indigo-500/10 font-sans flex flex-col ${getColorStyles()}`}
    >
      {/* Redimensionador Oficial do React Flow */}
      <NodeResizer
        minWidth={240}
        minHeight={160}
        isVisible={selected}
        lineClassName="!border-amber-400"
        handleClassName="!h-3 !w-3 !bg-amber-400 !border-2 !border-slate-900 !rounded"
      />

      {/* Handle superior de conexão */}
      <Handle
        type="target"
        position={Position.Top}
        className="!w-3 !h-3 !bg-amber-400 !border-2 !border-slate-900"
      />

      {/* Header da Nota */}
      <div className="flex items-center justify-between pb-2 mb-2 border-b border-white/10 text-xs shrink-0">
        <div className="flex items-center gap-1.5 font-semibold">
          <StickyNote className="h-3.5 w-3.5 opacity-80" />
          {isEditing ? (
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="bg-black/40 rounded px-1.5 py-0.5 text-xs text-white focus:outline-none"
            />
          ) : (
            <span>{title}</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setIsEditing(!isEditing)}
            className="p-1 hover:bg-white/10 rounded transition"
            title="Editar nota"
          >
            <Edit3 className="h-3 w-3 opacity-70" />
          </button>
        </div>
      </div>

      {/* Conteúdo da Nota com preenchimento total */}
      <div className="flex-1 w-full overflow-hidden flex flex-col">
        {isEditing ? (
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            className="w-full h-full bg-black/40 rounded-lg p-2 text-xs font-mono leading-relaxed text-white focus:outline-none resize-none"
          />
        ) : (
          <div className="w-full h-full text-xs leading-relaxed whitespace-pre-wrap font-mono opacity-90 overflow-y-auto">
            {content}
          </div>
        )}
      </div>

      {/* Autor da nota */}
      <div className="mt-3 pt-2 border-t border-white/10 flex items-center justify-between text-[10px] opacity-70 font-mono shrink-0">
        <span>{data.author ? `✍️ ${data.author}` : "Nota da equipe"}</span>
        <span>Auto-sync</span>
      </div>

      {/* Handle inferior de conexão */}
      <Handle
        type="source"
        position={Position.Bottom}
        className="!w-3 !h-3 !bg-amber-400 !border-2 !border-slate-900"
      />
    </div>
  );
}
