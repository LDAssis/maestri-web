"use client";

import React, { useContext, useRef, useState } from "react";
import { Handle, Position, NodeResizer, useReactFlow, useStore } from "@xyflow/react";
import { Layers, ChevronsUpDown, ArrowUpFromLine, Lock } from "lucide-react";
import DeleteNodeButton from "./DeleteNodeButton";
import Markdown from "./Markdown";
import { NOTE_STYLE, ICON_MAP } from "./palette";
import { CanvasOpsContext } from "@/lib/canvasOps";
import { unstackOps } from "@/lib/noteStack";

export interface NoteStackData extends Record<string, unknown> {
  title: string;
  color?: string;
  icon?: string;
}

// Fichário: pilha de páginas (notas com data.stackId === id do fichário, escondidas no canvas)
export default function NoteStackNode({ id, data }: { id: string; data: NoteStackData }) {
  const { setNodes, setEdges, getEdges, getNode, updateNodeData, screenToFlowPosition } = useReactFlow();
  const sendOp = useContext(CanvasOpsContext);
  // Seletor estável: só as páginas deste fichário (comparadas por referência dos nós)
  const pages = useStore(
    (s) => s.nodes.filter((n) => n.type === "stickyNote" && (n.data as any)?.stackId === id),
    (a, b) => a.length === b.length && a.every((n, i) => n === b[i]),
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const active = pages.find((p) => p.id === activeId) ?? pages[0];
  const Icon = (data.icon && ICON_MAP[data.icon]) || Layers;
  const colorStyles = NOTE_STYLE[data.color ?? "indigo"] ?? NOTE_STYLE.indigo;

  // Tira a nota do fichário: volta ao canvas (ao lado do fichário ou onde foi solta) e herda as ligações dele
  const unstack = (noteId: string, at?: { x: number; y: number }) => {
    const self = getNode(id);
    if (!self) return;
    const w = Number(self.measured?.width ?? self.width ?? 300);
    const position = at ?? { x: self.position.x + w + 40, y: self.position.y };
    const ops = unstackOps(noteId, id, getEdges());
    updateNodeData(noteId, ops.data);
    setNodes((nds) => nds.map((n) => (n.id === noteId ? { ...n, position } : n)));
    sendOp({ kind: "upsertNodes", nodes: [{ id: noteId, position }] });
    if (ops.addEdges.length) {
      setEdges((eds) => [...eds, ...ops.addEdges]);
      sendOp({ kind: "upsertEdges", edges: ops.addEdges });
    }
  };

  // Arrastar uma aba para fora do fichário a tira e a solta onde o ponteiro parou
  const rootRef = useRef<HTMLDivElement>(null);
  const onTabDragEnd = (noteId: string, e: React.DragEvent) => {
    const r = rootRef.current?.getBoundingClientRect();
    if (!r || (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom)) return;
    unstack(noteId, screenToFlowPosition({ x: e.clientX, y: e.clientY }));
  };

  return (
    <div ref={rootRef} className={`w-full h-full min-w-[240px] min-h-[160px] rounded-2xl border p-3 shadow-2xl backdrop-blur-md font-sans flex flex-col ${colorStyles}`}>
      <NodeResizer minWidth={240} minHeight={160} isVisible lineClassName="!border-amber-400" handleClassName="!h-3 !w-3 !bg-amber-400 !border-2 !border-slate-900 !rounded" />
      <Handle type="target" position={Position.Top} className="!w-3 !h-3 !bg-amber-400 !border-2 !border-slate-900" />

      <div className="flex items-center justify-between pb-2 mb-2 border-b border-white/10 text-xs shrink-0">
        <div className="flex items-center gap-1.5 font-semibold min-w-0">
          <Icon className="h-3.5 w-3.5 opacity-80 shrink-0" />
          <span className="truncate">{data.title || "Fichário"}</span>
          <span className="opacity-60 font-normal">({pages.length})</span>
        </div>
        <div className="flex items-center gap-1 nodrag">
          <button
            onClick={() => setExpanded((v) => !v)}
            aria-pressed={expanded}
            aria-label={expanded ? "Recolher páginas" : "Expandir todas as páginas"}
            // Com menos de 2 páginas não há o que expandir (e o botão não parece quebrado)
            disabled={pages.length < 2 && !expanded}
            title={pages.length < 2 && !expanded ? "Expandir (precisa de 2 ou mais páginas)" : expanded ? "Recolher" : "Expandir todas as páginas"}
            className="p-1 hover:bg-white/10 rounded transition disabled:opacity-30 disabled:hover:bg-transparent focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/70"
          >
            <ChevronsUpDown className="h-3 w-3 opacity-70" />
          </button>
          <DeleteNodeButton id={id} />
        </div>
      </div>

      {pages.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-[11px] opacity-60 text-center px-2">
          Fichário vazio. Use <code className="mx-1">maestri note stack</code> para guardar notas aqui.
        </div>
      ) : expanded ? (
        <div className="flex-1 overflow-y-auto nowheel nodrag space-y-2">
          {pages.map((p) => (
            <section key={p.id} className="rounded-lg bg-black/25 p-2" aria-label={`Página ${String((p.data as any).title)}`}>
              <div className="flex items-center justify-between text-[11px] font-semibold mb-1">
                <span className="flex items-center gap-1">
                  {(p.data as any).locked === true && <Lock className="h-2.5 w-2.5" aria-label="travada" />}
                  {String((p.data as any).title)}
                </span>
                <UnstackButton onClick={() => unstack(p.id)} />
              </div>
              <div className="text-xs leading-relaxed opacity-90"><Markdown>{String((p.data as any).content ?? "")}</Markdown></div>
            </section>
          ))}
        </div>
      ) : (
        <>
          <div role="tablist" aria-label="Páginas do fichário" className="nodrag flex gap-1 overflow-x-auto shrink-0 pb-1">
            {pages.map((p) => (
              <button
                key={p.id}
                role="tab"
                draggable
                onDragEnd={(e) => onTabDragEnd(p.id, e)}
                title="Arraste para fora para tirar do fichário"
                aria-selected={p.id === active?.id}
                onClick={() => setActiveId(p.id)}
                className={`px-2 py-0.5 rounded-t text-[11px] whitespace-nowrap max-w-[140px] truncate focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/70 ${
                  p.id === active?.id ? "bg-black/40 font-semibold" : "bg-white/5 opacity-70 hover:opacity-100"
                }`}
              >
                {String((p.data as any).title)}
              </button>
            ))}
          </div>
          {active && (
            <div role="tabpanel" className="flex-1 min-h-0 rounded-lg bg-black/25 p-2 flex flex-col">
              <div className="flex items-center justify-between text-[10px] opacity-70 mb-1 shrink-0">
                <span className="flex items-center gap-1">{(active.data as any).locked === true && <Lock className="h-2.5 w-2.5" aria-label="travada" />}página {pages.indexOf(active) + 1} de {pages.length}</span>
                <UnstackButton onClick={() => unstack(active.id)} />
              </div>
              <div className="flex-1 overflow-y-auto nowheel nodrag text-xs leading-relaxed opacity-90">
                <Markdown>{String((active.data as any).content ?? "")}</Markdown>
              </div>
            </div>
          )}
        </>
      )}

      <Handle type="source" position={Position.Bottom} className="!w-3 !h-3 !bg-amber-400 !border-2 !border-slate-900" />
    </div>
  );
}

function UnstackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label="Tirar do fichário"
      title="Tirar a nota do fichário"
      className="nodrag flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-white/10 text-[10px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/70"
    >
      <ArrowUpFromLine className="h-3 w-3" /> Tirar
    </button>
  );
}
