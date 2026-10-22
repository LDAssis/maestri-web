// Aparência (cor + ícone) de presets de agente novos: cor sorteada e o ícone do CLI quando conhecido, senão um sorteado.
// Mesmos campos `color`/`icon` do cliPresets das configurações (editáveis em CliConfigModal/ProjectSettingsModal);
// teamApi.ts (preset create) deve usar presetLook(cmd) ao criar um preset sem look.
import { COLORS, ICONS } from "./notesApi.js";

// Ícone por CLI conhecido (primeira palavra do comando, sem caminho)
const CLI_ICON: Record<string, (typeof ICONS)[number]> = {
  claude: "sparkles", codex: "code", opencode: "terminal", agy: "rocket", gemini: "brain", aider: "pen", cursor: "wrench",
};

export function presetLook(cmd: unknown, rnd: () => number = Math.random): { color: string; icon: string } {
  const prog = String(cmd ?? "").trim().split(/\s+/)[0].split("/").pop() ?? "";
  const pick = <T,>(xs: readonly T[]) => xs[Math.min(xs.length - 1, Math.floor(rnd() * xs.length))];
  return { color: pick(COLORS), icon: CLI_ICON[prog] ?? pick(ICONS) };
}
