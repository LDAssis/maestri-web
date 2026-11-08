import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rmTmp } from "./rmtmp.js";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maestri-polish5-test-")));
const repo = path.join(tmp, "principal");
fs.mkdirSync(repo, { recursive: true });
process.env.REPO_PATH = repo;
process.env.MAESTRI_PROJECTS_DIR = path.join(tmp, "projetos");
process.env.NODE_ENV = "test";
process.env.MAESTRI_TOKEN = "tok-p5";
process.env.MAESTRI_ASK_QUIET_MS = "400";
process.env.MAESTRI_WAKE_STARTUP_MS = "1500";
process.env.SHELL = "/bin/sh";

const { fastify } = await import("../src/index.js");
const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/maestri");
const P = "proj-maestri-web";
const auth = { authorization: "Bearer tok-p5" };
let port = 0;
let S = ""; // id do workspace "Satélite"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 10000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) assert.fail(`timeout: ${what}`);
    await sleep(40);
  }
}

function maestri(nodeId: string, args: string[], project = P) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      [bin, ...args],
      { env: { ...process.env, MAESTRI_API_URL: `http://127.0.0.1:${port}/api`, MAESTRI_PROJECT_ID: project, MAESTRI_NODE_ID: nodeId, MAESTRI_TOKEN: "tok-p5" } },
      (err, stdout, stderr) => resolve({ code: err ? ((err as any).code ?? 1) : 0, stdout, stderr }),
    );
  });
}
const M = (...a: string[]) => maestri("maestro", a);
const ok = async (p: Promise<{ code: number; stdout: string; stderr: string }>) => {
  const r = await p;
  assert.equal(r.code, 0, r.stderr || r.stdout);
  return r;
};
const canvasOf = async (p: string) => (await fastify.inject({ method: "GET", url: `/api/projects/${p}/canvas`, headers: auth })).json();
const byTitle = async (t: string, p = P) => (await canvasOf(p)).nodes.find((n: any) => n.data?.title === t);
const sessionIds = async (p = P) => (await fastify.inject({ method: "GET", url: `/api/projects/${p}/sessions`, headers: auth })).json().map((s: any) => s.nodeId);

before(async () => {
  await fastify.listen({ port: 0, host: "127.0.0.1" });
  port = (fastify.server.address() as any).port;
  const node = (id: string, x: number, data: object) => ({ id, type: "agentTerminal", position: { x, y: 0 }, style: { width: 300, height: 200 }, data });
  const res = await fastify.inject({
    method: "POST", url: `/api/projects/${P}/canvas`, headers: auth,
    payload: {
      nodes: [
        node("maestro", 0, { title: "Chefe", isMaestro: true }),
        node("worker", 400, { title: "Worker" }),
        node("sleeper", 800, { title: "Dorminhoco", defaultCmd: "echo ACORDEI$((1+1))" }),
        node("sleeper2", 1200, { title: "Dorminhoco2", defaultCmd: "echo ACORDEI2$((2+2))" }),
        node("sleeper3", 1600, { title: "Dorminhoco3", defaultCmd: "echo ACORDEI3" }),
      ],
      edges: [1, 2, 3, 4].map((i) => ({ id: `e${i}`, source: "maestro", target: ["worker", "sleeper", "sleeper2", "sleeper3"][i - 1] })),
    },
  });
  assert.equal(res.statusCode, 200);
  for (const name of ["Satélite"]) {
    const r = await fastify.inject({ method: "POST", url: "/api/projects", headers: auth, payload: { name } });
    assert.equal(r.statusCode, 200, r.body);
    S = r.json().project.id;
  }
});

after(async () => {
  await fastify.close();
  rmTmp(tmp);
});

// ---------- acordar agentes ----------

test("ask/send/check num agente sem sessão sobem a sessão (cwd e comando do nó) em vez de 409", async () => {
  assert.ok(!(await sessionIds()).includes("sleeper"), "começa sem sessão");
  // ask: sobe e avisa que ainda está iniciando (código 3), sem digitar a pergunta
  const a = await M("ask", "Dorminhoco", "echo NAO-DIGITADO");
  assert.equal(a.code, 3, a.stderr);
  assert.match(a.stderr, /ainda iniciando; pergunte de novo/);
  assert.equal(a.stdout, "");
  assert.ok((await sessionIds()).includes("sleeper"), "a sessão foi criada");
  await until(async () => (await M("check", "Dorminhoco")).stdout.includes("ACORDEI2"), "comando do nó executado");
  assert.doesNotMatch((await M("check", "Dorminhoco")).stdout, /NAO-DIGITADO/);
  // passada a janela de partida, o ask funciona normalmente
  await sleep(1600);
  const b = await ok(M("ask", "Dorminhoco", "echo PERGUNTA$((20+1))"));
  assert.match(b.stdout, /PERGUNTA21/);

  // check: sobe e mostra o que houver (com aviso)
  const c = await ok(M("check", "Dorminhoco2"));
  assert.match(c.stderr, /ainda subindo/);
  assert.ok((await sessionIds()).includes("sleeper2"));
  await until(async () => (await M("check", "Dorminhoco2")).stdout.includes("ACORDEI24"), "check mostra a saída");

  // send: sobe e envia
  const s = await ok(M("send", "Dorminhoco3", "echo ENVIADO$((3+4))"));
  assert.match(s.stdout, /foi iniciado/);
  await until(async () => (await M("check", "Dorminhoco3")).stdout.includes("ENVIADO7"), "send chegou");

  // batch: o item ainda iniciando vira erro com starting; sessão que já existe responde
  await fastify.inject({ method: "DELETE", url: `/api/projects/${P}/sessions/sleeper3`, headers: auth });
  const batch = await M("ask", "--batch", JSON.stringify({ Dorminhoco3: "echo B1", Worker: "echo B$((1+1))" }));
  assert.equal(batch.code, 3, batch.stderr);
  const out = JSON.parse(batch.stdout);
  assert.equal(out.find((x: any) => x.name === "Dorminhoco3").starting, true);
  assert.equal(out.find((x: any) => x.name === "Dorminhoco3").error, "ainda iniciando; pergunte de novo");
});

// ---------- workspaces cruzados ----------

test("recruit --workspace cria o agente no outro projeto, ligado a mim; list mostra os endereços", async () => {
  const r = await ok(M("recruit", "Alfa", "--workspace", "satélite", "--preset", "shell"));
  assert.match(r.stdout, /Agente "Alfa @ Satélite" recrutado/);
  const alfa = await byTitle("Alfa", S);
  assert.ok(alfa, "o nó vive no canvas do Satélite");
  assert.equal(await byTitle("Alfa"), undefined, "e não no meu");
  assert.ok((await sessionIds(S)).includes(alfa.id));
  // cwd = diretório do Satélite
  const where = await ok(M("ask", "Alfa @ Satélite", "pwd"));
  assert.match(where.stdout, /satelite/);
  assert.ok(!where.stdout.includes(repo));

  const links = JSON.parse(fs.readFileSync(path.join(repo, ".maestri_data", "links.json"), "utf8")).links;
  assert.deepEqual(links, [{ a: { project: P, node: "maestro" }, b: { project: S, node: alfa.id } }]);

  const list = (await ok(M("list"))).stdout;
  assert.match(list, /^Você: Chefe \(Maestro\) — Chefe @ Maestri Web \(Principal\)/);
  assert.match(list, /Agentes:\n(.*\n)*? {2}- Alfa @ Satélite/);
  // do lado de lá, o endereço é o meu
  const there = (await ok(maestri(alfa.id, ["list"], S))).stdout;
  assert.match(there, /Você: Alfa — Alfa @ Satélite/);
  assert.match(there, /- Chefe @ Maestri Web \(Principal\)/);

  // ask, send, check, batch aceitam o endereço (sem diferenciar maiúsculas); o nome puro não vale
  assert.match((await ok(M("send", "alfa @ SATÉLITE", "echo SEND$((2+2))"))).stdout, /Enviado/);
  await until(async () => (await M("check", "Alfa @ Satélite")).stdout.includes("SEND4"), "send chegou lá");
  // o Worker pode ter sido acordado há pouco por um teste anterior: espera ele ficar pronto (ask sem código 3)
  await until(async () => (await M("ask", "Worker", "true")).code === 0, "Worker pronto", 20000);
  const b = JSON.parse((await ok(M("ask", "--batch", JSON.stringify({ "Alfa @ Satélite": "echo L$((1+1))", Worker: "echo W$((2+2))" })))).stdout);
  assert.match(b.find((x: any) => x.name === "Alfa @ Satélite").output, /L2/);
  assert.match(b.find((x: any) => x.name === "Worker").output, /W4/);
  assert.match((await M("check", "Alfa")).stderr, /não encontrado/);
  assert.match((await M("recruit", "X", "--workspace", "Fantasma")).stderr, /Workspace "Fantasma" não encontrado/);
  assert.match((await M("recruit", "X", "--workspace", "Satélite", "--floor", "Nada")).stderr, /Andar "Nada" não encontrado/);
  assert.equal(await byTitle("X", S), undefined);

  // a UI: quem tem link externo (badge com tooltip)
  const ui = (await fastify.inject({ method: "GET", url: `/api/projects/${P}/links`, headers: auth })).json().links;
  assert.deepEqual(ui.maestro, [{ name: "Alfa", workspace: "Satélite" }]);
  const ui2 = (await fastify.inject({ method: "GET", url: `/api/projects/${S}/links`, headers: auth })).json().links;
  assert.deepEqual(ui2[alfa.id], [{ name: "Chefe", workspace: "Maestri Web (Principal)" }]);
  assert.equal((await fastify.inject({ method: "GET", url: `/api/projects/${P}/links` })).statusCode, 401);
});

test("connect entre workspaces (agente↔agente), um agente de lá enxerga o daqui e vice-versa", async () => {
  await ok(M("recruit", "Beta", "--preset", "shell"));
  const beta = await byTitle("Beta");
  // Beta (não Maestro) ainda não enxerga o Alfa
  assert.match((await maestri(beta.id, ["check", "Alfa @ Satélite"])).stderr, /não encontrado|não está conectado/);
  const c = await ok(M("connect", "Beta", "Alfa @ Satélite"));
  assert.match(c.stdout, /conectados/);
  assert.match((await ok(M("connect", "Alfa @ Satélite", "Beta"))).stdout, /já estão conectados/);
  assert.match((await ok(maestri(beta.id, ["list"]))).stdout, /- Alfa @ Satélite/);
  await ok(maestri(beta.id, ["send", "Alfa @ Satélite", "echo DO_BETA"]));
  await until(async () => (await M("check", "Alfa @ Satélite")).stdout.includes("DO_BETA"), "Beta falou com o Alfa");
  // só agente↔agente cruza workspaces
  await ok(M("note", "create", "Nota local", "x"));
  assert.match((await M("connect", "Nota local", "Alfa @ Satélite")).stderr, /Entre workspaces só agentes/);
  assert.match((await M("connect", "Beta", "Fantasma @ Satélite")).stderr, /não encontrado/);
});

test("bandas em outro workspace: create --workspace, 'Banda @ W' em add/remove/dissolve e no list", async () => {
  await ok(M("recruit", "Gama", "--workspace", "Satélite", "--preset", "shell"));
  await ok(M("recruit", "Delta", "--workspace", "Satélite", "--preset", "shell"));
  const made = await ok(M("band", "create", "Esquadra", "--workspace", "Satélite"));
  assert.match(made.stdout, /Banda "Esquadra @ Satélite" criada com .*Alfa/);
  const band = (await canvasOf(S)).nodes.find((n: any) => n.type === "band");
  assert.ok(band);
  assert.equal(band.data.members.length, 3, "reúne os agentes de lá que eu alcanço");
  assert.ok(!(await canvasOf(P)).nodes.some((n: any) => n.type === "band"), "a banda vive no outro workspace");
  assert.match((await ok(M("list"))).stdout, /Bandas:\n {2}- Esquadra @ Satélite\n(.*\n)* {6}· Alfa/);

  await ok(M("band", "remove", "Esquadra @ Satélite", "Delta"));
  assert.equal((await canvasOf(S)).nodes.find((n: any) => n.type === "band").data.members.length, 2);
  await ok(M("band", "add", "esquadra @ satélite", "Delta @ Satélite"));
  assert.equal((await canvasOf(S)).nodes.find((n: any) => n.type === "band").data.members.length, 3);
  assert.match((await M("band", "add", "Esquadra @ Satélite", "Beta")).stderr, /não encontrado|workspace da banda/);
  assert.match((await M("band", "dissolve", "Fantasma @ Satélite")).stderr, /não encontrada/);
  await ok(M("band", "dissolve", "Esquadra @ Satélite"));
  assert.ok(!(await canvasOf(S)).nodes.some((n: any) => n.type === "band"));
  // recruit --band com --workspace
  await ok(M("band", "create", "Dupla", "Gama", "Delta", "--workspace", "Satélite"));
  await ok(M("recruit", "Epsilon", "--workspace", "Satélite", "--preset", "shell", "--band", "Dupla"));
  const dupla = (await canvasOf(S)).nodes.find((n: any) => n.type === "band");
  assert.ok(dupla.data.members.includes((await byTitle("Epsilon", S)).id));
  await ok(M("band", "dissolve", "Dupla @ Satélite"));
});

test("dismiss funciona entre workspaces e limpa o link", async () => {
  await ok(M("dismiss", "Delta @ Satélite"));
  assert.equal(await byTitle("Delta", S), undefined);
  assert.match((await M("check", "Delta @ Satélite")).stderr, /não encontrado/);
  const links = JSON.parse(fs.readFileSync(path.join(repo, ".maestri_data", "links.json"), "utf8")).links;
  assert.ok(!links.some((l: any) => [l.a, l.b].some((e: any) => e.node.length && e.project === S && e.node === "Delta")));
  assert.equal(links.length >= 3, true);
  // apagar o projeto leva os links junto
  const before = links.length;
  const del = await fastify.inject({ method: "DELETE", url: `/api/projects/${S}`, headers: auth });
  assert.equal(del.statusCode, 200, del.body);
  const after = JSON.parse(fs.readFileSync(path.join(repo, ".maestri_data", "links.json"), "utf8")).links;
  assert.ok(after.length < before && !after.some((l: any) => l.a.project === S || l.b.project === S));
  assert.doesNotMatch((await ok(M("list"))).stdout, /@ Satélite/);
});

// ---------- flags desconhecidas ----------

test("flag desconhecida falha; '--' permite textos que começam com --; '---' e valores de flag seguem normais", async () => {
  const bad = await M("ask", "Worker", "oi", "--bogus");
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /Flag desconhecida: --bogus\. Use maestri ask --help/);
  for (const args of [["send", "Worker", "x", "--nope"], ["check", "Worker", "--linhas", "3"], ["routine", "list", "--x"], ["portal", "snapshot", "P", "--y"], ["recall", "--zzz"], ["band", "create", "B", "--w"], ["list", "--q"]]) {
    const r = await M(...args);
    assert.equal(r.code, 1, args.join(" "));
    assert.match(r.stderr, /Flag desconhecida: --(nope|linhas|x|y|zzz|w|q)/, args.join(" "));
  }
  assert.match((await M("--bogus")).stderr, /Flag desconhecida: --bogus\. Use maestri --help/);
  // --help com flag desconhecida ainda mostra a ajuda
  assert.equal((await M("ask", "--bogus", "--help")).code, 0);
  // texto posicional que começa com -- : depois de "--"
  const t = await ok(M("send", "Worker", "--", "--foo", "bar"));
  assert.match(t.stdout, /Enviado para Worker/);
  await until(async () => (await M("check", "Worker")).stdout.includes("--foo bar"), "texto com -- chegou");
  // "---" (markdown) e números negativos não são flags
  assert.equal((await M("send", "Worker", "---")).code, 0);
  assert.equal((await M("send", "Worker", "--1")).code, 0);
  // flags conhecidas de módulos continuam (valor consumido, mesmo começando com --)
  assert.equal((await M("say", "--progress", "--texto estranho")).code, 0);
});

// ---------- MAESTRI_CLI ----------

test("MAESTRI_CLI no ambiente do terminal aponta para o bin/maestri e funciona", async () => {
  await ok(M("recruit", "Env", "--preset", "shell"));
  const r = await ok(M("ask", "Env", 'echo CLI=$MAESTRI_CLI; "$MAESTRI_CLI" debug | head -3'));
  assert.ok(r.stdout.includes(`CLI=${bin}`), r.stdout);
  assert.match(r.stdout, /✓ MAESTRI_API_URL/);
});

// ---------- role dir ----------

test("role: prompt em CLAUDE.md/AGENTS.md na pasta do role, terminal começa nela; qualquer CLI; filho não herda a pasta", async () => {
  await ok(M("role", "create", "Revisor", "Revise com carinho."));
  await ok(M("recruit", "Rv", "--preset", "opencode", "--role", "Revisor"));
  const rv = await byTitle("Rv");
  assert.equal(rv.data.defaultCmd, "opencode", "presets que não são claude/codex também");
  const dir = path.join(repo, rv.data.worktreePath);
  assert.equal(rv.data.roleDir, true);
  assert.match(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), /<your_assigned_role>\nRevise com carinho\.\n<\/your_assigned_role>/);
  assert.match(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"), new RegExp(`The actual project you work on is located at:\\n${repo}`));
  assert.equal(fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8"), fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8"));
  // o terminal de fato começa na pasta do role
  await ok(M("recruit", "Rv2", "--preset", "shell", "--role", "Revisor"));
  assert.ok((await ok(M("ask", "Rv2", "pwd"))).stdout.includes(path.join(".maestri", "roles")));
  // role editado: o arquivo de contexto acompanha
  await ok(M("role", "edit", "Revisor", "carinho", "rigor"));
  assert.match(fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8"), /Revise com rigor\./);
});

test("agente acordado fica pronto quando a tela assenta, sem esperar a janela máxima", async () => {
  const prev = { max: process.env.MAESTRI_WAKE_STARTUP_MS, settle: process.env.MAESTRI_WAKE_SETTLE_MS };
  process.env.MAESTRI_WAKE_STARTUP_MS = "60000";
  process.env.MAESTRI_WAKE_SETTLE_MS = "500";
  try {
    await fastify.inject({ method: "DELETE", url: `/api/projects/${P}/sessions/sleeper`, headers: auth });
    await until(async () => !(await sessionIds()).includes("sleeper"), "sessão encerrada");
    const a = await M("ask", "Dorminhoco", "echo NAO");
    assert.equal(a.code, 3, a.stderr);
    await until(async () => (await M("check", "Dorminhoco")).stdout.includes("ACORDEI2"), "terminal produziu saída");
    await sleep(700);
    // bem antes dos 60s: a tela já assentou, então o ask responde
    const b = await ok(M("ask", "Dorminhoco", "echo PRONTO$((40+2))"));
    assert.match(b.stdout, /PRONTO42/);
  } finally {
    process.env.MAESTRI_WAKE_STARTUP_MS = prev.max;
    if (prev.settle === undefined) delete process.env.MAESTRI_WAKE_SETTLE_MS;
    else process.env.MAESTRI_WAKE_SETTLE_MS = prev.settle;
  }
});
