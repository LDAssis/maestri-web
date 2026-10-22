// Equipe (F15): connect, recruit avançado, preset, role, band e o `list` com bandas e conexões dos colegas.
// Carregado por bin/maestri; sobrescreve `recruit` e `list`/`context`.

const HELP = {
  recruit: `maestri recruit "Nome" [--preset "Nome do preset"] [--role "Nome do role"] [--floor "Andar"] [--band "Banda"]
                      [--command "claude --resume"] [--dir "/caminho/no/projeto"] [--icon I] [--color C]
maestri recruit ["Novo nome"] --replace "Antigo" (--preset P | --command C) [--role R] [--dir D] [--icon I] [--color C]
Apenas o Maestro. Cria um agente conectado a você e inicia o terminal dele.
--preset: veja "maestri preset list"; sem --preset (nem --command) o recruta é uma cópia sua (mesmo comando).
--role: nome de um role existente ("maestri role list"); --role-id usa o UUID; um texto que não é nome de role segue
  valendo como papel livre (formato antigo). --cmd é o apelido antigo de --command.
--account: roda o recruta numa conta do CLI (claude/codex; veja "maestri account list" e "maestri preset list"); vence a
  conta fixada no preset; sem ele, a do preset ou, numa cópia sua, a sua. "Default" = o login existente do CLI.
--dir: diretório de partida; precisa estar dentro do projeto (padrão: o seu). --icon/--color: veja "maestri arrange --help".
--band: coloca o recruta numa banda sua; sem ele, estando numa banda, o recruta entra nela em vez de ganhar uma corda.
--floor: cria o recruta num andar existente (e o terminal abre no checkout dele). Nomes repetidos viram "Nome (2)".
--replace "X" --account "Work" (sozinho) troca só a conta e reinicia o processo.
--replace troca o processo do agente existente NO MESMO LUGAR (nó, cordas, posição e rotinas ficam; a sessão reinicia e o chat
  é descartado). O nome posicional renomeia. Exige --preset ou --command para trocar de agente; poderes de Maestro só mudam
  com --preset explícito. --floor não vale com --replace.`,
  connect: `maestri connect "De" "Para"
Apenas o Maestro. Liga dois nós da sua árvore de equipe (você, recrutas diretos, e as notas/fichários/portais/bandas ligados
a você ou a eles). Agente↔agente pode cruzar andares; notas, fichários e portais só ligam no mesmo andar; um portal só se
liga a agente; nota não liga a portal. Uma corda para uma banda alcança todos os membros.`,
  preset: `maestri preset list
maestri preset show "Nome"
maestri preset create "Nome" [--command "claude --model opus"] [--account "Work"] [--maestro on|off] [--chat on|off] [--quick-start on|off]
maestri preset set "Nome" [--name Novo] [--command C] [--account "Work"|""] [--maestro on|off] [--chat on|off] [--quick-start on|off]
maestri preset delete "Nome"
Presets = embutidos (claude, codex, opencode, agy, shell) + cliPresets das configurações. Novos presets e overrides de
embutidos são gravados nas configurações GLOBAIS; um preset que já vive nas configurações do projeto é alterado lá.
create/set respondem com o preset atualizado. Apagar um preset não muda terminais já criados. Só o Maestro altera.
Sem --command o preset é um shell puro. --account fixa uma conta do CLI do comando (claude/codex); "" desafixa. O list mostra
accounts: "Default", "Work" nos presets com mais de uma conta e "; starts on Work" nos fixados.`,
  role: `maestri role list
maestri role show "Nome"
maestri role create "Nome" "Prompt" [--scope current|global]
maestri role edit "Nome" "texto antigo" "texto novo" [--scope current|global]
maestri role edit "Nome" --scope global
maestri role write "Nome" "novo prompt completo"
maestri role assign "Recruta" "Role"   |   maestri role assign "Recruta" --none
current = .maestri/roles do projeto (padrão); global = diretório de dados do servidor, visível em todos os projetos.
edit/write reescrevem o prompt de quem usa o role e reiniciam esses processos; assign reinicia o recruta preservando a
topologia. O chat se perde no reinício. Só o Maestro altera.`,
  band: `maestri band create "Nome" ["Agente" ...] [--without-me] [--floor F] [--icon I] [--color C]
maestri band add "Banda" "Agente"
maestri band remove "Banda" "Agente"
maestri band dissolve "Banda"
Apenas o Maestro. Sem nomes, a banda reúne você e todos os conectados a você no seu andar que não estão em outra banda
(mínimo 2 agentes). Todo membro alcança os outros e o que está ligado à banda; quem entra depois herda isso. Um terminal fica
em uma banda por vez. Uma banda com 1 membro se dissolve sozinha. --without-me deixa você de fora (fica ligado à banda).
"maestri list" mostra as bandas, os membros e marca a sua.`,
};

const SUMMARY = [
  "Equipe:",
  '  recruit "Nome" [--preset P] [--role R] [--band B] [--dir D] | recruit --replace "Antigo" ...   (Maestro)',
  '  connect "De" "Para"                Liga dois nós da sua equipe (Maestro)',
  "  preset list|show|create|set|delete Presets de agente",
  "  role list|show|create|edit|write|assign   Roles do projeto e globais",
  "  band create|add|remove|dissolve    Bandas de agentes (Maestro)",
];

const TYPE_LABEL = { agentTerminal: "agente", stickyNote: "nota", noteStack: "fichário", portal: "portal", band: "banda" };
const onOff = (v) => (v ? "on" : "off");

export function register({ call, need, CliError }) {
  const clip = (s, n = 80) => (s.length > n ? `${s.slice(0, n - 1).replace(/\s+$/, "")}…` : s).replace(/\s*\n\s*/g, " ");

  // ----- list / context -----
  async function list() {
    const c = await call("GET", "/context");
    const out = [`Você: ${c.self.title}${c.self.isMaestro ? " (Maestro)" : ""}`];
    const group = (name, items) => {
      if (!items.length) return;
      out.push("", `${name}:`, ...items);
    };
    group("Agentes", c.agents.flatMap((n) => [
      `  - ${n.title}${n.isMaestro ? " (Maestro)" : ""}${n.account ? ` [conta: ${n.account}]` : ""}`,
      // Maestro: as conexões de cada colega, aninhadas
      ...((c.links?.[n.nodeId] ?? []).map((l) => `      ↳ ${l.title} (${TYPE_LABEL[l.type] ?? l.type}${l.members ? `, ${l.members} membros` : ""})`)),
    ]));
    group("Bandas", (c.bands ?? []).flatMap((b) => [
      `  - ${b.title}${b.mine ? " (você está nela)" : ""}`,
      ...b.members.map((m) => `      · ${m}`),
    ]));
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
    // notas de recrutas (alcance do Maestro) cujo pai é um agente: aparecem como raiz
    for (const n of c.notes.filter((x) => x.parent && !x.stack && !c.notes.some((y) => y.title === x.parent) && !c.stacks.some((s) => s.title === x.parent))) {
      if (!notes.some((l) => l.trim() === `- ${n.title}${lock(n)}`)) notes.push(`  - ${n.title}${lock(n)}`);
    }
    group("Notas", notes);
    group("Fichários", c.stacks.flatMap((s) => {
      const pages = c.notes.filter((n) => n.stack === s.title);
      return [`  - ${s.title} (${pages.length} página${pages.length === 1 ? "" : "s"})`, ...pages.map((n) => `      · ${n.title}${lock(n)}`)];
    }));
    group("Portais", c.portals.map((n) => `  - ${n.title}${n.url ? ` — ${n.url}` : ""}`));
    if (c.agents.length + c.notes.length + c.stacks.length + c.portals.length + (c.bands ?? []).length === 0) out.push("", "Nenhum nó conectado.");
    console.log(out.join("\n"));
  }

  // ----- recruit -----
  async function recruit({ pos, flags }) {
    if (flags.workspace !== undefined) throw new CliError("--workspace não existe no Maestri Web (cada projeto é um workspace isolado).");
    const replacing = flags.replace !== undefined;
    if (!replacing) need(pos, 1, 'recruit "Nome" [--preset P] [--role R] [--band B] [--command C] [--dir D]');
    const r = await call("POST", "/recruit", {
      name: pos[0], replace: flags.replace, preset: flags.preset, role: flags.role, roleId: flags["role-id"],
      command: flags.command ?? flags.cmd, dir: flags.dir, floor: flags.floor, band: flags.band, icon: flags.icon, color: flags.color, account: flags.account,
    });
    if (r.note) console.error(`[maestri] ${r.note}`);
    console.log(replacing ? `Agente "${r.name}" trocado no mesmo lugar (sessão reiniciada).` : `Agente "${r.name}" recrutado e iniciado${r.band ? ` na banda "${r.band}"` : ""}.`);
  }

  async function connect({ pos }) {
    need(pos, 2, 'connect "De" "Para"');
    const r = await call("POST", "/connect", { from: pos[0], to: pos[1] });
    console.log(r.already ? `"${pos[0]}" e "${pos[1]}" já estão conectados.` : `"${pos[0]}" ↔ "${pos[1]}" conectados.`);
  }

  // ----- preset -----
  const showPreset = (p) =>
    console.log([
      `${p.label}  (id ${p.id}${p.builtin ? ", embutido" : ""}; ${p.source})`,
      `  comando: ${p.cmd || "(shell puro)"}`,
      `  maestro: ${onOff(p.maestro)} · chat: ${onOff(p.chat)} · quick-start: ${onOff(p.quickStart)}`,
      ...(p.account ? [`  conta: ${p.account}${p.accounts ? ` (disponíveis: ${p.accounts.map((a) => `"${a}"`).join(", ")})` : ""}`] : []),
    ].join("\n"));
  const presetBody = (flags) => ({
    command: flags.command, maestro: flags.maestro, chat: flags.chat, quickStart: flags["quick-start"], account: flags.account,
  });

  async function preset({ pos, flags }) {
    const [sub, name] = pos;
    if (sub === "list") {
      const { presets } = await call("GET", "/presets");
      for (const p of presets) console.log(`${p.label}  [${p.id}]  ${p.cmd || "(shell)"}${[p.maestro && "maestro", p.chat && "chat", p.quickStart && "quick-start"].filter(Boolean).map((x) => ` +${x}`).join("")}${p.accounts ? `  accounts: ${p.accounts.map((a) => `"${a}"`).join(", ")}` : ""}${p.account ? `; starts on "${p.account}"` : ""}`);
    } else if (sub === "show") {
      need(pos, 2, 'preset show "Nome"');
      showPreset((await call("POST", "/presets/show", { name })).preset);
    } else if (sub === "create") {
      need(pos, 2, 'preset create "Nome" [--command C] [--maestro on|off] [--chat on|off] [--quick-start on|off]');
      showPreset((await call("POST", "/presets/create", { name, ...presetBody(flags) })).preset);
    } else if (sub === "set") {
      need(pos, 2, 'preset set "Nome" [--name Novo] [--command C] [--maestro on|off] ...');
      showPreset((await call("POST", "/presets/set", { name, newName: flags.name, ...presetBody(flags) })).preset);
    } else if (sub === "delete" || sub === "rm") {
      need(pos, 2, 'preset delete "Nome"');
      const r = await call("POST", "/presets/delete", { name });
      console.log(r.builtinRestored ? `Override de "${name}" removido; o preset embutido voltou ao padrão.` : `Preset "${name}" apagado.`);
    } else throw new CliError('Uso: maestri preset list|show|create|set|delete (veja "maestri preset --help")');
  }

  // ----- role -----
  async function role({ pos, flags }) {
    const [sub, name] = pos;
    if (sub === "list") {
      const { roles } = await call("GET", "/roles");
      if (!roles.length) return console.log("Nenhum role.");
      const section = (title, items) => {
        if (!items.length) return;
        console.log(`${title}:`);
        for (const r of items) console.log(`  - ${r.name}: ${clip(r.prompt)}`);
      };
      section("Current workspace", roles.filter((r) => r.scope === "current"));
      section("Global", roles.filter((r) => r.scope === "global"));
    } else if (sub === "show") {
      need(pos, 2, 'role show "Nome"');
      const { role: r } = await call("POST", "/roles/show", { name });
      console.log(`${r.name} (${r.scope})\n\n${r.prompt}`);
    } else if (sub === "create") {
      need(pos, 3, 'role create "Nome" "Prompt" [--scope current|global]');
      const { role: r } = await call("POST", "/roles/create", { name, prompt: pos.slice(2).join(" "), scope: flags.scope });
      console.log(`Role "${r.name}" criado (${r.scope}).`);
    } else if (sub === "edit") {
      need(pos, 2, 'role edit "Nome" "texto antigo" "texto novo" [--scope current|global]');
      if (pos.length !== 2 && pos.length !== 4) throw new CliError('Uso: maestri role edit "Nome" "texto antigo" "texto novo" [--scope S] | role edit "Nome" --scope S');
      const { role: r } = await call("POST", "/roles/edit", { name, old: pos[2], new: pos[3], scope: flags.scope });
      console.log(`Role "${r.name}" atualizado (${r.scope}); agentes que o usam foram reiniciados.`);
    } else if (sub === "write") {
      need(pos, 3, 'role write "Nome" "novo prompt"');
      const { role: r } = await call("POST", "/roles/write", { name, prompt: pos.slice(2).join(" ") });
      console.log(`Prompt do role "${r.name}" substituído; agentes que o usam foram reiniciados.`);
    } else if (sub === "assign") {
      if (flags.none) need(pos, 2, 'role assign "Recruta" --none');
      else need(pos, 3, 'role assign "Recruta" "Role"');
      const r = await call("POST", "/roles/assign", { target: name, role: pos[2], none: flags.none === true });
      console.log(r.role ? `"${name}" agora usa o role "${r.role}" (processo reiniciado).` : `Role de "${name}" removido (processo reiniciado).`);
    } else throw new CliError('Uso: maestri role list|show|create|edit|write|assign (veja "maestri role --help")');
  }

  // ----- band -----
  async function band({ pos, flags }) {
    const [sub, name] = pos;
    if (sub === "create") {
      need(pos, 2, 'band create "Nome" ["Agente" ...] [--without-me] [--icon I] [--color C]');
      if (flags.workspace !== undefined) throw new CliError("--workspace não existe no Maestri Web.");
      const r = await call("POST", "/band/create", { name, agents: pos.slice(2), withoutMe: flags["without-me"] === true, floor: flags.floor, icon: flags.icon, color: flags.color });
      console.log(`Banda "${r.name}" criada com ${r.members.join(", ")}.`);
    } else if (sub === "add" || sub === "remove") {
      need(pos, 3, `band ${sub} "Banda" "Agente"`);
      const r = await call("POST", `/band/${sub}`, { band: name, agent: pos[2] });
      console.log(sub === "add" ? `"${pos[2]}" entrou na banda "${name}".` : r.dissolved ? `"${pos[2]}" saiu; a banda "${name}" ficou com 1 membro e foi dissolvida.` : `"${pos[2]}" saiu da banda "${name}".`);
    } else if (sub === "dissolve") {
      need(pos, 2, 'band dissolve "Banda"');
      await call("POST", "/band/dissolve", { band: name });
      console.log(`Banda "${name}" dissolvida (os agentes continuam rodando).`);
    } else throw new CliError('Uso: maestri band create|add|remove|dissolve (veja "maestri band --help")');
  }

  return {
    commands: { list, context: list, recruit, connect, preset, role, band },
    help: HELP,
    flags: ["--floor", "--workspace", "--band", "--command", "--dir", "--account", "--icon", "--color", "--replace", "--scope", "--name", "--maestro", "--chat", "--quick-start"],
    boolFlags: ["--without-me", "--none"],
    summary: SUMMARY,
  };
}
