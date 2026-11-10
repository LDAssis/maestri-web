import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { rmTmp } from "./rmtmp.js";

// FASE 4 (defensor): C8 autorização entre projetos/papéis, C9 traversal/download/anexos/XSS, C11 criação de projeto (repoPath, nomes).
// Roda sem root (isolamento desligado). Teste que FALHA = ACHADO: não se corrige o código aqui; reportar.
const isWindows = process.platform === "win32";
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maestri-sec4-test-")));
const repo = path.join(tmp, "principal");
fs.mkdirSync(path.join(repo, ".maestri_data"), { recursive: true });
const projectsRoot = path.join(tmp, "projetos");
process.env.REPO_PATH = repo;
process.env.MAESTRI_PROJECTS_DIR = projectsRoot;
process.env.MAESTRI_TOK_DIR = path.join(tmp, "tok");
process.env.NODE_ENV = "test";
process.env.MAESTRI_TOKEN = "chave-interna-sec4";
process.env.MAESTRI_PR_POLL_MS = "3600000";
process.env.MAESTRI_DOWNLOAD_TTL_MS = "1500";

const { fastify, authService } = await import("../src/index.js");
const internal = { authorization: "Bearer chave-interna-sec4" };
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function raw(method: string, url: string, headers?: Record<string, string>, payload?: unknown) {
  const r = await fastify.inject({ method: method as any, url, headers, payload: payload as any });
  let body: any = null;
  try {
    body = r.json();
  } catch {}
  return { status: r.statusCode, body, headers: r.headers, text: r.body, rawBody: r.rawPayload };
}
const call = (m: string, u: string, h?: Record<string, string>, p?: unknown) => raw(m, u, h, p);

let adminTok = "";
let seq = 0;
type U = { id: string; token: string; api: (m: string, u: string, p?: unknown) => ReturnType<typeof raw> };
const asAdmin = (m: string, u: string, p?: unknown) => call(m, u, bearer(adminTok), p);
async function newUser(name: string): Promise<U> {
  const inv = await asAdmin("POST", "/api/admin/invites", {});
  const r = await call("POST", `/api/invites/${inv.body.token}/accept`, undefined, { name, email: `sec4-${++seq}@example.com`, password: "Lume#Brasa998877" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { id: r.body.user.id, token: r.body.token, api: (m, u, p) => call(m, u, bearer(r.body.token), p) };
}

let A: U, B: U, C: U;
let PA = "";
let PB = "";
let dirA = "";
let port = 0;
const SECRET = "SEGREDO-FORA-DO-PROJETO-4242";
const outside = path.join(tmp, "fora");
const outsideFile = path.join(outside, "segredo.txt");

before(async () => {
  await fastify.listen({ port: 0, host: "127.0.0.1" });
  port = (fastify.server.address() as any).port;
  const s = await call("POST", "/api/auth/setup", undefined, { setupKey: "chave-interna-sec4", name: "Admin Sec", email: "admin.sec4@example.com", password: "Zebra!Lapis42xx" });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  adminTok = s.body.token;
  A = await newUser("Ana Alves");
  B = await newUser("Beto Braga");
  C = await newUser("Caio Costa");
  PA = (await A.api("POST", "/api/projects", { name: "Projeto A" })).body.project.id;
  PB = (await B.api("POST", "/api/projects", { name: "Projeto B" })).body.project.id;
  assert.equal((await asAdmin("POST", `/api/projects/${PA}/members`, { userId: C.id })).status, 200);
  dirA = (await asAdmin("GET", "/api/projects")).body.find((p: any) => p.id === PA).repoPath;
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(outsideFile, SECRET);
  fs.writeFileSync(path.join(dirA, "ola.txt"), "ola mundo\n");
  fs.writeFileSync(path.join(dirA, "pagina.html"), "<html><script>alert(1)</script></html>");
  fs.writeFileSync(path.join(dirA, "desenho.svg"), '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
  fs.writeFileSync(path.join(dirA, ".env"), "CHAVE=segredo-do-projeto");
  for (const p of [PA, PB]) {
    await call("POST", `/api/projects/${p}/canvas`, internal, {
      nodes: [
        { id: "t", type: "agentTerminal", position: { x: 0, y: 0 }, data: { title: "T" } },
        { id: "mst", type: "agentTerminal", position: { x: 300, y: 0 }, data: { title: "Maestro", isMaestro: true } },
      ],
      edges: [],
    });
  }
});
beforeEach(() => authService.limiter.reset());
after(async () => {
  await fastify.close();
  rmTmp(tmp);
});

// =============================== C8: autorização ===============================
type R = [string, string, unknown?];
const routesOf = (P: string): R[] => [
  ["GET", `/api/projects/${P}/canvas`], ["POST", `/api/projects/${P}/canvas`, { nodes: [], edges: [] }],
  ["GET", `/api/projects/${P}/files`], ["GET", `/api/projects/${P}/files/content?path=ola.txt`], ["POST", `/api/projects/${P}/files/download-link`, { path: "ola.txt" }],
  ["GET", `/api/projects/${P}/sessions`], ["DELETE", `/api/projects/${P}/sessions/t`], ["POST", `/api/projects/${P}/sessions/t/restart`],
  ["GET", `/api/projects/${P}/worktrees`], ["POST", `/api/projects/${P}/worktrees`, { nodeId: "t" }],
  ["GET", `/api/projects/${P}/floors`], ["POST", `/api/projects/${P}/floors`, { name: "x" }], ["POST", `/api/projects/${P}/floors/detect-prs`, {}],
  ["GET", `/api/projects/${P}/routines`], ["POST", `/api/projects/${P}/routines`, { name: "r" }],
  ["GET", `/api/projects/${P}/usage`], ["POST", `/api/projects/${P}/usage/report`, { nodeId: "t" }],
  ["GET", `/api/projects/${P}/nodes/t/context`], ["POST", `/api/projects/${P}/nodes/t/send`, { target: "x", text: "y" }], ["POST", `/api/projects/${P}/nodes/t/recruit`, { name: "z" }],
  ["GET", `/api/projects/${P}/members`], ["POST", `/api/projects/${P}/members`, { userId: "x" }], ["DELETE", `/api/projects/${P}/members/x`], ["POST", `/api/projects/${P}/owner`, { userId: "x" }],
  ["GET", `/api/projects/${P}/delete-info`], ["DELETE", `/api/projects/${P}`, {}], ["PATCH", `/api/projects/${P}/sidebar`, { pinned: true }],
  ["GET", `/api/projects/${P}/prefs`], ["PUT", `/api/projects/${P}/prefs`, { resumeSession: false }],
  ["GET", `/api/projects/${P}/settings`], ["PUT", `/api/projects/${P}/settings`, { defaultCmd: "id" }],
  ["GET", `/api/projects/${P}/roles`], ["POST", `/api/projects/${P}/roles`, { name: "R", prompt: "p" }], ["POST", `/api/projects/${P}/agents`, { title: "x", preset: "shell" }],
  ["GET", `/api/projects/${P}/models`], ["GET", `/api/projects/${P}/links`], ["GET", `/api/projects/${P}/presets`],
  ["POST", `/api/projects/${P}/attachments`, { name: "a.txt", data: "aGk=" }], ["GET", `/api/projects/${P}/attachments/0123456789ab`],
  ["GET", `/api/projects/${P}/`], ["GET", `/api/projects/${P}`],
];

test("C8.1 B (sem acesso) em CADA família de rota do projeto de A: 404 idêntico ao de um projeto inexistente (sem diferença que confirme a existência)", async () => {
  const ghost = "proj-naoexiste";
  for (const [m, u, p] of routesOf(PA)) {
    const real = await B.api(m, u, p);
    const fake = await B.api(m, u.replace(PA, ghost), p);
    assert.equal(real.status, 404, `${m} ${u} -> ${real.status} ${JSON.stringify(real.body)}`);
    assert.equal(real.status, fake.status, `${m} ${u}: status difere do projeto inexistente`);
    assert.deepEqual(real.body, fake.body, `${m} ${u}: corpo difere do projeto inexistente (vaza existência)`);
  }
  // o projeto A segue intacto
  assert.equal((await asAdmin("GET", `/api/projects/${PA}/canvas`)).body.nodes.length, 2);
  assert.equal((await asAdmin("GET", "/api/projects")).body.find((p: any) => p.id === PA).name, "Projeto A");
});

test("C8.2 sem token: todas as rotas /api/projects/* e /api/admin/* dão 401; token lixo também", async () => {
  for (const [m, u, p] of routesOf(PA).slice(0, 12)) {
    assert.equal((await call(m, u, undefined, p)).status, 401, `${m} ${u}`);
    assert.equal((await call(m, u, bearer("lixo"), p)).status, 401, `${m} ${u} (token lixo)`);
  }
  for (const u of ["/api/admin/users", "/api/admin/invites", "/api/projects", "/api/accounts", "/api/clis", "/api/users/directory", "/api/sidebar", "/api/settings/global"]) assert.equal((await call("GET", u)).status, 401, u);
});

test("C8.3 B nos WebSockets do projeto de A: 4404 (project, terminal, portal) e um id de projeto inexistente fecha igual", async () => {
  const code = (p: string) =>
    new Promise<number>((res) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${p}${p.includes("?") ? "&" : "?"}token=${B.token}`);
      ws.on("close", (c) => res(c));
      ws.on("error", () => {});
    });
  assert.equal(await code(`/ws/project/${PA}`), 4404);
  assert.equal(await code(`/ws/terminal?project=${PA}&node=t`), 4404);
  assert.equal(await code(`/ws/portal?project=${PA}&node=t`), 4404);
  assert.equal(await code(`/ws/project/proj-naoexiste`), await code(`/ws/project/${PA}`), "inexistente fecha com o mesmo código");
});

test("C8.4 membro (C) não gerencia membros, não transfere, não exclui e não vê delete-info; pode sair; admin-only 403 para usuário comum", async () => {
  const c = (m: string, u: string, p?: unknown) => C.api(m, u, p);
  assert.equal((await c("POST", `/api/projects/${PA}/members`, { userId: B.id })).status, 403);
  assert.equal((await c("DELETE", `/api/projects/${PA}/members/${A.id}`)).status, 403);
  assert.equal((await c("POST", `/api/projects/${PA}/owner`, { userId: C.id })).status, 403);
  assert.equal((await c("DELETE", `/api/projects/${PA}`, {})).status, 403);
  assert.equal((await c("GET", `/api/projects/${PA}/delete-info`)).status, 403);
  assert.equal((await c("POST", `/api/projects/${PA}/members`, { userId: C.id })).status, 403, "nem se auto-adicionar como dono por outro caminho");
  // o dono e o dono do outro projeto também não mexem no que não é deles
  assert.equal((await A.api("POST", `/api/projects/${PB}/owner`, { userId: A.id })).status, 404);
  // rotas admin: usuário comum (inclusive o dono do projeto) 403
  const adminRoutes: R[] = [
    ["GET", "/api/admin/users"], ["GET", "/api/admin/invites"], ["POST", "/api/admin/invites", {}], ["DELETE", "/api/admin/invites/x"],
    ["PATCH", `/api/admin/users/${B.id}`, { role: "admin" }], ["DELETE", `/api/admin/users/${B.id}`], ["POST", `/api/admin/users/${B.id}/reset-link`, {}],
    ["GET", `/api/admin/users/${B.id}/projects`], ["PUT", `/api/admin/users/${B.id}/projects`, { projectIds: [PA] }],
    ["GET", `/api/admin/users/${B.id}/accounts`], ["PUT", `/api/admin/users/${B.id}/accounts`, { grants: [] }],
    ["PUT", "/api/settings/global", { defaultCmd: "x" }], ["GET", "/api/clis"], ["POST", "/api/clis/claude/login", {}], ["POST", "/api/clis/claude/install", {}], ["GET", "/api/cli-jobs/x"],
    ["POST", "/api/accounts", { program: "claude", name: "X" }], ["DELETE", "/api/accounts/claude/X"], ["POST", "/api/global-roles", { name: "x" }], ["DELETE", "/api/global-roles/x"],
  ];
  for (const [m, u, p] of adminRoutes) {
    assert.equal((await A.api(m, u, p)).status, 403, `${m} ${u} (dono comum)`);
    assert.equal((await c(m, u, p)).status, 403, `${m} ${u} (membro)`);
  }
  // o próprio usuário não se promove por PATCH de si mesmo
  assert.equal((await A.api("PATCH", `/api/admin/users/${A.id}`, { role: "admin" })).status, 403);
  const me = (await asAdmin("GET", "/api/admin/users")).body.users.find((u: any) => u.id === A.id);
  assert.equal(me.role, "user");
});

test("C8.5 GET /api/projects e /api/users/directory não vazam repoPath, osUser/uid/gid, membros nem hashes para não-admin", async () => {
  for (const u of [A, B, C]) {
    const list = (await u.api("GET", "/api/projects")).body as any[];
    assert.ok(list.length >= 1);
    for (const p of list) for (const k of ["repoPath", "osUser", "uid", "gid", "members"]) assert.ok(!(k in p), `${k} vazou para ${u.id}: ${JSON.stringify(p)}`);
    assert.ok(!JSON.stringify(list).includes(tmp), "nenhum caminho do servidor");
  }
  assert.ok(!(await B.api("GET", "/api/projects")).body.some((p: any) => p.id === PA));
  const dir = JSON.stringify((await B.api("GET", "/api/users/directory")).body);
  assert.ok(!/passHash|password|\$argon|scrypt/i.test(dir), "diretório sem hash de senha");
  // projeto criado por usuário: resposta do POST também sem repoPath
  const created = await B.api("POST", "/api/projects", { name: "Sem Vazar" });
  assert.ok(!("repoPath" in created.body.project) && !JSON.stringify(created.body).includes(tmp));
  await B.api("DELETE", `/api/projects/${created.body.project.id}`, { deleteFolder: true });
  // delete-info do dono não mostra o caminho
  assert.ok(!("repoPath" in (await A.api("GET", `/api/projects/${PA}/delete-info`)).body));
});

test("C8.6 PATCH /sidebar e settings não aceitam atribuição em massa (ownerId, members, repoPath, osUser, uid) por membro/dono", async () => {
  const before = JSON.stringify((await asAdmin("GET", "/api/projects")).body.find((p: any) => p.id === PA));
  for (const who of [C, A]) {
    await who.api("PATCH", `/api/projects/${PA}/sidebar`, { pinned: true, ownerId: C.id, members: [B.id], repoPath: "/etc", osUser: "root", uid: 0, isolated: false, id: "outro" });
    await who.api("PUT", `/api/projects/${PA}/prefs`, { resumeSession: true, ownerId: C.id });
  }
  const after = (await asAdmin("GET", "/api/projects")).body.find((p: any) => p.id === PA);
  const b = JSON.parse(before);
  for (const k of ["id", "ownerId", "repoPath", "osUser", "uid", "gid", "isolated", "members"]) assert.deepEqual(after[k], b[k], `campo ${k} foi alterado por atribuição em massa`);
  const saved = JSON.parse(fs.readFileSync(path.join(repo, ".maestri_data", "projects.json"), "utf8")).find((p: any) => p.id === PA);
  assert.notEqual(saved.ownerId, C.id);
});

test("C8.7 /api/sidebar (global) não revela projetos que o usuário não acessa", async () => {
  const s = JSON.stringify((await B.api("GET", "/api/sidebar")).body);
  assert.ok(!s.includes(PA), "a barra lateral de B cita o projeto A");
  assert.ok(!s.includes("Projeto A"));
});

// =============================== C9: traversal / download / anexos / XSS ===============================
test("C9.1 files/content: traversal, absolutos, symlink para fora e .git (inclusive via symlink) não devolvem arquivo de fora nem credenciais do git", async () => {
  fs.writeFileSync(path.join(dirA, "ok.txt"), "dentro");
  if (!isWindows) {
    fs.rmSync(path.join(dirA, "link-fora"), { force: true });
    fs.symlinkSync(outsideFile, path.join(dirA, "link-fora"));
    fs.rmSync(path.join(dirA, "link-dir-fora"), { force: true });
    fs.symlinkSync(outside, path.join(dirA, "link-dir-fora"));
    fs.rmSync(path.join(dirA, "link-gitconfig"), { force: true });
    fs.symlinkSync(path.join(dirA, ".git", "config"), path.join(dirA, "link-gitconfig"));
  }
  const get = (p: string) => A.api("GET", `/api/projects/${PA}/files/content?path=${encodeURIComponent(p)}`);
  const bad = ["../fora/segredo.txt", "..\\fora\\segredo.txt", "ok.txt/../../fora/segredo.txt", outsideFile, "/etc/passwd", "C:\\Windows\\win.ini", "..%2ffora%2fsegredo.txt", "....//fora/segredo.txt", ".git/config", "./.git/config", "x/../.git/HEAD", "ok.txt\0.png", "link-fora", "link-dir-fora/segredo.txt", "link-gitconfig"];
  for (const p of bad) {
    const r = await get(p);
    assert.ok(r.status >= 400, `path=${JSON.stringify(p)} devolveu ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
    assert.ok(!JSON.stringify(r.body).includes(SECRET), `path=${JSON.stringify(p)} vazou o segredo`);
  }
  assert.equal((await get("ok.txt")).body.content, "dentro");
  // parâmetro root
  for (const root of ["../..", "..", ".worktrees", ".worktrees/../..", "main/../x", "a b", "x%2f..", "%2e%2e"]) {
    const r = await A.api("GET", `/api/projects/${PA}/files/content?path=ok.txt&root=${encodeURIComponent(root)}`);
    assert.ok(r.status >= 400, `root=${root} -> ${r.status}`);
  }
  // andar que é symlink para fora
  if (!isWindows) {
    fs.mkdirSync(path.join(dirA, ".worktrees"), { recursive: true });
    fs.rmSync(path.join(dirA, ".worktrees", "fuga"), { force: true });
    fs.symlinkSync(outside, path.join(dirA, ".worktrees", "fuga"));
    const r = await A.api("GET", `/api/projects/${PA}/files/content?path=segredo.txt&root=fuga`);
    assert.ok(r.status >= 400 && !JSON.stringify(r.body).includes(SECRET), `andar-symlink para fora: ${r.status} ${JSON.stringify(r.body)}`);
    const l = await A.api("GET", `/api/projects/${PA}/files?root=fuga`);
    assert.ok(l.status >= 400 || !JSON.stringify(l.body).includes("segredo.txt"), "listar um andar symlink para fora não pode listar a pasta de fora");
  }
  // B e membro sem acesso ao arquivo de A
  assert.equal((await B.api("GET", `/api/projects/${PA}/files/content?path=ok.txt`)).status, 404);
});

test("C9.2 corrida (TOCTOU): trocar o symlink entre o realpath e a leitura não vaza arquivo de fora via files/content", { skip: isWindows ? "posix" : false }, async () => {
  const L = path.join(dirA, "corrida");
  fs.writeFileSync(path.join(dirA, "real.txt"), "REAL-DENTRO");
  const child = spawn("sh", ["-c", `while :; do ln -sfn '${outsideFile}' '${L}.tmp' && mv -T '${L}.tmp' '${L}'; ln -sfn real.txt '${L}.tmp' && mv -T '${L}.tmp' '${L}'; done`], { stdio: "ignore" });
  let leaks = 0;
  const end = Date.now() + 2500;
  let n = 0;
  try {
    while (Date.now() < end) {
      const rs = await Promise.all(Array.from({ length: 20 }, () => A.api("GET", `/api/projects/${PA}/files/content?path=corrida`)));
      for (const r of rs) if (JSON.stringify(r.body).includes(SECRET)) leaks++;
      n += rs.length;
    }
  } finally {
    child.kill("SIGKILL");
    fs.rmSync(L, { force: true });
    fs.rmSync(L + ".tmp", { force: true });
  }
  assert.equal(leaks, 0, `${leaks} de ${n} leituras devolveram o arquivo de fora (a leitura segue o symlink depois da checagem do realpath)`);
});

test("C9.3 download-link: traversal/symlink recusados; link é de uso único, expira, revalida symlink trocado e tem entropia alta", async () => {
  const link = (p: unknown, extra: Record<string, unknown> = {}) => A.api("POST", `/api/projects/${PA}/files/download-link`, { path: p, ...extra });
  for (const p of ["../fora/segredo.txt", "/etc/passwd", "..\\fora", "link-fora", "link-dir-fora", ".git/config", "ok.txt\0"]) {
    const r = await link(p);
    assert.ok(r.status >= 400, `path=${JSON.stringify(p)} -> ${r.status} ${JSON.stringify(r.body)}`);
  }
  assert.equal((await link(123)).status, 400);
  const ok = await link("ola.txt");
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.match(ok.body.url, /^\/api\/downloads\/[0-9a-f]{64}$/);
  const first = await raw("GET", ok.body.url); // sem Authorization: o link É a credencial
  assert.equal(first.status, 200);
  assert.equal(first.text, "ola mundo\n");
  assert.equal((await raw("GET", ok.body.url)).status, 404, "uso único");
  assert.equal((await raw("GET", ok.body.url, bearer(B.token))).status, 404, "reuso por outro usuário");
  // expira
  const exp = await link("ola.txt");
  await sleep(1700);
  assert.equal((await raw("GET", exp.body.url)).status, 404, "expirado");
  // adivinhar/forjar
  for (const t of ["0".repeat(64), "../projects", "%2e%2e%2fprojects", "a".repeat(10)]) assert.ok([401, 404].includes((await raw("GET", `/api/downloads/${t}`)).status), t);
  // symlink trocado DEPOIS de emitido o link
  if (!isWindows) {
    fs.writeFileSync(path.join(dirA, "troca.txt"), "inocente");
    const l2 = await link("troca.txt");
    fs.rmSync(path.join(dirA, "troca.txt"));
    fs.symlinkSync(outsideFile, path.join(dirA, "troca.txt"));
    const r = await raw("GET", l2.body.url);
    assert.ok(r.status >= 400 && !r.text.includes(SECRET), `link emitido antes da troca por symlink devolveu ${r.status}`);
    fs.rmSync(path.join(dirA, "troca.txt"));
  }
});

test("C9.4 zip da pasta: não inclui alvo de symlink para fora, nem .env (excludeSecrets) por padrão", { skip: isWindows ? "posix" : false }, async () => {
  const l = await A.api("POST", `/api/projects/${PA}/files/download-link`, {});
  assert.equal(l.status, 200, JSON.stringify(l.body));
  const z = await raw("GET", l.body.url);
  assert.equal(z.status, 200);
  const names = Buffer.from(z.rawBody).toString("latin1");
  assert.ok(!names.includes("link-fora"), "o zip trouxe o symlink que aponta para fora");
  assert.ok(!names.includes("link-dir-fora"));
  assert.ok(!names.includes(".env"), ".env entrou no zip com excludeSecrets padrão");
  assert.ok(names.includes("ola.txt"));
});

test("C9.5 downloads: html/svg do projeto não são entregues como text/html|image/svg+xml sem proteção (nosniff / tipo inerte)", async () => {
  for (const f of ["pagina.html", "desenho.svg"]) {
    const l = await A.api("POST", `/api/projects/${PA}/files/download-link`, { path: f });
    const r = await raw("GET", l.body.url);
    assert.equal(r.status, 200);
    const ct = String(r.headers["content-type"]);
    const inert = /octet-stream|text\/plain/.test(ct);
    assert.match(String(r.headers["content-disposition"]), /^attachment/, `${f}: precisa ser attachment`);
    assert.ok(inert || r.headers["x-content-type-options"] === "nosniff", `${f}: servido como ${ct} sem X-Content-Type-Options: nosniff (HTML/SVG ativo na origem do app se aberto)`);
    assert.ok(inert || /sandbox/.test(String(r.headers["content-security-policy"] ?? "")), `${f}: servido como ${ct} sem CSP sandbox`);
  }
  // nome de arquivo com CR/LF/aspas não injeta cabeçalho
  if (!isWindows) {
    const nasty = 'a"b\r\nX-Injetado: 1.txt';
    try {
      fs.writeFileSync(path.join(dirA, nasty), "x");
      const l = await A.api("POST", `/api/projects/${PA}/files/download-link`, { path: nasty });
      if (l.status === 200) {
        const r = await raw("GET", l.body.url);
        assert.ok(!("x-injetado" in r.headers), "cabeçalho injetado pelo nome do arquivo");
        assert.ok(!/[\r\n]/.test(String(r.headers["content-disposition"])));
      }
    } finally {
      fs.rmSync(path.join(dirA, nasty), { force: true });
    }
  }
});

test("C9.6 anexos: de outro projeto = 404; id com traversal = 404; nome malicioso sanitizado; html/svg nunca inline; cabeçalhos de contenção", async () => {
  const up = async (name: string, content: Buffer | string) => A.api("POST", `/api/projects/${PA}/attachments`, { name, data: Buffer.from(content).toString("base64") });
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("<script>alert(1)</script>")]);
  const files = { html: await up("../../evil.html", "<script>alert(1)</script>"), svg: await up("x.svg", '<svg onload="alert(1)"/>'), png: await up("a\r\nX-Evil: 1.png", png), traversal: await up("..\\..\\..\\etc\\passwd", "x") };
  for (const [k, r] of Object.entries(files)) assert.equal(r.status, 200, `${k}: ${JSON.stringify(r.body)}`);
  assert.ok(!/[\\/]/.test(files.html.body.attachment.name) && !/[\r\n]/.test(files.png.body.attachment.name), "nome sanitizado");
  for (const k of ["html", "svg"] as const) {
    const g = await raw("GET", `/api/projects/${PA}/attachments/${files[k].body.attachment.id}`, bearer(A.token));
    assert.equal(g.status, 200);
    assert.match(String(g.headers["content-type"]), /octet-stream/, `${k} não pode ser servido como ${g.headers["content-type"]}`);
    assert.match(String(g.headers["content-disposition"]), /^attachment/);
    assert.equal(g.headers["x-content-type-options"], "nosniff");
    assert.match(String(g.headers["content-security-policy"]), /sandbox/);
  }
  const g = await raw("GET", `/api/projects/${PA}/attachments/${files.png.body.attachment.id}`, bearer(A.token));
  assert.equal(g.headers["x-content-type-options"], "nosniff");
  assert.match(String(g.headers["content-security-policy"]), /sandbox/, "imagem inline com CSP sandbox");
  const id = files.html.body.attachment.id as string;
  // outro projeto / usuário
  assert.equal((await B.api("GET", `/api/projects/${PA}/attachments/${id}`)).status, 404);
  assert.equal((await B.api("GET", `/api/projects/${PB}/attachments/${id}`)).status, 404, "id de A pedido no projeto de B");
  assert.equal((await call("GET", `/api/projects/${PA}/attachments/${id}`)).status, 401);
  for (const bad of ["../meta", "..%2f..%2fprojects.json", "%2e%2e", id.toUpperCase(), `${id}%00`, "x".repeat(300)]) {
    const r = await A.api("GET", `/api/projects/${PA}/attachments/${bad}`);
    assert.ok(r.status === 404 || r.status === 400, `${bad} -> ${r.status}`);
  }
});

test("C9.7 XSS/injeção: nomes de projeto/usuário com HTML ficam só em JSON (content-type application/json), sem refletir em HTML", async () => {
  const xss = '<img src=x onerror=alert(1)>';
  const p = await B.api("POST", "/api/projects", { name: xss });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const id = p.body.project.id;
  for (const [m, u] of [["GET", "/api/projects"], ["GET", `/api/projects/${id}/members`], ["GET", `/api/projects/${id}/canvas`], ["GET", "/api/users/directory"], ["GET", `/api/projects/${encodeURIComponent(xss)}/canvas`], ["GET", `/api/${encodeURIComponent(xss)}`], ["GET", `/api/downloads/${encodeURIComponent(xss)}`]] as const) {
    const r = await B.api(m, u);
    assert.match(String(r.headers["content-type"]), /application\/json/, `${m} ${u} respondeu ${r.headers["content-type"]}`);
  }
  // o nome vira pasta/usuário Linux só pelo slug (nunca pelo texto cru)
  const saved = JSON.parse(fs.readFileSync(path.join(repo, ".maestri_data", "projects.json"), "utf8")).find((x: any) => x.id === id);
  assert.match(path.basename(saved.repoPath), /^[a-z0-9-]+$/);
  await B.api("DELETE", `/api/projects/${id}`, { deleteFolder: true });
});

// =============================== C11: criação de projeto ===============================
const projectCount = async () => (await asAdmin("GET", "/api/projects")).body.length as number;
const listDirs = () => (fs.existsSync(projectsRoot) ? fs.readdirSync(projectsRoot) : []).sort();

test("C11.1 não-admin com repoPath (qualquer tipo/valor) leva 403 e nada é criado; chaves alternativas não viram pasta", async () => {
  const n0 = await projectCount();
  const d0 = listDirs();
  for (const v of ["/etc", "/tmp", "/", ".", "..", "~", outside, dirA, " ", "0", 0, 1, true, false, ["/etc"], { a: 1 }, "x\0y"]) {
    const r = await A.api("POST", "/api/projects", { name: "Invasor", repoPath: v });
    assert.equal(r.status, 403, `repoPath=${JSON.stringify(v)} -> ${r.status} ${JSON.stringify(r.body)}`);
  }
  assert.equal(await projectCount(), n0);
  assert.deepEqual(listDirs(), d0, "nenhuma pasta nova");
  // chaves alternativas: ou são recusadas ou o projeto nasce em pasta PRÓPRIA dentro de projects (nunca na pasta pedida)
  for (const key of ["repo_path", "path", "dir", "cwd", "RepoPath", "repoPath ", "__proto__", "constructor"]) {
    const body: any = { name: `Alt ${key}` };
    body[key] = outside;
    const r = await A.api("POST", "/api/projects", body);
    if (r.status === 200) {
      const rp = (await asAdmin("GET", "/api/projects")).body.find((p: any) => p.id === r.body.project.id).repoPath;
      assert.ok(rp.startsWith(projectsRoot + path.sep), `chave ${key} levou o projeto para ${rp}`);
      await A.api("DELETE", `/api/projects/${r.body.project.id}`, { deleteFolder: true });
    } else assert.ok(r.status >= 400);
  }
  // repoPath vazio/null é "sem repoPath" (pasta própria), não bypass
  for (const v of ["", null]) {
    const r = await A.api("POST", "/api/projects", { name: "Vazio", repoPath: v });
    assert.equal(r.status, 200);
    const rp = (await asAdmin("GET", "/api/projects")).body.find((p: any) => p.id === r.body.project.id).repoPath;
    assert.ok(rp.startsWith(projectsRoot + path.sep));
    await A.api("DELETE", `/api/projects/${r.body.project.id}`, { deleteFolder: true });
  }
});

test("C11.2 workspace/agente: usuário comum não cria workspace em pasta existente nem recruta com --dir fora do projeto", async () => {
  const n0 = await projectCount();
  for (const dir of ["/etc", "/tmp", "~", outside, dirA, "."]) {
    const r = await A.api("POST", `/api/projects/${PA}/nodes/mst/workspaces`, { name: `WS ${Math.random()}`, dir });
    assert.equal(r.status, 403, `dir=${dir} -> ${r.status} ${JSON.stringify(r.body)}`);
  }
  const noDir = await A.api("POST", `/api/projects/${PA}/nodes/mst/workspaces`, { name: "Sem Dir" });
  assert.ok(noDir.status >= 400, "workspace sem dir também não pode criar projeto por esse caminho");
  assert.equal(await projectCount(), n0);
  const rec = await A.api("POST", `/api/projects/${PA}/nodes/mst/recruit`, { name: "Zé", preset: "shell", dir: "/etc" });
  if (rec.status < 300) {
    const nodes = (await asAdmin("GET", `/api/projects/${PA}/canvas`)).body.nodes as any[];
    const z = nodes.find((n) => n.data?.title === "Zé");
    const wp = String(z?.data?.worktreePath ?? "");
    assert.ok(!wp.startsWith("/etc") && !wp.startsWith(".."), `recrutado com cwd fora do projeto: ${wp}`);
  }
});

test("C11.3 nomes hostis (../, barras, controles, shell, 5000 caracteres): a pasta é sempre um slug dentro de projects e nada nasce fora dela", async () => {
  const parent = path.dirname(projectsRoot);
  const outsideBefore = fs.readdirSync(parent).sort();
  const names = ["../../../../tmp/pwn", "a/b/c", "..", ".", "CON", "`id`", "$(id)", ";rm -rf /", "<script>alert(1)</script>", "x".repeat(5000), "emoji 💥 ñ", "\u202eevil", "  espaços  ", "-rf", "--help"];
  const made: string[] = [];
  for (const name of names) {
    const r = await B.api("POST", "/api/projects", { name });
    if (r.status !== 200) continue;
    made.push(r.body.project.id);
    const rp = (await asAdmin("GET", "/api/projects")).body.find((p: any) => p.id === r.body.project.id).repoPath as string;
    assert.ok(rp.startsWith(projectsRoot + path.sep), `${JSON.stringify(name).slice(0, 40)} -> ${rp}`);
    assert.match(path.basename(rp), /^[a-z0-9][a-z0-9-]*$/, `pasta não é slug: ${path.basename(rp)}`);
    assert.ok(path.basename(rp).length <= 80, "nome de pasta com tamanho razoável");
    assert.match(r.body.project.id, /^proj-[\w-]+$/);
  }
  assert.deepEqual(fs.readdirSync(parent).sort(), outsideBefore, "algo foi criado fora de projects");
  assert.ok(made.length > 0);
  for (const id of made) await B.api("DELETE", `/api/projects/${id}`, { deleteFolder: true });
});

test("C11.4 validação do nome e da descrição: controles (\\n, \\0), tamanho absurdo e descrição que não é texto são recusados", async () => {
  const bad: [string, any][] = [
    ["nome com quebra de linha", { name: "linha1\nlinha2" }], ["nome com NUL", { name: "a\0b" }], ["nome com 5000 caracteres", { name: "x".repeat(5000) }],
    ["nome só espaços", { name: "   " }], ["nome objeto", { name: { a: 1 } }], ["nome array", { name: ["a"] }],
    ["descrição objeto", { name: "Desc Obj", description: { a: 1 } }], ["descrição array", { name: "Desc Arr", description: [1] }], ["descrição enorme", { name: "Desc Big", description: "d".repeat(200_000) }],
  ];
  const made: string[] = [];
  const failures: string[] = [];
  for (const [what, body] of bad) {
    const r = await B.api("POST", "/api/projects", body);
    if (r.status === 200) {
      made.push(r.body.project.id);
      failures.push(`${what} foi ACEITO (200)`);
    }
  }
  for (const id of made) await B.api("DELETE", `/api/projects/${id}`, { deleteFolder: true });
  assert.deepEqual(failures, [], "entradas inválidas aceitas (armazenadas e devolvidas a todos que acessam o projeto)");
});
