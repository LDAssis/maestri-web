"use client";

import React, { useEffect, useState } from "react";
import { KeyRound, LogOut, ShieldCheck } from "lucide-react";
import { apiFetch, getToken, setToken } from "@/lib/api";
import { inputCls, NewPasswordFields } from "./PasswordField";
import { passwordOk } from "@/lib/password";

export interface MaestriUser {
  id: string;
  name: string;
  color: string;
  email?: string;
  role?: "admin" | "user";
}

const USER_KEY = "maestri.user";
const COLORS = ["#6366f1", "#8b5cf6", "#ec4899", "#ef4444", "#f59e0b", "#10b981", "#06b6d4", "#3b82f6"];

export const readUser = (): MaestriUser | null => {
  try {
    const u = JSON.parse(localStorage.getItem(USER_KEY) || "null");
    return u?.id && u?.name && u?.color ? u : null;
  } catch {
    return null;
  }
};

export const saveUser = (user: MaestriUser) => {
  try {
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch {}
};

// Guarda a sessão devolvida por login/setup/aceitar convite
export function startSession(token: string, user: MaestriUser) {
  setToken(token);
  saveUser(user);
}

export async function errorOf(res: Response | null, fallback: string) {
  if (!res) return "Servidor indisponível";
  const body = await res.json().catch(() => ({}));
  return body?.error || body?.message || fallback;
}

export const screen = "flex min-h-screen w-screen items-center justify-center bg-[#080d1a] p-4 text-xs text-slate-100 font-sans";
export const card = "w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-950 p-6 shadow-2xl space-y-4";
export const primaryBtn =
  "px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-indigo-600";

export function Avatar({ user, size = 28 }: { user: MaestriUser; size?: number }) {
  return (
    <span
      className="inline-flex items-center justify-center rounded-full font-semibold text-white uppercase shrink-0"
      style={{ background: user.color, width: size, height: size, fontSize: size * 0.45 }}
    >
      {user.name.trim().charAt(0)}
    </span>
  );
}

function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Cor">
      {COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={c}
          onClick={() => onChange(c)}
          className={`h-6 w-6 rounded-full border-2 transition ${value === c ? "border-white" : "border-transparent hover:border-slate-500"}`}
          style={{ background: c }}
        />
      ))}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-slate-300">{label}</label>
      {children}
    </div>
  );
}

const roleLabel = (r?: string) => (r === "admin" ? "Administrador" : "Usuário");

export function ProfileMenu({
  user,
  onChange,
  onLogout,
}: {
  user: MaestriUser;
  onChange: (user: MaestriUser) => void;
  onLogout: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(user.name);
  const [color, setColor] = useState(user.color);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pwOpen, setPwOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [open]);

  const toggle = () => {
    setOpen((o) => !o);
    setName(user.name);
    setColor(user.color);
    setMsg(null);
    setPwOpen(false);
  };

  const saveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    const res = await apiFetch("/api/auth/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), color }),
    }).catch(() => null);
    setBusy(false);
    if (res?.ok) {
      const body = await res.json().catch(() => ({}));
      onChange({ ...user, ...(body.user || { name: name.trim(), color }) });
      setMsg({ ok: true, text: "Perfil salvo" });
    } else setMsg({ ok: false, text: await errorOf(res, "Não foi possível salvar") });
  };

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const res = await apiFetch("/api/auth/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ current, password: pw }),
    }).catch(() => null);
    setBusy(false);
    if (res?.ok) {
      setMsg({ ok: true, text: "Senha alterada" });
      setPwOpen(false);
      setCurrent("");
      setPw("");
      setPw2("");
    } else setMsg({ ok: false, text: await errorOf(res, "Não foi possível alterar a senha") });
  };

  return (
    <div className="relative">
      <button
        onClick={toggle}
        aria-expanded={open}
        className="flex items-center rounded-full hover:ring-2 hover:ring-indigo-500 transition"
        title={user.name}
        aria-label="Perfil"
      >
        <Avatar user={user} />
      </button>
      {open && (
        <div role="dialog" aria-label="Perfil" className="absolute right-0 top-10 z-50 max-h-[80vh] w-72 space-y-4 overflow-y-auto rounded-xl border border-slate-800 bg-slate-950 p-4 shadow-2xl">
          <div className="flex items-center gap-3">
            <Avatar user={{ ...user, name, color }} size={40} />
            <div className="min-w-0">
              <div className="truncate text-xs font-semibold text-white">{user.name}</div>
              {user.email && <div className="truncate text-[11px] text-slate-400">{user.email}</div>}
              <span className="mt-0.5 inline-flex items-center gap-1 rounded-full bg-indigo-500/15 px-2 py-0.5 text-[10px] text-indigo-300">
                {user.role === "admin" && <ShieldCheck className="h-3 w-3" />}
                {roleLabel(user.role)}
              </span>
            </div>
          </div>
          <form className="space-y-3" onSubmit={saveProfile}>
            <Field label="Nome">
              <input type="text" required value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
            </Field>
            <Field label="Cor">
              <ColorPicker value={color} onChange={setColor} />
            </Field>
            <button type="submit" disabled={busy} className={primaryBtn}>
              Salvar
            </button>
          </form>
          <div className="border-t border-slate-800 pt-3">
            {pwOpen ? (
              <form className="space-y-3" onSubmit={changePassword}>
                <Field label="Senha atual">
                  <input type="password" required autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} className={inputCls} />
                </Field>
                <NewPasswordFields password={pw} onPassword={setPw} confirm={pw2} onConfirm={setPw2} ctx={user} />
                <div className="flex gap-2">
                  <button type="submit" disabled={busy || !current || !passwordOk(pw, user) || pw !== pw2} className={primaryBtn}>
                    Alterar senha
                  </button>
                  <button type="button" onClick={() => setPwOpen(false)} className="text-xs text-slate-400 hover:text-white">
                    Cancelar
                  </button>
                </div>
              </form>
            ) : (
              <button onClick={() => setPwOpen(true)} className="flex items-center gap-1.5 text-xs text-slate-300 hover:text-white transition">
                <KeyRound className="h-3.5 w-3.5" />
                Trocar senha
              </button>
            )}
          </div>
          {msg && (
            <p role={msg.ok ? "status" : "alert"} className={msg.ok ? "text-emerald-400" : "text-rose-300"}>
              {msg.text}
            </p>
          )}
          <button onClick={onLogout} className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white transition">
            <LogOut className="h-3.5 w-3.5" />
            Sair
          </button>
        </div>
      )}
    </div>
  );
}

type Phase = "checking" | "offline" | "setup" | "login" | "ready";

function SetupForm({ onDone }: { onDone: (token: string, user: MaestriUser) => void }) {
  const [setupKey, setSetupKey] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const ok = !!setupKey.trim() && !!name.trim() && !!email.trim() && passwordOk(pw, { name, email }) && pw === pw2;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ok) return;
    setBusy(true);
    setError("");
    const res = await apiFetch("/api/auth/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ setupKey: setupKey.trim(), name: name.trim(), email: email.trim(), password: pw }),
    }).catch(() => null);
    if (res?.ok) {
      const b = await res.json();
      onDone(b.token, b.user);
    } else {
      setError(await errorOf(res, "Não foi possível criar a conta"));
      setBusy(false);
    }
  };

  return (
    <div className={screen}>
      <form onSubmit={submit} className={`${card} !max-w-md`}>
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-600/20 text-indigo-300">
            <ShieldCheck className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-sm font-semibold text-white">Criar conta de administrador</h1>
            <p className="text-[11px] text-slate-500">Primeiro acesso a este Maestri Web</p>
          </div>
        </div>
        <Field label="Chave de configuração">
          <input type="password" required autoFocus autoComplete="off" value={setupKey} onChange={(e) => setSetupKey(e.target.value)} placeholder="MAESTRI_TOKEN do servidor" className={inputCls} />
        </Field>
        <Field label="Nome">
          <input type="text" required autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
        </Field>
        <Field label="E-mail">
          <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} />
        </Field>
        <NewPasswordFields password={pw} onPassword={setPw} confirm={pw2} onConfirm={setPw2} ctx={{ name, email }} />
        {error && (
          <p role="alert" className="text-rose-300">
            {error}
          </p>
        )}
        <button type="submit" disabled={!ok || busy} className={primaryBtn}>
          {busy ? "Criando..." : "Criar administrador"}
        </button>
      </form>
    </div>
  );
}

function LoginForm({ onDone }: { onDone: (token: string, user: MaestriUser) => void }) {
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await apiFetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim(), password: pw }),
    }).catch(() => null);
    if (res?.ok) {
      const b = await res.json();
      onDone(b.token, b.user);
    } else {
      setError(await errorOf(res, "E-mail ou senha incorretos"));
      setBusy(false);
    }
  };

  return (
    <div className={screen}>
      <form onSubmit={submit} className={card}>
        <h1 className="text-sm font-semibold text-white">Entrar no Maestri Web</h1>
        <Field label="E-mail">
          <input type="email" required autoFocus autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} />
        </Field>
        <Field label="Senha">
          <input type="password" required autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} className={inputCls} />
        </Field>
        {error && (
          <p role="alert" className="text-rose-300">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy} className={primaryBtn}>
          {busy ? "Entrando..." : "Entrar"}
        </button>
        <p className="text-[11px] text-slate-500">Sem conta? Peça um link de convite a um administrador.</p>
      </form>
    </div>
  );
}

export default function EntryGate({
  children,
}: {
  children: (session: { user: MaestriUser; setUser: (u: MaestriUser) => void; logout: () => void }) => React.ReactNode;
}) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [user, setUser] = useState<MaestriUser | null>(null);

  const check = async () => {
    setPhase("checking");
    try {
      const state = await (await apiFetch("/api/auth/state")).json().catch(() => ({}));
      if (state.setupRequired) return setPhase("setup");
      if (getToken()) {
        const res = await apiFetch("/api/auth/me");
        if (res.ok) {
          const b = await res.json().catch(() => ({}));
          if (b.user) {
            saveUser(b.user);
            setUser(b.user);
            return setPhase("ready");
          }
        }
        setToken("");
      }
      setPhase("login");
    } catch {
      setPhase("offline");
    }
  };

  useEffect(() => {
    check();
  }, []);

  const entered = (token: string, u: MaestriUser) => {
    startSession(token, u);
    setUser(u);
    setPhase("ready");
  };

  const updateUser = (u: MaestriUser) => {
    saveUser(u);
    setUser(u);
  };

  const logout = async () => {
    await apiFetch("/api/auth/logout", { method: "POST" }).catch(() => null);
    setToken("");
    try {
      localStorage.removeItem(USER_KEY);
    } catch {}
    location.reload();
  };

  if (phase === "checking") {
    return <div className={`${screen} font-mono text-slate-500`}>Conectando ao servidor...</div>;
  }

  if (phase === "offline") {
    return (
      <div role="alert" className={`${screen} flex-col gap-3`}>
        <p className="text-rose-300">Não foi possível conectar ao servidor.</p>
        <button onClick={check} className={primaryBtn}>
          Tentar novamente
        </button>
      </div>
    );
  }

  if (phase === "setup") return <SetupForm onDone={entered} />;
  if (phase === "login" || !user) return <LoginForm onDone={entered} />;

  return <>{children({ user, setUser: updateUser, logout })}</>;
}
