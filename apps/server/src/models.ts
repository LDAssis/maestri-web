// GET /api/projects/:p/models?cli=claude|codex|opencode|agy -> { models: [{id,label}], source: "static"|"cli"|"none" }
// claude não tem comando de listagem (lista estática); codex/opencode/agy perguntam ao próprio CLI (se existir). Cache de 10 min, timeout de 10 s.
import { execFile } from "node:child_process";
import type { FastifyInstance } from "fastify";
import { ApiError } from "./agents.js";

type Model = { id: string; label: string };
type Result = { models: Model[]; source: "static" | "cli" | "none" };

const TTL_MS = 10 * 60_000;
const TIMEOUT_MS = 10_000;

const CLAUDE: Model[] = [
  { id: "opus", label: "Opus (alias)" },
  { id: "sonnet", label: "Sonnet (alias)" },
  { id: "haiku", label: "Haiku (alias)" },
  { id: "fable", label: "Fable (alias)" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
];

const ID_OK = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}$/;
const asModel = (id: unknown, label?: unknown): Model | null => (typeof id === "string" && ID_OK.test(id) ? { id, label: typeof label === "string" && label.trim() ? label.trim() : id } : null);

// codex debug models: JSON (lista, ou objeto com models/data); cada item é string ou objeto com id/slug/name/model
function fromJson(text: string): Model[] {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  const list: any[] = Array.isArray(raw) ? raw : Array.isArray(raw?.models) ? raw.models : Array.isArray(raw?.data) ? raw.data : [];
  return list.map((m) => (typeof m === "string" ? asModel(m) : asModel(m?.id ?? m?.slug ?? m?.model ?? m?.name, m?.display_name ?? m?.label ?? m?.title ?? m?.name))).filter((m): m is Model => !!m);
}
// opencode/agy models: uma linha por modelo ("provider/modelo" ou "id  rótulo")
function fromLines(text: string): Model[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [id, ...rest] = l.split(/\s+/);
      return asModel(id, rest.join(" "));
    })
    .filter((m): m is Model => !!m);
}

const SOURCES: Record<string, { args: string[]; parse: (out: string) => Model[] }> = {
  codex: { args: ["debug", "models"], parse: fromJson },
  opencode: { args: ["models"], parse: fromLines },
  agy: { args: ["models"], parse: fromLines },
};

const cache = new Map<string, { at: number; value: Result }>();
const NONE: Result = { models: [], source: "none" };

function listFromCli(cli: string): Promise<Result> {
  const spec = SOURCES[cli];
  return new Promise((resolve) => {
    // shell no Windows: os CLIs de npm são .cmd. Os argumentos são fixos (nada do usuário entra no comando)
    execFile(cli, spec.args, { timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024, shell: process.platform === "win32", env: process.env }, (err, stdout) => {
      if (err) return resolve(NONE);
      const models = spec.parse(String(stdout)).filter((m, i, a) => a.findIndex((x) => x.id === m.id) === i);
      resolve(models.length ? { models, source: "cli" } : NONE);
    });
  });
}

export async function modelsFor(cli: string): Promise<Result> {
  if (cli === "claude") return { models: CLAUDE, source: "static" };
  const hit = cache.get(cli);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = await listFromCli(cli);
  cache.set(cli, { at: Date.now(), value });
  return value;
}

export const clearModelsCache = () => cache.clear();

export function registerModelsApi({ fastify, projectRepo }: { fastify: FastifyInstance; projectRepo: (projectId: string) => string | null }) {
  fastify.get<{ Params: { p: string }; Querystring: { cli?: string } }>("/api/projects/:p/models", async (req, reply) => {
    try {
      if (!/^[\w-]+$/.test(req.params.p)) throw new ApiError(400, "Ids inválidos.");
      if (!projectRepo(req.params.p)) throw new ApiError(404, "Projeto não encontrado.");
      const cli = String(req.query?.cli ?? "");
      if (!["claude", "codex", "opencode", "agy"].includes(cli)) throw new ApiError(400, "cli deve ser claude, codex, opencode ou agy.");
      return await modelsFor(cli);
    } catch (e: any) {
      if (e instanceof ApiError) return reply.status(e.status).send({ error: e.message });
      throw e;
    }
  });
}
