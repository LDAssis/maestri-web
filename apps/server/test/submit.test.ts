import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { submitDelayMs, submitPauseMs, submitVerifyMs } from "../src/nodeApi.js";
import { rmTmp } from "./rmtmp.js";

const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maestri-submit-test-")));
process.env.REPO_PATH = repo;
process.env.NODE_ENV = "test";
process.env.MAESTRI_TOKEN = "tok-submit";
process.env.MAESTRI_ASK_QUIET_MS = "500";
process.env.MAESTRI_SUBMIT_DELAY_MS = "300";
process.env.MAESTRI_SUBMIT_VERIFY_MS = "700";
process.env.MAESTRI_ROUTINE_BUSY_MS = "150"; // a rotina pula se o terminal imprimiu há pouco

// TUI falso que imita o Claude Code: entrada que chega JUNTA com o \r é colagem (o \r vira quebra de linha no input);
// só um \r sozinho, em outro write, envia. Imprime SUBMIT[<texto>] gap=<ms entre o texto e o Enter> e, como o Claude Code, o
// indicador "esc to interrupt" por 400 ms (sinal de envio). Todo \r sozinho imprime ENTER. Texto que começa com DROP1: tem o 1º \r
// engolido (a caixa é redesenhada com o texto ainda lá: o Enter se perdeu).
const fakeTui = path.join(repo, "fake-tui.mjs");
fs.writeFileSync(
  fakeTui,
  `let buf = "";
let lastText = 0;
let drop = false;
process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
console.log("READY");
process.stdin.on("data", (d) => {
  const pasted = d.includes("\\x1b[200~");
  const t = d.replace(/\\x1b\\[20[01]~/g, "");
  if (!pasted && t === "\\r") {
    console.log("ENTER");
    if (drop) {
      drop = false;
      console.log("PENDING" + JSON.stringify(buf)); // a caixa de entrada é redesenhada com o texto ainda lá
      return;
    }
    console.log("SUBMIT" + JSON.stringify(buf) + " gap=" + (Date.now() - lastText));
    console.log("esc to interrupt");
    setTimeout(() => console.log("DONE"), 400);
    buf = "";
    return;
  }
  buf += t.replace(/\\r/g, "\\n");
  lastText = Date.now();
  if (buf.startsWith("DROP1:")) drop = true;
  console.log("PENDING" + JSON.stringify(buf));
});
`,
);

const { fastify } = await import("../src/index.js");
const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/maestri");
const P = "proj-maestri-web";
const auth = { authorization: "Bearer tok-submit" };
let port = 0;
let term: WebSocket;
let out = "";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 12000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) assert.fail(`timeout: ${what}\n--- saída:\n${out.slice(-800)}`);
    await sleep(40);
  }
}
const maestri = (args: string[]) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      [bin, ...args],
      { env: { ...process.env, MAESTRI_API_URL: `http://127.0.0.1:${port}/api`, MAESTRI_PROJECT_ID: P, MAESTRI_NODE_ID: "maestro", MAESTRI_TOKEN: "tok-submit" } },
      (err, stdout, stderr) => resolve({ code: err ? ((err as any).code ?? 1) : 0, stdout, stderr }),
    );
  });
const ok = async (args: string[]) => {
  const r = await maestri(args);
  assert.equal(r.code, 0, r.stderr || r.stdout);
  return r.stdout;
};
// SUBMIT["..."] gap=N  (o texto sem o que veio do cabeçalho do chat)
const submits = () => [...out.matchAll(/SUBMIT(".*?") gap=(\d+)/g)].map((m) => ({ text: JSON.parse(m[1]) as string, gap: Number(m[2]) }));
const lastSubmit = () => submits().at(-1)!;
const enters = () => (out.match(/ENTER/g) ?? []).length;
const pendingOnly = () => out.lastIndexOf("PENDING") > out.lastIndexOf("SUBMIT");

before(async () => {
  await fastify.listen({ port: 0, host: "127.0.0.1" });
  port = (fastify.server.address() as any).port;
  await fastify.inject({
    method: "POST", url: `/api/projects/${P}/canvas`, headers: auth,
    payload: {
      nodes: [
        { id: "maestro", type: "agentTerminal", position: { x: 0, y: 0 }, style: { width: 460, height: 330 }, data: { title: "Maestro", isMaestro: true } },
        { id: "tui", type: "agentTerminal", position: { x: 600, y: 0 }, style: { width: 460, height: 330 }, data: { title: "Tui", baseCmd: `node '${fakeTui}'`, defaultCmd: `node '${fakeTui}'` } },
      ],
      edges: [{ id: "e1", source: "maestro", target: "tui" }],
    },
  });
  term = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal?project=${P}&node=tui&token=tok-submit&cmd=${encodeURIComponent(`node '${fakeTui}'`)}`);
  term.on("message", (m) => (out += m.toString()));
  await new Promise((r) => term.on("open", r));
  await until(() => out.includes("READY"), "TUI falso pronto");
});
after(async () => {
  term.close();
  await fastify.close();
  rmTmp(repo);
});

test("submitDelayMs: configurável, padrão 250, valor inválido volta ao padrão", () => {
  assert.equal(submitDelayMs(), 300);
  const saved = process.env.MAESTRI_SUBMIT_DELAY_MS;
  try {
    process.env.MAESTRI_SUBMIT_DELAY_MS = "0";
    assert.equal(submitDelayMs(), 0);
    for (const bad of ["", "abc", "-5"]) {
      process.env.MAESTRI_SUBMIT_DELAY_MS = bad;
      assert.equal(submitDelayMs(), 250, bad);
    }
    delete process.env.MAESTRI_SUBMIT_DELAY_MS;
    assert.equal(submitDelayMs(), 250);
  } finally {
    process.env.MAESTRI_SUBMIT_DELAY_MS = saved;
  }
});

test("ask submete 1 linha e várias; o Enter vem separado, depois da pausa", async () => {
  const n = submits().length;
  await ok(["ask", "Tui", "uma linha só"]);
  assert.equal(submits().length, n + 1, "submeteu");
  assert.equal(lastSubmit().text, "uma linha só");
  assert.ok(lastSubmit().gap >= 250, `Enter ${lastSubmit().gap} ms depois do texto`);
  await ok(["ask", "Tui", "primeira\nsegunda\nterceira"]);
  assert.equal(lastSubmit().text, "primeira\nsegunda\nterceira");
  assert.ok(!pendingOnly(), "nada ficou pendente no input");
});

test("send submete 1 linha e várias", async () => {
  const n = submits().length;
  await ok(["send", "Tui", "enviado direto"]);
  await until(() => submits().length === n + 1, "send submetido");
  assert.equal(lastSubmit().text, "enviado direto");
  await ok(["send", "Tui", "a\nb"]);
  await until(() => submits().length === n + 2, "send multi-linha submetido");
  assert.equal(lastSubmit().text, "a\nb");
});

test("o texto não carrega ESC/controles (não fecha a colagem nem injeta teclas)", async () => {
  const n = submits().length;
  await ok(["ask", "Tui", "x\x1b[201~y\x07z\nw"]);
  assert.equal(submits().length, n + 1);
  assert.equal(lastSubmit().text, "x[201~yz\nw");
});

test("chat submete (com o cabeçalho do Maestri Chat, várias linhas em colagem)", async () => {
  const n = submits().length;
  const r = await fastify.inject({
    method: "POST", url: `/api/projects/${P}/nodes/tui/chat`, headers: auth,
    payload: { text: "mensagem do chat", author: { id: "u1", name: "Bruno", color: "#3b82f6" } },
  });
  assert.equal(r.statusCode, 202);
  await until(() => submits().length === n + 1, "chat submetido");
  assert.match(lastSubmit().text, /through Maestri Chat[\s\S]*mensagem do chat$/);
  await until(async () => (await fastify.inject({ method: "GET", url: `/api/projects/${P}/canvas`, headers: auth })).json().nodes.find((x: any) => x.id === "tui").data.chatBusy === false, "captura do chat termina");
  const n2 = submits().length;
  await fastify.inject({ method: "POST", url: `/api/projects/${P}/nodes/tui/chat`, headers: auth, payload: { text: "l1\nl2", author: { id: "u1", name: "Bruno", color: "#3b82f6" } } });
  await until(() => submits().length === n2 + 1, "chat multi-linha submetido");
  assert.match(lastSubmit().text, /l1\nl2$/);
  // a rotina do próximo teste pula agente com chat em andamento
  await until(async () => (await fastify.inject({ method: "GET", url: `/api/projects/${P}/canvas`, headers: auth })).json().nodes.find((x: any) => x.id === "tui").data.chatBusy === false, "captura do 2º chat termina");
});

test("rotina submete o comando de 1 linha e de várias", async () => {
  await ok(["routine", "create", "Uma", "--command", "tarefa de uma linha", "--terminal", "Tui", "--every", "1h"]);
  const n = submits().length;
  await ok(["routine", "run", "Uma"]);
  await until(() => submits().length === n + 1, "rotina de 1 linha submetida");
  assert.equal(lastSubmit().text, "tarefa de uma linha");
  await ok(["routine", "create", "Varias", "--command", "passo 1\\npasso 2", "--terminal", "Tui", "--every", "1h"]);
  await ok(["routine", "run", "Varias"]);
  await until(() => submits().length === n + 2, "rotina multi-linha submetida");
  assert.equal(lastSubmit().text, "passo 1\npasso 2");
});

test("--raw continua cru: texto + \\r no mesmo write NÃO submete (é a colagem do TUI); o \\r sozinho submete", async () => {
  const n = submits().length;
  await ok(["ask", "Tui", "--raw", "cru\\r", "--timeout", "3"]);
  assert.equal(submits().length, n, "\\r colado ao texto virou quebra de linha, como no bug");
  assert.ok(pendingOnly());
  await ok(["ask", "Tui", "--raw", "\\r", "--timeout", "3"]);
  assert.equal(submits().length, n + 1);
  assert.equal(lastSubmit().text, "cru\n");
});

test("pausa adaptativa: base + 1 ms a cada 10 caracteres, teto de 2 s (base maior que o teto vale)", () => {
  assert.equal(submitPauseMs(0), 300);
  assert.equal(submitPauseMs(1000), 400);
  assert.equal(submitPauseMs(30_000), 2000);
  assert.equal(submitPauseMs(100_000), 2000);
  const saved = process.env.MAESTRI_SUBMIT_DELAY_MS;
  try {
    process.env.MAESTRI_SUBMIT_DELAY_MS = "2500";
    assert.equal(submitPauseMs(50_000), 2500);
    process.env.MAESTRI_SUBMIT_DELAY_MS = "0";
    assert.equal(submitPauseMs(500), 50);
  } finally {
    process.env.MAESTRI_SUBMIT_DELAY_MS = saved;
  }
  assert.equal(submitVerifyMs(), 700);
});

test("o Enter espera mais com texto grande (pausa adaptativa)", async () => {
  const n = submits().length;
  await ok(["send", "Tui", "x".repeat(8000)]);
  await until(() => submits().length === n + 1, "texto grande submetido");
  assert.ok(lastSubmit().gap >= 1000, `Enter ${lastSubmit().gap} ms depois do texto (esperado >= 300 + 800)`);
});

test("envio normal: um Enter só, sem reenvio", async () => {
  const n = submits().length;
  const e = enters();
  await ok(["send", "Tui", "envio normal"]);
  await until(() => submits().length === n + 1, "submetido");
  await sleep(1200); // mais que a janela de verificação
  assert.equal(enters(), e + 1, "nenhum Enter extra");
  assert.equal(submits().length, n + 1);
});

test("Enter engolido: o texto fica parado na caixa, então o servidor manda outro Enter", async () => {
  const n = submits().length;
  const e = enters();
  await ok(["send", "Tui", "DROP1: perdeu o enter"]);
  await until(() => submits().length === n + 1, "reenvio submeteu");
  assert.equal(lastSubmit().text, "DROP1: perdeu o enter");
  assert.equal(enters(), e + 2, "1 Enter perdido + 1 reenvio");
  await sleep(1200);
  assert.equal(enters(), e + 2, "parou depois de submeter");
  assert.ok(!pendingOnly());
});

test("Enter engolido em texto de várias linhas (colagem) também é reenviado", async () => {
  const n = submits().length;
  // a última linha é longa e sem quebra: o fake imprime o buffer em JSON (\n escapado), e o fim do texto é o que se compara
  await ok(["send", "Tui", "DROP1: a\nb\nfim da colagem sem quebra"]);
  await until(() => submits().length === n + 1, "reenvio submeteu o multi-linha");
  assert.equal(lastSubmit().text, "DROP1: a\nb\nfim da colagem sem quebra");
});
