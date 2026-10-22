// Comandos `floor` (andares do canvas) e `workspace` (projetos na barra lateral).
// Carregado automaticamente por bin/maestri.

const FLOOR_HELP = `maestri floor list
maestri floor create "Nome" [--branch NOME] [--existing-branch] [--copy] [--no-git] [--copy-ground]   (Maestro)
maestri floor create ["Nome"] --pull-request NUMERO|URL [--copy] [--copy-ground]                (Maestro; usa o gh)
maestri floor land "Nome" [--into BRANCH] [--delete-branch] [--keep-floor]                     (Maestro, só do térreo)
maestri floor delete "Nome" [--keep-branch] [--force]                                          (Maestro, só do térreo)
maestri floor status ["Texto"] [--state working|blocked|review|done] [--progress 2/5|40%|0.4] [--floor "Nome"] [--clear]
maestri floor unload "Nome"                                                                    (Maestro)
Andares são níveis do canvas ("Ground" = térreo). Com git, o andar é uma worktree na própria branch em
<repo>/.worktrees/<slug>; --no-git compartilha o diretório do térreo. land recusa se houver trabalho não commitado ou
conflito e remove o andar (mantendo a branch) salvo --keep-floor.
--copy cria um clone completo e isolado (pode ficar na mesma branch do térreo); land de um clone traz o trabalho de volta
(fetch + fast-forward/merge) e delete remove o clone (--keep-branch guarda os commits numa branch do repositório).
--pull-request abre um andar na branch do PR (fork: branch pr-N, commits não chegam ao PR). status é de qualquer agente para o próprio andar
(só o Maestro usa --floor); blocked/review/done avisam os navegadores; texto cortado em 120 caracteres.`;

const WORKSPACE_HELP = `maestri workspace list
maestri workspace create "Nome" --dir PATH [--from "Origem"] [--group G] [--folder F] [--root]
maestri workspace rename "Antigo" "Novo"
maestri workspace move "Nome" --group G | --folder F | --root
Só o Maestro. Workspace = projeto. O diretório de create precisa existir; --from copia o layout do canvas com ids novos,
reescrevendo caminhos sob o diretório de origem (sem sessões). Não há delete pela CLI.`;

const bar = (p) => (p == null ? "" : ` [${"█".repeat(Math.round(p * 10))}${"░".repeat(10 - Math.round(p * 10))}] ${Math.round(p * 100)}%`);
const statusLine = (s) => (s ? ` — ${s.state}${bar(s.progress)}${s.text ? `: ${s.text}` : ""}` : "");

export function register({ call, need, CliError }) {
  async function floor({ pos, flags }) {
    const [sub, name] = pos;
    if (sub === "list") {
      const r = await call("GET", "/floors");
      for (const f of r.floors) {
        const where = f.ground ? "térreo" : f.copy ? "clone" : f.git ? "git" : "sem git";
        console.log(`${f.name}${f.name === r.you ? " ← você" : ""} (${where}${f.branch ? `, branch ${f.branch}` : ""}) — ${f.nodes} nó(s) — ${f.path}${f.pullRequest ? ` — PR #${f.pullRequest.number} ${f.pullRequest.url}` : ""}${statusLine(f.status)}`);
      }
    } else if (sub === "create") {
      if (flags["pull-request"] === undefined) need(pos, 2, 'floor create "Nome" [--branch NOME] [--existing-branch] [--copy] [--no-git] [--copy-ground]');
      const r = await call("POST", "/floors", {
        name, branch: flags.branch, existingBranch: flags["existing-branch"], noGit: flags["no-git"], copyGround: flags["copy-ground"],
        copy: flags.copy, pullRequest: flags["pull-request"],
      });
      const f = r.floor;
      console.log(`Andar "${f.name}" criado${f.git ? ` ${f.copy ? "(clone isolado) " : ""}na branch ${f.branch} (${f.path})` : ""}; ${f.nodes} nó(s).${r.note ? ` ${r.note}` : ""}`);
    } else if (sub === "land") {
      need(pos, 2, 'floor land "Nome" [--into BRANCH] [--delete-branch] [--keep-floor]');
      const r = await call("POST", "/floors/land", { name, into: flags.into, deleteBranch: flags["delete-branch"], keepFloor: flags["keep-floor"] });
      console.log(`Land de "${name}" concluído${r.into ? `: ${r.branch ?? "branch"} mesclada em ${r.into}` : ""}.${r.floorKept ? " Andar mantido." : " Andar removido"}${r.branch ? `; branch ${r.branch} mantida.` : r.floorKept ? "" : "."}`);
    } else if (sub === "delete") {
      need(pos, 2, 'floor delete "Nome" [--keep-branch] [--force]');
      const r = await call("POST", "/floors/delete", { name, keepBranch: flags["keep-branch"], force: flags.force });
      console.log(`Andar "${name}" removido${r.branch ? `; branch ${r.branch} mantida` : ""}.`);
    } else if (sub === "unload") {
      need(pos, 2, 'floor unload "Nome"');
      const r = await call("POST", "/floors/unload", { name });
      console.log(`Andar "${r.floor}" descarregado (${r.terminals} terminal(is) encerrado(s)).`);
    } else if (sub === "status") {
      const text = pos.slice(1).join(" ");
      const post = text || flags.state !== undefined || flags.progress !== undefined || flags.clear;
      if (!post) {
        const q = flags.floor ? `?floor=${encodeURIComponent(flags.floor)}` : "";
        const r = await call("GET", `/floors/status${q}`);
        return console.log(r.status ? `${r.floor}${statusLine(r.status)}` : `${r.floor}: sem status.`);
      }
      const r = await call("POST", "/floors/status", {
        text: text || undefined, state: flags.state, progress: flags.progress, floor: flags.floor, clear: flags.clear,
      });
      console.log(r.status ? `Status de "${r.floor}":${statusLine(r.status)}` : `Status de "${r.floor}" removido.`);
    } else throw new CliError('Uso: maestri floor list|create|land|delete|status|unload ... (veja "maestri floor --help")');
  }

  async function workspace({ pos, flags }) {
    const [sub, name, extra] = pos;
    if (sub === "list") {
      const t = await call("GET", "/workspaces");
      const row = (w, ind) => `${ind}- ${w.name}${w.current ? " ← atual" : ""} — ${w.dir} — ${w.floors} andar(es)`;
      const folder = (f, ind) => [`${ind}📁 ${f.name}`, ...(f.workspaces.length ? f.workspaces.map((w) => row(w, ind + "  ")) : [`${ind}  (vazia)`])];
      const out = [];
      if (t.pinned.length) out.push("Fixados:", ...t.pinned.map((w) => row(w, "  ")), "");
      out.push("Raiz:", ...t.root.workspaces.map((w) => row(w, "  ")), ...t.root.folders.flatMap((f) => folder(f, "  ")));
      for (const g of t.groups) {
        out.push("", `Grupo "${g.name}":`, ...g.workspaces.map((w) => row(w, "  ")), ...g.folders.flatMap((f) => folder(f, "  ")));
        if (!g.workspaces.length && !g.folders.length) out.push("  (vazio)");
      }
      console.log(out.join("\n"));
    } else if (sub === "create") {
      need(pos, 2, 'workspace create "Nome" --dir PATH [--from "Origem"] [--group G] [--folder F] [--root]');
      if (!flags.dir) throw new CliError("Informe --dir PATH (o diretório precisa existir).");
      const r = await call("POST", "/workspaces", { name, dir: flags.dir, from: flags.from, group: flags.group, folder: flags.folder, root: flags.root });
      console.log(`Workspace "${r.name}" criado em ${r.dir}${r.from ? ` (layout clonado de "${r.from}")` : ""}${r.group ? `, grupo "${r.group}"` : ""}${r.folder ? `, pasta "${r.folder}"` : ""}.`);
    } else if (sub === "rename") {
      need(pos, 3, 'workspace rename "Antigo" "Novo"');
      const r = await call("POST", "/workspaces/rename", { name, to: extra });
      console.log(`Workspace renomeado para "${r.name}".`);
    } else if (sub === "move") {
      need(pos, 2, 'workspace move "Nome" --group G | --folder F | --root');
      const r = await call("POST", "/workspaces/move", { name, group: flags.group, folder: flags.folder, root: flags.root });
      console.log(`Workspace "${name}" movido para ${r.group ? `o grupo "${r.group}"` : "a raiz"}${r.folder ? `, pasta "${r.folder}"` : ""}.`);
    } else throw new CliError('Uso: maestri workspace list|create|rename|move ... (veja "maestri workspace --help")');
  }

  return {
    commands: { floor, workspace },
    help: { floor: FLOOR_HELP, workspace: WORKSPACE_HELP },
    flags: ["--branch", "--into", "--dir", "--from", "--group", "--folder", "--state", "--progress", "--floor", "--pull-request"],
    boolFlags: ["--existing-branch", "--copy", "--no-git", "--copy-ground", "--delete-branch", "--keep-floor", "--keep-branch", "--force", "--clear", "--root"],
    summary: [
      "Andares e workspaces:",
      '  floor list|create|land|delete|status|unload   Andares do canvas (veja "maestri floor --help"); status é de qualquer agente',
      '  workspace list|create|rename|move             (Maestro) Workspaces/projetos na barra lateral (veja "maestri workspace --help")',
    ],
  };
}
