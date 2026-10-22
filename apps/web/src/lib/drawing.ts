// Lógica pura dos desenhos do canvas (nós type "drawing"), testável com `npx tsx`
export type DrawingShape = "pen" | "rect" | "ellipse" | "arrow" | "text";

export interface DrawingData extends Record<string, unknown> {
  shape: DrawingShape;
  // pen: x,y,x,y… ; arrow: x1,y1,x2,y2 — normalizados (0..1) no retângulo do nó, assim o redimensionamento escala o desenho
  points?: number[];
  color: string;
  width: number;
  text?: string;
}

export const FONT_BY_WIDTH: Record<number, number> = { 2: 14, 4: 20, 8: 30 };

type Pt = { x: number; y: number };
const round = (n: number) => Math.round(n * 1000) / 1000;
export const newDrawingId = () => `draw-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// Pontos em coords do fluxo → nó: posição = bbox (mínimo 8px, centrado), pontos normalizados 0..1; null se for só um clique
export function buildDrawing(shape: DrawingShape, flowPts: Pt[], color: string, width: number) {
  const xs = flowPts.map((p) => p.x);
  const ys = flowPts.map((p) => p.y);
  const [minx, maxx, miny, maxy] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const bw = maxx - minx;
  const bh = maxy - miny;
  if (shape !== "pen" && bw < 4 && bh < 4) return null;
  const W = Math.max(bw, 8);
  const H = Math.max(bh, 8);
  const x0 = minx - (W - bw) / 2;
  const y0 = miny - (H - bh) / 2;
  const norm = flowPts.flatMap((p) => [round((p.x - x0) / W), round((p.y - y0) / H)]);
  const data: DrawingData = { shape, color, width };
  if (shape === "pen") data.points = norm;
  if (shape === "arrow") data.points = [norm[0], norm[1], norm[norm.length - 2], norm[norm.length - 1]];
  return { id: newDrawingId(), type: "drawing" as const, position: { x: x0, y: y0 }, style: { width: W, height: H, pointerEvents: "none" as const }, data };
}
