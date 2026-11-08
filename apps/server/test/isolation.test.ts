import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { rmTmp, noSymlink } from "./rmtmp.js";

const real = (p: string) => fs.realpathSync(p);
const tmp = real(fs.mkdtempSync(path.join(os.tmpdir(), "maestri-iso-test-")));
const A = path.join(tmp, "repoA"); // REPO_PATH: primeiro projeto
const projectsRoot = path.join(tmp, "projetos");
const outside = path.join(tmp, "externo");
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
for (const d of [A, path.join(A, "sub"), outside, path.join(outside, "inner")]) fs.mkdirSync(d, { recursive: true });
git(A, "init", "-q", "-b", "main");
fs.writeFileSync(path.join(A, ".gitignore"), ".worktrees\n.maestri_data\n.maestri\n");
fs.writeFileSync(path.join(A, "a.txt"), "a\n");
git(A, "add", "-A");
git(A, "commit", "-qm", "init");

// projects.json legado: dois no mesmo diretório, um aninhado em A, um externo e um aninhado no externo
fs.mkdirSync(path.join(A, ".maestri_data"), { recursive: true });
const mk = (id: string, name: string, repoPath: string) => ({ id, name, description: "", repoPath, createdAt: "2026-01-01T00:00:00.000Z" });
fs.writeFileSync(
  path.join(A, ".maestri_data", "projects.json"),
  JSON.stringify([mk("proj-maestri-web", "Principal", "."), mk("proj-dup", "Duplicado", "."), mk("proj-sub", "Aninhado", "sub"), mk("proj-ext", "Externo", outside), mk("proj-inner", "Dentro do externo", path.join(outside, "inner"))]),
);

process.env.REPO_PATH = A;
process.env.NODE_ENV = "test";
process.env.MAESTRI_TOKEN = "tok-iso";
process.env.MAESTRI_PROJECTS_DIR = projectsRoot;

const { fastify } = await import("../src/index.js");
const { migrateProjects, resolveInside, overlaps } = await import("../src/projectDirs.js");
const auth = { authorization: "Bearer tok-iso" };
const api = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) => fastify.inject({ method, url: `/api${url}`, headers: auth, payload });
const projectsNow = async () => (await api("GET", "/projects")).json() as any[];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let port = 0;

before(async () => {
  await fastify.listen({ port: 0, host: "127.0.0.1" });
  port = (fastify.server.address() as any).port;
});
after(async () => {
  await fastify.close();
  rmTmp(tmp);
});

const pathsOf = (list: any[]) => list.map((p) => real(p.repoPath));
const noOverlap = (paths: string[]) => paths.every((a, i) => paths.every((b, j) => i === j || !overlaps(a, b)));

test("migração: o primeiro mantém o diretório; duplicados e aninhados ganham pasta própria com git", async () => {
  const list = await projectsNow();
  const by = Object.fromEntries(list.map((p) => [p.id, p]));
  assert.equal(real(by["proj-maestri-web"].repoPath), A);
  assert.equal(real(by["proj-ext"].repoPath), outside);
  for (const id of ["proj-dup", "proj-sub", "proj-inner"]) {
    const dir = real(by[id].repoPath);
    assert.equal(path.dirname(dir), real(projectsRoot), id);
    assert.ok(fs.existsSync(path.join(dir, ".git")), `${id} tem .git`);
    assert.equal(git(dir, "rev-list", "--count", "HEAD"), "1", `${id} tem commit inicial`);
  }
  assert.equal(list.length, 5);
  assert.ok(noOverlap(pathsOf(list)), "nenhum par compartilha/aninha diretório");

  // regravado: relativo dentro do defaultRepo, absoluto fora
  const saved = JSON.parse(fs.readFileSync(path.join(A, ".maestri_data", "projects.json"), "utf8"));
  const sv = Object.fromEntries(saved.map((p: any) => [p.id, p.repoPath]));
  assert.equal(sv["proj-maestri-web"], ".");
  assert.equal(sv["proj-ext"], outside);
  assert.equal(sv["proj-dup"], by["proj-dup"].repoPath);
  assert.ok(path.isAbsolute(sv["proj-dup"]));
  // canvas/ids intactos
  assert.deepEqual(saved.map((p: any) => p.id), ["proj-maestri-web", "proj-dup", "proj-sub", "proj-ext", "proj-inner"]);
});

test("migração é idempotente e funciona como função pura sobre a lista", async () => {
  const list = (await projectsNow()).map((p) => ({ ...p }));
  const again = await migrateProjects(list, () => {});
  assert.equal(again.changed, false);
  const dup = [{ id: "proj-x1", name: "X", repoPath: outside }, { id: "proj-x2", name: "X", repoPath: outside }];
  const logs: string[] = [];
  const res = await migrateProjects(dup, (m) => logs.push(m));
  assert.equal(res.changed, true);
  assert.equal(res.projects[0].repoPath, outside);
  assert.notEqual(res.projects[1].repoPath, outside);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /Migração/);
});

test("POST /projects sem repoPath cria pasta própria com git; dois projetos nunca compartilham", async () => {
  const r1 = await api("POST", "/projects", { name: "Meu App Ótimo" });
  const r2 = await api("POST", "/projects", { name: "Meu App Ótimo" });
  assert.equal(r1.statusCode, 200);
  const [p1, p2] = [r1.json().project, r2.json().project];
  assert.notEqual(p1.id, p2.id);
  assert.notEqual(p1.repoPath, p2.repoPath);
  for (const p of [p1, p2]) {
    assert.equal(path.dirname(real(p.repoPath)), real(projectsRoot));
    assert.match(path.basename(p.repoPath), /^meu-app-otimo-/);
    assert.ok(fs.existsSync(path.join(p.repoPath, ".git")));
    assert.equal(git(p.repoPath, "rev-list", "--count", "HEAD"), "1");
    assert.equal(git(p.repoPath, "status", "--porcelain"), "");
  }
  assert.ok(noOverlap(pathsOf(await projectsNow())));
  assert.equal((await api("POST", "/projects", { name: "" })).statusCode, 400);
  assert.equal((await api("POST", "/projects", {})).statusCode, 400);
});

test("POST /projects com repoPath: 400 se inexistente/arquivo/tipo errado; 409 se igual, aninhado, ancestral ou via symlink", async () => {
  const post = (repoPath: unknown) => api("POST", "/projects", { name: "R", repoPath });
  assert.equal((await post(path.join(tmp, "nao-existe"))).statusCode, 400);
  assert.equal((await post(path.join(A, "a.txt"))).statusCode, 400);
  assert.equal((await post(42)).statusCode, 400);

  for (const [what, dir] of [["igual", A], ["descendente", path.join(A, "sub")], ["ancestral", tmp], ["igual ao externo", outside], ["dentro do externo", path.join(outside, "inner")]] as const) {
    const r = await post(dir);
    assert.equal(r.statusCode, 409, what);
    assert.match(r.json().error, /conflita com o projeto/);
  }
  const link = path.join(tmp, "link-para-A");
  if (!noSymlink) {
    fs.symlinkSync(A, link);
    assert.equal((await post(link)).statusCode, 409, "symlink para a pasta de outro projeto");
  }

  const free = real(fs.mkdtempSync(path.join(tmp, "livre-")));
  const ok = await post(free);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().project.repoPath, free);
  assert.equal((await post(free)).statusCode, 409, "segunda vez no mesmo dir");
});

test("DELETE do projeto não apaga a pasta do usuário", async () => {
  const p = (await api("POST", "/projects", { name: "Efêmero" })).json().project;
  fs.writeFileSync(path.join(p.repoPath, "meu-arquivo.txt"), "importante");
  const canvasFile = path.join(A, ".maestri_data", `canvas_${p.id}.json`);
  fs.writeFileSync(canvasFile, "{}");
  assert.equal((await api("DELETE", `/projects/${p.id}`)).statusCode, 200);
  assert.ok(!fs.existsSync(canvasFile), "canvas do projeto apagado");
  assert.ok(!(await projectsNow()).some((x) => x.id === p.id));
  assert.equal(fs.readFileSync(path.join(p.repoPath, "meu-arquivo.txt"), "utf8"), "importante");
  // a pasta ficou livre para outro projeto
  const again = await api("POST", "/projects", { name: "De novo", repoPath: p.repoPath });
  assert.equal(again.statusCode, 200);
});

test("andares, roles e arquivos de um projeto não aparecem no outro", async () => {
  const X = (await api("POST", "/projects", { name: "Proj X" })).json().project;
  const Y = (await api("POST", "/projects", { name: "Proj Y" })).json().project;
  for (const p of [X, Y]) {
    const res = await api("POST", `/projects/${p.id}/canvas`, { nodes: [{ id: "ag", type: "agentTerminal", position: { x: 0, y: 0 }, data: { title: "Agente" } }], edges: [] });
    assert.equal(res.statusCode, 200);
  }
  const wt = (await api("POST", `/projects/${X.id}/worktrees`, { nodeId: "ag", name: "so-no-x" })).json().worktree;
  assert.equal(wt.path, path.join(real(X.repoPath), ".worktrees", "so-no-x"));
  assert.deepEqual((await api("GET", `/projects/${X.id}/worktrees`)).json().worktrees.map((w: any) => w.name), ["so-no-x"]);
  assert.deepEqual((await api("GET", `/projects/${Y.id}/worktrees`)).json().worktrees, []);
  assert.equal((await api("GET", `/projects/${Y.id}/files?root=so-no-x`)).statusCode, 404);
  assert.equal((await api("GET", `/projects/${X.id}/files?root=so-no-x`)).statusCode, 200);
  assert.equal((await api("DELETE", `/projects/${Y.id}/worktrees/so-no-x`)).statusCode, 404);
  assert.equal((await api("GET", `/projects/${Y.id}/worktrees/so-no-x/diff`)).statusCode, 404);

  const role = (await api("POST", `/projects/${X.id}/roles`, { name: "Só do X", prompt: "p" })).json().role;
  assert.deepEqual((await api("GET", `/projects/${X.id}/roles`)).json().roles.map((r: any) => r.id), [role.id]);
  assert.deepEqual((await api("GET", `/projects/${Y.id}/roles`)).json().roles, []);
  assert.equal((await api("PUT", `/projects/${Y.id}/roles/${role.id}`, { name: "invadido" })).statusCode, 404);
  assert.equal((await api("DELETE", `/projects/${Y.id}/roles/${role.id}`)).statusCode, 404);
  assert.equal((await api("POST", `/projects/${Y.id}/agents`, { title: "Z", preset: "shell", roleId: role.id })).statusCode, 404);
  assert.ok(fs.existsSync(path.join(X.repoPath, ".maestri", "roles")) && !fs.existsSync(path.join(Y.repoPath, ".maestri", "roles")));

  // arquivos: cada projeto enxerga só o próprio
  fs.writeFileSync(path.join(X.repoPath, "so-x.txt"), "x");
  assert.ok((await api("GET", `/projects/${X.id}/files`)).json().files.some((f: any) => f.path === "so-x.txt"));
  assert.ok(!(await api("GET", `/projects/${Y.id}/files`)).json().files.some((f: any) => f.path === "so-x.txt"));
  assert.equal((await api("GET", `/projects/${Y.id}/files/content?path=so-x.txt`)).statusCode, 404);
  await api("DELETE", `/projects/${X.id}/worktrees/so-no-x?force=1`);
});

test("files: andar que é symlink para fora do repo é recusado", { skip: noSymlink }, async () => {
  const P = (await api("POST", "/projects", { name: "Symlink" })).json().project;
  fs.mkdirSync(path.join(P.repoPath, ".worktrees"), { recursive: true });
  fs.symlinkSync(outside, path.join(P.repoPath, ".worktrees", "fuga"));
  assert.equal((await api("GET", `/projects/${P.id}/files?root=fuga`)).statusCode, 404);
});

test("resolveInside: só caminhos dentro da raiz (inclusive via symlink); o resto cai na raiz", () => {
  const root = real(fs.mkdtempSync(path.join(tmp, "root-")));
  fs.mkdirSync(path.join(root, "dentro"));
  if (!noSymlink) fs.symlinkSync(outside, path.join(root, "fuga"));
  fs.writeFileSync(path.join(root, "arquivo"), "x");
  assert.equal(resolveInside(root, path.join(root, "dentro")), path.join(root, "dentro"));
  assert.equal(resolveInside(root, "dentro"), path.join(root, "dentro"), "relativo resolve contra a raiz");
  for (const bad of [outside, A, "/", "..", path.join(root, "fuga"), path.join(root, "arquivo"), path.join(root, "nao-existe"), "", undefined, null, 5]) {
    assert.equal(resolveInside(root, bad), root, String(bad));
  }
});

// --- WS: cwd só dentro do repoPath do próprio projeto ---
async function shellCwd(projectId: string, cwdParam: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal?project=${projectId}&node=term-${Math.random().toString(36).slice(2, 8)}&token=tok-iso&cwd=${encodeURIComponent(cwdParam)}`);
  let out = "";
  ws.on("message", (m) => (out += m.toString()));
  await new Promise((r) => ws.on("open", r));
  // 80 colunas + prompt longo: o readline quebra o eco com retorno de carro e o regex casaria o comando digitado
  ws.send(JSON.stringify({ type: "resize", cols: 500, rows: 24 }));
  // Windows: o PTY roda Git Bash, que imprime /tmp/...; pwd -W dá o caminho nativo
  const win = process.platform === "win32";
  ws.send(`echo CWD=[$(pwd ${win ? "-W" : "-P"})]\r`);
  const end = Date.now() + 20000;
  const m = () => /CWD=\[([^\]]+)\]/.exec(out.replace(/\$\(pwd -[PW]\)/g, ""));
  while (!m() && Date.now() < end) await sleep(50);
  ws.close();
  const cwd = m()?.[1];
  return cwd && win ? path.normalize(cwd) : cwd;
}

test("WS terminal: cwd de outro projeto (ou fora) cai no repoPath do próprio; andar próprio é permitido", async () => {
  const X = (await api("POST", "/projects", { name: "WS X" })).json().project;
  const Y = (await api("POST", "/projects", { name: "WS Y" })).json().project;
  const xr = real(X.repoPath);
  assert.equal(await shellCwd(X.id, ""), xr, "sem cwd: repoPath");
  assert.equal(await shellCwd(X.id, real(Y.repoPath)), xr, "cwd do projeto Y");
  assert.equal(await shellCwd(X.id, A), xr, "cwd do repo principal");
  assert.equal(await shellCwd(X.id, "/tmp"), xr, "cwd fora de qualquer projeto");
  fs.mkdirSync(path.join(xr, "sub"));
  assert.equal(await shellCwd(X.id, path.join(xr, "sub")), path.join(xr, "sub"), "subpasta própria");
  if (!noSymlink) {
    fs.symlinkSync(real(Y.repoPath), path.join(xr, "ponte"));
    assert.equal(await shellCwd(X.id, path.join(xr, "ponte")), xr, "symlink para o projeto Y");
  }
  assert.equal(await shellCwd(X.id, `${xr}/../${path.basename(real(Y.repoPath))}`), xr, "../ para o projeto Y");

  await api("POST", `/projects/${X.id}/canvas`, { nodes: [{ id: "ag", type: "agentTerminal", position: { x: 0, y: 0 }, data: { title: "A" } }], edges: [] });
  const wt = (await api("POST", `/projects/${X.id}/worktrees`, { nodeId: "ag", name: "andar" })).json().worktree;
  assert.equal(await shellCwd(X.id, wt.path), wt.path, "andar do próprio projeto");
  assert.equal(await shellCwd(Y.id, wt.path), real(Y.repoPath), "andar do projeto X visto de Y");
  await api("DELETE", `/projects/${X.id}/worktrees/andar?force=1`);
});
