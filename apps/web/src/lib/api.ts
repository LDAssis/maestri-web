const TOKEN_KEY = "maestri.token";

export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ||
  (typeof location !== "undefined" ? `${location.protocol}//${location.hostname}:4000` : "");
export const WS_URL = API_URL.replace(/^http/, "ws");

export const getToken = () => {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
};

export const setToken = (token: string) => {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {}
};

export function apiFetch(path: string, init: RequestInit = {}) {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(`${API_URL}${path}`, { ...init, headers }).then((res) => {
    // Sessão expirada/revogada: volta ao login (não vale para as rotas públicas de entrada)
    if (res.status === 401 && token && !/^\/api\/(auth\/(login|setup|state)|invites)/.test(path)) {
      setToken("");
      try {
        localStorage.removeItem("maestri.user");
      } catch {}
      if (typeof location !== "undefined") location.reload();
    }
    // 404 em /api/projects/:id... pode ser perda de acesso: a página confere a lista e troca de projeto
    if (res.status === 404 && typeof window !== "undefined") {
      const m = /^\/api\/projects\/([^/?]+)/.exec(path);
      if (m) window.dispatchEvent(new CustomEvent("maestri:project-404", { detail: m[1] }));
    }
    return res;
  });
}

export function wsUrl(path: string, params: Record<string, string> = {}) {
  const token = getToken();
  const query = new URLSearchParams(token ? { ...params, token } : params);
  return `${WS_URL}${path}?${query}`;
}
