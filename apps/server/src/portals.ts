import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page, type Locator } from "playwright-core";
import type { WebSocket } from "ws";
import type { CanvasStore } from "./canvas.js";
import { ApiError } from "./agents.js";

type Obj = Record<string, any>;

export const DEFAULT_VIEWPORT = { w: 1280, h: 800 };
const ACTION_TIMEOUT = 5000;
const NAV_TIMEOUT = 20_000;
const MAX_POPUPS = 8; // popups abertos ao mesmo tempo por portal raiz
const FRAME_MS = Number(process.env.MAESTRI_PORTAL_FRAME_MS) || 700;
const SNAPSHOT_MAX = 300;

// Presets de user agent (o mesmo conjunto do Maestri nativo); desktop = sem override
export const UA_PRESETS: Record<string, string | null> = {
  ios: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  android: "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
  "firefox-android": "Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0",
  "edge-android": "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36 EdgA/141.0.0.0",
  chrome: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  firefox: "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
  edge: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
  desktop: null,
};
const MOBILE_UA = new Set(["ios", "android", "firefox-android", "edge-android"]);

// Portas em que a própria API do Maestri atende (definidas pelo servidor ao subir); o portal não navega até ela
let selfPorts: () => number[] = () => [];
export const setPortalSelfPorts = (fn: () => number[]) => {
  selfPorts = fn;
};

// Por que um destino é bloqueado (por padrão): link-local e metadata de nuvem (credenciais!) e a API do próprio servidor.
// localhost em OUTRAS portas continua livre (é o caso de uso de dev). MAESTRI_PORTAL_ALLOW_PRIVATE=1 libera tudo.
// Limite: só olha o nome/IP digitado; um nome DNS que resolva para esses endereços não é detectado.
export function blockedReason(u: URL): string | null {
  if (process.env.MAESTRI_PORTAL_ALLOW_PRIVATE === "1") return null;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "metadata.google.internal" || host === "metadata") return "endereço de metadata de nuvem";
  if (/^169\.254\./.test(host)) return "endereço link-local/metadata (169.254.0.0/16)";
  if (host === "fd00:ec2::254" || /^fe[89ab][0-9a-f]:/.test(host)) return "endereço link-local/metadata (IPv6)";
  if (/^::ffff:a9fe:/.test(host)) return "endereço link-local/metadata (169.254.0.0/16)";
  const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
  const loopback = host === "localhost" || host.endsWith(".localhost") || /^127\./.test(host) || host === "::1" || host === "0.0.0.0" || host === "::";
  if (loopback && selfPorts().includes(port)) return "a API do próprio servidor do Maestri";
  return null;
}

// Só http/https (localhost incluso); devolve a URL normalizada ou "" (inválida ou bloqueada, veja urlError)
export function httpUrl(raw: unknown) {
  try {
    const u = new URL(String(raw ?? "").trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return blockedReason(u) ? "" : u.href;
  } catch {
    return "";
  }
}

// Mensagem de erro para uma URL que httpUrl recusou
export function urlError(raw: unknown): string {
  try {
    const u = new URL(String(raw ?? "").trim());
    const why = (u.protocol === "http:" || u.protocol === "https:") && blockedReason(u);
    if (why) return `URL bloqueada: ${why}. (MAESTRI_PORTAL_ALLOW_PRIVATE=1 libera.)`;
  } catch {}
  return "URL inválida (apenas http/https).";
}

interface Entry {
  key: string;
  projectId: string;
  nodeId: string;
  ctx: BrowserContext;
  owner: boolean; // dono do contexto (popups compartilham o do pai)
  page: Page;
  ua: string | null;
  viewport: { w: number; h: number };
  logs: string[];
  logging: boolean;
  watchers: Set<WebSocket>;
  timer?: NodeJS.Timeout;
  capturing: boolean;
  lastFrame?: Buffer;
  lastMeta?: string;
  queue: Promise<unknown>;
  popups: number; // contador para nomear "[Pai] #N"
  parent?: string;
}

// Gerencia uma página Chromium headless por nó de portal (aberta sob demanda)
export class PortalManager {
  private entries = new Map<string, Entry>();
  private opening = new Map<string, Promise<Entry>>();
  private browserP: Promise<Browser> | null = null;

  // repoOf/extraUploadRoots: de onde o `upload` pode ler arquivos (projeto, anexos do chat); o tmpdir vale sempre
  constructor(private canvas: CanvasStore, private opts: { repoOf?: (projectId: string) => string | null; extraUploadRoots?: (projectId: string) => string[] } = {}) {}

  uploadRoots(projectId: string): string[] {
    const roots = [os.tmpdir(), this.opts.repoOf?.(projectId), ...(this.opts.extraUploadRoots?.(projectId) ?? [])].filter((r): r is string => !!r);
    return roots.flatMap((r) => {
      try {
        return [fs.realpathSync(r)];
      } catch {
        return [];
      }
    });
  }

  private key(projectId: string, nodeId: string) {
    return `${projectId}:${nodeId}`;
  }

  private browser() {
    if (!this.browserP) {
      const args = process.env.MAESTRI_PORTAL_NO_SANDBOX ? ["--no-sandbox"] : [];
      const p = chromium.launch({ headless: true, args }).then(
        (b) => {
          // Chromium morreu/foi encerrado: esquece o navegador para o próximo comando lançar outro (senão todo
          // portal falhava com "Target closed" até reiniciar o servidor)
          b.on("disconnected", () => {
            if (this.browserP === p) this.browserP = null;
          });
          return b;
        },
        (e: any) => {
          if (this.browserP === p) this.browserP = null;
          throw new ApiError(503, `Não foi possível iniciar o Chromium: ${String(e?.message ?? e).split("\n")[0]}`);
        },
      );
      this.browserP = p;
    }
    return this.browserP;
  }

  private async newContext(vp: { w: number; h: number }, ua: string | null, preset?: string) {
    const browser = await this.browser();
    const ctx = await browser.newContext({
      viewport: { width: vp.w, height: vp.h },
      ...(ua ? { userAgent: ua } : {}),
      ...(preset && MOBILE_UA.has(preset) ? { isMobile: preset !== "firefox-android", hasTouch: true } : {}),
    });
    // Cobre também redirecionamentos e sub-requisições: nada chega ao metadata/link-local nem à API do servidor
    await ctx.route((url) => blockedReason(url) !== null, (route) => route.abort("blockedbyclient"));
    return ctx;
  }

  has(projectId: string, nodeId: string) {
    return this.entries.has(this.key(projectId, nodeId));
  }

  patchNode(e: Entry, data: Obj) {
    this.canvas.applyAndBroadcast(e.projectId, { kind: "patchNodeData", id: e.nodeId, data }, `portal:${e.nodeId}`);
  }

  // Abre (ou devolve) a página do nó; na abertura navega até a url do nó e liga o modo "ao vivo"
  async ensure(projectId: string, nodeId: string): Promise<Entry> {
    const key = this.key(projectId, nodeId);
    const cur = this.entries.get(key);
    if (cur && !cur.page.isClosed()) return cur;
    let p = this.opening.get(key);
    if (!p) {
      p = this.open(projectId, nodeId).finally(() => this.opening.delete(key));
      this.opening.set(key, p);
    }
    return p;
  }

  private async open(projectId: string, nodeId: string): Promise<Entry> {
    const node = this.canvas.state(projectId).nodes?.find((n) => n.id === nodeId);
    if (!node) throw new ApiError(404, "Portal não encontrado no canvas.");
    const vw = Number(node.data?.viewport?.w);
    const vh = Number(node.data?.viewport?.h);
    const viewport = vw > 0 && vh > 0 ? { w: vw, h: vh } : { ...DEFAULT_VIEWPORT };
    const ctx = await this.newContext(viewport, null);
    const page = await ctx.newPage();
    const e = this.register(projectId, nodeId, ctx, page, true, viewport);
    if (node.data?.live !== true) this.patchNode(e, { live: true });
    const url = httpUrl(node.data?.url);
    if (url) {
      // Se falhar, a página fica aberta (about:blank) e o erro vai só para quem pediu a abertura
      await this.goto(e, url);
    }
    return e;
  }

  private register(projectId: string, nodeId: string, ctx: BrowserContext, page: Page, owner: boolean, viewport: { w: number; h: number }, parent?: string) {
    const e: Entry = {
      key: this.key(projectId, nodeId), projectId, nodeId, ctx, owner, page, ua: null, viewport,
      logs: [], logging: false, watchers: new Set(), capturing: false, queue: Promise.resolve(), popups: 1, parent,
    };
    this.entries.set(e.key, e);
    this.attachPage(e, page);
    return e;
  }

  private attachPage(e: Entry, page: Page) {
    page.on("console", (m) => {
      if (e.logging) e.logs.push(`[${m.type()}] ${m.text()}`);
    });
    page.on("pageerror", (err) => {
      if (e.logging) e.logs.push(`[pageerror] ${err.message}`);
    });
    page.on("framenavigated", (f) => {
      if (f !== page.mainFrame()) return;
      const url = httpUrl(f.url());
      const node = this.canvas.state(e.projectId).nodes?.find((n) => n.id === e.nodeId);
      if (url && node && node.data?.url !== url) this.patchNode(e, { url });
      void this.pushFrame(e);
    });
    page.on("popup", (pop) => void this.adoptPopup(e, pop));
    page.on("close", () => {
      if (e.page !== page) return; // página antiga (troca de contexto pelo ua)
      if (!e.owner) this.dropPopup(e);
    });
  }

  // Popup aberto pela página vira um nó de portal "[Pai] #N", ligado aos mesmos agentes do pai
  private async adoptPopup(parent: Entry, page: Page) {
    // Teto de popups abertos por portal raiz: um site que abre janelas sem parar não enche o canvas nem a memória
    let root = parent;
    for (let up = root.parent ? this.entries.get(root.parent) : undefined; up; up = root.parent ? this.entries.get(root.parent) : undefined) root = up;
    const open = [...this.entries.values()].filter((x) => x !== root && x.parent && this.rootOf(x) === root).length;
    if (open >= MAX_POPUPS) {
      await page.close().catch(() => {});
      return;
    }
    const st = this.canvas.state(parent.projectId);
    const pn = st.nodes?.find((n) => n.id === parent.nodeId);
    if (!pn) return;
    const base = String(pn.data?.title ?? "Portal").replace(/ #\d+$/, "");
    const titles = new Set((st.nodes ?? []).map((n) => String(n.data?.title)));
    let n = parent.popups + 1;
    while (titles.has(`${base} #${n}`)) n++;
    parent.popups = n;
    const id = `portal-${crypto.randomUUID().slice(0, 8)}`;
    const node = {
      id, type: "portal",
      position: { x: (pn.position?.x ?? 0) + 40, y: (pn.position?.y ?? 0) + 60 },
      style: pn.style ?? { width: 480, height: 330 },
      data: { title: `${base} #${n}`, url: httpUrl(page.url()), live: true, viewport: parent.viewport },
    };
    const from = `portal:${parent.nodeId}`;
    this.canvas.applyAndBroadcast(parent.projectId, { kind: "upsertNodes", nodes: [node] }, from);
    const edges = (st.edges ?? [])
      .filter((e) => e.source === parent.nodeId || e.target === parent.nodeId)
      .map((e) => (e.source === parent.nodeId ? e.target : e.source))
      .map((other) => ({ id: `e-${other}-${id}`, source: other, target: id }));
    edges.push({ id: `e-${parent.nodeId}-${id}`, source: parent.nodeId, target: id });
    this.canvas.applyAndBroadcast(parent.projectId, { kind: "upsertEdges", edges }, from);
    const e = this.register(parent.projectId, id, parent.ctx, page, false, parent.viewport, parent.key);
    e.ua = parent.ua;
    void this.pushFrame(e);
  }

  private rootOf(e: Entry): Entry {
    let cur = e;
    for (let up = cur.parent ? this.entries.get(cur.parent) : undefined; up; up = cur.parent ? this.entries.get(cur.parent) : undefined) cur = up;
    return cur;
  }

  // Popup fechado pelo site: remove o nó dele do canvas
  private dropPopup(e: Entry) {
    if (!this.entries.delete(e.key)) return;
    this.stopWatching(e);
    this.canvas.applyAndBroadcast(e.projectId, { kind: "removeNodes", ids: [e.nodeId] }, `portal:${e.nodeId}`);
    this.maybeCloseBrowser();
  }

  private maybeCloseBrowser() {
    if (this.entries.size > 0 || this.opening.size > 0 || !this.browserP) return;
    const p = this.browserP;
    this.browserP = null;
    void p.then((b) => b.close()).catch(() => {});
  }

  private stopWatching(e: Entry) {
    if (e.timer) clearInterval(e.timer);
    e.timer = undefined;
    for (const ws of e.watchers) {
      try {
        ws.close(1000, "Portal fechado");
      } catch {}
    }
    e.watchers.clear();
  }

  // Nós removidos do canvas (ou projeto apagado): fecha as páginas e, no fim, o navegador
  closeNodes(projectId: string, ids: string[]) {
    for (const id of ids) {
      const e = this.entries.get(this.key(projectId, id));
      if (!e) continue;
      this.entries.delete(e.key);
      this.stopWatching(e);
      if (e.owner) {
        for (const o of [...this.entries.values()].filter((x) => x.ctx === e.ctx)) {
          this.entries.delete(o.key);
          this.stopWatching(o);
          this.canvas.applyAndBroadcast(o.projectId, { kind: "removeNodes", ids: [o.nodeId] }, `portal:${o.nodeId}`);
        }
        void e.ctx.close().catch(() => {});
      } else void e.page.close().catch(() => {});
    }
    this.maybeCloseBrowser();
  }

  closeProject(projectId: string) {
    this.closeNodes(projectId, [...this.entries.values()].filter((e) => e.projectId === projectId).map((e) => e.nodeId));
  }

  async closeAll() {
    for (const e of this.entries.values()) this.stopWatching(e);
    this.entries.clear();
    const p = this.browserP;
    this.browserP = null;
    if (p) await p.then((b) => b.close()).catch(() => {});
  }

  // ---- Navegação ----

  private async goto(e: Entry, url: string) {
    try {
      await e.page.goto(url, { waitUntil: "load", timeout: NAV_TIMEOUT });
    } catch (err: any) {
      throw new ApiError(502, `falha ao carregar ${url}: ${String(err?.message ?? err).split("\n")[0].replace(/^page\.goto: /, "")}`);
    }
    await this.pushFrame(e);
  }

  // Comandos de automação são serializados por portal (as refs dependem da ordem)
  private serial<T>(e: Entry, fn: () => Promise<T>): Promise<T> {
    const run = e.queue.then(fn, fn);
    e.queue = run.catch(() => {});
    return run;
  }

  async navigate(projectId: string, nodeId: string, url: string) {
    const e = this.entries.get(this.key(projectId, nodeId));
    if (!e || e.page.isClosed()) return null;
    await this.serial(e, () => this.goto(e, url));
    return { url: e.page.url(), title: await e.page.title().catch(() => "") };
  }

  // ---- Frames ao vivo ----

  private async meta(e: Entry) {
    const title = await e.page.title().catch(() => "");
    return JSON.stringify({ type: "meta", url: e.page.url(), title, w: e.viewport.w, h: e.viewport.h });
  }

  // Captura um JPEG e manda aos observadores (só se algo mudou)
  async pushFrame(e: Entry, force = false) {
    if (!e.watchers.size || e.capturing || e.page.isClosed()) return;
    e.capturing = true;
    try {
      const jpg = await e.page.screenshot({ type: "jpeg", quality: 55, timeout: 4000 });
      const meta = await this.meta(e);
      const same = !force && e.lastFrame?.equals(jpg) && e.lastMeta === meta;
      if (same) return;
      for (const ws of e.watchers) {
        if (ws.readyState !== 1) continue;
        try {
          if (e.lastMeta !== meta) ws.send(meta);
          ws.send(jpg, { binary: true });
        } catch {}
      }
      e.lastFrame = jpg;
      e.lastMeta = meta;
    } catch {
      // página navegando/fechando: o próximo ciclo tenta de novo
    } finally {
      e.capturing = false;
    }
  }

  // Cliente do canvas passa a observar a sessão (abre a página se preciso)
  async watch(projectId: string, nodeId: string, socket: WebSocket) {
    const say = (m: Obj) => {
      try {
        socket.send(JSON.stringify(m));
      } catch {} // o cliente pode ter caído no meio
    };
    // Os handlers entram ANTES do await do ensure: entradas iniciais do usuário ficam na fila (até 50) e não se perdem
    let entry: Entry | null = null;
    let closed = false;
    const queued: (Buffer | string)[] = [];
    const handle = (e: Entry, raw: Buffer | string) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      void this.userInput(e, msg).catch((err) => say({ type: "error", error: err?.message ?? String(err) }));
    };
    socket.on("message", (raw: Buffer | string) => {
      if (entry) handle(entry, raw);
      else if (queued.length < 50) queued.push(raw);
    });
    socket.on("close", () => {
      closed = true;
      if (!entry) return;
      entry.watchers.delete(socket);
      if (!entry.watchers.size && entry.timer) {
        clearInterval(entry.timer);
        entry.timer = undefined;
      }
    });

    let e: Entry;
    try {
      e = await this.ensure(projectId, nodeId);
    } catch (err: any) {
      say({ type: "error", error: err?.message ?? "Falha ao abrir o portal." });
      // a página existe mesmo com falha de carga (about:blank); ainda assim observa se houver
      const cur = this.entries.get(this.key(projectId, nodeId));
      if (!cur) return;
      e = cur;
    }
    if (closed) return;
    entry = e;
    e.watchers.add(socket);
    e.lastFrame = undefined;
    e.lastMeta = undefined;
    if (!e.timer) e.timer = setInterval(() => void this.pushFrame(e), FRAME_MS);
    void this.pushFrame(e, true);
    for (const raw of queued.splice(0)) handle(e, raw);
  }

  // Cliques, digitação, rolagem e navegação feitos pelo usuário no nó
  private async userInput(e: Entry, m: Obj) {
    const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    await this.serial(e, async () => {
      const p = e.page;
      switch (m.type) {
        case "click":
          await p.mouse.click(num(m.x), num(m.y), { clickCount: m.dbl ? 2 : 1, button: m.button === "right" ? "right" : "left" });
          break;
        case "move":
          await p.mouse.move(num(m.x), num(m.y));
          break;
        case "scroll":
          await p.mouse.move(num(m.x), num(m.y));
          await p.mouse.wheel(num(m.dx), num(m.dy));
          break;
        case "type":
          if (typeof m.text === "string" && m.text.length <= 2000) await p.keyboard.type(m.text);
          break;
        case "key":
          if (typeof m.key === "string") await p.keyboard.press(parseKey(m.key));
          break;
        case "navigate": {
          const url = httpUrl(m.url);
          if (!url) throw new ApiError(400, urlError(m.url));
          await this.goto(e, url);
          break;
        }
        case "reload":
          await p.reload({ timeout: NAV_TIMEOUT });
          break;
        case "back":
          await p.goBack({ timeout: NAV_TIMEOUT });
          break;
        case "forward":
          await p.goForward({ timeout: NAV_TIMEOUT });
          break;
        default:
          return;
      }
      await settle(p);
      await this.pushFrame(e);
    });
  }

  // ---- Comandos de automação (CLI) ----

  async run(projectId: string, nodeId: string, cmd: string, args: string[]): Promise<string> {
    const handler = COMMANDS[cmd];
    if (!handler) throw new ApiError(400, `verbo desconhecido: ${cmd}`);
    const e = await this.ensure(projectId, nodeId);
    return this.serial(e, async () => {
      try {
        const out = await handler(this, e, args);
        await settle(e.page);
        void this.pushFrame(e);
        return out;
      } catch (err: any) {
        if (err instanceof ApiError) throw err;
        throw new ApiError(400, cleanError(err));
      }
    });
  }

  // Troca o contexto (user agent só vale na criação) e reabre a mesma URL
  async replaceContext(e: Entry, ua: string | null, preset?: string) {
    const url = e.page.url();
    const old = e.ctx;
    const ctx = await this.newContext(e.viewport, ua, preset);
    const page = await ctx.newPage();
    e.ctx = ctx;
    e.page = page;
    e.ua = ua;
    this.attachPage(e, page);
    await old.close().catch(() => {});
    if (httpUrl(url)) await this.goto(e, url);
  }
}

// ---- helpers de página ----

const KEY_NAMES: Record<string, string> = {
  enter: "Enter", return: "Enter", tab: "Tab", escape: "Escape", esc: "Escape", backspace: "Backspace", delete: "Delete", del: "Delete",
  up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", arrowup: "ArrowUp", arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft", arrowright: "ArrowRight", space: "Space", home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown",
};
const MODS: Record<string, string> = { ctrl: "Control", control: "Control", shift: "Shift", alt: "Alt", option: "Alt", cmd: "ControlOrMeta", meta: "ControlOrMeta", command: "ControlOrMeta" };

// "ctrl+a", "shift+tab", "Enter" -> combinação aceita pelo Playwright
export function parseKey(spec: string) {
  const parts = spec.split("+").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) throw new ApiError(400, "tecla vazia");
  return parts
    .map((p, i) => {
      const l = p.toLowerCase();
      if (i < parts.length - 1) {
        if (!MODS[l]) throw new ApiError(400, `modificador desconhecido: ${p}`);
        return MODS[l];
      }
      return KEY_NAMES[l] ?? (/^f\d{1,2}$/i.test(p) ? p.toUpperCase() : p.length === 1 ? p : p[0].toUpperCase() + p.slice(1));
    })
    .join("+");
}

const cleanError = (err: any) => {
  const msg = String(err?.message ?? err).split("\n")[0];
  if (/Timeout \d+ms exceeded/.test(msg)) return `tempo esgotado: elemento não encontrado ou não interagível (${msg.replace(/^\w+\.\w+: /, "")})`;
  return msg.replace(/^\w+\.\w+: /, "");
};

// Dá uma folga para a página reagir (navegação disparada por clique, etc.)
async function settle(p: Page) {
  await p.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => {});
  await p.waitForTimeout(80).catch(() => {});
}

const COORDS = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;
type Target = { loc: Locator; point?: undefined } | { point: { x: number; y: number }; loc?: undefined };

// Seletor: ref @eN, coordenadas x,y ou CSS
async function target(e: Entry, sel: string | undefined): Promise<Target> {
  if (!sel) throw new ApiError(400, "informe o seletor (@eN, CSS ou x,y).");
  const c = COORDS.exec(sel);
  if (c) return { point: { x: Number(c[1]), y: Number(c[2]) } };
  const ref = /^@e(\d+)$/.exec(sel);
  const loc = e.page.locator(ref ? `[data-maestri-ref="e${ref[1]}"]` : sel).first();
  let n = 0;
  try {
    n = await loc.count();
  } catch {
    throw new ApiError(400, `seletor CSS inválido: ${sel}`);
  }
  if (!n) throw new ApiError(404, ref ? `ref ${sel} não encontrada (rode snapshot de novo; refs valem até o próximo snapshot ou navegação)` : `elemento não encontrado: ${sel}`);
  return { loc };
}

const need = (args: string[], n: number, usage: string) => {
  if (args.length < n) throw new ApiError(400, `uso: ${usage}`);
};

async function focusTarget(e: Entry, sel: string | undefined) {
  if (!sel) return;
  const t = await target(e, sel);
  if (t.point) await e.page.mouse.click(t.point.x, t.point.y);
  else await t.loc.focus({ timeout: ACTION_TIMEOUT });
}

async function viewportOf(p: Page) {
  const v = await p.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  return `${v.w}x${v.h}`;
}

async function snapshot(p: Page) {
  const header = { url: p.url(), title: await p.title().catch(() => "") };
  const { vp, lines } = await p.evaluate((max) => {
    // tsx/esbuild injeta __name nas funções internas; no navegador ele não existe
    (globalThis as any).__name ??= (f: unknown) => f;
    for (const old of Array.from(document.querySelectorAll("[data-maestri-ref]"))) old.removeAttribute("data-maestri-ref");
    const vp = { w: window.innerWidth, h: window.innerHeight };
    const SEL = [
      "a[href]", "button", "input:not([type=hidden])", "select", "textarea", "summary", "[contenteditable=''],[contenteditable='true']",
      "[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=switch],[role=option],[role=combobox],[role=textbox]",
      "[onclick]", "[tabindex]:not([tabindex^='-'])",
    ].join(",");
    const short = (s: string, n = 80) => {
      const t = s.replace(/\s+/g, " ").trim();
      return t.length > n ? `${t.slice(0, n - 1)}…` : t;
    };
    const labelOf = (el: any): string => {
      const aria = el.getAttribute("aria-label");
      if (aria) return short(aria);
      if (el.labels?.length) return short(Array.from(el.labels).map((l: any) => l.innerText || l.textContent || "").join(" "));
      const lb = el.getAttribute("aria-labelledby");
      if (lb) {
        const t = lb.split(/\s+/).map((id: string) => document.getElementById(id)?.textContent ?? "").join(" ");
        if (t.trim()) return short(t);
      }
      const tag = el.tagName.toLowerCase();
      if (tag === "input" && ["button", "submit", "reset"].includes(el.type)) return short(el.value || "");
      if (tag === "input" || tag === "textarea") return short(el.placeholder || el.title || el.name || "");
      if (tag === "select") return short(el.title || el.name || "");
      if (tag === "img") return short(el.alt || "");
      return short(el.innerText || el.textContent || el.title || el.getAttribute("alt") || "");
    };
    const q = (s: string) => `"${s.replace(/"/g, '\\"')}"`;
    const lines: string[] = [];
    let n = 0;
    for (const el of Array.from(document.querySelectorAll(SEL)) as any[]) {
      if (n >= max) break;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0 || r.bottom <= 0 || r.right <= 0 || r.top >= vp.h || r.left >= vp.w) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none" || cs.opacity === "0") continue;
      n++;
      el.setAttribute("data-maestri-ref", `e${n}`);
      const tag = el.tagName.toLowerCase();
      const parts = [`@e${n}`, tag];
      const role = el.getAttribute("role");
      if (role && !["a", "button", "input", "select", "textarea"].includes(tag)) parts.push(`role=${role}`);
      if (tag === "input") parts.push(`type=${el.type || "text"}`);
      const label = labelOf(el);
      if (label) parts.push(q(label));
      if (tag === "a" && el.href) parts.push(`href=${el.href}`);
      if (tag === "input" && ["checkbox", "radio"].includes(el.type)) parts.push(el.checked ? "checked" : "unchecked");
      else if (tag === "select") parts.push(`value=${q(short(el.selectedOptions[0]?.text ?? ""))}`);
      else if ((tag === "input" || tag === "textarea") && el.type !== "password" && el.value) parts.push(`value=${q(short(el.value, 60))}`);
      if (el.disabled) parts.push("disabled");
      parts.push(`[${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}]`);
      if (el === document.activeElement) parts.push("*focused*");
      lines.push(parts.join(" "));
    }
    return { vp, lines };
  }, SNAPSHOT_MAX);
  return [`viewport: ${vp.w}x${vp.h}  url: ${header.url}  title: ${header.title}`, ...lines].join("\n");
}

type Handler = (m: PortalManager, e: Entry, args: string[]) => Promise<string>;

const nav = (what: (p: Page) => Promise<unknown>): Handler => async (_m, e) => {
  try {
    const r = await what(e.page);
    if (r === null) throw new ApiError(400, "sem histórico nessa direção.");
  } catch (err: any) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(502, `falha ao navegar: ${String(err?.message ?? err).split("\n")[0]}`);
  }
  return `${e.page.url()} — ${await e.page.title().catch(() => "")}`;
};

const COMMANDS: Record<string, Handler> = {
  back: nav((p) => p.goBack({ timeout: NAV_TIMEOUT })),
  forward: nav((p) => p.goForward({ timeout: NAV_TIMEOUT })),
  reload: nav((p) => p.reload({ timeout: NAV_TIMEOUT })),

  async info(_m, e) {
    return `url: ${e.page.url()}\ntitle: ${await e.page.title().catch(() => "")}\nviewport: ${await viewportOf(e.page)}`;
  },

  async screenshot(_m, e) {
    const buf = await e.page.screenshot({ type: "png" });
    // Pasta própria (0700) e arquivo novo (wx, 0600): nome imprevisível, sem sobrescrever nem seguir links plantados no /tmp
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maestri-portal-"));
    const file = path.join(dir, `${e.nodeId}-${Date.now()}.png`);
    fs.writeFileSync(file, buf, { flag: "wx", mode: 0o600 });
    return file;
  },

  snapshot: (_m, e) => snapshot(e.page),

  async click(_m, e, a) {
    need(a, 1, 'click "Portal" <seletor>');
    const t = await target(e, a[0]);
    if (t.point) await e.page.mouse.click(t.point.x, t.point.y);
    else await t.loc.click({ timeout: ACTION_TIMEOUT });
    return "ok";
  },

  async fill(_m, e, a) {
    need(a, 2, 'fill "Portal" <seletor> "texto"');
    const t = await target(e, a[0]);
    if (t.point) {
      await e.page.mouse.click(t.point.x, t.point.y);
      await e.page.keyboard.press("ControlOrMeta+a");
      await e.page.keyboard.press("Backspace");
      await e.page.keyboard.insertText(a[1]);
    } else await t.loc.fill(a[1], { timeout: ACTION_TIMEOUT });
    return "ok";
  },

  // type [seletor] texto: acrescenta no fim do campo (sem seletor, digita no elemento focado)
  async type(_m, e, a) {
    need(a, 1, 'type "Portal" [seletor] "texto"');
    const text = a.length >= 2 ? a.slice(1).join(" ") : a[0];
    if (a.length >= 2) {
      const t = await target(e, a[0]);
      if (t.point) await e.page.mouse.click(t.point.x, t.point.y);
      else {
        await t.loc.focus({ timeout: ACTION_TIMEOUT });
        // põe o cursor no fim, para acrescentar (focus programático pode deixá-lo no início)
        await t.loc.evaluate((el: any) => {
          try {
            const n = (el.value ?? "").length;
            el.setSelectionRange?.(n, n);
          } catch {}
        });
      }
    }
    await e.page.keyboard.type(text);
    return "ok";
  },

  async key(_m, e, a) {
    need(a, 1, 'key "Portal" "Enter"');
    await e.page.keyboard.press(parseKey(a[0]));
    return "ok";
  },

  async selectall(_m, e, a) {
    await focusTarget(e, a[0]);
    await e.page.keyboard.press("ControlOrMeta+a");
    return "ok";
  },

  async clear(_m, e, a) {
    await focusTarget(e, a[0]);
    await e.page.keyboard.press("ControlOrMeta+a");
    await e.page.keyboard.press("Backspace");
    return "ok";
  },

  async hover(_m, e, a) {
    need(a, 1, 'hover "Portal" <seletor>');
    const t = await target(e, a[0]);
    if (t.point) await e.page.mouse.move(t.point.x, t.point.y);
    else await t.loc.hover({ timeout: ACTION_TIMEOUT });
    return "ok";
  },

  async focus(_m, e, a) {
    need(a, 1, 'focus "Portal" <seletor>');
    await focusTarget(e, a[0]);
    return "ok";
  },

  async select(_m, e, a) {
    need(a, 2, 'select "Portal" <seletor> "Texto da opção"');
    const t = await target(e, a[0]);
    if (!t.loc) throw new ApiError(400, "select não aceita coordenadas.");
    const text = a.slice(1).join(" ");
    try {
      await t.loc.selectOption({ label: text }, { timeout: 1500 });
    } catch {
      try {
        await t.loc.selectOption({ value: text }, { timeout: 1500 });
      } catch {
        throw new ApiError(404, `opção não encontrada: "${text}"`);
      }
    }
    return "ok";
  },

  async check(_m, e, a) {
    need(a, 1, 'check "Portal" <seletor>');
    const t = await target(e, a[0]);
    if (!t.loc) throw new ApiError(400, "check não aceita coordenadas.");
    await t.loc.check({ timeout: ACTION_TIMEOUT });
    return "ok";
  },

  async uncheck(_m, e, a) {
    need(a, 1, 'uncheck "Portal" <seletor>');
    const t = await target(e, a[0]);
    if (!t.loc) throw new ApiError(400, "uncheck não aceita coordenadas.");
    await t.loc.uncheck({ timeout: ACTION_TIMEOUT });
    return "ok";
  },

  // upload <seletor> arquivo...: pelo input[type=file] ou pelo botão que abre o seletor de arquivos
  async upload(_m, e, a) {
    need(a, 2, 'upload "Portal" <seletor> arquivo...');
    const files = a.slice(1);
    // Só arquivos do projeto, dos anexos do chat ou do tmp (o caminho real, depois de seguir links simbólicos)
    const roots = _m.uploadRoots(e.projectId);
    for (const f of files) {
      if (!path.isAbsolute(f) || !fs.existsSync(f)) throw new ApiError(400, `arquivo não encontrado: ${f}`);
      const real = fs.realpathSync(f);
      if (!roots.some((r) => real === r || real.startsWith(r + path.sep))) {
        throw new ApiError(400, `upload recusado: "${f}" está fora do projeto (só arquivos do projeto, dos anexos do chat ou de ${os.tmpdir()}).`);
      }
    }
    const t = await target(e, a[0]);
    if (!t.loc) throw new ApiError(400, "upload não aceita coordenadas.");
    const isFileInput = await t.loc.evaluate((el: any) => el.tagName === "INPUT" && el.type === "file");
    if (isFileInput) await t.loc.setInputFiles(files, { timeout: ACTION_TIMEOUT });
    else {
      const [chooser] = await Promise.all([e.page.waitForEvent("filechooser", { timeout: ACTION_TIMEOUT }), t.loc.click({ timeout: ACTION_TIMEOUT })]);
      await chooser.setFiles(files);
    }
    return `${files.length} arquivo(s) enviado(s)`;
  },

  // scroll up|down|left|right PX [x,y|@ref]
  async scroll(_m, e, a) {
    need(a, 2, 'scroll "Portal" up|down|left|right PX [x,y|@ref]');
    const dir = a[0].toLowerCase();
    const px = Number(a[1]);
    if (!["up", "down", "left", "right"].includes(dir)) throw new ApiError(400, "direção inválida (up, down, left, right).");
    if (!Number.isFinite(px) || px <= 0) throw new ApiError(400, "PX deve ser um número positivo.");
    let at = { x: e.viewport.w / 2, y: e.viewport.h / 2 };
    if (a[2]) {
      const t = await target(e, a[2]);
      if (t.point) at = t.point;
      else {
        const box = await t.loc.boundingBox({ timeout: ACTION_TIMEOUT });
        if (!box) throw new ApiError(400, `${a[2]} não está visível.`);
        at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      }
    }
    await e.page.mouse.move(at.x, at.y);
    await e.page.mouse.wheel(dir === "left" ? -px : dir === "right" ? px : 0, dir === "up" ? -px : dir === "down" ? px : 0);
    await e.page.waitForTimeout(250);
    return "ok";
  },

  async scrollintoview(_m, e, a) {
    need(a, 1, 'scrollintoview "Portal" <seletor>');
    const t = await target(e, a[0]);
    if (!t.loc) throw new ApiError(400, "scrollintoview não aceita coordenadas.");
    await t.loc.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT });
    return "ok";
  },

  // wait: aguarda um elemento (@ref/CSS), um texto na página, uma URL (substring ou glob com *) ou um tempo em ms.
  // args = [tipo, valor, timeoutMs]; estourar o tempo vira erro (maestri: error:, saída != 0)
  async wait(_m, e, a) {
    const [kind, value = "", t] = a;
    const timeout = Math.min(600_000, Math.max(100, Number(t) || 30_000));
    if (kind === "ms") {
      await e.page.waitForTimeout(Math.min(600_000, Math.max(0, Number(value) || 0)));
      return "ok";
    }
    // Estourar o tempo vira uma mensagem específica do que se esperava (e não o "Timeout 2000ms exceeded" do Playwright)
    const timedOut = (err: any, what: string) => {
      if (/Timeout/i.test(String(err?.message))) throw new ApiError(408, `tempo esgotado esperando ${what} (${timeout / 1000}s)`);
      throw err;
    };
    if (kind === "text") {
      try {
        await e.page.waitForFunction((x: string) => (document.body?.innerText ?? "").includes(x), value, { timeout });
      } catch (err) {
        timedOut(err, `o texto "${value}"`);
      }
      return "ok";
    }
    if (kind === "url") {
      const re = value.includes("*") ? new RegExp(`^${value.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`) : null;
      try {
        await e.page.waitForURL((u: URL) => (re ? re.test(u.href) : u.href.includes(value)), { timeout });
      } catch (err) {
        timedOut(err, `a URL "${value}"`);
      }
      return "ok";
    }
    if (kind === "selector") {
      // Não usa target(): ele recusa o que ainda não existe, e esperar por isso é o ponto do wait
      if (COORDS.test(value)) throw new ApiError(400, "wait não aceita coordenadas.");
      const ref = /^@e(\d+)$/.exec(value);
      try {
        await e.page.locator(ref ? `[data-maestri-ref="e${ref[1]}"]` : value).first().waitFor({ state: "visible", timeout });
      } catch (err: any) {
        if (/Timeout/i.test(String(err?.message))) throw new ApiError(408, `tempo esgotado esperando ${value} (${timeout / 1000}s)`);
        throw err;
      }
      return "ok";
    }
    throw new ApiError(400, 'Uso: wait "Portal" (@ref|seletor | --text "t" | --url "padrão" | MS) [--timeout S]');
  },

  async text(_m, e, a) {
    if (!a[0]) return (await e.page.evaluate(() => document.body?.innerText ?? "")) as string;
    const t = await target(e, a[0]);
    if (!t.loc) throw new ApiError(400, "text não aceita coordenadas.");
    return (await t.loc.innerText({ timeout: ACTION_TIMEOUT })) as string;
  },

  async html(_m, e, a) {
    if (!a[0]) return e.page.content();
    const t = await target(e, a[0]);
    if (!t.loc) throw new ApiError(400, "html não aceita coordenadas.");
    return t.loc.evaluate((el: any) => el.outerHTML);
  },

  async evaluate(_m, e, a) {
    need(a, 1, 'evaluate "Portal" "js"');
    const r = await e.page.evaluate(a.join(" "));
    return typeof r === "string" ? r : (JSON.stringify(r) ?? "undefined");
  },

  async "logs-start"(_m, e) {
    e.logging = true;
    return "captura de logs iniciada";
  },

  async logs(_m, e) {
    if (!e.logging) throw new ApiError(400, 'captura de logs não iniciada (rode "logs-start" antes).');
    const out = e.logs.join("\n");
    e.logs = [];
    return out;
  },

  async resize(m, e, a) {
    need(a, 2, 'resize "Portal" W H');
    const w = Number(a[0]);
    const h = Number(a[1]);
    if (![w, h].every((n) => Number.isInteger(n) && n >= 50 && n <= 5000)) throw new ApiError(400, "W e H devem ser inteiros entre 50 e 5000.");
    await e.page.setViewportSize({ width: w, height: h });
    e.viewport = { w, h };
    // o nó guarda o tamanho para reabrir igual
    m.patchNode(e, { viewport: e.viewport });
    return `viewport: ${await viewportOf(e.page)}`;
  },

  async ua(m, e, a) {
    if (!a[0]) {
      const cur = await e.page.evaluate(() => navigator.userAgent);
      return [`ua atual: ${cur}`, `presets: ${Object.keys(UA_PRESETS).join(", ")}`].join("\n");
    }
    const preset = a[0].toLowerCase();
    if (!Object.hasOwn(UA_PRESETS, preset)) throw new ApiError(400, `preset desconhecido: ${a[0]} (${Object.keys(UA_PRESETS).join(", ")})`);
    await m.replaceContext(e, UA_PRESETS[preset], preset);
    return `ua: ${preset} — ${await e.page.evaluate(() => navigator.userAgent)}`;
  },
};

export const PORTAL_VERBS = Object.keys(COMMANDS);
