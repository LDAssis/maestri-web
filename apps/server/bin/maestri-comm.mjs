// Comunicação do CLI (F13): ask --batch/--raw, say, recall e debug. Carregado por bin/maestri.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const THREADS = ["blue", "purple", "pink", "red", "orange", "yellow", "green"];

const HELP = {
  ask: `maestri ask "Nome" "texto" [--timeout S]
maestri ask "Nome" --raw "2\\n" [--timeout S]
maestri ask --batch '{"A":"prompt","B":"prompt"}' [--timeout S]

Envia o texto e espera o terminal do alvo ficar 5s quieto; imprime só a saída nova.
--raw envia entrada crua, sem Enter automático. Escapes: \\n (Enter), \\t (Tab), \\e (ESC), \\xNN (byte), \\\\ (barra).
--batch dispara asks em paralelo para agentes conectados distintos e imprime um array JSON de
{name, output} ou {name, error}. --timeout vale para cada ask (padrão 600s).
Timeout: imprime o que houver e sai com código 2 (no batch, o item ganha "timedOut": true).
Se o terminal do alvo estava descarregado (sem sessão), o ask o inicia (cwd e comando do nó) e responde "ainda iniciando;
pergunte de novo" com código 3, sem digitar. "Ainda iniciando" vale até o terminal acordado produzir saída e ficar quieto por MAESTRI_WAKE_SETTLE_MS (1,5s), no máximo MAESTRI_WAKE_STARTUP_MS (30s); passado esse tempo o ask
funciona normalmente. send e check também iniciam o terminal. Alvos de outros workspaces: "Nome @ Workspace".`,
  send: `maestri send "Nome" "texto"
maestri send "Nome" --raw "\\e[A"
Escreve o texto e Enter no terminal do agente conectado, sem esperar resposta.
--raw envia entrada crua (escapes \\n \\t \\e \\xNN) sem Enter automático.`,
  say: `maestri say "texto markdown" [--file caminho] [--attach caminho ...] [--progress "texto"]
Responde ao usuário na face de chat do SEU nó, na thread atual (a da última mensagem do usuário).
Sem argumento, lê o texto da entrada padrão (heredoc/pipe). --file lê um arquivo UTF-8; se for uma imagem
(PNG, JPEG, GIF, WebP), anexa a imagem (o texto posicional vira a legenda).
--attach CAMINHO (repetível, até 20MB cada) anexa arquivos à resposta final; o usuário baixa pela ChatFace.
Uma linha só com ![descrição](/caminho/absoluto/img.png) vira imagem embutida.
--progress publica um balão intermediário (estilo diferente) — use enquanto ainda trabalha.
"chat reply" continua funcionando como alias.`,
  recall: `maestri recall [thread] [--turns N | --last day|week|month | --from YYYY-MM-DD [--to YYYY-MM-DD] | --all] [--json]
maestri recall list
maestri recall attachment <id>
Relê a conversa do chat do seu nó. thread = blue|purple|pink|red|orange|yellow|green (padrão: a atual).
Padrão: últimos 10 turnos. As mensagens com anexos mostram os ids; "recall attachment <id>" salva o anexo em um
arquivo temporário e imprime o caminho. "recall list" mostra as threads com a contagem de mensagens.
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
  '  say "texto" [--file F] [--attach F ...] [--progress T] Responde no chat (thread atual); sem texto lê stdin',
  "  recall [thread] [--turns N|--last day|week|month|--from D [--to D]|--all] [--json]",
  "  recall list                          Threads do chat com contagem de mensagens",
  "  recall attachment <id>               Salva um anexo do chat num arquivo temporário e imprime o caminho",
  "  debug                                Diagnóstico do ambiente do Maestri",
];

const ATTACH_MAX = 20 * 1024 * 1024;
// PNG, JPEG, GIF ou WebP de verdade (primeiros bytes), não só pela extensão
const isImage = (b) =>
  (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) ||
  (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) ||
  (b.length > 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString("latin1"))) ||
  (b.length > 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP");
// --attach é repetível (o parser do bin/maestri guarda só o último valor)
const argvValues = (flag) => process.argv.flatMap((a, i, all) => (a === flag && i + 1 < all.length ? [all[i + 1]] : []));
// Linha própria com imagem de caminho absoluto: ![descrição](/caminho/img.png)
const INLINE_IMG = /^!\[([^\]]*)\]\((\/[^)\s]+)\)[ \t]*$/gm;

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
      if (r.starting) return { name, output: "", starting: true, error: STARTING };
      if (r.error) return { name, error: r.error };
      return { name, output: r.output ?? "", ...(r.timedOut && { timedOut: true }) };
    } catch (e) {
      return { name, error: e?.message || String(e) };
    }
  }

  // O terminal estava descarregado e acabou de ser iniciado: o agente ainda sobe, então não se digita agora
  const STARTING = "ainda iniciando; pergunte de novo";
  function starting(name) {
    console.error(`[maestri] ${name}: ${STARTING}.`);
    process.exitCode = 3;
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
      if (results.some((r) => r.error && !r.starting)) process.exitCode = 1;
      else if (results.some((r) => r.timedOut)) process.exitCode = 2;
      if (results.some((r) => r.starting) && !process.exitCode) process.exitCode = 3;
      return;
    }
    if (flags.raw !== undefined) {
      need(pos, 1, 'ask "Nome" --raw "texto com escapes"');
      const r = await call("POST", "/raw", { target: pos[0], input: flags.raw, wait: true, timeout });
      if (r.error) throw new CliError(r.error);
      if (r.starting) return starting(pos[0]);
      if (r.output) console.log(r.output);
      if (r.timedOut) {
        console.error(`[maestri] Timeout: ${pos[0]} não ficou quieto a tempo; saída parcial acima.`);
        process.exitCode = 2;
      }
      return;
    }
    need(pos, 2, 'ask "Nome" "texto" [--timeout S]');
    const r = await call("POST", "/ask", { target: pos[0], text: pos.slice(1).join(" "), timeout });
    if (r.error) throw new CliError(r.error);
    if (r.starting) return starting(pos[0]);
    if (r.output) console.log(r.output);
    if (r.timedOut) {
      console.error(`[maestri] Timeout: ${pos[0]} não ficou quieto a tempo; saída parcial acima.`);
      process.exitCode = 2;
    }
  }

  async function send({ pos, flags }) {
    if (flags.raw !== undefined) {
      need(pos, 1, 'send "Nome" --raw "texto com escapes"');
      const r = await call("POST", "/raw", { target: pos[0], input: flags.raw });
      return console.log(`Enviado (cru) para ${pos[0]}.${r.starting ? " O terminal estava descarregado e foi iniciado." : ""}`);
    }
    need(pos, 2, 'send "Nome" "texto"');
    const r = await call("POST", "/send", { target: pos[0], text: pos.slice(1).join(" ") });
    console.log(`Enviado para ${pos[0]}.${r.starting ? " O terminal estava descarregado e foi iniciado; o agente ainda está subindo." : ""}`);
  }

  // Envia um arquivo local ao servidor (armazenamento por projeto) e devolve os metadados com o id estável
  async function upload(file) {
    let data;
    try {
      data = fs.readFileSync(file);
    } catch {
      throw new CliError(`Arquivo não encontrado: ${file}`);
    }
    if (!data.length) throw new CliError(`Arquivo vazio: ${file}`);
    if (data.length > ATTACH_MAX) throw new CliError(`Arquivo grande demais (máximo ${ATTACH_MAX / 1024 / 1024}MB): ${file}`);
    return (await call("POST", "/attachments", { name: path.basename(file), data: data.toString("base64") })).attachment;
  }

  async function say({ pos, flags }) {
    const attach = argvValues("--attach");
    if (flags.progress !== undefined && (attach.length || flags.file !== undefined)) throw new CliError("--file/--attach só valem na resposta final (não em --progress).");
    const ids = [];
    let text = flags.progress ?? pos.join(" ");
    if (flags.file !== undefined) {
      let buf;
      try {
        buf = fs.readFileSync(flags.file);
      } catch {
        throw new CliError(`Arquivo não encontrado: ${flags.file}`);
      }
      if (isImage(buf)) ids.push((await upload(flags.file)).id); // imagem: vira anexo; o texto posicional é a legenda
      else {
        if (pos.length) throw new CliError("Use texto OU --file, não os dois.");
        text = buf.toString("utf8");
      }
    } else if (flags.progress === undefined && !pos.length && !attach.length) {
      if (process.stdin.isTTY) throw new CliError('Uso: maestri say "texto" | say --file F | say --attach F "texto" | say --progress "texto" | heredoc/pipe');
      text = await readStdin();
    }
    for (const f of attach) ids.push((await upload(f)).id);
    // ![desc](/abs/img.png) em linha própria vira imagem embutida (anexo + referência)
    const inline = [...String(text).matchAll(INLINE_IMG)];
    if (inline.length) {
      const map = new Map();
      for (const m of inline) {
        const buf = fs.existsSync(m[2]) ? fs.readFileSync(m[2]) : null;
        if (!buf) throw new CliError(`Imagem não encontrada: ${m[2]}`);
        if (!isImage(buf)) throw new CliError(`Não é uma imagem PNG/JPEG/GIF/WebP: ${m[2]}`);
        if (!map.has(m[2])) map.set(m[2], (await upload(m[2])).id);
      }
      text = String(text).replace(INLINE_IMG, (_, desc, file) => `![${desc}](attachment:${map.get(file)})`);
      ids.push(...new Set(map.values()));
    }
    if (!String(text).trim() && !ids.length) throw new CliError("Texto vazio.");
    const r = await call("POST", "/say", { text, ...(ids.length && { attachments: [...new Set(ids)] }), ...(flags.progress !== undefined && { progress: true }) });
    const extra = ids.length ? ` com ${new Set(ids).size} anexo(s)` : "";
    console.log(flags.progress !== undefined ? `Progresso enviado (thread ${r.thread}).` : `Resposta enviada${extra} (thread ${r.thread}).`);
  }

  // recall attachment <id>: salva o anexo num arquivo temporário e imprime o caminho
  async function recallAttachment(id) {
    if (!id) throw new CliError("Uso: maestri recall attachment <id>");
    const { attachment, data } = await call("GET", `/attachments/${encodeURIComponent(id)}`);
    const dir = path.join(os.tmpdir(), "maestri-attachments");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${attachment.id}-${attachment.name}`);
    fs.writeFileSync(file, Buffer.from(data, "base64"), { mode: 0o600 });
    console.log(file);
  }

  async function recall({ pos, flags }) {
    if (pos[0] === "attachment") return recallAttachment(pos[1]);
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
    for (const m of r.messages) {
      const files = (m.attachments ?? []).map((a) => `${a.id} ${a.name}`).join(", ");
      console.log(`[${m.at}] ${m.role === "user" ? m.author?.name || "usuário" : "agente"}: ${m.text}${files ? `\n    [attachments: ${files}]` : ""}`);
    }
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
    flags: ["--batch", "--raw", "--file", "--attach", "--progress", "--turns", "--from", "--to"],
    boolFlags: ["--all", "--json"],
    summary: SUMMARY,
  };
}
