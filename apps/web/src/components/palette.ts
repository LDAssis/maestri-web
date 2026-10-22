import {
  Terminal, Bot, Code2, Cpu, Brain, Rocket, ShieldCheck, Bug, FlaskConical, Palette, Database, Globe,
  Search, Wrench, BookOpen, PenTool, Star, Heart, Zap, Flag, Crown, Sparkles, Lightbulb, type LucideIcon,
} from "lucide-react";

// Cores e ícones do `maestri arrange` (mesmas listas do servidor: apps/server/src/notesApi.ts).
// Fica em components/ para o Tailwind enxergar as classes literais.
export const ARRANGE_COLORS = ["amber", "indigo", "emerald", "rose", "sky", "violet", "orange", "slate"] as const;

export const COLOR_HEX: Record<string, string> = {
  amber: "#f59e0b", indigo: "#6366f1", emerald: "#10b981", rose: "#f43f5e",
  sky: "#0ea5e9", violet: "#8b5cf6", orange: "#f97316", slate: "#64748b",
};

export const NOTE_STYLE: Record<string, string> = {
  amber: "bg-amber-950/70 border-amber-600/70 text-amber-100",
  indigo: "bg-indigo-950/80 border-indigo-700/80 text-indigo-100",
  emerald: "bg-emerald-950/80 border-emerald-700/80 text-emerald-100",
  rose: "bg-rose-950/80 border-rose-700/80 text-rose-100",
  sky: "bg-sky-950/80 border-sky-700/80 text-sky-100",
  violet: "bg-violet-950/80 border-violet-700/80 text-violet-100",
  orange: "bg-orange-950/80 border-orange-700/80 text-orange-100",
  slate: "bg-slate-800/80 border-slate-600/80 text-slate-100",
};

export const ICON_MAP: Record<string, LucideIcon> = {
  terminal: Terminal, bot: Bot, code: Code2, cpu: Cpu, brain: Brain, rocket: Rocket, shield: ShieldCheck,
  bug: Bug, flask: FlaskConical, palette: Palette, database: Database, globe: Globe, search: Search,
  wrench: Wrench, book: BookOpen, pen: PenTool, star: Star, heart: Heart, zap: Zap, flag: Flag,
  crown: Crown, sparkles: Sparkles, lightbulb: Lightbulb,
};

// Cor sorteada e ícone do CLI (quando conhecido; senão sorteado) para presets novos — espelha server/src/presetLook.ts
const CLI_ICON: Record<string, string> = { claude: "sparkles", codex: "code", opencode: "terminal", agy: "rocket", gemini: "brain", aider: "pen", cursor: "wrench" };
export function randomPresetLook(cmd: string, rnd: () => number = Math.random) {
  const pick = <T,>(xs: readonly T[]) => xs[Math.min(xs.length - 1, Math.floor(rnd() * xs.length))];
  const prog = cmd.trim().split(/\s+/)[0].split("/").pop() ?? "";
  return { color: pick(ARRANGE_COLORS) as string, icon: CLI_ICON[prog] ?? pick(Object.keys(ICON_MAP)) };
}
