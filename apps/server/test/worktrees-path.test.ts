import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maestri-wtpath-test-")));
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
git(repo, "init", "-b", "main");
fs.writeFileSync(path.join(repo, ".gitignore"), ".worktrees\n.maestri_data\n");
fs.writeFileSync(path.join(repo, "a.txt"), "um\n");
fs.writeFileSync(path.join(repo, "b.txt"), "b\n");
git(repo, "add", "-A");
git(repo, "commit", "-m", "init");

process.env.REPO_PATH = repo;
process.env.NODE_ENV = "test";
process.env.MAESTRI_TOKEN = "tok-wtp";
const { fastify } = await import("../src/index.js");
const P = "proj-maestri-web";
const auth = { authorization: "Bearer tok-wtp" };
const api = (method: "GET" | "POST" | "DELETE", sub: string, payload?: object) =>
  fastify.inject({ method, url: `/api/projects/${P}${sub}`, headers: auth, payload });

before(async () => {
  await fastify.ready();
  const res = await api("POST", "/canvas", { nodes: [{ id: "ag", type: "agentTerminal", position: { x: 0, y: 0 }, data: { title: "Andar P" } }], edges: [] });
  assert.equal(res.statusCode, 200);
});
after(async () => {
  await fastify.close();
  fs.rmSync(repo, { recursive: true, force: true });
});

test("diff ?path= restringe lista e patch a um arquivo (modificado, não rastreado) e valida o path", async () => {
  const wt = (await api("POST", "/worktrees", { nodeId: "ag", name: "p" })).json().worktree;
  fs.writeFileSync(path.join(wt.path, "a.txt"), "um\ndois\n");
  fs.writeFileSync(path.join(wt.path, "b.txt"), "b\nmudou\n");
  fs.writeFileSync(path.join(wt.path, "novo.txt"), "novo\n");

  const all = (await api("GET", "/worktrees/p/diff")).json();
  assert.deepEqual(all.files.map((f: any) => f.path), ["a.txt", "b.txt", "novo.txt"]);

  const one = (await api("GET", "/worktrees/p/diff?path=a.txt")).json();
  assert.deepEqual(one.files.map((f: any) => f.path), ["a.txt"]);
  assert.match(one.patch, /\+dois/);
  assert.doesNotMatch(one.patch, /mudou|novo/);

  const fresh = (await api("GET", "/worktrees/p/diff?path=novo.txt")).json();
  assert.deepEqual(fresh.files.map((f: any) => [f.path, f.status]), [["novo.txt", "?"]]);
  assert.match(fresh.patch, /\+\+\+ b\/novo\.txt/);
  assert.doesNotMatch(fresh.patch, /dois|mudou/);

  assert.deepEqual((await api("GET", "/worktrees/p/diff?path=b.txt")).json().files.map((f: any) => f.path), ["b.txt"]);
  assert.deepEqual((await api("GET", "/worktrees/p/diff?path=*.txt")).json().files, [], "sem glob");
  assert.equal((await api("GET", "/worktrees/p/diff?path=..%2Fx")).statusCode, 400);
  assert.equal((await api("GET", "/worktrees/p/diff?path=%2Fetc%2Fpasswd")).statusCode, 400);
  assert.equal((await api("DELETE", "/worktrees/p?force=1")).statusCode, 200);
});
