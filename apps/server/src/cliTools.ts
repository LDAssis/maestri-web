// Menu de CLIs: catálogo, detecção (instalado/versão/login) e jobs em node-pty (instalar / entrar).
// Comandos de instalação e login vêm SÓ do catálogo abaixo (nunca do cliente).
import pty from "node-pty";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { ApiError } from "./agents.js";
import { DEFAULT_ACCOUNT, type AccountProgram, type AccountStore } from "./accounts.js";
import { killGroup } from "./sessions.js";

export const CLI_IDS = ["claude", "codex", "agy", "opencode", "gemini"] as const;
export type CliId = (typeof CLI_IDS)[number];
export type JobState = "running" | "waiting_input" | "done" | "failed" | "cancelled";
export type JobKind = "install" | "login";

const isWindows = process.platform === "win32";
const LOG_MAX = 200 * 1024;
const FINISHED_TTL_MS = 30 * 60 * 1000;

interface StatusResult {
  loggedIn: boolean | null;
  detail?: string;
}
interface Ctx {
  bin: string; // caminho absoluto do binário
  env: NodeJS.ProcessEnv; // env com PATH da detecção e da conta
}

export interface CliDef {
  id: CliId;
  label: string;
  bin: string;
  installCmd: string;
  versionArgs: string[];
  loginArgs?: string[];
  logoutArgs?: string[];
  statusCheck: (ctx: Ctx) => Promise<StatusResult>;
  program?: AccountProgram; // claude/codex: aceitam conta (CLAUDE_CONFIG_DIR / CODEX_HOME)
  waitFor?: RegExp; // saída que pede algo ao usuário (código colado / menu) => waiting_input
  autoReply?: { re: RegExp; send: string }[]; // responde sozinho a menus com a resposta padrão (cada um uma vez)
  pollStatus?: boolean; // TUI que não sai ao terminar o login: confere o status depois do input e encerra quando logou
  // URL de login do próprio CLI (a TUI pode imprimir outros links antes, ex.: termos de uso). Vale a ÚLTIMA ocorrência.
  urlRe?: RegExp;
}

const homeDir = () => process.env.HOME || os.homedir();

// Pastas onde procurar os binários: $HOME/.local/bin (instaladores nativos do claude/agy) + o PATH do servidor
export function cliPath(): string {
  const dirs = [path.join(homeDir(), ".local", "bin"), ...(process.env.PATH || "").split(path.delimiter)].filter(Boolean);
  return [...new Set(dirs)].join(path.delimiter);
}

export function findBin(bin: string): string | null {
  const exts = isWindows ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of cliPath().split(path.delimiter)) {
    for (const ext of exts) {
      const f = path.join(dir, bin + ext);
      try {
        if (!fs.statSync(f).isFile()) continue;
        fs.accessSync(f, fs.constants.X_OK);
        return f;
      } catch {}
    }
  }
  return null;
}

// Remove sequências ANSI/OSC e caracteres de controle (o texto fica legível e pesquisável por regex)
const ANSI = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
export function clean(raw: string): string {
  return raw
    .replace(/\x1b\[\d*C/g, " ") // "cursor para a direita" faz as vezes de espaço nas TUIs
    .replace(ANSI, "")
    .replace(/\r\n/g, "\n")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

interface RunResult {
  code: number | null; // null = não executou
  out: string;
}
// Teto de cada checagem (versão / status) na listagem: estourou => resultado desconhecido (loggedIn null)
const checkTimeout = () => Number(process.env.MAESTRI_CLI_CHECK_TIMEOUT_MS) || 8000;
const timeoutAfter = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      () => (clearTimeout(t), resolve(fallback)),
    );
  });
interface Probe {
  version: string | null;
  loggedIn: boolean | null;
  detail?: string;
}
function run(file: string, args: string[], env: NodeJS.ProcessEnv, timeout = 8000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(file, args, { env, timeout, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, cwd: homeDir(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] } as any, (err: any, stdout: string, stderr: string) => {
      const out = clean(`${stdout ?? ""}${stderr ?? ""}`);
      if (!err) return resolve({ code: 0, out });
      resolve({ code: typeof err.code === "number" ? err.code : null, out });
    });
  });
}

const nonEmptyFile = (f: string) => {
  try {
    return fs.statSync(f).size > 2;
  } catch {
    return false;
  }
};
const lastLine = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";

export const CATALOG: CliDef[] = [
  {
    id: "claude",
    label: "Claude Code",
    bin: "claude",
    installCmd: "npm install -g @anthropic-ai/claude-code",
    versionArgs: ["--version"],
    loginArgs: ["auth", "login"],
    logoutArgs: ["auth", "logout"],
    program: "claude",
    waitFor: /paste code here/i,
    async statusCheck({ bin, env }) {
      const r = await run(bin, ["auth", "status"], env);
      if (r.code === null) return { loggedIn: null };
      let method = "";
      try {
        method = String(JSON.parse(r.out.slice(r.out.indexOf("{")))?.authMethod ?? "");
      } catch {}
      return { loggedIn: r.code === 0, detail: method && method !== "none" ? method : undefined };
    },
  },
  {
    id: "codex",
    label: "Codex",
    bin: "codex",
    installCmd: "npm install -g @openai/codex",
    versionArgs: ["--version"],
    loginArgs: ["login", "--device-auth"],
    logoutArgs: ["logout"],
    program: "codex",
    async statusCheck({ bin, env }) {
      const r = await run(bin, ["login", "status"], env);
      if (r.code === 0) return { loggedIn: true, detail: lastLine(r.out) || undefined };
      // fallback: auth.json do CODEX_HOME (padrão ~/.codex)
      const home = env.CODEX_HOME || path.join(homeDir(), ".codex");
      if (nonEmptyFile(path.join(home, "auth.json"))) return { loggedIn: true, detail: "auth.json" };
      return { loggedIn: r.code === null ? null : false };
    },
  },
  {
    id: "agy",
    label: "Antigravity (agy)",
    bin: "agy",
    installCmd: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
    versionArgs: ["--version"],
    loginArgs: [], // o login acontece dentro da TUI: rodar `agy` sem argumentos
    waitFor: /(authorization code|paste)/i,
    autoReply: [{ re: /select login method/i, send: "\r" }], // padrão: "1. Google OAuth"
    pollStatus: true,
    async statusCheck({ bin, env }) {
      const r = await run(bin, ["models"], env, checkTimeout());
      if (r.code === null) return { loggedIn: null };
      if (r.code === 0) return { loggedIn: true };
      if (/sign in/i.test(r.out)) return { loggedIn: false };
      // keyring D-Bus ausente etc.: erro que não é "deslogado"
      return { loggedIn: null, detail: lastLine(r.out) || undefined };
    },
  },
  {
    id: "opencode",
    label: "OpenCode",
    bin: "opencode",
    installCmd: "npm install -g opencode-ai",
    versionArgs: ["--version"],
    loginArgs: ["auth", "login"], // menu de provedor: o usuário responde pelo campo de input
    waitFor: /(select |login method|enter (your )?api key|enter code)/i,
    async statusCheck({ bin, env }) {
      // `auth list` sai 0 mesmo sem credenciais: ler "N credentials"
      const r = await run(bin, ["auth", "list"], env);
      const m = /(\d+)\s+credentials?/i.exec(r.out);
      if (m) return { loggedIn: Number(m[1]) > 0, detail: `${m[1]} credencial(is)` };
      const data = env.XDG_DATA_HOME || path.join(homeDir(), ".local", "share");
      if (nonEmptyFile(path.join(data, "opencode", "auth.json"))) return { loggedIn: true, detail: "auth.json" };
      return { loggedIn: r.code === null ? null : false };
    },
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    bin: "gemini",
    installCmd: "npm install -g @google/gemini-cli",
    versionArgs: ["--version"],
    loginArgs: [], // TUI: confiar na pasta -> método de login (padrão "Sign in with Google") -> URL + código colado
    waitFor: /enter the authorization code/i,
    // A TUI desenha o link dos Termos (geminicli.com/.../tos-privacy) antes da URL OAuth; um retry imprime URL nova
    urlRe: /https:\/\/accounts\.google\.com\/o\/oauth2\/[^\s"'<>]+(?=\s)/,
    autoReply: [
      { re: /trust the files in this folder/i, send: "\r" }, // "1. Trust folder" (o CLI reinicia sozinho depois)
      { re: /how would you like to authenticate/i, send: "\r" }, // "1. Sign in with Google"
    ],
    pollStatus: true,
    async statusCheck({ bin, env }) {
      if (env.GEMINI_API_KEY) return { loggedIn: true, detail: "GEMINI_API_KEY" };
      const root = env.GEMINI_CLI_HOME || homeDir();
      if (nonEmptyFile(path.join(root, ".gemini", "oauth_creds.json"))) return { loggedIn: true, detail: "oauth_creds.json" };
      // sem credencial conhecida: o modo headless sai com 41 (FatalAuthenticationError) quando não há login
      const r = await run(bin, ["-p", "ping", "--output-format", "json"], env, checkTimeout());
      if (r.code === 0) return { loggedIn: true };
      return { loggedIn: r.code === 41 ? false : null };
    },
  },
];

const def = (id: string): CliDef => {
  const d = CATALOG.find((c) => c.id === id);
  if (!d) throw new ApiError(404, `CLI desconhecido: ${id}.`);
  return d;
};

export interface JobRef {
  id: string;
  cliId: CliId;
  kind: JobKind;
  state: JobState;
}
export interface Job extends JobRef {
  account?: string;
  log: string;
  url?: string;
  code?: string;
  exitCode?: number;
  error?: string;
  startedAt: string;
  endedAt?: string;
}
export type JobEvent =
  | { type: "log"; data: string }
  | { type: "url"; url: string }
  | { type: "code"; code: string }
  | { type: "state"; state: JobState; exitCode?: number; error?: string };

interface Live extends Job {
  p?: pty.IPty;
  scan: string; // saída limpa (cauda) onde se procuram URL/código/pedidos
  secrets: string[]; // textos enviados pelo usuário: nunca ficam no log
  replied: Set<number>;
  inputSent: boolean;
  timer?: NodeJS.Timeout;
  poll?: NodeJS.Timeout;
  listeners: Set<(e: JobEvent) => void>;
}

const active = (j: { state: JobState }) => j.state === "running" || j.state === "waiting_input";
const view = (j: Live): Job => ({
  id: j.id, cliId: j.cliId, kind: j.kind, state: j.state, account: j.account, log: j.log, url: j.url, code: j.code,
  exitCode: j.exitCode, error: j.error, startedAt: j.startedAt, endedAt: j.endedAt,
});
const ref = (j: Live): JobRef => ({ id: j.id, cliId: j.cliId, kind: j.kind, state: j.state });

const URL_RE = /https:\/\/[^\s"'<>]+(?=\s)/;
const CODE_RE = /\b(?=[A-Z0-9-]*[A-Z])[A-Z0-9]{4}-[A-Z0-9]{4,5}\b/; // ABCD-1234 (precisa de ao menos uma letra)

export class CliTools {
  private jobs = new Map<string, Live>();

  constructor(private accounts: AccountStore) {}

  installEnabled() {
    return process.env.MAESTRI_CLI_INSTALL !== "0";
  }

  private timeouts() {
    return {
      install: Number(process.env.MAESTRI_CLI_INSTALL_TIMEOUT_MS) || 15 * 60_000,
      login: Number(process.env.MAESTRI_CLI_LOGIN_TIMEOUT_MS) || 10 * 60_000,
    };
  }

  // Conta pedida (só claude/codex; "Default" = login global do CLI) -> nome canônico e env
  private resolveAccount(d: CliDef, raw: unknown): { name?: string; env: Record<string, string> } {
    if (raw === undefined || raw === null || raw === "") return { env: {} };
    if (typeof raw !== "string") throw new ApiError(400, "account deve ser texto.");
    if (!d.program) {
      if (raw.trim().toLowerCase() === DEFAULT_ACCOUNT.toLowerCase()) return { env: {} };
      throw new ApiError(400, `${d.label} só aceita a conta "${DEFAULT_ACCOUNT}".`);
    }
    const real = this.accounts.find(d.program, raw);
    if (!real) throw new ApiError(404, `Conta "${raw}" não encontrada para ${d.program}.`);
    return real === DEFAULT_ACCOUNT ? { env: {} } : { name: real, env: this.accounts.envForProgram(d.program, real) };
  }

  private env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: cliPath(), ...extra };
    if (isWindows) env.Path = env.PATH;
    return env;
  }

  private sweep() {
    const now = Date.now();
    for (const [id, j] of this.jobs) if (!active(j) && j.endedAt && now - Date.parse(j.endedAt) > FINISHED_TTL_MS) this.jobs.delete(id);
  }

  activeJob(cliId: string): Live | undefined {
    return [...this.jobs.values()].find((j) => j.cliId === cliId && active(j));
  }

  // Cache de versão + status por CLI+conta (as checagens custam até ~2s cada: gemini/agy). Guarda a promessa, então
  // pedidos simultâneos dividem a mesma checagem. Cai quando um job/logout daquele CLI termina ou com ?refresh=1.
  private probes = new Map<string, { at: number; p: Promise<Probe> }>();

  private cacheMs() {
    const v = process.env.MAESTRI_CLI_CACHE_MS;
    return v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : 30_000;
  }

  private invalidate(cliId: string) {
    for (const k of [...this.probes.keys()]) if (k.startsWith(`${cliId}|`)) this.probes.delete(k);
  }

  private probe(d: CliDef, bin: string, env: NodeJS.ProcessEnv, account: string | undefined, refresh: boolean): Promise<Probe> {
    const key = `${d.id}|${account ?? ""}|${bin}`;
    const ttl = this.cacheMs();
    const hit = this.probes.get(key);
    if (!refresh && hit && Date.now() - hit.at < ttl) return hit.p;
    // versão e status em paralelo, cada um com teto de 8s (estourou => null: não dá para saber)
    const p = Promise.all([
      timeoutAfter(run(bin, d.versionArgs, env, checkTimeout()), checkTimeout(), { code: null, out: "" } as RunResult),
      timeoutAfter(d.statusCheck({ bin, env }), checkTimeout(), { loggedIn: null } as StatusResult),
    ]).then(([v, st]): Probe => ({ version: v.code === 0 ? lastLine(v.out) || null : null, loggedIn: st.loggedIn, detail: st.detail }));
    if (ttl > 0) this.probes.set(key, { at: Date.now(), p });
    return p;
  }

  async list(account?: unknown, refresh = false) {
    this.sweep();
    // conta inexistente em todos os programas => 404; senão cada CLI usa a conta que tiver (ou o padrão)
    if (typeof account === "string" && account && account.trim().toLowerCase() !== DEFAULT_ACCOUNT.toLowerCase() && !CATALOG.some((d) => d.program && this.accounts.find(d.program, account))) {
      throw new ApiError(404, `Conta "${account}" não encontrada.`);
    }
    return Promise.all(
      CATALOG.map(async (d) => {
        let acc: { name?: string; env: Record<string, string> } = { env: {} };
        try {
          acc = this.resolveAccount(d, account); // CLI que não tem essa conta (ou não aceita contas): vale o login padrão
        } catch {}
        const bin = findBin(d.bin);
        const job = this.activeJob(d.id);
        const info: Record<string, unknown> = {
          id: d.id, label: d.label, installed: !!bin, version: null as string | null, path: bin, loggedIn: null as boolean | null,
          accountsSupported: !!d.program, installCmd: d.installCmd,
        };
        if (job) info.activeJob = ref(job);
        if (bin) {
          const env = this.env(acc.env);
          const pr = await this.probe(d, bin, env, acc.name, refresh);
          info.version = pr.version;
          info.loggedIn = pr.loggedIn;
          if (pr.detail) info.loginDetail = pr.detail;
        }
        return info;
      }),
    );
  }

  // ---- jobs ----

  private newJob(cliId: CliId, kind: JobKind, account?: string): Live {
    this.sweep();
    if (this.activeJob(cliId)) throw new ApiError(409, `Já existe um job ativo para ${cliId}.`);
    const j: Live = {
      id: crypto.randomUUID(), cliId, kind, state: "running", account, log: "", startedAt: new Date().toISOString(),
      scan: "", secrets: [], replied: new Set(), inputSent: false, listeners: new Set(),
    };
    this.jobs.set(j.id, j);
    return j;
  }

  private emit(j: Live, e: JobEvent) {
    for (const fn of j.listeners) {
      try {
        fn(e);
      } catch {}
    }
  }

  private setState(j: Live, state: JobState, extra: { exitCode?: number; error?: string } = {}) {
    if (!active(j) && state !== j.state) return; // já finalizado
    if (j.state === state && !extra.error) return;
    j.state = state;
    if (extra.exitCode !== undefined) j.exitCode = extra.exitCode;
    if (extra.error) j.error = extra.error;
    if (!active(j)) {
      j.endedAt = new Date().toISOString();
      clearTimeout(j.timer);
      clearInterval(j.poll);
      this.invalidate(j.cliId); // instalou/logou/falhou: o que estava em cache já não vale
    }
    this.emit(j, { type: "state", state, exitCode: j.exitCode, error: j.error });
  }

  // Saída do PTY: limpa, esconde o que o usuário digitou, guarda o log e procura URL/código/pedidos
  private onData(j: Live, d: CliDef, raw: string) {
    let text = clean(raw);
    if (!text) return;
    for (const s of j.secrets) text = text.split(s).join("•••");
    j.log = (j.log + text).slice(-LOG_MAX);
    for (const s of j.secrets) if (j.log.includes(s)) j.log = j.log.split(s).join("•••");
    this.emit(j, { type: "log", data: text });
    j.scan = (j.scan + text).slice(-8000);

    if (j.kind === "login") {
      if (d.urlRe) {
        // Última ocorrência da URL do próprio CLI (troca se o CLI reimprimir uma nova)
        const all = j.scan.match(new RegExp(d.urlRe.source, "g"));
        const url = all?.[all.length - 1].replace(/[.,;:)\]]+$/, "");
        if (url && url !== j.url) {
          j.url = url;
          this.emit(j, { type: "url", url });
        }
      } else if (!j.url) {
        const m = URL_RE.exec(j.scan);
        if (m) {
          j.url = m[0].replace(/[.,;:)\]]+$/, "");
          this.emit(j, { type: "url", url: j.url });
        }
      }
      if (!j.code) {
        const m = CODE_RE.exec(j.scan.replace(/https:\/\/\S+/g, ""));
        if (m) {
          j.code = m[0];
          this.emit(j, { type: "code", code: j.code });
        }
      }
      d.autoReply?.forEach((r, i) => {
        if (j.replied.has(i) || !r.re.test(j.scan)) return;
        j.replied.add(i);
        setTimeout(() => {
          try {
            if (active(j)) j.p?.write(r.send);
          } catch {}
        }, 300);
      });
      if (j.state === "running" && d.waitFor?.test(j.scan.slice(-400))) this.setState(j, "waiting_input");
    }
  }

  private spawn(j: Live, d: CliDef, file: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) {
    const p = pty.spawn(file, args, { name: "xterm-256color", cols: isWindows ? 500 : 1000, rows: 40, cwd: homeDir(), env: env as Record<string, string> });
    j.p = p;
    p.onData((data) => this.onData(j, d, data));
    p.onExit(({ exitCode }) => void this.onExit(j, d, exitCode));
    j.timer = setTimeout(() => {
      if (!active(j)) return;
      this.setState(j, "failed", { error: `Tempo esgotado (${Math.round(timeoutMs / 60000)} min).` });
      killGroup(p);
    }, timeoutMs);
    j.timer.unref();
  }

  private async onExit(j: Live, d: CliDef, exitCode: number) {
    if (!active(j)) return;
    j.exitCode = exitCode;
    if (exitCode !== 0) return this.setState(j, "failed", { exitCode, error: lastLine(j.log) || `Saiu com código ${exitCode}.` });
    if (j.kind === "install") {
      if (!findBin(d.bin)) return this.setState(j, "failed", { exitCode, error: `Instalação terminou, mas o binário "${d.bin}" não foi encontrado no PATH.` });
      return this.setState(j, "done", { exitCode });
    }
    // login: confere o status; se o CLI diz que continua deslogado, não é sucesso
    const bin = findBin(d.bin);
    if (bin) {
      const st = await d.statusCheck({ bin, env: this.env(this.accountEnv(j)) }).catch((): StatusResult => ({ loggedIn: null }));
      if (st.loggedIn === false) return this.setState(j, "failed", { exitCode, error: "O login terminou, mas o CLI continua deslogado." });
    }
    this.setState(j, "done", { exitCode });
  }

  private accountEnv(j: Live): Record<string, string> {
    const d = def(j.cliId);
    return d.program && j.account ? this.accounts.envForProgram(d.program, j.account) : {};
  }

  startInstall(id: string): JobRef {
    if (!this.installEnabled()) throw new ApiError(403, "Instalação de CLIs desligada neste servidor (MAESTRI_CLI_INSTALL=0).");
    const d = def(id);
    const j = this.newJob(d.id, "install");
    const shell = isWindows ? "C:\\Program Files\\Git\\bin\\bash.exe" : fs.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
    try {
      this.spawn(j, d, shell, ["-c", `set -o pipefail 2>/dev/null; ${d.installCmd}`], this.env(), this.timeouts().install);
    } catch (e: any) {
      this.setState(j, "failed", { error: `Falha ao iniciar a instalação: ${e?.message ?? e}` });
    }
    return ref(j);
  }

  startLogin(id: string, account?: unknown): JobRef {
    const d = def(id);
    const acc = this.resolveAccount(d, account);
    const bin = findBin(d.bin);
    if (!bin) throw new ApiError(400, `${d.label} não está instalado.`);
    const j = this.newJob(d.id, "login", acc.name);
    // BROWSER vazio e sem DISPLAY: o CLI imprime a URL no terminal em vez de tentar abrir um navegador
    const env = this.env({ ...acc.env, BROWSER: "", NO_COLOR: "1" });
    delete env.DISPLAY;
    delete env.WAYLAND_DISPLAY;
    try {
      this.spawn(j, d, bin, d.loginArgs ?? [], env, this.timeouts().login);
    } catch (e: any) {
      this.setState(j, "failed", { error: `Falha ao iniciar o login: ${e?.message ?? e}` });
    }
    return ref(j);
  }

  async logout(id: string, account?: unknown) {
    const d = def(id);
    if (!d.logoutArgs) throw new ApiError(400, `${d.label}: logout não suportado pelo menu.`);
    const acc = this.resolveAccount(d, account);
    const bin = findBin(d.bin);
    if (!bin) throw new ApiError(400, `${d.label} não está instalado.`);
    const r = await run(bin, d.logoutArgs, this.env(acc.env), 15000);
    this.invalidate(d.id);
    if (r.code !== 0) throw new ApiError(500, lastLine(r.out) || "Falha ao sair.");
    return { ok: true };
  }

  private find(jobId: string): Live {
    this.sweep();
    const j = this.jobs.get(jobId);
    if (!j) throw new ApiError(404, "Job não encontrado.");
    return j;
  }

  job(jobId: string): Job {
    return view(this.find(jobId));
  }

  // Escreve o texto + Enter no PTY. O texto NUNCA é logado e some da saída ecoada pelo terminal
  input(jobId: string, text: unknown) {
    const j = this.find(jobId);
    if (typeof text !== "string" || !text.length || text.length > 4096 || /[\r\n\x00-\x08\x0b-\x1f]/.test(text)) throw new ApiError(400, "text deve ser uma linha de texto (até 4096 caracteres).");
    if (!active(j) || !j.p) throw new ApiError(409, "O job não está ativo.");
    if (text.length >= 8) j.secrets.push(text);
    j.p.write(`${text}\r`);
    j.inputSent = true;
    if (j.state === "waiting_input") {
      j.scan = ""; // o pedido anterior foi atendido
      this.setState(j, "running");
    }
    const d = def(j.cliId);
    if (d.pollStatus && !j.poll && j.kind === "login") this.startPoll(j, d);
    return { ok: true };
  }

  // agy: a TUI não sai quando o login conclui; confere o status e encerra quando ficar logado
  private startPoll(j: Live, d: CliDef) {
    let busy = false;
    j.poll = setInterval(async () => {
      if (busy || !active(j)) return;
      busy = true;
      try {
        const bin = findBin(d.bin);
        const st = bin ? await d.statusCheck({ bin, env: this.env(this.accountEnv(j)) }) : { loggedIn: null };
        if (st.loggedIn === true && active(j)) {
          this.setState(j, "done", { exitCode: 0 });
          if (j.p) killGroup(j.p);
        }
      } catch {} finally {
        busy = false;
      }
    }, Number(process.env.MAESTRI_CLI_POLL_MS) || 3000);
    j.poll.unref();
  }

  cancel(jobId: string) {
    const j = this.find(jobId);
    if (!active(j)) throw new ApiError(409, "O job já terminou.");
    this.setState(j, "cancelled");
    if (j.p) killGroup(j.p);
    return { ok: true };
  }

  // Assina os eventos de um job: devolve o snapshot e a função de cancelar a assinatura
  subscribe(jobId: string, fn: (e: JobEvent) => void): { job: Job; off: () => void } {
    const j = this.find(jobId);
    j.listeners.add(fn);
    return { job: view(j), off: () => void j.listeners.delete(fn) };
  }

  refOf(jobId: string): JobRef {
    return ref(this.find(jobId));
  }

  killAll() {
    for (const j of this.jobs.values()) {
      clearTimeout(j.timer);
      clearInterval(j.poll);
      if (active(j) && j.p) killGroup(j.p);
    }
  }
}
