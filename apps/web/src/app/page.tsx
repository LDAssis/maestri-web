"use client";

import React, { useState, useEffect } from "react";
import dynamic from "next/dynamic";
import {
  Layers,
  Cpu,
  Users,
  Settings,
  FolderGit2,
  FolderPlus,
  ChevronDown,
  Plus,
  X,
} from "lucide-react";

interface Project {
  id: string;
  name: string;
  description: string;
  repoPath: string;
  createdAt: string;
}

const MaestriCanvas = dynamic(() => import("@/components/MaestriCanvas"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center bg-[#080d1a] text-slate-500 font-mono text-xs">
      Carregando ambiente do projeto...
    </div>
  ),
});

export default function App() {
  const [activeTab, setActiveTab] = useState<"canvas" | "worktrees">("canvas");
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [isNewProjectModalOpen, setIsNewProjectModalOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectDesc, setNewProjectDesc] = useState("");

  const [projectsError, setProjectsError] = useState("");

  const fetchProjects = async () => {
    setProjectsError("");
    try {
      const res = await fetch("http://localhost:4000/api/projects");
      if (!res.ok) throw new Error(`Servidor respondeu ${res.status}`);
      const data = await res.json();
      setProjects(data);
      if (!activeProject && data.length > 0) {
        setActiveProject(data[0]);
      }
    } catch (err: any) {
      setProjectsError(err?.message || "Falha de rede");
    }
  };

  useEffect(() => {
    fetchProjects();
  }, []);

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProjectName.trim()) return;

    try {
      const res = await fetch("http://localhost:4000/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newProjectName,
          description: newProjectDesc,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        await fetchProjects();
        setActiveProject(data.project);
        setNewProjectName("");
        setNewProjectDesc("");
        setIsNewProjectModalOpen(false);
      }
    } catch (e: any) {
      alert("Erro ao criar projeto: " + e.message);
    }
  };

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
              title="Canvas & Agentes do Projeto"
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
          <button
            onClick={() => setIsNewProjectModalOpen(true)}
            className="p-2 hover:text-white transition"
            title="Novo Projeto"
          >
            <FolderPlus className="h-5 w-5" />
          </button>
        </div>
      </nav>

      {/* Conteúdo Principal */}
      <div className="flex-1 flex flex-col overflow-hidden relative">
        {/* Top Header com Seletor de Projetos */}
        <header className="h-14 border-b border-slate-800/80 px-6 flex items-center justify-between bg-slate-950/95 backdrop-blur-md relative z-50">
          <div className="flex items-center gap-4">
            <span className="font-semibold text-sm tracking-wide text-white">
              MAESTRI WEB
            </span>
            <span className="text-slate-600">/</span>

            {/* Dropdown de Projetos */}
            <div className="relative">
              <button
                onClick={() => setIsDropdownOpen(!isDropdownOpen)}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 hover:border-indigo-500 text-xs font-medium text-slate-200 transition"
              >
                <span className="h-2 w-2 rounded-full bg-emerald-500"></span>
                <span>
                  {activeProject?.name || (projectsError ? "Erro ao carregar" : "Carregando projeto...")}
                </span>
                <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
              </button>

              {isDropdownOpen && (
                <div className="absolute top-11 left-0 w-72 rounded-xl border border-slate-800 bg-slate-950 shadow-2xl py-1 z-50">
                  <div className="px-3 py-1.5 text-[10px] font-mono uppercase text-slate-500 border-b border-slate-800/80">
                    Selecione o Projeto / Ambiente
                  </div>
                  <div className="max-h-60 overflow-y-auto">
                    {projects.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => {
                          setActiveProject(p);
                          setIsDropdownOpen(false);
                        }}
                        className={`w-full text-left px-3 py-2 text-xs flex flex-col transition hover:bg-indigo-950/40 ${
                          activeProject?.id === p.id
                            ? "bg-indigo-900/30 text-indigo-300 font-medium"
                            : "text-slate-300"
                        }`}
                      >
                        <div className="font-medium text-slate-100">{p.name}</div>
                        <div className="text-[11px] text-slate-500 truncate">
                          {p.description || "Ambiente isolado"}
                        </div>
                      </button>
                    ))}
                  </div>
                  <div className="border-t border-slate-800/80 p-1">
                    <button
                      onClick={() => {
                        setIsDropdownOpen(false);
                        setIsNewProjectModalOpen(true);
                      }}
                      className="w-full flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-indigo-400 hover:bg-slate-900 transition font-medium"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Criar Novo Projeto
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1 bg-slate-900 border border-slate-800 rounded-lg p-1 text-xs">
              <button
                onClick={() => setActiveTab("canvas")}
                className={`px-3 py-1 rounded-md font-medium transition ${
                  activeTab === "canvas"
                    ? "bg-indigo-600 text-white"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                Canvas do Projeto
              </button>
              <button
                onClick={() => setActiveTab("worktrees")}
                className={`px-3 py-1 rounded-md font-medium transition ${
                  activeTab === "worktrees"
                    ? "bg-indigo-600 text-white"
                    : "text-slate-400 hover:text-white"
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
            activeProject ? (
              <MaestriCanvas
                key={activeProject.id}
                projectId={activeProject.id}
                projectName={activeProject.name}
              />
            ) : projectsError ? (
              <div
                role="alert"
                className="flex h-full flex-col items-center justify-center gap-3 bg-[#080d1a] text-xs"
              >
                <p className="text-rose-300">Não foi possível carregar os projetos: {projectsError}</p>
                <button
                  onClick={fetchProjects}
                  className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium transition"
                >
                  Tentar novamente
                </button>
              </div>
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-slate-500 font-mono">
                Selecione um projeto para abrir o canvas.
              </div>
            )
          ) : (
            <div className="h-full flex items-center justify-center p-8 text-center bg-[#080d1a]">
              <div className="max-w-md p-6 rounded-2xl border border-slate-800 bg-slate-900/60">
                <FolderGit2 className="h-10 w-10 text-indigo-400 mx-auto mb-3" />
                <h3 className="text-base font-semibold text-white mb-2">
                  Worktrees de {activeProject?.name}
                </h3>
                <p className="text-xs text-slate-400 mb-4 leading-relaxed">
                  Repositório: <span className="font-mono text-indigo-300">{activeProject?.repoPath}</span>
                </p>
                <div className="text-xs font-mono bg-black/60 p-3 rounded-lg border border-slate-800 text-left text-slate-300">
                  <div>$ git worktree list</div>
                  <div className="text-emerald-400">&gt; main (ambiente base)</div>
                  <div className="text-indigo-400">&gt; agent/{activeProject?.id}-backend</div>
                  <div className="text-purple-400">&gt; agent/{activeProject?.id}-frontend</div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Modal Criar Novo Projeto */}
      {isNewProjectModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-950 p-6 shadow-2xl">
            <div className="flex items-center justify-between pb-3 mb-4 border-b border-slate-800">
              <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                <FolderPlus className="h-4 w-4 text-indigo-400" />
                Criar Novo Projeto / Ambiente
              </h3>
              <button
                onClick={() => setIsNewProjectModalOpen(false)}
                className="text-slate-400 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleCreateProject} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Nome do Projeto
                </label>
                <input
                  type="text"
                  required
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  placeholder="ex: App Delivery Mobile"
                  className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Descrição / Objetivo
                </label>
                <textarea
                  rows={3}
                  value={newProjectDesc}
                  onChange={(e) => setNewProjectDesc(e.target.value)}
                  placeholder="Objetivos do projeto e equipe de agentes..."
                  className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setIsNewProjectModalOpen(false)}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium text-slate-400 hover:text-white hover:bg-slate-900 transition"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition"
                >
                  Criar Projeto
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
