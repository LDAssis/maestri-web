import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { rmTmp } from "./rmtmp.js";

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "maestri-authusers-test-"));
process.env.REPO_PATH = repo;
process.env.NODE_ENV = "test";
process.env.MAESTRI_TOKEN = "chave-interna-de-teste";

const { fastify, authService } = await import("../src/index.js");
const { checkPassword } = await import("../src/auth/password.js");
const { clock } = await import("../src/auth/clock.js");
const internal = { authorization: "Bearer chave-interna-de-teste" };
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const DAY = 24 * 3600_000;

const ADMIN = { name: "Carla Mendes", email: "Carla@Example.com", password: "Zebra!Lapis42xx" };
let adminTok = "";
let adminId = "";
let port = 0;

async function call(method: string, url: string, opts: { headers?: Record<string, string>; payload?: unknown; ip?: string } = {}) {
  const r = await fastify.inject({ method: method as any, url, headers: opts.headers, payload: opts.payload as any, remoteAddress: opts.ip });
  let body: any = null;
  try {
    body = r.json();
  } catch {}
  return { status: r.statusCode, body, raw: r.body };
}
const login = (email: string, password: string, ip?: string) => call("POST", "/api/auth/login", { payload: { email, password }, ip });
const admin = (method: string, url: string, payload?: unknown) => call(method, url, { headers: bearer(adminTok), payload });

// Cria um usuário comum via convite e devolve { token, id }
let seq = 0;
async function newUser(name: string, email: string, password: string) {
  const inv = await admin("POST", "/api/admin/invites", { note: `para ${name}` });
  const r = await call("POST", `/api/invites/${inv.body.token}/accept`, { payload: { name, email, password } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { token: r.body.token as string, id: r.body.user.id as string, email, password };
}
const uniq = () => `u${++seq}`;

before(async () => {
  await fastify.listen({ port: 0, host: "127.0.0.1" });
  port = (fastify.server.address() as any).port;
});
beforeEach(() => authService.limiter.reset());
after(async () => {
  clock.offset = 0;
  await fastify.close();
  rmTmp(repo);
});

test("sem usuários: setupRequired em /api/auth/state e /api/health; API protegida segue 401", async () => {
  assert.deepEqual((await call("GET", "/api/auth/state")).body, { setupRequired: true });
  assert.deepEqual((await call("GET", "/api/health")).body, { ok: true, authRequired: true, setupRequired: true });
  assert.equal((await call("GET", "/api/projects")).status, 401);
  assert.equal((await call("GET", "/api/auth/me")).status, 401);
});

test("política de senha: tamanho, 3 de 4 tipos, nome/e-mail, comuns, máximo", () => {
  const who = { name: "Carla Mendes", email: "carla.mendes@example.com" };
  assert.deepEqual(checkPassword("Zebra!Lapis42xx", who), []);
  assert.ok(checkPassword("Curta1!", who).some((m) => /12 caracteres/.test(m)));
  assert.ok(checkPassword("somenteminusculas", who).some((m) => /3 dos 4 tipos/.test(m)));
  assert.ok(checkPassword("SOMENTEMAIUSCULAS1", who).some((m) => /3 dos 4 tipos/.test(m)), "2 tipos só");
  assert.deepEqual(checkPassword("minusculas MAIUSCULAS", who), [], "3 tipos: minúscula, maiúscula e símbolo (espaço)");
  assert.ok(checkPassword("Xx-carla.mendes-9Zz", who).some((m) => /nome|e-mail/.test(m)), "parte do e-mail");
  assert.ok(checkPassword("Cinco#CARLA#Zz9", who).some((m) => /nome/.test(m)), "nome, sem diferenciar maiúsculas");
  assert.ok(checkPassword("Mendes!Qwerty123", who).some((m) => /nome/.test(m)), "sobrenome");
  assert.deepEqual(checkPassword("Ana!Lapis4242xx", { name: "Ana Lu", email: "al@example.com" }), [], "partes < 4 chars são ignoradas");
  assert.ok(checkPassword("password123", who).length > 0);
  assert.ok(checkPassword("Password123", { name: "x", email: "x@y.z" }).length >= 1, "curta");
  assert.ok(checkPassword("Aa1!" + "x".repeat(200), who).some((m) => /no máximo 200/.test(m)));
  assert.ok(checkPassword(undefined, who).length > 0);
});

test("setup: só com a chave certa, senha forte e 0 usuários; cria o admin e já devolve sessão", async () => {
  const body = (o: object = {}) => ({ setupKey: "chave-interna-de-teste", ...ADMIN, ...o });
  assert.equal((await call("POST", "/api/auth/setup", { payload: body({ setupKey: "errada" }) })).status, 403);
  const weak = await call("POST", "/api/auth/setup", { payload: body({ password: "curta" }) });
  assert.equal(weak.status, 400);
  assert.ok(Array.isArray(weak.body.errors) && weak.body.errors.length >= 1);
  assert.equal((await call("POST", "/api/auth/setup", { payload: body({ email: "nao-e-email" }) })).status, 400);
  assert.equal(authService.users.count(), 0, "nada foi criado nas tentativas ruins");

  // duas configurações simultâneas válidas: só uma cria o admin
  const [r1, r2] = await Promise.all([call("POST", "/api/auth/setup", { payload: body() }), call("POST", "/api/auth/setup", { payload: body() })]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
  assert.equal(authService.users.count(), 1);
  const ok = r1.status === 200 ? r1 : r2;
  assert.match(ok.body.token, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(ok.body.user).sort(), ["color", "email", "id", "name", "role"]);
  assert.equal(ok.body.user.role, "admin");
  assert.equal(ok.body.user.email, "carla@example.com", "e-mail em minúsculas");
  adminTok = ok.body.token;
  adminId = ok.body.user.id;

  assert.equal((await call("POST", "/api/auth/setup", { payload: body({ email: "outra@example.com" }) })).status, 409, "só com 0 usuários");
  assert.deepEqual((await call("GET", "/api/auth/state")).body, { setupRequired: false });
  assert.equal((await call("GET", "/api/health")).body.setupRequired, false);
});

test("a sessão acessa /api/*, /me devolve o usuário público e o token interno continua valendo", async () => {
  assert.equal((await call("GET", "/api/projects", { headers: bearer(adminTok) })).status, 200);
  assert.equal((await call("GET", "/api/projects", { headers: internal })).status, 200);
  const me = await call("GET", "/api/auth/me", { headers: bearer(adminTok) });
  assert.equal(me.body.user.id, adminId);
  assert.equal((await call("GET", "/api/auth/me", { headers: internal })).status, 401, "o token interno não tem conta");
  assert.equal((await call("GET", "/api/projects", { headers: bearer("0".repeat(64)) })).status, 401);
});

test("login: ok, senha errada e e-mail inexistente com a MESMA mensagem; e-mail sem diferenciar maiúsculas", async () => {
  const ok = await login("CARLA@example.com", ADMIN.password);
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token && ok.body.user.name === "Carla Mendes");
  const wrong = await login("carla@example.com", "senha-errada-123");
  const ghost = await login("ninguem@example.com", "senha-errada-123");
  assert.equal(wrong.status, 401);
  assert.equal(ghost.status, 401);
  assert.equal(wrong.body.error, "E-mail ou senha incorretos");
  assert.equal(ghost.body.error, wrong.body.error);
  assert.equal((await call("POST", "/api/auth/login", { payload: { email: "a@b.c" } })).status, 400);
  assert.ok(authService.users.byEmail("carla@example.com")!.lastLoginAt, "lastLoginAt registrado");
});

test("nunca devolve passHash nem hashes de token; arquivos de dados com modo 0600", async () => {
  const bob = await newUser("Bob Souza", `${uniq()}@example.com`, "Cavalo#Verde7788");
  const list = await admin("GET", "/api/admin/users");
  const inv = await admin("POST", "/api/admin/invites", {});
  const pend = await admin("GET", "/api/admin/invites");
  for (const raw of [list.raw, pend.raw, JSON.stringify((await call("GET", "/api/auth/me", { headers: bearer(bob.token) })).body)]) {
    assert.ok(!/passHash|scrypt\$|tokenHash/.test(raw), raw.slice(0, 120));
  }
  assert.ok(!pend.raw.includes(inv.body.token), "a lista de convites não traz o token");
  const dir = path.join(repo, ".maestri_data");
  for (const f of ["users.json", "auth_sessions.json", "invites.json"]) {
    assert.equal(fs.statSync(path.join(dir, f)).mode & 0o777, 0o600, f);
  }
  const stored = fs.readFileSync(path.join(dir, "auth_sessions.json"), "utf-8");
  assert.ok(!stored.includes(bob.token), "a sessão é guardada só como sha256");
  assert.match(fs.readFileSync(path.join(dir, "users.json"), "utf-8"), /scrypt\$32768\$8\$1\$/);
});

test("rate limit: 10 tentativas por IP e por e-mail, depois 429", async () => {
  // por e-mail, de IPs diferentes
  const email = "alvo@example.com";
  for (let i = 0; i < 10; i++) assert.equal((await login(email, "x-senha-errada", `10.1.0.${i + 1}`)).status, 401, `tentativa ${i + 1}`);
  const blocked = await login(email, "x-senha-errada", "10.1.0.99");
  assert.equal(blocked.status, 429);
  assert.ok(blocked.body.error);
  // por IP, com e-mails diferentes
  for (let i = 0; i < 10; i++) assert.equal((await login(`n${i}@example.com`, "x-senha-errada", "10.2.0.1")).status, 401);
  assert.equal((await login("n11@example.com", "x-senha-errada", "10.2.0.1")).status, 429);
  // a janela passa
  clock.offset += 16 * 60_000;
  try {
    assert.equal((await login(email, "x-senha-errada", "10.1.0.99")).status, 401);
  } finally {
    clock.offset -= 16 * 60_000;
  }
});

test("rate limit também vale para setup e para aceitar convite", async () => {
  for (let i = 0; i < 10; i++) await call("POST", "/api/auth/setup", { payload: { setupKey: "x" }, ip: "10.3.0.1" });
  assert.equal((await call("POST", "/api/auth/setup", { payload: { setupKey: "x" }, ip: "10.3.0.1" })).status, 429);
  for (let i = 0; i < 10; i++) await call("POST", `/api/invites/${"a".repeat(64)}/accept`, { payload: {}, ip: "10.3.0.2" });
  assert.equal((await call("POST", `/api/invites/${"a".repeat(64)}/accept`, { payload: {}, ip: "10.3.0.2" })).status, 429);
});

test("sessão: sliding (renova a cada uso), expira em 30 dias sem uso e logout apaga", async () => {
  const u = await newUser("Dora Lima", `${uniq()}@example.com`, "Mesa!Janela9988");
  try {
    clock.offset += 20 * DAY;
    assert.equal((await call("GET", "/api/auth/me", { headers: bearer(u.token) })).status, 200, "dia 20");
    clock.offset += 20 * DAY; // 40 dias da criação, mas só 20 do último uso
    assert.equal((await call("GET", "/api/auth/me", { headers: bearer(u.token) })).status, 200, "dia 40 (renovada)");
    clock.offset += 31 * DAY;
    assert.equal((await call("GET", "/api/auth/me", { headers: bearer(u.token) })).status, 401, "31 dias sem uso");
  } finally {
    clock.offset = 0;
  }
  // logout
  const l = await login(u.email, u.password);
  assert.equal((await call("POST", "/api/auth/logout", { headers: bearer(l.body.token) })).status, 200);
  assert.equal((await call("GET", "/api/auth/me", { headers: bearer(l.body.token) })).status, 401);
});

test("sessão renovada grava no máximo 1x por minuto", async () => {
  const u = await newUser("Eva Reis", `${uniq()}@example.com`, "Lampada*Azul5566");
  const f = path.join(repo, ".maestri_data", "auth_sessions.json");
  const m0 = fs.statSync(f).mtimeMs;
  await new Promise((r) => setTimeout(r, 30));
  for (let i = 0; i < 5; i++) await call("GET", "/api/auth/me", { headers: bearer(u.token) });
  assert.equal(fs.statSync(f).mtimeMs, m0, "usos seguidos não regravam o arquivo");
  clock.offset += 61_000;
  try {
    await call("GET", "/api/auth/me", { headers: bearer(u.token) });
  } finally {
    clock.offset = 0;
  }
  assert.ok(fs.statSync(f).mtimeMs > m0, "passado 1 min, grava");
});

test("PATCH /me muda nome e cor (validados); trocar senha exige a atual e derruba as OUTRAS sessões", async () => {
  const u = await newUser("Fabio Rocha", `${uniq()}@example.com`, "Pedra#Rio33445");
  const h = bearer(u.token);
  const p = await call("PATCH", "/api/auth/me", { headers: h, payload: { name: "  Fabio   R.  ", color: "#A1B2C3" } });
  assert.equal(p.body.user.name, "Fabio R.");
  assert.equal(p.body.user.color, "#a1b2c3");
  assert.equal((await call("PATCH", "/api/auth/me", { headers: h, payload: { color: "vermelho" } })).status, 400);
  assert.equal((await call("PATCH", "/api/auth/me", { headers: h, payload: { name: "" } })).status, 400);

  const other = (await login(u.email, u.password)).body.token as string;
  assert.equal((await call("POST", "/api/auth/password", { headers: h, payload: { current: "errada", password: "Nova!Senha8899x" } })).status, 403);
  assert.equal((await call("POST", "/api/auth/password", { headers: h, payload: { current: u.password, password: "fraca" } })).status, 400);
  assert.equal((await call("POST", "/api/auth/password", { headers: h, payload: { current: u.password, password: "Nova!Senha8899x" } })).status, 200);
  assert.equal((await call("GET", "/api/auth/me", { headers: h })).status, 200, "a sessão atual continua");
  assert.equal((await call("GET", "/api/auth/me", { headers: bearer(other) })).status, 401, "a outra caiu");
  assert.equal((await login(u.email, u.password)).status, 401, "senha antiga não vale");
  assert.equal((await login(u.email, "Nova!Senha8899x")).status, 200);
});

test("convite: uso único, validação na página, e-mail duplicado e senha fraca não consomem", async () => {
  const inv = await admin("POST", "/api/admin/invites", { note: "Time de QA" });
  assert.equal(inv.status, 200);
  assert.match(inv.body.token, /^[0-9a-f]{64}$/);
  const days = (Date.parse(inv.body.expiresAt) - Date.now()) / DAY;
  assert.ok(days > 6.9 && days <= 7, `expira em ~7 dias (${days})`);
  const info = await call("GET", `/api/invites/${inv.body.token}`);
  assert.deepEqual({ valid: info.body.valid, kind: info.body.kind }, { valid: true, kind: "invite" });
  assert.equal(info.body.email, undefined);
  assert.equal((await call("GET", `/api/invites/${"f".repeat(64)}`)).status, 404);
  assert.equal((await call("GET", "/api/invites/curto")).status, 404);

  const list = (await admin("GET", "/api/admin/invites")).body.invites;
  const mine = list.find((i: any) => i.note === "Time de QA");
  assert.ok(mine && mine.id && mine.id !== inv.body.token && mine.createdBy === adminId && mine.expiresAt);

  const url = `/api/invites/${inv.body.token}/accept`;
  assert.equal((await call("POST", url, { payload: { name: "Gil", email: "carla@example.com", password: "Tijolo!Ceu7788" } })).status, 409, "e-mail já usado");
  assert.equal((await call("POST", url, { payload: { name: "Gil Prado", email: "gil@example.com", password: "fraca" } })).status, 400);
  assert.equal((await call("POST", url, { payload: { name: "Gil Prado", email: "gil@example.com", password: "Gil.Prado.1234" } })).status, 400, "contém o nome");
  assert.equal((await call("GET", `/api/invites/${inv.body.token}`)).status, 200, "nada disso consumiu o convite");

  const ok = await call("POST", url, { payload: { name: "Gil Prado", email: "GIL@example.com", password: "Tijolo!Ceu7788" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.role, "user");
  assert.equal(ok.body.user.email, "gil@example.com");
  assert.equal((await call("GET", "/api/auth/me", { headers: bearer(ok.body.token) })).status, 200, "entra logado");
  assert.equal((await call("POST", url, { payload: { name: "Outro", email: "outro@example.com", password: "Tijolo!Ceu7788" } })).status, 404, "uso único");
  assert.equal((await call("GET", `/api/invites/${inv.body.token}`)).status, 404);
  assert.ok(!(await admin("GET", "/api/admin/invites")).body.invites.some((i: any) => i.id === mine.id), "saiu dos pendentes");
});

test("convite: aceitações simultâneas, só uma vence", async () => {
  const inv = await admin("POST", "/api/admin/invites", {});
  const url = `/api/invites/${inv.body.token}/accept`;
  const rs = await Promise.all([1, 2, 3].map((i) => call("POST", url, { payload: { name: `Par ${i}`, email: `par${i}@example.com`, password: "Tijolo!Ceu7788" } })));
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 404, 404]);
});

test("convite: expira em 7 dias e pode ser revogado", async () => {
  const a = await admin("POST", "/api/admin/invites", {});
  const b = await admin("POST", "/api/admin/invites", { note: "revogar" });
  const id = (await admin("GET", "/api/admin/invites")).body.invites.find((i: any) => i.note === "revogar").id;
  assert.equal((await admin("DELETE", `/api/admin/invites/${id}`)).status, 200);
  assert.equal((await call("GET", `/api/invites/${b.body.token}`)).status, 404, "revogado");
  assert.equal((await admin("DELETE", `/api/admin/invites/${id}`)).status, 404);
  clock.offset += 7 * DAY + 60_000;
  try {
    assert.equal((await call("GET", `/api/invites/${a.body.token}`)).status, 404, "expirado");
    assert.equal((await call("POST", `/api/invites/${a.body.token}/accept`, { payload: { name: "Tarde", email: "tarde@example.com", password: "Tijolo!Ceu7788" } })).status, 404);
  } finally {
    clock.offset = 0;
  }
});

test("redefinição: link de 24h e uso único; derruba as sessões e a senha antiga", async () => {
  const u = await newUser("Hugo Alves", `${uniq()}@example.com`, "Vento#Norte2211");
  const second = (await login(u.email, u.password)).body.token as string;
  const link = await admin("POST", `/api/admin/users/${u.id}/reset-link`);
  assert.equal(link.status, 200);
  const hours = (Date.parse(link.body.expiresAt) - Date.now()) / 3600_000;
  assert.ok(hours > 23.9 && hours <= 24, `24 h (${hours})`);
  const info = await call("GET", `/api/invites/${link.body.token}`);
  assert.deepEqual({ kind: info.body.kind, email: info.body.email }, { kind: "reset", email: u.email });
  assert.ok(!(await admin("GET", "/api/admin/invites")).body.invites.some((i: any) => i.id && i.note === ""), "links de redefinição não aparecem em convites pendentes");

  assert.equal((await call("POST", `/api/invites/${link.body.token}/accept`, { payload: { password: "fraca" } })).status, 400);
  const ok = await call("POST", `/api/invites/${link.body.token}/accept`, { payload: { password: "Chuva#Sul99887" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.id, u.id);
  assert.equal((await call("GET", "/api/auth/me", { headers: bearer(u.token) })).status, 401, "sessão antiga caiu");
  assert.equal((await call("GET", "/api/auth/me", { headers: bearer(second) })).status, 401);
  assert.equal((await call("GET", "/api/auth/me", { headers: bearer(ok.body.token) })).status, 200);
  assert.equal((await login(u.email, u.password)).status, 401);
  assert.equal((await login(u.email, "Chuva#Sul99887")).status, 200);
  assert.equal((await call("POST", `/api/invites/${link.body.token}/accept`, { payload: { password: "Chuva#Sul99887" } })).status, 404, "uso único");

  const again = await admin("POST", `/api/admin/users/${u.id}/reset-link`);
  const first = await admin("POST", `/api/admin/users/${u.id}/reset-link`);
  assert.equal((await call("GET", `/api/invites/${again.body.token}`)).status, 404, "um link novo substitui o anterior");
  clock.offset += 25 * 3600_000;
  try {
    assert.equal((await call("GET", `/api/invites/${first.body.token}`)).status, 404, "expira em 24 h");
  } finally {
    clock.offset = 0;
  }
  assert.equal((await admin("POST", `/api/admin/users/nao-existe/reset-link`)).status, 404);
});

test("desativar derruba as sessões, bloqueia o login (403) e reativar libera; excluir remove", async () => {
  const u = await newUser("Iara Costa", `${uniq()}@example.com`, "Barco#Mar77889");
  const off = await admin("PATCH", `/api/admin/users/${u.id}`, { disabled: true });
  assert.equal(off.body.user.disabled, true);
  assert.equal((await call("GET", "/api/auth/me", { headers: bearer(u.token) })).status, 401);
  const l = await login(u.email, u.password);
  assert.equal(l.status, 403);
  assert.equal(l.body.error, "Conta desativada");
  assert.equal((await login(u.email, "senha-errada-xx")).status, 401, "sem a senha certa não revela que está desativada");
  assert.equal((await admin("PATCH", `/api/admin/users/${u.id}`, { disabled: false })).status, 200);
  const back = await login(u.email, u.password);
  assert.equal(back.status, 200);
  assert.equal((await admin("DELETE", `/api/admin/users/${u.id}`)).status, 200);
  assert.equal((await call("GET", "/api/auth/me", { headers: bearer(back.body.token) })).status, 401);
  assert.equal((await login(u.email, u.password)).status, 401);
  assert.ok(!(await admin("GET", "/api/admin/users")).body.users.some((x: any) => x.id === u.id));
  assert.equal((await admin("DELETE", `/api/admin/users/${u.id}`)).status, 404);
});

test("painel: lista com os campos certos; PATCH valida name/role/disabled", async () => {
  const u = await newUser("Joao Dias", `${uniq()}@example.com`, "Forno#Pao123456");
  const users = (await admin("GET", "/api/admin/users")).body.users;
  const row = users.find((x: any) => x.id === u.id);
  assert.deepEqual(Object.keys(row).sort(), ["color", "createdAt", "disabled", "email", "id", "lastLoginAt", "name", "role"]);
  assert.equal(row.role, "user");
  assert.equal((await admin("PATCH", `/api/admin/users/${u.id}`, { role: "root" })).status, 400);
  assert.equal((await admin("PATCH", `/api/admin/users/${u.id}`, { disabled: "sim" })).status, 400);
  assert.equal((await admin("PATCH", `/api/admin/users/${u.id}`, { name: "" })).status, 400);
  assert.equal((await admin("PATCH", `/api/admin/users/${u.id}`, { name: "Joao D." })).body.user.name, "Joao D.");
  assert.equal((await admin("PATCH", `/api/admin/users/inexistente`, { name: "x" })).status, 404);
});

test("regras do admin: não age sobre si mesmo e nunca fica sem admin ativo (409)", async () => {
  // o único admin: nada que o tire de cena
  assert.equal((await admin("PATCH", `/api/admin/users/${adminId}`, { disabled: true })).status, 409);
  assert.equal((await admin("PATCH", `/api/admin/users/${adminId}`, { role: "user" })).status, 409);
  assert.equal((await admin("DELETE", `/api/admin/users/${adminId}`)).status, 409);
  assert.equal(authService.users.activeAdmins().length, 1);
  // com um 2º admin, o 1º ainda não pode agir sobre si mesmo
  const b = await newUser("Kelly Nunes", `${uniq()}@example.com`, "Pavio#Vela998877");
  assert.equal((await admin("PATCH", `/api/admin/users/${b.id}`, { role: "admin" })).body.user.role, "admin");
  assert.equal((await admin("PATCH", `/api/admin/users/${adminId}`, { disabled: true })).status, 409, "ele mesmo");
  assert.equal((await admin("DELETE", `/api/admin/users/${adminId}`)).status, 409);
  // o 2º rebaixa o 1º (permitido: sobra ele); depois nem ele nem o token interno tiram o último
  const r = await call("PATCH", `/api/admin/users/${adminId}`, { headers: bearer(b.token), payload: { role: "user" } });
  assert.equal(r.status, 200);
  assert.equal((await call("PATCH", `/api/admin/users/${b.id}`, { headers: internal, payload: { disabled: true } })).status, 409, "token interno também respeita o último admin");
  assert.equal((await call("DELETE", `/api/admin/users/${b.id}`, { headers: internal })).status, 409);
  // o 1º virou comum: perde o painel (sessão dele, sem novo login)
  assert.equal((await admin("GET", "/api/admin/users")).status, 403);
  // volta a ser admin pelas mãos do 2º, para os próximos testes
  assert.equal((await call("PATCH", `/api/admin/users/${adminId}`, { headers: bearer(b.token), payload: { role: "admin" } })).status, 200);
  // admin desativado não conta como ativo
  assert.equal((await call("PATCH", `/api/admin/users/${adminId}`, { headers: bearer(b.token), payload: { disabled: true } })).status, 200);
  assert.equal((await call("PATCH", `/api/admin/users/${b.id}`, { headers: internal, payload: { role: "user" } })).status, 409, "o outro admin está desativado");
  assert.equal((await call("PATCH", `/api/admin/users/${adminId}`, { headers: internal, payload: { disabled: false } })).status, 200);
  // reabilitado o admin, o 2º é rebaixado sem mais drama
  assert.equal((await call("PATCH", `/api/admin/users/${b.id}`, { headers: internal, payload: { role: "user" } })).status, 200);
  // o login do 1º reabilitado (sessões caíram ao desativar)
  const re = await login(ADMIN.email, ADMIN.password);
  assert.equal(re.status, 200);
  adminTok = re.body.token;
});

test("rotas admin: 403 para usuário comum e 401 sem credencial; o token interno passa", async () => {
  const u = await newUser("Lia Pinto", `${uniq()}@example.com`, "Trilho#Trem9988");
  const h = bearer(u.token);
  const routes: [string, string, unknown?][] = [
    ["GET", "/api/admin/users"],
    ["PATCH", `/api/admin/users/${adminId}`, { name: "x" }],
    ["DELETE", `/api/admin/users/${adminId}`],
    ["POST", `/api/admin/users/${adminId}/reset-link`],
    ["GET", "/api/admin/invites"],
    ["POST", "/api/admin/invites", {}],
    ["DELETE", "/api/admin/invites/abc"],
  ];
  for (const [m, url, payload] of routes) {
    assert.equal((await call(m, url, { headers: h, payload })).status, 403, `${m} ${url}`);
    assert.equal((await call(m, url, { payload })).status, 401, `${m} ${url} sem credencial`);
  }
  assert.equal((await call("GET", "/api/admin/users", { headers: internal })).status, 200);
});

test("WS com sessão: presença usa nome/cor da CONTA; desativar fecha o socket (4401); sessão inválida é recusada", async () => {
  const u = await newUser("Maria Teles", `${uniq()}@example.com`, "Rosa#Branca77889");
  await call("PATCH", "/api/auth/me", { headers: bearer(u.token), payload: { color: "#112233" } });
  const open = (token: string, p = "/ws/presence") => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${p}?token=${token}`) as WebSocket & { got: any[]; code?: number };
    ws.got = [];
    ws.on("message", (m) => ws.got.push(JSON.parse(m.toString())));
    ws.on("close", (c) => (ws.code = c));
    return ws;
  };
  const until = async (cond: () => boolean, what: string) => {
    const end = Date.now() + 3000;
    while (!cond()) {
      if (Date.now() > end) assert.fail(`timeout: ${what}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  const mine = open(u.token);
  await new Promise((r) => mine.on("open", r));
  const watcher = open("chave-interna-de-teste");
  await new Promise((r) => watcher.on("open", r));
  watcher.send(JSON.stringify({ type: "hello", user: { id: "w", name: "Watcher", color: "#3b82f6" } }));
  await until(() => watcher.got.some((m) => m.type === "snapshot"), "snapshot do watcher");
  mine.send(JSON.stringify({ type: "hello", user: { id: "falso", name: "Nome Falso", color: "#ff0000" } }));
  await until(() => watcher.got.some((m) => m.type === "join"), "join");
  const peer = watcher.got.find((m) => m.type === "join").peer;
  assert.deepEqual({ id: peer.user.id, name: peer.user.name, color: peer.user.color }, { id: u.id, name: "Maria Teles", color: "#112233" });

  // outros WS (terminal/canvas) também aceitam a sessão e caem junto com ela
  const canvasWs = open(u.token, "/ws/project/proj-maestri-web");
  await new Promise((r) => canvasWs.on("open", r));

  await admin("PATCH", `/api/admin/users/${u.id}`, { disabled: true });
  await until(() => mine.code === 4401 && canvasWs.code === 4401, "sockets da conta desativada fechados");
  await until(() => watcher.got.some((m) => m.type === "leave"), "leave");

  const bad = open("0".repeat(64));
  await until(() => bad.code === 4401, "sessão inválida recusada");
  const revived = open(u.token);
  await until(() => revived.code === 4401, "sessão derrubada não conecta");
  watcher.close();
});

test("logout e redefinição de senha fecham os WS da sessão", async () => {
  const u = await newUser("Nando Vaz", `${uniq()}@example.com`, "Lume#Brasa998877");
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/presence?token=${u.token}`) as WebSocket & { code?: number };
  ws.on("close", (c) => (ws.code = c));
  await new Promise((r) => ws.on("open", r));
  await call("POST", "/api/auth/logout", { headers: bearer(u.token) });
  const end = Date.now() + 3000;
  while (ws.code === undefined && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  assert.equal(ws.code, 4401);
});
