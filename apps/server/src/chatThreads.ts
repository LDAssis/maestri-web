import path from "node:path";
import type { Session } from "./sessions.js";

// As 7 threads coloridas do chat de cada agente (mesmos nomes do Maestri nativo). Mensagens sem thread = blue.
export const THREADS = ["blue", "purple", "pink", "red", "orange", "yellow", "green"] as const;
export type Thread = (typeof THREADS)[number];
export const DEFAULT_THREAD: Thread = "blue";

export const isThread = (v: unknown): v is Thread => typeof v === "string" && (THREADS as readonly string[]).includes(v);
export const threadOf = (m: { thread?: unknown }): Thread => (isThread(m.thread) ? m.thread : DEFAULT_THREAD);

// Thread "atual" do agente: a da última mensagem do usuário (é para ela que `maestri say` responde)
export function currentThread(chat: { role?: string; thread?: unknown }[]): Thread {
  for (let i = chat.length - 1; i >= 0; i--) if (chat[i].role === "user") return threadOf(chat[i]);
  return DEFAULT_THREAD;
}

// Cabeçalho idêntico ao do Maestri nativo (skill maestri-chat), para o agente reconhecer e responder via `maestri say`.
// Vai em várias linhas mesmo: o envio do chat usa bracketed paste quando há quebra de linha, então TUIs
// (claude, codex, opencode) recebem tudo como UMA colagem e só o \r final submete — achatar numa linha
// quebraria o formato que a skill procura.
export const chatHeader = (thread: Thread) =>
  `---\nBelow is a message from the user through Maestri Chat.\nReply only via \`maestri say\`. If the maestri-chat skill isn't already loaded, load it first.\nthread: ${thread}\n---\n`;

const SHELLS = /^(bash|zsh|sh|dash|ksh|mksh|fish|tcsh|csh|nu|pwsh|powershell|cmd)(\.exe)?$/i;

// Só põe o cabeçalho quando há um programa (o agente) em primeiro plano no PTY: num shell puro as linhas
// do cabeçalho virariam comandos (e o `maestri say` entre crases seria executado).
export function wantsChatHeader(session: Session) {
  try {
    const fg = path.basename(String(session.pty.process || "").trim().split(/\s+/)[0] || "").replace(/^-/, "");
    return !!fg && !SHELLS.test(fg);
  } catch {
    return false;
  }
}
