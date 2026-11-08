import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rmTmp } from "./rmtmp.js";

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "maestri-auth-test-"));
process.env.REPO_PATH = repo;
process.env.NODE_ENV = "test";
process.env.MAESTRI_TOKEN = "segredo-de-teste";

const { fastify } = await import("../src/index.js");
const auth = { authorization: "Bearer segredo-de-teste" };

before(async () => {
  await fastify.ready();
});

after(async () => {
  await fastify.close();
  rmTmp(repo);
});

test("GET /api/health é público e informa authRequired", async () => {
  const res = await fastify.inject({ method: "GET", url: "/api/health" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, authRequired: true, setupRequired: true });
});

test("/api/* sem token ou com token errado retorna 401", async () => {
  for (const headers of [{}, { authorization: "Bearer errado" }, { authorization: "Bearer " }]) {
    const res = await fastify.inject({ method: "GET", url: "/api/projects", headers });
    assert.equal(res.statusCode, 401);
    assert.ok(res.json().error);
  }
});

test("/api/* com token retorna 200", async () => {
  const res = await fastify.inject({ method: "GET", url: "/api/projects", headers: auth });
  assert.equal(res.statusCode, 200);
});

test("WS com token errado ou ausente fecha com 4401", async () => {
  for (const url of ["/ws/terminal?token=errado", "/ws/terminal"]) {
    const ws = await fastify.injectWS(url);
    const code = await new Promise<number>((resolve) => ws.on("close", resolve));
    assert.equal(code, 4401);
  }
});

test("WS com token correto dispensa a checagem de Origin", async () => {
  const ws = await fastify.injectWS("/ws/terminal?token=segredo-de-teste", { headers: { origin: "http://outro.example" } });
  const code = await new Promise<number>((resolve) => {
    ws.on("close", resolve);
    setTimeout(() => { ws.terminate(); resolve(-1); }, 1500);
  });
  assert.notEqual(code, 4401);
  assert.notEqual(code, 1008);
});

test("recusa subir com HOST=0.0.0.0 sem MAESTRI_TOKEN", () => {
  const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/index.ts");
  const env = { ...process.env, NODE_ENV: "production", HOST: "0.0.0.0", PORT: "0", MAESTRI_TOKEN: "" };
  const res = spawnSync(process.execPath, ["--import", "tsx", entry], { env, encoding: "utf-8", timeout: 20000 });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /MAESTRI_TOKEN/);
});
