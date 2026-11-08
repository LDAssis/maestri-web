"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Crown, Loader2, LogOut, Search, UserMinus, UserPlus, Users, X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { Avatar, errorOf, type MaestriUser } from "./EntryGate";
import { inputCls } from "./PasswordField";
import { useConfirm } from "./ConfirmProvider";

interface U {
  id: string;
  name: string;
  email: string;
  color: string;
}

const jsonBody = (body: unknown): RequestInit => ({
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

function Person({ u, badge, children }: { u: U; badge?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <li className="flex items-center gap-3 px-3 py-2">
      <Avatar user={u} size={30} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 truncate text-xs font-medium text-slate-100">
          {u.name}
          {badge}
        </div>
        <div className="truncate text-[11px] text-slate-500">{u.email}</div>
      </div>
      {children}
    </li>
  );
}

const smallBtn =
  "flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-slate-300 transition hover:bg-slate-800 hover:text-white disabled:opacity-40";

// access: papel de quem abre ("owner" | "member" | "admin")
export default function ProjectMembersModal({
  projectId,
  projectName,
  access,
  me,
  onClose,
  onChanged,
  onLeft,
}: {
  projectId: string;
  projectName: string;
  access: "owner" | "member" | "admin";
  me: MaestriUser;
  onClose: () => void;
  onChanged: () => void;
  onLeft: () => void;
}) {
  const confirm = useConfirm();
  const [owner, setOwner] = useState<U | null>(null);
  const [members, setMembers] = useState<U[]>([]);
  const [directory, setDirectory] = useState<U[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const canManage = access === "owner" || access === "admin";

  const load = useCallback(async () => {
    const res = await apiFetch(`/api/projects/${projectId}/members`).catch(() => null);
    if (res?.ok) {
      const b = await res.json();
      setOwner(b.owner ?? null);
      setMembers(b.members ?? []);
      setError("");
    } else setError(await errorOf(res, "Não foi possível carregar os membros"));
    setLoading(false);
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!canManage) return;
    apiFetch("/api/users/directory")
      .then((r) => (r.ok ? r.json() : { users: [] }))
      .then((b) => setDirectory(b.users ?? []))
      .catch(() => {});
  }, [canManage]);

  useEffect(() => {
    dialogRef.current?.focus();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);

  const candidates = useMemo(() => {
    const taken = new Set([owner?.id, ...members.map((m) => m.id)]);
    const q = query.trim().toLowerCase();
    return directory
      .filter((u) => !taken.has(u.id) && (!q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)))
      .slice(0, 8);
  }, [directory, owner, members, query]);

  const run = async (fn: () => Promise<Response | null>, fallback: string, after?: (b: any) => void) => {
    setBusy(true);
    setError("");
    const res = await fn().catch(() => null);
    setBusy(false);
    if (res?.ok) {
      const b = await res.json().catch(() => ({}));
      if (b.owner) setOwner(b.owner);
      if (b.members) setMembers(b.members);
      after?.(b);
      onChanged();
    } else {
      setError(await errorOf(res, fallback));
      load();
    }
  };

  const add = (u: U) =>
    run(() => apiFetch(`/api/projects/${projectId}/members`, { method: "POST", ...jsonBody({ userId: u.id }) }), "Não foi possível adicionar", () => setQuery(""));

  const remove = (u: U) =>
    run(() => apiFetch(`/api/projects/${projectId}/members/${u.id}`, { method: "DELETE" }), "Não foi possível remover");

  const transfer = async (u: U) => {
    const ok = await confirm({
      title: "Transferir dono",
      message: `Transferir a propriedade de "${projectName}" para ${u.name}? ${owner ? `${owner.name} continua como membro.` : ""}`,
      confirmLabel: "Transferir",
      danger: true,
    });
    if (ok) run(() => apiFetch(`/api/projects/${projectId}/owner`, { method: "POST", ...jsonBody({ userId: u.id }) }), "Não foi possível transferir");
  };

  const leave = async () => {
    const ok = await confirm({
      title: "Sair do projeto",
      message: `Sair de "${projectName}"? Você perde o acesso até ser adicionado de novo.`,
      confirmLabel: "Sair do projeto",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    const res = await apiFetch(`/api/projects/${projectId}/members/${me.id}`, { method: "DELETE" }).catch(() => null);
    setBusy(false);
    if (res?.ok) onLeft();
    else setError(await errorOf(res, "Não foi possível sair do projeto"));
  };

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
        aria-labelledby="members-title"
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 font-sans text-xs text-slate-100 shadow-2xl focus:outline-none"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-slate-800 px-5 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-600/20 text-indigo-300">
              <Users className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <h2 id="members-title" className="text-sm font-semibold text-white">
                Membros
              </h2>
              <p className="truncate text-[11px] text-slate-500">{projectName}</p>
            </div>
          </div>
          <button onClick={onClose} aria-label="Fechar" className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {error && (
            <p role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-rose-300">
              {error}
            </p>
          )}
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin text-slate-500" />
          ) : (
            <>
              <div>
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Dono</h3>
                <ul className="rounded-xl border border-slate-800">
                  {owner && (
                    <Person
                      u={owner}
                      badge={
                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">
                          <Crown className="h-3 w-3" /> dono
                        </span>
                      }
                    />
                  )}
                </ul>
              </div>

              <div>
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Membros ({members.length})</h3>
                {members.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-slate-800 p-4 text-center text-slate-500">Só o dono tem acesso por enquanto</p>
                ) : (
                  <ul className="divide-y divide-slate-800 rounded-xl border border-slate-800">
                    {members.map((m) => (
                      <Person key={m.id} u={m} badge={m.id === me.id ? <span className="text-[10px] text-slate-500">(você)</span> : undefined}>
                        {canManage && (
                          <div className="flex shrink-0 gap-0.5">
                            <button disabled={busy} onClick={() => transfer(m)} className={smallBtn} title="Transferir dono" aria-label={`Transferir dono para ${m.name}`}>
                              <Crown className="h-3.5 w-3.5" /> Tornar dono
                            </button>
                            <button disabled={busy} onClick={() => remove(m)} className={`${smallBtn} hover:!text-rose-300`} title="Remover" aria-label={`Remover ${m.name}`}>
                              <UserMinus className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        )}
                      </Person>
                    ))}
                  </ul>
                )}
              </div>

              {canManage && (
                <div>
                  <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Adicionar membro</h3>
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
                    <input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Buscar por nome ou e-mail"
                      aria-label="Buscar usuário"
                      className={`${inputCls} !pl-8`}
                    />
                  </div>
                  {candidates.length === 0 ? (
                    <p className="mt-2 text-[11px] text-slate-500">{query ? "Nenhum usuário encontrado" : "Todos os usuários já têm acesso"}</p>
                  ) : (
                    <ul className="mt-2 divide-y divide-slate-800 rounded-xl border border-slate-800">
                      {candidates.map((u) => (
                        <Person key={u.id} u={u}>
                          <button disabled={busy} onClick={() => add(u)} className={`${smallBtn} !text-indigo-300`} aria-label={`Adicionar ${u.name}`}>
                            <UserPlus className="h-3.5 w-3.5" /> Adicionar
                          </button>
                        </Person>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {access === "member" && (
                <button
                  disabled={busy}
                  onClick={leave}
                  className="flex items-center gap-1.5 rounded-lg border border-rose-800 px-3 py-1.5 font-medium text-rose-300 transition hover:bg-rose-600 hover:text-white disabled:opacity-40"
                >
                  <LogOut className="h-3.5 w-3.5" /> Sair do projeto
                </button>
              )}
              {access === "admin" && <p className="text-[11px] text-slate-500">Você vê este projeto como administrador.</p>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
