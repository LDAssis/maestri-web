import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maestri-dl-test-")));
const data = path.join(tmp, "data");
const proj = path.join(tmp, "meu projeto");
const outside = path.join(tmp, "fora");
for (const d of [data, proj, outside]) fs.mkdirSync(d);
process.env.REPO_PATH = data;
process.env.NODE_ENV = "test";
process.env.MAESTRI_TOKEN = "segredo-dl";
process.env.MAESTRI_DOWNLOAD_TTL_MS = "1500";

const write = (rel: string, content: string | Buffer, base = proj) => {
  fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
  fs.writeFileSync(path.join(base, rel), content);
};
write("a.txt", "conteudo-a\n");
write("espaço ç.txt", "acentos\n");
write("src/b.ts", "export const b = 1;\n");
write("src/sub/c.md", "# c\n");
write("node_modules/pkg/index.js", "x");
write(".git/config", "[core]");
write("dist/out.js", "x");
write(".worktrees/andar-x/y.txt", "y");
write("andar-fake/ok.txt", "ok");
write(".env", "API_KEY=segredo-env");
write("src/.env.local", "TOKEN=segredo-local");
write(".env.example", "API_KEY=");
fs.writeFileSync(path.join(outside, "segredo.txt"), "SEGREDO");
// Symlinks exigem privilégio no Windows: sem eles, os casos de link são pulados
let hasLinks = true;
try {
  fs.symlinkSync(path.join(outside, "segredo.txt"), path.join(proj, "link-fora"));
  fs.symlinkSync(outside, path.join(proj, "link-dir-fora"), "dir");
  fs.symlinkSync("a.txt", path.join(proj, "link-interno"));
} catch {
  hasLinks = false;
}

const { fastify } = await import("../src/index.js");
const auth = { authorization: "Bearer segredo-dl" };
let P = "";

const link = (body: unknown, headers: Record<string, string> = auth) =>
  fastify.inject({ method: "POST", url: `/api/projects/${P}/files/download-link`, headers, payload: body as any });
const dl = (url: string, headers: Record<string, string> = {}) => fastify.inject({ method: "GET", url, headers });

// Nomes das entradas do zip (diretório central)
function zipNames(buf: Buffer): string[] {
  const names: string[] = [];
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, "zip sem EOCD");
  const total = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < total; i++) {
    assert.equal(buf.readUInt32LE(off), 0x02014b50);
    const n = buf.readUInt16LE(off + 28), m = buf.readUInt16LE(off + 30), k = buf.readUInt16LE(off + 32);
    names.push(buf.subarray(off + 46, off + 46 + n).toString("utf8"));
    off += 46 + n + m + k;
  }
  return names.sort();
}

before(async () => {
  await fastify.ready();
  const res = await fastify.inject({ method: "POST", url: "/api/projects", headers: auth, payload: { name: "dl", repoPath: proj } });
  assert.equal(res.statusCode, 200, res.body);
  P = res.json().project.id;
});

after(async () => {
  await fastify.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("POST sem token -> 401; GET /api/downloads/:token inexistente (sem auth) -> 404 e não 401", async () => {
  const res = await link({ path: "a.txt" }, {});
  assert.equal(res.statusCode, 401);
  const r = await dl("/api/downloads/naoexiste");
  assert.equal(r.statusCode, 404);
  assert.ok(r.json().error);
  const r2 = await dl(`/api/downloads/${"0".repeat(64)}`);
  assert.equal(r2.statusCode, 404);
});

test("só o GET do token é público (outras rotas de download seguem exigindo auth)", async () => {
  const r = await fastify.inject({ method: "DELETE", url: "/api/downloads/abc" });
  assert.equal(r.statusCode, 401);
  const r2 = await fastify.inject({ method: "GET", url: `/api/projects/${P}/files` });
  assert.equal(r2.statusCode, 401);
});

test("link de arquivo: metadados, download sem auth, headers e uso único", async () => {
  const res = await link({ path: "espaço ç.txt" });
  assert.equal(res.statusCode, 200, res.body);
  const j = res.json();
  assert.equal(j.kind, "file");
  assert.equal(j.name, "espaço ç.txt");
  assert.equal(j.size, 8 + 0 + 1 > 0 ? Buffer.byteLength("acentos\n") : 0);
  assert.match(j.url, /^\/api\/downloads\/[0-9a-f]{64}$/);
  const r = await dl(j.url);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body, "acentos\n");
  assert.equal(r.headers["content-length"], String(j.size));
  assert.match(String(r.headers["content-type"]), /^text\/plain/);
  assert.match(String(r.headers["content-disposition"]), /^attachment; filename="[^"]*"; filename\*=UTF-8''espa%C3%A7o%20%C3%A7\.txt$/);
  const again = await dl(j.url);
  assert.equal(again.statusCode, 404);
});

test("arquivo desconhecido -> application/octet-stream", async () => {
  write("blob.bin", Buffer.from([0, 1, 2]));
  const j = (await link({ path: "blob.bin" })).json();
  const r = await dl(j.url);
  assert.equal(r.headers["content-type"], "application/octet-stream");
  assert.deepEqual(r.rawPayload, Buffer.from([0, 1, 2]));
});

test("token expira", async () => {
  const j = (await link({ path: "a.txt" })).json();
  await new Promise((r) => setTimeout(r, 1700));
  assert.equal((await dl(j.url)).statusCode, 404);
});

test("zip do projeto exclui node_modules/.git/dist/.worktrees e links para fora", async () => {
  const res = await link({ path: "" });
  assert.equal(res.statusCode, 200, res.body);
  const j = res.json();
  assert.equal(j.kind, "zip");
  assert.equal(j.name, "meu projeto.zip");
  assert.equal(j.size, undefined);
  const r = await dl(j.url);
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers["content-type"], "application/zip");
  assert.equal(r.headers["content-length"], undefined);
  assert.match(String(r.headers["content-disposition"]), /\.zip/);
  const names = zipNames(r.rawPayload);
  assert.deepEqual(names, [
    "meu projeto/.env.example",
    "meu projeto/a.txt",
    "meu projeto/andar-fake/ok.txt",
    "meu projeto/blob.bin",
    "meu projeto/espaço ç.txt",
    ...(hasLinks ? ["meu projeto/link-interno"] : []),
    "meu projeto/src/b.ts",
    "meu projeto/src/sub/c.md",
  ]);
  assert.ok(!r.rawPayload.includes("SEGREDO"));
  assert.equal((await dl(j.url)).statusCode, 404);
});

test(".env fica fora do zip por padrão; excludeSecrets=false inclui; arquivo .env sozinho continua baixável", async () => {
  const def = zipNames((await dl((await link({ path: "" })).json().url)).rawPayload);
  assert.ok(!def.includes("meu projeto/.env") && !def.includes("meu projeto/src/.env.local"), def.join(","));
  assert.ok(def.includes("meu projeto/.env.example"));
  const withEnv = zipNames((await dl((await link({ path: "", excludeSecrets: false })).json().url)).rawPayload);
  for (const n of ["meu projeto/.env", "meu projeto/src/.env.local"]) assert.ok(withEnv.includes(n), n);
  const one = await link({ path: ".env" });
  assert.equal(one.statusCode, 200);
  assert.equal((await dl(one.json().url)).body, "API_KEY=segredo-env");
});

test("zip de subpasta e excludeHeavy=false inclui node_modules e .git", async () => {
  const sub = (await link({ path: "src" })).json();
  assert.equal(sub.name, "src.zip");
  assert.deepEqual(zipNames((await dl(sub.url)).rawPayload), ["src/b.ts", "src/sub/c.md"]);

  const all = (await link({ path: "", excludeHeavy: false })).json();
  const names = zipNames((await dl(all.url)).rawPayload);
  for (const n of ["meu projeto/node_modules/pkg/index.js", "meu projeto/.git/config", "meu projeto/dist/out.js", "meu projeto/a.txt"]) assert.ok(names.includes(n), n);
  assert.ok(!names.some((n) => n.includes("segredo") || n.includes("link-fora") || n.includes("link-dir-fora")));
});

test("andar (root): zip da raiz do andar", async () => {
  const j = (await link({ root: "andar-x", path: "" })).json();
  assert.equal(j.name, "andar-x.zip");
  assert.deepEqual(zipNames((await dl(j.url)).rawPayload), ["andar-x/y.txt"]);
  assert.equal((await link({ root: "nao-existe", path: "" })).statusCode, 404);
  assert.equal((await link({ root: "../x", path: "" })).statusCode, 400);
});

test("path traversal, absolutos, .git e symlinks para fora são recusados", async () => {
  for (const p of ["../fora/segredo.txt", "..", "a/../../fora", "/etc/passwd", "C:\\Windows\\win.ini", ".git/config", "a\0b"]) {
    const r = await link({ path: p });
    assert.equal(r.statusCode, 400, `${JSON.stringify(p)} -> ${r.statusCode} ${r.body}`);
  }
  for (const p of hasLinks ? ["link-fora", "link-dir-fora", "link-dir-fora/segredo.txt"] : []) {
    const r = await link({ path: p });
    assert.ok([403, 404].includes(r.statusCode), `${p} -> ${r.statusCode}`);
    assert.ok(!r.body.includes("/api/downloads/"));
  }
  assert.equal((await link({ path: "nao-existe.txt" })).statusCode, 404);
  assert.equal((await link({ path: 5 })).statusCode, 400);
  // symlink interno é aceito
  if (hasLinks) assert.equal((await link({ path: "link-interno" })).statusCode, 200);
});

test("projeto inexistente -> 404", async () => {
  const r = await fastify.inject({ method: "POST", url: "/api/projects/proj-x/files/download-link", headers: auth, payload: { path: "" } });
  assert.equal(r.statusCode, 404);
});

test("symlink trocado depois do POST não vaza arquivo de fora", { skip: !hasLinks }, async () => {
  write("troca.txt", "inocente");
  const j = (await link({ path: "troca.txt" })).json();
  fs.rmSync(path.join(proj, "troca.txt"));
  fs.symlinkSync(path.join(outside, "segredo.txt"), path.join(proj, "troca.txt"));
  const r = await dl(j.url);
  assert.equal(r.statusCode, 404);
  assert.ok(!r.body.includes("SEGREDO"));
});
