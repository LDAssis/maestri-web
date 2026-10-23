// Notificações do sistema (Notification API do navegador), além dos toasts: toast do `maestri notify`, lembretes de
// rotina e mudanças de status de andar chegam todos como {type:"notify"} no WS do projeto.
export type NotifyPermission = NotificationPermission | "unsupported";

// Fora de contexto seguro (acesso por http://<ip> da rede) o navegador nega a permissão sem perguntar: trata como não suportado
export const notifyPermission = (): NotifyPermission =>
  typeof window !== "undefined" && window.isSecureContext && "Notification" in window ? Notification.permission : "unsupported";

// Pede a permissão uma vez (só a partir de um clique do usuário); devolve o estado resultante
export async function requestNotifyPermission(): Promise<NotifyPermission> {
  if (notifyPermission() !== "default") return notifyPermission();
  try {
    return await Notification.requestPermission();
  } catch {
    return notifyPermission();
  }
}

// `tag` evita duplicar a mesma notificação em vários navegadores/abas
export function systemNotify(title: string, body: string, tag?: string) {
  if (notifyPermission() !== "granted") return;
  try {
    new Notification(title, { body, tag, icon: "/favicon.ico" });
  } catch {}
}
