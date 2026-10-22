"use client";

import React, { useEffect, useRef, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useRoles } from "@/lib/useRoles";

// Presets do servidor (embutidos + cliPresets das configurações); o mesmo que `maestri preset list`
interface PresetItem {
  id: string;
  label: string;
  cmd: string;
  maestro: boolean;
  chat: boolean;
  quickStart: boolean;
  builtin: boolean;
}
const FALLBACK: PresetItem[] = [
  ["claude", "Claude"], ["codex", "Codex"], ["opencode", "OpenCode"], ["agy", "Antigravity"], ["shell", "Shell"],
].map(([id, label]) => ({ id, label, cmd: id === "shell" ? "" : id, maestro: false, chat: false, quickStart: true, builtin: true }));

export default function NewAgentSheet({
  projectId,
  position,
  floor,
  onClose,
  onCreated,
}: {
  projectId: string;
  position?: { x: number; y: number };
  // Andar em que o agente nasce (ausente = Ground)
  floor?: string;
  onClose: () => void;
  onCreated: (node: { id: string }) => void;
}) {
  const { roles } = useRoles(projectId);
  const [title, setTitle] = useState("");
  const [presets, setPresets] = useState<PresetItem[]>(FALLBACK);
  const [preset, setPreset] = useState("claude");
  const [cmd, setCmd] = useState("");
  const [roleId, setRoleId] = useState("");
  const [worktree, setWorktree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    apiFetch(`/api/projects/${projectId}/presets`)
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => {
        const list: PresetItem[] = (b?.presets ?? []).filter((p: PresetItem) => p.quickStart);
        if (list.length) {
          setPresets(list);
          setPreset((cur) => (list.some((p) => p.id === cur) ? cur : list[0].id));
        }
      })
      .catch(() => {});
  }, [projectId]);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    return () => {
      if (prev && document.contains(prev)) prev.focus();
    };
  }, []);

  // Foco preso na folha
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") return onClose();
    if (e.key !== "Tab") return;
    const f = Array.from(ref.current?.querySelectorAll<HTMLElement>("button, input, select, textarea") ?? []).filter((x) => !(x as any).disabled);
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const t = title.trim();
    if (!t || t.length > 64) return setError("Título: 1 a 64 caracteres.");
    const chosen = presets.find((p) => p.id === preset) ?? FALLBACK[0];
    setBusy(true);
    setError("");
    try {
      const res = await apiFetch(`/api/projects/${projectId}/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: t,
          // presets personalizados rodam como shell com o comando do preset
          preset: chosen.builtin ? chosen.id : "shell",
          ...((chosen.id === "shell" ? cmd.trim() : chosen.cmd) && { cmd: chosen.id === "shell" ? cmd.trim() : chosen.cmd }),
          ...(!chosen.builtin && { presetName: chosen.label }),
          ...(chosen.maestro && { isMaestro: true }),
          ...(chosen.chat && { chatFirst: true }),
          ...(roleId && { roleId }),
          ...(position && { position }),
          ...(floor && { floor }),
          ...(worktree && { worktree: true }),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return setError(body?.error || `Servidor respondeu ${res.status}`);
      onCreated(body.node);
    } catch {
      setError("Servidor indisponível");
    } finally {
      setBusy(false);
    }
  };

  const field = "w-full bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-indigo-500";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onMouseDown={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="Novo agente"
        onKeyDown={onKeyDown}
        onMouseDown={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-950 p-5 shadow-2xl"
      >
        <div className="mb-3 flex items-center justify-between border-b border-slate-800 pb-3">
          <h3 className="text-sm font-semibold text-white">Novo agente</h3>
          <button onClick={onClose} aria-label="Fechar" className="text-slate-400 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>
        <form onSubmit={submit} className="space-y-3">
          <label className="block text-[11px] text-slate-300">
            Título
            <input autoFocus value={title} maxLength={64} onChange={(e) => setTitle(e.target.value)} placeholder="ex: Backend" className={`${field} mt-1`} />
          </label>
          <fieldset>
            <legend className="mb-1 text-[11px] text-slate-300">Preset</legend>
            <div role="radiogroup" className="grid grid-cols-3 gap-1.5 sm:grid-cols-5">
              {presets.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={preset === p.id}
                  onClick={() => setPreset(p.id)}
                  className={`rounded-lg border px-1 py-2 text-[11px] font-medium transition ${
                    preset === p.id ? "border-indigo-500 bg-indigo-600/30 text-white" : "border-slate-800 bg-slate-900 text-slate-300 hover:border-slate-600"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </fieldset>
          {preset === "shell" && (
            <label className="block text-[11px] text-slate-300">
              Comando inicial (opcional)
              <input value={cmd} maxLength={500} onChange={(e) => setCmd(e.target.value)} placeholder="ex: npm run dev" className={`${field} mt-1 font-mono`} />
            </label>
          )}
          <label className="block text-[11px] text-slate-300">
            Role
            <select value={roleId} onChange={(e) => setRoleId(e.target.value)} className={`${field} mt-1`}>
              <option value="">Nenhum</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-[11px] text-slate-300">
            <input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} />
            Criar em andar isolado (git worktree)
          </label>
          {error && (
            <div role="alert" className="flex items-center gap-1.5 text-[11px] text-amber-300">
              <AlertTriangle className="h-3 w-3 shrink-0" />
              {error}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-xs text-slate-400 hover:text-white">Cancelar</button>
            <button type="submit" disabled={busy} className="rounded-lg bg-indigo-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-40">
              {busy ? "Criando…" : "Criar agente"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
