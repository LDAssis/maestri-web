import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";

interface Deps {
  fastify: FastifyInstance;
  projectRepo: (projectId: string) => string | null;
}

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const FILES_MAX = 20_000;
const CONTENT_MAX = 1024 * 1024;

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout),
    );
  });
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

export function registerFilesApi({ fastify, projectRepo }: Deps) {
  const wrap = (fn: (c: { repo: string; root: string; dir: string }, req: any) => any) =>
    async (req: any, reply: FastifyReply) => {
      try {
        const projectId = String(req.params.p);
        if (!/^[\w-]+$/.test(projectId)) throw new ApiError(400, "Ids inválidos.");
        const repo = projectRepo(projectId);
        if (!repo) throw new ApiError(404, "Projeto não encontrado.");
        const root = req.query?.root === undefined ? "main" : req.query.root;
        if (typeof root !== "string" || (root !== "main" && !NAME_RE.test(root))) throw new ApiError(400, "Raiz inválida (main ou nome de um andar).");
        const dir = root === "main" ? repo : path.join(repo, ".worktrees", root);
        if (root !== "main" && !(fs.existsSync(dir) && fs.statSync(dir).isDirectory())) throw new ApiError(404, `Andar "${root}" não encontrado.`);
        return await fn({ repo, root, dir: fs.realpathSync(dir) }, req);
      } catch (e: any) {
        if (e instanceof ApiError) return reply.status(e.status).send({ error: e.message });
        req.log.error(e);
        return reply.status(500).send({ error: e?.message || "Erro interno." });
      }
    };

  fastify.get("/api/projects/:p/files", wrap(async ({ root, dir }) => {
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
    const sorted = [...paths].sort();
    const truncated = sorted.length > FILES_MAX;
    const files = sorted.slice(0, FILES_MAX).map((p) => (statuses.has(p) ? { path: p, status: statuses.get(p)! } : { path: p }));
    return { root, files, ...(truncated ? { truncated: true } : {}) };
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
    const st = fs.statSync(real);
    if (!st.isFile()) throw new ApiError(400, "O path não é um arquivo.");
    if (st.size > CONTENT_MAX) throw new ApiError(413, `Arquivo grande demais (${st.size} bytes; máximo ${CONTENT_MAX}).`);
    const buf = fs.readFileSync(real);
    if (buf.subarray(0, 8192).includes(0)) return { path: rel, size: st.size, binary: true };
    return { path: rel, content: buf.toString("utf8"), size: st.size, binary: false };
  }));
}
