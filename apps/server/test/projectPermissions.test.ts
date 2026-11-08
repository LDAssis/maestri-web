import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { rmTmp } from "./rmtmp.js";

// Fase 2: permissões por projeto (dono / membro / admin), guarda central, rotas globais admin-only, WS e presença.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maestri-projperm-test-")));
const repo = path.join(tmp, "principal");
fs.mkdirSync(path.join(repo, ".maestri_data"), { recursive: true });
process.env.REPO_PATH = repo;
process.env.MAESTRI_PROJECTS_DIR = path.join(tmp, "projetos");
process.env.NODE_ENV = "test";
process.env.MAESTRI_TOKEN = "chave-interna-perm";
process.env.MAESTRI_PR_POLL_MS = "3600000";

// projects.json ANTIGO (sem ownerId/members) antes de subir: a migração roda no setup do primeiro admin
const legacyDir = path.join(tmp, "legado");
fs.mkdirSync(legacyDir);
fs.writeFileSync(
  path.join(repo, ".maestri_data", "projects.json"),
  JSON.stringify([
    { id: "proj-legado", name: "Legado", description: "", repoPath: legacyDir, createdAt: "2024-01-01T00:00:00.000Z" },
  ]),
);

const { fastify, authService, crossLinks } = await import("../src/index.js");
const internal = { authorization: "Bearer chave-interna-perm" };
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

let port = 0;
let adminTok = "";
let adminId = "";
const dataFile = (f: string) => path.join(repo, ".maestri_data", f);
const savedProjects = () => JSON.parse(fs.readFileSync(dataFile("projects.json"), "utf8")) as any[];

async function call(method: string, url: string, headers?: Record<string, string>, payload?: unknown) {
  const r = await fastify.inject({ method: method as any, url, headers, payload: payload as any });
  let body: any = null;
  try {
    body = r.json();
  } catch {}
  return { status: r.statusCode, body };
}
const asAdmin = (m: string, u: string, p?: unknown) => call(m, u, bearer(adminTok), p);
const as = (tok: string) => (m: string, u: string, p?: unknown) => call(m, u, bearer(tok), p);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, what: string, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) assert.fail(`timeout: ${what}`);
    await sleep(20);
  }
}

let seq = 0;
type U = { id: string; token: string; api: ReturnType<typeof as>; name: string };
async function newUser(name: string): Promise<U> {
  const inv = await asAdmin("POST", "/api/admin/invites", {});
  const r = await call("POST", `/api/invites/${inv.body.token}/accept`, undefined, { name, email: `perm${++seq}@example.com`, password: "Lume#Brasa998877" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { id: r.body.user.id, token: r.body.token, api: as(r.body.token), name };
}
async function newProject(u: U, name: string) {
  const r = await u.api("POST", "/api/projects", { name });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.project.id as string;
}
const ids = (r: { body: any }) => (r.body as any[]).map((p) => p.id);

type Ws = WebSocket & { got: any[]; code?: number };
function openWs(token: string, p: string): Ws {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${p}${p.includes("?") ? "&" : "?"}token=${token}`) as Ws;
  ws.got = [];
  ws.on("message", (m) => {
    try {
      ws.got.push(JSON.parse(m.toString()));
    } catch {}
  });
  ws.on("close", (c) => (ws.code = c));
  ws.on("error", () => {});
  return ws;
}
const opened = (ws: Ws) => new Promise<void>((r, j) => (ws.on("open", () => r()), ws.on("error", j)));
const closed = async (ws: Ws, what: string) => {
  await until(() => ws.code !== undefined, what);
  return ws.code;
};

let A: U, B: U, C: U;
let PA = "";
let PB = "";
let legacyBefore: any[];

before(async () => {
  await fastify.listen({ port: 0, host: "127.0.0.1" });
  port = (fastify.server.address() as any).port;
  // antes de existir usuário, os projetos antigos ficam sem dono
  legacyBefore = (await call("GET", "/api/projects", internal)).body;
  const s = await call("POST", "/api/auth/setup", undefined, { setupKey: "chave-interna-perm", name: "Carla Mendes", email: "carla.perm@example.com", password: "Zebra!Lapis42xx" });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  adminTok = s.body.token;
  adminId = s.body.user.id;
  A = await newUser("Ana Alves");
  B = await newUser("Beto Braga");
  C = await newUser("Caio Costa");
  PA = await newProject(A, "Projeto da Ana");
  PB = await newProject(B, "Projeto do Beto");
});
beforeEach(() => authService.limiter.reset());
after(async () => {
  await fastify.close();
  rmTmp(tmp);
});

test("migração: projeto antigo sem dono fica sem dono até o setup; depois pertence ao primeiro admin e é gravado", async () => {
  const old = legacyBefore.find((p) => p.id === "proj-legado");
  assert.equal(old.ownerId, null);
  assert.deepEqual(old.members, []);
  const now = savedProjects().find((p) => p.id === "proj-legado");
  assert.equal(now.ownerId, adminId);
  assert.deepEqual(now.members, []);
  // o projeto padrão criado no primeiro boot também migrou
  assert.ok(savedProjects().every((p) => p.ownerId));
  // usuário comum não vê o legado; o admin vê, como "admin"
  assert.ok(!ids(await A.api("GET", "/api/projects")).includes("proj-legado"));
  const adm = (await asAdmin("GET", "/api/projects")).body.find((p: any) => p.id === "proj-legado");
  assert.deepEqual({ ownerId: adm.ownerId, access: adm.access }, { ownerId: adminId, access: "owner" });
});

test("GET /api/projects: filtrado por acesso, com ownerId/access; não-admin sem repoPath; admin e token interno veem tudo", async () => {
  const a = await A.api("GET", "/api/projects");
  assert.deepEqual(ids(a), [PA]);
  assert.equal(a.body[0].ownerId, A.id);
  assert.equal(a.body[0].access, "owner");
  assert.ok(!("repoPath" in a.body[0]), "não-admin não recebe repoPath");
  assert.ok(!("members" in a.body[0]));
  assert.deepEqual(ids(await B.api("GET", "/api/projects")), [PB]);
  assert.deepEqual(ids(await C.api("GET", "/api/projects")), []);
  const adm = await asAdmin("GET", "/api/projects");
  assert.ok(ids(adm).includes(PA) && ids(adm).includes(PB));
  assert.equal(adm.body.find((p: any) => p.id === PA).access, "admin");
  assert.ok(adm.body.every((p: any) => typeof p.repoPath === "string"));
  const internalList = await call("GET", "/api/projects", internal);
  assert.ok(ids(internalList).includes(PA) && ids(internalList).includes(PB));
});

test("criação: quem cria vira dono; não-admin com repoPath leva 403; admin pode usar pasta existente; token interno entrega ao primeiro admin", async () => {
  const dir = path.join(tmp, "pasta-existente");
  fs.mkdirSync(dir);
  const r = await A.api("POST", "/api/projects", { name: "Com pasta", repoPath: dir });
  assert.equal(r.status, 403);
  assert.ok(!ids(await A.api("GET", "/api/projects")).some((i) => i !== PA && savedProjects().find((p) => p.id === i)?.name === "Com pasta"));
  const ok = await asAdmin("POST", "/api/projects", { name: "Pasta do admin", repoPath: dir });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.project.ownerId, adminId);
  assert.equal(ok.body.project.repoPath, dir);
  const viaToken = await call("POST", "/api/projects", internal, { name: "Via agente" });
  assert.equal(viaToken.status, 200);
  assert.equal(viaToken.body.project.ownerId, adminId);
  assert.equal(savedProjects().find((p) => p.id === PA).ownerId, A.id);
});

test("sem acesso → 404 em todas as famílias de /api/projects/:id (e igual a projeto inexistente)", async () => {
  const P = PB;
  const probes: [string, string, unknown?][] = [
    ["GET", `/api/projects/${P}/canvas`],
    ["POST", `/api/projects/${P}/canvas`, { nodes: [], edges: [] }],
    ["GET", `/api/projects/${P}/settings`],
    ["PUT", `/api/projects/${P}/settings`, { defaultCmd: "x" }],
    ["GET", `/api/projects/${P}/prefs`],
    ["PUT", `/api/projects/${P}/prefs`, { resumeSession: false }],
    ["GET", `/api/projects/${P}/sessions`],
    ["DELETE", `/api/projects/${P}/sessions/n1`],
    ["POST", `/api/projects/${P}/sessions/n1/restart`],
    ["GET", `/api/projects/${P}/files`],
    ["GET", `/api/projects/${P}/files/content?path=a.txt`],
    ["POST", `/api/projects/${P}/files/download-link`, { path: "" }],
    ["GET", `/api/projects/${P}/floors`],
    ["POST", `/api/projects/${P}/floors`, { name: "x" }],
    ["GET", `/api/projects/${P}/routines`],
    ["POST", `/api/projects/${P}/routines`, { nodeId: "n", name: "r", text: "x", schedule: { kind: "every", minutes: 5 } }],
    ["POST", `/api/projects/${P}/usage/report`, {}],
    ["GET", `/api/projects/${P}/nodes/n1/context`],
    ["POST", `/api/projects/${P}/nodes/n1/send`, { to: "x", text: "y" }],
    ["GET", `/api/projects/${P}/roles`],
    ["GET", `/api/projects/${P}/links`],
    ["GET", `/api/projects/${P}/models?cli=claude`],
    ["GET", `/api/projects/${P}/worktrees/x/diff`],
    ["POST", `/api/projects/${P}/attachments`, { name: "a.txt", data: "eA==" }],
    ["PATCH", `/api/projects/${P}/sidebar`, { pinned: true }],
    ["GET", `/api/projects/${P}/members`],
    ["POST", `/api/projects/${P}/members`, { userId: A.id }],
    ["GET", `/api/projects/${P}/delete-info`],
    ["DELETE", `/api/projects/${P}`],
  ];
  for (const [m, url, body] of probes) {
    const r = await A.api(m, url, body);
    assert.equal(r.status, 404, `${m} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
    const ghost = await A.api(m, url.replace(P, "proj-nao-existe"), body);
    assert.deepEqual(ghost, r, `${m} ${url}: resposta igual à de projeto inexistente`);
  }
  // nada foi apagado
  assert.ok(ids(await asAdmin("GET", "/api/projects")).includes(PB));
  // quem tem acesso não leva 404 nas mesmas rotas
  assert.equal((await B.api("GET", `/api/projects/${P}/canvas`)).status, 200);
  assert.equal((await B.api("GET", `/api/projects/${P}/settings`)).status, 200);
  assert.equal((await B.api("GET", `/api/projects/${P}/files`)).status, 200);
  assert.equal((await B.api("GET", `/api/projects/${P}/floors`)).status, 200);
  assert.equal((await B.api("GET", `/api/projects/${P}/routines`)).status, 200);
  assert.equal((await B.api("GET", `/api/projects/${P}/sessions`)).status, 200);
  // id com codificação/maiúsculas não escapa do guarda
  assert.equal((await A.api("GET", `/api/projects/%70roj-x/../${PB}/canvas`)).status, 404);
  assert.equal((await A.api("GET", `/api/projects/${PB}/`)).status, 404);
});

test("membro usa o projeto mas não gerencia (403); idempotência e validações do POST /members", async () => {
  const M = await newUser("Mara Melo");
  const P = await newProject(A, "Equipe da Ana");
  assert.equal((await M.api("GET", `/api/projects/${P}/canvas`)).status, 404);
  const add = await A.api("POST", `/api/projects/${P}/members`, { userId: M.id });
  assert.equal(add.status, 200);
  assert.deepEqual(add.body.members.map((u: any) => u.id), [M.id]);
  assert.deepEqual(Object.keys(add.body.members[0]).sort(), ["color", "email", "id", "name"]);
  const again = await A.api("POST", `/api/projects/${P}/members`, { userId: M.id });
  assert.equal(again.status, 200);
  assert.equal(again.body.members.length, 1, "idempotente");
  assert.equal(savedProjects().find((p) => p.id === P).members.length, 1);

  // validações
  assert.equal((await A.api("POST", `/api/projects/${P}/members`, { userId: "u-nao-existe" })).status, 400);
  assert.equal((await A.api("POST", `/api/projects/${P}/members`, {})).status, 400);
  assert.equal((await A.api("POST", `/api/projects/${P}/members`, { userId: A.id })).status, 400, "o dono já é dono");
  const D = await newUser("Davi Dias");
  await asAdmin("PATCH", `/api/admin/users/${D.id}`, { disabled: true });
  assert.equal((await A.api("POST", `/api/projects/${P}/members`, { userId: D.id })).status, 400, "desativado");

  // o membro usa tudo, lê a lista...
  assert.equal((await M.api("GET", `/api/projects/${P}/canvas`)).status, 200);
  assert.equal((await M.api("GET", `/api/projects/${P}/settings`)).status, 200);
  assert.equal((await M.api("PUT", `/api/projects/${P}/prefs`, { resumeSession: false })).status, 200);
  assert.equal((await M.api("PATCH", `/api/projects/${P}/sidebar`, { pinned: false })).status, 200);
  const list = await M.api("GET", `/api/projects/${P}/members`);
  assert.equal(list.status, 200);
  assert.equal(list.body.owner.id, A.id);
  assert.deepEqual(list.body.members.map((u: any) => u.id), [M.id]);
  const mine = (await M.api("GET", "/api/projects")).body.find((p: any) => p.id === P);
  assert.equal(mine.access, "member");
  assert.equal(mine.ownerId, A.id);
  // ...mas não gerencia
  assert.equal((await M.api("POST", `/api/projects/${P}/members`, { userId: C.id })).status, 403);
  assert.equal((await M.api("DELETE", `/api/projects/${P}/members/${A.id}`)).status, 403);
  assert.equal((await M.api("POST", `/api/projects/${P}/owner`, { userId: M.id })).status, 403);
  assert.equal((await M.api("GET", `/api/projects/${P}/delete-info`)).status, 403);
  assert.equal((await M.api("DELETE", `/api/projects/${P}`)).status, 403);
  assert.ok(ids(await asAdmin("GET", "/api/projects")).includes(P), "projeto continua existindo");

  // sai sozinho
  const leave = await M.api("DELETE", `/api/projects/${P}/members/${M.id}`);
  assert.equal(leave.status, 200);
  assert.deepEqual(leave.body.members, []);
  assert.equal((await M.api("GET", `/api/projects/${P}/canvas`)).status, 404);
  assert.deepEqual(ids(await M.api("GET", "/api/projects")), []);
});

test("dono gerencia e transfere; dono não sai nem é removido; admin faz tudo; token interno também", async () => {
  const P = await newProject(A, "Transferível");
  await A.api("POST", `/api/projects/${P}/members`, { userId: B.id });
  // o dono não pode ser removido (nem sair): 400
  assert.equal((await A.api("DELETE", `/api/projects/${P}/members/${A.id}`)).status, 400);
  assert.equal((await asAdmin("DELETE", `/api/projects/${P}/members/${A.id}`)).status, 400);
  // transferir para B: B sai de members, A vira membro
  const t = await A.api("POST", `/api/projects/${P}/owner`, { userId: B.id });
  assert.equal(t.status, 200);
  assert.equal(t.body.owner.id, B.id);
  assert.deepEqual(t.body.members.map((u: any) => u.id), [A.id]);
  const saved = savedProjects().find((p) => p.id === P);
  assert.equal(saved.ownerId, B.id);
  assert.deepEqual(saved.members, [A.id]);
  // A agora é só membro: não gerencia nem exclui; mas continua com acesso (transferir não revoga)
  assert.equal((await A.api("GET", `/api/projects/${P}/canvas`)).status, 200);
  assert.equal((await A.api("POST", `/api/projects/${P}/members`, { userId: C.id })).status, 403);
  assert.equal((await A.api("DELETE", `/api/projects/${P}`)).status, 403);
  // transferência: alvo inexistente/desativado = 400; para o próprio dono = idempotente
  assert.equal((await B.api("POST", `/api/projects/${P}/owner`, { userId: "nada" })).status, 400);
  assert.equal((await B.api("POST", `/api/projects/${P}/owner`, { userId: B.id })).status, 200);
  // o novo dono gerencia
  assert.equal((await B.api("POST", `/api/projects/${P}/members`, { userId: C.id })).status, 200);
  assert.equal((await B.api("DELETE", `/api/projects/${P}/members/${C.id}`)).status, 200);
  // admin gerencia sem ser membro; token interno também
  assert.equal((await asAdmin("POST", `/api/projects/${P}/members`, { userId: C.id })).status, 200);
  assert.equal((await call("DELETE", `/api/projects/${P}/members/${C.id}`, internal)).status, 200);
  const adm = await asAdmin("POST", `/api/projects/${P}/owner`, { userId: A.id });
  assert.equal(adm.status, 200);
  assert.equal(adm.body.owner.id, A.id);
  assert.deepEqual(adm.body.members.map((u: any) => u.id), [B.id]);
  // dono exclui o projeto
  const del = await A.api("GET", `/api/projects/${P}/delete-info`);
  assert.equal(del.status, 200);
  assert.ok(!("repoPath" in del.body), "não-admin não recebe o caminho");
  assert.equal((await A.api("DELETE", `/api/projects/${P}`)).status, 200);
  assert.equal((await A.api("GET", `/api/projects/${P}/canvas`)).status, 404);
  // admin exclui projeto de outro sem ser membro
  const Q = await newProject(B, "Do Beto, apagado pelo admin");
  const info = await asAdmin("GET", `/api/projects/${Q}/delete-info`);
  assert.equal(typeof info.body.repoPath, "string");
  assert.equal((await asAdmin("DELETE", `/api/projects/${Q}`)).status, 200);
});

test("diretório de usuários: só ativos, campos públicos; exige login", async () => {
  const D = await newUser("Dora Dutra");
  await asAdmin("PATCH", `/api/admin/users/${D.id}`, { disabled: true });
  const r = await C.api("GET", "/api/users/directory");
  assert.equal(r.status, 200);
  assert.ok(r.body.users.some((u: any) => u.id === C.id));
  assert.ok(!r.body.users.some((u: any) => u.id === D.id));
  for (const u of r.body.users) assert.deepEqual(Object.keys(u).sort(), ["color", "email", "id", "name"]);
  assert.equal((await call("GET", "/api/users/directory")).status, 401);
});

test("rotas globais: só admin (403 para usuário); leituras de roles/accounts e o resto seguem abertos", async () => {
  const writes: [string, string, unknown?][] = [
    ["PUT", "/api/settings/global", { defaultCmd: "echo oi" }],
    ["GET", "/api/clis"],
    ["POST", "/api/clis/claude/install"],
    ["POST", "/api/clis/claude/login", {}],
    ["POST", "/api/clis/claude/logout", {}],
    ["GET", "/api/cli-jobs/j1"],
    ["POST", "/api/cli-jobs/j1/input", { text: "x" }],
    ["DELETE", "/api/cli-jobs/j1"],
    ["POST", "/api/accounts", { program: "claude", name: "Outra" }],
    ["DELETE", "/api/accounts/claude/Outra"],
    ["POST", "/api/global-roles", { name: "r", prompt: "x" }],
    ["PUT", "/api/global-roles/r", { prompt: "y" }],
    ["DELETE", "/api/global-roles/r"],
  ];
  for (const [m, url, body] of writes) {
    assert.equal((await A.api(m, url, body)).status, 403, `${m} ${url}`);
    assert.notEqual((await call(m, url, internal, body)).status, 403, `${m} ${url} com token interno`);
    assert.notEqual((await asAdmin(m, url, body)).status, 403, `${m} ${url} como admin`);
  }
  assert.equal((await A.api("GET", "/api/settings/global")).status, 200);
  assert.equal((await A.api("GET", "/api/accounts")).status, 200);
  assert.equal((await A.api("GET", "/api/global-roles")).status, 200);
  assert.equal((await A.api("GET", "/api/sidebar")).status, 200);
  // grupos/pastas da barra lateral seguem abertos a todos
  assert.equal((await A.api("POST", "/api/sidebar/groups", { name: "Grupo da Ana" })).status, 200);
  assert.equal((await A.api("DELETE", "/api/sidebar/groups/Grupo da Ana")).status, 200);
});

test("WS: /ws/project e /ws/terminal fecham 4404 sem acesso (inexistente = igual); com acesso conecta", async () => {
  const denied = [openWs(A.token, `/ws/project/${PB}`), openWs(A.token, `/ws/project/proj-nao-existe`), openWs(A.token, `/ws/terminal?project=${PB}&node=n1`), openWs(A.token, `/ws/terminal?project=proj-nao-existe&node=n1`)];
  for (const ws of denied) assert.equal(await closed(ws, "fechado"), 4404);
  const ok = openWs(A.token, `/ws/project/${PA}`);
  await opened(ok);
  await until(() => ok.got.some((m) => m.type === "snapshot"), "snapshot");
  const adm = openWs(adminTok, `/ws/project/${PA}`);
  await opened(adm);
  await until(() => adm.got.some((m) => m.type === "snapshot"), "snapshot admin");
  const viaToken = openWs("chave-interna-perm", `/ws/project/${PB}`);
  await opened(viaToken);
  await until(() => viaToken.got.some((m) => m.type === "snapshot"), "snapshot interno");
  for (const w of [ok, adm, viaToken]) w.close();
});

test("revogação: remover membro, sair e o admin tirar do projeto fecham os WS dele (4403) e avisam {type:sidebar}", async () => {
  const M = await newUser("Nina Neves");
  const P = await newProject(A, "Revogação");
  const Own = await newProject(M, "Projeto da Nina");
  await A.api("POST", `/api/projects/${P}/members`, { userId: M.id });

  // 1) o dono remove o membro
  const inP = openWs(M.token, `/ws/project/${P}`);
  const inOwn = openWs(M.token, `/ws/project/${Own}`);
  await Promise.all([opened(inP), opened(inOwn)]);
  await until(() => inOwn.got.some((m) => m.type === "snapshot"), "snapshot");
  assert.equal((await A.api("DELETE", `/api/projects/${P}/members/${M.id}`)).status, 200);
  assert.equal(await closed(inP, "ws do projeto revogado"), 4403);
  await until(() => inOwn.got.some((m) => m.type === "sidebar"), "sidebar para o usuário");
  assert.equal(inOwn.code, undefined, "o outro projeto dele segue aberto");

  // 2) o membro sai sozinho
  await A.api("POST", `/api/projects/${P}/members`, { userId: M.id });
  const again = openWs(M.token, `/ws/project/${P}`);
  await opened(again);
  assert.equal((await M.api("DELETE", `/api/projects/${P}/members/${M.id}`)).status, 200);
  assert.equal(await closed(again, "saiu"), 4403);

  // 3) o admin redefine os projetos do usuário
  await A.api("POST", `/api/projects/${P}/members`, { userId: M.id });
  const third = openWs(M.token, `/ws/project/${P}`);
  await opened(third);
  const put = await asAdmin("PUT", `/api/admin/users/${M.id}/projects`, { projectIds: [] });
  assert.equal(put.status, 200);
  assert.equal(await closed(third, "admin tirou"), 4403);
  inOwn.close();
});

test("admin: GET/PUT /users/:id/projects (não mexe onde é dono; 400 id inexistente; só admin)", async () => {
  const M = await newUser("Olga Pires");
  const Own = await newProject(M, "Da Olga");
  const get = await asAdmin("GET", `/api/admin/users/${M.id}/projects`);
  assert.equal(get.status, 200);
  const row = (r: any, id: string) => r.body.projects.find((p: any) => p.id === id);
  assert.equal(row(get, Own).access, "owner");
  assert.equal(row(get, PA).access, null);
  assert.deepEqual(Object.keys(row(get, PA)).sort(), ["access", "id", "name"]);
  const put = await asAdmin("PUT", `/api/admin/users/${M.id}/projects`, { projectIds: [PA, PB] });
  assert.equal(put.status, 200);
  assert.equal(row(put, PA).access, "member");
  assert.equal(row(put, PB).access, "member");
  assert.equal(row(put, Own).access, "owner");
  assert.ok(ids(await M.api("GET", "/api/projects")).includes(PA));
  // a lista é o estado final; o projeto onde é dono não sai mesmo sem aparecer na lista
  const put2 = await asAdmin("PUT", `/api/admin/users/${M.id}/projects`, { projectIds: [PB] });
  assert.equal(row(put2, PA).access, null);
  assert.equal(row(put2, Own).access, "owner");
  assert.equal(savedProjects().find((p) => p.id === Own).ownerId, M.id);
  assert.equal((await asAdmin("PUT", `/api/admin/users/${M.id}/projects`, { projectIds: ["proj-fantasma"] })).status, 400);
  assert.equal((await asAdmin("PUT", `/api/admin/users/${M.id}/projects`, { projectIds: "x" })).status, 400);
  assert.equal((await asAdmin("GET", "/api/admin/users/nada/projects")).status, 404);
  assert.equal((await A.api("GET", `/api/admin/users/${M.id}/projects`)).status, 403);
  assert.equal((await A.api("PUT", `/api/admin/users/${M.id}/projects`, { projectIds: [] })).status, 403);
});

test("excluir usuário: projetos dele passam ao admin que excluiu; ele sai de todos os members", async () => {
  const X = await newUser("Xavier Xavier");
  const PX = await newProject(X, "Do Xavier");
  const Shared = await newProject(A, "Da Ana com Xavier");
  await A.api("POST", `/api/projects/${Shared}/members`, { userId: X.id });
  await X.api("POST", `/api/projects/${PX}/members`, { userId: B.id });
  const ws = openWs(X.token, `/ws/project/${Shared}`);
  await opened(ws);
  assert.equal((await asAdmin("DELETE", `/api/admin/users/${X.id}`)).status, 200);
  assert.ok(ws.code !== undefined || (await closed(ws, "ws do excluído")) !== undefined);
  const px = savedProjects().find((p) => p.id === PX);
  assert.equal(px.ownerId, adminId);
  assert.deepEqual(px.members, [B.id], "os outros membros ficam");
  assert.deepEqual(savedProjects().find((p) => p.id === Shared).members, []);
  assert.equal((await B.api("GET", `/api/projects/${PX}/canvas`)).status, 200);
  // desativar NÃO tira dono/membro
  const Y = await newUser("Yara Yamada");
  const PY = await newProject(Y, "Da Yara");
  await asAdmin("PATCH", `/api/admin/users/${Y.id}`, { disabled: true });
  assert.equal(savedProjects().find((p) => p.id === PY).ownerId, Y.id);
});

test("rotas que recebem OUTRO projeto: workspaces (lista/mover/renomear/descarregar/criar) e band/recruit com workspace só enxergam os acessíveis", async () => {
  // canvas com um Maestro em PA e em PB (via token interno)
  const node = (id: string, title: string, extra: object = {}) => ({ id, type: "agentTerminal", position: { x: 0, y: 0 }, style: { width: 300, height: 200 }, data: { title, ...extra } });
  for (const P of [PA, PB]) {
    const r = await call("POST", `/api/projects/${P}/canvas`, internal, { nodes: [node("maestro", "Chefe", { isMaestro: true }), node("w1", "Operario")], edges: [] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const nameB = savedProjects().find((p) => p.id === PB).name;
  const nameA = savedProjects().find((p) => p.id === PA).name;
  const mA = (route: string, body?: unknown, method = "POST") => A.api(method, `/api/projects/${PA}/nodes/maestro/${route}`, body);

  // a árvore de workspaces mostra só o que A acessa; o token interno vê todos
  const treeA = await mA("workspaces", undefined, "GET");
  assert.equal(treeA.status, 200, JSON.stringify(treeA.body));
  const flat = (t: any) => [...t.pinned, ...t.root.workspaces, ...t.root.folders.flatMap((f: any) => f.workspaces), ...t.groups.flatMap((g: any) => [...g.workspaces, ...g.folders.flatMap((f: any) => f.workspaces)])].map((w: any) => w.id);
  const mineIds = ids(await A.api("GET", "/api/projects"));
  assert.ok(flat(treeA.body).includes(PA) && !flat(treeA.body).includes(PB));
  assert.ok(flat(treeA.body).every((i) => mineIds.includes(i)), "só projetos que A acessa");
  assert.ok(!("dir" in treeA.body.root.workspaces[0]) || typeof treeA.body.root.workspaces[0].dir === "string");
  const treeInternal = await call("GET", `/api/projects/${PA}/nodes/maestro/workspaces`, internal);
  assert.ok(flat(treeInternal.body).includes(PB));

  // nomear o projeto de outro usuário = "não encontrado", e nada muda
  for (const [route, body] of [
    ["workspaces/move", { name: nameB, pin: true }],
    ["workspaces/rename", { name: nameB, to: "Sequestrado" }],
    ["workspaces/unload", { name: nameB }],
  ] as [string, unknown][]) {
    const r = await mA(route, body);
    assert.equal(r.status, 404, `${route}: ${JSON.stringify(r.body)}`);
    // o texto da resposta é o mesmo para um workspace que não existe (só muda o nome digitado)
    const ghost = await mA(route, { ...(body as object), name: "Workspace Fantasma" });
    assert.equal(r.body.error.replaceAll(nameB, "X"), ghost.body.error.replaceAll("Workspace Fantasma", "X"));
    assert.equal(r.body.error.split(nameB).length - 1, 1, "o nome só aparece como o usuário digitou; a lista de workspaces não inclui o de outros");
  }
  assert.equal(savedProjects().find((p) => p.id === PB).name, nameB);
  assert.notEqual(savedProjects().find((p) => p.id === PB).pinned, true);
  // o próprio workspace segue funcionando
  assert.equal((await mA("workspaces/move", { name: nameA, pin: true })).status, 200);
  assert.equal((await mA("workspaces/move", { name: nameA, unpin: true })).status, 200);
  // não-admin não cria workspace em pasta existente (nem clona o de outro)
  const dir = path.join(tmp, "ws-existente");
  fs.mkdirSync(dir);
  assert.equal((await mA("workspaces", { name: "Novo da Ana", dir })).status, 403);
  assert.equal((await mA("workspaces", { name: "Clone", dir, from: nameB })).status, 403);

  // band/create e recruit com --workspace de outro projeto: 404 (o nome não resolve para quem não acessa)
  assert.equal((await mA("band/create", { name: "B", agents: ["Operario"], workspace: nameB })).status, 404);
  assert.equal((await mA("recruit", { name: "Novo", workspace: nameB })).status, 404);
  // com o token interno o nome resolve (o erro, se houver, não é "workspace não encontrado")
  const viaAgent = await call("POST", `/api/projects/${PA}/nodes/maestro/band/create`, internal, { name: "B", agents: ["Operario"], workspace: nameB });
  assert.ok(!/Workspace ".*" não encontrado/.test(JSON.stringify(viaAgent.body)), JSON.stringify(viaAgent.body));
});

test("links entre workspaces: usuário só enxerga os pares de projetos que acessa", async () => {
  const nameB = savedProjects().find((p) => p.id === PB).name;
  // liga Operario (PA) ↔ Operario (PB) no registro de links (é o que o `maestri connect` entre workspaces grava)
  assert.ok(crossLinks.add({ project: PA, node: "w1" }, { project: PB, node: "w1" }));
  const asInternal = await call("GET", `/api/projects/${PA}/links`, internal);
  assert.equal(Object.keys(asInternal.body.links).length, 1, "o token interno vê o link");
  assert.deepEqual((await A.api("GET", `/api/projects/${PA}/links`)).body, { links: {} });
  // contexto do agente: o par de outro workspace não aparece para A
  const ctxA = await A.api("GET", `/api/projects/${PA}/nodes/w1/context`);
  assert.equal(ctxA.status, 200);
  assert.ok(!JSON.stringify(ctxA.body).includes(nameB));
  const ctxInternal = await call("GET", `/api/projects/${PA}/nodes/w1/context`, internal);
  assert.ok(JSON.stringify(ctxInternal.body).includes(nameB));
  // se A virar membro de PB, enxerga
  await B.api("POST", `/api/projects/${PB}/members`, { userId: A.id });
  assert.equal(Object.keys((await A.api("GET", `/api/projects/${PA}/links`)).body.links).length, 1);
  await B.api("DELETE", `/api/projects/${PB}/members/${A.id}`);
});

test("projeto criado por agente/CLI herda dono e membros do projeto de origem", async () => {
  const P = await newProject(A, "Origem");
  await A.api("POST", `/api/projects/${P}/members`, { userId: C.id });
  const node = { id: "maestro", type: "agentTerminal", position: { x: 0, y: 0 }, style: { width: 300, height: 200 }, data: { title: "Chefe", isMaestro: true } };
  await call("POST", `/api/projects/${P}/canvas`, internal, { nodes: [node], edges: [] });
  const dir = path.join(tmp, "filho");
  fs.mkdirSync(dir);
  const r = await call("POST", `/api/projects/${P}/nodes/maestro/workspaces`, internal, { name: "Filho do agente", dir });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const kid = savedProjects().find((p) => p.id === r.body.id);
  assert.equal(kid.ownerId, A.id);
  assert.deepEqual(kid.members, [C.id]);
  assert.ok(ids(await C.api("GET", "/api/projects")).includes(r.body.id));
  // origem sem dono (só poderia existir antes do setup): cai no primeiro admin
  const orphan = (await call("POST", "/api/projects", internal, { name: "Sem origem" })).body.project;
  assert.equal(orphan.ownerId, adminId);
});

test("presença: peer sem acesso ao projeto aparece online com projectId null (sem cursor/atividade); quem acessa vê tudo", async () => {
  const mk = async (tok: string) => {
    const ws = openWs(tok, "/ws/presence");
    await opened(ws);
    ws.send(JSON.stringify({ type: "hello", user: { id: "x", name: "x", color: "#3b82f6" } }));
    await until(() => ws.got.some((m) => m.type === "snapshot"), "snapshot presença");
    return ws;
  };
  const wa = await mk(A.token);
  const wb = await mk(B.token); // B não acessa PA
  const wadm = await mk(adminTok); // admin acessa tudo
  const wtok = await mk("chave-interna-perm");
  const meA = wa.got.find((m) => m.type === "snapshot").you;

  wa.send(JSON.stringify({ type: "update", projectId: PA, cursor: { x: 10, y: 20 }, activeNodeId: "n-secreto", activity: "typing" }));
  await until(() => wadm.got.some((m) => m.type === "update" && m.connId === meA), "update do admin");
  const seen = (ws: Ws) => ws.got.filter((m) => m.type === "update" && m.connId === meA).pop();
  assert.deepEqual({ p: seen(wadm).projectId, c: seen(wadm).cursor, n: seen(wadm).activeNodeId, a: seen(wadm).activity }, { p: PA, c: { x: 10, y: 20 }, n: "n-secreto", a: "typing" });
  assert.equal(seen(wtok).projectId, PA);
  // B recebe a troca de projeto já neutralizada
  await until(() => wb.got.some((m) => m.type === "update" && m.connId === meA), "update neutro de B");
  assert.deepEqual({ p: seen(wb).projectId, c: seen(wb).cursor, n: seen(wb).activeNodeId, a: seen(wb).activity }, { p: null, c: null, n: null, a: "idle" });
  // movimentos seguintes no projeto proibido nem chegam a B
  const before = wb.got.length;
  wa.send(JSON.stringify({ type: "update", cursor: { x: 99, y: 99 }, activity: "dragging" }));
  await until(() => seen(wadm).cursor?.x === 99, "cursor chegou ao admin");
  await sleep(80);
  assert.equal(wb.got.length, before, "B não recebe cursor/atividade de projeto que não acessa");
  assert.ok(!JSON.stringify(wb.got).includes(PA), "nenhuma mensagem de B menciona o id do projeto");
  assert.ok(!JSON.stringify(wb.got).includes("n-secreto"));

  // quem entra depois (join / snapshot) também recebe o peer neutro
  const late = await mk(B.token);
  const snap = late.got.find((m) => m.type === "snapshot");
  const peerInSnap = snap.peers.find((p: any) => p.connId === meA);
  assert.ok(peerInSnap, "o peer aparece online");
  assert.equal(peerInSnap.projectId, null);
  assert.equal(peerInSnap.cursor, null);
  assert.equal(peerInSnap.activeNodeId, null);
  const lateAdmin = await mk(adminTok);
  assert.equal(lateAdmin.got.find((m) => m.type === "snapshot").peers.find((p: any) => p.connId === meA).projectId, PA);

  // quando B passa a acessar PA, volta a ver (próximo update de projeto traz o estado completo)
  await A.api("POST", `/api/projects/${PA}/members`, { userId: B.id });
  wa.send(JSON.stringify({ type: "update", projectId: PA }));
  await until(() => seen(wb).projectId === PA, "B passa a ver o projeto");
  await A.api("DELETE", `/api/projects/${PA}/members/${B.id}`);
  for (const w of [wa, wb, wadm, wtok, late, lateAdmin]) w.close();
});

test("modo dev (sem MAESTRI_TOKEN) segue aberto: o guarda só age sobre sessões de usuário", async () => {
  // o servidor deste arquivo tem token; aqui só confirmamos que o token interno nunca leva 404/403 pelo guarda
  for (const url of [`/api/projects/${PB}/canvas`, `/api/projects/${PA}/settings`, `/api/projects/${PB}/members`]) {
    assert.equal((await call("GET", url, internal)).status, 200, url);
  }
  assert.equal((await call("GET", "/api/clis", internal)).status, 200);
});
