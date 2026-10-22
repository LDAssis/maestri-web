"use client";

import React, { useEffect, useRef, useState } from "react";
import { AlertTriangle, Pencil, Plus, Trash2, X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { Role, useGlobalRoles, useRoles } from "@/lib/useRoles";

interface Draft {
  id?: string;
  name: string;
  color: string;
  prompt: string;
  scope: "project" | "global";
}

export default function RolesPanel({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const { roles: allProject, reload } = useRoles(projectId);
  const { globalRoles, reloadGlobal } = useGlobalRoles(projectId);
  const roles = allProject;
  const scopeOf = (id: string): "project" | "global" => (globalRoles.some((g) => g.id === id) ? "global" : "project");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    return () => {
      if (prev && document.contains(prev)) prev.focus();
    };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") return draft ? setDraft(null) : onClose();
    if (e.key !== "Tab") return;
    const f = Array.from(ref.current?.querySelectorAll<HTMLElement>("button, input, textarea") ?? []).filter((x) => !(x as any).disabled);
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) {
      e.preventDefault();
      f[f.length - 1].focus();
    } else if (!e.shiftKey && document.activeElement === f[f.length - 1]) {
      e.preventDefault();
      f[0].focus();
    }
  };

  const request = async (path: string, init: RequestInit, scope: "project" | "global" = "project") => {
    setBusy(true);
    setError("");
    try {
      const res = await apiFetch(scope === "global" ? `/api/global-roles${path}` : `/api/projects/${projectId}/roles${path}`, init);
      if (!res.ok) {
        setError((await res.json().catch(() => ({})))?.error || `Servidor respondeu ${res.status}`);
        return false;
      }
      await Promise.all([reload(), reloadGlobal()]);
      return true;
    } catch {
      setError("Servidor indisponível");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    if (!draft.name.trim() || draft.name.trim().length > 60) return setError("Nome: 1 a 60 caracteres.");
    if (draft.prompt.length > 20000) return setError("Prompt: no máximo 20000 caracteres.");
    const body = JSON.stringify({ name: draft.name.trim(), color: draft.color, prompt: draft.prompt });
    const ok = await request(
      draft.id ? `/${draft.id}` : "",
      { method: draft.id ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body },
      draft.scope,
    );
    if (ok) setDraft(null);
  };

  const field = "w-full bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-indigo-500";
  const edit = (r: Role) => {
    setError("");
    setDraft({ id: r.id, name: r.name, color: r.color, prompt: r.prompt, scope: scopeOf(r.id) });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onMouseDown={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="Roles do projeto"
        onKeyDown={onKeyDown}
        onMouseDown={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-2xl border border-slate-800 bg-slate-950 p-5 shadow-2xl"
      >
        <div className="mb-3 flex items-center justify-between border-b border-slate-800 pb-3">
          <h3 className="text-sm font-semibold text-white">Roles</h3>
          <div className="flex items-center gap-2">
            {!draft && (
              <button
                onClick={() => {
                  setError("");
                  setDraft({ name: "", color: "#6366F1", prompt: "", scope: "project" });
                }}
                className="flex items-center gap-1 rounded-md bg-indigo-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-indigo-500"
              >
                <Plus className="h-3 w-3" /> Novo role
              </button>
            )}
            <button onClick={onClose} aria-label="Fechar" className="text-slate-400 hover:text-white">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto space-y-2">
          {draft && (
            <form onSubmit={save} className="space-y-2 rounded-xl border border-slate-800 bg-slate-900/60 p-3">
              <div className="flex gap-2">
                <label className="flex-1 text-[11px] text-slate-300">
                  Nome
                  <input autoFocus value={draft.name} maxLength={60} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={`${field} mt-1`} />
                </label>
                <label className="text-[11px] text-slate-300">
                  Cor
                  <input type="color" value={draft.color.toLowerCase()} onChange={(e) => setDraft({ ...draft, color: e.target.value.toUpperCase() })} className="mt-1 block h-[30px] w-12 cursor-pointer rounded border border-slate-800 bg-slate-900" />
                </label>
              </div>
              {!draft.id && (
                <div role="radiogroup" aria-label="Escopo do role" className="flex items-center gap-3 text-[11px] text-slate-300">
                  {(["project", "global"] as const).map((sc) => (
                    <label key={sc} className="flex items-center gap-1">
                      <input type="radio" name="role-scope" checked={draft.scope === sc} onChange={() => setDraft({ ...draft, scope: sc })} />
                      {sc === "project" ? "Deste projeto" : "Global (todos os projetos)"}
                    </label>
                  ))}
                </div>
              )}
              <label className="block text-[11px] text-slate-300">
                Prompt
                <textarea value={draft.prompt} rows={6} maxLength={20000} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} className={`${field} mt-1 font-mono`} />
              </label>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setDraft(null)} className="rounded-md px-2 py-1 text-[11px] text-slate-400 hover:text-white">Cancelar</button>
                <button type="submit" disabled={busy} className="rounded-md bg-indigo-600 px-3 py-1 text-[11px] font-medium text-white hover:bg-indigo-500 disabled:opacity-40">Salvar</button>
              </div>
            </form>
          )}
          {error && (
            <div role="alert" className="flex items-center gap-1.5 text-[11px] text-amber-300">
              <AlertTriangle className="h-3 w-3 shrink-0" />
              {error}
            </div>
          )}
          {roles.length + globalRoles.length === 0 && !draft && <div className="py-6 text-center text-xs text-slate-500">Nenhum role. Roles definem o prompt inicial de um agente.</div>}
          {[...roles.map((r) => ({ r, global: false })), ...globalRoles.map((r) => ({ r, global: true }))].map(({ r, global }) => (
            <React.Fragment key={`${global ? "g" : "p"}-${r.id}`}>
            <div key={r.id} className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2 text-xs font-semibold text-slate-100">
                  <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: r.color }} aria-hidden />
                  <span className="truncate">{r.name}</span>
                  {global && <span className="shrink-0 rounded border border-indigo-700 bg-indigo-950 px-1 text-[9px] font-medium uppercase text-indigo-300">global</span>}
                </div>
                <div className="flex items-center gap-1">
                  <button onClick={() => edit(r)} aria-label={`Editar ${r.name}`} className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white">
                    <Pencil className="h-3 w-3" />
                  </button>
                  <button onClick={() => setConfirmDel(r.id)} aria-label={`Apagar ${r.name}`} className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-rose-400">
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              </div>
              {r.prompt && <p className="mt-1 line-clamp-2 text-[11px] text-slate-400">{r.prompt}</p>}
              {confirmDel === r.id && (
                <div className="mt-2 flex items-center gap-2 text-[11px] text-slate-300">
                  Apagar este role? Agentes já criados mantêm o prompt.
                  <button
                    onClick={async () => {
                      if (await request(`/${r.id}`, { method: "DELETE" }, global ? "global" : "project")) setConfirmDel(null);
                    }}
                    className="rounded-md bg-rose-600 px-2 py-1 font-medium text-white hover:bg-rose-500"
                  >
                    Confirmar
                  </button>
                  <button onClick={() => setConfirmDel(null)} className="text-slate-400 hover:text-white">Cancelar</button>
                </div>
              )}
            </div>
            </React.Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}
