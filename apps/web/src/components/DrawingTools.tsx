"use client";

import React, { useRef, useState } from "react";
import { useReactFlow, type Node } from "@xyflow/react";
import { MousePointer2, Pencil, Square, Circle, MoveUpRight, Type, Eraser, Undo2, X } from "lucide-react";
import { FONT_BY_WIDTH, buildDrawing, newDrawingId, type DrawingData, type DrawingShape } from "@/lib/drawing";

export type DrawTool = "select" | DrawingShape | "eraser";
export const DRAW_COLORS = ["#f43f5e", "#f59e0b", "#10b981", "#0ea5e9", "#a78bfa", "#e2e8f0"];
export const DRAW_WIDTHS = [2, 4, 8];

const TOOLS: { id: DrawTool; label: string; Icon: typeof Pencil }[] = [
  { id: "select", label: "Selecionar", Icon: MousePointer2 },
  { id: "pen", label: "Caneta", Icon: Pencil },
  { id: "rect", label: "Retângulo", Icon: Square },
  { id: "ellipse", label: "Elipse", Icon: Circle },
  { id: "arrow", label: "Seta", Icon: MoveUpRight },
  { id: "text", label: "Texto", Icon: Type },
  { id: "eraser", label: "Borracha", Icon: Eraser },
];

// Barra de ferramentas de desenho (rodapé do canvas)
export function DrawToolbar({
  tool, color, width, canUndo, onTool, onColor, onWidth, onUndo, onClose,
}: {
  tool: DrawTool; color: string; width: number; canUndo: boolean;
  onTool: (t: DrawTool) => void; onColor: (c: string) => void; onWidth: (w: number) => void; onUndo: () => void; onClose: () => void;
}) {
  const btn = "p-1.5 rounded-lg border transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400";
  return (
    <div role="toolbar" aria-label="Ferramentas de desenho" className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 rounded-xl border border-slate-800 bg-slate-900/95 backdrop-blur-md px-2 py-1.5 shadow-xl max-w-[calc(100vw-2rem)] flex-wrap justify-center">
      {TOOLS.map(({ id, label, Icon }) => (
        <button key={id} aria-pressed={tool === id} aria-label={label} title={label} onClick={() => onTool(id)} className={`${btn} ${tool === id ? "bg-indigo-600 border-indigo-400 text-white" : "border-slate-800 text-slate-300 hover:bg-slate-800"}`}>
          <Icon className="h-4 w-4" />
        </button>
      ))}
      <span className="mx-1 h-5 w-px bg-slate-800" aria-hidden />
      <div role="radiogroup" aria-label="Cor do desenho" className="flex items-center gap-1">
        {DRAW_COLORS.map((c) => (
          <button key={c} role="radio" aria-checked={color === c} aria-label={`Cor ${c}`} onClick={() => onColor(c)} className={`h-4 w-4 rounded-full border focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400 ${color === c ? "ring-2 ring-white/80 border-transparent" : "border-slate-700"}`} style={{ background: c }} />
        ))}
      </div>
      <span className="mx-1 h-5 w-px bg-slate-800" aria-hidden />
      <div role="radiogroup" aria-label="Espessura" className="flex items-center gap-1">
        {DRAW_WIDTHS.map((w) => (
          <button key={w} role="radio" aria-checked={width === w} aria-label={`Espessura ${w}`} onClick={() => onWidth(w)} className={`${btn} px-2 ${width === w ? "bg-slate-700 border-slate-500" : "border-slate-800 hover:bg-slate-800"}`}>
            <span className="block rounded bg-slate-200" style={{ width: 16, height: w }} />
          </button>
        ))}
      </div>
      <span className="mx-1 h-5 w-px bg-slate-800" aria-hidden />
      <button aria-label="Desfazer (Ctrl+Z)" title="Desfazer (Ctrl+Z)" disabled={!canUndo} onClick={onUndo} className={`${btn} border-slate-800 text-slate-300 hover:bg-slate-800 disabled:opacity-30`}>
        <Undo2 className="h-4 w-4" />
      </button>
      <button aria-label="Fechar desenho" title="Fechar (Esc)" onClick={onClose} className={`${btn} border-slate-800 text-slate-300 hover:bg-slate-800`}>
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

type Pt = { x: number; y: number };

// Camada de captura do desenho: só existe com uma ferramenta ligada, então pan/zoom/seleção ficam intactos fora dela
export function DrawingLayer({
  tool, color, width, onCreate, onErase,
}: {
  tool: Exclude<DrawTool, "select">; color: string; width: number;
  onCreate: (node: Node<DrawingData>) => void; onErase: (id: string) => void;
}) {
  const { screenToFlowPosition } = useReactFlow();
  const ref = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Pt[] | null>(null); // coords locais ao overlay
  const [textAt, setTextAt] = useState<{ local: Pt; client: Pt } | null>(null);
  const erased = useRef(new Set<string>());
  const local = (e: React.PointerEvent): Pt => {
    const r = ref.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const eraseAt = (e: React.PointerEvent) => {
    for (const el of document.elementsFromPoint(e.clientX, e.clientY)) {
      const id = (el.closest("[data-drawing-id]") as HTMLElement | null)?.getAttribute("data-drawing-id");
      if (id && !erased.current.has(id)) {
        erased.current.add(id);
        onErase(id);
        break;
      }
    }
  };

  const down = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (tool === "eraser") {
      erased.current.clear();
      return eraseAt(e);
    }
    // Texto: a caixa abre no pointerup. Abrir no pointerdown fazia o foco padrão do mousedown tirar o foco
    // do textarea (autoFocus) na hora, o onBlur confirmava vazio e a caixa sumia.
    if (tool === "text") return;
    setDraft([local(e)]);
  };
  const move = (e: React.PointerEvent) => {
    if (tool === "eraser") return e.buttons === 1 ? eraseAt(e) : undefined;
    if (!draft) return;
    const p = local(e);
    setDraft((d) => {
      if (!d) return d;
      if (tool === "pen") {
        const last = d[d.length - 1];
        return Math.hypot(p.x - last.x, p.y - last.y) < 2 || d.length >= 2000 ? d : [...d, p];
      }
      return [d[0], p];
    });
  };
  const up = (e: React.PointerEvent) => {
    if (tool === "text") return e.button === 0 ? setTextAt({ local: local(e), client: { x: e.clientX, y: e.clientY } }) : undefined;
    if (!draft) return;
    const r = ref.current!.getBoundingClientRect();
    const pts = draft.map((p) => screenToFlowPosition({ x: p.x + r.left, y: p.y + r.top }));
    setDraft(null);
    const node = buildDrawing(tool as DrawingShape, pts, color, width);
    if (node) onCreate(node);
  };

  const commitText = (value: string) => {
    const at = textAt;
    setTextAt(null);
    const text = value.trim().slice(0, 2000);
    if (!at || !text) return;
    const fs = FONT_BY_WIDTH[width] ?? 20;
    const p = screenToFlowPosition(at.client);
    const lines = text.split("\n");
    onCreate({
      id: newDrawingId(),
      type: "drawing",
      position: p,
      style: { width: Math.max(40, Math.max(...lines.map((l) => l.length)) * fs * 0.6), height: lines.length * fs * 1.4, pointerEvents: "none" },
      data: { shape: "text", text, color, width },
    } as Node<DrawingData>);
  };

  const preview = () => {
    if (!draft || draft.length < 1) return null;
    const a = draft[0];
    const b = draft[draft.length - 1];
    const s = { fill: "none", stroke: color, strokeWidth: width, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
    if (tool === "pen") return <polyline {...s} points={draft.map((p) => `${p.x},${p.y}`).join(" ")} />;
    if (tool === "rect") return <rect {...s} x={Math.min(a.x, b.x)} y={Math.min(a.y, b.y)} width={Math.abs(b.x - a.x)} height={Math.abs(b.y - a.y)} />;
    if (tool === "ellipse") return <ellipse {...s} cx={(a.x + b.x) / 2} cy={(a.y + b.y) / 2} rx={Math.abs(b.x - a.x) / 2} ry={Math.abs(b.y - a.y) / 2} />;
    return <line {...s} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />;
  };

  return (
    <div
      ref={ref}
      aria-label={`Camada de desenho: ${tool}`}
      className="absolute inset-0 z-[15]"
      style={{ cursor: tool === "eraser" ? "cell" : tool === "text" ? "text" : "crosshair", touchAction: "none" }}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => setDraft(null)}
    >
      <svg className="absolute inset-0 w-full h-full pointer-events-none" aria-hidden>{preview()}</svg>
      {textAt && (
        <textarea
          autoFocus
          aria-label="Texto do desenho"
          placeholder="Texto…"
          className="absolute bg-black/50 rounded px-1 outline outline-1 outline-white/40 resize-none"
          style={{ left: textAt.local.x, top: textAt.local.y, color, fontSize: FONT_BY_WIDTH[width] ?? 20, lineHeight: 1.3, minWidth: 120, minHeight: 32 }}
          onPointerDown={(e) => e.stopPropagation()}
          onFocus={(e) => (e.currentTarget.dataset.openedAt ||= String(Date.now()))}
          onBlur={(e) => {
            // Alguns navegadores embutidos (ex.: o portal do Maestri) tiram o foco logo depois do clique que abriu a
            // caixa; vazia e recém-aberta, ela recupera o foco em vez de sumir
            const el = e.currentTarget;
            if (!el.value.trim() && Date.now() - Number(el.dataset.openedAt || 0) < 500) return void setTimeout(() => el.focus(), 0);
            commitText(el.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setTextAt(null);
            else if (e.key === "Enter" && !e.shiftKey) (e.currentTarget as HTMLTextAreaElement).blur();
            e.stopPropagation();
          }}
        />
      )}
    </div>
  );
}
