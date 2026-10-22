// Rodar: npx tsx apps/web/src/lib/floorMarker.check.ts
import assert from "node:assert/strict";
import { FLOOR_MARKER, splitFloorMarker, withFloorMarker } from "./floorMarker";

assert.equal(FLOOR_MARKER, '<maestri-create-floor skill="maestri-workspace" />');
const t = withFloorMarker("Refatorar o login");
assert.ok(t.startsWith(FLOOR_MARKER + "\n"));
assert.deepEqual(splitFloorMarker(t), { marker: true, rest: "Refatorar o login" });
assert.deepEqual(splitFloorMarker("sem marcador"), { marker: false, rest: "sem marcador" });
assert.deepEqual(splitFloorMarker(`  ${FLOOR_MARKER}\n\nlinha1\nlinha2`), { marker: true, rest: "linha1\nlinha2" });
assert.deepEqual(splitFloorMarker(FLOOR_MARKER), { marker: true, rest: "" });
console.log("floorMarker.check ok");
