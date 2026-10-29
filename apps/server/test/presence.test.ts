import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { rmTmp } from "./rmtmp.js";

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "maestri-presence-test-"));
process.env.REPO_PATH = repo;
process.env.NODE_ENV = "test";
process.env.MAESTRI_TOKEN = "segredo-de-teste";

const { fastify } = await import("../src/index.js");

type Client = WebSocket & { got: any[]; closeCode?: number };
let base = "";

function connect(query = "?token=segredo-de-teste"): Promise<Client> {
  const ws = new WebSocket(`${base}/ws/presence${query}`) as Client;
  ws.got = [];
  ws.on("message", (m) => ws.got.push(JSON.parse(m.toString())));
  ws.on("close", (code) => (ws.closeCode = code));
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, what: string, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) assert.fail(`timeout: ${what}`);
    await sleep(20);
  }
}

const hello = (ws: Client, id: string, name = id) =>
  ws.send(JSON.stringify({ type: "hello", user: { id, name, color: "#3b82f6" } }));
const update = (ws: Client, u: object) => ws.send(JSON.stringify({ type: "update", ...u }));

before(async () => {
  await fastify.listen({ port: 0, host: "127.0.0.1" });
  base = `ws://127.0.0.1:${(fastify.server.address() as any).port}`;
});

after(async () => {
  await fastify.close();
  rmTmp(repo);
});

test("token errado ou ausente fecha com 4401", async () => {
  for (const q of ["?token=errado", ""]) {
    const ws = await connect(q);
    await until(() => ws.closeCode !== undefined, "close");
    assert.equal(ws.closeCode, 4401);
  }
});

test("hello gera snapshot com os peers existentes e join para os outros", async () => {
  const a = await connect();
  hello(a, "ua", "Ana");
  await until(() => a.got.length === 1, "snapshot de A");
  assert.equal(a.got[0].type, "snapshot");
  assert.deepEqual(a.got[0].peers, []);

  const b = await connect();
  hello(b, "ub", "Bruno");
  await until(() => b.got.length === 1 && a.got.length === 2, "snapshot de B e join em A");
  assert.equal(b.got[0].peers.length, 1);
  assert.equal(b.got[0].peers[0].user.name, "Ana");
  assert.equal(b.got[0].peers[0].connId, a.got[0].you);
  assert.notEqual(b.got[0].you, a.got[0].you);
  assert.equal(a.got[1].type, "join");
  assert.equal(a.got[1].peer.connId, b.got[0].you);
  assert.equal(a.got[1].peer.activity, "idle");
  a.close();
  b.close();
  await sleep(100);
});

test("update chega aos outros, não ao emissor, e leave no close", async () => {
  const a = await connect();
  const b = await connect();
  hello(a, "ua");
  hello(b, "ub");
  await until(() => a.got.length === 2 && b.got.length === 1, "joins");

  update(a, { projectId: "proj-x", cursor: { x: 1.5, y: -2 }, activity: "typing", bogus: 1 });
  await until(() => b.got.length === 2, "update em B");
  const msg = b.got[1];
  assert.deepEqual(msg, { type: "update", connId: a.got[0].you, projectId: "proj-x", cursor: { x: 1.5, y: -2 }, activity: "typing" });
  await sleep(150);
  assert.equal(a.got.length, 2, "emissor não recebe o próprio update");

  // snapshot posterior reflete o estado atual
  const c = await connect();
  hello(c, "uc");
  await until(() => c.got.length === 1, "snapshot de C");
  const pa = c.got[0].peers.find((p: any) => p.connId === a.got[0].you);
  assert.equal(pa.projectId, "proj-x");
  assert.equal(pa.activity, "typing");

  a.close();
  await until(() => b.got.some((m) => m.type === "leave" && m.connId === a.got[0].you), "leave em B");
  b.close();
  c.close();
  await sleep(100);
});

test("mensagens antes do hello são ignoradas", async () => {
  const a = await connect();
  const b = await connect();
  hello(b, "ub");
  await until(() => b.got.length === 1, "snapshot de B");
  update(a, { projectId: "antes" });
  await sleep(150);
  assert.equal(b.got.length, 1);
  hello(a, "ua");
  await until(() => a.got.length === 1, "snapshot de A após hello");
  assert.equal(a.got[0].peers[0].projectId, null);
  a.close();
  b.close();
  await sleep(100);
});

test("hello inválido fecha com 4400", async () => {
  const bad = [
    { id: "u", name: "x", color: "azul" },
    { id: "u", name: "", color: "#112233" },
    { id: "x".repeat(65), name: "x", color: "#112233" },
    { id: 1, name: "x", color: "#112233" },
  ];
  for (const user of bad) {
    const ws = await connect();
    ws.send(JSON.stringify({ type: "hello", user }));
    await until(() => ws.closeCode !== undefined, "close");
    assert.equal(ws.closeCode, 4400, JSON.stringify(user));
  }
});

test("rate limit descarta o excesso de mensagens", async () => {
  const a = await connect();
  const b = await connect();
  hello(a, "ua");
  hello(b, "ub");
  await until(() => a.got.length === 2 && b.got.length === 1, "joins");
  for (let i = 0; i < 200; i++) update(a, { cursor: { x: i, y: i } });
  await sleep(500);
  const updates = b.got.filter((m) => m.type === "update").length;
  assert.ok(updates >= 25 && updates <= 50, `recebidos: ${updates}`);
  a.close();
  b.close();
  await sleep(100);
});
