// Rodar: npx tsx apps/web/src/lib/noteStack.check.ts
import assert from "node:assert/strict";
import { hitStack, stackOps, uniqueStackTitle, unstackOps } from "./noteStack";

const stack = { id: "s", type: "noteStack", position: { x: 0, y: 0 }, style: { width: 300, height: 220 }, data: { title: "Fichário" } };
const note = (x: number, y: number, floor?: string) => ({ id: "n", type: "stickyNote", position: { x, y }, style: { width: 100, height: 100 }, data: floor ? { floor } : {} });
const floorOf = (n: any) => n.data?.floor || "Ground";

assert.equal(hitStack(note(100, 60), [stack], floorOf)?.id, "s");
assert.equal(hitStack(note(400, 400), [stack], floorOf), null);
assert.equal(hitStack(note(100, 60, "Alto"), [stack], floorOf), null);

const edges = [{ id: "a", source: "n", target: "me" }, { id: "b", source: "k", target: "n" }, { id: "c", source: "s", target: "me" }];
const st = stackOps("n", "s", edges);
assert.deepEqual(st.data, { stackId: "s" });
assert.deepEqual(st.removeEdgeIds, ["a", "b"]);
assert.deepEqual(st.addEdges.map((e) => [e.source, e.target]), [["s", "k"]]);
assert.equal(st.addEdges.length, 1);
const un = unstackOps("n", "s", [{ id: "c", source: "s", target: "me" }]);
assert.deepEqual(un.data, { stackId: null });
assert.deepEqual(un.addEdges.map((e) => [e.source, e.target]), [["n", "me"]]);
assert.equal(uniqueStackTitle([stack]), "Fichário (2)");
assert.equal(uniqueStackTitle([]), "Fichário");
console.log("noteStack.check ok");
