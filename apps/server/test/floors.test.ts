import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maestri-floors-test-")));
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
git(repo, "init", "-b", "main");
fs.writeFileSync(path.join(repo, ".gitignore"), ".worktrees\n.maestri_data\nnode_modules\n");
fs.writeFileSync(path.join(repo, "a.txt"), "um\n");
git(repo, "add", "-A");
git(repo, "commit", "-m", "init");

process.env.REPO_PATH = repo;
process.env.NODE_ENV = "test";
process.env.MAESTRI_TOKEN = "tok-fl";

const { fastify } = await import("../src/index.js");
const { parseProgress } = await import("../src/floorsApi.js");
const { floorOf, cloneCanvas, GROUND } = await import("../src/floors.js");
const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/maestri");
const P = "proj-maestri-web";
const auth = { authorization: "Bearer tok-fl" };
let port = 0;
const sockets: WebSocket[] = [];

function maestri(nodeId: string, args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      [bin, ...args],
      { env: { ...process.env, MAESTRI_API_URL: `http://127.0.0.1:${port}/api`, MAESTRI_PROJECT_ID: P, MAESTRI_NODE_ID: nodeId, MAESTRI_TOKEN: "tok-fl" } },
      (err, stdout, stderr) => resolve({ code: err ? ((err as any).code ?? 1) : 0, stdout, stderr }),
    );
  });
}
const ok = async (nodeId: string, args: string[]) => {
  const r = await maestri(nodeId, args);
  assert.equal(r.code, 0, r.stderr);
  return r.stdout;
};
const fail = async (nodeId: string, args: string[], re: RegExp) => {
  const r = await maestri(nodeId, args);
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stderr, re);
};

const state = async () => (await fastify.inject({ method: "GET", url: `/api/projects/${P}/canvas`, headers: auth })).json();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const node = (id: string, type: string, x: number, data: object) => ({ id, type, position: { x, y: 0 }, style: { width: 300, height: 200 }, data });
const resetCanvas = (nodes: any[], edges: any[] = []) =>
  fastify.inject({ method: "POST", url: `/api/projects/${P}/canvas`, headers: auth, payload: { nodes, edges } });
const baseNodes = () => [
  node("maestro", "agentTerminal", 0, { title: "Maestro", isMaestro: true }),
  node("note", "stickyNote", 400, { title: "Nota", content: "x" }),
];
const baseEdges = () => [{ id: "e1", source: "note", target: "maestro" }];
const events: any[] = [];

before(async () => {
  await fastify.listen({ port: 0, host: "127.0.0.1" });
  port = (fastify.server.address() as any).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/project/${P}?token=tok-fl&clientId=browser`);
  ws.on("message", (m) => {
    try {
      events.push(JSON.parse(m.toString()));
    } catch {}
  });
  await new Promise((r) => ws.on("open", r));
  sockets.push(ws);
});
after(async () => {
  sockets.forEach((s) => s.close());
  await fastify.close();
  fs.rmSync(repo, { recursive: true, force: true });
});

test("parseProgress aceita 2/5, 40% e 0.4 e rejeita o resto", () => {
  assert.equal(parseProgress("2/5"), 0.4);
  assert.equal(parseProgress("40%"), 0.4);
  assert.equal(parseProgress("0.4"), 0.4);
  assert.equal(parseProgress("1"), 1);
  for (const bad of ["abc", "6/5", "150%", "-1", "1/0", ""]) assert.throws(() => parseProgress(bad), /Progresso inválido/);
});

test("floorOf: ausente = Ground; cloneCanvas dá ids novos, remapeia arestas e limpa dados efêmeros", () => {
  assert.equal(floorOf({ data: {} }), GROUND);
  assert.equal(floorOf({ data: { floor: "X" } }), "X");
  const c = cloneCanvas(
    [{ id: "agent-1", type: "agentTerminal", data: { title: "A", chat: [1], worktree: "w" } }, { id: "note-2", type: "stickyNote", data: { title: "N" } }],
    [{ id: "e", source: "agent-1", target: "note-2" }, { id: "x", source: "agent-1", target: "fora" }],
    (d) => ({ ...d, floor: "F" }),
  );
  assert.equal(c.nodes.length, 2);
  assert.notEqual(c.nodes[0].id, "agent-1");
  assert.ok(c.nodes[0].id.startsWith("agent-"));
  assert.deepEqual(c.nodes[0].data, { title: "A", floor: "F" });
  assert.equal(c.edges.length, 1);
  assert.deepEqual([c.edges[0].source, c.edges[0].target], [c.nodes[0].id, c.nodes[1].id]);
});

test("floor create: worktree na própria branch, cópia dos não rastreados, list e restrições", async () => {
  await resetCanvas(baseNodes(), baseEdges());
  fs.writeFileSync(path.join(repo, ".env.local"), "SEGREDO=1\n");
  fs.mkdirSync(path.join(repo, "node_modules/x"), { recursive: true });
  fs.writeFileSync(path.join(repo, "node_modules/x/i.js"), "x");
  fs.mkdirSync(path.join(repo, "dist"));
  fs.writeFileSync(path.join(repo, "dist/o.js"), "o");

  const out = await ok("maestro", ["floor", "create", "Refactor Auth", "--branch", "refactor-auth"]);
  assert.match(out, /Andar "Refactor Auth" criado na branch refactor-auth/);
  const wt = path.join(repo, ".worktrees", "refactor-auth");
  assert.ok(fs.existsSync(path.join(wt, "a.txt")));
  assert.equal(git(wt, "rev-parse", "--abbrev-ref", "HEAD"), "refactor-auth");
  assert.equal(fs.readFileSync(path.join(wt, ".env.local"), "utf8"), "SEGREDO=1\n");
  assert.ok(!fs.existsSync(path.join(wt, "node_modules")));
  assert.ok(!fs.existsSync(path.join(wt, "dist")));

  const l = await ok("maestro", ["floor", "list"]);
  assert.match(l, /Ground ← você \(térreo, branch main\)/);
  assert.match(l, /Refactor Auth \(git, branch refactor-auth\)/);

  await fail("maestro", ["floor", "create", "refactor auth"], /Já existe/);
  await fail("maestro", ["floor", "create", "Ground"], /Já existe/);
  await fail("maestro", ["floor", "create", "Outro", "--branch", "refactor-auth"], /já existe.*--existing-branch/);
  await fail("maestro", ["floor", "create", "Outro", "--branch", "nao-existe", "--existing-branch"], /não existe/);
  git(repo, "branch", "velha");
  assert.match(await ok("maestro", ["floor", "create", "Reuso", "--branch", "velha", "--existing-branch"]), /branch velha/);
  // worker comum não cria andares
  await resetCanvas([...baseNodes(), node("w", "agentTerminal", 800, { title: "W" })], [...baseEdges(), { id: "e2", source: "maestro", target: "w" }]);
  await fail("w", ["floor", "create", "Zzz"], /Apenas o Maestro/);
  await fail("w", ["floor", "list"], /Apenas o Maestro/);
  await ok("maestro", ["floor", "delete", "Reuso", "--keep-branch"]);
  await ok("maestro", ["floor", "delete", "Refactor Auth"]);
  assert.ok(!fs.existsSync(wt));
  assert.equal(git(repo, "branch", "--list", "refactor-auth"), "");
});

test("floor create --no-git compartilha o diretório; terminal de andar git começa no checkout dele", async () => {
  await resetCanvas(baseNodes(), baseEdges());
  assert.match(await ok("maestro", ["floor", "create", "Scratch", "--no-git"]), /sem git/);
  assert.match(await ok("maestro", ["floor", "create", "Isolado"]), /branch isolado/);
  await resetCanvas([
    ...baseNodes(),
    node("tg", "agentTerminal", 800, { title: "TG", floor: "Isolado" }),
    node("tp", "agentTerminal", 1200, { title: "TP", floor: "Scratch" }),
  ], baseEdges());
  const pwdOf = async (id: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal?project=${P}&node=${id}&token=tok-fl`);
    let raw = "";
    ws.on("message", (m) => (raw += m.toString()));
    await new Promise((r) => ws.on("open", r));
    sockets.push(ws);
    await sleep(600);
    ws.send("echo CWD[$(pwd -P)]\r");
    const end = Date.now() + 8000;
    const find = () => [...raw.matchAll(/CWD\[([^\]$]+)\]/g)][0]?.[1];
    while (!find() && Date.now() < end) await sleep(50);
    return find();
  };
  assert.equal(await pwdOf("tg"), path.join(repo, ".worktrees", "isolado"));
  assert.equal(await pwdOf("tp"), repo);
  await ok("maestro", ["floor", "delete", "Isolado", "--force"]);
  await ok("maestro", ["floor", "delete", "Scratch"]);
});

test("floor create --copy-ground duplica o layout do térreo com ids novos e sem sessões", async () => {
  await resetCanvas([...baseNodes(), node("w", "agentTerminal", 800, { title: "W" })], [...baseEdges(), { id: "e2", source: "maestro", target: "w" }]);
  await ok("maestro", ["floor", "create", "Clone", "--no-git", "--copy-ground"]);
  const st = await state();
  const onFloor = st.nodes.filter((n: any) => n.data?.floor === "Clone");
  assert.equal(onFloor.length, 3);
  assert.ok(onFloor.every((n: any) => !["maestro", "note", "w"].includes(n.id)));
  assert.equal(st.nodes.filter((n: any) => floorOf(n) === GROUND).length, 3);
  const ids = new Set(onFloor.map((n: any) => n.id));
  assert.equal(st.edges.filter((e: any) => ids.has(e.source) && ids.has(e.target)).length, 2);
  const sess = (await fastify.inject({ method: "GET", url: `/api/projects/${P}/sessions`, headers: auth })).json();
  assert.ok(!Object.keys(sess).some((k) => ids.has(k)) && !(Array.isArray(sess) && sess.some((s: any) => ids.has(s.nodeId))));
  await ok("maestro", ["floor", "delete", "Clone"]);
  assert.equal((await state()).nodes.filter((n: any) => n.data?.floor === "Clone").length, 0);
});

test("floor land: recusa trabalho não commitado, faz merge --into, mantém a branch e remove o andar", async () => {
  await resetCanvas(baseNodes(), baseEdges());
  await ok("maestro", ["floor", "create", "Feature"]);
  const wt = path.join(repo, ".worktrees", "feature");
  fs.writeFileSync(path.join(wt, "novo.txt"), "feature\n");
  await fail("maestro", ["floor", "land", "Feature"], /não commitado/);
  git(wt, "add", "novo.txt");
  git(wt, "commit", "-m", "feature");
  await fail("maestro", ["floor", "land", "Feature", "--delete-branch"], /--into/);
  const out = await ok("maestro", ["floor", "land", "Feature", "--into", "main"]);
  assert.match(out, /mesclada em main/);
  assert.equal(fs.readFileSync(path.join(repo, "novo.txt"), "utf8"), "feature\n");
  assert.ok(!fs.existsSync(wt));
  assert.notEqual(git(repo, "branch", "--list", "feature"), "");
  assert.doesNotMatch(await ok("maestro", ["floor", "list"]), /Feature/);
  git(repo, "branch", "-D", "feature");
});

test("floor land: --keep-floor, --delete-branch e conflito", async () => {
  await resetCanvas(baseNodes(), baseEdges());
  await ok("maestro", ["floor", "create", "Keep"]);
  const k = path.join(repo, ".worktrees", "keep");
  fs.writeFileSync(path.join(k, "k.txt"), "k\n");
  git(k, "add", "k.txt");
  git(k, "commit", "-m", "k");
  assert.match(await ok("maestro", ["floor", "land", "Keep", "--into", "main", "--keep-floor"]), /Andar mantido/);
  assert.ok(fs.existsSync(k));
  await fail("maestro", ["floor", "land", "Keep", "--delete-branch", "--into", "main", "--keep-floor"], /--keep-floor/);
  await ok("maestro", ["floor", "land", "Keep", "--into", "main", "--delete-branch"]);
  assert.equal(git(repo, "branch", "--list", "keep"), "");

  // conflito: mesmo arquivo alterado no andar e no térreo
  await ok("maestro", ["floor", "create", "Conf"]);
  const c = path.join(repo, ".worktrees", "conf");
  fs.writeFileSync(path.join(c, "a.txt"), "no andar\n");
  git(c, "commit", "-am", "andar");
  fs.writeFileSync(path.join(repo, "a.txt"), "no térreo\n");
  git(repo, "commit", "-am", "térreo");
  await fail("maestro", ["floor", "land", "Conf", "--into", "main"], /Conflito.*a\.txt.*nada foi alterado/);
  assert.equal(git(repo, "status", "--porcelain", "--untracked-files=no"), "");
  assert.ok(fs.existsSync(c));
  // térreo sujo também recusa
  fs.writeFileSync(path.join(repo, "a.txt"), "sujo\n");
  await fail("maestro", ["floor", "land", "Conf"], /térreo tem alterações/);
  git(repo, "checkout", "a.txt");
  await ok("maestro", ["floor", "delete", "Conf", "--force"]);
});

test("land e delete só de terminal do térreo", async () => {
  await resetCanvas([...baseNodes(), node("fm", "agentTerminal", 800, { title: "FM", isMaestro: true, floor: "Alto" })], [...baseEdges(), { id: "e2", source: "maestro", target: "fm" }]);
  await ok("maestro", ["floor", "create", "Alto", "--no-git"]);
  await fail("fm", ["floor", "land", "Alto"], /térreo/);
  await fail("fm", ["floor", "delete", "Alto"], /térreo/);
  await fail("maestro", ["floor", "land", "Alto"], /não tem isolamento git/);
  await ok("maestro", ["floor", "delete", "Alto"]);
});

test("floor delete: recusa trabalho não landado sem --force", async () => {
  await resetCanvas(baseNodes(), baseEdges());
  await ok("maestro", ["floor", "create", "Perigo"]);
  const w = path.join(repo, ".worktrees", "perigo");
  fs.writeFileSync(path.join(w, "p.txt"), "p\n");
  await fail("maestro", ["floor", "delete", "Perigo"], /não commitadas/);
  git(w, "add", "p.txt");
  git(w, "commit", "-m", "p");
  await fail("maestro", ["floor", "delete", "Perigo"], /commit\(s\) fora de main/);
  assert.match(await ok("maestro", ["floor", "delete", "Perigo", "--keep-branch"]), /branch perigo mantida/);
  assert.notEqual(git(repo, "branch", "--list", "perigo"), "");
  git(repo, "branch", "-D", "perigo");
  await fail("maestro", ["floor", "delete", "Fantasma"], /não encontrado/);
});

test("floor status: próprio andar, limite de 120, progress, --floor só Maestro, toast em blocked/review/done", async () => {
  await resetCanvas(
    [...baseNodes(), node("w", "agentTerminal", 800, { title: "W", floor: "Obra" }), node("w2", "agentTerminal", 1200, { title: "W2" })],
    [...baseEdges(), { id: "e2", source: "maestro", target: "w" }, { id: "e3", source: "maestro", target: "w2" }],
  );
  await ok("maestro", ["floor", "create", "Obra", "--no-git"]);
  const n0 = events.filter((e) => e.type === "notify").length;
  assert.match(await ok("w", ["floor", "status"]), /Obra: sem status/);
  assert.match(await ok("w", ["floor", "status", "Testes verdes", "--progress", "3/5"]), /working.*60%.*Testes verdes/);
  assert.doesNotMatch(await ok("w", ["floor", "status", "Testes verdes", "--progress", "3/5"]), /": —/); // sem travessão sobrando
  assert.equal(events.filter((e) => e.type === "notify").length, n0);
  await ok("w", ["floor", "status", "x".repeat(300)]);
  assert.match(await ok("w", ["floor", "status"]), new RegExp(`x{120}$`, "m"));
  assert.doesNotMatch(await ok("w", ["floor", "status"]), /x{121}/);
  await ok("w", ["floor", "status", "Preciso de decisão", "--state", "blocked"]);
  await sleep(100);
  const toasts = events.filter((e) => e.type === "notify").slice(n0);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].text, /Obra: blocked — Preciso de decisão/);
  assert.equal(toasts[0].from.title, "W");
  // mesmo estado de novo não notifica
  await ok("w", ["floor", "status", "ainda travado", "--state", "blocked"]);
  await ok("w", ["floor", "status", "pronto", "--state", "review"]);
  await sleep(100);
  assert.equal(events.filter((e) => e.type === "notify").slice(n0).length, 2);
  await fail("w", ["floor", "status", "oi", "--state", "feliz"], /Estado inválido/);
  await fail("w", ["floor", "status", "oi", "--progress", "9/5"], /Progresso inválido/);
  await fail("w", ["floor", "status", "oi", "--floor", "Ground"], /Apenas o Maestro/);
  // Maestro grava no térreo e em outro andar
  await ok("maestro", ["floor", "status", "2 de 3 andares em review", "--floor", "Ground"]);
  await ok("maestro", ["floor", "status", "ajustado", "--floor", "Obra", "--state", "done"]);
  const l = await ok("maestro", ["floor", "list"]);
  assert.match(l, /Ground ← você.*working.*2 de 3/);
  assert.match(l, /Obra .*done.*ajustado/);
  assert.match(await ok("w2", ["floor", "status"]), /Ground — working.*2 de 3/);
  await ok("w", ["floor", "status", "--clear"]);
  assert.match(await ok("w", ["floor", "status"]), /sem status/);
  await ok("maestro", ["floor", "delete", "Obra"]);
});

test("floor unload encerra as sessões do andar; não o seu próprio", async () => {
  await resetCanvas([...baseNodes(), node("u", "agentTerminal", 800, { title: "U", floor: "Dorme" })], baseEdges());
  await ok("maestro", ["floor", "create", "Dorme", "--no-git"]);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal?project=${P}&node=u&token=tok-fl`);
  await new Promise((r) => ws.on("open", r));
  sockets.push(ws);
  const live = async () => {
    const s = (await fastify.inject({ method: "GET", url: `/api/projects/${P}/sessions`, headers: auth })).json();
    return JSON.stringify(s).includes('"u"');
  };
  const end = Date.now() + 5000;
  while (!(await live()) && Date.now() < end) await sleep(50);
  assert.ok(await live());
  assert.match(await ok("maestro", ["floor", "unload", "Dorme"]), /1 terminal/);
  const end2 = Date.now() + 5000;
  while ((await live()) && Date.now() < end2) await sleep(50);
  assert.ok(!(await live()));
  await resetCanvas([...baseNodes(), node("u", "agentTerminal", 800, { title: "U", isMaestro: true, floor: "Dorme" })], [{ id: "e", source: "note", target: "u" }]);
  await fail("u", ["floor", "unload", "Dorme"], /em que você está/);
  await ok("maestro", ["floor", "delete", "Dorme"]).catch(() => {});
});

test("workspaces: list/create/rename/move com grupos e pastas", async () => {
  await resetCanvas(
    [...baseNodes(), node("w", "agentTerminal", 800, { title: "W", floor: "F1", worktreePath: path.join(repo, "sub"), defaultCmd: `claude "$(cat '${repo}/.maestri-roles/x.md')"` })],
    baseEdges(),
  );
  await ok("maestro", ["floor", "create", "F1", "--no-git"]);
  const dirA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maestri-ws-a-")));
  const dirB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maestri-ws-b-")));
  try {
    await fail("w", ["workspace", "list"], /Apenas o Maestro/);
    await fail("maestro", ["workspace", "create", "Novo", "--dir", "/nao/existe"], /não existe/);
    await fail("maestro", ["workspace", "create", "Novo"], /--dir/);
    await fail("maestro", ["workspace", "create", "Novo", "--dir", path.join(repo, "sub")], /não existe|conflita/);
    await fail("maestro", ["workspace", "create", "Maestri Web (Principal)", "--dir", dirA], /Já existe/);

    const out = await ok("maestro", ["workspace", "create", "Clone A", "--dir", dirA, "--from", "maestri web (principal)", "--group", "Dados", "--folder", "Relatórios"]);
    assert.match(out, /Workspace "Clone A" criado/);
    assert.match(out, /grupo "Dados", pasta "Relatórios"/);
    const projects = (await fastify.inject({ method: "GET", url: "/api/projects", headers: auth })).json();
    const a = projects.find((p: any) => p.name === "Clone A");
    assert.equal(a.repoPath, dirA);
    assert.deepEqual([a.group, a.folder], ["Dados", "Relatórios"]);

    // layout clonado, ids novos, caminhos reescritos, sem sessões
    const cs = (await fastify.inject({ method: "GET", url: `/api/projects/${a.id}/canvas`, headers: auth })).json();
    assert.equal(cs.nodes.length, 3);
    assert.ok(cs.nodes.every((n: any) => !["maestro", "note", "w"].includes(n.id)));
    const w = cs.nodes.find((n: any) => n.data.title === "W");
    assert.equal(w.data.floor, "F1");
    assert.equal(w.data.defaultCmd, `claude "$(cat '${dirA}/.maestri-roles/x.md')"`);
    assert.equal(cs.edges.length, 1);
    const fl = (await fastify.inject({ method: "GET", url: `/api/projects/${a.id}/floors`, headers: auth })).json();
    assert.deepEqual(fl.floors.map((f: any) => f.name), ["Ground", "F1"]);

    const l = await ok("maestro", ["workspace", "list"]);
    assert.match(l, /Maestri Web \(Principal\) ← atual — .* — 1 andar\(es\)/);
    assert.match(l, /Grupo "Dados":\n(?:.*\n)*? {2}📁 Relatórios\n {4}- Clone A — .* — 1 andar/);

    // rename: único, só maiúsculas permitido
    await fail("maestro", ["workspace", "rename", "Clone A", "maestri web (principal)"], /Já existe/);
    await ok("maestro", ["workspace", "rename", "Clone A", "CLONE A"]);
    await fail("maestro", ["workspace", "rename", "Fantasma", "X"], /não encontrado/);

    // move
    await ok("maestro", ["workspace", "move", "CLONE A", "--folder", "Arquivo"]);
    let cur = (await fastify.inject({ method: "GET", url: "/api/projects", headers: auth })).json().find((p: any) => p.id === a.id);
    assert.deepEqual([cur.group, cur.folder], [null, "Arquivo"]);
    await ok("maestro", ["workspace", "move", "CLONE A", "--group", "Dados", "--folder", "Arquivo"]);
    await fail("maestro", ["workspace", "move", "CLONE A", "--folder", "Arquivo"], /mais de um lugar/);
    await ok("maestro", ["workspace", "move", "CLONE A", "--root", "--folder", "Arquivo"]);
    cur = (await fastify.inject({ method: "GET", url: "/api/projects", headers: auth })).json().find((p: any) => p.id === a.id);
    assert.deepEqual([cur.group, cur.folder], [null, "Arquivo"]);
    await ok("maestro", ["workspace", "move", "CLONE A", "--group", "Outro"]);
    await ok("maestro", ["workspace", "move", "CLONE A", "--root"]);
    cur = (await fastify.inject({ method: "GET", url: "/api/projects", headers: auth })).json().find((p: any) => p.id === a.id);
    assert.deepEqual([cur.group, cur.folder], [null, null]);
    await fail("maestro", ["workspace", "move", "CLONE A"], /Informe/);
    // fixar/desafixar não move; aparece em "Fixados" no list
    assert.match(await ok("maestro", ["workspace", "move", "CLONE A", "--pin"]), /fixado/);
    cur = (await fastify.inject({ method: "GET", url: "/api/projects", headers: auth })).json().find((p: any) => p.id === a.id);
    assert.deepEqual([cur.group, cur.folder, cur.pinned], [null, null, true]);
    assert.match(await ok("maestro", ["workspace", "list"]), /Fixados:\n {2}- CLONE A/);
    assert.match(await ok("maestro", ["workspace", "move", "CLONE A", "--unpin"]), /desafixado/);
    cur = (await fastify.inject({ method: "GET", url: "/api/projects", headers: auth })).json().find((p: any) => p.id === a.id);
    assert.equal(cur.pinned, false);
    await fail("maestro", ["workspace", "move", "CLONE A", "--pin", "--unpin"], /não combina/);
    await fail("maestro", ["workspace", "move", "CLONE A", "--root", "--group", "G"], /não combina/);
    // grupos e pastas vazios continuam no list e em /api/sidebar
    assert.match(await ok("maestro", ["workspace", "list"]), /Grupo "Outro":\n {2}\(vazio\)/);
    const sb = (await fastify.inject({ method: "GET", url: "/api/sidebar", headers: auth })).json();
    assert.ok(sb.groups.includes("Dados") && sb.folders.some((f: any) => f.name === "Arquivo" && f.group === null));
    // sem delete pela CLI
    await fail("maestro", ["workspace", "delete", "CLONE A"], /Uso/);

    // diretório não pode conflitar com outro workspace
    await fail("maestro", ["workspace", "create", "Dup", "--dir", dirA], /conflita/);
    await ok("maestro", ["workspace", "create", "B", "--dir", dirB]);
  } finally {
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
    await ok("maestro", ["floor", "delete", "F1"]).catch(() => {});
  }
});
