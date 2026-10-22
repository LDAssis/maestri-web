import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { CanvasStore } from "../src/canvas.js";
import { SessionManager } from "../src/sessions.js";
import { registerRoutinesApi, nextRun, type TypeAndWait } from "../src/routines.js";
// @ts-expect-error módulo .mjs sem tipos
import { makeRoutine } from "../bin/maestri-routine.mjs";

const P = "proj-r";
const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maestri-routines-test-")));
process.env.MAESTRI_ROUTINE_TICK_MS = "3600000"; // o agendador real não interfere: o teste chama tick()

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 8000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) assert.fail(`timeout: ${what}`);
    await sleep(30);
  }
}

// Mesmo contrato do typeAndWait do nodeApi (hoje não exportado): escreve e espera o PTY ficar quieto
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
let clock = new Date(2026, 5, 10, 12, 0, 0).getTime();
const busyNodes = new Set<string>();
const events: any[] = [];

function build() {
  const fastify = Fastify();
  const sessions = new SessionManager({ apiUrl: () => "http://127.0.0.1:1/api", token: "t" });
  const canvas = new CanvasStore(() => path.join(dataDir, `canvas_${P}.json`), (f, d) => fs.writeFileSync(f, JSON.stringify(d)), (p, ids) => sessions.killNodes(p, ids), 5);
  canvas.notify = (_p: string, msg: unknown) => void events.push(msg);
  fastify.addHook("onClose", async () => sessions.killAll());
  const routines = registerRoutinesApi({
    fastify,
    sessions,
    canvas,
    projectRepo: (id) => (id === P ? dataDir : null),
    dataDir,
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
const sched = { type: "interval", minutes: 5 };
const make = async (extra: object = {}) => {
  const r = await api("POST", "/routines", { nodeId: "ag", name: `r${Math.random()}`, kind: "command", text: "echo x", schedule: sched, ...extra });
  assert.equal(r.statusCode, 201, r.body);
  return r.json().routine;
};
const cleanup = async () => {
  for (const r of await routinesList()) await api("DELETE", `/routines/${r.id}`);
};

before(async () => {
  app = build();
  app.canvas.apply(P, {
    kind: "replace",
    nodes: [
      { id: "ag", type: "agentTerminal", position: { x: 0, y: 0 }, data: { title: "Agente", defaultCmd: "" } },
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

test("nextRun: interval soma minutos; daily pega hoje ou amanhã, inclusive virando mês/ano", () => {
  const t = new Date(2026, 5, 10, 12, 0, 0).getTime();
  assert.equal(nextRun({ type: "interval", minutes: 90 }, t), t + 90 * 60_000);
  assert.equal(nextRun({ type: "daily", time: "18:30" }, t), new Date(2026, 5, 10, 18, 30).getTime());
  assert.equal(nextRun({ type: "daily", time: "09:00" }, t), new Date(2026, 5, 11, 9, 0).getTime());
  // exatamente na hora: estritamente depois -> amanhã
  assert.equal(nextRun({ type: "daily", time: "12:00" }, t), new Date(2026, 5, 11, 12, 0).getTime());
  // vira mês e ano
  assert.equal(nextRun({ type: "daily", time: "00:05" }, new Date(2026, 5, 30, 23, 59).getTime()), new Date(2026, 6, 1, 0, 5).getTime());
  assert.equal(nextRun({ type: "daily", time: "08:00" }, new Date(2026, 11, 31, 23, 30).getTime()), new Date(2027, 0, 1, 8, 0).getTime());
});

test("validação: nome, kind, texto, agendamento, nó e projeto", async () => {
  const ok = { nodeId: "ag", name: "n", kind: "command", text: "t", schedule: sched };
  const bad = [
    { ...ok, name: "" }, { ...ok, name: "x".repeat(61) }, { ...ok, kind: "outro" }, { ...ok, text: "" }, { ...ok, text: "x".repeat(20001) },
    { ...ok, schedule: { type: "interval", minutes: 0 } }, { ...ok, schedule: { type: "interval", minutes: 10081 } },
    { ...ok, schedule: { type: "interval", minutes: 1.5 } }, { ...ok, schedule: { type: "daily", time: "24:00" } },
    { ...ok, schedule: { type: "daily", time: "9:00" } }, { ...ok, schedule: { type: "cron" } }, { ...ok, schedule: undefined },
    { ...ok, enabled: "sim" },
  ];
  for (const b of bad) assert.equal((await api("POST", "/routines", b)).statusCode, 400, JSON.stringify(b).slice(0, 80));
  assert.equal((await api("POST", "/routines", { ...ok, nodeId: "nope" })).statusCode, 404);
  assert.equal((await api("POST", "/routines", { ...ok, nodeId: "note" })).statusCode, 404);
  const other = await app.fastify.inject({ method: "GET", url: "/api/projects/nao-existe/routines" });
  assert.equal(other.statusCode, 404);
  assert.equal((await api("PUT", "/routines/rt-nada", { name: "x" })).statusCode, 404);
  assert.equal((await api("DELETE", "/routines/rt-nada")).statusCode, 404);
  assert.equal((await api("POST", "/routines/rt-nada/run")).statusCode, 404);
  assert.deepEqual(await routinesList(), []);
});

test("criar calcula nextRunAt, persiste em arquivo e recarrega ao subir", async () => {
  const daily = await make({ name: "diaria", schedule: { type: "daily", time: "18:30" } });
  const every = await make({ name: "intervalo", enabled: false });
  assert.match(daily.id, /^rt-[0-9a-f]{8}$/);
  assert.equal(daily.nextRunAt, new Date(2026, 5, 10, 18, 30).getTime());
  assert.equal(every.nextRunAt, clock + 5 * 60_000);
  assert.equal(every.enabled, false);
  assert.deepEqual(every.history, []);
  assert.equal(every.lastRunAt, undefined);
  assert.ok(events.some((e) => e.type === "routines"));

  const file = path.join(dataDir, `routines_${P}.json`);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).routines.map((r: any) => r.id).sort(), [daily.id, every.id].sort());

  const second = build(); // outro processo lendo o mesmo dataDir
  const reloaded = (await second.fastify.inject({ method: "GET", url: `/api/projects/${P}/routines` })).json().routines;
  assert.deepEqual(reloaded.map((r: any) => r.id).sort(), [daily.id, every.id].sort());
  await second.fastify.close();
  await cleanup();
});

test("rodar agora executa no terminal do nó, captura a saída e agenda a próxima", async () => {
  const r = await make({ text: "echo ROTINA$((40+2))" });
  events.length = 0;
  clock += 60_000;
  const res = await api("POST", `/routines/${r.id}/run`);
  assert.equal(res.statusCode, 202);
  await until(async () => (await routinesList())[0].history.length === 1, "execução", 15000);
  const done = (await routinesList())[0];
  assert.equal(done.history[0].ok, true);
  assert.match(done.history[0].output, /ROTINA42/);
  assert.equal(done.lastRunAt, done.history[0].at);
  assert.equal(done.nextRunAt, clock + 5 * 60_000);
  assert.ok(events.some((e) => e.type === "routines"));
  await cleanup();
});

test("tick só roda o que venceu e está ligado; PUT liga/desliga e recalcula", async () => {
  const runs: string[] = [];
  impl = async (_s, _sess, input) => (runs.push(input), { output: "ok", timedOut: false });
  try {
    const r = await make();
    app.routines.tick();
    await sleep(30);
    assert.equal(runs.length, 0, "ainda não venceu");

    clock = r.nextRunAt;
    app.routines.tick();
    await until(() => runs.length === 1, "tick executou");
    assert.equal(runs[0], "echo x\r");
    await until(async () => (await routinesList())[0].history.length === 1, "histórico");
    assert.equal((await routinesList())[0].nextRunAt, clock + 5 * 60_000);

    // desligada não roda, mesmo vencida
    const off = await api("PUT", `/routines/${r.id}`, { enabled: false });
    assert.equal(off.json().routine.enabled, false);
    clock += 10 * 60_000;
    app.routines.tick();
    await sleep(50);
    assert.equal(runs.length, 1);

    // religar recalcula a partir de agora; trocar agendamento também
    const on = (await api("PUT", `/routines/${r.id}`, { enabled: true })).json().routine;
    assert.equal(on.nextRunAt, clock + 5 * 60_000);
    const re = (await api("PUT", `/routines/${r.id}`, { schedule: { type: "daily", time: "03:00" }, name: "nova" })).json().routine;
    assert.equal(re.nextRunAt, nextRun({ type: "daily", time: "03:00" }, clock));
    assert.equal(re.name, "nova");
    // PUT inválido não muda nada
    assert.equal((await api("PUT", `/routines/${r.id}`, { name: "ok", text: "" })).statusCode, 400);
    assert.equal((await routinesList())[0].name, "nova");
  } finally {
    impl = realTypeAndWait;
    await cleanup();
  }
});

test("texto multi-linha vai como bracketed paste; erro e timeout viram ok:false; histórico guarda 20", async () => {
  const inputs: string[] = [];
  let mode: "ok" | "timeout" | "throw" = "ok";
  impl = async (_s, _sess, input) => {
    inputs.push(input);
    if (mode === "throw") throw new Error("boom");
    return { output: "x".repeat(5000) + "FIM", timedOut: mode === "timeout" };
  };
  try {
    const r = await make({ text: "linha1\nlinha2" });
    const run = async () => {
      clock += 1000;
      const expected = new Date(clock).toISOString();
      assert.equal((await api("POST", `/routines/${r.id}/run`)).statusCode, 202);
      await until(async () => (await routinesList())[0].history.at(-1)?.at === expected, "run");
    };
    await run();
    assert.equal(inputs[0], "\x1b[200~linha1\nlinha2\x1b[201~\r");
    let h = (await routinesList())[0].history;
    assert.equal(h[0].output.length, 4000);
    assert.ok(h[0].output.endsWith("FIM"), "últimos 4000 caracteres");

    mode = "timeout";
    await run();
    h = (await routinesList())[0].history;
    assert.equal(h.at(-1).ok, false);
    assert.match(h.at(-1).error, /tempo esgotado/);

    mode = "throw";
    await run();
    h = (await routinesList())[0].history;
    assert.deepEqual({ ok: h.at(-1).ok, error: h.at(-1).error }, { ok: false, error: "boom" });

    mode = "ok";
    for (let i = 0; i < 22; i++) await run();
    h = (await routinesList())[0].history;
    assert.equal(h.length, 20);
    assert.ok(Date.parse(h.at(-1).at) >= Date.parse(h[0].at), "mais recente por último");
  } finally {
    impl = realTypeAndWait;
    await cleanup();
  }
});

test("sem execuções sobrepostas e chat ocupado adia 60s", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  impl = async () => (await gate, { output: "", timedOut: false });
  try {
    const r = await make();
    assert.equal((await api("POST", `/routines/${r.id}/run`)).statusCode, 202);
    assert.equal((await api("POST", `/routines/${r.id}/run`)).statusCode, 409, "já em execução");
    clock = r.nextRunAt + 1;
    app.routines.tick(); // vencida mas rodando: ignora
    release();
    await until(async () => (await routinesList())[0].history.length === 1, "terminou");
    assert.equal((await routinesList())[0].history.length, 1, "o tick não duplicou");

    const calls: number[] = [];
    impl = async () => (calls.push(1), { output: "", timedOut: false });
    busyNodes.add("ag");
    const due = (await routinesList())[0];
    clock = due.nextRunAt + 1;
    app.routines.tick();
    await sleep(50);
    assert.equal(calls.length, 0, "chat ocupado: não executou");
    const deferred = (await routinesList())[0];
    assert.equal(deferred.nextRunAt, clock + 60_000);
    assert.equal(deferred.history.length, 1);
    assert.equal((await api("POST", `/routines/${r.id}/run`)).statusCode, 409);

    busyNodes.delete("ag");
    clock = deferred.nextRunAt;
    app.routines.tick();
    await until(() => calls.length === 1, "executou depois de livre");
  } finally {
    busyNodes.clear();
    impl = realTypeAndWait;
    await cleanup();
  }
});

test("nó removido: a execução registra o erro e desabilita a rotina", async () => {
  const r = await make({ nodeId: "gone" });
  app.canvas.apply(P, { kind: "removeNodes", ids: ["gone"] });
  clock = r.nextRunAt;
  app.routines.tick();
  await until(async () => (await routinesList())[0].history.length === 1, "registrou");
  const done = (await routinesList())[0];
  assert.deepEqual({ ok: done.history[0].ok, error: done.history[0].error, enabled: done.enabled }, { ok: false, error: "nó removido", enabled: false });
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

// --- CLI: maestri routine (helpers injetados como no bin/maestri) ---
class CliError extends Error {}
const need = (pos: string[], n: number, usage: string) => {
  if (pos.length < n) throw new CliError(`Uso: maestri ${usage}`);
};
async function cli(node: string, argv: string[]) {
  const flags: Record<string, string> = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--every" || argv[i] === "--at") flags[argv[i].slice(2)] = argv[++i];
    else pos.push(argv[i]);
  }
  const call = async (method: string, route: string, body?: object) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/projects/${P}/nodes/${node}${route}`, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new CliError(data.error || `Erro ${res.status}`);
    return data;
  };
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    await makeRoutine({ call, need, CliError })({ pos, flags });
    return { ok: true, out: lines.join("\n") };
  } catch (e: any) {
    return { ok: false, out: e.message };
  } finally {
    console.log = orig;
  }
}

test("CLI routine: add (--every/--at/--prompt), list, run e rm sempre no próprio nó", async () => {
  assert.equal((await cli("ag", ["list"])).out, "Nenhuma rotina.");

  const a = await cli("ag", ["add", "Backup", "--every", "30", "echo", "backup"]);
  assert.equal(a.ok, true, a.out);
  assert.match(a.out, /Backup.*a cada 30 min/);
  const b = await cli("ag", ["add", "Bom dia", "--at", "09:15", "--prompt", "Resuma o dia"]);
  assert.equal(b.ok, true, b.out);
  assert.match(b.out, /todo dia às 09:15/);

  const list = await routinesList();
  assert.deepEqual(list.map((r) => [r.name, r.kind, r.nodeId, r.text]).sort(), [
    ["Backup", "command", "ag", "echo backup"],
    ["Bom dia", "prompt", "ag", "Resuma o dia"],
  ]);
  const shown = await cli("ag", ["list"]);
  assert.match(shown.out, /Backup \[command\] a cada 30 min/);
  assert.match(shown.out, /Bom dia \[prompt\] todo dia às 09:15/);

  // erros
  assert.match((await cli("ag", ["add", "X", "texto"])).out, /exatamente um/);
  assert.match((await cli("ag", ["add", "X", "--every", "5", "--at", "09:00", "t"])).out, /exatamente um/);
  assert.match((await cli("ag", ["add", "X", "--every", "0", "t"])).out, /Agendamento inválido/);
  assert.match((await cli("ag", ["add", "X"])).out, /Uso:/);
  assert.match((await cli("note", ["list"])).out, /não encontrado/);
  assert.match((await cli("ag", ["rm", "Inexistente"])).out, /não encontrada/);
  assert.match((await cli("ag", ["foo"])).out, /Uso:/);

  // run por nome (sem diferenciar maiúsculas)
  const seen: string[] = [];
  impl = async (_s, _sess, input) => (seen.push(input), { output: "", timedOut: false });
  try {
    assert.equal((await cli("ag", ["run", "backup"])).ok, true);
    await until(() => seen.length === 1, "run via CLI");
    assert.equal(seen[0], "echo backup\r");
  } finally {
    impl = realTypeAndWait;
  }

  assert.equal((await cli("ag", ["rm", "BACKUP"])).ok, true);
  assert.deepEqual((await routinesList()).map((r) => r.name), ["Bom dia"]);
  await cleanup();
});
