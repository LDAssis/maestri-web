import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rmTmp } from "./rmtmp.js";

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "maestri-kinds-test-"));
process.env.REPO_PATH = repo;
process.env.NODE_ENV = "test";
process.env.MAESTRI_TOKEN = "tok-kinds";

const { fastify } = await import("../src/index.js");
const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/maestri");
const P = "proj-maestri-web";
const auth = { authorization: "Bearer tok-kinds" };
let port = 0;

function maestri(nodeId: string, args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      [bin, ...args],
      { env: { ...process.env, MAESTRI_API_URL: `http://127.0.0.1:${port}/api`, MAESTRI_PROJECT_ID: P, MAESTRI_NODE_ID: nodeId, MAESTRI_TOKEN: "tok-kinds" } },
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

const canvas = async () => (await fastify.inject({ method: "GET", url: `/api/projects/${P}/canvas`, headers: auth })).json();
const byId = async (id: string) => (await canvas()).nodes.find((n: any) => n.id === id);
const node = (id: string, type: string, x: number, data: object) => ({ id, type, position: { x, y: 0 }, style: { width: 300, height: 200 }, data });

before(async () => {
  await fastify.listen({ port: 0, host: "127.0.0.1" });
  port = (fastify.server.address() as any).port;
  // "Gêmeo" é agente E nota; "Setlist" também; "Soundcheck" é só agente
  const res = await fastify.inject({
    method: "POST", url: `/api/projects/${P}/canvas`, headers: auth,
    payload: {
      nodes: [
        node("maestro", "agentTerminal", 0, { title: "Maestro", isMaestro: true }),
        node("gemeo-a", "agentTerminal", 400, { title: "Gêmeo" }),
        node("gemeo-n", "stickyNote", 800, { title: "Gêmeo", content: "x" }),
        node("sound", "agentTerminal", 1200, { title: "Soundcheck" }),
        node("set-a", "agentTerminal", 1600, { title: "Setlist" }),
        node("set-n", "stickyNote", 2000, { title: "Setlist", content: "y" }),
      ],
      edges: [
        { id: "e1", source: "maestro", target: "gemeo-a" },
        { id: "e2", source: "gemeo-n", target: "maestro" },
        { id: "e3", source: "maestro", target: "sound" },
        { id: "e4", source: "maestro", target: "set-a" },
        { id: "e5", source: "set-n", target: "maestro" },
      ],
    },
  });
  assert.equal(res.statusCode, 200);
});
after(async () => {
  await fastify.close();
  rmTmp(repo);
});

test("arrange: nome repetido entre tipos exige --agent/--note; a mensagem cita as flags", async () => {
  await fail(["arrange", "Gêmeo", "--color", "red"], /ambíguo.*--agent, --note, --band ou --fichario/);
  await ok(["arrange", "Gêmeo", "--note", "--color", "green"]);
  assert.equal((await byId("gemeo-n")).data.color, "emerald");
  assert.equal((await byId("gemeo-a")).data.color, undefined);
  await ok(["arrange", "Gêmeo", "--icon", "gearshape", "--agent"]);
  assert.equal((await byId("gemeo-a")).data.icon, "wrench");
  await fail(["arrange", "Gêmeo", "--note", "--agent", "--color", "red"], /só um de/);
  await fail(["arrange", "Gêmeo", "--portal", "--color", "red"], /não aceita --portal/);
  await fail(["arrange", "Gêmeo", "--band", "--color", "red"], /não encontrado/);
});

test("arrange: nomes de cor e ícone do app nativo viram o do Web e a resposta diz qual", async () => {
  const out = await ok(["arrange", "Soundcheck", "--color", "blue", "--icon", "server.rack"]);
  assert.match(out, /cor "blue" \(nativa\) virou "sky"/);
  assert.match(out, /ícone "server.rack" \(nativo\) virou "database"/);
  const s = await byId("sound");
  assert.deepEqual([s.data.color, s.data.icon], ["sky", "database"]);
  // nota: charcoal/midnight/white
  for (const [from, to] of [["charcoal", "slate"], ["midnight", "indigo"], ["white", "slate"], ["purple", "violet"]]) {
    await ok(["arrange", "Setlist", "--note", "--color", from]);
    assert.equal((await byId("set-n")).data.color, to, from);
  }
  // hex vira a cor do Web mais próxima; emoji vira o ícone padrão
  const hex = await ok(["arrange", "Soundcheck", "--color", "#3A7BD5", "--icon", "🚀"]);
  assert.match(hex, /cor #3A7BD5 virou "indigo"/);
  assert.match(hex, /emoji 🚀 .* "sparkles"/);
  assert.deepEqual([(await byId("sound")).data.color, (await byId("sound")).data.icon], ["indigo", "sparkles"]);
  // "default" volta ao padrão; nomes do Web seguem valendo sem aviso
  await ok(["arrange", "Soundcheck", "--color", "default", "--icon", "default"]);
  assert.deepEqual([(await byId("sound")).data.color, (await byId("sound")).data.icon], [null, null]);
  assert.doesNotMatch(await ok(["arrange", "Soundcheck", "--color", "rose", "--icon", "bug"]), /virou/);
});

test("arrange: valor inválido lista as duas formas (Web e nativa)", async () => {
  await fail(["arrange", "Soundcheck", "--color", "magenta"], /Cor inválida\. Web: amber.*Nativo \(convertido\): blue.*hex/);
  await fail(["arrange", "Soundcheck", "--icon", "naoexiste"], /Ícone inválido\. Web: terminal.*Nativo \(convertido\): sparkle.*emoji/);
});

test("connect: nome repetido entre tipos exige a flag logo depois do nome", async () => {
  await fail(["connect", "Soundcheck", "Setlist"], /ambíguo.*--agent, --note, --band, --fichario ou --portal/);
  assert.match(await ok(["connect", "Soundcheck", "Setlist", "--note"]), /conectados/);
  let edges = (await canvas()).edges;
  assert.ok(edges.some((e: any) => [e.source, e.target].sort().join() === ["sound", "set-n"].sort().join()));
  assert.ok(!edges.some((e: any) => [e.source, e.target].sort().join() === ["sound", "set-a"].sort().join()));
  // a flag vale para o nome que vem antes dela, em qualquer posição
  assert.match(await ok(["connect", "Setlist", "--agent", "Soundcheck"]), /conectados/);
  edges = (await canvas()).edges;
  assert.ok(edges.some((e: any) => [e.source, e.target].sort().join() === ["sound", "set-a"].sort().join()));
  assert.match(await ok(["connect", "Soundcheck", "Setlist", "--note"]), /já estão conectados/);
  await fail(["connect", "Soundcheck", "Setlist", "--band"], /não encontrado \(tipo band\)/);
});
