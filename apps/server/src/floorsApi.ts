import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { CanvasStore } from "./canvas.js";
import type { SessionManager } from "./sessions.js";
import type { NodeApi } from "./nodeApi.js";
import { isText } from "./nodeApi.js";
import { ApiError } from "./agents.js";
import { git, locked, slug } from "./worktrees.js";
import { FloorStore, GROUND, STATES, cloneCanvas, floorOf, sameFloor, type Floor, type FloorState, type FloorStatus } from "./floors.js";

type Obj = Record<string, any>;

interface Deps {
  fastify: FastifyInstance;
  sessions: SessionManager;
  canvas: CanvasStore;
  projectRepo: (projectId: string) => string | null;
  floors: FloorStore;
  nodeApi: NodeApi;
}

const STATUS_MAX = 120;
const NAME_MAX = 60;
// Não vão para a worktree nova: dependências e saída de build (mesmo sem estarem no .gitignore)
const SKIP_COPY = /(^|\/)(node_modules|\.next|dist|build|out|target|\.turbo|\.cache|__pycache__|\.venv|\.worktrees|\.maestri_data|\.git)(\/|$)/;
const BLOCKING = new Set<FloorState>(["blocked", "review", "done"]);

// "2/5", "40%" ou "0.4" → 0..1
export function parseProgress(v: unknown): number {
  const s = String(v ?? "").trim();
  let n = NaN;
  let m: RegExpExecArray | null;
  if ((m = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(s))) n = Number(m[2]) > 0 ? Number(m[1]) / Number(m[2]) : NaN;
  else if ((m = /^(\d+(?:\.\d+)?)\s*%$/.exec(s))) n = Number(m[1]) / 100;
  else if (/^\d*\.?\d+$/.test(s)) n = Number(s);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new ApiError(400, "Progresso inválido (use 2/5, 40% ou 0.4, entre 0 e 100%).");
  return n;
}

export function registerFloorsApi({ fastify, sessions, canvas, projectRepo, floors, nodeApi }: Deps) {
  const { base, requireMaestro, wrap } = nodeApi;
  const uiBase = "/api/projects/:p/floors";

  const nodesOf = (projectId: string): Obj[] => canvas.state(projectId).nodes ?? [];
  const edgesOf = (projectId: string): Obj[] => canvas.state(projectId).edges ?? [];
  const changed = (projectId: string) => canvas.notify(projectId, { type: "floors" });

  function repoOf(projectId: string) {
    if (!/^[\w-]+$/.test(projectId)) throw new ApiError(400, "Ids inválidos.");
    const repo = projectRepo(projectId);
    if (!repo) throw new ApiError(404, "Projeto não encontrado.");
    return fs.realpathSync(repo);
  }

  function getFloor(projectId: string, name: unknown): Floor {
    if (!isText(name, 200) || !name.trim()) throw new ApiError(400, "Informe o nome do andar.");
    const f = floors.find(projectId, name);
    if (!f) {
      const valid = [GROUND, ...floors.read(projectId).floors.map((x) => x.name)].join(", ");
      throw new ApiError(404, `Andar "${name}" não encontrado. Andares: ${valid}.`);
    }
    return f;
  }

  const isGitRepo = (repo: string) => git(repo, ["rev-parse", "--git-dir"]).then(() => true, () => false);
  const currentBranch = async (repo: string) => (await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")).trim() || null;
  // Trabalho não commitado; arquivos não rastreados em `ignore` (copiados do térreo) não contam
  const dirty = async (cwd: string, tracked = false, ignore: string[] = []) => {
    if (tracked) return (await git(cwd, ["status", "--porcelain", "--untracked-files=no"])).trim() !== "";
    const skip = new Set(ignore);
    return (await git(cwd, ["status", "--porcelain", "-z", "--untracked-files=all"])).split("\0").filter(Boolean).some((e) => !(e.startsWith("?? ") && skip.has(e.slice(3))));
  };

  // Copia (melhor esforço) os arquivos não rastreados e não ignorados do térreo para a worktree
  async function copyUntracked(repo: string, dest: string) {
    const copied: string[] = [];
    try {
      const files = (await git(repo, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
      for (const rel of files) {
        if (SKIP_COPY.test(rel)) continue;
        try {
          const src = path.join(repo, rel);
          if (!fs.statSync(src).isFile()) continue;
          fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
          fs.copyFileSync(src, path.join(dest, rel));
          copied.push(rel);
        } catch {}
      }
    } catch {}
    return copied;
  }

  async function hideWorktrees(repo: string) {
    const exclude = path.resolve(repo, (await git(repo, ["rev-parse", "--git-path", "info/exclude"])).trim());
    const cur = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
    if (!/^\/?\.worktrees\/?$/m.test(cur)) {
      fs.mkdirSync(path.dirname(exclude), { recursive: true });
      fs.appendFileSync(exclude, `${cur && !cur.endsWith("\n") ? "\n" : ""}/.worktrees/\n`);
    }
  }

  // --- listar ---
  async function list(projectId: string) {
    const repo = repoOf(projectId);
    const nodes = nodesOf(projectId);
    const count = (name: string) => nodes.filter((n) => sameFloor(floorOf(n), name)).length;
    const f = floors.read(projectId);
    return [
      { name: GROUND, ground: true, git: true, branch: await currentBranch(repo), path: repo, nodes: count(GROUND), status: f.ground ?? null },
      ...f.floors.map((x) => ({ name: x.name, ground: false, git: x.git, branch: x.branch, path: x.path ?? repo, nodes: count(x.name), status: x.status ?? null })),
    ];
  }

  // --- criar ---
  interface CreateOpts { name: unknown; branch?: unknown; existingBranch?: boolean; noGit?: boolean; copyGround?: boolean }

  const createFloor = (projectId: string, o: CreateOpts) => {
    const repo = repoOf(projectId);
    return locked(repo, async () => {
      if (!isText(o.name, 200) || !o.name.trim()) throw new ApiError(400, "Informe o nome do andar.");
      const name = o.name.trim();
      if (name.length > NAME_MAX || /[\x00-\x1f]/.test(name)) throw new ApiError(400, `Nome inválido (até ${NAME_MAX} caracteres, sem controle).`);
      if (sameFloor(name, GROUND) || floors.find(projectId, name)) throw new ApiError(409, `Já existe um andar chamado "${name}".`);
      if (o.branch !== undefined && (!isText(o.branch, 200) || !o.branch.trim())) throw new ApiError(400, "Branch inválida.");
      if (o.noGit && (o.branch !== undefined || o.existingBranch)) throw new ApiError(400, "--no-git não combina com --branch/--existing-branch.");

      let floor: Floor = { name, git: false, branch: null, path: null, createdAt: new Date().toISOString() };
      let note = "";
      const gitOk = await isGitRepo(repo);
      if (o.noGit) note = "Andar sem git: compartilha o diretório do térreo.";
      else if (!gitOk) note = "O projeto não é um repositório git: andar sem isolamento (compartilha o diretório do térreo).";
      else {
        const branch = (typeof o.branch === "string" ? o.branch.trim() : slug(name));
        if (!(await git(repo, ["check-ref-format", "--branch", branch]).then(() => true, () => false))) throw new ApiError(400, `Nome de branch inválido: ${branch}`);
        const exists = (await git(repo, ["branch", "--list", branch])).trim() !== "";
        if (o.existingBranch && !exists) throw new ApiError(404, `A branch "${branch}" não existe.`);
        if (!o.existingBranch && exists) throw new ApiError(409, `A branch "${branch}" já existe (use --existing-branch para usá-la).`);
        let dir = slug(name);
        for (let n = 2; fs.existsSync(path.join(repo, ".worktrees", dir)); n++) dir = `${slug(name)}-${n}`;
        const wtPath = path.join(repo, ".worktrees", dir);
        fs.mkdirSync(path.dirname(wtPath), { recursive: true });
        try {
          await git(repo, o.existingBranch ? ["worktree", "add", wtPath, branch] : ["worktree", "add", "-b", branch, wtPath, "HEAD"]);
        } catch (e: any) {
          throw new ApiError(409, `Falha ao criar o andar: ${e.message}`);
        }
        await hideWorktrees(repo);
        const copied = await copyUntracked(repo, wtPath);
        floor = { ...floor, git: true, branch, path: fs.realpathSync(wtPath), copied };
      }

      floors.read(projectId).floors.push(floor);
      floors.save(projectId);

      if (o.copyGround) {
        const ground = nodesOf(projectId).filter((n) => floorOf(n) === GROUND);
        const copy = cloneCanvas(ground, edgesOf(projectId), (d) => ({ ...d, floor: name }));
        if (copy.nodes.length) canvas.applyAndBroadcast(projectId, { kind: "upsertNodes", nodes: copy.nodes }, "floors");
        if (copy.edges.length) canvas.applyAndBroadcast(projectId, { kind: "upsertEdges", edges: copy.edges }, "floors");
      }
      changed(projectId);
      return { floor: { ...floor, nodes: nodesOf(projectId).filter((n) => sameFloor(floorOf(n), name)).length }, note };
    });
  };

  // Remove o andar (worktree, nós, metadados). Sem force, uma falha ao remover a worktree deixa tudo intacto.
  async function removeFloor(projectId: string, f: Floor, o: { deleteBranch: boolean; force: boolean }) {
    const repo = repoOf(projectId);
    if (f.git && f.path) {
      try {
        await git(repo, ["worktree", "remove", "--force", f.path]);
      } catch (e: any) {
        if (!o.force) throw new ApiError(500, `Não foi possível remover o clone do andar: ${e.message}. Use --force para remover mesmo assim.`);
        fs.rmSync(f.path, { recursive: true, force: true });
        await git(repo, ["worktree", "prune"]).catch(() => {});
      }
      if (o.deleteBranch && f.branch) await git(repo, ["branch", "-D", f.branch]).catch(() => {});
    }
    const ids = nodesOf(projectId).filter((n) => sameFloor(floorOf(n), f.name)).map((n) => n.id);
    if (ids.length) canvas.applyAndBroadcast(projectId, { kind: "removeNodes", ids }, "floors");
    const file = floors.read(projectId);
    file.floors = file.floors.filter((x) => x !== f);
    floors.save(projectId);
    changed(projectId);
  }

  const unmerged = async (repo: string, f: Floor) => {
    const base = await currentBranch(repo);
    if (!f.branch || !base) return 0;
    return Number((await git(repo, ["rev-list", "--count", `${base}..${f.branch}`]).catch(() => "0")).trim()) || 0;
  };

  const deleteFloor = (projectId: string, name: unknown, o: { keepBranch: boolean; force: boolean }) => {
    const repo = repoOf(projectId);
    return locked(repo, async () => {
      const f = getFloor(projectId, name);
      if (f.git && f.path && !o.force) {
        if (fs.existsSync(f.path) && (await dirty(f.path, false, f.copied))) throw new ApiError(409, `O andar "${f.name}" tem alterações não commitadas; commite/descarte ou use --force.`);
        const ahead = await unmerged(repo, f);
        if (!o.keepBranch && ahead > 0) throw new ApiError(409, `A branch ${f.branch} tem ${ahead} commit(s) fora de ${await currentBranch(repo)}; use --keep-branch para preservá-la ou --force.`);
      }
      await removeFloor(projectId, f, { deleteBranch: !o.keepBranch, force: o.force });
      return { ok: true, branch: f.git && o.keepBranch ? f.branch : null };
    });
  };

  // --- land ---
  const landFloor = (projectId: string, name: unknown, o: { into?: string; deleteBranch: boolean; keepFloor: boolean }) => {
    const repo = repoOf(projectId);
    return locked(repo, async () => {
      const f = getFloor(projectId, name);
      if (!f.git || !f.path || !f.branch) throw new ApiError(409, `O andar "${f.name}" não tem isolamento git; não há o que landar (use delete).`);
      if (o.deleteBranch && !o.into) throw new ApiError(400, "--delete-branch só vale junto com --into.");
      if (o.deleteBranch && o.keepFloor) throw new ApiError(400, "--delete-branch não combina com --keep-floor (a branch está em uso pelo andar).");
      if (fs.existsSync(f.path) && (await dirty(f.path, false, f.copied))) throw new ApiError(409, `O andar "${f.name}" tem trabalho não commitado; peça ao agente para commitar e tente de novo.`);
      if (await dirty(repo, true)) throw new ApiError(409, "O térreo tem alterações não commitadas; commite ou descarte antes de fazer land.");

      let merged: string | null = null;
      if (o.into) {
        if (!(await git(repo, ["rev-parse", "--verify", "-q", `refs/heads/${o.into}`]).then(() => true, () => false))) throw new ApiError(404, `A branch "${o.into}" não existe.`);
        if (o.into === f.branch) throw new ApiError(400, "--into não pode ser a própria branch do andar.");
        merged = await mergeInto(repo, f.branch, o.into);
      }
      if (!o.keepFloor) await removeFloor(projectId, f, { deleteBranch: o.deleteBranch, force: true });
      else changed(projectId);
      return { ok: true, branch: o.deleteBranch ? null : f.branch, into: o.into ?? null, merged, floorKept: o.keepFloor };
    });
  };

  // Merge de `branch` em `into`; se `into` não é a branch do térreo, usa uma worktree temporária
  async function mergeInto(repo: string, branch: string, into: string) {
    const env = { GIT_AUTHOR_NAME: "Maestri", GIT_AUTHOR_EMAIL: "maestri@localhost", GIT_COMMITTER_NAME: "Maestri", GIT_COMMITTER_EMAIL: "maestri@localhost" };
    const identity = async (cwd: string) => {
      const has = async (k: string) => (await git(cwd, ["config", k]).catch(() => "")).trim() !== "";
      return (await has("user.name")) && (await has("user.email")) ? {} : env;
    };
    const attempt = async (cwd: string) => {
      try {
        await git(cwd, ["merge", "--no-ff", "-m", `Merge ${branch}`, branch], await identity(cwd));
      } catch (e: any) {
        const files = (await git(cwd, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "")).split("\n").filter(Boolean);
        await git(cwd, ["merge", "--abort"]).catch(() => {});
        throw new ApiError(409, files.length ? `Conflito ao fazer merge de ${branch} em ${into} (${files.join(", ")}); nada foi alterado.` : `Falha no merge: ${e.message}`);
      }
      return (await git(cwd, ["rev-parse", "HEAD"])).trim();
    };
    if ((await currentBranch(repo)) === into) return attempt(repo);
    const tmp = path.join(repo, ".worktrees", `.land-${Date.now().toString(36)}`);
    try {
      await git(repo, ["worktree", "add", tmp, into]);
    } catch (e: any) {
      throw new ApiError(409, `Não foi possível usar a branch ${into} (já em uso em outra worktree?): ${e.message}`);
    }
    try {
      return await attempt(tmp);
    } finally {
      await git(repo, ["worktree", "remove", "--force", tmp]).catch(() => fs.rmSync(tmp, { recursive: true, force: true }));
    }
  }

  // --- unload ---
  function unloadFloor(projectId: string, name: unknown, callerFloor?: string) {
    const target = isText(name, 200) && sameFloor(name, GROUND) ? GROUND : getFloor(projectId, name).name;
    if (callerFloor !== undefined && sameFloor(callerFloor, target)) throw new ApiError(400, "Não é possível descarregar o andar em que você está.");
    const ids = nodesOf(projectId).filter((n) => n.type === "agentTerminal" && sameFloor(floorOf(n), target)).map((n) => n.id);
    sessions.killNodes(projectId, ids);
    changed(projectId);
    return { ok: true, floor: target, terminals: ids.length };
  }

  // --- status ---
  function getStatus(projectId: string, floorName: string): FloorStatus | null {
    const file = floors.read(projectId);
    return (sameFloor(floorName, GROUND) ? file.ground : floors.find(projectId, floorName)?.status) ?? null;
  }

  function setStatus(projectId: string, floorName: string, o: { text?: unknown; state?: unknown; progress?: unknown; clear?: boolean }, from?: { nodeId: string; title: string }) {
    const isGround = sameFloor(floorName, GROUND);
    const f = isGround ? undefined : getFloor(projectId, floorName);
    const file = floors.read(projectId);
    const put = (s: FloorStatus | undefined) => {
      if (isGround) file.ground = s;
      else if (s) f!.status = s;
      else delete f!.status;
    };
    if (o.clear) {
      put(undefined);
      floors.save(projectId);
      changed(projectId);
      return { status: null };
    }
    if (o.text !== undefined && !isText(o.text, 100_000)) throw new ApiError(400, "Texto inválido.");
    if (o.state !== undefined && !(STATES as readonly string[]).includes(String(o.state))) throw new ApiError(400, `Estado inválido (${STATES.join(", ")}).`);
    const old = (isGround ? file.ground : f!.status) ?? undefined;
    const text = typeof o.text === "string" ? o.text.trim().slice(0, STATUS_MAX) : old?.text;
    if (text === undefined && o.state === undefined && o.progress === undefined) throw new ApiError(400, "Informe o texto, --state ou --progress.");
    const state = ((o.state as FloorState | undefined) ?? (o.text !== undefined ? "working" : old?.state ?? "working")) as FloorState;
    const progress = o.progress !== undefined ? parseProgress(o.progress) : old?.progress ?? null;
    const status: FloorStatus = { text: text ?? "", state, progress, updatedAt: new Date().toISOString() };
    put(status);
    floors.save(projectId);
    if (BLOCKING.has(state) && state !== old?.state && from) {
      canvas.notify(projectId, { type: "notify", from, text: `${floorName}: ${state}${status.text ? ` — ${status.text}` : ""}` });
    }
    changed(projectId);
    return { status };
  }

  // --- rotas para a UI ---
  const guard = (fn: (projectId: string, req: any) => any) => async (req: any, reply: any) => {
    try {
      return await fn(req.params.p, req);
    } catch (e: any) {
      if (e instanceof ApiError) return reply.status(e.status).send({ error: e.message });
      req.log.error(e);
      return reply.status(500).send({ error: e?.message || "Erro interno." });
    }
  };
  const flag = (v: unknown) => v === true || v === "1" || v === "true";

  fastify.get(uiBase, guard(async (p) => ({ floors: await list(p) })));
  fastify.post(uiBase, guard(async (p, req) => {
    const b = req.body ?? {};
    return createFloor(p, { name: b.name, branch: b.branch, existingBranch: flag(b.existingBranch), noGit: flag(b.noGit), copyGround: flag(b.copyGround) });
  }));
  fastify.post(`${uiBase}/:name/land`, guard((p, req) => landFloor(p, req.params.name, { into: req.body?.into || undefined, deleteBranch: flag(req.body?.deleteBranch), keepFloor: flag(req.body?.keepFloor) })));
  fastify.delete(`${uiBase}/:name`, guard((p, req) => deleteFloor(p, req.params.name, { keepBranch: flag(req.query?.keepBranch), force: flag(req.query?.force) })));
  fastify.post(`${uiBase}/:name/unload`, guard((p, req) => unloadFloor(p, req.params.name)));

  // --- rotas do CLI (por nó): tudo exige Maestro, exceto status do próprio andar ---
  const onGround = (me: Obj, what: string) => {
    if (floorOf(me) !== GROUND) throw new ApiError(403, `${what} só pode ser feito a partir de um terminal do térreo (Ground).`);
  };

  fastify.get(`${base}/floors`, wrap(async (c) => {
    requireMaestro(c, "listar andares");
    return { you: floorOf(c.me), floors: await list(c.projectId) };
  }));
  fastify.post(`${base}/floors`, wrap(async (c, req) => {
    requireMaestro(c, "criar andares");
    const b = req.body ?? {};
    return createFloor(c.projectId, { name: b.name, branch: b.branch, existingBranch: flag(b.existingBranch), noGit: flag(b.noGit), copyGround: flag(b.copyGround) });
  }));
  fastify.post(`${base}/floors/land`, wrap((c, req) => {
    requireMaestro(c, "fazer land de andares");
    onGround(c.me, "O land");
    const b = req.body ?? {};
    return landFloor(c.projectId, b.name, { into: typeof b.into === "string" && b.into ? b.into : undefined, deleteBranch: flag(b.deleteBranch), keepFloor: flag(b.keepFloor) });
  }));
  fastify.post(`${base}/floors/delete`, wrap((c, req) => {
    requireMaestro(c, "apagar andares");
    onGround(c.me, "O delete");
    return deleteFloor(c.projectId, req.body?.name, { keepBranch: flag(req.body?.keepBranch), force: flag(req.body?.force) });
  }));
  fastify.post(`${base}/floors/unload`, wrap((c, req) => {
    requireMaestro(c, "descarregar andares");
    return unloadFloor(c.projectId, req.body?.name, floorOf(c.me));
  }));

  fastify.get(`${base}/floors/status`, wrap((c, req) => {
    const own = floorOf(c.me);
    const target = req.query?.floor ? String(req.query.floor) : own;
    if (!sameFloor(target, own)) requireMaestro(c, "ver o status de outro andar");
    const name = sameFloor(target, GROUND) ? GROUND : getFloor(c.projectId, target).name;
    return { floor: name, status: getStatus(c.projectId, name) };
  }));
  fastify.post(`${base}/floors/status`, wrap((c, req) => {
    const own = floorOf(c.me);
    const b = req.body ?? {};
    const target = b.floor ? String(b.floor) : own;
    if (!sameFloor(target, own)) requireMaestro(c, "alterar o status de outro andar");
    const name = sameFloor(target, GROUND) ? GROUND : getFloor(c.projectId, target).name;
    const r = setStatus(c.projectId, name, b, { nodeId: c.me.id, title: c.title(c.me) });
    return { floor: name, ...r };
  }));

  return { createFloor, listFloors: list, unloadFloor, setStatus };
}
