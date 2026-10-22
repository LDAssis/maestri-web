import fs from "node:fs";
import path from "node:path";

type Obj = Record<string, any>;

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const SIZES: Record<string, [number, number]> = { agentTerminal: [460, 330], stickyNote: [280, 200], portal: [480, 330], noteStack: [300, 220], band: [260, 160] };
const MARGIN = 40;

const sizeOf = (n: Obj): [number, number] => {
  const [dw, dh] = SIZES[n.type] ?? [300, 200];
  return [Number(n.style?.width) || dw, Number(n.style?.height) || dh];
};

// Primeira posição livre (sem sobrepor), a mais próxima de "logo abaixo" (ou "à esquerda") do nó de referência
export function freePosition(nodes: Obj[], ref: Obj, size: [number, number], side: "below" | "left" = "below") {
  const [, rh] = sizeOf(ref);
  const rx = ref.position?.x ?? 0;
  const ry = ref.position?.y ?? 0;
  const anchor = side === "left" ? { x: rx - size[0] - MARGIN, y: ry } : { x: rx, y: ry + rh + MARGIN };
  const step = 40;
  const candidates: { x: number; y: number }[] = [];
  for (let gx = -30; gx <= 30; gx++) {
    for (let gy = -30; gy <= 30; gy++) candidates.push({ x: rx + gx * step, y: ry + gy * step });
  }
  const dist = (c: { x: number; y: number }) => Math.hypot(c.x - anchor.x, c.y - anchor.y);
  candidates.sort((a, b) => dist(a) - dist(b));
  const free = (c: { x: number; y: number }) =>
    nodes.every((n) => {
      const [w, h] = sizeOf(n);
      const nx = n.position?.x ?? 0;
      const ny = n.position?.y ?? 0;
      return c.x + size[0] + MARGIN <= nx || nx + w + MARGIN <= c.x || c.y + size[1] + MARGIN <= ny || ny + h + MARGIN <= c.y;
    });
  return candidates.find(free) ?? anchor;
}

// Comando de cada preset (shell = terminal puro)
export const PRESETS: Record<string, string> = { claude: "claude", codex: "codex", opencode: "opencode", agy: "agy", shell: "" };
export const PRESET_LABELS: Record<string, string> = { claude: "Claude", codex: "Codex", opencode: "OpenCode", agy: "Antigravity", shell: "Shell" };

export const validCmd = (v: unknown): v is string => typeof v === "string" && v.length <= 500 && !/[\x00-\x1f]/.test(v);

const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// O texto do papel vai para um arquivo; o shell só lê o arquivo como um único argumento.
// Caminho absoluto: o comando também funciona quando o cwd é um andar (worktree).
export function withRolePrompt(repo: string, nodeId: string, cmd: string, prompt: string) {
  const dir = path.join(repo, ".maestri-roles");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${nodeId}.md`);
  fs.writeFileSync(file, prompt);
  return /^(claude|codex)(\s+[\w.=\/:-]+)*$/.test(cmd) ? `${cmd} "$(cat ${shQuote(file)})"` : cmd;
}
