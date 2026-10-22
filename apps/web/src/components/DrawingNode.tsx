"use client";

import React, { useState } from "react";
import { NodeResizer, useReactFlow, useStore } from "@xyflow/react";

import type { DrawingData } from "@/lib/drawing";
export type { DrawingData, DrawingShape } from "@/lib/drawing";

export { FONT_BY_WIDTH } from "@/lib/drawing";
import { FONT_BY_WIDTH } from "@/lib/drawing";

// Desenho do canvas (nó type "drawing"): SVG em pixels do nó; só o traço recebe o ponteiro, o resto do nó é transparente
export default function DrawingNode({ id, data, selected }: { id: string; data: DrawingData; selected?: boolean }) {
  const { updateNodeData } = useReactFlow();
  const size = useStore((s) => {
    const n = s.nodeLookup.get(id);
    const dim = (m?: number, v?: unknown, st?: unknown) => Math.round(m ?? (Number(v) || Number(st) || 0));
    return `${dim(n?.measured?.width, n?.width, n?.style?.width)}x${dim(n?.measured?.height, n?.height, n?.style?.height)}`;
  });
  const [w, h] = size.split("x").map((v) => Number(v) || 1);
  const [editing, setEditing] = useState(false);
  const sw = data.width || 4;
  const common = { fill: "none", stroke: data.color, strokeWidth: sw, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "data-drawing-id": id, style: { pointerEvents: "stroke" as const } };
  const hit = { fill: "none", stroke: "transparent", strokeWidth: Math.max(sw, 12), "data-drawing-id": id, style: { pointerEvents: "stroke" as const } };
  const pts = data.points ?? [];
  const px = (i: number) => (pts[i] ?? 0) * w;
  const py = (i: number) => (pts[i] ?? 0) * h;

  if (data.shape === "text") {
    const fs = FONT_BY_WIDTH[sw] ?? 20;
    return editing ? (
      <textarea
        autoFocus
        defaultValue={data.text}
        aria-label="Editar texto do desenho"
        onBlur={(e) => {
          updateNodeData(id, { text: e.target.value.slice(0, 2000) });
          setEditing(false);
        }}
        onKeyDown={(e) => (e.key === "Escape" || (e.key === "Enter" && !e.shiftKey)) && (e.currentTarget as HTMLTextAreaElement).blur()}
        className="nodrag nowheel w-full h-full bg-black/40 rounded p-0.5 outline-none resize-none"
        style={{ color: data.color, fontSize: fs, lineHeight: 1.3, pointerEvents: "auto" }}
      />
    ) : (
      <div
        data-drawing-id={id}
        onDoubleClick={() => setEditing(true)}
        title="Duplo clique para editar"
        className={`whitespace-pre-wrap select-none rounded ${selected ? "outline outline-1 outline-dashed outline-white/60" : ""}`}
        style={{ color: data.color, fontSize: fs, lineHeight: 1.3, pointerEvents: "auto", width: "max-content", maxWidth: 600 }}
      >
        {data.text || " "}
      </div>
    );
  }

  let shape: React.ReactNode = null;
  if (data.shape === "rect") shape = <rect x={sw / 2} y={sw / 2} width={Math.max(0, w - sw)} height={Math.max(0, h - sw)} rx={4} />;
  else if (data.shape === "ellipse") shape = <ellipse cx={w / 2} cy={h / 2} rx={Math.max(0, w / 2 - sw / 2)} ry={Math.max(0, h / 2 - sw / 2)} />;
  else if (data.shape === "pen") shape = <polyline points={Array.from({ length: pts.length / 2 }, (_, i) => `${px(i * 2)},${py(i * 2 + 1)}`).join(" ")} />;
  else if (data.shape === "arrow") {
    const [x1, y1, x2, y2] = [px(0), py(1), px(2), py(3)];
    const a = Math.atan2(y2 - y1, x2 - x1);
    const L = Math.max(10, sw * 4);
    const head = (d: number) => `${x2 - L * Math.cos(a + d)},${y2 - L * Math.sin(a + d)}`;
    shape = (
      <>
        <line x1={x1} y1={y1} x2={x2} y2={y2} />
        <polyline points={`${head(0.45)} ${x2},${y2} ${head(-0.45)}`} />
      </>
    );
  }

  // O traço e a área de captura compartilham a geometria; só o stroke recebe o ponteiro
  return (
    <>
      <NodeResizer minWidth={8} minHeight={8} isVisible={!!selected} lineClassName="!border-sky-400" handleClassName="!h-2.5 !w-2.5 !bg-sky-400 !border !border-slate-900 !rounded" />
      <svg width="100%" height="100%" viewBox={`0 0 ${w} ${h}`} style={{ overflow: "visible", pointerEvents: "none", display: "block" }} aria-label={`Desenho: ${data.shape}`} role="img">
        <g {...hit}>{shape}</g>
        <g {...common}>{shape}</g>
      </svg>
    </>
  );
}
