import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "maestri-notes-test-"));
process.env.REPO_PATH = repo;
process.env.NODE_ENV = "test";
process.env.MAESTRI_TOKEN = "tok-notes";

const { fastify } = await import("../src/index.js");
const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/maestri");
const P = "proj-maestri-web";
const auth = { authorization: "Bearer tok-notes" };
let port = 0;

function maestri(nodeId: string, args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      [bin, ...args],
      { env: { ...process.env, MAESTRI_API_URL: `http://127.0.0.1:${port}/api`, MAESTRI_PROJECT_ID: P, MAESTRI_NODE_ID: nodeId, MAESTRI_TOKEN: "tok-notes" } },
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

const canvasState = async () => (await fastify.inject({ method: "GET", url: `/api/projects/${P}/canvas`, headers: auth })).json();
const byId = async (id: string) => (await canvasState()).nodes.find((n: any) => n.id === id);
const byTitle = async (title: string) => (await canvasState()).nodes.find((n: any) => n.data?.title === title);
const put = (nodes: any[], edges: any[]) =>
  fastify.inject({ method: "POST", url: `/api/projects/${P}/canvas`, headers: auth, payload: { nodes, edges } });
const node = (id: string, type: string, x: number, data: object) => ({ id, type, position: { x, y: 0 }, style: { width: 300, height: 200 }, data });

const baseNodes = () => [
  node("maestro", "agentTerminal", 0, { title: "Maestro", isMaestro: true }),
  node("worker", "agentTerminal", 400, { title: "Worker" }),
  node("root", "stickyNote", 800, { title: "Raiz", content: "linha1\nlinha2\nlinha3" }),
  node("child", "stickyNote", 1200, { title: "Filha", content: "filha" }),
  node("grand", "stickyNote", 1600, { title: "Neta", content: "neta" }),
  node("far", "stickyNote", 2000, { title: "Longe", content: "x" }),
];
const baseEdges = () => [
  { id: "e1", source: "maestro", target: "worker" },
  { id: "e2", source: "root", target: "maestro" },
  { id: "e3", source: "child", target: "root" },
  { id: "e4", source: "grand", target: "child" },
];

before(async () => {
  await fastify.listen({ port: 0, host: "127.0.0.1" });
  port = (fastify.server.address() as any).port;
});
after(async () => {
  await fastify.close();
  fs.rmSync(repo, { recursive: true, force: true });
});

test("note read numera linhas e aceita intervalo", async () => {
  await put(baseNodes(), baseEdges());
  assert.equal(await ok("maestro", ["note", "read", "raiz"]), "   1| linha1\n   2| linha2\n   3| linha3\n");
  assert.equal(await ok("maestro", ["note", "read", "Raiz", "2", "1"]), "   2| linha2\n");
  assert.equal(await ok("maestro", ["note", "read", "Raiz", "2"]), "   2| linha2\n   3| linha3\n");
  await fail("maestro", ["note", "read", "Raiz", "9"], /fora/);
});

test("note edit exige trecho único; write/append mantêm", async () => {
  await put(baseNodes(), baseEdges());
  await ok("maestro", ["note", "write", "Raiz", "a b a"]);
  await fail("maestro", ["note", "edit", "Raiz", "a", "z"], /2 vezes/);
  await fail("maestro", ["note", "edit", "Raiz", "q", "z"], /não foi encontrado/);
  await ok("maestro", ["note", "edit", "Raiz", "b", "B"]);
  await ok("maestro", ["note", "append", "Raiz", "fim"]);
  assert.equal((await byId("root")).data.content, "a B a\nfim");
});

test("note delete remove o nó e as arestas; destravada só", async () => {
  await put(baseNodes(), baseEdges());
  await ok("maestro", ["note", "delete", "Raiz"]);
  const st = await canvasState();
  assert.ok(!st.nodes.some((n: any) => n.id === "root"));
  assert.ok(!st.edges.some((e: any) => e.source === "root" || e.target === "root"));
});

test("note create: nome pela primeira linha, duplicados, --name fixo e cor", async () => {
  await put(baseNodes(), baseEdges());
  assert.match(await ok("maestro", ["note", "create", "# Plano de voo\ncorpo"]), /Nota "Plano de voo" criada/);
  assert.match(await ok("maestro", ["note", "create", "Plano de voo\noutro"]), /Nota "Plano de voo \(2\)" criada/);
  assert.match(await ok("maestro", ["note", "create", "x", "--name", "Fixa", "--color", "sky"]), /Nota "Fixa" criada/);
  const fixa = await byTitle("Fixa");
  assert.equal(fixa.data.color, "sky");
  assert.equal(fixa.data.pinnedName, true);
  await fail("maestro", ["note", "create", "x", "--color", "magenta"], /Cor inválida/);
  // forma antiga: título + texto
  assert.match(await ok("maestro", ["note", "create", "Ideias", "conteúdo"]), /Nota "Ideias" criada/);
  assert.equal((await byTitle("Ideias")).data.content, "conteúdo");
  // sem conteúdo
  assert.match(await ok("maestro", ["note", "create"]), /Nota "Nova nota" criada/);
});

test("o título acompanha a primeira linha só em nota sem nome fixo", async () => {
  await put(baseNodes(), baseEdges());
  await ok("maestro", ["note", "create", "Primeira"]);
  const out = await ok("maestro", ["note", "write", "Primeira", "Segunda\nmais"]);
  assert.match(out, /renomeada para "Segunda"/);
  assert.ok(await byTitle("Segunda"));
  const out2 = await ok("maestro", ["note", "edit", "Segunda", "Segunda", "Terceira"]);
  assert.match(out2, /renomeada para "Terceira"/);
  await ok("maestro", ["note", "create", "Velha", "--name", "Estável"]);
  const out3 = await ok("maestro", ["note", "write", "Estável", "Outro título"]);
  assert.doesNotMatch(out3, /renomeada/);
  assert.ok(await byTitle("Estável"));
});

test("nota travada: list mostra locked e escrita falha", async () => {
  await put(baseNodes(), baseEdges());
  await fastify.inject({ method: "POST", url: `/api/projects/${P}/canvas`, headers: auth, payload: { nodes: baseNodes().map((n) => (n.id === "root" ? { ...n, data: { ...n.data, locked: true } } : n)), edges: baseEdges() } });
  assert.match(await ok("maestro", ["list"]), /- Raiz \(locked: true\)/);
  for (const a of [["write", "Raiz", "x"], ["append", "Raiz", "x"], ["edit", "Raiz", "linha1", "x"], ["delete", "Raiz"]]) {
    await fail("maestro", ["note", ...a], /travada/);
  }
  assert.match(await ok("maestro", ["note", "read", "Raiz", "1", "1"]), /linha1/);
  assert.ok(await byId("root"));
});

test("cadeia de notas: alcança filhas e netas, list indenta", async () => {
  await put(baseNodes(), baseEdges());
  const l = await ok("maestro", ["list"]);
  assert.match(l, /Notas:\n {2}- Raiz\n {4}- Filha\n {6}- Neta/);
  assert.doesNotMatch(l, /Longe/);
  await ok("maestro", ["note", "write", "Neta", "escrita na neta"]);
  assert.equal((await byId("grand")).data.content, "escrita na neta");
  assert.match(await ok("maestro", ["note", "read", "Filha"]), /filha/);
  await fail("maestro", ["note", "read", "Longe"], /não está conectado/);
  // o Worker não está ligado à cadeia
  await fail("worker", ["note", "read", "Raiz"], /não está conectado/);
});

test("fichários: stack cria, agrupa no list, alcança páginas e unstack libera", async () => {
  await put(baseNodes(), baseEdges());
  assert.match(await ok("maestro", ["note", "stack", "Filha"]), /fichário "Fichário"/);
  const stack = (await canvasState()).nodes.find((n: any) => n.type === "noteStack");
  assert.equal(stack.data.title, "Fichário");
  const child = await byId("child");
  assert.equal(child.data.stackId, stack.id);
  assert.equal(child.hidden, true);
  let l = await ok("maestro", ["list"]);
  assert.match(l, /Fichários:\n {2}- Fichário \(1 página\)\n {6}· Filha/);
  assert.doesNotMatch(l, /Notas:[^]*- Filha/);
  // página alcançável pelo fichário ligado a mim
  await ok("maestro", ["note", "write", "Filha", "na página"]);
  assert.equal((await byId("child")).data.content, "na página");
  // segunda nota no mesmo fichário (por nome) e em outro novo
  await ok("maestro", ["note", "stack", "Neta", "fichário"]);
  assert.equal((await canvasState()).nodes.filter((n: any) => n.type === "noteStack").length, 1);
  await ok("maestro", ["note", "stack", "Raiz", "Outro"]);
  assert.equal((await canvasState()).nodes.filter((n: any) => n.type === "noteStack").length, 2);
  await fail("maestro", ["note", "stack", "Raiz", "Outro"], /já está/);
  // unstack
  assert.match(await ok("maestro", ["note", "unstack", "Filha"]), /tirada do fichário/);
  const freed = await byId("child");
  assert.ok(!freed.data.stackId);
  assert.ok(!freed.hidden);
  l = await ok("maestro", ["list"]);
  assert.match(l, /Notas:\n(?:.*\n)*? {2}- Filha/);
  await fail("maestro", ["note", "unstack", "Filha"], /não está em um fichário/);
});

test("note create --stack cria a nota já no fichário", async () => {
  await put(baseNodes(), baseEdges());
  assert.match(await ok("maestro", ["note", "create", "Item um", "--stack"]), /no fichário "Fichário"/);
  assert.match(await ok("maestro", ["note", "create", "--stack", "Pilha", "Item dois"]), /no fichário "Pilha"/);
  assert.match(await ok("maestro", ["note", "create", "Item três", "--stack", "Pilha"]), /no fichário "Pilha"/);
  const st = await canvasState();
  const pilha = st.nodes.find((n: any) => n.data?.title === "Pilha");
  assert.equal(st.nodes.filter((n: any) => n.data?.stackId === pilha.id).length, 2);
  const l = await ok("maestro", ["list"]);
  assert.match(l, /Pilha \(2 páginas\)/);
  assert.match(l, /Fichário \(1 página\)/);
});

test("arrange: mostra, renomeia a si, nota e (Maestro) colega; restrições", async () => {
  await put(baseNodes(), baseEdges());
  const show = await ok("maestro", ["arrange"]);
  assert.match(show, /Maestro \[agentTerminal\]/);
  assert.match(show, /Raiz \[stickyNote\]/);
  assert.match(show, /Worker \[agentTerminal\]/);
  const help = await ok("maestro", ["arrange", "--help"]);
  assert.match(help, /rocket/);
  assert.match(help, /violet/);

  await ok("maestro", ["arrange", "Maestro", "--icon", "crown", "--color", "orange"]);
  assert.equal((await byId("maestro")).data.icon, "crown");
  await ok("maestro", ["arrange", "Maestro", "--name", "Regente"]);
  assert.equal((await byId("maestro")).data.title, "Regente");
  await ok("maestro", ["arrange", "Regente", "--name", "Maestro"]);

  await ok("maestro", ["arrange", "Raiz", "--name", "Principal", "--color", "rose", "--icon", "book"]);
  const raiz = await byId("root");
  assert.deepEqual([raiz.data.title, raiz.data.color, raiz.data.icon, raiz.data.pinnedName], ["Principal", "rose", "book", true]);

  await ok("maestro", ["arrange", "Worker", "--icon", "bug"]);
  assert.equal((await byId("worker")).data.icon, "bug");

  await fail("maestro", ["arrange", "Principal", "--icon", "naoexiste"], /Ícone inválido/);
  await fail("maestro", ["arrange", "Principal", "--color", "magenta"], /Cor inválida/);
  await fail("maestro", ["arrange", "Principal"], /Informe --name/);
  // não-Maestro não estiliza colega; pode estilizar a si
  await put(baseNodes(), [...baseEdges(), { id: "e9", source: "worker", target: "maestro" }]);
  await fail("worker", ["arrange", "Maestro", "--icon", "bug"], /Apenas o Maestro/);
  await ok("worker", ["arrange", "Worker", "--color", "violet"]);
  assert.equal((await byId("worker")).data.color, "violet");
});

test("notas e fichários criados por um agente de um andar nascem nesse andar", async () => {
  await put(
    [node("maestro", "agentTerminal", 0, { title: "Maestro", isMaestro: true, floor: "Alto" })],
    [],
  );
  await ok("maestro", ["note", "create", "Nota do alto", "--stack", "Pilha"]);
  const st = await canvasState();
  assert.equal(st.nodes.find((n: any) => n.data?.title === "Nota do alto").data.floor, "Alto");
  assert.equal(st.nodes.find((n: any) => n.type === "noteStack").data.floor, "Alto");
  await put(baseNodes(), baseEdges());
  await ok("maestro", ["note", "create", "No térreo"]);
  assert.equal((await byTitle("No térreo")).data.floor, undefined);
});
