// Retomada de sessão (POLISH3): detecta o programa de um comando de terminal e o reescreve em modo "continuar".
import path from "node:path";

export const KNOWN_PROGRAMS = ["claude", "codex", "opencode"] as const;
export type Program = (typeof KNOWN_PROGRAMS)[number];

const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh"]);
const WRAPPERS = new Set(["env", "exec", "command"]);
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// Prompt de role injetado por withRolePrompt: não deve ser reenviado ao retomar a conversa
const ROLE_ARG = /^"\$\(cat '[^']*'\)"$/;

interface Tok {
  raw: string;
  value: string;
  start: number;
  end: number;
}

// Separa por espaços respeitando aspas simples/duplas (e $(...) dentro de aspas duplas)
function tokenize(cmd: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < cmd.length) {
    while (i < cmd.length && /\s/.test(cmd[i])) i++;
    if (i >= cmd.length) break;
    const start = i;
    let value = "";
    let quote: string | null = null;
    while (i < cmd.length && (quote || !/\s/.test(cmd[i]))) {
      const ch = cmd[i];
      if (quote) {
        if (ch === quote) quote = null;
        else if (ch === "\\" && quote === '"' && i + 1 < cmd.length) value += cmd[++i];
        else value += ch;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "\\" && i + 1 < cmd.length) value += cmd[++i];
      else value += ch;
      i++;
    }
    out.push({ raw: cmd.slice(start, i), value, start, end: i });
  }
  return out;
}

const isAssign = (t: Tok) => /^[A-Za-z_]\w*=/.test(t.value);

// Posição do token do programa e o nome dele; entra em `sh -c "..."` / `fish -c "..."`
function locate(cmd: string): { toks: Tok[]; idx: number; program: Program | null; shell?: { inner: Tok } } {
  const toks = tokenize(cmd);
  let idx = 0;
  while (idx < toks.length && (isAssign(toks[idx]) || WRAPPERS.has(path.basename(toks[idx].value)))) idx++;
  const t = toks[idx];
  if (!t) return { toks, idx, program: null };
  const base = path.basename(t.value);
  if (SHELLS.has(base)) {
    const flag = toks.findIndex((x, j) => j > idx && /^-[a-z]*c$/.test(x.value));
    const inner = flag >= 0 ? toks[flag + 1] : undefined;
    return inner ? { toks, idx, program: programOf(inner.value), shell: { inner } } : { toks, idx, program: null };
  }
  return { toks, idx, program: (KNOWN_PROGRAMS as readonly string[]).includes(base) ? (base as Program) : null };
}

// claude/codex/opencode pelo nome do executável (com variáveis na frente, caminho completo ou shell -c)
export function programOf(cmd: string | undefined | null): Program | null {
  return cmd ? locate(cmd).program : null;
}

// claude/codex rodando DIRETAMENTE (não dentro de `sh -c`) e num comando simples, sem metacaracteres de shell: é seguro
// acrescentar um argumento no fim (usado para passar o prompt do role). Caminho absoluto e variáveis na frente valem.
export function directProgramOf(cmd: string | undefined | null): "claude" | "codex" | null {
  if (!cmd || /[;&|<>`\n]|\$\(/.test(cmd)) return null;
  const loc = locate(cmd);
  return !loc.shell && (loc.program === "claude" || loc.program === "codex") ? loc.program : null;
}

const has = (toks: Tok[], flags: string[]) => toks.some((t) => flags.includes(t.value));

// Insere os argumentos de retomada logo depois do programa; nada muda se o comando já retoma/usa subcomando
function resumeDirect(cmd: string, saved?: { program: string; id: string }): string {
  const { toks, idx, program } = locate(cmd);
  if (!program) return cmd;
  const prog = toks[idx];
  const rest = toks.slice(idx + 1);
  const id = saved && saved.program === program ? saved.id : undefined;
  // sem o argumento do prompt de role (a conversa retomada já o tem)
  let end = cmd.length;
  const last = toks[toks.length - 1];
  if (last && last !== prog && ROLE_ARG.test(last.raw)) end = last.start;
  const head = cmd.slice(0, prog.end);
  const tail = cmd.slice(prog.end, end).replace(/\s+$/, "");
  const strippedRest = rest.filter((t) => t.start < end);
  if (program === "claude") {
    if (has(strippedRest, ["--continue", "-c", "--resume", "-r"])) return cmd;
    return `${head}${id ? ` --resume ${id}` : " --continue"}${tail}`;
  }
  if (program === "codex") {
    // já tem subcomando (resume, exec...) ou prompt posicional: não mexe
    if (strippedRest.some((t) => !t.value.startsWith("-") && !isAssign(t))) return cmd;
    return `${head} resume ${id ?? "--last"}${tail}`;
  }
  if (has(strippedRest, ["--continue", "-c", "--session", "-s"])) return cmd;
  return `${head} --continue${tail}`;
}

export function resumeCommand(cmd: string, saved?: { program: string; id: string }): string {
  const loc = locate(cmd);
  if (!loc.program) return cmd;
  if (loc.shell) {
    const { inner } = loc.shell;
    const next = resumeDirect(inner.value, saved);
    if (next === inner.value) return cmd;
    const q = inner.raw[0] === "'" ? "'" : '"';
    if (next.includes(q) || next.includes("\\")) return cmd; // não arrisca reescrever o quoting
    return `${cmd.slice(0, inner.start)}${q}${next}${q}${cmd.slice(inner.end)}`;
  }
  return resumeDirect(cmd, saved);
}

const ANSI = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const RESUME_LINE = [
  { program: "claude", re: new RegExp(`claude\\s+(?:--resume|-r)\\s+(${UUID})`, "gi") },
  { program: "codex", re: new RegExp(`codex\\s+resume\\s+(${UUID})`, "gi") },
];

// Linha de retomada que o agente imprime ao sair ("claude --resume <id>"); devolve a última encontrada
export function captureResume(text: string): { program: string; id: string } | null {
  const clean = text.replace(ANSI, "");
  let found: { program: string; id: string; at: number } | null = null;
  for (const { program, re } of RESUME_LINE) {
    for (const m of clean.matchAll(re)) if (!found || m.index! > found.at) found = { program, id: m[1], at: m.index! };
  }
  return found && { program: found.program, id: found.id };
}
