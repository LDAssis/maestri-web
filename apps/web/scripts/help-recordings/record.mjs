// Grava os clipes da Central de Ajuda (tela real do Maestri Web) contra a instância ISOLADA de gravação.
// Uso: node record.mjs [id ...]      (sem ids = todos)      Veja README.md.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");

const WEB = process.env.WEB || "http://127.0.0.1:3100";
const API = process.env.API || "http://127.0.0.1:4100";
const OUT = process.env.OUT || "/tmp/maestri-rec/out";
const W = 1280;
const H = 800;
const PEOPLE = {
  ana: { email: "ana@exemplo.com", password: "Maestri#Demo2026!" },
  bruno: { email: "bruno@exemplo.com", password: "Maestri#Demo2026!" },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(p, token, init = {}) {
  const res = await fetch(API + p, { ...init, headers: { "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }) } });
  return res.json();
}
const sessions = {};
// um login por pessoa (o servidor limita tentativas de login: 10 a cada 15 min)
const login = async (who) => (sessions[who] ??= await api("/api/auth/login", null, { method: "POST", body: JSON.stringify(PEOPLE[who]) }));

// Ponteiro visível + destaque de clique (a gravação de vídeo não captura o cursor do sistema)
const CURSOR_JS = `(() => {
  const mk = () => {
    if (document.getElementById("__cur")) return;
    const st = document.createElement("style");
    st.textContent = "#__cur{position:fixed;left:0;top:0;width:22px;height:22px;margin:-4px 0 0 -4px;z-index:2147483647;pointer-events:none;transition:transform .05s linear}#__cur svg{filter:drop-shadow(0 1px 2px rgba(0,0,0,.6))}.__rip{position:fixed;z-index:2147483646;pointer-events:none;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;border:3px solid #818cf8;animation:__rip .55s ease-out forwards}@keyframes __rip{to{transform:scale(3.2);opacity:0}}";
    document.head.appendChild(st);
    const c = document.createElement("div");
    c.id = "__cur";
    c.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 2l16 9-7 2-3 7z" fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    document.body.appendChild(c);
    addEventListener("mousemove", (e) => { c.style.transform = "translate(" + e.clientX + "px," + e.clientY + "px)"; }, true);
    addEventListener("mousedown", (e) => {
      const r = document.createElement("div");
      r.className = "__rip"; r.style.left = e.clientX + "px"; r.style.top = e.clientY + "px";
      document.body.appendChild(r); setTimeout(() => r.remove(), 600);
    }, true);
  };
  if (document.body) mk(); else addEventListener("DOMContentLoaded", mk);
})();`;

let browser;
const results = [];

async function ctxFor(who, projectName, extra = {}) {
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    acceptDownloads: true,
    permissions: ["clipboard-read", "clipboard-write"],
    ...extra,
  });
  await context.addInitScript(CURSOR_JS);
  if (who) {
    const s = await login(who);
    const projects = await api("/api/projects", s.token);
    const target = projects.find((p) => p.name === projectName) ?? projects[0];
    await context.addInitScript(
      ([tok, user, pid]) => {
        try {
          localStorage.setItem("maestri.token", tok);
          localStorage.setItem("maestri.user", JSON.stringify(user));
          if (pid) localStorage.setItem("maestri.lastProject", pid);
        } catch {}
      },
      [s.token, s.user, target?.id],
    );
    return { context, token: s.token, user: s.user, projects };
  }
  return { context };
}

// Movimento humano: vai até o centro do elemento em passos, pausa, clica
async function click(page, target, { pause = 180, steps = 14, offset } = {}) {
  const loc = typeof target === "string" ? page.locator(target).first() : target.first();
  await loc.waitFor({ state: "visible", timeout: 15000 });
  const b = await loc.boundingBox();
  const x = b.x + (offset?.x ?? b.width / 2);
  const y = b.y + (offset?.y ?? b.height / 2);
  await page.mouse.move(x, y, { steps });
  await sleep(pause);
  await page.mouse.click(x, y);
  await sleep(280);
}
const move = async (page, x, y, steps = 25) => page.mouse.move(x, y, { steps });
const typeText = async (page, text, delay = 55) => page.keyboard.type(text, { delay });

async function openApp(page, { wait = 2500 } = {}) {
  await page.goto(WEB, { waitUntil: "domcontentloaded" });
  await page.locator(".react-flow__pane").first().waitFor({ timeout: 60000 });
  await sleep(wait);
}

async function openRecording(who, projectName, extra) {
  const c = await ctxFor(who, projectName, { recordVideo: { dir: mkdtempSync(path.join(tmpdir(), "rec-")), size: { width: W, height: H } }, ...extra });
  const page = await c.context.newPage();
  return { ...c, page, t0: Date.now() };
}

const MAX_SEC = { "primeiros-passos": 26 }; // fluxo mais longo (login + projeto + agente + prompt)
function convert(src, id, trimStart, maxSec = MAX_SEC[id] ?? 20) {
  mkdirSync(OUT, { recursive: true });
  const webm = path.join(OUT, `${id}.webm`);
  const jpg = path.join(OUT, `${id}.jpg`);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(Math.max(0, trimStart)), "-i", src, "-t", String(maxSec), "-an",
    "-vf", "fps=20,scale=1120:-2", "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "41", "-row-mt", "1", "-cpu-used", "2", "-deadline", "good", webm]);
  const dur = parseFloat(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", webm]).toString());
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(Math.max(0.5, dur * 0.55)), "-i", webm, "-frames:v", "1", "-q:v", "5", jpg]);
  const kb = Math.round(statSync(webm).size / 1024);
  results.push({ id, kb });
  console.log(`✔ ${id}: ${kb} KB`);
}

async function clip(id, who, projectName, fn, extra) {
  const r = await openRecording(who, projectName, extra);
  let start = null;
  const ctx = { ...r, mark: () => (start = Date.now()), openApp: (o) => openApp(r.page, o) };
  try {
    await fn(r.page, ctx);
    await sleep(1500);
    const video = r.page.video();
    await r.context.close();
    convert(await video.path(), id, ((start ?? r.t0 + 1500) - r.t0) / 1000 - 0.3);
  } catch (e) {
    try { await r.page.screenshot({ path: path.join(OUT, `${id}-erro.png`) }); } catch {}
    await r.context.close().catch(() => {});
    console.error(`✘ ${id}: ${e.message.split("\n")[0]}`);
    results.push({ id, error: e.message.split("\n")[0] });
  }
}

const dropdown = (page) => page.locator("header button:has(.lucide-chevron-down)").first();
const pane = (page) => page.locator(".react-flow__pane").first();
// Ponto do fundo (pane) que não está coberto por nenhum nó, para o clique direito
const freePoint = (page) =>
  page.evaluate(() => {
    for (let y = 640; y > 140; y -= 40)
      for (let x = 120; x < 1180; x += 40) {
        const el = document.elementFromPoint(x, y);
        if (el && el.classList.contains("react-flow__pane")) return { x, y };
      }
    return { x: 700, y: 700 };
  });
const paneRightClick = async (page) => {
  const { x, y } = await freePoint(page);
  await move(page, x, y);
  await sleep(300);
  await page.mouse.click(x, y, { button: "right" });
  await sleep(500);
};

/* ----------------------------- CLIPES ----------------------------- */
const CLIPS = {
  // login -> criar projeto -> abrir agente -> mandar prompt
  "primeiros-passos": () =>
    clip("primeiros-passos", null, null, async (page, c) => {
      await page.goto(WEB, { waitUntil: "domcontentloaded" });
      await page.locator("input[type=email]").waitFor({ timeout: 60000 });
      await sleep(300);
      c.mark();
      await click(page, "input[type=email]");
      await typeText(page, "ana@exemplo.com", 28);
      await click(page, "input[type=password]");
      await typeText(page, "Maestri#Demo2026!", 22);
      await click(page, "button:has-text('Entrar')");
      await page.locator(".react-flow__pane").first().waitFor({ timeout: 60000 });
      await sleep(700);
      await click(page, dropdown(page));
      await click(page, "button:has-text('Criar Novo Projeto')");
      await click(page, "input[placeholder^='ex: App Delivery']");
      await typeText(page, "Meu Primeiro Projeto", 32);
      await click(page, "button:has-text('Criar Projeto')");
      await sleep(1400);
      await click(page, pane(page), { offset: { x: 400, y: 300 } });
      await page.keyboard.press("a");
      await sleep(300);
      await click(page, "input[placeholder='ex: Backend']");
      await typeText(page, "Backend", 40);
      await sleep(400);
      await click(page, "button:has-text('Criar agente')");
      await page.locator(".xterm").first().waitFor({ timeout: 30000 });
      await sleep(2000);
      await click(page, ".xterm");
      await typeText(page, "Crie o componente de resumo do pedido", 32);
      await page.keyboard.press("Enter");
      await sleep(5500);
    }),

  // sidebar (grupos/fixar) + Membros adicionando alguém
  projetos: () =>
    clip("projetos", "ana", "Loja Virtual", async (page, c) => {
      await c.openApp();
      c.mark();
      await click(page, dropdown(page));
      await sleep(1100);
      await click(page, "button:has-text('Organizar grupos e pastas')");
      await sleep(1000);
      const pin = page.locator("button[aria-label^='Fixar']").first();
      if (await pin.count()) await click(page, pin);
      await sleep(800);
      await page.keyboard.press("Escape");
      await sleep(600);
      await click(page, dropdown(page));
      await click(page, "button:has-text('Membros')");
      await sleep(800);
      await click(page, "input[aria-label='Buscar usuário']");
      await typeText(page, "Carla", 70);
      await sleep(900);
      await click(page, "button[aria-label^='Adicionar Carla']");
      await sleep(2200);
    }),

  // pan/zoom, Ctrl+K, menu de contexto criando nota
  canvas: () =>
    clip("canvas", "ana", "Loja Virtual", async (page, c) => {
      await c.openApp();
      c.mark();
      await move(page, 640, 650);
      await page.mouse.down();
      await move(page, 520, 600, 30);
      await move(page, 760, 560, 30);
      await page.mouse.up();
      await sleep(500);
      await page.mouse.wheel(0, -300);
      await sleep(700);
      await page.mouse.wheel(0, 500);
      await sleep(900);
      await page.keyboard.press("Control+k");
      await sleep(700);
      await typeText(page, "Contrato", 90);
      await sleep(1000);
      await page.keyboard.press("Enter");
      await sleep(1800);
      await paneRightClick(page);
      await click(page, "[role=menuitem]:has-text('Nova nota')");
      await sleep(2500);
    }),

  // selecionar/copiar no terminal; anexo na face Chat
  terminais: () =>
    clip("terminais", "ana", "Loja Virtual", async (page, c) => {
      await c.openApp({ wait: 3500 });
      c.mark();
      const term = page.locator(".xterm").first();
      await click(page, term);
      await typeText(page, "Adicione o campo de cupom no checkout", 45);
      await page.keyboard.press("Enter");
      await sleep(6000);
      const b = await term.boundingBox();
      await move(page, b.x + 20, b.y + b.height - 90);
      await page.mouse.down();
      await move(page, b.x + b.width - 40, b.y + b.height - 60, 25);
      await page.mouse.up();
      await sleep(700);
      await click(page, "button[aria-label='Copiar seleção']");
      await sleep(1200);
      await click(page, "button[title='Ver Face de Chat']");
      await sleep(1500);
      const [chooser] = await Promise.all([page.waitForEvent("filechooser"), click(page, "button[aria-label='Anexar arquivo']")]);
      writeFileSync("/tmp/maestri-rec/captura-de-tela.png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
      await chooser.setFiles("/tmp/maestri-rec/captura-de-tela.png");
      await sleep(2500);
    }),

  // ligar uma nota a um agente (arrastar da bolinha)
  equipe: () =>
    clip("equipe", "ana", "App Delivery", async (page, c) => {
      await c.openApp({ wait: 3000 });
      c.mark();
      const noteH = page.locator(".react-flow__node-stickyNote .react-flow__handle.source, .react-flow__node-stickyNote .react-flow__handle").last();
      const agentH = page.locator(".react-flow__node-agentTerminal .react-flow__handle").first();
      await noteH.waitFor({ timeout: 15000 });
      const a = await noteH.boundingBox();
      const t = await agentH.boundingBox();
      await move(page, a.x + a.width / 2, a.y + a.height / 2, 30);
      await sleep(600);
      await page.mouse.down();
      await move(page, t.x + t.width / 2, t.y + t.height / 2, 40);
      await sleep(500);
      await page.mouse.up();
      await sleep(2500);
    }),

  // criar andar (agente isolado) e alternar
  andares: () =>
    clip("andares", "ana", "Loja Virtual", async (page, c) => {
      await c.openApp({ wait: 3500 });
      c.mark();
      await click(page, "button:has-text('Criar andar')");
      await sleep(3500);
      await click(page, "button:has-text('Andar:')");
      await sleep(1800);
      const other = page.locator("[role=listbox][aria-label='Andares'] button").nth(1);
      if (await other.count()) await click(page, other);
      await sleep(2500);
      await click(page, "button:has-text('Andar:')");
      await sleep(1500);
    }),

  // criar rotina
  rotinas: () =>
    clip("rotinas", "ana", "Loja Virtual", async (page, c) => {
      await c.openApp();
      c.mark();
      await click(page, "button:has-text('Rotinas')");
      await sleep(1200);
      await click(page, "button:has-text('Nova rotina')");
      await click(page, "input[placeholder='ex: auditoria noturna']");
      await typeText(page, "Resumo diário");
      await sleep(500);
      await page.locator("select").nth(0).selectOption({ index: 1 }).catch(() => {});
      await sleep(600);
      await click(page, "textarea");
      await typeText(page, "Resuma o que mudou hoje no projeto", 40);
      await sleep(900);
      await click(page, "button:has-text('Criar rotina')");
      await sleep(2800);
    }),

  // árvore de arquivos -> ver arquivo -> baixar
  arquivos: () =>
    clip("arquivos", "ana", "Loja Virtual", async (page, c) => {
      await c.openApp();
      c.mark();
      await click(page, "button:has-text('Arquivos')");
      await sleep(2500);
      const dir = page.locator("[role=tree] button:has-text('src')").first();
      if (await dir.count()) await click(page, dir);
      await sleep(900);
      await click(page, "[role=tree] button:has-text('preco.ts')");
      await sleep(2500);
      await click(page, "button[aria-label='Fechar visualizador']");
      await sleep(800);
      const dl = page.locator("button[aria-label^='Baixar src'], button[aria-label='Baixar pasta src (.zip)']").first();
      const download = page.waitForEvent("download", { timeout: 15000 }).catch(() => null);
      await click(page, dl);
      await download;
      await sleep(1800);
    }),

  // dois navegadores: o cursor do outro usuário aparece
  colaboracao: async () => {
    const bruno = await ctxFor("bruno", "Loja Virtual");
    const bp = await bruno.context.newPage();
    await openApp(bp, { wait: 2500 });
    await clip("colaboracao", "ana", "Loja Virtual", async (page, c) => {
      await c.openApp({ wait: 2500 });
      c.mark();
      const loop = (async () => {
        const pts = [[300, 300], [520, 380], [760, 300], [900, 480], [640, 560], [420, 460], [560, 340]];
        for (const [x, y] of pts) {
          await bp.mouse.move(x, y, { steps: 40 });
          await sleep(500);
        }
      })();
      await sleep(1500);
      await move(page, 380, 450, 30);
      await loop;
      await sleep(1500);
    });
    await bruno.context.close();
  },

  // admin: convite e botão Projetos do usuário
  administracao: () =>
    clip("administracao", "ana", "Loja Virtual", async (page, c) => {
      await c.openApp();
      c.mark();
      await click(page, "button[aria-label='Usuários e acessos']");
      await sleep(900);
      await click(page, "[role=tab]:has-text('Convites')");
      await sleep(900);
      await click(page, "input#invite-note");
      await typeText(page, "para a Marina (design)", 35);
      await click(page, "button:has-text('Gerar link de convite')");
      await sleep(1400);
      await click(page, "[role=tab]:has-text('Usuários')");
      await sleep(800);
      await click(page, "button[aria-label='Projetos de Bruno']");
      await sleep(1600);
      const box = page.locator("input[type=checkbox]:not(:disabled)").first();
      if (await box.count()) await click(page, box);
      await sleep(900);
      await click(page, "button:has-text('Salvar projetos')");
      await sleep(1800);
    }),

  // ? abre a Central de Ajuda nos atalhos; depois Ctrl+K
  atalhos: () =>
    clip("atalhos", "ana", "Loja Virtual", async (page, c) => {
      await c.openApp();
      await click(page, pane(page), { offset: { x: 700, y: 700 } });
      c.mark();
      await sleep(600);
      await page.keyboard.press("?");
      await sleep(3500);
      await page.keyboard.press("Escape");
      await sleep(900);
      await page.keyboard.press("Control+k");
      await sleep(900);
      await typeText(page, "Back", 100);
      await sleep(2000);
      await page.keyboard.press("Escape");
      await sleep(800);
    }),
};

/* ----------------------------- MAIN ----------------------------- */
const wanted = process.argv.slice(2);
const ids = wanted.length ? wanted : Object.keys(CLIPS);
browser = await chromium.launch({ args: ["--no-sandbox", "--force-device-scale-factor=1"] });
// aquece a compilação do next dev (a primeira carga é lenta)
{
  const warm = await browser.newPage();
  await warm.goto(WEB, { waitUntil: "domcontentloaded" }).catch(() => {});
  await sleep(4000);
  await warm.close();
}
for (const id of ids) {
  if (!CLIPS[id]) {
    console.error(`clipe desconhecido: ${id}`);
    continue;
  }
  await CLIPS[id]();
}
await browser.close();
writeFileSync(path.join(OUT, "resultado.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results));
if (results.some((r) => r.error)) process.exitCode = 1;
