// Isolamento no SO (Fase 3): um usuário Linux por projeto (mp-<id>), HOME/TMPDIR próprios, grupos por conta de assinatura e limites
// de cgroup. O servidor continua root; o PTY e os comandos do projeto rodam como o usuário do projeto (setpriv).
// Liga com MAESTRI_ISOLATION=1 e só vale em Linux como root. Projetos com pasta fora de <projects> (externos) seguem como root.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const SETPRIV = "/usr/bin/setpriv";
export const UID_BASE = 20000;
export const UID_MAX = 65000; // o LXC (unprivileged) só mapeia 0..65535

export interface IsolationConfig {
  enabled: boolean;
  rootDir: string; // /srv/maestri
  projectsDir: string;
  homeDir: string;
  tmpDir: string;
  accountsDir: string;
  backupsDir: string;
  userPrefix: string; // "mp-"
  groupPrefix: string; // "mac-"
  cgroup: boolean;
  limits: { memory: string; tasks: string; cpu: string };
}

export function loadIsolationConfig(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform, uid: number | undefined = process.getuid?.()): IsolationConfig {
  const rootDir = path.resolve(env.MAESTRI_ISOLATION_ROOT || "/srv/maestri");
  return {
    enabled: env.MAESTRI_ISOLATION === "1" && platform === "linux" && uid === 0,
    rootDir,
    projectsDir: path.resolve(env.MAESTRI_PROJECTS_DIR || path.join(rootDir, "projects")),
    homeDir: path.join(rootDir, "home"),
    tmpDir: path.join(rootDir, "tmp"),
    accountsDir: path.resolve(env.MAESTRI_ACCOUNTS_DIR || path.join(rootDir, "accounts")),
    backupsDir: path.join(rootDir, "backups"),
    userPrefix: env.MAESTRI_ISOLATION_USER_PREFIX || "mp-",
    groupPrefix: env.MAESTRI_ISOLATION_GROUP_PREFIX || "mac-",
    cgroup: env.MAESTRI_ISOLATION_CGROUP !== "0",
    limits: { memory: env.MAESTRI_LIMIT_MEMORY || "2G", tasks: env.MAESTRI_LIMIT_TASKS || "512", cpu: env.MAESTRI_LIMIT_CPU || "200%" },
  };
}

// Identidade sob a qual um comando de projeto roda
export interface RunAs {
  user: string;
  uid: number;
  gid: number;
  home: string;
  tmp: string;
  scope: string[]; // prefixo do systemd-run (vazio sem cgroup)
}

export type Exec = (cmd: string, args: string[]) => string;
export const realExec: Exec = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });

const sha10 = (s: string) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 10);
const slugify = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

export interface ProjectLike {
  id: string;
  repoPath: string;
  osUser?: string;
  uid?: number;
  gid?: number;
  isolated?: boolean;
}

export class Isolation {
  private stateFile: string;
  // chown dos diretórios que o servidor cria (trocável nos testes sem root)
  chown: (p: string, uid: number, gid: number) => void = (p, u, g) => fs.chownSync(p, u, g);
  constructor(
    public cfg: IsolationConfig,
    private dataDir: string,
    private exec: Exec = realExec,
  ) {
    this.stateFile = path.join(dataDir, "isolation.json");
  }

  get enabled() {
    return this.cfg.enabled;
  }

  // ---------- nomes ----------
  // mp-<id> (minúsculas; ids com caracteres que o Linux não aceita ou longos demais viram mp-<hash>)
  userName(projectId: string) {
    const plain = this.cfg.userPrefix + projectId.toLowerCase();
    return /^[a-z_][a-z0-9_-]*$/.test(plain) && plain.length <= 32 && plain === this.cfg.userPrefix + projectId ? plain : this.cfg.userPrefix + sha10(projectId);
  }
  homeOf(user: string) {
    return path.join(this.cfg.homeDir, user);
  }
  tmpOf(user: string) {
    return path.join(this.cfg.tmpDir, user);
  }
  // Pasta do projeto é gerenciada (vive em <projects>) ou externa (fica como está, roda como root)
  isManagedDir(repoPath: string) {
    const rel = path.relative(this.cfg.projectsDir, repoPath);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  }
  isIsolated(p: ProjectLike) {
    return this.cfg.enabled && !!p.osUser && !!p.uid && p.isolated !== false;
  }

  // ---------- consulta ao sistema ----------
  private passwd(user: string): { uid: number; gid: number } | null {
    try {
      const f = this.exec("getent", ["passwd", user]).trim().split(":");
      return f.length >= 4 ? { uid: Number(f[2]), gid: Number(f[3]) } : null;
    } catch {
      return null;
    }
  }
  private uidTaken(uid: number) {
    try {
      return this.exec("getent", ["passwd", String(uid)]).trim() !== "";
    } catch {
      return false;
    }
  }
  private groupExists(g: string) {
    try {
      return this.exec("getent", ["group", g]).trim() !== "";
    } catch {
      return false;
    }
  }
  groupGid(g: string): number | null {
    try {
      const f = this.exec("getent", ["group", g]).trim().split(":");
      return f.length >= 3 ? Number(f[2]) : null;
    } catch {
      return null;
    }
  }

  // Usuários mp-* existentes no sistema (uid >= UID_BASE): para o aviso de órfãos
  listProjectUsers(): string[] {
    try {
      return this.exec("getent", ["passwd"])
        .split("\n")
        .map((l) => l.split(":"))
        .filter((f) => f[0]?.startsWith(this.cfg.userPrefix) && Number(f[2]) >= UID_BASE)
        .map((f) => f[0]);
    } catch {
      return [];
    }
  }

  // ---------- uid ----------
  private readState(): { nextUid: number } {
    try {
      const s = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
      if (Number.isInteger(s.nextUid) && s.nextUid >= UID_BASE) return s;
    } catch {}
    return { nextUid: UID_BASE };
  }
  private writeState(s: { nextUid: number }) {
    const tmp = `${this.stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
    fs.renameSync(tmp, this.stateFile);
  }
  // Contador persistido; pula uids já ocupados no sistema. Nunca passa de UID_MAX.
  allocateUid(): number {
    const st = this.readState();
    let uid = st.nextUid;
    while (uid <= UID_MAX && this.uidTaken(uid)) uid++;
    if (uid > UID_MAX) throw new Error(`Sem uids livres para projetos (limite ${UID_MAX}).`);
    this.writeState({ nextUid: uid + 1 });
    return uid;
  }

  // ---------- ciclo de vida ----------
  // Cria (ou reaproveita) o usuário do projeto, HOME e TMPDIR. Idempotente. Não mexe na pasta do projeto: use claimDir.
  provision(projectId: string): { osUser: string; uid: number; gid: number } {
    const user = this.userName(projectId);
    let pw = this.passwd(user);
    if (!pw) {
      const uid = this.allocateUid();
      this.exec("useradd", ["-M", "-U", "-u", String(uid), "-d", this.homeOf(user), "-s", "/bin/bash", user]);
      pw = this.passwd(user) ?? { uid, gid: uid };
    }
    for (const d of [this.homeOf(user), this.tmpOf(user)]) {
      fs.mkdirSync(d, { recursive: true, mode: 0o700 });
      this.chown(d, pw.uid, pw.gid);
      fs.chmodSync(d, 0o700);
    }
    for (const d of [this.cfg.homeDir, this.cfg.tmpDir]) {
      try {
        fs.chmodSync(d, 0o711);
      } catch {}
    }
    this.ensureSlice(user);
    return { osUser: user, uid: pw.uid, gid: pw.gid };
  }

  // Passa a pasta do projeto ao usuário (dono e grupo mp-<id>, 2750; o servidor é root e escreve em qualquer lugar)
  claimDir(repoPath: string, uid: number, gid: number, recursive = true) {
    if (recursive) this.exec("chown", ["-R", `${uid}:${gid}`, repoPath]);
    else this.chown(repoPath, uid, gid);
    if (recursive) this.exec("chmod", ["-R", "g-w,o-rwx", repoPath]);
    fs.chmodSync(repoPath, 0o2750);
  }

  // Remove tudo do projeto no SO: processos, usuário/grupo, HOME e TMPDIR (a pasta do projeto é do chamador)
  deprovision(osUser: string) {
    if (!osUser.startsWith(this.cfg.userPrefix)) return; // nunca toca em usuários que não são de projeto
    try {
      this.exec("pkill", ["-KILL", "-u", osUser]);
    } catch {} // sem processos = código 1
    try {
      this.exec("userdel", [osUser]);
    } catch {}
    if (this.groupExists(osUser)) {
      try {
        this.exec("groupdel", [osUser]);
      } catch {}
    }
    for (const d of [this.homeOf(osUser), this.tmpOf(osUser)]) fs.rmSync(d, { recursive: true, force: true });
    for (const args of [["stop", `${osUser}.slice`], ["revert", `${osUser}.slice`]]) {
      try {
        this.exec("systemctl", args); // revert tira os limites gravados com set-property --runtime
      } catch {}
    }
  }

  killUser(osUser: string) {
    if (!osUser.startsWith(this.cfg.userPrefix)) return;
    try {
      this.exec("pkill", ["-KILL", "-u", osUser]);
    } catch {}
  }

  // ---------- cgroup ----------
  // Limites no slice do projeto (valem para todos os terminais dele juntos). Em runtime: reaplicados a cada subida do servidor.
  ensureSlice(osUser: string) {
    if (!this.cfg.cgroup) return;
    try {
      this.exec("systemctl", ["set-property", "--runtime", `${osUser}.slice`, `MemoryMax=${this.cfg.limits.memory}`, `TasksMax=${this.cfg.limits.tasks}`, `CPUQuota=${this.cfg.limits.cpu}`]);
    } catch (e: any) {
      console.warn(`Isolamento: limites de cgroup não aplicados a ${osUser}: ${String(e?.message || e).split("\n")[0]}`);
    }
  }

  // ---------- identidade de execução ----------
  runAs(p: ProjectLike): RunAs | null {
    if (!this.isIsolated(p)) return null;
    const user = p.osUser!;
    return {
      user, uid: p.uid!, gid: p.gid ?? p.uid!, // o grupo primário (-U) costuma nascer com o mesmo número do uid
      home: this.homeOf(user), tmp: this.tmpOf(user),
      scope: this.cfg.cgroup ? ["systemd-run", "--scope", "--quiet", `--slice=${user}.slice`, "--"] : [],
    };
  }

  // ---------- contas de assinatura (grupos) ----------
  groupFor(program: string, name: string) {
    const slug = slugify(name).slice(0, 12) || "x";
    return `${this.cfg.groupPrefix}${program}-${slug}-${sha10(`${program}/${name}`).slice(0, 4)}`;
  }

  // Pasta da conta: root:<grupo da conta>, 2770 (o login do CLI é gravado pelos projetos que entram no grupo)
  ensureAccountDir(program: string, name: string, dir: string, recursive = false) {
    const g = this.groupFor(program, name);
    if (!this.groupExists(g)) this.exec("groupadd", [g]);
    fs.mkdirSync(dir, { recursive: true });
    const gid = this.groupGid(g);
    if (gid == null) throw new Error(`Grupo ${g} não encontrado.`);
    if (recursive) {
      this.exec("chown", ["-R", `0:${gid}`, dir]);
      this.exec("chmod", ["-R", "g+rwX,o-rwx", dir]);
    }
    this.chown(dir, 0, gid);
    fs.chmodSync(dir, 0o2770);
    for (const parent of [path.dirname(dir), this.cfg.accountsDir]) {
      try {
        fs.chmodSync(parent, 0o711); // atravessar sem listar
      } catch {}
    }
    return g;
  }

  removeAccountGroup(program: string, name: string) {
    const g = this.groupFor(program, name);
    if (!this.groupExists(g)) return;
    try {
      this.exec("groupdel", [g]);
    } catch {}
  }

  // Grupos de conta (prefixo mac-) em que o usuário está
  accountGroupsOf(osUser: string): string[] {
    try {
      return this.exec("id", ["-nG", osUser]).trim().split(/\s+/).filter((g) => g.startsWith(this.cfg.groupPrefix));
    } catch {
      return [];
    }
  }

  // Deixa o usuário exatamente nos grupos de conta desejados; devolve o que entrou e o que saiu
  syncAccountGroups(osUser: string, wanted: string[]) {
    const want = new Set(wanted);
    const have = new Set(this.accountGroupsOf(osUser));
    const added: string[] = [];
    const removed: string[] = [];
    for (const g of want) {
      if (have.has(g)) continue;
      this.exec("usermod", ["-aG", g, osUser]);
      added.push(g);
    }
    for (const g of have) {
      if (want.has(g)) continue;
      try {
        this.exec("gpasswd", ["-d", osUser, g]);
        removed.push(g);
      } catch {}
    }
    return { added, removed };
  }
}

// Monta o argv do PTY isolado (puro: testável sem root)
export function isolatedArgv(r: RunAs, envPairs: string[], shellArgs: string[] = ["--login", "-i"]) {
  const inner = `umask 027; exec bash ${shellArgs.join(" ")}`;
  return {
    file: r.scope.length ? r.scope[0] : SETPRIV,
    args: [
      ...(r.scope.length ? r.scope.slice(1) : []),
      ...(r.scope.length ? [SETPRIV] : []),
      `--reuid=${r.uid}`, `--regid=${r.gid}`, "--init-groups", "--no-new-privs",
      "env", "-i", ...envPairs,
      "bash", "-c", inner,
    ],
  };
}
