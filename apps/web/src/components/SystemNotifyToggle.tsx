"use client";

import React, { useEffect, useState } from "react";
import { Bell, BellOff } from "lucide-react";
import { NotifyPermission, notifyPermission, requestNotifyPermission } from "@/lib/systemNotify";

// Estado da permissão de notificações do sistema + botão para ativar (a permissão só pode ser pedida num clique)
export default function SystemNotifyToggle({ compact = false }: { compact?: boolean }) {
  const [perm, setPerm] = useState<NotifyPermission>("default");
  useEffect(() => setPerm(notifyPermission()), []);
  if (perm === "unsupported") return compact ? null : <p className="text-[11px] text-slate-500">Notificações do navegador indisponíveis aqui (exigem HTTPS ou localhost). As notificações do SO pelo servidor continuam funcionando.</p>;
  if (perm === "granted") return compact ? null : <p className="text-[11px] text-emerald-400 flex items-center gap-1"><Bell className="h-3 w-3" />Notificações do sistema ativadas (avisos do CLI, lembretes de rotina e andares bloqueados/em revisão/prontos).</p>;
  if (perm === "denied") return compact ? null : <p className="text-[11px] text-amber-300 flex items-center gap-1"><BellOff className="h-3 w-3" />Bloqueadas no navegador: libere nas permissões do site para receber avisos do sistema.</p>;
  return (
    <button
      type="button"
      onClick={async () => setPerm(await requestNotifyPermission())}
      className={compact ? "mt-1 rounded-lg border border-amber-700/70 bg-slate-900/95 px-2 py-1 text-[11px] text-amber-300 hover:border-amber-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-400" : "px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-300"}
    >
      Ativar notificações do sistema
    </button>
  );
}
