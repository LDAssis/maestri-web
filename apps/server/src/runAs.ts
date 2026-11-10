// Comandos do servidor dentro de um projeto (git, pre-run das rotinas) rodam como o usuário do projeto quando ele é isolado:
// um repositório controlado pelo agente (core.fsmonitor, hooks, aliases no .git/config) nunca executa código como root.
// Sem isolamento (dev/CI/projeto externo) o comportamento é o de sempre, com `safe.directory=*` para repositórios de outro dono.
import { execFile, execFileSync, spawn, type ChildProcess, type ExecFileOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SETPRIV, type RunAs } from "./isolation.js";
import { runOps, type FsOp, type FsResult } from "./fsOps.mjs";

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

// gh (PR dos andares): como o usuário do projeto quando isolado (sem as credenciais do root; ele faz `gh auth login` no próprio HOME);
// em projeto externo/dev continua com as credenciais do servidor, mas com o git que ele dispara blindado contra o .git/config do repo
// (sem fsmonitor/hooks, sem config de sistema) e sem herdar o ambiente do servidor.
export const HARD_GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_COUNT: "3", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "*", GIT_CONFIG_KEY_1: "core.fsmonitor", GIT_CONFIG_VALUE_1: "false",
  GIT_CONFIG_KEY_2: "core.hooksPath", GIT_CONFIG_VALUE_2: "/dev/null",
};
export function ghExecFile(cwd: string, args: string[], opts: ExecFileOptions, cb: (err: any, stdout: any, stderr: any) => void): ChildProcess {
  const r = runAsFor(cwd);
  if (r) {
    const a = asUser(r, "gh", args);
    return execFile(a.file, a.args, { ...opts, cwd, env: userEnv(r, {}) } as ExecFileOptions, cb as any);
  }
  // credenciais/config do próprio gh (GH_*, GITHUB_TOKEN) passam; o resto do ambiente do servidor não
  const ghVars = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && /^(GH_|GITHUB_)/.test(k))) as Record<string, string>;
  return execFile("gh", args, { ...opts, cwd, env: { ...scrubbedEnv(), ...ghVars, ...HARD_GIT_ENV } } as ExecFileOptions, cb as any);
}

// ---- Arquivos do projeto ----
// Tudo que o servidor (root) escreve/copia/apaga dentro da árvore de um projeto isolado ou do HOME dele roda COMO o usuário do projeto
// (helper fsOps.mjs sob setpriv): um symlink plantado pelo agente nunca leva o servidor a tocar em arquivo de root. Sem isolamento,
// as mesmas operações rodam no processo com O_NOFOLLOW e tmp aleatório (fsOps.mjs).
const FS_HELPER = fileURLToPath(new URL("./fsOps.mjs", import.meta.url));
export function fsOps(ops: FsOp[], r: RunAs | null): FsResult[] {
  if (!r) return runOps(ops);
  const a = asUser(r, process.execPath, ["--no-warnings", FS_HELPER]);
  const out = execFileSync(a.file, a.args, { input: JSON.stringify(ops), cwd: r.home, env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: r.home, LANG: "C.UTF-8" }, maxBuffer: 512 * 1024 * 1024, timeout: 120_000 });
  return JSON.parse(String(out));
}
export const fsOpsAt = (anyPathInProject: string, ops: FsOp[]) => fsOps(ops, runAsFor(anyPathInProject));
// Igual, mas lança na primeira operação que falhar
export function fsOpsStrict(r: RunAs | null, ops: FsOp[]) {
  const res = fsOps(ops, r);
  const bad = res.findIndex((x) => x && typeof x === "object" && "error" in x);
  if (bad >= 0) throw new Error(`${ops[bad].op} ${"path" in ops[bad] ? (ops[bad] as any).path : ""}: ${(res[bad] as any).error}`);
  return res;
}
export const fsOpsAtStrict = (p: string, ops: FsOp[]) => fsOpsStrict(runAsFor(p), ops);

// $HOME/.gemini -> pasta da conta gemini (agy e gemini-cli). target "" = sem conta liberada: tira o link (o agente vê "não logado"
// em vez de erro de permissão). Se já existe um .gemini de verdade (dados do próprio projeto), ele é guardado ao lado, não apagado.
export function linkGeminiHome(home: string, uid: number | null, gid: number | null, target: string) {
  const link = path.join(home, ".gemini");
  let st: fs.Stats | null = null;
  try {
    st = fs.lstatSync(link);
  } catch {}
  if (st?.isSymbolicLink()) {
    if (target && fs.readlinkSync(link) === target) return;
    fs.unlinkSync(link);
  } else if (st && target) {
    fs.renameSync(link, link + ".local-" + Date.now());
  }
  if (!target) return;
  fs.symlinkSync(target, link, "dir");
  if (uid != null && gid != null) {
    try {
      fs.lchownSync(link, uid, gid);
    } catch {}
  }
}

// Acrescenta "/.worktrees/" ao .git/info/exclude (como o usuário do projeto, sem seguir symlink)
export function ensureWorktreesExcluded(exclude: string) {
  const cur = String(fsOpsAt(exclude, [{ op: "read", path: exclude }])[0] ?? "");
  if (/^\/?\.worktrees\/?$/m.test(cur)) return;
  fsOpsAt(exclude, [{ op: "append", path: exclude, data: `${cur && !cur.endsWith("\n") ? "\n" : ""}/.worktrees/\n` }]); // melhor esforço
}

// mkdir -p como o dono do projeto (os diretórios já nascem com o dono certo; sem seguir nada de root)
export function mkdirOwned(dir: string) {
  fsOpsAtStrict(dir, [{ op: "mkdirp", path: dir }]);
}
