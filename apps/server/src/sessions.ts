import pty from "node-pty";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WebSocket } from "ws";
import { captureResume, resumeCommand } from "./resume.js";
import { ensureAgentContext } from "./agentContext.js";
import type { SessionHistory } from "./sessionHistory.js";

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

export interface Session {
  projectId: string;
  nodeId: string;
  pty: pty.IPty;
  scrollback: string;
  clients: Set<WebSocket>;
  cwd: string;
  cmd: string;
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
}

function spawnPty(cwd: string, cols: number, rows: number, extraEnv: Record<string, string>) {
  const shellArgs = defaultShell.includes("bash") ? ["--login", "-i"] : isWindows ? ["-NoLogo"] : [];
  const env = {
    ...process.env,
    ...(isWindows ? { Path: enrichedPath } : {}),
    PATH: enrichedPath,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    ...extraEnv,
  };
  // Instruções do canvas para o claude/codex/opencode/agy que rodar neste terminal (inclui contas por config dir)
  ensureAgentContext(env);
  return pty.spawn(defaultShell, shellArgs, { name: "xterm-256color", cols, rows, cwd, env });
}

function killGroup(p: pty.IPty) {
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
      // Terminal ficou ocioso depois de produzir saída (fim de um "turno" do agente); usado p/ detectar PRs dos andares
      onIdle?: (projectId: string, nodeId: string) => void;
    },
  ) {}

  private env(projectId: string, nodeId: string) {
    return {
      MAESTRI_API_URL: this.cli.apiUrl(),
      MAESTRI_PROJECT_ID: projectId,
      MAESTRI_NODE_ID: nodeId,
      MAESTRI_TOKEN: this.cli.token,
      // Caminho absoluto do CLI: o recurso quando `maestri` não é encontrado no PATH ("$MAESTRI_CLI")
      MAESTRI_CLI: path.join(binDir, isWindows ? "maestri.cmd" : "maestri"),
    };
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
    let cmd = opts.cmd;
    if (h) {
      if (opts.fresh) h.reset(projectId, nodeId);
      else if (h.started(projectId, nodeId) && this.cli.resume?.(projectId) !== false) cmd = resumeCommand(cmd, h.resume(projectId, nodeId));
      h.markStarted(projectId, nodeId);
    }
    const p = spawnPty(opts.cwd, cols, rows, { ...this.env(projectId, nodeId), ...(this.cli.env?.(projectId, nodeId) ?? {}) });
    s = {
      projectId, nodeId, pty: p, clients: new Set(), cwd: opts.cwd, cmd,
      createdAt: new Date().toISOString(), cols, rows, dead: false, listeners: new Set(), lastOutputAt: 0, tail: "",
      scrollback: `\r\n\x1b[32m[Maestri Web - ConPTY Ativo]\x1b[0m Terminal pronto em: ${opts.cwd}\r\n`,
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
      socket.send(session.scrollback);
    } catch {}
    session.clients.add(socket);

    socket.on("message", (message: Buffer | string) => {
      try {
        const text = message.toString();
        if (text.startsWith('{"type":"resize"')) {
          const { cols, rows } = JSON.parse(text);
          if (Number.isFinite(cols) && Number.isFinite(rows)) {
            session.cols = Math.min(500, Math.max(10, Math.floor(cols)));
            session.rows = Math.min(200, Math.max(5, Math.floor(rows)));
            session.pty.resize(session.cols, session.rows);
          }
          return;
        }
        session.pty.write(text);
      } catch (e: any) {
        console.error("Erro ao escrever no PTY:", e.message);
      }
    });

    // Fechar um cliente não mata o PTY
    socket.on("close", () => session.clients.delete(socket));
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
    if (this.cli.history && this.cli.resume?.(projectId) !== false) s.cmd = resumeCommand(s.cmd, this.cli.history.resume(projectId, nodeId));
    const p = spawnPty(s.cwd, s.cols, s.rows, { ...this.env(projectId, nodeId), ...(this.cli.env?.(projectId, nodeId) ?? {}) });
    s.pty = p;
    killGroup(old);
    this.push(s, "\r\n\x1b[33m[Sessão reiniciada]\x1b[0m\r\n");
    this.wire(s, p);
    this.runCmd(s, p);
    return true;
  }
}
