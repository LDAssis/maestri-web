// Contas de CLI (POLISH3): `maestri account list|create|delete`. Uma conta isola o login do claude/codex num diretório
// de configuração próprio (CLAUDE_CONFIG_DIR / CODEX_HOME); o login de fato é feito rodando o CLI no terminal da conta.

const HELP = `maestri account list
maestri account create "Nome" --cli claude|codex
maestri account delete "Nome" --cli claude|codex
Contas de CLI para rodar agentes lado a lado em assinaturas/chaves diferentes: "maestri recruit ... --account Nome",
"maestri preset create/set ... --account Nome" e "maestri recruit --replace X --account Nome". "Default" é o login existente
do CLI e não precisa ser criada. Depois de recrutar na conta nova, faça o login rodando o CLI naquele terminal.
create/delete: só o Maestro. delete apaga o diretório de configuração (o login dessa conta) e só deve ser usado a pedido
explícito do usuário; é recusado enquanto algum terminal usa a conta. Presets que fixavam a conta são desafixados (e listados).`;

export function register({ call, need, CliError }) {
  async function account({ pos, flags }) {
    const [sub, name] = pos;
    const cli = flags.cli ?? flags.program;
    if (sub === "list") {
      const { accounts } = await call("GET", "/accounts");
      for (const program of ["claude", "codex"]) {
        const mine = accounts.filter((a) => a.program === program);
        console.log(`${program}: "Default"${mine.map((a) => `, "${a.name}"${a.usedBy.length ? ` (em uso: ${a.usedBy.join(", ")})` : ""}`).join("")}`);
      }
    } else if (sub === "create" || sub === "delete") {
      need(pos, 2, `account ${sub} "Nome" --cli claude|codex`);
      if (!cli) throw new CliError("Falta --cli claude|codex.");
      const r = await call("POST", `/accounts/${sub}`, { name, program: cli });
      console.log(sub === "create" ? `Conta "${r.name}" criada para ${cli}. Recrute com --account "${r.name}" e faça o login rodando ${cli} naquele terminal.` : `Conta "${r.name}" apagada (${cli}).${r.unpinned?.length ? ` Presets desafixados (voltam ao login padrão): ${r.unpinned.map((p) => `"${p}"`).join(", ")}.` : ""}`);
    } else throw new CliError('Uso: maestri account list|create|delete (veja "maestri account --help")');
  }

  return {
    commands: { account },
    help: { account: HELP },
    flags: ["--cli", "--program"],
    summary: ["Contas:", '  account list|create|delete          Contas de CLI (claude/codex) para --account (create/delete: Maestro)'],
  };
}
