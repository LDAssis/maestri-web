import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maestri-team-test-")));
process.env.REPO_PATH = repo;
process.env.NODE_ENV = "test";
process.env.MAESTRI_TOKEN = "tok-team";
process.env.MAESTRI_ASK_QUIET_MS = "400";

const { fastify } = await import("../src/index.js");
const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/maestri");
const P = "proj-maestri-web";
const auth = { authorization: "Bearer tok-team" };
let port = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 8000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) assert.fail(`timeout: ${what}`);
    await sleep(30);
  }
}

function maestri(nodeId: string, args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      [bin, ...args],
      { env: { ...process.env, MAESTRI_API_URL: `http://127.0.0.1:${port}/api`, MAESTRI_PROJECT_ID: P, MAESTRI_NODE_ID: nodeId, MAESTRI_TOKEN: "tok-team" } },
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

const canvas = async () => (await fastify.inject({ method: "GET", url: `/api/projects/${P}/canvas`, headers: auth })).json();
const byTitle = async (title: string) => (await canvas()).nodes.find((n: any) => n.data?.title === title);
const edgeBetween = async (a: string, b: string) => (await canvas()).edges.some((e: any) => (e.source === a && e.target === b) || (e.source === b && e.target === a));
const pid = async (nodeId: string) => (await fastify.inject({ method: "GET", url: `/api/projects/${P}/sessions`, headers: auth })).json().find((s: any) => s.nodeId === nodeId)?.pid;
const globalSettings = () => JSON.parse(fs.readFileSync(path.join(repo, ".maestri_data", "global_settings.json"), "utf8"));
const pos = { x: 0, y: 0 };

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
        node("maestro", "agentTerminal", 0, { title: "Chefe", isMaestro: true, preset: "claude", defaultCmd: "echo base" }),
        node("worker", "agentTerminal", 400, { title: "Worker" }),
        node("nota-m", "stickyNote", 800, { title: "Nota do Chefe", content: "chefe" }),
        node("nota-w", "stickyNote", 1200, { title: "Nota do Worker", content: "worker-secret" }),
        node("portal-w", "portal", 1600, { title: "Portal do Worker", url: "http://localhost:3000" }),
        node("fora", "stickyNote", 2000, { title: "Nota Solta", content: "x" }),
        node("peer", "agentTerminal", 2400, { title: "Peer" }),
        node("portal2", "portal", 2800, { title: "Outro Portal", url: "http://localhost:3001" }),
        node("nota-floor", "stickyNote", 3200, { title: "Nota de Outro Andar", content: "x", floor: "Experiment" }),
      ],
      edges: [
        { id: "e1", source: "maestro", target: "worker" },
        { id: "e2", source: "nota-m", target: "maestro" },
        { id: "e3", source: "nota-w", target: "worker" },
        { id: "e4", source: "worker", target: "portal-w" },
        { id: "e5", source: "maestro", target: "peer" },
        { id: "e6", source: "nota-floor", target: "peer" },
      ],
    },
  });
  assert.equal(res.statusCode, 200);
});

after(async () => {
  await fastify.close();
  fs.rmSync(repo, { recursive: true, force: true });
});

// ---------- presets ----------

test("preset: list traz embutidos + configurados; create/set/show/delete; só o Maestro altera", async () => {
  const l = await ok(M("preset", "list"));
  for (const w of ["claude", "Codex", "opencode", "agy", "Shell"]) assert.match(l.stdout, new RegExp(w, "i"));

  const c = await ok(M("preset", "create", "Claude Opus", "--command", "claude --model opus", "--maestro", "on", "--chat", "on"));
  assert.match(c.stdout, /Claude Opus {2}\(id claude-opus; global\)/);
  assert.match(c.stdout, /comando: claude --model opus/);
  assert.match(c.stdout, /maestro: on · chat: on · quick-start: on/);
  assert.ok(globalSettings().cliPresets.some((p: any) => p.id === "claude-opus" && p.cmd === "claude --model opus" && p.maestro === true));
  // as configurações antigas (agy/claude/opencode) continuam lá
  assert.ok(globalSettings().cliPresets.some((p: any) => p.id === "agy"));

  const s = await ok(M("preset", "set", "claude opus", "--name", "Opus", "--maestro", "off", "--quick-start", "off", "--command", "claude --model opus --verbose"));
  assert.match(s.stdout, /^Opus {2}\(id claude-opus/);
  assert.match(s.stdout, /maestro: off · chat: on · quick-start: off/);
  assert.match((await ok(M("preset", "show", "Opus"))).stdout, /--verbose/);
  assert.match((await ok(M("preset", "list"))).stdout, /Opus {2}\[claude-opus\]/);

  // UI: o endpoint REST devolve a mesma lista
  const rest = (await fastify.inject({ method: "GET", url: `/api/projects/${P}/presets`, headers: auth })).json().presets;
  assert.ok(rest.some((p: any) => p.label === "Opus" && p.quickStart === false));

  // erros
  assert.match((await M("preset", "create", "opus", "--command", "x")).stderr, /Já existe/);
  assert.match((await M("preset", "create", "Z", "--maestro", "talvez")).stderr, /on ou off/);
  assert.match((await M("preset", "create", "Z", "--account", "Work")).stderr, /Contas/);
  assert.match((await M("preset", "create", "Z", "--command", "a\nb")).stderr, /Comando inválido/);
  assert.match((await M("preset", "show", "Fantasma")).stderr, /não encontrado. Disponíveis:/);
  assert.match((await maestri("worker", ["preset", "create", "Nao", "--command", "x"])).stderr, /Apenas o Maestro/);
  assert.equal((await maestri("worker", ["preset", "list"])).code, 0);

  // embutido: override grava no global; apagar o override restaura; apagar o puro embutido é recusado
  assert.match((await M("preset", "delete", "Codex")).stderr, /embutido/);
  await ok(M("preset", "set", "Codex", "--command", "codex --yolo"));
  assert.match((await ok(M("preset", "show", "codex"))).stdout, /codex --yolo/);
  assert.match((await ok(M("preset", "delete", "codex"))).stdout, /embutido voltou/);
  assert.match((await ok(M("preset", "show", "codex"))).stdout, /comando: codex\n/);

  await ok(M("preset", "delete", "Opus"));
  assert.ok(!globalSettings().cliPresets.some((p: any) => p.id === "claude-opus"));
});

test("preset: aparência (cor + ícone) sorteada/explícita e aplicada ao recruta; --color/--icon do recruit vencem", async () => {
  const c = await ok(M("preset", "create", "Look A", "--command", "claude --x", "--color", "rose", "--icon", "bug"));
  assert.match(c.stdout, /aparência: cor rose · ícone bug/);
  // sem look explícito: cor sorteada e ícone do CLI conhecido
  const d = await ok(M("preset", "create", "Look B", "--command", "claude"));
  assert.match(d.stdout, /aparência: cor \w+ · ícone sparkles/);
  assert.match((await M("preset", "create", "Look C", "--color", "magenta")).stderr, /Cor inválida/);
  assert.match((await M("preset", "create", "Look C", "--icon", "nao")).stderr, /Ícone inválido/);
  await ok(M("preset", "set", "Look B", "--color", "sky", "--icon", "rocket"));
  assert.match((await ok(M("preset", "show", "Look B"))).stdout, /cor sky · ícone rocket/);
  await ok(M("recruit", "ComLook", "--preset", "Look A"));
  const n = await byTitle("ComLook");
  assert.deepEqual([n.data.color, n.data.icon], ["rose", "bug"]);
  await ok(M("recruit", "ComLook2", "--preset", "Look A", "--color", "emerald"));
  const n2 = await byTitle("ComLook2");
  assert.deepEqual([n2.data.color, n2.data.icon], ["emerald", "bug"]);
  for (const t of ["ComLook", "ComLook2"]) await ok(M("dismiss", t));
  for (const l of ["Look A", "Look B"]) await ok(M("preset", "delete", l));
});

test("preset do projeto: um preset que vive nas configurações do projeto é alterado lá", async () => {
  fs.writeFileSync(path.join(repo, ".maestri_data", `settings_${P}.json`), JSON.stringify({ defaultCmd: "x", cliPresets: [{ id: "proj-only", label: "Só do Projeto", cmd: "echo proj" }] }));
  assert.match((await ok(M("preset", "show", "só do projeto"))).stdout, /project/);
  await ok(M("preset", "set", "Só do Projeto", "--command", "echo proj2"));
  const proj = JSON.parse(fs.readFileSync(path.join(repo, ".maestri_data", `settings_${P}.json`), "utf8"));
  assert.equal(proj.cliPresets[0].cmd, "echo proj2");
  assert.equal(proj.defaultCmd, "x");
  assert.ok(!globalSettings().cliPresets.some((p: any) => p.id === "proj-only"));
  await ok(M("preset", "delete", "Só do Projeto"));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repo, ".maestri_data", `settings_${P}.json`), "utf8")).cliPresets, []);
});

// ---------- recruit ----------

test("recruit: sem --preset é cópia de mim; --command/--cmd; nome repetido ganha (2); look validado", async () => {
  await ok(M("recruit", "Copia"));
  const a = await byTitle("Copia");
  assert.equal(a.data.defaultCmd, "echo base");
  assert.equal(a.data.preset, "claude");
  assert.notEqual(a.data.isMaestro, true, "poderes de Maestro não são copiados");
  assert.ok(await edgeBetween("maestro", a.id));
  assert.ok(await pid(a.id), "sessão iniciada");

  const b = await ok(M("recruit", "Copia", "--command", "echo CMD$((1+1))", "--color", "rose", "--icon", "bot"));
  assert.match(b.stdout, /"Copia \(2\)"/);
  const n2 = await byTitle("Copia (2)");
  assert.deepEqual({ cmd: n2.data.defaultCmd, color: n2.data.color, icon: n2.data.icon }, { cmd: "echo CMD$((1+1))", color: "rose", icon: "bot" });
  await ok(M("recruit", "Copia", "--cmd", "echo old"));
  assert.ok(await byTitle("Copia (3)"));

  assert.match((await M("recruit", "X", "--color", "fúcsia")).stderr, /Cor inválida/);
  assert.match((await M("recruit", "X", "--icon", "nope")).stderr, /Ícone inválido/);
  assert.match((await M("recruit", "X", "--account", "Work")).stderr, /Contas/);
  assert.match((await M("recruit", "X", "--workspace", "W")).stderr, /Workspace "W" não encontrado/);
  assert.match((await M("recruit", "X", "--command", "a\nb")).stderr, /Comando inválido/);
  assert.equal(await byTitle("X"), undefined);
  assert.match((await maestri("worker", ["recruit", "Intruso"])).stderr, /Apenas o Maestro pode recrutar/);
});

test("recruit --preset: nome do preset, flags de Maestro/chat, preset desconhecido lista os disponíveis", async () => {
  await ok(M("preset", "create", "Chefinho", "--command", "echo CHEFINHO", "--maestro", "on", "--chat", "on"));
  await ok(M("recruit", "Sub", "--preset", "chefinho"));
  const n = await byTitle("Sub");
  assert.deepEqual({ cmd: n.data.defaultCmd, maestro: n.data.isMaestro, chat: n.data.chatFirst, name: n.data.presetName }, { cmd: "echo CHEFINHO", maestro: true, chat: true, name: "Chefinho" });
  await ok(M("recruit", "Sh", "--preset", "Shell"));
  assert.equal((await byTitle("Sh")).data.defaultCmd, "");
  await ok(M("recruit", "Cx", "--preset", "codex", "--command", "echo override"));
  assert.equal((await byTitle("Cx")).data.defaultCmd, "echo override", "--command vence o preset");
  const bad = await M("recruit", "Y", "--preset", "vim");
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /Preset "vim" não encontrado. Disponíveis: .*"Shell"/);
  await M("preset", "delete", "Chefinho");
});

test("recruit --role: por nome (current e global), id, texto livre antigo; claude passa o prompt por arquivo", async () => {
  await ok(M("role", "create", "Revisor", "Revise tudo. Rode `maestri list`."));
  await ok(M("role", "create", "Global Dev", "Escreva código.", "--scope", "global"));
  await ok(M("recruit", "R1", "--preset", "shell", "--role", "revisor"));
  const r1 = await byTitle("R1");
  assert.equal(r1.data.role, "Revisor");
  assert.ok(r1.data.roleId);
  assert.equal(fs.readFileSync(path.join(repo, ".maestri-roles", `${r1.id}.md`), "utf8"), "Revise tudo. Rode `maestri list`.");

  await ok(M("recruit", "R2", "--command", "claude", "--role", "Global Dev"));
  const r2 = await byTitle("R2");
  assert.equal(r2.data.role, "Global Dev");
  // padrão: contexto em .maestri/roles/<id>/ (CLAUDE.md e AGENTS.md) e o terminal começa nessa pasta; comando limpo
  assert.equal(r2.data.defaultCmd, "claude");
  assert.equal(r2.data.baseCmd, "claude");
  assert.equal(r2.data.worktreePath, path.join(".maestri", "roles", r2.data.roleId.toLowerCase()));
  for (const f of ["CLAUDE.md", "AGENTS.md"]) assert.match(fs.readFileSync(path.join(repo, r2.data.worktreePath, f), "utf8"), /Escreva código\./);
  // com --dir o terminal começa onde foi pedido: o prompt vai como argumento (arquivo + $(cat))
  fs.mkdirSync(path.join(repo, "outro"), { recursive: true });
  await ok(M("recruit", "R2b", "--command", "claude", "--role", "Global Dev", "--dir", "outro"));
  const r2b = await byTitle("R2b");
  assert.match(r2b.data.defaultCmd, /^claude "\$\(cat '.*\.maestri-roles\/agent-[0-9a-f]+\.md'\)"$/);
  assert.equal(r2b.data.worktreePath, "outro");
  assert.notEqual(r2b.data.roleDir, true);

  // role-id (UUID) e texto livre antigo
  const id = (await byTitle("R1")).data.roleId;
  await ok(M("recruit", "R3", "--preset", "shell", "--role-id", id));
  assert.equal((await byTitle("R3")).data.role, "Revisor");
  const free = await ok(M("recruit", "R4", "--preset", "shell", "--role", "Texto livre do papel"));
  assert.match(free.stderr, /usado como texto livre/);
  assert.equal((await byTitle("R4")).data.role, "Texto livre do papel");
  assert.match((await M("recruit", "R5", "--role-id", "11111111-2222-3333-4444-555555555555")).stderr, /Role não encontrado/);
});

test("recruit --dir: precisa estar dentro do projeto", async () => {
  fs.mkdirSync(path.join(repo, "sub", "pkg"), { recursive: true });
  await ok(M("recruit", "Dir", "--preset", "shell", "--dir", path.join(repo, "sub", "pkg")));
  const n = await byTitle("Dir");
  assert.equal(n.data.worktreePath, path.join("sub", "pkg"));
  assert.equal((await fastify.inject({ method: "GET", url: `/api/projects/${P}/sessions`, headers: auth })).json().some((s: any) => s.nodeId === n.id), true);
  await ok(M("recruit", "Dir2", "--preset", "shell", "--dir", "sub"));
  assert.equal((await byTitle("Dir2")).data.worktreePath, "sub");

  const outside = await M("recruit", "Fuga", "--preset", "shell", "--dir", os.tmpdir());
  assert.equal(outside.code, 1);
  assert.match(outside.stderr, /dentro do projeto/);
  assert.match((await M("recruit", "Fuga", "--dir", "nao-existe")).stderr, /Diretório não encontrado/);
  assert.equal(await byTitle("Fuga"), undefined);
});

test("recruit --replace: troca o processo no mesmo nó, preservando arestas, posição e rotinas", async () => {
  await ok(M("recruit", "Velho", "--preset", "shell", "--command", "echo VELHO"));
  const before = await byTitle("Velho");
  const pidBefore = await pid(before.id);
  assert.ok(pidBefore);
  await ok(M("connect", "Velho", "Worker"));
  const rt = await fastify.inject({ method: "POST", url: `/api/projects/${P}/routines`, headers: auth, payload: { nodeId: before.id, name: "R", text: "echo x", schedule: { type: "interval", every: "1h" } } });
  assert.equal(rt.statusCode, 201, rt.body);
  fastify.inject({ method: "POST", url: `/api/projects/${P}/nodes/${before.id}/chat/reply`, headers: auth, payload: { text: "oi" } });
  await sleep(50);

  const r = await ok(M("recruit", "Novo Nome", "--replace", "Velho", "--command", "echo NOVO$((1+1))", "--role", "Revisor"));
  assert.match(r.stdout, /"Novo Nome" trocado no mesmo lugar/);
  const after = await byTitle("Novo Nome");
  assert.equal(after.id, before.id);
  assert.equal(await byTitle("Velho"), undefined);
  assert.deepEqual(after.position, before.position);
  assert.ok(await edgeBetween("maestro", after.id));
  assert.ok(await edgeBetween("worker", after.id));
  assert.equal(after.data.defaultCmd, "echo NOVO$((1+1))");
  assert.equal(after.data.role, "Revisor");
  assert.deepEqual(after.data.chat, []);
  const routines = (await fastify.inject({ method: "GET", url: `/api/projects/${P}/routines`, headers: auth })).json().routines;
  assert.equal(routines.filter((x: any) => x.nodeId === before.id).length, 1);
  const pidAfter = await pid(after.id);
  assert.ok(pidAfter && pidAfter !== pidBefore, "processo reiniciado");
  await until(async () => (await M("check", "Novo Nome")).stdout.includes("NOVO2"), "novo comando rodou");

  // sem nome posicional mantém o nome; sem --preset/--command mantém o comando e o role; Maestro só com --preset explícito
  await ok(M("recruit", "--replace", "Novo Nome", "--dir", "sub"));
  const kept = await byTitle("Novo Nome");
  assert.deepEqual({ cmd: kept.data.defaultCmd.includes("echo NOVO"), dir: kept.data.worktreePath }, { cmd: true, dir: "sub" });
  assert.notEqual(kept.data.isMaestro, true);
  await ok(M("preset", "create", "Boss", "--command", "echo BOSS", "--maestro", "on"));
  await ok(M("recruit", "--replace", "Novo Nome", "--preset", "Boss"));
  assert.equal((await byTitle("Novo Nome")).data.isMaestro, true);
  await ok(M("recruit", "--replace", "Novo Nome", "--preset", "Shell"));
  assert.equal((await byTitle("Novo Nome")).data.isMaestro, false);
  await M("preset", "delete", "Boss");

  assert.match((await M("recruit", "--replace", "Novo Nome")).stderr, /Nada para trocar/);
  assert.match((await M("recruit", "--replace", "Fantasma", "--preset", "shell")).stderr, /não encontrado/);
  assert.match((await M("recruit", "--replace", "Novo Nome", "--preset", "shell", "--floor", "X")).stderr, /--floor não é suportado/);
  assert.match((await maestri("worker", ["recruit", "--replace", "Peer", "--preset", "shell"])).stderr, /Apenas o Maestro/);
});

// ---------- roles ----------

test("role: list agrupado, show, create (current/global), edit (substring e escopo), write, assign", async () => {
  const list = (await ok(M("role", "list"))).stdout;
  assert.match(list, /Current workspace:\n {2}- Revisor: Revise tudo/);
  assert.match(list, /Global:\n {2}- Global Dev: Escreva código\./);
  assert.match((await ok(M("role", "show", "revisor"))).stdout, /^Revisor \(current\)\n\nRevise tudo/);
  assert.ok(fs.readdirSync(path.join(repo, ".maestri_data", "global-roles", ".maestri", "roles")).length >= 1, "global fica no diretório de dados");

  assert.match((await M("role", "create", "Revisor", "outro")).stderr, /Já existe/);
  await ok(M("role", "create", "Revisor", "global com o mesmo nome", "--scope", "global")); // outro escopo: permitido
  assert.match((await ok(M("role", "show", "Revisor"))).stdout, /\(current\)/, "current vence global");

  // edit substring: reescreve o prompt de quem usa o role e reinicia
  const r1 = await byTitle("R1");
  const pidBefore = await pid(r1.id);
  await ok(M("role", "edit", "Revisor", "Revise tudo", "Revise apenas segurança"));
  assert.match((await ok(M("role", "show", "Revisor"))).stdout, /Revise apenas segurança\./);
  assert.match(fs.readFileSync(path.join(repo, ".maestri-roles", `${r1.id}.md`), "utf8"), /^Revise apenas segurança/);
  assert.notEqual(await pid(r1.id), pidBefore, "quem usa o role reiniciou");
  assert.match((await M("role", "edit", "Revisor", "não existe", "x")).stderr, /não aparece/);

  // só --scope: move entre escopos
  await ok(M("role", "create", "Mover", "texto a mover"));
  await ok(M("role", "edit", "Mover", "--scope", "global"));
  assert.match((await ok(M("role", "show", "Mover"))).stdout, /\(global\)/);
  assert.match((await M("role", "edit", "Mover", "--scope", "planeta")).stderr, /--scope aceita/);

  await ok(M("role", "write", "Mover", "prompt novo inteiro"));
  assert.match((await ok(M("role", "show", "Mover"))).stdout, /prompt novo inteiro/);
  assert.match((await M("role", "show", "Fantasma")).stderr, /não encontrado/);
  assert.match((await maestri("worker", ["role", "create", "X", "y"])).stderr, /Apenas o Maestro/);
  assert.equal((await maestri("worker", ["role", "list"])).code, 0);
});

test("role assign: reinicia o recruta com o novo role (ou sem role), preservando topologia", async () => {
  await ok(M("recruit", "Alvo", "--command", "claude"));
  const t = await byTitle("Alvo");
  await ok(M("connect", "Alvo", "Peer"));
  const p0 = await pid(t.id);
  await ok(M("role", "assign", "Alvo", "Revisor"));
  let n = await byTitle("Alvo");
  assert.equal(n.id, t.id);
  assert.equal(n.data.role, "Revisor");
  assert.equal(n.data.defaultCmd, "claude");
  assert.equal(n.data.roleDir, true);
  assert.match(fs.readFileSync(path.join(repo, n.data.worktreePath, "CLAUDE.md"), "utf8"), /Revise apenas segurança/);
  assert.match(fs.readFileSync(path.join(repo, ".maestri-roles", `${t.id}.md`), "utf8"), /Revise apenas segurança/);
  assert.ok(await edgeBetween("maestro", t.id) && (await edgeBetween("peer", t.id)));
  const p1 = await pid(t.id);
  assert.ok(p1 && p1 !== p0);

  await ok(M("role", "assign", "Alvo", "Global Dev"));
  assert.equal((await byTitle("Alvo")).data.role, "Global Dev");
  const none = await ok(M("role", "assign", "Alvo", "--none"));
  assert.match(none.stdout, /removido/);
  n = await byTitle("Alvo");
  assert.equal(n.data.defaultCmd, "claude");
  assert.equal(n.data.roleId, null);
  assert.equal(n.data.roleDir, false, "sem role, o terminal volta para a raiz do projeto");
  assert.equal(n.data.worktreePath, null);
  assert.notEqual(await pid(t.id), p1);
  assert.match((await M("role", "assign", "Alvo", "Fantasma")).stderr, /não encontrado/);
  assert.match((await M("role", "assign", "Estranho", "Revisor")).stderr, /não encontrado/);
});

// ---------- connect ----------

test("connect: regras de tipo, andar e árvore de equipe", async () => {
  // agente ↔ agente
  assert.match((await ok(M("connect", "Worker", "Peer"))).stdout, /conectados/);
  assert.ok(await edgeBetween("worker", "peer"));
  assert.match((await ok(M("connect", "peer", "worker"))).stdout, /já estão conectados/);
  // nota ↔ agente (a nota do Chefe com o Worker) e nota ↔ nota
  await ok(M("connect", "Nota do Chefe", "Worker"));
  assert.ok(await edgeBetween("nota-m", "worker"));
  await ok(M("connect", "Nota do Chefe", "Nota do Worker"));
  // portal só com agente; nota não liga a portal; portal ↔ portal não
  await ok(M("connect", "Peer", "Portal do Worker"));
  assert.match((await M("connect", "Nota do Chefe", "Portal do Worker")).stderr, /portal só se liga a um agente/);
  assert.match((await M("connect", "Portal do Worker", "Peer")).stdout + (await M("connect", "Portal do Worker", "Chefe")).stdout, /conectados/);
  // fora da árvore de equipe
  const out = await M("connect", "Nota Solta", "Worker");
  assert.equal(out.code, 1);
  assert.match(out.stderr, /fora da sua árvore de equipe/);
  assert.match((await M("connect", "Chefe", "Chefe")).stderr, /dois nós diferentes/);
  assert.match((await M("connect", "Fantasma", "Chefe")).stderr, /não encontrado/);
  // eu mesmo como ponta + andares diferentes (nota com floorId f2 vs agente com f1)
  await ok(M("connect", "Chefe", "Portal do Worker"));
  assert.match((await maestri("worker", ["connect", "Chefe", "Peer"])).stderr, /Apenas o Maestro/);
});

// ---------- bandas ----------

const bandNode = async (title: string) => (await canvas()).nodes.find((n: any) => n.type === "band" && n.data?.title === title);

test("band: create reúne eu + conectados; mínimo 2; um terminal por banda; list marca a minha", async () => {
  const lone = await M("band", "create", "Sozinha", "Chefe");
  assert.equal(lone.code, 1);
  assert.match(lone.stderr, /pelo menos 2 agentes/);

  const r = await ok(M("band", "create", "Squad", "--color", "emerald", "--icon", "star"));
  const band = await bandNode("Squad");
  assert.ok(band);
  const names = (await canvas()).nodes.filter((n: any) => band.data.members.includes(n.id)).map((n: any) => n.data.title);
  assert.ok(names.includes("Chefe") && names.includes("Worker") && names.includes("Peer"));
  assert.match(r.stdout, /Banda "Squad" criada com/);
  assert.deepEqual({ c: band.data.color, i: band.data.icon, t: band.type }, { c: "emerald", i: "star", t: "band" });
  for (const m of band.data.members) assert.ok(await edgeBetween(band.id, m), "corda da banda a cada membro");

  const list = (await ok(M("list"))).stdout;
  assert.match(list, /Bandas:\n {2}- Squad \(você está nela\)\n {6}· Chefe/);
  // Maestro vê as conexões de cada colega aninhadas
  assert.match(list, /- Worker\n {6}↳ Nota do Worker \(nota\)/);
  assert.match(list, /↳ Portal do Worker \(portal\)/);

  // um terminal fica em uma banda por vez
  const dup = await M("band", "create", "Outra", "Worker", "Peer", "--without-me");
  assert.equal(dup.code, 1);
  assert.match(dup.stderr, /já está na banda "Squad"/);
  assert.match((await M("band", "create", "X", "Fantasma", "Worker")).stderr, /não encontrado/);
  assert.match((await maestri("worker", ["band", "create", "Y"])).stderr, /Apenas o Maestro/);

  // limpa para os próximos testes
  await ok(M("band", "dissolve", "Squad"));
  assert.equal(await bandNode("Squad"), undefined);
  // dissolver preserva o alcance: todos continuam ligados entre si
  assert.ok(await edgeBetween("worker", "peer"));
  assert.ok(await edgeBetween("maestro", "worker"));
});

test("band: --without-me, add/remove, banda com 1 membro se dissolve, membros se alcançam e herdam conexões", async () => {
  await ok(M("band", "create", "Duo", "Worker", "Peer", "--without-me"));
  const duo = await bandNode("Duo");
  assert.deepEqual([...duo.data.members].sort(), ["peer", "worker"]);
  assert.ok(await edgeBetween(duo.id, "maestro"), "quem coordena de fora fica ligado à banda");
  assert.ok(!duo.data.members.includes("maestro"));
  assert.match((await ok(M("list"))).stdout, /Bandas:\n {2}- Duo\n/, "não marcada: eu não estou nela");

  // membro alcança o outro pela banda: Worker enxerga "Peer" e o que está ligado à banda (nota)
  await ok(M("connect", "Nota do Chefe", "Duo"));
  const w = (await maestri("worker", ["list"])).stdout;
  assert.match(w, /Peer/);
  assert.match(w, /Nota do Chefe/);
  // quem entra depois herda tudo
  await ok(M("recruit", "Terceiro", "--preset", "shell"));
  const t3 = await byTitle("Terceiro");
  await ok(M("band", "add", "Duo", "Terceiro"));
  assert.ok((await bandNode("Duo")).data.members.includes(t3.id));
  const t3list = (await maestri(t3.id, ["list"])).stdout;
  assert.match(t3list, /Worker/);
  assert.match(t3list, /Nota do Chefe/);
  assert.match((await M("band", "add", "Duo", "Terceiro")).stderr, /já está na banda/);

  // remove: quem sai continua ligado aos que ficam; banda com 1 membro se dissolve
  await ok(M("band", "remove", "Duo", "Terceiro"));
  assert.ok(!(await bandNode("Duo")).data.members.includes(t3.id));
  assert.ok(await edgeBetween(t3.id, "worker"));
  assert.match((await M("band", "remove", "Duo", "Terceiro")).stderr, /não está na banda/);
  const last = await ok(M("band", "remove", "Duo", "Peer"));
  assert.match(last.stdout, /foi dissolvida/);
  assert.equal(await bandNode("Duo"), undefined);
  assert.match((await M("band", "dissolve", "Duo")).stderr, /não encontrada/);

  // dismiss de um dos dois últimos membros dissolve a banda
  await ok(M("band", "create", "Par", "Worker", "Terceiro", "--without-me"));
  await ok(M("dismiss", "Terceiro"));
  assert.equal(await bandNode("Par"), undefined);
});

test("recruit estando numa banda entra nela em vez de ganhar corda; --band escolhe a banda", async () => {
  await ok(M("band", "create", "Time", "Chefe", "Worker"));
  const band = await bandNode("Time");
  await ok(M("recruit", "Entrante", "--preset", "shell"));
  const e = await byTitle("Entrante");
  assert.ok((await bandNode("Time")).data.members.includes(e.id));
  assert.ok(await edgeBetween(band.id, e.id));
  assert.ok(!(await edgeBetween("maestro", e.id)), "sem corda direta para mim");
  // pela banda eu ainda alcanço o recruta
  assert.match((await ok(M("list"))).stdout, /Entrante/);
  assert.equal((await ok(M("check", "Entrante"))).code, 0);

  await ok(M("band", "dissolve", "Time"));
  // --band com a banda de fora (--without-me): o recruta entra nela, sem corda direta
  await ok(M("band", "create", "Fora", "Worker", "Peer", "--without-me"));
  await ok(M("recruit", "Extra", "--preset", "shell", "--band", "Fora"));
  const x = await byTitle("Extra");
  assert.ok((await bandNode("Fora")).data.members.includes(x.id));
  assert.ok(!(await edgeBetween("maestro", x.id)));
  assert.match((await M("recruit", "Y", "--preset", "shell", "--band", "Fantasma")).stderr, /Banda "Fantasma" não encontrada/);
  assert.equal(await byTitle("Y"), undefined);
  await ok(M("band", "dissolve", "Fora"));
});

// ---------- alcance do Maestro ----------

test("Maestro resolve pelo nome as notas e os portais dos recrutas diretos", async () => {
  // "Nota do Worker" não está ligada ao Chefe, só ao Worker
  assert.ok(!(await edgeBetween("maestro", "nota-w")));
  const r = await ok(M("note", "read", "Nota do Worker"));
  assert.match(r.stdout, /worker-secret/);
  // quem não é Maestro não ganha esse alcance
  const w = await maestri("peer", ["note", "read", "Nota do Worker"]);
  assert.equal(w.code, 1);
  assert.match(w.stderr, /não está conectado|não encontrad/);
  // o list do Maestro mostra os portais dos colegas aninhados
  assert.match((await ok(M("list"))).stdout, /↳ Portal do Worker \(portal\)/);
});

// ---------- andares (F16) ----------

const git = (...args: string[]) => new Promise<void>((resolve, reject) => execFile("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], (e) => (e ? reject(e) : resolve())));

test("andares: recruit --floor usa o checkout do andar; recruta herda o andar de quem o criou", async () => {
  fs.writeFileSync(path.join(repo, "README.md"), "x");
  await git("init", "-q");
  await git("add", "-A");
  await git("commit", "-q", "-m", "init");
  await ok(M("floor", "create", "Experiment", "--no-git"));
  await ok(M("floor", "create", "Iso", "--branch", "feat/iso"));

  const plain = await ok(M("recruit", "Plain", "--preset", "shell", "--floor", "experiment"));
  assert.match(plain.stdout, /recrutado/);
  assert.equal((await byTitle("Plain")).data.floor, "Experiment");
  assert.ok(await edgeBetween("maestro", (await byTitle("Plain")).id), "a corda cruza andares");

  await ok(M("recruit", "Iso", "--preset", "shell", "--floor", "Iso"));
  const iso = await byTitle("Iso");
  assert.equal(iso.data.floor, "Iso");
  // Marcador no lugar de esperar silêncio (o bash de login pode demorar com a máquina carregada): o texto digitado traz
  // "CWD[$(pwd -P)]" literal e só a SAÍDA tem o caminho depois do "[" — o `check` repete até casar.
  await ok(M("send", "Iso", "echo CWD[$(pwd -P)]"));
  let where = "";
  await until(async () => ((where = /CWD\[(\/[^\]]+)\]/.exec((await M("check", "Iso")).stdout)?.[1] ?? ""), where !== ""), "cwd do terminal", 30000);
  assert.match(where, /\.worktrees\//, "cwd = checkout do andar");

  await ok(M("recruit", "Terra", "--preset", "shell", "--floor", "Ground"));
  assert.equal((await byTitle("Terra")).data.floor, undefined);
  const bad = await M("recruit", "Nada", "--preset", "shell", "--floor", "Fantasma");
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /Andar "Fantasma" não encontrado. Existentes: Ground, .*Experiment/);
  assert.equal(await byTitle("Nada"), undefined);

  // um Maestro no andar Experiment: o que ele recruta nasce no andar dele
  await ok(M("preset", "create", "SubChefe", "--command", "echo SUB", "--maestro", "on"));
  await ok(M("recruit", "SubM", "--preset", "SubChefe", "--floor", "Experiment"));
  const sub = await byTitle("SubM");
  await ok(maestri(sub.id, ["recruit", "Filho", "--preset", "shell"]));
  const filho = await byTitle("Filho");
  assert.equal(filho.data.floor, "Experiment");
  assert.ok(await edgeBetween(sub.id, filho.id));
  await M("preset", "delete", "SubChefe");
});

test("andares: notas/portais só ligam no mesmo andar; agente↔agente cruza", async () => {
  // "Nota de Outro Andar" (Experiment) está ligada ao Peer (Ground): não liga a um agente do térreo...
  const cross = await M("connect", "Nota de Outro Andar", "Chefe");
  assert.equal(cross.code, 1);
  assert.match(cross.stderr, /só se ligam no mesmo andar/);
  // ...mas liga a um agente do andar dela
  await ok(M("connect", "Nota de Outro Andar", "Plain"));
  assert.ok(await edgeBetween("nota-floor", (await byTitle("Plain")).id));
  // agente do térreo ↔ agente de outro andar: ok
  await ok(M("connect", "Peer", "Plain"));
});

test("andares: band create --floor reúne quem alcanço no andar (de fora) e a banda nasce lá", async () => {
  await ok(M("band", "create", "ExpBand", "--floor", "Experiment"));
  const band = await bandNode("ExpBand");
  assert.equal(band.data.floor, "Experiment");
  const titles = (await canvas()).nodes.filter((n: any) => band.data.members.includes(n.id)).map((n: any) => n.data.title).sort();
  assert.deepEqual(titles, ["Filho", "Plain", "SubM"].filter((t) => titles.includes(t)));
  assert.ok(titles.includes("Plain") && titles.includes("SubM"));
  assert.ok(!band.data.members.includes("maestro"), "fora do meu andar eu coordeno de fora");
  assert.ok(await edgeBetween(band.id, "maestro"));

  // recruta no andar da banda entra nela (--band); em outro andar é recusado
  await ok(M("recruit", "Entra", "--preset", "shell", "--floor", "Experiment", "--band", "ExpBand"));
  assert.ok((await bandNode("ExpBand")).data.members.includes((await byTitle("Entra")).id));
  const wrong = await M("recruit", "Errado", "--preset", "shell", "--band", "ExpBand");
  assert.equal(wrong.code, 1);
  assert.match(wrong.stderr, /está no andar "Experiment", não em "Ground"/);
  assert.equal(await byTitle("Errado"), undefined);
  // add de agente de outro andar é recusado
  assert.match((await M("band", "add", "ExpBand", "Peer")).stderr, /andar da banda/);
  assert.match((await M("band", "create", "NoFloor", "--floor", "Fantasma")).stderr, /Andar "Fantasma" não encontrado/);
  await ok(M("band", "dissolve", "ExpBand"));
});
