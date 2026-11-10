// Partituras pela CLI (Maestro): biblioteca de times salvos (agentes com roles e comandos, bandas, notas, fichários, portais e as cordas).
// Formato = o arquivo da UI (apps/web/src/lib/partitura.ts, F10: "maestri-partitura" v1 com nodes/edges), com campos extras
// que a UI ignora: id, description, icon, color, options, roles e prompts (para recriar roles que o projeto de destino não tem).
// Onde mora: <repo>/.maestri/partituras/<slug>.partitura.json (escopo "current") e <dataDir>/global-partituras/ (escopo "global").
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { CanvasStore } from "./canvas.js";
import type { SessionManager } from "./sessions.js";
import { ApiError, PRESETS, SIZES, freePosition } from "./agents.js";
import { isText, lc, type NodeApi } from "./nodeApi.js";
import { fsOpsAt, fsOpsAtStrict } from "./runAs.js";
import { listRoles, readRole, writeRole } from "./roles.js";
import { deliverRole } from "./agentSetup.js";
import { GROUND, floorOf, type FloorStore } from "./floors.js";
import { bandOf, isBand, memberIds, myBands, neighbors } from "./team.js";
import { reachNotes } from "./noteGraph.js";
import type { CrossLinks } from "./crossLinks.js";

type Obj = Record<string, any>;

export const PARTITURA_FORMAT = "maestri-partitura";
const NAME_MAX = 80;
const EPHEMERAL = ["chatBusy", "worktree", "branch", "worktreePath", "roleDir", "floor", "live"];

interface Deps {
  fastify: FastifyInstance;
  canvas: CanvasStore;
  sessions: SessionManager;
  floors: FloorStore;
  dataDir: string;
  projectRepo: (projectId: string) => string | null;
  nodeApi: NodeApi;
  links: CrossLinks;
  workspaces: { nameOf: (projectId: string) => string | undefined };
  wsId: (name: unknown) => string;
  floorNamed: (projectId: string, name: unknown) => string;
  linksChanged: (...pids: string[]) => void;
  baseCmdOf: (n: Obj) => string;
  tryAccount: (cmd: string, name: string) => string | undefined;
}

type Scope = "current" | "global";
interface Options {
  commands: boolean;
  noteText: boolean;
  chatHistory: boolean;
}
interface Entry {
  file: string;
  scope: Scope;
  rec: Obj;
}

const onOff = (v: unknown, what: string): boolean | undefined => {
  if (v === undefined) return undefined;
  if (v === true || v === "on") return true;
  if (v === false || v === "off") return false;
  throw new ApiError(400, `${what} deve ser on ou off.`);
};
const slugOf = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "partitura";
const prefixOf = (type: string) => (type === "agentTerminal" ? "agent" : type === "stickyNote" ? "note" : type === "noteStack" ? "stack" : type);

export function registerPartituras(d: Deps) {
  const { fastify, canvas, sessions, floors, dataDir, projectRepo, nodeApi, links, workspaces, wsId, floorNamed, linksChanged, baseCmdOf, tryAccount } = d;
  const { base, context, resolveTarget, requireMaestro, wrap } = nodeApi;
  type Ctx = ReturnType<typeof context>;
  const by = (c: Ctx) => `cli:${c.me.id}`;
  const globalRoles = path.join(dataDir, "global-roles");
  const dirOf = (repo: string, scope: Scope) => (scope === "global" ? path.join(dataDir, "global-partituras") : path.join(repo, ".maestri", "partituras"));

  // ---------- Biblioteca ----------
  function entries(repo: string): Entry[] {
    const out: Entry[] = [];
    for (const scope of ["current", "global"] as Scope[]) {
      const dir = dirOf(repo, scope);
      let names: string[] = [];
      try {
        names = fs.readdirSync(dir).filter((f) => f.endsWith(".partitura.json"));
      } catch {}
      for (const f of names) {
        try {
          const rec = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
          if (rec?.format === PARTITURA_FORMAT && typeof rec.name === "string" && Array.isArray(rec.nodes) && Array.isArray(rec.edges)) out.push({ file: path.join(dir, f), scope, rec });
        } catch {} // arquivo corrompido ou que não é partitura: ignora
      }
    }
    return out.sort((a, b) => a.rec.name.localeCompare(b.rec.name));
  }
  // "current" vence "global" quando o nome se repete
  function find(repo: string, name: unknown): Entry {
    if (!isText(name, 200) || !name.trim()) throw new ApiError(400, "Informe o nome da partitura.");
    const hits = entries(repo).filter((e) => lc(e.rec.name) === lc(name));
    const hit = hits.find((e) => e.scope === "current") ?? hits[0];
    if (!hit) throw new ApiError(404, `Partitura "${name}" não encontrada (veja "maestri partitura list").`);
    return hit;
  }
  function save(repo: string, scope: Scope, rec: Obj, previous?: string): string {
    const dir = dirOf(repo, scope);
    let file = path.join(dir, `${slugOf(rec.name)}.partitura.json`);
    for (let n = 2; fs.existsSync(file) && file !== previous; n++) file = path.join(dir, `${slugOf(rec.name)}-${n}.partitura.json`);
    // como o usuário do projeto (partitura de projeto é do agente), atômico e sem seguir symlink
    fsOpsAtStrict(repo, [{ op: "mkdirp", path: dir }, { op: "write", path: file, data: JSON.stringify(rec, null, 2) }]);
    if (previous && previous !== file) fsOpsAt(repo, [{ op: "rm", path: previous }]);
    return file;
  }
  const checkName = (v: unknown) => {
    if (!isText(v, NAME_MAX) || !v.trim()) throw new ApiError(400, `Nome da partitura: 1 a ${NAME_MAX} caracteres.`);
    return v.trim();
  };
  const checkScope = (v: unknown): Scope | undefined => {
    if (v === undefined) return undefined;
    if (v === "current" || v === "global") return v;
    throw new ApiError(400, "--scope deve ser current ou global.");
  };
  // "default" ou vazio tira o ícone/cor; o resto vale como está (vocabulário do arrange é do nó, não da partitura)
  const look = (v: unknown, what: string): string | null | undefined => {
    if (v === undefined) return undefined;
    if (!isText(v, 40)) throw new ApiError(400, `${what} inválido.`);
    return !v.trim() || lc(v) === "default" ? null : v.trim();
  };
  const summary = (rec: Obj) => {
    const count = (t: string) => rec.nodes.filter((n: Obj) => n.type === t).length;
    return { agents: count("agentTerminal"), bands: count("band"), notes: count("stickyNote"), stacks: count("noteStack"), portals: count("portal") };
  };

  // ---------- Captura (create/update) ----------
  function capture(c: Ctx, repo: string, names: string[], withoutMe: boolean, opts: Options) {
    const mine = floorOf(c.me);
    const picked = new Map<string, Obj>();
    const bands = new Map<string, Obj>();
    if (names.length) {
      for (const name of names) {
        try {
          const a = resolveTarget(c, name, "agentTerminal");
          picked.set(a.id, a);
        } catch (e) {
          const band = myBands(c.nodes, c.edges, c.me.id).find((b) => lc(b.data?.title) === lc(name));
          if (!band) throw e;
          bands.set(band.id, band);
        }
      }
    } else {
      for (const n of c.connected as Obj[]) if (n.type === "agentTerminal" && !n.__project && floorOf(n) === mine) picked.set(n.id, n);
    }
    if (withoutMe) picked.delete(c.me.id);
    else picked.set(c.me.id, c.me);
    // uma banda é salva inteira: com todos os membros
    for (const b of myBands(c.nodes, c.edges, c.me.id)) if (memberIds(b).some((id) => picked.has(id))) bands.set(b.id, b);
    for (const id of picked.keys()) {
      const b = bandOf(c.nodes, id);
      if (b) bands.set(b.id, b);
    }
    for (const b of bands.values()) for (const id of memberIds(b)) {
      const m = c.nodes.find((n) => n.id === id);
      if (m && m.type === "agentTerminal") picked.set(m.id, m);
    }
    if (!picked.size) throw new ApiError(400, "Nada para salvar: nenhum agente alcançado no seu andar.");
    for (const n of [...picked.values(), ...bands.values()]) {
      if (floorOf(n) !== mine) throw new ApiError(400, `"${n.data?.title}" está em outro andar: uma partitura salva um andar só.`);
    }

    // o que está ligado a eles: notas (e cadeias), fichários (com as páginas) e portais
    const set = new Map<string, Obj>([...picked, ...bands]);
    for (const owner of [...set.values()]) {
      for (const n of neighbors(c.nodes, c.edges, owner.id)) if (n.type === "portal" && floorOf(n) === mine) set.set(n.id, n);
      const r = reachNotes(c.nodes, c.edges, owner.id);
      for (const x of [...r.notes.map((y) => y.node), ...r.stacks]) if (floorOf(x) === mine) set.set(x.id, x);
    }
    const nodes = [...set.values()];
    const ids = new Set(nodes.map((n) => n.id));
    const minX = Math.min(...nodes.map((n) => n.position.x));
    const minY = Math.min(...nodes.map((n) => n.position.y));
    const roles: Obj = {};
    const prompts: Obj = {};
    const out = nodes.map((n) => {
      const data: Obj = { ...n.data };
      for (const k of EPHEMERAL) delete data[k];
      if (n.type === "agentTerminal") {
        data.status = "idle";
        if (opts.chatHistory) data.chat = Array.isArray(n.data?.chat) ? n.data.chat : [];
        else delete data.chat;
        delete data.defaultCmd;
        delete data.baseCmd;
        if (opts.commands) data.baseCmd = data.defaultCmd = baseCmdOf(n);
        const saved = typeof data.roleId === "string" ? readRole(repo, data.roleId) ?? readRole(globalRoles, data.roleId) : null;
        if (saved) roles[saved.id] = { name: saved.name, prompt: saved.prompt };
        else {
          delete data.roleId;
          try {
            prompts[n.id] = fs.readFileSync(path.join(repo, ".maestri-roles", `${n.id}.md`), "utf8"); // papel em texto livre
          } catch {}
        }
      } else {
        delete data.status;
        delete data.chat;
        if (n.type === "stickyNote" && !opts.noteText) data.content = "";
      }
      const style = n.style ?? (n.width && n.height ? { width: n.width, height: n.height } : undefined);
      return { id: n.id, type: n.type, position: { x: n.position.x - minX, y: n.position.y - minY }, ...(style && { style }), ...(n.hidden && { hidden: true }), data };
    });
    const edges = c.edges.filter((e) => ids.has(e.source) && ids.has(e.target)).map((e) => {
      const { source, target, sourceHandle, targetHandle, animated, style, markerEnd } = e;
      return { source, target, sourceHandle, targetHandle, animated, style, markerEnd };
    });
    return { nodes: out, edges, roles, prompts };
  }

  // ---------- Inserção ----------
  function insert(c: Ctx, entry: Entry, b: Obj) {
    const rec = entry.rec;
    const tpid = b.workspace === undefined ? c.projectId : wsId(b.workspace);
    const cross = tpid !== c.projectId;
    const repo = projectRepo(tpid)!;
    const tnodes = canvas.state(tpid).nodes ?? [];
    const tf = b.floor !== undefined ? floorNamed(tpid, b.floor) : cross ? GROUND : floorOf(c.me);
    const wsName = cross ? workspaces.nameOf(tpid) ?? tpid : undefined;
    const addr = (title: string) => (wsName ? `${title} @ ${wsName}` : title);

    const idMap = new Map<string, string>();
    for (const n of rec.nodes) idMap.set(n.id, `${prefixOf(n.type)}-${crypto.randomUUID().slice(0, 8)}`);
    const sizeOf = (n: Obj): [number, number] => [Number(n.style?.width) || SIZES[n.type]?.[0] || 300, Number(n.style?.height) || SIZES[n.type]?.[1] || 200];
    let bw = 0;
    let bh = 0;
    for (const n of rec.nodes) {
      const [w, h] = sizeOf(n);
      bw = Math.max(bw, n.position.x + w);
      bh = Math.max(bh, n.position.y + h);
    }
    // ao lado de você no seu andar; em outro andar/workspace, abaixo de todo o conteúdo dele
    let origin: { x: number; y: number };
    if (b.floor === undefined && !cross) origin = freePosition(tnodes, c.me, [bw, bh]);
    else {
      const there = tnodes.filter((n) => floorOf(n) === tf);
      origin = there.length ? { x: Math.min(...there.map((n) => n.position.x)), y: Math.max(...there.map((n) => n.position.y + sizeOf(n)[1])) + 80 } : { x: 0, y: 0 };
    }

    const taken = (type: string) => new Set(tnodes.filter((n) => n.type === type).map((n) => lc(n.data?.title)));
    const takenBy = new Map<string, Set<string>>();
    const unique = (type: string, wanted: string) => {
      const set = takenBy.get(type) ?? takenBy.set(type, taken(type)).get(type)!;
      let title = wanted;
      for (let n = 2; set.has(lc(title)); n++) title = `${wanted.slice(0, 55)} (${n})`;
      set.add(lc(title));
      return title;
    };
    const explicit = tf !== GROUND;
    const started: { id: string; cwd: string; cmd: string }[] = [];
    const notes: string[] = [];
    const nodes = rec.nodes.map((n: Obj) => {
      const id = idMap.get(n.id)!;
      const data: Obj = { ...n.data };
      for (const k of EPHEMERAL) delete data[k];
      Object.assign(data, tf === GROUND ? {} : { floor: tf });
      if (n.type === "agentTerminal") {
        data.title = unique("agentTerminal", String(data.title ?? "Agente"));
        data.status = "idle";
        const baseCmd = (typeof data.baseCmd === "string" ? data.baseCmd : PRESETS[data.preset] ?? "").trim();
        let prompt: string | null = null;
        let savedId: string | null = null;
        if (typeof data.roleId === "string") {
          const have = readRole(repo, data.roleId) ?? readRole(globalRoles, data.roleId);
          const emb = rec.roles?.[data.roleId];
          if (have) [prompt, savedId] = [have.prompt, have.id];
          else if (emb && typeof emb.prompt === "string") {
            // o projeto de destino não tem o role: recria (mesmo id) se o nome estiver livre; senão o prompt vai como texto livre
            const clash = listRoles(repo).some((r) => lc(r.name) === lc(emb.name ?? data.role));
            const role = { schemaVersion: 1, id: data.roleId.toUpperCase(), name: String(emb.name ?? data.role ?? "Role"), prompt: emb.prompt, color: "#007AFF", icon: "person.text.rectangle" };
            if (!clash) {
              writeRole(repo, role);
              [prompt, savedId] = [role.prompt, role.id];
            } else prompt = emb.prompt;
          }
        } else if (typeof rec.prompts?.[n.id] === "string" && rec.prompts[n.id].trim()) prompt = rec.prompts[n.id];
        if (savedId) data.roleId = savedId;
        else delete data.roleId;
        const dl = deliverRole(repo, id, baseCmd, prompt, savedId, explicit);
        data.baseCmd = baseCmd;
        data.defaultCmd = dl.defaultCmd;
        if (dl.roleDir) Object.assign(data, { worktreePath: dl.worktreePath, roleDir: true });
        if (data.account && !tryAccount(baseCmd, String(data.account))) delete data.account;
        delete data.chatBusy;
        started.push({ id, cwd: dl.roleDir ? path.join(fs.realpathSync(repo), dl.worktreePath!) : floors.floorCwd(tpid, tf), cmd: dl.defaultCmd });
      } else if (n.type === "band") {
        data.title = unique("band", String(data.title ?? "Banda"));
        data.members = memberIds(n).map((m) => idMap.get(m)).filter((m): m is string => !!m);
      } else if (n.type === "noteStack" || n.type === "portal" || (n.type === "stickyNote" && !data.stackId)) {
        if (typeof data.title === "string") data.title = unique(n.type, data.title);
      }
      if (typeof data.stackId === "string") data.stackId = idMap.get(data.stackId) ?? undefined;
      const [dw, dh] = sizeOf(n);
      return { id, type: n.type, position: { x: n.position.x + origin.x, y: n.position.y + origin.y }, style: n.style ?? { width: dw, height: dh }, data, ...(n.hidden && { hidden: true }) };
    });
    const edges = rec.edges.map((e: Obj) => {
      const [source, target] = [idMap.get(e.source)!, idMap.get(e.target)!];
      return { id: `e-${source}-${target}`, source, target, ...(e.sourceHandle != null && { sourceHandle: e.sourceHandle }), ...(e.targetHandle != null && { targetHandle: e.targetHandle }) };
    });

    // você: só aos Maestros dela quando houver (eles comandam o resto); senão a todos os agentes e bandas soltos
    const agents = nodes.filter((n: Obj) => n.type === "agentTerminal");
    const bandOfAgent = (id: string) => nodes.find((x: Obj) => x.type === "band" && x.data.members.includes(id));
    const maestros = agents.filter((n: Obj) => n.data.isMaestro === true);
    const linkTo: Obj[] = [];
    const add = (n: Obj | undefined) => n && !linkTo.includes(n) && linkTo.push(n);
    if (maestros.length) for (const m of maestros) add(cross ? m : bandOfAgent(m.id) ?? m);
    else for (const n of nodes.filter((x: Obj) => x.type === "band" || (x.type === "agentTerminal" && !bandOfAgent(x.id)))) add(n);
    // (outro workspace: bandas não cruzam; liga a você os agentes, pelo registro de links)

    canvas.applyAndBroadcast(tpid, { kind: "upsertNodes", nodes }, by(c));
    if (edges.length) canvas.applyAndBroadcast(tpid, { kind: "upsertEdges", edges }, by(c));
    if (cross) {
      const targets = linkTo.flatMap((n) => (n.type === "band" ? agents.filter((a: Obj) => n.data.members.includes(a.id)) : [n]));
      for (const t of targets) links.add({ project: c.projectId, node: c.me.id }, { project: tpid, node: t.id });
      linksChanged(c.projectId, tpid);
    } else if (linkTo.length) {
      canvas.applyAndBroadcast(c.projectId, { kind: "upsertEdges", edges: linkTo.map((n) => ({ id: `e-${c.me.id}-${n.id}`, source: c.me.id, target: n.id })) }, by(c));
    }
    for (const s of started) {
      try {
        sessions.ensure(tpid, s.id, { cwd: s.cwd, cmd: s.cmd });
      } catch (e: any) {
        notes.push(`sessão de um agente falhou: ${e.message}`);
      }
    }
    // quem você alcança agora: os agentes ligados direto e os membros das bandas ligadas
    const reach = new Set<string>();
    for (const n of linkTo) {
      if (n.type === "band") for (const m of n.data.members) reach.add(m);
      else reach.add(n.id);
    }
    const title = (id: string) => addr(String(nodes.find((x: Obj) => x.id === id)?.data.title));
    return {
      ok: true,
      name: rec.name,
      floor: tf,
      ...(wsName && { workspace: wsName }),
      ...summary({ nodes }),
      maestros: maestros.map((m: Obj) => addr(m.data.title)),
      reachable: [...reach].map(title),
      others: agents.length - reach.size,
      ...(notes.length && { warnings: notes }),
    };
  }

  // ---------- Rotas ----------
  const ctxRepo = (c: Ctx) => projectRepo(c.projectId)!;
  const toNames = (v: unknown): string[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.some((x) => !isText(x, 200) || !x.trim())) throw new ApiError(400, "agents deve ser uma lista de nomes.");
    return v.map((x) => x.trim());
  };
  const optionsOf = (b: Obj, from?: Partial<Options>): Options & { given: boolean; on: boolean } => {
    const commands = onOff(b.commands, "--commands");
    const noteText = onOff(b.noteText, "--note-text");
    const chatHistory = onOff(b.chatHistory, "--chat-history");
    return {
      commands: commands ?? from?.commands ?? true,
      noteText: noteText ?? from?.noteText ?? true,
      chatHistory: chatHistory ?? from?.chatHistory ?? false,
      given: [commands, noteText, chatHistory].some((x) => x !== undefined),
      on: [commands, noteText, chatHistory].some((x) => x === true),
    };
  };

  fastify.get(`${base}/partituras`, wrap((c) => {
    requireMaestro(c, "listar partituras");
    return { partituras: entries(ctxRepo(c)).map((e) => ({ name: e.rec.name, scope: e.scope, description: e.rec.description ?? "", icon: e.rec.icon ?? null, color: e.rec.color ?? null, ...summary(e.rec) })) };
  }));

  fastify.post(`${base}/partituras/insert`, wrap((c, req) => {
    requireMaestro(c, "inserir partituras");
    const entry = find(ctxRepo(c), req.body?.name);
    if (!entry.rec.nodes.length) throw new ApiError(400, `A partitura "${entry.rec.name}" está vazia.`);
    return insert(c, entry, req.body ?? {});
  }));

  fastify.post(`${base}/partituras/create`, wrap((c, req) => {
    requireMaestro(c, "criar partituras");
    const b = req.body ?? {};
    const repo = ctxRepo(c);
    const name = checkName(b.name);
    if (entries(repo).some((e) => lc(e.rec.name) === lc(name))) throw new ApiError(409, `Já existe uma partitura "${name}"; create nunca sobrescreve (use update).`);
    const scope = checkScope(b.scope) ?? "current";
    const opts = optionsOf(b);
    const icon = look(b.icon, "Ícone");
    const color = look(b.color, "Cor");
    if (b.description !== undefined && !isText(b.description, 500)) throw new ApiError(400, "Descrição: até 500 caracteres.");
    const cap = capture(c, repo, toNames(b.agents), b.withoutMe === true, opts);
    const rec = {
      format: PARTITURA_FORMAT, version: 1, id: crypto.randomUUID().toUpperCase(), name, exportedAt: new Date().toISOString(),
      ...(b.description?.trim() && { description: b.description.trim() }), ...(icon && { icon }), ...(color && { color }),
      options: { commands: opts.commands, noteText: opts.noteText, chatHistory: opts.chatHistory },
      roles: cap.roles, prompts: cap.prompts, nodes: cap.nodes, edges: cap.edges,
    };
    save(repo, scope, rec);
    return { ok: true, name, scope, ...summary(rec) };
  }));

  fastify.post(`${base}/partituras/update`, wrap((c, req) => {
    requireMaestro(c, "alterar partituras");
    const b = req.body ?? {};
    const repo = ctxRepo(c);
    const cur = find(repo, b.name);
    const rec: Obj = { ...cur.rec };
    const names = toNames(b.agents);
    const opts = optionsOf(b, rec.options);
    const scope = checkScope(b.scope) ?? cur.scope;
    if (b.newName !== undefined) {
      const next = checkName(b.newName);
      if (entries(repo).some((e) => e.file !== cur.file && lc(e.rec.name) === lc(next))) throw new ApiError(409, `Já existe uma partitura "${next}".`);
      rec.name = next;
    }
    if (b.description !== undefined) {
      if (!isText(b.description, 500)) throw new ApiError(400, "Descrição: até 500 caracteres.");
      if (b.description.trim()) rec.description = b.description.trim();
      else delete rec.description;
    }
    for (const [key, v] of [["icon", look(b.icon, "Ícone")], ["color", look(b.color, "Cor")]] as const) {
      if (v === undefined) continue;
      if (v === null) delete rec[key];
      else rec[key] = v;
    }
    if (names.length || b.withoutMe === true || opts.on) {
      // salva o time de novo (só o time vivo tem comandos, texto das notas e chat)
      const cap = capture(c, repo, names, b.withoutMe === true, opts);
      Object.assign(rec, { exportedAt: new Date().toISOString(), roles: cap.roles, prompts: cap.prompts, nodes: cap.nodes, edges: cap.edges });
    } else if (opts.given) {
      // chave desligada = apaga essa parte do que já foi salvo
      if (!opts.commands) for (const n of rec.nodes) if (n.type === "agentTerminal") (delete n.data.baseCmd, delete n.data.defaultCmd);
      if (!opts.noteText) for (const n of rec.nodes) if (n.type === "stickyNote") n.data.content = "";
      if (!opts.chatHistory) for (const n of rec.nodes) delete n.data.chat;
    }
    rec.options = { commands: opts.commands, noteText: opts.noteText, chatHistory: opts.chatHistory };
    save(repo, scope, rec, cur.file);
    return { ok: true, name: rec.name, scope, ...summary(rec) };
  }));

  fastify.post(`${base}/partituras/delete`, wrap((c, req) => {
    requireMaestro(c, "apagar partituras");
    const cur = find(ctxRepo(c), req.body?.name);
    fsOpsAt(cur.file, [{ op: "rm", path: cur.file }]);
    return { ok: true, name: cur.rec.name };
  }));
}
