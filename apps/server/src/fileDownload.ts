// Download de arquivo/pasta/projeto: POST gera um token de uso único (60s); GET /api/downloads/:token é público (o token é a credencial).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { ZipArchive } from "archiver";
import { ApiError, resolveRoot, safeRelPath } from "./files.js";
import { isInside } from "./projectDirs.js";

interface Deps {
  fastify: FastifyInstance;
  projectRepo: (projectId: string) => string | null;
}

const HEAVY = new Set(["node_modules", ".next", ".worktrees", "dist", "build", ".turbo", ".cache", ".git"]);
// Segredos fora do .zip por padrão: .env e .env.* (exceto modelos como .env.example)
export const isSecretFile = (name: string) => /^.env(..+)?$/i.test(name) && !/.(example|sample|template|dist)$/i.test(name);
const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ENTRIES = 200_000;
const MIME: Record<string, string> = {
  ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".json": "application/json", ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".ts": "text/plain; charset=utf-8", ".csv": "text/csv; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".pdf": "application/pdf", ".zip": "application/zip",
};

interface Entry {
  kind: "file" | "zip";
  dir: string; // realpath da raiz
  real: string; // realpath do alvo
  name: string;
  excludeHeavy: boolean;
  excludeSecrets: boolean;
  expires: number;
}

const ttl = () => {
  const n = Number(process.env.MAESTRI_DOWNLOAD_TTL_MS);
  return Number.isFinite(n) && n > 0 ? n : 60_000;
};

// Só esta rota escapa do token de auth (o navegador baixa por <a href>, sem header)
export const isPublicDownload = (method: string, pathname: string) => method === "GET" && /^\/api\/downloads\/[^/]+$/.test(pathname);

function disposition(name: string) {
  const ascii = name.replace(/[^\x20-\x7e]|["\\%]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())}`;
}

// Arquivos regulares a incluir (relativo, absoluto). Symlinks: só arquivos cujo destino fica dentro da raiz; diretórios-link não são seguidos.
function* walk(dir: string, rootReal: string, excludeHeavy: boolean, excludeSecrets: boolean, rel = ""): Generator<{ rel: string; abs: string; size: number }> {
  let names: fs.Dirent[];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of names) {
    if (excludeHeavy && HEAVY.has(d.name)) continue;
    if (excludeSecrets && !d.isDirectory() && isSecretFile(d.name)) continue;
    const abs = path.join(dir, d.name);
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) yield* walk(abs, rootReal, excludeHeavy, excludeSecrets, r);
    else if (d.isFile()) {
      try {
        yield { rel: r, abs, size: fs.statSync(abs).size };
      } catch {}
    } else if (d.isSymbolicLink()) {
      try {
        const real = fs.realpathSync(abs);
        const st = fs.statSync(real);
        if (st.isFile() && isInside(rootReal, real)) yield { rel: r, abs: real, size: st.size };
      } catch {}
    }
  }
}

export function registerDownloadsApi({ fastify, projectRepo }: Deps) {
  const tokens = new Map<string, Entry>();
  const sweep = () => {
    const now = Date.now();
    for (const [t, e] of tokens) if (e.expires <= now) tokens.delete(t);
  };

  fastify.post("/api/projects/:p/files/download-link", async (req: any, reply) => {
    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const { repo, root, dir } = resolveRoot(projectRepo, String(req.params.p), body.root);
      const excludeHeavy = body.excludeHeavy !== false;
      const excludeSecrets = body.excludeSecrets !== false;
      const p = body.path;
      if (p !== undefined && typeof p !== "string") throw new ApiError(400, "Path inválido.");
      const rel = p ? safeRelPath(p) : "";
      let real: string;
      try {
        real = fs.realpathSync(path.join(dir, rel));
      } catch {
        throw new ApiError(404, "Arquivo ou pasta não encontrado.");
      }
      if (!isInside(dir, real)) throw new ApiError(403, "O caminho está fora da raiz.");
      const st = fs.statSync(real);
      let entry: Omit<Entry, "expires">;
      let size: number | undefined;
      if (st.isFile()) {
        entry = { kind: "file", dir, real, name: path.basename(rel), excludeHeavy, excludeSecrets };
        size = st.size;
      } else if (st.isDirectory()) {
        let total = 0;
        let count = 0;
        for (const f of walk(real, dir, excludeHeavy, excludeSecrets)) {
          total += f.size;
          if (total > MAX_BYTES || ++count > MAX_ENTRIES)
            throw new ApiError(413, `A pasta é grande demais para baixar (limite de 2 GB${excludeHeavy ? "" : "; tente excluir node_modules e .git"}).`);
        }
        const base = rel ? path.basename(rel) : root === "main" ? path.basename(repo) : root;
        entry = { kind: "zip", dir, real, name: `${base || "projeto"}.zip`, excludeHeavy, excludeSecrets };
      } else throw new ApiError(400, "O caminho não é arquivo nem pasta.");
      sweep();
      const token = crypto.randomBytes(32).toString("hex");
      const expires = Date.now() + ttl();
      tokens.set(token, { ...entry, expires });
      setTimeout(() => tokens.delete(token), ttl() + 50).unref();
      return { url: `/api/downloads/${token}`, name: entry.name, kind: entry.kind, ...(size === undefined ? {} : { size }) };
    } catch (e: any) {
      if (e instanceof ApiError) return reply.status(e.status).send({ error: e.message });
      req.log.error({ err: e?.message }, "download-link");
      return reply.status(500).send({ error: e?.message || "Erro interno." });
    }
  });

  fastify.get("/api/downloads/:token", async (req: any, reply) => {
    const token = String(req.params.token);
    const e = tokens.get(token);
    tokens.delete(token); // uso único, mesmo que falhe adiante
    if (!e || e.expires <= Date.now()) return reply.status(404).send({ error: "Link de download inválido, usado ou expirado." });
    try {
      if (!isInside(e.dir, fs.realpathSync(e.real))) throw new Error("fora da raiz"); // revalida (symlink trocado depois do POST)
    } catch {
      return reply.status(404).send({ error: "Arquivo não encontrado." });
    }
    reply.header("Content-Disposition", disposition(e.name)).header("Cache-Control", "no-store");
    if (e.kind === "file") {
      reply.header("Content-Type", MIME[path.extname(e.name).toLowerCase()] ?? "application/octet-stream");
      try {
        reply.header("Content-Length", fs.statSync(e.real).size);
      } catch {
        return reply.status(404).send({ error: "Arquivo não encontrado." });
      }
      return reply.send(fs.createReadStream(e.real));
    }
    const archive = new ZipArchive({ zlib: { level: 6 } });
    archive.on("warning", () => {});
    archive.on("error", (err: Error) => {
      req.log.error({ err: err.message }, "zip");
      archive.destroy();
    });
    reply.raw.on("close", () => archive.destroy());
    const prefix = e.name.replace(/\.zip$/, "");
    for (const f of walk(e.real, e.dir, e.excludeHeavy, e.excludeSecrets)) archive.file(f.abs, { name: `${prefix}/${f.rel}` });
    archive.finalize().catch(() => {});
    reply.header("Content-Type", "application/zip");
    return reply.send(archive);
  });
}
