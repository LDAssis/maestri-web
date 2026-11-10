import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import WebSocket from "ws";

// Integração Linux do isolamento (Fase 3). Cria usuários de SO DE VERDADE, por isso só roda com root + MAESTRI_ISOLATION_TEST=1.
// Tudo em /tmp/mtest-iso-<pid>, usuários mtest-* e grupos mtestac-*, apagados no after (e conferidos). Sem remount/sysctl/pacotes.
// Cgroup (systemd-run --scope + slice) só com MAESTRI_ISOLATION_TEST_CGROUP=1.
const enabled = process.platform === "linux" && process.getuid?.() === 0 && process.env.MAESTRI_ISOLATION_TEST === "1";

if (!enabled) {
  test("integração Linux do isolamento (pulado: precisa de root + MAESTRI_ISOLATION_TEST=1)", { skip: true }, () => {});
} else {
  const base = `/tmp/mtest-iso-${process.pid}`;
  const repo = path.join(base, "principal");
  const dataDir = path.join(repo, ".maestri_data");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.chmodSync(base, 0o711); // o usuário do projeto atravessa (como /srv/maestri em produção)
  fs.chmodSync(dataDir, 0o700);
  fs.writeFileSync(path.join(dataDir, "dados-secretos.json"), '{"segredo":1}', { mode: 0o600 });
  const cgroup = process.env.MAESTRI_ISOLATION_TEST_CGROUP === "1";
  Object.assign(process.env, {
    NODE_ENV: "test", REPO_PATH: repo, MAESTRI_TOKEN: "chave-interna-linux", MAESTRI_PR_POLL_MS: "3600000",
    MAESTRI_ISOLATION: "1", MAESTRI_ISOLATION_ROOT: path.join(base, "srv"), MAESTRI_ISOLATION_USER_PREFIX: "mtest-", MAESTRI_ISOLATION_GROUP_PREFIX: "mtestac-",
    MAESTRI_ISOLATION_CGROUP: cgroup ? "1" : "0", MAESTRI_TOK_DIR: path.join(base, "srv", "tok"),
    SERVER_SECRET_XYZ: "vaza-do-servidor", MAESTRI_AGENT_CONTEXT: "1", // contexto ligado: exercita o que o servidor (root) escreve no HOME do projeto
  });
  fs.mkdirSync(path.join(base, "srv"), { recursive: true });
  fs.chmodSync(path.join(base, "srv"), 0o711);

  const { fastify, terminalTokens, iso } = await import("../src/index.js");
  const { gitExecFile, mkdirOwned } = await import("../src/runAs.js");
  const internal = { authorization: "Bearer chave-interna-linux" };
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
  const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const tryShOut = (cmd: string, args: string[]) => {
    try {
      return sh(cmd, args);
    } catch {
      return null;
    }
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 10000) {
    const end = Date.now() + ms;
    while (!(await cond())) {
      if (Date.now() > end) assert.fail(`timeout: ${what}`);
      await sleep(50);
    }
  }
  async function call(method: string, url: string, headers: Record<string, string> = internal, payload?: unknown) {
    const r = await fastify.inject({ method: method as any, url, headers, payload: payload as any });
    let body: any = null;
    try {
      body = r.json();
    } catch {}
    return { status: r.statusCode, body };
  }
  let port = 0;

  // terminal pelo WebSocket: run() digita o comando e espera o marcador com o código de saída
  function term(project: string, node: string) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal?project=${project}&node=${node}&token=chave-interna-linux`);
    let buf = "";
    let n = 0;
    let ready = false;
    const tag = Math.random().toString(36).slice(2, 6); // marcador único: o scrollback reproduzido de uma sessão antiga não confunde
    ws.on("message", (d, bin) => {
      if (!bin) buf += d.toString();
    });
    ws.on("error", () => {});
    // largura grande: o readline do bash não quebra a linha digitada (e a saída fica em uma linha só)
    ws.on("open", () => ws.send(JSON.stringify({ type: "resize", cols: 500, rows: 50 })));
    return {
      ws,
      get all() {
        return buf;
      },
      async run(cmd: string, ms = 20000) {
        const mark = `@@${tag}-${++n}@@`;
        await until(() => ws.readyState === 1, "ws aberto");
        if (!ready) {
          await sleep(400); // deixa chegar o scrollback da sessão (se já existia) antes de marcar onde a saída começa
          ready = true;
        }
        const start = buf.length;
        ws.send(`${cmd}; echo "${mark}$?"\r`);
        const re = new RegExp(`${mark}(\\d+)`);
        await until(() => re.test(buf.slice(start)), `saída de: ${cmd}`, ms);
        const text = buf.slice(start);
        return { out: text.replace(/\r/g, ""), code: Number(re.exec(text)![1]) };
      },
      close: () => ws.close(),
    };
  }
  // Valor de CHAVE=... na saída (sem ANSI, ignorando a linha digitada que ecoa o comando); vai até a próxima " OUTRA=" ou o fim da linha
  const clean = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
  const val = (out: string, key: string) => {
    for (const l of clean(out).split("\n")) {
      if (l.includes("$(") || l.includes("printenv")) continue;
      const m = new RegExp(`(?:^|\\s)${key}=(.*?)(?=\\s[A-Z_]{1,9}=|$)`).exec(l);
      if (m) return m[1].trim();
    }
    return "";
  };

  let adminTok = "";
  let accountDir = "";
  let accountGroup = "";
  let geminiDir = "";
  let geminiGroup = "";
  const created: string[] = [];
  const proj: Record<string, { id: string; dir: string; user: string; uid: number }> = {};

  async function newProject(name: string) {
    const r = await call("POST", "/api/projects", internal, { name });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const id = r.body.project.id as string;
    created.push(id);
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, "projects.json"), "utf8")).find((p: any) => p.id === id);
    proj[name] = { id, dir: saved.repoPath, user: saved.osUser, uid: saved.uid };
    const c = await call("POST", `/api/projects/${id}/canvas`, internal, {
      nodes: [
        { id: "t", type: "agentTerminal", position: { x: 0, y: 0 }, data: { title: "T" } },
        { id: "ag", type: "agentTerminal", position: { x: 300, y: 0 }, data: { title: "AG", baseCmd: "claude" } },
        { id: "agw", type: "agentTerminal", position: { x: 600, y: 0 }, data: { title: "AGW", baseCmd: "agy" } },
      ],
      edges: [],
    });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    return r.body.project;
  }

  before(async () => {
    await fastify.listen({ port: 0, host: "127.0.0.1" });
    port = (fastify.server.address() as any).port;
    const s = await call("POST", "/api/auth/setup", {}, { setupKey: "chave-interna-linux", name: "Admin Linux", email: "admin.linux@example.com", password: "Zebra!Lapis42xx" });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    adminTok = s.body.token;
    // conta "Padrão" (grupo mtestac-claude-padrao-xxxx, pasta root:grupo 2770)
    const a = await call("POST", "/api/accounts", internal, { program: "claude", name: "Padrão" });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    accountDir = path.join(iso.cfg.accountsDir, "claude", "Padrão");
    accountGroup = iso.groupFor("claude", "Padrão");
    // conta gemini (agy + gemini-cli): criada ANTES dos projetos? não: depois, para exercitar o onChange que ressincroniza os grupos
    await newProject("A");
    await newProject("B");
    const gm = await call("POST", "/api/accounts", internal, { program: "gemini", name: "Padrão" });
    assert.equal(gm.status, 200, JSON.stringify(gm.body));
    geminiDir = path.join(iso.cfg.accountsDir, "gemini", "Padrão");
    geminiGroup = iso.groupFor("gemini", "Padrão");
    fs.writeFileSync(path.join(proj.B.dir, "segredo-b.txt"), "SEGREDO-DE-B");
    fs.chownSync(path.join(proj.B.dir, "segredo-b.txt"), proj.B.uid, proj.B.uid);
    fs.chmodSync(path.join(proj.B.dir, "segredo-b.txt"), 0o640);
  });

  after(async () => {
    try {
      for (const id of created) await call("DELETE", `/api/projects/${id}`, internal, { deleteFolder: true }).catch(() => {});
      await fastify.close();
    } finally {
      // rede de segurança: nenhum mtest-* sobra, mesmo se um teste falhar no meio
      for (const line of (tryShOut("getent", ["passwd"]) ?? "").split("\n")) {
        const u = line.split(":")[0];
        if (u.startsWith("mtest-")) {
          tryShOut("pkill", ["-KILL", "-u", u]);
          tryShOut("userdel", [u]);
        }
      }
      for (const line of (tryShOut("getent", ["group"]) ?? "").split("\n")) {
        const g = line.split(":")[0];
        if (g.startsWith("mtest-") || g.startsWith("mtestac-")) tryShOut("groupdel", [g]);
      }
      fs.rmSync(base, { recursive: true, force: true });
      if (cgroup) tryShOut("systemctl", ["stop", "mtest-proj.slice", "mtest.slice"]); // slices pai (o hífen no nome cria a hierarquia)
    }
  });

  test("criar projeto: usuário mtest-<id> uid 20000+, grupo próprio, HOME/TMPDIR 0700, pasta 2750 do usuário, isolated:true", async () => {
    const list = (await call("GET", "/api/projects", { authorization: `Bearer ${adminTok}` })).body as any[];
    const A = list.find((p) => p.id === proj.A.id);
    assert.equal(A.isolated, true);
    assert.equal(A.osUser, proj.A.user, "o admin vê o usuário de SO");
    assert.match(proj.A.user, /^mtest-proj-/);
    assert.ok(proj.A.uid >= 20000 && proj.B.uid === proj.A.uid + 1, `uids ${proj.A.uid} ${proj.B.uid}`);
    assert.equal(sh("id", ["-u", proj.A.user]), String(proj.A.uid));
    const st = fs.statSync(proj.A.dir);
    assert.deepEqual([st.uid, st.mode & 0o7777], [proj.A.uid, 0o2750]);
    for (const d of [iso.homeOf(proj.A.user), iso.tmpOf(proj.A.user)]) assert.equal(fs.statSync(d).mode & 0o777, 0o700, d);
    assert.equal(fs.statSync(path.join(proj.A.dir, ".git")).uid, proj.A.uid, "o git init do servidor também passou ao usuário");
    assert.equal(JSON.parse(fs.readFileSync(path.join(base, "principal", ".maestri_data", "isolation.json"), "utf8")).nextUid, proj.B.uid + 1);
    assert.equal(fs.statSync(path.join(dataDir, "projects.json")).mode & 0o777, 0o600);
  });

  test("PTY: roda com o uid certo, grupos sem 0, umask 007, HOME/TMPDIR do projeto, no-new-privs, sem sudo", async () => {
    const t = term(proj.A.id, "t");
    const r = await t.run("echo UID=$(id -u) GID=$(id -g) GR=$(id -G) GN=$(id -nG) H=$HOME T=$TMPDIR U=$USER P=$(pwd) M=$(umask) NNP=$(awk '/NoNewPrivs/{print $2}' /proc/self/status) SH=$SHELL");
    const o = r.out;
    assert.equal(val(o, "UID"), String(proj.A.uid), JSON.stringify({ proj, o: clean(o).slice(-700) }));
    assert.equal(val(o, "GID"), sh("id", ["-g", proj.A.user]), "gid primário do usuário (o gid pode diferir do uid se o número já estava em uso)");
    assert.ok(!val(o, "GR").split(" ").includes("0"), `grupos do PTY não incluem root: ${val(o, "GR")}`);
    assert.ok(val(o, "GN").includes(accountGroup), `entrou no grupo da conta liberada ao dono (admin): ${val(o, "GN")}`);
    assert.equal(val(o, "H"), iso.homeOf(proj.A.user));
    assert.equal(val(o, "T"), iso.tmpOf(proj.A.user));
    assert.equal(val(o, "U"), proj.A.user);
    assert.equal(val(o, "P"), proj.A.dir);
    assert.equal(val(o, "M"), "0007");
    assert.equal(val(o, "NNP"), "1");
    assert.ok(proj.A.uid > 0);
    const sudo = await t.run("sudo -n true 2>&1");
    assert.notEqual(sudo.code, 0, "sudo falha dentro do terminal");
    const su = await t.run("su -c id root </dev/null 2>&1 | head -1; echo done");
    assert.ok(!/uid=0/.test(su.out.replace(/su -c id root[^\n]*\n/, "")), "su não vira root");
    const f = await t.run("touch novo.txt && echo MODE=$(stat -c %a novo.txt) OWNER=$(stat -c %U novo.txt)");
    assert.equal(val(f.out, "MODE"), "660", "arquivos novos nascem 0660 (umask 007; o grupo primário é só do usuário)");
    assert.equal(val(f.out, "OWNER"), proj.A.user);
    t.close();
  });

  test("PTY: ambiente limpo (sem MAESTRI_TOKEN nem segredos do servidor); só a lista branca e o arquivo do token", async () => {
    const t = term(proj.A.id, "t");
    const r = await t.run("echo NAMES=$(env | cut -d= -f1 | sort | tr '\\n' ' '); echo TOKCOUNT=$(env | grep -c '^MAESTRI_TOKEN=') SEC=$(env | grep -c SERVER_SECRET_XYZ) TF=$MAESTRI_TOKEN_FILE");
    assert.equal(val(r.out, "TOKCOUNT"), "0");
    assert.equal(val(r.out, "SEC"), "0");
    assert.ok(!r.out.includes("chave-interna-linux") && !r.out.includes("vaza-do-servidor"));
    const names = val(r.out, "NAMES");
    for (const must of ["HOME", "PATH", "MAESTRI_API_URL", "MAESTRI_NODE_ID", "MAESTRI_PROJECT_ID", "MAESTRI_TOKEN_FILE", "TERM", "USER", "TMPDIR"]) assert.ok(names.includes(must), `${must} em: ${names}`);
    const tf = val(r.out, "TF");
    assert.ok(tf.startsWith(terminalTokens.directory + "/"), tf);
    const meta = await t.run(`echo OWN=$(stat -c %U ${tf}) MODE=$(stat -c %a ${tf}); ls ${terminalTokens.directory} 2>&1 | head -1`);
    assert.equal(val(meta.out, "OWN"), proj.A.user);
    assert.equal(val(meta.out, "MODE"), "400");
    assert.match(meta.out, /Permission denied/, "o diretório dos tokens não lista");
    assert.equal(fs.statSync(terminalTokens.directory).mode & 0o777, 0o711);
    t.close();
  });

  test("isolamento de leitura: outro projeto, .maestri_data, /root, /etc/maestri-web.env e o token de outro terminal", async () => {
    const tb = term(proj.B.id, "t");
    const tbFile = val((await tb.run("echo F=$(printenv MAESTRI_TOKEN_FILE)")).out, "F");
    const t = term(proj.A.id, "t");
    const script = path.join(proj.A.dir, "leitura.sh");
    fs.writeFileSync(
      script,
      [
        `echo B_SECRET=$(cat ${proj.B.dir}/segredo-b.txt 2>&1 | head -1)`,
        `echo B_LS=$(ls ${proj.B.dir} 2>&1 | head -1)`,
        `echo B_HOME=$(ls ${iso.homeOf(proj.B.user)} 2>&1 | head -1)`,
        `echo B_TMP=$(touch ${iso.tmpOf(proj.B.user)}/x 2>&1 | head -1)`,
        `echo DATA=$(ls ${dataDir} 2>&1 | head -1)`,
        `echo DATAF=$(cat ${dataDir}/dados-secretos.json 2>&1 | head -1)`,
        `echo ROOT=$(ls /root 2>&1 | head -1)`,
        `echo ENVF=$(test -r /etc/maestri-web.env && echo LEU || echo NAO)`,
        `echo OTHERTOK=$(cat ${tbFile} 2>&1 | head -1)`,
        `echo OWNTOK=$(head -c 3 $MAESTRI_TOKEN_FILE)`,
        `echo PROC=$(cat /proc/1/environ 2>&1 | head -1)`,
        `echo WRITESYS=$(touch /etc/mtest-probe 2>&1 | head -1)`,
      ].join("\n") + "\n",
    );
    fs.chownSync(script, proj.A.uid, proj.A.uid);
    const r = await t.run("bash leitura.sh");
    for (const k of ["B_SECRET", "B_LS", "B_HOME", "B_TMP", "DATA", "DATAF", "ROOT", "OTHERTOK", "PROC"]) assert.match(val(r.out, k), /Permission denied/, `${k}: ${val(r.out, k)}`);
    assert.equal(val(r.out, "ENVF"), "NAO");
    assert.equal(val(r.out, "OWNTOK"), "mt_", "o próprio token ele lê");
    assert.ok(!/SEGREDO-DE-B/.test(r.out.replace(/echo B_SECRET[^\n]*/, "")));
    assert.match(val(r.out, "WRITESYS"), /Permission denied|Read-only/);
    assert.ok(!fs.existsSync("/etc/mtest-probe"));
    t.close();
    tb.close();
  });

  test("token do terminal: API do próprio projeto (CLI maestri funciona); outro projeto/admin/lista = 403; revogado ao matar/reiniciar", async () => {
    const t = term(proj.A.id, "t");
    // CLI maestri dentro do PTY lê MAESTRI_TOKEN_FILE
    const cli = await t.run("maestri context 2>&1 | head -3");
    assert.match(cli.out, /Você: T/, cli.out);
    fs.writeFileSync(path.join(proj.A.dir, "probe.mjs"), `
const t = fs.readFileSync(process.env.MAESTRI_TOKEN_FILE, "utf8").trim();
const u = process.env.MAESTRI_API_URL;
const g = (p, m = "GET") => fetch(u + p, { method: m, headers: { authorization: "Bearer " + t, "content-type": "application/json" }, body: m === "POST" ? "{}" : undefined }).then((r) => r.status);
const me = process.env.MAESTRI_PROJECT_ID;
const out = await Promise.all([
  g("/projects/" + me + "/nodes/t/context"), g("/projects/" + process.argv[2] + "/canvas"), g("/projects/" + process.argv[2] + "/nodes/t/context"),
  g("/projects"), g("/admin/users"), g("/admin/invites", "POST"), g("/accounts"), g("/settings/global"), g("/clis"), g("/users/directory"),
  g("/projects/" + me + "/nodes/t/workspaces"), g("/projects/" + me + "/members"), g("/projects/" + me + "/nodes/ag/context"),
]);
console.log("ST=" + out.join(","));
`.replace(/^/, "import fs from 'node:fs';\n"));
    fs.chownSync(path.join(proj.A.dir, "probe.mjs"), proj.A.uid, proj.A.uid);
    const r = await t.run(`node probe.mjs ${proj.B.id}`);
    // próprio nó 200 | canvas de B 403 | nó de B 403 | /projects 403 | admin 403 | convite 403 | contas 403 | settings 403 | clis 403 | diretório 403 | workspaces 403 | members 403 | outro nó do mesmo projeto 403
    assert.equal(val(r.out, "ST"), "200,403,403,403,403,403,403,403,403,403,403,403,403", r.out);
    // revoga: matar o PTY invalida o token e apaga o arquivo; reiniciar troca por outro
    const tokenFile = val((await t.run("echo F=$(printenv MAESTRI_TOKEN_FILE)")).out, "F");
    const token = fs.readFileSync(tokenFile, "utf8");
    assert.equal((await call("GET", `/api/projects/${proj.A.id}/nodes/t/context`, bearer(token))).status, 200);
    assert.equal((await call("POST", `/api/projects/${proj.A.id}/sessions/t/restart`)).status, 200);
    await until(() => !fs.existsSync(tokenFile), "arquivo do token antigo removido");
    assert.equal((await call("GET", `/api/projects/${proj.A.id}/nodes/t/context`, bearer(token))).status, 401, "token antigo revogado no restart");
    const r2 = await t.run("echo F=$(printenv MAESTRI_TOKEN_FILE)");
    const file2 = val(r2.out, "F");
    assert.notEqual(file2, tokenFile);
    const token2 = fs.readFileSync(file2, "utf8");
    assert.equal((await call("GET", `/api/projects/${proj.A.id}/nodes/t/context`, bearer(token2))).status, 200);
    assert.equal((await call("DELETE", `/api/projects/${proj.A.id}/sessions/t`)).status, 200);
    assert.equal((await call("GET", `/api/projects/${proj.A.id}/nodes/t/context`, bearer(token2))).status, 401, "token revogado ao matar o PTY");
    assert.ok(!fs.existsSync(file2));
    t.close();
  });

  test("conta gemini (agy): ~/.gemini do PTY é um LINK para a conta; login 0600 de root vira legível pelo grupo após normalizar; dois projetos compartilham", async () => {
    assert.ok((tryShOut("id", ["-nG", proj.A.user]) ?? "").includes(geminiGroup), "criar a conta ressincronizou os grupos dos projetos do admin");
    // login feito pelo servidor (root) deixa 0600 root:root: o projeto não leria
    fs.mkdirSync(path.join(geminiDir, "antigravity-cli"), { recursive: true });
    fs.writeFileSync(path.join(geminiDir, "antigravity-cli", "antigravity-oauth-token"), "TOKEN-AGY", { mode: 0o600 });
    fs.writeFileSync(path.join(geminiDir, "oauth_creds.json"), '{"gemini":1}', { mode: 0o600 });
    const a = term(proj.A.id, "agw");
    // o watcher de permissões (accountPerms.ts) normaliza o 0600 de root para o grupo sozinho, sem chamar ensureAccountDir
    await until(() => (fs.statSync(path.join(geminiDir, "antigravity-cli", "antigravity-oauth-token")).mode & 0o060) === 0o060, "watcher normalizou o login 0600", 2500);
    const r = await a.run("echo L=$(readlink ~/.gemini) T=$(cat ~/.gemini/antigravity-cli/antigravity-oauth-token) K=$(printenv MAESTRI_ACCOUNT_LINK_GEMINI) C=$(cat ~/.gemini/oauth_creds.json)");
    assert.equal(val(r.out, "L"), geminiDir);
    assert.equal(val(r.out, "T"), "TOKEN-AGY");
    assert.equal(val(r.out, "K"), "", "a chave reservada não vai para o ambiente do terminal");
    assert.equal(val(r.out, "C"), '{"gemini":1}');
    assert.equal(fs.lstatSync(path.join(iso.homeOf(proj.A.user), ".gemini")).uid, proj.A.uid, "o link é do usuário do projeto");
    // o projeto grava na conta (refresh de token) e o OUTRO projeto da mesma conta consegue regravar (grupo rw, umask 007)
    const w = await a.run("echo novo > ~/.gemini/antigravity-cli/refresh && echo M=$(stat -c %a ~/.gemini/antigravity-cli/refresh) G=$(stat -c %G ~/.gemini/antigravity-cli/refresh)");
    assert.equal(val(w.out, "M"), "660");
    assert.equal(val(w.out, "G"), path.basename(geminiGroup));
    const b = term(proj.B.id, "agw");
    const wb = await b.run("echo L=$(readlink ~/.gemini) && echo mais >> ~/.gemini/antigravity-cli/refresh && echo APPENDED=$(wc -l < ~/.gemini/antigravity-cli/refresh)");
    assert.equal(val(wb.out, "L"), geminiDir);
    assert.equal(val(wb.out, "APPENDED"), "2", "o outro projeto regrava o arquivo criado pelo primeiro");
    // projeto externo nunca ganha link (o ~/.gemini do root é o login do admin)
    assert.ok(!fs.existsSync("/tmp/.gemini-should-not-exist"));
    a.close();
    b.close();
  });

  test("contas: login gravado com chmod 0600 por um projeto continua legível (e regravável) pelos outros da conta — claude e gemini/agy", async () => {
    const credFile = path.join(accountDir, ".credentials.json");
    const agyFile = path.join(geminiDir, "antigravity-cli", "antigravity-oauth-token");
    const settle = async (f: string) => {
      await until(() => (fs.statSync(f).mode & 0o777) === 0o660, `${f} normalizado para 0660`, 2500);
    };
    const a = term(proj.A.id, "t");
    const b = term(proj.B.id, "t");
    // projeto A loga: o CLI grava 0600 (chmod explícito, ignora umask)
    await a.run(`echo TOKEN-A > ${credFile} && chmod 600 ${credFile} && mkdir -p ${geminiDir}/antigravity-cli && echo AGY-A > ${agyFile} && chmod 600 ${agyFile}`);
    await settle(credFile);
    await settle(agyFile);
    assert.equal(fs.statSync(credFile).uid, proj.A.uid, "continua sendo do uid que gravou");
    const rb = await b.run(`echo C=$(cat ${credFile}) G=$(cat ${agyFile})`);
    assert.equal(val(rb.out, "C"), "TOKEN-A", "o projeto B lê o login gravado pelo A");
    assert.equal(val(rb.out, "G"), "AGY-A");
    // B renova (tmp 0600 + rename, como o claude): o A precisa continuar lendo e vice-versa
    await b.run(`echo TOKEN-B > ${credFile}.tmp && chmod 600 ${credFile}.tmp && mv ${credFile}.tmp ${credFile}`);
    await settle(credFile);
    assert.equal(fs.statSync(credFile).uid, proj.B.uid);
    const ra = await a.run(`echo C=$(cat ${credFile}) && echo novo >> ${credFile} && echo APPENDED=sim`);
    assert.equal(val(ra.out, "C"), "TOKEN-B", "o projeto A lê a renovação feita pelo B");
    assert.equal(val(ra.out, "APPENDED"), "sim", "e consegue regravar o arquivo que o B criou");
    // ninguém de fora do grupo enxerga (o+ nunca)
    assert.equal(fs.statSync(credFile).mode & 0o007, 0);
    a.close();
    b.close();
  });

  test("contas: Default usa a conta Padrão do dono (env), grupo da conta escreve na pasta; revogar tira o grupo, reinicia o PTY e bloqueia o agente", async () => {
    const ag = term(proj.B.id, "ag");
    const r = await ag.run("echo CFG=$CLAUDE_CONFIG_DIR GN=$(id -nG); touch " + accountDir + "/probe-b && echo WROTE=sim");
    assert.equal(val(r.out, "CFG"), accountDir, "Default → Padrão em projeto isolado");
    assert.ok(val(r.out, "GN").includes(accountGroup));
    assert.equal(val(r.out, "WROTE"), "sim", "o grupo da conta escreve na pasta (root:grupo 2770)");
    assert.equal(fs.statSync(accountDir).mode & 0o7777, 0o2770);
    assert.equal(fs.statSync(accountDir).uid, 0);
    // dono passa a um usuário comum SEM liberações: sai do grupo, o PTY é reiniciado e avisamos no canvas
    const inv = await call("POST", "/api/admin/invites", { authorization: `Bearer ${adminTok}` }, {});
    const acc = await call("POST", `/api/invites/${inv.body.token}/accept`, {}, { name: "Comum Linux", email: "comum.linux@example.com", password: "Lume#Brasa998877" });
    assert.equal(acc.status, 200, JSON.stringify(acc.body));
    const comum = acc.body.user.id as string;
    const notes: any[] = [];
    const cws = new WebSocket(`ws://127.0.0.1:${port}/ws/project/${proj.B.id}?token=chave-interna-linux`);
    cws.on("message", (m) => {
      try {
        notes.push(JSON.parse(m.toString()));
      } catch {}
    });
    cws.on("error", () => {});
    await until(() => cws.readyState === 1, "canvas ws");
    assert.equal((await call("POST", `/api/projects/${proj.B.id}/owner`, internal, { userId: comum })).status, 200);
    await until(() => !(tryShOut("id", ["-nG", proj.B.user]) ?? "").includes(accountGroup), "grupo removido do usuário do projeto");
    await until(() => ag.all.includes("[Sessão reiniciada]"), "PTY reiniciado");
    await until(() => notes.some((n) => n.type === "notify" && /revogada/.test(n.text ?? "")), "aviso no canvas");
    await until(() => ag.all.includes("Nenhuma conta de assinatura liberada para este projeto — peça ao admin"), "mensagem no terminal sem conta");
    const after = await ag.run("echo GN=$(id -nG); touch " + accountDir + "/probe-b2 2>&1 | head -1; echo CFG=$CLAUDE_CONFIG_DIR");
    assert.ok(!val(after.out, "GN").includes(accountGroup), "novo shell sem o grupo");
    assert.match(after.out, /Permission denied/);
    assert.equal(val(after.out, "CFG"), "");
    // gemini: o dono novo (sem liberação gemini) perde o link e o grupo; o agente é bloqueado com a mensagem do contrato
    await until(() => !(tryShOut("id", ["-nG", proj.B.user]) ?? "").includes(geminiGroup), "grupo gemini removido");
    const agw = term(proj.B.id, "agw");
    await until(() => agw.all.includes("Nenhuma conta de assinatura liberada para este projeto — peça ao admin"), "bloqueio do agy sem conta");
    const gl = await agw.run("echo HAS=$(test -L ~/.gemini && echo sim || echo nao) GN=$(id -nG)");
    assert.equal(val(gl.out, "HAS"), "nao", "link revogado: o agy vê 'não logado', sem apontar para a conta");
    assert.ok(!val(gl.out, "GN").includes(path.basename(geminiGroup)));
    agw.close();
    // admin libera a conta ao novo dono: o grupo volta
    const g = await call("PUT", `/api/admin/users/${comum}/accounts`, { authorization: `Bearer ${adminTok}` }, { grants: [{ program: "claude", name: "Padrão" }] });
    assert.equal(g.status, 200, JSON.stringify(g.body));
    await until(() => (tryShOut("id", ["-nG", proj.B.user]) ?? "").includes(accountGroup), "grupo devolvido");
    // projeto A (dono admin) nunca perdeu
    assert.ok((tryShOut("id", ["-nG", proj.A.user]) ?? "").includes(accountGroup));
    cws.close();
    ag.close();
  });

  test("servidor roda git como o usuário do projeto e arquivos criados pelo servidor terminam com o dono do projeto", async () => {
    const who = await new Promise<string>((resolve, reject) =>
      gitExecFile(proj.A.dir, ["-c", "alias.who=!id -u", "who"], { encoding: "utf8" }, (e, out) => (e ? reject(e) : resolve(String(out).trim()))),
    );
    assert.equal(who, String(proj.A.uid), "git do servidor roda como mtest-*, não como root");
    // um .git/config hostil não executa como root: fsmonitor rodaria como o usuário do projeto
    const marker = path.join(base, "fsmonitor-rodou-como");
    fs.writeFileSync(path.join(proj.A.dir, ".git", "config"), fs.readFileSync(path.join(proj.A.dir, ".git", "config"), "utf8") + `\n[core]\n\tfsmonitor = id -u > ${marker}; echo\n`);
    await new Promise((res) => gitExecFile(proj.A.dir, ["status", "--porcelain"], { encoding: "utf8" }, () => res(null)));
    if (fs.existsSync(marker)) assert.notEqual(fs.readFileSync(marker, "utf8").trim(), "0", "nunca como root");
    // worktree (andar) criado pela API: dono do projeto, e o terminal do projeto consegue gravar nele
    mkdirOwned(path.join(proj.A.dir, ".maestri-roles", "x"));
    assert.equal(fs.statSync(path.join(proj.A.dir, ".maestri-roles")).uid, proj.A.uid);
    assert.equal(fs.statSync(path.join(proj.A.dir, ".maestri-roles", "x")).uid, proj.A.uid);
    const wt = await call("POST", `/api/projects/${proj.A.id}/worktrees`, internal, { nodeId: "ag", name: "andar1" });
    assert.ok(wt.status < 300, JSON.stringify(wt.body));
    const wtDir = path.join(proj.A.dir, ".worktrees");
    assert.equal(fs.statSync(wtDir).uid, proj.A.uid);
    for (const e of fs.readdirSync(wtDir)) assert.equal(fs.statSync(path.join(wtDir, e)).uid, proj.A.uid, e);
  });

  test("cgroup (só com MAESTRI_ISOLATION_TEST_CGROUP=1): o PTY roda dentro do slice do projeto com os limites", { skip: !cgroup }, async () => {
    const t = term(proj.A.id, "t");
    const r = await t.run("echo CG=$(cat /proc/self/cgroup | tail -1)");
    const cg = val(r.out, "CG");
    assert.match(cg, new RegExp(`${proj.A.user}\\.slice`));
    // os limites estão no slice do projeto (valem para todos os terminais dele juntos)
    const slice = "/sys/fs/cgroup" + path.dirname(cg.replace(/^0::/, ""));
    assert.equal(fs.readFileSync(path.join(slice, "memory.max"), "utf8").trim(), String(2 * 1024 ** 3));
    assert.equal(fs.readFileSync(path.join(slice, "pids.max"), "utf8").trim(), "512");
    assert.equal(fs.readFileSync(path.join(slice, "cpu.max"), "utf8").trim().split(" ")[0], "200000");
    t.close();
  });

  // =====================================================================================================================
  // FASE 4 (defensor) — A3: o SERVIDOR (root) seguindo symlink plantado pelo agente; A4: git/gh do servidor com repositório hostil.
  // Cada teste planta o ataque como o dono do projeto (o agente), dispara a ação pela API e exige que NADA fora do projeto mude.
  // Teste que falha = ACHADO (não corrigir aqui). Alvo ("victim"): pasta/arquivo de root fora do projeto, em /tmp/mtest-iso-<pid>/victim.
  // =====================================================================================================================
  const victim = path.join(base, "victim");
  const victimFile = path.join(victim, "alvo.txt");
  const ORIGINAL = "ORIGINAL-DE-ROOT\n";
  const resetVictim = () => {
    fs.rmSync(victim, { recursive: true, force: true });
    fs.mkdirSync(victim, { mode: 0o700 });
    fs.writeFileSync(victimFile, ORIGINAL, { mode: 0o600 });
    fs.chmodSync(victim, 0o700);
  };
  // O alvo continua intacto: conteúdo, dono root, modos e nenhum arquivo novo dentro dele
  const assertVictimIntact = (what: string) => {
    assert.equal(fs.readFileSync(victimFile, "utf8"), ORIGINAL, `${what}: o servidor (root) escreveu/alterou um arquivo FORA do projeto através do symlink`);
    const f = fs.statSync(victimFile);
    assert.deepEqual([f.uid, f.mode & 0o777], [0, 0o600], `${what}: dono/modo do arquivo alvo mudaram (chown/chmod pelo servidor via symlink)`);
    const d = fs.statSync(victim);
    assert.deepEqual([d.uid, d.mode & 0o777], [0, 0o700], `${what}: dono/modo da pasta alvo mudaram`);
    assert.deepEqual(fs.readdirSync(victim), ["alvo.txt"], `${what}: arquivos novos apareceram na pasta alvo`);
  };
  // O agente cria o symlink dentro do projeto/HOME (dono = usuário do projeto)
  const plant = (link: string, target: string, who = proj.A) => {
    fs.rmSync(link, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link);
    fs.lchownSync(link, who.uid, who.uid);
  };
  const cleanGit = (dir: string) => {
    fs.writeFileSync(path.join(dir, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tfilemode = true\n");
    fs.rmSync(path.join(dir, ".git", "hooks"), { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, ".git", "hooks"));
    fs.rmSync(path.join(dir, ".gitattributes"), { force: true });
    for (const w of fs.existsSync(path.join(dir, ".worktrees")) ? fs.readdirSync(path.join(dir, ".worktrees")) : []) tryShOut("git", ["-C", dir, "worktree", "remove", "--force", path.join(dir, ".worktrees", w)]);
    tryShOut("git", ["-C", dir, "worktree", "prune"]);
  };
  const killSession = async (p: string, n: string) => {
    await call("DELETE", `/api/projects/${p}/sessions/${n}`);
  };
  let floorSeq = 0;
  const newFloor = async (body: Record<string, unknown> = {}) => {
    const r = await call("POST", `/api/projects/${proj.A.id}/floors`, internal, { name: `sec${++floorSeq}`, ...body });
    return r;
  };

  test("A3.1 roles: .maestri apontando para fora (symlink de diretório) — POST /roles não escreve fora do projeto", async () => {
    resetVictim();
    try {
      plant(path.join(proj.A.dir, ".maestri"), victim);
      const r = await call("POST", `/api/projects/${proj.A.id}/roles`, internal, { name: "Papel", prompt: "oi" });
      assertVictimIntact(`POST /roles (status ${r.status}) com .maestri -> ${victim}`);
    } finally {
      fs.rmSync(path.join(proj.A.dir, ".maestri"), { recursive: true, force: true });
    }
  });

  test("A3.2 roles: arquivo temporário previsível (<arquivo>.<pid do servidor>.tmp) como symlink — PUT /roles não clobera arquivo de root", async () => {
    resetVictim();
    const created = await call("POST", `/api/projects/${proj.A.id}/roles`, internal, { name: "Papel2", prompt: "oi" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = String(created.body.role.id);
    const roleJson = path.join(proj.A.dir, ".maestri", "roles", id.toLowerCase(), "role.json");
    try {
      // o pid do servidor é público (ps); o agente adivinha o nome do tmp
      plant(`${roleJson}.${process.pid}.tmp`, victimFile);
      const r = await call("PUT", `/api/projects/${proj.A.id}/roles/${id}`, internal, { prompt: "novo prompt" });
      assert.ok(r.status < 500, JSON.stringify(r.body));
      assertVictimIntact(`PUT /roles/:id com ${path.basename(roleJson)}.${process.pid}.tmp -> arquivo de root`);
    } finally {
      fs.rmSync(path.join(proj.A.dir, ".maestri"), { recursive: true, force: true });
    }
  });

  test("A3.3 andares: .git/info/exclude como symlink — criar andar não faz o servidor (root) anexar texto a arquivo de root", async () => {
    resetVictim();
    cleanGit(proj.A.dir);
    const exclude = path.join(proj.A.dir, ".git", "info", "exclude");
    try {
      plant(exclude, victimFile);
      const r = await newFloor();
      assert.ok(r.status < 600, JSON.stringify(r.body));
      assertVictimIntact(`POST /floors (status ${r.status}) com .git/info/exclude -> arquivo de root`);
    } finally {
      fs.rmSync(exclude, { force: true });
      fs.writeFileSync(exclude, "");
      fs.chownSync(exclude, proj.A.uid, proj.A.uid);
      cleanGit(proj.A.dir);
    }
  });

  test("A3.4 andares (copyGround): arquivo não rastreado que é symlink para arquivo de root — o servidor não copia o conteúdo para dentro do projeto", async () => {
    resetVictim();
    cleanGit(proj.A.dir);
    const SECRET = "SEGREDO-LEGIVEL-SO-POR-ROOT";
    fs.writeFileSync(victimFile, SECRET + "\n", { mode: 0o600 });
    const leak = path.join(proj.A.dir, "vazamento.txt");
    try {
      plant(leak, victimFile);
      const r = await newFloor({ copyGround: true });
      assert.ok(r.status < 500, JSON.stringify(r.body));
      const wt = path.join(proj.A.dir, ".worktrees");
      const hits: string[] = [];
      const walk = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory() && e.name !== ".git") walk(p);
          else if (e.isFile()) {
            try {
              if (fs.readFileSync(p, "utf8").includes(SECRET)) hits.push(p);
            } catch {}
          }
        }
      };
      if (fs.existsSync(wt)) walk(wt);
      assert.deepEqual(hits, [], "o servidor (root) copiou o conteúdo de um arquivo de root (via symlink do agente) para dentro do projeto: leitura arbitrária como root");
    } finally {
      fs.rmSync(leak, { force: true });
      cleanGit(proj.A.dir);
    }
  });

  test("A3.5 contexto do agente: ~/.codex como symlink — o servidor (root) não escreve a skill/AGENTS nem dá chown fora do HOME", async () => {
    resetVictim();
    await killSession(proj.A.id, "t");
    const home = iso.homeOf(proj.A.user);
    try {
      plant(path.join(home, ".codex"), victim);
      const t = term(proj.A.id, "t");
      await t.run("echo PRONTO");
      t.close();
      assertVictimIntact("spawn do terminal (ensureAgentContext) com ~/.codex -> pasta de root");
    } finally {
      fs.rmSync(path.join(home, ".codex"), { recursive: true, force: true });
      await killSession(proj.A.id, "t");
    }
  });

  test("A3.6 agente com role: .maestri-roles como symlink — POST /agents (withRolePrompt) não escreve fora do projeto", async () => {
    resetVictim();
    const role = await call("POST", `/api/projects/${proj.A.id}/roles`, internal, { name: "Papel3", prompt: "seja útil" });
    assert.equal(role.status, 201, JSON.stringify(role.body));
    try {
      plant(path.join(proj.A.dir, ".maestri-roles"), victim);
      const r = await call("POST", `/api/projects/${proj.A.id}/agents`, internal, { title: "Com Papel", preset: "claude", roleId: role.body.role.id });
      assert.ok(r.status < 300 || /EACCES|ELOOP|ENOTDIR/.test(JSON.stringify(r.body)), `o servidor deveria ter tentado escrever (e ser barrado como o usuário) para o teste ser conclusivo: ${r.status} ${JSON.stringify(r.body)}`);
      assertVictimIntact("POST /agents com .maestri-roles -> pasta de root");
    } finally {
      fs.rmSync(path.join(proj.A.dir, ".maestri-roles"), { recursive: true, force: true });
      fs.rmSync(path.join(proj.A.dir, ".maestri"), { recursive: true, force: true });
    }
  });

  test("A3.7 partituras: .maestri/partituras como symlink — salvar partitura (fsOps como usuário do projeto) não escreve fora do projeto", async () => {
    resetVictim();
    const cv = (await call("GET", `/api/projects/${proj.A.id}/canvas`)).body;
    if (!cv.nodes.some((n: any) => n.id === "mst")) {
      const up = await call("POST", `/api/projects/${proj.A.id}/canvas`, internal, { nodes: [...cv.nodes, { id: "mst", type: "agentTerminal", position: { x: 900, y: 0 }, data: { title: "Maestro", isMaestro: true } }], edges: cv.edges });
      assert.equal(up.status, 200, JSON.stringify(up.body));
    }
    try {
      fs.mkdirSync(path.join(proj.A.dir, ".maestri"), { recursive: true });
      fs.chownSync(path.join(proj.A.dir, ".maestri"), proj.A.uid, proj.A.uid);
      plant(path.join(proj.A.dir, ".maestri", "partituras"), victim);
      const tk = terminalTokens.issue({ projectId: proj.A.id, nodeId: "mst" });
      const r = await call("POST", `/api/projects/${proj.A.id}/nodes/mst/partituras/create`, bearer(tk.token), { name: "Plano", scope: "current" });
      assert.ok(r.status < 300 || /EACCES|ELOOP|ENOTDIR/.test(JSON.stringify(r.body)), `o servidor deveria ter tentado escrever (e ser barrado como o usuário) para o teste ser conclusivo: ${r.status} ${JSON.stringify(r.body)}`);
      terminalTokens.revoke(tk.ptyId);
      assertVictimIntact(`salvar partitura (status ${r.status}) com .maestri/partituras -> pasta de root`);
    } finally {
      fs.rmSync(path.join(proj.A.dir, ".maestri"), { recursive: true, force: true });
    }
  });

  // ---- A4: git/gh do servidor com repositório controlado pelo agente ----
  const markers = path.join(base, "markers");
  const uidsIn = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean) : []);
  const prepMarkers = () => {
    fs.rmSync(markers, { recursive: true, force: true });
    fs.mkdirSync(markers, { mode: 0o777 });
    fs.chmodSync(markers, 0o777);
  };
  // roda git como o dono do projeto (o agente): prepara um repositório com arquivo rastreado (sem índice o fsmonitor nem é consultado)
  const asProject = (dir: string, args: string[]) =>
    sh("setpriv", [`--reuid=${proj.A.uid}`, `--regid=${sh("id", ["-g", proj.A.user])}`, "--init-groups", "env", "-i", `HOME=${iso.homeOf(proj.A.user)}`, "PATH=/usr/bin:/bin", "git", "-C", dir, "-c", "user.name=a", "-c", "user.email=a@a", ...args]);
  const hostileConfig = (dir: string, m: string) => {
    cleanGit(dir);
    fs.writeFileSync(path.join(dir, "x.pwn"), "inicial\n");
    fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
    fs.writeFileSync(path.join(dir, ".gitattributes"), "*.pwn filter=pwn\n");
    tryShOut("chown", ["-R", `${proj.A.uid}:${sh("id", ["-g", proj.A.user])}`, dir]);
    asProject(dir, ["add", "-A"]);
    try {
      asProject(dir, ["commit", "-qm", "seed"]);
    } catch {} // já commitado em um teste anterior
    fs.appendFileSync(
      path.join(dir, ".git", "config"),
      `[core]\n\tfsmonitor = "sh -c 'id -u >> ${m}/fsmonitor; echo' --"\n[filter "pwn"]\n\tclean = "sh -c 'id -u >> ${m}/filter; cat' --"\n\tsmudge = "sh -c 'id -u >> ${m}/smudge; cat' --"\n`,
    );
    fs.writeFileSync(path.join(dir, "x.pwn"), "modificado\n"); // sujo: o status roda o filtro clean
    fs.chownSync(path.join(dir, "x.pwn"), proj.A.uid, proj.A.uid);
    const hook = path.join(dir, ".git", "hooks", "post-checkout");
    fs.writeFileSync(hook, `#!/bin/sh\nid -u >> ${m}/hook\n`, { mode: 0o755 });
    fs.chownSync(hook, proj.A.uid, proj.A.uid);
    // o agente é dono do .git: tudo isso é dele
    tryShOut("chown", ["-R", `${proj.A.uid}:${sh("id", ["-g", proj.A.user])}`, path.join(dir, ".git")]);
  };
  const noRoot = (f: string, what: string) => {
    const u = uidsIn(f);
    assert.ok(u.length > 0, `${what}: o vetor não executou (teste inconclusivo)`);
    assert.ok(!u.includes("0"), `${what}: o servidor executou código do repositório do agente COMO ROOT (uids: ${[...new Set(u)].join(",")})`);
    assert.deepEqual([...new Set(u)], [String(proj.A.uid)], `${what}: deveria rodar como o usuário do projeto`);
  };

  test("A4.1 git do servidor: core.fsmonitor / filtro / hook no .git do agente executam como o usuário do projeto, nunca root (files, worktrees, andares)", async () => {
    prepMarkers();
    hostileConfig(proj.A.dir, markers);
    try {
      await call("GET", `/api/projects/${proj.A.id}/files`);
      await call("GET", `/api/projects/${proj.A.id}/worktrees`);
      await call("GET", `/api/projects/${proj.A.id}/floors`);
      noRoot(path.join(markers, "fsmonitor"), "fsmonitor (GET /files, /worktrees, /floors)");
      const r = await newFloor(); // worktree add dispara post-checkout
      assert.ok(r.status < 500, JSON.stringify(r.body));
      noRoot(path.join(markers, "hook"), "hook post-checkout (POST /floors)");
    } finally {
      cleanGit(proj.A.dir);
      fs.rmSync(path.join(proj.A.dir, "x.pwn"), { force: true });
    }
  });

  test("A4.2 fluxo de PR: o gh do servidor roda como o usuário do projeto (não root) e o git que ele dispara não executa o .git hostil como root", async () => {
    prepMarkers();
    hostileConfig(proj.A.dir, markers);
    const bin = path.join(base, "fakebin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "gh"), `#!/bin/sh\nid -u >> ${markers}/gh\ngit status >/dev/null 2>&1\necho '[]'\n`, { mode: 0o755 });
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath}`;
    try {
      const f = await newFloor();
      assert.ok(f.status < 500, JSON.stringify(f.body));
      fs.rmSync(path.join(markers, "fsmonitor"), { force: true });
      const r = await call("POST", `/api/projects/${proj.A.id}/floors/detect-prs`, internal, { now: true });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.ok(uidsIn(path.join(markers, "gh")).length > 0, "o gh falso não foi chamado (teste inconclusivo)");
      assert.ok(!uidsIn(path.join(markers, "gh")).includes("0"), "o servidor executa `gh` COMO ROOT com cwd dentro do repositório controlado pelo agente (floorsApi.ts gh())");
      assert.ok(!uidsIn(path.join(markers, "fsmonitor")).includes("0"), "o git disparado pelo gh executou o core.fsmonitor do agente COMO ROOT");
    } finally {
      process.env.PATH = oldPath;
      cleanGit(proj.A.dir);
      fs.rmSync(path.join(proj.A.dir, "x.pwn"), { force: true });
    }
  });

  test("A4.3 git do servidor: core.hooksPath apontando para hook do agente roda como o usuário do projeto (worktree add / land)", async () => {
    prepMarkers();
    cleanGit(proj.A.dir);
    fs.appendFileSync(path.join(proj.A.dir, ".git", "config"), `[core]\n\thooksPath = ${markers}/hooks\n`);
    fs.mkdirSync(path.join(markers, "hooks"));
    fs.writeFileSync(path.join(markers, "hooks", "post-checkout"), `#!/bin/sh\nid -u >> ${markers}/hookspath\n`, { mode: 0o755 });
    tryShOut("chown", ["-R", `${proj.A.uid}:${sh("id", ["-g", proj.A.user])}`, path.join(proj.A.dir, ".git")]);
    try {
      await call("GET", `/api/projects/${proj.A.id}/files`);
      const f = await newFloor();
      assert.ok(f.status < 500, JSON.stringify(f.body));
      await call("POST", `/api/projects/${proj.A.id}/floors/${(f.body.floor?.name ?? f.body.name ?? `sec${floorSeq}`)}/land`, internal, {});
      noRoot(path.join(markers, "hookspath"), "core.hooksPath (POST /floors, /land)");
    } finally {
      cleanGit(proj.A.dir);
    }
  });

  test("excluir projeto: mata o que sobrou do usuário, apaga usuário/grupo/HOME/TMPDIR e (com deleteFolder) a pasta; o outro projeto não é tocado", async () => {
    const t = term(proj.A.id, "t");
    await t.run("setsid sleep 300 >/dev/null 2>&1 < /dev/null & echo BG=ok");
    await until(() => (tryShOut("pgrep", ["-u", proj.A.user, "sleep"]) ?? "") !== "", "processo órfão do usuário");
    const token = fs.readdirSync(terminalTokens.directory).length;
    assert.ok(token >= 1);
    const del = await call("DELETE", `/api/projects/${proj.A.id}`, internal, { deleteFolder: true });
    assert.equal(del.status, 200, JSON.stringify(del.body));
    created.splice(created.indexOf(proj.A.id), 1);
    await until(() => tryShOut("id", [proj.A.user]) === null, "usuário removido");
    assert.equal(tryShOut("pgrep", ["-u", proj.A.user]) ?? "", "");
    assert.ok(!fs.existsSync(iso.homeOf(proj.A.user)) && !fs.existsSync(iso.tmpOf(proj.A.user)));
    assert.ok(!fs.existsSync(proj.A.dir), "pasta apagada (deleteFolder)");
    assert.equal(tryShOut("getent", ["group", proj.A.user]), null, "grupo primário também");
    assert.ok(tryShOut("id", [proj.B.user]), "o outro projeto segue intacto");
    assert.equal(fs.readFileSync(path.join(proj.B.dir, "segredo-b.txt"), "utf8"), "SEGREDO-DE-B");
    t.close();
  });
}
