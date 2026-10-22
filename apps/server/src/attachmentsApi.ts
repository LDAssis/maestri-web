// Rotas de anexos do chat: upload (web e CLI), download autenticado e leitura pelo agente (`recall attachment`).
import type { FastifyInstance } from "fastify";
import { ApiError } from "./agents.js";
import { AttachmentStore, decodeBase64 } from "./attachments.js";
import type { NodeApi } from "./nodeApi.js";

interface Deps {
  fastify: FastifyInstance;
  nodeApi: NodeApi;
  attachments: AttachmentStore;
  projectRepo: (projectId: string) => string | null;
}

// JSON com base64 de até 20MB: o limite de corpo do Fastify (1MB) sobe só nestas rotas
const BODY_LIMIT = 30 * 1024 * 1024;

export function registerAttachmentsApi({ fastify, nodeApi, attachments, projectRepo }: Deps) {
  const { base, wrap } = nodeApi;

  const project = (req: any, reply: any): string | null => {
    const p = String(req.params.p);
    if (!/^[\w-]+$/.test(p) || !projectRepo(p)) {
      reply.status(404).send({ error: "Projeto não encontrado." });
      return null;
    }
    return p;
  };
  const fail = (e: any, req: any, reply: any) => {
    if (e instanceof ApiError) return reply.status(e.status).send({ error: e.message });
    req.log.error(e);
    return reply.status(500).send({ error: e?.message || "Erro interno." });
  };

  // Web: o navegador envia o arquivo colado/escolhido na ChatFace
  fastify.post("/api/projects/:p/attachments", { bodyLimit: BODY_LIMIT }, async (req: any, reply) => {
    const p = project(req, reply);
    if (!p) return;
    try {
      return { attachment: attachments.save(p, req.body?.name, decodeBase64(req.body?.data)) };
    } catch (e) {
      return fail(e, req, reply);
    }
  });

  // Download autenticado (a web busca com o token e mostra via blob). Só imagens verificadas vão inline.
  fastify.get("/api/projects/:p/attachments/:id", async (req: any, reply) => {
    const p = project(req, reply);
    if (!p) return;
    const a = attachments.read(p, req.params.id);
    if (!a) return reply.status(404).send({ error: "Anexo não encontrado." });
    const safeName = encodeURIComponent(a.meta.name);
    return reply
      .header("content-type", a.meta.image ? a.meta.mime : "application/octet-stream")
      .header("content-disposition", `${a.meta.image ? "inline" : "attachment"}; filename*=UTF-8''${safeName}`)
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "sandbox; default-src 'none'")
      .send(a.data);
  });

  // CLI: o agente envia um arquivo (para `say --attach/--file`) e baixa um anexo (`recall attachment`)
  fastify.post(`${base}/attachments`, { bodyLimit: BODY_LIMIT }, wrap((c, req) => ({ attachment: attachments.save(c.projectId, req.body?.name, decodeBase64(req.body?.data)) })));
  fastify.get(`${base}/attachments/:id`, wrap((c, req) => {
    const a = attachments.read(c.projectId, req.params.id);
    if (!a) throw new ApiError(404, "Anexo não encontrado (veja os ids em `maestri recall`).");
    return { attachment: a.meta, data: a.data.toString("base64") };
  }));
}
