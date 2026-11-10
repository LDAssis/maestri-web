// Permissões das pastas de conta (Fase 3). Os CLIs (claude, codex, gemini/agy) gravam o login com chmod 0600 EXPLÍCITO (ignora umask)
// e o dono vira o uid do projeto que logou/renovou: os outros projetos do grupo da conta deixam de ler e o CLI pede login de novo.
// O servidor (root) normaliza tudo dentro de <accountsDir>/<programa>/<nome>: arquivos regulares g+rw (sem o+), diretórios g+rwxs e
// grupo = o da conta. Nunca segue symlink (lstat + open O_NOFOLLOW + fchmod/fchown no descritor), ignora o que não é arquivo/diretório
// regular, o que tem mais de um hard link e qualquer coisa fora da pasta da conta.
import fs from "node:fs";
import path from "node:path";

const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const O_DIRECTORY = fs.constants.O_DIRECTORY ?? 0;
const isRoot = () => process.platform !== "win32" && process.getuid?.() === 0;

export interface AccountPermOptions {
  gid?: number; // grupo da conta (padrão: o grupo da própria pasta da conta)
}

// Ajusta UM caminho (arquivo ou diretório) que está dentro de accountDir. Devolve true se mudou algo.
export function normalizeAccountPath(accountDir: string, target: string, opts: AccountPermOptions = {}): boolean {
  const rel = path.relative(accountDir, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return false; // fora da conta
  let st: fs.Stats;
  try {
    st = fs.lstatSync(target);
  } catch {
    return false;
  }
  if (st.isSymbolicLink()) return false; // nunca segue
  const isDir = st.isDirectory();
  if (!isDir && !st.isFile()) return false;
  if (!isDir && st.nlink > 1) return false; // hard link para fora da conta: não mexe no inode
  let fd: number;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | NOFOLLOW | (isDir ? O_DIRECTORY : 0));
  } catch {
    return false; // virou symlink/sumiu entre o lstat e o open
  }
  try {
    const f = fs.fstatSync(fd);
    if (f.ino !== st.ino || f.dev !== st.dev) return false; // trocado no meio
    let changed = false;
    const want = isDir ? ((f.mode | 0o2070) & ~0o007) & 0o7777 : ((f.mode | 0o060) & ~0o007) & 0o7777;
    if ((f.mode & 0o7777) !== want) {
      fs.fchmodSync(fd, want);
      changed = true;
    }
    const gid = opts.gid ?? (rel ? undefined : f.gid);
    if (gid !== undefined && f.gid !== gid && isRoot()) {
      fs.fchownSync(fd, f.uid, gid);
      changed = true;
    }
    return changed;
  } catch {
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

// Percorre a árvore da conta (sem descer em symlinks). Devolve quantos itens mudaram.
export function normalizeAccountTree(accountDir: string, opts: AccountPermOptions = {}): number {
  let gid = opts.gid;
  if (gid === undefined) {
    try {
      gid = fs.lstatSync(accountDir).gid;
    } catch {
      return 0;
    }
  }
  let changed = 0;
  const walk = (dir: string) => {
    if (normalizeAccountPath(accountDir, dir, { gid })) changed++;
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && normalizeAccountPath(accountDir, p, { gid })) changed++;
    }
  };
  walk(accountDir);
  return changed;
}

// Contas existentes: <accountsDir>/<programa>/<nome>
export function accountDirs(accountsDir: string): string[] {
  const out: string[] = [];
  let programs: fs.Dirent[] = [];
  try {
    programs = fs.readdirSync(accountsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const p of programs) {
    if (!p.isDirectory() || p.name.startsWith(".")) continue;
    try {
      for (const a of fs.readdirSync(path.join(accountsDir, p.name), { withFileTypes: true })) if (a.isDirectory()) out.push(path.join(accountsDir, p.name, a.name));
    } catch {}
  }
  return out;
}

// inotify por DIRETÓRIO (fs.watch não recursivo). O fs.watch recursivo do Node no Linux observa arquivos um a um e perde o rastro
// quando o arquivo é substituído por tmp+rename (exatamente como o claude renova o token), por isso cada diretório tem o seu watcher.
export class AccountPermWatcher {
  private watchers = new Map<string, fs.FSWatcher>();
  private timer?: NodeJS.Timeout;
  private pending = new Set<string>();
  private debounce?: NodeJS.Timeout;
  private debounceMs: number;
  private scanMs: number;
  private running = false;

  constructor(private accountsDir: string, opts: { debounceMs?: number; scanMs?: number } = {}) {
    this.debounceMs = opts.debounceMs ?? 100;
    this.scanMs = opts.scanMs ?? 30_000;
  }

  // Varredura completa de todas as contas (boot e segurança periódica)
  scanAll() {
    let n = 0;
    for (const d of accountDirs(this.accountsDir)) n += normalizeAccountTree(d);
    return n;
  }

  private accountOf(p: string): string | null {
    const parts = path.relative(this.accountsDir, p).split(path.sep);
    if (parts.length < 2 || parts[0].startsWith(".") || parts[0] === "..") return null;
    return path.join(this.accountsDir, parts[0], parts[1]);
  }

  private isDir(p: string) {
    try {
      return fs.lstatSync(p).isDirectory(); // lstat: symlink de diretório não conta
    } catch {
      return false;
    }
  }

  private watchDir(dir: string) {
    if (this.watchers.has(dir)) return;
    try {
      const w = fs.watch(dir, (_ev, name) => {
        if (!name) return;
        const p = path.join(dir, String(name));
        this.pending.add(p);
        if (this.isDir(p)) this.watchTree(p); // diretório novo: passa a ser observado também
        this.debounce ??= setTimeout(this.flush, this.debounceMs);
        this.debounce.unref?.();
      });
      w.on("error", () => {
        w.close();
        this.watchers.delete(dir); // a varredura periódica reata
      });
      this.watchers.set(dir, w);
    } catch {}
  }

  private watchTree(dir: string) {
    const parts = path.relative(this.accountsDir, dir).split(path.sep);
    if (parts[0]?.startsWith(".") || parts[0] === ".." || !this.isDir(dir)) return; // .holders não é conta
    this.watchDir(dir);
    let ents: fs.Dirent[] = [];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {}
    for (const e of ents) if (e.isDirectory()) this.watchTree(path.join(dir, e.name));
  }

  // Reata watchers (diretórios novos/perdidos) e solta os de diretórios que sumiram
  private syncWatchers() {
    for (const [d, w] of this.watchers) {
      if (!this.isDir(d)) {
        w.close();
        this.watchers.delete(d);
      }
    }
    this.watchTree(this.accountsDir);
  }

  private flush = () => {
    this.debounce = undefined;
    const paths = [...this.pending];
    this.pending.clear();
    for (const p of paths) {
      const acc = this.accountOf(p);
      if (!acc) continue;
      let gid: number;
      try {
        gid = fs.lstatSync(acc).gid;
      } catch {
        continue;
      }
      if (this.isDir(p)) normalizeAccountTree(p, { gid });
      else normalizeAccountPath(acc, p, { gid });
      if (p !== acc) normalizeAccountPath(acc, path.dirname(p), { gid }); // diretório pai (g+rwxs)
    }
  };

  start() {
    if (this.running) return;
    this.running = true;
    fs.mkdirSync(this.accountsDir, { recursive: true });
    this.scanAll();
    this.syncWatchers();
    this.timer = setInterval(() => {
      this.syncWatchers();
      this.scanAll();
    }, this.scanMs);
    this.timer.unref();
  }

  stop() {
    this.running = false;
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    clearInterval(this.timer);
    this.timer = undefined;
    clearTimeout(this.debounce);
    this.debounce = undefined;
  }
}
