import Fastify, { FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorktreeManager, WorktreeSession } from "./worktree.js";
import { SessionManager } from "./sessions.js";
import { CanvasStore } from "./canvas.js";
import { PresenceHub } from "./presence.js";

// Previne queda do servidor por erros transitórios de socket (ex: EAGAIN)
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception prevenida:", err.message);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection prevenida:", reason);
});

// Loga só o pathname: a query do WS carrega ?token= e não pode ir para o log
export const fastify = Fastify({
  logger: { serializers: { req: (req) => ({ method: req.method, url: req.url.split("?")[0] }) } },
});

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:3000")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// Token opcional: com ele, /api/* (exceto health) e WS exigem autenticação e o Origin é dispensado
const authToken = process.env.MAESTRI_TOKEN || "";

const tokenMatches = (given: unknown) => {
  if (!authToken || typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(authToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

await fastify.register(cors, { origin: authToken ? true : allowedOrigins });

fastify.get("/api/health", async () => ({ ok: true, authRequired: !!authToken }));

fastify.addHook("onRequest", async (req, reply) => {
  if (!authToken || req.method === "OPTIONS") return;
  const pathname = req.url.split("?")[0];
  if (!pathname.startsWith("/api/") || pathname === "/api/health") return;
  const match = /^Bearer (.+)$/.exec(req.headers.authorization || "");
  if (!tokenMatches(match?.[1])) {
    return reply.code(401).send({ error: "Token ausente ou inválido" });
  }
});
await fastify.register(websocket);

// Diretório base dos projetos e persistência
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const defaultRepo = path.resolve(process.env.REPO_PATH || repoRoot);
const dataDir = path.resolve(defaultRepo, ".maestri_data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

export interface Project {
  id: string;
  name: string;
  description: string;
  repoPath: string;
  createdAt: string;
}

const projectsFile = path.join(dataDir, "projects.json");
let projects: Project[] = [];

if (fs.existsSync(projectsFile)) {
  try {
    projects = JSON.parse(fs.readFileSync(projectsFile, "utf-8"));
  } catch {
    projects = [];
  }
}

if (projects.length === 0) {
  projects = [
    {
      id: "proj-maestri-web",
      name: "Maestri Web (Principal)",
      description: "Orquestrador web com Git Worktrees e agentes",
      repoPath: defaultRepo,
      createdAt: new Date().toISOString(),
    },
    {
      id: "proj-ecommerce-api",
      name: "Microserviço E-commerce",
      description: "Backend de pagamentos e catálogo com agentes dedicados",
      repoPath: defaultRepo,
      createdAt: new Date().toISOString(),
    },
  ];
  writeJsonAtomic(projectsFile, projects);
}

// repoPath relativo (ex.: ".") é resolvido a partir de defaultRepo, para o projects.json ser portátil
projects = projects.map((p) => ({ ...p, repoPath: path.resolve(defaultRepo, p.repoPath) }));

function writeJsonAtomic(file: string, data: unknown) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function saveProjects() {
  // Grava repoPath relativo a defaultRepo para o projects.json continuar portátil
  writeJsonAtomic(projectsFile, projects.map((p) => ({ ...p, repoPath: path.relative(defaultRepo, p.repoPath) || "." })));
}

function isInside(parent: string, child: string) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function canvasFileFor(id: string) {
  return /^[\w-]+$/.test(id) && projects.some((p) => p.id === id) ? path.join(dataDir, `canvas_${id}.json`) : null;
}

const sessions = new SessionManager();
const presence = new PresenceHub();
const canvas = new CanvasStore(canvasFileFor, writeJsonAtomic, (projectId, ids) => sessions.killNodes(projectId, ids));

fastify.addHook("onClose", async () => {
  canvas.flushAll();
  sessions.killAll();
  presence.close();
});

const idPattern = /^[\w-]+$/;

// Endpoints de Projetos
fastify.get("/api/projects", async () => {
  return projects;
});

fastify.post<{ Body: { name: string; description?: string; repoPath?: string } }>("/api/projects", async (req, reply) => {
  const { name, description = "", repoPath = defaultRepo } = req.body ?? {};
  if (!name || typeof name !== "string") {
    return reply.status(400).send({ error: "Nome do projeto é obrigatório." });
  }

  const id = `proj-${Date.now().toString().slice(-6)}`;
  const newProject: Project = {
    id,
    name,
    description,
    repoPath: path.resolve(repoPath),
    createdAt: new Date().toISOString(),
  };

  projects.push(newProject);
  saveProjects();
  return { ok: true, project: newProject };
});

fastify.delete<{ Params: { id: string } }>("/api/projects/:id", async (req, reply) => {
  const idx = projects.findIndex((p) => p.id === req.params.id);
  if (idx === -1) {
    return reply.status(404).send({ error: "Projeto não encontrado." });
  }
  projects.splice(idx, 1);
  saveProjects();
  sessions.killProject(req.params.id);
  canvas.drop(req.params.id);
  return { ok: true };
});

// Estado do Canvas por Projeto
fastify.get<{ Params: { id: string } }>("/api/projects/:id/canvas", async (req, reply) => {
  const canvasFile = canvasFileFor(req.params.id);
  if (!/^[\w-]+$/.test(req.params.id)) {
    return reply.status(400).send({ error: "Id de projeto inválido." });
  }
  if (!canvasFile) {
    return reply.status(404).send({ error: "Projeto não encontrado." });
  }
  const { nodes, edges, rev } = canvas.state(req.params.id);
  return { nodes, edges, rev };
});

fastify.post<{ Params: { id: string }; Body: { nodes: any[]; edges: any[] } }>("/api/projects/:id/canvas", async (req, reply) => {
  const canvasFile = canvasFileFor(req.params.id);
  if (!/^[\w-]+$/.test(req.params.id)) {
    return reply.status(400).send({ error: "Id de projeto inválido." });
  }
  if (!canvasFile) {
    return reply.status(404).send({ error: "Projeto não encontrado." });
  }
  const res = canvas.applyAndBroadcast(req.params.id, { kind: "replace", nodes: req.body?.nodes, edges: req.body?.edges }, "http");
  if ("error" in res) return reply.status(400).send({ error: res.error });
  return { ok: true, rev: res.rev };
});

// Sessões de terminal
fastify.get<{ Params: { id: string } }>("/api/projects/:id/sessions", async (req, reply) => {
  if (!canvasFileFor(req.params.id)) return reply.status(404).send({ error: "Projeto não encontrado." });
  return sessions.list(req.params.id);
});

fastify.delete<{ Params: { id: string; node: string } }>("/api/projects/:id/sessions/:node", async (req, reply) => {
  if (!sessions.kill(req.params.id, req.params.node)) return reply.status(404).send({ error: "Sessão não encontrada." });
  return { ok: true };
});

fastify.post<{ Params: { id: string; node: string } }>("/api/projects/:id/sessions/:node/restart", async (req, reply) => {
  try {
    if (!sessions.restart(req.params.id, req.params.node)) return reply.status(404).send({ error: "Sessão não encontrada." });
  } catch (err: any) {
    return reply.status(500).send({ error: `Falha ao reiniciar: ${err.message}` });
  }
  return { ok: true };
});

// Autoriza uma conexão WS: token (F1) ou, sem token, allowlist de Origin. Navegadores sempre enviam
// Origin; clientes sem Origin (CLI/ws) não são alvo de CSRF.
function wsAuthorized(socket: WebSocket, req: FastifyRequest, url: URL) {
  socket.on("error", (err) => {
    console.error("WebSocket socket error capturado:", err.message);
  });

  if (authToken) {
    if (!tokenMatches(url.searchParams.get("token"))) {
      socket.close(4401, "Token inválido");
      return false;
    }
  } else {
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.includes(origin)) {
      socket.close(1008, "Origin não permitido");
      return false;
    }
  }
  return true;
}

// WebSocket Terminal: anexa o cliente à sessão compartilhada do nó (cria o PTY na primeira vez)
fastify.get("/ws/terminal", { websocket: true }, (socket, req) => {
  const url = new URL(req.url, "http://localhost");
  if (!wsAuthorized(socket, req, url)) return;

  const projectId = url.searchParams.get("project") || "";
  const nodeId = url.searchParams.get("node") || "";
  if (!idPattern.test(projectId) || !idPattern.test(nodeId) || !canvasFileFor(projectId)) {
    socket.close(4400, "project/node inválidos");
    return;
  }

  const rawCwd = url.searchParams.get("cwd")?.trim();
  let cwd = defaultRepo;
  if (rawCwd) {
    try {
      const real = fs.realpathSync(path.resolve(rawCwd));
      const allowed = [defaultRepo, ...projects.map((p) => p.repoPath)].some((root) => {
        try {
          return isInside(fs.realpathSync(root), real);
        } catch {
          return false;
        }
      });
      if (allowed && fs.statSync(real).isDirectory()) cwd = real;
    } catch {}
  }

  sessions.attach(socket, projectId, nodeId, { cwd, cmd: url.searchParams.get("cmd") || "" });
});

// WebSocket do canvas: snapshot ao conectar, depois ops em tempo real
fastify.get<{ Params: { id: string } }>("/ws/project/:id", { websocket: true }, (socket, req) => {
  const url = new URL(req.url, "http://localhost");
  if (!wsAuthorized(socket, req, url)) return;

  if (!idPattern.test(req.params.id) || !canvasFileFor(req.params.id)) {
    socket.close(4400, "Projeto inválido");
    return;
  }
  canvas.attach(socket, req.params.id, url.searchParams.get("clientId") || "");
});

// WebSocket de presença global (quem está online, cursores, atividade)
fastify.get("/ws/presence", { websocket: true }, (socket, req) => {
  const url = new URL(req.url, "http://localhost");
  if (!wsAuthorized(socket, req, url)) return;
  presence.attach(socket);
});

const port = Number(process.env.PORT) || 4000;
const host = process.env.HOST || "127.0.0.1";

const isLoopback = ["127.0.0.1", "localhost", "::1"].includes(host);

const start = async () => {
  if (!isLoopback && !authToken) {
    console.error(`Recusando subir em HOST=${host} sem MAESTRI_TOKEN. Defina MAESTRI_TOKEN ou use HOST=127.0.0.1.`);
    process.exit(1);
  }
  try {
    await fastify.listen({ port, host });
    console.log(`Maestri Server com ConPTY Blindado rodando em http://${host}:${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

if (process.env.NODE_ENV !== "test") start();
