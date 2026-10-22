import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { CanvasStore } from "./canvas.js";
import type { Session, SessionManager } from "./sessions.js";
import { resolveInside } from "./projectDirs.js";

type Obj = Record<string, any>;

export type Schedule = { type: "interval"; minutes: number } | { type: "daily"; time: string };

export interface Routine {
  id: string;
  nodeId: string;
  name: string;
  kind: "command" | "prompt";
  text: string;
  schedule: Schedule;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  nextRunAt: number;
  history: { at: string; ok: boolean; error?: string; output?: string }[];
}

export type TypeAndWait = (
  sessions: SessionManager,
  session: Session,
  input: string,
  timeoutS: number,
  aborted?: () => boolean,
) => Promise<{ output: string; timedOut: boolean }>;

interface Deps {
  fastify: FastifyInstance;
  sessions: SessionManager;
  canvas: CanvasStore;
  projectRepo: (projectId: string) => string | null;
  dataDir: string;
  // de nodeApi.ts (hoje não exportado)
  typeAndWait: TypeAndWait;
  // true se o chat do nó (F6) está capturando saída
  isChatBusy: (projectId: string, nodeId: string) => boolean;
  now?: () => number;
}

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const HISTORY_MAX = 20;
const OUTPUT_MAX = 4000;
const BUSY_DEFER_MS = 60_000;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// Próxima execução estritamente depois de `from`. daily usa a hora local do servidor.
export function nextRun(s: Schedule, from: number): number {
  if (s.type === "interval") return from + s.minutes * 60_000;
  const [h, m] = s.time.split(":").map(Number);
  const d = new Date(from);
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= from) {
    d.setDate(d.getDate() + 1);
    d.setHours(h, m, 0, 0);
  }
  return d.getTime();
}

function parseSchedule(v: any): Schedule {
  if (v?.type === "interval" && Number.isInteger(v.minutes) && v.minutes >= 1 && v.minutes <= 10080) return { type: "interval", minutes: v.minutes };
  if (v?.type === "daily" && typeof v.time === "string" && TIME_RE.test(v.time)) return { type: "daily", time: v.time };
  throw new ApiError(400, "Agendamento inválido: { type: 'interval', minutes: 1..10080 } ou { type: 'daily', time: 'HH:MM' }.");
}

const parseName = (v: unknown) => {
  if (typeof v !== "string" || !v.trim() || v.trim().length > 60) throw new ApiError(400, "Nome da rotina: 1 a 60 caracteres.");
  return v.trim();
};
const parseText = (v: unknown) => {
  if (typeof v !== "string" || !v.trim() || v.length > 20_000) throw new ApiError(400, "Texto da rotina: 1 a 20000 caracteres.");
  return v;
};
const parseKind = (v: unknown): Routine["kind"] => {
  if (v !== "command" && v !== "prompt") throw new ApiError(400, "kind deve ser 'command' ou 'prompt'.");
  return v;
};

function writeJsonAtomic(file: string, data: unknown) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

const lc = (v: unknown) => String(v ?? "").trim().toLowerCase();

export function registerRoutinesApi({ fastify, sessions, canvas, projectRepo, dataDir, typeAndWait, isChatBusy, now = Date.now }: Deps) {
  const store = new Map<string, Routine[]>();
  const running = new Set<string>();
  let stopped = false;

  const fileFor = (projectId: string) => path.join(dataDir, `routines_${projectId}.json`);
  const persist = (projectId: string) => {
    try {
      writeJsonAtomic(fileFor(projectId), { routines: store.get(projectId) ?? [] });
    } catch (e: any) {
      console.error("Erro ao persistir rotinas:", e.message);
    }
  };
  const routinesOf = (projectId: string) => {
    let list = store.get(projectId);
    if (!list) store.set(projectId, (list = []));
    return list;
  };
  const notifyChange = (projectId: string) => canvas.notify(projectId, { type: "routines" });

  // Carrega ao subir
  try {
    for (const f of fs.readdirSync(dataDir)) {
      const m = /^routines_([\w-]+)\.json$/.exec(f);
      if (!m) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dataDir, f), "utf8"));
        if (Array.isArray(data.routines)) store.set(m[1], data.routines);
      } catch {}
    }
  } catch {}

  async function settle(session: Session) {
    // Sessão recém-criada: espera o shell terminar de iniciar (1s sem saída, no máximo 5s)
    let last = Date.now();
    const listener = () => (last = Date.now());
    session.listeners.add(listener);
    const started = Date.now();
    try {
      while (Date.now() - last < 1000 && Date.now() - started < 5000 && !session.dead) await new Promise((r) => setTimeout(r, 100));
    } finally {
      session.listeners.delete(listener);
    }
  }

  // Roda a rotina agora. Devolve false se já estava rodando.
  async function execute(projectId: string, r: Routine): Promise<boolean> {
    const key = `${projectId}:${r.id}`;
    if (running.has(key)) return false;
    running.add(key);
    const entry: Routine["history"][number] = { at: new Date(now()).toISOString(), ok: true };
    try {
      const node = canvas.state(projectId).nodes?.find((n) => n.id === r.nodeId);
      if (!node) {
        Object.assign(entry, { ok: false, error: "nó removido" });
        r.enabled = false;
      } else {
        try {
          const existing = sessions.get(projectId, node.id);
          const session = sessions.ensure(projectId, node.id, { cwd: resolveInside(projectRepo(projectId)!, node.data?.worktreePath), cmd: node.data?.defaultCmd || "" });
          if (!existing) await settle(session);
          const input = r.text.includes("\n") ? `\x1b[200~${r.text}\x1b[201~\r` : `${r.text}\r`;
          const res = await typeAndWait(sessions, session, input, 600, () => stopped);
          entry.output = res.output.slice(-OUTPUT_MAX);
          if (res.timedOut) Object.assign(entry, { ok: false, error: "tempo esgotado (600s) esperando o terminal ficar quieto" });
        } catch (e: any) {
          Object.assign(entry, { ok: false, error: String(e?.message || e) });
        }
      }
    } finally {
      running.delete(key);
    }
    r.lastRunAt = entry.at;
    r.nextRunAt = nextRun(r.schedule, now());
    r.history = [...r.history, entry].slice(-HISTORY_MAX);
    persist(projectId);
    notifyChange(projectId);
    return true;
  }

  function tick() {
    if (stopped) return;
    const t = now();
    for (const [projectId, list] of store) {
      for (const r of list) {
        if (!r.enabled || r.nextRunAt > t || running.has(`${projectId}:${r.id}`)) continue;
        if (isChatBusy(projectId, r.nodeId)) {
          r.nextRunAt = t + BUSY_DEFER_MS;
          persist(projectId);
          notifyChange(projectId);
          continue;
        }
        void execute(projectId, r);
      }
    }
  }
  const timer = setInterval(tick, Number(process.env.MAESTRI_ROUTINE_TICK_MS) || 15_000);
  timer.unref();
  fastify.addHook("onClose", async () => {
    stopped = true;
    clearInterval(timer);
  });

  const projectOr404 = (projectId: unknown) => {
    if (typeof projectId !== "string" || !/^[\w-]+$/.test(projectId)) throw new ApiError(400, "Ids inválidos.");
    if (!projectRepo(projectId)) throw new ApiError(404, "Projeto não encontrado.");
    return projectId;
  };
  const agentNode = (projectId: string, nodeId: unknown) => {
    const n = typeof nodeId === "string" ? canvas.state(projectId).nodes?.find((x) => x.id === nodeId) : undefined;
    if (!n || n.type !== "agentTerminal") throw new ApiError(404, "Nó de agente não encontrado.");
    return n;
  };
  const wrap = (fn: (projectId: string, req: any, reply: FastifyReply) => any) =>
    async (req: any, reply: FastifyReply) => {
      try {
        return await fn(projectOr404(req.params.p), req, reply);
      } catch (e: any) {
        if (e instanceof ApiError) return reply.status(e.status).send({ error: e.message });
        req.log.error(e);
        return reply.status(500).send({ error: e?.message || "Erro interno." });
      }
    };
  const find = (projectId: string, rid: unknown) => {
    const r = routinesOf(projectId).find((x) => x.id === rid);
    if (!r) throw new ApiError(404, "Rotina não encontrada.");
    return r;
  };

  function create(projectId: string, body: Obj): Routine {
    agentNode(projectId, body.nodeId);
    const schedule = parseSchedule(body.schedule);
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") throw new ApiError(400, "enabled deve ser booleano.");
    const t = now();
    const r: Routine = {
      id: `rt-${crypto.randomUUID().slice(0, 8)}`,
      nodeId: body.nodeId,
      name: parseName(body.name),
      kind: parseKind(body.kind),
      text: parseText(body.text),
      schedule,
      enabled: body.enabled ?? true,
      createdAt: new Date(t).toISOString(),
      nextRunAt: nextRun(schedule, t),
      history: [],
    };
    routinesOf(projectId).push(r);
    persist(projectId);
    notifyChange(projectId);
    return r;
  }

  function remove(projectId: string, r: Routine) {
    store.set(projectId, routinesOf(projectId).filter((x) => x !== r));
    persist(projectId);
    notifyChange(projectId);
  }

  function startNow(projectId: string, r: Routine) {
    if (running.has(`${projectId}:${r.id}`)) throw new ApiError(409, "A rotina já está em execução.");
    if (isChatBusy(projectId, r.nodeId)) throw new ApiError(409, "Agente ocupado (chat); tente em instantes.");
    void execute(projectId, r);
  }

  const pub = (r: Routine) => r;

  fastify.get("/api/projects/:p/routines", wrap((p) => ({ routines: routinesOf(p).map(pub) })));

  fastify.post("/api/projects/:p/routines", wrap((p, req, reply) => reply.status(201).send({ routine: pub(create(p, req.body ?? {})) })));

  fastify.put("/api/projects/:p/routines/:rid", wrap((p, req) => {
    const r = find(p, req.params.rid);
    const b = req.body ?? {};
    // valida tudo antes de mudar qualquer coisa
    const patch: Partial<Routine> = {};
    if (b.name !== undefined) patch.name = parseName(b.name);
    if (b.kind !== undefined) patch.kind = parseKind(b.kind);
    if (b.text !== undefined) patch.text = parseText(b.text);
    if (b.schedule !== undefined) patch.schedule = parseSchedule(b.schedule);
    if (b.enabled !== undefined) {
      if (typeof b.enabled !== "boolean") throw new ApiError(400, "enabled deve ser booleano.");
      patch.enabled = b.enabled;
    }
    const reschedule = patch.schedule !== undefined || (patch.enabled === true && !r.enabled);
    Object.assign(r, patch);
    if (reschedule) r.nextRunAt = nextRun(r.schedule, now());
    persist(p);
    notifyChange(p);
    return { routine: pub(r) };
  }));

  fastify.delete("/api/projects/:p/routines/:rid", wrap((p, req) => {
    remove(p, find(p, req.params.rid));
    return { ok: true };
  }));

  fastify.post("/api/projects/:p/routines/:rid/run", wrap((p, req, reply) => {
    startNow(p, find(p, req.params.rid));
    return reply.status(202).send({ ok: true });
  }));

  // --- Escopo do nó (CLI `maestri routine`): sempre as rotinas do PRÓPRIO nó ---
  const nodeBase = "/api/projects/:p/nodes/:n/routines";
  const mine = (p: string, nodeId: string) => {
    agentNode(p, nodeId);
    return routinesOf(p).filter((r) => r.nodeId === nodeId);
  };
  const byName = (list: Routine[], name: unknown) => {
    const hit = list.filter((r) => lc(r.name) === lc(name));
    if (!hit.length) throw new ApiError(404, `Rotina "${name}" não encontrada neste agente.`);
    if (hit.length > 1) throw new ApiError(400, `Nome ambíguo: ${hit.length} rotinas chamadas "${name}".`);
    return hit[0];
  };

  fastify.get(nodeBase, wrap((p, req) => ({ routines: mine(p, req.params.n).map(pub) })));
  fastify.post(nodeBase, wrap((p, req, reply) => {
    mine(p, req.params.n);
    return reply.status(201).send({ routine: pub(create(p, { ...(req.body ?? {}), nodeId: req.params.n })) });
  }));
  fastify.post(`${nodeBase}/remove`, wrap((p, req) => {
    remove(p, byName(mine(p, req.params.n), req.body?.name));
    return { ok: true };
  }));
  fastify.post(`${nodeBase}/run`, wrap((p, req, reply) => {
    startNow(p, byName(mine(p, req.params.n), req.body?.name));
    return reply.status(202).send({ ok: true });
  }));

  return {
    // Chame ao apagar um projeto (apaga o arquivo de rotinas)
    removeProject(projectId: string) {
      store.delete(projectId);
      fs.rmSync(fileFor(projectId), { force: true });
    },
    // Só para testes
    tick,
  };
}
