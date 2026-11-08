// Subcomando `maestri partitura` (só o Maestro): biblioteca de times salvos (agentes com roles/comandos, bandas, notas, portais, cordas).
// O formato é o arquivo da UI (maestri-partitura v1) com campos extras; o servidor guarda em .maestri/partituras/ (current) ou no diretório de dados (global).

const HELP = `maestri partitura list
maestri partitura insert "Nome" [--floor F] [--workspace W]
maestri partitura create "Nome" ["Agente" ...] [--without-me] [--commands on|off] [--note-text on|off] [--chat-history on|off] [--description D] [--icon I] [--color C] [--scope current|global]
maestri partitura update "Nome" ["Agente" ...] [--without-me] [--commands on|off] [--note-text on|off] [--chat-history on|off] [--name N] [--description D] [--icon I] [--color C] [--scope current|global]
maestri partitura delete "Nome"
Apenas o Maestro. Uma partitura é um time salvo: agentes com roles e comandos, bandas, notas, fichários, portais e as cordas entre eles.
Prefira colocar uma partitura salva a recrutar o mesmo time à mão. O arquivo é o da UI (Exportar/Importar partitura) com campos extras,
em .maestri/partituras/ do projeto (--scope current, padrão) ou no diretório de dados do servidor (--scope global, vale em todos os projetos).
insert coloca a partitura ao lado de você no seu andar (ou abaixo do conteúdo do andar/workspace de --floor/--workspace), com ids novos e
nomes sem conflito ("Nome (2)"), liga você aos Maestros dela quando houver (senão a todos os agentes e bandas) e inicia os terminais.
A resposta diz o que foi colocado e quais agentes você alcança para dar ask. Agentes em outro workspace: "Nome @ Workspace".
create salva você (salvo --without-me) e todos que você alcança no seu andar, ou só os agentes e bandas nomeados; uma banda entra inteira,
com as notas, fichários e portais ligados a eles. Nunca sobrescreve uma partitura existente (use update).
--commands/--note-text/--chat-history ligam ou desligam essas partes (padrão: comandos e texto das notas ligados, histórico de chat desligado).
update salva o time de novo (quando há agentes, --without-me ou uma chave on: só o time vivo tem comandos, texto das notas e chat) ou só troca
os detalhes (--name, --description, --icon, --color, --scope); chave off apaga essa parte do que já foi salvo. "default" tira ícone/cor.
update e delete só a pedido do usuário; apagar não desfaz o que a partitura já colocou. Partituras são por andar: tudo precisa estar no seu andar.`;

const SUMMARY = ["Partituras (Maestro):", "  partitura list|insert|create|update|delete   Times salvos (veja \"maestri partitura --help\"); floor create --partitura P põe um time no novo andar"];

export function register({ call, need, CliError }) {
  const counts = (r) =>
    [`${r.agents} agente(s)`, r.bands ? `${r.bands} banda(s)` : "", r.notes ? `${r.notes} nota(s)` : "", r.stacks ? `${r.stacks} fichário(s)` : "", r.portals ? `${r.portals} portal(is)` : ""].filter(Boolean).join(", ");
  const quoted = (list) => list.map((n) => `"${n}"`).join(", ");

  // Resposta do insert (também usada por floor create --partitura)
  const report = (r) => {
    console.log(`Partitura "${r.name}" colocada ${r.workspace ? `no workspace "${r.workspace}", ` : ""}no andar "${r.floor}": ${counts(r)}.`);
    if (r.maestros.length) console.log(`Maestros dela (ligados a você): ${quoted(r.maestros)}.`);
    if (r.reachable.length) console.log(`Para dar ask: ${quoted(r.reachable)}.`);
    if (r.others > 0) console.log(`Mais ${r.others} agente(s) rodam sob os Maestros dela.`);
    for (const n of r.warnings ?? []) console.log(`Aviso: ${n}.`);
  };

  async function partitura({ pos, flags }) {
    const [sub, name, ...rest] = pos;
    if (sub === "list") {
      const { partituras } = await call("GET", "/partituras");
      if (!partituras.length) return console.log("Nenhuma partitura salva.");
      for (const p of partituras) console.log(`- ${p.name} (${p.scope}) — ${counts(p)}${p.description ? ` — ${p.description}` : ""}`);
    } else if (sub === "insert") {
      need(pos, 2, 'partitura insert "Nome" [--floor F] [--workspace W]');
      report(await call("POST", "/partituras/insert", { name, floor: flags.floor, workspace: flags.workspace }));
    } else if (sub === "create" || sub === "update") {
      need(pos, 2, `partitura ${sub} "Nome" ["Agente" ...]`);
      const body = {
        name, agents: rest.length ? rest : undefined, withoutMe: flags["without-me"] === true ? true : undefined,
        commands: flags.commands, noteText: flags["note-text"], chatHistory: flags["chat-history"],
        description: flags.description, icon: flags.icon, color: flags.color, scope: flags.scope,
        ...(sub === "update" && { newName: flags.name }),
      };
      const r = await call("POST", `/partituras/${sub}`, body);
      console.log(`Partitura "${r.name}" ${sub === "create" ? "salva" : "atualizada"} (${r.scope}): ${counts(r)}.`);
    } else if (sub === "delete") {
      need(pos, 2, 'partitura delete "Nome"');
      const r = await call("POST", "/partituras/delete", { name });
      console.log(`Partitura "${r.name}" apagada.`);
    } else throw new CliError('Uso: maestri partitura list|insert|create|update|delete ... (veja "maestri partitura --help")');
  }

  return {
    commands: { partitura },
    help: { partitura: HELP },
    flags: ["--floor", "--workspace", "--commands", "--note-text", "--chat-history", "--description", "--icon", "--color", "--scope", "--name"],
    boolFlags: ["--without-me"],
    summary: SUMMARY,
  };
}
