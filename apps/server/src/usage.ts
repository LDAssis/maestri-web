// Indicador de uso (planos Claude): o Claude Code entrega à statusline, via stdin, rate_limits.five_hour/seven_day
// ({used_percentage, resets_at}) e model. Cada terminal claude roda `maestri usage-report` como statusline (sessions.ts monta
// o --settings); ele faz POST /usage/report. Aqui guardamos o uso POR CONTA (cli + nome da conta; "Default" sem --account),
// em memória e em <dataDir>/usage.json, e avisamos os navegadores ({type:"usage"}).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { CanvasStore } from "./canvas.js";
import { ApiError } from "./agents.js";

type Obj = Record<string, any>;

export interface UsageWindow {
  used_percentage: number;
  resets_at: number; // epoch em segundos
}
export interface UsageAccount {
  cli: string;
  account: string;
  model?: string;
  five_hour: UsageWindow | null;
  seven_day: UsageWindow | null;
  updatedAt: string;
}
interface NodeUse {
  account: string;
  model?: string;
  updatedAt: string;
}
export interface UsageReport {
  model?: string;
  five_hour?: UsageWindow;
  seven_day?: UsageWindow;
}

const DEFAULT_ACCOUNT = "Default";
const accountKey = (cli: string, account: string) => `${cli}\u0000${account}`;
const nodeKey = (projectId: string, nodeId: string) => `${projectId}\u0000${nodeId}`;

// Persistência simples (debounce): o arquivo é pequeno (uma entrada por conta e por nó)
export class UsageStore {
  private accounts = new Map<string, UsageAccount>();
  private nodes = new Map<string, NodeUse & { project: string; node: string; key: string }>();
  private timer?: NodeJS.Timeout;

  constructor(
    private file: string | null,
    private writeJson: (file: string, data: unknown) => void = (f, d) => fs.writeFileSync(f, JSON.stringify(d), { mode: 0o600 }),
    private debounceMs = 500,
  ) {
    if (file && fs.existsSync(file)) {
      try {
        const saved = JSON.parse(fs.readFileSync(file, "utf8"));
        for (const a of Array.isArray(saved.accounts) ? saved.accounts : []) {
          if (typeof a?.cli === "string" && typeof a?.account === "string") this.accounts.set(accountKey(a.cli, a.account), a);
        }
        for (const n of Array.isArray(saved.nodes) ? saved.nodes : []) {
          if (typeof n?.project === "string" && typeof n?.node === "string" && typeof n?.key === "string") this.nodes.set(nodeKey(n.project, n.node), n);
        }
      } catch {} // arquivo corrompido: começa vazio
    }
  }

  // Aplica um relatório; devolve as contas afetadas e se algo mudou (o updatedAt sozinho não conta)
  report(projectId: string, nodeId: string, cli: string, account: string, r: UsageReport, now = new Date()) {
    const key = accountKey(cli, account);
    const prev = this.accounts.get(key);
    const next: UsageAccount = {
      cli, account,
      ...((r.model ?? prev?.model) && { model: r.model ?? prev?.model }),
      five_hour: r.five_hour ?? prev?.five_hour ?? null,
      seven_day: r.seven_day ?? prev?.seven_day ?? null,
      updatedAt: now.toISOString(),
    };
    const nk = nodeKey(projectId, nodeId);
    const prevNode = this.nodes.get(nk);
    const nextNode = { project: projectId, node: nodeId, key, account, ...((r.model ?? prevNode?.model) && { model: r.model ?? prevNode?.model }), updatedAt: next.updatedAt };
    const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    const changed =
      !prev || prev.model !== next.model || !same(prev.five_hour, next.five_hour) || !same(prev.seven_day, next.seven_day) ||
      !prevNode || prevNode.key !== key || prevNode.model !== nextNode.model;
    this.accounts.set(key, next);
    this.nodes.set(nk, nextNode);
    this.schedule();
    return { changed, key };
  }

  // Projetos que têm nós nessa conta (para avisar todos os navegadores afetados)
  projectsOf(key: string) {
    return [...new Set([...this.nodes.values()].filter((n) => n.key === key).map((n) => n.project))];
  }

  // Só o que é deste projeto: seus nós (que ainda existem) e as contas desses nós
  view(projectId: string, exists: (nodeId: string) => boolean) {
    const nodes: Record<string, NodeUse> = {};
    const keys = new Set<string>();
    for (const n of this.nodes.values()) {
      if (n.project !== projectId || !exists(n.node)) continue;
      nodes[n.node] = { account: n.account, ...(n.model && { model: n.model }), updatedAt: n.updatedAt };
      keys.add(n.key);
    }
    return { accounts: [...keys].map((k) => this.accounts.get(k)).filter((a): a is UsageAccount => !!a), nodes };
  }

  private schedule() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
    this.timer.unref();
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.file) return;
    try {
      this.writeJson(this.file, { accounts: [...this.accounts.values()], nodes: [...this.nodes.values()] });
    } catch (e: any) {
      console.warn(`Uso: não foi possível gravar ${this.file}: ${e?.message || e}`);
    }
  }
}

// ---- validação da entrada ----
const num = (v: unknown, lo: number, hi: number, what: string) => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) throw new ApiError(400, `${what} inválido.`);
  return v;
};
const windowOf = (v: unknown, what: string): UsageWindow | undefined => {
  if (v == null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) throw new ApiError(400, `${what} inválido.`);
  const w = v as Obj;
  return {
    used_percentage: num(w.used_percentage, 0, 100, `${what}.used_percentage`),
    resets_at: num(w.resets_at, 1e9, 4e9, `${what}.resets_at`), // epoch em segundos (2001 a 2096)
  };
};

export function parseReport(body: Obj | undefined): { nodeId: string; report: UsageReport } {
  const b = body ?? {};
  if (typeof b.nodeId !== "string" || !/^[\w-]+$/.test(b.nodeId)) throw new ApiError(400, "nodeId inválido.");
  if (b.model != null && (typeof b.model !== "string" || !b.model.trim() || b.model.length > 100 || /[\x00-\x1f]/.test(b.model))) throw new ApiError(400, "model inválido.");
  const rl = b.rate_limits;
  if (rl != null && (typeof rl !== "object" || Array.isArray(rl))) throw new ApiError(400, "rate_limits inválido.");
  const five = windowOf(rl?.five_hour, "five_hour");
  const seven = windowOf(rl?.seven_day, "seven_day");
  return { nodeId: b.nodeId, report: { ...(b.model && { model: b.model.trim() }), ...(five && { five_hour: five }), ...(seven && { seven_day: seven }) } };
}

// ---- configuração do claude do terminal ----
// statusLine do usuário (CLAUDE_CONFIG_DIR ou ~/.claude/settings.json): vira MAESTRI_USER_STATUSLINE e o usage-report encadeia
export function userStatusLine(env: NodeJS.ProcessEnv): string | undefined {
  const dir = env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), ".claude");
  try {
    const sl = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"))?.statusLine;
    return sl && (sl.type === undefined || sl.type === "command") && typeof sl.command === "string" && sl.command.trim() ? sl.command : undefined;
  } catch {
    return undefined;
  }
}

// Desligue com MAESTRI_USAGE_REPORT=0 (nos testes fica desligado, salvo MAESTRI_USAGE_REPORT=1)
export function usageEnabled(env: NodeJS.ProcessEnv) {
  if (env.MAESTRI_USAGE_REPORT === "0") return false;
  if (env.NODE_ENV === "test") return env.MAESTRI_USAGE_REPORT === "1";
  return true;
}

interface Deps {
  fastify: FastifyInstance;
  canvas: CanvasStore;
  projectRepo: (projectId: string) => string | null;
  store: UsageStore;
}

export function registerUsageApi({ fastify, canvas, projectRepo, store }: Deps) {
  const base = "/api/projects/:p/usage";
  const project = (p: string) => {
    if (!/^[\w-]+$/.test(p)) throw new ApiError(400, "Id de projeto inválido.");
    if (!projectRepo(p)) throw new ApiError(404, "Projeto não encontrado.");
    return p;
  };
  const guard = (fn: (req: any) => any) => async (req: any, reply: any) => {
    try {
      return await fn(req);
    } catch (e: any) {
      if (e instanceof ApiError) return reply.status(e.status).send({ error: e.message });
      throw e;
    }
  };

  fastify.get(base, guard((req) => {
    const p = project(req.params.p);
    const ids = new Set((canvas.state(p).nodes ?? []).filter((n) => n.type === "agentTerminal").map((n) => n.id));
    return store.view(p, (id) => ids.has(id));
  }));

  fastify.post(`${base}/report`, guard((req) => {
    const p = project(req.params.p);
    const { nodeId, report } = parseReport(req.body);
    const node = (canvas.state(p).nodes ?? []).find((n) => n.id === nodeId && n.type === "agentTerminal");
    if (!node) throw new ApiError(404, "Nó de agente não encontrado.");
    const account = typeof node.data?.account === "string" && node.data.account.trim() ? node.data.account : DEFAULT_ACCOUNT;
    const { changed, key } = store.report(p, nodeId, "claude", account, report);
    if (changed) for (const pid of store.projectsOf(key)) canvas.notify(pid, { type: "usage" });
    return { ok: true, changed };
  }));
}
