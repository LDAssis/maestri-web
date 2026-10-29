import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rmTmp, installFakeBin } from "./rmtmp.js";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maestri-polish4-test-")));
const repo = path.join(tmp, "repo");
const ghDir = path.join(tmp, "gh");
fs.mkdirSync(repo);
fs.mkdirSync(ghDir);
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
const initRepo = (dir: string) => {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-b", "main");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".worktrees\n.maestri_data\n");
  fs.writeFileSync(path.join(dir, "a.txt"), "um\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "init");
};
initRepo(repo);

// gh falso: view/list/merge a partir de arquivos em $GH_FAKE_DIR (unauth = não autenticado)
installFakeBin(ghDir, "gh", `[ -f "$GH_FAKE_DIR/unauth" ] && { echo "To get started with GitHub CLI, please run:  gh auth login" >&2; exit 4; }
case "$2" in
  view) f="$GH_FAKE_DIR/pr-$3.json"; [ -f "$f" ] && cat "$f" || { echo "no pull requests found" >&2; exit 1; } ;;
  list) f="$GH_FAKE_DIR/list-$4.json"; [ -f "$f" ] && cat "$f" || echo "[]" ;;
  merge) echo "$@" >> "$GH_FAKE_DIR/merge.log"; [ -f "$GH_FAKE_DIR/fail-merge" ] && { echo "merge bloqueado" >&2; exit 1; }; exit 0 ;;
esac`);
const wj = (name: string, v: unknown) => fs.writeFileSync(path.join(ghDir, name), JSON.stringify(v));
process.env.PATH = `${ghDir}${path.delimiter}${process.env.PATH}`;
process.env.GH_FAKE_DIR = ghDir;
process.env.REPO_PATH = repo;
process.env.NODE_ENV = "test";
process.env.MAESTRI_TOKEN = "tok-p4";

const { fastify } = await import("../src/index.js");
const { tallyChecks } = await import("../src/floorsApi.js");
const { presetLook } = await import("../src/presetLook.js");
const { COLORS, ICONS } = await import("../src/notesApi.js");
const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/maestri");
const P = "proj-maestri-web";
const auth = { authorization: "Bearer tok-p4" };
let port = 0;

function maestri(nodeId: string, args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      [bin, ...args],
      { env: { ...process.env, MAESTRI_API_URL: `http://127.0.0.1:${port}/api`, MAESTRI_PROJECT_ID: P, MAESTRI_NODE_ID: nodeId, MAESTRI_TOKEN: "tok-p4" } },
      (err, stdout, stderr) => resolve({ code: err ? ((err as any).code ?? 1) : 0, stdout, stderr }),
    );
  });
}
const ok = async (args: string[], who = "maestro") => {
  const r = await maestri(who, args);
  assert.equal(r.code, 0, r.stderr);
  return r.stdout;
};
const fail = async (args: string[], re: RegExp, who = "maestro") => {
  const r = await maestri(who, args);
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stderr, re);
};
const api = (method: "GET" | "POST" | "DELETE", sub: string, payload?: object) =>
  fastify.inject({ method, url: `/api/projects/${P}${sub}`, headers: auth, payload });
const state = async () => (await fastify.inject({ method: "GET", url: `/api/projects/${P}/canvas`, headers: auth })).json();
const floorList = async () => (await api("GET", "/floors")).json().floors as any[];
const node = (id: string, type: string, x: number, data: object) => ({ id, type, position: { x, y: 0 }, style: { width: 300, height: 200 }, data });
const resetCanvas = (nodes: any[] = [], edges: any[] = []) =>
  fastify.inject({ method: "POST", url: `/api/projects/${P}/canvas`, headers: auth, payload: { nodes: [node("maestro", "agentTerminal", 0, { title: "Maestro", isMaestro: true }), ...nodes], edges } });

before(async () => {
  await fastify.listen({ port: 0, host: "127.0.0.1" });
  port = (fastify.server.address() as any).port;
  await resetCanvas();
});
after(async () => {
  await fastify.close();
  rmTmp(tmp);
});

test("tallyChecks e presetLook", () => {
  assert.deepEqual(tallyChecks([{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }, { status: "IN_PROGRESS" }, { state: "SUCCESS" }]), { passing: 2, failing: 1, pending: 1 });
  assert.deepEqual(tallyChecks(undefined), { passing: 0, failing: 0, pending: 0 });
  const known = presetLook("/usr/bin/claude --model opus");
  assert.equal(known.icon, "sparkles");
  assert.ok((COLORS as readonly string[]).includes(known.color));
  for (let i = 0; i < 30; i++) {
    const l = presetLook("meu-script");
    assert.ok((COLORS as readonly string[]).includes(l.color) && (ICONS as readonly string[]).includes(l.icon));
  }
  assert.equal(presetLook("x", () => 0).color, COLORS[0]);
  assert.equal(presetLook("x", () => 0.999999).icon, ICONS[ICONS.length - 1]);
});

test("PR do andar: merge pelo gh com método, confirmação de checks e recusas", async () => {
  wj("pr-5.json", { number: 5, title: "Titulo 5", state: "OPEN", url: "https://github.com/acme/app/pull/5", headRefName: "feat-x", isCrossRepository: false, statusCheckRollup: [{ conclusion: "SUCCESS" }] });
  git(repo, "branch", "feat-x");
  await ok(["floor", "create", "Revisao", "--branch", "feat-x", "--existing-branch"]);
  // andar sem PR
  const none = await api("POST", `/floors/Revisao/pr/merge`, { method: "squash" });
  assert.equal(none.statusCode, 404);
  // vincula o PR (como no --pull-request): detecção abaixo; aqui direto pelo store via detect
  wj("list-feat-x.json", [{ number: 5, url: "https://github.com/acme/app/pull/5", title: "Titulo 5" }]);
  const d = await api("POST", "/floors/detect-prs", { now: true });
  assert.equal(d.json().found, 1);
  assert.equal((await floorList()).find((f) => f.name === "Revisao").pullRequest.number, 5);

  assert.equal((await api("POST", `/floors/Revisao/pr/merge`, { method: "fast" })).statusCode, 400);
  const m = await api("POST", `/floors/Revisao/pr/merge`, { method: "squash" });
  assert.equal(m.statusCode, 200, m.body);
  assert.match(fs.readFileSync(path.join(ghDir, "merge.log"), "utf8"), /pr merge 5 --squash/);

  // checks falhando/pendentes: pede confirmação; force mescla
  wj("pr-5.json", { number: 5, title: "Titulo 5", state: "OPEN", url: "u", statusCheckRollup: [{ conclusion: "FAILURE" }, { status: "QUEUED" }] });
  const need = await api("POST", `/floors/Revisao/pr/merge`, { method: "rebase" });
  assert.equal(need.statusCode, 409);
  assert.equal(need.json().needsConfirm, true);
  assert.deepEqual(need.json().checks, { passing: 0, failing: 1, pending: 1 });
  assert.doesNotMatch(fs.readFileSync(path.join(ghDir, "merge.log"), "utf8"), /--rebase/);
  const forced = await api("POST", `/floors/Revisao/pr/merge`, { method: "rebase", force: true });
  assert.equal(forced.statusCode, 200);
  assert.match(fs.readFileSync(path.join(ghDir, "merge.log"), "utf8"), /pr merge 5 --rebase/);

  // PR fechado, falha do gh e não autenticado
  wj("pr-5.json", { number: 5, state: "MERGED", statusCheckRollup: [] });
  const closed = await api("POST", `/floors/Revisao/pr/merge`, { method: "merge" });
  assert.equal(closed.statusCode, 409);
  assert.match(closed.json().error, /não está aberto/);
  wj("pr-5.json", { number: 5, state: "OPEN", statusCheckRollup: [] });
  fs.writeFileSync(path.join(ghDir, "fail-merge"), "");
  const blocked = await api("POST", `/floors/Revisao/pr/merge`, { method: "merge" });
  assert.equal(blocked.statusCode, 409);
  assert.match(blocked.json().error, /merge bloqueado/);
  fs.rmSync(path.join(ghDir, "fail-merge"));
  fs.writeFileSync(path.join(ghDir, "unauth"), "");
  assert.match((await api("POST", `/floors/Revisao/pr/merge`, { method: "merge" })).json().error, /não está autenticado/);
  fs.rmSync(path.join(ghDir, "unauth"));
  await ok(["floor", "delete", "Revisao", "--keep-branch"]);
  git(repo, "branch", "-D", "feat-x");
});

test("detecção de PR: andar cuja branch ganhou PR passa a segui-lo; ignora térreo, andar sem git e quem já tem PR; gh ausente é informado", async () => {
  await ok(["floor", "create", "Trabalho"]); // branch "trabalho"
  await ok(["floor", "create", "Solto", "--no-git"]);
  let d = (await api("POST", "/floors/detect-prs", { now: true })).json();
  assert.equal(d.found, 0); // sem PR ainda
  wj("list-trabalho.json", [{ number: 12, url: "https://github.com/acme/app/pull/12", title: "Feito pelo agente" }]);
  // respeita o intervalo mínimo (30s) quando não é forçado
  d = (await api("POST", "/floors/detect-prs", {})).json();
  assert.equal(d.found, 0);
  d = (await api("POST", "/floors/detect-prs", { now: true })).json();
  assert.equal(d.found, 1);
  const f = (await floorList()).find((x) => x.name === "Trabalho");
  assert.deepEqual(f.pullRequest, { number: 12, url: "https://github.com/acme/app/pull/12", title: "Feito pelo agente" });
  assert.match(await ok(["floor", "list"]), /Trabalho .*PR #12/);
  // já segue o PR: não consulta de novo
  wj("list-trabalho.json", [{ number: 99, url: "x", title: "outro" }]);
  assert.equal((await api("POST", "/floors/detect-prs", { now: true })).json().found, 0);
  assert.equal((await floorList()).find((x) => x.name === "Trabalho").pullRequest.number, 12);
  // o estado do PR já funciona para o andar detectado
  wj("pr-12.json", { number: 12, title: "Feito pelo agente", state: "OPEN", url: "https://github.com/acme/app/pull/12", reviewDecision: "APPROVED", statusCheckRollup: [] });
  const st = (await api("GET", `/floors/Trabalho/pr`)).json();
  assert.deepEqual([st.state, st.review], ["OPEN", "APPROVED"]);
  // gh sem login: informa e não quebra
  await ok(["floor", "create", "Outro"]);
  fs.writeFileSync(path.join(ghDir, "unauth"), "");
  d = (await api("POST", "/floors/detect-prs", { now: true })).json();
  assert.equal(d.found, 0);
  assert.match(d.unavailable, /não está autenticado/);
  fs.rmSync(path.join(ghDir, "unauth"));
  for (const n of ["Trabalho", "Solto", "Outro"]) await ok(["floor", "delete", n, "--force"]);
});

test("workspace create --from recria andares git de verdade no destino (branch criada ou existente) e informa o que caiu para sem git", async () => {
  await resetCanvas([node("w", "agentTerminal", 800, { title: "W", floor: "Feat" })], [{ id: "e", source: "maestro", target: "w" }]);
  await ok(["floor", "create", "Feat", "--branch", "feat"]);
  await ok(["floor", "create", "Velha", "--branch", "velha"]);
  await ok(["floor", "create", "Plano", "--no-git"]);
  await ok(["floor", "create", "Clone", "--copy"]); // clone na mesma branch do térreo (main)
  await ok(["floor", "create", "NaMain", "--branch", "main", "--existing-branch"]).catch(() => {}); // main está no térreo: não cria

  // destino git com a branch "velha" já existente
  const destA = path.join(tmp, "destA");
  initRepo(destA);
  git(destA, "branch", "velha");
  const out = await ok(["workspace", "create", "Destino A", "--dir", destA, "--from", "maestri web (principal)"]);
  assert.match(out, /andar "Feat": git, branch feat/);
  assert.match(out, /andar "Velha": git, branch velha/);
  assert.match(out, /andar "Plano": git|andar "Plano": sem git/); // andar sem git do origem fica sem git
  const projects = (await fastify.inject({ method: "GET", url: "/api/projects", headers: auth })).json();
  const a = projects.find((p: any) => p.name === "Destino A");
  const fa = (await fastify.inject({ method: "GET", url: `/api/projects/${a.id}/floors`, headers: auth })).json().floors;
  const byName = Object.fromEntries(fa.map((f: any) => [f.name, f]));
  assert.equal(byName.Feat.git, true);
  assert.equal(byName.Feat.branch, "feat");
  assert.equal(git(path.join(destA, ".worktrees", "feat"), "rev-parse", "--abbrev-ref", "HEAD"), "feat"); // criada porque faltava
  assert.equal(byName.Velha.git, true);
  assert.equal(git(path.join(destA, ".worktrees", "velha"), "rev-parse", "--abbrev-ref", "HEAD"), "velha"); // existia
  assert.equal(byName.Plano.git, false);
  assert.equal(byName.Clone.git, true);
  assert.equal(byName.Clone.copy, true);
  assert.ok(fs.statSync(path.join(destA, ".worktrees", "clone", ".git")).isDirectory());
  // os nós copiados continuam no andar pelo nome
  const cs = (await fastify.inject({ method: "GET", url: `/api/projects/${a.id}/canvas`, headers: auth })).json();
  assert.equal(cs.nodes.find((n: any) => n.data.title === "W").data.floor, "Feat");

  // destino que não é repositório git: tudo vira andar sem git, com o motivo
  const destB = path.join(tmp, "destB");
  fs.mkdirSync(destB);
  const outB = await ok(["workspace", "create", "Destino B", "--dir", destB, "--from", "maestri web (principal)"]);
  assert.match(outB, /andar "Feat": sem git: o destino não é um repositório git/);
  const pb = (await fastify.inject({ method: "GET", url: "/api/projects", headers: auth })).json().find((p: any) => p.name === "Destino B");
  const fb = (await fastify.inject({ method: "GET", url: `/api/projects/${pb.id}/floors`, headers: auth })).json().floors;
  assert.ok(fb.slice(1).every((f: any) => f.git === false));
  assert.deepEqual(fb.slice(1).map((f: any) => f.name).sort(), ["Clone", "Feat", "Plano", "Velha"].sort());

  // branch em uso no térreo do destino: cai para sem git, com o motivo (sem derrubar o resto)
  const destC = path.join(tmp, "destC");
  initRepo(destC);
  git(destC, "checkout", "-q", "-b", "feat");
  const outC = await ok(["workspace", "create", "Destino C", "--dir", destC, "--from", "maestri web (principal)"]);
  assert.match(outC, /andar "Feat": sem git: Falha ao criar o andar/);
  assert.match(outC, /andar "Velha": git, branch velha/);

  for (const n of ["Clone", "Plano", "Velha", "Feat"]) await ok(["floor", "delete", n, "--force"]).catch(() => {});
});

test("note create nasce à ESQUERDA do terminal, sem sobrepor", async () => {
  await resetCanvas([node("vizinho", "stickyNote", -340, { title: "Vizinho", content: "x" })]);
  await ok(["note", "create", "Nova ideia"]);
  const st = await state();
  const me = st.nodes.find((n: any) => n.id === "maestro");
  const n = st.nodes.find((x: any) => x.data?.title === "Nova ideia");
  assert.ok(n.position.x + 280 <= me.position.x, `x=${n.position.x}`);
  assert.ok(n.position.x < me.position.x);
  for (const o of st.nodes.filter((x: any) => x.id !== n.id)) {
    const w = Number(o.style?.width) || 300;
    const h = Number(o.style?.height) || 200;
    assert.equal(n.position.x < o.position.x + w && o.position.x < n.position.x + 280 && n.position.y < o.position.y + h && o.position.y < n.position.y + 200, false, `sobrepõe ${o.id}`);
  }
  // vizinho no lugar ideal: continua à esquerda, só que deslocada
  assert.ok(n.position.x < me.position.x);
});

test("arrange em banda: só o Maestro, nome único, ícone e cor", async () => {
  await resetCanvas(
    [node("a", "agentTerminal", 400, { title: "A" }), node("b", "agentTerminal", 800, { title: "B" }), node("band1", "band", 400, { title: "Esquadrão", members: ["a", "b"] }), node("band2", "band", 800, { title: "Outra", members: [] })],
    [{ id: "e1", source: "maestro", target: "a" }, { id: "e2", source: "maestro", target: "b" }, { id: "e3", source: "band1", target: "maestro" }, { id: "e4", source: "band2", target: "maestro" }],
  );
  assert.match(await ok(["arrange"]), /Esquadrão \[band\]/);
  await ok(["arrange", "esquadrão", "--icon", "rocket", "--color", "sky", "--name", "Time Azul"]);
  const band = (await state()).nodes.find((n: any) => n.id === "band1");
  assert.deepEqual([band.data.title, band.data.icon, band.data.color], ["Time Azul", "rocket", "sky"]);
  // nome duplicado entre bandas ganha sufixo
  await ok(["arrange", "Time Azul", "--name", "outra"]);
  assert.equal((await state()).nodes.find((n: any) => n.id === "band1").data.title, "outra (2)");
  await fail(["arrange", "outra (2)", "--icon", "naoexiste"], /Ícone inválido/);
  // não-Maestro (membro) não estiliza a banda
  await resetCanvas(
    [node("a", "agentTerminal", 400, { title: "A" }), node("band1", "band", 400, { title: "Esquadrão", members: ["a"] })],
    [{ id: "e1", source: "maestro", target: "a" }],
  );
  await fail(["arrange", "Esquadrão", "--color", "rose"], /Apenas o Maestro/, "a");
});
