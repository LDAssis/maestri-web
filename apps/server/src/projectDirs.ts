import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type WithRepo = { repoPath: string };

// Raiz das pastas criadas pelo Maestri para projetos novos. Em teste (sem override) vai para um tmp descartável.
let testDir: string | null = null;
export function projectsDir() {
  if (process.env.MAESTRI_PROJECTS_DIR) return path.resolve(process.env.MAESTRI_PROJECTS_DIR);
  if (process.env.NODE_ENV === "test") {
    if (!testDir) {
      const dir = (testDir = path.join(os.tmpdir(), `maestri-projects-test-${process.pid}`));
      process.once("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
    }
    return testDir;
  }
  return path.join(os.homedir(), "maestri-projects");
}

export const realOrResolved = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

export function isInside(parent: string, child: string) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// Igual, ancestral ou descendente (comparando realpaths)
export const overlaps = (a: string, b: string) => {
  const [ra, rb] = [realOrResolved(a), realOrResolved(b)];
  return isInside(ra, rb) || isInside(rb, ra);
};

export const findConflict = <T extends WithRepo>(repoPath: string, others: T[]) => others.find((o) => overlaps(repoPath, o.repoPath));

// Caminho que precisa ficar dentro de `root` (realpath, resolve symlinks); fora disso, devolve o próprio root
export function resolveInside(root: string, candidate: unknown) {
  if (typeof candidate !== "string" || !candidate.trim()) return root;
  try {
    const real = fs.realpathSync(path.resolve(root, candidate.trim()));
    if (isInside(fs.realpathSync(root), real) && fs.statSync(real).isDirectory()) return real;
  } catch {}
  return root;
}

export const slugify = (name: string) =>
  name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "projeto";

function git(cwd: string, args: string[], env: Record<string, string> = {}) {
  return new Promise<string>((resolve, reject) => {
    execFile("git", args, { cwd, env: { ...process.env, ...env }, encoding: "utf8" }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout),
    );
  });
}

// Pasta própria do projeto, já com git (e um commit vazio) para os andares funcionarem
export async function createProjectDir(name: string, id: string) {
  const base = projectsDir();
  fs.mkdirSync(base, { recursive: true });
  const stem = `${slugify(name)}-${id.replace(/^proj-/, "")}`;
  let dir = path.join(base, stem);
  for (let n = 2; fs.existsSync(dir); n++) dir = path.join(base, `${stem}-${n}`);
  fs.mkdirSync(dir);
  const real = fs.realpathSync(dir);
  try {
    await git(real, ["init", "-q", "-b", "main"]).catch(() => git(real, ["init", "-q"]));
    const has = async (k: string) => (await git(real, ["config", k]).catch(() => "")).trim() !== "";
    const env: Record<string, string> = (await has("user.name")) && (await has("user.email"))
      ? {}
      : { GIT_AUTHOR_NAME: "Maestri", GIT_AUTHOR_EMAIL: "maestri@localhost", GIT_COMMITTER_NAME: "Maestri", GIT_COMMITTER_EMAIL: "maestri@localhost" };
    await git(real, ["commit", "-q", "--allow-empty", "-m", "maestri: init"], env);
  } catch (e: any) {
    console.warn(`Aviso: git init falhou em ${real}: ${e.message} (andares não funcionarão neste projeto)`);
  }
  return real;
}

// Na ordem: o primeiro mantém o repoPath; quem conflita com um já aceito ganha pasta própria
export async function migrateProjects<T extends WithRepo & { id: string; name: string }>(projects: T[], log: (msg: string) => void = console.log) {
  const accepted: T[] = [];
  let changed = false;
  for (const p of projects) {
    const other = findConflict(p.repoPath, accepted);
    if (!other) {
      accepted.push(p);
      continue;
    }
    const repoPath = await createProjectDir(p.name, p.id);
    log(`Migração: projeto "${p.name}" (${p.id}) dividia ${p.repoPath} com "${other.name}"; agora usa ${repoPath}`);
    accepted.push({ ...p, repoPath });
    changed = true;
  }
  return { projects: accepted, changed };
}
