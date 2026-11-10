"use client";

import React, { useCallback, useEffect, useState } from "react";
import { Bell, RotateCcw, Trash2, UserCog } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { isAdminUser } from "./EntryGate";

interface Account {
  program: "claude" | "codex";
  name: string;
  usedBy: string[];
}

// Retomada de sessão (por projeto) e contas de CLI (globais) nas configurações
export default function SessionAccountsSettings({ projectId }: { projectId: string }) {
  const isAdmin = isAdminUser();
  const [resume, setResume] = useState(true);
  const [desktop, setDesktop] = useState(true);
  const [desktopForced, setDesktopForced] = useState(false); // MAESTRI_DESKTOP_NOTIFY no servidor manda mais que a preferência
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [program, setProgram] = useState<"claude" | "codex">("claude");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmDel, setConfirmDel] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, a] = await Promise.all([apiFetch(`/api/projects/${projectId}/prefs`), apiFetch("/api/accounts")]);
      if (p.ok) {
        const prefs = await p.json();
        setResume(prefs.resumeSession !== false);
        setDesktop(prefs.desktopNotify === true);
        setDesktopForced(prefs.desktopNotifyForced === true);
      }
      if (a.ok) setAccounts((await a.json()).accounts);
    } catch {
      setError("Servidor indisponível");
    }
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const toggleResume = async (value: boolean) => {
    setResume(value);
    setError("");
    try {
      const res = await apiFetch(`/api/projects/${projectId}/prefs`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resumeSession: value }),
      });
      if (!res.ok) throw new Error();
    } catch {
      setResume(!value);
      setError("Não foi possível salvar a preferência");
    }
  };

  const toggleDesktop = async (value: boolean) => {
    setDesktop(value);
    setError("");
    try {
      const res = await apiFetch(`/api/projects/${projectId}/prefs`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ desktopNotify: value }),
      });
      if (!res.ok) throw new Error();
    } catch {
      setDesktop(!value);
      setError("Não foi possível salvar a preferência");
    }
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setError("");
    const res = await apiFetch("/api/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ program, name: name.trim() }),
    }).catch(() => null);
    const body = await res?.json().catch(() => ({}));
    if (!res?.ok) return setError(body?.error || "Não foi possível criar a conta");
    setName("");
    load();
  };

  const remove = async (a: Account) => {
    setError("");
    setNotice("");
    const res = await apiFetch(`/api/accounts/${a.program}/${encodeURIComponent(a.name)}`, { method: "DELETE" }).catch(() => null);
    const body = await res?.json().catch(() => ({}));
    setConfirmDel(null);
    if (!res?.ok) return setError(body?.error || "Não foi possível apagar a conta");
    // presets que fixavam a conta foram desafixados: avisa quais
    if (body?.unpinned?.length) setNotice(`Presets desafixados (voltam ao login padrão): ${body.unpinned.join(", ")}.`);
    load();
  };

  const input = "bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-indigo-500";
  return (
    <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/40 p-3">
      <label className="flex cursor-pointer items-start gap-2.5">
        <input type="checkbox" checked={resume} onChange={(e) => toggleResume(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-slate-700 bg-slate-950" />
        <span>
          <span className="flex items-center gap-1.5 font-semibold text-slate-200">
            <RotateCcw className="h-3.5 w-3.5 text-indigo-400" /> Retomar sessão dos agentes
          </span>
          <span className="block text-[11px] text-slate-400">
            Ao reabrir um terminal cuja sessão morreu (ou depois de reiniciar o servidor), claude, codex e opencode voltam em modo de retomada (<code>--continue</code>, <code>resume --last</code>). Trocar o agente ou o role começa do zero.
          </span>
        </span>
      </label>

      <label className="flex cursor-pointer items-start gap-2.5">
        <input type="checkbox" checked={desktop} disabled={desktopForced} onChange={(e) => toggleDesktop(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-slate-700 bg-slate-950" />
        <span>
          <span className="flex items-center gap-1.5 font-semibold text-slate-200">
            <Bell className="h-3.5 w-3.5 text-indigo-400" /> Notificações do sistema (no computador do servidor)
          </span>
          <span className="block text-[11px] text-slate-400">
            <code>maestri notify</code>, lembretes de rotina, andares em blocked/review/done e andares que passam a seguir um PR também aparecem como notificação do SO (Linux: <code>notify-send</code>; macOS: <code>osascript</code>), além do aviso no canvas. Por padrão fica ligada só quando o servidor escuta em loopback.
            {desktopForced && " A variável MAESTRI_DESKTOP_NOTIFY no servidor está definindo isso (a preferência é ignorada)."}
          </span>
        </span>
      </label>

      <div>
        <div className="mb-1 flex items-center gap-1.5 font-semibold text-slate-200">
          <UserCog className="h-3.5 w-3.5 text-indigo-400" /> Contas de CLI
        </div>
        <p className="mb-2 text-[11px] text-slate-400">
          Cada conta tem um diretório de configuração isolado (CLAUDE_CONFIG_DIR / CODEX_HOME). Depois de criar, recrute um agente na conta (<code>maestri recruit --account</code>) e faça o login rodando o CLI naquele terminal. &quot;Padrão&quot; é o login original do servidor, liberado a todo administrador. Cada usuário só vê as contas que um admin liberou para ele.
        </p>
        <ul className="mb-2 space-y-1" aria-label="Contas de CLI">
          {accounts.length === 0 && (
            <li role="status" className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-200">
              Nenhuma conta de assinatura liberada para este projeto. Peça a um administrador para liberar uma conta ao dono do projeto (Usuários e acessos → Contas).
            </li>
          )}
          {accounts.map((a) => {
            const k = `${a.program}/${a.name}`;
            return (
              <li key={k} className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-950 px-2 py-1">
                <span className="rounded bg-slate-800 px-1.5 text-[10px] text-slate-300">{a.program}</span>
                <span className="flex-1 truncate text-slate-200">{a.name}</span>
                {a.usedBy.length > 0 && <span className="truncate text-[10px] text-slate-500" title={a.usedBy.join(", ")}>em uso: {a.usedBy.join(", ")}</span>}
                {!isAdmin ? null : confirmDel === k ? (
                  <span className="flex items-center gap-1 text-[11px]">
                    Apagar (inclui o login)?
                    <button onClick={() => remove(a)} className="rounded bg-rose-600 px-1.5 py-0.5 text-white hover:bg-rose-500">Sim</button>
                    <button onClick={() => setConfirmDel(null)} className="text-slate-400 hover:text-white">Não</button>
                  </span>
                ) : (
                  <button onClick={() => setConfirmDel(k)} aria-label={`Apagar conta ${a.name}`} className="text-slate-500 hover:text-rose-400">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        {isAdmin ? (
        <form onSubmit={create} className="flex gap-2">
          <select value={program} onChange={(e) => setProgram(e.target.value as "claude" | "codex")} aria-label="CLI da conta" className={input}>
            <option value="claude">claude</option>
            <option value="codex">codex</option>
          </select>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="Nome da conta (ex: Work)" aria-label="Nome da conta" className={`${input} flex-1`} />
          <button type="submit" disabled={!name.trim()} className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-40">
            Criar conta
          </button>
        </form>
        ) : (
          <p className="text-[11px] text-slate-500">Só administradores criam ou apagam contas.</p>
        )}
        {error && <div role="alert" className="mt-1.5 text-[11px] text-amber-300">{error}</div>}
        {notice && <div role="status" className="mt-1.5 text-[11px] text-sky-300">{notice}</div>}
      </div>
    </div>
  );
}
