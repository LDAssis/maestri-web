import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { CanvasStore } from "./canvas.js";
import type { Session, SessionManager } from "./sessions.js";
import { resolveInside } from "./projectDirs.js";

type Obj = Record<string, any>;

// Dias da semana na ordem de Date#getDay (0 = domingo)
export const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Day = (typeof DAYS)[number];
const WEEK_ORDER: Day[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export type Schedule =
  | { type: "interval"; seconds: number }
  | { type: "daily"; time: string }
  | { type: "weekly"; days: Day[]; time: string }
  | { type: "once"; at: string }; // "yyyy-MM-dd HH:mm", hora local do servidor

export interface RoutineRun {
  at: string;
  status: "ok" | "skipped" | "error";
  reason?: string; // motivo do pulo ou do erro
  output?: string;
}

// Rotinas são do projeto (workspace). nodeId = terminal-alvo (null no lembrete).
export interface Routine {
  id: string;
  nodeId: string | null;
  reminder: boolean;
  name: string;
  kind: "command" | "prompt";
  text: string;
  schedule: Schedule;
  enabled: boolean;
  count?: number; // para depois de N disparos
  until?: string; // "yyyy-MM-dd": último dia (inclusive) em que ainda dispara
  preRun?: string;
  skipIfBusy: boolean;
  notify: boolean;
  fired: number; // disparos contados (ok ou erro; pulados não contam)
  completed?: boolean; // count/until/once esgotados
  createdAt: string;
  lastRunAt?: string;
  nextRunAt: number | null;
  history: RoutineRun[];
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
  projectName?: (projectId: string) => string | undefined;
  // checkout do andar do nó (null = térreo/sem isolamento)
  floorCwd?: (projectId: string, nodeId: string, nodes: Obj[]) => string | null;
  dataDir: string;
  // de nodeApi.ts
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
const PRE_RUN_OUTPUT_MAX = 100_000;

// Roda o pre-run (sh -c) no cwd do alvo; sucesso só com saída 0 dentro do timeout. Roda em grupo de processos próprio e,
// no timeout (ou ao estourar a saída), mata o grupo inteiro: `exec` só matava o sh e deixava os filhos (sleep, git...) vivos.
export function runPreRun(script: string, cwd: string, env: Record<string, string>) {
  return new Promise<{ ok: boolean; stdout: string; reason?: string }>((resolve) => {
    const child = spawn("sh", ["-c", script], { cwd, env: { ...process.env, ...env }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let why = "";
    const killGroup = () => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      why = `pre-run excedeu ${preRunTimeoutMs() / 1000}s`;
      killGroup();
    }, preRunTimeoutMs());
    child.stdout.on("data", (d) => {
      stdout += d;
      if (stdout.length > PRE_RUN_OUTPUT_MAX) {
        why = "pre-run produziu saída demais";
        killGroup();
      }
    });
    child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout: "", reason: `pre-run não iniciou: ${e.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!why && code === 0) return resolve({ ok: true, stdout });
      const detail = stderr.trim().slice(-300);
      const reason = why || `pre-run saiu com código ${code ?? "?"}`;
      resolve({ ok: false, stdout, reason: detail ? `${reason}: ${detail}` : reason });
    });
  });
}

// O texto de uma rotina vira teclas no terminal: ESC e outros controles (inclusive o fim do bracketed paste,
// ESC[201~, que deixaria o resto virar comandos) viriam, por exemplo, de uma saída de pre-run com dados de terceiros.
// Só \n e \t passam; \r vira \n.
export const sanitizeTyped = (s: string) => s.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ONCE_RE = /^(\d{4})-(\d{2})-(\d{2}) ([01]\d|2[0-3]):([0-5]\d)$/;
const MIN_INTERVAL_S = 5;
const MAX_INTERVAL_S = 7 * 86_400;

// "Ocupado" = captura do chat em andamento OU saída do terminal nos últimos N ms (padrão 5s).
// Lidos a cada uso para os testes poderem ajustar.
const busyMs = () => Number(process.env.MAESTRI_ROUTINE_BUSY_MS) || 5000;
const preRunTimeoutMs = () => Number(process.env.MAESTRI_ROUTINE_PRERUN_MS) || 30_000;

// --- Agendamento ---

// "45s", "30m", "2h", "1h30m"; número puro = minutos. Devolve segundos.
export function parseDuration(v: unknown): number {
  const s = String(v ?? "").trim().toLowerCase();
  let sec: number | null = null;
  if (/^\d+$/.test(s)) sec = Number(s) * 60;
  else {
    const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(s);
    if (m && s) sec = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  }
  if (sec === null || sec < MIN_INTERVAL_S || sec > MAX_INTERVAL_S) {
    throw new ApiError(400, `Intervalo inválido "${v}" (ex.: 45s, 30m, 2h, 1h30m; de ${MIN_INTERVAL_S}s a 7 dias; número puro = minutos).`);
  }
  return sec;
}

export function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h ? `${h}h` : ""}${m ? `${m}m` : ""}${s ? `${s}s` : ""}` || "0s";
}

function parseOnce(v: unknown): number {
  const m = ONCE_RE.exec(String(v ?? "").trim());
  if (!m) throw new ApiError(400, 'once deve ser "yyyy-MM-dd HH:mm" (hora local do servidor).');
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const t = new Date(y, mo - 1, d, h, mi, 0, 0);
  if (t.getMonth() !== mo - 1 || t.getDate() !== d) throw new ApiError(400, `Data inexistente: "${v}".`);
  return t.getTime();
}

// Fim (inclusive) do dia `until`; null se a data for inválida
function untilEnd(until: string): number | null {
  const m = DATE_RE.exec(until);
  if (!m) return null;
  const [y, mo, d] = m.slice(1).map(Number);
  const t = new Date(y, mo - 1, d, 23, 59, 59, 999);
  return t.getMonth() === mo - 1 && t.getDate() === d ? t.getTime() : null;
}

// Próxima execução estritamente depois de `from` (hora local do servidor); null se não houver mais (once passado)
export function nextRun(s: Schedule, from: number): number | null {
  if (s.type === "interval") return from + s.seconds * 1000;
  if (s.type === "once") {
    const t = parseOnce(s.at);
    return t > from ? t : null;
  }
  const [h, m] = s.time.split(":").map(Number);
  const days: readonly Day[] = s.type === "weekly" ? s.days : DAYS;
  for (let i = 0; i <= 7; i++) {
    const d = new Date(from);
    d.setDate(d.getDate() + i);
    d.setHours(h, m, 0, 0);
    if (d.getTime() > from && days.includes(DAYS[d.getDay()])) return d.getTime();
  }
  return null;
}

const DAY_PT: Record<Day, string> = { mon: "seg", tue: "ter", wed: "qua", thu: "qui", fri: "sex", sat: "sáb", sun: "dom" };

export function scheduleLabel(s: Schedule): string {
  if (s.type === "interval") return `a cada ${formatDuration(s.seconds)}`;
  if (s.type === "daily") return `todo dia às ${s.time}`;
  if (s.type === "weekly") return `${s.days.map((d) => DAY_PT[d]).join(",")} às ${s.time}`;
  return `uma vez em ${s.at}`;
}

function parseDays(v: unknown): Day[] {
  const list = (Array.isArray(v) ? v : String(v ?? "").split(",")).map((d) => String(d).trim().toLowerCase()).filter(Boolean);
  if (!list.length || list.some((d) => !(DAYS as readonly string[]).includes(d))) {
    throw new ApiError(400, "Dias inválidos (use mon, tue, wed, thu, fri, sat, sun separados por vírgula).");
  }
  return WEEK_ORDER.filter((d) => list.includes(d));
}

// Aceita o formato canônico e atalhos do CLI/legado: interval { seconds | minutes | every }, weekly { days | spec "mon,wed@09:00" }
export function parseSchedule(v: any): Schedule {
  const time = (t: unknown) => {
    if (typeof t !== "string" || !TIME_RE.test(t)) throw new ApiError(400, "Horário inválido (HH:MM, 24h).");
    return t;
  };
  if (v?.type === "interval") {
    const given = v.every ?? (v.seconds !== undefined ? `${v.seconds}s` : v.minutes !== undefined ? `${v.minutes}m` : undefined);
    return { type: "interval", seconds: parseDuration(given) };
  }
  if (v?.type === "daily") return { type: "daily", time: time(v.time) };
  if (v?.type === "weekly") {
    if (typeof v.spec === "string") {
      const [days, t] = v.spec.split("@");
      return { type: "weekly", days: parseDays(days), time: time(t) };
    }
    return { type: "weekly", days: parseDays(v.days), time: time(v.time) };
  }
  if (v?.type === "once") {
    parseOnce(v.at);
    return { type: "once", at: String(v.at).trim() };
  }
  throw new ApiError(400, "Agendamento inválido: type interval | daily | weekly | once.");
}

// --- Validação dos campos ---

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
const parseBool = (v: unknown, what: string) => {
  if (typeof v !== "boolean") throw new ApiError(400, `${what} deve ser booleano.`);
  return v;
};
// null/0/"" limpam o campo (valem só na edição)
const parseCount = (v: unknown) => {
  if (v === null || v === 0 || v === "") return undefined;
  if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 100_000) throw new ApiError(400, "count deve ser um inteiro de 1 a 100000.");
  return v as number;
};
const parseUntil = (v: unknown) => {
  if (v === null || v === "") return undefined;
  if (typeof v !== "string" || untilEnd(v) === null) throw new ApiError(400, 'until deve ser "yyyy-MM-dd".');
  return v;
};
const parsePreRun = (v: unknown) => {
  if (v === null || v === "") return undefined;
  if (typeof v !== "string" || v.length > 10_000) throw new ApiError(400, "pre-run: texto de até 10000 caracteres.");
  return v;
};

function writeJsonAtomic(file: string, data: unknown) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

const lc = (v: unknown) => String(v ?? "").trim().toLowerCase();
// Id curto: os 6 primeiros hex depois de "rt-"
const shortId = (r: Routine) => r.id.slice(3, 9);

// Rotinas gravadas antes da F17: intervalo em minutos, sem alvo/opções; viram o modelo novo sem mudar o comportamento
// (notify fica desligado: antes não havia toast por disparo).
function migrate(raw: Obj): Routine | null {
  if (!raw || typeof raw.id !== "string" || !raw.schedule) return null;
  const s = raw.schedule;
  const schedule: Schedule = s.type === "interval" && s.seconds === undefined ? { type: "interval", seconds: Number(s.minutes) * 60 } : s;
  return {
    reminder: false,
    kind: "command",
    skipIfBusy: true,
    notify: false,
    fired: 0,
    ...raw,
    nodeId: raw.reminder ? null : raw.nodeId ?? null,
    schedule,
    history: (raw.history ?? []).map((h: Obj) =>
      h.status ? h : { at: h.at, status: h.ok ? "ok" : "error", ...(h.error && { reason: h.error }), ...(h.output && { output: h.output }) },
    ),
  } as Routine;
}

export function registerRoutinesApi({ fastify, sessions, canvas, projectRepo, projectName, floorCwd, dataDir, typeAndWait, isChatBusy, now = Date.now }: Deps) {
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
  const save = (projectId: string) => {
    persist(projectId);
    canvas.notify(projectId, { type: "routines" });
  };

  // Carrega ao subir
  try {
    for (const f of fs.readdirSync(dataDir)) {
      const m = /^routines_([\w-]+)\.json$/.exec(f);
      if (!m) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dataDir, f), "utf8"));
        if (Array.isArray(data.routines)) store.set(m[1], data.routines.map(migrate).filter(Boolean) as Routine[]);
      } catch {}
    }
  } catch {}

  const nodeOf = (projectId: string, nodeId: string | null) =>
    nodeId ? canvas.state(projectId).nodes?.find((n) => n.id === nodeId) : undefined;

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

  const complete = (r: Routine) => {
    r.enabled = false;
    r.completed = true;
    r.nextRunAt = null;
  };

  // Registra um disparo. O agendado avança contadores e a próxima execução; o manual só entra no histórico.
  function finish(projectId: string, r: Routine, entry: RoutineRun, manual: boolean) {
    r.history = [...r.history, entry].slice(-HISTORY_MAX);
    if (entry.status !== "skipped") r.lastRunAt = entry.at;
    if (!manual) {
      if (entry.status !== "skipped") r.fired += 1;
      const next = nextRun(r.schedule, now());
      const limit = r.until ? untilEnd(r.until) : null;
      if (r.schedule.type === "once" || (r.count && r.fired >= r.count) || next === null || (limit !== null && next > limit)) complete(r);
      else r.nextRunAt = next;
    }
    save(projectId);
  }

  function skip(projectId: string, r: Routine, reason: string, manual: boolean) {
    finish(projectId, r, { at: new Date(now()).toISOString(), status: "skipped", reason }, manual);
    return { status: "skipped" as const, reason };
  }

  // Dispara a rotina. A decisão de pular é síncrona (devolve o resultado); a execução segue em segundo plano.
  // manual: não mexe em contadores/próxima execução e NÃO sobe um terminal parado (o agendado sobe).
  function fire(projectId: string, r: Routine, manual: boolean): { status: "started" | "skipped"; reason?: string } {
    const key = `${projectId}:${r.id}`;
    if (running.has(key)) throw new ApiError(409, "A rotina já está em execução.");
    let node: Obj | undefined;
    if (!r.reminder) {
      node = nodeOf(projectId, r.nodeId);
      if (!node) {
        r.enabled = false;
        finish(projectId, r, { at: new Date(now()).toISOString(), status: "error", reason: "nó removido" }, true);
        return { status: "skipped", reason: "nó removido" };
      }
      const session = sessions.get(projectId, node.id);
      if (!session && manual) return skip(projectId, r, "terminal não está rodando", manual);
      if (r.skipIfBusy) {
        if (isChatBusy(projectId, node.id)) return skip(projectId, r, "terminal ocupado (chat em andamento)", manual);
        if (session && Date.now() - session.lastOutputAt < busyMs()) return skip(projectId, r, "terminal ocupado (saída recente)", manual);
      }
    }
    running.add(key);
    void execute(projectId, r, node, manual, key);
    return { status: "started" };
  }

  async function execute(projectId: string, r: Routine, node: Obj | undefined, manual: boolean, key: string) {
    const entry: RoutineRun = { at: new Date(now()).toISOString(), status: "ok" };
    try {
      const repo = projectRepo(projectId)!;
      const cwd = node ? (node.data?.worktreePath ? resolveInside(repo, node.data.worktreePath) : floorCwd?.(projectId, node.id, canvas.state(projectId).nodes ?? []) ?? repo) : repo;
      let text = r.text;
      if (r.preRun) {
        const res = await runPreRun(r.preRun, cwd, {
          MAESTRI_WORKSPACE_NAME: projectName?.(projectId) ?? projectId,
          MAESTRI_WORKSPACE_DIR: repo,
          MAESTRI_ROUTINE_NAME: r.name,
          MAESTRI_TERMINAL_NAME: node ? String(node.data?.title ?? node.id) : "",
        });
        if (!res.ok) {
          Object.assign(entry, { status: "skipped", reason: res.reason });
          return;
        }
        text = text.split("{{output}}").join(res.stdout.replace(/\n+$/, ""));
      }
      if (r.reminder) {
        canvas.notify(projectId, { type: "notify", from: { nodeId: "", title: r.name }, text });
        entry.output = text.slice(-OUTPUT_MAX);
        return;
      }
      const existing = sessions.get(projectId, node!.id);
      const session = sessions.ensure(projectId, node!.id, { cwd, cmd: node!.data?.defaultCmd || "" });
      if (!existing) await settle(session);
      const typed = sanitizeTyped(text);
      const input = typed.includes("\n") ? `\x1b[200~${typed}\x1b[201~\r` : `${typed}\r`;
      const res = await typeAndWait(sessions, session, input, 600, () => stopped);
      entry.output = res.output.slice(-OUTPUT_MAX);
      if (res.timedOut) Object.assign(entry, { status: "error", reason: "tempo esgotado (600s) esperando o terminal ficar quieto" });
    } catch (e: any) {
      Object.assign(entry, { status: "error", reason: String(e?.message || e) });
    } finally {
      running.delete(key);
      finish(projectId, r, entry, manual);
      // toast a cada disparo (o lembrete já é o próprio toast)
      if (r.notify && !r.reminder && entry.status !== "skipped") {
        const text = entry.status === "ok" ? `Rotina "${r.name}" executada` : `Rotina "${r.name}" falhou: ${entry.reason}`;
        canvas.notify(projectId, { type: "notify", from: { nodeId: r.nodeId, title: String(node?.data?.title ?? r.nodeId) }, text });
      }
    }
  }

  function tick() {
    if (stopped) return;
    const t = now();
    for (const [projectId, list] of store) {
      for (const r of list) {
        if (!r.enabled || r.nextRunAt === null || r.nextRunAt > t || running.has(`${projectId}:${r.id}`)) continue;
        const limit = r.until ? untilEnd(r.until) : null;
        if (limit !== null && t > limit) {
          complete(r);
          save(projectId);
          continue;
        }
        try {
          fire(projectId, r, false);
        } catch (e) {
          console.error("Erro ao disparar rotina:", e);
        }
      }
    }
  }
  const timer = setInterval(tick, Number(process.env.MAESTRI_ROUTINE_TICK_MS) || 15_000);
  timer.unref();
  fastify.addHook("onClose", async () => {
    stopped = true;
    clearInterval(timer);
  });

  // --- Helpers de API ---

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
  // Alvo por título (terminal) ou id (nodeId); qualquer agentTerminal do projeto
  const targetId = (projectId: string, body: Obj): string | undefined => {
    if (body.terminal !== undefined) {
      const hits = (canvas.state(projectId).nodes ?? []).filter((n) => n.type === "agentTerminal" && lc(n.data?.title) === lc(body.terminal));
      if (!hits.length) throw new ApiError(404, `Terminal "${body.terminal}" não encontrado no projeto.`);
      if (hits.length > 1) throw new ApiError(400, `Nome ambíguo: ${hits.length} terminais chamados "${body.terminal}".`);
      return hits[0].id;
    }
    if (body.nodeId !== undefined && body.nodeId !== null) return agentNode(projectId, body.nodeId).id;
    return undefined;
  };

  const pub = (projectId: string, r: Routine) => ({
    ...r,
    nodeTitle: r.reminder ? null : String(nodeOf(projectId, r.nodeId)?.data?.title ?? r.nodeId),
    shortId: shortId(r),
    label: scheduleLabel(r.schedule),
    status: r.completed ? "completed" : r.enabled ? "active" : "disabled",
  });

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

  // Valida o corpo (criação: tudo; edição: só o que veio) e devolve só os campos presentes, normalizados.
  // count/until/preRun com valor de "limpar" vêm como chave presente com undefined.
  function parseBody(projectId: string, b: Obj): Obj {
    const out: Obj = {};
    if (b.name !== undefined) out.name = parseName(b.name);
    if (b.kind !== undefined) out.kind = parseKind(b.kind);
    if (b.text !== undefined) out.text = parseText(b.text);
    if (b.schedule !== undefined) out.schedule = parseSchedule(b.schedule);
    if (b.enabled !== undefined) out.enabled = parseBool(b.enabled, "enabled");
    if (b.skipIfBusy !== undefined) out.skipIfBusy = parseBool(b.skipIfBusy, "skipIfBusy");
    if (b.notify !== undefined) out.notify = parseBool(b.notify, "notify");
    if (b.count !== undefined) out.count = parseCount(b.count);
    if (b.until !== undefined) out.until = parseUntil(b.until);
    if (b.preRun !== undefined) out.preRun = parsePreRun(b.preRun);
    const reminder = b.reminder !== undefined ? parseBool(b.reminder, "reminder") : undefined;
    const target = targetId(projectId, b);
    if (reminder && target) throw new ApiError(400, "Use lembrete OU terminal-alvo, não os dois.");
    if (reminder) Object.assign(out, { reminder: true, nodeId: null });
    else if (target) Object.assign(out, { reminder: false, nodeId: target });
    else if (reminder === false) out.reminder = false; // a edição exige um alvo (validado em edit)
    return out;
  }

  function create(projectId: string, body: Obj, defaultNodeId?: string): Routine {
    const f = parseBody(projectId, body);
    for (const k of ["name", "text", "schedule"]) if (f[k] === undefined) throw new ApiError(400, `Campo obrigatório: ${k}.`);
    if (f.reminder !== true) {
      const id = f.nodeId ?? defaultNodeId;
      if (!id) throw new ApiError(400, "Informe o terminal-alvo (nodeId/terminal) ou reminder: true.");
      Object.assign(f, { nodeId: agentNode(projectId, id).id, reminder: false });
    }
    const t = now();
    const next = nextRun(f.schedule, t);
    if (next === null) throw new ApiError(400, "O horário de once já passou.");
    if (f.until && untilEnd(f.until)! < t) throw new ApiError(400, "until já passou.");
    const r = {
      kind: "command",
      skipIfBusy: true,
      notify: true,
      enabled: true,
      ...f,
      id: `rt-${crypto.randomUUID().slice(0, 8)}`,
      fired: 0,
      createdAt: new Date(t).toISOString(),
      nextRunAt: next,
      history: [],
    } as unknown as Routine;
    routinesOf(projectId).push(r);
    save(projectId);
    return r;
  }

  function edit(projectId: string, r: Routine, body: Obj) {
    const f = parseBody(projectId, body);
    const t = now();
    if (f.reminder === false && !f.nodeId && r.reminder) throw new ApiError(400, "Informe o terminal-alvo para deixar de ser lembrete.");
    if (f.until && untilEnd(f.until)! < t) throw new ApiError(400, "until já passou.");
    const schedule: Schedule = f.schedule ?? r.schedule;
    // Mudar o agendamento zera os contadores; religar uma rotina concluída também recomeça
    const scheduleChanged = f.schedule !== undefined && JSON.stringify(f.schedule) !== JSON.stringify(r.schedule);
    const enabling = f.enabled === true && !r.enabled;
    const restart = scheduleChanged || (enabling && !!r.completed);
    if ((scheduleChanged || enabling) && nextRun(schedule, t) === null) throw new ApiError(400, "O horário de once já passou.");
    for (const [k, v] of Object.entries(f)) {
      if (v === undefined) delete (r as Obj)[k];
      else (r as Obj)[k] = v;
    }
    if (restart) {
      r.fired = 0;
      if (r.completed && f.enabled === undefined) r.enabled = true;
      r.completed = false;
    }
    if (scheduleChanged || enabling) r.nextRunAt = nextRun(r.schedule, t);
    save(projectId);
    return r;
  }

  function remove(projectId: string, r: Routine) {
    store.set(projectId, routinesOf(projectId).filter((x) => x !== r));
    save(projectId);
  }

  const runNow = (projectId: string, r: Routine, reply: FastifyReply) => reply.status(202).send({ ok: true, ...fire(projectId, r, true) });

  // --- Rotas do projeto (painel da web) ---

  fastify.get("/api/projects/:p/routines", wrap((p) => ({ routines: routinesOf(p).map((r) => pub(p, r)) })));
  fastify.post("/api/projects/:p/routines", wrap((p, req, reply) => reply.status(201).send({ routine: pub(p, create(p, req.body ?? {})) })));
  fastify.put("/api/projects/:p/routines/:rid", wrap((p, req) => ({ routine: pub(p, edit(p, find(p, req.params.rid), req.body ?? {})) })));
  fastify.delete("/api/projects/:p/routines/:rid", wrap((p, req) => {
    remove(p, find(p, req.params.rid));
    return { ok: true };
  }));
  fastify.post("/api/projects/:p/routines/:rid/run", wrap((p, req, reply) => runNow(p, find(p, req.params.rid), reply)));

  // --- Rotas do CLI (`maestri routine`): todas as rotinas do projeto, só para o Maestro ---

  const nodeBase = "/api/projects/:p/nodes/:n/routines";
  // Por nome (sem diferenciar maiúsculas) e/ou prefixo de id; duplicatas listam as opções
  function resolve(p: string, body: Obj): Routine {
    if (body.name === undefined && body.id === undefined) throw new ApiError(400, "Informe o nome da rotina (ou --id).");
    let hits = routinesOf(p);
    if (body.id !== undefined) {
      const prefix = lc(body.id).replace(/^rt-/, "");
      hits = hits.filter((r) => prefix && r.id.slice(3).startsWith(prefix));
    }
    if (body.name !== undefined) hits = hits.filter((r) => lc(r.name) === lc(body.name));
    if (!hits.length) throw new ApiError(404, `Rotina ${body.name !== undefined ? `"${body.name}"` : `com id "${body.id}"`} não encontrada.`);
    if (hits.length > 1) {
      const lines = hits.map((r) => `  ${shortId(r)}  "${r.name}"  ${scheduleLabel(r.schedule)}`).join("\n");
      throw new ApiError(400, `Várias rotinas correspondem; repita com --id <prefixo>:\n${lines}`);
    }
    return hits[0];
  }
  // Só o Maestro mexe em rotinas pelo CLI
  const cli = (fn: (p: string, req: any, reply: FastifyReply) => any) =>
    wrap((p, req, reply) => {
      if (agentNode(p, req.params.n).data?.isMaestro !== true) throw new ApiError(403, "Apenas o Maestro pode gerenciar rotinas.");
      return fn(p, req, reply);
    });

  fastify.get(nodeBase, cli((p) => ({ routines: routinesOf(p).map((r) => pub(p, r)) })));
  fastify.post(nodeBase, cli((p, req, reply) => reply.status(201).send({ routine: pub(p, create(p, req.body ?? {}, req.params.n)) })));
  fastify.post(`${nodeBase}/show`, cli((p, req) => ({ routine: pub(p, resolve(p, req.body ?? {})) })));
  fastify.post(`${nodeBase}/edit`, cli((p, req) => ({ routine: pub(p, edit(p, resolve(p, req.body ?? {}), req.body?.patch ?? {})) })));
  fastify.post(`${nodeBase}/enable`, cli((p, req) => ({ routine: pub(p, edit(p, resolve(p, req.body ?? {}), { enabled: true })) })));
  fastify.post(`${nodeBase}/disable`, cli((p, req) => ({ routine: pub(p, edit(p, resolve(p, req.body ?? {}), { enabled: false })) })));
  fastify.post(`${nodeBase}/run`, cli((p, req, reply) => runNow(p, resolve(p, req.body ?? {}), reply)));
  // "remove" é o alias obsoleto de delete (rm)
  for (const verb of ["delete", "remove"]) {
    fastify.post(`${nodeBase}/${verb}`, cli((p, req) => {
      remove(p, resolve(p, req.body ?? {}));
      return { ok: true };
    }));
  }

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
