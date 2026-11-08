import { desktopNotify } from "./desktopNotify.js";
import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { CanvasStore } from "./canvas.js";
import type { Session, SessionManager } from "./sessions.js";
import { parseUser } from "./presence.js";
import { ApiError, PRESETS, PRESET_LABELS, SIZES, freePosition, validCmd, withRolePrompt } from "./agents.js";
import { readRole } from "./roles.js";
import { THREADS, DEFAULT_THREAD, isThread, chatHeader, wantsChatHeader, currentThread } from "./chatThreads.js";
import type { AttachmentStore } from "./attachments.js";
import type { CrossLinks } from "./crossLinks.js";
import { reqStore } from "./projectAccess.js";
import { sanitizeTyped } from "./routines.js";
import { reachNotes } from "./noteGraph.js";
import { bandReach, isBand, memberIds, myBands, neighbors, sweepBands, teamTree } from "./team.js";

type Obj = Record<string, any>;

interface Deps {
  fastify: FastifyInstance;
  sessions: SessionManager;
  canvas: CanvasStore;
  projectRepo: (projectId: string) => string | null;
  attachments?: AttachmentStore; // anexos do chat (POLISH3)
  // Workspaces cruzados (POLISH5): registro de links, nomes dos projetos e como subir a sessão de um nó
  links?: CrossLinks;
  workspaces?: { nameOf: (projectId: string) => string | undefined; idOf: (name: string) => string | undefined };
  wake?: (projectId: string, node: Obj) => Session;
}

const ANSI = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
export const stripAnsi = (s: string) => s.replace(ANSI, "").replace(/\r\n?/g, "\n");

export const lc = (v: unknown) => String(v ?? "").trim().toLowerCase();
export const isText = (v: unknown, max = 100_000): v is string => typeof v === "string" && v.length <= max;

// Chat ocupado (captura em andamento), chave `${projectId}:${nodeId}`; lido pelas rotinas
export const chatBusy = new Set<string>();

// A TUI do agente ainda está trabalhando? Indicadores conhecidos nas últimas linhas da tela (sem ANSI): "esc to interrupt"
// (Claude Code) / "Esc to interrupt" (Codex) e os spinners "Working…"/"Thinking…" (com "(12s" ou reticências).
// Recebe o ÚLTIMO TRECHO de saída contínua do terminal (o quadro mais recente): num scrollback bruto os quadros antigos
// continuam lá, já sem os códigos que os apagavam, e um indicador velho pareceria "ainda ocupado" para sempre.
const BUSY_RE = /esc to interrupt|\b(?:Working|Thinking)(?:…|\.{3}|\s*\(\d)/i;
export function busyIndicator(latest: string): boolean {
  const lines = stripAnsi(latest.slice(-4000)).split("\n").map((l) => l.trim()).filter(Boolean).slice(-6);
  return lines.some((l) => BUSY_RE.test(l));
}

// Prompt digitado no PTY de um agente (ask/send/chat/rotina). TUIs como o Claude Code tratam entrada que chega junta como
// COLAGEM: um \r no mesmo write vira quebra de linha e o texto fica parado no input. Por isso: o texto (multi-linha em bracketed
// paste) num write, uma pausa (MAESTRI_SUBMIT_DELAY_MS, padrão 250 ms) e o Enter num write SEPARADO. O --raw não passa por aqui.
export const submitDelayMs = () => {
  const v = process.env.MAESTRI_SUBMIT_DELAY_MS;
  return v !== undefined && v.trim() !== "" && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 250;
};
// Pausa antes do Enter: a base (MAESTRI_SUBMIT_DELAY_MS) + ~1 ms a cada 10 caracteres, teto de 2 s (se a base já passa disso, vale a base).
// Colagens grandes levam mais tempo para o TUI processar; um \r que chega antes vira quebra de linha dentro do texto.
export const submitPauseMs = (len: number) => {
  const base = submitDelayMs();
  return Math.max(base, Math.min(2000, base + Math.floor(len / 10)));
};
// Janela em que se observa a saída depois do Enter (MAESTRI_SUBMIT_VERIFY_MS, padrão 1500; 0 desliga a verificação).
export const submitVerifyMs = () => {
  const v = process.env.MAESTRI_SUBMIT_VERIFY_MS;
  return v !== undefined && v.trim() !== "" && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 1500;
};
const SUBMIT_RETRIES = 2; // Enters extras, no máximo
const squash = (s: string) => stripAnsi(s).replace(/\s+/g, "");

export async function typePrompt(sessions: SessionManager, session: Session, text: string) {
  const typed = sanitizeTyped(text); // sem ESC/controles: nada fecha o bracketed paste nem injeta teclas
  // Acompanha o quadro atual da tela (saída contínua mais recente) e se um indicador de ocupado apareceu depois do 1º Enter.
  let burst = "";
  let last = 0;
  let sawBusy = false;
  let enterSent = false;
  const listener = (d: string) => {
    const now = Date.now();
    if (now - last > 300) burst = "";
    burst = (burst + d).slice(-8000);
    last = now;
    if (enterSent && busyIndicator(burst)) sawBusy = true;
  };
  session.listeners.add(listener);
  try {
    sessions.write(session.projectId, session.nodeId, typed.includes("\n") ? `\x1b[200~${typed}\x1b[201~` : typed);
    await new Promise((r) => setTimeout(r, submitPauseMs(typed.length)));
    enterSent = true;
    sessions.write(session.projectId, session.nodeId, "\r");
    // Verificação: sem sinal de envio (ocupado) e com o quadro ainda mostrando o fim do texto, o Enter virou quebra de linha
    // dentro da colagem (ou foi engolido): manda outro. Enter extra numa caixa vazia é inofensivo (Claude Code/Codex/shell).
    const verifyMs = submitVerifyMs();
    const tail = squash(typed).slice(-16);
    if (!verifyMs || !tail) return;
    for (let attempt = 0; attempt < SUBMIT_RETRIES && !session.dead; attempt++) {
      const until = Date.now() + verifyMs;
      while (!sawBusy && Date.now() < until && !session.dead) await new Promise((r) => setTimeout(r, 50));
      if (sawBusy || session.dead || !squash(burst).includes(tail)) return;
      sessions.write(session.projectId, session.nodeId, "\r");
    }
  } finally {
    session.listeners.delete(listener);
  }
}

// Escreve no PTY e espera ele ficar quieto (depois de produzir saída); devolve só a saída nova.
// input string = cru (escapes já decodificados, --raw); { prompt } = texto de prompt: vai por typePrompt (Enter separado) e o
// tempo de silêncio conta a partir do Enter.
// O silêncio só encerra se a tela do alvo NÃO mostrar um indicador de ocupado (o --timeout continua valendo).
export async function typeAndWait(sessions: SessionManager, session: Session, input: string | { prompt: string }, timeoutS: number, aborted = () => false) {
  const quietMs = Number(process.env.MAESTRI_ASK_QUIET_MS) || 5000;
  let out = "";
  let last = 0;
  let burst = ""; // saída contínua mais recente (chunks separados por < 300ms): o "quadro" atual da tela
  const listener = (d: string) => {
    const now = Date.now();
    if (now - last > 300) burst = "";
    burst = (burst + d).slice(-8000);
    out += d;
    last = now;
  };
  session.listeners.add(listener);
  const started = Date.now();
  let timedOut = false;
  try {
    if (typeof input === "string") sessions.write(session.projectId, session.nodeId, input);
    else {
      await typePrompt(sessions, session, input.prompt);
      if (last) last = Date.now(); // o eco do texto não conta: o silêncio vale a partir do Enter
    }
    while (!aborted()) {
      await new Promise((r) => setTimeout(r, 100));
      const now = Date.now();
      if (last && now - last >= quietMs && !busyIndicator(burst)) break;
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

// Sessão recém-acordada por ask/send/check ainda está subindo o agente por alguns segundos
// Agente recém-acordado fica "iniciando" até produzir saída e ficar quieto por settleMs (no máximo startupMs)
const startupMs = () => Number(process.env.MAESTRI_WAKE_STARTUP_MS) || 30000;
const settleMs = () => Number(process.env.MAESTRI_WAKE_SETTLE_MS) || 1500;

export function registerNodeApi({ fastify, sessions, canvas, projectRepo, attachments, links, workspaces, wake }: Deps) {
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
    // Agentes de outros workspaces ligados a mim (registro de links): nós "sombra" com o projeto de origem
    for (const peer of links?.peers(params.p, me.id) ?? []) {
      const n = canvas.state(peer.project).nodes?.find((x) => x.id === peer.node && x.type === "agentTerminal");
      if (n) connected.push({ ...n, __project: peer.project, __workspace: workspaces?.nameOf(peer.project) ?? peer.project });
    }
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
    const wsName = workspaces?.nameOf(params.p) ?? params.p;
    // Agentes de outro workspace aparecem (e se endereçam) como "Nome @ Workspace"
    const title = (n: Obj) => (n.__workspace ? `${n.data?.title ?? n.id} @ ${n.__workspace}` : String(n.data?.title ?? n.id));
    return { projectId: params.p, workspace: wsName, nodes, edges: st.edges ?? [], reach, me, connected, title };
  }
  type Ctx = ReturnType<typeof context>;

  function resolveTarget(c: Ctx, name: unknown, type?: string) {
    if (!isText(name, 200) || !name.trim()) throw new ApiError(400, "Informe o nome do alvo.");
    const label = (n: Obj) => (n.__workspace ? `${n.data?.title} @ ${n.__workspace}` : n.data?.title);
    const matches = (list: Obj[]) => list.filter((n) => lc(label(n)) === lc(name) && (!type || n.type === type));
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

  // Bandas de outros workspaces com membros ligados a mim ("Banda @ Workspace")
  function remoteBands(c: Ctx) {
    const out: { nodeId: string; title: string; mine: boolean; members: string[] }[] = [];
    for (const pid of new Set((links?.peers(c.projectId, c.me.id) ?? []).map((p) => p.project))) {
      const mine = new Set(links!.peers(c.projectId, c.me.id).filter((p) => p.project === pid).map((p) => p.node));
      const nodes = canvas.state(pid).nodes ?? [];
      const ws = workspaces?.nameOf(pid) ?? pid;
      for (const b of nodes.filter((x) => isBand(x) && memberIds(x).some((m) => mine.has(m)))) {
        out.push({ nodeId: b.id, title: `${b.data?.title ?? b.id} @ ${ws}`, mine: false, members: memberIds(b).map((id) => nodes.find((x) => x.id === id)).filter((x): x is Obj => !!x).map((x) => String(x.data?.title ?? x.id)) });
      }
    }
    return out;
  }

  // Projeto do alvo (um agente de outro workspace carrega __project)
  const pidOf = (c: Ctx, target: Obj): string => target.__project ?? c.projectId;

  // Acorda o alvo: sem sessão (descarregado, andar com unload, servidor reiniciado) sobe a sessão com o cwd e o
  // comando do nó, como a UI faria. `starting` = acordada há pouco e ainda sem a tela assentada (o agente está subindo).
  const woken = new Map<string, { at: number; createdAt: string }>();
  function awake(c: Ctx, target: Obj): { session: Session; starting: boolean } {
    const pid = pidOf(c, target);
    const key = `${pid}:${target.id}`;
    let session = sessions.get(pid, target.id);
    if (!session) {
      if (!wake) throw new ApiError(409, `O terminal "${c.title(target)}" não tem sessão ativa (abra-o no canvas).`);
      try {
        session = wake(pid, target);
      } catch (e: any) {
        throw new ApiError(500, `Não foi possível iniciar o terminal "${c.title(target)}": ${e?.message || e}`);
      }
      woken.set(key, { at: Date.now(), createdAt: session.createdAt });
    }
    const w = woken.get(key);
    const now = Date.now();
    const settled = session.lastOutputAt > (w?.at ?? 0) && now - session.lastOutputAt >= settleMs();
    return { session, starting: !!w && w.createdAt === session.createdAt && now - w.at < startupMs() && !settled };
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
        // reqStore: as rotas que resolvem outro workspace pelo nome consultam o acesso de quem chamou
        return await reqStore.run(req, async () => fn(context(req.params), req, reply));
      } catch (e: any) {
        if (e instanceof ApiError) return reply.status(e.status).send({ error: e.message });
        req.log.error(e);
        return reply.status(500).send({ error: e?.message || "Erro interno." });
      }
    };

  fastify.get(`${base}/context`, wrap((c) => {
    const pick = (type: string) => c.connected.filter((n) => n.type === type);
    return {
      self: { nodeId: c.me.id, workspace: c.workspace, title: c.title(c.me), isMaestro: c.me.data?.isMaestro === true, ...(c.me.data?.account && { account: c.me.data.account }) },
      agents: pick("agentTerminal").map((n) => ({ nodeId: n.id, title: c.title(n), isMaestro: n.data?.isMaestro === true, ...(n.data?.account && { account: n.data.account }) })),
      notes: c.reach.notes.map((r) => ({
        nodeId: r.node.id, title: c.title(r.node), locked: r.node.data?.locked === true,
        parent: r.parent ? c.title(r.parent) : null, stack: r.stack ? c.title(r.stack) : null,
      })),
      stacks: c.reach.stacks.map((s) => ({ nodeId: s.id, title: c.title(s) })),
      portals: pick("portal").map((n) => ({ nodeId: n.id, title: c.title(n), url: n.data?.url ?? "" })),
      bands: myBands(c.nodes, c.edges, c.me.id).map((b) => ({
        nodeId: b.id, title: c.title(b), mine: memberIds(b).includes(c.me.id),
        members: memberIds(b).map((id) => c.nodes.find((x) => x.id === id)).filter((x): x is Obj => !!x).map((x) => c.title(x)),
      })).concat(remoteBands(c)),
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

  fastify.post(`${base}/send`, wrap(async (c, req) => {
    const { target, text } = req.body ?? {};
    if (!isText(text)) throw new ApiError(400, "Informe o texto.");
    const t = resolveTarget(c, target, "agentTerminal");
    const { session, starting } = awake(c, t);
    await typePrompt(sessions, session, text);
    return { ok: true, ...(starting && { starting: true }) };
  }));

  fastify.get(`${base}/check`, wrap((c, req) => {
    const t = resolveTarget(c, req.query?.target, "agentTerminal");
    const { session, starting } = awake(c, t);
    const lines = Math.min(2000, Math.max(1, Math.floor(Number(req.query?.lines)) || 60));
    const out = stripAnsi(session.scrollback).replace(/\s+$/, "").split("\n");
    return { output: out.slice(-lines).join("\n"), ...(starting && { starting: true }) };
  }));

  // Envia e espera o PTY do alvo ficar quieto (depois de produzir saída); devolve só a saída nova
  fastify.post(`${base}/ask`, async (req: any, reply) => {
    let t: Obj;
    let c: Ctx;
    let text: string;
    let session: Session;
    let starting: boolean;
    try {
      c = context(req.params);
      const body = req.body ?? {};
      if (!isText(body.text)) throw new ApiError(400, "Informe o texto.");
      text = body.text;
      t = resolveTarget(c, body.target, "agentTerminal");
      ({ session, starting } = awake(c, t));
    } catch (e: any) {
      if (e instanceof ApiError) return reply.status(e.status).send({ error: e.message });
      return reply.status(500).send({ error: e?.message || "Erro interno." });
    }
    const timeoutS = Math.min(3600, Math.max(1, Number(req.body?.timeout) || 600));
    // Acabou de ser acordado: o agente ainda está subindo, digitar agora se perderia. O CLI sai com código 3.
    if (starting) return reply.send({ output: "", starting: true });

    // Cabeçalhos já: o cliente (fetch) não estoura headersTimeout; espaços de keepalive precedem o JSON
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { "content-type": "application/json" });
    const keepalive = setInterval(() => raw.write(" "), 30_000);

    let aborted = false;
    raw.on("close", () => (aborted = true));

    try {
      const r = await typeAndWait(sessions, session, { prompt: text }, timeoutS, () => aborted);
      if (!aborted) raw.end(JSON.stringify(r));
    } catch (e: any) {
      // Os cabeçalhos 200 já saíram (hijack): o erro vai no corpo; o CLI o transforma em erro com saída != 0
      if (!raw.writableEnded && !aborted) raw.end(JSON.stringify({ error: e?.message || "Erro interno." }));
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
    // Funciona também em outro workspace (agente ligado por link): remove o nó do canvas dele
    const pid = pidOf(c, t);
    canvas.applyAndBroadcast(pid, { kind: "removeNodes", ids: [t.id] }, `cli:${c.me.id}`);
    sweepBands(canvas, pid, `cli:${c.me.id}`); // banda com 1 membro se dissolve sozinha
    if (links) {
      links.dropNode(pid, t.id);
      canvas.notify(pid, { type: "links" });
      canvas.notify(c.projectId, { type: "links" });
    }
    return { ok: true };
  }));

  fastify.post(`${base}/notify`, wrap((c, req) => {
    const { text } = req.body ?? {};
    if (!isText(text, 500) || !text.trim()) throw new ApiError(400, "Informe o texto (até 500 caracteres).");
    canvas.notify(c.projectId, { type: "notify", from: { nodeId: c.me.id, title: c.title(c.me) }, text });
    desktopNotify(c.projectId, `Maestri — ${c.title(c.me)}`, text); // também pelo SO, se ligado
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
    const { author, thread = DEFAULT_THREAD } = req.body ?? {};
    const files = attachments ? attachments.resolve(c.projectId, req.body?.attachments) : [];
    if (req.body?.attachments !== undefined && !attachments) throw new ApiError(400, "Anexos indisponíveis.");
    const text: unknown = req.body?.text ?? "";
    // O texto pode faltar quando há anexos
    if (!isText(text, 20_000) || (!text.trim() && !files.length)) throw new ApiError(400, "Informe o texto.");
    if (!isThread(thread)) throw new ApiError(400, `Thread inválida (${THREADS.join(", ")}).`);
    // Com conta, nome e cor vêm dela (não do que o cliente manda)
    const user = req.authUser ? { id: req.authUser.id, name: req.authUser.name, color: req.authUser.color } : parseUser(author);
    if (!user) throw new ApiError(400, "Autor inválido (id, name e color #rrggbb).");
    const session = sessions.get(c.projectId, c.me.id);
    if (!session) throw new ApiError(409, "O terminal deste agente não tem sessão ativa.");
    const key = `${c.projectId}:${c.me.id}`;
    if (chatBusy.has(key)) throw new ApiError(409, "Agente ocupado.");

    // Monta TUDO o que vai ao PTY antes de marcar o agente como ocupado (uma exceção aqui não deixa chatBusy preso).
    // Texto e nomes de anexo passam por sanitizeTyped: sem ESC/controles (nada fecha o bracketed paste nem injeta teclas).
    const attLines = files.map((f) => `[Attachment: ${sanitizeTyped(f.name)} (${f.image ? "image" : sanitizeTyped(f.mime)}, ${f.size} bytes) — get it with: maestri recall attachment ${f.id}]`);
    const hinted = (wantsChatHeader(session) ? chatHeader(thread) : "") + [expandMentions(sanitizeTyped(text), c.connected), ...attLines].filter(Boolean).join("\n");

    chatBusy.add(key);
    try {
      appendChat(c.projectId, c.me.id, { role: "user", text, author: user, thread, ...(files.length && { attachments: files }) }, { chatBusy: true });
    } catch (e) {
      chatBusy.delete(key);
      throw e;
    }

    // Captura em segundo plano; a resposta 202 não espera
    void typeAndWait(sessions, session, { prompt: hinted }, 600)
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
  return { base, context, resolveTarget, requireMaestro, requireSession, patch, wrap, awake, pidOf };
}
