import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maestri-projdel-test-")));
const repo = path.join(tmp, "principal");
const external = path.join(tmp, "externo");
const projectsRoot = path.join(tmp, "projetos");
fs.mkdirSync(repo, { recursive: true });
fs.mkdirSync(external, { recursive: true });
process.env.REPO_PATH = repo;
process.env.MAESTRI_PROJECTS_DIR = projectsRoot;
process.env.NODE_ENV = "test";
delete process.env.MAESTRI_TOKEN;

const { fastify } = await import("../src/index.js");
const dataDir = path.join(repo, ".maestri_data");
const MAIN = "proj-maestri-web";

type Client = WebSocket & { got: string[]; closeCode?: number };
let base = "";

function connect(url: string): Promise<Client> {
  const ws = new WebSocket(base + url) as Client;
  ws.got = [];
  ws.on("message", (m) => ws.got.push(m.toString()));
  ws.on("close", (code) => (ws.closeCode = code));
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}
async function until(cond: () => boolean, what: string, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) assert.fail(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) => fastify.inject({ method, url, payload: payload as any });
const list = async () => (await call("GET", "/api/projects")).json() as { id: string; name: string; repoPath: string }[];
const create = async (name: string, repoPath?: string) => (await call("POST", "/api/projects", { name, ...(repoPath && { repoPath }) })).json().project as { id: string; repoPath: string };
const info = async (id: string) => (await call("GET", `/api/projects/${id}/delete-info`)).json();

before(async () => {
  await fastify.listen({ port: 0, host: "127.0.0.1" });
  base = `ws://127.0.0.1:${(fastify.server.address() as any).port}`;
});

after(async () => {
  await fastify.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("delete-info: contagens, pasta apagável só dentro de MAESTRI_PROJECTS_DIR, 404 e id inválido", async () => {
  const a = await create("Alfa Info");
  assert.ok(a.repoPath.startsWith(projectsRoot));
  await call("POST", `/api/projects/${a.id}/canvas`, {
    nodes: [
      { id: "t1", type: "agentTerminal", position: { x: 0, y: 0 }, data: { title: "T1" } },
      { id: "t2", type: "agentTerminal", position: { x: 0, y: 0 }, data: { title: "T2" } },
      { id: "n1", type: "stickyNote", position: { x: 0, y: 0 }, data: { title: "N1" } },
    ],
    edges: [],
  });
  const i = await info(a.id);
  assert.equal(i.name, "Alfa Info");
  assert.equal(i.canDeleteFolder, true);
  assert.equal(i.isLast, false);
  assert.equal(i.counts.agents, 2);
  assert.equal(i.counts.notes, 1);
  assert.equal(i.counts.floors, 0);

  const ext = await create("Externo Info", external);
  const ie = await info(ext.id);
  assert.equal(ie.canDeleteFolder, false);
  assert.match(ie.folderReason, /criadas pelo Maestri/);
  assert.equal((await info(MAIN)).canDeleteFolder, false); // repositório principal

  assert.equal((await call("GET", "/api/projects/proj-nao-existe/delete-info")).statusCode, 404);
  assert.equal((await call("DELETE", "/api/projects/proj-nao-existe")).statusCode, 404);

  await call("DELETE", `/api/projects/${a.id}`);
  await call("DELETE", `/api/projects/${ext.id}`);
});

test("deleteFolder fora de MAESTRI_PROJECTS_DIR ou no repo principal: 400 e nada é apagado", async () => {
  const ext = await create("Externo Recusa", external);
  fs.writeFileSync(path.join(external, "keep.txt"), "x");
  const res = await call("DELETE", `/api/projects/${ext.id}`, { deleteFolder: true });
  assert.equal(res.statusCode, 400, res.body);
  assert.ok((await list()).some((p) => p.id === ext.id), "projeto continua registrado");
  assert.ok(fs.existsSync(path.join(external, "keep.txt")));

  const main = await call("DELETE", `/api/projects/${MAIN}`, { deleteFolder: true });
  assert.equal(main.statusCode, 400, main.body);
  assert.ok((await list()).some((p) => p.id === MAIN));
  assert.ok(fs.existsSync(repo) && fs.existsSync(dataDir));

  assert.equal((await call("DELETE", `/api/projects/${ext.id}`, { deleteFolder: "sim" })).statusCode, 400);

  // sem deleteFolder: remove o projeto e deixa os arquivos no disco
  const ok = await call("DELETE", `/api/projects/${ext.id}`);
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().folderDeleted, false);
  assert.ok(!(await list()).some((p) => p.id === ext.id));
  assert.ok(fs.existsSync(path.join(external, "keep.txt")));
});

test("pasta que é symlink para fora é recusada mesmo estando dentro da raiz", async () => {
  const link = path.join(projectsRoot, "atalho");
  fs.mkdirSync(projectsRoot, { recursive: true });
  const target = path.join(tmp, "alvo-do-link");
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "keep.txt"), "x");
  fs.symlinkSync(target, link);
  const p = await create("Via Link", link);
  assert.equal((await info(p.id)).canDeleteFolder, false);
  assert.equal((await call("DELETE", `/api/projects/${p.id}`, { deleteFolder: true })).statusCode, 400);
  assert.ok(fs.existsSync(path.join(target, "keep.txt")));
  await call("DELETE", `/api/projects/${p.id}`);
});

test("excluir com a pasta: mata PTYs, avisa e fecha clientes, limpa os dados e apaga o diretório", async () => {
  const a = await create("Beta Completo");
  const other = MAIN;
  const nodeId = "term-del";
  await call("POST", `/api/projects/${a.id}/canvas`, { nodes: [{ id: nodeId, type: "agentTerminal", position: { x: 0, y: 0 }, data: { title: "T" } }], edges: [] });
  await call("PUT", `/api/projects/${a.id}/settings`, { defaultCmd: "echo oi", cliPresets: [] });
  await call("PUT", `/api/projects/${a.id}/prefs`, { resumeSession: false });
  fs.mkdirSync(path.join(dataDir, "attachments", a.id, "x1"), { recursive: true });
  fs.writeFileSync(path.join(a.repoPath, "arquivo.txt"), "dados");
  // o canvas é gravado com debounce: espera os arquivos existirem antes de excluir
  for (const f of [`canvas_${a.id}.json`, `settings_${a.id}.json`, `prefs_${a.id}.json`]) await until(() => fs.existsSync(path.join(dataDir, f)), f);

  const term = await connect(`/ws/terminal?project=${a.id}&node=${nodeId}`);
  await until(() => term.got.length > 0, "terminal ativo");
  const [sess] = (await call("GET", `/api/projects/${a.id}/sessions`)).json();
  assert.ok(alive(sess.pid));
  assert.equal((await info(a.id)).counts.liveTerminals, 1);

  const inside = await connect(`/ws/project/${a.id}?clientId=dentro`);
  const outside = await connect(`/ws/project/${other}?clientId=fora`);
  await until(() => inside.got.length > 0 && outside.got.length > 0, "snapshots");
  const seenOutside = outside.got.length;

  const res = await call("DELETE", `/api/projects/${a.id}`, { deleteFolder: true });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().folderDeleted, true);

  assert.ok(!(await list()).some((p) => p.id === a.id));
  assert.ok(!fs.existsSync(a.repoPath), "pasta do projeto apagada");
  assert.ok(fs.existsSync(repo) && fs.existsSync(dataDir), "repositório principal intacto");
  for (const f of [`canvas_${a.id}.json`, `settings_${a.id}.json`, `prefs_${a.id}.json`, `floors_${a.id}.json`, `routines_${a.id}.json`]) assert.ok(!fs.existsSync(path.join(dataDir, f)), f);
  assert.ok(!fs.existsSync(path.join(dataDir, "attachments", a.id)));
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, "projects.json"), "utf8"));
  assert.ok(!saved.some((p: any) => p.id === a.id), "projects.json sem o projeto");

  await until(() => !alive(sess.pid), "PTY morto");
  await until(() => inside.closeCode === 4404, "cliente de dentro fechado com 4404");
  assert.ok(inside.got.some((m) => JSON.parse(m).type === "project-deleted"), "cliente de dentro foi avisado");
  await until(() => outside.got.slice(seenOutside).some((m) => JSON.parse(m).type === "sidebar"), "outros projetos recebem sidebar");

  assert.equal((await call("GET", `/api/projects/${a.id}/canvas`)).statusCode, 404);
  assert.equal((await call("GET", `/api/projects/${a.id}/delete-info`)).statusCode, 404);
  outside.close();
  term.close();
});

test("o último projeto não pode ser excluído (409)", async () => {
  for (const p of await list()) {
    if ((await list()).length > 1) assert.equal((await call("DELETE", `/api/projects/${p.id}`)).statusCode, 200);
  }
  const [last] = await list();
  assert.equal((await info(last.id)).isLast, true);
  const res = await call("DELETE", `/api/projects/${last.id}`);
  assert.equal(res.statusCode, 409, res.body);
  assert.equal((await list()).length, 1);
});
