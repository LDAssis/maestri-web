"use client";

import React, { useCallback, useEffect, useState } from "react";
import { AlarmClock, AlertTriangle, ChevronDown, ChevronRight, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useProjectEvents } from "@/lib/useProjectEvents";

type Schedule = { type: "interval"; minutes: number } | { type: "daily"; time: string };

interface Routine {
  id: string;
  nodeId: string;
  name: string;
  kind: "command" | "prompt";
  text: string;
  schedule: Schedule;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  nextRunAt: number; // epoch ms
  history: { at: string; ok: boolean; error?: string; output?: string }[];
}

interface Form {
  nodeId: string;
  name: string;
  kind: "command" | "prompt";
  text: string;
  scheduleType: "interval" | "daily";
  minutes: string;
  time: string;
}

const emptyForm = (nodeId = ""): Form => ({ nodeId, name: "", kind: "command", text: "", scheduleType: "interval", minutes: "30", time: "09:00" });

const fmt = (when?: string | number) => (when ? new Date(when).toLocaleString() : "—");
const scheduleLabel = (s: Schedule) => (s.type === "interval" ? `a cada ${s.minutes} min` : `diário às ${s.time}`);

// Devolve a mensagem de erro, ou "" se o formulário é válido (limites do contrato)
function validate(f: Form): string {
  if (!f.nodeId) return "Escolha um agente.";
  if (!f.name.trim() || f.name.trim().length > 60) return "Nome: 1 a 60 caracteres.";
  if (!f.text.trim() || f.text.length > 20000) return "Texto: 1 a 20000 caracteres.";
  if (f.scheduleType === "interval") {
    const m = Number(f.minutes);
    if (!Number.isInteger(m) || m < 1 || m > 10080) return "Intervalo: 1 a 10080 minutos.";
  } else if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(f.time)) return "Horário inválido (HH:MM).";
  return "";
}

export default function RoutinesPanel({ projectId }: { projectId: string }) {
  const api = `/api/projects/${projectId}/routines`;
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [agents, setAgents] = useState<{ id: string; title: string }[]>([]);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [form, setForm] = useState<Form | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(api);
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `Servidor respondeu ${res.status}`);
      setRoutines((await res.json()).routines);
      setError("");
    } catch (e: any) {
      setError(e?.message || "Falha de rede");
    }
    // agentes/títulos do canvas (best-effort)
    try {
      const res = await apiFetch(`/api/projects/${projectId}/canvas`);
      if (res.ok) {
        const nodes: any[] = (await res.json()).nodes || [];
        setTitles(Object.fromEntries(nodes.map((n) => [n.id, String(n.data?.title ?? n.id)])));
        setAgents(nodes.filter((n) => n.type === "agentTerminal").map((n) => ({ id: n.id, title: String(n.data?.title ?? n.id) })));
      }
    } catch {}
  }, [api, projectId]);

  useEffect(() => {
    setRoutines(null);
    load();
  }, [load]);

  useProjectEvents(projectId, (t) => {
    if (t === "routines" || t === "connected") load();
  });

  const call = async (id: string, path: string, init: RequestInit) => {
    setRowError(null);
    try {
      const res = await apiFetch(`${api}/${id}${path}`, init);
      if (!res.ok) {
        setRowError({ id, text: (await res.json().catch(() => ({})))?.error || `Servidor respondeu ${res.status}` });
        return false;
      }
      await load();
      return true;
    } catch {
      setRowError({ id, text: "Servidor indisponível" });
      return false;
    }
  };

  const openForm = (r?: Routine) => {
    setFormError("");
    setEditing(r?.id ?? null);
    setForm(
      r
        ? {
            nodeId: r.nodeId,
            name: r.name,
            kind: r.kind,
            text: r.text,
            scheduleType: r.schedule.type,
            minutes: r.schedule.type === "interval" ? String(r.schedule.minutes) : "30",
            time: r.schedule.type === "daily" ? r.schedule.time : "09:00",
          }
        : emptyForm(agents[0]?.id)
    );
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form) return;
    const problem = validate(form);
    if (problem) return setFormError(problem);
    const body = {
      nodeId: form.nodeId,
      name: form.name.trim(),
      kind: form.kind,
      text: form.text,
      schedule: form.scheduleType === "interval" ? { type: "interval", minutes: Number(form.minutes) } : { type: "daily", time: form.time },
    };
    setSaving(true);
    setFormError("");
    try {
      const res = await apiFetch(editing ? `${api}/${editing}` : api, {
        method: editing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) return setFormError((await res.json().catch(() => ({})))?.error || `Servidor respondeu ${res.status}`);
      setForm(null);
      setEditing(null);
      await load();
    } catch {
      setFormError("Servidor indisponível");
    } finally {
      setSaving(false);
    }
  };

  const groups = new Map<string, Routine[]>();
  for (const r of routines || []) groups.set(r.nodeId, [...(groups.get(r.nodeId) || []), r]);

  const input = "w-full bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-indigo-500";
  const btn = "px-2 py-1 rounded-md text-[11px] font-medium transition disabled:opacity-40";
  const set = (patch: Partial<Form>) => setForm((f) => (f ? { ...f, ...patch } : f));

  return (
    <div className="h-full overflow-y-auto bg-[#080d1a] p-6">
      <div className="mx-auto max-w-4xl space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
            <AlarmClock className="h-4 w-4 text-indigo-400" />
            Rotinas
          </h2>
          {!form && (
            <button
              onClick={() => openForm()}
              disabled={agents.length === 0}
              title={agents.length === 0 ? "O canvas não tem agentes" : undefined}
              className={`${btn} flex items-center gap-1 bg-indigo-600 text-white hover:bg-indigo-500`}
            >
              <Plus className="h-3 w-3" /> Nova rotina
            </button>
          )}
        </div>

        {form && (
          <form noValidate onSubmit={save} aria-label={editing ? "Editar rotina" : "Nova rotina"} className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-[11px] text-slate-300">
                Agente
                <select value={form.nodeId} onChange={(e) => set({ nodeId: e.target.value })} className={`${input} mt-1`}>
                  {!agents.some((a) => a.id === form.nodeId) && <option value={form.nodeId}>{titles[form.nodeId] || form.nodeId || "—"}</option>}
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>{a.title}</option>
                  ))}
                </select>
              </label>
              <label className="text-[11px] text-slate-300">
                Nome
                <input value={form.name} maxLength={60} onChange={(e) => set({ name: e.target.value })} className={`${input} mt-1`} placeholder="ex: rodar testes" />
              </label>
              <label className="text-[11px] text-slate-300">
                Tipo
                <select value={form.kind} onChange={(e) => set({ kind: e.target.value as Form["kind"] })} className={`${input} mt-1`}>
                  <option value="command">Comando (escreve no terminal)</option>
                  <option value="prompt">Prompt (para o agente)</option>
                </select>
              </label>
              <div className="text-[11px] text-slate-300">
                Agendamento
                <div className="mt-1 flex gap-2">
                  <select value={form.scheduleType} onChange={(e) => set({ scheduleType: e.target.value as Form["scheduleType"] })} aria-label="Tipo de agendamento" className={input}>
                    <option value="interval">A cada N min</option>
                    <option value="daily">Diário às</option>
                  </select>
                  {form.scheduleType === "interval" ? (
                    <input type="number" min={1} max={10080} value={form.minutes} onChange={(e) => set({ minutes: e.target.value })} aria-label="Minutos" className={`${input} w-24`} />
                  ) : (
                    <input type="time" value={form.time} onChange={(e) => set({ time: e.target.value })} aria-label="Horário (hora local do servidor)" className={`${input} w-28`} />
                  )}
                </div>
                {form.scheduleType === "daily" && <span className="text-[10px] text-slate-500">Hora local do servidor.</span>}
              </div>
            </div>
            <label className="block text-[11px] text-slate-300">
              Texto
              <textarea value={form.text} maxLength={20000} rows={4} onChange={(e) => set({ text: e.target.value })} className={`${input} mt-1 font-mono`} />
            </label>
            {formError && (
              <div role="alert" className="flex items-center gap-1.5 text-[11px] text-amber-300">
                <AlertTriangle className="h-3 w-3 shrink-0" />
                {formError}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setForm(null)} className={`${btn} text-slate-400 hover:text-white`}>Cancelar</button>
              <button type="submit" disabled={saving} className={`${btn} bg-indigo-600 text-white hover:bg-indigo-500`}>
                {saving ? "Salvando…" : editing ? "Salvar" : "Criar rotina"}
              </button>
            </div>
          </form>
        )}

        {error && (
          <div role="alert" className="flex items-center gap-2 rounded-lg border border-rose-800/60 bg-rose-950/50 px-3 py-2 text-xs text-rose-300">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            {error}
          </div>
        )}
        {routines === null && !error && <div className="text-xs text-slate-500 font-mono">Carregando rotinas…</div>}
        {routines?.length === 0 && (
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-6 text-center text-xs text-slate-400">
            Nenhuma rotina. Agende comandos ou prompts recorrentes para um agente.
          </div>
        )}

        {Array.from(groups.entries()).map(([nodeId, list]) => (
          <section key={nodeId} className="space-y-2">
            <h3 className="text-[11px] font-mono uppercase text-slate-500">
              {titles[nodeId] ?? `${nodeId} (nó removido)`}
            </h3>
            {list.map((r) => {
              const isOpen = expanded.has(r.id);
              const last = r.history[r.history.length - 1];
              return (
                <div key={r.id} className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 text-xs font-semibold text-slate-100">
                        <span className="truncate">{r.name}</span>
                        <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-normal text-slate-300">{r.kind === "command" ? "comando" : "prompt"}</span>
                        {!r.enabled && <span className="text-[10px] font-normal text-amber-300">desligada</span>}
                      </div>
                      <div className="mt-0.5 text-[11px] text-slate-400">
                        {scheduleLabel(r.schedule)} · próxima: {r.enabled ? fmt(r.nextRunAt) : "—"} · última:{" "}
                        {last ? <span className={last.ok ? "text-emerald-400" : "text-rose-400"}>{fmt(last.at)} {last.ok ? "ok" : "erro"}</span> : "nunca"}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <label className="flex cursor-pointer items-center gap-1 text-[11px] text-slate-300">
                        <input
                          type="checkbox"
                          role="switch"
                          checked={r.enabled}
                          onChange={(e) =>
                            call(r.id, "", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: e.target.checked }) })
                          }
                          aria-label={`${r.enabled ? "Desligar" : "Ligar"} ${r.name}`}
                        />
                        Ativa
                      </label>
                      <button onClick={() => call(r.id, "/run", { method: "POST" })} className={`${btn} flex items-center gap-1 bg-emerald-700 text-white hover:bg-emerald-600`} aria-label={`Rodar ${r.name} agora`}>
                        <Play className="h-3 w-3" /> Rodar agora
                      </button>
                      <button onClick={() => openForm(r)} className={`${btn} bg-slate-800 text-slate-200 hover:bg-slate-700`} aria-label={`Editar ${r.name}`}>
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button onClick={() => setConfirmDel(r.id)} className={`${btn} bg-slate-800 text-rose-300 hover:bg-rose-950`} aria-label={`Apagar ${r.name}`}>
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  </div>

                  {confirmDel === r.id && (
                    <div className="mt-2 flex items-center gap-2 text-[11px] text-slate-300">
                      Apagar esta rotina?
                      <button onClick={async () => { if (await call(r.id, "", { method: "DELETE" })) setConfirmDel(null); }} className={`${btn} bg-rose-600 text-white hover:bg-rose-500`}>Confirmar</button>
                      <button onClick={() => setConfirmDel(null)} className={`${btn} text-slate-400 hover:text-white`}>Cancelar</button>
                    </div>
                  )}
                  {rowError?.id === r.id && (
                    <div role="alert" className="mt-2 flex items-center gap-1.5 rounded-lg border border-amber-700/60 bg-amber-950/60 px-2 py-1 text-[11px] text-amber-300">
                      <AlertTriangle className="h-3 w-3 shrink-0" />
                      {rowError.text}
                    </div>
                  )}

                  <button
                    onClick={() => setExpanded((s) => { const n = new Set(s); if (!n.delete(r.id)) n.add(r.id); return n; })}
                    aria-expanded={isOpen}
                    className="mt-2 flex items-center gap-1 text-[11px] text-slate-400 hover:text-white"
                  >
                    {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                    Histórico ({r.history.length})
                  </button>
                  {isOpen && (
                    <ul className="mt-1 space-y-1.5">
                      {r.history.length === 0 && <li className="text-[11px] text-slate-500">Sem execuções ainda.</li>}
                      {[...r.history].reverse().map((h, i) => (
                        <li key={`${h.at}-${i}`} className="text-[11px]">
                          <span className={h.ok ? "text-emerald-400" : "text-rose-400"}>{h.ok ? "ok" : "erro"}</span>{" "}
                          <span className="text-slate-400">{fmt(h.at)}</span>
                          {h.error && <span className="text-rose-300"> — {h.error}</span>}
                          {h.output && (
                            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-slate-800 bg-black/50 p-2 font-mono text-[11px] text-slate-300">{h.output}</pre>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}
