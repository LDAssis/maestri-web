// Comunicação via CLI (F13): ask/send --raw, say, recall e debug. As rotas usam os helpers de registerNodeApi.
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { CanvasStore } from "./canvas.js";
import type { SessionManager } from "./sessions.js";
import { ApiError } from "./agents.js";
import type { AttachmentStore } from "./attachments.js";
import { isText, typeAndWait, type NodeApi } from "./nodeApi.js";
import { THREADS, currentThread, isThread, threadOf, type Thread } from "./chatThreads.js";

type Obj = Record<string, any>;

interface Deps {
  fastify: FastifyInstance;
  sessions: SessionManager;
  canvas: CanvasStore;
  nodeApi: NodeApi;
  attachments: AttachmentStore;
}

const CHAT_MAX = 200; // mesmo limite do chat em nodeApi.ts
const DAY = 86_400_000;

// Escapes do --raw: \n e \r = Enter (o PTY espera CR), \t Tab, \e ESC, \xNN byte, \\ barra. Outros ficam literais.
export function decodeEscapes(s: string) {
  const map: Record<string, string> = { n: "\r", r: "\r", t: "\t", e: "\x1b", "\\": "\\" };
  return s.replace(/\\(x[0-9a-fA-F]{2}|[\s\S])/g, (m, e: string) =>
    e.length === 3 ? String.fromCharCode(parseInt(e.slice(1), 16)) : map[e] ?? m,
  );
}

// 'YYYY-MM-DD' no fuso do servidor -> início do dia (ms); null se inválida
function parseDay(v: unknown) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v ?? ""));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getMonth() === Number(m[2]) - 1 ? d.getTime() : null;
}

// Só o que o usuário e o agente disseram (sem saída crua do terminal e sem bolhas de progresso)
const spoken = (m: Obj) => m.role === "user" || (m.role === "agent" && !m.progress);

// Filtra a conversa de uma thread: últimos N turnos (padrão 10), janela relativa, intervalo de datas ou tudo.
// Um turno começa em cada mensagem do usuário e inclui as respostas seguintes.
export function recall(chat: Obj[], q: Obj, now = Date.now()) {
  const thread: Thread = q.thread === undefined || q.thread === "" ? currentThread(chat) : q.thread;
  if (!isThread(thread)) throw new ApiError(400, `Thread inválida (${THREADS.join(", ")}).`);
  const msgs = chat.filter((m) => spoken(m) && threadOf(m) === thread);
  const modes = ["turns", "last", "from", "all"].filter((k) => q[k] !== undefined && q[k] !== "" && q[k] !== "false");
  if (modes.length > 1) throw new ApiError(400, "Use só um de --turns, --last, --from ou --all.");
  if (q.to !== undefined && q.from === undefined) throw new ApiError(400, "--to exige --from.");
  const at = (m: Obj) => Date.parse(m.at);
  let out: Obj[];
  switch (modes[0]) {
    case "all":
      out = msgs;
      break;
    case "last": {
      const span = { day: DAY, week: 7 * DAY, month: 30 * DAY }[String(q.last)];
      if (!span) throw new ApiError(400, "--last aceita day, week ou month.");
      out = msgs.filter((m) => at(m) >= now - span);
      break;
    }
    case "from": {
      const from = parseDay(q.from);
      const to = q.to === undefined ? Infinity : parseDay(q.to);
      if (from === null || to === null) throw new ApiError(400, "Datas no formato YYYY-MM-DD.");
      // --to inclui o dia inteiro
      out = msgs.filter((m) => at(m) >= from && at(m) < to + (to === Infinity ? 0 : DAY));
      break;
    }
    default: {
      const n = q.turns === undefined ? 10 : Number(q.turns);
      if (!Number.isInteger(n) || n < 1 || n > 500) throw new ApiError(400, "--turns deve ser um inteiro entre 1 e 500.");
      const starts = msgs.flatMap((m, i) => (m.role === "user" ? [i] : []));
      out = starts.length > n ? msgs.slice(starts[starts.length - n]) : msgs;
    }
  }
  return { thread, messages: out };
}

export function registerCommApi({ fastify, sessions, canvas, nodeApi, attachments }: Deps) {
  const { base, context, resolveTarget, awake, wrap } = nodeApi;

  const chatOf = (projectId: string, nodeId: string): Obj[] =>
    canvas.state(projectId).nodes?.find((n) => n.id === nodeId)?.data?.chat ?? [];

  const agentOnly = (c: { me: Obj }) => {
    if (c.me.type !== "agentTerminal") throw new ApiError(400, "O chat só existe em nós de agente.");
  };

  // Input cru (escapes decodificados) no PTY do alvo; com wait, espera ficar quieto e devolve a saída nova (como /ask)
  fastify.post(`${base}/raw`, async (req: any, reply) => {
    let session;
    let starting = false;
    let input: string;
    const body = req.body ?? {};
    try {
      const c = context(req.params);
      if (!isText(body.input, 100_000) || !body.input) throw new ApiError(400, "Informe o input cru.");
      input = decodeEscapes(body.input);
      const t = resolveTarget(c, body.target, "agentTerminal");
      ({ session, starting } = awake(c, t));
    } catch (e: any) {
      if (e instanceof ApiError) return reply.status(e.status).send({ error: e.message });
      return reply.status(500).send({ error: e?.message || "Erro interno." });
    }
    if (!body.wait) {
      sessions.write(session.projectId, session.nodeId, input);
      return { ok: true, ...(starting && { starting: true }) };
    }
    if (starting) return { output: "", starting: true, timedOut: false };
    const timeoutS = Math.min(3600, Math.max(1, Number(body.timeout) || 600));
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { "content-type": "application/json" });
    const keepalive = setInterval(() => raw.write(" "), 30_000);
    let aborted = false;
    raw.on("close", () => (aborted = true));
    try {
      const r = await typeAndWait(sessions, session, input, timeoutS, () => aborted);
      if (!aborted) raw.end(JSON.stringify(r));
    } finally {
      clearInterval(keepalive);
    }
  });

  // Resposta do agente na thread atual (a da última mensagem do usuário); progress = bolha intermediária
  fastify.post(`${base}/say`, wrap((c, req) => {
    agentOnly(c);
    const { progress } = req.body ?? {};
    const text: unknown = req.body?.text ?? "";
    // Anexos já enviados (POST /attachments): só na resposta final, nunca no balão de progresso
    const files = attachments.resolve(c.projectId, req.body?.attachments);
    if (files.length && progress === true) throw new ApiError(400, "Anexos só vão na resposta final (não em --progress).");
    if (!isText(text, 50_000) || (!text.trim() && !files.length)) throw new ApiError(400, "Informe o texto.");
    const chat = chatOf(c.projectId, c.me.id);
    const thread = currentThread(chat);
    const msg = { id: crypto.randomUUID(), at: new Date().toISOString(), role: "agent", text, thread, ...(progress === true && { progress: true }), ...(files.length && { attachments: files }) };
    // Lê e grava no mesmo tick (como appendChat em nodeApi.ts)
    canvas.applyAndBroadcast(c.projectId, { kind: "patchNodeData", id: c.me.id, data: { chat: [...chat, msg].slice(-CHAT_MAX) } }, `chat:${c.me.id}`);
    return { ok: true, thread };
  }));

  fastify.get(`${base}/recall`, wrap((c, req) => {
    agentOnly(c);
    return recall(chatOf(c.projectId, c.me.id), req.query ?? {});
  }));

  fastify.get(`${base}/recall/threads`, wrap((c) => {
    agentOnly(c);
    const chat = chatOf(c.projectId, c.me.id);
    const threads = THREADS.map((t) => {
      const msgs = chat.filter((m) => spoken(m) && threadOf(m) === t);
      return { thread: t, messages: msgs.length, lastAt: msgs.at(-1)?.at ?? null };
    });
    return { current: currentThread(chat), threads };
  }));

  // Diagnóstico do nó que chama: existe no canvas (senão o context já dá 404), tem sessão, é Maestro
  fastify.get(`${base}/debug`, wrap((c) => ({
    node: { id: c.me.id, title: c.title(c.me), type: c.me.type },
    session: !!sessions.get(c.projectId, c.me.id),
    isMaestro: c.me.data?.isMaestro === true,
    connected: c.connected.length,
  })));
}
