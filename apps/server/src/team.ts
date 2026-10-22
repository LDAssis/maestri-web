// Árvore de equipe e bandas (F15): funções puras sobre nodes/edges + a varredura de bandas órfãs.
import type { CanvasStore } from "./canvas.js";

type Obj = Record<string, any>;

export const BAND_SIZE: [number, number] = [260, 160];

export const isBand = (n: Obj) => n.type === "band";
export const memberIds = (band: Obj): string[] => (Array.isArray(band.data?.members) ? band.data.members.filter((x: unknown) => typeof x === "string") : []);

// Andar do nó. Hoje só vale quando o nó traz data.floorId (o F16 passa a gravá-lo); sem andar = sem restrição.
export const floorOf = (n: Obj): string | null => (typeof n.data?.floorId === "string" && n.data.floorId ? n.data.floorId : null);
export const sameFloor = (a: Obj, b: Obj) => {
  const fa = floorOf(a);
  const fb = floorOf(b);
  return fa === null || fb === null || fa === fb;
};

export function neighbors(nodes: Obj[], edges: Obj[], id: string): Obj[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map<string, Obj>();
  for (const e of edges) {
    const other = e.source === id ? e.target : e.target === id ? e.source : null;
    const n = other && byId.get(other);
    if (n && n.id !== id) out.set(n.id, n);
  }
  return [...out.values()];
}

// Páginas guardadas em fichário não são nós "soltos"
const loose = (n: Obj) => !(n.type === "stickyNote" && n.data?.stackId);

export const bandOf = (nodes: Obj[], agentId: string): Obj | undefined => nodes.find((b) => isBand(b) && memberIds(b).includes(agentId));

// Bandas "minhas": das quais sou membro ou às quais estou ligado por uma corda
export function myBands(nodes: Obj[], edges: Obj[], meId: string): Obj[] {
  const out = new Map<string, Obj>();
  const mine = bandOf(nodes, meId);
  if (mine) out.set(mine.id, mine);
  for (const n of neighbors(nodes, edges, meId)) if (isBand(n)) out.set(n.id, n);
  return [...out.values()];
}

// Nós alcançados pelas bandas: todo membro alcança os outros e tudo que está ligado à banda
export function bandReach(nodes: Obj[], edges: Obj[], meId: string): Obj[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map<string, Obj>();
  for (const band of myBands(nodes, edges, meId)) {
    for (const id of memberIds(band)) {
      const m = byId.get(id);
      if (m && m.id !== meId) out.set(m.id, m);
    }
    for (const n of neighbors(nodes, edges, band.id)) if (n.id !== meId && !isBand(n) && loose(n)) out.set(n.id, n);
  }
  return [...out.values()];
}

// Árvore de equipe do Maestro: ele, os recrutas diretos (agentes ligados a ele) e o que está ligado a eles
export function teamTree(nodes: Obj[], edges: Obj[], me: Obj) {
  const direct = neighbors(nodes, edges, me.id).filter((n) => n.type === "agentTerminal");
  const others = new Map<string, Obj>();
  for (const owner of [me, ...direct]) {
    for (const n of neighbors(nodes, edges, owner.id)) {
      if (n.type === "agentTerminal" || !loose(n)) continue;
      others.set(n.id, n);
    }
  }
  return { direct, others: [...others.values()] };
}

// Remove bandas com menos de 2 membros vivos (e arestas penduradas); corrige a lista de membros dos demais.
// Os membros de uma banda desfeita mantêm o alcance mútuo por cordas diretas (ver materialize).
export function sweepBands(canvas: CanvasStore, projectId: string, by = "team") {
  const st = canvas.state(projectId);
  const nodes = st.nodes ?? [];
  const alive = new Set(nodes.filter((n) => n.type === "agentTerminal").map((n) => n.id));
  for (const band of nodes.filter(isBand)) {
    const members = memberIds(band).filter((id) => alive.has(id));
    if (members.length >= 2) {
      if (members.length !== memberIds(band).length) canvas.applyAndBroadcast(projectId, { kind: "patchNodeData", id: band.id, data: { members } }, by);
      continue;
    }
    dissolve(canvas, projectId, band, members, by);
  }
}

// Liga todos os pares (a × b) que ainda não têm corda
export function materialize(canvas: CanvasStore, projectId: string, a: string[], b: string[], by = "team") {
  const st = canvas.state(projectId);
  const has = new Set((st.edges ?? []).flatMap((e) => [`${e.source}|${e.target}`, `${e.target}|${e.source}`]));
  const edges: Obj[] = [];
  for (const x of a) {
    for (const y of b) {
      if (x === y || has.has(`${x}|${y}`)) continue;
      has.add(`${x}|${y}`);
      has.add(`${y}|${x}`);
      edges.push({ id: `e-${x}-${y}`, source: x, target: y });
    }
  }
  if (edges.length) canvas.applyAndBroadcast(projectId, { kind: "upsertEdges", edges }, by);
}

// Desfaz a banda: os membros ficam ligados entre si e ao que estava ligado à banda
export function dissolve(canvas: CanvasStore, projectId: string, band: Obj, members: string[], by = "team") {
  const st = canvas.state(projectId);
  const nodes = st.nodes ?? [];
  const attached = neighbors(nodes, st.edges ?? [], band.id).filter((n) => !isBand(n) && !memberIds(band).includes(n.id)).map((n) => n.id);
  materialize(canvas, projectId, members, [...members, ...attached], by);
  canvas.applyAndBroadcast(projectId, { kind: "removeNodes", ids: [band.id] }, by);
}
