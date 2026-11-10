// Equipe via CLI (F15): connect, recruit avançado (--preset/--role/--band/--dir/--replace), presets, roles e bandas.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fsOpsAt } from "./runAs.js";
import type { FastifyInstance } from "fastify";
import type { CanvasStore } from "./canvas.js";
import type { SessionManager } from "./sessions.js";
import { ApiError, PRESETS, PRESET_LABELS, SIZES, freePosition, validCmd, withRolePrompt } from "./agents.js";
import { isText, lc, chatBusy, type NodeApi } from "./nodeApi.js";
import { listRoles, readRole, rolesDir, writeRole } from "./roles.js";
import { ICONS, KIND_TYPES, resolveColor, resolveIcon } from "./notesApi.js";
import { presetLook } from "./presetLook.js";
import { isInside, resolveInside } from "./projectDirs.js";
import { BAND_SIZE, bandOf, dissolve, isBand, materialize, memberIds, myBands, neighbors, sameFloorNodes, sweepBands, teamTree } from "./team.js";
import { FloorStore, GROUND, floorOf } from "./floors.js";
import { AccountStore, DEFAULT_ACCOUNT } from "./accounts.js";
import type { CrossLinks } from "./crossLinks.js";
import { programOf, validModel } from "./resume.js";
import { arrangeColor, deliverRole, roleCwdPatch } from "./agentSetup.js";
import { registerPartituras } from "./partituras.js";

type Obj = Record<string, any>;

// Acesso às configurações (global e por projeto) que o index.ts mantém
export interface SettingsAccess {
  readGlobal: () => Obj;
  writeGlobal: (s: Obj) => void;
  readProject: (projectId: string) => Obj | null;
  writeProject: (projectId: string, s: Obj) => void;
}

interface Deps {
  fastify: FastifyInstance;
  sessions: SessionManager;
  canvas: CanvasStore;
  projectRepo: (projectId: string) => string | null;
  dataDir: string;
  nodeApi: NodeApi;
  settings: SettingsAccess;
  floors: FloorStore;
  accounts: AccountStore;
  links: CrossLinks;
  workspaces: { nameOf: (projectId: string) => string | undefined; idOf: (name: string) => string | undefined };
}

export interface Preset {
  id: string;
  label: string;
  cmd: string;
  maestro: boolean;
  chat: boolean;
  quickStart: boolean;
  builtin: boolean;
  source: "builtin" | "global" | "project";
  color?: string;
  icon?: string;
  account?: string; // conta de CLI fixada (claude/codex)
  accounts?: string[]; // contas disponíveis para o CLI do preset (só quando há mais de uma)
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const slug = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "preset";
const MAX_TITLE = 64;

const onOff = (v: unknown, what: string) => {
  if (v === true || v === "on") return true;
  if (v === false || v === "off") return false;
  throw new ApiError(400, `${what} deve ser on ou off.`);
};

// Cores e ícones do `arrange` (mesmas listas das notas); aceita também os nomes do app nativo e já os converte em `b`
const checkLook = (b: Obj) => {
  if (b.color !== undefined) b.color = resolveColor(b.color).value ?? undefined;
  if (b.icon !== undefined) b.icon = resolveIcon(b.icon).value ?? undefined;
};


// Comando-base do agente: o defaultCmd sem o invólucro que injeta o prompt do role
export const baseCmdOf = (n: Obj): string => {
  if (typeof n.data?.baseCmd === "string") return n.data.baseCmd;
  const m = /^(.*) "\$\(cat '[^']*'\)"$/.exec(String(n.data?.defaultCmd ?? ""));
  return m ? m[1] : String(n.data?.defaultCmd ?? "");
};

// Programa do comando -> preset embutido (para o rótulo/ícone do nó); desconhecido = shell
const presetIdForCmd = (cmd: string) => {
  const prog = path.basename(cmd.trim().split(/\s+/).find((w) => !w.includes("=")) ?? "");
  return Object.hasOwn(PRESETS, prog) ? prog : "shell";
};

export function registerTeamApi({ fastify, sessions, canvas, projectRepo, dataDir, nodeApi, settings, floors, accounts, links, workspaces }: Deps) {
  const { base, context, resolveTarget, requireMaestro, wrap } = nodeApi;
  type Ctx = ReturnType<typeof context>;
  const by = (c: Ctx) => `cli:${c.me.id}`;
  const globalRoot = path.join(dataDir, "global-roles"); // global = <dataDir>/global-roles/.maestri/roles/<uuid>/role.json

  // ---------- Presets ----------
  // Embutidos + cliPresets das configurações. Onde grava: o preset existente é atualizado onde já mora
  // (projeto ou global); um novo, ou o override de um embutido, vai para as configurações GLOBAIS.
  function loadPresets(projectId: string): Preset[] {
    const map = new Map<string, Preset>();
    for (const id of Object.keys(PRESETS)) map.set(id, { id, label: PRESET_LABELS[id], cmd: PRESETS[id], maestro: false, chat: false, quickStart: true, builtin: true, source: "builtin" });
    const overlay = (list: unknown, source: "global" | "project") => {
      if (!Array.isArray(list)) return;
      for (const e of list) {
        if (!e || typeof e.id !== "string" || typeof e.label !== "string" || typeof e.cmd !== "string") continue;
        const b = map.get(e.id);
        map.set(e.id, { id: e.id, label: e.label, cmd: e.cmd, maestro: e.maestro === true, chat: e.chat === true, quickStart: e.quickStart !== false, builtin: !!b?.builtin, source, ...(typeof e.color === "string" && { color: arrangeColor(e.color) ?? e.color }), ...(typeof e.icon === "string" && { icon: e.icon }), ...(typeof e.account === "string" && e.account && { account: e.account }) });
      }
    };
    overlay(settings.readGlobal()?.cliPresets, "global");
    overlay(settings.readProject(projectId)?.cliPresets, "project");
    // contas do CLI do preset (claude/codex) quando existe alguma além de "Default"
    return [...map.values()].map((p) => {
      const prog = programOf(p.cmd);
      return prog === "claude" || prog === "codex" ? (accounts.names(prog).length > 1 ? { ...p, accounts: accounts.names(prog) } : p) : p;
    });
  }

  function findPreset(projectId: string, name: unknown): Preset {
    if (!isText(name, 200) || !name.trim()) throw new ApiError(400, "Informe o nome do preset.");
    const all = loadPresets(projectId);
    const hit = all.find((p) => lc(p.id) === lc(name)) ?? all.find((p) => lc(p.label) === lc(name));
    if (!hit) throw new ApiError(404, `Preset "${name}" não encontrado. Disponíveis: ${all.map((p) => `"${p.label}"`).join(", ")}.`);
    return hit;
  }

  const entryOf = (p: Preset) => ({ id: p.id, label: p.label, cmd: p.cmd, maestro: p.maestro, chat: p.chat, quickStart: p.quickStart, ...(p.color && { color: p.color }), ...(p.icon && { icon: p.icon }), ...(p.account && { account: p.account }) });

  function writePreset(projectId: string, p: Preset, source: "global" | "project") {
    const holder = source === "project" ? settings.readProject(projectId) ?? {} : clone(settings.readGlobal() ?? {});
    const list: Obj[] = Array.isArray(holder.cliPresets) ? holder.cliPresets : [];
    const i = list.findIndex((e) => e?.id === p.id);
    if (i === -1) list.push(entryOf(p));
    else {
      const { account: _old, ...kept } = list[i]; // a conta só fica se o preset ainda a fixa
      list[i] = { ...kept, ...entryOf(p) };
    }
    holder.cliPresets = list;
    if (source === "project") settings.writeProject(projectId, holder);
    else settings.writeGlobal(holder);
  }

  const parseCmd = (v: unknown) => {
    if (!validCmd(v)) throw new ApiError(400, "Comando inválido (uma linha, até 500 caracteres).");
    return v.trim();
  };
  const checkLabel = (projectId: string, label: unknown, selfId?: string) => {
    if (!isText(label, 60) || !label.trim()) throw new ApiError(400, "Nome do preset: 1 a 60 caracteres.");
    const name = label.trim();
    if (loadPresets(projectId).some((p) => p.id !== selfId && lc(p.label) === lc(name))) throw new ApiError(409, `Já existe um preset chamado "${name}".`);
    return name;
  };
  // --account de preset: precisa existir para o CLI do comando ("Default" vale sempre; vazio desafixa)
  const presetAccount = (cmd: string, v: unknown): string | undefined => {
    if (v === undefined || v === null || v === "") return undefined;
    if (typeof v !== "string") throw new ApiError(400, "Conta inválida.");
    accounts.resolveFor(cmd, v);
    return accounts.find(programOf(cmd) as "claude" | "codex", v) ?? undefined;
  };

  fastify.get("/api/projects/:p/presets", async (req: any, reply) => {
    const p = String(req.params.p);
    if (!/^[\w-]+$/.test(p) || !projectRepo(p)) return reply.status(404).send({ error: "Projeto não encontrado." });
    return { presets: loadPresets(p) };
  });
  fastify.get(`${base}/presets`, wrap((c) => ({ presets: loadPresets(c.projectId) })));
  fastify.post(`${base}/presets/show`, wrap((c, req) => ({ preset: findPreset(c.projectId, req.body?.name) })));
  fastify.post(`${base}/presets/create`, wrap((c, req) => {
    requireMaestro(c, "criar presets");
    const b = req.body ?? {};
    const label = checkLabel(c.projectId, b.name);
    const taken = new Set(loadPresets(c.projectId).map((p) => p.id));
    let id = slug(label);
    for (let n = 2; taken.has(id); n++) id = `${slug(label)}-${n}`;
    checkLook(b);
    const cmd0 = b.command === undefined ? "" : parseCmd(b.command);
    const look = presetLook(cmd0); // sem --color/--icon: cor sorteada e o ícone do CLI
    const preset: Preset = {
      id, label, cmd: cmd0, color: b.color ?? look.color, icon: b.icon ?? look.icon,
      maestro: b.maestro === undefined ? false : onOff(b.maestro, "maestro"),
      chat: b.chat === undefined ? false : onOff(b.chat, "chat"),
      quickStart: b.quickStart === undefined ? true : onOff(b.quickStart, "quick-start"),
      builtin: false, source: "global",
    };
    const pinned = presetAccount(preset.cmd, b.account);
    if (pinned) preset.account = pinned;
    writePreset(c.projectId, preset, "global");
    canvas.notify(c.projectId, { type: "presets" });
    return { preset };
  }));
  fastify.post(`${base}/presets/set`, wrap((c, req) => {
    requireMaestro(c, "alterar presets");
    const b = req.body ?? {};
    const cur = findPreset(c.projectId, b.name);
    checkLook(b);
    const next: Preset = {
      ...cur,
      ...(b.color !== undefined && { color: b.color }),
      ...(b.icon !== undefined && { icon: b.icon }),
      ...(b.newName !== undefined && { label: checkLabel(c.projectId, b.newName, cur.id) }),
      ...(b.command !== undefined && { cmd: parseCmd(b.command) }),
      ...(b.maestro !== undefined && { maestro: onOff(b.maestro, "maestro") }),
      ...(b.chat !== undefined && { chat: onOff(b.chat, "chat") }),
      ...(b.quickStart !== undefined && { quickStart: onOff(b.quickStart, "quick-start") }),
    };
    // conta: o novo valor (vazio desafixa) ou a atual, revalidada contra o comando que ficou
    if (b.account !== undefined || (b.command !== undefined && next.account)) {
      const pinned = presetAccount(next.cmd, b.account !== undefined ? b.account : next.account);
      if (pinned) next.account = pinned;
      else delete next.account;
    }
    const source = cur.source === "project" ? "project" : "global";
    writePreset(c.projectId, next, source);
    canvas.notify(c.projectId, { type: "presets" });
    return { preset: { ...next, source } };
  }));
  fastify.post(`${base}/presets/delete`, wrap((c, req) => {
    requireMaestro(c, "apagar presets");
    const cur = findPreset(c.projectId, req.body?.name);
    if (cur.source === "builtin") throw new ApiError(400, `"${cur.label}" é um preset embutido e não pode ser apagado.`);
    for (const source of ["project", "global"] as const) {
      const holder = source === "project" ? settings.readProject(c.projectId) : clone(settings.readGlobal() ?? {});
      if (!holder || !Array.isArray(holder.cliPresets)) continue;
      const rest = holder.cliPresets.filter((e: Obj) => e?.id !== cur.id);
      if (rest.length === holder.cliPresets.length) continue;
      holder.cliPresets = rest;
      if (source === "project") settings.writeProject(c.projectId, holder);
      else settings.writeGlobal(holder);
    }
    canvas.notify(c.projectId, { type: "presets" });
    return { ok: true, builtinRestored: cur.builtin };
  }));

  // ---------- Roles ----------
  type Scope = "current" | "global";
  const rootOf = (repo: string, scope: Scope) => (scope === "global" ? globalRoot : repo);
  const checkScope = (v: unknown): Scope | undefined => {
    if (v === undefined) return undefined;
    if (v !== "current" && v !== "global") throw new ApiError(400, "--scope aceita current ou global.");
    return v;
  };
  const allRoles = (repo: string) => [
    ...listRoles(repo).map((role) => ({ role, scope: "current" as Scope })),
    ...listRoles(globalRoot).map((role) => ({ role, scope: "global" as Scope })),
  ];
  // current vence global quando o nome se repete
  function findRole(repo: string, name: unknown) {
    if (!isText(name, 200) || !name.trim()) throw new ApiError(400, "Informe o nome do role.");
    const hits = allRoles(repo).filter((r) => lc(r.role.name) === lc(name));
    const cur = hits.filter((h) => h.scope === "current");
    const pick = cur.length ? cur : hits;
    if (!pick.length) throw new ApiError(404, `Role "${name}" não encontrado (veja "maestri role list").`);
    if (pick.length > 1) throw new ApiError(400, `Nome ambíguo: ${pick.length} roles chamados "${name}".`);
    return pick[0];
  }
  const readAnyRole = (repo: string, id: string) => readRole(repo, id) ?? readRole(globalRoot, id);
  const checkPrompt = (v: unknown) => {
    if (typeof v !== "string" || !v.trim() || v.length > 20_000) throw new ApiError(400, "Prompt do role: 1 a 20000 caracteres.");
    return v;
  };

  // Reescreve o prompt de quem usa o role e reinicia o processo (o chat se perde, a topologia não)
  function reapplyRole(c: Ctx, repo: string, role: Obj) {
    for (const n of c.nodes.filter((x) => x.type === "agentTerminal" && String(x.data?.roleId ?? "").toLowerCase() === String(role.id).toLowerCase())) {
      applyCmd(c, repo, n, baseCmdOf(n), role.prompt, { role: role.name, roleId: role.id });
    }
  }

  fastify.get(`${base}/roles`, wrap((c) => {
    const repo = projectRepo(c.projectId)!;
    return { roles: allRoles(repo).map(({ role, scope }) => ({ id: role.id, name: role.name, prompt: role.prompt, scope })) };
  }));
  fastify.post(`${base}/roles/show`, wrap((c, req) => {
    const { role, scope } = findRole(projectRepo(c.projectId)!, req.body?.name);
    return { role: { id: role.id, name: role.name, prompt: role.prompt, scope } };
  }));
  fastify.post(`${base}/roles/create`, wrap((c, req) => {
    requireMaestro(c, "criar roles");
    const repo = projectRepo(c.projectId)!;
    const { name, prompt } = req.body ?? {};
    const scope = checkScope(req.body?.scope) ?? "current";
    if (!isText(name, 60) || !name.trim()) throw new ApiError(400, "Nome do role: 1 a 60 caracteres.");
    if (allRoles(repo).some((r) => r.scope === scope && lc(r.role.name) === lc(name))) throw new ApiError(409, `Já existe um role "${name.trim()}" (${scope}).`);
    const role = { schemaVersion: 1, id: crypto.randomUUID().toUpperCase(), name: name.trim(), prompt: checkPrompt(prompt), color: "#007AFF", icon: "person.text.rectangle" };
    writeRole(rootOf(repo, scope), role);
    canvas.notify(c.projectId, { type: "roles" });
    return { role: { ...role, scope } };
  }));
  fastify.post(`${base}/roles/edit`, wrap((c, req) => {
    requireMaestro(c, "editar roles");
    const repo = projectRepo(c.projectId)!;
    const b = req.body ?? {};
    const cur = findRole(repo, b.name);
    const scope = checkScope(b.scope);
    if (b.old === undefined && scope === undefined) throw new ApiError(400, 'Informe "texto antigo" "texto novo" e/ou --scope.');
    let role = { ...cur.role };
    if (b.old !== undefined) {
      if (!isText(b.old, 20_000) || !b.old || typeof b.new !== "string") throw new ApiError(400, "Informe o texto antigo (não vazio) e o novo.");
      if (!role.prompt.includes(b.old)) throw new ApiError(400, "O texto antigo não aparece no prompt do role.");
      role = { ...role, prompt: checkPrompt(role.prompt.replace(b.old, () => b.new)) };
    }
    let finalScope: Scope = cur.scope;
    if (scope !== undefined && scope !== cur.scope) {
      if (allRoles(repo).some((r) => r.scope === scope && lc(r.role.name) === lc(role.name))) throw new ApiError(409, `Já existe um role "${role.name}" em ${scope}.`);
      fsOpsAt(rootOf(repo, cur.scope), [{ op: "rm", path: path.join(rolesDir(rootOf(repo, cur.scope)), String(role.id).toLowerCase()), recursive: true }]);
      finalScope = scope;
    }
    writeRole(rootOf(repo, finalScope), role);
    canvas.notify(c.projectId, { type: "roles" });
    reapplyRole(c, repo, role);
    return { role: { ...role, scope: finalScope } };
  }));
  fastify.post(`${base}/roles/write`, wrap((c, req) => {
    requireMaestro(c, "editar roles");
    const repo = projectRepo(c.projectId)!;
    const cur = findRole(repo, req.body?.name);
    const role = { ...cur.role, prompt: checkPrompt(req.body?.prompt) };
    writeRole(rootOf(repo, cur.scope), role);
    canvas.notify(c.projectId, { type: "roles" });
    reapplyRole(c, repo, role);
    return { role: { ...role, scope: cur.scope } };
  }));
  // Recusa enquanto terminais usam o role, salvo force: aí eles perdem o role (reiniciam) antes de apagar
  fastify.post(`${base}/roles/delete`, wrap((c, req) => {
    requireMaestro(c, "apagar roles");
    const repo = projectRepo(c.projectId)!;
    const { role, scope } = findRole(repo, req.body?.name);
    const users = c.nodes.filter((x) => x.type === "agentTerminal" && String(x.data?.roleId ?? "").toLowerCase() === String(role.id).toLowerCase());
    if (users.length && req.body?.force !== true) {
      throw new ApiError(409, `O role "${role.name}" ainda é usado por: ${users.map((n) => n.data?.title).join(", ")}. Use --force para desatribuí-lo (os terminais reiniciam).`);
    }
    for (const n of users) applyCmd(c, repo, n, baseCmdOf(n), null, { role: PRESET_LABELS[n.data?.preset] ?? "Agente", roleId: null });
    fsOpsAt(rootOf(repo, scope), [{ op: "rm", path: path.join(rolesDir(rootOf(repo, scope)), String(role.id).toLowerCase()), recursive: true }]);
    canvas.notify(c.projectId, { type: "roles" });
    return { ok: true, name: role.name, unassigned: users.length };
  }));
  fastify.post(`${base}/roles/assign`, wrap((c, req) => {
    requireMaestro(c, "atribuir roles");
    const repo = projectRepo(c.projectId)!;
    const t = resolveTarget(c, req.body?.target, "agentTerminal");
    if (req.body?.none === true) {
      applyCmd(c, repo, t, baseCmdOf(t), null, { role: PRESET_LABELS[t.data?.preset] ?? "Agente", roleId: null });
      return { ok: true, role: null };
    }
    const { role } = findRole(repo, req.body?.role);
    applyCmd(c, repo, t, baseCmdOf(t), role.prompt, { role: role.name, roleId: role.id });
    return { ok: true, role: role.name };
  }));

  // ---------- Processo do agente ----------
  // cwd do nó: --dir explícito (worktreePath) ou o checkout do andar dele
  const cwdOf = (projectId: string, repo: string, n: Obj) => (n.data?.worktreePath ? resolveInside(repo, n.data.worktreePath) : floors.floorCwd(projectId, floorOf(n)));
  // --floor "Nome": nome canônico do andar (Ground ou um andar existente)
  function floorNamed(projectId: string, name: unknown): string {
    if (!isText(name, 200) || !name.trim()) throw new ApiError(400, "Informe o nome do andar.");
    if (lc(name) === lc(GROUND)) return GROUND;
    const f = floors.find(projectId, name);
    if (!f) throw new ApiError(404, `Andar "${name}" não encontrado. Existentes: ${[GROUND, ...floors.read(projectId).floors.map((x) => x.name)].join(", ")}.`);
    return f.name;
  }
  const floorData = (name: string): Obj => (name === GROUND ? {} : { floor: name });

  // ---------- Workspaces cruzados ("Nome @ Workspace") ----------
  const wsId = (name: unknown): string => {
    const id = isText(name, 200) ? workspaces.idOf(name) : undefined;
    if (!id) throw new ApiError(404, `Workspace "${name}" não encontrado.`);
    return id;
  };
  // "Nome @ Workspace" -> { name, ws }; sem " @ " ws = null
  const splitAddr = (v: unknown): { name: string; ws: string | null } => {
    const str = String(v ?? "");
    const i = str.lastIndexOf(" @ ");
    return i > 0 ? { name: str.slice(0, i).trim(), ws: str.slice(i + 3).trim() } : { name: str.trim(), ws: null };
  };
  // Contexto apontando para o canvas de outro workspace (nós/arestas dele); o mesmo projeto devolve o próprio c
  const scoped = (c: Ctx, pid: string): Ctx => (pid === c.projectId ? c : ({ ...c, projectId: pid, nodes: canvas.state(pid).nodes ?? [], edges: canvas.state(pid).edges ?? [] } as Ctx));
  const linksChanged = (...pids: string[]) => {
    for (const p of new Set(pids)) canvas.notify(p, { type: "links" });
  };


  // Grava o comando (com o prompt do role) no nó e reinicia o PTY no mesmo lugar; o chat é descartado.
  // Sem sessão ativa só atualiza o nó (a sessão nasce quando alguém abrir o terminal).
  function applyCmd(c: Ctx, repo: string, node: Obj, baseCmd: string, prompt: string | null, extra: Obj = {}) {
    const explicit = !node.data?.roleDir && (!!node.data?.worktreePath || floorOf(node) !== GROUND);
    const d = deliverRole(repo, node.id, baseCmd, prompt, typeof extra.roleId === "string" ? extra.roleId : null, explicit);
    canvas.applyAndBroadcast(c.projectId, { kind: "patchNodeData", id: node.id, data: { ...extra, baseCmd, defaultCmd: d.defaultCmd, chat: [], chatBusy: false, ...roleCwdPatch(node, d) } }, by(c));
    chatBusy.delete(`${c.projectId}:${node.id}`);
    restart(c.projectId, repo, node, d.defaultCmd);
  }
  function restart(projectId: string, repo: string, node: Obj, cmd: string, force = false) {
    const had = !!sessions.get(projectId, node.id);
    if (!had && !force) return;
    sessions.kill(projectId, node.id);
    try {
      sessions.ensure(projectId, node.id, { cwd: cwdOf(projectId, repo, canvas.state(projectId).nodes?.find((x) => x.id === node.id) ?? node), cmd, fresh: true });
    } catch (e: any) {
      throw new ApiError(500, `Nó atualizado, mas a sessão falhou: ${e.message}`);
    }
  }

  // ---------- Recruit ----------
  // Nome único entre os terminais do canvas: "Nome (2)", "Nome (3)"...
  function uniqueTitle(nodes: Obj[], wanted: string, ignoreId?: string) {
    const taken = new Set(nodes.filter((n) => n.id !== ignoreId && n.type === "agentTerminal").map((n) => lc(n.data?.title)));
    let title = wanted;
    for (let n = 2; taken.has(lc(title)); n++) title = `${wanted.slice(0, MAX_TITLE - 5)} (${n})`;
    return title;
  }

  // --dir: precisa ser um diretório existente DENTRO do projeto (projetos não vazam um no outro)
  function projectDir(repo: string, from: string, dir: unknown): string {
    if (!isText(dir, 500) || !dir.trim()) throw new ApiError(400, "--dir inválido.");
    let real = "";
    try {
      real = fs.realpathSync(path.resolve(from, dir.trim()));
      if (!fs.statSync(real).isDirectory()) throw new Error();
    } catch {
      throw new ApiError(400, `Diretório não encontrado: ${dir}`);
    }
    if (!isInside(fs.realpathSync(repo), real)) throw new ApiError(400, "O diretório precisa estar dentro do projeto.");
    return real;
  }
  const relDir = (repo: string, real: string) => path.relative(fs.realpathSync(repo), real);

  // role: id (--role-id) | nome de um role existente | texto livre (formato antigo)
  function roleInput(repo: string, b: Obj): { saved: Obj | null; text: string; note?: string } {
    if (b.roleId !== undefined) {
      const saved = typeof b.roleId === "string" ? readAnyRole(repo, b.roleId) : null;
      if (!saved) throw new ApiError(404, "Role não encontrado (use o id de um role do projeto ou global).");
      return { saved, text: "" };
    }
    if (b.role === undefined) return { saved: null, text: "" };
    if (!isText(b.role)) throw new ApiError(400, "Papel inválido.");
    const hits = allRoles(repo).filter((r) => lc(r.role.name) === lc(b.role));
    const cur = hits.filter((h) => h.scope === "current");
    const pick = cur.length ? cur : hits;
    if (pick.length > 1) throw new ApiError(400, `Nome ambíguo: ${pick.length} roles chamados "${b.role}".`);
    if (pick.length) return { saved: pick[0].role, text: "" };
    return { saved: null, text: b.role, note: `Role "${b.role}" não encontrado: usado como texto livre do papel.` };
  }

  const tryAccount = (cmd: string, name: string) => {
    try {
      return accounts.resolveFor(cmd, name);
    } catch {
      return undefined; // conta do preset que sumiu: o recruta começa no login padrão
    }
  };
  const nodeLabel = (n: Obj, fallback = "Agente") => String(n.data?.title ?? fallback);

  fastify.post(`${base}/recruit`, wrap((c, req) => {
    requireMaestro(c, "recrutar");
    const b = req.body ?? {};
    checkLook(b);
    if (b.model != null && b.model !== "" && !validModel(b.model)) throw new ApiError(400, "Modelo inválido: use só letras, números e . _ : / @ - (começando por letra ou número).");
    if (b.replace !== undefined) return replaceAgent(c, projectRepo(c.projectId)!, b);

    if (!isText(b.name, MAX_TITLE) || !b.name.trim()) throw new ApiError(400, "Informe o nome do agente.");
    const command = b.command ?? b.cmd;
    if (command !== undefined && !validCmd(command)) throw new ApiError(400, "Comando inválido.");
    // --workspace: o agente nasce no projeto W (seu cwd ou o do andar) e liga a mim pelo registro de links
    const tpid = b.workspace === undefined ? c.projectId : wsId(b.workspace);
    const cross = tpid !== c.projectId;
    const myRepo = projectRepo(c.projectId)!;
    const repo = projectRepo(tpid)!;
    const tnodes = canvas.state(tpid).nodes ?? [];
    const floor = b.floor !== undefined ? floorNamed(tpid, b.floor) : cross ? GROUND : floorOf(c.me);

    const preset = b.preset === undefined ? null : findPreset(c.projectId, b.preset);
    // sem --preset nem --command: cópia de mim (mesmo comando)
    const copy = !preset && command === undefined;
    const baseCmd = (command !== undefined ? command : preset ? preset.cmd : baseCmdOf(c.me)).trim();
    const presetField = preset ? (preset.builtin ? preset.id : presetIdForCmd(baseCmd)) : copy ? c.me.data?.preset ?? presetIdForCmd(baseCmd) : presetIdForCmd(baseCmd);

    // conta: --account vence a do preset; cópia de mim herda a minha (mesmo CLI)
    const accountName = b.account !== undefined ? accounts.resolveFor(baseCmd, b.account)
      : preset?.account ? tryAccount(baseCmd, preset.account)
      : copy && programOf(baseCmd) === programOf(baseCmdOf(c.me)) ? (c.me.data?.account as string | undefined) : undefined;

    const { saved, text, note } = roleInput(myRepo, b);
    const id = `agent-${crypto.randomUUID().slice(0, 8)}`;
    const prompt = saved ? saved.prompt : text.trim() ? text : null;

    // cwd: --dir manda; --floor/--workspace usam o checkout do andar; senão herda o meu (um role-dir meu não é herdado)
    const explicit = b.dir !== undefined || b.floor !== undefined;
    const myCwd = c.me.data?.roleDir ? floors.floorCwd(c.projectId, floorOf(c.me)) : cwdOf(c.projectId, myRepo, c.me);
    const baseCwd = b.floor !== undefined || cross ? floors.floorCwd(tpid, floor) : myCwd;
    const real = b.dir !== undefined ? projectDir(repo, baseCwd, b.dir) : null;
    const d = deliverRole(repo, id, baseCmd, prompt, saved?.id ?? null, explicit);
    const inherited = b.floor === undefined && !cross && !c.me.data?.roleDir ? c.me.data?.worktreePath : undefined;
    const worktreePath = real ? relDir(repo, real) : d.roleDir ? d.worktreePath : inherited;
    const startCwd = real ?? (d.roleDir ? path.join(fs.realpathSync(repo), d.worktreePath!) : baseCwd);

    // banda: --band escolhe (no andar/workspace onde o recruta nasce); senão, estando numa banda no mesmo andar,
    // o recruta entra nela em vez de ganhar uma corda
    let band: Obj | null = null;
    if (b.band !== undefined) {
      band = findBand(c, cross && splitAddr(b.band).ws === null ? `${b.band} @ ${workspaces.nameOf(tpid)}` : b.band);
      if ((band.__project ?? c.projectId) !== tpid) throw new ApiError(400, `A banda "${nodeLabel(band)}" está em outro workspace.`);
      if (floorOf(band) !== floor) throw new ApiError(400, `A banda "${nodeLabel(band)}" está no andar "${floorOf(band)}", não em "${floor}".`);
    } else if (!cross) {
      band = bandOf(c.nodes, c.me.id) ?? null;
      if (band && floorOf(band) !== floor) band = null;
    }

    const look = {
      color: b.color ?? arrangeColor(preset?.color),
      icon: b.icon ?? (preset?.icon && (ICONS as readonly string[]).includes(preset.icon) ? preset.icon : undefined),
    };
    const title = uniqueTitle(tnodes, b.name.trim());
    const roleLabel = saved ? saved.name : text.trim() ? (text.trim().length <= 60 ? text.trim() : "Agente") : preset?.label ?? PRESET_LABELS[presetField] ?? "Agente";
    const ref = cross ? tnodes.at(-1) ?? { type: "agentTerminal", position: { x: 0, y: 0 } } : c.me;
    const node = {
      id, type: "agentTerminal", position: freePosition(tnodes, ref, SIZES.agentTerminal), style: { width: 460, height: 330 },
      data: {
        title,
        preset: presetField,
        ...(preset && { presetName: preset.label }),
        ...(saved && { roleId: saved.id }),
        role: roleLabel,
        status: "idle",
        baseCmd,
        defaultCmd: d.defaultCmd,
        ...(worktreePath && { worktreePath }),
        ...(d.roleDir && { roleDir: true }),
        ...floorData(floor),
        ...(accountName && { account: accountName }),
        ...(b.model && { model: b.model }),
        ...(preset?.maestro && { isMaestro: true }),
        ...(preset?.chat && { chatFirst: true }),
        // aparência: --color/--icon vencem; senão a do preset (cor antiga da UI, como purple, vira a da paleta do arrange)
        ...(look.color !== undefined && { color: look.color }),
        ...(look.icon !== undefined && { icon: look.icon }),
      },
    };
    canvas.applyAndBroadcast(tpid, { kind: "upsertNodes", nodes: [node] }, by(c));
    if (cross) {
      links.add({ project: c.projectId, node: c.me.id }, { project: tpid, node: id });
      linksChanged(c.projectId, tpid);
      if (band) joinBand(scoped(c, tpid), band, id);
    } else if (band) joinBand(c, band, id);
    else canvas.applyAndBroadcast(c.projectId, { kind: "upsertEdges", edges: [{ id: `e-${c.me.id}-${id}`, source: c.me.id, target: id }] }, by(c));
    try {
      sessions.ensure(tpid, id, { cwd: startCwd, cmd: d.defaultCmd });
    } catch (e: any) {
      throw new ApiError(500, `Nó criado, mas a sessão falhou: ${e.message}`);
    }
    return { ok: true, nodeId: id, name: cross ? `${title} @ ${workspaces.nameOf(tpid)}` : title, ...(band && { band: nodeLabel(band) }), ...(note && { note }) };
  }));

  // Troca o processo no mesmo nó: arestas, posição, rotinas e id ficam; a sessão reinicia
  function replaceAgent(c: Ctx, repo: string, b: Obj) {
    const t = resolveTarget(c, b.replace, "agentTerminal");
    if (b.floor !== undefined) throw new ApiError(400, "--floor não é suportado com --replace: o nó fica onde está.");
    const command = b.command ?? b.cmd;
    if (command !== undefined && !validCmd(command)) throw new ApiError(400, "Comando inválido.");
    const rename = b.name !== undefined ? (isText(b.name, MAX_TITLE) && b.name.trim() ? b.name.trim() : (() => { throw new ApiError(400, "Nome inválido."); })()) : undefined;
    if (b.preset === undefined && command === undefined && b.role === undefined && b.roleId === undefined && b.dir === undefined && rename === undefined && b.color === undefined && b.icon === undefined && b.account === undefined) {
      throw new ApiError(400, "Nada para trocar: informe --preset, --command, --role, --dir, --account, --color, --icon ou um novo nome.");
    }
    const preset = b.preset === undefined ? null : findPreset(c.projectId, b.preset);
    const baseCmd = (command !== undefined ? command : preset ? preset.cmd : baseCmdOf(t)).trim();
    // role: o novo, ou o atual (o prompt vigente está no arquivo do nó)
    let prompt: string | null = null;
    let roleData: Obj = {};
    const nr = roleInput(repo, b);
    if (nr.saved || nr.text.trim()) {
      prompt = nr.saved ? nr.saved.prompt : nr.text;
      roleData = { roleId: nr.saved?.id ?? null, role: nr.saved ? nr.saved.name : nr.text.trim().length <= 60 ? nr.text.trim() : "Agente" };
    } else {
      try {
        prompt = fs.readFileSync(path.join(repo, ".maestri-roles", `${t.id}.md`), "utf8") || null;
      } catch {}
    }
    const real = b.dir !== undefined ? projectDir(repo, t.data?.roleDir ? floors.floorCwd(c.projectId, floorOf(t)) : cwdOf(c.projectId, repo, t), b.dir) : null;
    const roleId = nr.saved?.id ?? (nr.text.trim() ? null : (t.data?.roleId as string | null | undefined) ?? null);
    const explicit = b.dir !== undefined || (!t.data?.roleDir && (!!t.data?.worktreePath || floorOf(t) !== GROUND));
    const delivery = deliverRole(repo, t.id, baseCmd, prompt, roleId, explicit);
    const title = rename ? uniqueTitle(c.nodes, rename, t.id) : undefined;
    // conta: --account vence a do preset; trocar de CLI não herda a conta do anterior; "Default" = sem conta (null limpa)
    let accountPatch: Obj = {};
    if (b.account !== undefined) accountPatch = { account: accounts.resolveFor(baseCmd, b.account) ?? null };
    else if (preset?.account) accountPatch = { account: tryAccount(baseCmd, preset.account) ?? null };
    else if (programOf(baseCmd) !== programOf(baseCmdOf(t))) accountPatch = { account: null };
    const presetField = preset ? (preset.builtin ? preset.id : presetIdForCmd(baseCmd)) : command !== undefined ? presetIdForCmd(baseCmd) : undefined;
    canvas.applyAndBroadcast(c.projectId, {
      kind: "patchNodeData", id: t.id,
      data: {
        ...(title && { title }),
        ...(presetField && { preset: presetField, presetName: preset?.label ?? null }),
        ...roleData,
        ...accountPatch,
        ...(real && { worktreePath: relDir(repo, real) }),
        ...(preset && { isMaestro: preset.maestro }), // poderes de Maestro só mudam com --preset explícito
        ...(b.color !== undefined && { color: b.color }),
        ...(b.icon !== undefined && { icon: b.icon }),
      },
    }, by(c));
    const fresh = canvas.state(c.projectId).nodes!.find((x) => x.id === t.id)!;
    const defaultCmd = delivery.defaultCmd;
    canvas.applyAndBroadcast(c.projectId, { kind: "patchNodeData", id: t.id, data: { baseCmd, defaultCmd, chat: [], chatBusy: false, ...(real ? { roleDir: false } : roleCwdPatch(t, delivery)) } }, by(c));
    chatBusy.delete(`${c.projectId}:${t.id}`);
    restart(c.projectId, repo, fresh, defaultCmd, true);
    return { ok: true, nodeId: t.id, name: title ?? nodeLabel(t), ...(nr.note && { note: nr.note }) };
  }

  // ---------- Connect ----------
  const LINKABLE = new Set(["agentTerminal", "stickyNote", "noteStack", "portal", "band"]);
  // Nome como o `maestri list` imprime: agente de outro workspace = "Nome @ Workspace"
  const labelOf = (n: Obj) => (n.__workspace ? `${n.data?.title} @ ${n.__workspace}` : n.data?.title);

  // Os nós da minha árvore de equipe, por nome: eu, recrutas diretos e o que está ligado a mim ou a eles
  // (inclui agentes de outros workspaces ligados a mim)
  // kind (--agent|--note|--band|--fichario|--portal, logo depois do nome) desambigua nomes repetidos entre tipos
  function teamNode(c: Ctx, name: unknown, kind?: unknown): Obj {
    if (!isText(name, 200) || !name.trim()) throw new ApiError(400, "Informe os dois nomes.");
    if (kind !== undefined && !KIND_TYPES[String(kind)]) throw new ApiError(400, "Tipo inválido. Use --agent, --note, --band, --fichario ou --portal.");
    const type = kind === undefined ? undefined : KIND_TYPES[String(kind)];
    const tree = teamTree(c.nodes, c.edges, c.me);
    const pool = [c.me, ...tree.direct, ...tree.others, ...c.connected].filter((n, i, a) => LINKABLE.has(n.type) && a.findIndex((x) => x.id === n.id) === i);
    const hits = pool.filter((n) => lc(labelOf(n)) === lc(name) && (!type || n.type === type));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) throw new ApiError(400, `Nome ambíguo: "${name}" corresponde a ${hits.length} nós da sua equipe.${type ? "" : " Diga o tipo logo depois do nome: --agent, --note, --band, --fichario ou --portal."}`);
    if (c.nodes.some((n) => LINKABLE.has(n.type) && lc(n.data?.title) === lc(name) && (!type || n.type === type))) throw new ApiError(400, `"${name}" existe no canvas, mas está fora da sua árvore de equipe.`);
    throw new ApiError(404, `"${name}" não encontrado${type ? ` (tipo ${kind})` : ""}.`);
  }

  function checkLink(a: Obj, b: Obj) {
    if (a.id === b.id && !a.__project && !b.__project) throw new ApiError(400, "Escolha dois nós diferentes.");
    const types = [a.type, b.type];
    const has = (t: string) => types.includes(t);
    if (has("portal") && !(has("agentTerminal") || has("band"))) throw new ApiError(400, "Um portal só se liga a um agente (ou banda).");
    if (a.type === "band" && b.type === "band") throw new ApiError(400, "Bandas não se ligam entre si.");
    // notas, fichários e portais vivem em um andar só: o par precisa dividi-lo (agente↔agente cruza andares)
    if (types.some((t) => t === "stickyNote" || t === "noteStack" || t === "portal") && !sameFloorNodes(a, b)) {
      throw new ApiError(400, `Notas, fichários e portais só se ligam no mesmo andar ("${nodeLabel(a)}" e "${nodeLabel(b)}" estão em andares diferentes).`);
    }
  }

  fastify.post(`${base}/connect`, wrap((c, req) => {
    requireMaestro(c, "conectar nós");
    const a = teamNode(c, req.body?.from, req.body?.fromKind);
    const b = teamNode(c, req.body?.to, req.body?.toKind);
    checkLink(a, b);
    const pa: string = a.__project ?? c.projectId;
    const pb: string = b.__project ?? c.projectId;
    // Workspaces diferentes: só agente↔agente, e a corda vive no registro de links (cada projeto tem o próprio canvas)
    if (pa !== pb) {
      if (a.type !== "agentTerminal" || b.type !== "agentTerminal") throw new ApiError(400, "Entre workspaces só agentes se conectam.");
      const added = links.add({ project: pa, node: a.id }, { project: pb, node: b.id });
      linksChanged(pa, pb);
      return { ok: true, already: !added };
    }
    const edges = canvas.state(pa).edges ?? [];
    if (edges.some((e) => (e.source === a.id && e.target === b.id) || (e.source === b.id && e.target === a.id))) {
      return { ok: true, already: true };
    }
    canvas.applyAndBroadcast(pa, { kind: "upsertEdges", edges: [{ id: `e-${a.id}-${b.id}`, source: a.id, target: b.id }] }, by(c));
    return { ok: true, already: false };
  }));

  // Para a UI: quem tem links com outros workspaces (badge com tooltip "Nome @ Workspace")
  fastify.get("/api/projects/:p/links", async (req: any, reply) => {
    const p = String(req.params.p);
    if (!/^[\w-]+$/.test(p) || !projectRepo(p)) return reply.status(404).send({ error: "Projeto não encontrado." });
    const out: Record<string, { name: string; workspace: string }[]> = {};
    for (const l of links.all()) {
      for (const [mine, other] of [[l.a, l.b], [l.b, l.a]] as const) {
        if (mine.project !== p) continue;
        const peer = canvas.state(other.project).nodes?.find((n) => n.id === other.node);
        if (peer) (out[mine.node] ??= []).push({ name: String(peer.data?.title ?? peer.id), workspace: workspaces.nameOf(other.project) ?? other.project });
      }
    }
    return { links: out };
  });

  // ---------- Bandas ----------
  // "Banda" (a minha) ou "Banda @ Workspace": no outro workspace só enxergo as bandas que têm membros ligados a mim
  function findBand(c: Ctx, name: unknown): Obj {
    if (!isText(name, 200) || !name.trim()) throw new ApiError(400, "Informe o nome da banda.");
    const { name: bn, ws } = splitAddr(name);
    const pid = ws !== null && lc(ws) !== lc(c.workspace) ? wsId(ws) : c.projectId;
    const cw = scoped(c, pid);
    let visible: Obj[];
    if (pid === c.projectId) visible = myBands(c.nodes, c.edges, c.me.id);
    else {
      const mine = new Set(links.peers(c.projectId, c.me.id).filter((p) => p.project === pid).map((p) => p.node));
      visible = cw.nodes.filter((x) => isBand(x) && memberIds(x).some((m) => mine.has(m)));
    }
    const hits = visible.filter((x) => lc(x.data?.title) === lc(bn));
    const tag = (x: Obj) => (pid === c.projectId ? x : { ...x, __project: pid });
    if (hits.length === 1) return tag(hits[0]);
    if (hits.length > 1) throw new ApiError(400, `Nome ambíguo: ${hits.length} bandas chamadas "${name}".`);
    if (cw.nodes.some((x) => isBand(x) && lc(x.data?.title) === lc(bn))) throw new ApiError(400, `A banda "${name}" existe, mas você não está nela nem ligado a ela.`);
    throw new ApiError(404, `Banda "${name}" não encontrada.`);
  }
  // Entrar na banda: vira membro e ganha a corda da banda (herda tudo a que a banda se liga)
  function joinBand(c: Ctx, band: Obj, agentId: string) {
    const fresh = canvas.state(c.projectId).nodes!.find((x) => x.id === band.id) ?? band;
    const members = [...new Set([...memberIds(fresh), agentId])];
    canvas.applyAndBroadcast(c.projectId, { kind: "patchNodeData", id: band.id, data: { members } }, by(c));
    canvas.applyAndBroadcast(c.projectId, { kind: "upsertEdges", edges: [{ id: `e-${band.id}-${agentId}`, source: band.id, target: agentId }] }, by(c));
  }
  // Agente por nome (eu, um colega ou "Nome @ Workspace"); wsDefault completa o nome sem endereço com o workspace da banda
  const agentIn = (c: Ctx, name: unknown, wsDefault?: string) => {
    if (isText(name, 200) && lc(name) === lc(c.me.data?.title)) return c.me;
    const qualified = wsDefault && isText(name, 200) && splitAddr(name).ws === null ? `${name} @ ${wsDefault}` : name;
    return resolveTarget(c, qualified, "agentTerminal");
  };
  const bandProject = (c: Ctx, band: Obj): string => band.__project ?? c.projectId;

  fastify.post(`${base}/band/create`, wrap((c, req) => {
    requireMaestro(c, "criar bandas");
    const b = req.body ?? {};
    checkLook(b);
    if (!isText(b.name, 60) || !b.name.trim()) throw new ApiError(400, "Informe o nome da banda (até 60 caracteres).");
    // --workspace: a banda nasce no outro workspace, com os agentes de lá que alcanço; eu coordeno de fora
    const tpid = b.workspace === undefined ? c.projectId : wsId(b.workspace);
    const cross = tpid !== c.projectId;
    const wsName = workspaces.nameOf(tpid) ?? tpid;
    sweepBands(canvas, tpid, by(c));
    const nodes = canvas.state(tpid).nodes ?? [];
    const inBand = (n: Obj) => bandOf(nodes, n.id);
    // --floor: junta os agentes que alcanço naquele andar; fora do meu andar eu coordeno de fora
    const floor = b.floor !== undefined ? floorNamed(tpid, b.floor) : cross ? GROUND : floorOf(c.me);
    const withoutMe = cross || b.withoutMe === true || floor !== floorOf(c.me);
    let agents: Obj[];
    if (Array.isArray(b.agents) && b.agents.length) {
      agents = b.agents.map((n: unknown) => agentIn(c, n, cross ? wsName : undefined));
    } else if (cross) {
      const mine = new Set(links.peers(c.projectId, c.me.id).filter((p) => p.project === tpid).map((p) => p.node));
      agents = nodes.filter((n) => n.type === "agentTerminal" && mine.has(n.id) && floorOf(n) === floor && !inBand(n));
    } else {
      agents = neighbors(nodes, c.edges, c.me.id).filter((n) => n.type === "agentTerminal" && floorOf(n) === floor && !inBand(n));
    }
    if (!withoutMe && !agents.some((n) => n.id === c.me.id)) agents.unshift(c.me);
    if (withoutMe) agents = agents.filter((n) => n.id !== c.me.id);
    agents = agents.filter((n, i, a) => a.findIndex((x) => x.id === n.id) === i);
    if (agents.some((n) => (n.__project ?? (cross ? tpid : c.projectId)) !== tpid)) throw new ApiError(400, "Uma banda vive em um workspace só: todos os agentes precisam ser dele.");
    for (const n of agents) {
      const other = inBand(n);
      if (other) throw new ApiError(409, `"${nodeLabel(n)}" já está na banda "${nodeLabel(other)}" (um terminal fica em uma banda por vez).`);
    }
    if (agents.length < 2) throw new ApiError(400, "Uma banda precisa de pelo menos 2 agentes.");
    if (agents.some((n) => floorOf(n) !== floor)) throw new ApiError(400, `Uma banda vive em um andar só: todos os agentes precisam estar em "${floor}".`);

    const taken = new Set(nodes.filter(isBand).map((x) => lc(x.data?.title)));
    let title = b.name.trim();
    for (let n = 2; taken.has(lc(title)); n++) title = `${b.name.trim().slice(0, 55)} (${n})`;
    const id = `band-${crypto.randomUUID().slice(0, 8)}`;
    const ref = cross ? nodes.find((n) => n.id === agents[0].id) ?? nodes.at(-1) ?? c.me : c.me;
    const band = {
      id, type: "band", position: freePosition(nodes, ref, BAND_SIZE), style: { width: BAND_SIZE[0], height: BAND_SIZE[1] },
      data: { title, members: agents.map((n) => n.id), ...floorData(floor), ...(b.color !== undefined && { color: b.color }), ...(b.icon !== undefined && { icon: b.icon }) },
    };
    canvas.applyAndBroadcast(tpid, { kind: "upsertNodes", nodes: [band] }, by(c));
    canvas.applyAndBroadcast(tpid, { kind: "upsertEdges", edges: agents.map((n) => ({ id: `e-${id}-${n.id}`, source: id, target: n.id })) }, by(c));
    // Fora da banda, o criador fica ligado a ela para continuar alcançando todos (outro workspace: pelos links dos membros)
    if (!cross && !agents.some((n) => n.id === c.me.id)) {
      canvas.applyAndBroadcast(c.projectId, { kind: "upsertEdges", edges: [{ id: `e-${id}-${c.me.id}`, source: id, target: c.me.id }] }, by(c));
    }
    return { ok: true, nodeId: id, name: cross ? `${title} @ ${wsName}` : title, members: agents.map((n) => nodeLabel(n)) };
  }));

  fastify.post(`${base}/band/add`, wrap((c, req) => {
    requireMaestro(c, "alterar bandas");
    sweepBands(canvas, c.projectId, by(c));
    const band = findBand(c, req.body?.band);
    const pid = bandProject(c, band);
    const cw = scoped(c, pid);
    if (pid !== c.projectId) sweepBands(canvas, pid, by(c));
    const agent = agentIn(c, req.body?.agent, pid !== c.projectId ? workspaces.nameOf(pid) : undefined);
    if ((agent.__project ?? c.projectId) !== pid) throw new ApiError(400, "O agente precisa estar no workspace da banda.");
    if (memberIds(band).includes(agent.id)) throw new ApiError(409, `"${nodeLabel(agent)}" já está na banda.`);
    const other = bandOf(cw.nodes, agent.id);
    if (other) throw new ApiError(409, `"${nodeLabel(agent)}" já está na banda "${nodeLabel(other)}".`);
    if (!sameFloorNodes(agent, band)) throw new ApiError(400, "O agente precisa estar no andar da banda.");
    joinBand(cw, band, agent.id);
    return { ok: true };
  }));

  fastify.post(`${base}/band/remove`, wrap((c, req) => {
    requireMaestro(c, "alterar bandas");
    sweepBands(canvas, c.projectId, by(c));
    const band = findBand(c, req.body?.band);
    const pid = bandProject(c, band);
    if (pid !== c.projectId) sweepBands(canvas, pid, by(c));
    const agent = agentIn(c, req.body?.agent, pid !== c.projectId ? workspaces.nameOf(pid) : undefined);
    const members = memberIds(band);
    if (!members.includes(agent.id)) throw new ApiError(400, `"${nodeLabel(agent)}" não está na banda.`);
    const rest = members.filter((id) => id !== agent.id);
    // quem sai continua ligado aos que ficam (não perde o alcance); a banda perde só a corda dele
    materialize(canvas, pid, [agent.id], rest, by(c));
    canvas.applyAndBroadcast(pid, { kind: "patchNodeData", id: band.id, data: { members: rest } }, by(c));
    canvas.applyAndBroadcast(pid, { kind: "removeEdges", ids: [`e-${band.id}-${agent.id}`] }, by(c));
    sweepBands(canvas, pid, by(c)); // sobrou 1 membro: a banda se dissolve
    return { ok: true, dissolved: !canvas.state(pid).nodes?.some((x) => x.id === band.id) };
  }));

  fastify.post(`${base}/band/dissolve`, wrap((c, req) => {
    requireMaestro(c, "alterar bandas");
    const band = findBand(c, req.body?.band);
    const cw = scoped(c, bandProject(c, band));
    const alive = memberIds(band).filter((id) => cw.nodes.some((n) => n.id === id));
    dissolve(canvas, cw.projectId, band, alive, by(c));
    return { ok: true };
  }));

  // Partituras (biblioteca de times salvos): src/partituras.ts
  registerPartituras({ fastify, canvas, sessions, floors, dataDir, projectRepo, nodeApi, links, workspaces, wsId, floorNamed, linksChanged, baseCmdOf, tryAccount });
}
