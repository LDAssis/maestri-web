import pty from "node-pty";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WebSocket } from "ws";
import { captureResume, resumeCommand, withModel, withUsageSettings } from "./resume.js";
import { usageEnabled, userStatusLine } from "./usage.js";
import { ensureAgentContext } from "./agentContext.js";
import type { SessionHistory } from "./sessionHistory.js";
import { TerminalTokens } from "./terminalTokens.js";
import { isolatedArgv, type RunAs } from "./isolation.js";
import { linkGeminiHome } from "./runAs.js";
import { GEMINI_LINK_ENV } from "./accounts.js";

const isWindows = process.platform === "win32";
const gitBashPath = "C:\\Program Files\\Git\\bin\\bash.exe";
const defaultShell = isWindows
  ? fs.existsSync(gitBashPath) ? gitBashPath : "powershell.exe"
  : process.env.SHELL || "/bin/bash";

// Prepend CLI tools paths (agy, claude, opencode) — só no Windows
const extraPaths = isWindows
  ? [
      "C:\\Users\\ti\\AppData\\Local\\agy\\bin",
      "C:\\Users\\ti\\.local\\bin",
      "C:\\Users\\ti\\AppData\\Roaming\\npm",
    ]
  : [];

// apps/server/bin vence qualquer outro `maestri` instalado no sistema
const binDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin");
const enrichedPath = [binDir, ...extraPaths, process.env.PATH || ""].join(path.delimiter);

const SCROLLBACK_MAX = 200 * 1024;

// Statusline do claude que reporta o uso (rate limits) ao servidor: o próprio bin/maestri, com / também no Windows (o claude roda via bash)
const usageSettings = JSON.stringify({ statusLine: { type: "command", command: `${path.join(binDir, "maestri").replace(/\\/g, "/")} usage-report` } });

export interface Session {
  projectId: string;
  nodeId: string;
  pty: pty.IPty;
  scrollback: string;
  clients: Set<WebSocket>;
  sizes: Map<WebSocket, { cols: number; rows: number }>; // tamanho que cabe no nó de cada cliente que já reportou
  cwd: string;
  cmd: string;
  baseCmd: string; // comando como veio do nó (sem modelo nem retomada): a base para remontar ao reiniciar
  createdAt: string;
  cols: number;
  rows: number;
  dead: boolean;
  listeners: Set<(data: string) => void>;
  // Última saída do PTY (epoch ms); as rotinas usam para saber se o terminal está ocupado
  lastOutputAt: number;
  // Cauda da saída (sem tratamento) para achar a linha de retomada que o agente imprime ao sair
  tail: string;
  idleTimer?: NodeJS.Timeout; // dispara onIdle depois de um tempo sem saída
  ptyId: string; // token por terminal (Fase 3): revogado quando este PTY acaba
}

// Ambiente do PTY. Linux: lista branca (nada do ambiente do servidor: MAESTRI_TOKEN, segredos do /etc/maestri-web.env...);
// demais plataformas (dev): o ambiente atual sem o token interno. O token do terminal vai por arquivo (MAESTRI_TOKEN_FILE).
export function buildPtyEnv(i: { base?: NodeJS.ProcessEnv; extra: Record<string, string>; runAs: RunAs | null; platform?: string; bin?: string }): Record<string, string> {
  const base = i.base ?? process.env;
  const platform = i.platform ?? process.platform;
  const bin = i.bin ?? binDir;
  const out: Record<string, string> = {};
  if (platform === "linux") {
    // o usuário do projeto não alcança /root: nada dele no PATH
    const basePath = (base.PATH || "/usr/local/bin:/usr/bin:/bin").split(path.delimiter).filter((d) => d && !(i.runAs && d.startsWith("/root")));
    Object.assign(out, {
      // MAESTRI_PTY_PATH: pastas extras (ex.: onde o claude está instalado para todos, já que o usuário do projeto não alcança /root)
      PATH: [bin, ...basePath, ...(base.MAESTRI_PTY_PATH || "").split(path.delimiter).filter(Boolean)].join(path.delimiter),
      LANG: base.LANG || "C.UTF-8",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      HOME: i.runAs ? i.runAs.home : base.HOME || os.homedir(),
      USER: i.runAs ? i.runAs.user : base.USER || os.userInfo().username,
      LOGNAME: i.runAs ? i.runAs.user : base.LOGNAME || base.USER || os.userInfo().username,
      SHELL: i.runAs ? "/bin/bash" : base.SHELL || "/bin/bash",
    });
    if (base.LC_ALL) out.LC_ALL = base.LC_ALL;
    if (base.TZ) out.TZ = base.TZ;
    const tmp = i.runAs ? i.runAs.tmp : base.TMPDIR;
    if (tmp) out.TMPDIR = tmp;
    // extras que o admin libera explicitamente (ex.: proxies): MAESTRI_PTY_PASSTHROUGH=HTTPS_PROXY,NO_PROXY
    for (const k of (base.MAESTRI_PTY_PASSTHROUGH || "").split(",").map((x) => x.trim()).filter(Boolean)) if (base[k] !== undefined && k !== "MAESTRI_TOKEN") out[k] = base[k]!;
  } else {
    for (const [k, v] of Object.entries(base)) if (v !== undefined && k !== "MAESTRI_TOKEN") out[k] = v;
    Object.assign(out, { ...(isWindows ? { Path: enrichedPath } : {}), PATH: [bin, ...extraPaths, base.PATH || ""].join(path.delimiter), TERM: "xterm-256color", COLORTERM: "truecolor" });
  }
  for (const [k, v] of Object.entries(i.extra)) if (k !== "MAESTRI_TOKEN") out[k] = v;
  return out;
}

interface SpawnCtx {
  projectId: string;
  nodeId: string;
  runAs: RunAs | null;
  tokens: TerminalTokens;
  sharedDirs?: string[]; // pastas de conta (compartilhadas por grupo) que o servidor pode preparar para o agente
}

function spawnPty(cwd: string, cols: number, rows: number, extraEnv: Record<string, string>, ctx: SpawnCtx) {
  const shellArgs = defaultShell.includes("bash") ? ["--login", "-i"] : isWindows ? ["-NoLogo"] : [];
  const { runAs } = ctx;
  const t = ctx.tokens.issue({ projectId: ctx.projectId, nodeId: ctx.nodeId, uid: runAs?.uid ?? null, gid: runAs?.gid ?? null });
  try {
    // Conta gemini (agy/gemini-cli): link $HOME/.gemini -> pasta da conta, só no HOME de um projeto isolado (nunca no /root)
    const { [GEMINI_LINK_ENV]: geminiLink, ...plainEnv } = extraEnv;
    if (runAs && geminiLink !== undefined) linkGeminiHome(runAs.home, runAs.uid, runAs.gid, geminiLink);
    const env = buildPtyEnv({ extra: { ...plainEnv, MAESTRI_TOKEN_FILE: t.file }, runAs });
    // Instruções do canvas para o claude/codex/opencode/agy que rodar neste terminal (inclui contas por config dir)
    // (o liga/desliga vem do ambiente do SERVIDOR: o PTY não herda NODE_ENV nem MAESTRI_AGENT_CONTEXT)
    ensureAgentContext({ ...env, NODE_ENV: process.env.NODE_ENV, MAESTRI_AGENT_CONTEXT: process.env.MAESTRI_AGENT_CONTEXT } as NodeJS.ProcessEnv, runAs ? { uid: runAs.uid, gid: runAs.gid, shared: ctx.sharedDirs ?? [] } : undefined);
    // statusLine do usuário (mesma config do claude deste terminal): o usage-report encadeia nela em vez de substituí-la
    const userSl = usageEnabled(process.env) ? userStatusLine(env) : undefined;
    if (userSl) env.MAESTRI_USER_STATUSLINE = userSl;
    else delete env.MAESTRI_USER_STATUSLINE;
    if (!runAs) return { p: pty.spawn(defaultShell, shellArgs, { name: "xterm-256color", cols, rows, cwd, env }), ptyId: t.ptyId };
    // Projeto isolado: setpriv troca uid/gid (e zera os grupos do root), env -i entrega SÓ a lista branca; nada herdado do servidor
    const a = isolatedArgv(runAs, Object.entries(env).map(([k, v]) => k + "=" + v), shellArgs);
    const p = pty.spawn(a.file, a.args, { name: "xterm-256color", cols, rows, cwd, env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" } });
    return { p, ptyId: t.ptyId };
  } catch (e) {
    ctx.tokens.revoke(t.ptyId);
    throw e;
  }
}

// Controle em frame BINÁRIO (a saída do PTY segue em texto): tamanho aplicado ao PTY
const sizeMsg = (s: Session) => Buffer.from(JSON.stringify({ type: "size", cols: s.cols, rows: s.rows }));

export function killGroup(p: pty.IPty) {
  const { pid } = p;
  try {
    p.kill();
  } catch {}
  if (!isWindows) {
    // node-pty faz setsid: o shell lidera o grupo; mata também os filhos (claude, npm run dev...)
    try {
      process.kill(-pid, "SIGHUP");
    } catch {}
    setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
    }, 2000).unref();
  }
}

// Sessões de terminal compartilhadas: sobrevivem à desconexão dos clientes
export class SessionManager {
  private sessions = new Map<string, Session>();

  // apiUrl é avaliado a cada spawn (a porta real só é conhecida depois do listen)
  constructor(
    private cli: {
      apiUrl: () => string;
      token: string;
      history?: SessionHistory; // terminais já iniciados / linha de retomada capturada
      resume?: (projectId: string) => boolean; // retomar sessão ao relançar (padrão: ligado)
      env?: (projectId: string, nodeId: string) => Record<string, string>; // ex.: conta de CLI do nó
      model?: (projectId: string, nodeId: string) => string | undefined; // data.model do nó (vazio = padrão do CLI)
      // Terminal ficou ocioso depois de produzir saída (fim de um "turno" do agente); usado p/ detectar PRs dos andares
      onIdle?: (projectId: string, nodeId: string) => void;
      // Fase 3: tokens por terminal, identidade de SO do projeto e bloqueio quando não há conta de assinatura liberada
      tokens?: TerminalTokens;
      runAs?: (projectId: string) => RunAs | null;
      gate?: (projectId: string, nodeId: string) => string | null; // mensagem exibida no lugar de iniciar o agente
      sharedDirs?: (projectId: string) => string[];
    },
  ) {
    this.tokens = cli.tokens ?? new TerminalTokens();
  }

  readonly tokens: TerminalTokens;

  private spawn(projectId: string, nodeId: string, cwd: string, cols: number, rows: number) {
    return spawnPty(cwd, cols, rows, { ...this.env(projectId, nodeId), ...(this.cli.env?.(projectId, nodeId) ?? {}) }, {
      projectId, nodeId, runAs: this.cli.runAs?.(projectId) ?? null, tokens: this.tokens, sharedDirs: this.cli.sharedDirs?.(projectId),
    });
  }

  private env(projectId: string, nodeId: string) {
    return {
      MAESTRI_API_URL: this.cli.apiUrl(),
      MAESTRI_PROJECT_ID: projectId,
      MAESTRI_NODE_ID: nodeId,
      // Caminho absoluto do CLI: o recurso quando `maestri` não é encontrado no PATH ("$MAESTRI_CLI")
      MAESTRI_CLI: path.join(binDir, "maestri"), // sem .cmd: só existe o script sh (Git Bash no Windows)
    };
  }

  // Comando do nó + modelo (data.model) + statusline de uso (claude); a retomada vem depois
  private compose(projectId: string, nodeId: string, base: string) {
    const cmd = withModel(base, this.cli.model?.(projectId, nodeId));
    return usageEnabled(process.env) ? withUsageSettings(cmd, usageSettings) : cmd;
  }

  private key(projectId: string, nodeId: string) {
    return `${projectId}:${nodeId}`;
  }

  private broadcast(s: Session, data: string) {
    for (const c of s.clients) {
      try {
        if (c.readyState === 1 /* OPEN */) c.send(data);
      } catch (e: any) {
        console.warn("Aviso ao enviar data para socket:", e.message);
      }
    }
  }

  private push(s: Session, data: string) {
    s.scrollback += data;
    s.lastOutputAt = Date.now();
    if (this.cli.onIdle) {
      clearTimeout(s.idleTimer);
      s.idleTimer = setTimeout(() => {
        s.idleTimer = undefined;
        if (!s.dead) this.cli.onIdle!(s.projectId, s.nodeId);
      }, Number(process.env.MAESTRI_IDLE_MS) || 8000);
      s.idleTimer.unref();
    }
    if (this.cli.history) {
      s.tail = (s.tail + data).slice(-1500);
      const found = captureResume(s.tail);
      if (found) this.cli.history.setResume(s.projectId, s.nodeId, found);
    }
    if (s.scrollback.length > SCROLLBACK_MAX) s.scrollback = s.scrollback.slice(-SCROLLBACK_MAX);
    this.broadcast(s, data);
    for (const fn of s.listeners) fn(data);
  }

  private runCmd(s: Session, p: pty.IPty) {
    if (!s.cmd) return;
    setTimeout(() => {
      try {
        if (s.pty === p && !s.dead) p.write(`${s.cmd}\r`);
      } catch {}
    }, 600);
  }

  private wire(s: Session, p: pty.IPty) {
    p.onData((data: string) => {
      if (s.pty === p && !s.dead) this.push(s, data);
    });
    p.onExit((event) => {
      if (s.pty === p) this.end(s, String(event.exitCode));
    });
  }

  // Encerra a sessão: avisa, fecha os clientes (4000), tira do registro e mata o process group
  private end(s: Session, exitCode: string) {
    if (s.dead) return;
    s.dead = true;
    clearTimeout(s.idleTimer);
    const k = this.key(s.projectId, s.nodeId);
    if (this.sessions.get(k) === s) this.sessions.delete(k);
    this.tokens.revoke(s.ptyId);
    this.broadcast(s, `\r\n\x1b[33m[PTY finalizado (exitCode: ${exitCode})]\x1b[0m\r\n`);
    for (const c of s.clients) {
      try {
        c.close(4000, "PTY finalizado");
      } catch {}
    }
    s.clients.clear();
    killGroup(s.pty);
  }

  // Cria a sessão se ainda não existir (sem precisar de cliente); lança se o PTY falhar
  // fresh: recomeço do zero (recruit --replace, role assign); senão, um terminal que já rodou antes é relançado em
  // modo de retomada (claude --continue etc.) quando a retomada está ligada no projeto
  ensure(projectId: string, nodeId: string, opts: { cwd: string; cmd: string; fresh?: boolean }) {
    const k = this.key(projectId, nodeId);
    let s = this.sessions.get(k);
    if (s) return s;
    const cols = 80;
    const rows = 24;
    const h = this.cli.history;
    let cmd = this.compose(projectId, nodeId, opts.cmd);
    const blocked = this.cli.gate?.(projectId, nodeId) ?? null;
    if (h) {
      if (opts.fresh) h.reset(projectId, nodeId);
      else if (h.started(projectId, nodeId) && this.cli.resume?.(projectId) !== false) cmd = resumeCommand(cmd, h.resume(projectId, nodeId));
      h.markStarted(projectId, nodeId);
    }
    if (blocked) cmd = "";
    const { p, ptyId } = this.spawn(projectId, nodeId, opts.cwd, cols, rows);
    s = {
      projectId, nodeId, pty: p, ptyId, clients: new Set(), sizes: new Map(), cwd: opts.cwd, cmd, baseCmd: opts.cmd,
      createdAt: new Date().toISOString(), cols, rows, dead: false, listeners: new Set(), lastOutputAt: 0, tail: "",
      scrollback: `\r\n\x1b[32m[Maestri Web - ${isWindows ? "ConPTY" : "PTY"} Ativo]\x1b[0m Terminal pronto em: ${opts.cwd}\r\n` + (blocked ? `\r\n\x1b[31m${blocked}\x1b[0m\r\n` : ""),
    };
    this.sessions.set(k, s);
    this.wire(s, p);
    this.runCmd(s, p);
    return s;
  }

  get(projectId: string, nodeId: string) {
    return this.sessions.get(this.key(projectId, nodeId));
  }

  // Escreve no PTY como se fosse digitado
  write(projectId: string, nodeId: string, text: string) {
    const s = this.get(projectId, nodeId);
    if (!s) return false;
    s.pty.write(text);
    return true;
  }

  attach(socket: WebSocket, projectId: string, nodeId: string, opts: { cwd: string; cmd: string; fresh?: boolean }) {
    let s: Session;
    try {
      s = this.ensure(projectId, nodeId, opts);
    } catch (err: any) {
      console.error("Erro ao iniciar ConPTY:", err.message);
      socket.send(`\r\n\x1b[31m[Erro]: Falha ao iniciar ConPTY: ${err.message}\x1b[0m\r\n`);
      socket.close();
      return;
    }

    const session = s;
    try {
      // Tamanho ANTES do histórico: o cliente redimensiona o xterm e só então reproduz o scrollback na largura certa
      // (na ordem inversa, o quadro do TUI era desenhado em 80 colunas e embaralhava até alguém redimensionar).
      socket.send(sizeMsg(session));
      socket.send(session.scrollback);
    } catch {}
    session.clients.add(socket);

    socket.on("message", (message: Buffer | string) => {
      try {
        const text = message.toString();
        if (text.startsWith('{"type":"resize"')) {
          const { cols, rows } = JSON.parse(text);
          if (Number.isFinite(cols) && Number.isFinite(rows)) {
            const first = !session.sizes.has(socket);
            session.sizes.set(socket, { cols: Math.min(500, Math.max(10, Math.floor(cols))), rows: Math.min(200, Math.max(5, Math.floor(rows))) });
            // Cliente novo e o tamanho não mudou: o TUI não recebe SIGWINCH e a tela reproduzida do histórico pode estar
            // incompleta. Um "empurrão" de tamanho faz o app redesenhar a tela inteira.
            if (!this.applySize(session) && first) this.nudgeRedraw(session);
          }
          return;
        }
        session.pty.write(text);
      } catch (e: any) {
        console.error("Erro ao escrever no PTY:", e.message);
      }
    });

    // Fechar um cliente não mata o PTY
    socket.on("close", () => {
      session.clients.delete(socket);
      session.sizes.delete(socket);
      this.applySize(session);
    });
  }

  // Estilo tmux: o PTY compartilhado usa o MENOR tamanho entre os clientes que já reportaram; quando muda, avisa todos
  private applySize(s: Session): boolean {
    if (!s.sizes.size) return false;
    const sizes = [...s.sizes.values()];
    const cols = Math.min(...sizes.map((z) => z.cols));
    const rows = Math.min(...sizes.map((z) => z.rows));
    if (cols === s.cols && rows === s.rows) return false;
    s.cols = cols;
    s.rows = rows;
    try {
      s.pty.resize(cols, rows);
    } catch {}
    this.broadcastBinary(s, sizeMsg(s));
    return true;
  }

  // Redimensiona o PTY uma linha a menos e volta: o app recebe dois SIGWINCH e redesenha a tela no tamanho atual
  private nudgeRedraw(s: Session) {
    if (s.dead || s.rows < 6) return;
    try {
      s.pty.resize(s.cols, s.rows - 1);
    } catch {}
    setTimeout(() => {
      if (s.dead) return;
      try {
        s.pty.resize(s.cols, s.rows);
      } catch {}
    }, 80).unref?.();
  }

  private broadcastBinary(s: Session, data: Buffer) {
    for (const c of s.clients) {
      try {
        if (c.readyState === 1 /* OPEN */) c.send(data, { binary: true });
      } catch {}
    }
  }

  list(projectId: string) {
    return [...this.sessions.values()]
      .filter((s) => s.projectId === projectId)
      .map((s) => ({ nodeId: s.nodeId, pid: s.pty.pid, clients: s.clients.size, createdAt: s.createdAt }));
  }

  kill(projectId: string, nodeId: string) {
    const s = this.sessions.get(this.key(projectId, nodeId));
    if (!s) return false;
    this.end(s, "killed");
    return true;
  }

  killNodes(projectId: string, nodeIds: string[]) {
    for (const id of nodeIds) this.kill(projectId, id);
  }

  killProject(projectId: string) {
    for (const s of [...this.sessions.values()]) if (s.projectId === projectId) this.end(s, "killed");
  }

  killAll() {
    for (const s of [...this.sessions.values()]) this.end(s, "killed");
  }

  // Recria o PTY com o mesmo cmd (e o mesmo cwd, salvo se informado); os clientes continuam anexados
  restart(projectId: string, nodeId: string, cwd?: string) {
    const s = this.sessions.get(this.key(projectId, nodeId));
    if (!s) return false;
    if (cwd) s.cwd = cwd;
    const old = s.pty;
    // reiniciar o agente também retoma a conversa (se ligado no projeto)
    // remonta a partir do comando do nó: o modelo pode ter mudado (a flag que nós mesmos pusemos não pode travar a troca)
    s.cmd = this.compose(projectId, nodeId, s.baseCmd);
    if (this.cli.history && this.cli.resume?.(projectId) !== false) s.cmd = resumeCommand(s.cmd, this.cli.history.resume(projectId, nodeId));
    const blocked = this.cli.gate?.(projectId, nodeId) ?? null;
    if (blocked) s.cmd = "";
    const { p, ptyId } = this.spawn(projectId, nodeId, s.cwd, s.cols, s.rows);
    const oldId = s.ptyId;
    s.pty = p;
    s.ptyId = ptyId;
    this.tokens.revoke(oldId);
    killGroup(old);
    this.push(s, "\r\n\x1b[33m[Sessão reiniciada]\x1b[0m\r\n");
    if (blocked) this.push(s, `\r\n\x1b[31m${blocked}\x1b[0m\r\n`);
    this.wire(s, p);
    this.runCmd(s, p);
    return true;
  }
}
