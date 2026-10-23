"use client";

import React, { useState } from "react";
import { Handle, Position, NodeResizer, useReactFlow } from "@xyflow/react";
import { StickyNote, Edit3, Lock, LockOpen } from "lucide-react";
import DeleteNodeButton from "./DeleteNodeButton";
import Markdown from "./Markdown";
import { NOTE_COLORS, NOTE_DOT } from "./CanvasOverlays";
import { usePresenceStore } from "@/lib/presence";
import { NOTE_STYLE, ICON_MAP } from "./palette";

export interface StickyNoteData extends Record<string, unknown> {
  title: string;
  content: string;
  author?: string;
  color?: string;
  icon?: string;
  locked?: boolean;
  // Nome fixo (pinnedName) ou acompanhando a primeira linha (autoTitle), usado pelo CLI
  pinnedName?: boolean;
  autoTitle?: boolean;
  stackId?: string | null;
}

export default function StickyNoteNode({
  id,
  data,
  selected,
}: {
  id: string;
  data: StickyNoteData;
  selected?: boolean;
}) {
  const content = data.content || "";
  const title = data.title || "Nota Adesiva";
  const [isEditing, setIsEditing] = useState(false);
  const { updateNodeData } = useReactFlow();
  const presence = usePresenceStore();
  const editingProps = {
    onFocus: () => presence.setActive(id, "editing"),
    onBlur: () => presence.setActive(null, "viewing"),
  };

  const locked = data.locked === true;
  const Icon = (data.icon && ICON_MAP[data.icon]) || StickyNote;
  const colorStyles = NOTE_STYLE[data.color ?? "amber"] ?? NOTE_STYLE.amber;

  return (
    <div
      className={`w-full h-full min-w-[240px] min-h-[160px] rounded-2xl border p-4 shadow-2xl backdrop-blur-md transition hover:shadow-indigo-500/10 font-sans flex flex-col ${colorStyles}`}
    >
      {/* Redimensionador Oficial do React Flow */}
      <NodeResizer
        minWidth={240}
        minHeight={160}
        isVisible={true}
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
      <div className="flex items-center justify-between gap-2 pb-2 mb-2 border-b border-white/10 text-xs shrink-0">
        {/* min-w-0 + truncate: título longo encolhe em vez de passar por baixo das cores e botões */}
        <div className="flex items-center gap-1.5 font-semibold min-w-0 flex-1">
          <Icon className="h-3.5 w-3.5 opacity-80 shrink-0" />
          {isEditing && !locked ? (
            <input
              type="text"
              value={title}
              onChange={(e) => {
                // Renomear à mão fixa o nome (a primeira linha deixa de renomear)
                updateNodeData(id, { title: e.target.value, pinnedName: true, autoTitle: false });
              }}
              {...editingProps}
              className="nodrag min-w-0 w-full bg-black/40 rounded px-1.5 py-0.5 text-xs text-white focus:outline-none"
            />
          ) : (
            <span className="truncate" title={title}>{title}</span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <div role="radiogroup" aria-label="Cor da nota" className="nodrag flex items-center gap-1 mr-1">
            {NOTE_COLORS.map((c) => (
              <button
                key={c}
                role="radio"
                aria-checked={(data.color || "amber") === c}
                aria-label={c}
                title={c}
                onClick={() => updateNodeData(id, { color: c })}
                className={`h-3 w-3 rounded-full ${NOTE_DOT[c]} ${
                  (data.color || "amber") === c ? "ring-2 ring-white/80" : "opacity-60 hover:opacity-100"
                }`}
              />
            ))}
          </div>
          <button
            onClick={() => updateNodeData(id, { locked: !locked })}
            aria-pressed={locked}
            aria-label={locked ? "Destravar nota" : "Travar nota"}
            title={locked ? "Nota travada: agentes só podem ler. Clique para destravar" : "Travar nota (somente leitura para agentes)"}
            className="p-1 hover:bg-white/10 rounded transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/70"
          >
            {locked ? <Lock className="h-3 w-3 text-amber-300" /> : <LockOpen className="h-3 w-3 opacity-70" />}
          </button>
          <button
            onClick={() => setIsEditing(!isEditing)}
            disabled={locked}
            aria-label="Editar nota"
            className="p-1 hover:bg-white/10 rounded transition disabled:opacity-30 disabled:cursor-not-allowed"
            title={locked ? "Nota travada" : "Editar nota"}
          >
            <Edit3 className="h-3 w-3 opacity-70" />
          </button>
          <DeleteNodeButton id={id} />
        </div>
      </div>

      {/* Conteúdo da Nota com preenchimento total */}
      <div className="flex-1 w-full overflow-hidden flex flex-col">
        {isEditing && !locked ? (
          <textarea
            value={content}
            onChange={(e) => {
              updateNodeData(id, { content: e.target.value });
            }}
            {...editingProps}
            placeholder="Escreva a nota (aceita Markdown)…"
            className="nodrag nowheel w-full h-full bg-black/40 rounded-lg p-2 text-xs font-mono leading-relaxed text-white focus:outline-none resize-none"
          />
        ) : (
          <div className="w-full h-full text-xs leading-relaxed opacity-90 overflow-y-auto nowheel">
            {content.trim() ? <Markdown>{content}</Markdown> : <p className="italic opacity-60">Nota vazia — clique no lápis para escrever.</p>}
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
