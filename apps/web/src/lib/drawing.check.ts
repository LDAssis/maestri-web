// Rodar: npx tsx apps/web/src/lib/drawing.check.ts
import assert from "node:assert/strict";
import { buildDrawing } from "./drawing";

// retângulo: bbox exata, sem pontos
const r = buildDrawing("rect", [{ x: 100, y: 50 }, { x: 300, y: 150 }], "#fff", 4)!;
assert.deepEqual([r.position, r.style.width, r.style.height, r.data.points], [{ x: 100, y: 50 }, 200, 100, undefined]);
assert.equal(r.type, "drawing");
assert.equal(r.style.pointerEvents, "none");
// clique sem arrastar não cria forma; caneta cria mesmo um ponto
assert.equal(buildDrawing("rect", [{ x: 5, y: 5 }, { x: 6, y: 6 }], "#fff", 4), null);
assert.ok(buildDrawing("pen", [{ x: 5, y: 5 }], "#fff", 4));
// seta horizontal: altura mínima 8 centrada na linha, pontos normalizados
const a = buildDrawing("arrow", [{ x: 0, y: 100 }, { x: 80, y: 100 }], "#fff", 2)!;
assert.deepEqual([a.style.width, a.style.height, a.position.y], [80, 8, 96]);
assert.deepEqual(a.data.points, [0, 0.5, 1, 0.5]);
// caneta: só os extremos definem a bbox; todos os pontos ficam em 0..1
const p = buildDrawing("pen", [{ x: 10, y: 10 }, { x: 60, y: 90 }, { x: 110, y: 30 }], "#f00", 8)!;
assert.ok(p.data.points!.every((v) => v >= 0 && v <= 1));
assert.deepEqual([p.position.x, p.position.y, p.style.width, p.style.height], [10, 10, 100, 80]);
// seta arrastada para a esquerda/cima preserva a direção (normalizada)
const l = buildDrawing("arrow", [{ x: 100, y: 100 }, { x: 0, y: 0 }], "#fff", 2)!;
assert.deepEqual(l.data.points, [1, 1, 0, 0]);
console.log("drawing.check ok");
