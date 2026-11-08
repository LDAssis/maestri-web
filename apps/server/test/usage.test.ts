import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { resumeCommand, withModel, withUsageSettings } from "../src/resume.js";
import { UsageStore, parseReport, userStatusLine, usageEnabled } from "../src/usage.js";
import { installFakeBin, rmTmp } from "./rmtmp.js";

const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maestri-usage-test-")));
const fakeBin = path.join(repo, "fakebin");
const cfg = path.join(repo, "claude-config");
const tmpCache = path.join(repo, "tmpcache");
for (const d of [fakeBin, cfg, tmpCache]) fs.mkdirSync(d);
const statusFile = path.join(repo, "status.json");
const seenFile = path.join(repo, "seen-by-user.json");
const posix = (p: string) => p.replace(/\\/g, "/");

// `claude` falso: acha a statusLine em --settings e a executa como o Claude Code faz (JSON no stdin), imprimindo o que ela devolve
const fakeClaude = path.join(repo, "fake-claude.mjs");
fs.writeFileSync(
  fakeClaude,
  `import fs from "node:fs";
import { spawnSync } from "node:child_process";
const a = process.argv.slice(2);
const i = a.indexOf("--settings");
if (i < 0) { console.log("SEM-SETTINGS"); process.exit(0); }
const s = JSON.parse(a[i + 1]);
const r = spawnSync(s.statusLine.command, { shell: true, input: fs.readFileSync(process.env.FAKE_STATUS_FILE, "utf8"), encoding: "utf8" });
console.log("STATUS[" + r.stdout.trim() + "]");
`,
);
installFakeBin(fakeBin, "claude", `exec node '${posix(fakeClaude)}' "$@"`);

const NOW = Math.floor(Date.now() / 1000); // fixo: o mesmo JSON dá a mesma impressão digital (throttle)
const statusJson = (five: number | null, seven: number | null, model = "claude-opus-5-5") => {
  const now = NOW;
  return JSON.stringify({
    model: { id: model, display_name: "Opus 5.5" },
    ...(five !== null && { rate_limits: { five_hour: { used_percentage: five, resets_at: now + 3600 }, seven_day: { used_percentage: seven, resets_at: now + 3 * 86400 } } }),
  });
};
fs.writeFileSync(statusFile, statusJson(13.2, 10));

const originalPath = process.env.PATH ?? "";
process.env.PATH = `${fakeBin}${path.delimiter}${originalPath}`;
process.env.REPO_PATH = repo;
process.env.NODE_ENV = "test";
process.env.MAESTRI_TOKEN = "tok-usage";
process.env.MAESTRI_USAGE_REPORT = "1"; // nos testes fica desligado por padrão
process.env.CLAUDE_CONFIG_DIR = cfg;
process.env.FAKE_STATUS_FILE = statusFile;
process.env.TMPDIR = tmpCache; // cache de throttle do usage-report (os terminais herdam)

const { fastify } = await import("../src/index.js");
const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/maestri");
const P = "proj-maestri-web";
const auth = { authorization: "Bearer tok-usage" };
let port = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 12000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) assert.fail(`timeout: ${what}`);
    await sleep(40);
  }
}
const usage = async () => (await fastify.inject({ method: "GET", url: `/api/projects/${P}/usage`, headers: auth })).json();
const report = (body: object) => fastify.inject({ method: "POST", url: `/api/projects/${P}/usage/report`, headers: auth, payload: body });

// usage-report como o Claude Code o chama: JSON no stdin, ambiente do terminal
function usageReport(nodeId: string, input: string, env: Record<string, string> = {}) {
  return new Promise<{ code: number; stdout: string; ms: number }>((resolve) => {
    const t0 = Date.now();
    const child = execFile(
      process.execPath,
      [bin, "usage-report"],
      { env: { ...process.env, MAESTRI_API_URL: `http://127.0.0.1:${port}/api`, MAESTRI_PROJECT_ID: P, MAESTRI_NODE_ID: nodeId, MAESTRI_TOKEN: "tok-usage", ...env } },
      (err, stdout) => resolve({ code: err ? ((err as any).code ?? 1) : 0, stdout, ms: Date.now() - t0 }),
    );
    child.stdin!.end(input);
  });
}
async function terminalOutput(nodeId: string, cmd = "claude") {
  let out = "";
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal?project=${P}&node=${nodeId}&token=tok-usage&cmd=${encodeURIComponent(cmd)}`);
  ws.on("message", (m) => (out += m.toString()));
  await new Promise((r) => ws.on("open", r));
  return { ws, get: () => out };
}

// ---------- sem servidor ----------
test("withUsageSettings: só claude, uma vez, junto com o modelo, e a retomada mantém", () => {
  const S = '{"statusLine":{"type":"command","command":"/x/maestri usage-report"}}';
  assert.equal(withUsageSettings("claude", S), `claude --settings '${S}'`);
  assert.equal(withUsageSettings("FOO=1 /usr/bin/claude --verbose", S), `FOO=1 /usr/bin/claude --settings '${S}' --verbose`);
  assert.equal(withUsageSettings(`claude "$(cat '/r/a.md')"`, S), `claude --settings '${S}' "$(cat '/r/a.md')"`);
  for (const cmd of ["codex", "opencode", "agy", "bash", "", "npm run dev", 'sh -c "claude"']) assert.equal(withUsageSettings(cmd, S), cmd, cmd);
  assert.equal(withUsageSettings("claude --settings /meu.json", S), "claude --settings /meu.json", "settings do usuário ficam");
  assert.equal(withUsageSettings("claude --settings=/meu.json", S), "claude --settings=/meu.json");
  assert.equal(withUsageSettings("claude", undefined), "claude");
  const full = resumeCommand(withUsageSettings(withModel("claude", "opus"), S));
  assert.equal(full, `claude --continue --settings '${S}' --model opus`);
});

test("userStatusLine lê a statusLine do CLAUDE_CONFIG_DIR; usageEnabled liga/desliga", () => {
  const dir = fs.mkdtempSync(path.join(repo, "cfg-"));
  const env = { CLAUDE_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
  assert.equal(userStatusLine(env), undefined, "sem settings.json");
  fs.writeFileSync(path.join(dir, "settings.json"), "{ quebrado");
  assert.equal(userStatusLine(env), undefined, "JSON inválido");
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ statusLine: { type: "command", command: "meu-script --x" } }));
  assert.equal(userStatusLine(env), "meu-script --x");
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ statusLine: { type: "outro", command: "x" } }));
  assert.equal(userStatusLine(env), undefined);
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ model: "opus" }));
  assert.equal(userStatusLine(env), undefined, "sem statusLine");
  assert.equal(usageEnabled({ NODE_ENV: "test" } as NodeJS.ProcessEnv), false);
  assert.equal(usageEnabled({ NODE_ENV: "test", MAESTRI_USAGE_REPORT: "1" } as NodeJS.ProcessEnv), true);
  assert.equal(usageEnabled({} as NodeJS.ProcessEnv), true);
  assert.equal(usageEnabled({ MAESTRI_USAGE_REPORT: "0" } as NodeJS.ProcessEnv), false);
});

test("parseReport valida números 0-100, epoch razoável, nodeId e model", () => {
  const w = (p: unknown, r: unknown) => ({ nodeId: "n1", rate_limits: { five_hour: { used_percentage: p, resets_at: r } } });
  const now = Math.floor(Date.now() / 1000);
  assert.deepEqual(parseReport(w(13.2, now + 10)).report.five_hour, { used_percentage: 13.2, resets_at: now + 10 });
  assert.deepEqual(parseReport({ nodeId: "n1" }).report, {}, "antes da 1ª resposta: sem nada");
  assert.equal(parseReport({ nodeId: "n1", model: " opus " }).report.model, "opus");
  const bad: unknown[] = [w(-1, now), w(101, now), w("13", now), w(NaN, now), w(50, 5), w(50, 9e12), w(50, "x"), { nodeId: "a b" }, {}, { nodeId: "n1", model: "x".repeat(101) }, { nodeId: "n1", model: 5 }, { nodeId: "n1", rate_limits: [] }, { nodeId: "n1", rate_limits: { seven_day: 7 } }];
  for (const b of bad) assert.throws(() => parseReport(b as any), /inválido/, JSON.stringify(b));
});

test("UsageStore: por conta, só o projeto pedido, 'changed' ignora updatedAt, persiste e recarrega", () => {
  const file = path.join(repo, "store-usage.json");
  const win = { used_percentage: 5, resets_at: 2e9 };
  const s = new UsageStore(file, undefined, 10);
  const r1 = s.report("p1", "a", "claude", "Default", { model: "opus", five_hour: win });
  assert.equal(r1.changed, true);
  assert.equal(s.report("p1", "a", "claude", "Default", { model: "opus", five_hour: win }).changed, false, "igual: não muda");
  assert.equal(s.report("p1", "b", "claude", "Default", { model: "opus" }).changed, true, "nó novo na conta");
  assert.equal(s.report("p1", "a", "claude", "Default", { model: "opus" }).changed, false, "sem rate_limits mantém os da conta");
  s.report("p2", "c", "claude", "Work", { five_hour: { used_percentage: 90, resets_at: 2e9 } });
  assert.deepEqual(s.projectsOf(r1.key), ["p1"]);
  const v1 = s.view("p1", () => true);
  assert.deepEqual(v1.accounts.map((a) => a.account), ["Default"]);
  assert.deepEqual(Object.keys(v1.nodes).sort(), ["a", "b"]);
  assert.deepEqual(v1.accounts[0].five_hour, win);
  assert.equal(v1.accounts[0].seven_day, null);
  assert.deepEqual(s.view("p1", (id) => id === "a").nodes, { a: v1.nodes.a }, "nó removido do canvas some");
  assert.deepEqual(s.view("p2", () => true).accounts.map((a) => a.account), ["Work"], "outro projeto, outra conta");
  assert.deepEqual(s.view("p3", () => true), { accounts: [], nodes: {} });
  s.flush();
  const again = new UsageStore(file);
  assert.deepEqual(again.view("p1", () => true).accounts, v1.accounts);
  fs.writeFileSync(file, "lixo");
  assert.deepEqual(new UsageStore(file).view("p1", () => true), { accounts: [], nodes: {} }, "arquivo corrompido: começa vazio");
});

// ---------- servidor ----------
before(async () => {
  await fastify.listen({ port: 0, host: "127.0.0.1" });
  port = (fastify.server.address() as any).port;
  const agent = (id: string, x: number, data: object = {}) => ({ id, type: "agentTerminal", position: { x, y: 0 }, style: { width: 460, height: 330 }, data: { title: id, preset: "claude", baseCmd: "claude", defaultCmd: "claude", ...data } });
  await fastify.inject({
    method: "POST", url: `/api/projects/${P}/canvas`, headers: auth,
    payload: { nodes: [agent("ag", 0), agent("ag2", 600), agent("thr", 1200), agent("work", 1800, { account: "Work" }), { id: "nota", type: "stickyNote", position: { x: 0, y: 700 }, data: { title: "Nota", content: "x" } }], edges: [] },
  });
});
after(async () => {
  process.env.PATH = originalPath;
  await fastify.close();
  rmTmp(repo);
});

test("claude sobe com --settings: a statusLine reporta o uso, imprime a linha curta, e o GET/WS refletem", async () => {
  const proj = new WebSocket(`ws://127.0.0.1:${port}/ws/project/${P}?token=tok-usage&clientId=ui`);
  const events: string[] = [];
  proj.on("message", (m) => {
    try {
      events.push(JSON.parse(m.toString()).type);
    } catch {}
  });
  await new Promise((r) => proj.on("open", r));
  assert.deepEqual((await usage()), { accounts: [], nodes: {} }, "começa sem dados");

  const t = await terminalOutput("ag");
  await until(() => t.get().includes("STATUS[Opus 5.5 · 5h 13% · 7d 10%]"), "linha curta da statusline");
  await until(() => events.includes("usage"), "evento usage no WS do projeto");
  const u = await usage();
  assert.equal(u.accounts.length, 1);
  const [acc] = u.accounts;
  assert.deepEqual([acc.cli, acc.account, acc.model], ["claude", "Default", "claude-opus-5-5"]);
  assert.equal(acc.five_hour.used_percentage, 13.2);
  assert.equal(acc.seven_day.used_percentage, 10);
  assert.ok(acc.five_hour.resets_at > Date.now() / 1000);
  assert.ok(!Number.isNaN(Date.parse(acc.updatedAt)));
  assert.deepEqual(Object.keys(u.nodes), ["ag"]);
  assert.deepEqual([u.nodes.ag.account, u.nodes.ag.model], ["Default", "claude-opus-5-5"]);

  // persistido em .maestri_data/usage.json (sobrevive a restart)
  const file = path.join(repo, ".maestri_data", "usage.json");
  await until(() => fs.existsSync(file), "usage.json gravado");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.accounts[0].account, "Default");
  assert.equal(saved.nodes[0].node, "ag");
  t.ws.close();
  proj.close();
});

test("com statusLine do usuário no CLAUDE_CONFIG_DIR: o usage-report encadeia (stdin repassado, saída dele) e ainda reporta", async () => {
  const script = path.join(repo, "user-status.sh");
  fs.writeFileSync(script, `#!/bin/sh\ncat > '${posix(seenFile)}'\necho minha-linha\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(cfg, "settings.json"), JSON.stringify({ statusLine: { type: "command", command: posix(script) } }));
  fs.writeFileSync(statusFile, statusJson(21, 12));
  const t = await terminalOutput("ag2");
  await until(() => t.get().includes("STATUS[minha-linha]"), "saída da statusline do usuário");
  assert.deepEqual(JSON.parse(fs.readFileSync(seenFile, "utf8")), JSON.parse(statusJson(21, 12)), "o stdin chegou inteiro à statusline do usuário");
  await until(async () => (await usage()).nodes.ag2?.model === "claude-opus-5-5", "ag2 reportou mesmo com a statusline do usuário");
  assert.equal((await usage()).accounts[0].five_hour.used_percentage, 21);
  t.ws.close();
  fs.rmSync(path.join(cfg, "settings.json"));
});

test("throttle: igual dentro de 60 s não reporta; mudou reporta; sem rate_limits não apaga o que a conta tem", async () => {
  const dir = fs.mkdtempSync(path.join(repo, "throttle-"));
  const run = (json: string) => usageReport("thr", json, { TMPDIR: dir });
  const at = async () => (await usage()).nodes.thr?.updatedAt;
  const a = await run(statusJson(30, 20));
  assert.equal(a.code, 0);
  assert.equal(a.stdout.trim(), "Opus 5.5 · 5h 30% · 7d 20%");
  const t1 = await at();
  assert.ok(t1, "primeiro relatório chegou");
  await sleep(1100);
  await run(statusJson(30, 20));
  assert.equal(await at(), t1, "igual e < 60 s: não foi ao servidor");
  await run(statusJson(31, 20));
  const t2 = await at();
  assert.notEqual(t2, t1, "mudou: reporta na hora");
  assert.equal((await usage()).accounts.find((x: any) => x.account === "Default").five_hour.used_percentage, 31);
  // antes da 1ª resposta o claude manda só o modelo: a linha mostra o modelo e o uso conhecido continua
  const only = await run(JSON.stringify({ model: { id: "claude-opus-5-5", display_name: "Opus 5.5" } }));
  assert.equal(only.stdout.trim(), "Opus 5.5");
  assert.equal((await usage()).accounts.find((x: any) => x.account === "Default").five_hour.used_percentage, 31);
  // passou de 60 s no cache: reporta de novo mesmo igual
  const cache = path.join(dir, "maestri-usage-thr.json");
  const saved = JSON.parse(fs.readFileSync(cache, "utf8"));
  fs.writeFileSync(cache, JSON.stringify({ ...saved, at: Date.now() - 61_000 }));
  const before = await at();
  await sleep(50);
  await run(JSON.stringify({ model: { id: "claude-opus-5-5", display_name: "Opus 5.5" } }));
  assert.notEqual(await at(), before, "a cada 60 s");
});

test("usage-report nunca falha nem demora: servidor fora, stdin lixo, sem ambiente", async () => {
  const dir = fs.mkdtempSync(path.join(repo, "never-"));
  const down = await usageReport("thr", statusJson(1, 1), { TMPDIR: dir, MAESTRI_API_URL: "http://127.0.0.1:1/api" });
  assert.equal(down.code, 0);
  assert.equal(down.stdout.trim(), "Opus 5.5 · 5h 1% · 7d 1%");
  assert.ok(down.ms < 4000, `${down.ms} ms`);
  const garbage = await usageReport("thr", "isto não é json", { TMPDIR: dir });
  assert.equal(garbage.code, 0);
  assert.equal(garbage.stdout.trim(), "");
  const noEnv = await usageReport("thr", statusJson(2, 2), { TMPDIR: dir, MAESTRI_API_URL: "", MAESTRI_PROJECT_ID: "", MAESTRI_NODE_ID: "" });
  assert.equal(noEnv.code, 0);
  assert.equal(noEnv.stdout.trim(), "Opus 5.5 · 5h 2% · 7d 2%");
  const brokenUser = await usageReport("thr", statusJson(3, 3), { TMPDIR: dir, MAESTRI_USER_STATUSLINE: "comando-que-nao-existe-xyz" });
  assert.equal(brokenUser.code, 0);
  assert.ok(brokenUser.ms < 6000);
});

test("POST /usage/report valida a entrada; a conta vem do nó (--account) e Default sem ela", async () => {
  const now = Math.floor(Date.now() / 1000);
  const win = (p: number) => ({ used_percentage: p, resets_at: now + 600 });
  assert.equal((await report({ nodeId: "nao-existe", model: "x" })).statusCode, 404);
  assert.equal((await report({ nodeId: "nota", model: "x" })).statusCode, 404, "só nós de agente");
  assert.equal((await report({ nodeId: "work", rate_limits: { five_hour: { used_percentage: 101, resets_at: now } } })).statusCode, 400);
  assert.equal((await report({ nodeId: "work", rate_limits: { five_hour: { used_percentage: 5, resets_at: 3 } } })).statusCode, 400);
  assert.equal((await report({ model: "x" })).statusCode, 400);
  assert.equal((await fastify.inject({ method: "POST", url: `/api/projects/nao-existe/usage/report`, headers: auth, payload: { nodeId: "work" } })).statusCode, 404);
  const ok = await report({ nodeId: "work", model: "claude-sonnet-5-5", rate_limits: { five_hour: win(70), seven_day: win(40) } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().changed, true);
  assert.equal((await report({ nodeId: "work", model: "claude-sonnet-5-5", rate_limits: { five_hour: win(70), seven_day: win(40) } })).json().changed, false);
  const u = await usage();
  assert.deepEqual(u.accounts.map((a: any) => a.account).sort(), ["Default", "Work"]);
  assert.equal(u.nodes.work.account, "Work");
  assert.equal(u.accounts.find((a: any) => a.account === "Work").five_hour.used_percentage, 70);
  assert.notEqual(u.accounts.find((a: any) => a.account === "Default").five_hour.used_percentage, 70, "contas separadas");
  assert.equal((await fastify.inject({ method: "GET", url: `/api/projects/nao-existe/usage`, headers: auth })).statusCode, 404);
});
