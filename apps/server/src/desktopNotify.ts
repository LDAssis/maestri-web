// Notificações do sistema operacional (POLISH8): o servidor roda na máquina do usuário, então além do toast no canvas
// ele pode avisar pelo SO — `notify-send` no Linux, `osascript` no macOS (Windows: nada). Sempre via execFile, sem shell,
// e só quando o comando existe. Liga/desliga por MAESTRI_DESKTOP_NOTIFY=0|1 (vence tudo), pela preferência do projeto e,
// na falta dela, pelo padrão: ligado quando o servidor escuta em loopback, desligado fora disso (o servidor pode estar
// em outra máquina, onde a notificação não chegaria à pessoa certa).
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MAX_TITLE = 100;
const MAX_TEXT = 300;

let prefOf: (projectId: string) => boolean | undefined = () => undefined;
let defaultOn: () => boolean = () => true;
export const configureDesktopNotify = (o: { pref?: (projectId: string) => boolean | undefined; defaultOn?: () => boolean }) => {
  if (o.pref) prefOf = o.pref;
  if (o.defaultOn) defaultOn = o.defaultOn;
};

export function desktopNotifyEnabled(projectId: string): boolean {
  const env = process.env.MAESTRI_DESKTOP_NOTIFY;
  if (env === "0") return false;
  if (env === "1") return true;
  return prefOf(projectId) ?? defaultOn();
}

// Procura o executável no PATH atual (lido a cada chamada)
function which(cmd: string): string | null {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, cmd);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch {}
  }
  return null;
}

const clean = (s: string, max: number) => s.replace(/[\x00-\x1f\x7f-\x9f]+/g, " ").trim().slice(0, max);

// AppleScript: texto entre aspas, com \ e " escapados (sem quebras de linha)
export const appleString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
export const osascriptArgs = (title: string, text: string) => ["-e", `display notification ${appleString(text)} with title ${appleString(title)}`];

// Dispara (sem esperar nem falhar); devolve true se mandou executar algum comando
export function desktopNotify(projectId: string, title: string, text: string): boolean {
  if (!desktopNotifyEnabled(projectId)) return false;
  const t = clean(title, MAX_TITLE) || "Maestri";
  const body = clean(text, MAX_TEXT);
  let bin: string | null = null;
  let args: string[] = [];
  if (process.platform === "linux") {
    bin = which("notify-send");
    // "--": título/texto que comecem com "-" não viram opções
    args = ["-a", "Maestri", "--", t, body];
  } else if (process.platform === "darwin") {
    bin = which("osascript");
    args = osascriptArgs(t, body);
  }
  if (!bin) return false;
  try {
    execFile(bin, args, { timeout: 5000 }, () => {}).on("error", () => {});
  } catch {}
  return true;
}
