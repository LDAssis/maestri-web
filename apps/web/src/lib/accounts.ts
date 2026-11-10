// Programas de conta de assinatura. "gemini" é uma conta só para o Gemini CLI e o Antigravity (agy), que dividem ~/.gemini.
export type AccountProgram = "claude" | "codex" | "gemini";

export const ACCOUNT_PROGRAMS: AccountProgram[] = ["claude", "codex", "gemini"];

export const ACCOUNT_PROGRAM_LABEL: Record<AccountProgram, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini / Antigravity",
};

export const accountProgramLabel = (p: string) => ACCOUNT_PROGRAM_LABEL[p as AccountProgram] ?? p;

// Programa de conta usado por um CLI (agy e gemini compartilham a conta "gemini")
export const accountProgramOf = (cliId: string) => (cliId === "agy" ? "gemini" : cliId);
