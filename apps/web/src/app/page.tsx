"use client";

import React, { useState, useEffect } from "react";
import { GitBranch, Play, RefreshCw, Terminal, Layers, Trash2 } from "lucide-react";
import dynamic from "next/dynamic";

const MonacoDiffEditor = dynamic(
  () => import("@monaco-editor/react").then((mod) => mod.DiffEditor),
  { ssr: false }
);

interface Session {
  id: string;
  devId: string;
  taskId: string;
  branch: string;
  worktreePath: string;
  createdAt: string;
}

export default function Dashboard() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [devId, setDevId] = useState("dev-carlos");
  const [taskId, setTaskId] = useState("auth-oauth-google");
  const [taskPrompt, setTaskPrompt] = useState(
    "Implementar autenticação Google OAuth utilizando NextAuth. Criar rotas e tipagem."
  );
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [activeDiff, setActiveDiff] = useState<string>("");
  const [loading, setLoading] = useState(false);

  const API_URL = "http://localhost:4000/api";

  const fetchSessions = async () => {
    try {
      const res = await fetch(`${API_URL}/sessions`);
      if (res.ok) {
        const data = await res.json();
        setSessions(data);
        if (data.length > 0 && !activeSession) {
          setActiveSession(data[0]);
        }
      }
    } catch {
      // Backend pode estar iniciando
    }
  };

  useEffect(() => {
    fetchSessions();
  }, []);

  const createSession = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ devId, taskId }),
      });
      const data = await res.json();
      if (data.ok) {
        await fetchSessions();
        setActiveSession(data.session);
      }
    } catch (e: any) {
      alert("Erro ao criar sessão: " + e.message);
    } finally {
      setLoading(false);
    }
  };

  const loadDiff = async (sessionId: string) => {
    try {
      const res = await fetch(`${API_URL}/sessions/${sessionId}/diff`);
      const data = await res.json();
      setActiveDiff(data.diff || "Sem alterações pendentes em relação ao branch base.");
    } catch (e: any) {
      setActiveDiff("Erro ao carregar diff: " + e.message);
    }
  };

  const removeSession = async (sessionId: string) => {
    if (!confirm("Deseja realmente encerrar a sessão e remover o worktree?")) return;
    try {
      await fetch(`${API_URL}/sessions/${sessionId}`, { method: "DELETE" });
      await fetchSessions();
      if (activeSession?.id === sessionId) {
        setActiveSession(null);
        setActiveDiff("");
      }
    } catch (e: any) {
      alert("Erro ao encerrar: " + e.message);
    }
  };

  return (
    <div className="flex h-screen bg-slate-950 font-sans text-slate-100">
      {/* Sidebar de Sessões / Ambientes por Dev */}
      <aside className="w-80 border-r border-slate-800 bg-slate-900/60 p-4 flex flex-col justify-between">
        <div>
          <div className="flex items-center gap-2 mb-6">
            <div className="h-8 w-8 rounded bg-indigo-600 flex items-center justify-center font-bold">
              M
            </div>
            <div>
              <h1 className="font-semibold text-sm tracking-wide">MAESTRI WEB</h1>
              <p className="text-xs text-slate-400">Multi-Agent Workspace</p>
            </div>
          </div>

          <div className="mb-4 flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              Ambientes Ativos
            </span>
            <button
              onClick={fetchSessions}
              className="text-slate-400 hover:text-white p-1 rounded"
              title="Recarregar"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="space-y-2 overflow-y-auto max-h-[calc(100vh-280px)]">
            {sessions.length === 0 ? (
              <p className="text-xs text-slate-500 italic">Nenhum ambiente ativo no momento.</p>
            ) : (
              sessions.map((s) => (
                <div
                  key={s.id}
                  onClick={() => {
                    setActiveSession(s);
                    loadDiff(s.id);
                  }}
                  className={`p-3 rounded-lg border cursor-pointer transition ${
                    activeSession?.id === s.id
                      ? "border-indigo-500 bg-indigo-950/40"
                      : "border-slate-800 bg-slate-900/40 hover:border-slate-700"
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-semibold text-indigo-400">{s.devId}</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        removeSession(s.id);
                      }}
                      className="text-slate-500 hover:text-red-400"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="text-sm font-medium text-slate-200 truncate">{s.taskId}</div>
                  <div className="flex items-center gap-1 mt-2 text-[11px] text-slate-400">
                    <GitBranch className="h-3 w-3" />
                    <span className="truncate">{s.branch}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Status do servidor */}
        <div className="border-t border-slate-800 pt-3 text-xs text-slate-400 flex items-center justify-between">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-emerald-500"></span>
            Orquestrador Online
          </span>
          <span className="text-[11px] text-slate-500">:4000</span>
        </div>
      </aside>

      {/* Área Central: Configuração de Nova Tarefa + Visualização de Diff */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Top Header */}
        <header className="h-14 border-b border-slate-800 px-6 flex items-center justify-between bg-slate-900/40">
          <div className="flex items-center gap-3">
            <Layers className="h-4 w-4 text-indigo-400" />
            <span className="text-sm font-medium text-slate-200">
              {activeSession ? `Worktree Ativo: ${activeSession.branch}` : "Novo Ambiente de Tarefa"}
            </span>
          </div>
          {activeSession && (
            <button
              onClick={() => loadDiff(activeSession.id)}
              className="px-3 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 rounded border border-slate-700 font-medium"
            >
              Atualizar Alterações (Diff)
            </button>
          )}
        </header>

        {/* Content Body */}
        <div className="flex-1 grid grid-cols-12 gap-0 overflow-hidden">
          {/* Painel Esquerdo: Formulário de Tarefa do Agente */}
          <div className="col-span-5 p-6 border-r border-slate-800 flex flex-col justify-between overflow-y-auto">
            <div>
              <h2 className="text-sm font-semibold mb-1">Criar Ambiente e Disparar Agente</h2>
              <p className="text-xs text-slate-400 mb-6">
                Cria um Git Worktree isolado para o dev trabalhar sem risco de merge conflicts.
              </p>

              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Identificador do Desenvolvedor
                  </label>
                  <input
                    type="text"
                    value={devId}
                    onChange={(e) => setDevId(e.target.value)}
                    className="w-full bg-slate-900 border border-slate-800 rounded px-3 py-2 text-xs focus:outline-none focus:border-indigo-500"
                    placeholder="ex: dev-ana"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Nome da Funcionalidade / ID da Tarefa
                  </label>
                  <input
                    type="text"
                    value={taskId}
                    onChange={(e) => setTaskId(e.target.value)}
                    className="w-full bg-slate-900 border border-slate-800 rounded px-3 py-2 text-xs focus:outline-none focus:border-indigo-500"
                    placeholder="ex: payment-stripe-webhook"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Instrução para a Equipe de Agentes
                  </label>
                  <textarea
                    rows={5}
                    value={taskPrompt}
                    onChange={(e) => setTaskPrompt(e.target.value)}
                    className="w-full bg-slate-900 border border-slate-800 rounded px-3 py-2 text-xs focus:outline-none focus:border-indigo-500"
                    placeholder="Descreva o que os agentes devem construir no projeto..."
                  />
                </div>

                <button
                  onClick={createSession}
                  disabled={loading}
                  className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded py-2 px-4 text-xs font-medium flex items-center justify-center gap-2 transition"
                >
                  <Play className="h-3.5 w-3.5 fill-current" />
                  {loading ? "Criando Worktree..." : "Inicializar Ambiente Isolado"}
                </button>
              </div>
            </div>

            {/* Terminal status preview */}
            <div className="mt-6 border border-slate-800 rounded-lg p-3 bg-black/40">
              <div className="flex items-center gap-2 mb-2 text-xs text-slate-400 font-mono">
                <Terminal className="h-3.5 w-3.5" />
                <span>Logs do Orquestrador</span>
              </div>
              <div className="text-[11px] font-mono text-slate-400 space-y-1">
                <div>[status] Sistema de Worktree pronto</div>
                {activeSession && (
                  <div>
                    [git] Isolado em: <span className="text-indigo-400">{activeSession.worktreePath}</span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Painel Direito: Diff Viewer (Monaco) */}
          <div className="col-span-7 flex flex-col bg-slate-950">
            <div className="h-9 border-b border-slate-800 px-4 flex items-center justify-between text-xs text-slate-400">
              <span>Revisão de Código / Diffs do Agente</span>
              {activeSession && <span>Branch: {activeSession.branch}</span>}
            </div>
            <div className="flex-1 p-2 font-mono text-xs overflow-auto bg-slate-900/30">
              {activeDiff ? (
                <pre className="p-4 text-slate-300 whitespace-pre-wrap">{activeDiff}</pre>
              ) : (
                <div className="h-full flex items-center justify-center text-slate-500">
                  Nenhuma alteração pendente ou selecione um ambiente ativo ao lado.
                </div>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
