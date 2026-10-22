import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { CanvasStore } from "./canvas.js";
import { ApiError, PRESETS, PRESET_LABELS, SIZES, freePosition, validCmd } from "./agents.js";
import { arrangeColor, deliverRole } from "./agentSetup.js";
import { ICONS } from "./notesApi.js";

type Obj = Record<string, any>;

interface Deps {
  fastify: FastifyInstance;
  canvas: CanvasStore;
  projectRepo: (projectId: string) => string | null;
  createFloorFor: (projectId: string, nodeId: string) => Promise<unknown>;
  // Raiz dos roles globais (<dataDir>/global-roles): o agente criado pela UI também aceita um role global
  globalRoot?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const DEFAULT_COLOR = "#007AFF";
const DEFAULT_ICON = "person.text.rectangle";

export const rolesDir = (repo: string) => path.join(repo, ".maestri", "roles");

// Mesmo formato do app nativo: <repo>/.maestri/roles/<uuid minúsculo>/role.json com id em maiúsculas
export function readRole(repo: string, roleId: string): Obj | null {
  if (!UUID_RE.test(roleId)) return null;
  try {
    const r = JSON.parse(fs.readFileSync(path.join(rolesDir(repo), roleId.toLowerCase(), "role.json"), "utf8"));
    if (!r || typeof r !== "object" || typeof r.id !== "string" || r.id.toLowerCase() !== roleId.toLowerCase()) return null;
    if (typeof r.name !== "string" || !r.name.trim() || typeof r.prompt !== "string") return null;
    return { ...r, schemaVersion: 1, color: COLOR_RE.test(r.color) ? r.color : DEFAULT_COLOR, icon: typeof r.icon === "string" ? r.icon : DEFAULT_ICON };
  } catch {
    return null;
  }
}

export function writeRole(repo: string, role: Obj) {
  const dir = path.join(rolesDir(repo), String(role.id).toLowerCase());
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "role.json");
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(role, null, 2));
  fs.renameSync(tmp, file);
}

export function listRoles(repo: string): Obj[] {
  let dirs: fs.Dirent[] = [];
  try {
    dirs = fs.readdirSync(rolesDir(repo), { withFileTypes: true });
  } catch {}
  return dirs
    .filter((d) => d.isDirectory() && UUID_RE.test(d.name))
    .map((d) => readRole(repo, d.name))
    .filter((r): r is Obj => !!r)
    .sort((a, b) => a.name.localeCompare(b.name));
}

const checkName = (v: unknown) => {
  if (typeof v !== "string" || !v.trim() || v.trim().length > 60) throw new ApiError(400, "Nome do role: 1 a 60 caracteres.");
  return v.trim();
};
const checkPrompt = (v: unknown) => {
  if (typeof v !== "string" || v.length > 20_000) throw new ApiError(400, "Prompt do role: texto de até 20000 caracteres.");
  return v;
};
const checkColor = (v: unknown) => {
  if (typeof v !== "string" || !COLOR_RE.test(v)) throw new ApiError(400, "Cor inválida (use #RRGGBB).");
  return v;
};

export function registerRolesApi({ fastify, canvas, projectRepo, createFloorFor, globalRoot }: Deps) {
  const wrap = (fn: (ctx: { projectId: string; repo: string }, req: any, reply: FastifyReply) => any) =>
    async (req: any, reply: FastifyReply) => {
      try {
        const projectId = String(req.params.p);
        if (!/^[\w-]+$/.test(projectId)) throw new ApiError(400, "Ids inválidos.");
        const repo = projectRepo(projectId);
        if (!repo) throw new ApiError(404, "Projeto não encontrado.");
        return await fn({ projectId, repo }, req, reply);
      } catch (e: any) {
        if (e instanceof ApiError) return reply.status(e.status).send({ error: e.message });
        req.log.error(e);
        return reply.status(500).send({ error: e?.message || "Erro interno." });
      }
    };

  const roleOr404 = (repo: string, roleId: unknown) => {
    if (typeof roleId !== "string" || !UUID_RE.test(roleId)) throw new ApiError(400, "roleId inválido (UUID).");
    const role = readRole(repo, roleId);
    if (!role) throw new ApiError(404, "Role não encontrado.");
    return role;
  };
  // Para criar agentes: o role do projeto, ou (se não houver) o GLOBAL com o mesmo id
  const agentRole = (repo: string, roleId: unknown) => {
    if (typeof roleId !== "string" || !UUID_RE.test(roleId)) throw new ApiError(400, "roleId inválido (UUID).");
    const role = readRole(repo, roleId) ?? (globalRoot ? readRole(globalRoot, roleId) : null);
    if (!role) throw new ApiError(404, "Role não encontrado.");
    return role;
  };
  const changed = (projectId: string) => canvas.notify(projectId, { type: "roles" });

  fastify.get("/api/projects/:p/roles", wrap(({ repo }) => ({ roles: listRoles(repo) })));

  fastify.post("/api/projects/:p/roles", wrap(({ projectId, repo }, req, reply) => {
    const { name, prompt, color, icon } = req.body ?? {};
    if (icon !== undefined && (typeof icon !== "string" || !icon || icon.length > 64)) throw new ApiError(400, "Ícone inválido.");
    const role = {
      schemaVersion: 1,
      id: crypto.randomUUID().toUpperCase(),
      name: checkName(name),
      prompt: checkPrompt(prompt),
      color: color === undefined ? DEFAULT_COLOR : checkColor(color),
      icon: icon ?? DEFAULT_ICON,
    };
    writeRole(repo, role);
    changed(projectId);
    return reply.status(201).send({ role });
  }));

  fastify.put("/api/projects/:p/roles/:roleId", wrap(({ projectId, repo }, req) => {
    const current = roleOr404(repo, req.params.roleId);
    const { name, prompt, color } = req.body ?? {};
    const role = {
      ...current,
      ...(name !== undefined && { name: checkName(name) }),
      ...(prompt !== undefined && { prompt: checkPrompt(prompt) }),
      ...(color !== undefined && { color: checkColor(color) }),
    };
    writeRole(repo, role);
    changed(projectId);
    return { role };
  }));

  fastify.delete("/api/projects/:p/roles/:roleId", wrap(({ projectId, repo }, req) => {
    const role = roleOr404(repo, req.params.roleId);
    fs.rmSync(path.join(rolesDir(repo), String(role.id).toLowerCase()), { recursive: true, force: true });
    changed(projectId);
    return { ok: true };
  }));

  // Cria o nó de agente; a sessão nasce quando o navegador anexa (initialCmd = defaultCmd)
  fastify.post("/api/projects/:p/agents", wrap(async ({ projectId, repo }, req, reply) => {
    const { title, preset, cmd, roleId, position, worktree, floor, isMaestro, chatFirst, presetName, color, icon } = req.body ?? {};
    if (typeof title !== "string" || !title.trim() || title.trim().length > 64) throw new ApiError(400, "Título: 1 a 64 caracteres.");
    if (typeof preset !== "string" || !Object.hasOwn(PRESETS, preset)) throw new ApiError(400, `preset inválido (${Object.keys(PRESETS).join(", ")}).`);
    if (cmd !== undefined && !validCmd(cmd)) throw new ApiError(400, "Comando inválido.");
    if (position !== undefined && !(position && Number.isFinite(position.x) && Number.isFinite(position.y))) throw new ApiError(400, "position deve ser {x, y} numéricos.");
    const role = roleId === undefined || roleId === null ? null : agentRole(repo, roleId);

    const id = `agent-${crypto.randomUUID().slice(0, 8)}`;
    const baseCmd = (cmd?.trim() || PRESETS[preset]).trim();
    // Mesmo mecanismo do `maestri recruit`: o prompt vira CLAUDE.md/AGENTS.md em .maestri/roles/<id>/ e o terminal começa
    // lá; com andar (floor/worktree) o terminal começa no checkout e claude/codex recebem o prompt como argumento
    const floorName = typeof floor === "string" && floor.trim() && floor.trim().length <= 60 && floor.trim().toLowerCase() !== "ground" ? floor.trim() : null;
    const d = deliverRole(repo, id, baseCmd, role ? role.prompt : null, role ? role.id : null, worktree === true || !!floorName);
    const defaultCmd = d.defaultCmd;
    // aparência do preset: a cor antiga da UI (purple...) vira a da paleta do arrange; ícone só se for um do arrange
    const lookColor = arrangeColor(color);
    const lookIcon = typeof icon === "string" && (ICONS as readonly string[]).includes(icon) ? icon : undefined;

    const nodes: Obj[] = canvas.state(projectId).nodes ?? [];
    const ref = nodes.at(-1) ?? { type: "agentTerminal", position: { x: 0, y: 0 } };
    const node = {
      id,
      type: "agentTerminal",
      position: position ? { x: position.x, y: position.y } : freePosition(nodes, ref, SIZES.agentTerminal),
      style: { width: 460, height: 330 },
      data: { title: title.trim(), preset, ...(role && { roleId: role.id }), role: role?.name ?? PRESET_LABELS[preset], status: "idle", baseCmd, defaultCmd, ...(d.roleDir && { worktreePath: d.worktreePath, roleDir: true }), ...(lookColor && { color: lookColor }), ...(lookIcon && { icon: lookIcon }), ...(typeof presetName === "string" && presetName && { presetName }), ...(isMaestro === true && { isMaestro: true }), ...(chatFirst === true && { chatFirst: true }), ...(floorName && { floor: floorName }) },
    };
    canvas.applyAndBroadcast(projectId, { kind: "upsertNodes", nodes: [node] }, "agents");

    if (worktree === true) {
      try {
        await createFloorFor(projectId, id);
      } catch (e: any) {
        canvas.applyAndBroadcast(projectId, { kind: "removeNodes", ids: [id] }, "agents");
        throw e;
      }
    }
    return reply.status(201).send({ node: canvas.state(projectId).nodes?.find((n) => n.id === id) });
  }));
}
