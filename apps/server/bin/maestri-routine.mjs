// Subcomando `maestri routine` (importado por bin/maestri): rotinas agendadas do SEU nó.
// Recebe os helpers do CLI para não duplicar chamada HTTP/erros.

export const ROUTINE_FLAGS = ["--every", "--at"];

export const ROUTINE_HELP = `maestri routine list
maestri routine add "nome" (--every MINUTOS | --at HH:MM) [--prompt] "texto"
maestri routine rm "nome"
maestri routine run "nome"
Rotinas do SEU agente. --every roda a cada N minutos (1..10080); --at roda todo dia na hora local do servidor.
Por padrão o texto é um comando; --prompt marca como prompt para o agente. O texto é digitado no terminal + Enter.`;

const USAGE = 'routine list | add "nome" (--every N | --at HH:MM) [--prompt] "texto" | rm "nome" | run "nome"';

const when = (r) => (r.schedule.type === "interval" ? `a cada ${r.schedule.minutes} min` : `todo dia às ${r.schedule.time}`);

export function makeRoutine({ call, need, CliError }) {
  return async function routine({ pos, flags }) {
    const prompt = pos.includes("--prompt");
    const args = pos.filter((a) => a !== "--prompt");
    const sub = args[0];
    if (sub === "list") {
      const { routines } = await call("GET", "/routines");
      if (!routines.length) return console.log("Nenhuma rotina.");
      for (const r of routines) {
        const last = r.history.at(-1);
        const status = last ? (last.ok ? "ok" : `erro: ${last.error}`) : "nunca rodou";
        console.log(`${r.name} [${r.kind}] ${when(r)} ${r.enabled ? "" : "(desligada) "}— próxima: ${new Date(r.nextRunAt).toLocaleString()} — última: ${status}`);
      }
    } else if (sub === "add") {
      need(args, 3, USAGE);
      if ((flags.every === undefined) === (flags.at === undefined)) throw new CliError("Informe exatamente um: --every N ou --at HH:MM.");
      const schedule = flags.every !== undefined ? { type: "interval", minutes: Number(flags.every) } : { type: "daily", time: flags.at };
      const { routine: r } = await call("POST", "/routines", { name: args[1], kind: prompt ? "prompt" : "command", text: args.slice(2).join(" "), schedule });
      console.log(`Rotina "${r.name}" criada (${when(r)}); próxima: ${new Date(r.nextRunAt).toLocaleString()}.`);
    } else if (sub === "rm" || sub === "remove") {
      need(args, 2, USAGE);
      await call("POST", "/routines/remove", { name: args[1] });
      console.log(`Rotina "${args[1]}" removida.`);
    } else if (sub === "run") {
      need(args, 2, USAGE);
      await call("POST", "/routines/run", { name: args[1] });
      console.log(`Rotina "${args[1]}" iniciada.`);
    } else throw new CliError(`Uso: maestri ${USAGE}`);
  };
}
