// Migração para o isolamento no SO (Fase 3). IDEMPOTENTE; dry-run por padrão (só mostra o que faria).
//
//   npx tsx scripts/migrate-isolation.ts                      # dry-run de todos os projetos
//   npx tsx scripts/migrate-isolation.ts --project proj-123   # só um
//   npx tsx scripts/migrate-isolation.ts --apply              # executa (root, Linux; pare o serviço antes)
//   npx tsx scripts/migrate-isolation.ts --accounts-only --apply   # só as contas (projetos já migrados): move, cria Padrão (claude, codex, gemini) e normaliza permissões
//
// Para cada projeto cuja pasta está em /root/maestri-projects: mata processos que estão nela, faz backup tar em
// /srv/maestri/backups, cria o usuário mp-<id>, move a pasta para /srv/maestri/projects, chown -R, chmod, repara as worktrees,
// reescreve os caminhos nos dados do canvas/andares e atualiza projects.json (repoPath, osUser, uid, gid, isolated).
// Projetos com pasta externa (ex.: o próprio maestri-web) só ganham isolated:false.
// Contas de assinatura: move .maestri_data/accounts para /srv/maestri/accounts (root:mac-<programa>-<nome>, 2770) e cria a conta
// "Padrão" (claude, codex e gemini = gemini-cli + agy, que dividem ~/.gemini) copiando o essencial do login do root (SEM o histórico
// de conversas) — sem apagar o original. Em toda rodada as contas existentes têm dono/grupo/modo normalizados (grupo da conta rw).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Isolation, loadIsolationConfig, realExec, type Exec, type IsolationConfig } from "../src/isolation.js";
import { isInside } from "../src/projectDirs.js";

type Obj = Record<string, any>;

export interface MigrateOptions {
  apply: boolean;
  only?: string; // id de um projeto
  accountsOnly?: boolean; // pula os projetos (já migrados) e roda só a parte de contas
  dataDir: string; // .maestri_data
  legacyRoot: string; // /root/maestri-projects
  home: string; // /root (login do admin: .claude, .claude.json, .codex)
  cfg: IsolationConfig;
  exec?: Exec;
  log?: (msg: string) => void;
  stamp?: string;
  killProcesses?: (dir: string) => number; // devolve quantos matou (padrão: varre /proc)
  chown?: (p: string, uid: number, gid: number) => void; // só testes
}

export interface MigrateReport {
  actions: string[];
  migrated: string[];
  alreadyDone: string[];
  external: string[];
  orphanDirs: string[]; // pastas em legacyRoot que nenhum projeto usa (não são mexidas)
  accounts: string[];
  warnings: string[];
}

// Pastas que NÃO vão para a conta "Padrão": histórico de conversas e estado por projeto do root (vazariam entre projetos)
const CLAUDE_KEEP = [".credentials.json", "settings.json", "settings.local.json", "CLAUDE.md", "commands", "agents", "skills", "plugins"];
const CODEX_KEEP = ["auth.json", "config.toml", "AGENTS.md", "skills", "prompts"];
// ~/.gemini (gemini-cli e agy): só login/config; fora history/, tmp/, projects.json (histórico), conversas (*.db), cache, bin e logs
const GEMINI_KEEP = ["oauth_creds.json", "google_accounts.json", "installation_id", "settings.json", "skills", "config", "antigravity-cli/antigravity-oauth-token", "antigravity-cli/settings.json", "antigravity-cli/installation_id"];

// Processos cujo cwd está dentro da pasta (terminais/agentes do projeto)
export function killProcessesIn(dir: string): number {
  let n = 0;
  if (!fs.existsSync("/proc")) return 0;
  for (const pid of fs.readdirSync("/proc").filter((x) => /^\d+$/.test(x))) {
    if (Number(pid) === process.pid) continue;
    try {
      const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
      if (isInside(dir, cwd)) {
        process.kill(Number(pid), "SIGKILL");
        n++;
      }
    } catch {}
  }
  return n;
}

const readJson = <T>(f: string, fallback: T): T => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8")) as T;
  } catch {
    return fallback;
  }
};
function writeJson(f: string, data: unknown) {
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, f);
}

function moveDir(src: string, dest: string) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.renameSync(src, dest);
  } catch (e: any) {
    if (e.code !== "EXDEV") throw e;
    fs.cpSync(src, dest, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

export function runMigration(o: MigrateOptions): MigrateReport {
  const log = o.log ?? ((m: string) => console.log(m));
  const exec = o.exec ?? realExec;
  const stamp = o.stamp ?? new Date().toISOString().replace(/[:.]/g, "-");
  const iso = new Isolation(o.cfg, o.dataDir, exec);
  if (o.chown) iso.chown = o.chown;
  const r: MigrateReport = { actions: [], migrated: [], alreadyDone: [], external: [], orphanDirs: [], accounts: [], warnings: [] };
  const act = (m: string) => {
    r.actions.push(m);
    log(`${o.apply ? "" : "[dry-run] "}${m}`);
  };
  const warn = (m: string) => {
    r.warnings.push(m);
    log(`AVISO: ${m}`);
  };

  const projectsFile = path.join(o.dataDir, "projects.json");
  const defaultRepo = path.dirname(o.dataDir);
  const projects = readJson<Obj[]>(projectsFile, []);
  const abs = (p: Obj) => path.resolve(defaultRepo, String(p.repoPath));
  let projectsChanged = false;
  let backedUp = false;
  const saveProjects = () => {
    if (!backedUp) {
      fs.copyFileSync(projectsFile, `${projectsFile}.bak-${stamp}`);
      backedUp = true;
    }
    // mesma convenção do servidor: dentro do repo principal relativo, fora absoluto
    writeJson(projectsFile, projects.map((p) => ({ ...p, repoPath: isInside(defaultRepo, abs(p)) ? path.relative(defaultRepo, abs(p)) || "." : abs(p) })));
  };

  if (o.apply) {
    for (const d of [o.cfg.rootDir, o.cfg.projectsDir, o.cfg.homeDir, o.cfg.tmpDir, o.cfg.backupsDir, o.cfg.accountsDir]) {
      fs.mkdirSync(d, { recursive: true });
    }
    fs.chmodSync(o.cfg.backupsDir, 0o700);
    for (const d of [o.cfg.rootDir, o.cfg.projectsDir, o.cfg.homeDir, o.cfg.tmpDir, o.cfg.accountsDir]) fs.chmodSync(d, 0o711);
  }

  // ---------- projetos ----------
  const targets = o.accountsOnly ? [] : projects.filter((p) => !o.only || p.id === o.only);
  if (o.only && !targets.length) warn(`Projeto "${o.only}" não encontrado em projects.json.`);
  for (const p of targets) {
    const dir = abs(p);
    if (p.osUser && iso.isManagedDir(dir)) {
      r.alreadyDone.push(p.id);
      log(`${p.id}: já migrado (${p.osUser}, ${dir}).`);
      continue;
    }
    if (!isInside(o.legacyRoot, dir) || dir === o.legacyRoot) {
      // pasta externa (ex.: /opt/maestri-web): roda como root, só marca
      r.external.push(p.id);
      if (p.isolated === false) continue;
      act(`${p.id}: pasta externa (${dir}); marcar isolated:false (continua como root, sem mover nada).`);
      if (o.apply) {
        p.isolated = false;
        projectsChanged = true;
      }
      continue;
    }
    if (!fs.existsSync(dir)) {
      warn(`${p.id}: a pasta ${dir} não existe; nada a mover.`);
      continue;
    }
    const user = iso.userName(p.id);
    let dest = path.join(o.cfg.projectsDir, path.basename(dir));
    for (let n = 2; fs.existsSync(dest); n++) dest = path.join(o.cfg.projectsDir, `${path.basename(dir)}-${n}`);
    const backup = path.join(o.cfg.backupsDir, `${p.id}-${stamp}.tar.gz`);
    act(`${p.id}: matar processos com cwd em ${dir}`);
    act(`${p.id}: backup ${backup} (tar -czf)`);
    act(`${p.id}: criar usuário ${user} (uid a partir de ${20000}), HOME ${iso.homeOf(user)}, TMPDIR ${iso.tmpOf(user)}`);
    act(`${p.id}: mover ${dir} -> ${dest}; chown -R ${user}:${user}; chmod -R g-w,o-rwx; chmod 2750`);
    act(`${p.id}: git worktree repair; reescrever caminhos no canvas/andares; projects.json (repoPath, osUser, uid, gid, isolated)`);
    if (!o.apply) continue;

    const killed = (o.killProcesses ?? killProcessesIn)(dir);
    if (killed) log(`${p.id}: ${killed} processo(s) encerrado(s).`);
    exec("tar", ["-czf", backup, "-C", path.dirname(dir), path.basename(dir)]);
    fs.chmodSync(backup, 0o600);
    const os_ = iso.provision(p.id);
    moveDir(dir, dest);
    iso.claimDir(dest, os_.uid, os_.gid);
    try {
      exec("git", ["-c", "safe.directory=*", "-C", dest, "worktree", "repair"]);
    } catch (e: any) {
      warn(`${p.id}: git worktree repair falhou (${String(e?.message || e).split("\n")[0]}); andares podem precisar de reparo manual.`);
    }
    for (const f of [`canvas_${p.id}.json`, `floors_${p.id}.json`, `routines_${p.id}.json`, `settings_${p.id}.json`]) {
      const file = path.join(o.dataDir, f);
      if (!fs.existsSync(file)) continue;
      const txt = fs.readFileSync(file, "utf8");
      if (txt.includes(dir)) fs.writeFileSync(file, txt.split(dir).join(dest), { mode: 0o600 });
    }
    Object.assign(p, { repoPath: dest, osUser: os_.osUser, uid: os_.uid, gid: os_.gid, isolated: true });
    projectsChanged = true;
    saveProjects(); // um por vez: se parar no meio, o que já migrou está registrado
    r.migrated.push(p.id);
  }
  if (o.apply && projectsChanged) saveProjects(); // inclui as marcações isolated:false dos externos

  // Pastas do legacyRoot que nenhum projeto usa (ex.: "src"): só reporta
  if (!o.accountsOnly) try {
    const used = new Set(projects.map((p) => abs(p)));
    for (const e of fs.readdirSync(o.legacyRoot, { withFileTypes: true })) {
      const full = path.join(o.legacyRoot, e.name);
      if (e.isDirectory() && !used.has(full) && !projects.some((p) => isInside(full, abs(p)))) {
        r.orphanDirs.push(full);
        log(`Pasta sem projeto (NÃO mexida): ${full}`);
      }
    }
  } catch {}

  // ---------- contas de assinatura ----------
  const oldAccounts = path.join(o.dataDir, "accounts");
  const moves: { program: string; name: string; from: string; to: string }[] = [];
  for (const program of ["claude", "codex"]) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(path.join(oldAccounts, program), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {}
    for (const name of names) moves.push({ program, name, from: path.join(oldAccounts, program, name), to: path.join(o.cfg.accountsDir, program, name) });
  }
  if (moves.length) {
    act(`contas: backup de ${oldAccounts} em ${path.join(o.cfg.backupsDir, `accounts-${stamp}.tar.gz`)}`);
    if (o.apply) {
      const bk = path.join(o.cfg.backupsDir, `accounts-${stamp}.tar.gz`);
      exec("tar", ["-czf", bk, "-C", o.dataDir, "accounts"]);
      fs.chmodSync(bk, 0o600);
    }
  }
  for (const m of moves) {
    if (fs.existsSync(m.to)) {
      log(`conta ${m.program}/${m.name}: já existe em ${m.to}; nada a mover.`);
      continue;
    }
    act(`conta ${m.program}/${m.name}: mover para ${m.to}; grupo ${iso.groupFor(m.program, m.name)} (root:grupo, 2770)`);
    if (!o.apply) continue;
    moveDir(m.from, m.to);
    iso.ensureAccountDir(m.program, m.name, m.to, true);
    r.accounts.push(`${m.program}/${m.name}`);
  }

  // "Padrão": o login do admin vira a conta liberada a todo admin (cópia do essencial; o original fica)
  const std: { program: string; to: string; copy: () => void; has: boolean }[] = [
    {
      program: "claude",
      to: path.join(o.cfg.accountsDir, "claude", "Padrão"),
      has: fs.existsSync(path.join(o.home, ".claude")) || fs.existsSync(path.join(o.home, ".claude.json")),
      copy: () => {
        const dest = path.join(o.cfg.accountsDir, "claude", "Padrão");
        fs.mkdirSync(dest, { recursive: true });
        for (const k of CLAUDE_KEEP) {
          const src = path.join(o.home, ".claude", k);
          if (fs.existsSync(src)) fs.cpSync(src, path.join(dest, k), { recursive: true, preserveTimestamps: true });
        }
        const cj = path.join(o.home, ".claude.json");
        if (fs.existsSync(cj)) {
          const j = readJson<Obj>(cj, {});
          delete j.projects; // estado/histórico por projeto do root: não vai para uma conta compartilhada
          fs.writeFileSync(path.join(dest, ".claude.json"), JSON.stringify(j, null, 2), { mode: 0o660 });
        }
      },
    },
    {
      program: "gemini",
      to: path.join(o.cfg.accountsDir, "gemini", "Padrão"),
      has: fs.existsSync(path.join(o.home, ".gemini")),
      copy: () => {
        const dest = path.join(o.cfg.accountsDir, "gemini", "Padrão");
        fs.mkdirSync(dest, { recursive: true });
        for (const k of GEMINI_KEEP) {
          const src = path.join(o.home, ".gemini", k);
          if (!fs.existsSync(src)) continue;
          fs.mkdirSync(path.dirname(path.join(dest, k)), { recursive: true });
          // o histórico por projeto do config/ (config/projects) fica de fora
          fs.cpSync(src, path.join(dest, k), { recursive: true, preserveTimestamps: true, filter: (s) => !/[\\/]config[\\/]projects([\\/]|$)/.test(s) });
        }
      },
    },
    {
      program: "codex",
      to: path.join(o.cfg.accountsDir, "codex", "Padrão"),
      has: fs.existsSync(path.join(o.home, ".codex")),
      copy: () => {
        const dest = path.join(o.cfg.accountsDir, "codex", "Padrão");
        fs.mkdirSync(dest, { recursive: true });
        for (const k of CODEX_KEEP) {
          const src = path.join(o.home, ".codex", k);
          if (fs.existsSync(src)) fs.cpSync(src, path.join(dest, k), { recursive: true, preserveTimestamps: true });
        }
      },
    },
  ];
  for (const s of std) {
    if (fs.existsSync(s.to)) {
      log(`conta ${s.program}/Padrão: já existe.`);
      continue;
    }
    if (!s.has) {
      log(`conta ${s.program}/Padrão: sem login em ${o.home}; nada a copiar.`);
      continue;
    }
    act(`conta ${s.program}/Padrão: copiar o essencial de ${o.home} (sem histórico de conversas) para ${s.to}; grupo ${iso.groupFor(s.program, "Padrão")}`);
    if (!o.apply) continue;
    s.copy();
    iso.ensureAccountDir(s.program, "Padrão", s.to, true);
    r.accounts.push(`${s.program}/Padrão`);
  }

  // Contas já existentes (movidas antes, criadas pela UI, ou logins refeitos pelo servidor como root): dono/grupo/modo corretos
  // (grupo da conta rw). Idempotente e sem efeito colateral quando já está certo.
  for (const program of ["claude", "codex", "gemini"]) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(path.join(o.cfg.accountsDir, program), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {}
    for (const name of names) {
      if (!o.apply) continue;
      iso.ensureAccountDir(program, name, path.join(o.cfg.accountsDir, program, name), true);
    }
  }
  if (!o.apply) log("Contas existentes: as permissões serão normalizadas (grupo da conta rw) no --apply.");

  // Pré-requisito: o usuário do projeto precisa executar claude/codex (nada embaixo de /root)
  for (const bin of ["claude", "codex", "node", "git"]) {
    try {
      const p = execFileSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8", env: { ...process.env, PATH: `${process.env.PATH}:${o.home}/.local/bin` } }).trim();
      const real = fs.realpathSync(p);
      if (real.startsWith(`${o.home}/`) || p.startsWith(`${o.home}/`)) warn(`"${bin}" está em ${real}: o usuário do projeto não alcança ${o.home}. Instale para todos (ex.: /usr/local/bin) ou defina MAESTRI_PTY_PATH.`);
    } catch {}
  }

  if (!o.apply) log("\nDry-run: nada foi alterado. Rode com --apply (root, serviço parado) para executar.");
  return r;
}

// ---------- CLI ----------
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const argv = process.argv.slice(2);
  const arg = (n: string) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const apply = argv.includes("--apply");
  if (apply && !(process.platform === "linux" && process.getuid?.() === 0)) {
    console.error("--apply exige Linux e root.");
    process.exit(1);
  }
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const dataDir = path.resolve(arg("--data-dir") ?? path.join(process.env.REPO_PATH ?? repoRoot, ".maestri_data"));
  const home = arg("--home") ?? process.env.HOME ?? os.homedir();
  const cfg = { ...loadIsolationConfig(process.env, "linux", 0), enabled: true };
  const rep = runMigration({ apply, accountsOnly: argv.includes("--accounts-only"), only: arg("--project"), dataDir, legacyRoot: path.resolve(arg("--legacy-root") ?? path.join(home, "maestri-projects")), home, cfg });
  console.log(`\nResumo: migrados ${rep.migrated.length}, já migrados ${rep.alreadyDone.length}, externos ${rep.external.length}, contas ${rep.accounts.length}, avisos ${rep.warnings.length}.`);
}
