import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maestri-roles-test-")));
const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8" }).trim();
git("init", "-b", "main");
fs.writeFileSync(path.join(repo, ".gitignore"), ".worktrees\n.maestri_data\n.maestri\n.maestri-roles\n");
fs.writeFileSync(path.join(repo, "a.txt"), "um\n");
git("add", "-A");
git("commit", "-m", "init");

// CLIs falsos: o recruit inicia o PTY e roda o defaultCmd; nada de agentes reais nos testes
const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "maestri-fakebin-"));
for (const c of ["claude", "codex"]) {
  fs.writeFileSync(path.join(fakeBin, c), `#!/bin/sh\necho FAKE-${c} "$@"\n`, { mode: 0o755 });
}
process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH}`;

process.env.REPO_PATH = repo;
process.env.NODE_ENV = "test";
process.env.MAESTRI_TOKEN = "tok-roles";

const { fastify } = await import("../src/index.js");
const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/maestri");
const P = "proj-maestri-web";
const auth = { authorization: "Bearer tok-roles" };
const api = (method: "GET" | "POST" | "PUT" | "DELETE", sub: string, payload?: object) =>
  fastify.inject({ method, url: `/api/projects/${P}${sub}`, headers: auth, payload });
const rolesDir = path.join(repo, ".maestri", "roles");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const events: any[] = [];
let ws: WebSocket;
let port = 0;

const canvasNodes = async () => (await api("GET", "/canvas")).json().nodes as any[];

before(async () => {
  await fastify.listen({ port: 0, host: "127.0.0.1" });
  port = (fastify.server.address() as any).port;
  const res = await api("POST", "/canvas", {
    nodes: [{ id: "maestro", type: "agentTerminal", position: { x: 0, y: 0 }, data: { title: "Maestro", isMaestro: true } }],
    edges: [],
  });
  assert.equal(res.statusCode, 200);
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws/project/${P}?token=tok-roles&clientId=b`);
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
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(fakeBin, { recursive: true, force: true });
});

function maestri(nodeId: string, args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      [bin, ...args],
      { env: { ...process.env, MAESTRI_API_URL: `http://127.0.0.1:${port}/api`, MAESTRI_PROJECT_ID: P, MAESTRI_NODE_ID: nodeId, MAESTRI_TOKEN: "tok-roles" } },
      (err, stdout, stderr) => resolve({ code: err ? ((err as any).code ?? 1) : 0, stdout, stderr }),
    );
  });
}

test("roles: lista vazia, cria no formato nativo, edita, apaga e avisa por WS", async () => {
  assert.deepEqual((await api("GET", "/roles")).json(), { roles: [] });

  const created = await api("POST", "/roles", { name: "  Revisor ", prompt: "Revise o código." });
  assert.equal(created.statusCode, 201);
  const role = created.json().role;
  assert.match(role.id, /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
  assert.equal(role.name, "Revisor");
  assert.match(role.color, /^#[0-9A-Fa-f]{6}$/);
  assert.equal(role.schemaVersion, 1);
  assert.ok(role.icon);

  const file = path.join(rolesDir, role.id.toLowerCase(), "role.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), role);

  const upd = await api("PUT", `/roles/${role.id}`, { name: "Revisor Sênior", color: "#112233" });
  assert.equal(upd.statusCode, 200);
  assert.deepEqual({ n: upd.json().role.name, c: upd.json().role.color, p: upd.json().role.prompt }, { n: "Revisor Sênior", c: "#112233", p: "Revise o código." });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).name, "Revisor Sênior");

  const list = (await api("GET", "/roles")).json().roles;
  assert.deepEqual(list.map((r: any) => r.id), [role.id]);

  // id minúsculo também funciona
  assert.equal((await api("PUT", `/roles/${role.id.toLowerCase()}`, { prompt: "novo" })).json().role.prompt, "novo");

  assert.equal((await api("DELETE", `/roles/${role.id}`)).statusCode, 200);
  assert.ok(!fs.existsSync(path.dirname(file)));
  assert.deepEqual((await api("GET", "/roles")).json(), { roles: [] });
  await sleep(50);
  assert.ok(events.filter((e) => e.type === "roles").length >= 3, "evento roles por mutação");
});

test("roles: valida entrada, 404 e id que não é UUID", async () => {
  for (const bad of [{ name: "", prompt: "x" }, { name: "x".repeat(61), prompt: "x" }, { name: "ok", prompt: "x".repeat(20001) }, { name: "ok" }, { name: "ok", prompt: "x", color: "azul" }, { name: "ok", prompt: "x", color: "#12345" }]) {
    assert.equal((await api("POST", "/roles", bad)).statusCode, 400, JSON.stringify(bad).slice(0, 60));
  }
  assert.equal((await api("PUT", "/roles/nao-e-uuid", { name: "x" })).statusCode, 400);
  assert.equal((await api("DELETE", "/roles/..%2F..%2Fx")).statusCode >= 400, true);
  const ghost = "11111111-2222-3333-4444-555555555555";
  assert.equal((await api("PUT", `/roles/${ghost}`, { name: "x" })).statusCode, 404);
  assert.equal((await api("DELETE", `/roles/${ghost}`)).statusCode, 404);
  const r = (await api("POST", "/roles", { name: "v", prompt: "x" })).json().role;
  assert.equal((await api("PUT", `/roles/${r.id}`, { name: "" })).statusCode, 400);
  assert.equal((await api("PUT", `/roles/${r.id}`, { color: "x" })).statusCode, 400);
  assert.equal((await api("DELETE", `/roles/${r.id}`)).statusCode, 200);
});

test("roles: lê pastas do app nativo e ignora inválidas sem tocar nos outros arquivos", async () => {
  const id = "ABCDEF12-3456-7890-ABCD-EF1234567890";
  const dir = path.join(rolesDir, id.toLowerCase());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "role.json"), JSON.stringify({ color: "#FF9500", icon: "person.text.rectangle", id, name: "Nativo", prompt: "do app", schemaVersion: 1 }, null, 2));
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "gerado pelo nativo");
  fs.mkdirSync(path.join(rolesDir, "lixo"), { recursive: true });
  fs.mkdirSync(path.join(rolesDir, "00000000-0000-0000-0000-000000000000"), { recursive: true });
  fs.writeFileSync(path.join(rolesDir, "11111111-1111-1111-1111-111111111111.json"), "{}");
  const bad = path.join(rolesDir, "22222222-2222-2222-2222-222222222222");
  fs.mkdirSync(bad);
  fs.writeFileSync(path.join(bad, "role.json"), "{não é json");

  const roles = (await api("GET", "/roles")).json().roles;
  assert.deepEqual(roles.map((r: any) => r.name), ["Nativo"]);

  assert.equal((await api("PUT", `/roles/${id}`, { prompt: "editado" })).statusCode, 200);
  assert.equal(fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8"), "gerado pelo nativo");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "role.json"), "utf8")).icon, "person.text.rectangle");
  fs.rmSync(dir, { recursive: true });
});

test("agents: preset, role, posição e id/dados do nó", async () => {
  const role = (await api("POST", "/roles", { name: "Dev Back", prompt: "Seja útil.", color: "#FF9500" })).json().role;

  const r = await api("POST", "/agents", { title: "Forge", preset: "claude", roleId: role.id, position: { x: 123, y: 456 } });
  assert.equal(r.statusCode, 201);
  const node = r.json().node;
  assert.match(node.id, /^agent-[0-9a-f]{8}$/);
  assert.equal(node.type, "agentTerminal");
  assert.deepEqual(node.position, { x: 123, y: 456 });
  assert.equal(node.data.title, "Forge");
  assert.equal(node.data.preset, "claude");
  assert.equal(node.data.roleId, role.id);
  assert.equal(node.data.role, "Dev Back");
  assert.equal(node.data.status, "idle");
  const promptFile = path.join(repo, ".maestri-roles", `${node.id}.md`);
  assert.equal(fs.readFileSync(promptFile, "utf8"), "Seja útil.");
  // paridade com o recruit do CLI: o prompt vira CLAUDE.md/AGENTS.md em .maestri/roles/<id>/ e o terminal começa lá
  assert.equal(node.data.defaultCmd, "claude");
  assert.equal(node.data.roleDir, true);
  assert.equal(node.data.worktreePath, path.join(".maestri", "roles", role.id.toLowerCase()));
  assert.match(fs.readFileSync(path.join(repo, node.data.worktreePath, "CLAUDE.md"), "utf8"), /<your_assigned_role>\nSeja útil\.\n<\/your_assigned_role>/);
  assert.ok((await canvasNodes()).some((n) => n.id === node.id), "persistido no canvas");

  // Shell: comando vazio; opencode/agy/codex: nome do preset; role só vira prompt para claude/codex
  const sh = (await api("POST", "/agents", { title: "Shell", preset: "shell" })).json().node;
  assert.equal(sh.data.defaultCmd, "");
  assert.equal(sh.data.role, "Shell");
  assert.ok(sh.position && Number.isFinite(sh.position.x), "freePosition");
  const shCustom = (await api("POST", "/agents", { title: "Dev", preset: "shell", cmd: "npm run dev" })).json().node;
  assert.equal(shCustom.data.defaultCmd, "npm run dev");
  for (const [p, cmd] of [["codex", "codex"], ["opencode", "opencode"], ["agy", "agy"]]) {
    assert.equal((await api("POST", "/agents", { title: `T-${p}`, preset: p })).json().node.data.defaultCmd, cmd, p);
  }
  const oc = (await api("POST", "/agents", { title: "OC", preset: "opencode", roleId: role.id })).json().node;
  assert.equal(oc.data.defaultCmd, "opencode");
  assert.ok(fs.existsSync(path.join(repo, ".maestri-roles", `${oc.id}.md`)));
  const cx = (await api("POST", "/agents", { title: "CX", preset: "codex", roleId: role.id })).json().node;
  assert.equal(cx.data.defaultCmd, "codex");
  assert.equal(cx.data.roleDir, true);

  // nós novos não se sobrepõem
  const nodes = await canvasNodes();
  const keys = nodes.map((n) => `${n.position.x},${n.position.y}`);
  assert.equal(new Set(keys).size, keys.length);
});

test("agents: valida título, preset, cmd, posição e roleId", async () => {
  const post = (b: object) => api("POST", "/agents", b);
  assert.equal((await post({ preset: "claude" })).statusCode, 400);
  assert.equal((await post({ title: "  ", preset: "claude" })).statusCode, 400);
  assert.equal((await post({ title: "x".repeat(65), preset: "claude" })).statusCode, 400);
  assert.equal((await post({ title: "x", preset: "vim" })).statusCode, 400);
  assert.equal((await post({ title: "x" })).statusCode, 400);
  assert.equal((await post({ title: "x", preset: "shell", cmd: "a\nb" })).statusCode, 400);
  assert.equal((await post({ title: "x", preset: "shell", cmd: "x".repeat(501) })).statusCode, 400);
  assert.equal((await post({ title: "x", preset: "claude", position: { x: "a", y: 1 } })).statusCode, 400);
  assert.equal((await post({ title: "x", preset: "claude", roleId: "nao-uuid" })).statusCode, 400);
  assert.equal((await post({ title: "x", preset: "claude", roleId: "11111111-2222-3333-4444-555555555555" })).statusCode, 404);
});

test("agents: worktree:true cria o andar e o prompt usa caminho absoluto", async () => {
  const role = (await api("POST", "/roles", { name: "Andar", prompt: "No andar." })).json().role;
  const r = await api("POST", "/agents", { title: "Isolado", preset: "claude", roleId: role.id, worktree: true });
  assert.equal(r.statusCode, 201);
  const node = r.json().node;
  assert.equal(node.data.worktree, "isolado");
  assert.equal(node.data.branch, "agent/isolado");
  assert.equal(node.data.worktreePath, path.join(repo, ".worktrees", "isolado"));
  assert.ok(fs.existsSync(node.data.worktreePath));
  assert.ok(node.data.defaultCmd.includes(`'${path.join(repo, ".maestri-roles", `${node.id}.md`)}'`));
  // o $(cat ...) funciona a partir do andar
  const out = execFileSync("sh", ["-c", `echo ${node.data.defaultCmd.replace(/^claude /, "")}`], { cwd: node.data.worktreePath, encoding: "utf8" });
  assert.equal(out.trim(), "No andar.");
  assert.equal((await api("GET", "/worktrees")).json().worktrees.find((w: any) => w.name === "isolado").nodeIds[0], node.id);
  assert.equal((await api("DELETE", "/worktrees/isolado?force=1")).statusCode, 200);
});

test("agents: título que colide com branch existente gera nome de andar com sufixo", async () => {
  fs.rmSync(path.join(repo, ".worktrees"), { recursive: true, force: true });
  git("worktree", "prune");
  git("branch", "agent/ocupado");
  const r = await api("POST", "/agents", { title: "Ocupado", preset: "shell", worktree: true });
  assert.equal(r.statusCode, 201);
  assert.match(r.json().node.data.worktree, /^ocupado-[0-9a-f]{4}$/);
});

test("CLI recruit: --preset e --role-id (e --cmd/--role continuam)", async () => {
  const role = (await api("POST", "/roles", { name: "Cli", prompt: "Papel CLI." })).json().role;
  const r = await maestri("maestro", ["recruit", "Cli Agent", "--preset", "claude", "--role-id", role.id]);
  assert.equal(r.code, 0, r.stderr);
  let n = (await canvasNodes()).find((x) => x.data.title === "Cli Agent");
  assert.equal(n.data.preset, "claude");
  assert.equal(n.data.roleId, role.id);
  assert.equal(n.data.role, "Cli");
  // contrato novo: o prompt vai em .maestri/roles/<id>/CLAUDE.md|AGENTS.md e o terminal começa nessa pasta
  assert.equal(n.data.defaultCmd, "claude");
  assert.equal(n.data.worktreePath, path.join(".maestri", "roles", role.id.toLowerCase()));
  for (const f of ["CLAUDE.md", "AGENTS.md"]) assert.match(fs.readFileSync(path.join(repo, ".maestri", "roles", role.id.toLowerCase(), f), "utf8"), /<your_assigned_role>\nPapel CLI\.\n<\/your_assigned_role>/);
  assert.equal(fs.readFileSync(path.join(repo, ".maestri-roles", `${n.id}.md`), "utf8"), "Papel CLI.");

  assert.equal((await maestri("maestro", ["recruit", "Sh", "--preset", "shell"])).code, 0);
  n = (await canvasNodes()).find((x) => x.data.title === "Sh");
  assert.equal(n.data.defaultCmd, "");

  const bad = await maestri("maestro", ["recruit", "X", "--preset", "vim"]);
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /preset/i);
  const ghost = await maestri("maestro", ["recruit", "Y", "--role-id", "11111111-2222-3333-4444-555555555555"]);
  assert.notEqual(ghost.code, 0);

  // compatibilidade: --cmd e --role de texto livre
  assert.equal((await maestri("maestro", ["recruit", "Legacy", "--cmd", "claude", "--role", "Texto livre"])).code, 0);
  n = (await canvasNodes()).find((x) => x.data.title === "Legacy");
  assert.equal(n.data.defaultCmd, "claude");
  assert.match(fs.readFileSync(path.join(repo, ".maestri-roles", n.id, "AGENTS.md"), "utf8"), /Texto livre/);
  assert.equal(fs.readFileSync(path.join(repo, ".maestri-roles", `${n.id}.md`), "utf8"), "Texto livre");
});
