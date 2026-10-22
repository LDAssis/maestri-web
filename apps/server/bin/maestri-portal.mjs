// Subcomando `maestri portal` (carregado por bin/maestri): automação dos portais conectados.
// O servidor mantém um Chromium headless por portal; aqui só traduzimos argv -> API.

import path from "node:path";

const VERBS = [
  "back", "forward", "reload", "info", "screenshot", "snapshot", "click", "fill", "type", "key", "selectall", "clear",
  "hover", "focus", "select", "check", "uncheck", "upload", "scroll", "scrollintoview", "text", "html", "evaluate",
  "logs-start", "logs", "resize", "ua", "wait",
];

// Quantos argumentos (depois do nome do portal) cada verbo exige
const MIN_ARGS = { click: 1, fill: 2, type: 1, key: 1, hover: 1, focus: 1, select: 2, check: 1, uncheck: 1, upload: 2, scroll: 2, scrollintoview: 1, evaluate: 1, resize: 2 };

const HELP = `maestri portal create URL ["Nome"] [--size WxH]    Cria um portal à direita de você, conectado e aberto na URL
maestri portal edit "Portal" --url URL                 Aponta o portal para outra URL
maestri portal close "Portal"                          Remove o portal do canvas

Navegação e leitura (o portal precisa estar conectado a você):
maestri portal navigate|back|forward|reload "Portal" [url]
maestri portal info|snapshot|screenshot "Portal"        snapshot = árvore com refs @e1.. ; screenshot imprime o caminho do PNG
maestri portal text|html "Portal" [seletor]
maestri portal evaluate "Portal" "js"
maestri portal logs-start|logs "Portal"                 console da página (logs devolve e limpa o buffer)

Interação (seletor = @eN do snapshot, CSS ou x,y):
maestri portal click|hover|focus|scrollintoview "Portal" SEL
maestri portal fill "Portal" SEL "texto"                 substitui o valor
maestri portal type "Portal" [SEL] "texto"               acrescenta (sem SEL, no elemento focado)
maestri portal key "Portal" "Enter|Tab|Escape|ctrl+a|shift+tab|..."
maestri portal selectall|clear "Portal" [SEL]
maestri portal select "Portal" SEL "Texto da opção"
maestri portal check|uncheck "Portal" SEL
maestri portal upload "Portal" SEL arquivo...            (não use click em input de arquivo)
maestri portal scroll "Portal" up|down|left|right PX [x,y|@ref]

Espera:
maestri portal wait "Portal" @ref|seletor|--text "texto"|--url "padrão"|MS [--timeout S]
  elemento visível, texto na página, URL (substring ou glob com *) ou MS milissegundos; padrão de timeout 30s.
  Estourar o tempo é erro ("maestri: error: ...", código != 0).

Responsivo:
maestri portal resize "Portal" W H                       viewport CSS exato; imprime o obtido
maestri portal ua "Portal" [ios|android|firefox-android|edge-android|chrome|firefox|edge|desktop]   sem argumento: UA atual + presets

Só URLs http/https. Erros saem em stderr como "maestri: error: <motivo>" com código != 0.
Popups da página viram portais "[Portal] #2".`;

export function register({ call, need, CliError }) {
  const fail = (msg, code = 1) => {
    // Formato do Maestri nativo para erros de automação
    console.error(`maestri: error: ${msg}`);
    process.exitCode = code;
  };

  async function portal({ pos, flags }) {
    const [verb, ...rest] = pos;
    try {
      if (verb === "create") {
        need(pos, 2, 'portal create URL ["Nome"] [--size WxH]');
        const r = await call("POST", "/portal/create", { url: rest[0], name: rest[1], size: flags.size });
        return console.log(`Portal "${r.title}" criado em ${r.url} (viewport ${r.viewport.w}x${r.viewport.h}) e conectado a você.`);
      }
      if (verb === "edit") {
        need(pos, 2, 'portal edit "Portal" --url URL');
        if (!flags.url) throw new CliError('Uso: maestri portal edit "Portal" --url URL');
        const r = await call("POST", "/portal/edit", { target: rest[0], url: flags.url });
        return console.log(`Portal "${rest[0]}" agora em ${r.url}`);
      }
      if (verb === "close") {
        need(pos, 2, 'portal close "Portal"');
        await call("POST", "/portal/close", { target: rest[0] });
        return console.log(`Portal "${rest[0]}" fechado.`);
      }
      if (verb === "navigate") {
        need(pos, 3, 'portal navigate "Portal" "url"');
        const r = await call("POST", "/portal-navigate", { target: rest[0], url: rest[1] });
        return console.log(`Portal "${rest[0]}" agora em ${r.url}${r.title ? ` — ${r.title}` : ""}`);
      }
      if (!VERBS.includes(verb)) {
        throw new CliError(verb ? `verbo de portal desconhecido: ${verb} (veja "maestri portal --help")` : 'Uso: maestri portal <verbo> "Portal" ... (veja "maestri portal --help")');
      }
      need(pos, 2, `portal ${verb} "Portal" ...`);
      let args = rest.slice(1);
      if (verb === "wait") {
        // modo: --text, --url, número puro (ms) ou seletor/@ref
        const timeoutMs = Math.round((Number(flags.timeout) || 30) * 1000);
        if (flags.text !== undefined) args = ["text", flags.text, String(timeoutMs)];
        else if (flags.url !== undefined) args = ["url", flags.url, String(timeoutMs)];
        else if (/^\d+$/.test(args[0] ?? "")) args = ["ms", args[0], String(timeoutMs)];
        else if (args[0]) args = ["selector", args[0], String(timeoutMs)];
        else throw new CliError('Uso: maestri portal wait "Portal" (@ref|seletor | --text "t" | --url "padrão" | MS) [--timeout S]');
      }
      if ((MIN_ARGS[verb] ?? 0) > args.length) throw new CliError(`Uso: maestri portal ${verb} "Portal" ... (veja "maestri portal --help")`);
      // O servidor roda em outro processo: caminhos de upload vão absolutos, a partir do cwd de quem chamou
      if (verb === "upload") args = [args[0], ...args.slice(1).map((f) => path.resolve(f))];
      const r = await call("POST", `/portal/${verb}`, { target: rest[0], args });
      if (r.output) console.log(r.output);
    } catch (e) {
      if (e instanceof CliError) return fail(e.message, e.code);
      throw e;
    }
  }

  return {
    commands: { portal },
    help: { portal: HELP },
    flags: ["--size", "--url", "--text"],
    summary: [
      'portal create|edit|close ...      Cria/edita/fecha portais (navegador automatizável)',
      'portal navigate "Portal" "url"    Muda a URL de um portal conectado (e da sessão aberta)',
      'portal snapshot|click|fill|... "Portal"   Automação de portais conectados (veja "maestri portal --help")',
    ],
  };
}
