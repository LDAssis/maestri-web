// Menu de CLIs: REST (/api/clis, /api/cli-jobs) e WebSocket do job (/ws/cli-job). O token vale como nas demais /api/*.
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { ApiError } from "./agents.js";
import type { AccountStore } from "./accounts.js";
import { CliTools } from "./cliTools.js";

interface Deps {
  fastify: FastifyInstance;
  accounts: AccountStore;
  wsAuthorized: (socket: WebSocket, req: FastifyRequest, url: URL) => boolean;
}

export function registerCliToolsApi({ fastify, accounts, wsAuthorized }: Deps) {
  const tools = new CliTools(accounts);
  fastify.addHook("onClose", async () => tools.killAll());

  // Corpo/param nunca vão para o log (o texto do input pode ser um código de login)
  const h = (fn: (req: any) => unknown | Promise<unknown>) => async (req: any, reply: any) => {
    try {
      return await fn(req);
    } catch (e: any) {
      if (e instanceof ApiError) return reply.status(e.status).send({ error: e.message });
      req.log.error({ err: e?.message }, "cli-tools");
      return reply.status(500).send({ error: e?.message || "Erro interno." });
    }
  };

  fastify.get("/api/clis", h(async (req) => ({ clis: await tools.list(req.query?.account, ["1", "true"].includes(String(req.query?.refresh ?? ""))), installEnabled: tools.installEnabled() })));
  fastify.post("/api/clis/:id/install", h((req) => ({ job: tools.startInstall(String(req.params.id)) })));
  fastify.post("/api/clis/:id/login", h((req) => ({ job: tools.startLogin(String(req.params.id), req.body?.account) })));
  fastify.post("/api/clis/:id/logout", h((req) => tools.logout(String(req.params.id), req.body?.account)));
  fastify.get("/api/cli-jobs/:jobId", h((req) => tools.job(String(req.params.jobId))));
  fastify.post("/api/cli-jobs/:jobId/input", h((req) => tools.input(String(req.params.jobId), req.body?.text)));
  fastify.delete("/api/cli-jobs/:jobId", h((req) => tools.cancel(String(req.params.jobId))));

  // WS: snapshot ao conectar; depois log / url / code / state
  fastify.get("/ws/cli-job", { websocket: true }, (socket, req) => {
    const url = new URL(req.url, "http://localhost");
    if (!wsAuthorized(socket, req, url)) return;
    const send = (m: unknown) => {
      try {
        if (socket.readyState === 1 /* OPEN */) socket.send(JSON.stringify(m));
      } catch {}
    };
    let sub: ReturnType<typeof tools.subscribe>;
    try {
      sub = tools.subscribe(url.searchParams.get("job") || "", send);
    } catch {
      socket.close(4404, "Job não encontrado");
      return;
    }
    send({ type: "snapshot", job: sub.job });
    socket.on("close", sub.off);
  });

  return tools;
}
