import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { CanvasStore } from "./canvas.js";
import type { SessionManager } from "./sessions.js";

type Obj = Record<string, any>;

interface Deps {
  fastify: FastifyInstance;
  sessions: SessionManager;
  canvas: CanvasStore;
  projectRepo: (projectId: string) => string | null;
}

const ANSI = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const stripAnsi = (s: string) => s.replace(ANSI, "").replace(/\r\n?/g, "\n");

const SIZES: Record<string, [number, number]> = { agentTerminal: [460, 330], stickyNote: [280, 200], portal: [480, 330] };
const MARGIN = 40;

const sizeOf = (n: Obj): [number, number] => {
  const [dw, dh] = SIZES[n.type] ?? [300, 200];
  return [Number(n.style?.width) || dw, Number(n.style?.height) || dh];
};

// Primeira posição livre (sem sobrepor), a mais próxima de "logo abaixo" do nó de referência
function freePosition(nodes: Obj[], ref: Obj, size: [number, number]) {
  const [, rh] = sizeOf(ref);
  const rx = ref.position?.x ?? 0;
  const ry = ref.position?.y ?? 0;
  const anchor = { x: rx, y: ry + rh + MARGIN };
  const step = 40;
  const candidates: { x: number; y: number }[] = [];
  for (let gx = -30; gx <= 30; gx++) {
    for (let gy = -30; gy <= 30; gy++) candidates.push({ x: rx + gx * step, y: ry + gy * step });
  }
  const dist = (c: { x: number; y: number }) => Math.hypot(c.x - anchor.x, c.y - anchor.y);
  candidates.sort((a, b) => dist(a) - dist(b));
  const free = (c: { x: number; y: number }) =>
    nodes.every((n) => {
      const [w, h] = sizeOf(n);
      const nx = n.position?.x ?? 0;
      const ny = n.position?.y ?? 0;
      return c.x + size[0] + MARGIN <= nx || nx + w + MARGIN <= c.x || c.y + size[1] + MARGIN <= ny || ny + h + MARGIN <= c.y;
    });
  return candidates.find(free) ?? anchor;
}

const lc = (v: unknown) => String(v ?? "").trim().toLowerCase();
const isText = (v: unknown, max = 100_000): v is string => typeof v === "string" && v.length <= max;

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function registerNodeApi({ fastify, sessions, canvas, projectRepo }: Deps) {
  const base = "/api/projects/:p/nodes/:n";

  // Resolve projeto, nó atual e conectados; lança ApiError com a mensagem para o CLI
  function context(params: { p: string; n: string }) {
    if (!/^[\w-]+$/.test(params.p) || !/^[\w-]+$/.test(params.n)) throw new ApiError(400, "Ids inválidos.");
    if (!projectRepo(params.p)) throw new ApiError(404, "Projeto não encontrado.");
    const st = canvas.state(params.p);
    const nodes = st.nodes ?? [];
    const me = nodes.find((x) => x.id === params.n);
    if (!me) throw new ApiError(404, "Nó atual não encontrado no canvas.");
    const ids = new Set<string>();
    for (const e of st.edges ?? []) {
      if (e.source === me.id) ids.add(e.target);
      else if (e.target === me.id) ids.add(e.source);
    }
    const connected = nodes.filter((x) => ids.has(x.id));
    return { projectId: params.p, nodes, me, connected, title: (n: Obj) => String(n.data?.title ?? n.id) };
  }
  type Ctx = ReturnType<typeof context>;

  function resolveTarget(c: Ctx, name: unknown, type?: string) {
    if (!isText(name, 200) || !name.trim()) throw new ApiError(400, "Informe o nome do alvo.");
    const matches = (list: Obj[]) => list.filter((n) => lc(n.data?.title) === lc(name) && (!type || n.type === type));
    const hit = matches(c.connected);
    if (hit.length === 1) return hit[0];
    if (hit.length > 1) throw new ApiError(400, `Nome ambíguo: "${name}" corresponde a ${hit.length} nós conectados.`);
    if (matches(c.nodes.filter((n) => n.id !== c.me.id)).length > 0) {
      throw new ApiError(400, `"${name}" existe no canvas, mas não está conectado ao seu nó.`);
    }
    throw new ApiError(404, `Alvo "${name}" não encontrado${type ? ` (tipo ${type})` : ""}.`);
  }

  function requireMaestro(c: Ctx, what: string) {
    if (c.me.data?.isMaestro !== true) throw new ApiError(403, `Apenas o Maestro pode ${what}.`);
  }

  function requireSession(c: Ctx, target: Obj) {
    if (!sessions.get(c.projectId, target.id)) {
      throw new ApiError(409, `O terminal "${c.title(target)}" não tem sessão ativa (abra-o no canvas).`);
    }
  }

  function patch(c: Ctx, id: string, data: Obj) {
    return canvas.applyAndBroadcast(c.projectId, { kind: "patchNodeData", id, data }, `cli:${c.me.id}`);
  }

  // Envolve o handler convertendo ApiError em { error }
  const wrap = (fn: (c: Ctx, req: any, reply: FastifyReply) => any) =>
    async (req: any, reply: FastifyReply) => {
      try {
        return await fn(context(req.params), req, reply);
      } catch (e: any) {
        if (e instanceof ApiError) return reply.status(e.status).send({ error: e.message });
        req.log.error(e);
        return reply.status(500).send({ error: e?.message || "Erro interno." });
      }
    };

  fastify.get(`${base}/context`, wrap((c) => {
    const pick = (type: string) => c.connected.filter((n) => n.type === type);
    return {
      self: { nodeId: c.me.id, title: c.title(c.me), isMaestro: c.me.data?.isMaestro === true },
      agents: pick("agentTerminal").map((n) => ({ nodeId: n.id, title: c.title(n), isMaestro: n.data?.isMaestro === true })),
      notes: pick("stickyNote").map((n) => ({ nodeId: n.id, title: c.title(n) })),
      portals: pick("portal").map((n) => ({ nodeId: n.id, title: c.title(n), url: n.data?.url ?? "" })),
    };
  }));

  fastify.post(`${base}/send`, wrap((c, req) => {
    const { target, text } = req.body ?? {};
    if (!isText(text)) throw new ApiError(400, "Informe o texto.");
    const t = resolveTarget(c, target, "agentTerminal");
    requireSession(c, t);
    sessions.write(c.projectId, t.id, `${text}\r`);
    return { ok: true };
  }));

  fastify.get(`${base}/check`, wrap((c, req) => {
    const t = resolveTarget(c, req.query?.target, "agentTerminal");
    requireSession(c, t);
    const lines = Math.min(2000, Math.max(1, Math.floor(Number(req.query?.lines)) || 60));
    const out = stripAnsi(sessions.get(c.projectId, t.id)!.scrollback).replace(/\s+$/, "").split("\n");
    return { output: out.slice(-lines).join("\n") };
  }));

  // Envia e espera o PTY do alvo ficar quieto (depois de produzir saída); devolve só a saída nova
  fastify.post(`${base}/ask`, async (req: any, reply) => {
    let t: Obj;
    let c: Ctx;
    let text: string;
    try {
      c = context(req.params);
      const body = req.body ?? {};
      if (!isText(body.text)) throw new ApiError(400, "Informe o texto.");
      text = body.text;
      t = resolveTarget(c, body.target, "agentTerminal");
      requireSession(c, t);
    } catch (e: any) {
      if (e instanceof ApiError) return reply.status(e.status).send({ error: e.message });
      return reply.status(500).send({ error: e?.message || "Erro interno." });
    }
    const timeoutS = Math.min(3600, Math.max(1, Number(req.body?.timeout) || 600));
    const quietMs = Number(process.env.MAESTRI_ASK_QUIET_MS) || 5000;
    const session = sessions.get(c.projectId, t.id)!;

    // Cabeçalhos já: o cliente (fetch) não estoura headersTimeout; espaços de keepalive precedem o JSON
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { "content-type": "application/json" });
    const keepalive = setInterval(() => raw.write(" "), 30_000);

    let out = "";
    let last = 0;
    const listener = (d: string) => {
      out += d;
      last = Date.now();
    };
    session.listeners.add(listener);
    let aborted = false;
    raw.on("close", () => (aborted = true));

    const started = Date.now();
    try {
      sessions.write(c.projectId, t.id, `${text}\r`);
      let timedOut = false;
      while (!aborted) {
        await new Promise((r) => setTimeout(r, 100));
        const now = Date.now();
        if (last && now - last >= quietMs) break;
        if (session.dead) break;
        if (now - started >= timeoutS * 1000) {
          timedOut = true;
          break;
        }
      }
      if (!aborted) raw.end(JSON.stringify({ output: stripAnsi(out).trim(), timedOut }));
    } finally {
      clearInterval(keepalive);
      session.listeners.delete(listener);
    }
  });

  const noteTarget = (c: Ctx, name: unknown) => resolveTarget(c, name, "stickyNote");

  fastify.get(`${base}/notes/:target`, wrap((c, req) => ({ content: String(noteTarget(c, req.params.target).data?.content ?? "") })));

  fastify.put(`${base}/notes/:target`, wrap((c, req) => {
    const { text } = req.body ?? {};
    if (!isText(text)) throw new ApiError(400, "Informe o texto.");
    patch(c, noteTarget(c, req.params.target).id, { content: text });
    return { ok: true };
  }));

  fastify.post(`${base}/notes/:target`, wrap((c, req) => {
    const { text } = req.body ?? {};
    if (!isText(text)) throw new ApiError(400, "Informe o texto.");
    const t = noteTarget(c, req.params.target);
    const old = String(t.data?.content ?? "");
    patch(c, t.id, { content: old ? `${old}\n${text}` : text });
    return { ok: true };
  }));

  fastify.post(`${base}/notes`, wrap((c, req) => {
    const { title, text } = req.body ?? {};
    if (!isText(title, 200) || !title.trim()) throw new ApiError(400, "Informe o título da nota.");
    if (!isText(text)) throw new ApiError(400, "Informe o texto.");
    const id = `note-${crypto.randomUUID().slice(0, 8)}`;
    const node = {
      id, type: "stickyNote", position: freePosition(c.nodes, c.me, SIZES.stickyNote), style: { width: 280, height: 200 },
      data: { title: title.trim(), color: "amber", author: `🤖 ${c.title(c.me)}`, content: text },
    };
    canvas.applyAndBroadcast(c.projectId, { kind: "upsertNodes", nodes: [node] }, `cli:${c.me.id}`);
    canvas.applyAndBroadcast(c.projectId, { kind: "upsertEdges", edges: [{ id: `e-${id}-${c.me.id}`, source: id, target: c.me.id }] }, `cli:${c.me.id}`);
    return { ok: true, nodeId: id };
  }));

  fastify.post(`${base}/portal-navigate`, wrap((c, req) => {
    const t = resolveTarget(c, req.body?.target, "portal");
    let href = "";
    try {
      const u = new URL(String(req.body?.url ?? ""));
      if (u.protocol === "http:" || u.protocol === "https:") href = u.href;
    } catch {}
    if (!href) throw new ApiError(400, "URL inválida (apenas http/https).");
    patch(c, t.id, { url: href });
    return { ok: true, url: href };
  }));

  fastify.post(`${base}/recruit`, wrap((c, req) => {
    requireMaestro(c, "recrutar");
    const { name, cmd, role } = req.body ?? {};
    if (!isText(name, 64) || !name.trim()) throw new ApiError(400, "Informe o nome do agente.");
    if (cmd !== undefined && (!isText(cmd, 500) || /[\x00-\x1f]/.test(cmd))) throw new ApiError(400, "Comando inválido.");
    if (role !== undefined && !isText(role)) throw new ApiError(400, "Papel inválido.");
    if (c.connected.some((n) => lc(n.data?.title) === lc(name))) throw new ApiError(409, `Já existe um nó conectado chamado "${name}".`);
    const cwd = projectRepo(c.projectId)!;
    const id = `agent-${crypto.randomUUID().slice(0, 8)}`;

    // O texto do papel vai para um arquivo; o shell só lê o arquivo como um único argumento
    let defaultCmd = (cmd ?? "").trim();
    if (role?.trim()) {
      const dir = path.join(cwd, ".maestri-roles");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${id}.md`), role);
      if (/^(claude|codex)(\s+[\w.=\/:-]+)*$/.test(defaultCmd)) defaultCmd += ` "$(cat .maestri-roles/${id}.md)"`;
    }

    const node = {
      id, type: "agentTerminal", position: freePosition(c.nodes, c.me, SIZES.agentTerminal), style: { width: 460, height: 330 },
      data: { title: name.trim(), role: role && role.trim().length <= 60 ? role.trim() : "Agente", status: "idle", defaultCmd },
    };
    canvas.applyAndBroadcast(c.projectId, { kind: "upsertNodes", nodes: [node] }, `cli:${c.me.id}`);
    canvas.applyAndBroadcast(c.projectId, { kind: "upsertEdges", edges: [{ id: `e-${c.me.id}-${id}`, source: c.me.id, target: id }] }, `cli:${c.me.id}`);
    try {
      sessions.ensure(c.projectId, id, { cwd, cmd: defaultCmd });
    } catch (e: any) {
      throw new ApiError(500, `Nó criado, mas a sessão falhou: ${e.message}`);
    }
    return { ok: true, nodeId: id };
  }));

  fastify.post(`${base}/dismiss`, wrap((c, req) => {
    requireMaestro(c, "dispensar agentes");
    const t = resolveTarget(c, req.body?.target);
    canvas.applyAndBroadcast(c.projectId, { kind: "removeNodes", ids: [t.id] }, `cli:${c.me.id}`);
    return { ok: true };
  }));

  fastify.post(`${base}/notify`, wrap((c, req) => {
    const { text } = req.body ?? {};
    if (!isText(text, 500) || !text.trim()) throw new ApiError(400, "Informe o texto (até 500 caracteres).");
    canvas.notify(c.projectId, { type: "notify", from: { nodeId: c.me.id, title: c.title(c.me) }, text });
    return { ok: true };
  }));
}
