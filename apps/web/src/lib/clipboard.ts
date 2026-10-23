// Área de transferência que funciona também fora de contexto seguro (acesso por http://<ip> da rede),
// onde o navegador não expõe navigator.clipboard.

// Copia texto; devolve se deu certo. Sem a API assíncrona, usa um textarea temporário + execCommand("copy"),
// que os navegadores ainda aceitam dentro de um gesto do usuário (clique/tecla).
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  const prev = document.activeElement as HTMLElement | null;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {}
  ta.remove();
  prev?.focus?.();
  return ok;
}

// Lê o texto da área de transferência; null quando o navegador não permite (sem HTTPS ou permissão negada).
// Nesse caso, quem chama oferece um campo onde o usuário cola com Ctrl+V (o evento de colar sempre funciona).
export async function readText(): Promise<string | null> {
  try {
    if (window.isSecureContext && navigator.clipboard?.readText) return await navigator.clipboard.readText();
  } catch {}
  return null;
}
