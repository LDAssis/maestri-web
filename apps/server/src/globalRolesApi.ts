import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { CanvasStore } from "./canvas.js";
import { ApiError } from "./agents.js";
import { listRoles, readRole, rolesDir, writeRole } from "./roles.js";

type Obj = Record<string, any>;

interface Deps {
  fastify: FastifyInstance;
  canvas: CanvasStore;
  dataDir: string;
  projectRepo: (projectId: string) => string | null;
  projectIds: () => string[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const lc = (v: unknown) => String(v ?? "").trim().toLowerCase();

// Roles globais para a UI (RolesPanel/NewAgentSheet). Mesmo armazenamento do `role create --scope global` (teamApi.ts):
// <dataDir>/global-roles/.maestri/roles/<uuid>/role.json. Para criar um agente com um role global, a UI "materializa"
// uma cópia no projeto (mesmo id, marcada com origin:"global"), porque POST /agents só resolve roles do projeto.
export function registerGlobalRolesApi({ fastify, canvas, dataDir, projectRepo, projectIds }: Deps) {
  const root = path.join(dataDir, "global-roles");
  const changed = () => projectIds().forEach((id) => canvas.notify(id, { type: "roles" }));
  const guard = (fn: (req: any) => any) => async (req: any, reply: any) => {
    try {
      return await fn(req);
    } catch (e: any) {
      if (e instanceof ApiError) return reply.status(e.status).send({ error: e.message });
      req.log.error(e);
      return reply.status(500).send({ error: e?.message || "Erro interno." });
    }
  };
  const name = (v: unknown) => {
    if (typeof v !== "string" || !v.trim() || v.trim().length > 60) throw new ApiError(400, "Nome do role: 1 a 60 caracteres.");
    return v.trim();
  };
  const prompt = (v: unknown) => {
    if (typeof v !== "string" || v.length > 20_000) throw new ApiError(400, "Prompt do role: texto de até 20000 caracteres.");
    return v;
  };
  const color = (v: unknown) => {
    if (typeof v !== "string" || !COLOR_RE.test(v)) throw new ApiError(400, "Cor inválida (use #RRGGBB).");
    return v;
  };
  const get = (id: unknown) => {
    if (typeof id !== "string" || !UUID_RE.test(id)) throw new ApiError(400, "roleId inválido (UUID).");
    const r = readRole(root, id);
    if (!r) throw new ApiError(404, "Role global não encontrado.");
    return r;
  };
  const dupe = (n: string, exceptId?: string) => {
    if (listRoles(root).some((r) => r.id !== exceptId && lc(r.name) === lc(n))) throw new ApiError(409, `Já existe um role global chamado "${n}".`);
  };

  fastify.get("/api/global-roles", guard(() => ({ roles: listRoles(root) })));

  fastify.post("/api/global-roles", guard((req) => {
    const b = req.body ?? {};
    const n = name(b.name);
    dupe(n);
    const role = { schemaVersion: 1, id: crypto.randomUUID().toUpperCase(), name: n, prompt: prompt(b.prompt), color: b.color === undefined ? "#007AFF" : color(b.color), icon: "person.text.rectangle" };
    writeRole(root, role);
    changed();
    return { role };
  }));

  fastify.put("/api/global-roles/:roleId", guard((req) => {
    const cur = get(req.params.roleId);
    const b = req.body ?? {};
    const role: Obj = { ...cur, ...(b.name !== undefined && { name: name(b.name) }), ...(b.prompt !== undefined && { prompt: prompt(b.prompt) }), ...(b.color !== undefined && { color: color(b.color) }) };
    dupe(String(role.name), cur.id);
    writeRole(root, role);
    // Cópias materializadas nos projetos acompanham a edição
    for (const id of projectIds()) {
      const repo = projectRepo(id);
      const copy = repo ? readRole(repo, role.id) : null;
      if (repo && copy?.origin === "global") writeRole(repo, { ...role, origin: "global" });
    }
    changed();
    return { role };
  }));

  fastify.delete("/api/global-roles/:roleId", guard((req) => {
    const cur = get(req.params.roleId);
    fs.rmSync(path.join(rolesDir(root), String(cur.id).toLowerCase()), { recursive: true, force: true });
    changed();
    return { ok: true };
  }));

  // Cópia do role global dentro do projeto (idempotente, sempre com o prompt atual); devolve o roleId a usar no agente
  fastify.post("/api/projects/:p/roles/materialize-global", guard((req) => {
    const repo = /^[\w-]+$/.test(String(req.params.p)) ? projectRepo(req.params.p) : null;
    if (!repo) throw new ApiError(404, "Projeto não encontrado.");
    const g = get(req.body?.roleId);
    const existing = readRole(repo, g.id);
    if (existing && existing.origin !== "global") return { roleId: existing.id, copied: false }; // já é um role do projeto com esse id
    writeRole(repo, { ...g, origin: "global" });
    canvas.notify(req.params.p, { type: "roles" });
    return { roleId: g.id, copied: true };
  }));
}
