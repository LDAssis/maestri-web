import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import pty from "node-pty";
import fs from "node:fs";
import path from "node:path";
import { WorktreeManager, WorktreeSession } from "./worktree.js";

// Previne queda do servidor por erros transitórios de socket (ex: EAGAIN)
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception prevenida:", err.message);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection prevenida:", reason);
});

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

// Prepend CLI tools paths (agy, claude, opencode)
const extraPaths = [
  "C:\\Users\\ti\\AppData\\Local\\agy\\bin",
  "C:\\Users\\ti\\.local\\bin",
  "C:\\Users\\ti\\AppData\\Roaming\\npm",
].join(";");

const enrichedPath = `${extraPaths};${process.env.PATH || ""}`;

// WebSocket Terminal com ConPTY e proteção contra EAGAIN
fastify.get("/ws/terminal", { websocket: true }, (socket, req) => {
  socket.on("error", (err) => {
    console.error("WebSocket socket error capturado:", err.message);
  });

  const url = new URL(req.url, "http://localhost:4000");
  const rawCwd = url.searchParams.get("cwd");
  const cwd = rawCwd && rawCwd.trim() && fs.existsSync(rawCwd) ? path.resolve(rawCwd) : defaultRepo;
  const initialCommand = url.searchParams.get("cmd") || "";

  let ptyProcess: pty.IPty | null = null;

  try {
    const shellArgs = defaultShell.includes("bash") ? ["--login", "-i"] : ["-NoLogo"];
    ptyProcess = pty.spawn(defaultShell, shellArgs, {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd,
      env: {
        ...process.env,
        PATH: enrichedPath,
        Path: enrichedPath,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      },
    });
  } catch (err: any) {
    console.error("Erro ao iniciar ConPTY:", err.message);
    socket.send(`\r\n\x1b[31m[Erro]: Falha ao iniciar ConPTY: ${err.message}\x1b[0m\r\n`);
    socket.close();
    return;
  }

  socket.send(`\r\n\x1b[32m[Maestri Web - ConPTY Ativo]\x1b[0m Terminal pronto em: ${cwd}\r\n`);

  if (initialCommand) {
    setTimeout(() => {
      try {
        ptyProcess?.write(`${initialCommand}\r`);
      } catch {}
    }, 600);
  }

  ptyProcess.onData((data: string) => {
    try {
      if (socket.readyState === 1 /* OPEN */) {
        socket.send(data);
      }
    } catch (e: any) {
      console.warn("Aviso ao enviar data para socket:", e.message);
    }
  });

  socket.on("message", (message: Buffer | string) => {
    try {
      if (!ptyProcess) return;
      const text = message.toString();
      if (text.startsWith('{"type":"resize"')) {
        const parsed = JSON.parse(text);
        ptyProcess.resize(Math.max(10, parsed.cols), Math.max(5, parsed.rows));
        return;
      }
      ptyProcess.write(text);
    } catch (e: any) {
      console.error("Erro ao escrever no PTY:", e.message);
    }
  });

  const cleanup = () => {
    if (ptyProcess) {
      try {
        ptyProcess.kill();
      } catch {}
      ptyProcess = null;
    }
  };

  socket.on("close", cleanup);

  ptyProcess.onExit((event) => {
    try {
      if (socket.readyState === 1) {
        socket.send(`\r\n\x1b[33m[PTY finalizado (exitCode: ${event.exitCode})]\x1b[0m\r\n`);
        socket.close();
      }
    } catch {}
    cleanup();
  });
});

const start = async () => {
  try {
    await fastify.listen({ port: 4000, host: "0.0.0.0" });
    console.log("Maestri Server com ConPTY Blindado rodando em http://localhost:4000");
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
