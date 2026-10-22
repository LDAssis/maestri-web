import crypto from "node:crypto";
import type { CanvasStore } from "./canvas.js";
import type { NodeApi } from "./nodeApi.js";
import { isText, lc } from "./nodeApi.js";
import { ApiError, SIZES, freePosition } from "./agents.js";

type Obj = Record<string, any>;

// Paleta de cores (nomes) e ícones curados; a web mapeia cada nome para classes/ícones do lucide-react
export const COLORS = ["amber", "indigo", "emerald", "rose", "sky", "violet", "orange", "slate"] as const;
export const ICONS = [
  "terminal", "bot", "code", "cpu", "brain", "rocket", "shield", "bug", "flask", "palette", "database", "globe",
  "search", "wrench", "book", "pen", "star", "heart", "zap", "flag", "crown", "sparkles", "lightbulb",
] as const;

const DEFAULT_STACK = "Fichário";
const TITLE_MAX = 40;

// Título derivado da primeira linha não vazia (sem marcadores markdown); vazio se não houver texto
export function titleFromContent(content: string) {
  const line = content.split("\n").map((l) => l.replace(/^\s*(#{1,6}\s+|[-*>]\s+)/, "").trim()).find(Boolean) ?? "";
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1).trimEnd()}…` : line;
}

// Nome único entre os nós do tipo (duplicados ganham " (2)", " (3)"...)
export function uniqueTitle(nodes: Obj[], type: string, base: string, exceptId?: string) {
  const taken = new Set(nodes.filter((n) => n.type === type && n.id !== exceptId).map((n) => lc(n.data?.title)));
  if (!taken.has(lc(base))) return base;
  for (let i = 2; ; i++) if (!taken.has(lc(`${base} (${i})`))) return `${base} (${i})`;
}

interface Deps {
  fastify: any;
  canvas: CanvasStore;
  nodeApi: NodeApi;
}

export function registerNotesApi({ fastify, canvas, nodeApi }: Deps) {
  const { base, resolveTarget, requireMaestro, patch, wrap } = nodeApi;
  type Ctx = ReturnType<typeof nodeApi.context>;

  const apply = (c: Ctx, op: Obj) => canvas.applyAndBroadcast(c.projectId, op as any, `cli:${c.me.id}`);
  const noteTarget = (c: Ctx, name: unknown) => resolveTarget(c, name, "stickyNote");
  const nt = (n: Obj) => String(n.data?.title ?? n.id);
  const visible = (c: Ctx) => c.nodes.filter((n) => !n.hidden);

  const assertUnlocked = (n: Obj, what: string) => {
    if (n.data?.locked === true) throw new ApiError(423, `A nota "${nt(n)}" está travada (locked): não é possível ${what}. Peça ao usuário para destravá-la no canvas.`);
  };
  const checkColor = (color: unknown) => {
    if (color !== undefined && !(COLORS as readonly string[]).includes(String(color))) throw new ApiError(400, `Cor inválida. Opções: ${COLORS.join(", ")}.`);
  };
  const checkIcon = (icon: unknown) => {
    if (icon !== undefined && !(ICONS as readonly string[]).includes(String(icon))) throw new ApiError(400, `Ícone inválido. Opções: ${ICONS.join(", ")}.`);
  };

  // Troca o conteúdo; se o título acompanha a primeira linha (nota sem nome fixo), renomeia e devolve o novo nome
  function setContent(c: Ctx, n: Obj, content: string) {
    const data: Obj = { content };
    let renamed: string | undefined;
    if (n.data?.autoTitle === true) {
      const derived = titleFromContent(content);
      if (derived && lc(derived) !== lc(nt(n))) {
        const t = uniqueTitle(c.nodes, "stickyNote", derived, n.id);
        if (t !== nt(n)) data.title = renamed = t;
      }
    }
    patch(c, n.id, data);
    return renamed;
  }

  function findStack(c: Ctx, name: string) {
    return c.reach.stacks.find((s) => lc(nt(s)) === lc(name));
  }

  // Guarda a nota num fichário (cria se não existir): nota some do canvas, fichário fica ligado ao nó atual
  function stackNote(c: Ctx, note: Obj, name: string) {
    let stack = findStack(c, name);
    if (!stack) {
      const id = `stack-${crypto.randomUUID().slice(0, 8)}`;
      stack = {
        id, type: "noteStack", position: note.position ?? freePosition(visible(c), c.me, SIZES.noteStack),
        style: { width: 300, height: 220 }, data: { title: uniqueTitle(c.nodes, "noteStack", name) },
      };
      apply(c, { kind: "upsertNodes", nodes: [stack] });
      apply(c, { kind: "upsertEdges", edges: [{ id: `e-${id}-${c.me.id}`, source: id, target: c.me.id }] });
    }
    // As ligações da nota passam para o fichário (cadeias continuam alcançáveis)
    const own = c.edges.filter((e) => e.source === note.id || e.target === note.id);
    if (own.length) apply(c, { kind: "removeEdges", ids: own.map((e) => e.id) });
    const others = [...new Set(own.map((e) => (e.source === note.id ? e.target : e.source)))].filter((o) => o !== stack.id && o !== c.me.id);
    if (others.length) apply(c, { kind: "upsertEdges", edges: others.map((o) => ({ id: `e-${stack.id}-${o}`, source: stack.id, target: o })) });
    patch(c, note.id, { stackId: stack.id });
    apply(c, { kind: "upsertNodes", nodes: [{ id: note.id, hidden: true }] });
    return nt(stack);
  }

  fastify.get(`${base}/notes/:target`, wrap((c: Ctx, req: any) => {
    const n = noteTarget(c, req.params.target);
    return { content: String(n.data?.content ?? ""), title: nt(n), locked: n.data?.locked === true };
  }));

  fastify.put(`${base}/notes/:target`, wrap((c: Ctx, req: any) => {
    const { text } = req.body ?? {};
    if (!isText(text)) throw new ApiError(400, "Informe o texto.");
    const n = noteTarget(c, req.params.target);
    assertUnlocked(n, "escrever nela");
    return { ok: true, renamed: setContent(c, n, text) };
  }));

  fastify.post(`${base}/notes/:target/edit`, wrap((c: Ctx, req: any) => {
    const { old, text } = req.body ?? {};
    if (!isText(old) || !old) throw new ApiError(400, "Informe o trecho antigo.");
    if (!isText(text)) throw new ApiError(400, "Informe o texto novo.");
    const n = noteTarget(c, req.params.target);
    assertUnlocked(n, "editá-la");
    const content = String(n.data?.content ?? "");
    const count = content.split(old).length - 1;
    if (count === 0) throw new ApiError(400, `O trecho não foi encontrado na nota "${nt(n)}".`);
    if (count > 1) throw new ApiError(400, `O trecho aparece ${count} vezes na nota "${nt(n)}"; use um trecho que apareça exatamente uma vez.`);
    const i = content.indexOf(old);
    return { ok: true, renamed: setContent(c, n, content.slice(0, i) + text + content.slice(i + old.length)) };
  }));

  fastify.post(`${base}/notes/:target`, wrap((c: Ctx, req: any) => {
    const { text } = req.body ?? {};
    if (!isText(text)) throw new ApiError(400, "Informe o texto.");
    const n = noteTarget(c, req.params.target);
    assertUnlocked(n, "acrescentar texto");
    const old = String(n.data?.content ?? "");
    return { ok: true, renamed: setContent(c, n, old ? `${old}\n${text}` : text) };
  }));

  fastify.delete(`${base}/notes/:target`, wrap((c: Ctx, req: any) => {
    const n = noteTarget(c, req.params.target);
    assertUnlocked(n, "apagá-la");
    apply(c, { kind: "removeNodes", ids: [n.id] });
    return { ok: true };
  }));

  fastify.post(`${base}/notes`, wrap((c: Ctx, req: any) => {
    const { title, text, name, stack, color } = req.body ?? {};
    // Forma antiga: { title, text } — o título vira nome fixo
    const content = text ?? "";
    if (!isText(content)) throw new ApiError(400, "Informe o texto.");
    if (title !== undefined && (!isText(title, 200) || !title.trim())) throw new ApiError(400, "Título inválido.");
    if (name !== undefined && (!isText(name, 200) || !name.trim())) throw new ApiError(400, "Nome inválido.");
    if (stack !== undefined && stack !== true && (!isText(stack, 200) || !stack.trim())) throw new ApiError(400, "Nome de fichário inválido.");
    checkColor(color);
    const pinned = String(name ?? title ?? "").trim();
    const base0 = pinned || titleFromContent(content) || "Nova nota";
    const finalTitle = uniqueTitle(c.nodes, "stickyNote", base0);
    const id = `note-${crypto.randomUUID().slice(0, 8)}`;
    const node = {
      id, type: "stickyNote", position: freePosition(visible(c), c.me, SIZES.stickyNote), style: { width: 280, height: 200 },
      data: {
        title: finalTitle, color: color ?? "amber", author: `🤖 ${nt(c.me)}`, content,
        ...(pinned ? { pinnedName: true } : { autoTitle: true }),
      },
    };
    apply(c, { kind: "upsertNodes", nodes: [node] });
    apply(c, { kind: "upsertEdges", edges: [{ id: `e-${id}-${c.me.id}`, source: id, target: c.me.id }] });
    let stackName: string | undefined;
    if (stack !== undefined) {
      const fresh = canvas.state(c.projectId).nodes!.find((n) => n.id === id)!;
      stackName = stackNote(c, fresh, stack === true ? DEFAULT_STACK : stack.trim());
    }
    return { ok: true, nodeId: id, title: finalTitle, stack: stackName };
  }));

  fastify.post(`${base}/notes/:target/stack`, wrap((c: Ctx, req: any) => {
    const n = noteTarget(c, req.params.target);
    const name = String(req.body?.stack ?? "").trim() || DEFAULT_STACK;
    if (name.length > 200) throw new ApiError(400, "Nome de fichário inválido.");
    if (n.data?.stackId) {
      const cur = c.nodes.find((s) => s.id === n.data.stackId);
      if (cur && lc(nt(cur)) === lc(name)) throw new ApiError(400, `A nota "${nt(n)}" já está no fichário "${nt(cur)}".`);
    }
    return { ok: true, stack: stackNote(c, n, name) };
  }));

  fastify.post(`${base}/notes/:target/unstack`, wrap((c: Ctx, req: any) => {
    const n = noteTarget(c, req.params.target);
    const stack = n.data?.stackId ? c.nodes.find((s) => s.id === n.data.stackId) : null;
    if (!stack) throw new ApiError(400, `A nota "${nt(n)}" não está em um fichário.`);
    // A nota volta ao canvas ao lado do fichário e herda as ligações dele
    const nodes = visible(c);
    const position = freePosition(nodes, stack, SIZES.stickyNote);
    patch(c, n.id, { stackId: null });
    apply(c, { kind: "upsertNodes", nodes: [{ id: n.id, hidden: false, position }] });
    const links = c.edges.filter((e) => e.source === stack.id || e.target === stack.id).map((e) => (e.source === stack.id ? e.target : e.source));
    apply(c, { kind: "upsertEdges", edges: [...new Set(links)].map((o) => ({ id: `e-${n.id}-${o}`, source: n.id, target: o })) });
    return { ok: true, stack: nt(stack) };
  }));

  // --- arrange: nome, ícone e cor de você, de uma nota conectada ou (Maestro) de um agente conectado ---
  const styleOf = (n: Obj) => ({ title: nt(n), type: n.type, icon: n.data?.icon ?? null, color: n.data?.color ?? null });

  fastify.get(`${base}/arrange`, wrap((c: Ctx) => {
    const list = [c.me, ...c.reach.notes.map((r) => r.node), ...c.reach.stacks];
    if (c.me.data?.isMaestro === true) list.push(...c.connected.filter((n) => n.type === "agentTerminal"));
    return { items: list.map(styleOf), icons: ICONS, colors: COLORS };
  }));

  fastify.post(`${base}/arrange`, wrap((c: Ctx, req: any) => {
    const { target, name, icon, color } = req.body ?? {};
    if (name === undefined && icon === undefined && color === undefined) throw new ApiError(400, "Informe --name, --icon e/ou --color.");
    if (name !== undefined && (!isText(name, 64) || !name.trim())) throw new ApiError(400, "Nome inválido (até 64 caracteres).");
    checkIcon(icon);
    checkColor(color);
    // Sem alvo = o próprio nó
    if (target !== undefined && (!isText(target, 200) || !target.trim())) throw new ApiError(400, "Informe o nome do alvo.");
    const self = target === undefined || lc(target) === lc(nt(c.me));
    const t = self ? c.me : resolveTarget(c, target);
    if (!self && t.type === "agentTerminal") requireMaestro(c, "alterar o estilo de outro agente");
    if (!["agentTerminal", "stickyNote", "noteStack"].includes(t.type)) throw new ApiError(400, "Só agentes, notas e fichários aceitam arrange.");
    const data: Obj = {};
    if (icon !== undefined) data.icon = icon;
    if (color !== undefined) data.color = color;
    if (name !== undefined) {
      const n0 = name.trim();
      if (t.type === "agentTerminal") {
        if (c.nodes.some((x) => x.type === "agentTerminal" && x.id !== t.id && lc(nt(x)) === lc(n0))) throw new ApiError(409, `Já existe um agente chamado "${n0}".`);
        data.title = n0;
      } else {
        data.title = uniqueTitle(c.nodes, t.type, n0, t.id);
        if (t.type === "stickyNote") Object.assign(data, { pinnedName: true, autoTitle: false });
      }
    }
    if (t.type === "stickyNote" && t.data?.locked === true && data.title) assertUnlocked(t, "renomeá-la");
    patch(c, t.id, data);
    return { ok: true, title: data.title ?? nt(t) };
  }));
}
