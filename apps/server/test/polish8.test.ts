import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { rmTmp, installFakeBin } from "./rmtmp.js";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maestri-polish8-test-")));
const repo = path.join(tmp, "repo");
const fakeBin = path.join(tmp, "bin");
const ghDir = path.join(tmp, "gh");
const notifyLog = path.join(tmp, "notify.log");
for (const d of [repo, fakeBin, ghDir]) fs.mkdirSync(d);
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
git(repo, "init", "-b", "main");
fs.writeFileSync(path.join(repo, ".gitignore"), ".worktrees\n.maestri_data\n.maestri\n.maestri-roles\n");
fs.writeFileSync(path.join(repo, "a.txt"), "um\n");
git(repo, "add", "-A");
git(repo, "commit", "-m", "init");

// Programas falsos no PATH: notify-send (registra os argumentos), gh (lista de PRs por branch) e TUIs que mostram o indicador de ocupado
const winSO = process.platform === "win32";
const noSO = winSO && "desktopNotify não faz nada no Windows (só notify-send/osascript)";
const bin = (name: string, body: string) => fs.writeFileSync(path.join(fakeBin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
bin("notify-send", `for a in "$@"; do printf '%s\\n' "$a" >> "${notifyLog}"; done; echo "---" >> "${notifyLog}"`);
installFakeBin(fakeBin, "gh", `[ -f "${ghDir}/unauth" ] && { echo "gh auth login" >&2; exit 4; }\ncase "$2" in\n  list) f="${ghDir}/list-$4.json"; [ -f "$f" ] && cat "$f" || echo "[]" ;;\nesac`);
bin("busyprog", `echo "✻ Working (1s • esc to interrupt)"\nsleep 1.5\necho "RESPOSTA-FINAL"\necho "> pronto"`);
bin("busyprog2", `echo "Thinking… (esc to interrupt)"\nsleep 8\necho "NUNCA-A-TEMPO"`);
process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH}`;
process.env.REPO_PATH = repo;
process.env.NODE_ENV = "test";
process.env.MAESTRI_TOKEN = "tok-p8";
process.env.MAESTRI_ASK_QUIET_MS = "400";
process.env.MAESTRI_PR_POLL_MS = "3600000"; // só o gatilho de ocioso age neste arquivo (o intervalo é testado em polish8-poll)
process.env.MAESTRI_IDLE_MS = "600";
process.env.MAESTRI_DESKTOP_NOTIFY = ""; // padrão: ligado em loopback
process.env.SHELL = "/bin/sh";

const { fastify } = await import("../src/index.js");
const { desktopNotify, desktopNotifyEnabled, configureDesktopNotify, osascriptArgs, appleString } = await import("../src/desktopNotify.js");
const { busyIndicator } = await import("../src/nodeApi.js");
const { withRolePrompt } = await import("../src/agents.js");
const binCli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/maestri");
const P = "proj-maestri-web";
const auth = { authorization: "Bearer tok-p8" };
let port = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 12000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) assert.fail(`timeout: ${what}`);
    await sleep(40);
  }
}
function maestri(nodeId: string, args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath, [binCli, ...args],
      { env: { ...process.env, MAESTRI_API_URL: `http://127.0.0.1:${port}/api`, MAESTRI_PROJECT_ID: P, MAESTRI_NODE_ID: nodeId, MAESTRI_TOKEN: "tok-p8" } },
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
// Notificações registradas pelo notify-send falso: cada uma = lista de argumentos
const notifications = () => {
  try {
    return fs.readFileSync(notifyLog, "utf8").split("---\n").filter(Boolean).map((b) => b.trimEnd().split("\n"));
  } catch {
    return [];
  }
};
const lastNotification = () => notifications().at(-1);
const canvasNodes = async () => (await req("GET", `/api/projects/${P}/canvas`)).json().nodes;
const nodeOf = async (t: string) => (await canvasNodes()).find((n: any) => n.data?.title === t);
const events: any[] = [];

before(async () => {
  await fastify.listen({ port: 0, host: "127.0.0.1" });
  port = (fastify.server.address() as any).port;
  const node = (id: string, x: number, data: object) => ({ id, type: "agentTerminal", position: { x, y: 0 }, data });
  const res = await req("POST", `/api/projects/${P}/canvas`, {
    nodes: [node("maestro", 0, { title: "Chefe", isMaestro: true }), node("twin1", 400, { title: "Gêmeo" }), node("twin2", 800, { title: "Gêmeo", floor: "Experiment" })],
    edges: [{ id: "e1", source: "maestro", target: "twin1" }, { id: "e2", source: "maestro", target: "twin2" }],
  });
  assert.equal(res.statusCode, 200);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/project/${P}?token=tok-p8&clientId=browser`);
  ws.on("message", (m) => {
    try {
      events.push(JSON.parse(m.toString()));
    } catch {}
  });
  await new Promise((r, j) => (ws.on("open", r), ws.on("error", j)));
});

after(async () => {
  await fastify.close();
  rmTmp(tmp);
});

// ---------- 1. notificações do sistema ----------

test("desktopNotify: notify-send via execFile (sem shell), com '--', texto limpo, só quando o comando existe", { skip: noSO }, async () => {
  assert.equal(desktopNotifyEnabled(P), true, "padrão em loopback: ligado");
  fs.writeFileSync(notifyLog, "");
  assert.equal(desktopNotify(P, "Título", "corpo\x07com\nquebra"), true);
  await until(() => notifications().length === 1, "notify-send chamado");
  assert.deepEqual(notifications()[0], ["-a", "Maestri", "--", "Título", "corpo com quebra"]);
  // título/texto que começam com "-" não viram opções
  desktopNotify(P, "--help", "-x $(id) `id` ; rm");
  await until(() => notifications().length === 2, "segunda chamada");
  assert.deepEqual(notifications()[1], ["-a", "Maestri", "--", "--help", "-x $(id) `id` ; rm"]);
  // sem notify-send no PATH: nada acontece (e nada quebra)
  const oldPath = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    assert.equal(desktopNotify(P, "x", "y"), false);
  } finally {
    process.env.PATH = oldPath;
  }
  // macOS: escape de \ e " no AppleScript
  assert.equal(appleString('a"b\\c'), '"a\\"b\\\\c"');
  assert.deepEqual(osascriptArgs('T "x"', 'dize "oi" \\ fim'), ["-e", 'display notification "dize \\"oi\\" \\\\ fim" with title "T \\"x\\""']);
});

test("liga/desliga: MAESTRI_DESKTOP_NOTIFY vence a preferência do projeto; padrão fora de loopback é desligado", async () => {
  fs.writeFileSync(notifyLog, "");
  // preferência do projeto (toggle das Configurações)
  assert.equal((await req("GET", `/api/projects/${P}/prefs`)).json().desktopNotify, true);
  assert.equal((await req("PUT", `/api/projects/${P}/prefs`, { desktopNotify: false })).json().desktopNotify, false);
  await ok(M("notify", "não deve aparecer no SO"));
  await sleep(300);
  assert.equal(notifications().length, 0);
  assert.equal((await req("PUT", `/api/projects/${P}/prefs`, { desktopNotify: true })).statusCode, 200);
  assert.equal((await req("PUT", `/api/projects/${P}/prefs`, { desktopNotify: "sim" })).statusCode, 400);
  assert.equal((await req("PUT", `/api/projects/${P}/prefs`, {})).statusCode, 400);
  // a variável de ambiente manda mais que a preferência, nos dois sentidos
  process.env.MAESTRI_DESKTOP_NOTIFY = "0";
  try {
    const prefs = (await req("GET", `/api/projects/${P}/prefs`)).json();
    assert.deepEqual([prefs.desktopNotify, prefs.desktopNotifyForced], [false, true]);
    await ok(M("notify", "desligado pela env"));
    await sleep(300);
    assert.equal(notifications().length, 0);
    await req("PUT", `/api/projects/${P}/prefs`, { desktopNotify: false });
    process.env.MAESTRI_DESKTOP_NOTIFY = "1";
    await ok(M("notify", "ligado pela env"));
    if (!winSO) await until(() => notifications().length === 1, "ligado pela env mesmo com a preferência desligada");
  } finally {
    process.env.MAESTRI_DESKTOP_NOTIFY = "";
    await req("PUT", `/api/projects/${P}/prefs`, { desktopNotify: true });
  }
  // fora de loopback (servidor possivelmente noutra máquina): desligado, a menos que a preferência diga o contrário
  configureDesktopNotify({ defaultOn: () => false, pref: () => undefined });
  assert.equal(desktopNotifyEnabled(P), false);
  configureDesktopNotify({ pref: () => true });
  assert.equal(desktopNotifyEnabled(P), true);
  configureDesktopNotify({ defaultOn: () => true, pref: (id) => (JSON.parse(fs.readFileSync(path.join(repo, ".maestri_data", `prefs_${id}.json`), "utf8")) as any).desktopNotify });
  assert.equal(desktopNotifyEnabled(P), true);
});

test("maestri notify, lembrete de rotina e andar em blocked/review/done também vão para o SO", { skip: noSO }, async () => {
  fs.writeFileSync(notifyLog, "");
  await ok(M("notify", "build terminou"));
  await until(() => notifications().length === 1, "notify");
  assert.deepEqual(lastNotification(), ["-a", "Maestri", "--", "Maestri — Chefe", "build terminou"]);
  // lembrete
  await ok(M("routine", "create", "Standup", "--command", "Hora do standup", "--every", "1h", "--reminder"));
  await ok(M("routine", "run", "Standup"));
  await until(() => notifications().length === 2, "lembrete");
  assert.deepEqual(lastNotification(), ["-a", "Maestri", "--", "Maestri — Standup", "Hora do standup"]);
  // status do andar: working não avisa; blocked/review/done sim
  await ok(M("floor", "status", "trabalhando", "--state", "working"));
  await sleep(300);
  assert.equal(notifications().length, 2);
  await ok(M("floor", "status", "preciso de ajuda", "--state", "blocked"));
  await until(() => notifications().length === 3, "blocked");
  assert.deepEqual(lastNotification(), ["-a", "Maestri", "--", "Maestri — Chefe", "Ground: blocked — preciso de ajuda"]);
  await ok(M("floor", "status", "pronto", "--state", "review"));
  await until(() => notifications().length === 4, "review");
});

// ---------- 2. PR em segundo plano (gatilho de ocioso) ----------

test("andar git: fim do turno do agente (ocioso depois de saída) detecta o PR, avisa no canvas e no SO; gh ausente não faz barulho", async () => {
  await ok(M("floor", "create", "Feat", "--branch", "feat-idle"));
  fs.writeFileSync(path.join(ghDir, "list-feat-idle.json"), JSON.stringify([{ number: 7, url: "https://github.com/acme/app/pull/7", title: "Do agente" }]));
  fs.writeFileSync(notifyLog, "");
  events.length = 0;
  await ok(M("recruit", "Fl", "--preset", "shell", "--floor", "Feat"));
  // o terminal produz saída e fica 600ms ocioso -> detecção (sem ninguém chamar detect-prs)
  await ok(M("send", "Fl", "echo trabalho"));
  await until(async () => ((await req("GET", `/api/projects/${P}/floors`)).json().floors ?? (await req("GET", `/api/projects/${P}/floors`)).json()).find?.((f: any) => f.name === "Feat")?.pullRequest?.number === 7, "andar passou a seguir o PR");
  await until(() => events.some((e) => e.type === "notify" && e.text === "Andar Feat agora segue o PR #7"), "toast no canvas");
  if (!winSO) await until(() => notifications().some((n) => n.includes("Andar Feat agora segue o PR #7")), "notificação do SO");
  // já segue: não avisa de novo
  const count = notifications().length;
  await ok(M("send", "Fl", "echo mais"));
  await sleep(1500);
  assert.equal(notifications().length, count);
  // gh sem login: a detecção informa e não quebra nada
  await ok(M("floor", "create", "Outro", "--branch", "feat-outro"));
  fs.writeFileSync(path.join(ghDir, "unauth"), "");
  const d = (await req("POST", `/api/projects/${P}/floors/detect-prs`, { now: true })).json();
  assert.equal(d.found, 0);
  assert.ok(d.unavailable, "gh indisponível é informado");
  fs.rmSync(path.join(ghDir, "unauth"));
});

// ---------- 3. textos de ajuda ----------

test("help: nenhuma linha repetida no geral; recruit --help cita --workspace/--account; list --help descreve o formato atual", async () => {
  const help = (await ok(M("help"))).stdout.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim());
  const seen = new Map<string, number>();
  for (const l of help) seen.set(l, (seen.get(l) ?? 0) + 1);
  assert.deepEqual([...seen].filter(([, n]) => n > 1).map(([l]) => l), [], "linhas repetidas no help geral");
  assert.equal(help.filter((l) => /^\s*recruit\b/.test(l)).length, 1, "recruit aparece em uma linha só");
  const recruit = (await ok(M("recruit", "--help"))).stdout;
  assert.match(recruit.split("\n").slice(0, 2).join("\n"), /--workspace/);
  assert.match(recruit.split("\n").slice(0, 2).join("\n"), /--account/);
  for (const cmd of ["list", "context"]) {
    const h = (await ok(M(cmd, "--help"))).stdout;
    for (const piece of ["Bandas", "↳", "[conta: X]", "Nome @ Workspace", "locked", "Fichários", "(você está nela)", "— <título> @ <Workspace>"]) assert.ok(h.includes(piece), `${cmd}: ${piece}`);
  }
  assert.match((await ok(M("ask", "--help"))).stdout, /MAESTRI_WAKE_STARTUP_MS \(30s/);
});

// ---------- 4. ask e o fim do turno ----------

test("busyIndicator: indicadores das TUIs conhecidas nas últimas linhas, sem ANSI", () => {
  assert.equal(busyIndicator("\x1b[2m✻ Thinking… (12s · esc to interrupt)\x1b[0m\n> "), true);
  assert.equal(busyIndicator("• Working (3s • Esc to interrupt)"), true);
  assert.equal(busyIndicator("\x1b[36m⠙ Working...\x1b[0m"), true);
  assert.equal(busyIndicator("Thinking (2s)"), true);
  for (const quiet of ["", "> pronto", "terminei o trabalho e estou pensando em outra coisa", "Working directory: /tmp", "o usuário apertou esc"]) assert.equal(busyIndicator(quiet), false, quiet);
  // só as últimas linhas contam
  assert.equal(busyIndicator("esc to interrupt\n" + "linha\n".repeat(10)), false);
});

test("ask espera enquanto a tela mostra o indicador de ocupado, mesmo em silêncio > quiet; --timeout continua valendo", async () => {
  await ok(M("recruit", "Bz", "--preset", "shell"));
  await sleep(1200); // shell pronto
  const t0 = Date.now();
  const r = await ok(M("ask", "Bz", "busyprog"));
  assert.match(r.stdout, /RESPOSTA-FINAL/, "esperou a resposta que veio depois de 1.5s de silêncio (quiet = 0.4s)");
  assert.ok(Date.now() - t0 >= 1500);
  // indicador que nunca sai: respeita o timeout (código 2), não trava para sempre
  await ok(M("recruit", "Bz2", "--preset", "shell"));
  await sleep(1200);
  const t1 = Date.now();
  const slow = await M("ask", "Bz2", "busyprog2", "--timeout", "2");
  assert.equal(slow.code, 2, slow.stderr);
  assert.ok(Date.now() - t1 < 6000);
  assert.match(slow.stderr, /Timeout/);
});

// ---------- QA5 ----------

test("withRolePrompt detecta claude/codex pelo executável (caminho, variáveis na frente) e não mexe em shells compostos", () => {
  const dir = fs.mkdtempSync(path.join(tmp, "role-"));
  const w = (cmd: string) => withRolePrompt(dir, "n1", cmd, "papel");
  const arg = ` "$(cat '${path.join(dir, ".maestri-roles", "n1.md").replaceAll("\\", "/")}')"`; // Windows: o src quota com /
  assert.equal(w("claude"), `claude${arg}`);
  assert.equal(w("/opt/homebrew/bin/codex --yolo"), `/opt/homebrew/bin/codex --yolo${arg}`);
  assert.equal(w("ANTHROPIC_BASE_URL=http://localhost:4000 claude --model opus"), `ANTHROPIC_BASE_URL=http://localhost:4000 claude --model opus${arg}`);
  assert.equal(w('claude --append-system-prompt "x y"'), `claude --append-system-prompt "x y"${arg}`);
  // não é claude/codex, está dentro de sh -c, ou tem metacaracteres de shell: o comando fica como está
  for (const cmd of ["opencode", "npm run dev", "echo claude", "sh -c 'claude'", 'fish -c "codex"', "claude; rm -rf x", "claude | tee x", "claude && ls", "claude $(id)", ""]) assert.equal(w(cmd), cmd, cmd);
  assert.equal(fs.readFileSync(path.join(dir, ".maestri-roles", "n1.md"), "utf8"), "papel");
});

test("routine create --terminal ambíguo: o erro cita --floor e --floor desambigua", async () => {
  const amb = await M("routine", "create", "Gemea", "--command", "echo oi", "--every", "5m", "--terminal", "Gêmeo");
  assert.equal(amb.code, 1);
  assert.match(amb.stderr, /Nome ambíguo: 2 terminais chamados "Gêmeo"; use --floor "Andar" para escolher \(andares: Ground, Experiment\)/);
  await ok(M("routine", "create", "Gemea", "--command", "echo oi", "--every", "5m", "--terminal", "Gêmeo", "--floor", "Experiment"));
  await ok(M("routine", "create", "GemeaT", "--command", "echo oi", "--every", "5m", "--terminal", "gêmeo", "--floor", "ground"));
  const list = (await req("GET", `/api/projects/${P}/routines`)).json().routines;
  assert.equal(list.find((r: any) => r.name === "Gemea").nodeId, "twin2");
  assert.equal(list.find((r: any) => r.name === "GemeaT").nodeId, "twin1");
  assert.match((await M("routine", "create", "X", "--command", "c", "--every", "5m", "--terminal", "Gêmeo", "--floor", "Nada")).stderr, /Nenhum terminal "Gêmeo" no andar "Nada" \(andares: Ground, Experiment\)/);
  // sem ambiguidade, --floor errado também avisa
  assert.match((await M("routine", "create", "X", "--command", "c", "--every", "5m", "--terminal", "Fl", "--floor", "Experiment")).stderr, /Nenhum terminal "Fl" no andar "Experiment"/);
});
