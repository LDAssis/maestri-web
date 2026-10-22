// Comunicação do CLI (F13): ask --batch/--raw, say, recall e debug. Carregado por bin/maestri.
import fs from "node:fs";

const THREADS = ["blue", "purple", "pink", "red", "orange", "yellow", "green"];

const HELP = {
  ask: `maestri ask "Nome" "texto" [--timeout S]
maestri ask "Nome" --raw "2\\n" [--timeout S]
maestri ask --batch '{"A":"prompt","B":"prompt"}' [--timeout S]

Envia o texto e espera o terminal do alvo ficar 5s quieto; imprime só a saída nova.
--raw envia entrada crua, sem Enter automático. Escapes: \\n (Enter), \\t (Tab), \\e (ESC), \\xNN (byte), \\\\ (barra).
--batch dispara asks em paralelo para agentes conectados distintos e imprime um array JSON de
{name, output} ou {name, error}. --timeout vale para cada ask (padrão 600s).
Timeout: imprime o que houver e sai com código 2 (no batch, o item ganha "timedOut": true).`,
  send: `maestri send "Nome" "texto"
maestri send "Nome" --raw "\\e[A"
Escreve o texto e Enter no terminal do agente conectado, sem esperar resposta.
--raw envia entrada crua (escapes \\n \\t \\e \\xNN) sem Enter automático.`,
  say: `maestri say "texto markdown" [--file caminho] [--progress "texto"]
Responde ao usuário na face de chat do SEU nó, na thread atual (a da última mensagem do usuário).
Sem argumento, lê o texto da entrada padrão (heredoc/pipe). --file lê um arquivo UTF-8.
--progress publica um balão intermediário (estilo diferente) — use enquanto ainda trabalha.
"chat reply" continua funcionando como alias.`,
  recall: `maestri recall [thread] [--turns N | --last day|week|month | --from YYYY-MM-DD [--to YYYY-MM-DD] | --all] [--json]
maestri recall list
Relê a conversa do chat do seu nó. thread = blue|purple|pink|red|orange|yellow|green (padrão: a atual).
Padrão: últimos 10 turnos. "recall list" mostra as threads com a contagem de mensagens.
Só lê o diálogo (mensagens do usuário e respostas do agente): balões de progresso (say --progress) e a saída
capturada do terminal ficam de fora de propósito; por isso a contagem pode ser menor que a do badge da UI.`,
  debug: `maestri debug
Diagnostica o ambiente: variáveis MAESTRI_*, API (/api/health), nó no canvas, sessão e papel de Maestro.
Sai com 0 se tudo estiver certo, 1 caso contrário.`,
};

const SUMMARY = [
  "Comunicação:",
  '  ask --batch \'{"A":"p1","B":"p2"}\'   Vários asks em paralelo; imprime array JSON',
  '  ask|send "Nome" --raw "2\\n"          Entrada crua (\\n Enter, \\t, \\e ESC, \\xNN)',
  '  say "texto" [--file F] [--progress T] Responde no chat (thread atual); sem texto lê stdin',
  "  recall [thread] [--turns N|--last day|week|month|--from D [--to D]|--all] [--json]",
  "  recall list                          Threads do chat com contagem de mensagens",
  "  debug                                Diagnóstico do ambiente do Maestri",
];

const readStdin = async () => {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
};

export function register({ call, need, CliError }) {
  const timeoutOf = (flags) => Number(flags.timeout) || 600;

  // Um ask de uma thread do batch: nunca lança, devolve {name, output} ou {name, error}
  async function askOne(name, text, timeout) {
    try {
      const r = await call("POST", "/ask", { target: name, text, timeout });
      return { name, output: r.output ?? "", ...(r.timedOut && { timedOut: true }) };
    } catch (e) {
      return { name, error: e?.message || String(e) };
    }
  }

  async function ask({ pos, flags }) {
    const timeout = timeoutOf(flags);
    if (flags.batch !== undefined) {
      let obj;
      try {
        obj = JSON.parse(flags.batch);
      } catch {
        throw new CliError('--batch espera um JSON: \'{"Agente":"prompt",...}\'.');
      }
      const names = obj && typeof obj === "object" && !Array.isArray(obj) ? Object.keys(obj) : [];
      if (!names.length) throw new CliError("--batch precisa de um objeto {nome: prompt} não vazio.");
      if (names.some((n) => typeof obj[n] !== "string")) throw new CliError("Cada prompt do --batch deve ser texto.");
      const lower = names.map((n) => n.trim().toLowerCase());
      if (new Set(lower).size !== names.length) throw new CliError("--batch exige agentes distintos.");
      const results = await Promise.all(names.map((n) => askOne(n, obj[n], timeout)));
      console.log(JSON.stringify(results, null, 2));
      if (results.some((r) => r.error)) process.exitCode = 1;
      else if (results.some((r) => r.timedOut)) process.exitCode = 2;
      return;
    }
    if (flags.raw !== undefined) {
      need(pos, 1, 'ask "Nome" --raw "texto com escapes"');
      const r = await call("POST", "/raw", { target: pos[0], input: flags.raw, wait: true, timeout });
      if (r.output) console.log(r.output);
      if (r.timedOut) {
        console.error(`[maestri] Timeout: ${pos[0]} não ficou quieto a tempo; saída parcial acima.`);
        process.exitCode = 2;
      }
      return;
    }
    need(pos, 2, 'ask "Nome" "texto" [--timeout S]');
    const r = await call("POST", "/ask", { target: pos[0], text: pos.slice(1).join(" "), timeout });
    if (r.output) console.log(r.output);
    if (r.timedOut) {
      console.error(`[maestri] Timeout: ${pos[0]} não ficou quieto a tempo; saída parcial acima.`);
      process.exitCode = 2;
    }
  }

  async function send({ pos, flags }) {
    if (flags.raw !== undefined) {
      need(pos, 1, 'send "Nome" --raw "texto com escapes"');
      await call("POST", "/raw", { target: pos[0], input: flags.raw });
      return console.log(`Enviado (cru) para ${pos[0]}.`);
    }
    need(pos, 2, 'send "Nome" "texto"');
    await call("POST", "/send", { target: pos[0], text: pos.slice(1).join(" ") });
    console.log(`Enviado para ${pos[0]}.`);
  }

  async function say({ pos, flags }) {
    let text = flags.progress ?? (flags.file ? fs.readFileSync(flags.file, "utf8") : pos.join(" "));
    if (flags.progress === undefined && flags.file === undefined && !pos.length) {
      if (process.stdin.isTTY) throw new CliError('Uso: maestri say "texto" | say --file F | say --progress "texto" | heredoc/pipe');
      text = await readStdin();
    }
    if (flags.file !== undefined && flags.progress === undefined && pos.length) throw new CliError("Use texto OU --file, não os dois.");
    if (!String(text).trim()) throw new CliError("Texto vazio.");
    const r = await call("POST", "/say", { text, ...(flags.progress !== undefined && { progress: true }) });
    console.log(flags.progress !== undefined ? `Progresso enviado (thread ${r.thread}).` : `Resposta enviada (thread ${r.thread}).`);
  }

  async function recall({ pos, flags }) {
    if (pos[0] === "list") {
      const r = await call("GET", "/recall/threads");
      if (flags.json) return console.log(JSON.stringify(r, null, 2));
      for (const t of r.threads) console.log(`${t.thread}${t.thread === r.current ? " *" : ""}: ${t.messages} mensagens${t.lastAt ? ` (última ${t.lastAt})` : ""}`);
      return console.log("\n* = thread atual");
    }
    if (pos[0] && !THREADS.includes(pos[0])) throw new CliError(`Thread inválida "${pos[0]}" (${THREADS.join(", ")}).`);
    const q = new URLSearchParams();
    if (pos[0]) q.set("thread", pos[0]);
    for (const k of ["turns", "last", "from", "to"]) if (flags[k] !== undefined) q.set(k, flags[k]);
    if (flags.all) q.set("all", "true");
    const r = await call("GET", `/recall?${q}`);
    if (flags.json) return console.log(JSON.stringify(r, null, 2));
    if (!r.messages.length) return console.log(`Nenhuma mensagem na thread ${r.thread}.`);
    console.log(`# thread ${r.thread}`);
    for (const m of r.messages) console.log(`[${m.at}] ${m.role === "user" ? m.author?.name || "usuário" : "agente"}: ${m.text}`);
  }

  async function debug() {
    const e = process.env;
    const vars = ["MAESTRI_API_URL", "MAESTRI_PROJECT_ID", "MAESTRI_NODE_ID"];
    let ok = true;
    const line = (good, label, extra = "") => {
      if (!good) ok = false;
      console.log(`${good ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
    };
    for (const v of vars) line(!!e[v], v, e[v] ? (v === "MAESTRI_TOKEN" ? "definido" : e[v]) : "ausente");
    // O token só é obrigatório quando o servidor exige autenticação (authRequired no /health)
    let authRequired = true;
    if (!e.MAESTRI_API_URL) {
      line(false, "API", "sem MAESTRI_API_URL");
    } else {
      try {
        const res = await fetch(`${e.MAESTRI_API_URL.replace(/\/$/, "")}/health`);
        line(res.ok, "API responde (/api/health)", `HTTP ${res.status}`);
        authRequired = (await res.json().catch(() => ({}))).authRequired !== false;
      } catch (err) {
        line(false, "API responde (/api/health)", err.cause?.code || err.message);
      }
    }
    line(!!e.MAESTRI_TOKEN || !authRequired, "MAESTRI_TOKEN", e.MAESTRI_TOKEN ? "definido" : authRequired ? "ausente" : "ausente (o servidor não exige token)");
    if (e.MAESTRI_API_URL && e.MAESTRI_PROJECT_ID && e.MAESTRI_NODE_ID) {
      try {
        const d = await call("GET", "/debug");
        line(true, "Nó existe no canvas", `${d.node.title} (${d.node.type})`);
        line(d.session, "Sessão ativa");
        console.log(`  Maestro: ${d.isMaestro ? "sim" : "não"} · conectados: ${d.connected}`);
      } catch (err) {
        line(false, "Nó existe no canvas", err.message);
      }
    } else line(false, "Nó existe no canvas", "variáveis ausentes");
    if (!ok) process.exitCode = 1;
  }

  return {
    commands: { ask, send, say, recall, debug },
    help: HELP,
    flags: ["--batch", "--raw", "--file", "--progress", "--turns", "--from", "--to"],
    boolFlags: ["--all", "--json"],
    summary: SUMMARY,
  };
}
