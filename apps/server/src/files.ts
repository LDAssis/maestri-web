import { gitExecFile } from "./runAs.js";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { isInside } from "./projectDirs.js";
import { listByWalk, listIgnored, type ListedFile } from "./fileList.js";

interface Deps {
  fastify: FastifyInstance;
  projectRepo: (projectId: string) => string | null;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const FILES_MAX = 20_000;
const CONTENT_MAX = 1024 * 1024;

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    gitExecFile(cwd, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout),
    );
  });
}

// O destino REAL (depois de resolver symlinks) passa por dentro de .git? (o bloqueio lexical do safeRelPath não vê um link para .git/config)
export function hasGitPart(root: string, real: string) {
  return path.relative(root, real).split(path.sep).some((s) => s.toLowerCase() === ".git");
}

// Abre o arquivo SEM seguir symlink no último componente e confere, pelo próprio descritor, que ele está dentro da raiz (Linux:
// /proc/self/fd). Fecha a janela entre o realpath e a leitura: trocar o link depois da checagem não leva a outro arquivo.
export function openInside(root: string, real: string): number {
  const fd = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    if (process.platform === "linux") {
      const actual = fs.realpathSync(`/proc/self/fd/${fd}`).replace(/ \(deleted\)$/, "");
      if (!isInside(root, actual) || hasGitPart(root, actual)) throw new ApiError(403, "O arquivo está fora da raiz.");
    }
    return fd;
  } catch (e) {
    fs.closeSync(fd);
    throw e;
  }
}

// Caminho relativo seguro (lexicalmente): sem absolutos, "..", NUL nem o diretório .git
export function safeRelPath(p: unknown): string {
  if (typeof p !== "string" || !p || p.includes("\0")) throw new ApiError(400, "Informe o path.");
  if (path.isAbsolute(p) || /^[a-z]:[\\/]/i.test(p) || p.startsWith("\\")) throw new ApiError(400, "O path deve ser relativo.");
  const parts = p.split(/[\\/]+/).filter((s) => s && s !== ".");
  if (!parts.length || parts.includes("..")) throw new ApiError(400, "Path inválido.");
  if (parts.includes(".git")) throw new ApiError(400, "Path inválido.");
  return parts.join("/");
}

function statusLetter(xy: string) {
  if (xy === "??") return "?";
  if (xy.includes("D")) return "D";
  if (xy.includes("A")) return "A";
  return "M";
}

// Projeto + raiz (main ou andar) -> realpath do diretório; lança ApiError
export function resolveRoot(projectRepo: (id: string) => string | null, projectId: string, rootParam: unknown) {
  if (!/^[\w-]+$/.test(projectId)) throw new ApiError(400, "Ids inválidos.");
  const repo = projectRepo(projectId);
  if (!repo) throw new ApiError(404, "Projeto não encontrado.");
  const root = rootParam === undefined ? "main" : rootParam;
  if (typeof root !== "string" || (root !== "main" && !NAME_RE.test(root))) throw new ApiError(400, "Raiz inválida (main ou nome de um andar).");
  const d = root === "main" ? repo : path.join(repo, ".worktrees", root);
  if (root !== "main" && !(fs.existsSync(d) && fs.statSync(d).isDirectory())) throw new ApiError(404, `Andar "${root}" não encontrado.`);
  const dir = fs.realpathSync(d);
  if (!isInside(fs.realpathSync(repo), dir)) throw new ApiError(404, `Andar "${root}" não encontrado.`);
  return { repo, root, dir };
}

export function registerFilesApi({ fastify, projectRepo }: Deps) {
  const wrap = (fn: (c: { repo: string; root: string; dir: string }, req: any) => any) =>
    async (req: any, reply: FastifyReply) => {
      try {
        const { repo, root, dir } = resolveRoot(projectRepo, String(req.params.p), req.query?.root);
        return await fn({ repo, root, dir }, req);
      } catch (e: any) {
        if (e instanceof ApiError) return reply.status(e.status).send({ error: e.message });
        req.log.error(e);
        return reply.status(500).send({ error: e?.message || "Erro interno." });
      }
    };

  fastify.get("/api/projects/:p/files", wrap(async ({ root, dir }) => {
    let list: ListedFile[];
    try {
      const [tracked, status] = await Promise.all([
        git(dir, ["ls-files", "-co", "--exclude-standard", "-z"]),
        git(dir, ["status", "--porcelain", "-z"]),
      ]);
      const statuses = new Map<string, string>();
      const entries = status.split("\0");
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (e.length < 4) continue;
        const xy = e.slice(0, 2);
        statuses.set(e.slice(3), statusLetter(xy));
        if (xy.includes("R") || xy.includes("C")) i++; // próximo token é o caminho de origem
      }
      const paths = new Set(tracked.split("\0").filter(Boolean));
      for (const [p, s] of statuses) if (s === "D") paths.add(p); // removidos do índice não aparecem no ls-files
      list = [...paths].map((p) => (statuses.has(p) ? { path: p, status: statuses.get(p)! } : { path: p }));
      list.push(...(await listIgnored(dir, FILES_MAX + 1).catch(() => [])));
    } catch {
      list = listByWalk(dir, FILES_MAX); // não é repositório git
    }
    list.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
    const truncated = list.length > FILES_MAX;
    return { root, files: list.slice(0, FILES_MAX), ...(truncated ? { truncated: true } : {}) };
  }));

  fastify.get("/api/projects/:p/files/content", wrap(async ({ dir }, req) => {
    const rel = safeRelPath(req.query?.path);
    const abs = path.join(dir, rel);
    let real: string;
    try {
      real = fs.realpathSync(abs);
    } catch {
      throw new ApiError(404, "Arquivo não encontrado.");
    }
    const inside = path.relative(dir, real);
    if (inside.startsWith("..") || path.isAbsolute(inside)) throw new ApiError(403, "O arquivo está fora da raiz.");
    if (hasGitPart(dir, real)) throw new ApiError(403, "O diretório .git não é exposto.");
    let fd: number;
    try {
      fd = openInside(dir, real);
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(404, "Arquivo não encontrado.");
    }
    let buf: Buffer;
    let st: fs.Stats;
    try {
      st = fs.fstatSync(fd);
      if (!st.isFile()) throw new ApiError(400, "O path não é um arquivo.");
      if (st.size > CONTENT_MAX) throw new ApiError(413, `Arquivo grande demais (${st.size} bytes; máximo ${CONTENT_MAX}).`);
      buf = fs.readFileSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (buf.subarray(0, 8192).includes(0)) return { path: rel, size: st.size, binary: true };
    return { path: rel, content: buf.toString("utf8"), size: st.size, binary: false };
  }));
}
