import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "maestri-portal-test-"));
process.env.REPO_PATH = repo;
process.env.NODE_ENV = "test";
process.env.MAESTRI_TOKEN = "tok-portal";

const { fastify, portals } = await import("../src/index.js");
const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/maestri");
const P = "proj-maestri-web";
const auth = { authorization: "Bearer tok-portal" };

const PAGE = `<!doctype html><html><head><title>Formulário</title></head><body>
<h1>Cadastro</h1>
<a id="lnk" href="/outra">Ir para outra</a>
<label for="nome">Nome</label><input id="nome" type="text" placeholder="Seu nome">
<input id="ok" type="checkbox"> <label for="ok">Aceito</label>
<select id="cor" aria-label="Cor"><option value="r">Vermelho</option><option value="g">Verde</option></select>
<input id="arq" type="file" aria-label="Arquivo">
<button id="enviar" onclick="document.getElementById('res').textContent='enviado:'+document.getElementById('nome').value;console.log('clicou')">Enviar</button>
<button id="pop" onclick="window.open('/popup','_blank')">Popup</button>
<p id="res"></p><p id="tam"></p>
<div style="height:3000px">espaço</div><p id="fim">rodapé</p>
<script>document.getElementById('tam').textContent=innerWidth+'x'+innerHeight;window.addEventListener('resize',()=>document.getElementById('tam').textContent=innerWidth+'x'+innerHeight);
document.getElementById('arq').onchange=e=>{document.getElementById('res').textContent='arquivo:'+e.target.files[0].name}</script>
</body></html>`;

const server = http.createServer((req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  if (req.url === "/outra") res.end("<title>Outra</title><p>outra página</p>");
  else if (req.url === "/popup") res.end("<title>Pop</title><p>sou um popup</p>");
  else res.end(PAGE);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const site = `http://127.0.0.1:${(server.address() as any).port}`;

// Se o Chromium não abrir neste ambiente, os testes são pulados com uma mensagem clara
let skip: string | false = false;
let port = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 8000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) assert.fail(`timeout: ${what}`);
    await sleep(40);
  }
}

function maestri(args: string[], node = "maestro", cwd?: string) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      [bin, ...args],
      { cwd, env: { ...process.env, MAESTRI_API_URL: `http://127.0.0.1:${port}/api`, MAESTRI_PROJECT_ID: P, MAESTRI_NODE_ID: node, MAESTRI_TOKEN: "tok-portal" } },
      (err, stdout, stderr) => resolve({ code: err ? ((err as any).code ?? 1) : 0, stdout: stdout.trimEnd(), stderr: stderr.trimEnd() }),
    );
  });
}
const ok = async (args: string[]) => {
  const r = await maestri(args);
  assert.equal(r.code, 0, `${args.join(" ")} -> ${r.stderr}`);
  return r.stdout;
};
const canvasState = async () => (await fastify.inject({ method: "GET", url: `/api/projects/${P}/canvas`, headers: auth })).json();
const nodeByTitle = async (title: string) => (await canvasState()).nodes.find((n: any) => n.data?.title === title);
// ref (@eN) do primeiro elemento do snapshot cuja linha casa com o padrão
const refOf = (snap: string, re: RegExp) => {
  const line = snap.split("\n").find((l) => re.test(l));
  assert.ok(line, `linha não encontrada no snapshot: ${re}\n${snap}`);
  return line!.split(" ")[0];
};

before(async () => {
  await fastify.listen({ port: 0, host: "127.0.0.1" });
  port = (fastify.server.address() as any).port;
  await fastify.inject({
    method: "POST",
    url: `/api/projects/${P}/canvas`,
    headers: auth,
    payload: {
      nodes: [
        { id: "maestro", type: "agentTerminal", position: { x: 0, y: 0 }, style: { width: 460, height: 330 }, data: { title: "Agente Maestro", isMaestro: true } },
        { id: "outro", type: "agentTerminal", position: { x: 0, y: 700 }, style: { width: 460, height: 330 }, data: { title: "Outro" } },
      ],
      edges: [],
    },
  });
  // Sonda: o primeiro `create` abre o Chromium de verdade
  const r = await maestri(["portal", "create", site, "Form"]);
  if (r.code !== 0) skip = `Chromium indisponível neste ambiente, testes de portal pulados: ${r.stderr}`;
});

after(async () => {
  await fastify.close();
  server.close();
  fs.rmSync(repo, { recursive: true, force: true });
});

test("create: nó à direita, conectado, com viewport e já aberto na URL", { skip }, async () => {
  const n = await nodeByTitle("Form");
  assert.equal(n.type, "portal");
  assert.equal(n.data.url, `${site}/`);
  assert.equal(n.data.live, true);
  assert.deepEqual(n.data.viewport, { w: 1280, h: 800 });
  assert.ok(n.position.x >= 460, `à direita do agente (x=${n.position.x})`);
  const st = await canvasState();
  assert.ok(st.edges.some((e: any) => e.source === "maestro" && e.target === n.id));
  assert.match(await ok(["list"]), /Form/);
  assert.match(await ok(["portal", "info", "Form"]), /title: Formulário/);
});

test("create valida URL (só http/https), nome duplicado e --size", { skip }, async () => {
  const bad = await maestri(["portal", "create", "javascript:alert(1)"]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /^maestri: error: URL inválida/);
  assert.equal((await maestri(["portal", "create", "file:///etc/passwd"])).code, 1);
  const dup = await maestri(["portal", "create", site, "form"]);
  assert.match(dup.stderr, /Já existe um nó conectado/);
  const size = await maestri(["portal", "create", site, "X", "--size", "abc"]);
  assert.match(size.stderr, /--size/);
});

test("snapshot: cabeçalho, refs, caixas, valores e foco", { skip }, async () => {
  const snap = await ok(["portal", "snapshot", "Form"]);
  assert.match(snap.split("\n")[0], /^viewport: 1280x800  url: http:\/\/127\.0\.0\.1:\d+\/  title: Formulário$/);
  assert.match(snap, /^@e\d+ a "Ir para outra" href=http:\/\/127\.0\.0\.1:\d+\/outra \[\d+,\d+ \d+x\d+\]$/m);
  assert.match(snap, /^@e\d+ input type=text "Nome" \[\d+,\d+ \d+x\d+\]$/m);
  assert.match(snap, /input type=checkbox .*unchecked/);
  assert.match(snap, /select "Cor" value="Vermelho"/);
  assert.match(snap, /button "Enviar"/);
  assert.doesNotMatch(snap, /rodapé/); // fora do viewport
  await ok(["portal", "focus", "Form", "#nome"]);
  assert.match(await ok(["portal", "snapshot", "Form"]), /input type=text "Nome" .*\*focused\*/);
});

test("fill, click, text, evaluate e logs", { skip }, async () => {
  const snap = await ok(["portal", "snapshot", "Form"]);
  await ok(["portal", "logs-start", "Form"]);
  await ok(["portal", "fill", "Form", refOf(snap, /input type=text "Nome"/), "Maria"]);
  await ok(["portal", "click", "Form", refOf(snap, /button "Enviar"/)]);
  assert.equal(await ok(["portal", "text", "Form", "#res"]), "enviado:Maria");
  assert.equal(await ok(["portal", "evaluate", "Form", "document.getElementById('nome').value"]), "Maria");
  assert.equal(await ok(["portal", "evaluate", "Form", "1+1"]), "2");
  assert.match(await ok(["portal", "logs", "Form"]), /\[log\] clicou/);
  assert.equal(await ok(["portal", "logs", "Form"]), ""); // o buffer é limpo
  assert.match(await ok(["portal", "html", "Form"]), /<h1>Cadastro<\/h1>/);
});

test("type acrescenta, key/selectall/clear e clique por coordenadas", { skip }, async () => {
  await ok(["portal", "fill", "Form", "#nome", "ab"]);
  await ok(["portal", "type", "Form", "#nome", "cd"]);
  assert.equal(await ok(["portal", "evaluate", "Form", "document.getElementById('nome').value"]), "abcd");
  await ok(["portal", "type", "Form", "ef"]); // sem seletor: elemento focado
  assert.equal(await ok(["portal", "evaluate", "Form", "document.getElementById('nome').value"]), "abcdef");
  await ok(["portal", "key", "Form", "Backspace"]);
  assert.equal(await ok(["portal", "evaluate", "Form", "document.getElementById('nome').value"]), "abcde");
  await ok(["portal", "selectall", "Form"]);
  await ok(["portal", "key", "Form", "x"]);
  assert.equal(await ok(["portal", "evaluate", "Form", "document.getElementById('nome').value"]), "x");
  await ok(["portal", "key", "Form", "ctrl+a"]);
  await ok(["portal", "key", "Form", "Backspace"]);
  assert.equal(await ok(["portal", "evaluate", "Form", "document.getElementById('nome').value"]), "");
  await ok(["portal", "type", "Form", "#nome", "zz"]);
  await ok(["portal", "clear", "Form", "#nome"]);
  assert.equal(await ok(["portal", "evaluate", "Form", "document.getElementById('nome').value"]), "");
  // coordenadas: clica no centro do campo "Nome" e digita
  const snap = await ok(["portal", "snapshot", "Form"]);
  const m = /input type=text "Nome" \[(\d+),(\d+) (\d+)x(\d+)\]/.exec(snap)!;
  await ok(["portal", "click", "Form", `${Number(m[1]) + Number(m[3]) / 2},${Number(m[2]) + Number(m[4]) / 2}`]);
  await ok(["portal", "type", "Form", "coord"]);
  assert.equal(await ok(["portal", "evaluate", "Form", "document.getElementById('nome').value"]), "coord");
  await ok(["portal", "key", "Form", "Tab"]);
  assert.match(await ok(["portal", "snapshot", "Form"]), /type=checkbox .*\*focused\*/);
});

test("select, check/uncheck e hover", { skip }, async () => {
  await ok(["portal", "select", "Form", "#cor", "Verde"]);
  assert.equal(await ok(["portal", "evaluate", "Form", "document.getElementById('cor').value"]), "g");
  await ok(["portal", "check", "Form", "#ok"]);
  assert.equal(await ok(["portal", "evaluate", "Form", "document.getElementById('ok').checked"]), "true");
  await ok(["portal", "uncheck", "Form", "#ok"]);
  assert.equal(await ok(["portal", "evaluate", "Form", "document.getElementById('ok').checked"]), "false");
  await ok(["portal", "hover", "Form", "#enviar"]);
  const bad = await maestri(["portal", "select", "Form", "#cor", "Azul"]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /opção não encontrada/);
});

test("upload resolve caminhos a partir do cwd de quem chamou", { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maestri-upload-"));
  fs.writeFileSync(path.join(dir, "relatorio.txt"), "conteúdo");
  const r = await maestri(["portal", "upload", "Form", "#arq", "./relatorio.txt"], "maestro", dir);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(await ok(["portal", "text", "Form", "#res"]), "arquivo:relatorio.txt");
  const miss = await maestri(["portal", "upload", "Form", "#arq", "./nao-existe.txt"], "maestro", dir);
  assert.equal(miss.code, 1);
  assert.match(miss.stderr, /arquivo não encontrado/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("scroll e scrollintoview", { skip }, async () => {
  await ok(["portal", "evaluate", "Form", "window.scrollTo(0,0)"]);
  await ok(["portal", "scroll", "Form", "down", "300"]);
  assert.equal(await ok(["portal", "evaluate", "Form", "Math.round(scrollY)"]), "300");
  await ok(["portal", "scroll", "Form", "up", "100", "400,300"]);
  assert.equal(await ok(["portal", "evaluate", "Form", "Math.round(scrollY)"]), "200");
  await ok(["portal", "scrollintoview", "Form", "#fim"]);
  assert.ok(Number(await ok(["portal", "evaluate", "Form", "scrollY"])) > 2000);
  await ok(["portal", "evaluate", "Form", "window.scrollTo(0,0)"]);
  assert.match((await maestri(["portal", "scroll", "Form", "diagonal", "10"])).stderr, /direção inválida/);
});

test("wait: elemento, texto, URL e tempo; estourar o tempo é erro", { skip }, async () => {
  await ok(["portal", "navigate", "Form", `${site}/`]);
  // elemento que aparece depois (CSS e @ref)
  await ok(["portal", "evaluate", "Form", "setTimeout(() => { const d = document.createElement('div'); d.id = 'tarde'; d.textContent = 'chegou-depois'; document.body.appendChild(d); }, 500); 'agendado'"]);
  const t0 = Date.now();
  assert.equal(await ok(["portal", "wait", "Form", "#tarde"]), "ok");
  assert.ok(Date.now() - t0 >= 300, "esperou o elemento aparecer");
  const snap = await ok(["portal", "snapshot", "Form"]);
  assert.equal(await ok(["portal", "wait", "Form", refOf(snap, /button "Enviar"/)]), "ok", "@ref visível");
  // texto
  await ok(["portal", "evaluate", "Form", "setTimeout(() => { document.getElementById('res').textContent = 'terminou-o-trabalho'; }, 400); 1"]);
  assert.equal(await ok(["portal", "wait", "Form", "--text", "terminou-o-trabalho"]), "ok");
  // URL: substring e glob (a navegação acontece depois)
  await ok(["portal", "evaluate", "Form", "setTimeout(() => { location.href = '/outra'; }, 300); 1"]);
  assert.equal(await ok(["portal", "wait", "Form", "--url", "/outra"]), "ok");
  await ok(["portal", "evaluate", "Form", "setTimeout(() => { location.href = '/'; }, 300); 1"]);
  assert.equal(await ok(["portal", "wait", "Form", "--url", `${site}/`]), "ok");
  await ok(["portal", "evaluate", "Form", "setTimeout(() => { location.href = '/outra?x=1'; }, 300); 1"]);
  assert.equal(await ok(["portal", "wait", "Form", "--url", "*/outra?x=*"]), "ok");
  await ok(["portal", "navigate", "Form", `${site}/`]);
  // tempo puro (ms)
  const t1 = Date.now();
  assert.equal(await ok(["portal", "wait", "Form", "400"]), "ok");
  assert.ok(Date.now() - t1 >= 350);
  // timeout: erro no formato do Maestri, saída != 0
  for (const args of [["#nunca"], ["--text", "texto que nunca aparece"], ["--url", "/jamais"]]) {
    const r = await maestri(["portal", "wait", "Form", ...args, "--timeout", "1"]);
    assert.equal(r.code, 1, args.join(" "));
    assert.match(r.stderr, /^maestri: error: /, args.join(" "));
  }
  assert.match((await maestri(["portal", "wait", "Form"])).stderr, /^maestri: error: Uso: maestri portal wait/);
});

test("navigate, back, forward, reload mantêm data.url em sincronia", { skip }, async () => {
  assert.match(await ok(["portal", "navigate", "Form", `${site}/outra`]), /Outra/);
  assert.equal((await nodeByTitle("Form")).data.url, `${site}/outra`);
  assert.match(await ok(["portal", "back", "Form"]), /Formulário/);
  assert.match(await ok(["portal", "forward", "Form"]), /Outra/);
  assert.match(await ok(["portal", "reload", "Form"]), /Outra/);
  await ok(["portal", "edit", "Form", "--url", `${site}/`]);
  assert.match(await ok(["portal", "info", "Form"]), /title: Formulário/);
  assert.equal((await nodeByTitle("Form")).data.url, `${site}/`);
  // clicar num link muda a página e a url do nó
  await ok(["portal", "click", "Form", "#lnk"]);
  await until(async () => (await nodeByTitle("Form")).data.url === `${site}/outra`, "data.url segue a navegação");
  await ok(["portal", "back", "Form"]);
});

test("refs são invalidadas pela navegação e erros saem como 'maestri: error:'", { skip }, async () => {
  const snap = await ok(["portal", "snapshot", "Form"]);
  const ref = refOf(snap, /button "Enviar"/);
  await ok(["portal", "navigate", "Form", `${site}/outra`]);
  const stale = await maestri(["portal", "click", "Form", ref]);
  assert.equal(stale.code, 1);
  assert.match(stale.stderr, /^maestri: error: ref @e\d+ não encontrada/);
  await ok(["portal", "navigate", "Form", `${site}/`]);
  const miss = await maestri(["portal", "click", "Form", "#nao-existe"]);
  assert.equal(miss.code, 1);
  assert.match(miss.stderr, /^maestri: error: elemento não encontrado/);
  const js = await maestri(["portal", "evaluate", "Form", "naoExiste.x"]);
  assert.equal(js.code, 1);
  assert.match(js.stderr, /^maestri: error: .*naoExiste/);
  const verb = await maestri(["portal", "dance", "Form"]);
  assert.equal(verb.code, 1);
  assert.match(verb.stderr, /^maestri: error: verbo de portal desconhecido/);
  assert.equal((await maestri(["portal", "logs", "Form"])).code, 0); // logs-start veio de teste anterior
  const none = await maestri(["portal", "snapshot", "Fantasma"]);
  assert.match(none.stderr, /^maestri: error: Alvo "Fantasma" não encontrado/);
  const unconnected = await maestri(["portal", "snapshot", "Form"], "outro");
  assert.match(unconnected.stderr, /não encontrado|não está conectado/);
});

test("resize devolve o viewport obtido e ua troca o user agent", { skip }, async () => {
  assert.equal(await ok(["portal", "resize", "Form", "390", "844"]), "viewport: 390x844");
  assert.match(await ok(["portal", "info", "Form"]), /viewport: 390x844/);
  assert.equal(await ok(["portal", "evaluate", "Form", "innerWidth+'x'+innerHeight"]), "390x844");
  assert.match((await ok(["portal", "snapshot", "Form"])).split("\n")[0], /^viewport: 390x844/);
  assert.deepEqual((await nodeByTitle("Form")).data.viewport, { w: 390, h: 844 });
  assert.match((await maestri(["portal", "resize", "Form", "10", "10"])).stderr, /entre 50 e 5000/);

  const before = await ok(["portal", "ua", "Form"]);
  assert.match(before, /ua atual: .*HeadlessChrome|ua atual: .*Chrome/);
  assert.match(before, /presets: ios, android, firefox-android, edge-android, chrome, firefox, edge, desktop/);
  assert.match(await ok(["portal", "ua", "Form", "ios"]), /iPhone/);
  assert.match(await ok(["portal", "evaluate", "Form", "navigator.userAgent"]), /iPhone/);
  assert.match(await ok(["portal", "info", "Form"]), /title: Formulário/); // recarregou a mesma URL
  assert.match((await maestri(["portal", "ua", "Form", "nokia"])).stderr, /preset desconhecido/);
  await ok(["portal", "ua", "Form", "desktop"]);
  assert.doesNotMatch(await ok(["portal", "evaluate", "Form", "navigator.userAgent"]), /iPhone/);
  await ok(["portal", "resize", "Form", "1280", "800"]);
});

test("screenshot salva um PNG e imprime o caminho", { skip }, async () => {
  const file = await ok(["portal", "screenshot", "Form"]);
  assert.ok(path.isAbsolute(file) && file.endsWith(".png"), file);
  const buf = fs.readFileSync(file);
  assert.equal(buf.subarray(1, 4).toString(), "PNG");
  // pasta própria 0700 e arquivo 0600 (nome imprevisível; nada de caminho fixo no /tmp)
  assert.match(path.basename(path.dirname(file)), /^maestri-portal-[A-Za-z0-9]{6}$/);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.notEqual(await ok(["portal", "screenshot", "Form"]), file, "cada screenshot tem a própria pasta");
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test("popup vira o portal '[Pai] #2' e some quando a página o fecha", { skip }, async () => {
  await ok(["portal", "click", "Form", "#pop"]);
  await until(async () => !!(await nodeByTitle("Form #2")), "nó do popup");
  const pop = await nodeByTitle("Form #2");
  assert.equal(pop.type, "portal");
  assert.ok((await canvasState()).edges.some((e: any) => e.source === "maestro" && e.target === pop.id), "ligado ao agente");
  await until(async () => (await maestri(["portal", "text", "Form #2"])).stdout.includes("sou um popup"), "popup carregado");
  await ok(["portal", "evaluate", "Form #2", "window.close()"]).catch(() => {});
  await until(async () => !(await nodeByTitle("Form #2")), "popup removido do canvas");
});

test("WS ao vivo: frames JPEG + meta, e eventos do usuário chegam à página", { skip }, async () => {
  const n = await nodeByTitle("Form");
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/portal?project=${P}&node=${n.id}&token=tok-portal`);
  const got: { bin: Buffer[]; json: any[] } = { bin: [], json: [] };
  ws.on("message", (d, isBinary) => (isBinary ? got.bin.push(d as Buffer) : got.json.push(JSON.parse(d.toString()))));
  await new Promise((r, j) => (ws.on("open", r), ws.on("error", j)));
  await until(() => got.bin.length > 0 && got.json.some((m) => m.type === "meta"), "primeiro frame");
  assert.equal(got.bin[0][0], 0xff); // assinatura JPEG
  assert.equal(got.bin[0][1], 0xd8);
  const meta = got.json.find((m) => m.type === "meta");
  assert.equal(meta.title, "Formulário");
  assert.deepEqual([meta.w, meta.h], [1280, 800]);

  // O usuário clica no campo e digita; a página recebe
  const snap = await ok(["portal", "snapshot", "Form"]);
  const m = /input type=text "Nome" \[(\d+),(\d+) (\d+)x(\d+)\]/.exec(snap)!;
  ws.send(JSON.stringify({ type: "click", x: Number(m[1]) + 5, y: Number(m[2]) + 5 }));
  ws.send(JSON.stringify({ type: "type", text: "humano" }));
  await until(async () => (await ok(["portal", "evaluate", "Form", "document.getElementById('nome').value"])).endsWith("humano"), "digitação do usuário");
  ws.send(JSON.stringify({ type: "scroll", x: 300, y: 300, dx: 0, dy: 200 }));
  await until(async () => Number(await ok(["portal", "evaluate", "Form", "scrollY"])) > 0, "rolagem do usuário");
  ws.send(JSON.stringify({ type: "navigate", url: `${site}/outra` }));
  await until(() => got.json.some((x) => x.type === "meta" && x.title === "Outra" && x.url === `${site}/outra`), "meta reflete a navegação");
  ws.close();

  // sem project/node válidos, a conexão é recusada
  const bad = new WebSocket(`ws://127.0.0.1:${port}/ws/portal?project=${P}&node=nao-existe&token=tok-portal`);
  const code = await new Promise<number>((r) => bad.on("close", (c) => r(c)));
  assert.equal(code, 4400);
  const noTok = new WebSocket(`ws://127.0.0.1:${port}/ws/portal?project=${P}&node=${n.id}`);
  assert.equal(await new Promise<number>((r) => noTok.on("close", (c) => r(c))), 4401);
});

test("popups: no máximo 8 abertos por portal raiz; o excedente é fechado", { skip }, async () => {
  await ok(["portal", "navigate", "Form", `${site}/`]);
  await ok(["portal", "evaluate", "Form", "for (let i = 0; i < 12; i++) window.open('/popup?n=' + i, '_blank'); 'ok'"]);
  await until(async () => (await canvasState()).nodes.filter((n: any) => /^Form #\d+$/.test(n.data?.title ?? "")).length >= 8, "popups adotados");
  await sleep(1500); // dá tempo aos excedentes de chegar (e serem fechados)
  const popups = (await canvasState()).nodes.filter((n: any) => /^Form #\d+$/.test(n.data?.title ?? ""));
  assert.equal(popups.length, 8);
  // fechar um abre vaga
  await ok(["portal", "close", popups[0].data.title]);
  await ok(["portal", "evaluate", "Form", "window.open('/popup?n=extra', '_blank'); 'ok'"]);
  await until(async () => (await canvasState()).nodes.filter((n: any) => /^Form #\d+$/.test(n.data?.title ?? "")).length === 8, "uma vaga reaproveitada");
  for (const p of (await canvasState()).nodes.filter((n: any) => /^Form #\d+$/.test(n.data?.title ?? ""))) await maestri(["portal", "close", p.data.title]);
});

test("upload só lê arquivos do projeto, dos anexos do chat e do tmp", { skip }, async () => {
  await ok(["portal", "navigate", "Form", `${site}/`]);
  const outside = "/etc/passwd";
  const r = await maestri(["portal", "upload", "Form", "#arq", outside]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^maestri: error: upload recusado: "\/etc\/passwd" está fora do projeto/);
  // link simbólico do tmp para fora também é recusado (vale o caminho real)
  const link = path.join(os.tmpdir(), `p7-link-${Date.now()}`);
  fs.symlinkSync(outside, link);
  assert.match((await maestri(["portal", "upload", "Form", "#arq", link])).stderr, /upload recusado/);
  fs.rmSync(link);
  // dentro do projeto (repo) e do tmp: ok
  const inRepo = path.join(repo, "dentro.txt");
  fs.writeFileSync(inRepo, "x");
  assert.match(await ok(["portal", "upload", "Form", "#arq", inRepo]), /1 arquivo/);
  // anexo do chat
  const att = (await fastify.inject({ method: "POST", url: `/api/projects/${P}/attachments`, headers: auth, payload: { name: "doc.txt", data: Buffer.from("anexo").toString("base64") } })).json().attachment;
  const attFile = path.join(repo, ".maestri_data", "attachments", P, att.id, "file");
  assert.match(await ok(["portal", "upload", "Form", "#arq", attFile]), /1 arquivo/);
});

test("URLs bloqueadas: metadata/link-local e a API do próprio servidor; localhost em outra porta e ALLOW_PRIVATE liberam", { skip }, async () => {
  for (const url of ["http://169.254.169.254/latest/meta-data", "http://169.254.1.1/", "http://[fd00:ec2::254]/", "http://[::ffff:169.254.169.254]/", "http://metadata.google.internal/computeMetadata/v1/", `http://127.0.0.1:${port}/api/health`, `http://localhost:${port}/`]) {
    const create = await maestri(["portal", "create", url, "Bloq"]);
    assert.equal(create.code, 1, url);
    assert.match(create.stderr, /^maestri: error: URL bloqueada: /, url);
    assert.match((await maestri(["portal", "navigate", "Form", url])).stderr, /URL bloqueada/, url);
  }
  assert.equal(await nodeByTitle("Bloq"), undefined);
  assert.match((await maestri(["portal", "create", "ftp://x/", "Bloq"])).stderr, /URL inválida \(apenas http\/https\)/);
  // localhost em outra porta (o site de teste) segue permitido
  assert.equal((await maestri(["portal", "navigate", "Form", `${site}/outra`])).code, 0);
  await ok(["portal", "navigate", "Form", `${site}/`]);
  // o site não alcança o metadata nem por sub-requisição (fetch) nem por redirecionamento: a requisição é abortada
  assert.equal(await ok(["portal", "evaluate", "Form", "(async () => { try { await fetch('http://169.254.169.254/x'); return 'passou'; } catch { return 'bloqueado'; } })()"]), "bloqueado");
  assert.equal(await ok(["portal", "evaluate", "Form", `(async () => { try { await fetch('http://127.0.0.1:${port}/api/health', { mode: 'no-cors' }); return 'passou'; } catch { return 'bloqueado'; } })()`]), "bloqueado");
  // MAESTRI_PORTAL_ALLOW_PRIVATE=1 libera
  process.env.MAESTRI_PORTAL_ALLOW_PRIVATE = "1";
  try {
    const r = await maestri(["portal", "create", `http://127.0.0.1:${port}/api/health`, "Liberado"]);
    assert.equal(r.code, 0, r.stderr);
    await ok(["portal", "close", "Liberado"]);
  } finally {
    delete process.env.MAESTRI_PORTAL_ALLOW_PRIVATE;
  }
});

test("WS: entradas enviadas antes da página abrir ficam na fila e valem; erro com cliente caído não derruba", { skip }, async () => {
  const again = await maestri(["portal", "create", site, "Fila2"]);
  assert.equal(again.code, 0, again.stderr);
  const n2 = await nodeByTitle("Fila2");
  // fecha a página (o nó fica) e reabre via WS: a navegação enviada no mesmo instante do open é aplicada depois do ensure
  portals.closeNodes(P, [n2.id]);
  assert.equal(portals.has(P, n2.id), false);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/portal?project=${P}&node=${n2.id}&token=tok-portal`);
  const got: any[] = [];
  ws.on("message", (d, isBinary) => !isBinary && got.push(JSON.parse(d.toString())));
  await new Promise((res, rej) => (ws.on("open", res), ws.on("error", rej)));
  ws.send(JSON.stringify({ type: "navigate", url: `${site}/outra` })); // antes de o ensure terminar
  await until(() => got.some((m) => m.type === "meta" && m.title === "Outra"), "navegação enfileirada aplicada", 20000);
  ws.close();
  // cliente que cai durante a abertura: o servidor segue de pé
  const quick = new WebSocket(`ws://127.0.0.1:${port}/ws/portal?project=${P}&node=${n2.id}&token=tok-portal`);
  quick.on("open", () => quick.terminate());
  await sleep(500);
  assert.match(await ok(["portal", "info", "Fila2"]), /url: /);
  await ok(["portal", "close", "Fila2"]);
});

test("create --size, close e remoção do nó pelo canvas fecham a página", { skip }, async () => {
  const r = await maestri(["portal", "create", site, "Segundo", "--size", "390x844"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /390x844/);
  const seg = await nodeByTitle("Segundo");
  assert.deepEqual(seg.data.viewport, { w: 390, h: 844 });
  assert.ok(seg.style.height > seg.style.width, "nó em retrato");
  assert.match(await ok(["portal", "snapshot", "Segundo"]), /^viewport: 390x844/);
  assert.match(await ok(["portal", "close", "Segundo"]), /fechado/);
  assert.equal(await nodeByTitle("Segundo"), undefined);
  assert.match((await maestri(["portal", "info", "Segundo"])).stderr, /não encontrado/);

  // remover o nó pelo canvas (como a UI faz) também fecha a página
  const form = await nodeByTitle("Form");
  assert.equal(portals.has(P, form.id), true);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/project/${P}?token=tok-portal&clientId=ui`);
  await new Promise((r, j) => (ws.on("open", r), ws.on("error", j)));
  ws.send(JSON.stringify({ type: "op", op: { kind: "removeNodes", ids: [form.id] } }));
  await until(() => !portals.has(P, form.id), "página fechada com o nó");
  ws.close();
});
