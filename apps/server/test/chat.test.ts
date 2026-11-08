import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { rmTmp } from "./rmtmp.js";

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "maestri-chat-test-"));
process.env.REPO_PATH = repo;
process.env.NODE_ENV = "test";
process.env.MAESTRI_TOKEN = "tok-chat";
process.env.MAESTRI_ASK_QUIET_MS = "600";

const { fastify } = await import("../src/index.js");
const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/maestri");
const P = "proj-maestri-web";
const auth = { authorization: "Bearer tok-chat" };
const author = { id: "u1", name: "Bruno", color: "#3b82f6" };

type Client = WebSocket & { raw: string[]; got: any[] };
let port = 0;

function connect(url: string): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${url}`) as Client;
  ws.raw = [];
  ws.got = [];
  ws.on("message", (m) => {
    ws.raw.push(m.toString());
    try {
      ws.got.push(JSON.parse(m.toString()));
    } catch {}
  });
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 8000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) assert.fail(`timeout: ${what}`);
    await sleep(30);
  }
}

const chatUrl = (node: string, sub = "") => `/api/projects/${P}/nodes/${node}/chat${sub}`;
const send = (node: string, text: string, a: object | null = author) =>
  fastify.inject({ method: "POST", url: chatUrl(node), headers: auth, payload: { text, author: a } });
const history = async (node: string, last = 200) => (await fastify.inject({ method: "GET", url: chatUrl(node, `?last=${last}`), headers: auth })).json().messages;
const nodeData = async (id: string) => (await fastify.inject({ method: "GET", url: `/api/projects/${P}/canvas`, headers: auth })).json().nodes.find((n: any) => n.id === id).data;

function maestri(nodeId: string, args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      [bin, ...args],
      { env: { ...process.env, MAESTRI_API_URL: `http://127.0.0.1:${port}/api`, MAESTRI_PROJECT_ID: P, MAESTRI_NODE_ID: nodeId, MAESTRI_TOKEN: "tok-chat" } },
      (err, stdout, stderr) => resolve({ code: err ? ((err as any).code ?? 1) : 0, stdout, stderr }),
    );
  });
}

let agent: Client;
let proj: Client;

before(async () => {
  await fastify.listen({ port: 0, host: "127.0.0.1" });
  port = (fastify.server.address() as any).port;
  const node = (id: string, type: string, x: number, data: object) => ({ id, type, position: { x, y: 0 }, data });
  const res = await fastify.inject({
    method: "POST",
    url: `/api/projects/${P}/canvas`,
    headers: auth,
    payload: {
      nodes: [
        node("agent", "agentTerminal", 0, { title: "Agente Chat" }),
        node("idle", "agentTerminal", 400, { title: "Sem Sessão" }),
        node("peer", "agentTerminal", 800, { title: "Parceiro" }),
        node("note", "stickyNote", 1200, { title: "Notas de Arquitetura", content: "x" }),
      ],
      edges: [
        { id: "e1", source: "note", target: "agent" },
        { id: "e2", source: "agent", target: "peer" },
      ],
    },
  });
  assert.equal(res.statusCode, 200);
  agent = await connect(`/ws/terminal?project=${P}&node=agent&token=tok-chat`);
  // PTY de 80 colunas + prompt longo: o readline quebra a linha ecoada com retorno de carro e os testes que casam texto no eco falham
  agent.send(JSON.stringify({ type: "resize", cols: 500, rows: 24 }));
  proj = await connect(`/ws/project/${P}?token=tok-chat&clientId=browser`);
  await until(() => agent.raw.length > 0 && proj.got.length > 0, "sessão e snapshot");
  // Espera o shell executar um comando de verdade: antes disso só o eco do tty chega e a captura (quiet 600ms) encerra sem a saída
  agent.send("echo PRONTO$((1+1))\r");
  await until(() => agent.raw.join("").includes("PRONTO2"), "shell pronto", 20000);
  for (let n = agent.raw.length, quiet = 0; quiet < 800; ) {
    await sleep(100);
    quiet = agent.raw.length === n ? quiet + 100 : 0;
    n = agent.raw.length;
  }
});

after(async () => {
  agent.close();
  proj.close();
  await fastify.close();
  rmTmp(repo);
});

test("envio grava user, marca chatBusy, responde 202, captura a saída e grava terminal", async () => {
  const res = await send("agent", "echo CHAT$((20+22))");
  assert.equal(res.statusCode, 202);
  let h = await history("agent");
  assert.equal(h[0].role, "user");
  assert.equal(h[0].text, "echo CHAT$((20+22))");
  assert.deepEqual(h[0].author, author);
  assert.ok(h[0].id && h[0].at);
  assert.equal((await nodeData("agent")).chatBusy, true);

  await until(async () => (await history("agent")).some((m: any) => m.role === "terminal"), "mensagem terminal");
  h = await history("agent");
  const term = h.find((m: any) => m.role === "terminal");
  assert.match(term.text, /CHAT42/);
  assert.doesNotMatch(term.text, /\x1b/);
  await until(async () => (await nodeData("agent")).chatBusy === false, "chatBusy false");

  // os navegadores recebem por patchNodeData
  // (o WS entrega depois da mudança de estado: espera chegar)
  const chatOps = () => proj.got.filter((m) => m.type === "op" && m.op.kind === "patchNodeData" && m.op.id === "agent" && m.op.data.chat);
  await until(() => chatOps().length >= 2 && chatOps().at(-1).op.data.chat.at(-1).role === "terminal", "ops de chat no WS");
});

test("409 sem sessão ativa e 409 quando o agente está ocupado", async () => {
  const none = await send("idle", "oi");
  assert.equal(none.statusCode, 409);
  assert.match(none.json().error, /sess/i);

  const first = await send("agent", "echo A$((1+1))");
  assert.equal(first.statusCode, 202);
  const second = await send("agent", "echo B");
  assert.equal(second.statusCode, 409);
  assert.match(second.json().error, /ocupado/);
  await until(async () => (await nodeData("agent")).chatBusy === false, "captura termina");
  assert.equal((await send("agent", "echo C$((1+1))")).statusCode, 202);
  await until(async () => (await nodeData("agent")).chatBusy === false, "captura termina");
});

test("valida texto e autor; chat só em nós de agente", async () => {
  assert.equal((await send("agent", "  ")).statusCode, 400);
  assert.equal((await send("agent", "oi", { id: "u", name: "x", color: "azul" })).statusCode, 400);
  assert.equal((await send("agent", "oi", null)).statusCode, 400);
  const r = await fastify.inject({ method: "GET", url: chatUrl("note"), headers: auth });
  assert.equal(r.statusCode, 400);
});

test("menção vira dica no PTY mas o histórico guarda o texto original", async () => {
  const text = "echo MENCAO leia @Notas de Arquitetura e fale com @parceiro";
  const before = agent.raw.length;
  assert.equal((await send("agent", text)).statusCode, 202);
  await until(() => agent.raw.slice(before).join("").includes('maestri ask "Parceiro"'), "dica no PTY");
  const pty = agent.raw.slice(before).join("");
  assert.ok(pty.includes('@Notas de Arquitetura (use: maestri note read "Notas de Arquitetura")'));
  assert.ok(pty.includes('@parceiro (use: maestri ask "Parceiro" ...)'));
  const h = await history("agent");
  assert.equal(h.filter((m: any) => m.role === "user").at(-1).text, text);
  assert.ok(!h.filter((m: any) => m.role === "user").at(-1).text.includes("(use:"));
  await until(async () => (await nodeData("agent")).chatBusy === false, "captura termina");
});

test("chat reply grava agent e history lista (CLI real)", async () => {
  const r = await maestri("agent", ["chat", "reply", "**Pronto**\n\n- a\n- b"]);
  assert.equal(r.code, 0, r.stderr);
  const h = await history("agent");
  assert.deepEqual({ role: h.at(-1).role, text: h.at(-1).text }, { role: "agent", text: "**Pronto**\n\n- a\n- b" });

  const hist = await maestri("agent", ["chat", "history", "--last", "2"]);
  assert.equal(hist.code, 0, hist.stderr);
  assert.match(hist.stdout, /agente: \*\*Pronto\*\*/);
  assert.equal(hist.stdout.split("] ").length - 1, 2);
  const bad = await maestri("agent", ["chat", "reply"]);
  assert.equal(bad.code, 1);
});

test("DELETE limpa o histórico e o limite de 200 descarta as mais antigas", async () => {
  const del = await fastify.inject({ method: "DELETE", url: chatUrl("agent"), headers: auth });
  assert.equal(del.statusCode, 200);
  assert.deepEqual(await history("agent"), []);
  for (let i = 0; i < 205; i++) {
    const r = await fastify.inject({ method: "POST", url: chatUrl("agent", "/reply"), headers: auth, payload: { text: `m${i}` } });
    assert.equal(r.statusCode, 200);
  }
  const h = await history("agent");
  assert.equal(h.length, 200);
  assert.equal(h[0].text, "m5");
  assert.equal(h.at(-1).text, "m204");
});

test("o histórico é persistido no canvas", async () => {
  const file = path.join(repo, ".maestri_data", `canvas_${P}.json`);
  await until(() => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf-8")).nodes.find((n: any) => n.id === "agent").data.chat.length === 200;
    } catch {
      return false;
    }
  }, "persistido", 3000);
});
