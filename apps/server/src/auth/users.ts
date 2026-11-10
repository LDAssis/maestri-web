import crypto from "node:crypto";
import { clock } from "./clock.js";
import { readJson, writeJsonAtomic } from "./store.js";

export type Role = "admin" | "user";
export interface User {
  id: string;
  name: string;
  email: string;
  passHash: string;
  role: Role;
  color: string;
  disabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  projects: string[]; // reservado (fase 2)
  accounts: { program: string; name: string }[]; // contas de assinatura liberadas (fase 3)
}
export interface PublicUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  color: string;
}

const COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316", "#06b6d4", "#84cc16"];
export const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
export const normEmail = (e: unknown) => (typeof e === "string" ? e.trim().toLowerCase() : "");
export const validEmail = (e: string) => e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
export const cleanName = (n: unknown) => (typeof n === "string" ? n.trim().replace(/\s+/g, " ") : "");
export const validName = (n: string) => n.length >= 1 && n.length <= 80 && !/[\x00-\x1f]/.test(n);

export const publicUser = (u: User): PublicUser => ({ id: u.id, name: u.name, email: u.email, role: u.role, color: u.color });

export class UserStore {
  private users: User[];
  constructor(private file: string) {
    this.users = readJson<User[]>(file, []);
  }
  private save() {
    writeJsonAtomic(this.file, this.users);
  }
  count() {
    return this.users.length;
  }
  all() {
    return this.users;
  }
  get(id: string) {
    return this.users.find((u) => u.id === id);
  }
  byEmail(email: string) {
    const e = normEmail(email);
    return this.users.find((u) => u.email === e);
  }
  activeAdmins() {
    return this.users.filter((u) => u.role === "admin" && !u.disabled);
  }
  add(p: { name: string; email: string; passHash: string; role: Role }): User {
    const u: User = {
      id: crypto.randomUUID(),
      name: p.name,
      email: normEmail(p.email),
      passHash: p.passHash,
      role: p.role,
      color: COLORS[this.users.length % COLORS.length],
      disabled: false,
      createdAt: new Date(clock.now()).toISOString(),
      lastLoginAt: null,
      projects: [],
      accounts: [],
    };
    this.users.push(u);
    this.save();
    return u;
  }
  update(id: string, patch: Partial<Pick<User, "name" | "color" | "role" | "disabled" | "passHash" | "lastLoginAt" | "accounts">>) {
    const u = this.get(id);
    if (!u) return undefined;
    Object.assign(u, patch);
    this.save();
    return u;
  }
  remove(id: string) {
    const n = this.users.length;
    this.users = this.users.filter((u) => u.id !== id);
    if (this.users.length !== n) this.save();
    return this.users.length !== n;
  }
}
