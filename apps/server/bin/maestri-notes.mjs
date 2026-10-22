// Comandos `note` (avançado), `arrange` e `list`/`context` (com notas encadeadas, travadas e fichários).
// Carregado automaticamente por bin/maestri; sobrescreve o `note` e o `list` built-in.

const NOTE_HELP = `maestri note read "Nome" [início] [quantidade]   Lê a nota com números de linha (intervalo opcional)
maestri note write "Nome" "texto"               Substitui o conteúdo
maestri note append "Nome" "texto"              Acrescenta ao fim
maestri note edit "Nome" "antigo" "novo"        Troca um trecho (precisa aparecer exatamente uma vez)
maestri note delete "Nome"                      Remove a nota (destrutivo; só quando o usuário pedir)
maestri note create ["conteúdo"] [--name "Nome"] [--stack ["Fichário"]] [--color C]
maestri note stack "Nome" ["Fichário"]          Guarda a nota num fichário (cria se não existir; padrão "Fichário")
maestri note unstack "Nome"                     Tira a nota do fichário
O nome de uma nota sem --name acompanha a primeira linha do conteúdo; --name fixa o nome. A resposta de create
imprime o nome exato atribuído (duplicados ganham " (2)"). Forma antiga: note create "Título" "texto" (título fixo).
Notas ligadas a uma nota conectada a você, e as de fichários conectados a você, também são acessíveis.
Notas com "locked: true" no list são somente leitura (write/edit/append/delete falham). Cores: amber, indigo,
emerald, rose, sky, violet, orange, slate.`;

const ARRANGE_HELP = (icons, colors) => `maestri arrange                              Mostra nome, ícone e cor atuais
maestri arrange "Nome" [--name N] [--icon I] [--color C]   Renomeia/estiliza você, uma nota conectada ou (Maestro) um agente conectado
Ícones: ${icons.join(", ")}
Cores: ${colors.join(", ")}`;

const ICONS = [
  "terminal", "bot", "code", "cpu", "brain", "rocket", "shield", "bug", "flask", "palette", "database", "globe",
  "search", "wrench", "book", "pen", "star", "heart", "zap", "flag", "crown", "sparkles", "lightbulb",
];
const COLORS = ["amber", "indigo", "emerald", "rose", "sky", "violet", "orange", "slate"];

const numbered = (lines, from) => lines.map((l, i) => `${String(from + i).padStart(4)}| ${l}`).join("\n");

// --stack aceita valor opcional: o nome (se houver) vem logo depois da flag em argv
function stackArg() {
  const i = process.argv.indexOf("--stack");
  const v = i === -1 ? undefined : process.argv[i + 1];
  return v !== undefined && !v.startsWith("--") ? v : undefined;
}

export function register({ call, need, CliError }) {
  const enc = (s) => encodeURIComponent(s ?? "");
  const renamedMsg = (r) => (r.renamed ? ` Nota renomeada para "${r.renamed}".` : "");

  async function note({ pos, flags }) {
    const [sub, name, ...rest] = pos;
    const route = `/notes/${enc(name)}`;
    if (sub === "read") {
      need([name], 1, 'note read "Nome" [início] [quantidade]');
      const { content } = await call("GET", route);
      const lines = content.split("\n");
      const start = rest[0] === undefined ? 1 : Number(rest[0]);
      const count = rest[1] === undefined ? lines.length : Number(rest[1]);
      if (!Number.isInteger(start) || start < 1 || !Number.isInteger(count) || count < 1) throw new CliError("início e quantidade devem ser inteiros positivos.");
      if (start > lines.length) throw new CliError(`A nota tem só ${lines.length} linha(s); início ${start} está fora.`);
      console.log(numbered(lines.slice(start - 1, start - 1 + count), start));
    } else if (sub === "write" || sub === "append") {
      need([name, ...rest], 2, `note ${sub} "Nome" "texto"`);
      const r = await call(sub === "write" ? "PUT" : "POST", route, { text: rest.join(" ") });
      console.log((sub === "write" ? "Nota atualizada." : "Texto acrescentado à nota.") + renamedMsg(r));
    } else if (sub === "edit") {
      need(pos, 4, 'note edit "Nome" "antigo" "novo"');
      const r = await call("POST", `${route}/edit`, { old: rest[0], text: rest[1] });
      console.log("Nota editada." + renamedMsg(r));
    } else if (sub === "delete") {
      need([name], 1, 'note delete "Nome"');
      await call("DELETE", route);
      console.log(`Nota "${name}" removida.`);
    } else if (sub === "create") {
      const stackName = stackArg();
      let args = pos.slice(1);
      if (stackName !== undefined) {
        const i = args.lastIndexOf(stackName);
        if (i !== -1) args.splice(i, 1);
      }
      // Forma antiga: note create "Título" "texto" (título fixo); com --stack/--name vale a nova forma
      const legacy = args.length >= 2 && flags.name === undefined && flags.stack === undefined;
      const body = legacy ? { title: args[0], text: args.slice(1).join(" ") } : { text: args.join(" "), name: flags.name, color: flags.color };
      if (!legacy && flags.stack) body.stack = stackName ?? true;
      if (legacy && flags.color) body.color = flags.color;
      const r = await call("POST", "/notes", body);
      console.log(`Nota "${r.title}" criada e conectada${r.stack ? `, no fichário "${r.stack}"` : ""}.`);
    } else if (sub === "stack") {
      need([name], 1, 'note stack "Nome" ["Fichário"]');
      const r = await call("POST", `${route}/stack`, { stack: rest[0] });
      console.log(`Nota "${name}" guardada no fichário "${r.stack}".`);
    } else if (sub === "unstack") {
      need([name], 1, 'note unstack "Nome"');
      const r = await call("POST", `${route}/unstack`, {});
      console.log(`Nota "${name}" tirada do fichário "${r.stack}".`);
    } else throw new CliError('Uso: maestri note read|write|append|edit|delete|create|stack|unstack ... (veja "maestri note --help")');
  }

  async function arrange({ pos, flags }) {
    if (pos.length === 0 && flags.name === undefined && flags.icon === undefined && flags.color === undefined) {
      const r = await call("GET", "/arrange");
      for (const i of r.items) console.log(`${i.title} [${i.type}] — ícone: ${i.icon ?? "(padrão)"}, cor: ${i.color ?? "(padrão)"}`);
      return;
    }
    // Sem nome de alvo, aplica a você mesmo
    const r = await call("POST", "/arrange", { target: pos[0], name: flags.name, icon: flags.icon, color: flags.color });
    const who = pos[0] ?? "Você";
    console.log(`"${who}" atualizado${r.title !== who ? ` (agora "${r.title}")` : ""}.`);
  }

  async function list() {
    const c = await call("GET", "/context");
    const out = [`Você: ${c.self.title}${c.self.isMaestro ? " (Maestro)" : ""}`];
    const group = (name, items) => {
      if (!items.length) return;
      out.push("", `${name}:`, ...items);
    };
    group("Agentes", c.agents.map((n) => `  - ${n.title}${n.isMaestro ? " (Maestro)" : ""}`));
    // Notas: árvore pelas notas-mãe; páginas de fichário ficam sob o fichário
    const lock = (n) => (n.locked ? " (locked: true)" : "");
    const notes = [];
    const walk = (parent, depth) => {
      for (const n of c.notes.filter((x) => x.parent === parent && !x.stack)) {
        notes.push(`${"  ".repeat(depth + 1)}- ${n.title}${lock(n)}`);
        walk(n.title, depth + 1);
      }
    };
    walk(null, 0);
    group("Notas", notes);
    group("Fichários", c.stacks.flatMap((s) => {
      const pages = c.notes.filter((n) => n.stack === s.title);
      return [`  - ${s.title} (${pages.length} página${pages.length === 1 ? "" : "s"})`, ...pages.map((n) => `      · ${n.title}${lock(n)}`)];
    }));
    group("Portais", c.portals.map((n) => `  - ${n.title}${n.url ? ` — ${n.url}` : ""}`));
    if (c.agents.length + c.notes.length + c.stacks.length + c.portals.length === 0) out.push("", "Nenhum nó conectado.");
    console.log(out.join("\n"));
  }

  return {
    commands: { note, arrange, list, context: list },
    help: { note: NOTE_HELP, arrange: ARRANGE_HELP(ICONS, COLORS) },
    flags: ["--name", "--icon", "--color"],
    boolFlags: ["--stack"],
    summary: [
      'Notas e estilo:',
      '  note read|write|append|edit|delete|create|stack|unstack   Notas, cadeias e fichários (veja "maestri note --help")',
      '  arrange ["Nome"] [--name N] [--icon I] [--color C]       Renomeia/estiliza você, uma nota ou (Maestro) um agente',
    ],
  };
}
