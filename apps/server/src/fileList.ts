import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface ListedFile {
  path: string;
  status?: string;
  dir?: boolean;
  collapsed?: boolean;
}

// Pastas pesadas: aparecem como uma única entrada recolhida, sem filhos
export const HEAVY_DIRS = new Set(["node_modules", ".git", ".next", ".turbo", ".cache", "dist", "build", "__pycache__", ".venv", ".worktrees"]);

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout),
    );
  });
}

// Percorre `abs` (relativo `rel`) com fs. Não segue symlinks: link vira entrada de arquivo.
// `budget.left` limita o total de entradas para não varrer árvores enormes.
function walk(root: string, rel: string, status: string | undefined, out: ListedFile[], budget: { left: number }, skipGit: boolean) {
  let ents: fs.Dirent[];
  try {
    ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    if (budget.left <= 0) return;
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (skipGit && e.name === ".git") continue;
      if (HEAVY_DIRS.has(e.name)) {
        out.push({ path: `${p}/`, dir: true, status: "I", collapsed: true });
        budget.left--;
      } else walk(root, p, status, out, budget, skipGit);
    } else {
      out.push(status ? { path: p, status } : { path: p });
      budget.left--;
    }
  }
}

// Arquivos e pastas ignorados pelo .gitignore (status "I"), exceto o conteúdo das pastas pesadas
export async function listIgnored(dir: string, max: number): Promise<ListedFile[]> {
  const raw = await git(dir, ["ls-files", "-o", "-i", "--exclude-standard", "--directory", "-z"]);
  const out: ListedFile[] = [];
  const budget = { left: max };
  for (const p of raw.split("\0").filter(Boolean)) {
    if (budget.left <= 0) break;
    if (p.endsWith("/")) {
      const clean = p.slice(0, -1);
      if (clean.split("/").some((s) => s === ".git")) continue;
      if (HEAVY_DIRS.has(clean.split("/").pop()!)) {
        out.push({ path: p, dir: true, status: "I", collapsed: true });
        budget.left--;
      } else walk(dir, clean, "I", out, budget, true);
    } else {
      out.push({ path: p, status: "I" });
      budget.left--;
    }
  }
  return out;
}

// Pasta que não é repositório git: lista tudo por fs (mesmas exclusões das pesadas)
export function listByWalk(dir: string, max: number): ListedFile[] {
  const out: ListedFile[] = [];
  walk(dir, "", undefined, out, { left: max + 1 }, true);
  return out;
}
