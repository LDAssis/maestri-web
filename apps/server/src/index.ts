import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { WorktreeManager, WorktreeSession } from "./worktree.js";

const fastify = Fastify({ logger: true });

await fastify.register(cors, { origin: true });
await fastify.register(websocket);

const gitBashPath = "C:\\Program Files\\Git\\bin\\bash.exe";
const defaultShell = fs.existsSync(gitBashPath) ? gitBashPath : "powershell.exe";

// Diretório base dos projetos e persistência
const defaultRepo = process.env.REPO_PATH || path.resolve("C:/Users/ti/.gemini/antigravity/scratch/maestri-web");
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
  fs.writeFileSync(projectsFile, JSON.stringify(projects, null, 2));
}

function saveProjects() {
  fs.writeFileSync(projectsFile, JSON.stringify(projects, null, 2));
}

// Map de WorktreeManagers por repositório
const worktreeManagers = new Map<string, WorktreeManager>();
function getWorktreeManager(repoPath: string): WorktreeManager {
  if (!worktreeManagers.has(repoPath)) {
    const mgr = new WorktreeManager(repoPath);
    mgr.init().catch(console.error);
    worktreeManagers.set(repoPath, mgr);
  }
  return worktreeManagers.get(repoPath)!;
}

// Endpoints de Projetos
fastify.get("/api/projects", async () => {
  return projects;
});

fastify.post<{ Body: { name: string; description?: string; repoPath?: string } }>("/api/projects", async (req, reply) => {
  const { name, description = "", repoPath = defaultRepo } = req.body;
  if (!name) {
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
  return { ok: true };
});

// Estado do Canvas por Projeto
fastify.get<{ Params: { id: string } }>("/api/projects/:id/canvas", async (req, reply) => {
  const canvasFile = path.join(dataDir, `canvas_${req.params.id}.json`);
  if (fs.existsSync(canvasFile)) {
    try {
      const state = JSON.parse(fs.readFileSync(canvasFile, "utf-8"));
      return state;
    } catch {}
  }
  return { nodes: null, edges: null };
});

fastify.post<{ Params: { id: string }; Body: { nodes: any[]; edges: any[] } }>("/api/projects/:id/canvas", async (req, reply) => {
  const canvasFile = path.join(dataDir, `canvas_${req.params.id}.json`);
  fs.writeFileSync(canvasFile, JSON.stringify(req.body, null, 2));
  return { ok: true };
});

// Prepend CLI tools paths (agy, claude, opencode) para garantir que estejam no PATH do terminal
const extraPaths = [
  "C:\\Users\\ti\\AppData\\Local\\agy\\bin",
  "C:\\Users\\ti\\.local\\bin",
  "C:\\Users\\ti\\AppData\\Roaming\\npm",
].join(";");

const enrichedPath = `${extraPaths};${process.env.PATH || ""}`;

// WebSocket Terminal para invocar bash em qualquer projeto/worktree
fastify.get("/ws/terminal", { websocket: true }, (socket, req) => {
  const url = new URL(req.url, "http://localhost:4000");
  const cwd = url.searchParams.get("cwd") || defaultRepo;
  const initialCommand = url.searchParams.get("cmd") || "";

  const shellArgs = defaultShell.includes("bash") ? ["--login", "-i"] : ["-NoLogo"];
  const proc = spawn(defaultShell, shellArgs, {
    cwd,
    env: {
      ...process.env,
      PATH: enrichedPath,
      Path: enrichedPath,
      TERM: "xterm-256color",
      FORCE_COLOR: "1",
    },
    shell: false,
  });

  socket.send(`\r\n\x1b[32m[Maestri Web]\x1b[0m Terminal ativo em: ${cwd}\r\n`);
  if (defaultShell.includes("bash")) {
    socket.send(`\x1b[34m[Shell]\x1b[0m Git Bash pronto. Digite agy, claude, opencode ou comandos bash.\r\n\r\n`);
  }

  if (initialCommand) {
    setTimeout(() => {
      proc.stdin.write(`${initialCommand}\n`);
    }, 500);
  }

  proc.stdout.on("data", (chunk: Buffer) => {
    socket.send(chunk.toString("utf-8"));
  });

  proc.stderr.on("data", (chunk: Buffer) => {
    socket.send(chunk.toString("utf-8"));
  });

  socket.on("message", (message: Buffer | string) => {
    try {
      proc.stdin.write(message.toString());
    } catch (e) {
      console.error("Erro ao enviar para stdin:", e);
    }
  });

  socket.on("close", () => {
    proc.kill();
  });

  proc.on("close", (code) => {
    try {
      socket.send(`\r\n\x1b[33m[Processo finalizado (code ${code})]\x1b[0m\r\n`);
      socket.close();
    } catch {}
  });
});

const start = async () => {
  try {
    await fastify.listen({ port: 4000, host: "0.0.0.0" });
    console.log("Maestri Server com Suporte a Multi-Projetos rodando em http://localhost:4000");
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
