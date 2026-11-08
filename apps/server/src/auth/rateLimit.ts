import { clock } from "./clock.js";

// N tentativas por janela, por chave (IP ou e-mail). Memória do processo basta: reiniciar zera.
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private max = 10, private windowMs = 15 * 60_000) {}

  private recent(key: string) {
    const now = clock.now();
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  // true = pode tentar (e a tentativa é contada em todas as chaves); false = bloqueado (nada é contado)
  take(...keys: string[]): boolean {
    const lists = keys.map((k) => this.recent(k));
    if (lists.some((l) => l.length >= this.max)) return false;
    const now = clock.now();
    keys.forEach((k, i) => this.hits.set(k, [...lists[i], now]));
    return true;
  }

  clear(key: string) {
    this.hits.delete(key);
  }

  reset() {
    this.hits.clear();
  }
}
