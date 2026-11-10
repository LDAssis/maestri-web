import crypto from "node:crypto";
import path from "node:path";
import type { FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { InviteStore } from "./invites.js";
import { RateLimiter } from "./rateLimit.js";
import { SessionStore } from "./sessions.js";
import { UserStore, type User } from "./users.js";

declare module "fastify" {
  interface FastifyRequest {
    // null = token interno (agentes/CLI, privilégio de admin); undefined = rota pública/sem autenticação exigida
    authUser?: User | null;
    authInternal?: boolean;
    authSessionId?: string;
    // Token por terminal (Fase 3): só vale para o próprio projeto/nó; nunca é admin nem usuário
    authTerminal?: { projectId: string; nodeId: string; ptyId: string };
  }
}

export type AuthResult = { internal: true } | { internal: false; user: User; sessionId: string } | null;

export class AuthService {
  users: UserStore;
  sessions: SessionStore;
  invites: InviteStore;
  limiter = new RateLimiter(10, 15 * 60_000);
  onSetup?: () => void; // depois do primeiro admin criado (os projetos sem dono passam a ele)
  private sockets = new Map<string, Set<{ socket: WebSocket; sessionId: string }>>(); // por userId

  // internalToken: MAESTRI_TOKEN ("" = sem autenticação, modo dev em loopback)
  constructor(dataDir: string, public internalToken: string) {
    this.users = new UserStore(path.join(dataDir, "users.json"));
    this.sessions = new SessionStore(path.join(dataDir, "auth_sessions.json"));
    this.invites = new InviteStore(path.join(dataDir, "invites.json"));
  }

  isInternal(given: unknown) {
    if (!this.internalToken || typeof given !== "string") return false;
    const a = Buffer.from(given);
    const b = Buffer.from(this.internalToken);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // Token interno ou sessão de usuário (renova a sessão); usuário desativado/inexistente não passa
  authenticate(token: unknown): AuthResult {
    if (typeof token !== "string" || !token) return null;
    if (this.isInternal(token)) return { internal: true };
    const s = this.sessions.touch(token);
    if (!s) return null;
    const user = this.users.get(s.userId);
    if (!user || user.disabled) return null;
    return { internal: false, user, sessionId: s.sessionId };
  }

  // Sockets autenticados por sessão: fecham quando a sessão cai
  trackSocket(userId: string, sessionId: string, socket: WebSocket) {
    const entry = { socket, sessionId };
    let set = this.sockets.get(userId);
    if (!set) this.sockets.set(userId, (set = new Set()));
    set.add(entry);
    socket.on("close", () => {
      set!.delete(entry);
      if (!set!.size) this.sockets.delete(userId);
    });
  }

  private closeSockets(userId: string, only?: Set<string>) {
    for (const e of [...(this.sockets.get(userId) ?? [])]) {
      if (only && !only.has(e.sessionId)) continue;
      try {
        e.socket.close(4401, "Sessão encerrada");
      } catch {}
    }
  }

  // Derruba as sessões do usuário (menos `keep`) e fecha os WS delas
  revokeUser(userId: string, keep?: string) {
    const gone = new Set(this.sessions.removeForUser(userId, keep));
    this.closeSockets(userId, gone);
  }

  logout(userId: string, sessionId: string) {
    this.sessions.remove(sessionId);
    this.closeSockets(userId, new Set([sessionId]));
  }

  attachReq(req: FastifyRequest, r: AuthResult) {
    if (!r) return;
    req.authInternal = r.internal;
    req.authUser = r.internal ? null : r.user;
    if (!r.internal) req.authSessionId = r.sessionId;
  }
}
