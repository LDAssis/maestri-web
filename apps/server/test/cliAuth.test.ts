// Menu de CLIs (instalar / entrar): binários falsos no PATH (padrão polish3). Precisa de /bin/sh e de PTY POSIX: pulado no Windows.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const isWindows = process.platform === "win32";
const skip = isWindows ? "binários falsos são scripts sh: rodar em Linux/macOS" : false;

const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "maestri-cliauth-test-")));
const fakeBin = path.join(repo, "fakebin");
const state = path.join(repo, "state");
const home = path.join(repo, "home");
for (const d of [fakeBin, state, home]) fs.mkdirSync(d, { recursive: true });
const fake = (dir: string, name: string, body: string) => fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });

// claude: login por URL + código colado; o "login" é um arquivo na pasta da conta
fake(fakeBin, "claude", `flag="\${CLAUDE_CONFIG_DIR:-$FAKE_STATE/claude-default}"
case "$1 $2" in
"--version "*) echo "2.1.318 (Claude Code)";;
"auth status") if [ -f "$flag/.logged" ]; then echo '{"loggedIn":true,"authMethod":"claude.ai"}'; else echo '{"loggedIn":false,"authMethod":"none"}'; exit 1; fi;;
"auth login")
  echo "Opening browser to sign in..."
  echo "ENV BROWSER=[$BROWSER] CFG=$CLAUDE_CONFIG_DIR DISPLAY=[$DISPLAY]"
  echo "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz"
  printf "Paste code here if prompted > "
  read code
  if [ "$code" = "good-code-12345" ]; then mkdir -p "$flag"; touch "$flag/.logged"; echo "Login successful"; exit 0; fi
  echo "Invalid code. Please make sure the full code was copied."; exit 1;;
"auth logout") rm -f "$flag/.logged"; echo "Logged out";;
esac`);
// codex: device code, sem nada a colar; termina sozinho e grava o auth.json
fake(fakeBin, "codex", `home="\${CODEX_HOME:-$HOME/.codex}"
case "$1 $2" in
"--version "*) echo "codex-cli 0.166.0";;
"login status") if [ -s "$home/auth.json" ]; then echo "Logged in using ChatGPT"; else echo "Not logged in"; exit 1; fi;;
"login --device-auth")
  echo "Follow these steps to sign in with ChatGPT using device code authorization:"
  printf '1. Open this link in your browser and sign in to your account\\n   https://auth.openai.com/codex/device\\n\\n'
  printf '2. Enter this one-time code (expires in 15 minutes)\\n   ABCD-1234\\n\\n'
  sleep 1; mkdir -p "$home"; echo '{"tokens":1}' > "$home/auth.json";;
"logout "*) rm -f "$home/auth.json";;
esac`);
// opencode: menu de provedor (responde por input) e "N credentials" no auth list (sai 0 sempre)
fake(fakeBin, "opencode", `case "$1 $2" in
"--version "*) echo "1.19.5";;
"auth list") echo x >> "$FAKE_STATE/oc-calls"; [ -f "$FAKE_STATE/slow" ] && sleep 3
  if [ -f "$HOME/.oc-logged" ]; then echo "1 credentials"; else echo "0 credentials"; fi;;
"auth login") echo "Select provider"; read p; echo "Go to: https://github.com/login/device"; echo "Enter code: 539E-EF19"; sleep 30;;
esac`);
// agy (instalado depois, pelo "instalador"): TUI que não sai ao logar
fs.writeFileSync(path.join(state, "agy-real"), `#!/bin/sh
case "$1" in
--version) echo "1.4.12";;
models) if [ -f "$HOME/.agy-logged" ]; then echo "gemini-3"; else echo "Error: Please sign in to view available models."; exit 1; fi;;
*) echo "Welcome to the Antigravity CLI. You are currently not signed in."
   echo "Select login method:"; echo "> 1. Google OAuth"; read choice
   echo "Open the URL below in your browser:"; echo " https://accounts.google.com/o/oauth2/auth?client_id=1&state=2"
   echo " After authenticating, copy the code displayed in the browser and paste it below:"; printf " authorization code... "
   read code; [ "$code" = "good-agy-code" ] && touch "$HOME/.agy-logged"; sleep 30;;
esac
`, { mode: 0o755 });
fs.writeFileSync(path.join(state, "agy-installer.sh"), `echo "baixando agy"; sleep 0.6; mkdir -p "$HOME/.local/bin"; cp "$FAKE_STATE/agy-real" "$HOME/.local/bin/agy"; chmod +x "$HOME/.local/bin/agy"; echo "agy instalado"\n`);
fake(fakeBin, "curl", `cat "$FAKE_STATE/agy-installer.sh"`);
// npm: gemini instala (cria o binário); codex falha depois de um tempo; o resto não existe
// gemini (instalado depois, pelo npm falso): TUI com "confiar na pasta" -> método -> URL + código; sem login o -p sai com 41
fs.writeFileSync(path.join(state, "gemini-real"), `#!/bin/sh
case "$1" in
--version) echo "0.66.0";;
-p) if [ -s "$HOME/.gemini/oauth_creds.json" ]; then echo '{"response":"pong"}'; else echo '{"error":{"code":41}}'; exit 41; fi;;
*) echo "Do you trust the files in this folder?"; echo "1. Trust folder"; read t
   echo "How would you like to authenticate for this project?"; echo "1. Sign in with Google"; read m
   echo "Please visit the following URL to authorize the application:"
   echo "https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fcodeassist.google.com%2Fauthcode&state=1"
   printf "Enter the authorization code: "; read code
   if [ "$code" = "good-gemini-code" ]; then mkdir -p "$HOME/.gemini"; echo '{"token":1}' > "$HOME/.gemini/oauth_creds.json"; fi
   sleep 30;;
esac
`, { mode: 0o755 });
fake(fakeBin, "npm", `case "$*" in
"install -g @google/gemini-cli") echo "added 1 package"; sleep 0.6
  cp "$FAKE_STATE/gemini-real" "$FAKE_BIN/gemini"; chmod +x "$FAKE_BIN/gemini"; echo "gemini installed";;
"install -g @openai/codex") echo "npm ERR! boom"; sleep 1; exit 1;;
*) echo "npm: nada a fazer para $*"; exit 1;;
esac`);

// PATH isolado: só os binários falsos + as ferramentas de sistema necessárias (links), sem enxergar CLIs reais da máquina
const sysBin = path.join(repo, "sysbin");
fs.mkdirSync(sysBin);
const realPath = process.env.PATH || "";
for (const tool of ["sh", "bash", "cat", "sleep", "cp", "mkdir", "chmod", "touch", "rm", "env", "dirname", "sed"]) {
  for (const dir of realPath.split(path.delimiter)) {
    const f = path.join(dir, tool);
    if (fs.existsSync(f)) {
      fs.symlinkSync(f, path.join(sysBin, tool));
      break;
    }
  }
}
fs.symlinkSync(process.execPath, path.join(sysBin, "node"));
process.env.PATH = `${fakeBin}${path.delimiter}${sysBin}`;
process.env.HOME = home;
process.env.FAKE_STATE = state;
process.env.FAKE_BIN = fakeBin;
process.env.SHELL = "/bin/sh";
process.env.DISPLAY = ":99";
process.env.REPO_PATH = repo;
process.env.NODE_ENV = "test";
process.env.MAESTRI_TOKEN = "tok-cli";
process.env.MAESTRI_CLI_POLL_MS = "200";

const { fastify } = await import("../src/index.js");
const auth = { authorization: "Bearer tok-cli" };
let port = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(cond: () => T | Promise<T>, what: string, ms = 10000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await cond();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) assert.fail(`timeout: ${what}`);
    await sleep(40);
  }
}
async function api(method: "GET" | "POST" | "DELETE", url: string, body?: unknown) {
  const r = await fastify.inject({ method, url, headers: auth, ...(body === undefined ? {} : { payload: body as any }) });
  return { status: r.statusCode, json: r.json() as any };
}
const job = async (id: string) => (await api("GET", `/api/cli-jobs/${id}`)).json;
const waitJob = (id: string, pred: (j: any) => boolean, what: string, ms?: number) => until(async () => { const j = await job(id); return pred(j) ? j : null; }, what, ms);
const clis = async (account?: string) => (await api("GET", `/api/clis${account ? `?account=${encodeURIComponent(account)}` : ""}`)).json.clis as any[];
const cli = async (id: string, account?: string) => (await clis(account)).find((c) => c.id === id);

before(async () => {
  if (skip) return;
  await fastify.listen({ port: 0, host: "127.0.0.1" });
  port = (fastify.server.address() as any).port;
});
after(async () => {
  await fastify.close();
  fs.rmSync(repo, { recursive: true, force: true });
});

test("exige token e lista os 5 CLIs com versão/instalado/login", { skip }, async () => {
  assert.equal((await fastify.inject({ method: "GET", url: "/api/clis" })).statusCode, 401);
  const r = await api("GET", "/api/clis");
  assert.equal(r.status, 200);
  assert.equal(r.json.installEnabled, true);
  assert.deepEqual(r.json.clis.map((c: any) => c.id), ["claude", "codex", "agy", "opencode", "gemini"]);
  const by = Object.fromEntries(r.json.clis.map((c: any) => [c.id, c]));
  assert.equal(by.claude.installed, true);
  assert.equal(by.claude.version, "2.1.318 (Claude Code)");
  assert.equal(by.claude.path, path.join(fakeBin, "claude"));
  assert.equal(by.claude.loggedIn, false);
  assert.equal(by.claude.accountsSupported, true);
  assert.equal(by.claude.installCmd, "npm install -g @anthropic-ai/claude-code");
  assert.equal(by.codex.version, "codex-cli 0.166.0");
  assert.equal(by.codex.loggedIn, false);
  assert.equal(by.opencode.loggedIn, false); // "0 credentials" com exit 0
  assert.equal(by.opencode.accountsSupported, false);
  assert.equal(by.agy.installed, false);
  assert.equal(by.agy.version, null);
  assert.equal(by.agy.path, null);
  assert.equal(by.gemini.installed, false);
  assert.equal(by.gemini.loggedIn, null);
  // login de CLI não instalado
  const nl = await api("POST", "/api/clis/agy/login");
  assert.equal(nl.status, 400);
  assert.match(nl.json.error, /não está instalado/);
});

test("instalar (npm): job com log ao vivo pelo WS e CLI passa a aparecer instalado", { skip }, async () => {
  const r = await api("POST", "/api/clis/gemini/install");
  assert.equal(r.status, 200);
  assert.equal(r.json.job.cliId, "gemini");
  assert.equal(r.json.job.kind, "install");
  const id = r.json.job.id;
  // segundo job do mesmo CLI enquanto o primeiro roda
  assert.equal((await api("POST", "/api/clis/gemini/install")).status, 409);
  assert.equal((await api("POST", "/api/clis/gemini/login")).status, 400); // ainda não instalado

  const msgs: any[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/cli-job?job=${id}&token=tok-cli`);
  ws.on("message", (m) => msgs.push(JSON.parse(m.toString())));
  await until(() => msgs.some((m) => m.type === "state" && m.state === "done"), "estado done no WS");
  ws.close();
  assert.equal(msgs[0].type, "snapshot");
  assert.equal(msgs[0].job.id, id);
  const streamed = msgs.filter((m) => m.type === "log").map((m) => m.data).join("") + msgs[0].job.log;
  assert.match(streamed, /gemini installed/);

  const j = await job(id);
  assert.equal(j.state, "done");
  assert.equal(j.exitCode, 0);
  assert.ok(j.endedAt);
  assert.match(j.log, /added 1 package/);
  assert.doesNotMatch(j.log, /\x1b/);
  const g = await cli("gemini");
  assert.equal(g.installed, true);
  assert.equal(g.version, "0.66.0");
  assert.equal(g.activeJob, undefined);
});

test("instalar (curl | bash): binário em $HOME/.local/bin entra na detecção", { skip }, async () => {
  const { job: ref } = (await api("POST", "/api/clis/agy/install")).json;
  assert.equal((await cli("agy")).activeJob.id, ref.id);
  const j = await waitJob(ref.id, (x) => x.state === "done" || x.state === "failed", "install agy");
  assert.equal(j.state, "done", j.error);
  assert.match(j.log, /agy instalado/);
  const a = await cli("agy");
  assert.equal(a.installed, true);
  assert.equal(a.path, path.join(home, ".local", "bin", "agy"));
  assert.equal(a.version, "1.4.12");
  assert.equal(a.loggedIn, false);
});

test("instalar: falha reporta erro; 404/403 e job desconhecido", { skip }, async () => {
  const { job: ref } = (await api("POST", "/api/clis/codex/install")).json;
  const j = await waitJob(ref.id, (x) => x.state === "failed", "install codex falha");
  assert.equal(j.exitCode, 1);
  assert.match(j.error, /boom/);
  assert.equal((await api("POST", "/api/clis/nao-existe/install")).status, 404);
  assert.equal((await api("GET", "/api/cli-jobs/nao-existe")).status, 404);
  process.env.MAESTRI_CLI_INSTALL = "0";
  try {
    assert.equal((await api("POST", "/api/clis/opencode/install")).status, 403);
    assert.equal((await api("GET", "/api/clis")).json.installEnabled, false);
  } finally {
    delete process.env.MAESTRI_CLI_INSTALL;
  }
});

test("login claude: URL, waiting_input, código colado (sem vazar), conta isolada, logout", { skip }, async () => {
  assert.equal((await api("POST", "/api/accounts", { program: "claude", name: "work" })).status, 200);
  const dir = path.join(repo, ".maestri_data", "accounts", "claude", "work");

  const { job: ref } = (await api("POST", "/api/clis/claude/login", { account: "work" })).json;
  assert.equal(ref.kind, "login");
  const j = await waitJob(ref.id, (x) => x.state === "waiting_input", "pede o código");
  assert.equal(j.account, "work");
  assert.equal(j.url, "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz");
  assert.match(j.log, /BROWSER=\[\]/); // BROWSER vazio
  assert.match(j.log, /DISPLAY=\[\]/);
  assert.ok(j.log.includes(`CFG=${dir}`), j.log); // env da conta
  assert.equal((await api("POST", `/api/clis/claude/login`, { account: "work" })).status, 409);

  assert.equal((await api("POST", `/api/cli-jobs/${ref.id}/input`, { text: "" })).status, 400);
  assert.equal((await api("POST", `/api/cli-jobs/${ref.id}/input`, { text: "a\nb" })).status, 400);
  assert.equal((await api("POST", `/api/cli-jobs/${ref.id}/input`, { text: "good-code-12345" })).status, 200);
  const done = await waitJob(ref.id, (x) => x.state === "done" || x.state === "failed", "login conclui");
  assert.equal(done.state, "done", done.error + done.log);
  assert.match(done.log, /Login successful/);
  assert.ok(!done.log.includes("good-code-12345"), "o código colado não pode ficar no log");
  assert.equal((await api("POST", `/api/cli-jobs/${ref.id}/input`, { text: "mais-um-texto" })).status, 409);

  assert.equal((await cli("claude", "work")).loggedIn, true);
  assert.equal((await cli("claude", "work")).loginDetail, "claude.ai");
  assert.equal((await cli("claude")).loggedIn, false); // a conta Default é outra
  assert.equal((await api("GET", "/api/clis?account=nao-existe")).status, 404);

  assert.equal((await api("POST", "/api/clis/claude/logout", { account: "work" })).json.ok, true);
  assert.equal((await cli("claude", "work")).loggedIn, false);
});

test("login claude: código errado => failed com a mensagem do CLI", { skip }, async () => {
  const { job: ref } = (await api("POST", "/api/clis/claude/login")).json;
  await waitJob(ref.id, (x) => x.state === "waiting_input", "pede o código");
  await api("POST", `/api/cli-jobs/${ref.id}/input`, { text: "codigo-errado-1" });
  const j = await waitJob(ref.id, (x) => x.state === "failed", "falha");
  assert.equal(j.exitCode, 1);
  assert.match(j.error, /Invalid code/);
  assert.ok(!j.log.includes("codigo-errado-1"));
});

test("login codex (device code): URL e código no WS, sem pedir input, loggedIn ao final", { skip }, async () => {
  const { job: ref } = (await api("POST", "/api/clis/codex/login")).json;
  const msgs: any[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/cli-job?job=${ref.id}&token=tok-cli`);
  ws.on("message", (m) => msgs.push(JSON.parse(m.toString())));
  await until(() => msgs.some((m) => m.type === "state" && m.state === "done"), "codex termina");
  ws.close();
  assert.equal(msgs[0].type, "snapshot");
  const seen = (t: string) => msgs.find((m) => m.type === t);
  const j = await job(ref.id);
  assert.equal(j.url, "https://auth.openai.com/codex/device");
  assert.equal(j.code, "ABCD-1234");
  // url/code chegam pelo stream ou já no snapshot (corrida com a conexão)
  assert.ok((seen("url")?.url ?? msgs[0].job.url) === "https://auth.openai.com/codex/device");
  assert.ok((seen("code")?.code ?? msgs[0].job.code) === "ABCD-1234");
  assert.ok(!msgs.some((m) => m.type === "state" && m.state === "waiting_input"));
  assert.equal((await cli("codex")).loggedIn, true);
  assert.equal((await api("POST", "/api/clis/codex/logout", {})).json.ok, true);
  assert.equal((await cli("codex")).loggedIn, false);
});

test("login agy: responde o menu sozinho, aceita o código e encerra a TUI quando loga", { skip }, async () => {
  const { job: ref } = (await api("POST", "/api/clis/agy/login")).json;
  const j = await waitJob(ref.id, (x) => x.state === "waiting_input", "agy pede o código");
  assert.match(j.url, /^https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?/);
  await api("POST", `/api/cli-jobs/${ref.id}/input`, { text: "good-agy-code" });
  const done = await waitJob(ref.id, (x) => x.state === "done" || x.state === "failed", "agy loga");
  assert.equal(done.state, "done", done.error);
  assert.equal((await cli("agy")).loggedIn, true);
  fs.rmSync(path.join(home, ".agy-logged"), { force: true });
});

test("cancelar e timeout (opencode: menu pelo input)", { skip }, async () => {
  assert.equal((await api("POST", "/api/clis/agy/login", { account: "work" })).status, 400); // só Default
  const { job: a } = (await api("POST", "/api/clis/opencode/login")).json;
  await waitJob(a.id, (x) => /Select provider/.test(x.log), "menu");
  await api("POST", `/api/cli-jobs/${a.id}/input`, { text: "GitHub Copilot" }); // responde o menu
  const j = await waitJob(a.id, (x) => x.code === "539E-EF19", "device code do opencode");
  assert.equal(j.url, "https://github.com/login/device");
  assert.equal((await api("DELETE", `/api/cli-jobs/${a.id}`)).json.ok, true);
  assert.equal((await job(a.id)).state, "cancelled");
  assert.equal((await api("DELETE", `/api/cli-jobs/${a.id}`)).status, 409);
  assert.equal((await api("POST", "/api/clis/opencode/logout", {})).status, 400);

  process.env.MAESTRI_CLI_LOGIN_TIMEOUT_MS = "600";
  try {
    const { job: b } = (await api("POST", "/api/clis/opencode/login")).json;
    const t = await waitJob(b.id, (x) => x.state === "failed", "timeout do login");
    assert.match(t.error, /Tempo esgotado/);
  } finally {
    delete process.env.MAESTRI_CLI_LOGIN_TIMEOUT_MS;
  }
});

test("login gemini: confia na pasta e escolhe o método sozinho, pede o código, status por exit 41 / oauth_creds", { skip }, async () => {
  assert.equal((await cli("gemini")).loggedIn, false); // `gemini -p` sai com 41 sem login
  const { job: ref } = (await api("POST", "/api/clis/gemini/login")).json;
  const j = await waitJob(ref.id, (x) => x.state === "waiting_input", "gemini pede o código");
  assert.match(j.url, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
  assert.match(j.log, /Trust folder/);
  assert.match(j.log, /Sign in with Google/);
  await api("POST", `/api/cli-jobs/${ref.id}/input`, { text: "good-gemini-code" });
  const done = await waitJob(ref.id, (x) => x.state === "done" || x.state === "failed", "gemini loga");
  assert.equal(done.state, "done", done.error);
  assert.ok(!done.log.includes("good-gemini-code"));
  assert.equal((await cli("gemini")).loggedIn, true);
  assert.equal((await cli("gemini")).loginDetail, "oauth_creds.json");
  fs.rmSync(path.join(home, ".gemini"), { recursive: true, force: true });
});

test("cache de status: reaproveita, ?refresh=1 força, job/logout invalida, check lento vira null", { skip }, async () => {
  const f = path.join(state, "oc-calls");
  const calls = () => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).length : 0);
  const oc = async (q = "") => (await api("GET", `/api/clis${q}`)).json.clis.find((c: any) => c.id === "opencode");

  await oc("?refresh=1");
  const c0 = calls();
  await oc();
  await oc();
  assert.equal(calls(), c0, "sem refresh, o status vem do cache");

  fs.writeFileSync(path.join(home, ".oc-logged"), "1"); // mudança "de fora": o cache ainda não sabe
  assert.equal((await oc()).loggedIn, false);
  assert.equal((await oc("?refresh=1")).loggedIn, true);
  assert.equal(calls(), c0 + 1);
  fs.rmSync(path.join(home, ".oc-logged"));
  assert.equal((await oc()).loggedIn, true); // cache do refresh anterior
  assert.equal((await oc("?refresh=true")).loggedIn, false);
  const c1 = calls();

  // job terminando (aqui: cancelado) derruba o cache do CLI; duas listagens simultâneas dividem uma só checagem
  const { job: a } = (await api("POST", "/api/clis/opencode/login")).json;
  await api("DELETE", `/api/cli-jobs/${a.id}`);
  await Promise.all([oc(), oc()]);
  assert.equal(calls(), c1 + 1);
  await oc();
  assert.equal(calls(), c1 + 1);

  // logout também invalida (claude): o status passa a ser reconsultado
  const claudeFlag = path.join(state, "claude-default");
  fs.mkdirSync(claudeFlag, { recursive: true });
  fs.writeFileSync(path.join(claudeFlag, ".logged"), "1");
  assert.equal((await cli("claude")).loggedIn, false); // cache antigo
  await api("POST", "/api/clis/claude/logout", {});
  assert.equal((await cli("claude")).loggedIn, false);
  fs.writeFileSync(path.join(claudeFlag, ".logged"), "1");
  assert.equal((await cli("claude")).loggedIn, false); // cacheado depois do logout
  assert.equal((await api("GET", "/api/clis?refresh=1")).json.clis.find((c: any) => c.id === "claude").loggedIn, true);
  fs.rmSync(claudeFlag, { recursive: true, force: true });

  // check que estoura o teto => loggedIn null, e a listagem não espera pelo check
  fs.writeFileSync(path.join(state, "slow"), "1");
  process.env.MAESTRI_CLI_CHECK_TIMEOUT_MS = "500";
  try {
    const t0 = Date.now();
    assert.equal((await oc("?refresh=1")).loggedIn, null);
    assert.ok(Date.now() - t0 < 2500, `listagem demorou ${Date.now() - t0}ms`);
  } finally {
    delete process.env.MAESTRI_CLI_CHECK_TIMEOUT_MS;
    fs.rmSync(path.join(state, "slow"), { force: true });
  }
  assert.equal((await oc("?refresh=1")).loggedIn, false);
});

test("validações: conta inválida, job inexistente, WS sem token/job", { skip }, async () => {
  assert.equal((await api("POST", "/api/clis/claude/login", { account: "nao-existe" })).status, 404);
  assert.equal((await api("POST", "/api/cli-jobs/x/input", { text: "abcdefgh" })).status, 404);
  const closeCode = (url: string) => new Promise<number>((resolve) => {
    const ws = new WebSocket(url);
    ws.on("close", (c) => resolve(c));
    ws.on("error", () => {});
  });
  assert.equal(await closeCode(`ws://127.0.0.1:${port}/ws/cli-job?job=x&token=errado`), 4401);
  assert.equal(await closeCode(`ws://127.0.0.1:${port}/ws/cli-job?job=nao-existe&token=tok-cli`), 4404);
});
