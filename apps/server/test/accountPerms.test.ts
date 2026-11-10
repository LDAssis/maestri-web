import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rmTmp } from "./rmtmp.js";
import { AccountPermWatcher, normalizeAccountPath, normalizeAccountTree } from "../src/accountPerms.js";

// O CLI grava o login com chmod 0600 explícito: o servidor mantém a pasta da conta legível/gravável pelo grupo, sem seguir symlink.
const skip = process.platform === "win32" ? "modos POSIX" : false;
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maestri-accperm-test-")));
const root = path.join(tmp, "accounts");
const acc = path.join(root, "claude", "Padrão");
fs.mkdirSync(acc, { recursive: true });
const outside = path.join(tmp, "fora");
fs.mkdirSync(outside);
const mode = (p: string) => fs.lstatSync(p).mode & 0o7777;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, what: string, ms = 1000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) assert.fail(`timeout (${ms} ms): ${what}`);
    await sleep(20);
  }
}

test("normalizeAccountPath: arquivo 0600 vira g+rw sem o+; diretório g+rwxs; idempotente", { skip }, () => {
  const f = path.join(acc, ".credentials.json");
  fs.writeFileSync(f, "{}", { mode: 0o600 });
  fs.chmodSync(f, 0o600);
  assert.equal(normalizeAccountPath(acc, f), true);
  assert.equal(mode(f), 0o660);
  assert.equal(normalizeAccountPath(acc, f), false, "nada a fazer na 2ª vez");
  const wide = path.join(acc, "aberto.json");
  fs.writeFileSync(wide, "x");
  fs.chmodSync(wide, 0o666);
  normalizeAccountPath(acc, wide);
  assert.equal(mode(wide), 0o660, "o+ removido");
  const d = path.join(acc, "sub");
  fs.mkdirSync(d, { mode: 0o700 });
  fs.chmodSync(d, 0o700);
  normalizeAccountPath(acc, d);
  assert.equal(mode(d), 0o2770);
  assert.equal(normalizeAccountPath(acc, path.join(outside, "x")), false, "fora da pasta da conta: ignorado");
});

test("não segue symlink nem mexe em hard link para fora da conta", { skip }, () => {
  const victim = path.join(outside, "segredo.txt");
  fs.writeFileSync(victim, "x", { mode: 0o600 });
  fs.chmodSync(victim, 0o600);
  fs.symlinkSync(victim, path.join(acc, "link-arquivo"));
  fs.symlinkSync(outside, path.join(acc, "link-dir"));
  fs.linkSync(victim, path.join(acc, "hard"));
  fs.chmodSync(victim, 0o600);
  const before = mode(victim);
  normalizeAccountTree(acc);
  assert.equal(mode(victim), before, "o alvo do symlink/hard link não pode mudar de modo");
  assert.ok(fs.lstatSync(path.join(acc, "link-arquivo")).isSymbolicLink());
  fs.rmSync(path.join(acc, "hard"));
});

test("watcher: arquivo 0600 recriado (tmp+rename) volta a 0660 em < 1 s; symlink plantado não é seguido", { skip }, async () => {
  const w = new AccountPermWatcher(root, { debounceMs: 80, scanMs: 60_000 });
  w.start();
  try {
    const f = path.join(acc, ".credentials.json");
    // o claude renova o token: escreve tmp 0600 e renomeia por cima
    const tmpf = `${f}.tmp.123`;
    fs.writeFileSync(tmpf, '{"token":1}', { mode: 0o600 });
    fs.chmodSync(tmpf, 0o600);
    fs.renameSync(tmpf, f);
    await until(() => mode(f) === 0o660, "credencial voltou a g+rw");
    // de novo (outro projeto renova)
    fs.writeFileSync(tmpf, '{"token":2}', { mode: 0o600 });
    fs.chmodSync(tmpf, 0o600);
    fs.renameSync(tmpf, f);
    await until(() => mode(f) === 0o660, "segunda renovação");
    // subpasta nova e arquivo dentro dela
    fs.mkdirSync(path.join(acc, "novo"), { mode: 0o700 });
    fs.writeFileSync(path.join(acc, "novo", "h.jsonl"), "x", { mode: 0o600 });
    fs.chmodSync(path.join(acc, "novo", "h.jsonl"), 0o600);
    await until(() => mode(path.join(acc, "novo", "h.jsonl")) === 0o660 && mode(path.join(acc, "novo")) === 0o2770, "arquivo em subpasta nova");
    // symlink plantado: NÃO segue
    const victim = path.join(outside, "alvo.txt");
    fs.writeFileSync(victim, "x", { mode: 0o600 });
    fs.chmodSync(victim, 0o600);
    fs.symlinkSync(victim, path.join(acc, "plantado"));
    fs.writeFileSync(path.join(acc, "controle.txt"), "x", { mode: 0o600 });
    fs.chmodSync(path.join(acc, "controle.txt"), 0o600);
    await until(() => mode(path.join(acc, "controle.txt")) === 0o660, "o watcher processou o controle");
    assert.equal(mode(victim), 0o600, "o alvo do symlink plantado foi alterado");
  } finally {
    w.stop();
  }
});

test("watcher: varredura no boot corrige o que já estava 0600 e ignora .holders", { skip }, () => {
  const f = path.join(acc, "antigo.json");
  fs.writeFileSync(f, "x", { mode: 0o600 });
  fs.chmodSync(f, 0o600);
  fs.mkdirSync(path.join(root, ".holders", "gemini-Padrão"), { recursive: true });
  const h = path.join(root, ".holders", "gemini-Padrão", "x");
  fs.writeFileSync(h, "x", { mode: 0o600 });
  fs.chmodSync(h, 0o600);
  const w = new AccountPermWatcher(root, { scanMs: 60_000 });
  assert.ok(w.scanAll() >= 1);
  assert.equal(mode(f), 0o660);
  assert.equal(mode(h), 0o600, ".holders não é conta");
});

test("fim", () => rmTmp(tmp));
