import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ensureAgentContext, skillContent, agentsBlock, SKILL_NAME, ROLE_CANVAS_HINT } from "../src/agentContext.js";
import { writeRoleContext } from "../src/agentSetup.js";
import { rmTmp } from "./rmtmp.js";

// HOME e PATH temporários: nada toca a configuração real do usuário
function sandbox(bins: string[]) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maestri-ctx-")));
  const binDir = path.join(home, "bin");
  fs.mkdirSync(binDir);
  for (const b of bins) fs.writeFileSync(path.join(binDir, b), "#!/bin/sh\n", { mode: 0o755 });
  const env = { HOME: home, PATH: binDir, MAESTRI_AGENT_CONTEXT: "1", NODE_ENV: "test" } as NodeJS.ProcessEnv;
  return { home, env };
}
const read = (f: string) => fs.readFileSync(f, "utf-8");

test("instala a skill maestri-web para claude e agy e o bloco no AGENTS.md de codex e opencode", () => {
  const { home, env } = sandbox(["claude", "agy", "codex", "opencode"]);
  ensureAgentContext(env);
  const claudeSkill = path.join(home, ".claude", "skills", SKILL_NAME, "SKILL.md");
  const agySkill = path.join(home, ".gemini", "config", "skills", SKILL_NAME, "SKILL.md");
  for (const f of [claudeSkill, agySkill, path.join(home, ".codex", "skills", SKILL_NAME, "SKILL.md")]) {
    assert.ok(fs.existsSync(f), f);
    assert.match(read(f), /^---\nname: maestri-web\ndescription: .*MAESTRI_NODE_ID/);
    assert.match(read(f), /maestri list/);
  }
  for (const f of [path.join(home, ".codex", "AGENTS.md"), path.join(home, ".config", "opencode", "AGENTS.md")]) {
    assert.match(read(f), /maestri-web:start[\s\S]*MAESTRI_NODE_ID[\s\S]*maestri say[\s\S]*maestri-web:end/);
  }
  rmTmp(home);
});

test("AGENTS.md do usuário é preservado e o bloco não se duplica", () => {
  const { home, env } = sandbox(["codex"]);
  const agents = path.join(home, ".codex", "AGENTS.md");
  fs.mkdirSync(path.dirname(agents), { recursive: true });
  fs.writeFileSync(agents, "# Minhas regras\nsempre responda em português\n");
  ensureAgentContext(env);
  ensureAgentContext({ ...env }); // segunda vez (outro terminal)
  const text = read(agents);
  assert.match(text, /^# Minhas regras\nsempre responda em português\n/);
  assert.equal(text.match(/maestri-web:start/g)?.length, 1);
  // bloco desatualizado é substituído no lugar
  fs.writeFileSync(agents, text.replace(/## Maestri Web[^\n]*/, "## versão antiga"));
  ensureAgentContext({ ...env, PATH: env.PATH + path.delimiter + "/nao-existe" });
  assert.doesNotMatch(read(agents), /versão antiga/);
  assert.equal(read(agents).match(/maestri-web:start/g)?.length, 1);
  rmTmp(home);
});

test("contas: CLAUDE_CONFIG_DIR e CODEX_HOME recebem as instruções", () => {
  const { home, env } = sandbox(["claude", "codex"]);
  const claudeAcc = path.join(home, "contas", "claude", "Work");
  const codexAcc = path.join(home, "contas", "codex", "Work");
  ensureAgentContext({ ...env, CLAUDE_CONFIG_DIR: claudeAcc, CODEX_HOME: codexAcc });
  assert.ok(fs.existsSync(path.join(claudeAcc, "skills", SKILL_NAME, "SKILL.md")));
  assert.ok(fs.existsSync(path.join(codexAcc, "AGENTS.md")));
  rmTmp(home);
});

test("não escreve para CLIs ausentes nem quando desligado", () => {
  const { home, env } = sandbox([]);
  ensureAgentContext(env);
  assert.equal(fs.existsSync(path.join(home, ".claude")), false);
  assert.equal(fs.existsSync(path.join(home, ".codex")), false);
  const on = sandbox(["claude"]);
  ensureAgentContext({ ...on.env, MAESTRI_AGENT_CONTEXT: "0" });
  assert.equal(fs.existsSync(path.join(on.home, ".claude")), false);
  // em teste fica desligado por padrão
  ensureAgentContext({ ...on.env, MAESTRI_AGENT_CONTEXT: undefined });
  assert.equal(fs.existsSync(path.join(on.home, ".claude")), false);
  rmTmp(home);
  rmTmp(on.home);
});

test("a skill vem do SKILL.md do repositório e os arquivos de role citam o canvas", () => {
  assert.match(skillContent(), /maestri chat reply|maestri say/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maestri-role-"));
  writeRoleContext(dir, "Você revisa código.", "/projeto");
  for (const f of ["CLAUDE.md", "AGENTS.md"]) {
    const t = read(path.join(dir, f));
    assert.ok(t.includes(ROLE_CANVAS_HINT), f);
    assert.match(t, /<your_assigned_role>\nVocê revisa código\./);
  }
  rmTmp(dir);
});

// Documentação x CLI: cada `maestri <cmd> [sub]` citado no SKILL.md e no bloco do AGENTS.md tem que existir de verdade
test("todo subcomando citado no SKILL.md existe na CLI", () => {
  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/maestri");
  const text = read(path.resolve(path.dirname(cli), "../../../SKILL.md")) + agentsBlock("x");
  const WITH_SUBVERBS = new Set(["note", "portal", "floor", "routine", "band", "role", "preset", "account", "workspace", "chat", "recall", "partitura"]);
  const helps = new Map<string, string | null>(); // null = comando desconhecido
  const helpOf = (cmd: string) => {
    if (!helps.has(cmd)) {
      const r = spawnSync(process.execPath, [cli, cmd, "--help"], { encoding: "utf-8", env: { ...process.env, MAESTRI_API_URL: "" } });
      helps.set(cmd, r.status === 0 ? r.stdout : null);
    }
    return helps.get(cmd)!;
  };
  const bad: string[] = [];
  for (const m of text.matchAll(/\bmaestri ([a-z][a-z-]*)(?: ([a-z][a-z-]*))?/g)) {
    const [, cmd, sub] = m;
    if (cmd === "help") continue;
    const h = helpOf(cmd);
    if (h === null) bad.push(`maestri ${cmd}: comando não existe`);
    else if (sub && WITH_SUBVERBS.has(cmd) && h.trim() !== "undefined" && !new RegExp(`(?<![\\w-])${sub}(?![\\w-])`).test(h)) bad.push(`maestri ${cmd} ${sub}: não aparece no help de ${cmd}`);
  }
  assert.deepEqual([...new Set(bad)], []);
});

test("a skill e o bloco só valem no Maestri Web: MAESTRI_NODE_ID liga, só MAESTRI_TERMINAL_ID (nativo) desliga", () => {
  const skill = skillContent();
  assert.match(skill, /^---\nname: maestri-web\ndescription: Use SOMENTE quando .*MAESTRI_NODE_ID.*NÃO use se .*MAESTRI_TERMINAL_ID/);
  assert.match(skill.split("\n---\n")[1], /^> \*\*Só vale no Maestri Web/);
  assert.match(agentsBlock("x"), /MAESTRI_NODE_ID.*MAESTRI_TERMINAL_ID.*ignore este bloco/s);
});
