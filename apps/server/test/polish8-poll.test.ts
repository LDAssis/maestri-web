// Detecção de PR em segundo plano pelo INTERVALO do servidor (sem nenhum agente produzindo saída): arquivo próprio porque
// o período é lido na subida (MAESTRI_PR_POLL_MS); o gatilho de ocioso fica desligado aqui (MAESTRI_IDLE_MS enorme).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maestri-polish8poll-test-")));
const repo = path.join(tmp, "repo");
const fakeBin = path.join(tmp, "bin");
const ghDir = path.join(tmp, "gh");
const notifyLog = path.join(tmp, "notify.log");
for (const d of [repo, fakeBin, ghDir]) fs.mkdirSync(d);
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
git(repo, "init", "-b", "main");
fs.writeFileSync(path.join(repo, ".gitignore"), ".worktrees\n.maestri_data\n");
fs.writeFileSync(path.join(repo, "a.txt"), "um\n");
git(repo, "add", "-A");
git(repo, "commit", "-m", "init");
const bin = (name: string, body: string) => fs.writeFileSync(path.join(fakeBin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
bin("notify-send", `for a in "$@"; do printf '%s\\n' "$a" >> "${notifyLog}"; done; echo "---" >> "${notifyLog}"`);
bin("gh", `echo "$@" >> "${ghDir}/gh.log"\n[ -f "${ghDir}/unauth" ] && { echo "gh auth login" >&2; exit 4; }\ncase "$2" in\n  list) f="${ghDir}/list-$4.json"; [ -f "$f" ] && cat "$f" || echo "[]" ;;\nesac`);
process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH}`;
process.env.REPO_PATH = repo;
process.env.NODE_ENV = "test";
process.env.MAESTRI_TOKEN = "tok-p8p";
process.env.MAESTRI_PR_POLL_MS = "400";
process.env.MAESTRI_IDLE_MS = "3600000";

const { fastify } = await import("../src/index.js");
const binCli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/maestri");
const P = "proj-maestri-web";
const auth = { authorization: "Bearer tok-p8p" };
let port = 0;
const events: any[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 10000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) assert.fail(`timeout: ${what}`);
    await sleep(40);
  }
}
const M = (...args: string[]) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [binCli, ...args], { env: { ...process.env, MAESTRI_API_URL: `http://127.0.0.1:${port}/api`, MAESTRI_PROJECT_ID: P, MAESTRI_NODE_ID: "maestro", MAESTRI_TOKEN: "tok-p8p" } }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as any).code ?? 1) : 0, stdout, stderr }),
    );
  });
const floorsNow = async () => {
  const j = (await fastify.inject({ method: "GET", url: `/api/projects/${P}/floors`, headers: auth })).json();
  return (j.floors ?? j) as any[];
};

before(async () => {
  await fastify.listen({ port: 0, host: "127.0.0.1" });
  port = (fastify.server.address() as any).port;
  await fastify.inject({
    method: "POST", url: `/api/projects/${P}/canvas`, headers: auth,
    payload: { nodes: [{ id: "maestro", type: "agentTerminal", position: { x: 0, y: 0 }, data: { title: "Chefe", isMaestro: true } }], edges: [] },
  });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/project/${P}?token=tok-p8p&clientId=browser`);
  ws.on("message", (m) => {
    try {
      events.push(JSON.parse(m.toString()));
    } catch {}
  });
  await new Promise((r, j) => (ws.on("open", r), ws.on("error", j)));
});

after(async () => {
  await fastify.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("o intervalo do servidor detecta o PR de um andar git sem agente rodando e avisa (canvas + SO); sem andar git não chama o gh", async () => {
  // sem andares: o gh não é consultado
  await sleep(1000);
  assert.ok(!fs.existsSync(path.join(ghDir, "gh.log")), "sem andar git, nada de gh");
  assert.equal((await M("floor", "create", "Poll", "--branch", "feat-poll")).code, 0);
  fs.writeFileSync(path.join(ghDir, "list-feat-poll.json"), JSON.stringify([{ number: 21, url: "https://github.com/acme/app/pull/21", title: "Aberto" }]));
  await until(async () => (await floorsNow()).find((f) => f.name === "Poll")?.pullRequest?.number === 21, "intervalo detectou o PR");
  await until(() => events.some((e) => e.type === "notify" && e.text === "Andar Poll agora segue o PR #21"), "toast");
  await until(() => fs.existsSync(notifyLog) && fs.readFileSync(notifyLog, "utf8").includes("Andar Poll agora segue o PR #21"), "notificação do SO");
  assert.equal(events.filter((e) => e.type === "notify" && /Poll agora segue/.test(e.text)).length, 1, "avisa uma vez só");
  // quem já segue um PR não é mais consultado
  const calls = fs.readFileSync(path.join(ghDir, "gh.log"), "utf8").split("\n").filter(Boolean).length;
  await sleep(1500);
  assert.equal(fs.readFileSync(path.join(ghDir, "gh.log"), "utf8").split("\n").filter(Boolean).length, calls);
});

test("gh ausente/sem login no intervalo: silencioso, sem toast e sem derrubar o servidor", async () => {
  assert.equal((await M("floor", "create", "Quieto", "--branch", "feat-quieto")).code, 0);
  fs.writeFileSync(path.join(ghDir, "unauth"), "");
  fs.writeFileSync(path.join(ghDir, "list-feat-quieto.json"), JSON.stringify([{ number: 30, url: "https://github.com/acme/app/pull/30", title: "x" }]));
  const before = events.filter((e) => e.type === "notify").length;
  await sleep(1500);
  assert.ok(!(await floorsNow()).find((f) => f.name === "Quieto").pullRequest, "sem PR");
  assert.equal(events.filter((e) => e.type === "notify").length, before);
  assert.equal((await fastify.inject({ method: "GET", url: "/api/health" })).statusCode, 200);
  // o gh volta a funcionar: depois do throttle de 30s a detecção seguiria; aqui só confirmamos que a rota forçada acha
  fs.rmSync(path.join(ghDir, "unauth"));
  assert.equal(((await fastify.inject({ method: "POST", url: `/api/projects/${P}/floors/detect-prs`, headers: auth, payload: { now: true } })).json()).found, 1);
});
