// Montagem de um agente novo, compartilhada pelo `maestri recruit` (teamApi.ts) e pela rota da UI (roles.ts):
// entrega do prompt do role e aparência (cor/ícone) vinda do preset.
import fs from "node:fs";
import path from "node:path";
import { withRolePrompt } from "./agents.js";
import { ROLE_CANVAS_HINT } from "./agentContext.js";

type Obj = Record<string, any>;

// Cada CLI lê o seu arquivo de contexto: CLAUDE.md (claude) e AGENTS.md (codex, opencode, agy). Escrevemos os dois.
export function writeRoleContext(dir: string, prompt: string, projectRoot: string) {
  fs.mkdirSync(dir, { recursive: true });
  const body = `<your_assigned_role>\n${prompt}\n</your_assigned_role>\n\n${ROLE_CANVAS_HINT}\n<working_directory>\nYou were started in this directory only to receive the role above. The actual project you work on is located at:\n${projectRoot}\n</working_directory>\n`;
  for (const f of ["CLAUDE.md", "AGENTS.md"]) fs.writeFileSync(path.join(dir, f), body);
}

// Entrega o prompt ao agente. Padrão: arquivos de contexto em .maestri/roles/<id>/ (ou .maestri-roles/<nó>/ para papel
// livre) e o terminal começa NESSA pasta. Com --dir/--floor o terminal começa em outro lugar (explicit): claude e codex
// recebem o prompt como argumento (arquivo + $(cat)); os demais CLIs ficam sem o prompt.
export function deliverRole(repo: string, nodeId: string, baseCmd: string, prompt: string | null, roleId: string | null, explicit: boolean) {
  if (!prompt) return { defaultCmd: baseCmd, worktreePath: null as string | null, roleDir: false };
  const wrapped = withRolePrompt(repo, nodeId, baseCmd, prompt); // também grava .maestri-roles/<nó>.md (o prompt vigente)
  if (explicit) return { defaultCmd: wrapped, worktreePath: null, roleDir: false };
  const dir = roleId ? path.join(repo, ".maestri", "roles", roleId.toLowerCase()) : path.join(repo, ".maestri-roles", nodeId);
  writeRoleContext(dir, prompt, fs.realpathSync(repo));
  return { defaultCmd: baseCmd, worktreePath: path.relative(fs.realpathSync(repo), fs.realpathSync(dir)), roleDir: true };
}

// Muda (ou desfaz) o cwd de role-dir do nó conforme a entrega
export const roleCwdPatch = (node: Obj, d: { worktreePath: string | null; roleDir: boolean }): Obj =>
  d.roleDir ? { worktreePath: d.worktreePath, roleDir: true } : node.data?.roleDir ? { worktreePath: null, roleDir: false } : {};

// Paleta do `arrange` (a única que o nó desenha) e cores antigas/padrão da UI mapeadas para ela
export const ARRANGE_PALETTE = ["amber", "indigo", "emerald", "rose", "sky", "violet", "orange", "slate"] as const;
const LEGACY_COLORS: Record<string, string> = {
  purple: "violet", violet: "violet", fuchsia: "violet", pink: "rose", red: "rose", rose: "rose",
  blue: "sky", cyan: "sky", sky: "sky", teal: "emerald", green: "emerald", lime: "emerald", emerald: "emerald",
  yellow: "amber", amber: "amber", orange: "orange", gray: "slate", grey: "slate", zinc: "slate", slate: "slate", indigo: "indigo",
};
// Nome de cor (da paleta ou antigo) -> cor da paleta do arrange; undefined se não houver equivalente
export const arrangeColor = (c: unknown): string | undefined => (typeof c === "string" ? LEGACY_COLORS[c.trim().toLowerCase()] : undefined);
