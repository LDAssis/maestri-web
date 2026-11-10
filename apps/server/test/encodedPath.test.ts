import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rmTmp } from "./rmtmp.js";

// Fase 4 (CRÍTICO): o roteador decodifica %XX antes de casar a rota; a autenticação e a ACL não podem decidir pelo req.url bruto.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maestri-encpath-test-")));
const repo = path.join(tmp, "principal");
fs.mkdirSync(path.join(repo, ".maestri_data"), { recursive: true });
process.env.REPO_PATH = repo;
process.env.MAESTRI_PROJECTS_DIR = path.join(tmp, "projetos");
process.env.NODE_ENV = "test";
process.env.MAESTRI_TOKEN = "chave-interna-enc";
process.env.MAESTRI_PR_POLL_MS = "3600000";

const { fastify } = await import("../src/index.js");
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const call = async (method: string, url: string, headers?: Record<string, string>, payload?: unknown) => {
  const r = await fastify.inject({ method: method as any, url, headers, payload: payload as any });
  let body: any = null;
  try {
    body = r.json();
  } catch {}
  return { status: r.statusCode, body };
};

let adminTok = "";
let userTok = "";
let projAdmin = "";

before(async () => {
  await fastify.ready();
  const s = await call("POST", "/api/auth/setup", undefined, { setupKey: "chave-interna-enc", name: "Dora Admin", email: "dora.enc@example.com", password: "Zebra!Lapis42xx" });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  adminTok = s.body.token;
  const inv = await call("POST", "/api/admin/invites", bearer(adminTok), {});
  const u = await call("POST", `/api/invites/${inv.body.token}/accept`, undefined, { name: "Edu User", email: "edu.enc@example.com", password: "Lume#Brasa998877" });
  assert.equal(u.status, 200, JSON.stringify(u.body));
  userTok = u.body.token;
  const p = await call("POST", "/api/projects", bearer(adminTok), { name: "Projeto da Dora" });
  projAdmin = p.body.project.id;
});

after(async () => {
  await fastify.close();
  rmTmp(tmp);
});

test("prefixo /api codificado não pula a autenticação", async () => {
  for (const url of ["/%61pi/projects", "/a%70i/admin/users", "/ap%69/settings/global", "/%61pi/clis", "/%61pi/accounts", "/%61%70%69/projects", "/%61pi/auth/me"]) {
    assert.equal((await call("GET", url)).status, 401, `${url} sem token`);
    assert.equal((await call("GET", url, bearer("lixo"))).status, 401, `${url} com token lixo`);
  }
  assert.equal((await call("POST", "/%61pi/admin/invites", undefined, {})).status, 401);
  assert.equal((await call("GET", "/%61pi/health")).status, 200, "rota pública continua pública");
});

test("ACL de projeto e rotas admin valem com o caminho codificado", async () => {
  const enc = projAdmin.replace("p", "%70");
  for (const url of [`/api/projects/${enc}/canvas`, `/%61pi/projects/${projAdmin}/canvas`, `/api/projects/${enc}/delete-info`]) {
    assert.equal((await call("GET", url, bearer(userTok))).status, 404, url);
  }
  assert.equal((await call("GET", `/api/projects/${enc}/canvas`, bearer(adminTok))).status, 200, "admin acessa pelo caminho codificado");
  assert.equal((await call("GET", "/%61pi/admin/users", bearer(userTok))).status, 403);
  assert.equal((await call("PUT", "/ap%69/settings/global", bearer(userTok), {})).status, 403);
});

test("codificação inválida é recusada", async () => {
  assert.equal((await call("GET", "/api/projects/%zz/canvas", bearer(userTok))).status, 400);
});
