import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rmTmp } from "./rmtmp.js";

// Fase 4 (C10): atrás do túnel toda conexão vem de 127.0.0.1. O limite de login tem de valer por cliente
// (X-Forwarded-For do proxy local), não ser um balde global que qualquer um esgota para travar o login de todos.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maestri-ratelimit-test-")));
const repo = path.join(tmp, "principal");
fs.mkdirSync(path.join(repo, ".maestri_data"), { recursive: true });
process.env.REPO_PATH = repo;
process.env.MAESTRI_PROJECTS_DIR = path.join(tmp, "projetos");
process.env.NODE_ENV = "test";
process.env.MAESTRI_TOKEN = "chave-interna-rl";
process.env.MAESTRI_PR_POLL_MS = "3600000";

const { fastify } = await import("../src/index.js");
const login = (email: string, xff?: string, remoteAddress = "127.0.0.1") =>
  fastify.inject({ method: "POST", url: "/api/auth/login", remoteAddress, headers: xff ? { "x-forwarded-for": xff } : {}, payload: { email, password: "errada" } });

before(async () => {
  await fastify.ready();
  const s = await fastify.inject({ method: "POST", url: "/api/auth/setup", payload: { setupKey: "chave-interna-rl", name: "Rita Admin", email: "rita.rl@example.com", password: "Zebra!Lapis42xx" } });
  assert.equal(s.statusCode, 200, s.body);
});

after(async () => {
  await fastify.close();
  rmTmp(tmp);
});

test("um cliente esgotando o limite atrás do túnel não trava o login dos outros", async () => {
  let last = 0;
  for (let i = 0; i < 12; i++) last = (await login(`atacante${i}@example.com`, "203.0.113.7")).statusCode;
  assert.equal(last, 429, "o atacante é limitado");
  assert.equal((await login("vitima@example.com", "198.51.100.20")).statusCode, 401, "outro cliente ainda tenta (senha errada = 401, não 429)");
});

test("X-Forwarded-For só vale vindo do loopback: na LAN o IP real manda", async () => {
  let last = 0;
  for (let i = 0; i < 12; i++) last = (await login(`lan${i}@example.com`, `10.9.9.${i}`, "192.168.50.5")).statusCode;
  assert.equal(last, 429, "trocar o X-Forwarded-For de fora do loopback não escapa do limite");
});
