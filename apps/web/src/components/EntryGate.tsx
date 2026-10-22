"use client";

import React, { useEffect, useState } from "react";
import { LogOut } from "lucide-react";
import { apiFetch, getToken, setToken } from "@/lib/api";

export interface MaestriUser {
  id: string;
  name: string;
  color: string;
}

const USER_KEY = "maestri.user";
const COLORS = ["#6366f1", "#8b5cf6", "#ec4899", "#ef4444", "#f59e0b", "#10b981", "#06b6d4", "#3b82f6"];

const readUser = (): MaestriUser | null => {
  try {
    const u = JSON.parse(localStorage.getItem(USER_KEY) || "null");
    return u?.id && u?.name && u?.color ? u : null;
  } catch {
    return null;
  }
};

const saveUser = (user: MaestriUser) => {
  try {
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch {}
};

const screen = "flex h-screen w-screen items-center justify-center bg-[#080d1a] p-4 text-xs text-slate-100 font-sans";
const card = "w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-950 p-6 shadow-2xl space-y-4";
const input =
  "w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500";
const primaryBtn = "px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition";

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
    <div className="flex gap-2" role="radiogroup" aria-label="Cor">
      {COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={c}
          onClick={() => onChange(c)}
          className={`h-6 w-6 rounded-full border-2 transition ${
            value === c ? "border-white" : "border-transparent hover:border-slate-500"
          }`}
          style={{ background: c }}
        />
      ))}
    </div>
  );
}

function ProfileForm({
  initial,
  submitLabel,
  onSubmit,
}: {
  initial?: MaestriUser;
  submitLabel: string;
  onSubmit: (user: MaestriUser) => void;
}) {
  const [name, setName] = useState(initial?.name || "");
  const [color, setColor] = useState(initial?.color || COLORS[0]);

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        onSubmit({ id: initial?.id || crypto.randomUUID(), name: name.trim(), color });
      }}
    >
      <div>
        <label className="block text-xs font-medium text-slate-300 mb-1">Nome</label>
        <input
          type="text"
          required
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Como os outros vão te ver"
          className={input}
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-slate-300 mb-2">Cor</label>
        <ColorPicker value={color} onChange={setColor} />
      </div>
      <button type="submit" className={primaryBtn}>
        {submitLabel}
      </button>
    </form>
  );
}

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

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center rounded-full hover:ring-2 hover:ring-indigo-500 transition"
        title={user.name}
        aria-label="Perfil"
      >
        <Avatar user={user} />
      </button>
      {open && (
        <div className="absolute right-0 top-10 w-64 rounded-xl border border-slate-800 bg-slate-950 p-4 shadow-2xl z-50 space-y-4">
          <ProfileForm
            initial={user}
            submitLabel="Salvar"
            onSubmit={(u) => {
              onChange(u);
              setOpen(false);
            }}
          />
          <button
            onClick={onLogout}
            className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white transition"
          >
            <LogOut className="h-3.5 w-3.5" />
            Sair
          </button>
        </div>
      )}
    </div>
  );
}

type Phase = "checking" | "offline" | "token" | "ready";

export default function EntryGate({
  children,
}: {
  children: (session: { user: MaestriUser; setUser: (u: MaestriUser) => void; logout: () => void }) => React.ReactNode;
}) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [user, setUser] = useState<MaestriUser | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  const [tokenError, setTokenError] = useState("");

  const check = async () => {
    setPhase("checking");
    try {
      const health = await (await apiFetch("/api/health")).json().catch(() => ({}));
      if (!health.authRequired) return setPhase("ready");
      if (getToken() && (await apiFetch("/api/projects")).status !== 401) return setPhase("ready");
      setPhase("token");
    } catch {
      setPhase("offline");
    }
  };

  useEffect(() => {
    setUser(readUser());
    check();
  }, []);

  const handleToken = async (e: React.FormEvent) => {
    e.preventDefault();
    setToken(tokenInput.trim());
    setTokenError("");
    try {
      const res = await apiFetch("/api/projects");
      if (res.status === 401) {
        setToken("");
        setTokenError("Token inválido");
      } else {
        setPhase("ready");
      }
    } catch {
      setTokenError("Servidor indisponível");
    }
  };

  const updateUser = (u: MaestriUser) => {
    saveUser(u);
    setUser(u);
  };

  const logout = () => {
    setToken("");
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

  if (phase === "token") {
    return (
      <div className={screen}>
        <form onSubmit={handleToken} className={card}>
          <h1 className="text-sm font-semibold text-white">Acesso protegido</h1>
          <p className="text-slate-400">Informe o token de acesso deste Maestri Web.</p>
          <input
            type="password"
            required
            autoFocus
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder="Token"
            className={input}
          />
          {tokenError && (
            <p role="alert" className="text-rose-300">
              {tokenError}
            </p>
          )}
          <button type="submit" className={primaryBtn}>
            Entrar
          </button>
        </form>
      </div>
    );
  }

  if (!user) {
    return (
      <div className={screen}>
        <div className={card}>
          <h1 className="text-sm font-semibold text-white">Quem é você?</h1>
          <ProfileForm submitLabel="Continuar" onSubmit={updateUser} />
        </div>
      </div>
    );
  }

  return <>{children({ user, setUser: updateUser, logout })}</>;
}
