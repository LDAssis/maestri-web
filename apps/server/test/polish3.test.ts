import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maestri-polish3-test-")));
const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "maestri-fakebin-"));
// Programas falsos no PATH: imprimem os argumentos, a conta e a linha de retomada que o agente real imprime ao sair
const fake = (name: string, body: string) => {
  fs.writeFileSync(path.join(fakeBin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
};
fake("claude", `echo "FAKE-CLAUDE ARGS: $* CFG=$CLAUDE_CONFIG_DIR"\n[ -n "$NOID" ] || { echo "Resume this session with:"; echo "claude --resume 11111111-2222-3333-4444-555555555555"; }`);
fake("codex", `echo "FAKE-CODEX ARGS: $* HOME_DIR=$CODEX_HOME"`);
fake("opencode", `echo "FAKE-OPENCODE ARGS: $*"`);
process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH}`;
// Shell sem login/rc: um bash de login reordena o PATH (ex.: ~/.local/bin na frente) e esconderia os programas falsos
process.env.SHELL = "/bin/sh";
process.env.REPO_PATH = repo;
process.env.NODE_ENV = "test";
process.env.MAESTRI_TOKEN = "tok-p3";
process.env.MAESTRI_ASK_QUIET_MS = "400";

const { fastify } = await import("../src/index.js");
const { resumeCommand, programOf, captureResume } = await import("../src/resume.js");
const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/maestri");
const P = "proj-maestri-web";
const auth = { authorization: "Bearer tok-p3" };
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

function maestri(nodeId: string, args: string[], stdin?: string) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(
      process.execPath,
      [bin, ...args],
      { env: { ...process.env, MAESTRI_API_URL: `http://127.0.0.1:${port}/api`, MAESTRI_PROJECT_ID: P, MAESTRI_NODE_ID: nodeId, MAESTRI_TOKEN: "tok-p3" } },
      (err, stdout, stderr) => resolve({ code: err ? ((err as any).code ?? 1) : 0, stdout, stderr }),
    );
    child.stdin?.end(stdin ?? "");
  });
}
const M = (...a: string[]) => maestri("maestro", a);
const ok = async (p: Promise<{ code: number; stdout: string; stderr: string }>) => {
  const r = await p;
  assert.equal(r.code, 0, r.stderr || r.stdout);
  return r;
};
const canvas = async () => (await fastify.inject({ method: "GET", url: `/api/projects/${P}/canvas`, headers: auth })).json();
const byTitle = async (t: string) => (await canvas()).nodes.find((n: any) => n.data?.title === t);
const termOut = async (title: string) => (await M("check", title, "--lines", "200")).stdout;

// Reabre o terminal como o navegador faria: WS com o cmd do nó (a sessão antiga já foi encerrada)
async function reopen(node: any) {
  await fastify.inject({ method: "DELETE", url: `/api/projects/${P}/sessions/${node.id}`, headers: auth });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal?project=${P}&node=${node.id}&token=tok-p3&cmd=${encodeURIComponent(node.data.defaultCmd)}`);
  const raw: string[] = [];
  ws.on("message", (m) => raw.push(m.toString()));
  await new Promise((res, rej) => (ws.on("open", res), ws.on("error", rej)));
  return { ws, text: () => raw.join("") };
}

before(async () => {
  await fastify.listen({ port: 0, host: "127.0.0.1" });
  port = (fastify.server.address() as any).port;
  const res = await fastify.inject({
    method: "POST", url: `/api/projects/${P}/canvas`, headers: auth,
    payload: {
      nodes: [
        { id: "maestro", type: "agentTerminal", position: { x: 0, y: 0 }, data: { title: "Chefe", isMaestro: true, defaultCmd: "claude", baseCmd: "claude", preset: "claude" } },
        { id: "worker", type: "agentTerminal", position: { x: 400, y: 0 }, data: { title: "Worker" } },
        { id: "chatty", type: "agentTerminal", position: { x: 800, y: 0 }, data: { title: "Chatty" } },
      ],
      edges: [{ id: "e1", source: "maestro", target: "worker" }, { id: "e2", source: "maestro", target: "chatty" }],
    },
  });
  assert.equal(res.statusCode, 200);
});

after(async () => {
  await fastify.close();
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(fakeBin, { recursive: true, force: true });
});

// ---------- retomada de sessão ----------

test("resumeCommand: claude/codex/opencode, env na frente, caminho completo, shell -c; sem mexer no que já retoma", () => {
  const id = "11111111-2222-3333-4444-555555555555";
  assert.equal(resumeCommand("claude"), "claude --continue");
  assert.equal(resumeCommand("claude --model opus"), "claude --continue --model opus");
  assert.equal(resumeCommand("claude", { program: "claude", id }), `claude --resume ${id}`);
  assert.equal(resumeCommand("claude", { program: "codex", id }), "claude --continue", "id de outro programa é ignorado");
  assert.equal(resumeCommand("ANTHROPIC_BASE_URL=http://localhost:4000 claude --dangerously-skip-permissions"), "ANTHROPIC_BASE_URL=http://localhost:4000 claude --continue --dangerously-skip-permissions");
  assert.equal(resumeCommand("/opt/homebrew/bin/codex --yolo"), "/opt/homebrew/bin/codex resume --last --yolo");
  assert.equal(resumeCommand("codex"), "codex resume --last");
  assert.equal(resumeCommand("codex", { program: "codex", id }), `codex resume ${id}`);
  assert.equal(resumeCommand("opencode"), "opencode --continue");
  assert.equal(resumeCommand('fish -c "claude --model opus"'), 'fish -c "claude --continue --model opus"');
  assert.equal(resumeCommand("sh -c 'codex'"), "sh -c 'codex resume --last'");
  assert.equal(resumeCommand("env FOO=1 claude"), "env FOO=1 claude --continue");
  // já retoma / já tem subcomando: igual
  for (const c of ["claude --continue", "claude -r abc", "claude --resume x", "codex resume --last", "codex exec 'faça x'", "opencode --continue", "opencode -s abc"]) assert.equal(resumeCommand(c), c, c);
  // desconhecidos e shell puro: igual
  for (const c of ["", "npm run dev", "echo claude", "cc", "op run -- claude", "npx claude", "bash"]) assert.equal(resumeCommand(c), c, c);
  // o prompt de role injetado por withRolePrompt não é reenviado
  assert.equal(resumeCommand(`claude "$(cat '/tmp/p/.maestri-roles/agent-1.md')"`), "claude --continue");
  assert.equal(resumeCommand(`codex "$(cat '/tmp/x.md')"`), "codex resume --last");
  assert.equal(programOf("FOO=1 /usr/local/bin/claude --x"), "claude");
  assert.equal(programOf('fish -c "codex --yolo"'), "codex");
  assert.equal(programOf("echo hi"), null);
});

test("captureResume lê a linha de retomada impressa ao sair (com cores)", () => {
  const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  assert.deepEqual(captureResume(`bye\r\n\x1b[1mResume this session with:\x1b[0m\r\n\x1b[36mclaude --resume ${id}\x1b[0m\r\n`), { program: "claude", id });
  assert.deepEqual(captureResume(`To continue: codex resume ${id}`), { program: "codex", id });
  assert.equal(captureResume("claude --resume nao-e-uuid"), null);
  assert.equal(captureResume("nada"), null);
});

test("reabrir um terminal morto retoma: claude --resume <id capturado>; sem id, --continue; env na frente", async () => {
  await ok(M("recruit", "Ret", "--command", "claude --model opus"));
  const n = await byTitle("Ret");
  await until(async () => (await termOut("Ret")).includes("FAKE-CLAUDE ARGS: --model opus"), "primeira execução, sem retomada");
  assert.doesNotMatch(await termOut("Ret"), /ARGS: --(continue|resume)/);
  await until(async () => (await termOut("Ret")).includes("claude --resume 1111"), "linha de retomada impressa");
  await sleep(100);

  const a = await reopen(n);
  await until(() => a.text().includes("FAKE-CLAUDE ARGS: --resume 11111111-2222-3333-4444-555555555555 --model opus"), "relançado com --resume <id>");
  a.ws.close();

  // sem a linha de retomada (NOID): --continue
  await ok(M("recruit", "RetNoId", "--command", "NOID=1 claude"));
  const b0 = await byTitle("RetNoId");
  await until(async () => (await termOut("RetNoId")).includes("FAKE-CLAUDE ARGS:"), "primeira execução");
  const b = await reopen(b0);
  await until(() => b.text().includes("FAKE-CLAUDE ARGS: --continue"), "relançado com --continue");
  b.ws.close();

  await ok(M("recruit", "RetCx", "--command", "codex --yolo"));
  const c = await reopen(await byTitle("RetCx"));
  await until(() => c.text().includes("FAKE-CODEX ARGS: resume --last --yolo"), "codex resume --last");
  c.ws.close();
  await ok(M("recruit", "RetOc", "--command", "opencode"));
  const d = await reopen(await byTitle("RetOc"));
  await until(() => d.text().includes("FAKE-OPENCODE ARGS: --continue"), "opencode --continue");
  d.ws.close();
});

test("recruit --replace e role assign NÃO retomam; toggle do projeto desliga a retomada; restart da UI retoma", async () => {
  await ok(M("role", "create", "Rev", "Revise."));
  await ok(M("recruit", "Fresh", "--command", "NOID=1 claude"));
  await until(async () => (await termOut("Fresh")).includes("FAKE-CLAUDE ARGS:"), "primeira execução");
  await ok(M("recruit", "--replace", "Fresh", "--command", "NOID=1 claude --model sonnet"));
  await until(async () => (await termOut("Fresh")).includes("FAKE-CLAUDE ARGS: --model sonnet"), "replace recomeça");
  assert.doesNotMatch(await termOut("Fresh"), /ARGS: --continue/);
  await ok(M("role", "assign", "Fresh", "Rev"));
  await until(async () => (await termOut("Fresh")).includes("FAKE-CLAUDE ARGS:"), "role assign recomeça");
  assert.doesNotMatch(await termOut("Fresh"), /ARGS: --continue|--resume/);

  // a conversa continua depois de reabrir, e o restart da UI também retoma
  const node = await byTitle("Fresh");
  const again = await reopen(node);
  await until(() => again.text().includes("FAKE-CLAUDE ARGS: --continue"), "reabrir retoma");
  const before = again.text().length;
  const r = await fastify.inject({ method: "POST", url: `/api/projects/${P}/sessions/${node.id}/restart`, headers: auth });
  assert.equal(r.statusCode, 200);
  await until(() => again.text().slice(before).includes("FAKE-CLAUDE ARGS: --continue"), "restart retoma");
  again.ws.close();

  // toggle desligado no projeto: relança do zero
  const put = await fastify.inject({ method: "PUT", url: `/api/projects/${P}/prefs`, headers: auth, payload: { resumeSession: false } });
  assert.equal(put.statusCode, 200);
  assert.equal((await fastify.inject({ method: "GET", url: `/api/projects/${P}/prefs`, headers: auth })).json().resumeSession, false);
  assert.equal((await fastify.inject({ method: "PUT", url: `/api/projects/${P}/prefs`, headers: auth, payload: { resumeSession: "sim" } })).statusCode, 400);
  const off = await reopen(await byTitle("Fresh"));
  await until(() => off.text().includes("FAKE-CLAUDE ARGS:"), "relançado");
  assert.match(off.text(), /FAKE-CLAUDE ARGS: --model sonnet CFG=/, "comando original, sem retomada");
  assert.doesNotMatch(off.text(), /ARGS: --continue/);
  off.ws.close();
  await fastify.inject({ method: "PUT", url: `/api/projects/${P}/prefs`, headers: auth, payload: { resumeSession: true } });
});

// ---------- contas ----------

test("account: create/list/delete (Maestro), validações e proteção de conta em uso", async () => {
  assert.match((await ok(M("account", "list"))).stdout, /claude: "Default"\ncodex: "Default"/);
  assert.match((await ok(M("account", "create", "Work", "--cli", "claude"))).stdout, /Conta "Work" criada para claude/);
  assert.ok(fs.statSync(path.join(dataDir, "accounts", "claude", "Work")).isDirectory());
  await ok(M("account", "create", "Work", "--cli", "codex"));
  await ok(M("account", "create", "Pessoal", "--cli", "codex"));
  const l = (await ok(M("account", "list"))).stdout;
  assert.match(l, /claude: "Default", "Work"/);
  assert.match(l, /codex: "Default", "Pessoal", "Work"/);

  assert.match((await M("account", "create", "work", "--cli", "claude")).stderr, /Já existe/);
  assert.match((await M("account", "create", "Default", "--cli", "claude")).stderr, /Default/);
  assert.match((await M("account", "create", "../x", "--cli", "claude")).stderr, /Nome da conta/);
  assert.match((await M("account", "create", "X", "--cli", "vim")).stderr, /Programa inválido/);
  assert.match((await M("account", "create", "X")).stderr, /--cli/);
  assert.match((await maestri("worker", ["account", "create", "Y", "--cli", "claude"])).stderr, /Apenas o Maestro/);
  assert.equal((await maestri("worker", ["account", "list"])).code, 0);
  assert.match((await M("account", "delete", "Nada", "--cli", "claude")).stderr, /não encontrada/);

  // REST da web
  const rest = (await fastify.inject({ method: "GET", url: "/api/accounts", headers: auth })).json();
  assert.ok(rest.accounts.some((a: any) => a.program === "claude" && a.name === "Work"));
  assert.equal((await fastify.inject({ method: "POST", url: "/api/accounts", headers: auth, payload: { program: "claude", name: "Via UI" } })).statusCode, 200);
  assert.equal((await fastify.inject({ method: "DELETE", url: "/api/accounts/claude/Via%20UI", headers: auth })).statusCode, 200);
  assert.equal((await fastify.inject({ method: "GET", url: "/api/accounts" })).statusCode, 401);
});

test("recruit --account: o terminal recebe CLAUDE_CONFIG_DIR/CODEX_HOME; preset pinado; cópia herda; replace troca só a conta", async () => {
  const claudeWork = path.join(dataDir, "accounts", "claude", "Work");
  const codexWork = path.join(dataDir, "accounts", "codex", "Work");
  await ok(M("recruit", "AcW", "--command", "NOID=1 claude", "--account", "work"));
  assert.equal((await byTitle("AcW")).data.account, "Work");
  await until(async () => (await termOut("AcW")).includes(`CFG=${claudeWork}`), "CLAUDE_CONFIG_DIR da conta");
  await ok(M("recruit", "AcX", "--command", "codex", "--account", "Work"));
  await until(async () => (await termOut("AcX")).includes(`HOME_DIR=${codexWork}`), "CODEX_HOME da conta");
  await ok(M("recruit", "AcD", "--command", "NOID=1 claude", "--account", "Default"));
  assert.equal((await byTitle("AcD")).data.account, undefined);
  await until(async () => (await termOut("AcD")).includes("CFG=\n") || /CFG=\s*$/m.test(await termOut("AcD")), "sem conta = login padrão");

  // erros
  assert.match((await M("recruit", "E1", "--command", "claude", "--account", "Fantasma")).stderr, /não encontrada para claude/);
  assert.match((await M("recruit", "E2", "--command", "npm run dev", "--account", "Work")).stderr, /só existem para comandos claude e codex/);
  assert.match((await M("recruit", "E3", "--command", "codex", "--account", "Pessoal2")).stderr, /não encontrada/);
  assert.equal(await byTitle("E1"), undefined);

  // preset: accounts na listagem; pinar; o recruta herda a conta do preset; --account vence
  await ok(M("preset", "create", "Claude Work", "--command", "NOID=1 claude", "--account", "Work"));
  const list = (await ok(M("preset", "list"))).stdout;
  assert.match(list, /Claude Work .*accounts: "Default", "Work"; starts on "Work"/);
  assert.match(list, /Codex .*accounts: "Default", "Pessoal", "Work"/);
  assert.match((await ok(M("preset", "show", "Claude Work"))).stdout, /conta: Work/);
  await ok(M("recruit", "ViaPreset", "--preset", "Claude Work"));
  assert.equal((await byTitle("ViaPreset")).data.account, "Work");
  await ok(M("recruit", "Override", "--preset", "Claude Work", "--account", "Default"));
  assert.equal((await byTitle("Override")).data.account, undefined);
  assert.match((await M("preset", "set", "Claude Work", "--account", "Nada")).stderr, /não encontrada/);
  assert.match((await M("preset", "create", "Shelly", "--account", "Work")).stderr, /só existem para comandos claude e codex/);
  await ok(M("preset", "set", "Claude Work", "--account", ""));
  assert.doesNotMatch((await ok(M("preset", "show", "Claude Work"))).stdout, /conta:/);
  await ok(M("preset", "set", "Claude Work", "--account", "Work"));
  // trocar o comando para um programa sem contas é recusado enquanto a conta está pinada
  assert.match((await M("preset", "set", "Claude Work", "--command", "echo oi")).stderr, /só existem para comandos claude e codex/);

  // cópia de mim herda a minha conta (mesmo CLI)
  await ok(M("recruit", "--replace", "Chefe", "--account", "Work")).catch(() => {});
  const swap = await ok(M("recruit", "--replace", "AcD", "--account", "Work"));
  assert.match(swap.stdout, /trocado no mesmo lugar/);
  const acd = await byTitle("AcD");
  assert.equal(acd.data.account, "Work");
  assert.equal(acd.data.defaultCmd, "NOID=1 claude", "só a conta muda");
  await until(async () => (await termOut("AcD")).includes(`CFG=${claudeWork}`), "reiniciou na conta nova");
  await ok(M("recruit", "--replace", "AcD", "--account", "Default"));
  assert.equal((await byTitle("AcD")).data.account, null);
  // trocar de CLI não herda a conta do anterior
  await ok(M("recruit", "--replace", "AcW", "--command", "opencode"));
  assert.equal((await byTitle("AcW")).data.account, null);

  // maestri list mostra a conta de cada colega
  assert.match((await ok(M("list"))).stdout, /- AcX \[conta: Work\]/);
  assert.match((await ok(M("list"))).stdout, /- ViaPreset \[conta: Work\]/);

  // delete: recusado enquanto em uso
  const busy = await M("account", "delete", "Work", "--cli", "codex");
  assert.equal(busy.code, 1);
  assert.match(busy.stderr, /em uso por: AcX/);
  await ok(M("dismiss", "AcX"));
  assert.match((await ok(M("account", "delete", "Work", "--cli", "codex"))).stdout, /apagada/);
  assert.ok(!fs.existsSync(codexWork));
});

test("cópia de mim herda a conta do Maestro", async () => {
  await fastify.inject({ method: "POST", url: `/api/projects/${P}/nodes/maestro/chat/reply`, headers: auth, payload: { text: "x" } });
  // o Maestro roda claude: patch da conta e recruta uma cópia
  const st = await canvas();
  const me = st.nodes.find((n: any) => n.id === "maestro");
  await fastify.inject({ method: "POST", url: `/api/projects/${P}/canvas`, headers: auth, payload: { nodes: st.nodes.map((n: any) => (n.id === "maestro" ? { ...me, data: { ...me.data, account: "Work", defaultCmd: "NOID=1 claude", baseCmd: "NOID=1 claude" } } : n)), edges: st.edges } });
  await ok(M("recruit", "Gemeo"));
  assert.equal((await byTitle("Gemeo")).data.account, "Work");
  assert.equal((await byTitle("Gemeo")).data.defaultCmd, "NOID=1 claude");
});

// ---------- anexos do chat ----------

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fake-png-body")]);
const chatOf = async (id: string) => (await byTitle(id === "chatty" ? "Chatty" : id)).data.chat ?? [];

test("say --file <imagem> e --attach: arquivos vão ao servidor com id estável; recall mostra e baixa", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p3-files-"));
  const img = path.join(dir, "grafico.png");
  const pdf = path.join(dir, "relatorio.pdf");
  fs.writeFileSync(img, PNG);
  fs.writeFileSync(pdf, "%PDF-1.4 fake");
  await fastify.inject({ method: "POST", url: `/api/projects/${P}/nodes/chatty/chat/reply`, headers: auth, payload: { text: "abrindo thread" } });

  const a = await ok(maestri("chatty", ["say", "--file", img, "Aqui está o gráfico"]));
  assert.match(a.stdout, /com 1 anexo\(s\)/);
  let msgs = await chatOf("chatty");
  let last = msgs.at(-1);
  assert.equal(last.text, "Aqui está o gráfico");
  assert.equal(last.attachments.length, 1);
  assert.deepEqual({ n: last.attachments[0].name, m: last.attachments[0].mime, i: last.attachments[0].image }, { n: "grafico.png", m: "image/png", i: true });
  assert.match(last.attachments[0].id, /^[0-9a-f]{12}$/);

  await ok(maestri("chatty", ["say", "--attach", pdf, "--attach", img, "Relatório e gráfico"]));
  last = (await chatOf("chatty")).at(-1);
  assert.deepEqual(last.attachments.map((x: any) => [x.name, x.image]), [["relatorio.pdf", false], ["grafico.png", true]]);
  assert.equal(last.attachments[0].mime, "application/pdf");

  // só imagem, sem texto (via stdin vazio não: precisa de --file)
  await ok(maestri("chatty", ["say", "--file", img]));
  assert.equal((await chatOf("chatty")).at(-1).text, "");

  // ![desc](/abs.png) em linha própria vira imagem embutida
  await ok(maestri("chatty", ["say", `Veja:\n![meu grafico](${img})\nfim`]));
  last = (await chatOf("chatty")).at(-1);
  assert.equal(last.attachments.length, 1);
  assert.match(last.text, new RegExp(`^Veja:\\n!\\[meu grafico\\]\\(attachment:${last.attachments[0].id}\\)\\nfim$`));
  // no meio da linha NÃO é tocado
  await ok(maestri("chatty", ["say", `texto ![x](${img}) no meio`]));
  last = (await chatOf("chatty")).at(-1);
  assert.equal(last.attachments, undefined);
  assert.equal(last.text, `texto ![x](${img}) no meio`);

  // recall: ids; recall attachment baixa para um arquivo temporário com os mesmos bytes
  const rec = await ok(maestri("chatty", ["recall", "--turns", "50"]));
  assert.match(rec.stdout, /\[attachments: [0-9a-f]{12} relatorio\.pdf, [0-9a-f]{12} grafico\.png\]/);
  const withPdf = (await chatOf("chatty")).find((m: any) => m.attachments?.some((x: any) => x.name === "relatorio.pdf"));
  const saved = (await ok(maestri("chatty", ["recall", "attachment", withPdf.attachments[0].id]))).stdout.trim();
  assert.ok(saved.startsWith(path.join(os.tmpdir(), "maestri-attachments")));
  assert.equal(fs.readFileSync(saved, "utf8"), "%PDF-1.4 fake");
  const json = JSON.parse((await ok(maestri("chatty", ["recall", "--all", "--json"]))).stdout);
  assert.ok(json.messages.some((m: any) => m.attachments?.length));

  // erros
  assert.match((await maestri("chatty", ["recall", "attachment", "000000000000"])).stderr, /não encontrado/);
  assert.match((await maestri("chatty", ["recall", "attachment"])).stderr, /Uso/);
  assert.match((await maestri("chatty", ["say", "--attach", path.join(dir, "nao-existe.pdf"), "x"])).stderr, /não encontrado/);
  fs.writeFileSync(path.join(dir, "vazio.txt"), "");
  assert.match((await maestri("chatty", ["say", "--attach", path.join(dir, "vazio.txt"), "x"])).stderr, /Arquivo vazio/);
  assert.match((await maestri("chatty", ["say", "--progress", "x", "--attach", pdf])).stderr, /só valem na resposta final/);
  fs.writeFileSync(path.join(dir, "falsa.png"), "isto não é uma imagem");
  assert.match((await maestri("chatty", ["say", `![x](${path.join(dir, "falsa.png")})`])).stderr, /Não é uma imagem/);
  assert.match((await maestri("chatty", ["say", `![x](${path.join(dir, "nao.png")})`])).stderr, /Imagem não encontrada/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("anexos: extensão .png que não é imagem não é embutida; limite de 20MB; sem token = 401; outro projeto não enxerga", async () => {
  const up = async (name: string, data: Buffer, headers = auth) =>
    fastify.inject({ method: "POST", url: `/api/projects/${P}/attachments`, headers, payload: { name, data: data.toString("base64") } });
  const fakePng = (await up("lixo.png", Buffer.from("não sou png"))).json().attachment;
  assert.equal(fakePng.image, false);
  assert.equal(fakePng.mime, "application/octet-stream");
  const real = (await up("../../etc/passwd.png", PNG)).json().attachment;
  assert.equal(real.name, "passwd.png", "nome saneado (sem caminho)");
  assert.equal(real.image, true);

  assert.equal((await up("grande.bin", Buffer.alloc(20 * 1024 * 1024 + 1, 1))).statusCode, 413);
  assert.equal((await up("ok.bin", Buffer.alloc(1024 * 1024, 1))).statusCode, 200);
  assert.equal((await up("vazio.txt", Buffer.alloc(0))).statusCode, 400);
  assert.equal((await fastify.inject({ method: "POST", url: `/api/projects/${P}/attachments`, headers: auth, payload: { name: "x", data: "###" } })).statusCode, 400);
  assert.equal((await up("x.png", PNG, {} as any)).statusCode, 401);

  // download: imagem inline; qualquer outro tipo sempre como download genérico, com cabeçalhos de segurança
  const dl = await fastify.inject({ method: "GET", url: `/api/projects/${P}/attachments/${real.id}`, headers: auth });
  assert.equal(dl.statusCode, 200);
  assert.equal(dl.headers["content-type"], "image/png");
  assert.match(String(dl.headers["content-disposition"]), /^inline/);
  assert.equal(dl.headers["x-content-type-options"], "nosniff");
  assert.deepEqual(dl.rawPayload, PNG);
  const other = await fastify.inject({ method: "GET", url: `/api/projects/${P}/attachments/${fakePng.id}`, headers: auth });
  assert.equal(other.headers["content-type"], "application/octet-stream");
  assert.match(String(other.headers["content-disposition"]), /^attachment/);
  assert.equal((await fastify.inject({ method: "GET", url: `/api/projects/${P}/attachments/${real.id}` })).statusCode, 401);
  assert.equal((await fastify.inject({ method: "GET", url: `/api/projects/${P}/attachments/zzzz`, headers: auth })).statusCode, 404);
  assert.equal((await fastify.inject({ method: "GET", url: `/api/projects/outro-projeto/attachments/${real.id}`, headers: auth })).statusCode, 404);
});

test("anexos do usuário na ChatFace: o texto enviado ao PTY cita o anexo com o comando para obtê-lo", async () => {
  const shellNode = await byTitle("Worker");
  // sessão do Worker (shell) para receber o chat
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal?project=${P}&node=${shellNode.id}&token=tok-p3`);
  const raw: string[] = [];
  ws.on("message", (m) => raw.push(m.toString()));
  await new Promise((res, rej) => (ws.on("open", res), ws.on("error", rej)));
  ws.send("echo PRONTO$((1+1))\r");
  await until(() => raw.join("").includes("PRONTO2"), "shell pronto", 20000);
  await sleep(800);

  const att = (await fastify.inject({ method: "POST", url: `/api/projects/${P}/attachments`, headers: auth, payload: { name: "print.png", data: PNG.toString("base64") } })).json().attachment;
  const author = { id: "u1", name: "Bruno", color: "#3b82f6" };
  const url = `/api/projects/${P}/nodes/worker/chat`;
  assert.equal((await fastify.inject({ method: "POST", url, headers: auth, payload: { text: "", author } })).statusCode, 400, "sem texto nem anexo");
  assert.equal((await fastify.inject({ method: "POST", url, headers: auth, payload: { text: "oi", author, attachments: ["000000000000"] } })).statusCode, 404);
  assert.equal((await fastify.inject({ method: "POST", url, headers: auth, payload: { text: "oi", author, attachments: "x" } })).statusCode, 400);

  const res = await fastify.inject({ method: "POST", url, headers: auth, payload: { text: "olhe isto", author, attachments: [att.id] } });
  assert.equal(res.statusCode, 202, res.body);
  await until(async () => (await byTitle("Worker")).data.chatBusy === false, "chat livre");
  const user = (await byTitle("Worker")).data.chat.find((m: any) => m.role === "user");
  assert.equal(user.attachments[0].id, att.id);
  const typed = raw.join("");
  assert.ok(typed.includes(`maestri recall attachment ${att.id}`), "o PTY recebeu o comando para obter o anexo");
  assert.ok(typed.includes("print.png"));

  // só anexo, sem texto
  await until(async () => (await fastify.inject({ method: "POST", url, headers: auth, payload: { text: "", author, attachments: [att.id] } })).statusCode === 202, "só anexo");
  ws.close();
});
