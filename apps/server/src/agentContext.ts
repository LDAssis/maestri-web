// Contexto dos agentes: para um `claude`/`codex`/`opencode`/`agy` aberto num terminal do canvas saber que está no
// Maestri Web e que tem o CLI `maestri`, instalamos a documentação (SKILL.md do repositório) onde cada CLI procura
// instruções globais, como o Maestri nativo faz com as suas skills:
//   claude   ${CLAUDE_CONFIG_DIR:-~/.claude}/skills/maestri-web/SKILL.md
//   agy      ~/.gemini/config/skills/maestri-web/SKILL.md
//   codex    ${CODEX_HOME:-~/.codex}/skills/maestri-web/SKILL.md + bloco no AGENTS.md global
//   opencode ${XDG_CONFIG_HOME:-~/.config}/opencode/AGENTS.md (bloco)
// Os blocos em AGENTS.md ficam entre marcadores e o resto do arquivo do usuário é preservado. Só escreve para CLIs
// presentes (no PATH ou com a pasta de configuração já criada) e só quando o conteúdo muda.
// Desligue com MAESTRI_AGENT_CONTEXT=0 (nos testes fica desligado, salvo MAESTRI_AGENT_CONTEXT=1).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RunAs } from "./isolation.js";
import { fsOps } from "./runAs.js";
import type { FsOp } from "./fsOps.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const SKILL_NAME = "maestri-web";
const START = "<!-- maestri-web:start (gerenciado pelo Maestri Web; não edite este bloco) -->";
const END = "<!-- maestri-web:end -->";

// Só dispara no Maestri Web: o Maestri nativo tem skills próprias para as mesmas situações e se distingue pelo ambiente
// (o Web define MAESTRI_NODE_ID; o nativo define MAESTRI_TERMINAL_ID e não MAESTRI_NODE_ID)
const DESCRIPTION =
  "Use SOMENTE quando a variável de ambiente MAESTRI_NODE_ID estiver definida (você roda num terminal do canvas do Maestri Web): " +
  "para falar com outro agente, responder mensagens 'through Maestri Chat', ler/escrever notas, usar um portal (navegador), " +
  "andares, rotinas, bandas ou recrutar agentes com o CLI `maestri` (list, ask, send, check, say, note, portal, floor, routine, recruit, band...). " +
  "NÃO use se MAESTRI_NODE_ID não existir, nem se só MAESTRI_TERMINAL_ID estiver definida (isso é o Maestri nativo, que tem outras skills).";

const WEB_ONLY_GUARD =
  "> **Só vale no Maestri Web.** Confira `MAESTRI_NODE_ID` no ambiente: se não estiver definida, ou se só existir `MAESTRI_TERMINAL_ID` (Maestri nativo), ignore esta skill e use as do Maestri nativo.";

let cachedSkill: string | null = null;
// SKILL.md do repositório com o frontmatter da skill instalada (nome estável e descrição que dispara sozinha)
export function skillContent() {
  if (cachedSkill) return cachedSkill;
  const src = fs.readFileSync(path.join(repoRoot, "SKILL.md"), "utf-8");
  const body = src.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  cachedSkill = `---\nname: ${SKILL_NAME}\ndescription: ${DESCRIPTION}\n---\n${WEB_ONLY_GUARD}\n${body}`;
  return cachedSkill;
}

// Bloco curto para AGENTS.md: aponta para a documentação completa
export function agentsBlock(skillPath: string) {
  return [
    START,
    "## Maestri Web (canvas de agentes)",
    "Só vale se a variável de ambiente `MAESTRI_NODE_ID` estiver definida; se ela não existir, ou se só `MAESTRI_TERMINAL_ID` existir (Maestri nativo), ignore este bloco.",
    "Com `MAESTRI_NODE_ID` definida, você roda num terminal do canvas do Maestri Web, ligado a",
    "outros agentes, notas e portais. Use o comando `maestri` (está no PATH; senão, `$MAESTRI_CLI`):",
    "- `maestri list`: quem é você e o que está conectado (rode antes de tudo); `maestri help`: todos os comandos.",
    '- `maestri ask "Agente" "pergunta"` / `send` / `check`: conversar com outros agentes; `maestri note read|write|edit "Nota"`.',
    '- Mensagens "through Maestri Chat": responda SOMENTE com `maestri say "..."` (a saída do terminal não chega ao usuário).',
    '- Ao terminar uma tarefa delegada, devolva o resultado com `maestri send "Quem pediu" "resumo"` (sem `--raw`, sem colar no terminal dele; `ask` só se precisar da resposta).',
    `Documentação completa: ${skillPath}`,
    END,
  ].join("\n");
}

// Substitui (ou acrescenta) o bloco gerenciado preservando o resto do arquivo
export function upsertBlock(existing: string, block: string) {
  const re = new RegExp(`${escapeRe(START)}[\\s\\S]*?${escapeRe(END)}`);
  if (re.test(existing)) return existing.replace(re, block);
  return existing.trim() ? `${existing.replace(/\s*$/, "")}\n\n${block}\n` : `${block}\n`;
}
const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// arquivo -> conteúdo garantido neste processo e o mtime do arquivo naquele momento (editado por fora = confere de novo)
const written = new Map<string, { content: string; mtimeMs: number }>();
const mtimeOf = (file: string) => {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return -1;
  }
};

// Escritas no HOME/pasta de conta do projeto: em projeto isolado rodam COMO o usuário do projeto (fsOps.mjs sob setpriv), então um
// symlink plantado pelo agente (~/.codex -> /algo-de-root) nunca leva o servidor (root) a escrever, ler ou dar chown fora do que o
// próprio agente alcança. Sem isolamento, as mesmas operações rodam no processo (O_NOFOLLOW, tmp aleatório).
type Job = { op: FsOp };
function onPath(bin: string, PATH: string) {
  return PATH.split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, bin)));
}

export function contextEnabled(env: NodeJS.ProcessEnv) {
  if (env.MAESTRI_AGENT_CONTEXT === "0") return false;
  if (env.NODE_ENV === "test") return env.MAESTRI_AGENT_CONTEXT === "1";
  return true;
}

// Garante as instruções para o ambiente do terminal que vai nascer (HOME, contas por CLI_CONFIG_DIR/CODEX_HOME)
export function ensureAgentContext(env: NodeJS.ProcessEnv, runAs: RunAs | null = null) {
  if (!contextEnabled(env)) return;
  const home = env.HOME || os.homedir();
  const PATH = env.PATH || "";
  const skill = skillContent();
  const has = (bin: string, dir: string) => onPath(bin, PATH) || fs.existsSync(dir);
  const ops: FsOp[] = [];
  const put = (file: string, content: string) => ops.push({ op: "write", path: file, data: content, ifChanged: true });
  const block = (file: string, b: string) => ops.push({ op: "upsert", path: file, block: b, start: START, end: END });

  const claudeDir = env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
  if (has("claude", claudeDir)) put(path.join(claudeDir, "skills", SKILL_NAME, "SKILL.md"), skill);

  let geminiDir = path.join(home, ".gemini");
  try {
    geminiDir = fs.realpathSync(geminiDir); // conta gemini: o link aponta para a pasta compartilhada da conta
  } catch {}
  if (has("agy", geminiDir)) put(path.join(geminiDir, "config", "skills", SKILL_NAME, "SKILL.md"), skill);

  const codexDir = env.CODEX_HOME || path.join(home, ".codex");
  if (has("codex", codexDir)) {
    const skillFile = path.join(codexDir, "skills", SKILL_NAME, "SKILL.md");
    put(skillFile, skill);
    block(path.join(codexDir, "AGENTS.md"), agentsBlock(skillFile));
  }

  const opencodeDir = path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "opencode");
  if (has("opencode", opencodeDir)) {
    const skillFile = path.join(opencodeDir, "maestri-web.md");
    put(skillFile, skill);
    block(path.join(opencodeDir, "AGENTS.md"), agentsBlock(skillFile));
  }
  if (!ops.length) return;
  try {
    const res = fsOps(ops, runAs);
    res.forEach((r, i) => {
      if (r && typeof r === "object" && "error" in r) console.warn(`Contexto do agente: não foi possível escrever ${(ops[i] as any).path}: ${r.error}`);
    });
  } catch (e: any) {
    console.warn(`Contexto do agente: falha ao escrever: ${e?.message || e}`);
  }
}

// Linha para os arquivos de role (CLAUDE.md/AGENTS.md da pasta do role): o agente sabe onde está desde o início
export const ROLE_CANVAS_HINT =
  "<maestri_canvas>\nYou run inside a Maestri Web canvas terminal. The `maestri` CLI is on PATH (or use \"$MAESTRI_CLI\"): run `maestri list` to see who you are and who is connected to you, and `maestri help` for every command (ask/send/check other agents, notes, portals, floors, routines). Messages that arrive \"through Maestri Chat\" must be answered only with `maestri say`.\n</maestri_canvas>\n";
