// Partitura: arquivo JSON portátil com um recorte do canvas (nós + arestas entre eles).
// Lógica pura (sem React/DOM) para poder ser testada com `npx tsx`.

export const PARTITURA_FORMAT = "maestri-partitura";
export const PARTITURA_VERSION = 1;
export const MAX_PARTITURA_BYTES = 2 * 1024 * 1024;

// Tipos de nó aceitos na importação; novos tipos (ex.: fileTree, diff) entram só aqui
export const PARTITURA_NODE_TYPES: string[] = ["agentTerminal", "stickyNote", "portal", "fileTree", "diff", "band", "noteStack"];

// Estado efêmero/pessoal que nunca viaja na partitura
const EPHEMERAL_DATA_KEYS = ["chat", "chatBusy", "worktree", "branch", "worktreePath"];
const EPHEMERAL_NODE_KEYS = ["selected", "dragging", "measured", "resizing"];

export interface PartituraNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
  style?: Record<string, unknown>;
  width?: number;
  height?: number;
}

export interface PartituraEdge {
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  animated?: boolean;
  style?: Record<string, unknown>;
  markerEnd?: unknown;
}

export interface Partitura {
  format: typeof PARTITURA_FORMAT;
  version: typeof PARTITURA_VERSION;
  name: string;
  exportedAt: string;
  nodes: PartituraNode[];
  edges: PartituraEdge[];
}

export type ParseResult = { ok: true; partitura: Partitura } | { ok: false; error: string };

const isObj = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function cleanNode(n: Record<string, any>, position: { x: number; y: number }): PartituraNode {
  const data: Record<string, unknown> = { ...n.data };
  for (const k of EPHEMERAL_DATA_KEYS) delete data[k];
  if (n.type === "agentTerminal") data.status = "idle";
  else delete data.status;
  // Andares são locais: o diff perde o andar e a árvore volta para a raiz principal
  if (n.type === "diff") delete data.worktree;
  if (n.type === "fileTree") data.root = "main";
  const out: Record<string, any> = { ...n, position, data };
  for (const k of EPHEMERAL_NODE_KEYS) delete out[k];
  return out as PartituraNode;
}

// Arestas só entre nós do conjunto; posições relativas ao canto superior-esquerdo
export function serializePartitura(
  name: string,
  nodes: Array<Record<string, any>>,
  edges: Array<Record<string, any>>,
  now: Date = new Date()
): Partitura {
  const ids = new Set(nodes.map((n) => n.id));
  const minX = nodes.length ? Math.min(...nodes.map((n) => n.position.x)) : 0;
  const minY = nodes.length ? Math.min(...nodes.map((n) => n.position.y)) : 0;
  return {
    format: PARTITURA_FORMAT,
    version: PARTITURA_VERSION,
    name,
    exportedAt: now.toISOString(),
    nodes: nodes.map((n) => cleanNode(n, { x: n.position.x - minX, y: n.position.y - minY })),
    edges: edges
      .filter((e) => ids.has(e.source) && ids.has(e.target))
      .map((e) => {
        const { source, target, sourceHandle, targetHandle, animated, style, markerEnd } = e;
        return { source, target, sourceHandle, targetHandle, animated, style, markerEnd };
      }),
  };
}

export function partituraFileName(name: string) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return `${slug || "canvas"}.partitura.json`;
}

export function parsePartitura(text: string): ParseResult {
  const fail = (error: string): ParseResult => ({ ok: false, error });
  if (text.length > MAX_PARTITURA_BYTES) return fail("Arquivo maior que 2 MB.");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail("O arquivo não é um JSON válido.");
  }
  if (!isObj(raw) || raw.format !== PARTITURA_FORMAT) return fail("Não é uma partitura do Maestri (format inválido).");
  if (raw.version !== PARTITURA_VERSION) return fail(`Versão de partitura não suportada: ${String(raw.version)}.`);
  if (!Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) return fail("Partitura inválida: nodes e edges devem ser listas.");

  const ids = new Set<string>();
  const nodes: PartituraNode[] = [];
  for (let i = 0; i < raw.nodes.length; i++) {
    const n = raw.nodes[i];
    if (!isObj(n) || typeof n.id !== "string" || !n.id) return fail(`Nó #${i + 1}: id ausente.`);
    if (typeof n.type !== "string") return fail(`Nó "${n.id}": type ausente.`);
    if (!PARTITURA_NODE_TYPES.includes(n.type)) return fail(`Nó "${n.id}": tipo desconhecido "${n.type}".`);
    if (!isObj(n.position) || !isNum(n.position.x) || !isNum(n.position.y)) return fail(`Nó "${n.id}": position inválida.`);
    if (!isObj(n.data)) return fail(`Nó "${n.id}": data inválido.`);
    if (ids.has(n.id)) return fail(`Id de nó duplicado: "${n.id}".`);
    ids.add(n.id);
    nodes.push(cleanNode(n, { x: n.position.x, y: n.position.y }));
  }
  const edges: PartituraEdge[] = [];
  for (let i = 0; i < raw.edges.length; i++) {
    const e = raw.edges[i];
    if (!isObj(e) || typeof e.source !== "string" || typeof e.target !== "string") return fail(`Aresta #${i + 1}: source/target ausentes.`);
    if (!ids.has(e.source) || !ids.has(e.target)) return fail(`Aresta #${i + 1}: aponta para nó inexistente.`);
    edges.push({
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle,
      targetHandle: e.targetHandle,
      animated: e.animated,
      style: e.style,
      markerEnd: e.markerEnd,
    });
  }
  return {
    ok: true,
    partitura: {
      format: PARTITURA_FORMAT,
      version: PARTITURA_VERSION,
      name: typeof raw.name === "string" ? raw.name : "",
      exportedAt: typeof raw.exportedAt === "string" ? raw.exportedAt : "",
      nodes,
      edges,
    },
  };
}

// Bandas (members) e páginas de fichário (stackId) apontam para outros nós da partitura: acompanham os ids novos
function remapRefs(data: Record<string, unknown>, idMap: Map<string, string>) {
  const out = { ...data };
  if (Array.isArray(out.members)) out.members = out.members.map((m) => idMap.get(String(m))).filter(Boolean);
  if (typeof out.stackId === "string") out.stackId = idMap.get(out.stackId) ?? out.stackId;
  return out;
}

const defaultNewId = (type: string) =>
  `${type === "agentTerminal" ? "agent" : type === "stickyNote" ? "note" : type}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// Gera ids novos (sem colidir com `existingIds`), remapeia arestas e posiciona o canto
// superior-esquerdo do conjunto em `origin`. Nós saem selecionados.
export function instantiatePartitura(
  p: Partitura,
  origin: { x: number; y: number },
  existingIds: Iterable<string> = [],
  newId: (type: string) => string = defaultNewId
) {
  const taken = new Set(existingIds);
  const idMap = new Map<string, string>();
  for (const n of p.nodes) {
    let id = newId(n.type);
    while (taken.has(id)) id = newId(n.type);
    taken.add(id);
    idMap.set(n.id, id);
  }
  const nodes = p.nodes.map((n) => ({
    ...n,
    id: idMap.get(n.id)!,
    position: { x: n.position.x + origin.x, y: n.position.y + origin.y },
    data: remapRefs(n.data, idMap),
    selected: true,
  }));
  const edges = p.edges.map((e) => {
    const source = idMap.get(e.source)!;
    const target = idMap.get(e.target)!;
    return { ...e, id: `xy-edge__${source}${e.sourceHandle ?? ""}-${target}${e.targetHandle ?? ""}`, source, target };
  });
  return { nodes, edges, idMap };
}

// Tamanho do recorte (para centralizar na viewport)
export function partituraBounds(p: Pick<Partitura, "nodes">) {
  let w = 0;
  let h = 0;
  for (const n of p.nodes) {
    w = Math.max(w, n.position.x + Number(n.style?.width ?? n.width ?? 300));
    h = Math.max(h, n.position.y + Number(n.style?.height ?? n.height ?? 200));
  }
  return { width: w, height: h };
}
