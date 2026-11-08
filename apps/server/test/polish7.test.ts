import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { rmTmp } from "./rmtmp.js";

const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maestri-polish7-test-")));
process.env.REPO_PATH = repo;
process.env.NODE_ENV = "test";
process.env.MAESTRI_TOKEN = "tok-p7";
process.env.MAESTRI_ASK_QUIET_MS = "400";
process.env.SHELL = "/bin/sh";

const { fastify } = await import("../src/index.js");
const { arrangeColor } = await import("../src/agentSetup.js");
const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/maestri");
const P = "proj-maestri-web";
const auth = { authorization: "Bearer tok-p7" };
const dataDir = path.join(repo, ".maestri_data");
let port = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 10000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) assert.fail(`timeout: ${what}`);
    await sleep(40);
  }
}
function maestri(nodeId: string, args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath, [bin, ...args],
      { env: { ...process.env, MAESTRI_API_URL: `http://127.0.0.1:${port}/api`, MAESTRI_PROJECT_ID: P, MAESTRI_NODE_ID: nodeId, MAESTRI_TOKEN: "tok-p7" } },
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
const req = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object) => fastify.inject({ method, url, headers: auth, payload });
const nodeOf = async (t: string) => (await req("GET", `/api/projects/${P}/canvas`)).json().nodes.find((n: any) => n.data?.title === t);

before(async () => {
  await fastify.listen({ port: 0, host: "127.0.0.1" });
  port = (fastify.server.address() as any).port;
  const res = await req("POST", `/api/projects/${P}/canvas`, {
    nodes: [
      { id: "maestro", type: "agentTerminal", position: { x: 0, y: 0 }, data: { title: "Chefe", isMaestro: true } },
      { id: "chatty", type: "agentTerminal", position: { x: 400, y: 0 }, data: { title: "Chatty" } },
    ],
    edges: [{ id: "e1", source: "maestro", target: "chatty" }],
  });
  assert.equal(res.statusCode, 200);
});

after(async () => {
  await fastify.close();
  rmTmp(repo);
});

// ---------- chat: o que vai ao PTY é sanitizado e o agente não fica preso ----------

test("POST /chat: texto e nome de anexo sem ESC/controles no PTY (nada fecha o bracketed paste); chatBusy solta", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal?project=${P}&node=chatty&token=tok-p7`);
  const raw: string[] = [];
  ws.on("message", (m) => raw.push(m.toString()));
  await new Promise((res, rej) => (ws.on("open", res), ws.on("error", rej)));
  ws.send("echo PRONTO$((1+1))\r");
  await until(() => raw.join("").includes("PRONTO2"), "shell pronto", 20000);
  await sleep(800);

  const author = { id: "u1", name: "B", color: "#3b82f6" };
  const url = `/api/projects/${P}/nodes/chatty/chat`;
  // sem a sanitização, o ESC[201~ encerraria a colagem e a segunda linha rodaria como comando (imprimiria INJETADO2)
  const att = (await req("POST", `/api/projects/${P}/attachments`, { name: "foto\x1b[201~echo NOMEINJ$((1+1)).png", data: Buffer.from("x").toString("base64") })).json().attachment;
  assert.ok(!/[\x00-\x1f]/.test(att.name), "o servidor já limpa o nome na gravação");
  const before = raw.join("").length;
  const r = await req("POST", url, { text: "oi\n\x1b[201~echo INJETADO$((1+1))\x07\x00fim", author, attachments: [att.id] });
  assert.equal(r.statusCode, 202, r.body);
  await until(async () => (await nodeOf("Chatty")).data.chatBusy === false, "chat livre");
  const typed = raw.join("").slice(before);
  assert.doesNotMatch(typed, /^INJETADO2\s*$/m, "o comando injetado não rodou");
  assert.doesNotMatch(typed, /^NOMEINJ2\s*$/m);
  // o histórico guarda o texto como o usuário digitou (a limpeza vale só para o que vai ao terminal)
  const user = (await nodeOf("Chatty")).data.chat.find((m: any) => m.role === "user");
  assert.match(user.text, /INJETADO/);
  // e o agente não ficou preso: a próxima mensagem entra
  assert.equal((await req("POST", url, { text: "de novo", author })).statusCode, 202);
  await until(async () => (await nodeOf("Chatty")).data.chatBusy === false, "chat livre 2");
  ws.close();
});

// ---------- contas fixadas em presets ----------

test("apagar uma conta fixada em presets desafixa e lista quais (CLI e REST)", async () => {
  await ok(M("account", "create", "Work", "--cli", "claude"));
  await ok(M("account", "create", "Outra", "--cli", "claude"));
  await ok(M("preset", "create", "Claude W1", "--command", "claude", "--account", "Work"));
  await ok(M("preset", "create", "Claude W2", "--command", "claude --model opus", "--account", "work"));
  await ok(M("preset", "create", "Claude O", "--command", "claude", "--account", "Outra"));
  // projeto com preset fixando a mesma conta
  fs.writeFileSync(path.join(dataDir, `settings_${P}.json`), JSON.stringify({ defaultCmd: "", cliPresets: [{ id: "p-w", label: "Do Projeto", cmd: "claude", account: "Work" }] }));
  const del = await ok(M("account", "delete", "Work", "--cli", "claude"));
  assert.match(del.stdout, /Conta "Work" apagada \(claude\)\. Presets desafixados \(voltam ao login padrão\): "Claude W1", "Claude W2", "Do Projeto"\./);
  const g = JSON.parse(fs.readFileSync(path.join(dataDir, "global_settings.json"), "utf8")).cliPresets;
  assert.equal(g.find((p: any) => p.id === "claude-w1").account, undefined);
  assert.equal(g.find((p: any) => p.id === "claude-w2").account, undefined);
  assert.equal(g.find((p: any) => p.id === "claude-o").account, "Outra", "outras contas ficam");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, `settings_${P}.json`), "utf8")).cliPresets[0].account, undefined);
  assert.doesNotMatch((await ok(M("preset", "show", "Claude W1"))).stdout, /conta:/);
  // REST devolve a lista; sem presets afetados, nada a avisar
  await ok(M("account", "create", "Via UI", "--cli", "claude"));
  await ok(M("preset", "set", "Claude O", "--account", "Via UI"));
  const rest = await req("DELETE", "/api/accounts/claude/Via%20UI");
  assert.deepEqual(rest.json(), { ok: true, name: "Via UI", unpinned: ["Claude O"] });
  const plain = await ok(M("account", "delete", "Outra", "--cli", "claude"));
  assert.doesNotMatch(plain.stdout, /desafixados/);
  fs.rmSync(path.join(dataDir, `settings_${P}.json`));
});

// ---------- cores dos presets ----------

test("cor antiga de preset (purple, amber...) vira a da paleta do arrange no recruta e na rota da UI", async () => {
  assert.deepEqual(["purple", "Pink", "teal", "yellow", "amber", "slate", "magenta", undefined].map(arrangeColor), ["violet", "rose", "emerald", "amber", "amber", "slate", undefined, undefined]);
  // o preset padrão `agy` das configurações tem color: purple
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, "global_settings.json"), "utf8")).cliPresets.find((p: any) => p.id === "agy")?.color ?? "purple", "purple");
  const list = (await req("GET", `/api/projects/${P}/presets`)).json().presets;
  assert.equal(list.find((p: any) => p.id === "agy").color, "violet", "o preset já sai com a cor do arrange");
  await ok(M("recruit", "ViaAgy", "--preset", "agy", "--command", "echo AGY"));
  assert.equal((await nodeOf("ViaAgy")).data.color, "violet");
  // --color explícito vence
  await ok(M("recruit", "ViaAgy2", "--preset", "agy", "--command", "echo AGY", "--color", "rose"));
  assert.equal((await nodeOf("ViaAgy2")).data.color, "rose");
  // rota da UI: mesma tradução; cor sem equivalente e ícone inválido são ignorados
  const a = await req("POST", `/api/projects/${P}/agents`, { title: "UiCor", preset: "shell", color: "purple", icon: "bot" });
  assert.equal(a.statusCode, 201, a.body);
  assert.deepEqual([a.json().node.data.color, a.json().node.data.icon], ["violet", "bot"]);
  const b = await req("POST", `/api/projects/${P}/agents`, { title: "UiSemCor", preset: "shell", color: "magenta", icon: "nao-existe" });
  assert.deepEqual([b.json().node.data.color, b.json().node.data.icon], [undefined, undefined]);
});

// ---------- roles globais e paridade da rota da UI ----------

test("roles globais valem no recruit e na rota da UI sem cópia; a UI usa a pasta de role como o CLI", async () => {
  await ok(M("role", "create", "Global Dev", "Escreva código limpo.", "--scope", "global"));
  const globalRole = (await ok(M("role", "show", "Global Dev"))).stdout;
  assert.match(globalRole, /\(global\)/);
  const gid = fs.readdirSync(path.join(dataDir, "global-roles", ".maestri", "roles"))[0];
  // CLI: por nome e por id
  await ok(M("recruit", "G1", "--preset", "opencode", "--role", "Global Dev"));
  await ok(M("recruit", "G2", "--preset", "opencode", "--role-id", gid.toUpperCase()));
  for (const t of ["G1", "G2"]) {
    const n = await nodeOf(t);
    assert.equal(n.data.roleDir, true, t);
    assert.match(fs.readFileSync(path.join(repo, n.data.worktreePath, "AGENTS.md"), "utf8"), /Escreva código limpo\./);
  }
  // UI: POST /agents com o id do role global (sem /materialize-global)
  const ui = await req("POST", `/api/projects/${P}/agents`, { title: "UiG", preset: "claude", roleId: gid });
  assert.equal(ui.statusCode, 201, ui.body);
  const d = ui.json().node.data;
  assert.deepEqual([d.role, d.defaultCmd, d.roleDir, d.worktreePath], ["Global Dev", "claude", true, path.join(".maestri", "roles", gid)]);
  assert.match(fs.readFileSync(path.join(repo, d.worktreePath, "CLAUDE.md"), "utf8"), /Escreva código limpo\./);
  // o role global NÃO é copiado para o projeto (nada de role.json na pasta de contexto)
  assert.ok(!fs.existsSync(path.join(repo, ".maestri", "roles", gid, "role.json")));
  assert.ok(!(await req("GET", `/api/projects/${P}/roles`)).json().roles.some((r: any) => r.id.toLowerCase() === gid));
  assert.equal((await req("POST", `/api/projects/${P}/roles/materialize-global`, { roleId: gid })).statusCode, 404);
  assert.equal((await req("POST", `/api/projects/${P}/agents`, { title: "Nada", preset: "shell", roleId: "00000000-0000-4000-8000-000000000000" })).statusCode, 404);
  assert.equal((await req("POST", `/api/projects/${P}/agents`, { title: "Ruim", preset: "shell", roleId: "x" })).statusCode, 400);
  // editar/apagar roles do PROJETO continua só no projeto (um id global não é editável por essa rota)
  assert.equal((await req("PUT", `/api/projects/${P}/roles/${gid}`, { name: "X" })).statusCode, 404);
});
