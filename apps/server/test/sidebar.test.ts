import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rmTmp } from "./rmtmp.js";

const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maestri-sidebar-test-")));
process.env.REPO_PATH = repo;
process.env.NODE_ENV = "test";
process.env.MAESTRI_TOKEN = "tok-sb";

const { fastify } = await import("../src/index.js");
const auth = { authorization: "Bearer tok-sb" };
const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) => fastify.inject({ method, url, headers: auth, payload });
const sidebar = async () => (await call("GET", "/api/sidebar")).json();
const project = async (id: string) => (await call("GET", "/api/projects")).json().find((p: any) => p.id === id);
let a = "";
let b = "";

before(async () => {
  await fastify.listen({ port: 0, host: "127.0.0.1" });
  a = (await call("POST", "/api/projects", { name: "Alfa" })).json().project.id;
  b = (await call("POST", "/api/projects", { name: "Beta" })).json().project.id;
});
after(async () => {
  await fastify.close();
  rmTmp(repo);
});

test("grupos: criar, duplicado, renomear (leva workspaces e pastas) e apagar", async () => {
  assert.equal((await call("POST", "/api/sidebar/groups", { name: "Dados" })).statusCode, 200);
  assert.equal((await call("POST", "/api/sidebar/groups", { name: "dados" })).statusCode, 409);
  assert.equal((await call("POST", "/api/sidebar/groups", { name: "  " })).statusCode, 400);
  await call("POST", "/api/sidebar/folders", { name: "Rel", group: "Dados" });
  await call("PATCH", `/api/projects/${a}/sidebar`, { group: "Dados", folder: "Rel" });
  assert.equal((await call("PATCH", "/api/sidebar/groups/Dados", { name: "Data" })).statusCode, 200);
  const p = await project(a);
  assert.deepEqual([p.group, p.folder], ["Data", "Rel"]);
  assert.deepEqual((await sidebar()).folders, [{ name: "Rel", group: "Data" }]);
  assert.equal((await call("PATCH", "/api/sidebar/groups/Nada", { name: "X" })).statusCode, 404);
  assert.equal((await call("DELETE", "/api/sidebar/groups/data")).statusCode, 200);
  const q = await project(a);
  assert.deepEqual([q.group, q.folder], [null, null]);
  const sb = await sidebar();
  assert.deepEqual([sb.groups, sb.folders], [[], []]);
});

test("pastas: escopo por grupo, renomear e apagar devolvem os workspaces ao pai", async () => {
  await call("POST", "/api/sidebar/groups", { name: "G" });
  assert.equal((await call("POST", "/api/sidebar/folders", { name: "F" })).statusCode, 200);
  assert.equal((await call("POST", "/api/sidebar/folders", { name: "f" })).statusCode, 409);
  assert.equal((await call("POST", "/api/sidebar/folders", { name: "F", group: "G" })).statusCode, 200);
  assert.equal((await call("POST", "/api/sidebar/folders", { name: "Z", group: "Fantasma" })).statusCode, 404);
  await call("PATCH", `/api/projects/${a}/sidebar`, { group: "G", folder: "F" });
  assert.equal((await call("PATCH", "/api/sidebar/folders/F?group=G", { name: "F2" })).statusCode, 200);
  let p = await project(a);
  assert.deepEqual([p.group, p.folder], ["G", "F2"]);
  assert.equal((await call("PATCH", "/api/sidebar/folders/F2?group=G", { name: "F" })).statusCode, 200);
  assert.equal((await call("DELETE", "/api/sidebar/folders/F?group=G")).statusCode, 200);
  p = await project(a);
  assert.deepEqual([p.group, p.folder], ["G", null]);
  assert.deepEqual((await sidebar()).folders, [{ name: "F", group: null }]);
  assert.equal((await call("DELETE", "/api/sidebar/folders/F?group=G")).statusCode, 404);
  await call("DELETE", "/api/sidebar/folders/F");
  await call("DELETE", "/api/sidebar/groups/G");
});

test("mover e fixar um workspace; pasta precisa existir no escopo; persiste em disco", async () => {
  await call("POST", "/api/sidebar/groups", { name: "G" });
  await call("POST", "/api/sidebar/folders", { name: "Raiz1" });
  assert.equal((await call("PATCH", `/api/projects/${b}/sidebar`, { group: "G", folder: "Raiz1" })).statusCode, 404);
  assert.equal((await call("PATCH", `/api/projects/${b}/sidebar`, { group: null, folder: "Raiz1" })).statusCode, 200);
  let p = await project(b);
  assert.deepEqual([p.group, p.folder], [null, "Raiz1"]);
  assert.equal((await call("PATCH", `/api/projects/${b}/sidebar`, { pinned: "sim" })).statusCode, 400);
  const r = await call("PATCH", `/api/projects/${b}/sidebar`, { pinned: true });
  assert.equal(r.json().project.pinned, true);
  p = await project(b);
  assert.deepEqual([p.folder, p.pinned], ["Raiz1", true]); // fixar não move
  await call("PATCH", `/api/projects/${b}/sidebar`, { pinned: false });
  await call("PATCH", `/api/projects/${b}/sidebar`, { group: null, folder: null });
  assert.equal((await call("PATCH", "/api/projects/nao-existe/sidebar", { pinned: true })).statusCode, 404);
  const saved = JSON.parse(fs.readFileSync(path.join(repo, ".maestri_data", "sidebar.json"), "utf8"));
  assert.deepEqual(saved.groups, ["G"]);
  p = await project(b);
  assert.deepEqual([p.group, p.folder, p.pinned], [null, null, false]);
});
