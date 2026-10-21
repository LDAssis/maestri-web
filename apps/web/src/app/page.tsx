"use client";

import React, { useState } from "react";
import dynamic from "next/dynamic";
import {
  Layers,
  GitBranch,
  Terminal,
  Code2,
  Cpu,
  Users,
  Settings,
  Maximize2,
  FolderGit2,
} from "lucide-react";

// Carrega dinamicamente o canvas e o editor de diff sem problemas de SSR
const MaestriCanvas = dynamic(() => import("@/components/MaestriCanvas"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center bg-[#080d1a] text-slate-500 font-mono text-xs">
      Carregando canvas de agentes...
    </div>
  ),
});

export default function App() {
  const [activeTab, setActiveTab] = useState<"canvas" | "worktrees">("canvas");
  const [activeDev, setActiveDev] = useState("Equipe Alpha (4 Agentes)");

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#080d1a] text-slate-100 font-sans">
      {/* Barra de Navegação Esquerda (Mini Dock) */}
      <nav className="w-16 border-r border-slate-800/80 bg-slate-950 flex flex-col items-center justify-between py-4 z-20">
        <div className="flex flex-col items-center gap-6">
          <div className="h-10 w-10 rounded-xl bg-gradient-to-tr from-indigo-600 to-violet-500 flex items-center justify-center font-bold text-white shadow-lg shadow-indigo-500/20">
            M
          </div>

          <div className="flex flex-col gap-3">
            <button
              onClick={() => setActiveTab("canvas")}
              className={`p-3 rounded-xl transition ${
                activeTab === "canvas"
                  ? "bg-indigo-600 text-white shadow-md shadow-indigo-600/30"
                  : "text-slate-400 hover:text-white hover:bg-slate-800/50"
              }`}
              title="Canvas de Agentes (Maestri View)"
            >
              <Cpu className="h-5 w-5" />
            </button>

            <button
              onClick={() => setActiveTab("worktrees")}
              className={`p-3 rounded-xl transition ${
                activeTab === "worktrees"
                  ? "bg-indigo-600 text-white shadow-md shadow-indigo-600/30"
                  : "text-slate-400 hover:text-white hover:bg-slate-800/50"
              }`}
              title="Worktrees & Diffs Git"
            >
              <FolderGit2 className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="flex flex-col items-center gap-3 text-slate-400">
          <button className="p-2 hover:text-white transition">
            <Users className="h-5 w-5" />
          </button>
          <button className="p-2 hover:text-white transition">
            <Settings className="h-5 w-5" />
          </button>
        </div>
      </nav>

      {/* Conteúdo Principal */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top Header */}
        <header className="h-14 border-b border-slate-800/80 px-6 flex items-center justify-between bg-slate-950/80 backdrop-blur-md z-10">
          <div className="flex items-center gap-4">
            <span className="font-semibold text-sm tracking-wide text-white">
              MAESTRI WEB
            </span>
            <span className="text-slate-600">/</span>
            <span className="text-xs font-mono text-indigo-400 bg-indigo-950/50 px-2.5 py-1 rounded-md border border-indigo-900/60">
              {activeDev}
            </span>
            <span className="text-xs text-slate-400 flex items-center gap-1.5 ml-2">
              <span className="h-2 w-2 rounded-full bg-emerald-500"></span>
              Isolamento Git Ativo
            </span>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1 bg-slate-900 border border-slate-800 rounded-lg p-1 text-xs">
              <button
                onClick={() => setActiveTab("canvas")}
                className={`px-3 py-1 rounded-md font-medium transition ${
                  activeTab === "canvas" ? "bg-indigo-600 text-white" : "text-slate-400 hover:text-white"
                }`}
              >
                Canvas & Terminais
              </button>
              <button
                onClick={() => setActiveTab("worktrees")}
                className={`px-3 py-1 rounded-md font-medium transition ${
                  activeTab === "worktrees" ? "bg-indigo-600 text-white" : "text-slate-400 hover:text-white"
                }`}
              >
                Worktrees & Diffs
              </button>
            </div>
          </div>
        </header>

        {/* View Switcher */}
        <div className="flex-1 relative overflow-hidden">
          {activeTab === "canvas" ? (
            <MaestriCanvas />
          ) : (
            <div className="h-full flex items-center justify-center p-8 text-center bg-[#080d1a]">
              <div className="max-w-md p-6 rounded-2xl border border-slate-800 bg-slate-900/60">
                <FolderGit2 className="h-10 w-10 text-indigo-400 mx-auto mb-3" />
                <h3 className="text-base font-semibold text-white mb-2">
                  Gerenciador de Worktrees Multi-Dev
                </h3>
                <p className="text-xs text-slate-400 mb-4 leading-relaxed">
                  Cada agente opera dentro de sua própria pasta clonada em paralelo (`.worktrees/agent-*`).
                  Nenhum desenvolvedor bloqueia o outro com travas de arquivo ou conflitos de branch.
                </p>
                <div className="text-xs font-mono bg-black/60 p-3 rounded-lg border border-slate-800 text-left text-slate-300">
                  <div>$ git worktree list</div>
                  <div className="text-emerald-400">&gt; main (43a5b8a)</div>
                  <div className="text-indigo-400">&gt; agent/backend-oauth</div>
                  <div className="text-purple-400">&gt; agent/frontend-oauth</div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
