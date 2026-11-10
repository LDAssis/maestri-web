// `maestri usage-report` (interno, fora do help): statusline do claude. Lê o JSON do stdin, reporta o uso (rate limits) ao servidor
// só quando mudou ou a cada 60 s, e imprime uma linha curta. NUNCA falha nem demora: timeout de 1 s, erros silenciosos, sempre sai 0.
// Se o usuário já tinha uma statusLine, o servidor a passa em MAESTRI_USER_STATUSLINE: repassamos o stdin a ela e imprimimos a saída dela.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const THROTTLE_MS = 60_000;
const POST_TIMEOUT_MS = 1000;
const USER_TIMEOUT_MS = 5000;

const readStdin = () =>
  new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    const done = () => resolve(data);
    const timer = setTimeout(done, 2000); // sem EOF não prende o claude
    timer.unref();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => (clearTimeout(timer), done()));
    process.stdin.on("error", done);
  });

const pct = (w) => (w && Number.isFinite(w.used_percentage) ? `${Math.round(w.used_percentage)}%` : null);

// "<modelo> · 5h 13% · 7d 10%" (partes que faltam somem)
function summaryLine(data) {
  const m = data?.model;
  const model = typeof m === "string" ? m : m?.display_name || m?.id;
  const rl = data?.rate_limits ?? {};
  return [model, pct(rl.five_hour) && `5h ${pct(rl.five_hour)}`, pct(rl.seven_day) && `7d ${pct(rl.seven_day)}`].filter(Boolean).join(" · ");
}

// Só reporta quando mudou ou passou 1 min (cache em arquivo tmp por nó); a tentativa conta mesmo se falhar (servidor fora não atrasa a statusline)
function shouldReport(nodeId, fingerprint) {
  const file = path.join(os.tmpdir(), `maestri-usage-${nodeId.replace(/[^\w-]/g, "_")}.json`);
  let prev = null;
  try {
    prev = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {}
  const now = Date.now();
  if (prev && prev.fp === fingerprint && now - prev.at < THROTTLE_MS) return false;
  try {
    fs.writeFileSync(file, JSON.stringify({ fp: fingerprint, at: now }));
  } catch {}
  return true;
}

// MAESTRI_TOKEN_FILE (token do terminal, só o dono lê) vence; MAESTRI_TOKEN é o recurso do Maestri nativo/dev
function readToken() {
  const f = process.env.MAESTRI_TOKEN_FILE;
  if (f) {
    try {
      const t = fs.readFileSync(f, "utf8").trim();
      if (t) return t;
    } catch {}
  }
  return process.env.MAESTRI_TOKEN;
}

async function post(data) {
  const { MAESTRI_API_URL: api, MAESTRI_PROJECT_ID: project, MAESTRI_NODE_ID: nodeId } = process.env;
  const token = readToken();
  if (!api || !project || !nodeId) return;
  const m = data?.model;
  const model = typeof m === "string" ? m : m?.id || m?.display_name;
  const rl = data?.rate_limits;
  const body = { nodeId, ...(model && { model }), ...(rl && typeof rl === "object" && { rate_limits: { five_hour: rl.five_hour, seven_day: rl.seven_day } }) };
  if (!model && !rl) return; // nada a reportar (antes da 1ª resposta)
  if (!shouldReport(nodeId, JSON.stringify(body))) return;
  await fetch(`${api.replace(/\/$/, "")}/projects/${project}/usage/report`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(POST_TIMEOUT_MS),
  }).catch(() => {});
}

// Statusline do usuário: recebe o mesmo stdin; devolve a saída dela (ou null se falhou)
const runUser = (cmd, input) =>
  new Promise((resolve) => {
    const env = { ...process.env };
    delete env.MAESTRI_USER_STATUSLINE; // sem laço
    let out = "";
    let settled = false;
    const finish = (v) => settled || ((settled = true), resolve(v));
    try {
      const child = spawn(cmd, { shell: true, env, stdio: ["pipe", "pipe", "ignore"] });
      const timer = setTimeout(() => (child.kill(), finish(null)), USER_TIMEOUT_MS);
      child.stdout.on("data", (c) => (out += c));
      child.on("error", () => (clearTimeout(timer), finish(null)));
      child.on("close", (code) => (clearTimeout(timer), finish(code === 0 || out ? out : null)));
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    } catch {
      finish(null);
    }
  });

export function register() {
  async function usageReport() {
    try {
      const input = await readStdin();
      let data = {};
      try {
        data = JSON.parse(input) ?? {};
      } catch {}
      const user = process.env.MAESTRI_USER_STATUSLINE;
      const [, userOut] = await Promise.all([post(data).catch(() => {}), user ? runUser(user, input) : Promise.resolve(null)]);
      if (userOut != null) process.stdout.write(userOut);
      else {
        const line = summaryLine(data);
        if (line) console.log(line);
      }
    } catch {} // statusline nunca derruba o claude
    process.exitCode = 0;
  }
  return { commands: { "usage-report": usageReport }, help: { "usage-report": 'maestri usage-report   (interno) statusline do claude: reporta o uso (rate limits) ao servidor e imprime "<modelo> · 5h N% · 7d N%"' } };
}
