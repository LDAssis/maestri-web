import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { registerFilesApi } from "../src/files.js";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maestri-filelist-test-")));
const repo = path.join(tmp, "repo");
const plain = path.join(tmp, "sem-git");
const outside = path.join(tmp, "fora");
for (const d of [repo, plain, outside]) fs.mkdirSync(d);
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
const write = (rel: string, content = "x\n", base = repo) => {
  fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
  fs.writeFileSync(path.join(base, rel), content);
};

const fastify = Fastify();
registerFilesApi({ fastify, projectRepo: (id) => (id === "p-git" ? repo : id === "p-plain" ? plain : null) });
const list = async (p: string) => {
  const r = await fastify.inject({ method: "GET", url: `/api/projects/${p}/files` });
  assert.equal(r.statusCode, 200, r.body);
  return r.json().files as { path: string; status?: string; dir?: boolean; collapsed?: boolean }[];
};

before(async () => {
  git(repo, "init", "-b", "main");
  write(".gitignore", ".env\nrenders/\nnode_modules/\nlogs/\n");
  write("a.txt");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "init");
  write(".env", "SEGREDO=1\n");
  write("serra-news/.gitignore", "renders/\n");
  write("serra-news/renders/video.mp4", "mp4");
  write("serra-news/renders/sub/nota.txt");
  write("serra-news/node_modules/pkg/index.js");
  write("node_modules/x/index.js");
  write("logs/app.log");
  write("logs/dist/saida.js"); // pesada dentro de pasta ignorada
  fs.symlinkSync(outside, path.join(repo, "logs", "link-fora"));
  write("segredo.txt", "nunca listar", outside);
  // sem git
  write("a.txt", "a", plain);
  write(".env", "x", plain);
  write("node_modules/y/z.js", "z", plain);
  write("src/b.ts", "b", plain);
  write(".git/config", "nao listar", plain);
  await fastify.ready();
});
after(async () => {
  await fastify.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("inclui arquivos e pastas ignorados com status I", async () => {
  const files = await list("p-git");
  const by = Object.fromEntries(files.map((f) => [f.path, f]));
  assert.equal(by[".env"].status, "I");
  assert.equal(by["serra-news/renders/video.mp4"].status, "I");
  assert.equal(by["serra-news/renders/sub/nota.txt"].status, "I");
  assert.equal(by["logs/app.log"].status, "I");
  assert.equal(by["a.txt"].status, undefined);
  assert.ok(!files.some((f) => f.path.startsWith(".git/")));
});

test("pastas pesadas viram uma entrada recolhida, sem filhos", async () => {
  const files = await list("p-git");
  const by = Object.fromEntries(files.map((f) => [f.path, f]));
  for (const p of ["node_modules/", "serra-news/node_modules/", "logs/dist/"]) {
    assert.deepEqual(by[p], { path: p, dir: true, status: "I", collapsed: true }, p);
  }
  assert.ok(!files.some((f) => f.path.startsWith("node_modules/") && f.path !== "node_modules/"));
  assert.ok(!files.some((f) => f.path.includes("pkg/index.js")));
});

test("symlinks não são seguidos para fora", async () => {
  const files = await list("p-git");
  assert.ok(!files.some((f) => f.path.includes("segredo.txt")));
  assert.ok(files.some((f) => f.path === "logs/link-fora"), "o link aparece como entrada, sem expandir");
});

test("lista continua ordenada", async () => {
  const paths = (await list("p-git")).map((f) => f.path);
  assert.deepEqual(paths, [...paths].sort());
});

test("pasta sem git: walk por fs com as mesmas exclusões", async () => {
  const files = await list("p-plain");
  const paths = files.map((f) => f.path);
  assert.ok(paths.includes("a.txt") && paths.includes(".env") && paths.includes("src/b.ts"));
  assert.ok(paths.includes("node_modules/"));
  assert.ok(!paths.some((p) => p.includes("y/z.js") || p.startsWith(".git")));
  assert.equal(files.find((f) => f.path === "a.txt")!.status, undefined);
});
