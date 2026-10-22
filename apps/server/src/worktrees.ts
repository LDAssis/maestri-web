import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { CanvasStore } from "./canvas.js";
import type { SessionManager } from "./sessions.js";

type Obj = Record<string, any>;

interface Deps {
  fastify: FastifyInstance;
  sessions: SessionManager;
  canvas: CanvasStore;
  projectRepo: (projectId: string) => string | null;
}

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const PATCH_MAX = 500 * 1024;
const FILE_STATUS = new Set(["A", "M", "D"]);

class GitError extends Error {
  constructor(message: string, public stdout: string, public code: number | string | undefined) {
    super(message);
  }
}

// Sempre execFile com argv: nenhum valor externo passa por shell
function git(cwd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      reject(new GitError((stderr || stdout || err.message).trim(), stdout, (err as any).code));
    });
  });
}

const lines = (s: string) => s.split("\n").filter(Boolean);

function slug(title: string) {
  return title.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "agente";
}

export function registerWorktreeApi({ fastify, sessions, canvas, projectRepo }: Deps) {
  const base = "/api/projects/:p/worktrees";

  // Um mutex por repositório: create/land/delete não se intercalam
  const chains = new Map<string, Promise<unknown>>();
  function locked<T>(repo: string, fn: () => Promise<T>): Promise<T> {
    const run = (chains.get(repo) ?? Promise.resolve()).then(fn, fn);
    chains.set(repo, run.catch(() => {}));
    return run;
  }

  function context(params: { p: string }) {
    if (!/^[\w-]+$/.test(params.p)) throw new ApiError(400, "Ids inválidos.");
    const repo = projectRepo(params.p);
    if (!repo) throw new ApiError(404, "Projeto não encontrado.");
    return { projectId: params.p, repo: fs.realpathSync(repo) };
  }
  type Ctx = ReturnType<typeof context>;

  const wrap = (fn: (c: Ctx, req: any, reply: FastifyReply) => any) =>
    async (req: any, reply: FastifyReply) => {
      try {
        return await fn(context(req.params), req, reply);
      } catch (e: any) {
        if (e instanceof ApiError) return reply.status(e.status).send({ error: e.message });
        req.log.error(e);
        return reply.status(500).send({ error: e?.message || "Erro interno." });
      }
    };

  const validName = (name: unknown) => {
    if (typeof name !== "string" || !NAME_RE.test(name)) throw new ApiError(400, "Nome inválido (letras, números, ., _ e -; até 64 caracteres).");
    return name.toLowerCase();
  };

  async function baseBranch(repo: string) {
    const b = (await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")).trim();
    if (!b || b === "HEAD") throw new ApiError(409, "O worktree principal não está em uma branch (HEAD solto).");
    return b;
  }

  async function ensureIdentity(cwd: string): Promise<Record<string, string>> {
    const has = async (k: string) => (await git(cwd, ["config", k]).catch(() => "")).trim() !== "";
    if ((await has("user.name")) && (await has("user.email"))) return {};
    return { GIT_AUTHOR_NAME: "Maestri", GIT_AUTHOR_EMAIL: "maestri@localhost", GIT_COMMITTER_NAME: "Maestri", GIT_COMMITTER_EMAIL: "maestri@localhost" };
  }

  // Andares = worktrees em <repo>/.worktrees/*
  async function list(repo: string, baseName: string, nodes: Obj[]) {
    const out = await git(repo, ["worktree", "list", "--porcelain"]);
    const root = path.join(repo, ".worktrees") + path.sep;
    const found: { name: string; path: string; branch: string }[] = [];
    for (const block of out.split("\n\n")) {
      const wt = /^worktree (.+)$/m.exec(block)?.[1];
      const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
      if (!wt || !branch || !wt.startsWith(root)) continue;
      found.push({ name: path.basename(wt), path: wt, branch });
    }
    return Promise.all(
      found.map(async (w) => {
        const [head, counts, status] = await Promise.all([
          git(w.path, ["rev-parse", "--short", "HEAD"]),
          git(w.path, ["rev-list", "--left-right", "--count", `${baseName}...HEAD`]),
          git(w.path, ["status", "--porcelain"]),
        ]);
        const [behind, ahead] = counts.trim().split(/\s+/).map(Number);
        return {
          ...w,
          head: head.trim(),
          ahead,
          behind,
          changed: lines(status).length,
          nodeIds: nodes.filter((n) => n.data?.worktree === w.name).map((n) => n.id),
        };
      }),
    );
  }

  type Floor = Awaited<ReturnType<typeof list>>[number];
  const notifyChange = (c: Ctx) => canvas.notify(c.projectId, { type: "worktrees" });
  const nodesOf = (c: Ctx): Obj[] => canvas.state(c.projectId).nodes ?? [];
  const publicShape = ({ name, branch, path: p, head, ahead, behind, changed, nodeIds }: Floor) => ({ name, branch, path: p, head, ahead, behind, changed, nodeIds });

  async function find(c: Ctx, name: string) {
    const baseName = await baseBranch(c.repo);
    const w = (await list(c.repo, baseName, nodesOf(c))).find((x) => x.name === name);
    if (!w) throw new ApiError(404, `Andar "${name}" não encontrado.`);
    return { w, baseName };
  }

  fastify.get(base, wrap(async (c) => {
    const baseName = await baseBranch(c.repo);
    return { base: baseName, worktrees: (await list(c.repo, baseName, nodesOf(c))).map(publicShape) };
  }));

  fastify.post(base, wrap((c, req, reply) => locked(c.repo, async () => {
    const { nodeId, name: rawName } = req.body ?? {};
    if (rawName !== undefined && rawName !== null) validName(rawName);
    const node = typeof nodeId === "string" ? nodesOf(c).find((n) => n.id === nodeId) : undefined;
    if (!node || node.type !== "agentTerminal") throw new ApiError(404, "Nó de agente não encontrado.");
    if (node.data?.worktree) throw new ApiError(409, `O nó já tem um andar (${node.data.worktree}).`);

    const baseName = await baseBranch(c.repo);
    const taken = async (n: string) =>
      fs.existsSync(path.join(c.repo, ".worktrees", n)) || (await git(c.repo, ["branch", "--list", `agent/${n}`])).trim() !== "";
    let name: string;
    if (typeof rawName === "string") {
      name = rawName.toLowerCase();
      if (await taken(name)) throw new ApiError(409, `Já existe um andar chamado "${name}".`);
    } else {
      name = slug(String(node.data?.title ?? node.id));
      if (await taken(name)) {
        const stem = name.slice(0, 55);
        do name = `${stem}-${Math.random().toString(16).slice(2, 6)}`;
        while (await taken(name));
      }
    }

    const wtPath = path.join(c.repo, ".worktrees", name);
    fs.mkdirSync(path.dirname(wtPath), { recursive: true });
    const branch = `agent/${name}`;
    try {
      await git(c.repo, ["worktree", "add", "-b", branch, wtPath, baseName]);
    } catch (e: any) {
      throw new ApiError(500, `Falha ao criar o andar: ${e.message}`);
    }

    canvas.applyAndBroadcast(c.projectId, { kind: "patchNodeData", id: node.id, data: { worktree: name, branch, worktreePath: wtPath } }, "worktrees");
    sessions.restart(c.projectId, node.id, wtPath);
    notifyChange(c);
    const worktree = (await list(c.repo, baseName, nodesOf(c))).find((x) => x.name === name)!;
    return reply.status(201).send({ worktree: publicShape(worktree) });
  })));

  fastify.get(`${base}/:name/diff`, wrap(async (c, req) => {
    const name = validName(req.params.name);
    const { w, baseName } = await find(c, name);
    const mergeBase = (await git(w.path, ["merge-base", baseName, "HEAD"])).trim();

    const files: { path: string; status: string; additions: number; deletions: number }[] = [];
    const statuses = (await git(w.path, ["diff", "--no-renames", "--name-status", "-z", mergeBase])).split("\0").filter(Boolean);
    for (let i = 0; i + 1 < statuses.length; i += 2) {
      const s = statuses[i][0];
      files.push({ path: statuses[i + 1], status: FILE_STATUS.has(s) ? s : "M", additions: 0, deletions: 0 });
    }
    for (const row of (await git(w.path, ["diff", "--no-renames", "--numstat", "-z", mergeBase])).split("\0").filter(Boolean)) {
      const [a, d, ...p] = row.split("\t");
      const f = files.find((x) => x.path === p.join("\t"));
      if (f) Object.assign(f, { additions: Number(a) || 0, deletions: Number(d) || 0 });
    }

    let patch = await git(w.path, ["diff", "--no-renames", mergeBase]);
    for (const p of (await git(w.path, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean)) {
      // --no-index sai com 1 quando há diferença: o patch vem em stdout
      const one = await git(w.path, ["diff", "--no-index", "--", "/dev/null", p]).catch((e: GitError) => (e.code === 1 ? e.stdout : ""));
      files.push({ path: p, status: "?", additions: lines(one).filter((l) => l.startsWith("+") && !l.startsWith("+++")).length, deletions: 0 });
      if (patch.length <= PATCH_MAX) patch += one;
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    const truncated = patch.length > PATCH_MAX;
    return { base: baseName, files, patch: truncated ? patch.slice(0, PATCH_MAX) : patch, ...(truncated ? { truncated: true } : {}) };
  }));

  fastify.post(`${base}/:name/land`, wrap((c, req) => locked(c.repo, async () => {
    const name = validName(req.params.name);
    const message = req.body?.message;
    if (message !== undefined && (typeof message !== "string" || !message.trim() || message.length > 2000)) throw new ApiError(400, "Mensagem inválida.");
    const { w } = await find(c, name);

    // Só arquivos rastreados importam para o merge; untracked colidindo faz o próprio merge falhar (tratado abaixo)
    if ((await git(c.repo, ["status", "--porcelain", "--untracked-files=no"])).trim()) {
      throw new ApiError(409, "O worktree principal tem alterações não commitadas; commite ou descarte antes de fazer land.");
    }

    const env = await ensureIdentity(c.repo);
    if (w.changed > 0) {
      try {
        await git(w.path, ["add", "-A"]);
        await git(w.path, ["commit", "-m", message?.trim() || `maestri: land ${name}`], env);
      } catch (e: any) {
        throw new ApiError(409, `Falha ao commitar o andar: ${e.message}`);
      }
    }

    try {
      await git(c.repo, ["merge", "--no-ff", "-m", `Merge ${w.branch}`, w.branch], env);
    } catch (e: any) {
      const conflict = await git(c.repo, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).then(() => true, () => false);
      if (conflict) await git(c.repo, ["merge", "--abort"]).catch(() => {});
      throw new ApiError(409, conflict ? `Conflito ao fazer merge de ${w.branch}; merge abortado, o principal não mudou.` : `Falha no merge: ${e.message}`);
    }
    notifyChange(c);
    return { ok: true, merged: (await git(c.repo, ["rev-parse", "HEAD"])).trim() };
  })));

  fastify.delete(`${base}/:name`, wrap((c, req) => locked(c.repo, async () => {
    const name = validName(req.params.name);
    const force = ["1", "true"].includes(String(req.query?.force ?? ""));
    const { w } = await find(c, name);
    if (!force && (w.changed > 0 || w.ahead > 0)) {
      throw new ApiError(409, `O andar tem trabalho não landado (${w.changed} alterado(s), ${w.ahead} commit(s) à frente); use force=1 para apagar mesmo assim.`);
    }

    const linked = nodesOf(c).filter((n) => n.data?.worktree === name);
    try {
      await git(c.repo, ["worktree", "remove", "--force", w.path]);
      await git(c.repo, ["branch", "-D", w.branch]);
    } catch (e: any) {
      throw new ApiError(500, `Falha ao remover o andar: ${e.message}`);
    } finally {
      // Os agentes voltam ao repositório principal (PTY recriado fora do diretório removido)
      for (const n of nodesOf(c).filter((x) => linked.some((l) => l.id === x.id) && x.data?.worktree === name)) {
        const { worktree: _w, branch: _b, worktreePath: _p, ...data } = n.data;
        canvas.applyAndBroadcast(c.projectId, { kind: "upsertNodes", nodes: [{ ...n, data }] }, "worktrees");
        sessions.restart(c.projectId, n.id, c.repo);
      }
      notifyChange(c);
    }
    return { ok: true };
  })));
}
