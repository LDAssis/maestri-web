"use client";

import React, { useCallback, useEffect, useState } from "react";
import { AlarmClock, AlertTriangle, Bell, ChevronDown, ChevronRight, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useProjectEvents } from "@/lib/useProjectEvents";

type Day = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
type Schedule =
  | { type: "interval"; seconds: number }
  | { type: "daily"; time: string }
  | { type: "weekly"; days: Day[]; time: string }
  | { type: "once"; at: string };

interface Run {
  at: string;
  status: "ok" | "skipped" | "error";
  reason?: string;
  output?: string;
}

interface Routine {
  id: string;
  shortId: string;
  nodeId: string | null;
  nodeTitle: string | null;
  reminder: boolean;
  name: string;
  kind: "command" | "prompt";
  text: string;
  schedule: Schedule;
  label: string;
  status: "active" | "disabled" | "completed";
  enabled: boolean;
  count?: number;
  until?: string;
  preRun?: string;
  skipIfBusy: boolean;
  notify: boolean;
  fired: number;
  lastRunAt?: string;
  nextRunAt: number | null;
  history: Run[];
}

type ScheduleType = Schedule["type"];

interface Form {
  target: string; // id do terminal ou "reminder"
  name: string;
  kind: "command" | "prompt";
  text: string;
  scheduleType: ScheduleType;
  every: string;
  time: string;
  days: Day[];
  at: string; // datetime-local
  count: string;
  until: string;
  preRun: string;
  skipIfBusy: boolean;
  notify: boolean;
  enabled: boolean;
}

const DAYS: { id: Day; label: string }[] = [
  { id: "mon", label: "Seg" },
  { id: "tue", label: "Ter" },
  { id: "wed", label: "Qua" },
  { id: "thu", label: "Qui" },
  { id: "fri", label: "Sex" },
  { id: "sat", label: "Sáb" },
  { id: "sun", label: "Dom" },
];
const REMINDER = "reminder";

const emptyForm = (target = ""): Form => ({
  target, name: "", kind: "command", text: "", scheduleType: "interval", every: "30m", time: "09:00", days: ["mon", "tue", "wed", "thu", "fri"],
  at: "", count: "", until: "", preRun: "", skipIfBusy: true, notify: true, enabled: true,
});

const fmt = (when?: string | number | null) => (when ? new Date(when).toLocaleString() : "—");

// 5400 -> "1h30m"
function duration(sec: number) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h ? `${h}h` : ""}${m ? `${m}m` : ""}${s ? `${s}s` : ""}` || "0s";
}

const STATUS_STYLE: Record<Routine["status"], string> = {
  active: "bg-emerald-950 text-emerald-300",
  disabled: "bg-amber-950 text-amber-300",
  completed: "bg-slate-800 text-slate-300",
};
const STATUS_LABEL: Record<Routine["status"], string> = { active: "ativa", disabled: "desligada", completed: "concluída" };
const RUN_STYLE: Record<Run["status"], string> = { ok: "text-emerald-400", skipped: "text-amber-300", error: "text-rose-400" };
const RUN_LABEL: Record<Run["status"], string> = { ok: "ok", skipped: "pulado", error: "erro" };

// Devolve a mensagem de erro, ou "" se o formulário é válido (o servidor valida de novo)
function validate(f: Form): string {
  if (!f.target) return "Escolha um terminal ou lembrete.";
  if (!f.name.trim() || f.name.trim().length > 60) return "Nome: 1 a 60 caracteres.";
  if (!f.text.trim() || f.text.length > 20000) return "Comando: 1 a 20000 caracteres.";
  if (f.scheduleType === "interval" && !/^(\d+|(\d+h)?(\d+m)?(\d+s)?)$/i.test(f.every.trim())) return "Intervalo: ex. 45s, 30m, 2h, 1h30m (número puro = minutos).";
  if ((f.scheduleType === "daily" || f.scheduleType === "weekly") && !/^([01]\d|2[0-3]):[0-5]\d$/.test(f.time)) return "Horário inválido (HH:MM).";
  if (f.scheduleType === "weekly" && f.days.length === 0) return "Escolha ao menos um dia.";
  if (f.scheduleType === "once" && !f.at) return "Informe a data e a hora.";
  if (f.count !== "" && (!Number.isInteger(Number(f.count)) || Number(f.count) < 1)) return "Repetições: inteiro maior que 0.";
  return "";
}

function scheduleBody(f: Form) {
  if (f.scheduleType === "interval") return { type: "interval", every: f.every.trim() };
  if (f.scheduleType === "daily") return { type: "daily", time: f.time };
  if (f.scheduleType === "weekly") return { type: "weekly", days: f.days, time: f.time };
  return { type: "once", at: f.at.replace("T", " ").slice(0, 16) };
}

export default function RoutinesPanel({ projectId }: { projectId: string }) {
  const api = `/api/projects/${projectId}/routines`;
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [agents, setAgents] = useState<{ id: string; title: string }[]>([]);
  const [error, setError] = useState("");
  const [form, setForm] = useState<Form | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [rowMsg, setRowMsg] = useState<{ id: string; text: string; warn: boolean } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(api);
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `Servidor respondeu ${res.status}`);
      setRoutines((await res.json()).routines);
      setError("");
    } catch (e: any) {
      setError(e?.message || "Falha de rede");
    }
    // agentes do canvas (best-effort)
    try {
      const res = await apiFetch(`/api/projects/${projectId}/canvas`);
      if (res.ok) {
        const nodes: any[] = (await res.json()).nodes || [];
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

  const call = async (id: string, path: string, init: RequestInit, onOk?: (body: any) => void) => {
    setRowMsg(null);
    try {
      const res = await apiFetch(`${api}/${id}${path}`, init);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRowMsg({ id, text: body?.error || `Servidor respondeu ${res.status}`, warn: true });
        return false;
      }
      onOk?.(body);
      await load();
      return true;
    } catch {
      setRowMsg({ id, text: "Servidor indisponível", warn: true });
      return false;
    }
  };

  const openForm = (r?: Routine) => {
    setFormError("");
    setEditing(r?.id ?? null);
    if (!r) return setForm(emptyForm(agents[0]?.id));
    const s = r.schedule;
    setForm({
      ...emptyForm(),
      target: r.reminder ? REMINDER : r.nodeId ?? "",
      name: r.name,
      kind: r.kind,
      text: r.text,
      scheduleType: s.type,
      every: s.type === "interval" ? duration(s.seconds) : "30m",
      time: s.type === "daily" || s.type === "weekly" ? s.time : "09:00",
      days: s.type === "weekly" ? s.days : emptyForm().days,
      at: s.type === "once" ? s.at.replace(" ", "T") : "",
      count: r.count ? String(r.count) : "",
      until: r.until ?? "",
      preRun: r.preRun ?? "",
      skipIfBusy: r.skipIfBusy,
      notify: r.notify,
      enabled: r.enabled,
    });
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form) return;
    const problem = validate(form);
    if (problem) return setFormError(problem);
    // Campos opcionais vazios viram null (limpam na edição; o servidor ignora na criação)
    const body = {
      ...(form.target === REMINDER ? { reminder: true } : { reminder: false, nodeId: form.target }),
      name: form.name.trim(),
      kind: form.kind,
      text: form.text,
      schedule: scheduleBody(form),
      count: form.count === "" ? null : Number(form.count),
      until: form.until || null,
      preRun: form.preRun.trim() ? form.preRun : null,
      skipIfBusy: form.skipIfBusy,
      notify: form.notify,
      enabled: form.enabled,
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

  // Agrupa por terminal-alvo; lembretes ficam num grupo próprio
  const groups = new Map<string, Routine[]>();
  for (const r of routines || []) {
    const key = r.reminder ? REMINDER : r.nodeId ?? "";
    groups.set(key, [...(groups.get(key) || []), r]);
  }
  const groupTitle = (key: string, list: Routine[]) =>
    key === REMINDER ? "Lembretes" : agents.find((a) => a.id === key)?.title ?? list[0]?.nodeTitle ?? `${key} (nó removido)`;

  const input = "w-full bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-indigo-500";
  const btn = "px-2 py-1 rounded-md text-[11px] font-medium transition disabled:opacity-40";
  const set = (patch: Partial<Form>) => setForm((f) => (f ? { ...f, ...patch } : f));
  const toggleDay = (d: Day) => form && set({ days: form.days.includes(d) ? form.days.filter((x) => x !== d) : [...form.days, d] });

  return (
    <div className="h-full overflow-y-auto bg-[#080d1a] p-6">
      <div className="mx-auto max-w-4xl space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
            <AlarmClock className="h-4 w-4 text-indigo-400" />
            Rotinas
          </h2>
          {!form && (
            <button onClick={() => openForm()} className={`${btn} flex items-center gap-1 bg-indigo-600 text-white hover:bg-indigo-500`}>
              <Plus className="h-3 w-3" /> Nova rotina
            </button>
          )}
        </div>

        {form && (
          <form noValidate onSubmit={save} aria-label={editing ? "Editar rotina" : "Nova rotina"} className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-[11px] text-slate-300">
                Nome
                <input value={form.name} maxLength={60} onChange={(e) => set({ name: e.target.value })} className={`${input} mt-1`} placeholder="ex: auditoria noturna" />
              </label>
              <label className="text-[11px] text-slate-300">
                Alvo
                <select value={form.target} onChange={(e) => set({ target: e.target.value })} className={`${input} mt-1`}>
                  {!form.target && <option value="">—</option>}
                  {form.target && form.target !== REMINDER && !agents.some((a) => a.id === form.target) && <option value={form.target}>{form.target} (removido)</option>}
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>Terminal: {a.title}</option>
                  ))}
                  <option value={REMINDER}>Lembrete (sem terminal, só aviso)</option>
                </select>
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
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <select value={form.scheduleType} onChange={(e) => set({ scheduleType: e.target.value as ScheduleType })} aria-label="Tipo de agendamento" className={`${input} w-36`}>
                    <option value="interval">A cada…</option>
                    <option value="daily">Diário às</option>
                    <option value="weekly">Semanal</option>
                    <option value="once">Uma vez</option>
                  </select>
                  {form.scheduleType === "interval" && (
                    <input value={form.every} onChange={(e) => set({ every: e.target.value })} aria-label="Intervalo (ex. 45s, 30m, 2h, 1h30m)" placeholder="30m" className={`${input} w-28`} />
                  )}
                  {(form.scheduleType === "daily" || form.scheduleType === "weekly") && (
                    <input type="time" value={form.time} onChange={(e) => set({ time: e.target.value })} aria-label="Horário (hora local do servidor)" className={`${input} w-28`} />
                  )}
                  {form.scheduleType === "once" && (
                    <input type="datetime-local" value={form.at} onChange={(e) => set({ at: e.target.value })} aria-label="Data e hora (hora local do servidor)" className={`${input} w-52`} />
                  )}
                </div>
                {form.scheduleType === "weekly" && (
                  <div role="group" aria-label="Dias da semana" className="mt-1.5 flex flex-wrap gap-1">
                    {DAYS.map((d) => (
                      <button
                        key={d.id}
                        type="button"
                        aria-pressed={form.days.includes(d.id)}
                        onClick={() => toggleDay(d.id)}
                        className={`${btn} ${form.days.includes(d.id) ? "bg-indigo-600 text-white" : "bg-slate-800 text-slate-400 hover:text-white"}`}
                      >
                        {d.label}
                      </button>
                    ))}
                  </div>
                )}
                <span className="text-[10px] text-slate-500">Horários na hora local do servidor.</span>
              </div>
            </div>
            <label className="block text-[11px] text-slate-300">
              {form.target === REMINDER ? "Texto do aviso" : "Comando"} <span className="text-slate-500">({"{{output}}"} = saída do pre-run)</span>
              <textarea value={form.text} maxLength={20000} rows={3} onChange={(e) => set({ text: e.target.value })} className={`${input} mt-1 font-mono`} />
            </label>
            <label className="block text-[11px] text-slate-300">
              Pre-run <span className="text-slate-500">(opcional; roda no diretório do terminal, precisa sair com 0 ou o disparo é pulado)</span>
              <textarea value={form.preRun} rows={2} onChange={(e) => set({ preRun: e.target.value })} className={`${input} mt-1 font-mono`} placeholder="git log --since=midnight --oneline" />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-[11px] text-slate-300">
                Parar após N disparos
                <input type="number" min={1} value={form.count} onChange={(e) => set({ count: e.target.value })} placeholder="sem limite" className={`${input} mt-1`} />
              </label>
              <label className="text-[11px] text-slate-300">
                Parar depois de (último dia)
                <input type="date" value={form.until} onChange={(e) => set({ until: e.target.value })} className={`${input} mt-1`} />
              </label>
            </div>
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-slate-300">
              {form.target !== REMINDER && (
                <label className="flex items-center gap-1.5" title="Ocupado = chat em andamento ou saída do terminal nos últimos segundos">
                  <input type="checkbox" checked={form.skipIfBusy} onChange={(e) => set({ skipIfBusy: e.target.checked })} /> Pular se ocupado
                </label>
              )}
              {form.target !== REMINDER && (
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" checked={form.notify} onChange={(e) => set({ notify: e.target.checked })} /> Notificar a cada disparo
                </label>
              )}
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Ligada
              </label>
            </div>
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
            Nenhuma rotina. Agende comandos, prompts ou lembretes recorrentes para o projeto.
          </div>
        )}

        {Array.from(groups.entries()).map(([key, list]) => (
          <section key={key} className="space-y-2">
            <h3 className="flex items-center gap-1.5 text-[11px] font-mono uppercase text-slate-500">
              {key === REMINDER && <Bell className="h-3 w-3" />}
              {groupTitle(key, list)}
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
                        <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-normal text-slate-300">
                          {r.reminder ? "lembrete" : r.kind === "command" ? "comando" : "prompt"}
                        </span>
                        <span className={`rounded px-1.5 py-0.5 text-[10px] font-normal ${STATUS_STYLE[r.status]}`}>{STATUS_LABEL[r.status]}</span>
                      </div>
                      <div className="mt-0.5 text-[11px] text-slate-400">
                        {r.label} · próxima: {r.status === "active" ? fmt(r.nextRunAt) : "—"} · disparos: {r.fired}
                        {r.count ? `/${r.count}` : ""}
                        {r.until ? ` · até ${r.until}` : ""} · última:{" "}
                        {last ? (
                          <span className={RUN_STYLE[last.status]}>
                            {fmt(last.at)} {RUN_LABEL[last.status]}
                          </span>
                        ) : (
                          "nunca"
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <label className="flex cursor-pointer items-center gap-1 text-[11px] text-slate-300">
                        <input
                          type="checkbox"
                          role="switch"
                          checked={r.enabled}
                          onChange={(e) => call(r.id, "", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: e.target.checked }) })}
                          aria-label={`${r.enabled ? "Desligar" : "Ligar"} ${r.name}`}
                        />
                        Ativa
                      </label>
                      <button
                        onClick={() =>
                          call(r.id, "/run", { method: "POST" }, (b) => {
                            if (b.status === "skipped") setRowMsg({ id: r.id, text: `Pulada: ${b.reason}`, warn: true });
                          })
                        }
                        className={`${btn} flex items-center gap-1 bg-emerald-700 text-white hover:bg-emerald-600`}
                        aria-label={`Rodar ${r.name} agora`}
                      >
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
                  {rowMsg?.id === r.id && (
                    <div role="alert" className="mt-2 flex items-center gap-1.5 rounded-lg border border-amber-700/60 bg-amber-950/60 px-2 py-1 text-[11px] text-amber-300">
                      <AlertTriangle className="h-3 w-3 shrink-0" />
                      {rowMsg.text}
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
                      {r.history.length === 0 && <li className="text-[11px] text-slate-500">Sem disparos ainda.</li>}
                      {[...r.history].reverse().map((h, i) => (
                        <li key={`${h.at}-${i}`} className="text-[11px]">
                          <span className={RUN_STYLE[h.status]}>{RUN_LABEL[h.status]}</span> <span className="text-slate-400">{fmt(h.at)}</span>
                          {h.reason && <span className={h.status === "error" ? "text-rose-300" : "text-amber-200"}> — {h.reason}</span>}
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
