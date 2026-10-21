import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { WorktreeManager, WorktreeSession } from "./worktree.js";

const fastify = Fastify({ logger: true });

await fastify.register(cors, { origin: true });
await fastify.register(websocket);

// Target repository root: can be configured via REPO_PATH env or current directory
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

const start = async () => {
  try {
    await worktreeManager.init();
    await fastify.listen({ port: 4000, host: "0.0.0.0" });
    console.log("Maestri Server rodando em http://localhost:4000");
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
