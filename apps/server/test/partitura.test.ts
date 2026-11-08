import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rmTmp } from "./rmtmp.js";

const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maestri-partitura-test-")));
process.env.REPO_PATH = repo;
process.env.NODE_ENV = "test";
process.env.MAESTRI_TOKEN = "tok-part";

const { fastify } = await import("../src/index.js");
const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/maestri");
const P = "proj-maestri-web";
const auth = { authorization: "Bearer tok-part" };
let port = 0;

function maestri(nodeId: string, args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      [bin, ...args],
      { env: { ...process.env, MAESTRI_API_URL: `http://127.0.0.1:${port}/api`, MAESTRI_PROJECT_ID: P, MAESTRI_NODE_ID: nodeId, MAESTRI_TOKEN: "tok-part" } },
      (err, stdout, stderr) => resolve({ code: err ? ((err as any).code ?? 1) : 0, stdout, stderr }),
    );
  });
}
const M = (...a: string[]) => maestri("maestro", a);
const ok = async (p: Promise<{ code: number; stdout: string; stderr: string }>) => {
  const r = await p;
  assert.equal(r.code, 0, r.stderr || r.stdout);
  return r.stdout;
};
const fail = async (p: Promise<{ code: number; stdout: string; stderr: string }>, re: RegExp) => {
  const r = await p;
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stderr, re);
};
const canvas = async () => (await fastify.inject({ method: "GET", url: `/api/projects/${P}/canvas`, headers: auth })).json();
const titled = async (title: string) => (await canvas()).nodes.filter((n: any) => n.data?.title === title);
const libFile = (slug: string) => path.join(repo, ".maestri", "partituras", `${slug}.partitura.json`);
const readLib = (slug: string) => JSON.parse(fs.readFileSync(libFile(slug), "utf8"));
const node = (id: string, type: string, x: number, y: number, data: object, extra: object = {}) => ({ id, type, position: { x, y }, style: { width: 300, height: 200 }, data, ...extra });
let roleId = "";

before(async () => {
  await fastify.listen({ port: 0, host: "127.0.0.1" });
  port = (fastify.server.address() as any).port;
  await fastify.inject({
    method: "POST", url: `/api/projects/${P}/canvas`, headers: auth,
    payload: {
      nodes: [
        node("maestro", "agentTerminal", 0, 0, { title: "Maestro", isMaestro: true, preset: "shell", baseCmd: "", defaultCmd: "" }),
        node("dev", "agentTerminal", 500, 0, { title: "Dev", preset: "shell", baseCmd: "", defaultCmd: "", role: "DevRole", status: "idle" }),
        node("qa", "agentTerminal", 1000, 0, { title: "QA", preset: "shell", baseCmd: "", defaultCmd: "" }),
        node("duo", "band", 500, 400, { title: "Duo", members: ["dev", "qa"] }),
        node("spec", "stickyNote", 0, 400, { title: "Spec", content: "plano" }),
        node("pilha", "noteStack", 0, 700, { title: "Pilha" }),
        node("pag", "stickyNote", 0, 700, { title: "Pag", content: "pagina", stackId: "pilha" }, { hidden: true }),
        node("site", "portal", 1000, 400, { title: "Site", url: "http://127.0.0.1:1/" }),
      ],
      edges: [
        { id: "e1", source: "duo", target: "maestro" },
        { id: "e2", source: "duo", target: "dev" },
        { id: "e3", source: "duo", target: "qa" },
        { id: "e4", source: "spec", target: "maestro" },
        { id: "e5", source: "pilha", target: "maestro" },
        { id: "e6", source: "site", target: "dev" },
      ],
    },
  });
  const role = (await fastify.inject({ method: "POST", url: `/api/projects/${P}/nodes/maestro/roles/create`, headers: auth, payload: { name: "DevRole", prompt: "Prompt do dev." } })).json().role;
  roleId = role.id;
  const st = await canvas();
  await fastify.inject({
    method: "POST", url: `/api/projects/${P}/canvas`, headers: auth,
    payload: { nodes: st.nodes.map((n: any) => (n.id === "dev" ? { ...n, data: { ...n.data, roleId } } : n)), edges: st.edges },
  });
});
after(async () => {
  await fastify.close();
  rmTmp(repo);
});

test("create salva o time no formato da UI (nodes/edges relativos) com bandas inteiras, notas, fichário, portal e roles embutidos", async () => {
  assert.match(await ok(M("partitura", "create", "Time Base", "--description", "time de teste")), /Partitura "Time Base" salva \(current\): 3 agente\(s\), 1 banda\(s\), 2 nota\(s\), 1 fichário\(s\), 1 portal/);
  const rec = readLib("time-base");
  assert.equal(rec.format, "maestri-partitura");
  assert.equal(rec.version, 1);
  assert.equal(rec.description, "time de teste");
  assert.equal(rec.nodes.length, 8);
  assert.equal(Math.min(...rec.nodes.map((n: any) => n.position.x)), 0);
  assert.equal(Math.min(...rec.nodes.map((n: any) => n.position.y)), 0);
  const ids = new Set(rec.nodes.map((n: any) => n.id));
  assert.ok(rec.edges.every((e: any) => ids.has(e.source) && ids.has(e.target)));
  assert.equal(rec.edges.length, 6);
  assert.deepEqual(rec.nodes.find((n: any) => n.type === "band").data.members, ["dev", "qa"]);
  assert.equal(rec.nodes.find((n: any) => n.id === "pag").hidden, true);
  assert.equal(rec.nodes.find((n: any) => n.id === "pag").data.stackId, "pilha");
  assert.equal(rec.roles[roleId].prompt, "Prompt do dev.");
  assert.ok(!rec.nodes.some((n: any) => n.data?.worktreePath || n.data?.floor || n.data?.chatBusy));
  assert.deepEqual(rec.options, { commands: true, noteText: true, chatHistory: false });
  await fail(M("partitura", "create", "time base"), /nunca sobrescreve/);
  await fail(M("partitura", "create"), /Uso: maestri partitura/);
});

test("list mostra nome, escopo, contagens e descrição; só o Maestro usa", async () => {
  const out = await ok(M("partitura", "list"));
  assert.match(out, /- Time Base \(current\) — 3 agente\(s\), 1 banda\(s\), 2 nota\(s\), 1 fichário\(s\), 1 portal\(is\) — time de teste/);
  await fail(maestri("dev", ["partitura", "list"]), /Apenas o Maestro/);
});

test("insert coloca ao lado, com ids/nomes novos, bandas e fichário remapeados, liga só ao Maestro dela e inicia os terminais", async () => {
  const before = await canvas();
  const out = await ok(M("partitura", "insert", "Time Base"));
  assert.match(out, /Partitura "Time Base" colocada no andar "Ground": 3 agente\(s\)/);
  assert.match(out, /Maestros dela \(ligados a você\): "Maestro \(2\)"/);
  assert.match(out, /Para dar ask: "Maestro \(2\)"/);
  assert.match(out, /Mais 2 agente\(s\) rodam sob os Maestros dela/);
  const st = await canvas();
  assert.equal(st.nodes.length, before.nodes.length + 8);
  const [m2] = await titled("Maestro (2)");
  const [dev2] = await titled("Dev (2)");
  const [qa2] = await titled("QA (2)");
  const [duo2] = await titled("Duo (2)");
  const [pilha2] = await titled("Pilha (2)");
  const [pag] = (await titled("Pag")).filter((n: any) => n.id !== "pag");
  assert.ok(m2 && dev2 && qa2 && duo2 && pilha2 && pag);
  assert.deepEqual(duo2.data.members, [dev2.id, qa2.id]);
  assert.equal(pag.data.stackId, pilha2.id);
  assert.equal(pag.hidden, true);
  assert.ok(st.edges.some((e: any) => e.source === "maestro" && e.target === m2.id), "você ligado ao Maestro dela");
  assert.ok(!st.edges.some((e: any) => (e.source === "maestro" || e.target === "maestro") && [dev2.id, qa2.id, duo2.id].some((i) => e.source === i || e.target === i)), "e a mais ninguém");
  assert.ok(st.edges.some((e: any) => e.source === duo2.id && e.target === dev2.id), "cordas da banda remapeadas");
  // posição livre: nada sobreposto ao que já existia
  const old = before.nodes.map((n: any) => `${n.position.x},${n.position.y}`);
  assert.ok(![m2, dev2, qa2, duo2].some((n: any) => old.includes(`${n.position.x},${n.position.y}`)));
  // role mantido, comando limpo e sessões vivas
  assert.equal(dev2.data.roleId, roleId);
  assert.equal(dev2.data.roleDir, true);
  assert.ok(!("floor" in dev2.data));
  const sessions = (await fastify.inject({ method: "GET", url: `/api/projects/${P}/sessions`, headers: auth })).json();
  for (const n of [m2, dev2, qa2]) assert.ok(sessions.some((s: any) => s.nodeId === n.id), `sessão de ${n.data.title}`);
  await fail(M("partitura", "insert", "Nao Existe"), /Partitura "Nao Existe" não encontrada/);
});

test("insert sem Maestro na partitura liga você a cada agente e banda; role que sumiu é recriado do arquivo", async () => {
  assert.match(await ok(M("partitura", "create", "Sem Chefe", "Dev", "--without-me")), /salva \(current\): 2 agente\(s\), 1 banda\(s\), 1 portal/);
  await ok(M("role", "delete", "DevRole", "--force"));
  assert.match(await ok(M("role", "list")), /^(?![\s\S]*DevRole)/, "role apagado");
  const out = await ok(M("partitura", "insert", "Sem Chefe"));
  assert.doesNotMatch(out, /Maestros dela/);
  const st = await canvas();
  const bands = st.nodes.filter((n: any) => n.type === "band" && n.data.title.startsWith("Duo"));
  const newBand = bands.at(-1);
  assert.ok(st.edges.some((e: any) => (e.source === "maestro" && e.target === newBand.id) || (e.target === "maestro" && e.source === newBand.id)), "ligado à banda");
  assert.match(await ok(M("role", "list")), /DevRole: Prompt do dev\./);
  const restored = st.nodes.filter((n: any) => n.data?.title?.startsWith("Dev") && n.data.roleId);
  assert.ok(restored.length >= 1);
});

test("insert --floor e floor create --partitura põem o time no andar pedido", async () => {
  await ok(M("floor", "create", "Alto", "--no-git"));
  const out = await ok(M("partitura", "insert", "Sem Chefe", "--floor", "Alto"));
  assert.match(out, /no andar "Alto"/);
  let st = await canvas();
  const inAlto = st.nodes.filter((n: any) => n.data?.floor === "Alto" && n.type === "agentTerminal");
  assert.equal(inAlto.length, 2);
  assert.ok(st.nodes.some((n: any) => n.type === "band" && n.data.floor === "Alto"));

  assert.match(await ok(M("floor", "create", "Beta", "--no-git", "--partitura", "Sem Chefe")), /Andar "Beta" criado.*\nPartitura "Sem Chefe" colocada no andar "Beta": 2 agente\(s\)/);
  st = await canvas();
  assert.equal(st.nodes.filter((n: any) => n.data?.floor === "Beta" && n.type === "agentTerminal").length, 2);
  // partitura inexistente: falha antes de criar o andar
  await fail(M("floor", "create", "Gama", "--no-git", "--partitura", "Nada"), /Partitura "Nada" não encontrada/);
  assert.ok(!(await ok(M("floor", "list"))).includes("Gama"));
  await fail(M("partitura", "insert", "Sem Chefe", "--floor", "Nao Existe"), /Andar "Nao Existe" não encontrado/);
});

test("create com chaves off: sem comandos e sem texto de nota; chat só com --chat-history on", async () => {
  await ok(M("partitura", "create", "Magra", "Dev", "--without-me", "--commands", "off", "--note-text", "off"));
  const rec = readLib("magra");
  assert.deepEqual(rec.options, { commands: false, noteText: false, chatHistory: false });
  assert.ok(rec.nodes.filter((n: any) => n.type === "agentTerminal").every((n: any) => !("baseCmd" in n.data) && !("defaultCmd" in n.data)));
  await fail(M("partitura", "create", "Torta", "Dev", "--commands", "talvez"), /--commands deve ser on ou off/);
  await fastify.inject({ method: "POST", url: `/api/projects/${P}/canvas`, headers: auth, payload: { nodes: (await canvas()).nodes.map((n: any) => (n.id === "qa" ? { ...n, data: { ...n.data, chat: [{ role: "user", text: "oi" }] } } : n)), edges: (await canvas()).edges } });
  await ok(M("partitura", "create", "Com Chat", "QA", "--without-me", "--chat-history", "on"));
  assert.deepEqual(readLib("com-chat").nodes.find((n: any) => n.id === "qa").data.chat, [{ role: "user", text: "oi" }]);
  assert.ok(!("chat" in readLib("time-base").nodes.find((n: any) => n.id === "qa").data), "padrão: sem histórico de chat");
});

test("update: detalhes, escopo, chave off sem recapturar, e recaptura com agentes", async () => {
  assert.match(await ok(M("partitura", "update", "Magra", "--name", "Dupla", "--description", "só o par", "--icon", "bug", "--color", "rose")), /Partitura "Dupla" atualizada \(current\): 2 agente/);
  assert.ok(!fs.existsSync(libFile("magra")));
  const rec = readLib("dupla");
  assert.deepEqual([rec.name, rec.description, rec.icon, rec.color], ["Dupla", "só o par", "bug", "rose"]);
  assert.equal(rec.id, readLib("dupla").id);
  await ok(M("partitura", "update", "Dupla", "--icon", "default"));
  assert.ok(!("icon" in readLib("dupla")));
  await fail(M("partitura", "update", "Dupla", "--name", "Time Base"), /Já existe uma partitura "Time Base"/);

  // chave off sem agentes: só apaga a parte salva
  await ok(M("partitura", "update", "Time Base", "--note-text", "off"));
  const tb = readLib("time-base");
  assert.equal(tb.nodes.length, 8);
  assert.ok(tb.nodes.filter((n: any) => n.type === "stickyNote").every((n: any) => n.data.content === ""));
  assert.equal(tb.options.noteText, false);

  // com agentes: salva o time de novo (aqui você + Dev + a banda inteira)
  assert.match(await ok(M("partitura", "update", "Dupla", "Dev")), /atualizada \(current\): 3 agente\(s\), 1 banda\(s\)/);

  // escopo global: o arquivo muda de pasta
  await ok(M("partitura", "update", "Dupla", "--scope", "global"));
  assert.ok(!fs.existsSync(libFile("dupla")));
  assert.match(await ok(M("partitura", "list")), /- Dupla \(global\)/);
  await fail(M("partitura", "update", "Dupla", "--scope", "mundial"), /--scope deve ser current ou global/);
});

test("delete apaga da biblioteca sem desfazer o que já foi colocado", async () => {
  const nodesBefore = (await canvas()).nodes.length;
  assert.match(await ok(M("partitura", "delete", "Time Base")), /Partitura "Time Base" apagada/);
  assert.ok(!fs.existsSync(libFile("time-base")));
  assert.equal((await canvas()).nodes.length, nodesBefore);
  await fail(M("partitura", "delete", "Time Base"), /não encontrada/);
  assert.doesNotMatch(await ok(M("partitura", "list")), /Time Base/);
  await ok(M("partitura", "delete", "Dupla")); // global
  assert.match((await M("partitura", "--help")).stdout, /partitura insert "Nome"/);
});
