import crypto from "node:crypto";
import { clock } from "./clock.js";
import { readJson, writeJsonAtomic } from "./store.js";
import { sha256 } from "./sessions.js";

export type InviteKind = "invite" | "reset";
export const INVITE_TTL_MS = 7 * 24 * 3600_000;
export const RESET_TTL_MS = 24 * 3600_000;

export interface Invite {
  id: string; // público (≠ token)
  tokenHash: string;
  kind: InviteKind;
  userId?: string; // reset
  note: string;
  createdAt: number;
  expiresAt: number;
  createdBy: string | null; // id do admin (null = token interno)
}

export class InviteStore {
  private recs: Invite[];
  constructor(private file: string) {
    this.recs = readJson<Invite[]>(file, []).filter((r) => r.expiresAt > clock.now());
  }
  private save() {
    writeJsonAtomic(this.file, this.recs);
  }
  private sweep() {
    const now = clock.now();
    const n = this.recs.length;
    this.recs = this.recs.filter((r) => r.expiresAt > now);
    if (n !== this.recs.length) this.save();
  }
  create(kind: InviteKind, p: { userId?: string; note?: string; createdBy: string | null }) {
    this.sweep();
    if (kind === "reset" && p.userId) this.removeResetsFor(p.userId); // só o link mais novo vale
    const token = crypto.randomBytes(32).toString("hex");
    const now = clock.now();
    const rec: Invite = {
      id: crypto.randomBytes(8).toString("hex"),
      tokenHash: sha256(token),
      kind,
      ...(p.userId && { userId: p.userId }),
      note: (p.note ?? "").slice(0, 200),
      createdAt: now,
      expiresAt: now + (kind === "invite" ? INVITE_TTL_MS : RESET_TTL_MS),
      createdBy: p.createdBy,
    };
    this.recs.push(rec);
    this.save();
    return { token, expiresAt: rec.expiresAt };
  }
  find(token: string): Invite | undefined {
    if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) return undefined;
    this.sweep();
    const h = sha256(token);
    return this.recs.find((r) => r.tokenHash === h);
  }
  // Uso único: apaga ao consumir (síncrono: duas aceitações simultâneas não passam as duas)
  consume(token: string): Invite | undefined {
    const r = this.find(token);
    if (!r) return undefined;
    this.recs = this.recs.filter((x) => x !== r);
    this.save();
    return r;
  }
  pending() {
    this.sweep();
    return this.recs.filter((r) => r.kind === "invite");
  }
  revoke(id: string) {
    const n = this.recs.length;
    this.recs = this.recs.filter((r) => !(r.id === id && r.kind === "invite"));
    if (n !== this.recs.length) this.save();
    return n !== this.recs.length;
  }
  removeResetsFor(userId: string) {
    const n = this.recs.length;
    this.recs = this.recs.filter((r) => !(r.kind === "reset" && r.userId === userId));
    if (n !== this.recs.length) this.save();
  }
}
