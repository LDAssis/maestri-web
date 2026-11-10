import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rmTmp } from "./rmtmp.js";

// Menu CLIs & Logins com o isolamento ligado (Fase 3): age na conta "Padrão" (não no /root) e cobre agy + gemini-cli (conta "gemini").
const isWindows = process.platform === "win32";
const skip = isWindows ? "binários falsos são scripts sh" : false;
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maestri-gemacc-test-")));
const fakeBin = path.join(tmp, "bin");
const rootHome = path.join(tmp, "roothome");
const accountsDir = path.join(tmp, "accounts");
const data = path.join(tmp, "data");
for (const d of [fakeBin, rootHome, data]) fs.mkdirSync(d, { recursive: true });
const fake = (name: string, body: string) => fs.writeFileSync(path.join(fakeBin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
fake("gemini", `case "$1" in --version) echo "0.67.0";; -p) if [ -s "$HOME/.gemini/oauth_creds.json" ]; then echo '{"ok":1}'; else exit 41; fi;; esac`);
fake("agy", `case "$1" in --version) echo "1.5.3";; models) if [ -s "$HOME/.gemini/antigravity-cli/antigravity-oauth-token" ]; then echo "gemini-x"; else echo "Error: Please sign in to view available models."; exit 1; fi;; esac`);
fake("claude", `flag="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; case "$1 $2" in "--version "*) echo "2.1.0";; "auth status") if [ -f "$flag/.logged" ]; then echo '{"loggedIn":true,"authMethod":"claude.ai"}'; else echo '{"loggedIn":false}'; exit 1; fi;; esac`);
// login do ROOT existente: se o menu olhasse o /root, mentiria
fs.mkdirSync(path.join(rootHome, ".gemini", "antigravity-cli"), { recursive: true });
fs.writeFileSync(path.join(rootHome, ".gemini", "oauth_creds.json"), '{"root":1}');
fs.writeFileSync(path.join(rootHome, ".gemini", "antigravity-cli", "antigravity-oauth-token"), "root-token");
fs.mkdirSync(path.join(rootHome, ".claude"));
fs.writeFileSync(path.join(rootHome, ".claude", ".logged"), "");
const sysBin = path.join(tmp, "sysbin");
fs.mkdirSync(sysBin);
for (const tool of ["sh", "cat", "env", "dirname"]) {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (fs.existsSync(path.join(dir, tool))) {
      fs.symlinkSync(path.join(dir, tool), path.join(sysBin, tool));
      break;
    }
  }
}
process.env.PATH = `${fakeBin}${path.delimiter}${sysBin}`;
process.env.HOME = rootHome;
process.env.MAESTRI_CLI_CACHE_MS = "0";
const { CliTools } = await import("../src/cliTools.js");
const { AccountStore } = await import("../src/accounts.js");

const byId = (l: any[], id: string) => l.find((c) => c.id === id);

test("sem isolamento: o menu olha o login do root (como sempre) e agy/gemini já aceitam conta", { skip }, async () => {
  const store = new AccountStore(data, { accountsDir });
  const l = await new CliTools(store).list();
  assert.equal(byId(l, "gemini").loggedIn, true);
  assert.equal(byId(l, "agy").loggedIn, true);
  assert.equal(byId(l, "gemini").accountsSupported, true);
  assert.equal(byId(l, "agy").accountsSupported, true);
});

test("com isolamento: não olha o /root; sem a conta Padrão diz deslogado e explica; com ela, olha a pasta da conta (agy E gemini)", { skip }, async () => {
  const store = new AccountStore(data, { accountsDir });
  const tools = new CliTools(store, { isolated: true });
  let l = await tools.list();
  for (const id of ["gemini", "agy", "claude"]) {
    assert.equal(byId(l, id).loggedIn, false, `${id} não pode herdar o login do root`);
    assert.match(byId(l, id).loginDetail, /Padrão" ainda não criada/);
    assert.ok(byId(l, id).version, `${id} ainda mostra a versão`);
  }
  store.create("gemini", "Padrão");
  store.create("claude", "Padrão");
  l = await tools.list();
  assert.equal(byId(l, "gemini").loggedIn, false, "conta existe mas sem login");
  assert.equal(byId(l, "agy").loggedIn, false);
  assert.equal(byId(l, "claude").loggedIn, false);
  const dir = store.dir("gemini", "Padrão");
  fs.writeFileSync(path.join(dir, "oauth_creds.json"), '{"conta":1}');
  l = await tools.list();
  assert.equal(byId(l, "gemini").loggedIn, true, "gemini-cli enxerga o oauth_creds da conta");
  assert.equal(byId(l, "agy").loggedIn, false, "agy ainda sem o token dele");
  fs.mkdirSync(path.join(dir, "antigravity-cli"), { recursive: true });
  fs.writeFileSync(path.join(dir, "antigravity-cli", "antigravity-oauth-token"), "tok");
  l = await tools.list();
  assert.equal(byId(l, "agy").loggedIn, true, "agy enxerga o token da conta pelo HOME de passagem (~/.gemini -> conta)");
  fs.writeFileSync(path.join(store.dir("claude", "Padrão"), ".logged"), "");
  assert.equal(byId(await tools.list(), "claude").loggedIn, true);
  // o HOME de passagem fica fora da pasta de cada programa (não vira uma conta falsa)
  assert.deepEqual(store.list().map((a) => `${a.program}/${a.name}`).sort(), ["claude/Padrão", "gemini/Padrão"]);
  assert.ok(fs.lstatSync(path.join(accountsDir, ".holders", "gemini-Padrão", ".gemini")).isSymbolicLink());
  // conta explícita continua funcionando
  store.create("gemini", "Outra");
  assert.equal(byId(await tools.list("Outra"), "gemini").loggedIn, false);
  assert.equal(byId(await tools.list("Padrão"), "gemini").loggedIn, true);
});

test("com isolamento: o login do menu cria a conta Padrão (nunca escreve no /root) e logout sem conta é 404", { skip }, async () => {
  const store = new AccountStore(path.join(tmp, "data2"), { accountsDir: path.join(tmp, "acc2") });
  fs.mkdirSync(path.join(tmp, "data2"));
  const tools = new CliTools(store, { isolated: true });
  await assert.rejects(() => tools.logout("claude"), /ainda não existe/);
  const before = fs.readdirSync(path.join(rootHome, ".gemini")).sort();
  const job = tools.startLogin("gemini");
  assert.equal(store.find("gemini", "Padrão"), "Padrão");
  assert.equal(tools.job(job.id).account, "Padrão");
  tools.cancel(job.id);
  assert.deepEqual(fs.readdirSync(path.join(rootHome, ".gemini")).sort(), before, "o /root não foi tocado");
});

test("limpeza", () => {
  rmTmp(tmp);
});
