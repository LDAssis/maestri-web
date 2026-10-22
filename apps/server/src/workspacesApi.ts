import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { CanvasStore } from "./canvas.js";
import type { NodeApi } from "./nodeApi.js";
import { isText, lc } from "./nodeApi.js";
import { ApiError } from "./agents.js";
import { findConflict, overlaps } from "./projectDirs.js";
import { FloorStore, cloneCanvas } from "./floors.js";

type Obj = Record<string, any>;

// Workspace = projeto. group/folder/pinned vivem no próprio registro do projeto (projects.json); grupos e
// pastas vazios ficam em sidebar.json. Pasta com group = pasta dentro do grupo; sem group = pasta na raiz.
export interface WorkspaceProject {
  id: string;
  name: string;
  description: string;
  repoPath: string;
  createdAt: string;
  group?: string | null;
  folder?: string | null;
  pinned?: boolean;
}

interface Sidebar {
  groups: string[];
  folders: { name: string; group: string | null }[];
}

interface Deps {
  fastify: FastifyInstance;
  canvas: CanvasStore;
  projects: WorkspaceProject[];
  saveProjects: () => void;
  dataDir: string;
  writeJson: (file: string, data: unknown) => void;
  floors: FloorStore;
  nodeApi: NodeApi;
}

const NAME_MAX = 80;

export function registerWorkspacesApi({ fastify, canvas, projects, saveProjects, dataDir, writeJson, floors, nodeApi }: Deps) {
  const { base, requireMaestro, wrap } = nodeApi;
  const sidebarFile = path.join(dataDir, "sidebar.json");
  let sidebar: Sidebar = { groups: [], folders: [] };
  try {
    const saved = JSON.parse(fs.readFileSync(sidebarFile, "utf8"));
    if (Array.isArray(saved.groups)) sidebar.groups = saved.groups;
    if (Array.isArray(saved.folders)) sidebar.folders = saved.folders;
  } catch {}
  const saveSidebar = () => writeJson(sidebarFile, sidebar);

  const cleanName = (v: unknown, what: string) => {
    if (!isText(v, 400) || !v.trim()) throw new ApiError(400, `Informe ${what}.`);
    const n = v.trim();
    if (n.length > NAME_MAX || /[\x00-\x1f]/.test(n)) throw new ApiError(400, `${what[0].toUpperCase()}${what.slice(1)} inválido (até ${NAME_MAX} caracteres).`);
    return n;
  };

  const findProject = (name: unknown) => {
    const hit = projects.filter((p) => lc(p.name) === lc(name));
    if (hit.length === 1) return hit[0];
    throw new ApiError(404, `Workspace "${name}" não encontrado. Workspaces: ${projects.map((p) => p.name).join(", ")}.`);
  };

  // Destino na barra lateral: cria grupo/pasta se faltar e devolve { group, folder }
  function destination(o: { group?: unknown; folder?: unknown; root?: boolean }) {
    const group = o.group === undefined ? undefined : cleanName(o.group, "o nome do grupo");
    const folder = o.folder === undefined ? undefined : cleanName(o.folder, "o nome da pasta");
    if (o.root && group !== undefined) throw new ApiError(400, "--root não combina com --group.");
    if (group === undefined && folder === undefined && !o.root) throw new ApiError(400, "Informe --group, --folder ou --root.");
    let g: string | null = null;
    let f: string | null = null;
    if (group !== undefined) {
      g = sidebar.groups.find((x) => lc(x) === lc(group)) ?? group;
      if (!sidebar.groups.includes(g)) sidebar.groups.push(g);
    }
    if (folder !== undefined) {
      const same = (x: { name: string; group: string | null }) => lc(x.name) === lc(folder);
      let hit: { name: string; group: string | null } | undefined;
      if (g !== null) hit = sidebar.folders.find((x) => same(x) && x.group === g);
      else if (o.root) hit = sidebar.folders.find((x) => same(x) && x.group === null);
      else {
        const all = sidebar.folders.filter(same);
        if (all.length > 1) throw new ApiError(400, `A pasta "${folder}" existe em mais de um lugar; acrescente --group ou --root.`);
        hit = all[0];
        if (hit) g = hit.group;
      }
      if (!hit) sidebar.folders.push((hit = { name: folder, group: g }));
      f = hit.name;
    }
    return { group: g, folder: f };
  }

  const view = (p: WorkspaceProject, currentId: string) => ({
    id: p.id, name: p.name, dir: p.repoPath, floors: floors.read(p.id).floors.length, current: p.id === currentId,
  });

  function tree(currentId: string) {
    const of = (group: string | null, folder: string | null) =>
      projects.filter((p) => (p.group ?? null) === group && (p.folder ?? null) === folder).map((p) => view(p, currentId));
    const foldersIn = (group: string | null) =>
      sidebar.folders.filter((f) => f.group === group).map((f) => ({ name: f.name, workspaces: of(group, f.name) }));
    return {
      pinned: projects.filter((p) => p.pinned).map((p) => view(p, currentId)),
      root: { workspaces: of(null, null), folders: foldersIn(null) },
      groups: sidebar.groups.map((g) => ({ name: g, workspaces: of(g, null), folders: foldersIn(g) })),
    };
  }

  fastify.get("/api/sidebar", async () => sidebar);

  // --- Gerência da barra lateral pela UI (grupos, pastas, mover e fixar) ---
  const guard = (fn: (req: any) => any) => async (req: any, reply: any) => {
    try {
      return await fn(req);
    } catch (e: any) {
      if (e instanceof ApiError) return reply.status(e.status).send({ error: e.message });
      req.log.error(e);
      return reply.status(500).send({ error: e?.message || "Erro interno." });
    }
  };
  const groupOf = (name: unknown) => {
    const g = sidebar.groups.find((x) => lc(x) === lc(name));
    if (!g) throw new ApiError(404, `Grupo "${name}" não encontrado.`);
    return g;
  };
  // group "" / ausente = raiz
  const scope = (v: unknown) => (v === undefined || v === null || v === "" ? null : groupOf(v));
  const folderOf = (name: unknown, group: string | null) => {
    const f = sidebar.folders.find((x) => lc(x.name) === lc(name) && x.group === group);
    if (!f) throw new ApiError(404, `Pasta "${name}" não encontrada${group ? ` no grupo "${group}"` : " na raiz"}.`);
    return f;
  };
  const ok = () => {
    saveProjects();
    saveSidebar();
    return { ok: true, sidebar };
  };

  fastify.post("/api/sidebar/groups", guard((req) => {
    const name = cleanName(req.body?.name, "o nome do grupo");
    if (sidebar.groups.some((g) => lc(g) === lc(name))) throw new ApiError(409, `Já existe um grupo "${name}".`);
    sidebar.groups.push(name);
    return ok();
  }));

  fastify.patch("/api/sidebar/groups/:name", guard((req) => {
    const g = groupOf(req.params.name);
    const to = cleanName(req.body?.name, "o novo nome");
    if (sidebar.groups.some((x) => x !== g && lc(x) === lc(to))) throw new ApiError(409, `Já existe um grupo "${to}".`);
    sidebar.groups = sidebar.groups.map((x) => (x === g ? to : x));
    sidebar.folders.forEach((f) => f.group === g && (f.group = to));
    projects.forEach((p) => p.group === g && (p.group = to));
    return ok();
  }));

  // Apagar um grupo leva os workspaces (e os dos folders dele) para a raiz; as pastas dele somem
  fastify.delete("/api/sidebar/groups/:name", guard((req) => {
    const g = groupOf(req.params.name);
    sidebar.groups = sidebar.groups.filter((x) => x !== g);
    sidebar.folders = sidebar.folders.filter((f) => f.group !== g);
    projects.forEach((p) => p.group === g && ((p.group = null), (p.folder = null)));
    return ok();
  }));

  fastify.post("/api/sidebar/folders", guard((req) => {
    const name = cleanName(req.body?.name, "o nome da pasta");
    const group = scope(req.body?.group);
    if (sidebar.folders.some((f) => f.group === group && lc(f.name) === lc(name))) throw new ApiError(409, `Já existe uma pasta "${name}" ${group ? `no grupo "${group}"` : "na raiz"}.`);
    sidebar.folders.push({ name, group });
    return ok();
  }));

  fastify.patch("/api/sidebar/folders/:name", guard((req) => {
    const group = scope(req.query?.group);
    const f = folderOf(req.params.name, group);
    const to = cleanName(req.body?.name, "o novo nome");
    if (sidebar.folders.some((x) => x !== f && x.group === group && lc(x.name) === lc(to))) throw new ApiError(409, `Já existe uma pasta "${to}" ${group ? `no grupo "${group}"` : "na raiz"}.`);
    projects.forEach((p) => (p.group ?? null) === group && p.folder === f.name && (p.folder = to));
    f.name = to;
    return ok();
  }));

  // Apagar uma pasta leva os workspaces dela para o grupo (ou a raiz) onde ela estava
  fastify.delete("/api/sidebar/folders/:name", guard((req) => {
    const group = scope(req.query?.group);
    const f = folderOf(req.params.name, group);
    sidebar.folders = sidebar.folders.filter((x) => x !== f);
    projects.forEach((p) => (p.group ?? null) === group && p.folder === f.name && (p.folder = null));
    return ok();
  }));

  // Move e/ou fixa um workspace. group/folder explícitos (null = raiz); a pasta precisa existir naquele escopo.
  fastify.patch("/api/projects/:id/sidebar", guard((req) => {
    const p = projects.find((x) => x.id === req.params.id);
    if (!p) throw new ApiError(404, "Projeto não encontrado.");
    const b = req.body ?? {};
    if (b.pinned !== undefined && typeof b.pinned !== "boolean") throw new ApiError(400, "pinned deve ser booleano.");
    if (b.group !== undefined || b.folder !== undefined) {
      const group = scope(b.group);
      const folder = b.folder ? folderOf(b.folder, group).name : null;
      p.group = group;
      p.folder = folder;
    }
    if (b.pinned !== undefined) p.pinned = b.pinned;
    ok();
    return { ok: true, project: p };
  }));

  fastify.get(`${base}/workspaces`, wrap((c) => {
    requireMaestro(c, "listar workspaces");
    return tree(c.projectId);
  }));

  fastify.post(`${base}/workspaces`, wrap((c, req) => {
    requireMaestro(c, "criar workspaces");
    const b = req.body ?? {};
    const name = cleanName(b.name, "o nome do workspace");
    if (projects.some((p) => lc(p.name) === lc(name))) throw new ApiError(409, `Já existe um workspace chamado "${name}".`);
    if (!isText(b.dir, 4096) || !b.dir.trim()) throw new ApiError(400, "Informe --dir (o diretório precisa existir).");
    let dir: string;
    try {
      dir = fs.realpathSync(path.resolve(b.dir.trim().replace(/^~(?=$|\/)/, process.env.HOME ?? "~")));
      if (!fs.statSync(dir).isDirectory()) throw new Error("não é diretório");
    } catch {
      throw new ApiError(400, `O diretório não existe ou não é um diretório: ${b.dir}`);
    }
    const other = findConflict(dir, projects);
    if (other) throw new ApiError(409, `O diretório conflita com o workspace "${other.name}" (${other.repoPath}): workspaces não compartilham pastas.`);
    if (overlaps(dir, dataDir)) throw new ApiError(409, "O diretório contém os dados internos do Maestri (.maestri_data); escolha outra pasta.");
    const source = b.from !== undefined ? findProject(b.from) : null;
    const dest = b.group !== undefined || b.folder !== undefined || b.root ? destination(b) : { group: null, folder: null };

    let id = `proj-${Date.now().toString().slice(-6)}`;
    while (projects.some((p) => p.id === id)) id = `proj-${Math.random().toString(36).slice(2, 8)}`;
    const project: WorkspaceProject = { id, name, description: source ? `Clone de ${source.name}` : "", repoPath: dir, createdAt: new Date().toISOString(), group: dest.group, folder: dest.folder };
    projects.push(project);
    saveProjects();
    saveSidebar();

    if (source) copyCanvas(source, project);
    return { ok: true, id, name, dir, group: dest.group, folder: dest.folder, from: source?.name ?? null };
  }));

  // Clona o layout do canvas (e os andares, como andares sem git) reescrevendo caminhos sob o diretório de origem
  function copyCanvas(source: WorkspaceProject, target: WorkspaceProject) {
    const src = source.repoPath.replace(/\/+$/, "");
    const re = new RegExp(`${src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[/'"\\s]|$)`, "g");
    const rewrite = (v: unknown): unknown =>
      typeof v === "string" ? v.replace(re, target.repoPath) : Array.isArray(v) ? v.map(rewrite) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rewrite(x)])) : v;
    const st = canvas.state(source.id);
    const copy = cloneCanvas(st.nodes ?? [], st.edges ?? [], (d) => rewrite(d) as Obj);
    canvas.applyAndBroadcast(target.id, { kind: "replace", nodes: copy.nodes, edges: copy.edges }, "workspace");
    const file = floors.read(target.id);
    file.floors = floors.read(source.id).floors.map((f) => ({ name: f.name, git: false, branch: null, path: null, createdAt: new Date().toISOString() }));
    floors.save(target.id);
  }

  fastify.post(`${base}/workspaces/rename`, wrap((c, req) => {
    requireMaestro(c, "renomear workspaces");
    const p = findProject(req.body?.name);
    const next = cleanName(req.body?.to, "o novo nome");
    if (projects.some((x) => x !== p && lc(x.name) === lc(next))) throw new ApiError(409, `Já existe um workspace chamado "${next}".`);
    p.name = next;
    saveProjects();
    return { ok: true, name: next };
  }));

  fastify.post(`${base}/workspaces/move`, wrap((c, req) => {
    requireMaestro(c, "mover workspaces");
    const p = findProject(req.body?.name);
    const dest = destination(req.body ?? {});
    p.group = dest.group;
    p.folder = dest.folder;
    saveProjects();
    saveSidebar();
    return { ok: true, group: dest.group, folder: dest.folder };
  }));
}
