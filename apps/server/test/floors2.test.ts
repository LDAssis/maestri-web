import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { rmTmp, installFakeBin } from "./rmtmp.js";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maestri-floors2-test-")));
const repo = path.join(tmp, "repo");
const origin = path.join(tmp, "origin.git");
const ghDir = path.join(tmp, "gh");
fs.mkdirSync(repo);
fs.mkdirSync(ghDir);
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

git(repo, "init", "-b", "main");
fs.writeFileSync(path.join(repo, ".gitignore"), ".worktrees\n.maestri_data\n");
fs.writeFileSync(path.join(repo, "a.txt"), "um\n");
git(repo, "add", "-A");
git(repo, "commit", "-m", "init");
git(tmp, "init", "--bare", "-b", "main", origin);
git(repo, "remote", "add", "origin", origin);
git(repo, "push", "-q", "origin", "main");
// branches de PR no origin: feat-x e feat-y (mesmo repositório) e pull/9/head (fork)
for (const b of ["feat-x", "feat-y"]) {
  git(repo, "checkout", "-q", "-b", b);
  fs.writeFileSync(path.join(repo, `${b}.txt`), `${b}\n`);
  git(repo, "add", `${b}.txt`);
  git(repo, "commit", "-m", b);
  git(repo, "push", "-q", "origin", b);
  git(repo, "checkout", "-q", "main");
  git(repo, "branch", "-D", b);
}
git(repo, "checkout", "-q", "-b", "forkhead");
fs.writeFileSync(path.join(repo, "fork.txt"), "fork\n");
git(repo, "add", "fork.txt");
git(repo, "commit", "-m", "fork");
git(repo, "push", "-q", "origin", "forkhead:refs/pull/9/head");
git(repo, "checkout", "-q", "main");
git(repo, "branch", "-D", "forkhead");

// gh falso: devolve o JSON de $GH_FAKE_DIR/pr-N.json (ou erro de autenticação se existir "unauth")
installFakeBin(ghDir, "gh", `[ -f "$GH_FAKE_DIR/unauth" ] && { echo "To get started with GitHub CLI, please run:  gh auth login" >&2; exit 4; }
f="$GH_FAKE_DIR/pr-$3.json"
[ -f "$f" ] && cat "$f" || { echo "no pull requests found for #$3" >&2; exit 1; }`);
const pr = (n: number, extra: object) => fs.writeFileSync(path.join(ghDir, `pr-${n}.json`), JSON.stringify({ number: n, title: `Titulo ${n}`, state: "OPEN", url: `https://github.com/acme/app/pull/${n}`, headRefName: "x", headRepositoryOwner: { login: "acme" }, isCrossRepository: false, ...extra }));
pr(5, { headRefName: "feat-x", reviewDecision: "APPROVED", statusCheckRollup: [{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }, { status: "IN_PROGRESS" }] });
pr(6, { headRefName: "feat-y" });
pr(7, { headRefName: "feat-z", state: "MERGED" });
pr(9, { headRefName: "forkhead", isCrossRepository: true, headRepositoryOwner: { login: "alguem" } });

process.env.PATH = `${ghDir}${path.delimiter}${process.env.PATH}`;
process.env.GH_FAKE_DIR = ghDir;
// Windows: core.autocrlf=true converteria os arquivos do teste para CRLF no checkout (herdado pelo git do servidor)
process.env.GIT_CONFIG_COUNT = "1";
process.env.GIT_CONFIG_KEY_0 = "core.autocrlf";
process.env.GIT_CONFIG_VALUE_0 = "false";
process.env.REPO_PATH = repo;
process.env.NODE_ENV = "test";
process.env.MAESTRI_TOKEN = "tok-f2";

const { fastify } = await import("../src/index.js");
const { parsePrRef } = await import("../src/floorsApi.js");
const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/maestri");
const P = "proj-maestri-web";
const auth = { authorization: "Bearer tok-f2" };
let port = 0;
const sockets: WebSocket[] = [];

function maestri(nodeId: string, args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      [bin, ...args],
      { env: { ...process.env, MAESTRI_API_URL: `http://127.0.0.1:${port}/api`, MAESTRI_PROJECT_ID: P, MAESTRI_NODE_ID: nodeId, MAESTRI_TOKEN: "tok-f2" } },
      (err, stdout, stderr) => resolve({ code: err ? ((err as any).code ?? 1) : 0, stdout, stderr }),
    );
  });
}
const ok = async (args: string[]) => {
  const r = await maestri("maestro", args);
  assert.equal(r.code, 0, r.stderr);
  return r.stdout;
};
const fail = async (args: string[], re: RegExp) => {
  const r = await maestri("maestro", args);
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stderr, re);
};
const state = async () => (await fastify.inject({ method: "GET", url: `/api/projects/${P}/canvas`, headers: auth })).json();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const resetCanvas = (nodes: any[] = [], edges: any[] = []) =>
  fastify.inject({ method: "POST", url: `/api/projects/${P}/canvas`, headers: auth, payload: { nodes: [{ id: "maestro", type: "agentTerminal", position: { x: 0, y: 0 }, data: { title: "Maestro", isMaestro: true } }, ...nodes], edges } });

before(async () => {
  await fastify.listen({ port: 0, host: "127.0.0.1" });
  port = (fastify.server.address() as any).port;
  await resetCanvas();
});
after(async () => {
  sockets.forEach((s) => s.close());
  await fastify.close();
  rmTmp(tmp);
});

test("parsePrRef: número, #número e link", () => {
  assert.equal(parsePrRef("42"), 42);
  assert.equal(parsePrRef("#42"), 42);
  assert.equal(parsePrRef("https://github.com/acme/app/pull/42"), 42);
  assert.equal(parsePrRef("https://github.com/acme/app/pull/42/files?x=1"), 42);
  for (const bad of ["abc", "0", "", "https://x.com/acme"]) assert.throws(() => parsePrRef(bad), /inválido/);
});

test("floor create --copy: clone isolado na mesma branch do térreo; land traz o trabalho de volta (fast-forward)", async () => {
  fs.writeFileSync(path.join(repo, ".env.local"), "X=1\n");
  const out = await ok(["floor", "create", "Isolado", "--copy"]);
  assert.match(out, /clone isolado.*branch main/);
  const dir = path.join(repo, ".worktrees", "isolado");
  assert.ok(fs.statSync(path.join(dir, ".git")).isDirectory()); // clone, não worktree
  assert.equal(git(dir, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  assert.equal(fs.readFileSync(path.join(dir, ".env.local"), "utf8"), "X=1\n");
  assert.match(await ok(["floor", "list"]), /Isolado \(clone, branch main\)/);

  fs.writeFileSync(path.join(dir, "novo.txt"), "do clone\n");
  await fail(["floor", "land", "Isolado"], /não commitado/);
  git(dir, "add", "novo.txt");
  git(dir, "commit", "-m", "clone");
  assert.match(await ok(["floor", "land", "Isolado"]), /Land de "Isolado" concluído/);
  assert.equal(fs.readFileSync(path.join(repo, "novo.txt"), "utf8"), "do clone\n");
  assert.equal(git(repo, "log", "-1", "--format=%s"), "clone"); // fast-forward, sem commit de merge
  assert.ok(!fs.existsSync(dir));
  assert.equal(git(repo, "for-each-ref", "refs/maestri"), "");
  assert.doesNotMatch(await ok(["floor", "list"]), /Isolado/);
});

test("floor create --copy --branch nova: land cria a branch no repositório; conflito é recusado", async () => {
  await ok(["floor", "create", "Nova", "--copy", "--branch", "nova"]);
  const dir = path.join(repo, ".worktrees", "nova");
  assert.equal(git(dir, "rev-parse", "--abbrev-ref", "HEAD"), "nova");
  await fail(["floor", "create", "Outra", "--copy", "--branch", "nova"], /já existe/).catch(() => {});
  fs.writeFileSync(path.join(dir, "n.txt"), "n\n");
  git(dir, "add", "n.txt");
  git(dir, "commit", "-m", "nova");
  await fail(["floor", "land", "Nova", "--delete-branch"], /não se aplica/);
  await ok(["floor", "land", "Nova"]);
  assert.equal(git(repo, "log", "-1", "--format=%s", "nova"), "nova");
  git(repo, "branch", "-D", "nova");

  // conflito: mesmo arquivo alterado no clone e no térreo
  await ok(["floor", "create", "Conf", "--copy"]);
  const c = path.join(repo, ".worktrees", "conf");
  fs.writeFileSync(path.join(c, "a.txt"), "no clone\n");
  git(c, "commit", "-am", "clone");
  fs.writeFileSync(path.join(repo, "a.txt"), "no térreo\n");
  git(repo, "commit", "-am", "térreo");
  await fail(["floor", "land", "Conf"], /Conflito.*a\.txt.*nada foi alterado/);
  assert.equal(git(repo, "status", "--porcelain", "--untracked-files=no"), "");
  assert.ok(fs.existsSync(c));
  assert.equal(git(repo, "for-each-ref", "refs/maestri"), "");
  // delete: recusa commits não trazidos; --keep-branch preserva e remove o clone
  await fail(["floor", "delete", "Conf"], /commit\(s\) fora de main/);
  const kept = await ok(["floor", "delete", "Conf", "--keep-branch"]);
  assert.match(kept, /branch maestri\/conf mantida/); // o clone estava em main, que já existe no repositório
  assert.ok(!fs.existsSync(c));
  assert.equal(git(repo, "log", "-1", "--format=%s", "maestri/conf"), "clone");
  git(repo, "branch", "-D", "maestri/conf");
});

test("floor delete remove o clone sem trabalho pendente (e recusa clone sujo sem --force)", async () => {
  await ok(["floor", "create", "Lixo", "--copy"]);
  const d = path.join(repo, ".worktrees", "lixo");
  fs.writeFileSync(path.join(d, "a.txt"), "sujo\n");
  await fail(["floor", "delete", "Lixo"], /não commitadas/);
  await ok(["floor", "delete", "Lixo", "--force"]);
  assert.ok(!fs.existsSync(d));
});

test("floor create --pull-request (mesmo repositório): branch do PR, tracking, nome padrão e guarda o PR", async () => {
  const out = await ok(["floor", "create", "--pull-request", "5"]);
  assert.match(out, /Andar "#5 Titulo 5" criado.*branch feat-x/);
  assert.match(out, /vão para o PR/);
  const wt = path.join(repo, ".worktrees", "5-titulo-5");
  assert.equal(fs.readFileSync(path.join(wt, "feat-x.txt"), "utf8"), "feat-x\n");
  assert.equal(git(wt, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"), "origin/feat-x");
  const list = await ok(["floor", "list"]);
  assert.match(list, /PR #5 https:\/\/github\.com\/acme\/app\/pull\/5/);
  // já tem andar (por número e por link)
  await fail(["floor", "create", "--pull-request", "#5"], /já tem um andar/);
  await fail(["floor", "create", "Outro", "--pull-request", "https://github.com/acme/app/pull/5"], /já tem um andar/);

  // estado do PR para a UI
  const st = (await fastify.inject({ method: "GET", url: `/api/projects/${P}/floors/${encodeURIComponent("#5 Titulo 5")}/pr`, headers: auth })).json();
  assert.deepEqual([st.state, st.review, st.checks], ["OPEN", "APPROVED", { passing: 1, failing: 1, pending: 1 }]);
  assert.equal(st.url, "https://github.com/acme/app/pull/5");
  const noPr = await fastify.inject({ method: "GET", url: `/api/projects/${P}/floors/Ground/pr`, headers: auth });
  assert.equal(noPr.statusCode, 404);
  await ok(["floor", "delete", "#5 Titulo 5", "--keep-branch"]);
  git(repo, "branch", "-D", "feat-x");
});

test("floor create --pull-request: fork (branch pr-N + aviso), --copy, nome explícito e recusas", async () => {
  const fork = await ok(["floor", "create", "Revisão fork", "--pull-request", "9"]);
  assert.match(fork, /branch pr-9/);
  assert.match(fork, /não chegam ao PR/);
  assert.equal(fs.readFileSync(path.join(repo, ".worktrees", "revisao-fork", "fork.txt"), "utf8"), "fork\n");
  await ok(["floor", "delete", "Revisão fork", "--keep-branch"]);
  git(repo, "branch", "-D", "pr-9");

  const copy = await ok(["floor", "create", "--pull-request", "6", "--copy"]);
  assert.match(copy, /clone isolado.*branch feat-y/);
  const dir = path.join(repo, ".worktrees", "6-titulo-6");
  assert.ok(fs.statSync(path.join(dir, ".git")).isDirectory());
  assert.equal(git(dir, "rev-parse", "--abbrev-ref", "HEAD"), "feat-y");
  await fail(["floor", "delete", "#6 Titulo 6"], /fora de main/).catch(() => {});
  await ok(["floor", "delete", "#6 Titulo 6", "--force"]);
  git(repo, "branch", "-D", "feat-y");

  await fail(["floor", "create", "--pull-request", "7"], /não está aberto \(merged\)/);
  await fail(["floor", "create", "--pull-request", "404"], /gh falhou.*no pull requests/);
  await fail(["floor", "create", "--pull-request", "abc"], /inválido/);
  await fail(["floor", "create", "X", "--pull-request", "5", "--no-git"], /não combina/);
  await fail(["floor", "create", "X", "--pull-request", "5", "--branch", "b"], /não combina/);
  fs.writeFileSync(path.join(ghDir, "unauth"), "");
  await fail(["floor", "create", "--pull-request", "5"], /não está autenticado/);
  fs.rmSync(path.join(ghDir, "unauth"));
  // a branch local do PR divergiu: recusa
  git(repo, "branch", "feat-x", "main");
  await fail(["floor", "create", "--pull-request", "5"], /divergiu/);
  git(repo, "branch", "-D", "feat-x");
});

test("desenhos: nós type drawing são validados, sincronizados em tempo real e persistidos; floor delete apaga os do andar", async () => {
  await resetCanvas();
  await ok(["floor", "create", "Quadro", "--no-git"]);
  const open = async (clientId: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/project/${P}?token=tok-f2&clientId=${clientId}`);
    const got: any[] = [];
    ws.on("message", (m) => got.push(JSON.parse(m.toString())));
    await new Promise((r) => ws.on("open", r));
    sockets.push(ws);
    return { ws, got };
  };
  const a = await open("a");
  const b = await open("b");
  const drawing = (id: string, data: object, floor?: string) => ({ id, type: "drawing", position: { x: 10, y: 20 }, style: { width: 120, height: 80 }, data: { color: "#f43f5e", width: 4, ...(floor && { floor }), ...data } });
  const send = (ws: WebSocket, nodes: any[]) => ws.send(JSON.stringify({ type: "op", op: { kind: "upsertNodes", nodes } }));

  send(a.ws, [drawing("d1", { shape: "pen", points: [0, 0, 0.5, 0.5, 1, 1] }), drawing("d2", { shape: "rect" }, "Quadro")]);
  const until = async (cond: () => boolean, what: string) => {
    const end = Date.now() + 5000;
    while (!cond()) {
      if (Date.now() > end) assert.fail(`timeout: ${what}`);
      await sleep(30);
    }
  };
  await until(() => b.got.some((m) => m.type === "op" && m.op.kind === "upsertNodes" && m.op.nodes.some((n: any) => n.id === "d1")), "B recebe o desenho de A");

  // inválidos: forma desconhecida, pontos não numéricos, pontos demais
  for (const bad of [{ shape: "triangulo" }, { shape: "pen", points: ["x"] }, { shape: "pen", points: new Array(8001).fill(0) }]) {
    send(a.ws, [drawing("ruim", bad)]);
  }
  await until(() => a.got.filter((m) => m.type === "error").length === 3, "3 erros de validação");
  assert.ok(!(await state()).nodes.some((n: any) => n.id === "ruim"));

  // persistência (debounce de 1s)
  const file = path.join(repo, ".maestri_data", `canvas_${P}.json`);
  await until(() => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")).nodes.some((n: any) => n.id === "d1");
    } catch {
      return false;
    }
  }, "canvas persistido com o desenho");
  const saved = JSON.parse(fs.readFileSync(file, "utf8")).nodes.find((n: any) => n.id === "d2");
  assert.deepEqual([saved.type, saved.data.shape, saved.data.floor], ["drawing", "rect", "Quadro"]);

  // floor delete leva os desenhos do andar (e só eles)
  await ok(["floor", "delete", "Quadro"]);
  const ids = (await state()).nodes.map((n: any) => n.id);
  assert.ok(ids.includes("d1") && !ids.includes("d2"));
  await until(() => b.got.some((m) => m.type === "op" && m.op.kind === "removeNodes" && m.op.ids.includes("d2")), "B vê a remoção");
});
