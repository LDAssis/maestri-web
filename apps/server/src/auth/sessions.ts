import crypto from "node:crypto";
import { clock } from "./clock.js";
import { readJson, writeJsonAtomic } from "./store.js";

export const SESSION_TTL_MS = 30 * 24 * 3600_000;
const WRITE_EVERY_MS = 60_000;
export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

interface Rec {
  id: string; // sha256 do token
  userId: string;
  createdAt: number;
  expiresAt: number;
}

export class SessionStore {
  private recs: Rec[];
  private lastWrite = new Map<string, number>();
  constructor(private file: string) {
    this.recs = readJson<Rec[]>(file, []).filter((r) => r.expiresAt > clock.now());
  }
  private save() {
    writeJsonAtomic(this.file, this.recs);
  }
  create(userId: string): string {
    const token = crypto.randomBytes(32).toString("hex");
    const now = clock.now();
    this.recs = this.recs.filter((r) => r.expiresAt > now);
    this.recs.push({ id: sha256(token), userId, createdAt: now, expiresAt: now + SESSION_TTL_MS });
    this.lastWrite.set(sha256(token), now);
    this.save();
    return token;
  }
  // Devolve { userId, sessionId } e renova (sliding); no máximo 1 escrita por minuto por sessão
  touch(token: string): { userId: string; sessionId: string } | null {
    if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) return null;
    const id = sha256(token);
    const r = this.recs.find((x) => x.id === id);
    if (!r) return null;
    const now = clock.now();
    if (r.expiresAt <= now) {
      this.recs = this.recs.filter((x) => x !== r);
      this.lastWrite.delete(id);
      this.save();
      return null;
    }
    r.expiresAt = now + SESSION_TTL_MS;
    if (now - (this.lastWrite.get(id) ?? 0) >= WRITE_EVERY_MS) {
      this.lastWrite.set(id, now);
      this.save();
    }
    return { userId: r.userId, sessionId: id };
  }
  remove(sessionId: string) {
    const n = this.recs.length;
    this.recs = this.recs.filter((r) => r.id !== sessionId);
    this.lastWrite.delete(sessionId);
    if (n !== this.recs.length) this.save();
  }
  // Derruba as sessões do usuário (exceto `keep`); devolve os ids derrubados
  removeForUser(userId: string, keep?: string): string[] {
    const gone = this.recs.filter((r) => r.userId === userId && r.id !== keep).map((r) => r.id);
    if (gone.length) {
      this.recs = this.recs.filter((r) => !gone.includes(r.id));
      gone.forEach((g) => this.lastWrite.delete(g));
      this.save();
    }
    return gone;
  }
  expiryOf(sessionId: string) {
    return this.recs.find((r) => r.id === sessionId)?.expiresAt;
  }
}
