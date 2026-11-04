import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { registerFilesApi, safeRelPath } from "../src/files.js";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maestri-files-test-")));
const repo = path.join(tmp, "repo");
const outside = path.join(tmp, "fora");
fs.mkdirSync(repo);
fs.mkdirSync(outside);
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
const write = (rel: string, content: string | Buffer, base = repo) => {
  fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
  fs.writeFileSync(path.join(base, rel), content);
};

git(repo, "init", "-b", "main");
write(".gitignore", ".worktrees\nignorado.log\n");
write("a.txt", "um\n");
write("src/b.ts", "export const b = 1;\n");
write("src/c.ts", "export const c = 1;\n");
write("remover.txt", "x\n");
write("espaço ç.txt", "acentos\n");
git(repo, "add", "-A");
git(repo, "commit", "-m", "init");
fs.writeFileSync(path.join(outside, "segredo.txt"), "SEGREDO");

const P = "proj-f";
const fastify = Fastify();
registerFilesApi({ fastify, projectRepo: (id) => (id === P ? repo : null) });
const get = (sub: string) => fastify.inject({ method: "GET", url: `/api/projects/${P}${sub}` });
const content = (p: string, root = "") => get(`/files/content?${root ? `root=${root}&` : ""}path=${encodeURIComponent(p)}`);

before(async () => {
  // estado sujo: modificado, não rastreado, removido do disco, staged-add, staged-delete, ignorado
  write("a.txt", "um\ndois\n");
  write("novo.txt", "n\n");
  fs.rmSync(path.join(repo, "src/c.ts"));
  write("staged.txt", "s\n");
  git(repo, "add", "staged.txt");
  git(repo, "rm", "-q", "remover.txt");
  write("ignorado.log", "log\n");
  write("bin.dat", Buffer.from([1, 2, 0, 3, 4]));
  write("grande.txt", Buffer.alloc(1024 * 1024 + 1, 97));
  write("limite.txt", Buffer.alloc(1024 * 1024, 98));
  fs.symlinkSync(path.join(outside, "segredo.txt"), path.join(repo, "link-arquivo"));
  fs.symlinkSync(outside, path.join(repo, "link-dir"));
  fs.symlinkSync("a.txt", path.join(repo, "link-interno"));
  fs.symlinkSync(path.join(repo, "src"), path.join(repo, "link-src"));
  await fastify.ready();
});

after(async () => {
  await fastify.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("lista rastreados, não rastreados e ignorados (status I)", async () => {
  const r = await get("/files");
  assert.equal(r.statusCode, 200);
  const { root, files, truncated } = r.json();
  assert.equal(root, "main");
  assert.equal(truncated, undefined);
  const by = Object.fromEntries(files.map((f: any) => [f.path, f.status]));
  assert.equal(by["a.txt"], "M");
  assert.equal(by["novo.txt"], "?");
  assert.equal(by["src/c.ts"], "D");
  assert.equal(by["staged.txt"], "A");
  assert.equal(by["remover.txt"], "D");
  assert.ok("src/b.ts" in by && by["src/b.ts"] === undefined, "limpo não tem status");
  assert.ok("espaço ç.txt" in by, "nomes com espaço/acento");
  assert.equal(by["ignorado.log"], "I");
  assert.deepEqual(files.map((f: any) => f.path), [...files.map((f: any) => f.path)].sort());
  assert.equal((await get("/files?root=main")).json().files.length, files.length);
});

test("raiz de andar: lista o diretório do andar; raiz inválida 400, inexistente 404", async () => {
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "estado");
  git(repo, "worktree", "add", "-q", "-b", "agent/andar", path.join(repo, ".worktrees", "andar"), "main");
  const wt = path.join(repo, ".worktrees", "andar");
  write("so-no-andar.txt", "x\n", wt);
  write("a.txt", "mudou no andar\n", wt);

  const r = (await get("/files?root=andar")).json();
  assert.equal(r.root, "andar");
  const by = Object.fromEntries(r.files.map((f: any) => [f.path, f.status]));
  assert.equal(by["so-no-andar.txt"], "?");
  assert.equal(by["a.txt"], "M");
  assert.equal(JSON.parse((await content("a.txt", "andar")).body).content, "mudou no andar\n");
  assert.equal(JSON.parse((await content("a.txt")).body).content, "um\ndois\n");

  for (const bad of ["..", "a%2Fb", "-x", "a b", ".worktrees", "x".repeat(65)]) assert.equal((await get(`/files?root=${bad}`)).statusCode, 400, bad);
  assert.equal((await get("/files?root=nao-existe")).statusCode, 404);
  assert.equal((await get("/files/content?root=nao-existe&path=a.txt")).statusCode, 404);
  assert.equal((await fastify.inject({ method: "GET", url: "/api/projects/nada/files" })).statusCode, 404);
  assert.equal((await fastify.inject({ method: "GET", url: "/api/projects/a%20b/files" })).statusCode, 400);
});

test("conteúdo: texto, tamanho, UTF-8 e subpastas", async () => {
  const r = await content("src/b.ts");
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { path: "src/b.ts", content: "export const b = 1;\n", size: 20, binary: false });
  assert.equal((await content("espaço ç.txt")).json().content, "acentos\n");
  assert.equal(safeRelPath("./src//b.ts"), "src/b.ts");
  assert.equal((await content("./src/b.ts")).json().path, "src/b.ts");
});

test("conteúdo: traversal, absolutos e .git são rejeitados (400)", async () => {
  for (const p of ["../fora/segredo.txt", "src/../../fora/segredo.txt", "..", "/etc/passwd", path.join(outside, "segredo.txt"), "C:\\Windows\\win.ini", "\\etc\\passwd", ".git/config", "src/.git/x", "a\0b", ""]) {
    const r = await content(p);
    assert.equal(r.statusCode, 400, JSON.stringify(p));
    assert.ok(!r.body.includes("SEGREDO"));
  }
  assert.equal((await get("/files/content")).statusCode, 400);
  assert.equal((await get("/files/content?path=%2e%2e%2ffora%2fsegredo.txt")).statusCode, 400);
  assert.equal((await get("/files/content?path=..%5Cfora%5Csegredo.txt")).statusCode, 400);
});

test("conteúdo: symlink que sai da raiz é bloqueado; interno é permitido", async () => {
  for (const p of ["link-arquivo", "link-dir/segredo.txt"]) {
    const r = await content(p);
    assert.equal(r.statusCode, 403, p);
    assert.ok(!r.body.includes("SEGREDO"));
  }
  assert.equal((await content("link-interno")).json().content, "um\ndois\n");
  assert.equal((await content("link-src/b.ts")).json().content, "export const b = 1;\n");
});

test("conteúdo: binário, 413 acima de 1 MB, 404 e diretório", async () => {
  const bin = await content("bin.dat");
  assert.deepEqual(bin.json(), { path: "bin.dat", size: 5, binary: true });
  assert.equal(bin.json().content, undefined);
  assert.equal((await content("grande.txt")).statusCode, 413);
  const edge = await content("limite.txt");
  assert.equal(edge.statusCode, 200, "exatamente 1 MB passa");
  assert.equal(edge.json().size, 1024 * 1024);
  assert.equal((await content("nao-existe.txt")).statusCode, 404);
  assert.equal((await content("src")).statusCode, 400);
});

test("pasta que não é git é listada pelo sistema de arquivos (fallback)", async () => {
  const f = Fastify();
  const plain = path.join(tmp, "plain");
  fs.mkdirSync(path.join(plain, "sub"), { recursive: true });
  fs.writeFileSync(path.join(plain, "sub", "a.txt"), "a");
  registerFilesApi({ fastify: f, projectRepo: () => plain });
  const r = await f.inject({ method: "GET", url: `/api/projects/${P}/files` });
  assert.equal(r.statusCode, 200);
  assert.ok(r.json().files.some((x: any) => x.path === "sub/a.txt"));
  await f.close();
});
