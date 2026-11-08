"use client";

import React from "react";
import { Check, Circle } from "lucide-react";
import { passwordRules, passwordStrength } from "@/lib/password";

export const inputCls =
  "w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500";

const LEVELS = [
  { label: "Muito fraca", bar: "bg-rose-500" },
  { label: "Fraca", bar: "bg-rose-500" },
  { label: "Razoável", bar: "bg-amber-400" },
  { label: "Boa", bar: "bg-emerald-500" },
  { label: "Forte", bar: "bg-emerald-400" },
];

// Campo de nova senha + confirmação com checklist e barra de força ao vivo
export function NewPasswordFields({
  password,
  onPassword,
  confirm,
  onConfirm,
  ctx,
}: {
  password: string;
  onPassword: (v: string) => void;
  confirm: string;
  onConfirm: (v: string) => void;
  ctx: { name?: string; email?: string };
}) {
  const rules = passwordRules(password, ctx);
  const s = passwordStrength(password, ctx);
  const mismatch = confirm.length > 0 && confirm !== password;
  return (
    <>
      <div>
        <label className="mb-1 block text-xs font-medium text-slate-300">Senha</label>
        <input type="password" required autoComplete="new-password" maxLength={200} value={password} onChange={(e) => onPassword(e.target.value)} className={inputCls} />
        <div className="mt-2 flex items-center gap-2">
          <div className="flex h-1.5 flex-1 gap-1" aria-hidden>
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className={`flex-1 rounded-full ${password && i < s ? LEVELS[s].bar : "bg-slate-800"}`} />
            ))}
          </div>
          <span className="w-16 text-right text-[10px] text-slate-400" aria-live="polite">{password ? LEVELS[s].label : ""}</span>
        </div>
        <ul className="mt-2 space-y-1" aria-label="Requisitos da senha">
          {rules.map((r) => (
            <li key={r.id} className={`flex items-center gap-1.5 text-[11px] ${r.ok ? "text-emerald-400" : "text-slate-500"}`}>
              {r.ok ? <Check className="h-3 w-3" /> : <Circle className="h-3 w-3" />}
              {r.label}
            </li>
          ))}
        </ul>
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-slate-300">Confirmar senha</label>
        <input type="password" required autoComplete="new-password" maxLength={200} value={confirm} onChange={(e) => onConfirm(e.target.value)} className={inputCls} />
        {mismatch && <p className="mt-1 text-[11px] text-rose-300">As senhas não coincidem</p>}
      </div>
    </>
  );
}
