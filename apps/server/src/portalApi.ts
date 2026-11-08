import { newNodeData } from "./floors.js";
import crypto from "node:crypto";
import path from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import type { CanvasStore } from "./canvas.js";
import type { NodeApi } from "./nodeApi.js";
import { isText, lc } from "./nodeApi.js";
import { ApiError, SIZES, freePosition } from "./agents.js";
import { DEFAULT_VIEWPORT, PortalManager, httpUrl, urlError } from "./portals.js";

interface Deps {
  fastify: FastifyInstance;
  canvas: CanvasStore;
  projectRepo: (projectId: string) => string | null;
  nodeApi: NodeApi;
  wsAuthorized: (socket: WebSocket, req: FastifyRequest, url: URL) => boolean;
  wsProject?: (socket: WebSocket, projectId: string) => boolean; // acesso do usuário ao projeto (fecha 4404 se não tiver)
  dataDir?: string; // anexos do chat (<dataDir>/attachments/<projeto>) valem como origem de upload
}

// "WxH" -> { w, h } (50..5000)
function parseSize(v: unknown) {
  const m = /^(\d{2,4})x(\d{2,4})$/i.exec(String(v ?? "").trim());
  if (!m || Number(m[1]) < 50 || Number(m[2]) < 50) throw new ApiError(400, "--size deve ser LxA entre 50 e 9999 (ex.: 390x844).");
  return { w: Number(m[1]), h: Number(m[2]) };
}

// Tamanho do nó no canvas conforme a proporção do viewport (o conteúdo é escalado para caber)
function nodeSize(vp: { w: number; h: number }) {
  const [dw, dh] = SIZES.portal;
  if (vp.h > vp.w) {
    const height = 640;
    return { width: Math.max(380, Math.round(((height - 110) * vp.w) / vp.h)), height };
  }
  return { width: Math.max(dw, 560), height: Math.max(dh, Math.round((560 * vp.h) / vp.w) + 110) };
}

export function registerPortalApi({ fastify, canvas, projectRepo, nodeApi, wsAuthorized, dataDir, wsProject }: Deps) {
  const { base, resolveTarget, wrap, patch } = nodeApi;
  const manager = new PortalManager(canvas, { repoOf: projectRepo, extraUploadRoots: (projectId) => (dataDir ? [path.join(dataDir, "attachments", projectId)] : []) });

  fastify.addHook("onClose", async () => manager.closeAll());

  // Cria um portal à direita do nó atual, conectado a ele, já aberto na URL
  fastify.post(`${base}/portal/create`, wrap(async (c, req) => {
    const { url, name, size } = req.body ?? {};
    const href = httpUrl(url);
    if (!href) throw new ApiError(400, urlError(url));
    if (name !== undefined && (!isText(name, 100) || !name.trim())) throw new ApiError(400, "Nome inválido.");
    const vp = size === undefined ? { ...DEFAULT_VIEWPORT } : parseSize(size);
    const titles = new Set(c.nodes.map((n) => lc(n.data?.title)));
    let title = String(name ?? "").trim();
    if (title) {
      if (c.connected.some((n) => lc(n.data?.title) === lc(title))) throw new ApiError(409, `Já existe um nó conectado chamado "${title}".`);
    } else {
      title = "Portal";
      for (let i = 2; titles.has(lc(title)); i++) title = `Portal ${i}`;
    }

    const id = `portal-${crypto.randomUUID().slice(0, 8)}`;
    const dim = nodeSize(vp);
    const mw = Number(c.me.style?.width) || 460;
    // Referência sintética: a posição "logo abaixo" dela é exatamente à direita do nó atual
    const ref = { type: "portal", position: { x: (c.me.position?.x ?? 0) + mw + 40, y: (c.me.position?.y ?? 0) - 41 }, style: { width: 1, height: 1 } };
    const node = {
      id, type: "portal", position: freePosition(c.nodes, ref, [dim.width, dim.height]), style: dim,
      data: { title, url: href, live: true, viewport: vp, ...newNodeData(c.me) },
    };
    const from = `cli:${c.me.id}`;
    canvas.applyAndBroadcast(c.projectId, { kind: "upsertNodes", nodes: [node] }, from);
    canvas.applyAndBroadcast(c.projectId, { kind: "upsertEdges", edges: [{ id: `e-${c.me.id}-${id}`, source: c.me.id, target: id }] }, from);
    try {
      await manager.ensure(c.projectId, id);
    } catch (e: any) {
      throw new ApiError(e instanceof ApiError ? e.status : 502, `Portal "${title}" criado, mas falhou ao abrir: ${e.message}`);
    }
    return { ok: true, nodeId: id, title, url: href, viewport: vp };
  }));

  fastify.post(`${base}/portal/edit`, wrap(async (c, req) => {
    const t = resolveTarget(c, req.body?.target, "portal");
    const href = httpUrl(req.body?.url);
    if (!href) throw new ApiError(400, urlError(req.body?.url));
    patch(c, t.id, { url: href });
    const r = await manager.navigate(c.projectId, t.id, href);
    return { ok: true, url: r?.url ?? href };
  }));

  fastify.post(`${base}/portal/close`, wrap((c, req) => {
    const t = resolveTarget(c, req.body?.target, "portal");
    canvas.applyAndBroadcast(c.projectId, { kind: "removeNodes", ids: [t.id] }, `cli:${c.me.id}`);
    return { ok: true };
  }));

  // `portal navigate`: atualiza data.url (modo iframe) e, se a sessão automatizada já existe, navega nela
  fastify.post(`${base}/portal-navigate`, wrap(async (c, req) => {
    const t = resolveTarget(c, req.body?.target, "portal");
    const href = httpUrl(req.body?.url);
    if (!href) throw new ApiError(400, urlError(req.body?.url));
    patch(c, t.id, { url: href });
    const r = await manager.navigate(c.projectId, t.id, href);
    return { ok: true, url: r?.url ?? href, title: r?.title };
  }));

  // Demais verbos de automação (snapshot, click, fill, ...)
  fastify.post(`${base}/portal/:cmd`, wrap(async (c, req) => {
    const t = resolveTarget(c, req.body?.target, "portal");
    const args = req.body?.args ?? [];
    if (!Array.isArray(args) || !args.every((a: unknown) => isText(a, 1_000_000))) throw new ApiError(400, "args inválidos.");
    return { output: await manager.run(c.projectId, t.id, String(req.params.cmd), args) };
  }));

  // Sessão ao vivo: frames JPEG (binários) + meta JSON para o cliente; eventos do usuário no sentido inverso
  fastify.get("/ws/portal", { websocket: true }, (socket, req) => {
    const url = new URL(req.url, "http://localhost");
    if (!wsAuthorized(socket, req, url)) return;
    const projectId = url.searchParams.get("project") || "";
    const nodeId = url.searchParams.get("node") || "";
    if (/^[\w-]+$/.test(projectId) && wsProject && !wsProject(socket, projectId)) return;
    const node = /^[\w-]+$/.test(projectId) && /^[\w-]+$/.test(nodeId) && projectRepo(projectId) ? canvas.state(projectId).nodes?.find((n) => n.id === nodeId) : null;
    if (!node || node.type !== "portal") {
      socket.close(4400, "project/node inválidos");
      return;
    }
    void manager.watch(projectId, nodeId, socket);
  });

  return manager;
}
