// Equipe via CLI (F15): connect, recruit avançado (--preset/--role/--band/--dir/--replace), presets, roles e bandas.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { CanvasStore } from "./canvas.js";
import type { SessionManager } from "./sessions.js";
import { ApiError, PRESETS, PRESET_LABELS, SIZES, freePosition, validCmd, withRolePrompt } from "./agents.js";
import { isText, lc, chatBusy, type NodeApi } from "./nodeApi.js";
import { listRoles, readRole, rolesDir, writeRole } from "./roles.js";
import { COLORS, ICONS } from "./notesApi.js";
import { presetLook } from "./presetLook.js";
import { isInside, resolveInside } from "./projectDirs.js";
import { BAND_SIZE, bandOf, dissolve, isBand, materialize, memberIds, myBands, neighbors, sameFloorNodes, sweepBands, teamTree } from "./team.js";
import { FloorStore, GROUND, floorOf } from "./floors.js";
import { AccountStore, DEFAULT_ACCOUNT } from "./accounts.js";
import { programOf } from "./resume.js";

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

// Cores e ícones do `arrange` (mesmas listas das notas)
const checkLook = (color: unknown, icon: unknown) => {
  if (color !== undefined && !(COLORS as readonly string[]).includes(String(color))) throw new ApiError(400, `Cor inválida. Opções: ${COLORS.join(", ")}.`);
  if (icon !== undefined && !(ICONS as readonly string[]).includes(String(icon))) throw new ApiError(400, `Ícone inválido. Opções: ${ICONS.join(", ")}.`);
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

export function registerTeamApi({ fastify, sessions, canvas, projectRepo, dataDir, nodeApi, settings, floors, accounts }: Deps) {
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
        map.set(e.id, { id: e.id, label: e.label, cmd: e.cmd, maestro: e.maestro === true, chat: e.chat === true, quickStart: e.quickStart !== false, builtin: !!b?.builtin, source, ...(typeof e.color === "string" && { color: e.color }), ...(typeof e.icon === "string" && { icon: e.icon }), ...(typeof e.account === "string" && e.account && { account: e.account }) });
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
    checkLook(b.color, b.icon);
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
    checkLook(b.color, b.icon);
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
      fs.rmSync(path.join(rolesDir(rootOf(repo, cur.scope)), String(role.id).toLowerCase()), { recursive: true, force: true });
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

  // Grava o comando (com o prompt do role) no nó e reinicia o PTY no mesmo lugar; o chat é descartado.
  // Sem sessão ativa só atualiza o nó (a sessão nasce quando alguém abrir o terminal).
  function applyCmd(c: Ctx, repo: string, node: Obj, baseCmd: string, prompt: string | null, extra: Obj = {}) {
    const defaultCmd = prompt ? withRolePrompt(repo, node.id, baseCmd, prompt) : baseCmd;
    canvas.applyAndBroadcast(c.projectId, { kind: "patchNodeData", id: node.id, data: { ...extra, baseCmd, defaultCmd, chat: [], chatBusy: false } }, by(c));
    chatBusy.delete(`${c.projectId}:${node.id}`);
    restart(c.projectId, repo, node, defaultCmd);
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
    const repo = projectRepo(c.projectId)!;
    const b = req.body ?? {};
    checkLook(b.color, b.icon);
    if (b.replace !== undefined) return replaceAgent(c, repo, b);

    if (!isText(b.name, MAX_TITLE) || !b.name.trim()) throw new ApiError(400, "Informe o nome do agente.");
    const command = b.command ?? b.cmd;
    if (command !== undefined && !validCmd(command)) throw new ApiError(400, "Comando inválido.");
    const myFloor = floorOf(c.me);
    const floor = b.floor === undefined ? myFloor : floorNamed(c.projectId, b.floor);

    const preset = b.preset === undefined ? null : findPreset(c.projectId, b.preset);
    // sem --preset nem --command: cópia de mim (mesmo comando)
    const copy = !preset && command === undefined;
    const baseCmd = (command !== undefined ? command : preset ? preset.cmd : baseCmdOf(c.me)).trim();
    const presetField = preset ? (preset.builtin ? preset.id : presetIdForCmd(baseCmd)) : copy ? c.me.data?.preset ?? presetIdForCmd(baseCmd) : presetIdForCmd(baseCmd);

    // conta: --account vence a do preset; cópia de mim herda a minha (mesmo CLI)
    const accountName = b.account !== undefined ? accounts.resolveFor(baseCmd, b.account)
      : preset?.account ? tryAccount(baseCmd, preset.account)
      : copy && programOf(baseCmd) === programOf(baseCmdOf(c.me)) ? (c.me.data?.account as string | undefined) : undefined;

    const { saved, text, note } = roleInput(repo, b);
    const id = `agent-${crypto.randomUUID().slice(0, 8)}`;
    const prompt = saved ? saved.prompt : text.trim() ? text : null;
    const defaultCmd = prompt ? withRolePrompt(repo, id, baseCmd, prompt) : baseCmd;

    // cwd: --dir manda; --floor usa o checkout do andar; senão herda o meu
    const baseCwd = b.floor !== undefined ? floors.floorCwd(c.projectId, floor) : cwdOf(c.projectId, repo, c.me);
    const real = b.dir !== undefined ? projectDir(repo, baseCwd, b.dir) : null;
    const worktreePath = real ? relDir(repo, real) : b.floor === undefined ? c.me.data?.worktreePath : undefined;

    // banda: --band escolhe (no andar onde o recruta nasce); senão, estando numa banda no mesmo andar,
    // o recruta entra nela em vez de ganhar uma corda
    let band: Obj | null = null;
    if (b.band !== undefined) {
      band = findBand(c, b.band);
      if (floorOf(band) !== floor) throw new ApiError(400, `A banda "${nodeLabel(band)}" está no andar "${floorOf(band)}", não em "${floor}".`);
    } else {
      band = bandOf(c.nodes, c.me.id) ?? null;
      if (band && floorOf(band) !== floor) band = null;
    }

    const title = uniqueTitle(c.nodes, b.name.trim());
    const roleLabel = saved ? saved.name : text.trim() ? (text.trim().length <= 60 ? text.trim() : "Agente") : preset?.label ?? PRESET_LABELS[presetField] ?? "Agente";
    const node = {
      id, type: "agentTerminal", position: freePosition(c.nodes, c.me, SIZES.agentTerminal), style: { width: 460, height: 330 },
      data: {
        title,
        preset: presetField,
        ...(preset && { presetName: preset.label }),
        ...(saved && { roleId: saved.id }),
        role: roleLabel,
        status: "idle",
        baseCmd,
        defaultCmd,
        ...(worktreePath && { worktreePath }),
        ...floorData(floor),
        ...(accountName && { account: accountName }),
        ...(preset?.maestro && { isMaestro: true }),
        ...(preset?.chat && { chatFirst: true }),
        // aparência: --color/--icon vencem; senão a do preset (quando é uma cor/ícone válido do arrange)
        ...((b.color ?? (preset?.color && (COLORS as readonly string[]).includes(preset.color) ? preset.color : undefined)) !== undefined && { color: b.color ?? preset!.color }),
        ...((b.icon ?? (preset?.icon && (ICONS as readonly string[]).includes(preset.icon) ? preset.icon : undefined)) !== undefined && { icon: b.icon ?? preset!.icon }),
      },
    };
    canvas.applyAndBroadcast(c.projectId, { kind: "upsertNodes", nodes: [node] }, by(c));
    if (band) joinBand(c, band, id);
    else canvas.applyAndBroadcast(c.projectId, { kind: "upsertEdges", edges: [{ id: `e-${c.me.id}-${id}`, source: c.me.id, target: id }] }, by(c));
    try {
      sessions.ensure(c.projectId, id, { cwd: real ?? baseCwd, cmd: defaultCmd });
    } catch (e: any) {
      throw new ApiError(500, `Nó criado, mas a sessão falhou: ${e.message}`);
    }
    return { ok: true, nodeId: id, name: title, ...(band && { band: nodeLabel(band) }), ...(note && { note }) };
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
    const real = b.dir !== undefined ? projectDir(repo, cwdOf(c.projectId, repo, t), b.dir) : null;
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
    const defaultCmd = prompt ? withRolePrompt(repo, t.id, baseCmd, prompt) : baseCmd;
    canvas.applyAndBroadcast(c.projectId, { kind: "patchNodeData", id: t.id, data: { baseCmd, defaultCmd, chat: [], chatBusy: false } }, by(c));
    chatBusy.delete(`${c.projectId}:${t.id}`);
    restart(c.projectId, repo, fresh, defaultCmd, true);
    return { ok: true, nodeId: t.id, name: title ?? nodeLabel(t), ...(nr.note && { note: nr.note }) };
  }

  // ---------- Connect ----------
  const LINKABLE = new Set(["agentTerminal", "stickyNote", "noteStack", "portal", "band"]);

  // Os nós da minha árvore de equipe, por nome: eu, recrutas diretos e o que está ligado a mim ou a eles
  function teamNode(c: Ctx, name: unknown): Obj {
    if (!isText(name, 200) || !name.trim()) throw new ApiError(400, "Informe os dois nomes.");
    const tree = teamTree(c.nodes, c.edges, c.me);
    const pool = [c.me, ...tree.direct, ...tree.others, ...c.connected].filter((n, i, a) => LINKABLE.has(n.type) && a.findIndex((x) => x.id === n.id) === i);
    const hits = pool.filter((n) => lc(n.data?.title) === lc(name));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) throw new ApiError(400, `Nome ambíguo: "${name}" corresponde a ${hits.length} nós da sua equipe.`);
    if (c.nodes.some((n) => LINKABLE.has(n.type) && lc(n.data?.title) === lc(name))) throw new ApiError(400, `"${name}" existe no canvas, mas está fora da sua árvore de equipe.`);
    throw new ApiError(404, `"${name}" não encontrado.`);
  }

  function checkLink(a: Obj, b: Obj) {
    if (a.id === b.id) throw new ApiError(400, "Escolha dois nós diferentes.");
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
    const a = teamNode(c, req.body?.from);
    const b = teamNode(c, req.body?.to);
    checkLink(a, b);
    if (c.edges.some((e) => (e.source === a.id && e.target === b.id) || (e.source === b.id && e.target === a.id))) {
      return { ok: true, already: true };
    }
    canvas.applyAndBroadcast(c.projectId, { kind: "upsertEdges", edges: [{ id: `e-${a.id}-${b.id}`, source: a.id, target: b.id }] }, by(c));
    return { ok: true, already: false };
  }));

  // ---------- Bandas ----------
  const bandsOfMine = (c: Ctx) => myBands(c.nodes, c.edges, c.me.id);
  function findBand(c: Ctx, name: unknown): Obj {
    if (!isText(name, 200) || !name.trim()) throw new ApiError(400, "Informe o nome da banda.");
    const mine = bandsOfMine(c);
    const hits = mine.filter((x) => lc(x.data?.title) === lc(name));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) throw new ApiError(400, `Nome ambíguo: ${hits.length} bandas chamadas "${name}".`);
    if (c.nodes.some((x) => isBand(x) && lc(x.data?.title) === lc(name))) throw new ApiError(400, `A banda "${name}" existe, mas você não está nela nem ligado a ela.`);
    throw new ApiError(404, `Banda "${name}" não encontrada.`);
  }
  // Entrar na banda: vira membro e ganha a corda da banda (herda tudo a que a banda se liga)
  function joinBand(c: Ctx, band: Obj, agentId: string) {
    const fresh = canvas.state(c.projectId).nodes!.find((x) => x.id === band.id) ?? band;
    const members = [...new Set([...memberIds(fresh), agentId])];
    canvas.applyAndBroadcast(c.projectId, { kind: "patchNodeData", id: band.id, data: { members } }, by(c));
    canvas.applyAndBroadcast(c.projectId, { kind: "upsertEdges", edges: [{ id: `e-${band.id}-${agentId}`, source: band.id, target: agentId }] }, by(c));
  }
  const agentIn = (c: Ctx, name: unknown) => {
    if (isText(name, 200) && lc(name) === lc(c.me.data?.title)) return c.me;
    return resolveTarget(c, name, "agentTerminal");
  };

  fastify.post(`${base}/band/create`, wrap((c, req) => {
    requireMaestro(c, "criar bandas");
    const b = req.body ?? {};
    checkLook(b.color, b.icon);
    if (!isText(b.name, 60) || !b.name.trim()) throw new ApiError(400, "Informe o nome da banda (até 60 caracteres).");
    sweepBands(canvas, c.projectId, by(c));
    const nodes = canvas.state(c.projectId).nodes ?? [];
    const inBand = (n: Obj) => bandOf(nodes, n.id);
    // --floor: junta os agentes que alcanço naquele andar; fora do meu andar eu coordeno de fora
    const floor = b.floor === undefined ? floorOf(c.me) : floorNamed(c.projectId, b.floor);
    const withoutMe = b.withoutMe === true || floor !== floorOf(c.me);
    let agents: Obj[];
    if (Array.isArray(b.agents) && b.agents.length) {
      agents = b.agents.map((n: unknown) => agentIn(c, n));
    } else {
      agents = neighbors(nodes, c.edges, c.me.id).filter((n) => n.type === "agentTerminal" && floorOf(n) === floor && !inBand(n));
    }
    if (!withoutMe && !agents.some((n) => n.id === c.me.id)) agents.unshift(c.me);
    if (withoutMe) agents = agents.filter((n) => n.id !== c.me.id);
    agents = agents.filter((n, i, a) => a.findIndex((x) => x.id === n.id) === i);
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
    const band = {
      id, type: "band", position: freePosition(nodes, c.me, BAND_SIZE), style: { width: BAND_SIZE[0], height: BAND_SIZE[1] },
      data: { title, members: agents.map((n) => n.id), ...floorData(floor), ...(b.color !== undefined && { color: b.color }), ...(b.icon !== undefined && { icon: b.icon }) },
    };
    canvas.applyAndBroadcast(c.projectId, { kind: "upsertNodes", nodes: [band] }, by(c));
    canvas.applyAndBroadcast(c.projectId, { kind: "upsertEdges", edges: agents.map((n) => ({ id: `e-${id}-${n.id}`, source: id, target: n.id })) }, by(c));
    // Fora da banda, o criador fica ligado a ela para continuar alcançando todos
    if (!agents.some((n) => n.id === c.me.id)) {
      canvas.applyAndBroadcast(c.projectId, { kind: "upsertEdges", edges: [{ id: `e-${id}-${c.me.id}`, source: id, target: c.me.id }] }, by(c));
    }
    return { ok: true, nodeId: id, name: title, members: agents.map((n) => nodeLabel(n)) };
  }));

  fastify.post(`${base}/band/add`, wrap((c, req) => {
    requireMaestro(c, "alterar bandas");
    sweepBands(canvas, c.projectId, by(c));
    const band = findBand(c, req.body?.band);
    const agent = agentIn(c, req.body?.agent);
    if (memberIds(band).includes(agent.id)) throw new ApiError(409, `"${nodeLabel(agent)}" já está na banda.`);
    const other = bandOf(c.nodes, agent.id);
    if (other) throw new ApiError(409, `"${nodeLabel(agent)}" já está na banda "${nodeLabel(other)}".`);
    if (!sameFloorNodes(agent, band)) throw new ApiError(400, "O agente precisa estar no andar da banda.");
    joinBand(c, band, agent.id);
    return { ok: true };
  }));

  fastify.post(`${base}/band/remove`, wrap((c, req) => {
    requireMaestro(c, "alterar bandas");
    sweepBands(canvas, c.projectId, by(c));
    const band = findBand(c, req.body?.band);
    const agent = agentIn(c, req.body?.agent);
    const members = memberIds(band);
    if (!members.includes(agent.id)) throw new ApiError(400, `"${nodeLabel(agent)}" não está na banda.`);
    const rest = members.filter((id) => id !== agent.id);
    // quem sai continua ligado aos que ficam (não perde o alcance); a banda perde só a corda dele
    materialize(canvas, c.projectId, [agent.id], rest, by(c));
    canvas.applyAndBroadcast(c.projectId, { kind: "patchNodeData", id: band.id, data: { members: rest } }, by(c));
    canvas.applyAndBroadcast(c.projectId, { kind: "removeEdges", ids: [`e-${band.id}-${agent.id}`] }, by(c));
    sweepBands(canvas, c.projectId, by(c)); // sobrou 1 membro: a banda se dissolve
    return { ok: true, dissolved: !canvas.state(c.projectId).nodes?.some((x) => x.id === band.id) };
  }));

  fastify.post(`${base}/band/dissolve`, wrap((c, req) => {
    requireMaestro(c, "alterar bandas");
    const band = findBand(c, req.body?.band);
    const alive = memberIds(band).filter((id) => c.nodes.some((n) => n.id === id));
    dissolve(canvas, c.projectId, band, alive, by(c));
    return { ok: true };
  }));
}
