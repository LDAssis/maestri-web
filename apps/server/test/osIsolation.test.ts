import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rmTmp } from "./rmtmp.js";

// Fase 3 (isolamento no SO), parte que roda em qualquer máquina: tokens por terminal e seu escopo, ambiente do PTY, argv do setpriv,
// ciclo de vida do usuário (com exec falso), contas de assinatura liberadas por usuário e as rotas /api/admin/users/:id/accounts.
// A parte que cria usuários Linux de verdade fica em osIsolation.linux.test.ts (só com root + MAESTRI_ISOLATION_TEST=1).
const isWindows = process.platform === "win32";
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maestri-osiso-test-")));
const repo = path.join(tmp, "principal");
fs.mkdirSync(path.join(repo, ".maestri_data"), { recursive: true });
process.env.REPO_PATH = repo;
process.env.MAESTRI_PROJECTS_DIR = path.join(tmp, "projetos");
process.env.MAESTRI_TOK_DIR = path.join(tmp, "tok");
process.env.NODE_ENV = "test";
process.env.MAESTRI_TOKEN = "chave-interna-iso";
process.env.MAESTRI_PR_POLL_MS = "3600000";

const { fastify, authService, terminalTokens, accountAccess } = await import("../src/index.js");
const { TerminalTokens, terminalScopeCheck } = await import("../src/terminalTokens.js");
const { buildPtyEnv, SessionManager } = await import("../src/sessions.js");
const { Isolation, isolatedArgv, loadIsolationConfig, UID_BASE, UID_MAX } = await import("../src/isolation.js");
const { AccountStore, STANDARD_ACCOUNT } = await import("../src/accounts.js");
const { AuthService } = await import("../src/auth/service.js");
const { AccountAccess, NO_ACCOUNT_MESSAGE } = await import("../src/accountAccess.js");
const { scrubbedEnv } = await import("../src/runAs.js");

const internal = { authorization: "Bearer chave-interna-iso" };
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
let adminTok = "";
let adminId = "";
async function call(method: string, url: string, headers?: Record<string, string>, payload?: unknown) {
  const r = await fastify.inject({ method: method as any, url, headers, payload: payload as any });
  let body: any = null;
  try {
    body = r.json();
  } catch {}
  return { status: r.statusCode, body };
}
const asAdmin = (m: string, u: string, p?: unknown) => call(m, u, bearer(adminTok), p);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let seq = 0;
async function newUser(name: string) {
  const inv = await asAdmin("POST", "/api/admin/invites", {});
  const r = await call("POST", `/api/invites/${inv.body.token}/accept`, undefined, { name, email: `iso${++seq}@example.com`, password: "Lume#Brasa998877" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { id: r.body.user.id as string, token: r.body.token as string, api: (m: string, u: string, p?: unknown) => call(m, u, bearer(r.body.token), p) };
}

let P1 = "";
let P2 = "";
before(async () => {
  await fastify.listen({ port: 0, host: "127.0.0.1" });
  const s = await call("POST", "/api/auth/setup", undefined, { setupKey: "chave-interna-iso", name: "Admin Iso", email: "admin.iso@example.com", password: "Zebra!Lapis42xx" });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  adminTok = s.body.token;
  adminId = s.body.user.id;
  for (const name of ["Projeto Um", "Projeto Dois"]) {
    const r = await asAdmin("POST", "/api/projects", { name });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    if (name.endsWith("Um")) P1 = r.body.project.id;
    else P2 = r.body.project.id;
  }
  // um nó em cada projeto (o terminal do token vive no nó N1)
  for (const [p, n] of [[P1, "n1"], [P2, "n2"]] as const) {
    const c = await call("POST", `/api/projects/${p}/canvas`, internal, {
      nodes: [{ id: n, type: "agentTerminal", position: { x: 0, y: 0 }, data: { title: `Agente ${n}`, defaultCmd: "" } }],
      edges: [],
    });
    assert.equal(c.status, 200, JSON.stringify(c.body));
  }
});
beforeEach(() => authService.limiter.reset());
after(async () => {
  await fastify.close();
  terminalTokens.revokeAll();
  rmTmp(tmp);
});

// ---------- token por terminal ----------
test("token por terminal: formato mt_, só o hash em memória, arquivo 0400, revoga e apaga o arquivo", () => {
  const t = new TerminalTokens(path.join(tmp, "tok-unit"));
  const a = t.issue({ projectId: "p", nodeId: "n" });
  assert.match(a.token, /^mt_[A-Za-z0-9_-]{43}$/); // 32 bytes em base64url
  assert.equal(fs.readFileSync(a.file, "utf8"), a.token);
  if (!isWindows) {
    assert.equal(fs.statSync(a.file).mode & 0o777, 0o400);
    assert.equal(fs.statSync(path.join(tmp, "tok-unit")).mode & 0o777, 0o711);
  }
  assert.deepEqual({ ...t.verify(a.token), createdAt: 0 }, { projectId: "p", nodeId: "n", ptyId: a.ptyId, uid: null, createdAt: 0 });
  assert.equal(t.verify(a.token + "x"), null);
  assert.equal(t.verify("mt_" + "A".repeat(43)), null);
  assert.equal(t.verify("outro"), null);
  const b = t.issue({ projectId: "p", nodeId: "n" });
  assert.notEqual(a.token, b.token);
  // nada guarda o token em claro: o mapa interno usa o SHA-256
  assert.ok(!JSON.stringify([...(t as any).byHash.keys()]).includes(a.token));
  t.revoke(a.ptyId);
  assert.equal(t.verify(a.token), null);
  assert.ok(!fs.existsSync(a.file));
  assert.ok(t.verify(b.token));
  t.revokeAll();
  assert.equal(t.size(), 0);
});

test("escopo do token: só o próprio projeto/nó e usage/report; todo o resto é 403", () => {
  const s = { projectId: "p1", nodeId: "n1", ptyId: "x", uid: null, createdAt: 0 };
  const ok = (m: string, u: string) => assert.equal(terminalScopeCheck(s, m, u).ok, true, `${m} ${u}`);
  const no = (m: string, u: string, re?: RegExp) => {
    const v = terminalScopeCheck(s, m, u);
    assert.equal(v.ok, false, `${m} ${u}`);
    assert.equal(v.status, 403);
    if (re) assert.match(v.error!, re);
  };
  for (const r of ["context", "send", "ask", "check", "notes/Nota", "notes", "recruit", "band/create", "floors", "routines", "accounts", "presets", "roles", "portal/create", "attachments", "chat", "arrange", "partituras", "debug"]) ok("POST", `/api/projects/p1/nodes/n1/${r}`);
  ok("GET", "/api/projects/p1/nodes/n1");
  ok("POST", "/api/projects/p1/usage/report");
  no("GET", "/api/projects/p1/usage/report");
  no("POST", "/api/projects/p2/usage/report");
  no("POST", "/api/projects/p2/nodes/n1/send");
  no("POST", "/api/projects/p1/nodes/n2/send", /próprio projeto e nó/);
  no("POST", "/api/projects/p1/nodes/n1/workspaces", /Workspaces e bandas entre projetos/);
  no("GET", "/api/projects/p1/nodes/n1/workspaces");
  no("POST", "/api/projects/p1/nodes/n1/workspaces/move");
  no("POST", "/api/projects/p1/nodes/n1/accounts/create", /administrador/);
  no("POST", "/api/projects/p1/nodes/n1/accounts/delete");
  for (const u of ["/api/projects", "/api/projects/p1", "/api/projects/p1/canvas", "/api/projects/p1/members", "/api/projects/p1/settings", "/api/users/directory", "/api/admin/users", "/api/admin/invites", "/api/settings/global", "/api/clis", "/api/accounts", "/api/global-roles", "/api/auth/state"]) no("GET", u);
  no("POST", "/api/projects", /não dá acesso/);
  no("DELETE", "/api/projects/p1");
  no("PUT", "/api/admin/users/x/accounts");
  // tentativas de escapar do prefixo
  no("GET", "/api/projects/p1/nodes/n1/../../p2/canvas");
  no("GET", "/api/projects/p1/nodes/n1/./x/../../../../admin/users");
  no("GET", "/api/projects/p1/nodes/n1x/context");
  no("GET", "/api/projects/p1x/nodes/n1/context");
  no("GET", "/api/projects/p1/nodes/n1%2f..%2f..%2fcanvas/x");
});

test("HTTP: o token do terminal passa pelo hook de autenticação, é barrado fora do escopo e morre ao revogar", async () => {
  const t = terminalTokens.issue({ projectId: P1, nodeId: "n1" });
  const me = bearer(t.token);
  const ctx = await call("GET", `/api/projects/${P1}/nodes/n1/context`, me);
  assert.equal(ctx.status, 200, JSON.stringify(ctx.body));
  // outro projeto / outro nó / listagens / admin / settings / contas: 403 com mensagem clara
  const denied = async (m: string, u: string, payload?: unknown) => {
    const r = await call(m, u, me, payload);
    assert.equal(r.status, 403, `${m} ${u} -> ${r.status} ${JSON.stringify(r.body)}`);
    assert.ok(r.body?.error, `${m} ${u}: sem mensagem`);
    return r;
  };
  await denied("GET", `/api/projects/${P2}/nodes/n2/context`);
  await denied("GET", `/api/projects/${P2}/canvas`);
  await denied("GET", `/api/projects/${P1}/canvas`);
  await denied("GET", `/api/projects/${P1}/nodes/n9/context`);
  await denied("GET", "/api/projects");
  await denied("POST", "/api/projects", { name: "Invasor" });
  await denied("GET", "/api/admin/users");
  await denied("POST", "/api/admin/invites", {});
  await denied("PUT", "/api/settings/global", { defaultCmd: "rm -rf /" });
  await denied("GET", "/api/clis");
  await denied("GET", "/api/accounts");
  await denied("POST", "/api/accounts", { program: "claude", name: "X" });
  await denied("GET", "/api/users/directory");
  await denied("DELETE", `/api/projects/${P1}`);
  const w = await denied("GET", `/api/projects/${P1}/nodes/n1/workspaces`);
  assert.match(w.body.error, /Workspaces e bandas entre projetos/);
  // não existe projeto "isolado" para o token: o token não vira sessão de usuário nem token interno
  assert.equal((await call("GET", "/api/health", me)).status, 200);
  // revogado: 401 (como qualquer token inválido)
  terminalTokens.revoke(t.ptyId);
  assert.equal((await call("GET", `/api/projects/${P1}/nodes/n1/context`, me)).status, 401);
  // o token interno continua valendo em tudo (admin local/CLI fora de PTY)
  assert.equal((await call("GET", `/api/projects/${P2}/canvas`, internal)).status, 200);
});

test("token de terminal não abre WebSocket (4401) e um token inventado com prefixo mt_ não passa", async () => {
  const { default: WebSocket } = await import("ws");
  const t = terminalTokens.issue({ projectId: P1, nodeId: "n1" });
  const port = (fastify.server.address() as any).port;
  const code = await new Promise<number>((res) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/project/${P1}?token=${t.token}`);
    ws.on("close", (c) => res(c));
    ws.on("error", () => {});
  });
  assert.equal(code, 4401);
  terminalTokens.revoke(t.ptyId);
  assert.equal((await call("GET", `/api/projects/${P1}/nodes/n1/context`, bearer("mt_" + "B".repeat(43)))).status, 401);
});

test("cross-project por corpo com token de terminal: workspaces de outros projetos não existem para ele", async () => {
  const t = terminalTokens.issue({ projectId: P1, nodeId: "n1" });
  const r = await call("POST", `/api/projects/${P1}/nodes/n1/recruit`, bearer(t.token), { name: "Zé", preset: "shell", workspace: "Projeto Dois" });
  assert.ok(r.status >= 400, JSON.stringify(r.body));
  assert.ok(!(await call("GET", `/api/projects/${P2}/canvas`, internal)).body.nodes.some((n: any) => n.data?.title === "Zé"), "nada foi criado no outro projeto");
  terminalTokens.revokeAll();
});

// ---------- ambiente do PTY ----------
test("buildPtyEnv (linux): lista branca, nada do ambiente do servidor e nunca o MAESTRI_TOKEN", () => {
  const base = { PATH: "/usr/local/bin:/usr/bin:/root/.local/bin", LANG: "pt_BR.UTF-8", MAESTRI_TOKEN: "segredo", AWS_SECRET_ACCESS_KEY: "x", ALLOWED_ORIGINS: "y", HOME: "/root", USER: "root", NODE_ENV: "production", FOO: "bar", TZ: "UTC" };
  const root = buildPtyEnv({ base, extra: { MAESTRI_API_URL: "http://x/api", MAESTRI_TOKEN_FILE: "/run/maestri/tok/a", MAESTRI_TOKEN: "vaza", CLAUDE_CONFIG_DIR: "/c" }, runAs: null, platform: "linux", bin: "/bin-maestri" });
  assert.deepEqual(Object.keys(root).sort(), ["CLAUDE_CONFIG_DIR", "COLORTERM", "HOME", "LANG", "LOGNAME", "MAESTRI_API_URL", "MAESTRI_TOKEN_FILE", "PATH", "SHELL", "TERM", "TZ", "USER"]);
  assert.equal(root.PATH.split(":")[0], "/bin-maestri");
  assert.ok(root.PATH.includes("/root/.local/bin"), "projeto externo (root) mantém o PATH do servidor");
  assert.equal(root.HOME, "/root");

  const run = { user: "mp-x", uid: 20001, gid: 20001, home: "/srv/maestri/home/mp-x", tmp: "/srv/maestri/tmp/mp-x", scope: [] };
  const iso = buildPtyEnv({ base: { ...base, MAESTRI_PTY_PATH: "/opt/cli/bin", MAESTRI_PTY_PASSTHROUGH: "FOO,MAESTRI_TOKEN,AUSENTE" }, extra: { MAESTRI_NODE_ID: "n" }, runAs: run, platform: "linux", bin: "/bin-maestri" });
  assert.equal(iso.HOME, run.home);
  assert.equal(iso.USER, "mp-x");
  assert.equal(iso.LOGNAME, "mp-x");
  assert.equal(iso.TMPDIR, run.tmp);
  assert.equal(iso.SHELL, "/bin/bash");
  assert.ok(!iso.PATH.includes("/root"), `PATH do usuário isolado não cita /root: ${iso.PATH}`);
  assert.ok(iso.PATH.endsWith("/opt/cli/bin"));
  assert.equal(iso.FOO, "bar", "passthrough explícito do admin");
  for (const k of ["MAESTRI_TOKEN", "AWS_SECRET_ACCESS_KEY", "ALLOWED_ORIGINS", "NODE_ENV", "AUSENTE"]) assert.ok(!(k in iso), `${k} não pode vazar`);

  // fora do Linux (dev): segue o ambiente, mas o token interno nunca entra
  const dev = buildPtyEnv({ base: { PATH: "/p", MAESTRI_TOKEN: "s", FOO: "1" }, extra: {}, runAs: null, platform: "darwin", bin: "/b" });
  assert.equal(dev.FOO, "1");
  assert.ok(!("MAESTRI_TOKEN" in dev));
  assert.ok(!("MAESTRI_TOKEN" in scrubbedEnv({ MAESTRI_TOKEN: "s", PATH: "/p" }, "win32")));
  assert.deepEqual(scrubbedEnv({ MAESTRI_TOKEN: "s", PATH: "/p", SEGREDO: "z", HOME: "/h" }, "linux"), { PATH: "/p", HOME: "/h" });
});

test("isolatedArgv: setpriv com uid/gid, grupos do usuário (--init-groups), no-new-privs, env -i com a lista branca e umask 007", () => {
  const run = { user: "mp-x", uid: 20001, gid: 20001, home: "/h", tmp: "/t", scope: [] as string[] };
  const a = isolatedArgv(run, ["HOME=/h", "PATH=/usr/bin"]);
  assert.equal(a.file, "/usr/bin/setpriv");
  assert.deepEqual(a.args, ["--reuid=20001", "--regid=20001", "--init-groups", "--no-new-privs", "env", "-i", "HOME=/h", "PATH=/usr/bin", "bash", "-c", "umask 007; exec bash --login -i"]);
  const b = isolatedArgv({ ...run, scope: ["systemd-run", "--scope", "--quiet", "--slice=mp-x.slice", "--"] }, ["A=1"]);
  assert.equal(b.file, "systemd-run");
  assert.deepEqual(b.args.slice(0, 6), ["--scope", "--quiet", "--slice=mp-x.slice", "--", "/usr/bin/setpriv", "--reuid=20001"]);
  assert.ok(!b.args.join(" ").includes("MAESTRI_TOKEN"));
});

// ---------- usuário do projeto (exec falso) ----------
function fakeSystem() {
  const calls: string[] = [];
  const users = new Map<string, { uid: number; gid: number; groups: Set<string> }>();
  const groups = new Set<string>();
  const exec = (cmd: string, args: string[]) => {
    calls.push([cmd, ...args].join(" "));
    if (cmd === "getent" && args[0] === "passwd") {
      if (!args[1]) return [...users].map(([n, u]) => `${n}:x:${u.uid}:${u.gid}::/h:/bin/bash`).join("\n");
      const u = users.get(args[1]) ?? [...users].map(([n, v]) => ({ n, v })).find((x) => String(x.v.uid) === args[1])?.v;
      if (!u) throw new Error("não existe");
      const name = users.has(args[1]) ? args[1] : [...users].find(([, v]) => v === u)![0];
      return `${name}:x:${u.uid}:${u.gid}::/h:/bin/bash`;
    }
    if (cmd === "getent" && args[0] === "group") {
      if (!groups.has(args[1])) throw new Error("não existe");
      return `${args[1]}:x:${3000 + [...groups].indexOf(args[1])}:`;
    }
    if (cmd === "useradd") {
      const uid = Number(args[args.indexOf("-u") + 1]);
      users.set(args[args.length - 1], { uid, gid: uid, groups: new Set() });
      groups.add(args[args.length - 1]);
      return "";
    }
    if (cmd === "userdel") {
      users.delete(args[0]);
      groups.delete(args[0]);
      return "";
    }
    if (cmd === "groupadd") {
      groups.add(args[0]);
      return "";
    }
    if (cmd === "groupdel") {
      groups.delete(args[0]);
      return "";
    }
    if (cmd === "usermod") {
      users.get(args[2])!.groups.add(args[1]);
      return "";
    }
    if (cmd === "gpasswd") {
      users.get(args[1])!.groups.delete(args[2]);
      return "";
    }
    if (cmd === "id") return [...(users.get(args[1])?.groups ?? [])].join(" ");
    return "";
  };
  return { calls, users, groups, exec };
}
function newIso(prefix = "mp-") {
  const dir = fs.mkdtempSync(path.join(tmp, "iso-"));
  const sys = fakeSystem();
  const cfg = { ...loadIsolationConfig({ MAESTRI_ISOLATION: "1", MAESTRI_ISOLATION_ROOT: path.join(dir, "srv"), MAESTRI_ISOLATION_USER_PREFIX: prefix } as any, "linux", 0), enabled: true };
  const data = path.join(dir, "data");
  fs.mkdirSync(data);
  const iso = new Isolation(cfg, data, sys.exec);
  iso.chown = () => {};
  return { iso, sys, cfg, dir, data };
}

test("Isolation: flag e plataforma (só liga com MAESTRI_ISOLATION=1, Linux e root)", () => {
  assert.equal(loadIsolationConfig({ MAESTRI_ISOLATION: "1" } as any, "linux", 0).enabled, true);
  assert.equal(loadIsolationConfig({} as any, "linux", 0).enabled, false);
  assert.equal(loadIsolationConfig({ MAESTRI_ISOLATION: "1" } as any, "win32", 0).enabled, false);
  assert.equal(loadIsolationConfig({ MAESTRI_ISOLATION: "1" } as any, "linux", 1000).enabled, false);
  const c = loadIsolationConfig({ MAESTRI_ISOLATION: "1", MAESTRI_LIMIT_MEMORY: "512M" } as any, "linux", 0);
  assert.deepEqual(c.limits, { memory: "512M", tasks: "512", cpu: "200%" });
  assert.equal(c.projectsDir, "/srv/maestri/projects");
});

test("Isolation: mp-<id>, uid 20000+ por contador persistido (pula uids ocupados, nunca passa de 65535), HOME/TMPDIR 0700", () => {
  const { iso, sys, cfg, data } = newIso();
  assert.equal(iso.userName("proj-123456"), "mp-proj-123456");
  assert.match(iso.userName("Proj_ÁÉ"), /^mp-[0-9a-f]{10}$/); // maiúscula/acento: vira hash
  assert.match(iso.userName("a".repeat(40)), /^mp-[0-9a-f]{10}$/); // > 32 caracteres
  const a = iso.provision("proj-a");
  const b = iso.provision("proj-b");
  assert.deepEqual([a.uid, b.uid], [UID_BASE, UID_BASE + 1]);
  assert.equal(iso.provision("proj-a").uid, a.uid, "idempotente: não cria outro usuário");
  assert.equal(sys.calls.filter((c) => c.startsWith("useradd")).length, 2);
  const useradd = sys.calls.find((c) => c.startsWith("useradd"))!;
  assert.match(useradd, /^useradd -M -U -u 20000 -d .*home[\\/]mp-proj-a -s \/bin\/bash mp-proj-a$/);
  if (!isWindows) for (const d of [iso.homeOf("mp-proj-a"), iso.tmpOf("mp-proj-a")]) assert.equal(fs.statSync(d).mode & 0o777, 0o700);
  assert.ok(sys.calls.some((c) => c.startsWith("systemctl set-property --runtime mp-proj-a.slice MemoryMax=2G TasksMax=512 CPUQuota=200%")));
  // contador persistido (e 0600): reiniciar o servidor não reaproveita uid
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, "isolation.json"), "utf8")).nextUid, UID_BASE + 2);
  if (!isWindows) assert.equal(fs.statSync(path.join(data, "isolation.json")).mode & 0o777, 0o600);
  const again = new Isolation(cfg, data, sys.exec);
  again.chown = () => {};
  assert.equal(again.provision("proj-c").uid, UID_BASE + 2);
  // uid ocupado no sistema é pulado
  sys.users.set("alguem", { uid: UID_BASE + 3, gid: 1, groups: new Set() });
  assert.equal(again.provision("proj-d").uid, UID_BASE + 4);
  // teto
  fs.writeFileSync(path.join(data, "isolation.json"), JSON.stringify({ nextUid: UID_MAX + 1 }));
  assert.throws(() => new Isolation(cfg, data, sys.exec).provision("proj-z"), /Sem uids livres/);
});

test("Isolation: runAs só para projeto isolado; externo (isolated:false) e sem osUser rodam como root", () => {
  const { iso } = newIso();
  const p = iso.provision("proj-a");
  const proj = { id: "proj-a", repoPath: "/x", osUser: p.osUser, uid: p.uid, gid: p.gid };
  const r = iso.runAs(proj)!;
  assert.equal(r.uid, p.uid);
  assert.equal(r.user, "mp-proj-a");
  assert.deepEqual(r.scope.slice(0, 3), ["systemd-run", "--scope", "--quiet"]);
  assert.equal(iso.runAs({ ...proj, isolated: false }), null);
  assert.equal(iso.runAs({ id: "x", repoPath: "/x" }), null);
  const off = new Isolation({ ...iso.cfg, enabled: false }, "/tmp", () => "");
  assert.equal(off.runAs(proj), null);
  assert.equal(iso.isManagedDir(path.join(iso.cfg.projectsDir, "a")), true);
  assert.equal(iso.isManagedDir("/opt/maestri-web"), false);
  assert.equal(iso.isManagedDir(iso.cfg.projectsDir), false);
});

test("Isolation: deprovision mata o usuário, apaga HOME/TMPDIR e se recusa a tocar em usuário que não é de projeto", () => {
  const { iso, sys } = newIso();
  const p = iso.provision("proj-a");
  iso.deprovision("root");
  iso.deprovision("www-data");
  assert.ok(!sys.calls.some((c) => c.startsWith("userdel root") || c.startsWith("pkill -KILL -u root")));
  iso.deprovision(p.osUser);
  assert.ok(sys.calls.includes("pkill -KILL -u mp-proj-a"));
  assert.ok(sys.calls.includes("userdel mp-proj-a"));
  assert.ok(!fs.existsSync(iso.homeOf(p.osUser)) && !fs.existsSync(iso.tmpOf(p.osUser)));
  assert.deepEqual(iso.listProjectUsers(), []);
});

test("Isolation: grupos de conta (nome estável e único) e sincronização entra/sai", () => {
  const { iso, sys, cfg } = newIso();
  const p = iso.provision("proj-a");
  const g1 = iso.groupFor("claude", "Padrão");
  assert.match(g1, /^mac-claude-padrao-[0-9a-f]{4}$/);
  assert.notEqual(iso.groupFor("claude", "A b"), iso.groupFor("claude", "a_b"));
  assert.notEqual(iso.groupFor("claude", "Padrão"), iso.groupFor("codex", "Padrão"));
  assert.ok(iso.groupFor("codex", "x".repeat(40)).length <= 32);
  const dir = path.join(cfg.accountsDir, "claude", "Padrão");
  iso.ensureAccountDir("claude", "Padrão", dir);
  assert.ok(sys.groups.has(g1));
  assert.deepEqual(iso.syncAccountGroups(p.osUser, [g1]), { added: [g1], removed: [] });
  assert.deepEqual(iso.syncAccountGroups(p.osUser, [g1]), { added: [], removed: [] });
  assert.deepEqual(iso.syncAccountGroups(p.osUser, []), { added: [], removed: [g1] });
});

// ---------- contas liberadas por usuário ----------
function world() {
  const w = newIso();
  const accounts = new AccountStore(w.data, { accountsDir: w.cfg.accountsDir, iso: w.iso });
  const auth = new AuthService(w.data, "");
  const admin = auth.users.add({ name: "Adm", email: "adm@e.com", passHash: "x", role: "admin" });
  const dono = auth.users.add({ name: "Dono", email: "dono@e.com", passHash: "x", role: "user" });
  const p = w.iso.provision("proj-a");
  const proj: any = { id: "proj-a", repoPath: path.join(w.cfg.projectsDir, "a"), osUser: p.osUser, uid: p.uid, gid: p.gid, isolated: true, ownerId: dono.id };
  const access = new AccountAccess(accounts, w.iso, auth, () => [proj]);
  return { ...w, accounts, auth, admin, dono, proj, access };
}

test("contas: terminal sem conta usa 'Padrão' se o dono tiver; senão a mensagem do contrato; Default vira Padrão só em projeto isolado", () => {
  const w = world();
  w.accounts.create("claude", STANDARD_ACCOUNT);
  w.accounts.create("claude", "Trabalho");
  // dono comum sem liberação: bloqueia com a mensagem exata
  const r0 = w.access.resolve(w.proj, "claude", undefined) as any;
  assert.equal(r0.blocked, "Nenhuma conta de assinatura liberada para este projeto — peça ao admin.");
  assert.equal(NO_ACCOUNT_MESSAGE, r0.blocked);
  assert.equal((w.access.resolve(w.proj, "claude", "Default") as any).blocked, NO_ACCOUNT_MESSAGE);
  // liberou só "Trabalho": sem escolha ainda bloqueia (não cai noutra assinatura); escolhendo "Trabalho" funciona
  assert.ok(w.access.setGrants(w.dono, [{ program: "claude", name: "trabalho" }]));
  assert.deepEqual(w.auth.users.get(w.dono.id).accounts, [{ program: "claude", name: "Trabalho" }]);
  assert.equal((w.access.resolve(w.proj, "claude", undefined) as any).blocked, NO_ACCOUNT_MESSAGE);
  assert.deepEqual((w.access.resolve(w.proj, "claude", "Trabalho") as any).env, { CLAUDE_CONFIG_DIR: w.accounts.dir("claude", "Trabalho") });
  assert.equal((w.access.resolve(w.proj, "claude", STANDARD_ACCOUNT) as any).blocked, NO_ACCOUNT_MESSAGE);
  assert.match((w.access.resolve(w.proj, "claude", "Equipe") as any).blocked, /"Equipe" não está liberada/); // não existe
  // liberou Padrão: sem escolha (e "Default") usam Padrão
  w.access.setGrants(w.dono, [{ program: "claude", name: "Padrão" }]);
  assert.deepEqual((w.access.resolve(w.proj, "claude", undefined) as any).env, { CLAUDE_CONFIG_DIR: w.accounts.dir("claude", "Padrão") });
  assert.deepEqual((w.access.resolve(w.proj, "claude", "Default") as any).env, { CLAUDE_CONFIG_DIR: w.accounts.dir("claude", "Padrão") });
  // codex sem conta codex: bloqueia; comando que não é claude/codex nunca é bloqueado
  assert.ok((w.access.resolve(w.proj, "codex", undefined) as any).blocked);
  assert.deepEqual(w.access.resolve(w.proj, "bash", undefined), { env: {} });
  assert.deepEqual(w.access.resolve(w.proj, "", undefined), { env: {} });
  // dono admin: todas liberadas
  w.proj.ownerId = w.admin.id;
  assert.deepEqual((w.access.resolve(w.proj, "claude", "Trabalho") as any).env, { CLAUDE_CONFIG_DIR: w.accounts.dir("claude", "Trabalho") });
  // projeto externo (root): como antes, Default = login do CLI, sem bloqueio
  w.proj.isolated = false;
  assert.deepEqual(w.access.resolve(w.proj, "claude", undefined), { env: {} });
  assert.deepEqual((w.access.resolve(w.proj, "claude", "Trabalho") as any).env, { CLAUDE_CONFIG_DIR: w.accounts.dir("claude", "Trabalho") });
});

test("contas: liberação valida existência; grupos entram/saem conforme o DONO; revogar avisa para reiniciar os terminais", () => {
  const w = world();
  w.accounts.create("claude", STANDARD_ACCOUNT);
  w.accounts.create("codex", "Time");
  assert.equal(w.access.setGrants(w.dono, [{ program: "claude", name: "Nada" }]), null);
  assert.equal(w.access.setGrants(w.dono, [{ program: "outro", name: "x" }]), null);
  assert.equal(w.access.setGrants(w.dono, [{ program: "claude", name: "Default" }]), null);
  const gPadrao = w.iso.groupFor("claude", STANDARD_ACCOUNT);
  const gTime = w.iso.groupFor("codex", "Time");
  const revoked: string[][] = [];
  w.access.onRevoked = (_p, groups) => revoked.push(groups);
  w.access.setGrants(w.dono, [{ program: "claude", name: "Padrão" }, { program: "claude", name: "padrão" }]); // duplicata some
  assert.equal(w.auth.users.get(w.dono.id).accounts.length, 1);
  assert.deepEqual(w.sys.users.get("mp-proj-a")!.groups, new Set([gPadrao]));
  w.access.setGrants(w.dono, [{ program: "claude", name: "Padrão" }, { program: "codex", name: "Time" }]);
  assert.deepEqual(w.sys.users.get("mp-proj-a")!.groups, new Set([gPadrao, gTime]));
  assert.deepEqual(revoked, [], "liberar não reinicia nada");
  w.access.setGrants(w.dono, [{ program: "codex", name: "Time" }]);
  assert.deepEqual(revoked, [[gPadrao]], "revogar reinicia (o servidor reinicia os PTYs do projeto)");
  assert.deepEqual(w.sys.users.get("mp-proj-a")!.groups, new Set([gTime]));
  // dono muda (transferência): grupos seguem o novo dono (admin = todas)
  w.proj.ownerId = w.admin.id;
  w.access.syncAll();
  assert.deepEqual(w.sys.users.get("mp-proj-a")!.groups, new Set([gPadrao, gTime]));
  // volta para o usuário comum com só Time: Padrão sai e reinicia
  w.proj.ownerId = w.dono.id;
  w.access.syncAll();
  assert.deepEqual(w.sys.users.get("mp-proj-a")!.groups, new Set([gTime]));
  assert.equal(revoked.length, 2);
  // projeto externo não mexe em grupo nenhum
  w.proj.isolated = false;
  const before = w.sys.calls.length;
  w.access.syncProject(w.proj);
  assert.equal(w.sys.calls.length, before);
});

test("contas: criar/apagar conta com isolamento cria/remove o grupo e a pasta fica root:grupo 2770", () => {
  const w = world();
  let changes = 0;
  const accounts = new AccountStore(w.data, { accountsDir: w.cfg.accountsDir, iso: w.iso, onChange: () => changes++ });
  accounts.create("claude", "Equipe");
  const g = w.iso.groupFor("claude", "Equipe");
  assert.ok(w.sys.groups.has(g));
  if (!isWindows) assert.equal(fs.statSync(accounts.dir("claude", "Equipe")).mode & 0o777, 0o770);
  assert.equal(changes, 1);
  accounts.delete("claude", "Equipe");
  assert.ok(!w.sys.groups.has(g));
  assert.equal(changes, 2);
  assert.ok(!fs.existsSync(accounts.dir("claude", "Equipe")));
});

test("contas: visibilidade — admin vê tudo; usuário comum só as liberadas (ao projeto pedido ou a ele); terminal só as do dono", () => {
  const w = world();
  for (const n of ["A", "B", "C"]) w.accounts.create("claude", n);
  w.access.setGrants(w.dono, [{ program: "claude", name: "B" }]);
  const names = (l: any[]) => l.map((a) => a.name).sort();
  assert.deepEqual(names(w.access.visible({ internal: true })), ["A", "B", "C"]);
  assert.deepEqual(names(w.access.visible({ user: w.admin })), ["A", "B", "C"]);
  assert.deepEqual(names(w.access.visible({ user: w.dono })), ["B"]);
  assert.deepEqual(names(w.access.visible({ user: w.admin, project: w.proj })), ["A", "B", "C"]);
  assert.deepEqual(names(w.access.visible({ project: w.proj })), ["B"]);
  assert.deepEqual(w.access.view(w.dono).accounts.map((a) => [a.name, a.granted]), [["A", false], ["B", true], ["C", false]]);
  assert.ok(w.access.view(w.admin).accounts.every((a) => a.granted), "admin tem todas (implícito)");
});

// ---------- rotas ----------
test("GET/PUT /api/admin/users/:id/accounts: formato do contrato, validações e só admin", async () => {
  const u = await newUser("Usuária Conta");
  for (const [program, name] of [["claude", "Padrão"], ["claude", "Equipe"], ["codex", "Padrão"]]) {
    const r = await asAdmin("POST", "/api/accounts", { program, name });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const get = await asAdmin("GET", `/api/admin/users/${u.id}/accounts`);
  assert.equal(get.status, 200);
  assert.deepEqual(get.body, { accounts: [{ program: "claude", name: "Equipe", granted: false }, { program: "claude", name: "Padrão", granted: false }, { program: "codex", name: "Padrão", granted: false }] });
  const put = await asAdmin("PUT", `/api/admin/users/${u.id}/accounts`, { grants: [{ program: "claude", name: "equipe" }, { program: "codex", name: "Padrão" }] });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.deepEqual(put.body.accounts.map((a: any) => [a.program, a.name, a.granted]), [["claude", "Equipe", true], ["claude", "Padrão", false], ["codex", "Padrão", true]]);
  assert.deepEqual((await asAdmin("GET", `/api/admin/users/${u.id}/accounts`)).body, put.body);
  // inválidos
  assert.equal((await asAdmin("PUT", `/api/admin/users/${u.id}/accounts`, { grants: [{ program: "claude", name: "Nao existe" }] })).status, 400);
  assert.equal((await asAdmin("PUT", `/api/admin/users/${u.id}/accounts`, { grants: "x" })).status, 400);
  assert.equal((await asAdmin("PUT", `/api/admin/users/${u.id}/accounts`, {})).status, 400);
  assert.equal((await asAdmin("PUT", `/api/admin/users/${u.id}/accounts`, { grants: [{ program: "claude" }] })).status, 400);
  assert.equal((await asAdmin("GET", "/api/admin/users/nao-existe/accounts")).status, 404);
  assert.equal((await asAdmin("PUT", "/api/admin/users/nao-existe/accounts", { grants: [] })).status, 404);
  // não-admin: 403 (e não lê nem altera as do outro)
  assert.equal((await u.api("GET", `/api/admin/users/${u.id}/accounts`)).status, 403);
  assert.equal((await u.api("PUT", `/api/admin/users/${u.id}/accounts`, { grants: [] })).status, 403);
  // limpar
  assert.equal((await asAdmin("PUT", `/api/admin/users/${u.id}/accounts`, { grants: [] })).status, 200);
  assert.ok((await asAdmin("GET", `/api/admin/users/${u.id}/accounts`)).body.accounts.every((a: any) => !a.granted));
  // admin: tudo granted
  assert.ok((await asAdmin("GET", `/api/admin/users/${adminId}/accounts`)).body.accounts.every((a: any) => a.granted));
});

test("GET /api/accounts: admin vê todas; usuário comum só as liberadas ao dono do projeto atual (?project=) ou as dele; terminal as do dono", async () => {
  const u = await newUser("Dona das Contas");
  const mine = (await u.api("POST", "/api/projects", { name: "Projeto da Dona" })).body.project.id as string;
  await call("POST", `/api/projects/${mine}/canvas`, internal, { nodes: [{ id: "t1", type: "agentTerminal", position: { x: 0, y: 0 }, data: { title: "T1" } }], edges: [] });
  await asAdmin("PUT", `/api/admin/users/${u.id}/accounts`, { grants: [{ program: "claude", name: "Equipe" }] });
  const nm = (r: any) => r.body.accounts.map((a: any) => `${a.program}/${a.name}`).sort();
  assert.deepEqual(nm(await asAdmin("GET", "/api/accounts")), ["claude/Equipe", "claude/Padrão", "codex/Padrão"]);
  assert.deepEqual(nm(await call("GET", "/api/accounts", internal)), ["claude/Equipe", "claude/Padrão", "codex/Padrão"]);
  assert.deepEqual(nm(await u.api("GET", "/api/accounts")), ["claude/Equipe"], "sem projeto: as do próprio usuário");
  assert.deepEqual(nm(await u.api("GET", `/api/accounts?project=${mine}`)), ["claude/Equipe"], "projeto dele: as do dono");
  assert.deepEqual(nm(await u.api("GET", `/api/accounts?project=${P1}`)), ["claude/Equipe"], "projeto alheio: ignora o parâmetro e usa as dele");
  // se o admin fosse o dono do projeto pedido por um membro, o membro vê as do dono
  const mem = await newUser("Membra");
  assert.deepEqual(nm(await mem.api("GET", "/api/accounts")), []);
  await asAdmin("POST", `/api/projects/${mine}/members`, { userId: mem.id });
  assert.deepEqual(nm(await mem.api("GET", `/api/accounts?project=${mine}`)), ["claude/Equipe"], "membro usa as contas do dono do projeto");
  // terminal do projeto: as do dono, no GET /api/projects/:p/nodes/:n/accounts
  const tt = terminalTokens.issue({ projectId: mine, nodeId: "t1" });
  const cli = await call("GET", `/api/projects/${mine}/nodes/t1/accounts`, bearer(tt.token));
  assert.equal(cli.status, 200, JSON.stringify(cli.body));
  assert.deepEqual(nm(cli), ["claude/Equipe"]);
  terminalTokens.revokeAll();
  // não-admin não gerencia contas
  assert.equal((await u.api("POST", "/api/accounts", { program: "claude", name: "Minha" })).status, 403);
  assert.equal((await u.api("DELETE", "/api/accounts/claude/Equipe")).status, 403);
});

test("GET /api/projects traz `isolated` (false sem o flag) e o projeto novo não ganha osUser", async () => {
  const list = (await asAdmin("GET", "/api/projects")).body as any[];
  assert.ok(list.length >= 2);
  for (const p of list) assert.equal(p.isolated, false, p.id);
  const created = await asAdmin("POST", "/api/projects", { name: "Sem Isolamento" });
  assert.equal(created.body.project.isolated, false);
  assert.ok(!("osUser" in created.body.project));
  const saved = JSON.parse(fs.readFileSync(path.join(repo, ".maestri_data", "projects.json"), "utf8"));
  assert.ok(!saved.some((p: any) => p.osUser), "sem o flag nada de usuário de SO");
  assert.equal(accountAccess.sharedDirs(saved[0]).length, 0);
});

test("dados novos em .maestri_data nascem 0600", () => {
  if (isWindows) return;
  const dir = path.join(repo, ".maestri_data");
  for (const f of ["projects.json", "users.json", "auth_sessions.json"]) if (fs.existsSync(path.join(dir, f))) assert.equal(fs.statSync(path.join(dir, f)).mode & 0o777, 0o600, f);
});

// ---------- sessões ----------
const skipPty = isWindows ? "PTY POSIX: rodar em Linux/macOS" : false;
test("sessão: gate escreve a mensagem em vez de iniciar o agente; o PTY recebe o arquivo do token e nunca o MAESTRI_TOKEN; kill revoga", { skip: skipPty }, async () => {
  const tokens = new TerminalTokens(path.join(tmp, "tok-sess"));
  process.env.MAESTRI_TOKEN = "NAO-PODE-VAZAR";
  const sm = new SessionManager({
    apiUrl: () => "http://127.0.0.1:1/api", token: "NAO-PODE-VAZAR", tokens,
    gate: (_p, n) => (n === "bloq" ? "BLOQUEADO-SEM-CONTA" : null),
  } as any);
  process.env.MAESTRI_TOKEN = "chave-interna-iso";
  const cwd = fs.mkdtempSync(path.join(tmp, "cwd-"));
  const ok = sm.ensure("px", "nok", { cwd, cmd: "echo TOK[$MAESTRI_TOKEN]FILE[$(test -r $MAESTRI_TOKEN_FILE && echo ok)]" });
  const blocked = sm.ensure("px", "bloq", { cwd, cmd: "echo NAO-RODA" });
  for (let i = 0; i < 100 && !ok.scrollback.includes("FILE[ok]"); i++) await sleep(50);
  assert.match(ok.scrollback, /TOK\[\]FILE\[ok\]/, ok.scrollback);
  assert.ok(!ok.scrollback.includes("NAO-PODE-VAZAR"));
  assert.equal(tokens.size(), 2);
  await sleep(1000);
  assert.ok(blocked.scrollback.includes("BLOQUEADO-SEM-CONTA"));
  assert.ok(!/NAO-RODA\r?\n/.test(blocked.scrollback.replace("echo NAO-RODA", "")), "o comando do agente não roda quando não há conta");
  // reiniciar troca o token (o antigo morre); matar revoga
  const before = tokens.size();
  const oldId = ok.ptyId;
  assert.equal(sm.restart("px", "nok"), true);
  assert.notEqual(ok.ptyId, oldId);
  assert.equal(tokens.size(), before);
  assert.ok(!fs.existsSync(path.join(tmp, "tok-sess", oldId)));
  sm.kill("px", "nok");
  sm.kill("px", "bloq");
  assert.equal(tokens.size(), 0);
  assert.deepEqual(fs.readdirSync(path.join(tmp, "tok-sess")), []);
});

// ---------- conta gemini (agy + gemini-cli) ----------
const { accountProgramOf } = await import("../src/resume.js");
const { linkGeminiHome } = await import("../src/runAs.js");
const { GEMINI_LINK_ENV } = await import("../src/accounts.js");

test("accountProgramOf: claude, codex e gemini (agy e gemini-cli dividem ~/.gemini), com wrappers e sh -c", () => {
  for (const [cmd, want] of [
    ["claude", "claude"], ["/usr/bin/codex --flag", "codex"], ["agy", "gemini"], ["gemini", "gemini"], ["env FOO=1 agy", "gemini"],
    ["/root/.local/bin/agy", "gemini"], ["sh -c \"agy\"", "gemini"], ["opencode", null], ["bash", null], ["", null],
  ] as const) assert.equal(accountProgramOf(cmd), want, cmd);
  assert.equal(accountProgramOf(undefined), null);
});

test("conta gemini: terminal agy/gemini usa Padrão do dono pelo LINK ~/.gemini (não por variável); sem liberação bloqueia", () => {
  const w = world();
  w.accounts.create("gemini", STANDARD_ACCOUNT);
  assert.equal(w.accounts.checkProgram("gemini"), "gemini");
  assert.deepEqual(w.accounts.list().map((a) => `${a.program}/${a.name}`), ["gemini/Padrão"]);
  const dir = w.accounts.dir("gemini", "Padrão");
  assert.equal((w.access.resolve(w.proj, "agy", undefined) as any).blocked, NO_ACCOUNT_MESSAGE);
  assert.equal((w.access.resolve(w.proj, "gemini", "Default") as any).blocked, NO_ACCOUNT_MESSAGE);
  w.access.setGrants(w.dono, [{ program: "gemini", name: "Padrão" }]);
  assert.deepEqual((w.access.resolve(w.proj, "agy", undefined) as any).env, { [GEMINI_LINK_ENV]: dir });
  assert.deepEqual((w.access.resolve(w.proj, "env X=1 gemini", "Default") as any).env, { [GEMINI_LINK_ENV]: dir });
  // uma conta só para os dois CLIs: um grupo só
  assert.ok(w.sys.users.get("mp-proj-a")!.groups.has(w.iso.groupFor("gemini", "Padrão")));
  assert.deepEqual(w.access.sharedDirs(w.proj), [dir]);
  // projeto externo: nunca mexe no ~/.gemini do root (sem link)
  w.proj.isolated = false;
  assert.deepEqual(w.access.resolve(w.proj, "agy", undefined), { env: {} });
  assert.equal(w.accounts.resolveFor("agy", "Padrão"), "Padrão");
  assert.throws(() => w.accounts.resolveFor("bash", "Padrão"), /claude, codex, agy e gemini/);
  // dono admin: gemini também liberado automaticamente
  w.proj.isolated = true;
  w.proj.ownerId = w.admin.id;
  assert.deepEqual((w.access.resolve(w.proj, "agy", undefined) as any).env, { [GEMINI_LINK_ENV]: dir });
});

test("linkGeminiHome: cria o link, repointa, guarda um .gemini de verdade ao lado e remove sem conta", { skip: isWindows ? "symlink" : false }, () => {
  const home = fs.mkdtempSync(path.join(tmp, "gh-"));
  const a = path.join(tmp, "conta-a");
  const b = path.join(tmp, "conta-b");
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  linkGeminiHome(home, null, null, a);
  assert.equal(fs.readlinkSync(path.join(home, ".gemini")), a);
  linkGeminiHome(home, null, null, a); // idempotente
  linkGeminiHome(home, null, null, b);
  assert.equal(fs.readlinkSync(path.join(home, ".gemini")), b);
  linkGeminiHome(home, null, null, ""); // revogada: tira o link
  assert.ok(!fs.existsSync(path.join(home, ".gemini")));
  fs.mkdirSync(path.join(home, ".gemini"));
  fs.writeFileSync(path.join(home, ".gemini", "dado-do-projeto"), "x");
  linkGeminiHome(home, null, null, ""); // sem conta e sem link: não mexe no diretório de verdade
  assert.ok(fs.existsSync(path.join(home, ".gemini", "dado-do-projeto")));
  linkGeminiHome(home, null, null, a); // com conta: guarda o diretório do projeto ao lado
  assert.equal(fs.readlinkSync(path.join(home, ".gemini")), a);
  const kept = fs.readdirSync(home).find((n) => n.startsWith(".gemini.local-"))!;
  assert.ok(fs.existsSync(path.join(home, kept, "dado-do-projeto")));
});

test("sessão: a chave reservada da conta gemini nunca chega ao terminal (e projeto não isolado não ganha link)", { skip: skipPty }, async () => {
  const target = path.join(tmp, "conta-g");
  fs.mkdirSync(target);
  const tokens = new TerminalTokens(path.join(tmp, "tok-g"));
  const sm = new SessionManager({ apiUrl: () => "http://x/api", token: "", tokens, env: () => ({ [GEMINI_LINK_ENV]: target }) } as any);
  const cwd = fs.mkdtempSync(path.join(tmp, "cwd-"));
  const s = sm.ensure("pg", "n", { cwd, cmd: "echo LINK[$" + GEMINI_LINK_ENV + "]" });
  for (let i = 0; i < 100 && !/LINK\[\]/.test(s.scrollback); i++) await sleep(50);
  assert.match(s.scrollback, /LINK\[\]/);
  const own = path.join(process.env.HOME || "/nonexistent", ".gemini");
  assert.ok(!fs.existsSync(own) || !fs.lstatSync(own).isSymbolicLink() || fs.readlinkSync(own) !== target, "o HOME do servidor não vira link");
  sm.kill("pg", "n");
});

// ======================================================================================================================
// FASE 4 (defensor) — B7: escopo do token de terminal sob variações de URL/método/cabeçalho. Falhou = ACHADO (não corrigir aqui).
// ======================================================================================================================
test("B7.1 token de terminal: nenhuma variação de caminho alcança outro projeto, outro nó, rotas admin ou globais", async () => {
  const t = terminalTokens.issue({ projectId: P1, nodeId: "n1" });
  const me = bearer(t.token);
  const own = `/api/projects/${P1}/nodes/n1`;
  const foreign = [`/api/projects/${P2}/canvas`, `/api/projects/${P2}/nodes/n2/context`, `/api/projects/${P1}/nodes/n2/context`, `/api/projects/${P1}/canvas`, "/api/admin/users", "/api/projects", "/api/accounts", "/api/settings/global", "/api/users/directory", "/api/clis"];
  const enc = (s: string) => s.replace(/\//g, "%2F");
  const variants = (u: string): string[] => {
    const rest = u.replace(/^\/api\//, "");
    return [
      u, `${u}/`, `${u}?x=1`, `${u}?token=${t.token}`, `${u};a=b`, `${u}#frag`, `//${u.slice(1)}`, `/${u}`, u.replace("/api/", "/API/"), u.toUpperCase(),
      `/api/${enc(rest)}`, `/api%2F${rest}`, `/api/./${rest}`, `/api//${rest}`, `/%61pi/${rest}`, u.replace(/\//g, "/%2e/"), u.replace(/\//g, "\\"),
      `${own}/../../../${rest}`, `${own}/%2e%2e/%2e%2e/%2e%2e/${rest}`, `${own}/..%2f..%2f..%2f${rest}`, `${own}/%2e%2e%2f%2e%2e%2f${rest}`, `${own}//..//..//${rest}`,
      `${own}/notes/..%2f..%2f..%2f..%2f${rest}`, `${own}/notes/${enc(`../../../../${rest}`)}`, `${own}%2f..%2f..%2f..%2f${rest}`, `${own}%00/${rest}`, `${own}\\..\\..\\${rest}`,
    ];
  };
  const failures: string[] = [];
  for (const target of foreign) {
    for (const v of variants(target)) {
      const r = await call("GET", v, me);
      const leaked = r.status < 300 && /"nodes"|"users"|"projects"|"accounts"|"clis"|"settings"|defaultCmd|repoPath/.test(JSON.stringify(r.body ?? r.text));
      if (r.status < 300 || leaked) failures.push(`GET ${v} -> ${r.status}`);
    }
  }
  assert.deepEqual(failures, [], "o token do terminal passou o escopo");
  terminalTokens.revoke(t.ptyId);
});

test("B7.2 métodos e cabeçalhos: HEAD/OPTIONS/POST/PUT/DELETE em rotas fora do escopo; Authorization com dois tokens; minúsculas; token na query; sem espaço", async () => {
  const t = terminalTokens.issue({ projectId: P1, nodeId: "n1" });
  const targets = [`/api/projects/${P2}/canvas`, `/api/admin/users`, `/api/settings/global`, `/api/projects`];
  for (const u of targets) {
    for (const m of ["HEAD", "POST", "PUT", "PATCH", "DELETE"]) {
      const r = await call(m, u, bearer(t.token), m === "HEAD" ? undefined : {});
      assert.ok(r.status >= 400, `${m} ${u} -> ${r.status}`);
    }
    const o = await call("OPTIONS", u, { ...bearer(t.token), origin: "http://evil.example", "access-control-request-method": "GET" });
    assert.ok(!/nodes|users|repoPath/.test(String(o.text)), `OPTIONS ${u} devolveu dados`);
  }
  const ctx = `/api/projects/${P1}/nodes/n1/context`;
  assert.equal((await call("GET", ctx, bearer(t.token))).status, 200);
  // combinar credenciais não vira privilégio
  for (const h of [`Bearer ${t.token}, Bearer chave-interna-iso`, `Bearer ${t.token} Bearer chave-interna-iso`, `Bearer chave-interna-iso, Bearer ${t.token}`, `bearer ${t.token}`, `Bearer  ${t.token}`, `Bearer ${t.token}\u0000x`]) {
    const r = await call("GET", `/api/projects/${P2}/canvas`, { authorization: h });
    assert.ok(r.status >= 400, `Authorization: ${h.replace(t.token, "<tok>")} -> ${r.status}`);
  }
  // token interno/sessão na query string NUNCA autentica HTTP
  assert.equal((await call("GET", `/api/projects/${P2}/canvas?token=chave-interna-iso`)).status, 401);
  assert.equal((await call("GET", `/api/projects/${P2}/canvas?token=${t.token}`)).status, 401);
  // o token de terminal não vira sessão nem é aceito como sessão em /api/auth
  assert.ok((await call("GET", "/api/auth/state", bearer(t.token))).status < 500);
  assert.notEqual((await call("POST", "/api/auth/logout", bearer(t.token))).status, 200);
  assert.equal((await call("GET", ctx, bearer(t.token))).status, 200, "continua válido depois das tentativas");
  terminalTokens.revoke(t.ptyId);
  assert.equal((await call("GET", ctx, bearer(t.token))).status, 401);
});

test("B7.3 token de um terminal não vale para o OUTRO nó do mesmo projeto nem para o mesmo nó de outro projeto; ids parecidos (n1 vs n10, p1 vs p1x)", async () => {
  const t = terminalTokens.issue({ projectId: P1, nodeId: "n1" });
  for (const u of [`/api/projects/${P1}/nodes/n10/context`, `/api/projects/${P1}/nodes/N1/context`, `/api/projects/${P1}/nodes/n1x/context`, `/api/projects/${P1}x/nodes/n1/context`, `/api/projects/${P2}/nodes/n1/context`, `/api/projects/${P1.toUpperCase()}/nodes/n1/context`]) {
    const r = await call("GET", u, bearer(t.token));
    assert.ok(r.status >= 400, `${u} -> ${r.status}`);
  }
  terminalTokens.revokeAll();
});

test("B7.4 reuso: token morre no restart e no kill do PTY real; arquivo some; permissões 0400/0711 (posix)", { skip: skipPty }, async () => {
  const sm = new SessionManager({ apiUrl: () => "http://x/api", token: "", tokens: terminalTokens } as any);
  const cwd = fs.mkdtempSync(path.join(tmp, "b74-"));
  const s = sm.ensure(P1, "n1", { cwd, cmd: "" });
  const file1 = path.join(terminalTokens.directory, s.ptyId);
  const tok1 = fs.readFileSync(file1, "utf8");
  assert.equal(fs.statSync(file1).mode & 0o777, 0o400);
  assert.equal(fs.statSync(terminalTokens.directory).mode & 0o777, 0o711);
  assert.equal((await call("GET", `/api/projects/${P1}/nodes/n1/context`, bearer(tok1))).status, 200);
  sm.restart(P1, "n1");
  assert.equal((await call("GET", `/api/projects/${P1}/nodes/n1/context`, bearer(tok1))).status, 401, "token antigo vale depois do restart");
  assert.ok(!fs.existsSync(file1));
  const file2 = path.join(terminalTokens.directory, s.ptyId);
  const tok2 = fs.readFileSync(file2, "utf8");
  assert.notEqual(tok1, tok2);
  assert.equal((await call("GET", `/api/projects/${P1}/nodes/n1/context`, bearer(tok2))).status, 200);
  // o shell sair sozinho também revoga
  sm.write(P1, "n1", "exit\r");
  for (let i = 0; i < 100 && terminalTokens.verify(tok2); i++) await sleep(50);
  assert.equal(terminalTokens.verify(tok2), null, "token continua válido depois que o PTY saiu");
  assert.equal((await call("GET", `/api/projects/${P1}/nodes/n1/context`, bearer(tok2))).status, 401);
  assert.ok(!fs.existsSync(file2));
  sm.killAll();
  assert.equal(terminalTokens.size(), 0);
});

test("B7.5 SEM NENHUM token: variações de codificação do prefixo /api/ (ex.: /%61pi/) não pulam a autenticação nem o guarda de projetos", async () => {
  const targets = ["admin/users", "admin/invites", "projects", `projects/${P2}/canvas`, `projects/${P2}/nodes/n2/context`, "accounts", "settings/global", "users/directory", "clis"];
  const prefixes = ["/%61pi/", "/a%70i/", "/ap%69/", "/%41PI/", "/api%2F", "/%2e/api/", "//api/", "/./api/", "/api/./", "/ap%2569/"];
  const failures: string[] = [];
  for (const t of targets) {
    for (const p of prefixes) {
      for (const hdr of [undefined, bearer("token-lixo")]) {
        const r = await call("GET", `${p}${t}`, hdr);
        if (r.status < 400) failures.push(`GET ${p}${t}${hdr ? " (token lixo)" : " (sem token)"} -> ${r.status}`);
      }
    }
  }
  assert.deepEqual(failures, [], "requisições sem credencial atravessaram a autenticação");
});
