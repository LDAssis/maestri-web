"use client";

import React, { useEffect, useRef, useState } from "react";
import { AlarmClock, AlertTriangle, Bot, FolderGit2, Globe, Layers, Loader2, StickyNote, Trash2, X } from "lucide-react";
import { apiFetch } from "@/lib/api";

interface DeleteInfo {
  name: string;
  repoPath: string;
  isLast: boolean;
  canDeleteFolder: boolean;
  folderReason?: string;
  counts: { agents: number; notes: number; portals: number; floors: number; routines: number; liveTerminals: number };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// Confirmação de exclusão de projeto: mostra o que será apagado e exige digitar o nome
export default function DeleteProjectModal({ projectId, projectName, onClose, onDeleted }: { projectId: string; projectName: string; onClose: () => void; onDeleted: () => void }) {
  const [info, setInfo] = useState<DeleteInfo | null>(null);
  const [loadError, setLoadError] = useState("");
  const [deleteFolder, setDeleteFolder] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const busyRef = useRef(false);
  busyRef.current = busy;

  useEffect(() => {
    let alive = true;
    apiFetch(`/api/projects/${projectId}/delete-info`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!alive) return;
        if (!res.ok) setLoadError(body?.error || `Servidor respondeu ${res.status}`);
        else setInfo(body);
      })
      .catch(() => alive && setLoadError("Servidor indisponível"));
    return () => {
      alive = false;
    };
  }, [projectId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busyRef.current) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const matches = typed.trim() === projectName.trim();
  const canConfirm = !!info && !info.isLast && matches && !busy;

  const confirm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canConfirm) return;
    setBusy(true);
    setError("");
    try {
      const res = await apiFetch(`/api/projects/${projectId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deleteFolder: deleteFolder && info!.canDeleteFolder }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body?.error || `Servidor respondeu ${res.status}`);
        setBusy(false);
        return;
      }
      if (body?.folderError) window.alert(`O projeto foi excluído, mas a pasta não pôde ser apagada: ${body.folderError}`);
      onDeleted();
    } catch {
      setError("Servidor indisponível");
      setBusy(false);
    }
  };

  const c = info?.counts;
  const rows: { icon: React.ReactNode; text: string }[] = c
    ? [
        { icon: <Bot className="h-3.5 w-3.5" />, text: `${plural(c.agents, "agente/terminal", "agentes/terminais")}${c.liveTerminals ? ` (${c.liveTerminals} em execução serão encerrados)` : ""}` },
        { icon: <StickyNote className="h-3.5 w-3.5" />, text: plural(c.notes, "nota", "notas") },
        { icon: <Layers className="h-3.5 w-3.5" />, text: plural(c.floors, "andar", "andares") },
        { icon: <AlarmClock className="h-3.5 w-3.5" />, text: plural(c.routines, "rotina", "rotinas") },
        { icon: <Globe className="h-3.5 w-3.5" />, text: plural(c.portals, "portal", "portais") },
      ].filter((r) => !r.text.startsWith("0 "))
    : [];

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm nodrag nopan" onMouseDown={(e) => { e.stopPropagation(); if (e.target === e.currentTarget && !busy) onClose(); }}>
      <form
        onSubmit={confirm}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="del-proj-title"
        className="w-full max-w-md overflow-hidden rounded-2xl border border-rose-900/70 bg-slate-950 text-slate-100 shadow-2xl shadow-rose-950/40"
      >
        <div className="flex items-start gap-3 border-b border-rose-900/50 bg-rose-950/30 px-5 py-4">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-rose-500/15 text-rose-400">
            <AlertTriangle className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 id="del-proj-title" className="text-sm font-semibold text-white">Excluir projeto</h3>
            <p className="truncate text-xs text-rose-200/80" title={projectName}>{projectName}</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Fechar" className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-900 hover:text-white disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4 text-xs">
          {!info && !loadError && (
            <div className="flex items-center gap-2 text-slate-400"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Verificando o projeto…</div>
          )}
          {loadError && <div role="alert" className="text-amber-300">{loadError}</div>}

          {info?.isLast && (
            <div role="alert" className="rounded-lg border border-amber-900/50 bg-amber-950/20 p-3 text-amber-200">
              Este é o único projeto. Crie outro antes de excluí-lo.
            </div>
          )}

          {info && !info.isLast && (
            <>
              <div>
                <p className="mb-2 text-slate-300">Isto apaga <strong className="text-white">de forma permanente</strong> o canvas e as configurações do projeto:</p>
                <ul className="space-y-1.5" aria-label="O que será apagado">
                  {rows.length === 0 && <li className="text-slate-500">O canvas está vazio.</li>}
                  {rows.map((r) => (
                    <li key={r.text} className="flex items-center gap-2 text-slate-200">
                      <span className="text-rose-400">{r.icon}</span>
                      {r.text}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-[11px] text-slate-500">Os terminais em execução são encerrados e quem está no projeto é levado para outro.</p>
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-3">
                <div className="mb-1.5 flex items-center gap-1.5 font-mono text-[11px] text-slate-400" title={info.repoPath}>
                  <FolderGit2 className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{info.repoPath}</span>
                </div>
                {info.canDeleteFolder ? (
                  <label className="flex cursor-pointer items-start gap-2.5">
                    <input type="checkbox" checked={deleteFolder} onChange={(e) => setDeleteFolder(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-slate-700 bg-slate-950 accent-rose-600" />
                    <span>
                      <span className="font-medium text-slate-100">Apagar também a pasta do projeto no disco</span>
                      <span className="block text-[11px] text-slate-500">Todos os arquivos dessa pasta serão removidos. Sem marcar, eles continuam no disco.</span>
                    </span>
                  </label>
                ) : (
                  <p className="text-[11px] text-slate-500">Os arquivos do projeto continuam no disco{info.folderReason ? ` — ${info.folderReason}` : "."}</p>
                )}
              </div>

              <div>
                <label htmlFor="del-proj-name" className="mb-1.5 block text-slate-300">
                  Para confirmar, digite o nome do projeto: <strong className="select-all text-white">{projectName}</strong>
                </label>
                <input
                  id="del-proj-name"
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  placeholder={projectName}
                  className={`w-full rounded-lg border bg-slate-900 px-3 py-2 text-sm text-white transition focus:outline-none focus:ring-2 ${matches ? "border-rose-600 focus:ring-rose-500/40" : "border-slate-700 focus:border-rose-500 focus:ring-rose-500/20"}`}
                />
              </div>
            </>
          )}

          {error && <div role="alert" className="rounded-lg border border-amber-900/50 bg-amber-950/20 p-2.5 text-amber-200">{error}</div>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-800 px-5 py-3">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-lg px-3 py-2 text-xs font-medium text-slate-400 transition hover:bg-slate-900 hover:text-white disabled:opacity-40">
            Cancelar
          </button>
          <button
            type="submit"
            disabled={!canConfirm}
            className="flex items-center gap-1.5 rounded-lg bg-rose-600 px-4 py-2 text-xs font-semibold text-white shadow-md shadow-rose-600/30 transition hover:bg-rose-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-300 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            {busy ? "Excluindo…" : "Excluir projeto"}
          </button>
        </div>
      </form>
    </div>
  );
}
