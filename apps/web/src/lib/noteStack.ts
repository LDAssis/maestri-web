// Operações de fichário no cliente (mesma semântica do `note stack`/`unstack` do servidor, src/notesApi.ts):
// a nota guarda data.stackId, as arestas dela passam para o fichário; ao tirar, ela herda as ligações do fichário.
type N = { id: string; type?: string; position: { x: number; y: number }; width?: number | null; height?: number | null; measured?: { width?: number; height?: number }; style?: Record<string, any>; data?: Record<string, any> };
type E = { id: string; source: string; target: string };

const size = (n: N): [number, number] => [
  Number(n.measured?.width ?? n.width ?? n.style?.width) || 280,
  Number(n.measured?.height ?? n.height ?? n.style?.height) || 200,
];

// Fichário (do mesmo andar, não escondido) sob o centro da nota arrastada
export function hitStack(note: N, nodes: N[], floorOf: (n: N) => string): N | null {
  const [w, h] = size(note);
  const cx = note.position.x + w / 2;
  const cy = note.position.y + h / 2;
  return (
    nodes.find((s) => {
      if (s.type !== "noteStack" || floorOf(s) !== floorOf(note)) return false;
      const [sw, sh] = size(s);
      return cx >= s.position.x && cx <= s.position.x + sw && cy >= s.position.y && cy <= s.position.y + sh;
    }) ?? null
  );
}

// Vizinhos de `id` (sem `skip`) que ainda não estão ligados a `target`
const others = (edges: E[], id: string, skip: string, target = skip) => {
  const linked = (a: string, b: string) => edges.some((e) => (e.source === a && e.target === b) || (e.source === b && e.target === a));
  return Array.from(new Set(edges.filter((e) => e.source === id || e.target === id).map((e) => (e.source === id ? e.target : e.source)))).filter((o) => o !== skip && !linked(target, o));
};

// Guardar: tira as arestas da nota e liga os vizinhos dela ao fichário
export function stackOps(noteId: string, stackId: string, edges: E[]) {
  const own = edges.filter((e) => e.source === noteId || e.target === noteId);
  const addEdges = others(edges, noteId, stackId, stackId).map((o) => ({ id: `e-${stackId}-${o}`, source: stackId, target: o }));
  return { data: { stackId }, removeEdgeIds: own.map((e) => e.id), addEdges };
}

// Tirar: a nota volta ao canvas (hidden derivado de stackId) e herda as ligações do fichário
export function unstackOps(noteId: string, stackId: string, edges: E[]) {
  return { data: { stackId: null }, addEdges: others(edges, stackId, noteId, noteId).map((o) => ({ id: `e-${noteId}-${o}`, source: noteId, target: o })) };
}

export function uniqueStackTitle(nodes: N[], base = "Fichário") {
  const taken = new Set(nodes.filter((n) => n.type === "noteStack").map((n) => String(n.data?.title ?? "").toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base} (${i})`.toLowerCase())) return `${base} (${i})`;
}
