import type { FastifyRequest } from "fastify";

// Caminho de uma requisição para decisões de segurança.
// O roteador do Fastify decodifica %XX antes de casar a rota (/%61pi/projects casa /api/projects), então NUNCA decida
// autenticação/ACL pelo req.url bruto: use a rota que de fato casou (route) e o caminho decodificado (path).
export interface ReqPath {
  path: string; // req.url sem query, decodificado (decodeURIComponent)
  route: string; // padrão da rota casada (ex.: /api/projects/:id/canvas); "" quando nenhuma rota casou (404)
}

// null = codificação inválida (%zz, UTF-8 quebrado): a requisição deve ser recusada
export function reqPath(req: FastifyRequest): ReqPath | null {
  const raw = req.url.split("?")[0];
  let path: string;
  try {
    path = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const route = (req as any).routeOptions?.url ?? "";
  return { path, route: typeof route === "string" ? route : "" };
}

// Rotas que dispensam autenticação (método + padrão da rota). HEAD vale como GET.
const PUBLIC_ROUTES = new Set([
  "GET /api/health",
  "GET /api/auth/state",
  "POST /api/auth/setup",
  "POST /api/auth/login",
  "GET /api/invites/:token",
  "POST /api/invites/:token/accept",
  "GET /api/downloads/:token", // o token de uso único é a credencial
]);

export function isPublicRoute(method: string, route: string) {
  const m = method === "HEAD" ? "GET" : method;
  return PUBLIC_ROUTES.has(`${m} ${route}`);
}

// Exige autenticação? Default-deny: toda rota casada exige, menos as públicas e os WebSockets (que autenticam no handler).
// Sem rota casada (404), exige quando o caminho decodificado está em /api/ (responde 401 em vez de revelar 404).
export function needsAuth(method: string, p: ReqPath) {
  if (p.route) return !p.route.startsWith("/ws/") && !isPublicRoute(method, p.route);
  return p.path.startsWith("/api/");
}
