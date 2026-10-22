import fs from "node:fs";
import type { WebSocket } from "ws";

type Obj = Record<string, any>;

export interface CanvasState {
  nodes: Obj[] | null;
  edges: Obj[] | null;
  rev: number;
}

const TRANSIENT = ["selected", "dragging", "measured", "resizing"];

// Desenhos do canvas (nós type "drawing"): forma conhecida e pontos numéricos em quantidade limitada
const DRAWING_SHAPES = ["pen", "rect", "ellipse", "arrow", "text"];
function drawingError(n: Obj): string | null {
  const d = n.data;
  if (!d || typeof d !== "object" || !DRAWING_SHAPES.includes(d.shape)) return "drawing: data.shape inválido (pen, rect, ellipse, arrow, text).";
  if (d.points !== undefined && (!Array.isArray(d.points) || d.points.length > 8000 || !d.points.every((v: unknown) => typeof v === "number" && Number.isFinite(v)))) return "drawing: data.points deve ser até 8000 números.";
  if (d.text !== undefined && (typeof d.text !== "string" || d.text.length > 2000)) return "drawing: data.text inválido.";
  return null;
}

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const isObjWithId = (v: unknown) => isObj(v) && typeof v.id === "string";
const isIdList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

function cleanNode(n: Obj) {
  const copy = { ...n };
  for (const f of TRANSIENT) delete copy[f];
  return copy;
}

function upsert(list: Obj[], items: Obj[]) {
  const out = [...list];
  for (const item of items) {
    const i = out.findIndex((x) => x.id === item.id);
    if (i === -1) out.push(item);
    // Mescla raso: um upsert parcial (ex.: só position) não apaga data editado por outro usuário
    else out[i] = { ...out[i], ...item };
  }
  return out;
}

// Estado do canvas em memória por projeto, com persistência debounced e fan-out por WebSocket
export class CanvasStore {
  private states = new Map<string, CanvasState>();
  private timers = new Map<string, NodeJS.Timeout>();
  private clients = new Map<string, Map<WebSocket, string>>();

  constructor(
    private fileFor: (projectId: string) => string | null,
    private writeJson: (file: string, data: unknown) => void,
    private onRemoveNodes: (projectId: string, ids: string[]) => void,
    private debounceMs = 1000,
  ) {}

  state(projectId: string): CanvasState {
    let st = this.states.get(projectId);
    if (!st) {
      st = { nodes: null, edges: null, rev: 0 };
      const file = this.fileFor(projectId);
      if (file && fs.existsSync(file)) {
        try {
          const saved = JSON.parse(fs.readFileSync(file, "utf-8"));
          if (Array.isArray(saved.nodes)) st.nodes = saved.nodes.map(cleanNode);
          if (Array.isArray(saved.edges)) st.edges = saved.edges;
        } catch {}
      }
      this.states.set(projectId, st);
    }
    return st;
  }

  // Valida e aplica a op. Devolve a op normalizada (para o broadcast) ou um erro.
  apply(projectId: string, op: any): { op: Obj; rev: number } | { error: string } {
    if (!isObj(op)) return { error: "Op inválida." };
    const st = this.state(projectId);
    const nodes = st.nodes ?? [];
    const edges = st.edges ?? [];
    let normalized: Obj;

    switch (op.kind) {
      case "upsertNodes":
        if (!Array.isArray(op.nodes) || !op.nodes.every(isObjWithId)) return { error: "upsertNodes: nodes deve ser array de objetos com id." };
        for (const n of op.nodes) {
          const bad = n.type === "drawing" ? drawingError(n) : null;
          if (bad) return { error: bad };
        }
        normalized = { kind: op.kind, nodes: op.nodes.map(cleanNode) };
        st.nodes = upsert(nodes, normalized.nodes);
        break;
      case "removeNodes": {
        if (!isIdList(op.ids)) return { error: "removeNodes: ids deve ser array de strings." };
        const ids = new Set<string>(op.ids);
        normalized = { kind: op.kind, ids: op.ids };
        st.nodes = nodes.filter((n) => !ids.has(n.id));
        st.edges = edges.filter((e) => !ids.has(e.source) && !ids.has(e.target));
        this.onRemoveNodes(projectId, op.ids);
        break;
      }
      case "patchNodeData": {
        if (typeof op.id !== "string" || !isObj(op.data)) return { error: "patchNodeData: id (string) e data (objeto) são obrigatórios." };
        const i = nodes.findIndex((n) => n.id === op.id);
        if (i === -1) return { error: "patchNodeData: nó não encontrado." };
        normalized = { kind: op.kind, id: op.id, data: op.data };
        st.nodes = nodes.map((n, j) => (j === i ? { ...n, data: { ...n.data, ...op.data } } : n));
        break;
      }
      case "upsertEdges":
        if (!Array.isArray(op.edges) || !op.edges.every(isObjWithId)) return { error: "upsertEdges: edges deve ser array de objetos com id." };
        normalized = { kind: op.kind, edges: op.edges };
        st.edges = upsert(edges, op.edges);
        break;
      case "removeEdges": {
        if (!isIdList(op.ids)) return { error: "removeEdges: ids deve ser array de strings." };
        const ids = new Set<string>(op.ids);
        normalized = { kind: op.kind, ids: op.ids };
        st.edges = edges.filter((e) => !ids.has(e.id));
        break;
      }
      case "replace":
        if (!Array.isArray(op.nodes) || !op.nodes.every(isObjWithId) || !Array.isArray(op.edges) || !op.edges.every(isObjWithId)) {
          return { error: "replace: nodes e edges devem ser arrays de objetos com id." };
        }
        normalized = { kind: op.kind, nodes: op.nodes.map(cleanNode), edges: op.edges };
        st.nodes = normalized.nodes;
        st.edges = normalized.edges;
        break;
      default:
        return { error: "Op desconhecida." };
    }

    st.rev++;
    this.schedulePersist(projectId);
    return { op: normalized, rev: st.rev };
  }

  private schedulePersist(projectId: string) {
    if (this.timers.has(projectId)) return;
    const t = setTimeout(() => this.flush(projectId), this.debounceMs);
    t.unref();
    this.timers.set(projectId, t);
  }

  flush(projectId: string) {
    const t = this.timers.get(projectId);
    if (!t) return;
    clearTimeout(t);
    this.timers.delete(projectId);
    const file = this.fileFor(projectId);
    const st = this.states.get(projectId);
    if (!file || !st) return;
    try {
      this.writeJson(file, { nodes: st.nodes, edges: st.edges });
    } catch (e: any) {
      console.error("Erro ao persistir canvas:", e.message);
    }
  }

  flushAll() {
    for (const id of [...this.timers.keys()]) this.flush(id);
  }

  private broadcast(projectId: string, msg: unknown, except?: WebSocket) {
    const data = JSON.stringify(msg);
    for (const ws of this.clients.get(projectId)?.keys() ?? []) {
      if (ws === except || ws.readyState !== 1) continue;
      try {
        ws.send(data);
      } catch {}
    }
  }

  // Mensagem avulsa (ex.: notify) para todos os clientes do projeto
  notify(projectId: string, msg: unknown) {
    this.broadcast(projectId, msg);
  }

  // Aplica uma op vinda de fora do WS (ex.: POST /canvas) e transmite a todos
  applyAndBroadcast(projectId: string, op: any, from: string) {
    const res = this.apply(projectId, op);
    if ("error" in res) return res;
    this.broadcast(projectId, { type: "op", op: res.op, from, rev: res.rev });
    return res;
  }

  attach(socket: WebSocket, projectId: string, clientId: string) {
    let group = this.clients.get(projectId);
    if (!group) this.clients.set(projectId, (group = new Map()));
    group.set(socket, clientId);

    const st = this.state(projectId);
    socket.send(JSON.stringify({ type: "snapshot", nodes: st.nodes, edges: st.edges, rev: st.rev }));

    socket.on("message", (raw: Buffer | string) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        socket.send(JSON.stringify({ type: "error", error: "JSON inválido." }));
        return;
      }
      if (msg?.type === "presence") return; // reservado para o F4
      if (msg?.type !== "op") {
        socket.send(JSON.stringify({ type: "error", error: "Tipo de mensagem desconhecido." }));
        return;
      }
      const res = this.apply(projectId, msg.op);
      if ("error" in res) {
        socket.send(JSON.stringify({ type: "error", error: res.error }));
        return;
      }
      this.broadcast(projectId, { type: "op", op: res.op, from: clientId, rev: res.rev }, socket);
    });

    socket.on("close", () => {
      group.delete(socket);
      if (group.size === 0) this.clients.delete(projectId);
    });
  }

  // Projeto apagado: descarta estado em memória, cancela a gravação e fecha os clientes
  drop(projectId: string) {
    const t = this.timers.get(projectId);
    if (t) clearTimeout(t);
    this.timers.delete(projectId);
    this.states.delete(projectId);
    for (const ws of this.clients.get(projectId)?.keys() ?? []) {
      try {
        ws.close(4404, "Projeto removido");
      } catch {}
    }
    this.clients.delete(projectId);
  }
}
