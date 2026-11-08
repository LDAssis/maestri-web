import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rmTmp } from "./rmtmp.js";

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "maestri-test-"));
process.env.REPO_PATH = repo;
process.env.NODE_ENV = "test";

const { fastify } = await import("../src/index.js");

before(async () => {
  await fastify.ready();
});

after(async () => {
  await fastify.close();
  rmTmp(repo);
});

test("canvas com id inválido retorna 400", async () => {
  for (const id of ["..%2f..%2fetc", "a.b", "x%20y"]) {
    const res = await fastify.inject({ method: "GET", url: `/api/projects/${id}/canvas` });
    assert.equal(res.statusCode, 400, id);
  }
});

test("canvas de projeto inexistente retorna 404", async () => {
  const res = await fastify.inject({ method: "POST", url: "/api/projects/proj-nope/canvas", payload: { nodes: [], edges: [] } });
  assert.equal(res.statusCode, 404);
});

test("POST /api/projects sem corpo retorna 400", async () => {
  const res = await fastify.inject({ method: "POST", url: "/api/projects" });
  assert.equal(res.statusCode, 400);
});

test("WS /ws/terminal rejeita Origin fora da allowlist", async () => {
  const ws = await fastify.injectWS("/ws/terminal", { headers: { origin: "http://evil.example" } });
  const code = await new Promise<number>((resolve) => ws.on("close", resolve));
  assert.equal(code, 1008);
});
