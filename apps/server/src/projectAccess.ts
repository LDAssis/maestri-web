// Permissões por projeto (Fase 2): dono, membros e admin. A verdade fica no projeto (ownerId/members em projects.json).
// Token interno (agentes/CLI) e modo dev sem token têm acesso total (req.authInternal); a Fase 3 troca isso.
import { AsyncLocalStorage } from "node:async_hooks";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import type { AuthService } from "./auth/service.js";
import type { User } from "./auth/users.js";

export interface AclProject {
  id: string;
  name: string;
  repoPath: string;
  ownerId?: string;
  members?: string[];
}
export type Access = "owner" | "member" | "admin";

// Requisição em andamento: deixa as rotas de agente (que resolvem OUTRO projeto pelo nome) consultarem o acesso de quem chamou
export const reqStore = new AsyncLocalStorage<FastifyRequest>();

const NOT_FOUND = "Projeto não encontrado.";
const ID_RE = /^\/api\/projects\/([^/]+)(?:\/|$)/;
const dec = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

type Who = { internal: true } | { internal: false; user: User };
export const whoOf = (req: FastifyRequest): Who | null => {
  if (req.authInternal) return { internal: true };
  return req.authUser ? { internal: false, user: req.authUser } : null;
};

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  color: string;
}
export const dirUser = (u: User): PublicUser => ({ id: u.id, name: u.name, email: u.email, color: u.color });

export class ProjectAcl {
  // Mudou o dono de algum projeto (transferência/exclusão de usuário): as contas liberadas ao dono mudam junto (Fase 3)
  onOwnerChange?: () => void;
  private sockets = new Set<{ userId: string; projectId: string; kind: "project" | "terminal" | "portal"; socket: WebSocket }>();

  constructor(
    private getProjects: () => AclProject[],
    private auth: AuthService,
    private persist: () => void,
    // avisa todos os clientes conectados de que a lista de projetos mudou ({type:"sidebar"})
    private notifyAll: () => void,
  ) {}

  find(id: string) {
    return this.getProjects().find((p) => p.id === id);
  }

  // Acesso de um usuário (conta) a um projeto
  accessOfUser(user: User, p: AclProject): Access | null {
    if (p.ownerId === user.id) return "owner";
    if ((p.members ?? []).includes(user.id)) return "member";
    if (user.role === "admin") return "admin";
    return null;
  }

  accessOf(who: Who | null, p: AclProject): Access | null {
    if (!who) return null;
    if (who.internal) return "admin";
    return this.accessOfUser(who.user, p);
  }

  reqAccess(req: FastifyRequest, p: AclProject) {
    return this.accessOf(whoOf(req), p);
  }

  // Dono ou admin (gerenciar membros, transferir, excluir)
  canManage(access: Access | null) {
    return access === "owner" || access === "admin";
  }

  isAdminReq(req: FastifyRequest) {
    return !!req.authInternal || req.authUser?.role === "admin";
  }

  // Dentro de um handler (via reqStore): o chamador enxerga esse projeto? Sem requisição = chamada interna.
  canSeeCurrent = (projectId: string) => {
    const req = reqStore.getStore();
    if (!req) return true;
    if (req.authTerminal) return projectId === req.authTerminal.projectId; // token de terminal: só o próprio projeto
    const p = this.find(projectId);
    return !!p && !!this.reqAccess(req, p);
  };

  // ---------- migração / herança ----------
  firstAdminId(): string | undefined {
    return [...this.auth.users.activeAdmins()].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0]?.id;
  }

  // Projetos sem dono passam ao primeiro admin ativo. Sem usuário ainda, ficam sem dono até o setup.
  migrate() {
    const admin = this.firstAdminId();
    let changed = false;
    for (const p of this.getProjects()) {
      if (!Array.isArray(p.members)) {
        p.members = [];
        changed = true;
      }
      if (!p.ownerId && admin) {
        p.ownerId = admin;
        changed = true;
      }
    }
    if (changed) this.persist();
    return changed;
  }

  // Projeto criado por agente/CLI herda dono e membros do projeto de origem; sem origem, o primeiro admin é o dono
  inherit(origin?: AclProject | null): { ownerId?: string; members: string[] } {
    if (origin?.ownerId) return { ownerId: origin.ownerId, members: [...(origin.members ?? [])] };
    return { ownerId: this.firstAdminId(), members: [] };
  }

  // Quem aparece em `access` de um item de /api/projects
  describe(req: FastifyRequest, p: AclProject): Access {
    return this.reqAccess(req, p) ?? "admin";
  }

  // Item de projeto como o chamador pode ver: não-admin não recebe repoPath nem a lista de membros
  present(req: FastifyRequest, p: AclProject) {
    // osUser/uid/gid (Fase 3) são detalhe de SO: só o admin vê
    const { members, repoPath, osUser, uid, gid, ...rest } = p as AclProject & { osUser?: string; uid?: number; gid?: number };
    const base = { ...rest, ownerId: p.ownerId ?? null, access: this.describe(req, p) };
    return this.isAdminReq(req) ? { ...base, repoPath, members: members ?? [], ...(osUser ? { osUser, uid, gid } : {}) } : base;
  }

  // ---------- sockets por projeto (revogação) ----------
  track(socket: WebSocket, projectId: string, kind: "project" | "terminal" | "portal") {
    const userId = (socket as any).authUser?.id as string | undefined;
    if (!userId) return;
    const e = { userId, projectId, kind, socket };
    this.sockets.add(e);
    socket.on("close", () => this.sockets.delete(e));
  }

  // Porta de entrada dos WS por projeto. Sem acesso: fecha com 4404. Devolve se pode seguir.
  wsAllowed(socket: WebSocket, projectId: string, kind: "project" | "terminal" | "portal") {
    const user = (socket as any).authUser as User | undefined;
    if (!user) return true; // token interno / dev
    const p = this.find(projectId);
    if (!p || !this.accessOfUser(this.auth.users.get(user.id) ?? user, p)) {
      socket.close(4404, NOT_FOUND);
      return false;
    }
    this.track(socket, projectId, kind);
    return true;
  }

  // O usuário perdeu o acesso: fecha os WS dele nesse projeto (4403) e manda {type:"sidebar"} aos canvas que sobraram
  revoke(userId: string, projectId: string) {
    for (const e of [...this.sockets]) {
      if (e.userId === userId && e.projectId === projectId) {
        try {
          e.socket.close(4403, "Sem acesso ao projeto");
        } catch {}
        this.sockets.delete(e);
      }
    }
    for (const e of this.sockets) {
      if (e.userId !== userId || e.kind !== "project") continue;
      try {
        if (e.socket.readyState === 1) e.socket.send(JSON.stringify({ type: "sidebar" }));
      } catch {}
    }
  }

  // Revoga quem deixou de ter acesso depois de uma mudança: compara usuários antes/depois
  revokeLost(p: AclProject, before: Set<string>) {
    for (const id of before) {
      const u = this.auth.users.get(id);
      if (!u || !this.accessOfUser(u, p)) this.revoke(id, p.id);
    }
  }

  private holders(p: AclProject) {
    return new Set([...(p.ownerId ? [p.ownerId] : []), ...(p.members ?? [])]);
  }

  // ---------- operações ----------
  addMember(p: AclProject, userId: string) {
    p.members ??= [];
    if (!p.members.includes(userId)) {
      p.members.push(userId);
      this.persist();
      this.notifyAll();
    }
  }

  removeMember(p: AclProject, userId: string) {
    const had = this.holders(p);
    p.members = (p.members ?? []).filter((m) => m !== userId);
    this.persist();
    this.revokeLost(p, had);
    this.notifyAll();
  }

  transfer(p: AclProject, userId: string) {
    const old = p.ownerId;
    p.members = (p.members ?? []).filter((m) => m !== userId);
    if (old && old !== userId && !p.members.includes(old)) p.members.push(old);
    p.ownerId = userId;
    this.persist();
    this.notifyAll();
    this.onOwnerChange?.();
  }

  // Admin excluiu o usuário: projetos dele passam a quem excluiu; ele sai de todos os members
  onUserDeleted(userId: string, actorId: string | null) {
    const heir = actorId && actorId !== userId ? actorId : this.auth.users.activeAdmins().find((a) => a.id !== userId)?.id;
    for (const p of this.getProjects()) {
      p.members = (p.members ?? []).filter((m) => m !== userId);
      if (p.ownerId === userId) {
        p.ownerId = heir;
        if (heir) p.members = p.members.filter((m) => m !== heir);
      }
      this.revoke(userId, p.id);
    }
    this.persist();
    this.notifyAll();
    this.onOwnerChange?.();
  }

  // Projetos em que o usuário está explicitamente (dono/membro) ou é admin
  projectsOfUser(user: User) {
    return this.getProjects().map((p) => ({ id: p.id, name: p.name, access: this.accessOfUser(user, p) }));
  }

  // Define em quais projetos o usuário é membro (não mexe onde é dono). null se algum id não existe.
  setMemberships(user: User, projectIds: string[]) {
    const all = this.getProjects();
    if (projectIds.some((id) => !all.some((p) => p.id === id))) return null;
    const want = new Set(projectIds);
    for (const p of all) {
      if (p.ownerId === user.id) continue;
      const has = (p.members ?? []).includes(user.id);
      if (want.has(p.id) && !has) (p.members ??= []).push(user.id);
      else if (!want.has(p.id) && has) {
        const had = this.holders(p);
        p.members = (p.members ?? []).filter((m) => m !== user.id);
        this.revokeLost(p, had);
      }
    }
    this.persist();
    this.notifyAll();
    return this.projectsOfUser(user);
  }

  // ---------- guarda central ----------
  // Rotas globais só do admin (sessão admin ou token interno)
  isAdminOnlyRoute(method: string, pathname: string) {
    if (pathname === "/api/settings/global") return method !== "GET" && method !== "HEAD";
    if (pathname === "/api/clis" || pathname.startsWith("/api/clis/")) return true;
    if (pathname === "/api/cli-jobs" || pathname.startsWith("/api/cli-jobs/")) return true;
    if (pathname === "/api/accounts" || pathname.startsWith("/api/accounts/")) return method !== "GET" && method !== "HEAD";
    if (pathname === "/api/global-roles" || pathname.startsWith("/api/global-roles/")) return method !== "GET" && method !== "HEAD";
    return false;
  }

  register(fastify: FastifyInstance) {
    // O resto da requisição (inclusive rotas sem wrap) roda com a requisição no reqStore: canSeeCurrent() filtra por quem chamou
    fastify.addHook("onRequest", (req, _reply, done) => {
      reqStore.run(req, done);
    });
    // Depois da autenticação (hook registrado antes): rotas globais admin-only e toda rota /api/projects/:id/*
    fastify.addHook("onRequest", async (req, reply) => {
      if (req.method === "OPTIONS" || req.authInternal) return;
      const pathname = req.url.split("?")[0];
      if (!pathname.startsWith("/api/")) return;
      const user = req.authUser;
      if (!user) return; // rota pública ou sem autenticação exigida
      if (this.isAdminOnlyRoute(req.method, pathname) && user.role !== "admin") return reply.code(403).send({ error: "Apenas administradores." });
      const m = ID_RE.exec(pathname);
      if (!m) return;
      const p = this.find(dec(m[1]));
      const access = p ? this.accessOfUser(user, p) : null;
      if (!p || !access) return reply.code(404).send({ error: NOT_FOUND });
      // Excluir o projeto (e o resumo da exclusão): dono ou admin
      const rest = pathname.slice(m[0].length);
      const isDelete = (req.method === "DELETE" && rest === "") || (req.method === "GET" && rest === "delete-info");
      if (isDelete && !this.canManage(access)) return reply.code(403).send({ error: "Apenas o dono ou um administrador pode excluir o projeto." });
    });
  }
}

// Rotas novas: membros, dono, diretório
export function registerProjectAclApi(fastify: FastifyInstance, acl: ProjectAcl, auth: AuthService) {
  const fail = (reply: any, code: number, error: string) => reply.code(code).send({ error });
  const membersOf = (p: AclProject) => (p.members ?? []).map((id) => auth.users.get(id)).filter((u): u is User => !!u).map(dirUser);
  const ownerOf = (p: AclProject) => {
    const u = p.ownerId ? auth.users.get(p.ownerId) : undefined;
    return u ? dirUser(u) : null;
  };
  // O guarda central já garantiu o acesso; aqui só resolvemos o projeto e o nível
  const ctx = (req: any, reply: any) => {
    const p = acl.find(String(req.params.id));
    const access = p ? acl.reqAccess(req, p) : null;
    if (!p || !access) {
      fail(reply, 404, NOT_FOUND);
      return null;
    }
    return { p, access };
  };
  const target = (userId: unknown) => (typeof userId === "string" ? auth.users.get(userId) : undefined);

  fastify.get("/api/users/directory", async (req, reply) => {
    if (!req.authUser && !req.authInternal) return fail(reply, 401, "Faça login.");
    return { users: auth.users.all().filter((u) => !u.disabled).map(dirUser) };
  });

  fastify.get("/api/projects/:id/members", async (req: any, reply) => {
    const c = ctx(req, reply);
    if (!c) return reply;
    return { owner: ownerOf(c.p), members: membersOf(c.p) };
  });

  fastify.post("/api/projects/:id/members", async (req: any, reply) => {
    const c = ctx(req, reply);
    if (!c) return reply;
    if (!acl.canManage(c.access)) return fail(reply, 403, "Apenas o dono ou um administrador gerencia os membros.");
    const u = target(req.body?.userId);
    if (!u || u.disabled) return fail(reply, 400, "Usuário inexistente ou desativado.");
    if (u.id === c.p.ownerId) return fail(reply, 400, "Esse usuário já é o dono do projeto.");
    acl.addMember(c.p, u.id);
    return { members: membersOf(c.p) };
  });

  fastify.delete("/api/projects/:id/members/:userId", async (req: any, reply) => {
    const c = ctx(req, reply);
    if (!c) return reply;
    const userId = String(req.params.userId);
    const self = req.authUser?.id === userId;
    if (!self && !acl.canManage(c.access)) return fail(reply, 403, "Apenas o dono ou um administrador gerencia os membros.");
    if (userId === c.p.ownerId) return fail(reply, 400, "O dono não pode ser removido; transfira o projeto antes.");
    acl.removeMember(c.p, userId);
    return { members: membersOf(c.p) };
  });

  fastify.post("/api/projects/:id/owner", async (req: any, reply) => {
    const c = ctx(req, reply);
    if (!c) return reply;
    if (!acl.canManage(c.access)) return fail(reply, 403, "Apenas o dono ou um administrador transfere o projeto.");
    const u = target(req.body?.userId);
    if (!u || u.disabled) return fail(reply, 400, "Usuário inexistente ou desativado.");
    if (u.id !== c.p.ownerId) acl.transfer(c.p, u.id);
    return { owner: ownerOf(c.p), members: membersOf(c.p) };
  });
}
