import Fastify, { FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "./sessions.js";
import { registerWorktreeApi } from "./worktrees.js";
import { registerRolesApi } from "./roles.js";
import { CanvasStore } from "./canvas.js";
import { PresenceHub } from "./presence.js";
import { registerNodeApi, typeAndWait, chatBusy } from "./nodeApi.js";
import { registerWorkspacesApi } from "./workspacesApi.js";
import { registerFloorsApi } from "./floorsApi.js";
import { FloorStore } from "./floors.js";
import { registerRoutinesApi } from "./routines.js";
import { registerFilesApi } from "./files.js";
import { createProjectDir, findConflict, isInside, migrateProjects, overlaps, resolveInside } from "./projectDirs.js";

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
  // Barra lateral (F16): grupo/pasta/fixado
  group?: string | null;
  folder?: string | null;
  pinned?: boolean;
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

// Isolamento: dois projetos nunca compartilham diretório (igual/aninhado). O primeiro mantém o dele; os demais ganham pasta própria.
{
  const migrated = await migrateProjects(projects);
  if (migrated.changed) {
    projects = migrated.projects;
    saveProjects();
  }
}

function writeJsonAtomic(file: string, data: unknown) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function saveProjects() {
  // Dentro de defaultRepo grava relativo (portátil); fora dele, absoluto
  const stored = (repoPath: string) => (isInside(defaultRepo, repoPath) ? path.relative(defaultRepo, repoPath) || "." : repoPath);
  writeJsonAtomic(projectsFile, projects.map((p) => ({ ...p, repoPath: stored(p.repoPath) })));
}

function canvasFileFor(id: string) {
  return /^[\w-]+$/.test(id) && projects.some((p) => p.id === id) ? path.join(dataDir, `canvas_${id}.json`) : null;
}

const port = Number(process.env.PORT) || 4000;
const host = process.env.HOST || "127.0.0.1";

const sessions = new SessionManager({
  apiUrl: () => `http://127.0.0.1:${(fastify.server.address() as { port?: number } | null)?.port ?? port}/api`,
  token: authToken,
});
const presence = new PresenceHub();
const canvas = new CanvasStore(canvasFileFor, writeJsonAtomic, (projectId, ids) => sessions.killNodes(projectId, ids));

fastify.addHook("onClose", async () => {
  canvas.flushAll();
  sessions.killAll();
  presence.close();
});

const idPattern = /^[\w-]+$/;

const nodeApi = registerNodeApi({ fastify, sessions, canvas, projectRepo: (id) => projects.find((p) => p.id === id)?.repoPath ?? null });
const floors = new FloorStore(dataDir, (id) => projects.find((p) => p.id === id)?.repoPath ?? null, writeJsonAtomic);
registerFloorsApi({ fastify, sessions, canvas, projectRepo: (id) => projects.find((p) => p.id === id)?.repoPath ?? null, floors, nodeApi });
const projectRepo = (id: string) => projects.find((p) => p.id === id)?.repoPath ?? null;
const { createFloorFor } = registerWorktreeApi({ fastify, sessions, canvas, projectRepo });
registerRolesApi({ fastify, canvas, projectRepo, createFloorFor });
const routines = registerRoutinesApi({ fastify, sessions, canvas, projectRepo, dataDir, typeAndWait, isChatBusy: (p, n) => chatBusy.has(`${p}:${n}`) });
registerFilesApi({ fastify, projectRepo });
registerWorkspacesApi({ fastify, canvas, projects, saveProjects, dataDir, writeJson: writeJsonAtomic, floors, nodeApi });

// Endpoints de Projetos

// Configurações Globais e por Projeto de Inicialização e CLIs
const globalSettingsFile = path.join(dataDir, "global_settings.json");
const defaultGlobalSettings = {
  defaultCmd: "echo 'Agente inicializado'",
  cliPresets: [
    { id: "agy", label: "agy", cmd: "agy", color: "purple" },
    { id: "claude", label: "claude", cmd: "claude", color: "amber" },
    { id: "opencode", label: "opencode", cmd: "opencode", color: "emerald" },
  ],
};

function readGlobalSettings() {
  if (fs.existsSync(globalSettingsFile)) {
    try {
      return JSON.parse(fs.readFileSync(globalSettingsFile, "utf-8"));
    } catch {}
  }
  return defaultGlobalSettings;
}

function projectSettingsFile(id: string) {
  return path.join(dataDir, `settings_${id}.json`);
}

function readProjectSettings(id: string) {
  const f = projectSettingsFile(id);
  if (fs.existsSync(f)) {
    try {
      return JSON.parse(fs.readFileSync(f, "utf-8"));
    } catch {}
  }
  return null;
}

fastify.get("/api/settings/global", async () => {
  return readGlobalSettings();
});

fastify.put<{ Body: any }>("/api/settings/global", async (req) => {
  writeJsonAtomic(globalSettingsFile, req.body);
  return { ok: true, settings: req.body };
});

fastify.get<{ Params: { id: string } }>("/api/projects/:id/settings", async (req) => {
  const proj = readProjectSettings(req.params.id);
  const global = readGlobalSettings();
  return {
    global,
    project: proj,
    effective: proj ?? global,
  };
});

fastify.put<{ Params: { id: string }; Body: any }>("/api/projects/:id/settings", async (req) => {
  const f = projectSettingsFile(req.params.id);
  writeJsonAtomic(f, req.body);
  return { ok: true, settings: req.body };
});

fastify.get("/api/projects", async () => {
  return projects;
});

fastify.post<{ Body: { name: string; description?: string; repoPath?: string } }>("/api/projects", async (req, reply) => {
  const { name, description = "", repoPath } = req.body ?? {};
  if (!name || typeof name !== "string" || !name.trim()) {
    return reply.status(400).send({ error: "Nome do projeto é obrigatório." });
  }

  let id = `proj-${Date.now().toString().slice(-6)}`;
  while (projects.some((p) => p.id === id)) id = `proj-${Math.random().toString(36).slice(2, 8)}`;

  let dir: string;
  if (repoPath === undefined || repoPath === null || repoPath === "") {
    // Sem repoPath: pasta nova só deste projeto (com git)
    dir = await createProjectDir(name, id);
  } else {
    if (typeof repoPath !== "string") return reply.status(400).send({ error: "repoPath deve ser texto." });
    try {
      dir = fs.realpathSync(path.resolve(repoPath));
      if (!fs.statSync(dir).isDirectory()) throw new Error("não é diretório");
    } catch {
      return reply.status(400).send({ error: `repoPath não existe ou não é um diretório: ${repoPath}` });
    }
    const other = findConflict(dir, projects);
    if (other) {
      return reply.status(409).send({ error: `O diretório conflita com o projeto "${other.name}" (${other.repoPath}): projetos não podem compartilhar pastas.` });
    }
    if (overlaps(dir, dataDir)) {
      return reply.status(409).send({ error: "O diretório contém os dados internos do Maestri (.maestri_data); escolha outra pasta." });
    }
  }

  const newProject: Project = { id, name, description, repoPath: dir, createdAt: new Date().toISOString() };
  projects.push(newProject);
  saveProjects();
  return { ok: true, project: newProject };
});

fastify.delete<{ Params: { id: string } }>("/api/projects/:id", async (req, reply) => {
  const idx = projects.findIndex((p) => p.id === req.params.id);
  if (idx === -1) {
    return reply.status(404).send({ error: "Projeto não encontrado." });
  }
  const canvasFile = canvasFileFor(req.params.id);
  projects.splice(idx, 1);
  saveProjects();
  sessions.killProject(req.params.id);
  canvas.drop(req.params.id);
  if (canvasFile) fs.rmSync(canvasFile, { force: true });
  routines.removeProject(req.params.id);
  floors.drop(req.params.id);
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

  // O cwd só vale dentro do repoPath do PRÓPRIO projeto (andares ficam em <repo>/.worktrees); senão cai no repoPath
  // Sem cwd explícito, um nó de andar com isolamento git começa no checkout do andar
  const floorCwd = url.searchParams.get("cwd") ? null : floors.cwdForNode(projectId, nodeId, canvas.state(projectId).nodes ?? []);
  const cwd = resolveInside(projects.find((p) => p.id === projectId)!.repoPath, url.searchParams.get("cwd") || floorCwd);

  let cmd = url.searchParams.get("cmd") || "";
  if (!cmd) {
    const projSettings = readProjectSettings(projectId);
    const globalSettings = readGlobalSettings();
    cmd = projSettings?.defaultCmd || globalSettings?.defaultCmd || "";
  }
  sessions.attach(socket, projectId, nodeId, { cwd, cmd });
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
