import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureAgentContext, skillContent, SKILL_NAME, ROLE_CANVAS_HINT } from "../src/agentContext.js";
import { writeRoleContext } from "../src/agentSetup.js";

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
  fs.rmSync(home, { recursive: true, force: true });
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
  fs.rmSync(home, { recursive: true, force: true });
});

test("contas: CLAUDE_CONFIG_DIR e CODEX_HOME recebem as instruções", () => {
  const { home, env } = sandbox(["claude", "codex"]);
  const claudeAcc = path.join(home, "contas", "claude", "Work");
  const codexAcc = path.join(home, "contas", "codex", "Work");
  ensureAgentContext({ ...env, CLAUDE_CONFIG_DIR: claudeAcc, CODEX_HOME: codexAcc });
  assert.ok(fs.existsSync(path.join(claudeAcc, "skills", SKILL_NAME, "SKILL.md")));
  assert.ok(fs.existsSync(path.join(codexAcc, "AGENTS.md")));
  fs.rmSync(home, { recursive: true, force: true });
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
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(on.home, { recursive: true, force: true });
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
  fs.rmSync(dir, { recursive: true, force: true });
});
