"use client";

import React, { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { UserPlus } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { passwordOk } from "@/lib/password";
import { inputCls, NewPasswordFields } from "@/components/PasswordField";
import { card, errorOf, primaryBtn, screen, startSession } from "@/components/EntryGate";

interface Invite {
  kind: "invite" | "reset";
  email?: string;
  expiresAt: string | number;
}

export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const [invite, setInvite] = useState<Invite | null>(null);
  const [state, setState] = useState<"loading" | "invalid" | "offline" | "ok">("loading");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiFetch(`/api/invites/${encodeURIComponent(token)}`)
      .then(async (res) => {
        if (!res.ok) return setState("invalid");
        const b = await res.json();
        setInvite(b);
        if (b.email) setEmail(b.email);
        setState("ok");
      })
      .catch(() => setState("offline"));
  }, [token]);

  if (state === "loading") return <div className={`${screen} font-mono text-slate-500`}>Verificando convite...</div>;
  if (state === "offline")
    return (
      <div role="alert" className={screen}>
        <p className="text-rose-300">Não foi possível conectar ao servidor.</p>
      </div>
    );
  if (state === "invalid" || !invite)
    return (
      <div className={screen}>
        <div className={`${card} text-center`} role="alert">
          <h1 className="text-sm font-semibold text-white">Link inválido ou expirado</h1>
          <p className="text-slate-400">Este link já foi usado, foi revogado ou passou da validade. Peça um novo a um administrador.</p>
          <a href="/" className={`${primaryBtn} inline-block`}>
            Ir para o login
          </a>
        </div>
      </div>
    );

  const reset = invite.kind === "reset";
  const ctx = { name, email };
  const ok = passwordOk(pw, ctx) && pw === pw2 && (reset || (!!name.trim() && !!email.trim()));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ok) return;
    setBusy(true);
    setError("");
    const res = await apiFetch(`/api/invites/${encodeURIComponent(token)}/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reset ? { password: pw } : { name: name.trim(), email: email.trim(), password: pw }),
    }).catch(() => null);
    if (res?.ok) {
      const b = await res.json();
      startSession(b.token, b.user);
      location.href = "/";
    } else {
      setError(await errorOf(res, "Não foi possível concluir"));
      setBusy(false);
    }
  };

  return (
    <div className={screen}>
      <form onSubmit={submit} className={`${card} !max-w-md`}>
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-600/20 text-indigo-300">
            <UserPlus className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-sm font-semibold text-white">{reset ? "Definir nova senha" : "Criar sua conta"}</h1>
            <p className="text-[11px] text-slate-500">{reset ? invite.email || "Redefinição de senha" : "Você foi convidado para o Maestri Web"}</p>
          </div>
        </div>
        {!reset && (
          <>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-300">Nome</label>
              <input type="text" required autoFocus autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-300">E-mail</label>
              <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} />
            </div>
          </>
        )}
        <NewPasswordFields password={pw} onPassword={setPw} confirm={pw2} onConfirm={setPw2} ctx={ctx} />
        {error && (
          <p role="alert" className="text-rose-300">
            {error}
          </p>
        )}
        <button type="submit" disabled={!ok || busy} className={primaryBtn}>
          {busy ? "Entrando..." : reset ? "Salvar e entrar" : "Criar conta e entrar"}
        </button>
      </form>
    </div>
  );
}
