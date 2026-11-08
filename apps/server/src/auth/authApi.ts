import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthService } from "./service.js";
import { burnPasswordTime, checkPassword, hashPassword, verifyPassword } from "./password.js";
import { COLOR_RE, cleanName, normEmail, publicUser, validEmail, validName } from "./users.js";

interface Deps {
  fastify: FastifyInstance;
  auth: AuthService;
}

const iso = (ms: number) => new Date(ms).toISOString();
const str = (v: unknown, max = 500): v is string => typeof v === "string" && v.length <= max;
const TOO_MANY = "Muitas tentativas. Aguarde alguns minutos e tente de novo.";

export function registerAuthApi({ fastify, auth }: Deps) {
  const fail = (reply: FastifyReply, code: number, error: string, extra: object = {}) => reply.code(code).send({ error, ...extra });
  const weak = (reply: FastifyReply, fails: string[]) => fail(reply, 400, fails[0], { errors: fails });
  const ipKey = (req: FastifyRequest) => `ip:${req.ip}`;
  const session = (userId: string) => auth.sessions.create(userId);

  fastify.get("/api/auth/state", async () => ({ setupRequired: auth.users.count() === 0 }));

  // Cria o ADMIN: só com 0 usuários e com a chave de configuração (= MAESTRI_TOKEN)
  fastify.post("/api/auth/setup", async (req: any, reply) => {
    const b = req.body ?? {};
    if (!auth.limiter.take(ipKey(req), "setup")) return fail(reply, 429, TOO_MANY);
    if (auth.users.count() > 0) return fail(reply, 409, "A configuração inicial já foi concluída.");
    if (!auth.internalToken) return fail(reply, 403, "O servidor não tem chave de configuração (MAESTRI_TOKEN).");
    if (!auth.isInternal(b.setupKey)) return fail(reply, 403, "Chave de configuração incorreta.");
    const name = cleanName(b.name);
    const email = normEmail(b.email);
    if (!validName(name)) return fail(reply, 400, "Informe o nome (até 80 caracteres).");
    if (!validEmail(email)) return fail(reply, 400, "E-mail inválido.");
    const fails = checkPassword(b.password, { name, email });
    if (fails.length) return weak(reply, fails);
    const passHash = await hashPassword(b.password);
    if (auth.users.count() > 0) return fail(reply, 409, "A configuração inicial já foi concluída."); // outra requisição ganhou
    const user = auth.users.add({ name, email, passHash, role: "admin" });
    auth.users.update(user.id, { lastLoginAt: iso(Date.now()) });
    return { token: session(user.id), user: publicUser(user) };
  });

  fastify.post("/api/auth/login", async (req: any, reply) => {
    const b = req.body ?? {};
    if (!str(b.email, 254) || !str(b.password, 1000)) return fail(reply, 400, "Informe e-mail e senha.");
    const email = normEmail(b.email);
    const emailKey = `email:${email}`;
    if (!auth.limiter.take(ipKey(req), emailKey)) return fail(reply, 429, TOO_MANY);
    const user = auth.users.byEmail(email);
    if (!user) {
      await burnPasswordTime(b.password);
      return fail(reply, 401, "E-mail ou senha incorretos");
    }
    if (!(await verifyPassword(b.password, user.passHash))) return fail(reply, 401, "E-mail ou senha incorretos");
    if (user.disabled) return fail(reply, 403, "Conta desativada");
    auth.limiter.clear(emailKey);
    auth.users.update(user.id, { lastLoginAt: iso(Date.now()) });
    return { token: session(user.id), user: publicUser(user) };
  });

  fastify.get("/api/invites/:token", async (req: any, reply) => {
    const inv = auth.invites.find(req.params.token);
    if (!inv) return fail(reply, 404, "Link inválido ou expirado.");
    const target = inv.kind === "reset" && inv.userId ? auth.users.get(inv.userId) : undefined;
    if (inv.kind === "reset" && !target) return fail(reply, 404, "Link inválido ou expirado.");
    return { valid: true, kind: inv.kind, ...(target && { email: target.email }), expiresAt: iso(inv.expiresAt) };
  });

  fastify.post("/api/invites/:token/accept", async (req: any, reply) => {
    const b = req.body ?? {};
    const token: string = req.params.token;
    const email0 = normEmail(b.email);
    if (!auth.limiter.take(ipKey(req), email0 ? `email:${email0}` : `invite:${String(token).slice(0, 16)}`)) return fail(reply, 429, TOO_MANY);
    const inv = auth.invites.find(token);
    if (!inv) return fail(reply, 404, "Link inválido ou expirado.");

    if (inv.kind === "reset") {
      const target = inv.userId ? auth.users.get(inv.userId) : undefined;
      if (!target) return fail(reply, 404, "Link inválido ou expirado.");
      if (target.disabled) return fail(reply, 403, "Conta desativada");
      const fails = checkPassword(b.password, { name: target.name, email: target.email });
      if (fails.length) return weak(reply, fails);
      const passHash = await hashPassword(b.password);
      if (!auth.invites.consume(token)) return fail(reply, 404, "Link inválido ou expirado.");
      auth.users.update(target.id, { passHash, lastLoginAt: iso(Date.now()) });
      auth.revokeUser(target.id);
      return { token: session(target.id), user: publicUser(target) };
    }

    const name = cleanName(b.name);
    const email = email0;
    if (!validName(name)) return fail(reply, 400, "Informe o nome (até 80 caracteres).");
    if (!validEmail(email)) return fail(reply, 400, "E-mail inválido.");
    if (auth.users.byEmail(email)) return fail(reply, 409, "Já existe uma conta com esse e-mail.");
    const fails = checkPassword(b.password, { name, email });
    if (fails.length) return weak(reply, fails);
    const passHash = await hashPassword(b.password);
    if (auth.users.byEmail(email)) return fail(reply, 409, "Já existe uma conta com esse e-mail.");
    if (!auth.invites.consume(token)) return fail(reply, 404, "Link inválido ou expirado.");
    const user = auth.users.add({ name, email, passHash, role: "user" });
    auth.users.update(user.id, { lastLoginAt: iso(Date.now()) });
    return { token: session(user.id), user: publicUser(user) };
  });

  // --- com sessão de usuário (o token interno não tem conta) ---
  const needUser = (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.authUser) {
      fail(reply, 401, "Faça login com uma conta de usuário.");
      return null;
    }
    return req.authUser;
  };

  fastify.get("/api/auth/me", async (req, reply) => {
    const u = needUser(req, reply);
    return u ? { user: publicUser(u) } : reply;
  });

  fastify.post("/api/auth/logout", async (req, reply) => {
    const u = needUser(req, reply);
    if (!u) return reply;
    auth.logout(u.id, req.authSessionId!);
    return { ok: true };
  });

  fastify.patch("/api/auth/me", async (req: any, reply) => {
    const u = needUser(req, reply);
    if (!u) return reply;
    const b = req.body ?? {};
    const patch: { name?: string; color?: string } = {};
    if (b.name !== undefined) {
      const name = cleanName(b.name);
      if (!validName(name)) return fail(reply, 400, "Nome inválido (1 a 80 caracteres).");
      patch.name = name;
    }
    if (b.color !== undefined) {
      if (typeof b.color !== "string" || !COLOR_RE.test(b.color)) return fail(reply, 400, "Cor inválida (use #RRGGBB).");
      patch.color = b.color.toLowerCase();
    }
    const nu = auth.users.update(u.id, patch)!;
    return { user: publicUser(nu) };
  });

  fastify.post("/api/auth/password", async (req: any, reply) => {
    const u = needUser(req, reply);
    if (!u) return reply;
    const b = req.body ?? {};
    if (!auth.limiter.take(ipKey(req), `pw:${u.id}`)) return fail(reply, 429, TOO_MANY);
    if (!str(b.current, 1000) || !(await verifyPassword(b.current, u.passHash))) return fail(reply, 403, "Senha atual incorreta.");
    const fails = checkPassword(b.password, { name: u.name, email: u.email });
    if (fails.length) return weak(reply, fails);
    const passHash = await hashPassword(b.password);
    auth.users.update(u.id, { passHash });
    auth.revokeUser(u.id, req.authSessionId); // as outras sessões caem; esta continua
    return { ok: true };
  });
}
