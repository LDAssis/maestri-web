// Rodar: npx tsx apps/web/src/lib/partitura.check.ts
import assert from "node:assert/strict";
import {
  instantiatePartitura,
  parsePartitura,
  partituraBounds,
  partituraFileName,
  PARTITURA_NODE_TYPES,
  serializePartitura,
} from "./partitura";

const nodes = [
  {
    id: "a", type: "agentTerminal", position: { x: 100, y: 50 }, selected: true, dragging: true, measured: { width: 1, height: 1 },
    style: { width: 460, height: 330 },
    data: { title: "A", status: "running", chat: [{ id: "1" }], chatBusy: true, worktree: "w", branch: "agent/w", worktreePath: "/x", isMaestro: true },
  },
  { id: "b", type: "stickyNote", position: { x: 600, y: 250 }, data: { title: "B", content: "oi", color: "rose", status: "x" } },
  { id: "c", type: "portal", position: { x: 0, y: 0 }, data: { title: "C", url: "" } },
];
const edges = [
  { id: "e1", source: "a", target: "b", animated: true },
  { id: "e2", source: "b", target: "c" },
];

// serialize: seleção {a,b}; aresta para c descartada; posições relativas; efêmeros limpos
const p = serializePartitura("Meu Time", nodes.slice(0, 2), edges, new Date("2026-01-01T00:00:00Z"));
assert.equal(p.format, "maestri-partitura");
assert.equal(p.edges.length, 1);
assert.deepEqual(p.nodes.map((n) => n.position), [{ x: 0, y: 0 }, { x: 500, y: 200 }]);
const a = p.nodes[0];
assert.equal(a.data.status, "idle");
for (const k of ["chat", "chatBusy", "worktree", "branch", "worktreePath"]) assert.ok(!(k in a.data), k);
assert.equal(a.data.isMaestro, true);
for (const k of ["selected", "dragging", "measured"]) assert.ok(!(k in a));
assert.ok(!("status" in p.nodes[1].data), "status só em agentes");
assert.equal(nodes[0].data.status, "running", "entrada não é mutada");

// roundtrip
const r = parsePartitura(JSON.stringify(p));
assert.ok(r.ok);
assert.deepEqual(r.ok && r.partitura, p);

// remap de ids: novos, sem colisão, arestas coerentes, origem aplicada, selecionados
const inst = instantiatePartitura(r.ok ? r.partitura : (null as never), { x: 1000, y: 500 }, ["a", "b"]);
assert.equal(inst.nodes.length, 2);
assert.ok(inst.nodes.every((n) => !["a", "b"].includes(n.id) && n.selected));
assert.equal(new Set(inst.nodes.map((n) => n.id)).size, 2);
assert.deepEqual(inst.nodes[1].position, { x: 1500, y: 700 });
assert.equal(inst.edges[0].source, inst.idMap.get("a"));
assert.equal(inst.edges[0].target, inst.idMap.get("b"));
let n = 0;
const forced = instantiatePartitura(p, { x: 0, y: 0 }, ["n0"], () => `n${n++ < 3 ? 0 : n}`);
assert.ok(forced.nodes.every((x) => x.id !== "n0"), "ids colidindo são regenerados");
assert.deepEqual(partituraBounds(p), { width: 800, height: 400 });
assert.equal(partituraFileName("Meu Time!"), "meu-time.partitura.json");

// seleção vazia -> partitura vazia válida
assert.ok(parsePartitura(JSON.stringify(serializePartitura("x", [], []))).ok);

// inválidos
const bad = (v: unknown, re: RegExp) => {
  const res = parsePartitura(typeof v === "string" ? v : JSON.stringify(v));
  assert.ok(!res.ok && re.test(res.error), `esperava /${re}/, veio ${JSON.stringify(res)}`);
};
const good = { format: "maestri-partitura", version: 1, name: "x", nodes: [], edges: [] };
bad("{nope", /JSON/);
bad([], /format/);
bad({ ...good, format: "outro" }, /format/);
bad({ ...good, version: 2 }, /Versão/);
bad({ ...good, nodes: {} }, /listas/);
bad({ ...good, nodes: [{ id: "a", type: "hacker", position: { x: 0, y: 0 }, data: {} }] }, /tipo desconhecido/);
bad({ ...good, nodes: [{ id: "a", type: "portal", position: { x: "0", y: 0 }, data: {} }] }, /position/);
bad({ ...good, nodes: [{ id: "a", type: "portal", position: { x: 0, y: 0 } }] }, /data/);
bad({ ...good, nodes: [{ type: "portal", position: { x: 0, y: 0 }, data: {} }] }, /id ausente/);
const dup = { id: "a", type: "portal", position: { x: 0, y: 0 }, data: {} };
bad({ ...good, nodes: [dup, dup] }, /duplicado/);
bad({ ...good, nodes: [dup], edges: [{ source: "a", target: "zzz" }] }, /inexistente/);
bad({ ...good, nodes: [dup], edges: [{ source: "a" }] }, /source\/target/);
bad("x".repeat(2 * 1024 * 1024 + 1), /2 MB/);

// importar também limpa efêmeros de arquivos editados à mão
const dirty = parsePartitura(JSON.stringify({ ...good, nodes: [{ ...dup, type: "agentTerminal", data: { chat: [1], status: "running", branch: "b" } }] }));
assert.ok(dirty.ok && dirty.partitura.nodes[0].data.status === "idle" && !("chat" in dirty.partitura.nodes[0].data) && !("branch" in dirty.partitura.nodes[0].data));

// lista de tipos extensível
assert.deepEqual(PARTITURA_NODE_TYPES, ["agentTerminal", "stickyNote", "portal", "fileTree", "diff"]);
PARTITURA_NODE_TYPES.push("outro");
assert.ok(parsePartitura(JSON.stringify({ ...good, nodes: [{ ...dup, type: "outro" }] })).ok);
PARTITURA_NODE_TYPES.pop();

// fileTree/diff: andares são locais -> limpos na exportação e na importação
const ft = { id: "t", type: "fileTree", position: { x: 5, y: 5 }, data: { title: "Arquivos", root: "meu-andar" } };
const df = { id: "d", type: "diff", position: { x: 9, y: 9 }, data: { title: "Diff", worktree: "meu-andar", status: "x" } };
const pf = serializePartitura("x", [ft, df], []);
assert.equal(pf.nodes[0].data.root, "main");
assert.ok(!("worktree" in pf.nodes[1].data) && pf.nodes[1].data.title === "Diff");
const back = parsePartitura(JSON.stringify({ ...good, nodes: [ft, df] }));
assert.ok(back.ok && back.partitura.nodes[0].data.root === "main" && !("worktree" in back.partitura.nodes[1].data));
assert.equal(ft.data.root, "meu-andar", "entrada não é mutada");

console.log("partitura.check: OK");
