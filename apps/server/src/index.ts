import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { WorktreeManager, WorktreeSession } from "./worktree.js";

const fastify = Fastify({ logger: true });

await fastify.register(cors, { origin: true });
await fastify.register(websocket);

// Determina se o Git Bash existe no Windows
const gitBashPath = "C:\\Program Files\\Git\\bin\\bash.exe";
const defaultShell = fs.existsSync(gitBashPath) ? gitBashPath : "powershell.exe";

const targetRepo = process.env.REPO_PATH || process.cwd();
const worktreeManager = new WorktreeManager(targetRepo);
const activeSessions = new Map<string, WorktreeSession>();

fastify.post<{ Body: { devId: string; taskId: string } }>("/api/sessions", async (req, reply) => {
  const { devId, taskId } = req.body;
  if (!devId || !taskId) {
    return reply.status(400).send({ error: "devId e taskId são obrigatórios." });
  }

  try {
    const session = await worktreeManager.createSession(devId, taskId);
    activeSessions.set(session.id, session);
    return { ok: true, session };
  } catch (err: any) {
    return reply.status(500).send({ error: err.message });
  }
});

fastify.get("/api/sessions", async () => {
  return Array.from(activeSessions.values());
});

fastify.get<{ Params: { id: string } }>("/api/sessions/:id/diff", async (req, reply) => {
  const session = activeSessions.get(req.params.id);
  if (!session) {
    return reply.status(404).send({ error: "Sessão não encontrada." });
  }
  const diff = await worktreeManager.getDiff(session.worktreePath);
  return { id: session.id, diff };
});

fastify.delete<{ Params: { id: string } }>("/api/sessions/:id", async (req, reply) => {
  const session = activeSessions.get(req.params.id);
  if (!session) {
    return reply.status(404).send({ error: "Sessão não encontrada." });
  }
  await worktreeManager.removeSession(session);
  activeSessions.delete(session.id);
  return { ok: true, message: `Sessão ${session.id} encerrada e worktree removido.` };
});

// WebSocket Terminal para invocar bash e agentes CLI (agy, claude, opencode, etc.)
fastify.get("/ws/terminal", { websocket: true }, (socket, req) => {
  const url = new URL(req.url, "http://localhost:4000");
  const cwd = url.searchParams.get("cwd") || targetRepo;
  const initialCommand = url.searchParams.get("cmd") || "";

  // Inicia bash interativo com terminal colorido
  const shellArgs = defaultShell.includes("bash") ? ["--login", "-i"] : ["-NoLogo"];
  const proc = spawn(defaultShell, shellArgs, {
    cwd,
    env: {
      ...process.env,
      TERM: "xterm-256color",
      FORCE_COLOR: "1",
    },
    shell: false,
  });

  socket.send(`\r\n\x1b[32m[Maestri Web]\x1b[0m Terminal ativo em: ${cwd}\r\n`);
  if (defaultShell.includes("bash")) {
    socket.send(`\x1b[34m[Shell]\x1b[0m Bash iniciado (Git Bash). Digite agy, claude, opencode ou comandos bash.\r\n\r\n`);
  }

  // Se passou um comando inicial (ex: claude ou opencode ou agy)
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
      const text = message.toString();
      proc.stdin.write(text);
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
    await worktreeManager.init();
    await fastify.listen({ port: 4000, host: "0.0.0.0" });
    console.log("Maestri Server com Terminal rodando em http://localhost:4000");
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
