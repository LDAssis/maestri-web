// Popula a instância de GRAVAÇÃO (nunca a de produção) com dados fictícios para os clipes da Central de Ajuda.
// Uso: node seed.mjs   (variáveis: API, SETUP_KEY; ver README.md)
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
const require = createRequire(process.env.NODE_PATH ? process.env.NODE_PATH + "/" : import.meta.url);
const WebSocket = require("ws");

const API = process.env.API || "http://127.0.0.1:4100";
const SETUP_KEY = process.env.SETUP_KEY || "rec-demo-token-2026";
export const PEOPLE = {
  ana: { name: "Ana Admin", email: "ana@exemplo.com", password: "Maestri#Demo2026!" },
  bruno: { name: "Bruno", email: "bruno@exemplo.com", password: "Maestri#Demo2026!" },
  carla: { name: "Carla Dev", email: "carla@exemplo.com", password: "Maestri#Demo2026!" },
};

const J = { "Content-Type": "application/json" };
async function call(path, { token, method = "GET", body } = {}) {
  const res = await fetch(API + path, { method, headers: { ...J, ...(token && { Authorization: `Bearer ${token}` }) }, body: body && JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(data)}`);
  return data;
}

async function canvasOps(token, projectId, ops) {
  const ws = new WebSocket(`${API.replace(/^http/, "ws")}/ws/project/${projectId}?clientId=seed&token=${token}`);
  await new Promise((r, j) => (ws.on("open", r), ws.on("error", j)));
  for (const op of ops) ws.send(JSON.stringify({ type: "op", op }));
  await new Promise((r) => setTimeout(r, 800));
  ws.close();
}

const note = (id, x, y, title, content, color = "amber") => ({
  id, type: "stickyNote", position: { x, y }, style: { width: 300, height: 220 },
  data: { title, color, author: "Ana Admin", content, pinnedName: true },
});

async function main() {
  const state = await call("/api/auth/state");
  if (!state.setupRequired) throw new Error("A instância de gravação já tem usuários. Reinicie com dados limpos (veja o README).");
  const ana = await call("/api/auth/setup", { method: "POST", body: { setupKey: SETUP_KEY, ...PEOPLE.ana } });
  const t = ana.token;
  for (const p of [PEOPLE.bruno, PEOPLE.carla]) {
    const inv = await call("/api/admin/invites", { token: t, method: "POST", body: { note: `para ${p.name}` } });
    await call(`/api/invites/${inv.token}/accept`, { method: "POST", body: p });
  }
  const users = (await call("/api/admin/users", { token: t })).users;
  const bruno = users.find((u) => u.email === PEOPLE.bruno.email);

  const mk = async (name, description) => (await call("/api/projects", { token: t, method: "POST", body: { name, description } })).project;
  const loja = await mk("Loja Virtual", "Checkout, carrinho e catálogo da loja");
  const delivery = await mk("App Delivery", "Aplicativo de entregas para o time de campo");
  const site = await mk("Site Institucional", "Página da empresa e blog");
  await call(`/api/projects/${loja.id}/members`, { token: t, method: "POST", body: { userId: bruno.id } });

  // Loja Virtual: contrato em nota + dois agentes (o comando "claude" é um script de mentira no PATH da instância)
  await canvasOps(t, loja.id, [
    { kind: "upsertNodes", nodes: [
      note("note-contrato", -380, -40, "Contrato da API", "# Contrato da API\n\n- POST /pedidos cria um pedido\n- GET /pedidos/:id devolve o status\n- Preços sempre com duas casas decimais\n\nPronto quando os testes passarem.", "amber"),
      note("note-tarefas", -380, 220, "Tarefas da semana", "- [x] Catálogo de produtos\n- [ ] Carrinho\n- [ ] Checkout com cupom", "indigo"),
    ] },
  ]);
  const backend = (await call(`/api/projects/${loja.id}/agents`, { token: t, method: "POST", body: { title: "Backend", preset: "claude", position: { x: 60, y: -120 } } })).node;
  const frontend = (await call(`/api/projects/${loja.id}/agents`, { token: t, method: "POST", body: { title: "Frontend", preset: "claude", position: { x: 60, y: 250 } } })).node;
  await canvasOps(t, loja.id, [
    { kind: "upsertEdges", edges: [{ id: `e-${backend.id}-${frontend.id}`, source: backend.id, target: frontend.id, animated: true, style: { stroke: "#818cf8", strokeWidth: 2 } }] },
  ]);

  // App Delivery: uma nota e um agente soltos (o clipe "equipe" liga um ao outro)
  await canvasOps(t, delivery.id, [
    { kind: "upsertNodes", nodes: [note("note-entregas", -340, 20, "Contrato de entregas", "# Entregas\n\n- Tela com lista de entregas do dia\n- Botão Confirmar entrega\n- Funciona offline", "amber")] },
  ]);
  await call(`/api/projects/${delivery.id}/agents`, { token: t, method: "POST", body: { title: "Mobile", preset: "claude", position: { x: 60, y: 0 } } });

  // Repositórios com um commit e alguns arquivos (andares e árvore de arquivos precisam de git de verdade)
  for (const p of [loja, delivery]) {
    const dir = p.repoPath;
    mkdirSync(`${dir}/src`, { recursive: true });
    writeFileSync(`${dir}/README.md`, `# ${p.name}\n\nProjeto de demonstração (dados fictícios).\n`);
    writeFileSync(`${dir}/src/preco.ts`, "export const preco = (v: number) => v.toFixed(2);\n");
    writeFileSync(`${dir}/src/carrinho.tsx`, "export function Carrinho() {\n  return null;\n}\n");
    writeFileSync(`${dir}/package.json`, '{ "name": "demo", "version": "1.0.0" }\n');
    const sh = (c) => execSync(c, { cwd: dir, stdio: "ignore" });
    sh("git config user.email demo@example.com && git config user.name Demo && git add -A && git commit -qm 'primeiro commit'");
  }

  // Sidebar: grupo + fixar
  await call("/api/sidebar/groups", { token: t, method: "POST", body: { name: "Clientes" } }).catch(() => {});
  await call(`/api/projects/${delivery.id}/sidebar`, { token: t, method: "PATCH", body: { group: "Clientes" } }).catch(() => {});

  console.log(JSON.stringify({ loja: loja.id, delivery: delivery.id, site: site.id, backend: backend.id, frontend: frontend.id, bruno: bruno.id }));
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
