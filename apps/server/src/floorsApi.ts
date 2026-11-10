import { desktopNotify } from "./desktopNotify.js";
import { execFile } from "node:child_process";
import { ghExecFile, fsOpsAt, mkdirOwned, ensureWorktreesExcluded } from "./runAs.js";
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
// GitHub CLI (gh): erros viram mensagens claras; o JSON de `gh pr view` vem em stdout
function gh(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    ghExecFile(cwd, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 30_000 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      if ((err as any).code === "ENOENT") return reject(new ApiError(409, "O GitHub CLI (gh) não está instalado ou não está no PATH."));
      const msg = (stderr || stdout || err.message).trim();
      if (/gh auth login|not logged in|authentication|GH_TOKEN/i.test(msg)) return reject(new ApiError(409, "O gh não está autenticado (rode `gh auth login`)."));
      reject(new ApiError(409, `gh falhou: ${msg}`));
    });
  });
}

// Só http/https vira link (a URL vem do gh e é guardada no andar)
export const safeHttpUrl = (v: unknown) => {
  try {
    const u = new URL(String(v ?? ""));
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : "";
  } catch {
    return "";
  }
};

// Conta os checks de um PR (statusCheckRollup do gh)
export function tallyChecks(rollup: unknown) {
  const checks = { passing: 0, failing: 0, pending: 0 };
  for (const c of (Array.isArray(rollup) ? rollup : []) as Record<string, any>[]) {
    const v = String(c.conclusion || c.state || c.status || "").toUpperCase();
    if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(v)) checks.passing++;
    else if (["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(v)) checks.failing++;
    else checks.pending++;
  }
  return checks;
}

// "42", "#42" ou link do PR → número
export function parsePrRef(v: unknown): number {
  const s = String(v ?? "").trim();
  const m = /^#?(\d+)$/.exec(s) ?? /\/(?:pull|pulls)\/(\d+)(?:[/?#].*)?$/.exec(s);
  if (!m || Number(m[1]) < 1) throw new ApiError(400, "Pull request inválido (use o número, #número ou o link).");
  return Number(m[1]);
}

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
      // Como o usuário do projeto e SEM seguir symlink: um arquivo "não rastreado" que é link para um arquivo de root não vira cópia
      const todo = files.filter((rel) => !SKIP_COPY.test(rel));
      const res = fsOpsAt(repo, todo.map((rel) => ({ op: "copy" as const, src: path.join(repo, rel), dest: path.join(dest, rel) })));
      todo.forEach((rel, i) => res[i] === true && copied.push(rel));
    } catch {}
    return copied;
  }

  async function hideWorktrees(repo: string) {
    const exclude = path.resolve(repo, (await git(repo, ["rev-parse", "--git-path", "info/exclude"])).trim());
    ensureWorktreesExcluded(exclude);
  }

  // --- listar ---
  async function list(projectId: string) {
    const repo = repoOf(projectId);
    const nodes = nodesOf(projectId);
    const count = (name: string) => nodes.filter((n) => sameFloor(floorOf(n), name)).length;
    const f = floors.read(projectId);
    return [
      { name: GROUND, ground: true, git: true, branch: await currentBranch(repo), path: repo, nodes: count(GROUND), status: f.ground ?? null },
      ...f.floors.map((x) => ({ name: x.name, ground: false, git: x.git, branch: x.branch, path: x.path ?? repo, nodes: count(x.name), status: x.status ?? null, copy: x.copy === true, pullRequest: x.pullRequest ?? null })),
    ];
  }

  // --- criar ---
  interface CreateOpts { name?: unknown; branch?: unknown; existingBranch?: boolean; noGit?: boolean; copyGround?: boolean; copy?: boolean; pullRequest?: unknown }

  const branchExists = (repo: string, b: string) => git(repo, ["rev-parse", "-q", "--verify", `refs/heads/${b}`]).then(() => true, () => false);

  // Pull request: valida com o gh, traz a branch para o repositório e devolve a branch do andar
  async function resolvePullRequest(repo: string, ref: unknown) {
    const n = parsePrRef(ref);
    let pr: Obj;
    try {
      pr = JSON.parse(await gh(repo, ["pr", "view", String(n), "--json", "number,title,state,url,headRefName,headRepositoryOwner,isCrossRepository"]));
    } catch (e: any) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(409, "Resposta inesperada do gh.");
    }
    if (String(pr.state).toUpperCase() !== "OPEN") throw new ApiError(409, `O pull request #${n} não está aberto (${String(pr.state).toLowerCase()}).`);
    return { number: n, title: String(pr.title ?? ""), url: safeHttpUrl(pr.url), head: String(pr.headRefName ?? ""), fork: pr.isCrossRepository === true };
  }

  async function fetchPrBranch(repo: string, pr: { number: number; head: string; fork: boolean }) {
    if (pr.fork) {
      const branch = `pr-${pr.number}`;
      try {
        await git(repo, ["fetch", "origin", `pull/${pr.number}/head:${branch}`]);
      } catch (e: any) {
        throw new ApiError(409, `Não foi possível trazer o pull request #${pr.number} (a branch local ${branch} divergiu ou está em uso?): ${e.message}`);
      }
      return { branch, note: `Pull request de fork: o andar tem uma cópia dos commits em ${branch}; commits feitos aqui não chegam ao PR.` };
    }
    const branch = pr.head;
    if (!(await git(repo, ["check-ref-format", "--branch", branch]).then(() => true, () => false))) throw new ApiError(409, `Branch do PR inválida: ${branch}`);
    try {
      await git(repo, ["fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
    } catch (e: any) {
      throw new ApiError(409, `Não foi possível trazer a branch ${branch} do PR: ${e.message}`);
    }
    const remote = (await git(repo, ["rev-parse", `refs/remotes/origin/${branch}`])).trim();
    if (await branchExists(repo, branch)) {
      if ((await git(repo, ["rev-parse", `refs/heads/${branch}`])).trim() !== remote) throw new ApiError(409, `A branch local ${branch} divergiu da do pull request; alinhe-a antes de criar o andar.`);
    } else await git(repo, ["branch", "--track", branch, `refs/remotes/origin/${branch}`]);
    return { branch, note: `Andar na branch ${branch} do pull request; commits enviados dela vão para o PR.` };
  }

  // Clone completo e isolado (--copy): pode estar na mesma branch do térreo
  async function cloneFloor(repo: string, dest: string, branch: string | undefined, existing: boolean) {
    try {
      await git(repo, ["clone", "--local", "-q", repo, dest]);
      if (branch !== undefined) await git(dest, existing ? ["checkout", "-q", branch] : ["checkout", "-q", "-b", branch]);
    } catch (e: any) {
      fs.rmSync(dest, { recursive: true, force: true });
      throw new ApiError(409, `Falha ao clonar o andar: ${e.message}`);
    }
    return (await git(dest, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  }

  const createFloor = (projectId: string, o: CreateOpts) => {
    const repo = repoOf(projectId);
    return locked(repo, async () => {
      const gitOk = await isGitRepo(repo);
      let pr: Awaited<ReturnType<typeof resolvePullRequest>> | null = null;
      if (o.pullRequest !== undefined) {
        if (o.noGit || o.branch !== undefined || o.existingBranch) throw new ApiError(400, "--pull-request não combina com --branch, --existing-branch nem --no-git.");
        if (!gitOk) throw new ApiError(409, "O projeto não é um repositório git; não há como revisar um pull request.");
        pr = await resolvePullRequest(repo, o.pullRequest);
        if (floors.read(projectId).floors.some((f) => f.pullRequest?.number === pr!.number)) throw new ApiError(409, `O pull request #${pr.number} já tem um andar.`);
      }
      const rawName = o.name !== undefined && o.name !== null && o.name !== "" ? o.name : pr ? `#${pr.number} ${pr.title}`.slice(0, NAME_MAX).trim() : undefined;
      if (!isText(rawName, 400) || !rawName.trim()) throw new ApiError(400, "Informe o nome do andar.");
      const name = rawName.trim();
      if (name.length > NAME_MAX || /[\x00-\x1f]/.test(name)) throw new ApiError(400, `Nome inválido (até ${NAME_MAX} caracteres, sem controle).`);
      if (sameFloor(name, GROUND) || floors.find(projectId, name)) throw new ApiError(409, `Já existe um andar chamado "${name}".`);
      if (o.branch !== undefined && (!isText(o.branch, 200) || !o.branch.trim())) throw new ApiError(400, "Branch inválida.");
      if (o.noGit && (o.branch !== undefined || o.existingBranch)) throw new ApiError(400, "--no-git não combina com --branch/--existing-branch.");
      if (o.noGit && o.copy) throw new ApiError(400, "--no-git não combina com --copy.");

      let floor: Floor = { name, git: false, branch: null, path: null, createdAt: new Date().toISOString() };
      let note = "";
      if (o.noGit) note = "Andar sem git: compartilha o diretório do térreo.";
      else if (!gitOk) note = "O projeto não é um repositório git: andar sem isolamento (compartilha o diretório do térreo).";
      else {
        let branch: string | undefined;
        let existing = !!o.existingBranch;
        if (pr) {
          const r = await fetchPrBranch(repo, pr);
          branch = r.branch;
          existing = true;
          note = r.note;
        } else if (typeof o.branch === "string") branch = o.branch.trim();
        else if (!o.copy) branch = slug(name);
        // --copy sem --branch: o clone fica na mesma branch do térreo
        if (branch !== undefined && !pr) {
          if (!(await git(repo, ["check-ref-format", "--branch", branch]).then(() => true, () => false))) throw new ApiError(400, `Nome de branch inválido: ${branch}`);
          const exists = await branchExists(repo, branch);
          if (existing && !exists) throw new ApiError(404, `A branch "${branch}" não existe.`);
          if (!existing && exists) throw new ApiError(409, `A branch "${branch}" já existe (use --existing-branch para usá-la).`);
        }
        let dir = slug(name);
        for (let n = 2; fs.existsSync(path.join(repo, ".worktrees", dir)); n++) dir = `${slug(name)}-${n}`;
        const dest = path.join(repo, ".worktrees", dir);
        mkdirOwned(path.dirname(dest));
        await hideWorktrees(repo);
        let finalBranch: string;
        if (o.copy) {
          finalBranch = await cloneFloor(repo, dest, branch, existing);
        } else {
          try {
            await git(repo, existing ? ["worktree", "add", dest, branch!] : ["worktree", "add", "-b", branch!, dest, "HEAD"]);
          } catch (e: any) {
            throw new ApiError(409, `Falha ao criar o andar: ${e.message}`);
          }
          finalBranch = branch!;
        }
        const copied = await copyUntracked(repo, dest);
        floor = { ...floor, git: true, branch: finalBranch, path: fs.realpathSync(dest), copied, ...(o.copy && { copy: true }), ...(pr && { pullRequest: { number: pr.number, url: pr.url, title: pr.title } }) };
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
    if (f.copy && f.path) {
      // Clone isolado: é só apagar o diretório (a branch dele não existe no repositório)
      fs.rmSync(f.path, { recursive: true, force: true });
    } else if (f.git && f.path) {
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

  // Traz a branch do clone para um ref temporário do repositório; devolve o ref
  async function fetchClone(repo: string, f: Floor) {
    const ref = `refs/maestri/land/${slug(f.name)}`;
    await git(repo, ["fetch", "-q", f.path!, `+refs/heads/${f.branch}:${ref}`]);
    return ref;
  }
  const dropRef = (repo: string, ref: string) => git(repo, ["update-ref", "-d", ref]).catch(() => {});

  // Commits do clone que ainda não estão na branch atual do térreo
  async function copyAhead(repo: string, f: Floor) {
    if (!f.path || !fs.existsSync(f.path)) return 0;
    const ref = await fetchClone(repo, f);
    try {
      return Number((await git(repo, ["rev-list", "--count", `HEAD..${ref}`]).catch(() => "0")).trim()) || 0;
    } finally {
      await dropRef(repo, ref);
    }
  }

  // Guarda o trabalho do clone numa branch do repositório (nome do andar se livre, senão maestri/<slug>)
  async function preserveClone(repo: string, f: Floor) {
    const ref = await fetchClone(repo, f);
    try {
      const name = !(await branchExists(repo, f.branch!)) ? f.branch! : `maestri/${slug(f.name)}`;
      await git(repo, ["branch", "-f", name, ref]);
      return name;
    } finally {
      await dropRef(repo, ref);
    }
  }

  const deleteFloor = (projectId: string, name: unknown, o: { keepBranch: boolean; force: boolean }) => {
    const repo = repoOf(projectId);
    return locked(repo, async () => {
      const f = getFloor(projectId, name);
      if (f.git && f.path && !o.force) {
        if (fs.existsSync(f.path) && (await dirty(f.path, false, f.copied))) throw new ApiError(409, `O andar "${f.name}" tem alterações não commitadas; commite/descarte ou use --force.`);
        const ahead = f.copy ? await copyAhead(repo, f) : await unmerged(repo, f);
        if (!o.keepBranch && ahead > 0) throw new ApiError(409, `A branch ${f.branch} tem ${ahead} commit(s) fora de ${await currentBranch(repo)}; use --keep-branch para preservá-la ou --force.`);
      }
      let kept: string | null = f.git && !f.copy && o.keepBranch ? f.branch : null;
      // Clone: --keep-branch traz os commits para o repositório numa branch antes de apagar o clone
      if (f.copy && o.keepBranch && f.path && fs.existsSync(f.path)) kept = await preserveClone(repo, f);
      await removeFloor(projectId, f, { deleteBranch: !o.keepBranch, force: o.force });
      return { ok: true, branch: kept };
    });
  };

  // --- land ---
  const landFloor = (projectId: string, name: unknown, o: { into?: string; deleteBranch: boolean; keepFloor: boolean }) => {
    const repo = repoOf(projectId);
    return locked(repo, async () => {
      const f = getFloor(projectId, name);
      if (!f.git || !f.path || !f.branch) throw new ApiError(409, `O andar "${f.name}" não tem isolamento git; não há o que landar (use delete).`);
      if (f.copy && o.deleteBranch) throw new ApiError(400, "--delete-branch não se aplica a andares --copy (a branch vive no clone).");
      if (o.deleteBranch && !o.into) throw new ApiError(400, "--delete-branch só vale junto com --into.");
      if (o.deleteBranch && o.keepFloor) throw new ApiError(400, "--delete-branch não combina com --keep-floor (a branch está em uso pelo andar).");
      if (fs.existsSync(f.path) && (await dirty(f.path, false, f.copied))) throw new ApiError(409, `O andar "${f.name}" tem trabalho não commitado; peça ao agente para commitar e tente de novo.`);
      if (await dirty(repo, true)) throw new ApiError(409, "O térreo tem alterações não commitadas; commite ou descarte antes de fazer land.");

      let merged: string | null = null;
      if (f.copy) {
        // Clone: traz o trabalho de volta (fetch) e faz fast-forward/merge na branch alvo; sem --into, na branch do andar
        const ref = await fetchClone(repo, f);
        try {
          const target = o.into ?? ((await branchExists(repo, f.branch)) ? f.branch : null);
          if (o.into && !(await branchExists(repo, o.into))) throw new ApiError(404, `A branch "${o.into}" não existe.`);
          if (target === null) {
            await git(repo, ["branch", f.branch, ref]);
            merged = (await git(repo, ["rev-parse", f.branch])).trim();
          } else merged = await mergeInto(repo, ref, target, f.branch, true);
        } finally {
          await dropRef(repo, ref);
        }
      } else if (o.into) {
        if (!(await git(repo, ["rev-parse", "--verify", "-q", `refs/heads/${o.into}`]).then(() => true, () => false))) throw new ApiError(404, `A branch "${o.into}" não existe.`);
        if (o.into === f.branch) throw new ApiError(400, "--into não pode ser a própria branch do andar.");
        merged = await mergeInto(repo, f.branch, o.into, f.branch);
      }
      if (!o.keepFloor) await removeFloor(projectId, f, { deleteBranch: o.deleteBranch, force: true });
      else changed(projectId);
      return { ok: true, branch: o.deleteBranch ? null : f.branch, into: o.into ?? (f.copy ? f.branch : null), merged, floorKept: o.keepFloor, copy: f.copy === true };
    });
  };

  // Merge de `branch` em `into`; se `into` não é a branch do térreo, usa uma worktree temporária
  // `ref` pode ser branch ou ref qualquer; `label` aparece na mensagem; `ff` tenta fast-forward antes do merge
  async function mergeInto(repo: string, ref: string, into: string, label = ref, ff = false) {
    const branch = ref;
    const env = { GIT_AUTHOR_NAME: "Maestri", GIT_AUTHOR_EMAIL: "maestri@localhost", GIT_COMMITTER_NAME: "Maestri", GIT_COMMITTER_EMAIL: "maestri@localhost" };
    const identity = async (cwd: string) => {
      const has = async (k: string) => (await git(cwd, ["config", k]).catch(() => "")).trim() !== "";
      return (await has("user.name")) && (await has("user.email")) ? {} : env;
    };
    const attempt = async (cwd: string) => {
      try {
        const fastForward = ff && (await git(cwd, ["merge-base", "--is-ancestor", "HEAD", branch]).then(() => true, () => false));
        await git(cwd, fastForward ? ["merge", "--ff-only", branch] : ["merge", "--no-ff", "-m", `Merge ${label}`, branch], await identity(cwd));
      } catch (e: any) {
        const files = (await git(cwd, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "")).split("\n").filter(Boolean);
        await git(cwd, ["merge", "--abort"]).catch(() => {});
        throw new ApiError(409, files.length ? `Conflito ao fazer merge de ${label} em ${into} (${files.join(", ")}); nada foi alterado.` : `Falha no merge: ${e.message}`);
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
      const msg = `${floorName}: ${state}${status.text ? ` — ${status.text}` : ""}`;
      canvas.notify(projectId, { type: "notify", from, text: msg });
      desktopNotify(projectId, `Maestri — ${from.title}`, msg);
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
    return createFloor(p, { name: b.name, branch: b.branch, existingBranch: flag(b.existingBranch), noGit: flag(b.noGit), copyGround: flag(b.copyGround), copy: flag(b.copy), pullRequest: b.pullRequest }); 
  }));
  fastify.post(`${uiBase}/:name/land`, guard((p, req) => landFloor(p, req.params.name, { into: req.body?.into || undefined, deleteBranch: flag(req.body?.deleteBranch), keepFloor: flag(req.body?.keepFloor) })));
  fastify.delete(`${uiBase}/:name`, guard((p, req) => deleteFloor(p, req.params.name, { keepBranch: flag(req.query?.keepBranch), force: flag(req.query?.force) })));
  // Estado do pull request do andar (gh pr view): review e checks
  fastify.get(`${uiBase}/:name/pr`, guard(async (p, req) => {
    const f = getFloor(p, req.params.name);
    if (!f.pullRequest) throw new ApiError(404, `O andar "${f.name}" não é de um pull request.`);
    const raw = JSON.parse(await gh(repoOf(p), ["pr", "view", String(f.pullRequest.number), "--json", "number,title,state,url,reviewDecision,statusCheckRollup"]));
    const checks = tallyChecks(raw.statusCheckRollup);
    return { number: raw.number, title: raw.title, state: raw.state, url: raw.url, review: raw.reviewDecision || null, checks };
  }));
  // Mescla o PR do andar com `gh pr merge` (merge|squash|rebase); com checks falhando/pendentes só após confirmar (force)
  fastify.post(`${uiBase}/:name/pr/merge`, async (req: any, reply: any) => {
    try {
      const p = req.params.p;
      const f = getFloor(p, req.params.name);
      if (!f.pullRequest) throw new ApiError(404, `O andar "${f.name}" não é de um pull request.`);
      const method = req.body?.method ?? "merge";
      if (!["merge", "squash", "rebase"].includes(method)) throw new ApiError(400, "Método inválido (merge, squash ou rebase).");
      const repo = repoOf(p);
      const n = String(f.pullRequest.number);
      const raw = JSON.parse(await gh(repo, ["pr", "view", n, "--json", "state,statusCheckRollup"]));
      if (String(raw.state).toUpperCase() !== "OPEN") throw new ApiError(409, `O pull request #${n} não está aberto (${String(raw.state).toLowerCase()}).`);
      const checks = tallyChecks(raw.statusCheckRollup);
      if ((checks.failing || checks.pending) && !flag(req.body?.force)) {
        return reply.status(409).send({ error: `Checks não estão todos ok (${checks.failing} falhando, ${checks.pending} pendentes); confirme para mesclar mesmo assim.`, needsConfirm: true, checks });
      }
      await gh(repo, ["pr", "merge", n, `--${method}`]);
      changed(p);
      return { ok: true, method, number: f.pullRequest.number };
    } catch (e: any) {
      if (e instanceof ApiError) return reply.status(e.status).send({ error: e.message });
      req.log.error(e);
      return reply.status(500).send({ error: e?.message || "Erro interno." });
    }
  });

  // Andar cuja branch ganhou um PR aberto (feito por um agente, p.ex.) passa a segui-lo como no --pull-request
  const lastDetect = new Map<string, number>();
  async function detectPullRequests(projectId: string, minIntervalMs = 30_000) {
    const repo = repoOf(projectId);
    const ground = await currentBranch(repo);
    let found = 0;
    let unavailable = "";
    const followed: { name: string; number: number }[] = [];
    for (const f of floors.read(projectId).floors) {
      if (!f.git || !f.branch || f.pullRequest || f.branch === ground) continue;
      const key = `${projectId}:${f.name}`;
      if (Date.now() - (lastDetect.get(key) ?? 0) < minIntervalMs) continue;
      lastDetect.set(key, Date.now());
      try {
        const out = JSON.parse(await gh(repo, ["pr", "list", "--head", f.branch, "--state", "open", "--json", "number,url,title", "--limit", "1"]));
        if (out[0]?.number) {
          f.pullRequest = { number: Number(out[0].number), url: safeHttpUrl(out[0].url), title: String(out[0].title ?? "") };
          found++;
          followed.push({ name: f.name, number: f.pullRequest.number });
        }
      } catch (e: any) {
        if (e instanceof ApiError) {
          unavailable = e.message; // gh ausente/sem login: não adianta insistir nos outros andares
          break;
        }
      }
    }
    if (found) {
      floors.save(projectId);
      changed(projectId);
      // Avisa: toast no canvas e notificação do sistema (se ligada)
      for (const { name, number } of followed) {
        const text = `Andar ${name} agora segue o PR #${number}`;
        canvas.notify(projectId, { type: "notify", from: { nodeId: "", title: name }, text });
        desktopNotify(projectId, "Maestri — pull request", text);
      }
    }
    return { found, unavailable };
  }
  fastify.post(`${uiBase}/detect-prs`, guard((p, req) => detectPullRequests(p, flag(req.body?.now) ? 0 : 30_000)));

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
    return createFloor(c.projectId, { name: b.name, branch: b.branch, existingBranch: flag(b.existingBranch), noGit: flag(b.noGit), copyGround: flag(b.copyGround), copy: flag(b.copy), pullRequest: b.pullRequest }); 
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

  return { createFloor, listFloors: list, unloadFloor, setStatus, detectPullRequests };
}
