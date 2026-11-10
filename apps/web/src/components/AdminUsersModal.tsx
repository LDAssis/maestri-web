"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, FolderGit2, KeyRound, Bot, Link2, Loader2, Plus, ShieldCheck, Trash2, UserCheck, UserX, Users, X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { Avatar, errorOf, type MaestriUser } from "./EntryGate";
import { inputCls } from "./PasswordField";

interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: "admin" | "user";
  disabled: boolean;
  createdAt: string;
  lastLoginAt?: string | null;
  color: string;
}
interface PendingInvite {
  id: string;
  note?: string;
  createdAt: string;
  expiresAt: string | number;
  createdBy?: string;
}

const fmt = (d?: string | number | null) =>
  d ? new Date(d).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";

const json = (body: unknown): RequestInit => ({
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

function CopyBox({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <input readOnly value={value} onFocus={(e) => e.currentTarget.select()} aria-label="Link" className={`${inputCls} font-mono`} />
      <button
        type="button"
        onClick={async () => {
          if (await copyText(value)) {
            setDone(true);
            setTimeout(() => setDone(false), 2000);
          }
        }}
        className="flex shrink-0 items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-medium text-white hover:bg-indigo-500"
      >
        {done ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        {done ? "Copiado" : "Copiar"}
      </button>
    </div>
  );
}

const iconBtn = "rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-800 hover:text-white disabled:opacity-30";
const textBtn = "flex items-center gap-1 rounded-lg px-2 py-1.5 text-[11px] text-slate-300 transition hover:bg-slate-800 hover:text-white disabled:opacity-30";


interface ProjAccess {
  id: string;
  name: string;
  access: "owner" | "member" | "admin";
}

// Projetos em que o usuário é membro (o dono aparece marcado e travado)
function UserProjectsPanel({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const [all, setAll] = useState<{ id: string; name: string }[] | null>(null);
  const [owned, setOwned] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([apiFetch("/api/projects"), apiFetch(`/api/admin/users/${user.id}/projects`)])
      .then(async ([a, b]) => {
        if (!a.ok || !b.ok) throw new Error(await errorOf(a.ok ? b : a, "Não foi possível carregar os projetos"));
        const list: { id: string; name: string }[] = await a.json();
        const mine: ProjAccess[] = (await b.json()).projects ?? [];
        setOwned(new Set(mine.filter((p) => p.access === "owner").map((p) => p.id)));
        setSel(new Set(mine.filter((p) => p.access === "member").map((p) => p.id)));
        setAll(list);
      })
      .catch((e) => setError(e?.message || "Servidor indisponível"));
  }, [user.id]);

  const toggle = (id: string) => {
    setSaved(false);
    setSel((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  const save = async () => {
    setBusy(true);
    setError("");
    const res = await apiFetch(`/api/admin/users/${user.id}/projects`, { method: "PUT", ...json({ projectIds: Array.from(sel) }) }).catch(() => null);
    setBusy(false);
    if (res?.ok) setSaved(true);
    else setError(await errorOf(res, "Não foi possível salvar"));
  };

  return (
    <div className="space-y-2 rounded-xl border border-slate-800 bg-slate-900/60 p-3">
      <div className="flex items-start justify-between gap-2 text-xs text-slate-200">
        <span>
          Projetos de <strong>{user.name}</strong>
          {user.role === "admin" && <span className="text-slate-500"> (administrador vê todos os projetos)</span>}
        </span>
        <button onClick={onClose} aria-label="Fechar" className="text-slate-400 hover:text-white">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-rose-300">
          {error}
        </p>
      )}
      {!all ? (
        !error && <Loader2 className="h-4 w-4 animate-spin text-slate-500" />
      ) : all.length === 0 ? (
        <p className="text-xs text-slate-500">Nenhum projeto</p>
      ) : (
        <ul className="max-h-56 divide-y divide-slate-800 overflow-y-auto rounded-lg border border-slate-800">
          {all.map((p) => {
            const isOwner = owned.has(p.id);
            return (
              <li key={p.id}>
                <label className={`flex items-center gap-2.5 px-3 py-2 text-xs ${isOwner ? "text-slate-500" : "cursor-pointer text-slate-200 hover:bg-slate-900"}`}>
                  <input type="checkbox" checked={isOwner || sel.has(p.id)} disabled={isOwner} onChange={() => toggle(p.id)} className="accent-indigo-500" />
                  <span className="flex-1 truncate">{p.name}</span>
                  {isOwner && <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">dono</span>}
                </label>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex items-center gap-3">
        <button onClick={save} disabled={busy || !all} className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-40">
          Salvar projetos
        </button>
        {saved && <span className="text-[11px] text-emerald-400">Salvo</span>}
      </div>
    </div>
  );
}
interface GrantAccount {
  program: "claude" | "codex";
  name: string;
  granted: boolean;
}

// Contas de assinatura (claude/codex) liberadas para o usuário; admin tem todas
function UserAccountsPanel({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const [all, setAll] = useState<GrantAccount[] | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const key = (a: { program: string; name: string }) => `${a.program}/${a.name}`;
  const isAdmin = user.role === "admin";

  useEffect(() => {
    apiFetch(`/api/admin/users/${user.id}/accounts`)
      .then(async (res) => {
        if (!res.ok) throw new Error(await errorOf(res, "Não foi possível carregar as contas"));
        const list: GrantAccount[] = (await res.json()).accounts ?? [];
        setSel(new Set(list.filter((a) => a.granted).map(key)));
        setAll(list);
      })
      .catch((e) => setError(e?.message || "Servidor indisponível"));
  }, [user.id]);

  const toggle = (k: string) => {
    setSaved(false);
    setSel((s) => {
      const n = new Set(s);
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });
  };

  const save = async () => {
    if (!all) return;
    setBusy(true);
    setError("");
    const grants = all.filter((a) => sel.has(key(a))).map((a) => ({ program: a.program, name: a.name }));
    const res = await apiFetch(`/api/admin/users/${user.id}/accounts`, { method: "PUT", ...json({ grants }) }).catch(() => null);
    setBusy(false);
    if (res?.ok) setSaved(true);
    else setError(await errorOf(res, "Não foi possível salvar"));
  };

  return (
    <div className="space-y-2 rounded-xl border border-slate-800 bg-slate-900/60 p-3">
      <div className="flex items-start justify-between gap-2 text-xs text-slate-200">
        <span>
          Contas de assinatura de <strong>{user.name}</strong>
          {isAdmin && <span className="text-slate-500"> (administrador usa todas)</span>}
        </span>
        <button onClick={onClose} aria-label="Fechar" className="text-slate-400 hover:text-white">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <p className="text-[11px] text-slate-500">
        Os projetos dessa pessoa só podem usar as contas marcadas. Ao retirar uma conta, os terminais que a usam são reiniciados.
      </p>
      {error && (
        <p role="alert" className="text-xs text-rose-300">
          {error}
        </p>
      )}
      {!all ? (
        !error && <Loader2 className="h-4 w-4 animate-spin text-slate-500" />
      ) : all.length === 0 ? (
        <p className="text-xs text-slate-500">Nenhuma conta cadastrada</p>
      ) : (
        <ul className="max-h-56 divide-y divide-slate-800 overflow-y-auto rounded-lg border border-slate-800">
          {all.map((a) => {
            const k = key(a);
            return (
              <li key={k}>
                <label className={`flex items-center gap-2.5 px-3 py-2 text-xs ${isAdmin ? "text-slate-500" : "cursor-pointer text-slate-200 hover:bg-slate-900"}`}>
                  <input type="checkbox" checked={isAdmin || sel.has(k)} disabled={isAdmin} onChange={() => toggle(k)} className="accent-indigo-500" />
                  <span className="rounded bg-slate-800 px-1.5 text-[10px] text-slate-300">{a.program}</span>
                  <span className="flex-1 truncate">{a.name}</span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex items-center gap-3">
        <button onClick={save} disabled={busy || !all || isAdmin} className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-40">
          Salvar contas
        </button>
        {saved && <span className="text-[11px] text-emerald-400">Salvo</span>}
      </div>
    </div>
  );
}
function UsersTab({ me }: { me: MaestriUser }) {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState("");
  const [link, setLink] = useState<{ user: AdminUser; url: string; expiresAt: string | number } | null>(null);
  const [del, setDel] = useState<AdminUser | null>(null);
  const [typed, setTyped] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [projUser, setProjUser] = useState<AdminUser | null>(null);
  const [accUser, setAccUser] = useState<AdminUser | null>(null);

  const load = useCallback(async () => {
    const res = await apiFetch("/api/admin/users").catch(() => null);
    if (res?.ok) setUsers((await res.json()).users ?? []);
    else setError(await errorOf(res, "Não foi possível carregar os usuários"));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const patch = async (u: AdminUser, body: Partial<Pick<AdminUser, "disabled" | "role">>) => {
    setBusyId(u.id);
    setError("");
    const res = await apiFetch(`/api/admin/users/${u.id}`, { method: "PATCH", ...json(body) }).catch(() => null);
    setBusyId(null);
    if (!res?.ok) setError(await errorOf(res, "Não foi possível atualizar"));
    load();
  };

  const resetLink = async (u: AdminUser) => {
    setBusyId(u.id);
    setError("");
    const res = await apiFetch(`/api/admin/users/${u.id}/reset-link`, { method: "POST" }).catch(() => null);
    setBusyId(null);
    if (res?.ok) {
      const b = await res.json();
      setLink({ user: u, url: `${location.origin}/convite/${b.token}`, expiresAt: b.expiresAt });
    } else setError(await errorOf(res, "Não foi possível gerar o link"));
  };

  const remove = async () => {
    if (!del) return;
    setBusyId(del.id);
    const res = await apiFetch(`/api/admin/users/${del.id}`, { method: "DELETE" }).catch(() => null);
    setBusyId(null);
    if (res?.ok) {
      setDel(null);
      setTyped("");
    } else setError(await errorOf(res, "Não foi possível excluir"));
    load();
  };

  if (!users) return <div className="p-6 text-xs text-slate-500">{error || <Loader2 className="h-4 w-4 animate-spin" />}</div>;

  return (
    <div className="space-y-3 p-4">
      {error && (
        <p role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
          {error}
        </p>
      )}
      {link && (
        <div className="space-y-2 rounded-xl border border-indigo-500/30 bg-indigo-500/10 p-3">
          <div className="flex items-start justify-between gap-2 text-xs text-slate-200">
            <span>
              Link de redefinição para <strong>{link.user.name}</strong>. Vale 1 uso e expira em {fmt(link.expiresAt)}.
            </span>
            <button onClick={() => setLink(null)} aria-label="Fechar" className="text-slate-400 hover:text-white">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <CopyBox value={link.url} />
        </div>
      )}
      {projUser && <UserProjectsPanel key={projUser.id} user={projUser} onClose={() => setProjUser(null)} />}
      {accUser && <UserAccountsPanel key={accUser.id} user={accUser} onClose={() => setAccUser(null)} />}
      <div className="overflow-x-auto rounded-xl border border-slate-800">
        <table className="w-full min-w-[640px] text-left text-xs">
          <thead className="bg-slate-900 text-[11px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2 font-medium">Usuário</th>
              <th className="px-3 py-2 font-medium">Papel</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Último login</th>
              <th className="px-3 py-2 text-right font-medium">Ações</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {users.map((u) => {
              const self = u.id === me.id;
              const busy = busyId === u.id;
              return (
                <tr key={u.id} className={u.disabled ? "opacity-60" : ""}>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2.5">
                      <Avatar user={u} size={30} />
                      <div className="min-w-0">
                        <div className="truncate font-medium text-slate-100">
                          {u.name}
                          {self && <span className="ml-1.5 text-[10px] text-slate-500">(você)</span>}
                        </div>
                        <div className="truncate text-[11px] text-slate-500">{u.email}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] ${u.role === "admin" ? "bg-indigo-500/15 text-indigo-300" : "bg-slate-800 text-slate-400"}`}>
                      {u.role === "admin" && <ShieldCheck className="h-3 w-3" />}
                      {u.role === "admin" ? "Administrador" : "Usuário"}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex items-center gap-1.5 text-[11px] ${u.disabled ? "text-amber-300" : "text-emerald-400"}`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${u.disabled ? "bg-amber-400" : "bg-emerald-500"}`} />
                      {u.disabled ? "Desativado" : "Ativo"}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-slate-400">{fmt(u.lastLoginAt)}</td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-0.5">
                      <button
                        className={iconBtn}
                        disabled={busy || self}
                        onClick={() => patch(u, { role: u.role === "admin" ? "user" : "admin" })}
                        title={u.role === "admin" ? "Rebaixar para usuário" : "Promover a administrador"}
                        aria-label={u.role === "admin" ? `Rebaixar ${u.name}` : `Promover ${u.name}`}
                      >
                        <ShieldCheck className="h-4 w-4" />
                      </button>
                      <button
                        className={iconBtn}
                        disabled={busy || self}
                        onClick={() => patch(u, { disabled: !u.disabled })}
                        title={u.disabled ? "Reativar" : "Desativar"}
                        aria-label={u.disabled ? `Reativar ${u.name}` : `Desativar ${u.name}`}
                      >
                        {u.disabled ? <UserCheck className="h-4 w-4" /> : <UserX className="h-4 w-4" />}
                      </button>
                      <button className={textBtn} onClick={() => { setAccUser(null); setProjUser(u); }} title="Projetos em que a pessoa é membro" aria-label={`Projetos de ${u.name}`}>
                        <FolderGit2 className="h-4 w-4" />
                        Projetos
                      </button>
                      <button className={textBtn} onClick={() => { setProjUser(null); setAccUser(u); }} title="Contas de assinatura (claude/codex) liberadas" aria-label={`Contas de assinatura de ${u.name}`}>
                        <Bot className="h-4 w-4" />
                        Contas
                      </button>
                      <button className={iconBtn} disabled={busy} onClick={() => resetLink(u)} title="Gerar link de redefinição de senha" aria-label={`Redefinir senha de ${u.name}`}>
                        <KeyRound className="h-4 w-4" />
                      </button>
                      <button
                        className={`${iconBtn} hover:!text-rose-300`}
                        disabled={busy || self}
                        onClick={() => {
                          setDel(u);
                          setTyped("");
                        }}
                        title="Excluir"
                        aria-label={`Excluir ${u.name}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {del && (
        <div className="space-y-2 rounded-xl border border-rose-500/30 bg-rose-500/10 p-3">
          <p className="text-xs text-slate-200">
            Excluir <strong>{del.name}</strong> apaga a conta e encerra as sessões. Para confirmar, digite o e-mail <span className="font-mono text-rose-300">{del.email}</span>.
          </p>
          <div className="flex gap-2">
            <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={del.email} aria-label="Confirmar e-mail" className={inputCls} />
            <button
              onClick={remove}
              disabled={typed.trim().toLowerCase() !== del.email.toLowerCase() || busyId === del.id}
              className="shrink-0 rounded-lg bg-rose-600 px-3 py-2 text-xs font-medium text-white hover:bg-rose-500 disabled:opacity-40"
            >
              Excluir
            </button>
            <button onClick={() => setDel(null)} className="shrink-0 px-2 text-xs text-slate-400 hover:text-white">
              Cancelar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function InvitesTab() {
  const [invites, setInvites] = useState<PendingInvite[] | null>(null);
  const [note, setNote] = useState("");
  const [created, setCreated] = useState<{ url: string; expiresAt: string | number } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await apiFetch("/api/admin/invites").catch(() => null);
    if (res?.ok) setInvites((await res.json()).invites ?? []);
    else setError(await errorOf(res, "Não foi possível carregar os convites"));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const create = async () => {
    setBusy(true);
    setError("");
    const res = await apiFetch("/api/admin/invites", { method: "POST", ...json(note.trim() ? { note: note.trim() } : {}) }).catch(() => null);
    setBusy(false);
    if (res?.ok) {
      const b = await res.json();
      setCreated({ url: `${location.origin}/convite/${b.token}`, expiresAt: b.expiresAt });
      setNote("");
      load();
    } else setError(await errorOf(res, "Não foi possível gerar o convite"));
  };

  const revoke = async (id: string) => {
    const res = await apiFetch(`/api/admin/invites/${id}`, { method: "DELETE" }).catch(() => null);
    if (!res?.ok) setError(await errorOf(res, "Não foi possível revogar"));
    load();
  };

  return (
    <div className="space-y-4 p-4">
      <div className="space-y-2 rounded-xl border border-slate-800 bg-slate-900/60 p-3">
        <label className="block text-xs font-medium text-slate-300" htmlFor="invite-note">
          Anotação (opcional)
        </label>
        <div className="flex gap-2">
          <input id="invite-note" value={note} maxLength={120} onChange={(e) => setNote(e.target.value)} placeholder="Ex.: para a Maria (design)" className={inputCls} />
          <button onClick={create} disabled={busy} className="flex shrink-0 items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-40">
            <Plus className="h-3.5 w-3.5" />
            Gerar link de convite
          </button>
        </div>
        {created && (
          <div className="space-y-2 pt-1">
            <CopyBox value={created.url} />
            <p className="text-[11px] text-amber-300">Vale 1 uso, expira em 7 dias ({fmt(created.expiresAt)}). Copie agora: o link não é mostrado de novo.</p>
          </div>
        )}
      </div>
      {error && (
        <p role="alert" className="text-xs text-rose-300">
          {error}
        </p>
      )}
      <div>
        <h3 className="mb-2 text-xs font-semibold text-slate-300">Convites pendentes</h3>
        {!invites ? (
          <Loader2 className="h-4 w-4 animate-spin text-slate-500" />
        ) : invites.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-800 p-6 text-center text-xs text-slate-500">Nenhum convite pendente</p>
        ) : (
          <ul className="divide-y divide-slate-800 rounded-xl border border-slate-800">
            {invites.map((i) => (
              <li key={i.id} className="flex items-center gap-3 px-3 py-2.5">
                <Link2 className="h-4 w-4 shrink-0 text-slate-500" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs text-slate-100">{i.note || "Sem anotação"}</div>
                  <div className="text-[11px] text-slate-500">
                    Criado em {fmt(i.createdAt)} · expira em {fmt(i.expiresAt)}
                  </div>
                </div>
                <button onClick={() => revoke(i.id)} className="rounded-lg px-2.5 py-1 text-xs text-rose-300 hover:bg-rose-500/10">
                  Revogar
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export default function AdminUsersModal({ isOpen, onClose, me }: { isOpen: boolean; onClose: () => void; me: MaestriUser }) {
  const [tab, setTab] = useState<"users" | "invites">("users");
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    dialogRef.current?.focus();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const tabCls = (t: string) =>
    `border-b-2 px-4 py-2 text-xs font-medium transition ${tab === t ? "border-indigo-500 text-white" : "border-transparent text-slate-500 hover:text-slate-300"}`;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 p-3 backdrop-blur-sm sm:p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-users-title"
        className="flex max-h-[85vh] min-h-[420px] w-full max-w-[900px] flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 font-sans text-slate-100 shadow-2xl focus:outline-none"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-slate-800 px-5 py-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600/20 text-indigo-300">
              <Users className="h-4 w-4" />
            </span>
            <div>
              <h2 id="admin-users-title" className="text-sm font-semibold text-white">
                Usuários e acessos
              </h2>
              <p className="text-[11px] text-slate-500">Gerencie contas e convide pessoas</p>
            </div>
          </div>
          <button onClick={onClose} aria-label="Fechar" className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex shrink-0 border-b border-slate-800 px-3" role="tablist">
          <button role="tab" aria-selected={tab === "users"} className={tabCls("users")} onClick={() => setTab("users")}>
            Usuários
          </button>
          <button role="tab" aria-selected={tab === "invites"} className={tabCls("invites")} onClick={() => setTab("invites")}>
            Convites
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto" role="tabpanel">
          {tab === "users" ? <UsersTab me={me} /> : <InvitesTab />}
        </div>
      </div>
    </div>
  );
}
