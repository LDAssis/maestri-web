import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { CanvasStore } from "./canvas.js";
import type { Session, SessionManager } from "./sessions.js";
import { parseUser } from "./presence.js";
import { ApiError, PRESETS, PRESET_LABELS, SIZES, freePosition, validCmd, withRolePrompt } from "./agents.js";
import { readRole } from "./roles.js";
import { THREADS, DEFAULT_THREAD, isThread, chatHeader, wantsChatHeader, currentThread } from "./chatThreads.js";
import { reachNotes } from "./noteGraph.js";
import { bandReach, isBand, memberIds, myBands, neighbors, sweepBands, teamTree } from "./team.js";

type Obj = Record<string, any>;

interface Deps {
  fastify: FastifyInstance;
  sessions: SessionManager;
  canvas: CanvasStore;
  projectRepo: (projectId: string) => string | null;
}

const ANSI = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
export const stripAnsi = (s: string) => s.replace(ANSI, "").replace(/\r\n?/g, "\n");

export const lc = (v: unknown) => String(v ?? "").trim().toLowerCase();
export const isText = (v: unknown, max = 100_000): v is string => typeof v === "string" && v.length <= max;

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

export type NodeApi = ReturnType<typeof registerNodeApi>;

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
    const direct = nodes.filter((x) => ids.has(x.id) && !(x.type === "stickyNote" && x.data?.stackId));
    // Notas encadeadas e páginas de fichários ligados também são alcançáveis
    const reach = reachNotes(nodes, st.edges ?? [], me.id);
    const extra = [...reach.notes.map((r) => r.node), ...reach.stacks].filter((x) => !direct.some((d) => d.id === x.id));
    const connected = [...direct, ...extra];
    // Bandas: o membro alcança os outros membros e o que está ligado à banda
    for (const n of bandReach(nodes, st.edges ?? [], me.id)) if (!connected.some((x) => x.id === n.id)) connected.push(n);
    // ...inclusive as notas/fichários (e cadeias) da banda
    for (const band of myBands(nodes, st.edges ?? [], me.id)) {
      const r = reachNotes(nodes, st.edges ?? [], band.id);
      for (const item of r.notes) {
        if (reach.notes.some((x) => x.node.id === item.node.id)) continue;
        reach.notes.push(item);
        if (!connected.some((x) => x.id === item.node.id)) connected.push(item.node);
      }
      for (const stk of r.stacks) {
        if (!reach.stacks.some((x) => x.id === stk.id)) reach.stacks.push(stk);
        if (!connected.some((x) => x.id === stk.id)) connected.push(stk);
      }
    }
    // Maestro: também alcança, pelo nome, as notas/portais/fichários dos recrutas diretos (árvore de equipe)
    if (me.data?.isMaestro === true) {
      const tree = teamTree(nodes, st.edges ?? [], me);
      for (const n of tree.others) if (!connected.some((x) => x.id === n.id)) connected.push(n);
      for (const a of tree.direct) {
        const r = reachNotes(nodes, st.edges ?? [], a.id);
        for (const item of r.notes) {
          if (reach.notes.some((x) => x.node.id === item.node.id)) continue;
          reach.notes.push({ ...item, parent: item.parent ?? a });
          if (!connected.some((x) => x.id === item.node.id)) connected.push(item.node);
        }
        for (const st2 of r.stacks) {
          if (!reach.stacks.some((x) => x.id === st2.id)) reach.stacks.push(st2);
          if (!connected.some((x) => x.id === st2.id)) connected.push(st2);
        }
      }
    }
    return { projectId: params.p, nodes, edges: st.edges ?? [], reach, me, connected, title: (n: Obj) => String(n.data?.title ?? n.id) };
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
      notes: c.reach.notes.map((r) => ({
        nodeId: r.node.id, title: c.title(r.node), locked: r.node.data?.locked === true,
        parent: r.parent ? c.title(r.parent) : null, stack: r.stack ? c.title(r.stack) : null,
      })),
      stacks: c.reach.stacks.map((s) => ({ nodeId: s.id, title: c.title(s) })),
      portals: pick("portal").map((n) => ({ nodeId: n.id, title: c.title(n), url: n.data?.url ?? "" })),
      bands: myBands(c.nodes, c.edges, c.me.id).map((b) => ({
        nodeId: b.id, title: c.title(b), mine: memberIds(b).includes(c.me.id),
        members: memberIds(b).map((id) => c.nodes.find((x) => x.id === id)).filter((x): x is Obj => !!x).map((x) => c.title(x)),
      })),
      // Maestro: as conexões de cada colega direto, aninhadas
      ...(c.me.data?.isMaestro === true && {
        links: Object.fromEntries(
          pick("agentTerminal").map((a) => [
            a.id,
            neighbors(c.nodes, c.edges, a.id).filter((n) => n.id !== c.me.id && !(n.type === "stickyNote" && n.data?.stackId)).map((n) => ({ type: n.type, title: c.title(n), ...(isBand(n) && { members: memberIds(n).length }) })),
          ]),
        ),
      }),
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

  // Rotas de nota (read/write/append/edit/delete/create/stack) vivem em notesApi.ts

  // portal-navigate (e os demais verbos de portal) vivem em portalApi.ts

  // recruit/preset/role/band/connect vivem em teamApi.ts

  fastify.post(`${base}/dismiss`, wrap((c, req) => {
    requireMaestro(c, "dispensar agentes");
    const t = resolveTarget(c, req.body?.target);
    if (isBand(t)) throw new ApiError(400, 'Use "maestri band dissolve" para desfazer uma banda.');
    canvas.applyAndBroadcast(c.projectId, { kind: "removeNodes", ids: [t.id] }, `cli:${c.me.id}`);
    sweepBands(canvas, c.projectId, `cli:${c.me.id}`); // banda com 1 membro se dissolve sozinha
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
    appendChat(c.projectId, c.me.id, { role: "agent", text, thread: currentThread(chatOf(c.projectId, c.me.id)) });
    return { ok: true };
  }));

  fastify.post(`${base}/chat`, wrap((c, req, reply) => {
    agentOnly(c);
    const { text, author, thread = DEFAULT_THREAD } = req.body ?? {};
    if (!isText(text, 20_000) || !text.trim()) throw new ApiError(400, "Informe o texto.");
    if (!isThread(thread)) throw new ApiError(400, `Thread inválida (${THREADS.join(", ")}).`);
    const user = parseUser(author);
    if (!user) throw new ApiError(400, "Autor inválido (id, name e color #rrggbb).");
    const session = sessions.get(c.projectId, c.me.id);
    if (!session) throw new ApiError(409, "O terminal deste agente não tem sessão ativa.");
    const key = `${c.projectId}:${c.me.id}`;
    if (chatBusy.has(key)) throw new ApiError(409, "Agente ocupado.");
    chatBusy.add(key);

    appendChat(c.projectId, c.me.id, { role: "user", text, author: user, thread }, { chatBusy: true });

    // Várias linhas vão como bracketed paste para o shell/TUI não executar linha a linha.
    // Com um agente em primeiro plano, a mensagem leva o cabeçalho do Maestri Chat (thread + `maestri say`).
    const hinted = (wantsChatHeader(session) ? chatHeader(thread) : "") + expandMentions(text, c.connected);
    const input = hinted.includes("\n") ? `\x1b[200~${hinted}\x1b[201~\r` : `${hinted}\r`;

    // Captura em segundo plano; a resposta 202 não espera
    void typeAndWait(sessions, session, input, 600)
      .then(({ output }) => {
        if (output) appendChat(c.projectId, c.me.id, { role: "terminal", text: output.slice(-20_000), thread });
      })
      .catch((e) => req.log.error(e))
      .finally(() => {
        chatBusy.delete(key);
        const node = canvas.state(c.projectId).nodes?.find((n) => n.id === c.me.id);
        if (node) canvas.applyAndBroadcast(c.projectId, { kind: "patchNodeData", id: c.me.id, data: { chatBusy: false } }, `chat:${c.me.id}`);
      });
    return reply.status(202).send({ ok: true });
  }));

  // Helpers reaproveitados pelos módulos de extensão da API de nós (registerXxxApi em index.ts)
  return { base, context, resolveTarget, requireMaestro, requireSession, patch, wrap };
}
