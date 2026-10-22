// Andares (floors) do canvas de um projeto — helpers para o resto do servidor (F15: recruit --floor, bandas).
//
// Modelo: cada nó tem `data.floor` (nome do andar); ausente = "Ground" (térreo). Os andares criados ficam em
// `floors_<projectId>.json` (FloorStore). Um andar com isolamento git é uma git worktree em
// `<repo>/.worktrees/<slug>` na própria branch; um andar "plain" (git: false) compartilha o diretório do térreo.
//
// API:
//   GROUND                       nome do térreo ("Ground")
//   floorOf(node)                nome do andar de um nó (nunca vazio)
//   FloorStore#floorCwd(projectId, floorName)   diretório de trabalho do andar (térreo/plain → repo do projeto)
//   FloorStore#cwdForNode(projectId, nodeId, nodes)  cwd de um nó, ou null se está no térreo
//   FloorStore#find(projectId, name)            definição do andar (case-insensitive) ou undefined
//   newNodeData(me)              { floor } a aplicar em nós criados por `me` para nascerem no mesmo andar
import fs from "node:fs";
import path from "node:path";

type Obj = Record<string, any>;

export const GROUND = "Ground";
export const STATES = ["working", "blocked", "review", "done"] as const;
export type FloorState = (typeof STATES)[number];

export interface FloorStatus {
  text: string;
  state: FloorState;
  progress: number | null; // 0..1
  updatedAt: string;
}

export interface Floor {
  name: string;
  git: boolean;
  branch: string | null;
  path: string | null;
  createdAt: string;
  // Arquivos não rastreados copiados do térreo para a worktree: não contam como trabalho não commitado
  copied?: string[];
  status?: FloorStatus;
}

interface FloorFile {
  floors: Floor[];
  ground?: FloorStatus;
}

export const floorOf = (node: Obj | undefined | null): string => {
  const f = node?.data?.floor;
  return typeof f === "string" && f.trim() ? f : GROUND;
};

export const sameFloor = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

// Dados a mesclar em um nó novo para ele nascer no andar de `me`
export const newNodeData = (me: Obj | undefined | null): Obj => (floorOf(me) === GROUND ? {} : { floor: floorOf(me) });

export class FloorStore {
  private cache = new Map<string, FloorFile>();

  constructor(
    private dataDir: string,
    private projectRepo: (projectId: string) => string | null,
    private writeJson: (file: string, data: unknown) => void,
  ) {}

  private file(projectId: string) {
    return path.join(this.dataDir, `floors_${projectId}.json`);
  }

  read(projectId: string): FloorFile {
    let f = this.cache.get(projectId);
    if (!f) {
      f = { floors: [] };
      try {
        const saved = JSON.parse(fs.readFileSync(this.file(projectId), "utf8"));
        if (Array.isArray(saved.floors)) f.floors = saved.floors;
        if (saved.ground) f.ground = saved.ground;
      } catch {}
      this.cache.set(projectId, f);
    }
    return f;
  }

  save(projectId: string) {
    try {
      this.writeJson(this.file(projectId), this.read(projectId));
    } catch (e: any) {
      console.error("Erro ao persistir andares:", e.message);
    }
  }

  drop(projectId: string) {
    this.cache.delete(projectId);
    fs.rmSync(this.file(projectId), { force: true });
  }

  find(projectId: string, name: string) {
    return this.read(projectId).floors.find((f) => sameFloor(f.name, name));
  }

  floorCwd(projectId: string, floorName: string): string {
    const repo = this.projectRepo(projectId);
    if (!repo) throw new Error("Projeto não encontrado.");
    const f = floorName === GROUND ? undefined : this.find(projectId, floorName);
    return f?.git && f.path && fs.existsSync(f.path) ? f.path : repo;
  }

  cwdForNode(projectId: string, nodeId: string, nodes: Obj[]): string | null {
    const node = nodes.find((n) => n.id === nodeId);
    const name = floorOf(node);
    if (name === GROUND) return null;
    const f = this.find(projectId, name);
    return f?.git && f.path && fs.existsSync(f.path) ? f.path : null;
  }
}

// Dados efêmeros (sessão/andar de agente) que não vão para cópias do canvas
const EPHEMERAL_DATA = ["chat", "chatBusy", "worktree", "branch", "worktreePath"];

// Copia profunda de nós e arestas com ids novos (só arestas com as duas pontas copiadas); não cria sessões.
// `mapData` ajusta o data de cada nó já sem os campos efêmeros (ex.: trocar o andar, reescrever caminhos).
export function cloneCanvas(nodes: Obj[], edges: Obj[], mapData: (data: Obj, node: Obj) => Obj = (d) => d) {
  const ids = new Map<string, string>();
  const rand = () => Math.random().toString(36).slice(2, 10);
  const copies = nodes.map((n) => {
    const id = `${String(n.id).replace(/-[^-]*$/, "") || "n"}-${rand()}`;
    ids.set(n.id, id);
    const data: Obj = structuredClone(n.data ?? {});
    for (const k of EPHEMERAL_DATA) delete data[k];
    const { selected: _s, dragging: _d, measured: _m, ...rest } = structuredClone(n);
    return { ...rest, id, data: mapData(data, n) };
  });
  const copiedEdges = edges
    .filter((e) => ids.has(e.source) && ids.has(e.target))
    .map((e) => ({ ...structuredClone(e), id: `e-${ids.get(e.source)}-${ids.get(e.target)}`, source: ids.get(e.source)!, target: ids.get(e.target)! }));
  return { nodes: copies, edges: copiedEdges };
}
