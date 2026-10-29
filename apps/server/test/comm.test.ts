import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { rmTmp } from "./rmtmp.js";

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "maestri-comm-test-"));
process.env.REPO_PATH = repo;
process.env.NODE_ENV = "test";
process.env.MAESTRI_TOKEN = "tok-comm";
process.env.MAESTRI_ASK_QUIET_MS = "600";

const { fastify } = await import("../src/index.js");
const { decodeEscapes, recall } = await import("../src/commApi.js");
const { chatHeader, wantsChatHeader, currentThread, THREADS } = await import("../src/chatThreads.js");
const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/maestri");
const P = "proj-maestri-web";
const auth = { authorization: "Bearer tok-comm" };

type Client = WebSocket & { raw: string[] };
let port = 0;

function connect(url: string): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${url}`) as Client;
  ws.raw = [];
  ws.on("message", (m) => ws.raw.push(m.toString()));
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 20000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) assert.fail(`timeout: ${what}`);
    await sleep(30);
  }
}

function maestri(nodeId: string, args: string[], env: Record<string, string> = {}, stdin?: string) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(
      process.execPath,
      [bin, ...args],
      { env: { ...process.env, MAESTRI_API_URL: `http://127.0.0.1:${port}/api`, MAESTRI_PROJECT_ID: P, MAESTRI_NODE_ID: nodeId, MAESTRI_TOKEN: "tok-comm", ...env } },
      (err, stdout, stderr) => resolve({ code: err ? ((err as any).code ?? 1) : 0, stdout, stderr }),
    );
    child.stdin?.end(stdin ?? "");
  });
}

const nodeData = async (id: string) => (await fastify.inject({ method: "GET", url: `/api/projects/${P}/canvas`, headers: auth })).json().nodes.find((n: any) => n.id === id).data;

// Histórico semeado em datas relativas a agora
const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const H = 3_600_000;
const D = 24 * H;
let n = 0;
const msg = (role: string, text: string, at: string, extra: object = {}) => ({ id: `m${++n}`, role, text, at, ...extra });
const seeded = [
  msg("user", "velha", ago(40 * D)), // sem thread = blue
  msg("agent", "resposta velha", ago(40 * D - 1000)),
  msg("user", "semana", ago(3 * D), { thread: "blue" }),
  msg("agent", "resp semana", ago(3 * D - 1000), { thread: "blue" }),
  msg("terminal", "saída crua", ago(3 * D - 2000), { thread: "blue" }),
  msg("user", "roxa 1", ago(2 * H), { thread: "purple" }),
  msg("agent", "parcial", ago(2 * H - 1000), { thread: "purple", progress: true }),
  msg("agent", "roxa resp", ago(2 * H - 2000), { thread: "purple" }),
  msg("user", "roxa 2", ago(1 * H), { thread: "purple" }),
];

let w1: Client;
let w2: Client;
let boss: Client;

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
        node("boss", "agentTerminal", 0, { title: "Chefe", isMaestro: true }),
        node("w1", "agentTerminal", 400, { title: "Um" }),
        node("w2", "agentTerminal", 800, { title: "Dois" }),
        node("hist", "agentTerminal", 1200, { title: "Historiador", chat: seeded }),
        node("note", "stickyNote", 1600, { title: "Nota", content: "x" }),
      ],
      edges: [
        { id: "e1", source: "boss", target: "w1" },
        { id: "e2", source: "boss", target: "w2" },
        { id: "e3", source: "boss", target: "hist" },
      ],
    },
  });
  assert.equal(res.statusCode, 200);
  boss = await connect(`/ws/terminal?project=${P}&node=boss&token=tok-comm`);
  w1 = await connect(`/ws/terminal?project=${P}&node=w1&token=tok-comm`);
  w2 = await connect(`/ws/terminal?project=${P}&node=w2&token=tok-comm`);
  // Espera cada shell executar de verdade antes dos asks (só o eco do tty chega antes disso)
  for (const [c, tag] of [[w1, "R1"], [w2, "R2"]] as const) {
    c.send(`echo ${tag}$((1+1))\r`);
    await until(() => c.raw.join("").includes(`${tag}2`), `shell ${tag} pronto`);
  }
  await sleep(1000);
});

after(async () => {
  boss.close();
  w1.close();
  w2.close();
  await fastify.close();
  rmTmp(repo);
});

test("decodeEscapes: \\n=Enter(CR), \\t, \\e, \\xNN, \\\\ e desconhecidos literais", () => {
  assert.equal(decodeEscapes("2\\n"), "2\r");
  assert.equal(decodeEscapes("a\\tb"), "a\tb");
  assert.equal(decodeEscapes("\\e[A"), "\x1b[A");
  assert.equal(decodeEscapes("\\x41\\x1b"), "A\x1b");
  assert.equal(decodeEscapes("a\\\\n"), "a\\n");
  assert.equal(decodeEscapes("\\q \\x4"), "\\q \\x4");
});

test("ask --raw envia a entrada crua e imprime a saída", async () => {
  const r = await maestri("boss", ["ask", "Um", "--raw", "echo RAW$((3+4)) \\x41\\x42\\n"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /RAW7 AB/);
});

test("send --raw escreve sem esperar; sem alvo conectado dá erro", async () => {
  const r = await maestri("boss", ["send", "Dois", "--raw", "echo SENDRAW$((5+5))\\n"]);
  assert.equal(r.code, 0, r.stderr);
  await until(() => w2.raw.join("").includes("SENDRAW10"), "saída do send --raw");
  const bad = await maestri("boss", ["ask", "Nota", "--raw", "x"]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /não encontrado|tipo agentTerminal/);
});

test("ask --batch: paralelo, array JSON {name, output} e erros por item", async () => {
  const t = Date.now();
  const r = await maestri("boss", ["ask", "--batch", JSON.stringify({ Um: "echo BA$((10+1))", Dois: "echo BB$((20+2))" })]);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.map((x: any) => x.name), ["Um", "Dois"]);
  assert.match(out[0].output, /BA11/);
  assert.match(out[1].output, /BB22/);
  assert.ok(Date.now() - t < 9000, "executou em paralelo");

  const mixed = await maestri("boss", ["ask", "--batch", JSON.stringify({ Um: "echo OK$((1+1))", Fantasma: "oi" })]);
  assert.equal(mixed.code, 1);
  const m = JSON.parse(mixed.stdout);
  assert.match(m[0].output, /OK2/);
  assert.equal(m[1].name, "Fantasma");
  assert.match(m[1].error, /não encontrado/);
});

test("ask --batch valida o JSON e exige agentes distintos", async () => {
  for (const arg of ["não-json", "[]", "{}", '{"A":1}', '{"Um":"a","um":"b"}']) {
    const r = await maestri("boss", ["ask", "--batch", arg]);
    assert.equal(r.code, 1, arg);
    assert.match(r.stderr, /--batch/);
  }
});

test("ask --batch respeita --timeout (item marcado timedOut, código 2)", async () => {
  const r = await maestri("boss", ["ask", "--batch", JSON.stringify({ Um: "for i in 1 2 3 4 5 6 7 8; do echo T$i; sleep 0.3; done" }), "--timeout", "1"]);
  assert.equal(r.code, 2, r.stderr);
  assert.equal(JSON.parse(r.stdout)[0].timedOut, true);
  await sleep(3000); // deixa o laço terminar para não sujar os próximos testes
});

test("say responde na thread atual; --progress marca balão intermediário; stdin e --file", async () => {
  const r = await maestri("hist", ["say", "**pronto** com `md`"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /thread purple/);
  const p = await maestri("hist", ["say", "--progress", "trabalhando..."]);
  assert.equal(p.code, 0, p.stderr);
  const s = await maestri("hist", ["say"], {}, "via\nheredoc\n");
  assert.equal(s.code, 0, s.stderr);
  const f = path.join(repo, "resp.txt");
  fs.writeFileSync(f, "do arquivo ✓");
  assert.equal((await maestri("hist", ["say", "--file", f])).code, 0);

  const chat = (await nodeData("hist")).chat;
  const tail = chat.slice(-4);
  assert.deepEqual(tail.map((m: any) => m.thread), ["purple", "purple", "purple", "purple"]);
  assert.deepEqual(tail.map((m: any) => m.role), ["agent", "agent", "agent", "agent"]);
  assert.equal(tail[0].text, "**pronto** com `md`");
  assert.equal(tail[1].progress, true);
  assert.equal(tail[0].progress, undefined);
  assert.equal(tail[2].text, "via\nheredoc\n");
  assert.equal(tail[3].text, "do arquivo ✓");

  assert.equal((await maestri("hist", ["say", "   "])).code, 1);
  assert.equal((await maestri("note", ["say", "x"])).code, 1); // nó de nota não tem chat
});

test("chat reply continua funcionando (alias) e herda a thread", async () => {
  const r = await maestri("hist", ["chat", "reply", "alias ok"]);
  assert.equal(r.code, 0, r.stderr);
  const last = (await nodeData("hist")).chat.at(-1);
  assert.equal(last.text, "alias ok");
  assert.equal(last.thread, "purple");
});

test("POST /chat guarda a thread, rejeita inválida e responde na mesma thread", async () => {
  const body = (thread?: string) => ({ text: "echo TH$((1+1))", author: { id: "u1", name: "B", color: "#3b82f6" }, ...(thread && { thread }) });
  const url = `/api/projects/${P}/nodes/w1/chat`;
  const bad = await fastify.inject({ method: "POST", url, headers: auth, payload: body("magenta") });
  assert.equal(bad.statusCode, 400);
  const ok = await fastify.inject({ method: "POST", url, headers: auth, payload: body("red") });
  assert.equal(ok.statusCode, 202);
  await until(async () => (await nodeData("w1")).chatBusy === false, "chat livre");
  const chat = (await nodeData("w1")).chat;
  assert.equal(chat[0].thread, "red");
  assert.equal(chat.find((m: any) => m.role === "terminal").thread, "red");
  // sem thread = blue
  await until(async () => (await fastify.inject({ method: "POST", url, headers: auth, payload: body() })).statusCode === 202, "reenvio");
  await until(async () => (await nodeData("w1")).chatBusy === false, "chat livre 2");
  assert.equal((await nodeData("w1")).chat.filter((m: any) => m.role === "user").at(-1).thread, "blue");
  assert.equal((await maestri("w1", ["say", "r"])).stdout.includes("thread blue"), true);
});

test("cabeçalho do Maestri Chat: formato e só com programa em primeiro plano", () => {
  assert.equal(THREADS.length, 7);
  const h = chatHeader("green");
  assert.match(h, /^---\nBelow is a message from the user through Maestri Chat\.\nReply only via `maestri say`\./);
  assert.match(h, /\nthread: green\n---\n$/);
  const fg = (process: string) => ({ pty: { process } }) as any;
  assert.equal(wantsChatHeader(fg("bash")), false);
  assert.equal(wantsChatHeader(fg("-zsh")), false);
  assert.equal(wantsChatHeader(fg("claude")), true);
  assert.equal(wantsChatHeader(fg("/usr/bin/node")), true);
});

test("recall: filtros turns, last, from/to, all, thread e legado = blue", () => {
  const chat = seeded as any[];
  assert.equal(currentThread(chat), "purple");
  // padrão: thread atual (purple), sem progress nem terminal
  let r = recall(chat, {}, NOW);
  assert.equal(r.thread, "purple");
  assert.deepEqual(r.messages.map((m) => m.text), ["roxa 1", "roxa resp", "roxa 2"]);
  // turns = turnos a partir da mensagem do usuário
  assert.deepEqual(recall(chat, { turns: "1" }, NOW).messages.map((m) => m.text), ["roxa 2"]);
  // blue inclui a mensagem legada sem thread, nunca o terminal
  r = recall(chat, { thread: "blue", all: "true" }, NOW);
  assert.deepEqual(r.messages.map((m) => m.text), ["velha", "resposta velha", "semana", "resp semana"]);
  assert.deepEqual(recall(chat, { thread: "blue", last: "week" }, NOW).messages.map((m) => m.text), ["semana", "resp semana"]);
  assert.equal(recall(chat, { thread: "blue", last: "month" }, NOW).messages.length, 2);
  assert.equal(recall(chat, { thread: "purple", last: "day" }, NOW).messages.length, 3);
  const day = (ms: number) => { const d = new Date(NOW - ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  assert.deepEqual(recall(chat, { thread: "blue", from: day(3 * D), to: day(3 * D) }, NOW).messages.map((m) => m.text), ["semana", "resp semana"]);
  assert.equal(recall(chat, { thread: "blue", from: day(50 * D), to: day(10 * D) }, NOW).messages.length, 2);
  assert.equal(recall(chat, { thread: "blue", from: day(1 * D) }, NOW).messages.length, 0);
  // erros
  for (const q of [{ thread: "x" }, { turns: "0" }, { last: "year" }, { from: "ontem" }, { to: "2026-01-01" }, { turns: "2", all: "true" }]) {
    assert.throws(() => recall(chat, q, NOW), /400|inválid|Use|exige|aceita|Datas|turns/i, JSON.stringify(q));
  }
});

test("recall pelo CLI: texto, --json, thread e recall list", async () => {
  const t = await maestri("hist", ["recall", "blue", "--last", "week"]);
  assert.equal(t.code, 0, t.stderr);
  assert.match(t.stdout, /# thread blue/);
  assert.match(t.stdout, /semana/);
  assert.doesNotMatch(t.stdout, /velha/);
  const j = await maestri("hist", ["recall", "blue", "--all", "--json"]);
  assert.equal(JSON.parse(j.stdout).messages.length, 4);
  const cur = await maestri("hist", ["recall", "--turns", "1", "--json"]);
  assert.equal(JSON.parse(cur.stdout).thread, "purple");
  const l = await maestri("hist", ["recall", "list"]);
  assert.match(l.stdout, /blue: 4 mensagens/);
  assert.match(l.stdout, /purple \*: \d+ mensagens/);
  assert.match(l.stdout, /green: 0 mensagens/);
  const bad = await maestri("hist", ["recall", "roxo"]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /Thread inválida/);
  assert.equal((await maestri("hist", ["recall", "--from", "x"])).code, 1);
});

test("debug: tudo certo = 0; env ausente, API fora e nó inexistente = 1", async () => {
  const ok = await maestri("boss", ["debug"]);
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /✓ MAESTRI_API_URL/);
  assert.match(ok.stdout, /✓ API responde/);
  assert.match(ok.stdout, /✓ Nó existe no canvas — Chefe/);
  assert.match(ok.stdout, /✓ Sessão ativa/);
  assert.match(ok.stdout, /Maestro: sim/);
  assert.doesNotMatch(ok.stdout, /tok-comm/);

  const w = await maestri("w1", ["debug"]);
  assert.match(w.stdout, /Maestro: não/);

  const noSession = await maestri("hist", ["debug"]);
  assert.equal(noSession.code, 1);
  assert.match(noSession.stdout, /✗ Sessão ativa/);

  const ghost = await maestri("fantasma", ["debug"]);
  assert.equal(ghost.code, 1);
  assert.match(ghost.stdout, /✗ Nó existe no canvas/);

  const noEnv = await maestri("boss", ["debug"], { MAESTRI_API_URL: "", MAESTRI_PROJECT_ID: "", MAESTRI_NODE_ID: "", MAESTRI_TOKEN: "" });
  assert.equal(noEnv.code, 1);
  assert.match(noEnv.stdout, /✗ MAESTRI_API_URL — ausente/);

  const down = await maestri("boss", ["debug"], { MAESTRI_API_URL: "http://127.0.0.1:1/api" });
  assert.equal(down.code, 1);
  assert.match(down.stdout, /✗ API responde/);
});

test("help geral e por comando listam os comandos novos", async () => {
  const g = await maestri("boss", ["help"]);
  for (const w of ["--batch", "--raw", "say", "recall", "debug"]) assert.ok(g.stdout.includes(w), w);
  for (const c of ["ask", "send", "say", "recall", "debug"]) {
    const h = await maestri("boss", [c, "--help"], { MAESTRI_API_URL: "", MAESTRI_PROJECT_ID: "", MAESTRI_NODE_ID: "" });
    assert.equal(h.code, 0);
    assert.match(h.stdout, new RegExp(`maestri ${c}`));
  }
});
