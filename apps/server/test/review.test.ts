import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maestri-review-test-")));
const repo = path.join(tmp, "repo");
fs.mkdirSync(repo);
process.env.REPO_PATH = repo;
process.env.NODE_ENV = "test";
process.env.MAESTRI_TOKEN = "tok-rv";
process.env.MAESTRI_ROUTINE_PRERUN_MS = "400";

const { fastify } = await import("../src/index.js");
const { cloneCanvas } = await import("../src/floors.js");
const { runPreRun, sanitizeTyped } = await import("../src/routines.js");
const { AccountStore } = await import("../src/accounts.js");
const { safeHttpUrl } = await import("../src/floorsApi.js");
const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/maestri");
const P = "proj-maestri-web";
const auth = { authorization: "Bearer tok-rv" };
let port = 0;

function maestri(args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      [bin, ...args],
      { env: { ...process.env, MAESTRI_API_URL: `http://127.0.0.1:${port}/api`, MAESTRI_PROJECT_ID: P, MAESTRI_NODE_ID: "maestro", MAESTRI_TOKEN: "tok-rv" } },
      (err, stdout, stderr) => resolve({ code: err ? ((err as any).code ?? 1) : 0, stdout, stderr }),
    );
  });
}
const ok = async (args: string[]) => {
  const r = await maestri(args);
  assert.equal(r.code, 0, r.stderr);
  return r.stdout;
};
const get = async (url: string) => (await fastify.inject({ method: "GET", url, headers: auth })).json();
const state = (id = P) => get(`/api/projects/${id}/canvas`);
const node = (id: string, type: string, x: number, data: object, extra: object = {}) => ({ id, type, position: { x, y: 0 }, style: { width: 300, height: 200 }, data, ...extra });
const put = (nodes: any[], edges: any[] = []) =>
  fastify.inject({ method: "POST", url: `/api/projects/${P}/canvas`, headers: auth, payload: { nodes, edges } });

before(async () => {
  await fastify.listen({ port: 0, host: "127.0.0.1" });
  port = (fastify.server.address() as any).port;
});
after(async () => {
  await fastify.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const layout = () => [
  node("maestro", "agentTerminal", 0, { title: "Maestro", isMaestro: true }),
  node("w1", "agentTerminal", 400, { title: "W1" }),
  node("w2", "agentTerminal", 800, { title: "W2" }),
  node("stack1", "noteStack", 1200, { title: "Fichário" }),
  node("page1", "stickyNote", 1200, { title: "Página", content: "x", stackId: "stack1" }, { hidden: true }),
  node("band1", "band", 400, { title: "Time", members: ["w1", "w2"] }),
];
const edges = () => [
  { id: "e1", source: "maestro", target: "w1" },
  { id: "e2", source: "stack1", target: "maestro" },
  { id: "e3", source: "band1", target: "maestro" },
];

test("cloneCanvas remapeia páginas de fichário e membros de banda para os ids novos", () => {
  const c = cloneCanvas(layout(), edges());
  const byTitle = (t: string) => c.nodes.find((n: any) => n.data.title === t)!;
  const stack = byTitle("Fichário");
  const page = byTitle("Página");
  assert.equal(page.data.stackId, stack.id);
  assert.notEqual(page.data.stackId, "stack1");
  const band = byTitle("Time");
  assert.deepEqual(band.data.members, [byTitle("W1").id, byTitle("W2").id]);
  // sem o fichário na cópia, a página volta a aparecer (nada de nota escondida para sempre)
  const only = cloneCanvas(layout().filter((n) => n.id !== "stack1"), []);
  const lone = only.nodes.find((n: any) => n.data.title === "Página")!;
  assert.equal(lone.data.stackId, null);
  assert.equal(lone.hidden, false);
  // membros que não foram copiados saem da banda
  const partial = cloneCanvas(layout().filter((n) => n.id !== "w2"), []);
  assert.equal(partial.nodes.find((n: any) => n.data.title === "Time")!.data.members.length, 1);
});

test("floor create --copy-ground e workspace create --from mantêm fichários e bandas coerentes", async () => {
  await put(layout(), edges());
  await ok(["floor", "create", "Copia", "--no-git", "--copy-ground"]);
  const st = await state();
  const onFloor = st.nodes.filter((n: any) => n.data?.floor === "Copia");
  const stack = onFloor.find((n: any) => n.type === "noteStack");
  const page = onFloor.find((n: any) => n.data.title === "Página");
  assert.equal(page.data.stackId, stack.id); // fichário da cópia, não o do térreo
  assert.equal(st.nodes.find((n: any) => n.id === "page1").data.stackId, "stack1");
  const band = onFloor.find((n: any) => n.type === "band");
  const copies = new Set(onFloor.filter((n: any) => n.type === "agentTerminal").map((n: any) => n.id));
  assert.ok(band.data.members.length === 2 && band.data.members.every((m: string) => copies.has(m)));
  await ok(["floor", "delete", "Copia"]);

  const dir = path.join(tmp, "novo-ws");
  fs.mkdirSync(dir);
  await ok(["workspace", "create", "Clone WS", "--dir", dir, "--from", "maestri web (principal)"]);
  const projects = await get("/api/projects");
  const ws = projects.find((p: any) => p.name === "Clone WS");
  const cs = await state(ws.id);
  const cstack = cs.nodes.find((n: any) => n.type === "noteStack");
  const cpage = cs.nodes.find((n: any) => n.data.title === "Página");
  assert.equal(cpage.data.stackId, cstack.id);
  const ids = new Set(cs.nodes.map((n: any) => n.id));
  assert.ok(cs.nodes.find((n: any) => n.type === "band").data.members.every((m: string) => ids.has(m)));
});

test("apagar um fichário solta as páginas (nada de nota escondida sem fichário)", async () => {
  await put(layout(), edges());
  const ws = await import("ws");
  const sock = new ws.default(`ws://127.0.0.1:${port}/ws/project/${P}?token=tok-rv&clientId=t`);
  await new Promise((r) => sock.on("open", r));
  sock.send(JSON.stringify({ type: "op", op: { kind: "removeNodes", ids: ["stack1"] } }));
  const end = Date.now() + 4000;
  let page: any;
  while (Date.now() < end) {
    page = (await state()).nodes.find((n: any) => n.id === "page1");
    if (page && !page.data.stackId) break;
    await new Promise((r) => setTimeout(r, 30));
  }
  sock.close();
  assert.ok(page, "a página continua no canvas");
  assert.ok(!page.data.stackId && page.hidden === false, JSON.stringify(page));
});

test("pre-run: o timeout mata o grupo de processos inteiro (filhos não ficam vivos)", async () => {
  const pidFile = path.join(tmp, "child.pid");
  const t0 = Date.now();
  const r = await runPreRun(`sleep 30 & echo $! > '${pidFile}'; wait`, tmp, {});
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /excedeu/);
  assert.ok(Date.now() - t0 < 5000);
  const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
  await new Promise((res) => setTimeout(res, 200));
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, false, "o filho do pre-run continuou vivo");
  // sucesso, código ≠ 0 e saída demais
  assert.deepEqual(await runPreRun("printf 'a\\nb'", tmp, {}), { ok: true, stdout: "a\nb" });
  const bad = await runPreRun("echo falhou >&2; exit 3", tmp, {});
  assert.equal(bad.ok, false);
  assert.match(bad.reason ?? "", /código 3: falhou/);
  const big = await runPreRun("yes | head -c 500000", tmp, {});
  assert.equal(big.ok, false);
  assert.match(big.reason ?? "", /saída demais/);
});

test("sanitizeTyped tira ESC/controles (inclusive o fim do bracketed paste) e normaliza \\r", () => {
  assert.equal(sanitizeTyped("ok\x1b[201~; rm -rf ~\r"), "ok[201~; rm -rf ~\n");
  assert.equal(sanitizeTyped("a\r\nb\rc\td\x07\x00\x7f\u009b"), "a\nb\nc\td");
  assert.equal(sanitizeTyped("linha1\nlinha2 — acentuação ✓"), "linha1\nlinha2 — acentuação ✓");
});

test("contas de CLI são criadas com permissão 0700", () => {
  const dir = fs.mkdtempSync(path.join(tmp, "acc-"));
  const store = new AccountStore(dir);
  store.create("claude", "Trabalho");
  for (const d of [path.join(dir, "accounts"), path.join(dir, "accounts", "claude"), path.join(dir, "accounts", "claude", "Trabalho")]) {
    assert.equal(fs.statSync(d).mode & 0o777, 0o700, d);
  }
});

test("safeHttpUrl só aceita http/https", () => {
  assert.equal(safeHttpUrl("https://github.com/a/b/pull/1"), "https://github.com/a/b/pull/1");
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "", undefined, "nao é url"]) assert.equal(safeHttpUrl(bad), "");
});

test("apagar um agente pela UI tira-o das bandas (banda com menos de 2 membros se dissolve) e do histórico de sessões", async () => {
  await put(layout(), edges());
  const ws = await import("ws");
  const sock = new ws.default(`ws://127.0.0.1:${port}/ws/project/${P}?token=tok-rv&clientId=t2`);
  await new Promise((r) => sock.on("open", r));
  sock.send(JSON.stringify({ type: "op", op: { kind: "removeNodes", ids: ["w2"] } }));
  const end = Date.now() + 4000;
  let nodes: any[] = [];
  while (Date.now() < end) {
    nodes = (await state()).nodes;
    if (!nodes.some((n: any) => n.id === "band1")) break;
    await new Promise((r) => setTimeout(r, 30));
  }
  sock.close();
  assert.ok(!nodes.some((n: any) => n.id === "band1"), "a banda ficou com 1 membro e deveria ter se dissolvido");
  assert.ok(nodes.some((n: any) => n.id === "w1"), "o outro membro continua no canvas");
});

test("nome de anexo sem controles C0/C1; SessionHistory.dropNodes só grava quando havia entrada", async () => {
  const { AttachmentStore } = await import("../src/attachments.js");
  const { SessionHistory } = await import("../src/sessionHistory.js");
  const store = new AttachmentStore(fs.mkdtempSync(path.join(tmp, "att-")));
  const meta = store.save("p", "a\u009b[2Jb\x1b.txt", Buffer.from("x"));
  assert.doesNotMatch(meta.name, /[\x00-\x1f\x7f-\x9f]/);
  const file = path.join(tmp, "hist.json");
  const h = new SessionHistory(file);
  h.markStarted("p", "a");
  h.markStarted("p", "b");
  h.dropNodes("p", ["a", "inexistente"]);
  assert.equal(h.started("p", "a"), false);
  assert.equal(h.started("p", "b"), true);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, "utf8"))), ["p:b"]);
});
