"use client";

import React, { useEffect, useRef, useState } from "react";
import { Gauge } from "lucide-react";
import { isStale, resetIn, useMinuteTick, useUsage, type UsageAccount, type UsageWindow } from "@/lib/useUsage";

// verde < 70, âmbar 70-90, vermelho > 90
const barColor = (p: number) => (p > 90 ? "bg-rose-500" : p >= 70 ? "bg-amber-400" : "bg-emerald-500");
const pct = (w: UsageWindow) => Math.max(0, Math.min(100, Math.round(w.used_percentage)));

function Bar({ w, label, now, wide }: { w: UsageWindow | null; label: string; now: number; wide?: boolean }) {
  const p = w ? pct(w) : 0;
  return (
    <span className="flex items-center gap-1" title={w ? `${label}: ${p}% — ${resetIn(w, now)}` : `${label}: sem dados`}>
      <span className="text-[9px] text-slate-500">{label}</span>
      <span className={`${wide ? "w-14" : "w-8"} h-1 overflow-hidden rounded-full bg-slate-800`} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={p}>
        <span className={`block h-full ${barColor(p)}`} style={{ width: `${p}%` }} />
      </span>
    </span>
  );
}

// model: o do nó quando vem de NodeUsageMeter; o da conta (última sessão que escreveu) só no indicador do topo
const tip = (a: UsageAccount, now: number, model = a.model) =>
  [
    `${a.cli} · ${a.account}${model ? ` · ${model}` : ""}`,
    a.five_hour && `5 h: ${pct(a.five_hour)}% — ${resetIn(a.five_hour, now)}`,
    a.seven_day && `7 d: ${pct(a.seven_day)}% — ${resetIn(a.seven_day, now)}`,
    isStale(a, now) && "desatualizado",
  ]
    .filter(Boolean)
    .join("\n");

// Cabeçalho do nó: só aparece se houver dados da conta daquele nó
export function NodeUsageMeter({ projectId, nodeId, cli }: { projectId: string; nodeId: string; cli?: string }) {
  const { accounts, nodes } = useUsage(projectId);
  const now = useMinuteTick();
  const n = nodes[nodeId];
  const a = n && (accounts.find((x) => x.account === n.account && (!cli || x.cli === cli)) ?? accounts.find((x) => x.account === n.account));
  if (!a || (!a.five_hour && !a.seven_day)) return null;
  return (
    <div
      className={`flex flex-col gap-0.5 ${isStale(a, now) ? "opacity-40" : ""}`}
      title={tip(a, now, n.model)}
      aria-label={tip(a, now, n.model).replace(/\n/g, ". ")}
    >
      <Bar w={a.five_hour} label="5h" now={now} />
      <Bar w={a.seven_day} label="7d" now={now} />
    </div>
  );
}

// Topo do canvas: uma linha por conta/CLI; clique abre o popover com detalhes
export function UsageIndicator({ projectId }: { projectId: string }) {
  const { accounts } = useUsage(projectId);
  const now = useMinuteTick();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
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
  const shown = accounts.filter((a) => a.five_hour || a.seven_day);
  if (!shown.length) return null;
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label="Uso do plano"
        className="flex items-center gap-2 rounded-md border border-slate-800 bg-slate-900 px-1.5 py-0.5 hover:border-indigo-500"
      >
        <Gauge className="h-3 w-3 text-slate-400" />
        {shown.map((a) => (
          <span key={`${a.cli}/${a.account}`} className={`flex flex-col gap-0.5 ${isStale(a, now) ? "opacity-40" : ""}`} title={tip(a, now)}>
            <Bar w={a.five_hour} label="5h" now={now} />
            <Bar w={a.seven_day} label="7d" now={now} />
          </span>
        ))}
      </button>
      {open && (
        <div role="dialog" aria-label="Uso do plano" className="absolute right-0 top-full z-30 mt-2 w-72 space-y-3 rounded-xl border border-slate-700 bg-slate-950 p-3 font-sans shadow-2xl">
          {shown.map((a) => {
            const stale = isStale(a, now);
            return (
              <div key={`${a.cli}/${a.account}`} className={stale ? "opacity-60" : ""}>
                <div className="flex items-baseline justify-between text-[11px] text-slate-200">
                  <strong>
                    {a.cli} · {a.account}
                  </strong>
                  {stale && <span className="text-[10px] text-amber-300">desatualizado</span>}
                </div>
                {a.model && <div className="text-[10px] text-slate-500">{a.model}</div>}
                {([["5 h", a.five_hour], ["7 d", a.seven_day]] as const).map(([label, w]) =>
                  w ? (
                    <div key={label} className="mt-1.5">
                      <div className="flex justify-between text-[10px] text-slate-400">
                        <span>
                          {label}: <span className="text-slate-200">{pct(w)}%</span>
                        </span>
                        <span>{resetIn(w, now)}</span>
                      </div>
                      <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-slate-800">
                        <div className={`h-full ${barColor(pct(w))}`} style={{ width: `${pct(w)}%` }} />
                      </div>
                    </div>
                  ) : (
                    <div key={label} className="mt-1.5 text-[10px] text-slate-600">{label}: sem dados</div>
                  ),
                )}
                <div className="mt-1.5 text-[10px] text-slate-500">Atualizado às {new Date(a.updatedAt).toLocaleTimeString("pt-BR")}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
