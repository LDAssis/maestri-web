import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rmTmp } from "./rmtmp.js";
import { runMigration } from "../scripts/migrate-isolation.js";
import { loadIsolationConfig, UID_BASE } from "../src/isolation.js";

// Script de migração (Fase 3): só roda aqui em tmp, com exec falso. Nunca toca em produção.
const isWindows = process.platform === "win32";

function setup() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maestri-migrate-test-")));
  const repo = path.join(tmp, "app");
  const dataDir = path.join(repo, ".maestri_data");
  const legacy = path.join(tmp, "home", "maestri-projects");
  const home = path.join(tmp, "home");
  const ext = path.join(tmp, "externo");
  const srv = path.join(tmp, "srv");
  for (const d of [dataDir, legacy, ext, path.join(legacy, "src"), path.join(legacy, "alfa"), path.join(legacy, "beta")]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(legacy, "alfa", "codigo.txt"), "alfa");
  fs.mkdirSync(path.join(legacy, "alfa", ".worktrees"));
  fs.writeFileSync(path.join(legacy, "beta", "codigo.txt"), "beta");
  fs.writeFileSync(path.join(legacy, "src", "solto.txt"), "não é projeto");
  const projects = [
    { id: "proj-a", name: "Alfa", description: "", repoPath: path.join(legacy, "alfa"), createdAt: "2024-01-01", ownerId: "u1", members: [] },
    { id: "proj-b", name: "Beta", description: "", repoPath: path.join(legacy, "beta"), createdAt: "2024-01-01", ownerId: "u1", members: [] },
    { id: "proj-c", name: "Externo", description: "", repoPath: ext, createdAt: "2024-01-01", ownerId: "u1", members: [] },
    { id: "proj-d", name: "Principal", description: "", repoPath: ".", createdAt: "2024-01-01", ownerId: "u1", members: [] },
  ];
  fs.writeFileSync(path.join(dataDir, "projects.json"), JSON.stringify(projects.map((p) => (p.id === "proj-d" ? p : p)), null, 2));
  fs.writeFileSync(path.join(dataDir, "canvas_proj-a.json"), JSON.stringify({ nodes: [{ id: "n", data: { worktreePath: path.join(legacy, "alfa", ".worktrees", "x") } }] }));
  fs.writeFileSync(path.join(dataDir, "floors_proj-a.json"), JSON.stringify({ floors: [{ path: path.join(legacy, "alfa", ".worktrees", "x") }] }));
  // contas existentes
  fs.mkdirSync(path.join(dataDir, "accounts", "claude", "Trabalho"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "accounts", "claude", "Trabalho", ".credentials.json"), '{"t":1}');
  // login do admin
  fs.mkdirSync(path.join(home, ".claude", "projects", "-x"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "projects", "-x", "conversa.jsonl"), "SEGREDO DE OUTRO PROJETO");
  fs.mkdirSync(path.join(home, ".claude", "skills", "s"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "skills", "s", "SKILL.md"), "skill");
  fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), '{"oauth":1}');
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{}");
  fs.writeFileSync(path.join(home, ".claude", "history.jsonl"), "historico");
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { a: 1 }, projects: { "/root/x": { history: ["segredo"] } } }));
  fs.mkdirSync(path.join(home, ".codex", "sessions"), { recursive: true });
  fs.writeFileSync(path.join(home, ".codex", "sessions", "s.jsonl"), "SEGREDO");
  fs.writeFileSync(path.join(home, ".codex", "auth.json"), '{"tokens":1}');
  fs.writeFileSync(path.join(home, ".codex", "config.toml"), "x=1");
  // ~/.gemini do root (gemini-cli + agy): login e config vão; histórico, conversas, cache e logs não
  const g = path.join(home, ".gemini");
  for (const d of ["antigravity-cli/conversations", "antigravity-cli/cache", "history/root", "tmp/root/chats", "config/projects", "config/plugins", "skills/s"]) fs.mkdirSync(path.join(g, d), { recursive: true });
  for (const [f, c] of [
    ["oauth_creds.json", "{}tok"], ["google_accounts.json", "{}acc"], ["settings.json", "{}set"], ["installation_id", "id1"], ["state.json", "estado"], ["projects.json", "HISTORICO"],
    ["antigravity-cli/antigravity-oauth-token", "agy-token"], ["antigravity-cli/settings.json", "{}s"], ["antigravity-cli/cli.log", "LOG"],
    ["antigravity-cli/conversations/a.db", "CONVERSA"], ["antigravity-cli/cache/c.json", "cache"], ["history/root/h", "HIST"], ["tmp/root/chats/c", "CHAT"],
    ["config/mcp_config.json", "{}mcp"], ["config/projects/default.json", "PROJ-HIST"], ["config/plugins/p.json", "{}p"], ["skills/s/SKILL.md", "skill"],
  ]) fs.writeFileSync(path.join(g, f), c);

  const calls: string[] = [];
  const users = new Map<string, number>();
  const groups = new Set<string>();
  const exec = (cmd: string, args: string[]) => {
    calls.push([cmd, ...args].join(" "));
    if (cmd === "getent" && args[0] === "passwd") {
      const u = users.get(args[1]);
      if (u === undefined) throw new Error("não existe");
      return `${args[1]}:x:${u}:${u}::/h:/bin/bash`;
    }
    if (cmd === "getent" && args[0] === "group") {
      if (!groups.has(args[1])) throw new Error("não existe");
      return `${args[1]}:x:4000:`;
    }
    if (cmd === "useradd") users.set(args[args.length - 1], Number(args[args.indexOf("-u") + 1]));
    if (cmd === "groupadd") groups.add(args[0]);
    if (cmd === "tar") fs.writeFileSync(args[1], "tar"); // backup falso, mas o arquivo existe
    return "";
  };
  const cfg = { ...loadIsolationConfig({ MAESTRI_ISOLATION_ROOT: srv, MAESTRI_ISOLATION_CGROUP: "0" } as any, "linux", 0), enabled: true };
  const killed: string[] = [];
  const base = { dataDir, legacyRoot: legacy, home, cfg, exec, log: () => {}, stamp: "T1", chown: () => {}, killProcesses: (d: string) => (killed.push(d), 0) };
  return { tmp, repo, dataDir, legacy, home, ext, srv, cfg, calls, users, groups, killed, base };
}
const read = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));

test("dry-run (padrão): lista o que faria e não altera NADA", () => {
  const w = setup();
  const before = fs.readFileSync(path.join(w.dataDir, "projects.json"), "utf8");
  const r = runMigration({ ...w.base, apply: false });
  assert.equal(fs.readFileSync(path.join(w.dataDir, "projects.json"), "utf8"), before);
  assert.ok(fs.existsSync(path.join(w.legacy, "alfa", "codigo.txt")), "nada foi movido");
  assert.ok(!fs.existsSync(w.srv), "nem criou /srv/maestri");
  assert.deepEqual(w.calls.filter((c) => !c.startsWith("getent")), [], "nenhum comando mutante");
  assert.deepEqual(w.killed, []);
  const text = r.actions.join("\n");
  assert.match(text, /proj-a: matar processos/);
  assert.match(text, /proj-a: backup .*proj-a-T1\.tar\.gz/);
  assert.match(text, /proj-a: criar usuário mp-proj-a/);
  assert.match(text, /proj-b: mover .* -> .*beta/);
  assert.match(text, /proj-c: pasta externa/);
  assert.match(text, /conta claude\/Trabalho: mover/);
  assert.match(text, /conta claude\/Padrão: copiar/);
  assert.match(text, /conta codex\/Padrão: copiar/);
  assert.match(text, /conta gemini\/Padrão: copiar/);
  assert.deepEqual(r.migrated, []);
  assert.deepEqual(r.external.sort(), ["proj-c", "proj-d"]);
  assert.deepEqual(r.orphanDirs, [path.join(w.legacy, "src")], "a pasta 'src' é reportada e não mexida");
  rmTmp(w.tmp);
});

test("--apply: move, backup, usuário, chown, caminhos reescritos, externos marcados, contas migradas e Padrão sem o histórico", () => {
  const w = setup();
  const r = runMigration({ ...w.base, apply: true });
  assert.deepEqual(r.migrated, ["proj-a", "proj-b"]);
  const projects = read(path.join(w.dataDir, "projects.json"));
  const a = projects.find((p: any) => p.id === "proj-a");
  const dest = path.join(w.cfg.projectsDir, "alfa");
  assert.deepEqual({ repoPath: a.repoPath, osUser: a.osUser, isolated: a.isolated }, { repoPath: dest, osUser: "mp-proj-a", isolated: true });
  assert.ok(a.uid >= UID_BASE);
  assert.equal(projects.find((p: any) => p.id === "proj-b").uid, a.uid + 1);
  assert.equal(projects.find((p: any) => p.id === "proj-c").isolated, false);
  assert.equal(projects.find((p: any) => p.id === "proj-d").isolated, false);
  assert.equal(projects.find((p: any) => p.id === "proj-c").repoPath, w.ext, "externo não é movido");
  assert.equal(projects.find((p: any) => p.id === "proj-d").repoPath, ".", "convenção relativa do servidor preservada");
  // pasta movida de verdade, a antiga some; o que não é projeto fica
  assert.equal(fs.readFileSync(path.join(dest, "codigo.txt"), "utf8"), "alfa");
  assert.ok(!fs.existsSync(path.join(w.legacy, "alfa")));
  assert.ok(fs.existsSync(path.join(w.legacy, "src", "solto.txt")));
  if (!isWindows) assert.equal(fs.statSync(dest).mode & 0o7777, 0o2750);
  // caminhos persistidos reescritos (canvas e andares)
  assert.equal(read(path.join(w.dataDir, "canvas_proj-a.json")).nodes[0].data.worktreePath, path.join(dest, ".worktrees", "x"));
  assert.equal(read(path.join(w.dataDir, "floors_proj-a.json")).floors[0].path, path.join(dest, ".worktrees", "x"));
  // backup antes de mover + comandos esperados
  assert.ok(w.calls.some((c) => c.startsWith("tar -czf") && c.includes("proj-a-T1.tar.gz")));
  assert.ok(w.calls.some((c) => c.startsWith("useradd -M -U -u 20000 ") && c.endsWith(" mp-proj-a")));
  assert.ok(w.calls.includes(`chown -R ${a.uid}:${a.gid} ${dest}`));
  assert.ok(w.calls.includes(`chmod -R g-w,o-rwx ${dest}`));
  assert.ok(w.calls.some((c) => c.includes("worktree repair")));
  assert.ok(w.calls.findIndex((c) => c.startsWith("tar -czf")) < w.calls.findIndex((c) => c.startsWith("useradd")), "backup vem antes de qualquer mudança");
  assert.deepEqual(w.killed.sort(), [path.join(w.legacy, "alfa"), path.join(w.legacy, "beta")].sort());
  assert.ok(fs.existsSync(path.join(w.dataDir, "projects.json.bak-T1")), "cópia do projects.json");
  if (!isWindows) assert.equal(fs.statSync(path.join(w.dataDir, "projects.json")).mode & 0o777, 0o600);
  if (!isWindows) assert.equal(fs.statSync(path.join(w.cfg.backupsDir, "proj-a-T1.tar.gz")).mode & 0o777, 0o600);

  // contas: a existente foi movida; "Padrão" nasce só com o essencial, sem histórico de conversa
  assert.equal(fs.readFileSync(path.join(w.cfg.accountsDir, "claude", "Trabalho", ".credentials.json"), "utf8"), '{"t":1}');
  assert.ok(!fs.existsSync(path.join(w.dataDir, "accounts", "claude", "Trabalho")));
  const padrao = path.join(w.cfg.accountsDir, "claude", "Padrão");
  assert.deepEqual(fs.readdirSync(padrao).sort(), [".claude.json", ".credentials.json", "settings.json", "skills"]);
  assert.ok(!JSON.stringify(read(path.join(padrao, ".claude.json"))).includes("segredo"));
  assert.deepEqual(Object.keys(read(path.join(padrao, ".claude.json"))), ["oauthAccount"]);
  assert.deepEqual(fs.readdirSync(path.join(w.cfg.accountsDir, "codex", "Padrão")).sort(), ["auth.json", "config.toml"]);
  assert.ok(fs.existsSync(path.join(w.home, ".claude", ".credentials.json")), "o login do root continua lá (cópia, não mover)");
  assert.ok(fs.existsSync(path.join(w.home, ".claude", "projects", "-x", "conversa.jsonl")));
  assert.ok(w.groups.size >= 3, "um grupo por conta");
  assert.deepEqual(r.accounts.sort(), ["claude/Padrão", "claude/Trabalho", "codex/Padrão", "gemini/Padrão"]);
  // gemini/Padrão (agy + gemini-cli): login e config; sem histórico, conversas, cache, logs nem tmp
  const gem = path.join(w.cfg.accountsDir, "gemini", "Padrão");
  const tree = (d: string, rel = ""): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? tree(path.join(d, e.name), path.join(rel, e.name)) : [path.join(rel, e.name).replace(/\\/g, "/")]));
  assert.deepEqual(tree(gem).sort(), [
    "antigravity-cli/antigravity-oauth-token", "antigravity-cli/settings.json",
    "config/mcp_config.json", "config/plugins/p.json", "google_accounts.json", "installation_id", "oauth_creds.json", "settings.json", "skills/s/SKILL.md",
  ].sort());
  assert.ok(!JSON.stringify(tree(gem)).match(/HIST|conversations|cache|cli\.log|projects|tmp|state\.json/i));
  assert.ok(fs.existsSync(path.join(w.home, ".gemini", "oauth_creds.json")), "o login do root continua lá");
  assert.ok([...w.groups].some((g) => g.includes("gemini")), "grupo da conta gemini");
  rmTmp(w.tmp);
});

test("idempotente: rodar de novo não faz nada; --project limita a um projeto", () => {
  const w = setup();
  const one = runMigration({ ...w.base, apply: true, only: "proj-b" });
  assert.deepEqual(one.migrated, ["proj-b"]);
  const projects = read(path.join(w.dataDir, "projects.json"));
  assert.equal(projects.find((p: any) => p.id === "proj-a").osUser, undefined, "os demais ficam como estavam");
  assert.ok(fs.existsSync(path.join(w.legacy, "alfa", "codigo.txt")));
  const n = w.calls.length;
  const again = runMigration({ ...w.base, apply: true, only: "proj-b" });
  assert.deepEqual(again.migrated, []);
  assert.deepEqual(again.alreadyDone, ["proj-b"]);
  assert.equal(w.calls.filter((c) => c.startsWith("useradd")).length, 1);
  assert.equal(w.calls.slice(n).filter((c) => /^(tar|useradd|chown|userdel)/.test(c) && !c.includes(w.cfg.accountsDir)).length, 0, "só a renormalização das contas pode rodar");
  // tudo: A migra, B já estava, externos marcados; segunda passada total não altera mais nada
  const all = runMigration({ ...w.base, apply: true });
  assert.deepEqual(all.migrated, ["proj-a"]);
  assert.deepEqual(all.alreadyDone, ["proj-b"]);
  const snap = fs.readFileSync(path.join(w.dataDir, "projects.json"), "utf8");
  const last = runMigration({ ...w.base, apply: true });
  assert.deepEqual(last.migrated, []);
  assert.deepEqual(last.actions, [], "nada a fazer");
  assert.equal(fs.readFileSync(path.join(w.dataDir, "projects.json"), "utf8"), snap);
  assert.equal(runMigration({ ...w.base, apply: false, only: "nao-existe" }).warnings.length >= 1, true);
  rmTmp(w.tmp);
});

test("--accounts-only: projetos já migrados não são tocados; só as contas (inclui gemini/Padrão) e a normalização", () => {
  const w = setup();
  const before = fs.readFileSync(path.join(w.dataDir, "projects.json"), "utf8");
  const dry = runMigration({ ...w.base, apply: false, accountsOnly: true });
  assert.deepEqual(dry.migrated, []);
  assert.ok(dry.actions.every((a) => a.startsWith("conta")), dry.actions.join(" | "));
  const r = runMigration({ ...w.base, apply: true, accountsOnly: true });
  assert.deepEqual(r.migrated, []);
  assert.equal(fs.readFileSync(path.join(w.dataDir, "projects.json"), "utf8"), before, "projects.json intacto");
  assert.ok(fs.existsSync(path.join(w.legacy, "alfa", "codigo.txt")), "nenhuma pasta movida");
  assert.ok(!w.calls.some((c) => c.startsWith("useradd")), "nenhum usuário criado");
  assert.deepEqual(r.accounts.sort(), ["claude/Padrão", "claude/Trabalho", "codex/Padrão", "gemini/Padrão"]);
  // segunda rodada: nada a copiar/mover; só renormaliza as pastas (chown/chmod recursivos nas contas existentes)
  const n = w.calls.length;
  const again = runMigration({ ...w.base, apply: true, accountsOnly: true });
  assert.deepEqual(again.accounts, []);
  assert.deepEqual(again.actions, []);
  const later = w.calls.slice(n);
  assert.ok(later.some((c) => c.startsWith("chmod -R g+rwX,o-rwx ") && c.includes("gemini")), "renormaliza as contas existentes");
  assert.ok(!later.some((c) => c.startsWith("tar") || c.startsWith("useradd")));
  rmTmp(w.tmp);
});
