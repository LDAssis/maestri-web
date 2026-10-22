// Contas de CLI (POLISH3): REST para as configurações da web e rotas do `maestri account`.
import type { FastifyInstance } from "fastify";
import type { CanvasStore } from "./canvas.js";
import { ApiError } from "./agents.js";
import { AccountStore, type AccountProgram } from "./accounts.js";
import { programOf } from "./resume.js";
import type { NodeApi } from "./nodeApi.js";
import type { SettingsAccess } from "./teamApi.js";

type Obj = Record<string, any>;

interface Deps {
  fastify: FastifyInstance;
  canvas: CanvasStore;
  nodeApi: NodeApi;
  accounts: AccountStore;
  projectIds: () => string[];
  settings: SettingsAccess;
}

export function registerAccountsApi({ fastify, canvas, nodeApi, accounts, projectIds, settings }: Deps) {
  const { base, requireMaestro, wrap } = nodeApi;

  // Terminais (de todos os projetos) que rodam nesta conta
  const usedBy = (program: AccountProgram, name: string) =>
    projectIds().flatMap((p) =>
      (canvas.state(p).nodes ?? [])
        .filter((n: Obj) => n.type === "agentTerminal" && n.data?.account === name && programOf(n.data?.baseCmd ?? n.data?.defaultCmd) === program)
        .map((n: Obj) => String(n.data?.title ?? n.id)),
    );
  const view = () => accounts.list().map((a) => ({ ...a, usedBy: usedBy(a.program, a.name) }));

  // Presets (globais e de cada projeto) que fixam esta conta: ao apagar a conta eles são DESAFIXADOS e a resposta lista quais
  // (apagar não é recusado por causa de preset: o preset volta a iniciar no login padrão do CLI).
  function unpinPresets(program: AccountProgram, name: string): string[] {
    const hit = (e: Obj) => typeof e?.account === "string" && e.account.trim().toLowerCase() === name.trim().toLowerCase() && programOf(e.cmd) === program;
    const strip = (holder: Obj | null | undefined): { holder: Obj; labels: string[] } | null => {
      if (!holder || !Array.isArray(holder.cliPresets) || !holder.cliPresets.some(hit)) return null;
      const labels: string[] = [];
      holder.cliPresets = holder.cliPresets.map((e: Obj) => {
        if (!hit(e)) return e;
        labels.push(String(e.label ?? e.id));
        const { account: _a, ...rest } = e;
        return rest;
      });
      return { holder, labels };
    };
    const out: string[] = [];
    const g = strip(JSON.parse(JSON.stringify(settings.readGlobal() ?? {})));
    if (g) {
      settings.writeGlobal(g.holder);
      out.push(...g.labels);
    }
    for (const p of projectIds()) {
      const r = strip(settings.readProject(p));
      if (r) {
        settings.writeProject(p, r.holder);
        out.push(...r.labels);
      }
    }
    return [...new Set(out)];
  }

  const guardDelete = (program: AccountProgram, name: string) => {
    const real = accounts.find(program, name);
    const users = real ? usedBy(program, real) : [];
    if (users.length) throw new ApiError(409, `A conta "${real}" está em uso por: ${users.join(", ")}. Troque a conta deles antes (recruit --replace ... --account).`);
    const deleted = accounts.delete(program, name);
    const unpinned = unpinPresets(program, deleted);
    if (unpinned.length) for (const p of projectIds()) canvas.notify(p, { type: "presets" });
    return { name: deleted, unpinned };
  };

  const guarded = (fn: (req: any) => unknown) => async (req: any, reply: any) => {
    try {
      return fn(req);
    } catch (e: any) {
      if (e instanceof ApiError) return reply.status(e.status).send({ error: e.message });
      req.log.error(e);
      return reply.status(500).send({ error: e?.message || "Erro interno." });
    }
  };

  // Web (configurações): gerenciar contas; o login de fato é feito rodando o CLI no terminal da conta
  fastify.get("/api/accounts", guarded(() => ({ accounts: view(), default: "Default" })));
  fastify.post("/api/accounts", guarded((req) => {
    const program = accounts.checkProgram(req.body?.program);
    const name = accounts.create(program, req.body?.name);
    return { ok: true, program, name };
  }));
  fastify.delete("/api/accounts/:program/:name", guarded((req) => ({ ok: true, ...guardDelete(accounts.checkProgram(req.params.program), String(req.params.name)) })));

  // CLI
  fastify.get(`${base}/accounts`, wrap(() => ({ accounts: view(), default: "Default" })));
  fastify.post(`${base}/accounts/create`, wrap((c, req) => {
    requireMaestro(c, "criar contas");
    const program = accounts.checkProgram(req.body?.program);
    return { ok: true, program, name: accounts.create(program, req.body?.name) };
  }));
  fastify.post(`${base}/accounts/delete`, wrap((c, req) => {
    requireMaestro(c, "apagar contas");
    return { ok: true, ...guardDelete(accounts.checkProgram(req.body?.program), String(req.body?.name ?? "")) };
  }));
}
