"use client";

import React, { useEffect, useId, useRef, useState } from "react";
import { Gauge } from "lucide-react";
import { isStale, resetIn, useMinuteTick, useUsage, type UsageAccount, type UsageWindow } from "@/lib/useUsage";

// Cores de marca (mesmas do CliAuthModal)
const BRAND: Record<string, { name: string; mono: string; bg: string }> = {
  claude: { name: "Claude Code", mono: "C", bg: "#D97757" },
  codex: { name: "Codex", mono: "Cx", bg: "#0b3d2e" },
  agy: { name: "Antigravity", mono: "A", bg: "#4285F4" },
  opencode: { name: "OpenCode", mono: "OC", bg: "#52525b" },
  gemini: { name: "Gemini CLI", mono: "G", bg: "linear-gradient(135deg,#4285F4,#9B72CB)" },
};
const brandOf = (cli: string) => BRAND[cli] ?? { name: cli, mono: cli.slice(0, 1).toUpperCase(), bg: "#475569" };

// verde < 70, âmbar 70-90, vermelho > 90
const barColor = (p: number) => (p > 90 ? "bg-rose-500" : p >= 70 ? "bg-amber-400" : "bg-emerald-500");
const textColor = (p: number) => (p > 90 ? "text-rose-400" : p >= 70 ? "text-amber-300" : "text-emerald-400");
const pct = (w: UsageWindow) => Math.max(0, Math.min(100, Math.round(w.used_percentage)));
const peak = (a: UsageAccount) => Math.max(a.five_hour ? pct(a.five_hour) : -1, a.seven_day ? pct(a.seven_day) : -1);
const accountName = (a: string) => (!a || a.toLowerCase() === "default" ? "Default" : a);

function Bar({ w, label, now }: { w: UsageWindow | null; label: string; now: number }) {
  const p = w ? pct(w) : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between text-[11px]">
        <span className="text-slate-400">{label}</span>
        {w ? <span className={`font-semibold tabular-nums ${textColor(p)}`}>{p}%</span> : <span className="text-slate-600">sem dados</span>}
      </div>
      <div
        className="mt-1 h-2 overflow-hidden rounded-full bg-slate-800"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={p}
      >
        <div className={`h-full rounded-full transition-[width] ${barColor(p)}`} style={{ width: `${p}%` }} />
      </div>
      {w && <div className="mt-0.5 text-[10px] text-slate-500">{resetIn(w, now)}</div>}
    </div>
  );
}

function AccountCard({ a, now }: { a: UsageAccount; now: number }) {
  const b = brandOf(a.cli);
  const stale = isStale(a, now);
  return (
    <li className="rounded-xl border border-slate-800 bg-slate-900/70 p-3">
      <div className="flex items-center gap-2.5">
        <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-sm font-bold text-white shadow-md" style={{ background: b.bg }}>
          {b.mono}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold text-slate-100">
            {b.name} · {accountName(a.account)}
          </div>
          {a.model && <div className="truncate text-[10px] text-slate-500">{a.model}</div>}
        </div>
        {stale && <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-300">desatualizado</span>}
      </div>
      <div className={`mt-3 space-y-2.5 ${stale ? "opacity-60" : ""}`}>
        <Bar w={a.five_hour} label="Sessão (5 h)" now={now} />
        <Bar w={a.seven_day} label="Semana (7 d)" now={now} />
      </div>
    </li>
  );
}

// Botão flutuante (canto inferior direito) + painel com o uso de todas as assinaturas
export function UsagePanel({ projectId }: { projectId: string }) {
  const { accounts } = useUsage(projectId);
  const now = useMinuteTick();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const sorted = [...accounts].sort((x, y) => peak(y) - peak(x));
  const withData = accounts.filter((a) => a.five_hour);
  const top = withData.length ? Math.max(...withData.map((a) => pct(a.five_hour!))) : null;
  const last = accounts.length ? new Date(Math.max(...accounts.map((a) => Date.parse(a.updatedAt) || 0))) : null;

  return (
    <div ref={ref} className="absolute bottom-4 right-4 z-20 flex flex-col items-end font-sans">
      {open && (
        <div
          id={id}
          role="dialog"
          aria-label="Uso das assinaturas"
          className="mb-2 flex max-h-[70vh] w-[360px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-950/95 shadow-2xl backdrop-blur-md"
        >
          <div className="border-b border-slate-800 px-4 py-3">
            <h2 className="text-sm font-semibold text-slate-100">Uso das assinaturas</h2>
            <p className="text-[11px] text-slate-500">{last ? `Atualizado às ${last.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}` : "Sem atualizações ainda"}</p>
          </div>
          <div className="overflow-y-auto p-3">
            {sorted.length ? (
              <ul className="space-y-2.5">
                {sorted.map((a) => (
                  <AccountCard key={`${a.cli}/${a.account}`} a={a} now={now} />
                ))}
              </ul>
            ) : (
              <div className="flex flex-col items-center px-4 py-8 text-center">
                <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-500/10 text-indigo-300">
                  <Gauge className="h-6 w-6" />
                </span>
                <p className="mt-3 text-sm font-medium text-slate-200">Nenhum dado de uso ainda</p>
                <p className="mt-1 text-xs leading-relaxed text-slate-500">
                  O uso aparece depois que um agente Claude (assinatura Pro/Max) responde no canvas. Outros CLIs ainda não informam cota.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label="Uso das assinaturas"
        title={top === null ? "Uso das assinaturas" : `Uso das assinaturas — maior uso na sessão de 5 h: ${top}%`}
        className="flex items-center gap-1.5 rounded-full border border-slate-700 bg-slate-900/90 px-3 py-2 text-xs shadow-xl backdrop-blur-md hover:border-indigo-500"
      >
        <Gauge className={`h-4 w-4 ${top === null ? "text-slate-500" : textColor(top)}`} />
        {top !== null && <span className={`font-semibold tabular-nums ${textColor(top)}`}>{top}%</span>}
      </button>
    </div>
  );
}
