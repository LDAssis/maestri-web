// Contas de assinatura por projeto (Fase 3). Uma conta (claude/codex) vive em <accountsDir>/<programa>/<nome>, com um grupo de SO
// próprio. O admin libera contas POR USUÁRIO (User.accounts); um projeto pode usar as contas liberadas ao DONO (admin: todas), e o
// usuário do projeto entra/sai dos grupos conforme isso. Revogar tira do grupo e reinicia os terminais do projeto.
import type { AccountStore, AccountProgram } from "./accounts.js";
import { ACCOUNT_PROGRAMS, DEFAULT_ACCOUNT, STANDARD_ACCOUNT } from "./accounts.js";
import type { Isolation, ProjectLike } from "./isolation.js";
import type { AuthService } from "./auth/service.js";
import type { User } from "./auth/users.js";
import { accountProgramOf } from "./resume.js";

export interface AccountProject extends ProjectLike {
  ownerId?: string;
}
export interface AccountRef {
  program: AccountProgram;
  name: string;
}
const key = (program: string, name: string) => `${program}/${name.trim().toLowerCase()}`;
const lc = (s: string) => s.trim().toLowerCase();

export const NO_ACCOUNT_MESSAGE = "Nenhuma conta de assinatura liberada para este projeto — peça ao admin.";

export class AccountAccess {
  // Chamado quando um projeto perdeu grupos de conta (os terminais dele precisam reiniciar)
  onRevoked?: (project: AccountProject, groups: string[]) => void;

  constructor(
    private store: AccountStore,
    private iso: Isolation,
    private auth: AuthService,
    private projects: () => AccountProject[],
  ) {}

  // Contas liberadas a um usuário (admin: todas)
  grantsOf(user: User | undefined | null): AccountRef[] {
    if (!user) return [];
    const all = this.store.list();
    if (user.role === "admin") return all;
    const have = new Set((user.accounts ?? []).map((a) => key(a.program, a.name)));
    return all.filter((a) => have.has(key(a.program, a.name)));
  }
  grantsOfOwner(p: AccountProject) {
    return this.grantsOf(p.ownerId ? this.auth.users.get(p.ownerId) : undefined);
  }

  // Conta que um terminal do projeto usa: "Default"/vazio = "Padrão" (o login do admin) quando o projeto é isolado
  resolve(p: AccountProject, cmd: string | undefined, account: unknown): { env: Record<string, string> } | { blocked: string } | { env: {} } {
    const program = accountProgramOf(cmd);
    if (!program) return { env: {} };
    if (!this.iso.isIsolated(p)) return { env: this.store.envFor(cmd, account) }; // projeto externo (root): como antes
    const asked = typeof account === "string" && account.trim() && lc(account) !== lc(DEFAULT_ACCOUNT) ? account.trim() : STANDARD_ACCOUNT;
    const real = this.store.find(program, asked);
    const granted = real && real !== DEFAULT_ACCOUNT ? this.grantsOfOwner(p).some((a) => a.program === program && lc(a.name) === lc(real)) : false;
    if (!real || !granted) {
      return { blocked: asked === STANDARD_ACCOUNT ? NO_ACCOUNT_MESSAGE : `A conta "${asked}" não está liberada para este projeto — peça ao admin.` };
    }
    return { env: this.store.envForProgram(program, real) };
  }

  // Pastas de conta que o servidor pode preparar para os agentes deste projeto (instruções do canvas)
  sharedDirs(p: AccountProject): string[] {
    return this.iso.isIsolated(p) ? this.grantsOfOwner(p).map((a) => this.store.dir(a.program, a.name)) : [];
  }

  // Contas visíveis a quem chama: admin/interno todas; terminal e usuário com projeto = as do dono; usuário sem projeto = as dele
  visible(who: { internal?: boolean; user?: User | null; project?: AccountProject | null }): AccountRef[] {
    if (who.internal || who.user?.role === "admin") return this.store.list();
    if (who.project) return this.grantsOfOwner(who.project);
    return this.grantsOf(who.user);
  }

  // ---------- grupos ----------
  wantedGroups(p: AccountProject) {
    return this.grantsOfOwner(p).map((a) => this.iso.groupFor(a.program, a.name));
  }
  syncProject(p: AccountProject) {
    if (!this.iso.isIsolated(p)) return;
    try {
      const { removed } = this.iso.syncAccountGroups(p.osUser!, this.wantedGroups(p));
      if (removed.length) this.onRevoked?.(p, removed);
    } catch (e: any) {
      console.warn(`Contas: não foi possível sincronizar os grupos de ${p.osUser}: ${String(e?.message || e).split("\n")[0]}`);
    }
  }
  syncAll() {
    for (const p of this.projects()) this.syncProject(p);
  }
  syncOwnedBy(userId: string) {
    for (const p of this.projects()) if (p.ownerId === userId) this.syncProject(p);
  }

  // ---------- liberação ----------
  view(user: User) {
    const granted = new Set(this.grantsOf(user).map((a) => key(a.program, a.name)));
    return { accounts: this.store.list().map((a) => ({ program: a.program, name: a.name, granted: granted.has(key(a.program, a.name)) })) };
  }

  // Valida e grava as liberações; devolve null se alguma conta não existe
  setGrants(user: User, grants: { program: unknown; name: unknown }[]): AccountRef[] | null {
    const out: AccountRef[] = [];
    for (const g of grants) {
      if (typeof g?.program !== "string" || typeof g?.name !== "string") return null;
      const real = (ACCOUNT_PROGRAMS as readonly string[]).includes(g.program) ? this.store.find(g.program as AccountProgram, g.name) : null;
      if (!real || real === DEFAULT_ACCOUNT) return null;
      if (!out.some((a) => a.program === g.program && a.name === real)) out.push({ program: g.program as AccountProgram, name: real });
    }
    this.auth.users.update(user.id, { accounts: out });
    this.syncOwnedBy(user.id);
    return out;
  }
}
