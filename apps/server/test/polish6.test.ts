import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maestri-polish6-test-")));
const repo = path.join(tmp, "repo");
fs.mkdirSync(repo);
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
git(repo, "init", "-b", "main");
fs.writeFileSync(path.join(repo, ".gitignore"), ".worktrees\n.maestri_data\n");
fs.writeFileSync(path.join(repo, "a.txt"), "um\n");
git(repo, "add", "-A");
git(repo, "commit", "-m", "init");

process.env.REPO_PATH = repo;
process.env.NODE_ENV = "test";
process.env.MAESTRI_TOKEN = "tok-p6";

const { fastify } = await import("../src/index.js");
const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/maestri");
const P = "proj-maestri-web";
const auth = { authorization: "Bearer tok-p6" };
let port = 0;
const events: any[] = [];
let ws: WebSocket;

function maestri(args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      [bin, ...args],
      { env: { ...process.env, MAESTRI_API_URL: `http://127.0.0.1:${port}/api`, MAESTRI_PROJECT_ID: P, MAESTRI_NODE_ID: "maestro", MAESTRI_TOKEN: "tok-p6" } },
      (err, stdout, stderr) => resolve({ code: err ? ((err as any).code ?? 1) : 0, stdout, stderr }),
    );
  });
}
const ok = async (args: string[]) => {
  const r = await maestri(args);
  assert.equal(r.code, 0, r.stderr);
  return r.stdout;
};
const call = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: object) => fastify.inject({ method, url, headers: auth, payload });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const count = (type: string) => events.filter((e) => e.type === type).length;
async function until(cond: () => boolean, what: string, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) assert.fail(`timeout: ${what}`);
    await sleep(30);
  }
}

before(async () => {
  await fastify.listen({ port: 0, host: "127.0.0.1" });
  port = (fastify.server.address() as any).port;
  await call("POST", `/api/projects/${P}/canvas`, { nodes: [{ id: "maestro", type: "agentTerminal", position: { x: 0, y: 0 }, data: { title: "Maestro", isMaestro: true } }], edges: [] });
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws/project/${P}?token=tok-p6&clientId=browser`);
  ws.on("message", (m) => {
    try {
      events.push(JSON.parse(m.toString()));
    } catch {}
  });
  await new Promise((r) => ws.on("open", r));
});
after(async () => {
  ws.close();
  await fastify.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("roles globais pela UI: CRUD, duplicado, validação, mesmo armazenamento do CLI e evento roles", async () => {
  assert.deepEqual((await call("GET", "/api/global-roles")).json().roles, []);
  const before = count("roles");
  const created = await call("POST", "/api/global-roles", { name: "Revisor", prompt: "Revise o código.", color: "#112233" });
  assert.equal(created.statusCode, 200, created.body);
  const role = created.json().role;
  assert.deepEqual([role.name, role.color], ["Revisor", "#112233"]);
  await until(() => count("roles") > before, "evento roles ao criar");
  // o CLI enxerga o role criado pela UI (mesmo armazenamento) com escopo global
  const listed = await ok(["role", "list"]);
  assert.match(listed, /Global[^]*Revisor/);
  // e o criado pelo CLI aparece na UI
  await ok(["role", "create", "Do CLI", "Prompt do CLI", "--scope", "global"]);
  assert.deepEqual((await call("GET", "/api/global-roles")).json().roles.map((r: any) => r.name), ["Do CLI", "Revisor"]);

  assert.equal((await call("POST", "/api/global-roles", { name: "revisor", prompt: "x" })).statusCode, 409);
  assert.equal((await call("POST", "/api/global-roles", { name: " ", prompt: "x" })).statusCode, 400);
  assert.equal((await call("POST", "/api/global-roles", { name: "Cor", prompt: "x", color: "azul" })).statusCode, 400);
  assert.equal((await call("POST", "/api/global-roles", { name: "Longo", prompt: "x".repeat(20_001) })).statusCode, 400);

  const edited = await call("PUT", `/api/global-roles/${role.id}`, { name: "Revisor 2", prompt: "Novo prompt" });
  assert.equal(edited.json().role.prompt, "Novo prompt");
  assert.equal((await call("PUT", `/api/global-roles/${role.id}`, { name: "do cli" })).statusCode, 409);
  assert.equal((await call("PUT", "/api/global-roles/nao-uuid", { name: "x" })).statusCode, 400);
  assert.equal((await call("PUT", "/api/global-roles/00000000-0000-4000-8000-000000000000", { name: "x" })).statusCode, 404);
  // não aparece como role do projeto
  assert.ok(!(await call("GET", `/api/projects/${P}/roles`)).json().roles.some((r: any) => r.id === role.id));

  // usar um role global num agente: materializa a cópia (idempotente, origin:"global") e cria o agente com o prompt
  const mat = await call("POST", `/api/projects/${P}/roles/materialize-global`, { roleId: role.id });
  assert.deepEqual(mat.json(), { roleId: role.id, copied: true });
  const copy = (await call("GET", `/api/projects/${P}/roles`)).json().roles.find((r: any) => r.id === role.id);
  assert.deepEqual([copy.origin, copy.prompt], ["global", "Novo prompt"]);
  assert.equal((await call("POST", `/api/projects/${P}/roles/materialize-global`, { roleId: "00000000-0000-4000-8000-000000000000" })).statusCode, 404);
  const agent = await call("POST", `/api/projects/${P}/agents`, { title: "Rev", preset: "shell", roleId: role.id });
  assert.equal(agent.statusCode, 201, agent.body);
  assert.equal(agent.json().node.data.roleId, role.id);
  assert.equal(agent.json().node.data.role, "Revisor 2");
  // editar o global atualiza a cópia materializada; apagar remove só o global
  await call("PUT", `/api/global-roles/${role.id}`, { prompt: "Terceiro prompt" });
  assert.equal((await call("GET", `/api/projects/${P}/roles`)).json().roles.find((r: any) => r.id === role.id).prompt, "Terceiro prompt");
  assert.equal((await call("DELETE", `/api/global-roles/${role.id}`)).statusCode, 200);
  assert.ok(!(await call("GET", "/api/global-roles")).json().roles.some((r: any) => r.id === role.id));
  assert.equal((await call("DELETE", `/api/global-roles/${role.id}`)).statusCode, 404);
});

test("barra lateral transmite {type:'sidebar'} para mudanças do CLI e da UI (coalescido)", async () => {
  const dir = path.join(tmp, "ws1");
  fs.mkdirSync(dir);
  let n = count("sidebar");
  await ok(["workspace", "create", "WS Um", "--dir", dir, "--group", "G1"]);
  await until(() => count("sidebar") > n, "workspace create");
  n = count("sidebar");
  await ok(["workspace", "rename", "WS Um", "WS 1"]);
  await until(() => count("sidebar") > n, "workspace rename");
  n = count("sidebar");
  await ok(["workspace", "move", "WS 1", "--root"]);
  await until(() => count("sidebar") > n, "workspace move");
  n = count("sidebar");
  await ok(["workspace", "move", "WS 1", "--pin"]);
  await until(() => count("sidebar") > n, "workspace pin");
  n = count("sidebar");
  await ok(["workspace", "move", "WS 1", "--unpin"]);
  await until(() => count("sidebar") > n, "workspace unpin");
  // UI: grupos/pastas/mover/fixar e criar/apagar projeto
  for (const [m, url, body] of [
    ["POST", "/api/sidebar/groups", { name: "G2" }],
    ["PATCH", "/api/sidebar/groups/G2", { name: "G3" }],
    ["POST", "/api/sidebar/folders", { name: "F1", group: "G3" }],
    ["DELETE", "/api/sidebar/folders/F1?group=G3", undefined],
    ["DELETE", "/api/sidebar/groups/G3", undefined],
  ] as const) {
    n = count("sidebar");
    assert.equal((await call(m, url, body as any)).statusCode, 200, `${m} ${url}`);
    await until(() => count("sidebar") > n, `${m} ${url}`);
  }
  n = count("sidebar");
  const created = (await call("POST", "/api/projects", { name: "Novo Projeto UI" })).json().project;
  await until(() => count("sidebar") > n, "POST /api/projects");
  n = count("sidebar");
  assert.equal((await call("DELETE", `/api/projects/${created.id}`)).statusCode, 200);
  await until(() => count("sidebar") > n, "DELETE /api/projects");
  // rajada: vários saves seguidos viram poucos avisos
  n = count("sidebar");
  await Promise.all(["A", "B", "C", "D", "E"].map((g) => call("POST", "/api/sidebar/groups", { name: `Rajada ${g}` })));
  await sleep(300);
  const burst = count("sidebar") - n;
  assert.ok(burst >= 1 && burst < 5, `rajada gerou ${burst} avisos`);
});

test("floor land de clone na mesma branch não imprime 'main mesclada em main'", async () => {
  await ok(["floor", "create", "Clone", "--copy"]);
  const dir = path.join(repo, ".worktrees", "clone");
  fs.writeFileSync(path.join(dir, "novo.txt"), "do clone\n");
  git(dir, "add", "novo.txt");
  git(dir, "commit", "-m", "clone");
  const out = await ok(["floor", "land", "Clone"]);
  assert.match(out, /Land de "Clone" concluído: trabalho do clone trazido para main\. Andar removido\./);
  assert.doesNotMatch(out, /mesclada em/);
  assert.doesNotMatch(out, /branch main mantida/);
  // worktree com --into mantém a mensagem original
  await ok(["floor", "create", "Feat", "--branch", "feat"]);
  const wt = path.join(repo, ".worktrees", "feat");
  fs.writeFileSync(path.join(wt, "f.txt"), "f\n");
  git(wt, "add", "f.txt");
  git(wt, "commit", "-m", "feat");
  const out2 = await ok(["floor", "land", "Feat", "--into", "main"]);
  assert.match(out2, /feat mesclada em main\. Andar removido; branch feat mantida\./);
});
