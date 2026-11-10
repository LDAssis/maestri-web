// Contas de CLI (POLISH3): nome + programa (claude|codex) + diretório de configuração isolado em <dataDir>/accounts/<programa>/<nome>.
import fs from "node:fs";
import path from "node:path";
import { ApiError } from "./agents.js";
import { programOf } from "./resume.js";
import type { Isolation } from "./isolation.js";

export const ACCOUNT_PROGRAMS = ["claude", "codex"] as const;
export type AccountProgram = (typeof ACCOUNT_PROGRAMS)[number];
export const DEFAULT_ACCOUNT = "Default";
// Fase 3: o login do admin (/root/.claude, /root/.codex) vira esta conta, liberada a todo admin; "Default" nos projetos isolados aponta para ela
export const STANDARD_ACCOUNT = "Padrão";
// Variável de ambiente que isola o login de cada CLI
const ENV_VAR: Record<AccountProgram, string> = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" };
const NAME_RE = /^[\p{L}\d][\p{L}\d _.-]{0,39}$/u;

const lc = (s: string) => s.trim().toLowerCase();

export class AccountStore {
  // accountsDir: raiz das contas (padrão <dataDir>/accounts; com isolamento, /srv/maestri/accounts)
  constructor(private dataDir: string, private opts: { accountsDir?: string; iso?: Isolation; onChange?: () => void } = {}) {}

  get accountsRoot() {
    return this.opts.accountsDir ?? path.join(this.dataDir, "accounts");
  }

  private root(program: AccountProgram) {
    return path.join(this.accountsRoot, program);
  }

  dir(program: AccountProgram, name: string) {
    return path.join(this.root(program), name);
  }

  checkProgram(v: unknown): AccountProgram {
    if (typeof v !== "string" || !(ACCOUNT_PROGRAMS as readonly string[]).includes(v)) throw new ApiError(400, `Programa inválido (${ACCOUNT_PROGRAMS.join(", ")}).`);
    return v as AccountProgram;
  }

  // Contas criadas (sem o "Default", que é o login existente do CLI)
  list(): { program: AccountProgram; name: string }[] {
    return ACCOUNT_PROGRAMS.flatMap((program) => {
      try {
        return fs.readdirSync(this.root(program), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => ({ program, name: d.name })).sort((a, b) => a.name.localeCompare(b.name));
      } catch {
        return [];
      }
    });
  }

  // "Default" + as criadas para o programa
  names(program: AccountProgram): string[] {
    return [DEFAULT_ACCOUNT, ...this.list().filter((a) => a.program === program).map((a) => a.name)];
  }

  find(program: AccountProgram, name: string): string | null {
    if (lc(name) === lc(DEFAULT_ACCOUNT)) return DEFAULT_ACCOUNT;
    return this.list().find((a) => a.program === program && lc(a.name) === lc(name))?.name ?? null;
  }

  create(program: AccountProgram, name: unknown) {
    if (typeof name !== "string" || !NAME_RE.test(name.trim())) throw new ApiError(400, "Nome da conta: 1 a 40 caracteres (letras, números, espaço, ponto, hífen e sublinhado).");
    const n = name.trim();
    if (lc(n) === lc(DEFAULT_ACCOUNT)) throw new ApiError(400, '"Default" é o login existente do CLI e não pode ser criada.');
    if (this.find(program, n)) throw new ApiError(409, `Já existe a conta "${n}" para ${program}.`);
    // Cada conta guarda o login do CLI: só o dono do servidor entra (0700), sem depender do umask
    fs.mkdirSync(this.dir(program, n), { recursive: true, mode: 0o700 });
    if (this.opts.iso?.enabled) {
      // Isolamento: pasta root:<grupo da conta> 2770; os projetos liberados entram no grupo
      this.opts.iso.ensureAccountDir(program, n, this.dir(program, n));
    } else {
      for (const d of [this.dir(program, n), this.root(program), this.accountsRoot]) {
        try {
          fs.chmodSync(d, 0o700);
        } catch {}
      }
    }
    this.opts.onChange?.();
    return n;
  }

  delete(program: AccountProgram, name: string) {
    const real = this.find(program, name);
    if (!real || real === DEFAULT_ACCOUNT) throw new ApiError(404, `Conta "${name}" não encontrada para ${program}.`);
    fs.rmSync(this.dir(program, real), { recursive: true, force: true });
    this.opts.iso?.enabled && this.opts.iso.removeAccountGroup(program, real);
    this.opts.onChange?.();
    return real;
  }

  // Valida a conta para o comando (programa claude/codex) e devolve o nome canônico; "Default" = sem conta
  resolveFor(cmd: string, name: string): string | undefined {
    const program = programOf(cmd);
    if (program !== "claude" && program !== "codex") throw new ApiError(400, "Contas só existem para comandos claude e codex.");
    const real = this.find(program, name);
    if (!real) throw new ApiError(404, `Conta "${name}" não encontrada para ${program} (veja "maestri account list").`);
    return real === DEFAULT_ACCOUNT ? undefined : real;
  }

  // Variável de ambiente de uma conta (programa já conhecido); "Default"/inexistente = sem variável
  envForProgram(program: AccountProgram, account: unknown): Record<string, string> {
    if (typeof account !== "string" || !account) return {};
    const real = this.find(program, account);
    if (!real || real === DEFAULT_ACCOUNT) return {};
    return { [ENV_VAR[program]]: this.dir(program, real) };
  }

  // Variável de ambiente que o terminal recebe ao iniciar
  envFor(cmd: string | undefined, account: unknown): Record<string, string> {
    const program = programOf(cmd);
    return program === "claude" || program === "codex" ? this.envForProgram(program, account) : {};
  }
}
