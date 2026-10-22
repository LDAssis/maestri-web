import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "maestri-cli-test-"));
process.env.REPO_PATH = repo;
process.env.NODE_ENV = "test";
process.env.MAESTRI_TOKEN = "tok-cli";
process.env.MAESTRI_ASK_QUIET_MS = "700";

const { fastify } = await import("../src/index.js");
const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/maestri");
const P = "proj-maestri-web";
const auth = { authorization: "Bearer tok-cli" };

type Client = WebSocket & { got: any[]; raw: string[]; closeCode?: number };
let port = 0;

function connect(url: string): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${url}`) as Client;
  ws.got = [];
  ws.raw = [];
  ws.on("message", (m) => {
    ws.raw.push(m.toString());
    try {
      ws.got.push(JSON.parse(m.toString()));
    } catch {}
  });
  ws.on("close", (code) => (ws.closeCode = code));
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 6000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) assert.fail(`timeout: ${what}`);
    await sleep(30);
  }
}

// Roda o executável real, como um agente dentro do PTY faria
function maestri(nodeId: string, args: string[], env: Record<string, string> = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      [bin, ...args],
      { env: { ...process.env, MAESTRI_API_URL: `http://127.0.0.1:${port}/api`, MAESTRI_PROJECT_ID: P, MAESTRI_NODE_ID: nodeId, MAESTRI_TOKEN: "tok-cli", ...env } },
      (err, stdout, stderr) => resolve({ code: err ? ((err as any).code ?? 1) : 0, stdout, stderr }),
    );
  });
}

const canvasState = async () => (await fastify.inject({ method: "GET", url: `/api/projects/${P}/canvas`, headers: auth })).json();
const sessionList = async () => (await fastify.inject({ method: "GET", url: `/api/projects/${P}/sessions`, headers: auth })).json();
const nodeByTitle = async (title: string) => (await canvasState()).nodes.find((n: any) => n.data?.title === title);

let worker: Client;
let proj: Client;

before(async () => {
  await fastify.listen({ port: 0, host: "127.0.0.1" });
  port = (fastify.server.address() as any).port;
  const node = (id: string, type: string, x: number, data: object) => ({ id, type, position: { x, y: 0 }, style: { width: 300, height: 200 }, data });
  const res = await fastify.inject({
    method: "POST",
    url: `/api/projects/${P}/canvas`,
    headers: auth,
    payload: {
      nodes: [
        node("maestro", "agentTerminal", 0, { title: "Agente Maestro", isMaestro: true }),
        node("worker", "agentTerminal", 400, { title: "Worker" }),
        node("note1", "stickyNote", 800, { title: "Notas", content: "um" }),
        node("portal1", "portal", 1200, { title: "Preview", url: "http://localhost:3000" }),
        node("stranger", "agentTerminal", 1600, { title: "Estranho" }),
      ],
      edges: [
        { id: "e1", source: "maestro", target: "worker" },
        { id: "e2", source: "note1", target: "maestro" },
        { id: "e3", source: "maestro", target: "portal1" },
        { id: "e4", source: "worker", target: "note1" },
      ],
    },
  });
  assert.equal(res.statusCode, 200);
  worker = await connect(`/ws/terminal?project=${P}&node=worker&token=tok-cli`);
  proj = await connect(`/ws/project/${P}?token=tok-cli&clientId=browser`);
  await until(() => worker.raw.length > 0 && proj.got.length > 0, "sessão e snapshot");
});

after(async () => {
  worker.close();
  proj.close();
  await fastify.close();
  fs.rmSync(repo, { recursive: true, force: true });
});

test("--help funciona sem ambiente do Maestri", async () => {
  const r = await maestri("x", ["--help"], { MAESTRI_API_URL: "", MAESTRI_PROJECT_ID: "", MAESTRI_NODE_ID: "" });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /recruit/);
  const h = await maestri("x", ["ask", "--help"]);
  assert.match(h.stdout, /maestri ask/);
});

test("help geral sem linhas duplicadas e recall documenta o que ignora", async () => {
  const env = { MAESTRI_API_URL: "", MAESTRI_PROJECT_ID: "", MAESTRI_NODE_ID: "" };
  const { stdout } = await maestri("x", ["help"], env);
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  assert.equal(lines.length, new Set(lines).size, "linhas repetidas no help");
  assert.doesNotMatch(stdout, /note read\|write\|append "Nome"/); // linha antiga do núcleo
  assert.equal((stdout.match(/portal navigate/g) ?? []).length, 1);
  assert.equal((stdout.match(/note read\|write\|append\|edit/g) ?? []).length, 1);
  const recall = await maestri("x", ["recall", "--help"], env);
  assert.match(recall.stdout, /progresso/);
  assert.match(recall.stdout, /terminal/);
});

test("context lista os conectados agrupados, sem os não conectados", async () => {
  for (const cmd of ["context", "list"]) {
    const r = await maestri("maestro", [cmd]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Você: Agente Maestro \(Maestro\)/);
    assert.match(r.stdout, /Agentes:\n {2}- Worker/);
    assert.match(r.stdout, /Notas:\n {2}- Notas/);
    assert.match(r.stdout, /Portais:\n {2}- Preview — http:\/\/localhost:3000/);
    assert.doesNotMatch(r.stdout, /Estranho/);
  }
});

test("erros claros: alvo não conectado, inexistente, servidor fora e sem token", async () => {
  const a = await maestri("maestro", ["send", "estranho", "oi"]);
  assert.equal(a.code, 1);
  assert.match(a.stderr, /não está conectado/);
  const b = await maestri("maestro", ["check", "Fantasma"]);
  assert.equal(b.code, 1);
  assert.match(b.stderr, /não encontrado/);
  const c = await maestri("maestro", ["context"], { MAESTRI_API_URL: "http://127.0.0.1:1/api" });
  assert.equal(c.code, 1);
  assert.match(c.stderr, /Não foi possível falar com o servidor/);
  const d = await maestri("maestro", ["context"], { MAESTRI_TOKEN: "" });
  assert.equal(d.code, 1);
  assert.match(d.stderr, /Token/);
});

test("o PTY recebe o ambiente do CLI e o maestri do web vence no PATH", async () => {
  worker.send("echo ENV[$MAESTRI_NODE_ID][$MAESTRI_PROJECT_ID][$(command -v maestri)]\r");
  await until(() => worker.raw.join("").includes(`ENV[worker][${P}][${path.resolve(path.dirname(bin))}/maestri]`), "env no PTY");
  worker.send("echo URL=$MAESTRI_API_URL TOK=$MAESTRI_TOKEN\r");
  await until(() => worker.raw.join("").includes(`URL=http://127.0.0.1:${port}/api TOK=tok-cli`), "api url/token no PTY");
});

test("send escreve no PTY do alvo e check devolve o scrollback sem ANSI", async () => {
  const s = await maestri("maestro", ["send", "worker", "echo SEND$((1+2))"]);
  assert.equal(s.code, 0, s.stderr);
  let out = "";
  await until(async () => {
    out = (await maestri("maestro", ["check", "WORKER", "--lines", "20"])).stdout;
    return out.includes("SEND3");
  }, "check mostra SEND3");
  assert.doesNotMatch(out, /\x1b/);
  assert.ok(out.split("\n").length <= 20);
});

test("ask espera o PTY ficar quieto e devolve só a saída nova", async () => {
  const r = await maestri("maestro", ["ask", "Worker", "echo ASK$((4+5))"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /ASK9/);
  assert.doesNotMatch(r.stdout, /SEND3/);
  assert.doesNotMatch(r.stdout, /\x1b/);
});

test("ask com timeout curto imprime o parcial e sai com 2", async () => {
  const r = await maestri("maestro", ["ask", "Worker", "for i in 1 2 3 4 5 6; do echo T$i; sleep 0.4; done", "--timeout", "1"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Timeout/);
  assert.match(r.stdout, /T1/);
});

test("note write propaga pelo WS de projeto; append e read", async () => {
  const before = proj.got.length;
  const w = await maestri("maestro", ["note", "write", "notas", "novo texto"]);
  assert.equal(w.code, 0, w.stderr);
  await until(() => proj.got.length > before, "op no WS");
  const msg = proj.got.at(-1);
  assert.equal(msg.type, "op");
  assert.equal(msg.from, "cli:maestro");
  assert.deepEqual(msg.op, { kind: "patchNodeData", id: "note1", data: { content: "novo texto" } });
  await maestri("maestro", ["note", "append", "Notas", "mais"]);
  const r = await maestri("maestro", ["note", "read", "Notas"]);
  assert.equal(r.stdout, "   1| novo texto\n   2| mais\n");
});

test("note create cria a nota perto do nó, sem sobrepor, conectada a ele", async () => {
  const r = await maestri("maestro", ["note", "create", "Ideias", "conteúdo"]);
  assert.equal(r.code, 0, r.stderr);
  const st = await canvasState();
  const n = st.nodes.find((x: any) => x.data?.title === "Ideias");
  assert.equal(n.type, "stickyNote");
  assert.equal(n.data.content, "conteúdo");
  assert.ok(st.edges.some((e: any) => [e.source, e.target].sort().join() === ["maestro", n.id].sort().join()));
  for (const o of st.nodes.filter((x: any) => x.id !== n.id)) {
    const w = Number(o.style?.width) || 300;
    const h = Number(o.style?.height) || 200;
    const overlap = n.position.x < o.position.x + w && o.position.x < n.position.x + 280 && n.position.y < o.position.y + h && o.position.y < n.position.y + 200;
    assert.equal(overlap, false, `sobrepõe ${o.id}`);
  }
});

test("portal navigate valida http/https", async () => {
  const ok = await maestri("maestro", ["portal", "navigate", "Preview", "https://example.com/a"]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal((await nodeByTitle("Preview")).data.url, "https://example.com/a");
  const bad = await maestri("maestro", ["portal", "navigate", "Preview", "javascript:alert(1)"]);
  assert.equal(bad.code, 1);
  assert.equal((await nodeByTitle("Preview")).data.url, "https://example.com/a");
});

test("notify chega ao WS de projeto com o título do emissor", async () => {
  const r = await maestri("maestro", ["notify", "build", "pronto"]);
  assert.equal(r.code, 0, r.stderr);
  await until(() => proj.got.some((m) => m.type === "notify"), "notify no WS");
  assert.deepEqual(proj.got.find((m) => m.type === "notify"), { type: "notify", from: { nodeId: "maestro", title: "Agente Maestro" }, text: "build pronto" });
});

test("recruit e dismiss são negados para quem não é Maestro", async () => {
  const a = await maestri("worker", ["recruit", "Intruso"]);
  assert.equal(a.code, 1);
  assert.match(a.stderr, /Apenas o Maestro pode recrutar/);
  const b = await maestri("worker", ["dismiss", "Notas"]);
  assert.equal(b.code, 1);
  assert.match(b.stderr, /Apenas o Maestro/);
  assert.equal(await nodeByTitle("Intruso"), undefined);
});

test("recruit (Maestro) cria nó, aresta, sessão iniciada e papel em arquivo; dismiss mata a sessão", async () => {
  const r = await maestri("maestro", ["recruit", "Novato", "--cmd", "echo RECRUIT$((1+1))", "--role", "Revisor de testes"]);
  assert.equal(r.code, 0, r.stderr);
  const st = await canvasState();
  const n = st.nodes.find((x: any) => x.data?.title === "Novato");
  assert.equal(n.type, "agentTerminal");
  assert.equal(n.data.role, "Revisor de testes");
  assert.equal(n.data.defaultCmd, "echo RECRUIT$((1+1))");
  assert.ok(st.edges.some((e: any) => e.source === "maestro" && e.target === n.id));
  assert.equal(fs.readFileSync(path.join(repo, ".maestri-roles", `${n.id}.md`), "utf-8"), "Revisor de testes");

  const [sess] = (await sessionList()).filter((s: any) => s.nodeId === n.id);
  assert.ok(sess, "sessão iniciada sem navegador");
  await until(async () => (await maestri("maestro", ["check", "Novato"])).stdout.includes("RECRUIT2"), "cmd executado na sessão");

  const d = await maestri("maestro", ["dismiss", "Novato"]);
  assert.equal(d.code, 0, d.stderr);
  assert.equal(await nodeByTitle("Novato"), undefined);
  await until(async () => !(await sessionList()).some((s: any) => s.nodeId === n.id), "sessão encerrada");
  await until(() => {
    try {
      process.kill(sess.pid, 0);
      return false;
    } catch {
      return true;
    }
  }, "PTY morto");
});

test("recruit com claude+role passa o papel por arquivo, nunca interpolado no comando", async () => {
  const role = 'x"; rm -rf /; echo "$(whoami)';
  const r = await maestri("maestro", ["recruit", "Seguro", "--cmd", "claude", "--role", role]);
  assert.equal(r.code, 0, r.stderr);
  const n = await nodeByTitle("Seguro");
  assert.equal(n.data.defaultCmd, `claude "$(cat '${path.join(repo, ".maestri-roles", `${n.id}.md`)}')"`);
  assert.equal(n.data.role, role); // curto o bastante para virar o papel exibido
  assert.equal(fs.readFileSync(path.join(repo, ".maestri-roles", `${n.id}.md`), "utf-8"), role);
  await maestri("maestro", ["dismiss", "Seguro"]); // antes dos 600ms do cmd inicial
});
