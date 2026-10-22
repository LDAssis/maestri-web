import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { CanvasStore } from "./canvas.js";
import type { Session, SessionManager } from "./sessions.js";
import { parseUser } from "./presence.js";
import { ApiError, PRESETS, PRESET_LABELS, SIZES, freePosition, validCmd, withRolePrompt } from "./agents.js";
import { readRole } from "./roles.js";

type Obj = Record<string, any>;

interface Deps {
  fastify: FastifyInstance;
  sessions: SessionManager;
  canvas: CanvasStore;
  projectRepo: (projectId: string) => string | null;
}

const ANSI = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const stripAnsi = (s: string) => s.replace(ANSI, "").replace(/\r\n?/g, "\n");

const lc = (v: unknown) => String(v ?? "").trim().toLowerCase();
const isText = (v: unknown, max = 100_000): v is string => typeof v === "string" && v.length <= max;

// Chat ocupado (captura em andamento), chave `${projectId}:${nodeId}`; lido pelas rotinas
export const chatBusy = new Set<string>();

// Escreve no PTY e espera ele ficar quieto (depois de produzir saída); devolve só a saída nova
export async function typeAndWait(sessions: SessionManager, session: Session, input: string, timeoutS: number, aborted = () => false) {
  const quietMs = Number(process.env.MAESTRI_ASK_QUIET_MS) || 5000;
  let out = "";
  let last = 0;
  const listener = (d: string) => {
    out += d;
    last = Date.now();
  };
  session.listeners.add(listener);
  const started = Date.now();
  let timedOut = false;
  try {
    sessions.write(session.projectId, session.nodeId, input);
    while (!aborted()) {
      await new Promise((r) => setTimeout(r, 100));
      const now = Date.now();
      if (last && now - last >= quietMs) break;
      if (session.dead) break;
      if (now - started >= timeoutS * 1000) {
        timedOut = true;
        break;
      }
    }
  } finally {
    session.listeners.delete(listener);
  }
  return { output: stripAnsi(out).trim(), timedOut };
}

const CHAT_MAX = 200;
const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// '@Título' de nó conectado vira, só no texto enviado ao PTY, uma dica de como o agente lê/consulta o nó
function expandMentions(text: string, connected: Obj[]) {
  const mentionable = connected.filter((n) => (n.type === "stickyNote" || n.type === "agentTerminal") && String(n.data?.title ?? "").trim());
  if (!mentionable.length) return text;
  const titles = mentionable.map((n) => String(n.data.title)).sort((a, b) => b.length - a.length);
  const re = new RegExp(`@(${titles.map(escapeRe).join("|")})(?!\\w)`, "gi");
  return text.replace(re, (m, name: string) => {
    const n = mentionable.find((x) => lc(x.data.title) === lc(name))!;
    const q = String(n.data.title).replace(/"/g, '\\"');
    return `${m} (use: ${n.type === "stickyNote" ? `maestri note read "${q}"` : `maestri ask "${q}" ...`})`;
  });
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
    const session = sessions.get(c.projectId, t.id)!;

    // Cabeçalhos já: o cliente (fetch) não estoura headersTimeout; espaços de keepalive precedem o JSON
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { "content-type": "application/json" });
    const keepalive = setInterval(() => raw.write(" "), 30_000);

    let aborted = false;
    raw.on("close", () => (aborted = true));

    try {
      const r = await typeAndWait(sessions, session, `${text}\r`, timeoutS, () => aborted);
      if (!aborted) raw.end(JSON.stringify(r));
    } finally {
      clearInterval(keepalive);
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
    const { name, cmd, role, preset, roleId } = req.body ?? {};
    if (!isText(name, 64) || !name.trim()) throw new ApiError(400, "Informe o nome do agente.");
    if (cmd !== undefined && !validCmd(cmd)) throw new ApiError(400, "Comando inválido.");
    if (role !== undefined && !isText(role)) throw new ApiError(400, "Papel inválido.");
    if (preset !== undefined && (typeof preset !== "string" || !Object.hasOwn(PRESETS, preset))) throw new ApiError(400, `preset inválido (${Object.keys(PRESETS).join(", ")}).`);
    if (c.connected.some((n) => lc(n.data?.title) === lc(name))) throw new ApiError(409, `Já existe um nó conectado chamado "${name}".`);
    const cwd = projectRepo(c.projectId)!;
    const id = `agent-${crypto.randomUUID().slice(0, 8)}`;

    let savedRole: Obj | null = null;
    if (roleId !== undefined) {
      savedRole = typeof roleId === "string" ? readRole(cwd, roleId) : null;
      if (!savedRole) throw new ApiError(404, "Role não encontrado (use o id do role do projeto).");
    }
    let defaultCmd = (cmd ?? (preset ? PRESETS[preset] : "")).trim();
    const prompt = savedRole ? savedRole.prompt : role?.trim() ? role : "";
    if (prompt) defaultCmd = withRolePrompt(cwd, id, defaultCmd, prompt);

    const node = {
      id, type: "agentTerminal", position: freePosition(c.nodes, c.me, SIZES.agentTerminal), style: { width: 460, height: 330 },
      data: {
        title: name.trim(),
        ...(preset && { preset }),
        ...(savedRole && { roleId: savedRole.id }),
        role: savedRole ? savedRole.name : role && role.trim().length <= 60 ? role.trim() : preset ? PRESET_LABELS[preset] : "Agente",
        status: "idle",
        defaultCmd,
      },
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

  // --- Chat (face de chat do nó): histórico em node.data.chat, sincronizado pelo canvas ---
  const chatOf = (projectId: string, nodeId: string): Obj[] =>
    canvas.state(projectId).nodes?.find((n) => n.id === nodeId)?.data?.chat ?? [];

  // Lê e grava no mesmo tick: appends concorrentes não se perdem. Descarta as mais antigas além de CHAT_MAX.
  function appendChat(projectId: string, nodeId: string, msg: Obj, extra: Obj = {}) {
    const node = canvas.state(projectId).nodes?.find((n) => n.id === nodeId);
    if (!node) return;
    const chat = [...(node.data?.chat ?? []), { id: crypto.randomUUID(), at: new Date().toISOString(), ...msg }].slice(-CHAT_MAX);
    canvas.applyAndBroadcast(projectId, { kind: "patchNodeData", id: nodeId, data: { chat, ...extra } }, `chat:${nodeId}`);
  }

  const agentOnly = (c: Ctx) => {
    if (c.me.type !== "agentTerminal") throw new ApiError(400, "O chat só existe em nós de agente.");
  };

  fastify.get(`${base}/chat`, wrap((c, req) => {
    agentOnly(c);
    const last = Math.min(CHAT_MAX, Math.max(1, Math.floor(Number(req.query?.last)) || 20));
    return { messages: chatOf(c.projectId, c.me.id).slice(-last) };
  }));

  fastify.delete(`${base}/chat`, wrap((c) => {
    agentOnly(c);
    canvas.applyAndBroadcast(c.projectId, { kind: "patchNodeData", id: c.me.id, data: { chat: [] } }, `chat:${c.me.id}`);
    return { ok: true };
  }));

  fastify.post(`${base}/chat/reply`, wrap((c, req) => {
    agentOnly(c);
    const { text } = req.body ?? {};
    if (!isText(text, 50_000) || !text.trim()) throw new ApiError(400, "Informe o texto.");
    appendChat(c.projectId, c.me.id, { role: "agent", text });
    return { ok: true };
  }));

  fastify.post(`${base}/chat`, wrap((c, req, reply) => {
    agentOnly(c);
    const { text, author } = req.body ?? {};
    if (!isText(text, 20_000) || !text.trim()) throw new ApiError(400, "Informe o texto.");
    const user = parseUser(author);
    if (!user) throw new ApiError(400, "Autor inválido (id, name e color #rrggbb).");
    const session = sessions.get(c.projectId, c.me.id);
    if (!session) throw new ApiError(409, "O terminal deste agente não tem sessão ativa.");
    const key = `${c.projectId}:${c.me.id}`;
    if (chatBusy.has(key)) throw new ApiError(409, "Agente ocupado.");
    chatBusy.add(key);

    appendChat(c.projectId, c.me.id, { role: "user", text, author: user }, { chatBusy: true });

    // Várias linhas vão como bracketed paste para o shell/TUI não executar linha a linha
    const hinted = expandMentions(text, c.connected);
    const input = hinted.includes("\n") ? `\x1b[200~${hinted}\x1b[201~\r` : `${hinted}\r`;

    // Captura em segundo plano; a resposta 202 não espera
    void typeAndWait(sessions, session, input, 600)
      .then(({ output }) => {
        if (output) appendChat(c.projectId, c.me.id, { role: "terminal", text: output.slice(-20_000) });
      })
      .catch((e) => req.log.error(e))
      .finally(() => {
        chatBusy.delete(key);
        const node = canvas.state(c.projectId).nodes?.find((n) => n.id === c.me.id);
        if (node) canvas.applyAndBroadcast(c.projectId, { kind: "patchNodeData", id: c.me.id, data: { chatBusy: false } }, `chat:${c.me.id}`);
      });
    return reply.status(202).send({ ok: true });
  }));
}
