// Subcomando `maestri routine` (carregado por bin/maestri via register): rotinas agendadas do PROJETO.
// Só o Maestro usa; o servidor valida (agendamento, alvo, nomes duplicados) e devolve mensagens prontas.

const HELP = `maestri routine list
maestri routine show "Nome"
maestri routine create "Nome" --command "..." <agendamento> [alvo] [opções]
maestri routine edit "Nome" [--name Novo] [--command ...] [agendamento] [alvo] [opções]
maestri routine enable|disable|run|delete "Nome"

Rotinas do projeto (workspace); exige o modo Maestro neste terminal.
Agendamento (exatamente um): --every 30m (45s, 30m, 2h, 1h30m; número puro = minutos) | --daily 09:00 |
  --weekly mon,wed,fri@09:00 | --once "2026-06-20 15:00" (hora local do servidor).
Alvo: (padrão) o seu terminal | --terminal "Nome" [--floor "Andar" se houver terminais de mesmo nome em andares diferentes] | --reminder (sem terminal; dispara um aviso com o texto).
Opções: --count N (para após N disparos) | --until "2026-07-01" (último dia) |
  --pre-run "script" (roda no cwd do alvo; precisa sair com 0 ou o disparo é pulado; {{output}} no comando vira o stdout;
  variáveis MAESTRI_WORKSPACE_NAME, MAESTRI_WORKSPACE_DIR, MAESTRI_ROUTINE_NAME, MAESTRI_TERMINAL_NAME) |
  --no-skip-if-busy (dispara mesmo ocupado; ocupado = chat em andamento ou saída do terminal nos últimos 5s) |
  --no-notify (sem aviso a cada disparo) | --disabled (cria pausada).
No edit: só os campos passados mudam; mudar o agendamento zera os contadores; --count 0, --until none e --pre-run ""
  limpam; --skip-if-busy e --notify religam as opções.
Nomes iguais: o comando lista as correspondências com id curto; repita com --id <prefixo>.
Escapes \\n no --command viram quebra de linha. "run" dispara agora (pulado se o terminal-alvo não estiver rodando).
Legado: add "nome" (--every N | --at HH:MM) [--prompt] "texto" e rm "nome".`;

const VALUE_FLAGS = ["--command", "--every", "--daily", "--weekly", "--once", "--at", "--terminal", "--pre-run", "--count", "--until", "--name", "--id"];
const BOOL_FLAGS = ["--reminder", "--no-skip-if-busy", "--skip-if-busy", "--no-notify", "--notify", "--disabled", "--prompt"];

const SUMMARY = [
  "Rotinas (Maestro):",
  '  routine list|show|create|edit|enable|disable|run|delete   Rotinas agendadas do projeto (veja "maestri routine --help")',
];

// \n vira quebra de linha; \\n fica como o texto literal \n
const unescape = (s) => s.replace(/\\\\n|\\n/g, (m) => (m === "\\n" ? "\n" : "\\n"));

const when = (ms) => (ms ? new Date(ms).toLocaleString() : "—");
const STATUS = { active: "ativa", completed: "concluída", disabled: "desligada" };

export function register({ call, need, CliError }) {
  const numeric = (v, what) => {
    const n = Number(v);
    if (v === "" || !Number.isFinite(n)) throw new CliError(`${what} deve ser um número.`);
    return n;
  };

  // flags -> corpo da API (create envia tudo que veio; edit só o que veio)
  function bodyFrom(flags, { edit = false } = {}) {
    const body = {};
    const sched = ["every", "daily", "weekly", "once", "at"].filter((k) => flags[k] !== undefined);
    if (sched.length > 1) throw new CliError("Informe só um agendamento: --every, --daily, --weekly ou --once.");
    const [k] = sched;
    if (k === "every") body.schedule = { type: "interval", every: flags.every };
    else if (k === "daily" || k === "at") body.schedule = { type: "daily", time: flags[k] };
    else if (k === "weekly") body.schedule = { type: "weekly", spec: flags.weekly };
    else if (k === "once") body.schedule = { type: "once", at: flags.once };

    if (flags.reminder && flags.terminal !== undefined) throw new CliError("Use --reminder OU --terminal, não os dois.");
    if (flags.reminder) body.reminder = true;
    else if (flags.terminal !== undefined) body.terminal = flags.terminal;
    if (flags.floor !== undefined && flags.terminal !== undefined) body.floor = flags.floor; // desambigua --terminal de mesmo nome

    if (flags.command !== undefined) body.text = unescape(flags.command);
    if (flags["pre-run"] !== undefined) body.preRun = flags["pre-run"];
    if (flags.count !== undefined) {
      const n = numeric(flags.count, "--count");
      body.count = edit && n === 0 ? null : n;
    }
    if (flags.until !== undefined) body.until = flags.until === "none" ? null : flags.until;
    if (flags["no-skip-if-busy"]) body.skipIfBusy = false;
    else if (flags["skip-if-busy"]) body.skipIfBusy = true;
    if (flags["no-notify"]) body.notify = false;
    else if (flags.notify) body.notify = true;
    if (flags.disabled) body.enabled = false;
    if (flags.prompt) body.kind = "prompt";
    return body;
  }

  // Referência a uma rotina: nome e/ou --id
  const ref = (name, flags) => ({ ...(name !== undefined && { name }), ...(flags.id !== undefined && { id: flags.id }) });

  async function routine({ pos, flags }) {
    const [sub, name] = pos;
    if (sub === "list") {
      const { routines } = await call("GET", "/routines");
      if (!routines.length) return console.log("Nenhuma rotina.");
      for (const r of routines) {
        const last = r.history.at(-1);
        const lastText = last ? `${last.status}${last.reason ? ` (${last.reason})` : ""}` : "nunca rodou";
        const to = r.reminder ? "lembrete" : r.nodeFloor && r.nodeFloor !== "Ground" ? `${r.nodeTitle} (andar ${r.nodeFloor})` : r.nodeTitle;
        console.log(`${r.shortId}  ${r.name}  [${r.label}]  → ${to}  ${STATUS[r.status]}  próxima: ${r.status === "active" ? when(r.nextRunAt) : "—"}  última: ${lastText}`);
      }
    } else if (sub === "show") {
      need(pos, 2, 'routine show "Nome"');
      const { routine: r } = await call("POST", "/routines/show", ref(name, flags));
      const last = r.history.at(-1);
      const out = [
        `${r.name}  (id ${r.shortId})`,
        `  agendamento: ${r.label}`,
        `  alvo: ${r.reminder ? "lembrete (aviso aos navegadores)" : r.nodeTitle}${r.nodeFloor && r.nodeFloor !== "Ground" ? ` (andar ${r.nodeFloor})` : ""}`,
        `  status: ${STATUS[r.status]} · disparos: ${r.fired}${r.count ? `/${r.count}` : ""}${r.until ? ` · até ${r.until}` : ""}`,
        `  próxima: ${r.status === "active" ? when(r.nextRunAt) : "—"}`,
        `  pular se ocupado: ${r.skipIfBusy ? "sim" : "não"} · notificar: ${r.notify ? "sim" : "não"}`,
        `  comando: ${r.text}`,
      ];
      if (r.preRun) out.push(`  pre-run: ${r.preRun}`);
      if (last) out.push(`  última: ${last.at} ${last.status}${last.reason ? ` — ${last.reason}` : ""}`);
      console.log(out.join("\n"));
    } else if (sub === "create") {
      need(pos, 2, 'routine create "Nome" --command "..." (--every 30m | --daily HH:MM | --weekly dias@HH:MM | --once "yyyy-MM-dd HH:mm") [opções]');
      const body = bodyFrom(flags);
      if (body.text === undefined) throw new CliError('Falta --command "texto".');
      if (!body.schedule) throw new CliError("Falta o agendamento: --every, --daily, --weekly ou --once.");
      const { routine: r } = await call("POST", "/routines", { ...body, name });
      console.log(`Rotina "${r.name}" criada (id ${r.shortId}, ${r.label}); próxima: ${when(r.nextRunAt)}.`);
    } else if (sub === "edit") {
      need(pos, 2, 'routine edit "Nome" [--name Novo] [--command ...] [agendamento] [opções]');
      const patch = bodyFrom(flags, { edit: true });
      if (flags.name !== undefined) patch.name = flags.name;
      if (!Object.keys(patch).length) throw new CliError("Nada para mudar: passe ao menos um campo (--name, --command, --every, ...).");
      const { routine: r } = await call("POST", "/routines/edit", { ...ref(name, flags), patch });
      console.log(`Rotina "${r.name}" atualizada (${r.label}); próxima: ${when(r.nextRunAt)}.`);
    } else if (sub === "enable" || sub === "disable") {
      need(pos, 2, `routine ${sub} "Nome"`);
      const { routine: r } = await call("POST", `/routines/${sub}`, ref(name, flags));
      console.log(sub === "enable" ? `Rotina "${r.name}" ligada; próxima: ${when(r.nextRunAt)}.` : `Rotina "${r.name}" desligada.`);
    } else if (sub === "run") {
      need(pos, 2, 'routine run "Nome"');
      const r = await call("POST", "/routines/run", ref(name, flags));
      console.log(r.status === "skipped" ? `Rotina "${name}" pulada: ${r.reason}.` : `Rotina "${name}" iniciada.`);
    } else if (sub === "delete" || sub === "rm" || sub === "remove") {
      need(pos, 2, 'routine delete "Nome"');
      await call("POST", "/routines/delete", ref(name, flags));
      console.log(`Rotina "${name}" removida.`);
    } else if (sub === "add") {
      // Legado: add "nome" (--every N | --at HH:MM) [--prompt] "texto"
      need(pos, 3, 'routine add "nome" (--every N | --at HH:MM) [--prompt] "texto"');
      if ((flags.every === undefined) === (flags.at === undefined)) throw new CliError("Informe exatamente um: --every N ou --at HH:MM.");
      const { routine: r } = await call("POST", "/routines", { ...bodyFrom(flags), name, text: pos.slice(2).join(" ") });
      console.log(`Rotina "${r.name}" criada (${r.label}); próxima: ${when(r.nextRunAt)}.`);
    } else throw new CliError('Uso: maestri routine list|show|create|edit|enable|disable|run|delete (veja "maestri routine --help")');
  }

  return { commands: { routine }, help: { routine: HELP }, flags: VALUE_FLAGS, boolFlags: BOOL_FLAGS, summary: SUMMARY };
}
