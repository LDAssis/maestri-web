import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { CanvasStore } from "../src/canvas.js";
import { SessionManager } from "../src/sessions.js";
import { registerRoutinesApi, nextRun, parseDuration, parseSchedule, type TypeAndWait } from "../src/routines.js";

const P = "proj-r";
const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maestri-routines-test-")));
process.env.MAESTRI_ROUTINE_TICK_MS = "3600000"; // o agendador real não interfere: o teste chama tick()
process.env.MAESTRI_ROUTINE_BUSY_MS = "150";
process.env.MAESTRI_ROUTINE_PRERUN_MS = "1500";
const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/maestri");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 8000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) assert.fail(`timeout: ${what}`);
    await sleep(30);
  }
}

// Mesmo contrato do typeAndWait do nodeApi: escreve e espera o PTY ficar quieto
const realTypeAndWait: TypeAndWait = async (sessions, session, input, timeoutS, aborted = () => false) => {
  let out = "";
  let last = 0;
  const listener = (d: string) => {
    out += d;
    last = Date.now();
  };
  session.listeners.add(listener);
  const started = Date.now();
  let timedOut = false;
  try {
    sessions.write(session.projectId, session.nodeId, input);
    while (!aborted()) {
      await sleep(50);
      if (last && Date.now() - last >= 500) break;
      if (session.dead) break;
      if (Date.now() - started >= timeoutS * 1000) {
        timedOut = true;
        break;
      }
    }
  } finally {
    session.listeners.delete(listener);
  }
  return { output: out.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "").replace(/\r\n?/g, "\n").trim(), timedOut };
};

let impl: TypeAndWait = realTypeAndWait;
const WED = new Date(2026, 5, 10, 12, 0, 0).getTime(); // quarta-feira
let clock = WED;
const busyNodes = new Set<string>();
const events: any[] = [];
const toasts = () => events.filter((e) => e.type === "notify");

function build(dir = dataDir) {
  const fastify = Fastify();
  const sessions = new SessionManager({ apiUrl: () => "http://127.0.0.1:1/api", token: "t" });
  const canvas = new CanvasStore(() => path.join(dir, `canvas_${P}.json`), (f, d) => fs.writeFileSync(f, JSON.stringify(d)), (p, ids) => sessions.killNodes(p, ids), 5);
  canvas.notify = (_p: string, msg: unknown) => void events.push(msg);
  fastify.addHook("onClose", async () => sessions.killAll());
  const routines = registerRoutinesApi({
    fastify,
    sessions,
    canvas,
    projectRepo: (id) => (id === P ? dir : null),
    projectName: () => "Meu Projeto",
    dataDir: dir,
    typeAndWait: (...a) => impl(...a),
    isChatBusy: (_p, n) => busyNodes.has(n),
    now: () => clock,
  });
  return { fastify, canvas, sessions, routines };
}

let app: ReturnType<typeof build>;
let port = 0;
const api = (method: "GET" | "POST" | "PUT" | "DELETE", sub: string, payload?: object) =>
  app.fastify.inject({ method, url: `/api/projects/${P}${sub}`, payload });
const routinesList = async () => (await api("GET", "/routines")).json().routines as any[];
const one = async (id: string) => (await routinesList()).find((r) => r.id === id);
const every5 = { type: "interval", every: "5m" };
const make = async (extra: object = {}) => {
  await quiet();
  const r = await api("POST", "/routines", { nodeId: "ag", name: `r${Math.random()}`, text: "echo x", schedule: every5, ...extra });
  assert.equal(r.statusCode, 201, r.body);
  return r.json().routine;
};
const cleanup = async () => {
  busyNodes.clear();
  impl = realTypeAndWait;
  clock = WED;
  for (const r of await routinesList()) await api("DELETE", `/routines/${r.id}`);
  events.length = 0;
};
// Espera o terminal "ag" ficar sem saída (o critério de ocupado olha a saída recente)
const quiet = async () => {
  const s = app.sessions.get(P, "ag");
  while (s && Date.now() - s.lastOutputAt < 300) await sleep(50);
};
// Roda o agendador até a rotina ganhar `n` entradas no histórico
const tickUntil = async (id: string, n: number) => {
  app.routines.tick();
  await until(async () => (await one(id)).history.length >= n, `histórico ${n}`);
  return one(id);
};

before(async () => {
  app = build();
  app.canvas.apply(P, {
    kind: "replace",
    nodes: [
      { id: "ag", type: "agentTerminal", position: { x: 0, y: 0 }, data: { title: "Agente", defaultCmd: "" } },
      { id: "cold", type: "agentTerminal", position: { x: 0, y: 0 }, data: { title: "Frio", defaultCmd: "" } },
      { id: "ice", type: "agentTerminal", position: { x: 0, y: 0 }, data: { title: "Gelado", defaultCmd: "" } },
      { id: "boss", type: "agentTerminal", position: { x: 0, y: 0 }, data: { title: "Maestro", isMaestro: true } },
      { id: "note", type: "stickyNote", position: { x: 0, y: 0 }, data: { title: "Nota" } },
      { id: "gone", type: "agentTerminal", position: { x: 0, y: 0 }, data: { title: "Some" } },
    ],
    edges: [],
  });
  await app.fastify.listen({ port: 0, host: "127.0.0.1" });
  port = (app.fastify.server.address() as any).port;
  // Aquece a sessão do agente: espera o shell executar um comando (o eco do tty sozinho engana a captura)
  const session = app.sessions.ensure(P, "ag", { cwd: dataDir, cmd: "" });
  let out = "";
  session.listeners.add((d) => (out += d));
  session.pty.write("echo PRONTO$((1+1))\r");
  await until(() => out.includes("PRONTO2"), "shell pronto", 20000);
  await sleep(800);
});

after(async () => {
  await app.fastify.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// --- Parsing e cálculo do próximo disparo ---

test("parseDuration: 45s, 30m, 2h, 1h30m, número puro = minutos; inválidos erram", () => {
  assert.equal(parseDuration("45s"), 45);
  assert.equal(parseDuration("30m"), 1800);
  assert.equal(parseDuration("2h"), 7200);
  assert.equal(parseDuration("1h30m"), 5400);
  assert.equal(parseDuration("90"), 5400);
  assert.equal(parseDuration(" 2H "), 7200);
  for (const bad of ["", "abc", "1.5m", "0", "4s", "30x", "m30", "8d", "10081", "-5"]) assert.throws(() => parseDuration(bad), /Intervalo inválido/, bad);
});

test("parseSchedule: formatos canônicos, atalhos do CLI e legado em minutos", () => {
  assert.deepEqual(parseSchedule({ type: "interval", every: "1h30m" }), { type: "interval", seconds: 5400 });
  assert.deepEqual(parseSchedule({ type: "interval", seconds: 45 }), { type: "interval", seconds: 45 });
  assert.deepEqual(parseSchedule({ type: "interval", minutes: 5 }), { type: "interval", seconds: 300 });
  assert.deepEqual(parseSchedule({ type: "daily", time: "09:00" }), { type: "daily", time: "09:00" });
  assert.deepEqual(parseSchedule({ type: "weekly", spec: "fri,mon,wed@09:30" }), { type: "weekly", days: ["mon", "wed", "fri"], time: "09:30" });
  assert.deepEqual(parseSchedule({ type: "weekly", days: ["sun", "SUN", "sat"], time: "10:00" }), { type: "weekly", days: ["sat", "sun"], time: "10:00" });
  assert.deepEqual(parseSchedule({ type: "once", at: "2026-06-20 15:00" }), { type: "once", at: "2026-06-20 15:00" });
  for (const bad of [
    null, { type: "cron" }, { type: "interval" }, { type: "interval", every: "1x" }, { type: "daily", time: "24:00" }, { type: "daily", time: "9:00" },
    { type: "weekly", days: [], time: "09:00" }, { type: "weekly", days: ["xyz"], time: "09:00" }, { type: "weekly", spec: "mon" },
    { type: "once", at: "2026-06-20" }, { type: "once", at: "2026-02-30 10:00" }, { type: "once", at: "2026-06-20 25:00" },
  ]) assert.throws(() => parseSchedule(bad), /inválid|Dias|Horário|once|Data/i, JSON.stringify(bad));
});

test("nextRun: interval, daily (mês/ano), weekly e once", () => {
  const t = WED;
  assert.equal(nextRun({ type: "interval", seconds: 90 }, t), t + 90_000);
  assert.equal(nextRun({ type: "daily", time: "18:30" }, t), new Date(2026, 5, 10, 18, 30).getTime());
  assert.equal(nextRun({ type: "daily", time: "09:00" }, t), new Date(2026, 5, 11, 9, 0).getTime());
  assert.equal(nextRun({ type: "daily", time: "12:00" }, t), new Date(2026, 5, 11, 12, 0).getTime(), "estritamente depois");
  assert.equal(nextRun({ type: "daily", time: "00:05" }, new Date(2026, 5, 30, 23, 59).getTime()), new Date(2026, 6, 1, 0, 5).getTime());
  assert.equal(nextRun({ type: "daily", time: "08:00" }, new Date(2026, 11, 31, 23, 30).getTime()), new Date(2027, 0, 1, 8, 0).getTime());
  // weekly (quarta 12:00): hoje mais tarde, próxima sexta, mesma hora = semana seguinte, domingo, fim de ano
  const w = (days: string, time: string, from = t) => nextRun(parseSchedule({ type: "weekly", spec: `${days}@${time}` }), from);
  assert.equal(w("mon,wed,fri", "09:00"), new Date(2026, 5, 12, 9, 0).getTime());
  assert.equal(w("wed", "13:00"), new Date(2026, 5, 10, 13, 0).getTime());
  assert.equal(w("wed", "12:00"), new Date(2026, 5, 17, 12, 0).getTime());
  assert.equal(w("sun", "00:00"), new Date(2026, 5, 14, 0, 0).getTime());
  assert.equal(w("mon", "08:00"), new Date(2026, 5, 15, 8, 0).getTime());
  assert.equal(w("thu", "08:00", new Date(2026, 11, 31, 9, 0).getTime()), new Date(2027, 0, 7, 8, 0).getTime());
  // once
  assert.equal(nextRun({ type: "once", at: "2026-06-20 15:00" }, t), new Date(2026, 5, 20, 15, 0).getTime());
  assert.equal(nextRun({ type: "once", at: "2026-06-10 12:00" }, t), null, "agora exato já passou");
  assert.equal(nextRun({ type: "once", at: "2026-01-01 00:00" }, t), null);
});

// --- API ---

test("validação: campos, agendamento, alvo, opções e projeto", async () => {
  const ok = { nodeId: "ag", name: "n", text: "t", schedule: every5 };
  const bad: object[] = [
    { ...ok, name: "" }, { ...ok, name: "x".repeat(61) }, { ...ok, kind: "outro" }, { ...ok, text: "" }, { ...ok, text: "x".repeat(20001) },
    { ...ok, schedule: { type: "interval", every: "0" } }, { ...ok, schedule: { type: "daily", time: "24:00" } }, { ...ok, schedule: undefined },
    { ...ok, schedule: { type: "once", at: "2026-06-01 10:00" } }, // no passado
    { ...ok, enabled: "sim" }, { ...ok, skipIfBusy: 1 }, { ...ok, notify: "x" },
    { ...ok, count: 0.5 }, { ...ok, count: -1 }, { ...ok, until: "2026-6-1" }, { ...ok, until: "2026-06-09" }, { ...ok, preRun: 5 },
    { ...ok, reminder: true, terminal: "Agente" }, { ...ok, nodeId: undefined },
  ];
  for (const b of bad) assert.equal((await api("POST", "/routines", b)).statusCode, 400, JSON.stringify(b).slice(0, 90));
  assert.equal((await api("POST", "/routines", { ...ok, nodeId: "nope" })).statusCode, 404);
  assert.equal((await api("POST", "/routines", { ...ok, nodeId: "note" })).statusCode, 404);
  assert.equal((await api("POST", "/routines", { ...ok, nodeId: undefined, terminal: "Fantasma" })).statusCode, 404);
  assert.equal((await app.fastify.inject({ method: "GET", url: "/api/projects/nao-existe/routines" })).statusCode, 404);
  assert.equal((await api("PUT", "/routines/rt-nada", { name: "x" })).statusCode, 404);
  assert.equal((await api("DELETE", "/routines/rt-nada")).statusCode, 404);
  assert.equal((await api("POST", "/routines/rt-nada/run")).statusCode, 404);
  assert.deepEqual(await routinesList(), []);
});

test("criar: padrões, alvo por título, lembrete, persiste e recarrega", async () => {
  const daily = await make({ name: "diaria", schedule: { type: "daily", time: "18:30" } });
  const off = await make({ name: "pausada", enabled: false });
  const byTitle = await make({ name: "por titulo", nodeId: undefined, terminal: "frio" });
  const rem = await make({ name: "lembrete", nodeId: undefined, reminder: true });
  assert.match(daily.id, /^rt-[0-9a-f]{8}$/);
  assert.equal(daily.shortId, daily.id.slice(3, 9));
  assert.equal(daily.nextRunAt, new Date(2026, 5, 10, 18, 30).getTime());
  assert.deepEqual({ k: daily.kind, sk: daily.skipIfBusy, n: daily.notify, e: daily.enabled, f: daily.fired, h: daily.history, st: daily.status }, { k: "command", sk: true, n: true, e: true, f: 0, h: [], st: "active" });
  assert.equal(daily.label, "todo dia às 18:30");
  assert.equal(off.enabled, false);
  assert.equal(off.status, "disabled");
  assert.equal(byTitle.nodeId, "cold");
  assert.equal(byTitle.nodeTitle, "Frio");
  assert.deepEqual({ r: rem.reminder, n: rem.nodeId }, { r: true, n: null });
  assert.ok(events.some((e) => e.type === "routines"));

  const file = path.join(dataDir, `routines_${P}.json`);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).routines.length, 4);
  const second = build();
  const reloaded = (await second.fastify.inject({ method: "GET", url: `/api/projects/${P}/routines` })).json().routines;
  assert.deepEqual(reloaded.map((r: any) => r.id).sort(), [daily.id, off.id, byTitle.id, rem.id].sort());
  await second.fastify.close();
  await cleanup();
});

test("migração: arquivo antigo (minutos, sem alvo/opções, histórico ok/error) vira o modelo novo sem toast", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maestri-routines-old-")));
  const old = {
    id: "rt-deadbeef", nodeId: "ag", name: "Velha", kind: "prompt", text: "oi", enabled: true, createdAt: "2026-01-01T00:00:00.000Z", nextRunAt: WED + 1000,
    schedule: { type: "interval", minutes: 15 },
    history: [{ at: "2026-01-01T00:00:00.000Z", ok: true, output: "saida" }, { at: "2026-01-01T00:15:00.000Z", ok: false, error: "boom" }],
  };
  const daily = { ...old, id: "rt-cafe0001", name: "Diaria", schedule: { type: "daily", time: "07:30" }, history: [] };
  fs.writeFileSync(path.join(dir, `routines_${P}.json`), JSON.stringify({ routines: [old, daily] }));
  const other = build(dir);
  const list = (await other.fastify.inject({ method: "GET", url: `/api/projects/${P}/routines` })).json().routines;
  const r = list.find((x: any) => x.id === "rt-deadbeef");
  assert.deepEqual(r.schedule, { type: "interval", seconds: 900 });
  assert.equal(r.label, "a cada 15m");
  assert.deepEqual({ rem: r.reminder, n: r.notify, sk: r.skipIfBusy, f: r.fired, kind: r.kind, node: r.nodeId, next: r.nextRunAt }, { rem: false, n: false, sk: true, f: 0, kind: "prompt", node: "ag", next: WED + 1000 });
  assert.deepEqual(r.history, [{ at: "2026-01-01T00:00:00.000Z", status: "ok", output: "saida" }, { at: "2026-01-01T00:15:00.000Z", status: "error", reason: "boom" }]);
  assert.deepEqual(list.find((x: any) => x.id === "rt-cafe0001").schedule, { type: "daily", time: "07:30" });
  await other.fastify.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("rodar agora: executa no terminal, captura a saída e NÃO mexe em contadores nem na próxima execução", async () => {
  const r = await make({ text: "echo ROTINA$((40+2))", notify: false });
  clock += 60_000;
  const res = await api("POST", `/routines/${r.id}/run`);
  assert.equal(res.statusCode, 202);
  assert.equal(res.json().status, "started");
  await until(async () => (await one(r.id)).history.length === 1, "execução", 15000);
  const done = await one(r.id);
  assert.equal(done.history[0].status, "ok");
  assert.match(done.history[0].output, /ROTINA42/);
  assert.equal(done.lastRunAt, done.history[0].at);
  assert.equal(done.fired, 0);
  assert.equal(done.nextRunAt, r.nextRunAt);
  await cleanup();
});

test("rodar agora: terminal parado é pulado (com motivo); o disparo agendado sobe o terminal", async () => {
  const stub: string[] = [];
  impl = async (_s, _sess, input) => (stub.push(input), { output: "ok", timedOut: false });
  const r = await make({ nodeId: "cold" });
  const res = await api("POST", `/routines/${r.id}/run`);
  assert.equal(res.statusCode, 202);
  assert.deepEqual({ s: res.json().status, why: res.json().reason }, { s: "skipped", why: "terminal não está rodando" });
  assert.equal(app.sessions.get(P, "cold"), undefined);
  let cur = await one(r.id);
  assert.equal(cur.history[0].status, "skipped");
  assert.equal(cur.lastRunAt, undefined);
  assert.equal(cur.nextRunAt, r.nextRunAt, "manual não mexe na agenda");

  clock = r.nextRunAt;
  cur = await tickUntil(r.id, 2);
  assert.equal(cur.history[1].status, "ok");
  assert.ok(app.sessions.get(P, "cold"), "a sessão foi criada");
  assert.equal(stub.length, 1);
  await cleanup();
});

test("tick só roda o que venceu e está ligado; PUT liga/desliga; mudar o agendamento zera contadores", async () => {
  const runs: string[] = [];
  impl = async (_s, _sess, input) => (runs.push(input), { output: "ok", timedOut: false });
  const r = await make();
  app.routines.tick();
  await sleep(30);
  assert.equal(runs.length, 0, "ainda não venceu");

  clock = r.nextRunAt;
  let cur = await tickUntil(r.id, 1);
  assert.equal(runs[0], "echo x\r");
  assert.deepEqual({ f: cur.fired, n: cur.nextRunAt }, { f: 1, n: clock + 300_000 });

  const off = await api("PUT", `/routines/${r.id}`, { enabled: false });
  assert.equal(off.json().routine.status, "disabled");
  clock += 600_000;
  app.routines.tick();
  await sleep(50);
  assert.equal(runs.length, 1, "desligada não roda, mesmo vencida");

  const on = (await api("PUT", `/routines/${r.id}`, { enabled: true })).json().routine;
  assert.equal(on.nextRunAt, clock + 300_000);
  assert.equal(on.fired, 1, "religar não zera");
  const re = (await api("PUT", `/routines/${r.id}`, { schedule: { type: "daily", time: "03:00" }, name: "nova" })).json().routine;
  assert.deepEqual({ f: re.fired, n: re.nextRunAt, name: re.name }, { f: 0, n: nextRun({ type: "daily", time: "03:00" }, clock), name: "nova" });
  // mesmo agendamento: contadores ficam
  assert.equal((await api("PUT", `/routines/${r.id}`, { schedule: { type: "daily", time: "03:00" }, text: "echo y" })).json().routine.text, "echo y");
  // PUT inválido não muda nada
  assert.equal((await api("PUT", `/routines/${r.id}`, { name: "ok", text: "" })).statusCode, 400);
  assert.equal((await one(r.id)).name, "nova");
  await cleanup();
});

test("count: para depois de N disparos; religar recomeça; once dispara uma vez e conclui", async () => {
  impl = async () => ({ output: "ok", timedOut: false });
  const r = await make({ count: 2 });
  clock = r.nextRunAt;
  let cur = await tickUntil(r.id, 1);
  assert.deepEqual({ f: cur.fired, e: cur.enabled, c: cur.completed }, { f: 1, e: true, c: undefined });
  clock = cur.nextRunAt;
  cur = await tickUntil(r.id, 2);
  assert.deepEqual({ f: cur.fired, e: cur.enabled, c: cur.completed, n: cur.nextRunAt, st: cur.status }, { f: 2, e: false, c: true, n: null, st: "completed" });
  clock += 3_600_000;
  app.routines.tick();
  await sleep(50);
  assert.equal((await one(r.id)).history.length, 2, "concluída não dispara mais");
  const again = (await api("PUT", `/routines/${r.id}`, { enabled: true })).json().routine;
  assert.deepEqual({ f: again.fired, e: again.enabled, c: again.completed, n: again.nextRunAt }, { f: 0, e: true, c: false, n: clock + 300_000 });
  await cleanup();

  const o = await make({ schedule: { type: "once", at: "2026-06-10 12:30" } });
  assert.equal(o.nextRunAt, new Date(2026, 5, 10, 12, 30).getTime());
  clock = o.nextRunAt;
  cur = await tickUntil(o.id, 1);
  assert.deepEqual({ f: cur.fired, e: cur.enabled, c: cur.completed, n: cur.nextRunAt }, { f: 1, e: false, c: true, n: null });
  // religar com a data no passado é recusado; remarcar reabre
  assert.equal((await api("PUT", `/routines/${o.id}`, { enabled: true })).statusCode, 400);
  const moved = (await api("PUT", `/routines/${o.id}`, { schedule: { type: "once", at: "2026-06-10 13:00" } })).json().routine;
  assert.deepEqual({ f: moved.fired, e: moved.enabled, c: moved.completed }, { f: 0, e: true, c: false });
  await cleanup();
});

test("until: último dia é inclusivo; passou do dia = conclui sem disparar", async () => {
  impl = async () => ({ output: "ok", timedOut: false });
  // diária 13:00 até amanhã (12:00): a próxima (amanhã) já passa do limite -> dispara hoje? não: amanhã > until, então conclui no ato do primeiro disparo
  const r = await make({ schedule: { type: "daily", time: "13:00" }, until: "2026-06-11" });
  clock = r.nextRunAt; // 10/06 13:00
  let cur = await tickUntil(r.id, 1);
  assert.equal(cur.completed, undefined, "amanhã (11/06 13:00) ainda é o último dia");
  assert.equal(cur.nextRunAt, new Date(2026, 5, 11, 13, 0).getTime());
  clock = cur.nextRunAt;
  cur = await tickUntil(r.id, 2);
  assert.deepEqual({ c: cur.completed, e: cur.enabled, n: cur.nextRunAt }, { c: true, e: false, n: null });

  clock = WED;
  const late = await make({ until: "2026-06-10" });
  clock = new Date(2026, 5, 11, 0, 5).getTime();
  app.routines.tick();
  await until(async () => (await one(late.id)).completed === true, "concluiu pelo until");
  assert.equal((await one(late.id)).history.length, 0, "não disparou");
  await cleanup();
});

test("pre-run: stdout entra em {{output}}, roda no cwd do alvo com as variáveis; saída ≠ 0 ou timeout pulam", async () => {
  const typed: string[] = [];
  impl = async (_s, _sess, input) => (typed.push(input), { output: "ok", timedOut: false });
  const r = await make({
    name: "Resumo",
    text: "Resuma:\n{{output}}\n---\n{{output}}",
    preRun: 'echo "$MAESTRI_WORKSPACE_NAME|$MAESTRI_WORKSPACE_DIR|$MAESTRI_ROUTINE_NAME|$MAESTRI_TERMINAL_NAME|$(pwd -P)"; echo $ {x}',
  });
  assert.equal((await api("POST", `/routines/${r.id}/run`)).json().status, "started");
  await until(() => typed.length === 1, "digitou");
  const input = typed[0];
  assert.match(input, /^\x1b\[200~Resuma:\n/);
  assert.ok(input.includes(`Meu Projeto|${dataDir}|Resumo|Agente|${dataDir}`), input);
  assert.equal(input.split("Meu Projeto").length, 3, "{{output}} trocado nas duas ocorrências");
  assert.doesNotMatch(input, /\{\{output\}\}/);
  await until(async () => (await one(r.id)).history.length === 1, "histórico");

  // sem {{output}}: o script roda mas nada é inserido
  const plain = await make({ text: "echo fixo", preRun: "echo ignorado" });
  await api("POST", `/routines/${plain.id}/run`);
  await until(() => typed.length === 2, "digitou 2");
  assert.equal(typed[1], "echo fixo\r");

  // saída ≠ 0: pulado, com o motivo (stderr), sem digitar
  const failing = await make({ text: "nunca {{output}}", preRun: "echo explodiu >&2; exit 3" });
  const res = await api("POST", `/routines/${failing.id}/run`);
  assert.equal(res.json().status, "started");
  await until(async () => (await one(failing.id)).history.length === 1, "pulado");
  const h = (await one(failing.id)).history[0];
  assert.equal(h.status, "skipped");
  assert.match(h.reason, /pre-run saiu com código 3: explodiu/);
  assert.equal(typed.length, 2);

  await api("DELETE", `/routines/${r.id}`);
  await api("DELETE", `/routines/${plain.id}`);
  // agendado: pulo conta como disparo pulado (não incrementa fired) e a agenda avança
  clock = failing.nextRunAt;
  const sched = await tickUntil(failing.id, 2);
  assert.deepEqual({ f: sched.fired, n: sched.nextRunAt, s: sched.history[1].status }, { f: 0, n: clock + 300_000, s: "skipped" });

  // timeout
  const slow = await make({ preRun: "sleep 5" });
  await api("POST", `/routines/${slow.id}/run`);
  await until(async () => (await one(slow.id)).history.length === 1, "timeout do pre-run", 6000);
  assert.match((await one(slow.id)).history[0].reason, /excedeu 1\.5s/);
  assert.equal(typed.length, 2);
  await cleanup();
});

test("pular se ocupado: chat em andamento ou saída recente; --no-skip-if-busy dispara mesmo assim", async () => {
  const calls: string[] = [];
  impl = async (_s, _sess, input) => (calls.push(input), { output: "", timedOut: false });
  const r = await make();
  busyNodes.add("ag");
  clock = r.nextRunAt;
  let cur = await tickUntil(r.id, 1);
  assert.equal(calls.length, 0);
  assert.deepEqual({ s: cur.history[0].status, f: cur.fired, n: cur.nextRunAt }, { s: "skipped", f: 0, n: clock + 300_000 });
  assert.match(cur.history[0].reason, /chat em andamento/);
  const man = await api("POST", `/routines/${r.id}/run`);
  assert.equal(man.json().status, "skipped");
  assert.equal(calls.length, 0);

  // saída recente do terminal
  busyNodes.clear();
  app.sessions.get(P, "ag")!.lastOutputAt = Date.now();
  clock = cur.nextRunAt;
  cur = await tickUntil(r.id, 3);
  assert.match(cur.history[2].reason, /saída recente/);
  assert.equal(calls.length, 0);

  // desligado o pulo: dispara com o terminal ocupado
  await api("PUT", `/routines/${r.id}`, { skipIfBusy: false });
  busyNodes.add("ag");
  app.sessions.get(P, "ag")!.lastOutputAt = Date.now();
  clock = (await one(r.id)).nextRunAt;
  cur = await tickUntil(r.id, 4);
  assert.equal(cur.history[3].status, "ok");
  assert.equal(calls.length, 1);
  assert.equal(cur.fired, 1);
  await cleanup();
});

test("lembrete: toast com o texto (e pre-run), sem tocar em terminal; notify liga o toast de cada disparo", async () => {
  const calls: string[] = [];
  impl = async (_s, _sess, input) => (calls.push(input), { output: "", timedOut: false });
  const r = await make({ nodeId: undefined, reminder: true, name: "Standup", text: "Hora do standup: {{output}}", preRun: "echo 5 pessoas" });
  clock = r.nextRunAt;
  const cur = await tickUntil(r.id, 1);
  assert.equal(cur.history[0].status, "ok");
  assert.equal(calls.length, 0);
  assert.deepEqual(toasts().map((t) => [t.from.title, t.text]), [["Standup", "Hora do standup: 5 pessoas"]]);
  assert.equal(cur.fired, 1);
  await cleanup();

  const loud = await make({ name: "Barulhenta" });
  const quietOne = await make({ name: "Quieta", notify: false });
  clock = loud.nextRunAt;
  await tickUntil(loud.id, 1);
  await until(async () => (await one(quietOne.id)).history.length === 1, "quieta");
  assert.deepEqual(toasts().map((t) => t.text), ['Rotina "Barulhenta" executada']);
  assert.equal(toasts()[0].from.title, "Agente");
  await cleanup();
});

test("texto multi-linha vai como bracketed paste; erro e timeout viram status error; histórico guarda 20", async () => {
  const inputs: string[] = [];
  let mode: "ok" | "timeout" | "throw" = "ok";
  impl = async (_s, _sess, input) => {
    inputs.push(input);
    if (mode === "throw") throw new Error("boom");
    return { output: "x".repeat(5000) + "FIM", timedOut: mode === "timeout" };
  };
  const r = await make({ text: "linha1\nlinha2", notify: false });
  const run = async () => {
    clock += 1000;
    const expected = new Date(clock).toISOString();
    assert.equal((await api("POST", `/routines/${r.id}/run`)).statusCode, 202);
    await until(async () => (await one(r.id)).history.at(-1)?.at === expected, "run");
  };
  await run();
  assert.equal(inputs[0], "\x1b[200~linha1\nlinha2\x1b[201~\r");
  let h = (await one(r.id)).history;
  assert.equal(h[0].output.length, 4000);
  assert.ok(h[0].output.endsWith("FIM"));

  mode = "timeout";
  await run();
  h = (await one(r.id)).history;
  assert.equal(h.at(-1).status, "error");
  assert.match(h.at(-1).reason, /tempo esgotado/);

  mode = "throw";
  await run();
  assert.deepEqual((await one(r.id)).history.at(-1).reason, "boom");

  mode = "ok";
  for (let i = 0; i < 22; i++) await run();
  h = (await one(r.id)).history;
  assert.equal(h.length, 20);
  await cleanup();
});

test("sem execuções sobrepostas: segundo run dá 409 e o tick ignora a rotina em execução", async () => {
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  impl = async () => (await gate, { output: "", timedOut: false });
  const r = await make({ notify: false });
  assert.equal((await api("POST", `/routines/${r.id}/run`)).statusCode, 202);
  assert.equal((await api("POST", `/routines/${r.id}/run`)).statusCode, 409);
  clock = r.nextRunAt + 1;
  app.routines.tick();
  release();
  await until(async () => (await one(r.id)).history.length === 1, "terminou");
  assert.equal((await one(r.id)).history.length, 1, "o tick não duplicou");
  await cleanup();
});

test("nó removido: o disparo registra o erro e desabilita a rotina", async () => {
  const r = await make({ nodeId: "gone" });
  app.canvas.apply(P, { kind: "removeNodes", ids: ["gone"] });
  clock = r.nextRunAt;
  const done = await tickUntil(r.id, 1);
  assert.deepEqual({ s: done.history[0].status, why: done.history[0].reason, e: done.enabled }, { s: "error", why: "nó removido", e: false });
  await cleanup();
});

test("DELETE remove a rotina e removeProject apaga o arquivo", async () => {
  const r = await make();
  assert.equal((await api("DELETE", `/routines/${r.id}`)).statusCode, 200);
  assert.deepEqual(await routinesList(), []);
  await make();
  const file = path.join(dataDir, `routines_${P}.json`);
  assert.ok(fs.existsSync(file));
  app.routines.removeProject(P);
  assert.ok(!fs.existsSync(file));
  assert.deepEqual(await routinesList(), []);
});

// --- CLI: o executável real, como o Maestro dentro do PTY ---

function maestri(nodeId: string, args: string[], env: Record<string, string> = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      [bin, ...args],
      { env: { ...process.env, MAESTRI_API_URL: `http://127.0.0.1:${port}/api`, MAESTRI_PROJECT_ID: P, MAESTRI_NODE_ID: nodeId, ...env } },
      (err, stdout, stderr) => resolve({ code: err ? ((err as any).code ?? 1) : 0, stdout, stderr }),
    );
  });
}
const rt = (...a: string[]) => maestri("boss", ["routine", ...a]);

test("CLI: tudo exige o Maestro; --help e help listam os comandos", async () => {
  for (const args of [["list"], ["create", "X", "--command", "c", "--every", "5m"], ["run", "X"], ["delete", "X"]]) {
    const r = await maestri("ag", ["routine", ...args]);
    assert.equal(r.code, 1, args.join(" "));
    assert.match(r.stderr, /Apenas o Maestro/);
  }
  const h = await maestri("x", ["routine", "--help"], { MAESTRI_API_URL: "", MAESTRI_PROJECT_ID: "", MAESTRI_NODE_ID: "" });
  assert.equal(h.code, 0);
  for (const w of ["create", "show", "edit", "enable", "disable", "run", "delete", "--weekly", "--once", "--reminder", "--pre-run", "{{output}}", "--id"]) assert.ok(h.stdout.includes(w), w);
  const g = await maestri("x", ["help"], { MAESTRI_API_URL: "", MAESTRI_PROJECT_ID: "", MAESTRI_NODE_ID: "" });
  assert.match(g.stdout, /routine list\|show\|create/);
});

test("CLI: create com todos os agendamentos/alvos/opções, list e show", async () => {
  assert.equal((await rt("list")).stdout.trim(), "Nenhuma rotina.");
  const a = await rt("create", "Audit", "--command", "npm audit", "--daily", "02:00", "--terminal", "Agente");
  assert.equal(a.code, 0, a.stderr);
  assert.match(a.stdout, /Rotina "Audit" criada \(id [0-9a-f]{6}, todo dia às 02:00\)/);
  const b = await rt("create", "Self", "--command", "Resumo:\\n\\n{{output}}\\\\n", "--every", "1h30m", "--pre-run", "git log -1", "--count", "3", "--until", "2026-07-01", "--no-skip-if-busy", "--no-notify", "--disabled");
  assert.equal(b.code, 0, b.stderr);
  const c = await rt("create", "Standup", "--command", "Hora!", "--weekly", "mon,wed,fri@09:00", "--reminder");
  assert.equal(c.code, 0, c.stderr);
  const d = await rt("create", "Unica", "--command", "echo 1", "--once", "2026-06-20 15:00", "--terminal", "Agente");
  assert.equal(d.code, 0, d.stderr);
  const e = await rt("create", "Segundos", "--command", "echo", "--every", "45s", "--terminal", "Agente");
  assert.equal(e.code, 0, e.stderr);

  const list = await routinesList();
  const by = Object.fromEntries(list.map((r) => [r.name, r]));
  assert.deepEqual(by.Audit.schedule, { type: "daily", time: "02:00" });
  assert.equal(by.Audit.nodeId, "ag");
  assert.equal(by.Self.nodeId, "boss", "alvo padrão = o próprio terminal");
  assert.equal(by.Self.text, "Resumo:\n\n{{output}}\\n", "\\n vira quebra; \\\\n fica literal");
  assert.deepEqual({ s: by.Self.schedule, pre: by.Self.preRun, c: by.Self.count, u: by.Self.until, sk: by.Self.skipIfBusy, n: by.Self.notify, e: by.Self.enabled },
    { s: { type: "interval", seconds: 5400 }, pre: "git log -1", c: 3, u: "2026-07-01", sk: false, n: false, e: false });
  assert.deepEqual({ s: by.Standup.schedule, rem: by.Standup.reminder, node: by.Standup.nodeId }, { s: { type: "weekly", days: ["mon", "wed", "fri"], time: "09:00" }, rem: true, node: null });
  assert.deepEqual(by.Unica.schedule, { type: "once", at: "2026-06-20 15:00" });
  assert.deepEqual(by.Segundos.schedule, { type: "interval", seconds: 45 });

  const out = (await rt("list")).stdout;
  assert.match(out, /Audit  \[todo dia às 02:00\]  → Agente  ativa/);
  assert.match(out, /Self  \[a cada 1h30m\]  → Maestro  desligada/);
  assert.match(out, /Standup  \[seg,qua,sex às 09:00\]  → lembrete/);
  // rotina desligada não mostra "próxima"
  assert.match(out, /Self  .*desligada  próxima: —  última/);
  assert.match(out, /Unica  \[uma vez em 2026-06-20 15:00\]/);
  const sh = (await rt("show", "self")).stdout;
  assert.match(sh, /status: desligada · disparos: 0\/3 · até 2026-07-01/);
  assert.match(sh, /pular se ocupado: não · notificar: não/);
  assert.match(sh, /pre-run: git log -1/);
  assert.match(sh, /próxima: —/);

  // erros
  assert.match((await rt("create", "X", "--every", "5m")).stderr, /--command/);
  assert.match((await rt("create", "X", "--command", "c")).stderr, /agendamento/);
  assert.match((await rt("create", "X", "--command", "c", "--every", "5m", "--daily", "09:00")).stderr, /só um agendamento/);
  assert.match((await rt("create", "X", "--command", "c", "--every", "5m", "--reminder", "--terminal", "Agente")).stderr, /OU/);
  assert.match((await rt("create", "X", "--command", "c", "--every", "abc")).stderr, /Intervalo inválido/);
  assert.match((await rt("create", "X", "--command", "c", "--weekly", "mon")).stderr, /Horário inválido/);
  assert.match((await rt("create", "X", "--command", "c", "--once", "2020-01-01 10:00")).stderr, /já passou/);
  assert.match((await rt("create", "X", "--command", "c", "--every", "5m", "--terminal", "Fantasma")).stderr, /não encontrado/);
  assert.match((await rt("create", "X", "--command", "c", "--every", "5m", "--count", "x")).stderr, /número/);
  assert.match((await rt("show", "Fantasma")).stderr, /não encontrada/);
  assert.match((await rt("foo")).stderr, /Uso:/);
  await cleanup();
});

test("CLI: edit só os campos passados, enable/disable, run, delete e aliases legados", async () => {
  const c = await rt("create", "Job", "--command", "echo job", "--every", "10m", "--terminal", "Agente", "--count", "5", "--pre-run", "echo p");
  assert.equal(c.code, 0, c.stderr);
  const before = (await routinesList())[0];
  assert.equal((await rt("edit", "Job", "--name", "Job2")).code, 0);
  let cur = (await routinesList())[0];
  assert.deepEqual({ n: cur.name, t: cur.text, s: cur.schedule, c: cur.count, p: cur.preRun, node: cur.nodeId }, { n: "Job2", t: "echo job", s: before.schedule, c: 5, p: "echo p", node: "ag" });

  clock += 1000;
  impl = async () => ({ output: "ok", timedOut: false });
  await quiet();
  assert.equal((await rt("edit", "job2", "--command", "echo novo", "--daily", "04:00", "--count", "0", "--pre-run", "", "--no-notify")).code, 0);
  cur = (await routinesList())[0];
  assert.deepEqual({ t: cur.text, s: cur.schedule, c: cur.count, p: cur.preRun, n: cur.notify, f: cur.fired }, { t: "echo novo", s: { type: "daily", time: "04:00" }, c: undefined, p: undefined, n: false, f: 0 });
  assert.equal((await rt("edit", "Job2", "--reminder")).code, 0);
  assert.deepEqual({ r: (await routinesList())[0].reminder, n: (await routinesList())[0].nodeId }, { r: true, n: null });
  assert.equal((await rt("edit", "Job2", "--terminal", "Agente")).code, 0);
  assert.equal((await routinesList())[0].nodeId, "ag");
  assert.match((await rt("edit", "Job2")).stderr, /Nada para mudar/);
  assert.match((await rt("edit", "Job2", "--until", "2020-01-01")).stderr, /já passou/);

  assert.match((await rt("disable", "JOB2")).stdout, /desligada/);
  assert.equal((await routinesList())[0].enabled, false);
  assert.match((await rt("enable", "Job2")).stdout, /ligada; próxima:/);
  assert.equal((await routinesList())[0].enabled, true);

  // run: terminal rodando = iniciada; parado = pulada com motivo
  assert.match((await rt("run", "Job2")).stdout, /iniciada/);
  await until(async () => (await routinesList())[0].history.length === 1, "run via CLI");
  await rt("edit", "Job2", "--terminal", "Gelado");
  assert.match((await rt("run", "Job2")).stdout, /pulada: terminal não está rodando/);

  assert.match((await rt("delete", "Job2")).stdout, /removida/);
  assert.deepEqual(await routinesList(), []);

  // legado: add/rm (--every N em minutos, --at, --prompt)
  const a = await rt("add", "Backup", "--every", "30", "echo", "backup");
  assert.equal(a.code, 0, a.stderr);
  assert.match(a.stdout, /a cada 30m/);
  const b = await rt("add", "Bom dia", "--at", "09:15", "--prompt", "Resuma o dia");
  assert.equal(b.code, 0, b.stderr);
  assert.deepEqual((await routinesList()).map((r) => [r.name, r.kind, r.nodeId, r.text, r.schedule.type]).sort(), [
    ["Backup", "command", "boss", "echo backup", "interval"],
    ["Bom dia", "prompt", "boss", "Resuma o dia", "daily"],
  ]);
  assert.match((await rt("add", "X", "texto")).stderr, /exatamente um/);
  assert.equal((await rt("rm", "BACKUP")).code, 0);
  assert.deepEqual((await routinesList()).map((r) => r.name), ["Bom dia"]);
  await cleanup();
});

test("CLI: nomes duplicados listam as opções e --id (prefixo) desambigua", async () => {
  await rt("create", "Audit", "--command", "um", "--every", "5m", "--terminal", "Agente");
  await rt("create", "audit", "--command", "dois", "--every", "6m", "--terminal", "Agente");
  const [a, b] = await routinesList();
  for (const sub of ["show", "edit", "enable", "disable", "run", "delete"]) {
    const r = await rt(sub, "AUDIT", ...(sub === "edit" ? ["--command", "x"] : []));
    assert.equal(r.code, 1, sub);
    assert.match(r.stderr, /Várias rotinas correspondem; repita com --id/);
    assert.ok(r.stderr.includes(a.shortId) && r.stderr.includes(b.shortId), sub);
  }
  assert.equal((await routinesList()).length, 2, "nada foi alterado");
  assert.match((await rt("show", "Audit", "--id", b.shortId.slice(0, 4))).stdout, /comando: dois/);
  assert.equal((await rt("edit", "Audit", "--id", a.shortId, "--daily", "03:00")).code, 0);
  assert.deepEqual((await one(a.id)).schedule, { type: "daily", time: "03:00" });
  assert.match((await rt("show", "Audit", "--id", "zzzz")).stderr, /não encontrada/);
  assert.equal((await rt("delete", "Audit", "--id", b.id)).code, 0);
  assert.deepEqual((await routinesList()).map((r) => r.id), [a.id]);
  await cleanup();
});
