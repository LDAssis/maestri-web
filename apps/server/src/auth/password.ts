import crypto from "node:crypto";

const N = 2 ** 15;
const R = 8;
const P = 1;
const KEYLEN = 64;
export const PASSWORD_MAX = 200;
export const PASSWORD_MIN = 12;

const scrypt = (pw: string, salt: Buffer, n: number, r: number, p: number, keylen: number) =>
  new Promise<Buffer>((resolve, reject) =>
    crypto.scrypt(pw, salt, keylen, { N: n, r, p, maxmem: 128 * n * r * 2 + 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))),
  );

// "scrypt$N$r$p$salt$hash" (base64)
export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(pw, salt, N, R, P, KEYLEN);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [n, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (![n, r, p].every((x) => Number.isInteger(x) && x > 0) || n > 2 ** 20 || r > 32 || p > 16) return false;
  try {
    const salt = Buffer.from(parts[4], "base64");
    const want = Buffer.from(parts[5], "base64");
    const got = await scrypt(pw, salt, n, r, p, want.length);
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

// Hash descartável: login de e-mail inexistente gasta o mesmo tempo que um de verdade
let dummy: Promise<string> | null = null;
export async function burnPasswordTime(pw: string) {
  dummy ??= hashPassword("dummy-password-for-timing");
  await verifyPassword(pw, await dummy);
}

const COMMON = new Set(
  [
    "password", "password1", "password123", "passw0rd", "senha123", "senha1234", "senha12345", "senhasenha", "123456789012",
    "1234567890123", "qwertyuiop12", "qwerty123456", "qwertyuiopas", "abc123456789", "admin1234567", "administrador",
    "letmein12345", "welcome12345", "iloveyou1234", "changeme1234", "mudar123456", "trocar123456", "brasil123456",
    "123456789abc", "abcdefghijkl", "aaaaaaaaaaaa", "111111111111", "000000000000", "maestri12345",
  ].map((s) => s.toLowerCase()),
);

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// Lista de falhas (vazia = senha aceita). Mensagens em pt-BR.
export function checkPassword(pw: unknown, who: { name?: string; email?: string } = {}): string[] {
  if (typeof pw !== "string") return ["Informe a senha."];
  const fails: string[] = [];
  if (pw.length < PASSWORD_MIN) fails.push(`A senha precisa ter pelo menos ${PASSWORD_MIN} caracteres.`);
  if (pw.length > PASSWORD_MAX) fails.push(`A senha pode ter no máximo ${PASSWORD_MAX} caracteres.`);
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(pw)).length;
  if (kinds < 3) fails.push("Use pelo menos 3 dos 4 tipos: minúscula, maiúscula, número e símbolo.");
  const low = fold(pw);
  const bits = new Set<string>();
  const name = fold((who.name ?? "").trim());
  if (name.length >= 4) bits.add(name);
  for (const w of name.split(/\s+/)) if (w.length >= 4) bits.add(w);
  const local = fold((who.email ?? "").split("@")[0].trim());
  if (local.length >= 4) bits.add(local);
  if ([...bits].some((b) => low.includes(b))) fails.push("A senha não pode conter seu nome nem a parte do e-mail antes do @.");
  if (COMMON.has(low)) fails.push("Essa senha é muito comum.");
  return fails;
}
