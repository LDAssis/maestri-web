import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { rmTmp } from "./rmtmp.js";

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "maestri-rt-test-"));
process.env.REPO_PATH = repo;
process.env.NODE_ENV = "test";
delete process.env.MAESTRI_TOKEN;

const { fastify } = await import("../src/index.js");
const P = "proj-maestri-web";

type Client = WebSocket & { got: string[]; closeCode?: number };

let base = "";

// Socket real (não injectWS): as mensagens enviadas na conexão não se perdem antes dos listeners
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

const term = (node: string, extra = "") => `/ws/terminal?project=${P}&node=${node}${extra}`;
const sessionList = async () => (await fastify.inject({ method: "GET", url: `/api/projects/${P}/sessions` })).json();

before(async () => {
  await fastify.listen({ port: 0, host: "127.0.0.1" });
  base = `ws://127.0.0.1:${(fastify.server.address() as any).port}`;
});

after(async () => {
  await fastify.close();
  rmTmp(repo);
});

test("terminal sem project/node válidos fecha com 4400", async () => {
  for (const url of ["/ws/terminal", "/ws/terminal?project=proj-nope&node=n1", `/ws/terminal?project=${P}&node=a.b`]) {
    const ws = await fastify.injectWS(url);
    const code = await new Promise<number>((resolve) => ws.on("close", resolve));
    assert.equal(code, 4400, url);
  }
});

test("dois clientes na mesma sessão recebem a saída; reconectar recebe scrollback sem reexecutar cmd", async () => {
  const cmd = encodeURIComponent("echo MARK$((20+22))");
  const a = await connect(term("n-share", `&cmd=${cmd}`));
  const b = await connect(term("n-share", `&cmd=${cmd}`));
  await until(() => a.got.join("").includes("MARK42") && b.got.join("").includes("MARK42"), "ambos recebem MARK42");
  assert.equal((await sessionList()).filter((s: any) => s.nodeId === "n-share")[0].clients, 2);

  // entrada de um cliente vai para o PTY e a saída chega aos dois
  b.send("echo FROMB$((1+1))\r");
  await until(() => a.got.join("").includes("FROMB2"), "saída da entrada de B chega a A");

  a.close();
  b.close();
  const c = await connect(term("n-share", `&cmd=${cmd}`));
  await until(() => c.got.join("").includes("MARK42"), "scrollback na reconexão");
  await new Promise((r) => setTimeout(r, 1000));
  const all = c.got.join("");
  assert.equal(all.split("MARK42").length - 1, 1, "cmd não foi reexecutado");
  assert.ok(all.includes("FROMB2"));
  c.close();
});

test("DELETE da sessão mata o PTY, fecha os clientes com 4000 e remove do registro", async () => {
  const a = await connect(term("n-del"));
  await until(() => a.got.length > 0, "sessão ativa");
  const [s] = (await sessionList()).filter((x: any) => x.nodeId === "n-del");
  assert.ok(alive(s.pid));

  const res = await fastify.inject({ method: "DELETE", url: `/api/projects/${P}/sessions/n-del` });
  assert.equal(res.statusCode, 200);
  await until(() => a.closeCode === 4000, "cliente fechado com 4000");
  await until(() => !alive(s.pid), "PTY morto");
  assert.equal((await sessionList()).some((x: any) => x.nodeId === "n-del"), false);
  const again = await fastify.inject({ method: "DELETE", url: `/api/projects/${P}/sessions/n-del` });
  assert.equal(again.statusCode, 404);
});

test("restart recria o PTY e mantém os clientes anexados", async () => {
  const a = await connect(term("n-rs"));
  await until(() => a.got.length > 0, "sessão ativa");
  const [before] = (await sessionList()).filter((x: any) => x.nodeId === "n-rs");
  const res = await fastify.inject({ method: "POST", url: `/api/projects/${P}/sessions/n-rs/restart` });
  assert.equal(res.statusCode, 200);
  const [after] = (await sessionList()).filter((x: any) => x.nodeId === "n-rs");
  assert.notEqual(after.pid, before.pid);
  assert.equal(after.clients, 1);
  await until(() => !alive(before.pid), "PTY antigo morto");
  a.send("echo AFTER$((3+4))\r");
  await until(() => a.got.join("").includes("AFTER7"), "saída do novo PTY chega ao cliente");
  a.close();
});

test("canvas: snapshot inicial, op chega ao outro cliente com rev incrementado, erro só ao emissor", async () => {
  const a = await connect(`/ws/project/${P}?clientId=ca`);
  const b = await connect(`/ws/project/${P}?clientId=cb`);
  await until(() => a.got.length > 0 && b.got.length > 0, "snapshots");
  const snap = JSON.parse(a.got[0]);
  assert.equal(snap.type, "snapshot");
  assert.equal(snap.nodes, null);
  assert.equal(snap.rev, 0);

  a.send(JSON.stringify({ type: "op", op: { kind: "upsertNodes", nodes: [{ id: "n1", position: { x: 1, y: 2 }, data: { t: 1 }, selected: true, dragging: true }] } }));
  await until(() => b.got.length > 1, "op em B");
  const msg = JSON.parse(b.got[1]);
  assert.equal(msg.type, "op");
  assert.equal(msg.from, "ca");
  assert.equal(msg.rev, 1);
  assert.equal("selected" in msg.op.nodes[0], false);
  assert.equal(a.got.length, 1, "emissor não recebe o próprio eco");

  a.send(JSON.stringify({ type: "op", op: { kind: "patchNodeData", id: "n1", data: { u: 2 } } }));
  await until(() => b.got.length > 2, "patch em B");
  assert.equal(JSON.parse(b.got[2]).rev, 2);

  a.send(JSON.stringify({ type: "op", op: { kind: "upsertNodes", nodes: "x" } }));
  await until(() => a.got.length > 1, "erro em A");
  assert.equal(JSON.parse(a.got[1]).type, "error");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(b.got.length, 3, "B não recebe op inválida");

  const got = (await fastify.inject({ method: "GET", url: `/api/projects/${P}/canvas` })).json();
  assert.equal(got.rev, 2);
  assert.deepEqual(got.nodes[0].data, { t: 1, u: 2 });
  a.close();
  b.close();
});

test("removeNodes remove arestas ligadas e mata a sessão do nó", async () => {
  const t = await connect(term("n-rm"));
  await until(() => t.got.length > 0, "sessão ativa");
  const [s] = (await sessionList()).filter((x: any) => x.nodeId === "n-rm");

  const a = await connect(`/ws/project/${P}?clientId=ca`);
  await until(() => a.got.length > 0, "snapshot");
  a.send(JSON.stringify({ type: "op", op: { kind: "replace", nodes: [{ id: "n-rm" }, { id: "n2" }], edges: [{ id: "e1", source: "n-rm", target: "n2" }, { id: "e2", source: "n2", target: "n2" }] } }));
  a.send(JSON.stringify({ type: "op", op: { kind: "removeNodes", ids: ["n-rm"] } }));
  await until(() => t.closeCode === 4000, "sessão do nó encerrada");
  await until(() => !alive(s.pid), "PTY morto");
  const got = (await fastify.inject({ method: "GET", url: `/api/projects/${P}/canvas` })).json();
  assert.deepEqual(got.nodes.map((n: any) => n.id), ["n2"]);
  assert.deepEqual(got.edges.map((e: any) => e.id), ["e2"]);
  a.close();
});

test("POST /canvas faz replace com broadcast e valida o corpo", async () => {
  const b = await connect(`/ws/project/${P}?clientId=cb`);
  await until(() => b.got.length > 0, "snapshot");
  const res = await fastify.inject({ method: "POST", url: `/api/projects/${P}/canvas`, payload: { nodes: [{ id: "x" }], edges: [] } });
  assert.equal(res.statusCode, 200);
  await until(() => b.got.length > 1, "broadcast");
  assert.equal(JSON.parse(b.got[1]).op.kind, "replace");
  const bad = await fastify.inject({ method: "POST", url: `/api/projects/${P}/canvas`, payload: { nodes: 1 } });
  assert.equal(bad.statusCode, 400);
  b.close();
});

test("canvas é persistido em arquivo após o debounce, sem campos transitórios", async () => {
  const file = path.join(repo, ".maestri_data", `canvas_${P}.json`);
  const res = await fastify.inject({ method: "POST", url: `/api/projects/${P}/canvas`, payload: { nodes: [{ id: "p1", dragging: true, measured: { width: 1 } }], edges: [] } });
  assert.equal(res.statusCode, 200);
  await until(() => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf-8")).nodes?.[0]?.id === "p1";
    } catch {
      return false;
    }
  }, "arquivo gravado", 3000);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf-8")).nodes, [{ id: "p1" }]);
});
