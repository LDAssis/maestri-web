// Mesmas regras do servidor (apps/server/src/auth/password.ts); o servidor é a fonte da verdade
export interface PasswordRule {
  id: string;
  label: string;
  ok: boolean;
}

const COMMON = ["123456789012", "password1234", "senha1234567", "qwertyuiop12", "administrador"];

export function passwordRules(pw: string, ctx: { name?: string; email?: string } = {}): PasswordRule[] {
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  const low = pw.toLowerCase();
  const local = (ctx.email || "").split("@")[0].toLowerCase();
  const name = (ctx.name || "").trim().toLowerCase();
  const hasPersonal = (name.length >= 4 && low.includes(name)) || (local.length >= 4 && low.includes(local));
  return [
    { id: "len", label: "Pelo menos 12 caracteres", ok: pw.length >= 12 },
    { id: "kinds", label: "3 de 4 tipos: minúscula, maiúscula, número, símbolo", ok: kinds >= 3 },
    { id: "personal", label: "Não contém seu nome nem o início do e-mail", ok: pw.length > 0 && !hasPersonal },
    { id: "common", label: "Não é uma senha comum", ok: pw.length > 0 && !COMMON.includes(low) },
  ];
}

export const passwordOk = (pw: string, ctx?: { name?: string; email?: string }) =>
  pw.length <= 200 && passwordRules(pw, ctx).every((r) => r.ok);

// 0-4
export function passwordStrength(pw: string, ctx?: { name?: string; email?: string }): number {
  if (!pw) return 0;
  const rules = passwordRules(pw, ctx).filter((r) => r.ok).length;
  const bonus = pw.length >= 16 ? 1 : 0;
  return Math.min(4, Math.max(rules - 1, 0) + (rules === 4 ? bonus : 0));
}
