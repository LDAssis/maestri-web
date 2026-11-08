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
import { registerCommApi } from "./commApi.js";
import { registerTeamApi } from "./teamApi.js";
import { registerNotesApi } from "./notesApi.js";
import { registerWorkspacesApi } from "./workspacesApi.js";
import { registerModelsApi } from "./models.js";
import { UsageStore, registerUsageApi } from "./usage.js";
import { SessionHistory } from "./sessionHistory.js";
import { AccountStore } from "./accounts.js";
import { registerAccountsApi } from "./accountsApi.js";
import { registerCliToolsApi } from "./cliToolsApi.js";
import { registerProjectDeleteApi } from "./projectDeleteApi.js";
import { CrossLinks } from "./crossLinks.js";
import { AttachmentStore } from "./attachments.js";
import { registerAttachmentsApi } from "./attachmentsApi.js";
import { registerGlobalRolesApi } from "./globalRolesApi.js";
import { registerFloorsApi } from "./floorsApi.js";
import { FloorStore, floorOf } from "./floors.js";
import { registerRoutinesApi } from "./routines.js";
import { registerFilesApi } from "./files.js";
import { registerDownloadsApi, isPublicDownload } from "./fileDownload.js";
import { sweepBands } from "./team.js";
import { registerPortalApi } from "./portalApi.js";
import { setPortalSelfPorts } from "./portals.js";
import { configureDesktopNotify, desktopNotifyEnabled } from "./desktopNotify.js";
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
  if (!pathname.startsWith("/api/") || pathname === "/api/health" || isPublicDownload(req.method, pathname)) return;
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

// Retomada de sessão e contas de CLI (POLISH3): `canvas`/`readProjectSettings` são usados só em tempo de execução
const sessionHistory = new SessionHistory(path.join(dataDir, "session_history.json"));
const accounts = new AccountStore(dataDir);
const attachments = new AttachmentStore(dataDir);
const crossLinks = new CrossLinks(path.join(dataDir, "links.json"));
const sessions = new SessionManager({
  apiUrl: () => `http://127.0.0.1:${(fastify.server.address() as { port?: number } | null)?.port ?? port}/api`,
  token: authToken,
  history: sessionHistory,
  // Toggle "retomar sessão" do projeto (prefs_<id>.json, separado das configurações de CLI); ligado por padrão
  resume: (projectId) => readPrefs(projectId).resumeSession !== false,
  // Fim de turno de um agente num andar git: tenta achar o PR dessa branch (a detecção tem o próprio throttle)
  onIdle: (projectId, nodeId) => {
    const node = canvas.state(projectId).nodes?.find((n) => n.id === nodeId);
    const fl = node ? floors.find(projectId, floorOf(node)) : undefined;
    if (fl?.git && !fl.pullRequest) void floorsApi.detectPullRequests(projectId).catch(() => {});
  },
  env: (projectId, nodeId) => {
    const n = canvas.state(projectId).nodes?.find((x) => x.id === nodeId);
    return accounts.envFor(n?.data?.baseCmd ?? n?.data?.defaultCmd, n?.data?.account);
  },
  model: (projectId, nodeId) => {
    const m = canvas.state(projectId).nodes?.find((x) => x.id === nodeId)?.data?.model;
    return typeof m === "string" && m ? m : undefined;
  },
});
const presence = new PresenceHub();
const canvas = new CanvasStore(canvasFileFor, writeJsonAtomic, (projectId, ids) => {
  sessions.killNodes(projectId, ids);
  portals.closeNodes(projectId, ids);
  // Apagar um fichário solta as páginas dele (senão elas ficam escondidas para sempre, sem fichário para abri-las)
  const gone = new Set(ids);
  for (const n of canvas.state(projectId).nodes ?? []) {
    if (typeof n.data?.stackId === "string" && gone.has(n.data.stackId)) {
      canvas.applyAndBroadcast(projectId, { kind: "patchNodeData", id: n.id, data: { stackId: null } }, "stack-removed");
      canvas.applyAndBroadcast(projectId, { kind: "upsertNodes", nodes: [{ id: n.id, hidden: false }] }, "stack-removed");
    }
  }
  // Agente apagado pela UI: some dos membros das bandas (banda com menos de 2 se dissolve) e do histórico de sessões
  sweepBands(canvas, projectId, "sweep");
  sessionHistory.dropNodes(projectId, ids);
});
// Mudou data.model de um agente que está rodando: reinicia o terminal (remonta o comando com o modelo novo e retoma a conversa)
canvas.onModelChange = (projectId, nodeId) => {
  if (sessions.get(projectId, nodeId)) sessions.restart(projectId, nodeId);
};

fastify.addHook("onClose", async () => {
  canvas.flushAll();
  sessions.killAll();
  presence.close();
});

const idPattern = /^[\w-]+$/;

const nodeApi = registerNodeApi({ fastify, sessions, canvas, projectRepo: (id) => projects.find((p) => p.id === id)?.repoPath ?? null, attachments,
  links: crossLinks,
  workspaces: { nameOf: (id) => projects.find((p) => p.id === id)?.name, idOf: (name) => projects.find((p) => p.name.trim().toLowerCase() === name.trim().toLowerCase())?.id },
  // Acordar um agente sem sessão: cwd (andar) e comando do nó, como a conexão da UI faria
  wake: (projectId, node) => {
    const repo = projects.find((p) => p.id === projectId)!.repoPath;
    const cwd = node.data?.worktreePath ? resolveInside(repo, node.data.worktreePath) : resolveInside(repo, floors.cwdForNode(projectId, node.id, canvas.state(projectId).nodes ?? []));
    const cmd = node.data?.defaultCmd || readProjectSettings(projectId)?.defaultCmd || readGlobalSettings()?.defaultCmd || "";
    return sessions.ensure(projectId, node.id, { cwd, cmd });
  },
});
registerAttachmentsApi({ fastify, nodeApi, attachments, projectRepo: (id) => projects.find((p) => p.id === id)?.repoPath ?? null });
registerCommApi({ fastify, sessions, canvas, nodeApi, attachments });
registerNotesApi({ fastify, canvas, nodeApi });
const floors = new FloorStore(dataDir, (id) => projects.find((p) => p.id === id)?.repoPath ?? null, writeJsonAtomic);
const floorsApi = registerFloorsApi({ fastify, sessions, canvas, projectRepo: (id) => projects.find((p) => p.id === id)?.repoPath ?? null, floors, nodeApi });
// Acesso às configurações (global e por projeto) para as APIs de equipe e de contas
const settingsAccess = {
  readGlobal: () => readGlobalSettings(),
  writeGlobal: (s: any) => writeJsonAtomic(globalSettingsFile, s),
  readProject: (id: string) => readProjectSettings(id),
  writeProject: (id: string, s: any) => writeJsonAtomic(projectSettingsFile(id), s),
};
// Detecção de PRs em segundo plano: a cada 2 min (MAESTRI_PR_POLL_MS) nos projetos com andares git que ainda não seguem um PR.
// `gh` ausente/sem login só devolve `unavailable` (sem ruído); o throttle por andar fica em detectPullRequests.
const prPoll = setInterval(() => {
  for (const p of projects) {
    if (floors.read(p.id).floors.some((f) => f.git && f.branch && !f.pullRequest)) void floorsApi.detectPullRequests(p.id).catch(() => {});
  }
}, Number(process.env.MAESTRI_PR_POLL_MS) || 120_000);
prPoll.unref();
fastify.addHook("onClose", async () => clearInterval(prPoll));
registerAccountsApi({ fastify, canvas, nodeApi, accounts, projectIds: () => projects.map((p) => p.id), settings: settingsAccess });
registerCliToolsApi({ fastify, accounts, wsAuthorized });
registerTeamApi({
  fastify, sessions, canvas, projectRepo: (id) => projects.find((p) => p.id === id)?.repoPath ?? null, dataDir, nodeApi, floors, accounts, links: crossLinks, workspaces: { nameOf: (id) => projects.find((p) => p.id === id)?.name, idOf: (name) => projects.find((p) => p.name.trim().toLowerCase() === name.trim().toLowerCase())?.id },
  settings: settingsAccess,
});
const projectRepo = (id: string) => projects.find((p) => p.id === id)?.repoPath ?? null;
// o portal não navega até a API do próprio servidor (porta real, mesmo quando escolhida pelo SO)
setPortalSelfPorts(() => [(fastify.server.address() as { port?: number } | null)?.port ?? port]);
export const portals = registerPortalApi({ fastify, canvas, projectRepo, nodeApi, wsAuthorized, dataDir });
const { createFloorFor } = registerWorktreeApi({ fastify, sessions, canvas, projectRepo });
registerRolesApi({ fastify, canvas, projectRepo, createFloorFor, globalRoot: path.join(dataDir, "global-roles") });
registerGlobalRolesApi({ fastify, canvas, dataDir, projectRepo, projectIds: () => projects.map((p) => p.id) });
const routines = registerRoutinesApi({ fastify, sessions, canvas, projectRepo, projectName: (id) => projects.find((p) => p.id === id)?.name, floorCwd: (p, n, nodes) => floors.cwdForNode(p, n, nodes), dataDir, typeAndWait, isChatBusy: (p, n) => chatBusy.has(`${p}:${n}`) });
registerFilesApi({ fastify, projectRepo });
registerDownloadsApi({ fastify, projectRepo });
registerModelsApi({ fastify, projectRepo });
const usageStore = new UsageStore(path.join(dataDir, "usage.json"), writeJsonAtomic);
registerUsageApi({ fastify, canvas, projectRepo, store: usageStore });
fastify.addHook("onClose", async () => usageStore.flush());
registerWorkspacesApi({ fastify, canvas, projects, saveProjects, dataDir, writeJson: writeJsonAtomic, floors, nodeApi, sessions, createFloor: floorsApi.createFloor as any });

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

// Preferências do projeto (POLISH3): arquivo próprio para não criar um "settings do projeto" que esconderia o global
function readPrefs(id: string): { resumeSession?: boolean; desktopNotify?: boolean } {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, `prefs_${id}.json`), "utf-8"));
  } catch {
    return {};
  }
}

// Notificação do SO: preferência do projeto; sem ela, ligada só quando o servidor escuta em loopback
const isLoopbackHost = () => ["127.0.0.1", "localhost", "::1"].includes(host);
configureDesktopNotify({ pref: (id) => readPrefs(id).desktopNotify, defaultOn: isLoopbackHost });
const desktopNotifyEnabledFor = (id: string) => desktopNotifyEnabled(id);

fastify.get<{ Params: { id: string } }>("/api/projects/:id/prefs", async (req, reply) => {
  if (!idPattern.test(req.params.id) || !projects.some((p) => p.id === req.params.id)) return reply.status(404).send({ error: "Projeto não encontrado." });
  const prefs = readPrefs(req.params.id);
  return { resumeSession: prefs.resumeSession !== false, desktopNotify: desktopNotifyEnabledFor(req.params.id), desktopNotifyForced: process.env.MAESTRI_DESKTOP_NOTIFY === "0" || process.env.MAESTRI_DESKTOP_NOTIFY === "1" };
});

fastify.put<{ Params: { id: string }; Body: { resumeSession?: unknown; desktopNotify?: unknown } }>("/api/projects/:id/prefs", async (req, reply) => {
  if (!idPattern.test(req.params.id) || !projects.some((p) => p.id === req.params.id)) return reply.status(404).send({ error: "Projeto não encontrado." });
  const { resumeSession, desktopNotify } = req.body ?? {};
  if (resumeSession === undefined && desktopNotify === undefined) return reply.status(400).send({ error: "Informe resumeSession e/ou desktopNotify." });
  if (resumeSession !== undefined && typeof resumeSession !== "boolean") return reply.status(400).send({ error: "resumeSession deve ser booleano." });
  if (desktopNotify !== undefined && typeof desktopNotify !== "boolean") return reply.status(400).send({ error: "desktopNotify deve ser booleano." });
  const next = { ...readPrefs(req.params.id), ...(resumeSession !== undefined && { resumeSession }), ...(desktopNotify !== undefined && { desktopNotify }) };
  writeJsonAtomic(path.join(dataDir, `prefs_${req.params.id}.json`), next);
  return { ok: true, resumeSession: next.resumeSession !== false, desktopNotify: desktopNotifyEnabledFor(req.params.id) };
});

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
  for (const p of projects) canvas.notify(p.id, { type: "sidebar" });
  return { ok: true, project: newProject };
});

// DELETE /api/projects/:id e GET /api/projects/:id/delete-info (projectDeleteApi.ts)
registerProjectDeleteApi({ fastify, projects, defaultRepo, dataDir, canvas, sessions, portals, routines, floors, sessionHistory, crossLinks, attachments, saveProjects });

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
