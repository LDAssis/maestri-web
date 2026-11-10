import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rmTmp } from "./rmtmp.js";
import { runOps } from "../src/fsOps.mjs";

// Operações de arquivo do servidor dentro de árvores controladas pelo agente: nunca seguem symlink (Fase 4 / A3).
const skip = process.platform === "win32" ? "symlinks no Windows exigem privilégio" : false;
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maestri-fsops-test-")));
const alvo = path.join(tmp, "alvo.txt");
const proj = path.join(tmp, "proj");
fs.mkdirSync(proj);
const reset = () => fs.writeFileSync(alvo, "ORIGINAL");
const err = (r: unknown) => typeof r === "object" && r !== null && "error" in r;

test("write: atômico; o destino que é symlink é SUBSTITUÍDO (o alvo do link não é tocado); tmp previsível é ignorado", { skip }, () => {
  reset();
  const f = path.join(proj, "a.json");
  fs.symlinkSync(alvo, f);
  assert.deepEqual(runOps([{ op: "write", path: f, data: "novo" }]), [true]);
  assert.equal(fs.readFileSync(alvo, "utf8"), "ORIGINAL");
  assert.ok(!fs.lstatSync(f).isSymbolicLink());
  assert.equal(fs.readFileSync(f, "utf8"), "novo");
  // nenhum tmp previsível sobra e o nome do tmp é aleatório (plantar <arq>.<pid>.tmp não adianta)
  fs.symlinkSync(alvo, `${f}.${process.pid}.tmp`);
  runOps([{ op: "write", path: f, data: "outro" }]);
  assert.equal(fs.readFileSync(alvo, "utf8"), "ORIGINAL");
  assert.deepEqual(runOps([{ op: "write", path: f, data: "outro", ifChanged: true }]), [false]);
});

test("append: não segue symlink no último componente (ELOOP)", { skip }, () => {
  reset();
  const f = path.join(proj, "exclude");
  fs.symlinkSync(alvo, f);
  const [r] = runOps([{ op: "append", path: f, data: "/.worktrees/\n" }]);
  assert.ok(err(r), JSON.stringify(r));
  assert.equal(fs.readFileSync(alvo, "utf8"), "ORIGINAL");
});

test("copy: só arquivo regular; symlink (para arquivo de fora) não é copiado", { skip }, () => {
  fs.writeFileSync(alvo, "SEGREDO");
  fs.writeFileSync(path.join(proj, "real.txt"), "dentro");
  fs.symlinkSync(alvo, path.join(proj, "link.txt"));
  const dest = path.join(tmp, "dest");
  const res = runOps([
    { op: "copy", src: path.join(proj, "real.txt"), dest: path.join(dest, "real.txt") },
    { op: "copy", src: path.join(proj, "link.txt"), dest: path.join(dest, "link.txt") },
    { op: "copy", src: path.join(proj, "naoexiste"), dest: path.join(dest, "x") },
  ]);
  assert.equal(res[0], true);
  assert.equal(res[1], false);
  assert.ok(err(res[2]));
  assert.ok(!fs.existsSync(path.join(dest, "link.txt")));
  assert.equal(fs.readFileSync(path.join(dest, "real.txt"), "utf8"), "dentro");
});

test("upsert/read: ler pelo link não vaza o conteúdo do alvo para dentro do projeto", { skip }, () => {
  fs.writeFileSync(alvo, "SEGREDO-DE-ROOT");
  const f = path.join(proj, "AGENTS.md");
  fs.symlinkSync(alvo, f);
  assert.deepEqual(runOps([{ op: "read", path: f }]), [null]);
  runOps([{ op: "upsert", path: f, block: "<!--s-->\nbloco\n<!--e-->", start: "<!--s-->", end: "<!--e-->" }]);
  assert.ok(!fs.readFileSync(f, "utf8").includes("SEGREDO-DE-ROOT"), "o conteúdo do alvo foi lido e regravado");
  assert.equal(fs.readFileSync(alvo, "utf8"), "SEGREDO-DE-ROOT");
  // preserva o conteúdo do usuário e não duplica o bloco
  const g = path.join(proj, "G.md");
  fs.writeFileSync(g, "meu texto\n");
  const op = { op: "upsert" as const, path: g, block: "<!--s-->\nv1\n<!--e-->", start: "<!--s-->", end: "<!--e-->" };
  assert.deepEqual(runOps([op, op]), [true, false]);
  assert.equal(fs.readFileSync(g, "utf8"), "meu texto\n\n<!--s-->\nv1\n<!--e-->\n");
});

test("fim", () => rmTmp(tmp));
