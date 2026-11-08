import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { resumeCommand, validModel, withModel } from "../src/resume.js";
import { installFakeBin, rmTmp } from "./rmtmp.js";

const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maestri-model-test-")));
const fakeBin = path.join(repo, "fakebin");
fs.mkdirSync(fakeBin);
const calls = path.join(repo, "codex-calls");
// `claude` falso: imprime os argumentos recebidos (saída do programa, não eco do que foi digitado)
installFakeBin(fakeBin, "claude", 'echo "ARGS[$*]"');
installFakeBin(fakeBin, "codex", `echo x >> '${calls.replace(/\\/g, "/")}'; echo '{"models":[{"slug":"gpt-5.1-codex","display_name":"GPT 5.1 Codex"},"o3"]}'`);
installFakeBin(fakeBin, "opencode", "echo anthropic/claude-sonnet-4; echo openai/gpt-5");
const originalPath = process.env.PATH ?? "";
process.env.PATH = `${fakeBin}${path.delimiter}${originalPath}`;
process.env.REPO_PATH = repo;
process.env.NODE_ENV = "test";
process.env.MAESTRI_TOKEN = "tok-model";

const { fastify } = await import("../src/index.js");
const { clearModelsCache } = await import("../src/models.js");
const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/maestri");
const P = "proj-maestri-web";
const auth = { authorization: "Bearer tok-model" };
let port = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 10000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) assert.fail(`timeout: ${what}`);
    await sleep(40);
  }
}
const maestri = (args: string[]) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      [bin, ...args],
      { env: { ...process.env, MAESTRI_API_URL: `http://127.0.0.1:${port}/api`, MAESTRI_PROJECT_ID: P, MAESTRI_NODE_ID: "maestro", MAESTRI_TOKEN: "tok-model" } },
      (err, stdout, stderr) => resolve({ code: err ? ((err as any).code ?? 1) : 0, stdout, stderr }),
    );
  });
const canvas = async () => (await fastify.inject({ method: "GET", url: `/api/projects/${P}/canvas`, headers: auth })).json();
const sessionPid = async (nodeId: string) => (await fastify.inject({ method: "GET", url: `/api/projects/${P}/sessions`, headers: auth })).json().find((s: any) => s.nodeId === nodeId)?.pid;

// ---------- montagem do comando (sem servidor) ----------
test("withModel acrescenta a flag certa de cada CLI, pelo executável", () => {
  assert.equal(withModel("claude", "opus"), "claude --model opus");
  assert.equal(withModel("codex", "gpt-5.1-codex"), "codex -m gpt-5.1-codex");
  assert.equal(withModel("opencode", "anthropic/claude-sonnet-4"), "opencode -m anthropic/claude-sonnet-4");
  assert.equal(withModel("agy", "gemini-2.5"), "agy --model=gemini-2.5");
  // caminho completo, variáveis na frente e argumentos já existentes
  assert.equal(withModel("FOO=1 /usr/local/bin/claude --dangerously-skip-permissions", "sonnet"), "FOO=1 /usr/local/bin/claude --model sonnet --dangerously-skip-permissions");
  // prompt de role (injetado por withRolePrompt) continua no fim
  assert.equal(withModel(`claude "$(cat '/r/agent-1.md')"`, "haiku"), `claude --model haiku "$(cat '/r/agent-1.md')"`);
  // dentro de sh -c
  assert.equal(withModel('sh -c "claude --verbose"', "opus"), 'sh -c "claude --model opus --verbose"');
});

test("withModel ignora shell/desconhecido, modelo vazio e comando que já escolheu modelo", () => {
  for (const cmd of ["", "bash", "npm run dev", "python3 app.py"]) assert.equal(withModel(cmd, "opus"), cmd);
  for (const m of [undefined, null, ""]) assert.equal(withModel("claude", m), "claude");
  assert.equal(withModel("claude --model haiku", "opus"), "claude --model haiku");
  assert.equal(withModel("claude --model=haiku", "opus"), "claude --model=haiku");
  assert.equal(withModel("codex -m o3", "gpt-5"), "codex -m o3");
  assert.equal(withModel("agy --model=x", "y"), "agy --model=x");
});

test("allowlist: só [A-Za-z0-9._:/@-] começando por letra/número; o resto nunca vira comando", () => {
  for (const ok of ["opus", "claude-opus-5-5", "gpt-5.1-codex", "anthropic/claude-sonnet-4", "ollama/llama3:8b", "a@b.c"]) assert.ok(validModel(ok), ok);
  for (const bad of ["", " ", "a b", "a;b", "$(x)", "`x`", "a|b", "a&b", "a'b", 'a"b', "a\nb", "--model", "-m", "é", "a".repeat(101), 5, null, undefined]) assert.ok(!validModel(bad), String(bad));
  assert.equal(withModel("claude", "a b; rm -rf /"), "claude");
  assert.equal(withModel("claude", "$(id)"), "claude");
});

test("retomada mantém o modelo (e a ordem não atrapalha)", () => {
  assert.equal(resumeCommand(withModel("claude", "opus")), "claude --continue --model opus");
  assert.equal(resumeCommand(withModel("claude", "opus"), { program: "claude", id: "11111111-2222-3333-4444-555555555555" }), "claude --resume 11111111-2222-3333-4444-555555555555 --model opus");
  assert.equal(resumeCommand(withModel("codex", "o3")), "codex resume --last -m o3");
  assert.equal(resumeCommand(withModel("opencode", "openai/gpt-5")), "opencode --continue -m openai/gpt-5");
  assert.equal(resumeCommand(withModel(`claude "$(cat '/r/a.md')"`, "opus")), "claude --continue --model opus", "o prompt do role não volta ao retomar");
  assert.equal(resumeCommand(withModel("agy", "x")), "agy --model=x", "agy não tem retomada");
});

// ---------- servidor ----------
before(async () => {
  await fastify.listen({ port: 0, host: "127.0.0.1" });
  port = (fastify.server.address() as any).port;
  await fastify.inject({
    method: "POST", url: `/api/projects/${P}/canvas`, headers: auth,
    payload: {
      nodes: [
        { id: "maestro", type: "agentTerminal", position: { x: 0, y: 0 }, style: { width: 460, height: 330 }, data: { title: "Maestro", isMaestro: true } },
        { id: "ag", type: "agentTerminal", position: { x: 600, y: 0 }, style: { width: 460, height: 330 }, data: { title: "Ag", preset: "claude", baseCmd: "claude", defaultCmd: "claude", model: "opus" } },
      ],
      edges: [{ id: "e1", source: "maestro", target: "ag" }],
    },
  });
});
after(async () => {
  process.env.PATH = originalPath;
  await fastify.close();
  rmTmp(repo);
});

test("o terminal sobe com a flag do modelo; mudar data.model (patchNodeData) reinicia retomando e mantém/atualiza o modelo", async () => {
  let out = "";
  const term = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal?project=${P}&node=ag&token=tok-model&cmd=claude`); // o cliente manda o defaultCmd do nó
  term.on("message", (m) => (out += m.toString()));
  await new Promise((r) => term.on("open", r));
  await until(() => out.includes("ARGS[--model opus]"), "claude subiu com --model opus");
  const pid1 = await sessionPid("ag");

  const proj = new WebSocket(`ws://127.0.0.1:${port}/ws/project/${P}?token=tok-model&clientId=ui`);
  const errors: string[] = [];
  proj.on("message", (m) => {
    try {
      const msg = JSON.parse(m.toString());
      if (msg.type === "error") errors.push(msg.error);
    } catch {}
  });
  await new Promise((r) => proj.on("open", r));
  const op = (data: object) => proj.send(JSON.stringify({ type: "op", op: { kind: "patchNodeData", id: "ag", data } }));

  op({ model: "sonnet" });
  await until(() => out.includes("ARGS[--continue --model sonnet]"), "reiniciou retomando com o modelo novo");
  const pid2 = await sessionPid("ag");
  assert.notEqual(pid2, pid1, "terminal reiniciado");
  assert.equal((await canvas()).nodes.find((n: any) => n.id === "ag").data.model, "sonnet");

  // outro campo (como o isMaestro) não reinicia
  op({ isMaestro: false });
  await sleep(600);
  assert.equal(await sessionPid("ag"), pid2);
  // mesmo modelo de novo: nada a fazer
  op({ model: "sonnet" });
  await sleep(600);
  assert.equal(await sessionPid("ag"), pid2);

  // valor inválido: recusado (erro na conexão), nó e terminal intactos
  op({ model: "$(rm -rf /)" });
  op({ model: "a b" });
  await until(() => errors.length >= 2, "erros de modelo inválido");
  assert.match(errors[0], /Modelo inválido/);
  assert.equal((await canvas()).nodes.find((n: any) => n.id === "ag").data.model, "sonnet");
  assert.equal(await sessionPid("ag"), pid2);

  // vazio = padrão do CLI: reinicia sem a flag
  out = "";
  op({ model: "" });
  await until(() => out.includes("ARGS[--continue]"), "voltou ao modelo padrão");
  proj.close();
  term.close();
});

test("POST /agents e canvas aceitam model com a mesma validação; vazio é ignorado", async () => {
  const post = (body: object) => fastify.inject({ method: "POST", url: `/api/projects/${P}/agents`, headers: auth, payload: body });
  const good = await post({ title: "Com Modelo", preset: "claude", model: "claude-opus-5-5" });
  assert.equal(good.statusCode, 201);
  assert.equal(good.json().node.data.model, "claude-opus-5-5");
  const empty = await post({ title: "Sem Modelo", preset: "claude", model: "" });
  assert.equal(empty.statusCode, 201);
  assert.ok(!("model" in empty.json().node.data));
  for (const model of ["a b", "--x", "x;y", "$(id)", 5]) {
    const r = await post({ title: `Ruim ${String(model).length}`, preset: "claude", model });
    assert.equal(r.statusCode, 400, String(model));
    assert.match(r.json().error, /Modelo inválido/);
  }
  const st = await canvas();
  const replace = await fastify.inject({
    method: "POST", url: `/api/projects/${P}/canvas`, headers: auth,
    payload: { nodes: st.nodes.map((n: any) => (n.id === "ag" ? { ...n, data: { ...n.data, model: "a b" } } : n)), edges: st.edges },
  });
  assert.equal(replace.statusCode, 400);
});

test("maestri recruit --model grava data.model; valor inválido é recusado", async () => {
  const ok = await maestri(["recruit", "Hawk", "--preset", "claude", "--model", "opus"]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal((await canvas()).nodes.find((n: any) => n.data?.title === "Hawk").data.model, "opus");
  const bad = await maestri(["recruit", "Hawk2", "--preset", "claude", "--model", "a b"]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /Modelo inválido/);
  assert.match((await maestri(["recruit", "--help"])).stdout, /--model M/);
});

test("GET /models: claude estático; codex/opencode pelo CLI (com cache); sem o executável, source none; cli inválido 400", async () => {
  const get = (q: string, p = P) => fastify.inject({ method: "GET", url: `/api/projects/${p}/models${q}`, headers: auth });
  const claude = (await get("?cli=claude")).json();
  assert.equal(claude.source, "static");
  assert.deepEqual(claude.models.map((m: any) => m.id), ["opus", "sonnet", "haiku", "fable", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"]);

  clearModelsCache();
  const codex = (await get("?cli=codex")).json();
  assert.equal(codex.source, "cli");
  assert.deepEqual(codex.models, [{ id: "gpt-5.1-codex", label: "GPT 5.1 Codex" }, { id: "o3", label: "o3" }]);
  await get("?cli=codex");
  assert.equal(fs.readFileSync(calls, "utf8").trim().split("\n").length, 1, "segunda chamada veio do cache");
  const opencode = (await get("?cli=opencode")).json();
  assert.equal(opencode.source, "cli");
  assert.deepEqual(opencode.models.map((m: any) => m.id), ["anthropic/claude-sonnet-4", "openai/gpt-5"]);

  // sem o executável no PATH (agy não existe aqui; e com o PATH vazio nenhum existe)
  assert.deepEqual((await get("?cli=agy")).json(), { models: [], source: "none" });
  clearModelsCache();
  const saved = process.env.PATH;
  process.env.PATH = fs.mkdtempSync(path.join(repo, "vazio-"));
  try {
    for (const cli of ["codex", "opencode", "agy"]) assert.deepEqual((await get(`?cli=${cli}`)).json(), { models: [], source: "none" }, cli);
  } finally {
    process.env.PATH = saved;
    clearModelsCache();
  }

  assert.equal((await get("?cli=gemini")).statusCode, 400);
  assert.equal((await get("")).statusCode, 400);
  assert.equal((await get("?cli=claude", "nao-existe")).statusCode, 404);
});
