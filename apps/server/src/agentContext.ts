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

function writeIfChanged(file: string, content: string) {
  const known = written.get(file);
  if (known && known.content === content && known.mtimeMs === mtimeOf(file)) return;
  try {
    if (!fs.existsSync(file) || fs.readFileSync(file, "utf-8") !== content) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
    written.set(file, { content, mtimeMs: mtimeOf(file) });
  } catch (e: any) {
    console.warn(`Contexto do agente: não foi possível escrever ${file}: ${e?.message || e}`);
  }
}

function onPath(bin: string, PATH: string) {
  return PATH.split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, bin)));
}

export function contextEnabled(env: NodeJS.ProcessEnv) {
  if (env.MAESTRI_AGENT_CONTEXT === "0") return false;
  if (env.NODE_ENV === "test") return env.MAESTRI_AGENT_CONTEXT === "1";
  return true;
}

// Garante as instruções para o ambiente do terminal que vai nascer (HOME, contas por CLI_CONFIG_DIR/CODEX_HOME)
export function ensureAgentContext(env: NodeJS.ProcessEnv) {
  if (!contextEnabled(env)) return;
  const home = env.HOME || os.homedir();
  const PATH = env.PATH || "";
  const skill = skillContent();
  const has = (bin: string, dir: string) => onPath(bin, PATH) || fs.existsSync(dir);

  const claudeDir = env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
  if (has("claude", claudeDir)) writeIfChanged(path.join(claudeDir, "skills", SKILL_NAME, "SKILL.md"), skill);

  const geminiDir = path.join(home, ".gemini");
  if (has("agy", geminiDir)) writeIfChanged(path.join(geminiDir, "config", "skills", SKILL_NAME, "SKILL.md"), skill);

  const codexDir = env.CODEX_HOME || path.join(home, ".codex");
  if (has("codex", codexDir)) {
    const skillFile = path.join(codexDir, "skills", SKILL_NAME, "SKILL.md");
    writeIfChanged(skillFile, skill);
    const agents = path.join(codexDir, "AGENTS.md");
    writeIfChanged(agents, upsertBlock(readOr(agents), agentsBlock(skillFile)));
  }

  const opencodeDir = path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "opencode");
  if (has("opencode", opencodeDir)) {
    const skillFile = path.join(opencodeDir, "maestri-web.md");
    writeIfChanged(skillFile, skill);
    const agents = path.join(opencodeDir, "AGENTS.md");
    writeIfChanged(agents, upsertBlock(readOr(agents), agentsBlock(skillFile)));
  }
}

function readOr(file: string) {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return "";
  }
}

// Linha para os arquivos de role (CLAUDE.md/AGENTS.md da pasta do role): o agente sabe onde está desde o início
export const ROLE_CANVAS_HINT =
  "<maestri_canvas>\nYou run inside a Maestri Web canvas terminal. The `maestri` CLI is on PATH (or use \"$MAESTRI_CLI\"): run `maestri list` to see who you are and who is connected to you, and `maestri help` for every command (ask/send/check other agents, notes, portals, floors, routines). Messages that arrive \"through Maestri Chat\" must be answered only with `maestri say`.\n</maestri_canvas>\n";
