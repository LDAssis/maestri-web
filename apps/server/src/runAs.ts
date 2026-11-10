// Comandos do servidor dentro de um projeto (git, pre-run das rotinas) rodam como o usuário do projeto quando ele é isolado:
// um repositório controlado pelo agente (core.fsmonitor, hooks, aliases no .git/config) nunca executa código como root.
// Sem isolamento (dev/CI/projeto externo) o comportamento é o de sempre, com `safe.directory=*` para repositórios de outro dono.
import { execFile, spawn, type ChildProcess, type ExecFileOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { SETPRIV, type RunAs } from "./isolation.js";

// cwd -> identidade (resolvida pelo projeto que contém o diretório); null = sem isolamento
type Resolver = (cwd: string) => RunAs | null;
let resolver: Resolver | null = null;
export function setRunAsResolver(r: Resolver | null) {
  resolver = r;
}
export const runAsFor = (cwd: string): RunAs | null => (resolver ? resolver(cwd) : null);

// `git -c safe.directory=*` por variáveis de ambiente (vale para todo subprocesso git, inclusive o do gh)
export const SAFE_DIR_ENV = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "*" };

// Ambiente mínimo de um comando rodando como o usuário do projeto
function userEnv(r: RunAs, extra: Record<string, string>) {
  return {
    PATH: (process.env.PATH || "/usr/local/bin:/usr/bin:/bin").split(path.delimiter).filter((d) => d && !d.startsWith("/root")).join(path.delimiter),
    HOME: r.home, USER: r.user, LOGNAME: r.user, TMPDIR: r.tmp, LANG: process.env.LANG || "C.UTF-8",
    GIT_TERMINAL_PROMPT: "0", ...SAFE_DIR_ENV, ...extra,
  };
}

function asUser(r: RunAs, cmd: string, args: string[]) {
  return { file: SETPRIV, args: [`--reuid=${r.uid}`, `--regid=${r.gid}`, "--init-groups", "--no-new-privs", "--", cmd, ...args] };
}

// execFile("git", ...) com a identidade certa. `env` extra (GIT_AUTHOR_*...) é repassado nos dois modos.
export function gitExecFile(cwd: string, args: string[], opts: ExecFileOptions & { env?: Record<string, string> }, cb: (err: any, stdout: any, stderr: any) => void): ChildProcess {
  const { env: extra = {}, ...rest } = opts;
  const r = runAsFor(cwd);
  if (!r) return execFile("git", args, { ...rest, cwd, env: { ...process.env, ...SAFE_DIR_ENV, ...extra } } as ExecFileOptions, cb as any);
  const a = asUser(r, "git", args);
  return execFile(a.file, a.args, { ...rest, cwd, env: userEnv(r, extra) } as ExecFileOptions, cb as any);
}

// Pre-run (sh -c) de uma rotina: nunca com o ambiente do servidor; como o usuário do projeto quando isolado
// Ambiente herdado do servidor sem segredos: lista branca no Linux; nas demais plataformas (dev) tudo menos o token interno
const KEEP = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TZ", "TMPDIR", "TERM", "COLORTERM"];
export function scrubbedEnv(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (platform === "linux" ? KEEP.includes(k) : k !== "MAESTRI_TOKEN") out[k] = v;
  }
  return out;
}

// Pre-run (sh -c) de uma rotina: nunca com o ambiente do servidor; como o usuário do projeto quando isolado
export function spawnScript(script: string, cwd: string, extraEnv: Record<string, string>): ChildProcess {
  const r = runAsFor(cwd);
  if (!r) return spawn("sh", ["-c", script], { cwd, env: { ...scrubbedEnv(), ...extraEnv }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const a = asUser(r, "sh", ["-c", `umask 027; ${script}`]);
  return spawn(a.file, a.args, { cwd, env: { ...userEnv(r, {}), ...extraEnv }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
}

// Arquivos que o SERVIDOR cria dentro de um projeto isolado terminam com o dono certo (o agente edita e apaga)
export function fixOwner(target: string, recursive = false) {
  const r = runAsFor(target);
  if (!r) return;
  const apply = (p: string) => {
    try {
      fs.lchownSync(p, r.uid, r.gid);
    } catch {}
  };
  const walk = (p: string) => {
    apply(p);
    if (!recursive) return;
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) for (const e of fs.readdirSync(p)) walk(path.join(p, e));
  };
  walk(target);
}

// Cria os diretórios que faltam já com o dono do projeto (mkdir -p + chown de cada um que nasceu)
export function mkdirOwned(dir: string) {
  const made: string[] = [];
  let cur = path.resolve(dir);
  while (!fs.existsSync(cur)) {
    made.unshift(cur);
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  fs.mkdirSync(dir, { recursive: true });
  for (const d of made) fixOwner(d);
}
