import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import pty from "node-pty";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorktreeManager, WorktreeSession } from "./worktree.js";

// Previne queda do servidor por erros transitórios de socket (ex: EAGAIN)
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception prevenida:", err.message);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection prevenida:", reason);
});

export const fastify = Fastify({ logger: true });

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:3000")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

await fastify.register(cors, { origin: allowedOrigins });
await fastify.register(websocket);

const isWindows = process.platform === "win32";
const gitBashPath = "C:\\Program Files\\Git\\bin\\bash.exe";
const defaultShell = isWindows
  ? fs.existsSync(gitBashPath) ? gitBashPath : "powershell.exe"
  : process.env.SHELL || "/bin/bash";

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
  if (fs.existsSync(canvasFile)) {
    try {
      const state = JSON.parse(fs.readFileSync(canvasFile, "utf-8"));
      return state;
    } catch {}
  }
  return { nodes: null, edges: null };
});

fastify.post<{ Params: { id: string }; Body: { nodes: any[]; edges: any[] } }>("/api/projects/:id/canvas", async (req, reply) => {
  const canvasFile = canvasFileFor(req.params.id);
  if (!/^[\w-]+$/.test(req.params.id)) {
    return reply.status(400).send({ error: "Id de projeto inválido." });
  }
  if (!canvasFile) {
    return reply.status(404).send({ error: "Projeto não encontrado." });
  }
  writeJsonAtomic(canvasFile, req.body);
  return { ok: true };
});

// Prepend CLI tools paths (agy, claude, opencode) — só no Windows
const extraPaths = isWindows
  ? [
      "C:\\Users\\ti\\AppData\\Local\\agy\\bin",
      "C:\\Users\\ti\\.local\\bin",
      "C:\\Users\\ti\\AppData\\Roaming\\npm",
    ]
  : [];

const enrichedPath = [...extraPaths, process.env.PATH || ""].join(path.delimiter);

// WebSocket Terminal com ConPTY e proteção contra EAGAIN
fastify.get("/ws/terminal", { websocket: true }, (socket, req) => {
  socket.on("error", (err) => {
    console.error("WebSocket socket error capturado:", err.message);
  });

  // Navegadores sempre enviam Origin; clientes sem Origin (CLI/ws) não são alvo de CSRF
  const origin = req.headers.origin;
  if (origin && !allowedOrigins.includes(origin)) {
    socket.close(1008, "Origin não permitido");
    return;
  }

  const url = new URL(req.url, "http://localhost");
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
  const initialCommand = url.searchParams.get("cmd") || "";

  let ptyProcess: pty.IPty | null = null;

  try {
    const shellArgs = defaultShell.includes("bash") ? ["--login", "-i"] : isWindows ? ["-NoLogo"] : [];
    ptyProcess = pty.spawn(defaultShell, shellArgs, {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd,
      env: {
        ...process.env,
        ...(isWindows ? { Path: enrichedPath } : {}),
        PATH: enrichedPath,
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
        const { cols, rows } = JSON.parse(text);
        if (Number.isFinite(cols) && Number.isFinite(rows)) {
          ptyProcess.resize(Math.min(500, Math.max(10, Math.floor(cols))), Math.min(200, Math.max(5, Math.floor(rows))));
        }
        return;
      }
      ptyProcess.write(text);
    } catch (e: any) {
      console.error("Erro ao escrever no PTY:", e.message);
    }
  });

  const cleanup = () => {
    if (ptyProcess) {
      const { pid } = ptyProcess;
      try {
        ptyProcess.kill();
      } catch {}
      if (!isWindows) {
        // node-pty faz setsid: o shell lidera o grupo; mata também os filhos (claude, npm run dev...)
        try {
          process.kill(-pid, "SIGHUP");
        } catch {}
        setTimeout(() => {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {}
        }, 2000).unref();
      }
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

const port = Number(process.env.PORT) || 4000;
const host = process.env.HOST || "127.0.0.1";

const start = async () => {
  try {
    await fastify.listen({ port, host });
    console.log(`Maestri Server com ConPTY Blindado rodando em http://${host}:${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

if (process.env.NODE_ENV !== "test") start();
