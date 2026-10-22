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
  return fetch(`${API_URL}${path}`, { ...init, headers });
}

export function wsUrl(path: string, params: Record<string, string> = {}) {
  const token = getToken();
  const query = new URLSearchParams(token ? { ...params, token } : params);
  return `${WS_URL}${path}?${query}`;
}
