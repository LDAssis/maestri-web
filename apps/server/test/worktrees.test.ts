import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maestri-wt-test-")));
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
git(repo, "init", "-b", "main");
fs.writeFileSync(path.join(repo, ".gitignore"), ".worktrees\n.maestri_data\n");
fs.writeFileSync(path.join(repo, "a.txt"), "um\n");
git(repo, "add", "-A");
git(repo, "commit", "-m", "init");

process.env.REPO_PATH = repo;
process.env.NODE_ENV = "test";
process.env.MAESTRI_TOKEN = "tok-wt";

const { fastify } = await import("../src/index.js");
const P = "proj-maestri-web";
const auth = { authorization: "Bearer tok-wt" };
const url = (sub = "") => `/api/projects/${P}/worktrees${sub}`;
const call = (method: "GET" | "POST" | "DELETE", sub: string, payload?: object) =>
  fastify.inject({ method, url: url(sub), headers: auth, payload });
const nodeData = async (id: string) => (await fastify.inject({ method: "GET", url: `/api/projects/${P}/canvas`, headers: auth })).json().nodes.find((n: any) => n.id === id).data;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let events: any[] = [];

before(async () => {
  await fastify.listen({ port: 0, host: "127.0.0.1" });
  const node = (id: string, type: string, title: string) => ({ id, type, position: { x: 0, y: 0 }, data: { title } });
  const res = await fastify.inject({
    method: "POST",
    url: `/api/projects/${P}/canvas`,
    headers: auth,
    payload: { nodes: [node("ag1", "agentTerminal", "Dev Backend"), node("ag2", "agentTerminal", "Dev Backend 2"), node("note", "stickyNote", "Nota")], edges: [] },
  });
  assert.equal(res.statusCode, 200);
  const port = (fastify.server.address() as any).port;
  const { default: WebSocket } = await import("ws");
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/project/${P}?token=tok-wt&clientId=browser`);
  ws.on("message", (m) => {
    try {
      events.push(JSON.parse(m.toString()));
    } catch {}
  });
  await new Promise((r) => ws.on("open", r));
  (globalThis as any).__ws = ws;
});

after(async () => {
  (globalThis as any).__ws?.close();
  await fastify.close();
  fs.rmSync(repo, { recursive: true, force: true });
});

const worktreeEvents = () => events.filter((e) => e.type === "worktrees").length;

test("lista vazia no início, com a base", async () => {
  const r = await call("GET", "");
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { base: "main", worktrees: [] });
});

test("valida nome, nó inexistente e nó que não é agente", async () => {
  for (const name of ["../x", "-a", "a b", "a;rm", "x".repeat(65)]) {
    assert.equal((await call("POST", "", { nodeId: "ag1", name })).statusCode, 400, name);
  }
  assert.equal((await call("POST", "", { nodeId: "nope" })).statusCode, 404);
  assert.equal((await call("POST", "", { nodeId: "note" })).statusCode, 404);
  assert.equal((await call("GET", "/../x/diff")).statusCode >= 400, true);
});

test("create → diff → land → delete", async () => {
  const before = worktreeEvents();
  const created = await call("POST", "", { nodeId: "ag1" });
  assert.equal(created.statusCode, 201);
  const wt = created.json().worktree;
  assert.equal(wt.name, "dev-backend");
  assert.equal(wt.branch, "agent/dev-backend");
  assert.equal(wt.path, path.join(repo, ".worktrees", "dev-backend"));
  assert.ok(fs.existsSync(wt.path));
  assert.deepEqual(wt.nodeIds, ["ag1"]);

  assert.deepEqual(await nodeData("ag1").then((d) => ({ w: d.worktree, b: d.branch, p: d.worktreePath })), {
    w: "dev-backend", b: "agent/dev-backend", p: wt.path,
  });
  await sleep(50);
  assert.ok(worktreeEvents() > before, "evento WS worktrees");

  // já tem andar -> 409
  assert.equal((await call("POST", "", { nodeId: "ag1" })).statusCode, 409);

  const list = (await call("GET", "")).json();
  assert.equal(list.worktrees.length, 1);
  assert.equal(list.worktrees[0].ahead, 0);
  assert.equal(list.worktrees[0].changed, 0);
  assert.match(list.worktrees[0].head, /^[0-9a-f]{7,}$/);

  // muda: arquivo versionado alterado + não rastreado
  fs.writeFileSync(path.join(wt.path, "a.txt"), "um\ndois\n");
  fs.writeFileSync(path.join(wt.path, "novo.txt"), "novo\n");
  assert.equal((await call("GET", "")).json().worktrees[0].changed, 2);

  const diff = (await call("GET", "/dev-backend/diff")).json();
  assert.equal(diff.base, "main");
  const byPath = Object.fromEntries(diff.files.map((f: any) => [f.path, f]));
  assert.deepEqual({ s: byPath["a.txt"].status, a: byPath["a.txt"].additions, d: byPath["a.txt"].deletions }, { s: "M", a: 1, d: 0 });
  assert.equal(byPath["novo.txt"].status, "?");
  assert.equal(byPath["novo.txt"].additions, 1);
  assert.match(diff.patch, /\+dois/);
  assert.match(diff.patch, /\+\+\+ b\/novo\.txt/);

  // delete sem force com mudanças -> 409; nada some
  const refuse = await call("DELETE", "/dev-backend");
  assert.equal(refuse.statusCode, 409);
  assert.ok(fs.existsSync(wt.path));

  const landed = await call("POST", "/dev-backend/land", { message: "feat: dois" });
  assert.equal(landed.statusCode, 200);
  assert.equal(landed.json().ok, true);
  assert.equal(landed.json().merged, git(repo, "rev-parse", "HEAD"));
  assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "um\ndois\n");
  assert.equal(fs.readFileSync(path.join(repo, "novo.txt"), "utf8"), "novo\n");
  assert.equal(git(repo, "log", "-1", "--format=%P").split(" ").length, 2, "merge --no-ff");

  // landado: sem mudanças, mas ahead>0 (o merge commit não está no andar) -> ainda exige force? não: atrás, não à frente
  const after = (await call("GET", "")).json().worktrees[0];
  assert.equal(after.ahead, 0);
  assert.equal(after.changed, 0);

  const del = await call("DELETE", "/dev-backend");
  assert.equal(del.statusCode, 200);
  assert.ok(!fs.existsSync(wt.path));
  assert.equal(git(repo, "branch", "--list", "agent/dev-backend"), "");
  assert.deepEqual((await call("GET", "")).json().worktrees, []);
  const d = await nodeData("ag1");
  assert.equal(d.worktree, undefined);
  assert.equal(d.branch, undefined);
  assert.equal(d.worktreePath, undefined);
  assert.equal((await call("GET", "/dev-backend/diff")).statusCode, 404);
});

test("nome padrão ganha sufixo se já existir; nome explícito inválido/duplicado", async () => {
  const a = await call("POST", "", { nodeId: "ag1", name: "Dev-Backend" });
  assert.equal(a.statusCode, 201);
  const b = await call("POST", "", { nodeId: "ag2", name: "dev-backend" });
  assert.equal(b.statusCode, 409);
  const c = await call("POST", "", { nodeId: "ag2" });
  assert.equal(c.statusCode, 201);
  assert.match(c.json().worktree.name, /^dev-backend-2(-[0-9a-f]+)?$/);
  // limpa
  assert.equal((await call("DELETE", "/Dev-Backend")).statusCode, 200);
  assert.equal((await call("DELETE", `/${c.json().worktree.name}`)).statusCode, 200);
});

test("delete com ahead>0 exige force=1 e limpa o nó", async () => {
  const created = (await call("POST", "", { nodeId: "ag1", name: "fx" })).json().worktree;
  fs.writeFileSync(path.join(created.path, "f.txt"), "f\n");
  git(created.path, "add", "-A");
  git(created.path, "commit", "-m", "f");
  assert.equal((await call("GET", "")).json().worktrees[0].ahead, 1);
  assert.equal((await call("DELETE", "/fx")).statusCode, 409);
  const r = await call("DELETE", "/fx?force=1");
  assert.equal(r.statusCode, 200);
  assert.ok(!fs.existsSync(created.path));
  assert.equal((await nodeData("ag1")).worktree, undefined);
  assert.equal(git(repo, "branch", "--list", "agent/fx"), "");
});

test("land: 409 se o principal está sujo e 409 + abort em conflito", async () => {
  const wt = (await call("POST", "", { nodeId: "ag1", name: "cf" })).json().worktree;
  fs.writeFileSync(path.join(wt.path, "a.txt"), "do andar\n");

  // principal sujo
  fs.writeFileSync(path.join(repo, "a.txt"), "sujo\n");
  const dirty = await call("POST", "/cf/land");
  assert.equal(dirty.statusCode, 409);
  assert.match(dirty.json().error, /principal/i);
  git(repo, "checkout", "a.txt");

  // conflito: principal altera a mesma linha
  fs.writeFileSync(path.join(repo, "a.txt"), "do principal\n");
  git(repo, "commit", "-am", "principal");
  const head = git(repo, "rev-parse", "HEAD");
  const conflict = await call("POST", "/cf/land");
  assert.equal(conflict.statusCode, 409);
  assert.match(conflict.json().error, /conflito/i);
  assert.equal(git(repo, "rev-parse", "HEAD"), head, "nada mudou no principal");
  assert.equal(git(repo, "status", "--porcelain"), "");
  assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "do principal\n");

  assert.equal((await call("DELETE", "/cf?force=1")).statusCode, 200);
});

test("andar inexistente: land/delete/diff dão 404; nome inválido dá 400", async () => {
  assert.equal((await call("POST", "/nao/land")).statusCode, 404);
  assert.equal((await call("DELETE", "/nao")).statusCode, 404);
  assert.equal((await call("GET", "/nao/diff")).statusCode, 404);
  assert.equal((await call("GET", "/a%20b/diff")).statusCode, 400);
});

test("sessão viva é recriada no cwd do andar e volta ao principal ao apagar", async () => {
  const { default: WebSocket } = await import("ws");
  const port = (fastify.server.address() as any).port;
  const term = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal?project=${P}&node=ag2&token=tok-wt`);
  let out = "";
  term.on("message", (m) => (out += m.toString()));
  await new Promise((r) => term.on("open", r));
  const until = async (cond: () => boolean, what: string) => {
    for (let i = 0; i < 200 && !cond(); i++) await sleep(50);
    assert.ok(cond(), what);
  };
  await until(() => out.length > 0, "shell iniciou");
  await sleep(1000);

  const wt = (await call("POST", "", { nodeId: "ag2", name: "pty" })).json().worktree;
  await until(() => out.includes("Sessão reiniciada"), "PTY recriado");
  await sleep(1000);
  out = "";
  term.send("echo CWD=$(pwd)\r");
  await until(() => out.includes(`CWD=${wt.path}`), "cwd do andar");

  assert.equal((await call("DELETE", "/pty")).statusCode, 200);
  await sleep(1000);
  out = "";
  term.send("echo CWD=$(pwd)\r");
  await until(() => out.includes(`CWD=${repo}`), "cwd do principal");
  term.close();
});
