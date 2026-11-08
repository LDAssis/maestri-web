import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthService } from "./service.js";
import type { ProjectAcl } from "../projectAccess.js";
import { cleanName, validName, type User } from "./users.js";

interface Deps {
  fastify: FastifyInstance;
  auth: AuthService;
  acl?: ProjectAcl; // permissões por projeto (Fase 2)
}

const iso = (ms: number) => new Date(ms).toISOString();
const row = (u: User) => ({ id: u.id, name: u.name, email: u.email, role: u.role, disabled: u.disabled, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt, color: u.color });

export function registerAdminApi({ fastify, auth, acl }: Deps) {
  const fail = (reply: FastifyReply, code: number, error: string) => reply.code(code).send({ error });
  // Admin (sessão) ou token interno (agentes/CLI: privilégio de admin até a Fase 3)
  const adminOnly = async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.authInternal || req.authUser?.role === "admin") return;
    return fail(reply, 403, "Apenas administradores.");
  };
  const opts = { preHandler: adminOnly };
  const actorId = (req: FastifyRequest) => req.authUser?.id ?? null;

  // Depois da mudança, ainda sobra algum admin ativo?
  const keepsAnAdmin = (target: User, after: { role: string; disabled: boolean }) => {
    const wasActiveAdmin = target.role === "admin" && !target.disabled;
    const stillActiveAdmin = after.role === "admin" && !after.disabled;
    return !(wasActiveAdmin && !stillActiveAdmin) || auth.users.activeAdmins().length > 1;
  };

  fastify.get("/api/admin/users", opts, async () => ({ users: auth.users.all().map(row) }));

  fastify.patch("/api/admin/users/:id", opts, async (req: any, reply) => {
    const target = auth.users.get(req.params.id);
    if (!target) return fail(reply, 404, "Usuário não encontrado.");
    const b = req.body ?? {};
    const patch: Partial<Pick<User, "name" | "role" | "disabled">> = {};
    if (b.name !== undefined) {
      const name = cleanName(b.name);
      if (!validName(name)) return fail(reply, 400, "Nome inválido (1 a 80 caracteres).");
      patch.name = name;
    }
    if (b.role !== undefined) {
      if (b.role !== "admin" && b.role !== "user") return fail(reply, 400, "Papel inválido.");
      patch.role = b.role;
    }
    if (b.disabled !== undefined) {
      if (typeof b.disabled !== "boolean") return fail(reply, 400, "Valor inválido para disabled.");
      patch.disabled = b.disabled;
    }
    const after = { role: patch.role ?? target.role, disabled: patch.disabled ?? target.disabled };
    if (actorId(req) === target.id && (after.disabled || after.role !== "admin"))
      return fail(reply, 409, "Você não pode desativar nem rebaixar a própria conta.");
    if (!keepsAnAdmin(target, after)) return fail(reply, 409, "Precisa sobrar pelo menos um administrador ativo.");
    const u = auth.users.update(target.id, patch)!;
    if (patch.disabled) auth.revokeUser(u.id);
    return { user: row(u) };
  });

  fastify.delete("/api/admin/users/:id", opts, async (req: any, reply) => {
    const target = auth.users.get(req.params.id);
    if (!target) return fail(reply, 404, "Usuário não encontrado.");
    if (actorId(req) === target.id) return fail(reply, 409, "Você não pode excluir a própria conta.");
    if (!keepsAnAdmin(target, { role: "user", disabled: true })) return fail(reply, 409, "Precisa sobrar pelo menos um administrador ativo.");
    auth.revokeUser(target.id);
    auth.invites.removeResetsFor(target.id);
    // Os projetos dele passam a quem excluiu (token interno: ao primeiro outro admin) e ele sai de todos os members
    acl?.onUserDeleted(target.id, actorId(req));
    auth.users.remove(target.id);
    return { ok: true };
  });

  // Projetos do usuário: dono / membro / admin (admin sem vínculo) / null (sem acesso)
  fastify.get("/api/admin/users/:id/projects", opts, async (req: any, reply) => {
    const target = auth.users.get(req.params.id);
    if (!target || !acl) return fail(reply, 404, "Usuário não encontrado.");
    return { projects: acl.projectsOfUser(target) };
  });

  fastify.put("/api/admin/users/:id/projects", opts, async (req: any, reply) => {
    const target = auth.users.get(req.params.id);
    if (!target || !acl) return fail(reply, 404, "Usuário não encontrado.");
    const ids = req.body?.projectIds;
    if (!Array.isArray(ids) || !ids.every((x: unknown) => typeof x === "string")) return fail(reply, 400, "projectIds deve ser uma lista de ids.");
    const out = acl.setMemberships(target, ids);
    if (!out) return fail(reply, 400, "Algum projeto não existe.");
    return { projects: out };
  });

  fastify.post("/api/admin/users/:id/reset-link", opts, async (req: any, reply) => {
    const target = auth.users.get(req.params.id);
    if (!target) return fail(reply, 404, "Usuário não encontrado.");
    const r = auth.invites.create("reset", { userId: target.id, createdBy: actorId(req) });
    return { token: r.token, expiresAt: iso(r.expiresAt) };
  });

  fastify.get("/api/admin/invites", opts, async () => ({
    invites: auth.invites.pending().map((i) => ({ id: i.id, note: i.note, createdAt: iso(i.createdAt), expiresAt: iso(i.expiresAt), createdBy: i.createdBy })),
  }));

  fastify.post("/api/admin/invites", opts, async (req: any, reply) => {
    const note = req.body?.note;
    if (note !== undefined && (typeof note !== "string" || note.length > 200)) return fail(reply, 400, "Anotação inválida (até 200 caracteres).");
    const r = auth.invites.create("invite", { note, createdBy: actorId(req) });
    return { token: r.token, expiresAt: iso(r.expiresAt) };
  });

  fastify.delete("/api/admin/invites/:id", opts, async (req: any, reply) => {
    if (!auth.invites.revoke(req.params.id)) return fail(reply, 404, "Convite não encontrado.");
    return { ok: true };
  });
}
