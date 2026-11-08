"use client";

import React, { useState, useEffect } from "react";
import dynamic from "next/dynamic";
import ProjectSettingsModal from "@/components/ProjectSettingsModal";
import CliAuthModal from "@/components/CliAuthModal";
import DeleteProjectModal from "@/components/DeleteProjectModal";
import AdminUsersModal from "@/components/AdminUsersModal";
import ProjectMembersModal from "@/components/ProjectMembersModal";
import {
  KeyRound,
  ShieldCheck,
  Layers,
  Cpu,
  Users,
  Settings,
  FolderGit2,
  AlarmClock,
  FolderPlus,
  ChevronDown,
  Plus,
  X,
} from "lucide-react";
import EntryGate, { ProfileMenu, MaestriUser } from "@/components/EntryGate";
import { apiFetch } from "@/lib/api";
import { useRef } from "react";
import { Peer, PresenceProvider } from "@/lib/presence";
import RoutinesPanel from "@/components/RoutinesPanel";
import WorktreesPanel from "@/components/WorktreesPanel";
import SidebarManager from "@/components/SidebarManager";
import { ConfirmProvider } from "@/components/ConfirmProvider";
import { useProjectEvents } from "@/lib/useProjectEvents";
import { PresenceStack, PresenceToasts } from "@/components/PresenceUI";

interface Project {
  id: string;
  name: string;
  description: string;
  repoPath: string;
  createdAt: string;
  // Barra lateral: workspaces agrupados em grupos/pastas (maestri workspace move)
  group?: string | null;
  folder?: string | null;
  pinned?: boolean;
  ownerId?: string;
  access?: "owner" | "member" | "admin";
}

// Seções do seletor de projetos: fixados, raiz, pastas da raiz e grupos (com as pastas deles)
function projectSections(projects: Project[]) {
  const out: { label: string | null; items: Project[] }[] = [];
  const add = (label: string | null, items: Project[]) => items.length && out.push({ label, items });
  add("Fixados", projects.filter((p) => p.pinned));
  add(null, projects.filter((p) => !p.group && !p.folder));
  const uniq = (xs: (string | null | undefined)[]) => Array.from(new Set(xs.filter((x): x is string => !!x)));
  for (const f of uniq(projects.filter((p) => !p.group).map((p) => p.folder))) add(`📁 ${f}`, projects.filter((p) => !p.group && p.folder === f));
  for (const g of uniq(projects.map((p) => p.group))) {
    add(g, projects.filter((p) => p.group === g && !p.folder));
    for (const f of uniq(projects.filter((p) => p.group === g).map((p) => p.folder))) add(`${g} / 📁 ${f}`, projects.filter((p) => p.group === g && p.folder === f));
  }
  return out;
}

const MaestriCanvas = dynamic(() => import("@/components/MaestriCanvas"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center bg-[#080d1a] text-slate-500 font-mono text-xs">
      Carregando ambiente do projeto...
    </div>
  ),
});

const LAST_PROJECT_KEY = "maestri.lastProject";
const readLastProject = () => {
  try {
    return localStorage.getItem(LAST_PROJECT_KEY);
  } catch {
    return null;
  }
};

// Recarrega a lista de projetos quando o servidor avisa que a barra lateral mudou (CLI ou outro usuário)
function SidebarSync({ projectId, onChange }: { projectId: string; onChange: () => void }) {
  useProjectEvents(projectId, (t) => (t === "sidebar" || t === "project-deleted" || t === "access-lost") && onChange());
  return null;
}

export default function Page() {
  return (
    <EntryGate>
      {({ user, setUser, logout }) => <App user={user} setUser={setUser} logout={logout} />}
    </EntryGate>
  );
}

function App({
  user,
  setUser,
  logout,
}: {
  user: MaestriUser;
  setUser: (u: MaestriUser) => void;
  logout: () => void;
}) {
  const [activeTab, setActiveTab] = useState<"canvas" | "worktrees" | "routines">("canvas");
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [isNewProjectModalOpen, setIsNewProjectModalOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isCliAuthOpen, setIsCliAuthOpen] = useState(false);
  const [isAdminOpen, setIsAdminOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [isOrganizeOpen, setIsOrganizeOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectDesc, setNewProjectDesc] = useState("");
  const [createError, setCreateError] = useState("");

  const [diffFocus, setDiffFocus] = useState<string | null>(null);
  const [projectsError, setProjectsError] = useState("");
  const [focus, setFocus] = useState<{ x?: number; y?: number; nodeId?: string | null; nonce: number } | undefined>();

  // "Ir até": troca para o projeto da pessoa e centraliza no cursor (ou no nó ativo) dela
  const goToPeer = (peer: Peer) => {
    const target = projects.find((p) => p.id === peer.projectId);
    if (!target) return;
    setActiveTab("canvas");
    setActiveProject(target);
    setFocus({ x: peer.cursor?.x, y: peer.cursor?.y, nodeId: peer.activeNodeId, nonce: Date.now() });
  };

  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [isMembersOpen, setIsMembersOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const activeIdRef = useRef<string | null>(null);
  const quietRef = useRef(false); // perda esperada (excluí/saí do projeto): sem toast
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showNotice = (text: string) => {
    setNotice(text);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(""), 6000);
  };

  const fetchProjects = async () => {
    setProjectsError("");
    try {
      const res = await apiFetch("/api/projects");
      if (!res.ok) throw new Error(`Servidor respondeu ${res.status}`);
      const data = await res.json();
      const lost = activeIdRef.current && !data.some((p: Project) => p.id === activeIdRef.current);
      if (lost && !quietRef.current) {
        showNotice("Você não tem mais acesso a este projeto");
        setIsMembersOpen(false);
        setIsSettingsOpen(false);
      }
      quietRef.current = false;
      setProjects(data);
      setProjectsLoaded(true);
      // Mantém o projeto aberto (com os dados novos); no começo, o último aberto (ou o primeiro se ele sumiu)
      setActiveProject((prev) => {
        if (prev) return data.find((p: Project) => p.id === prev.id) ?? data[0] ?? null;
        const stored = readLastProject();
        return data.find((p: Project) => p.id === stored) ?? data[0] ?? null;
      });
    } catch (err: any) {
      setProjectsError(err?.message || "Falha de rede");
    }
  };

  // Lembra o último projeto aberto
  useEffect(() => {
    if (!activeProject) return;
    try {
      localStorage.setItem(LAST_PROJECT_KEY, activeProject.id);
    } catch {}
  }, [activeProject?.id]);

  useEffect(() => {
    activeIdRef.current = activeProject?.id ?? null;
  }, [activeProject?.id]);

  useEffect(() => {
    fetchProjects();
  }, []);

  // 404 em rota do projeto aberto: pode ser perda de acesso; confere a lista (com debounce)
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const h = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== activeIdRef.current) return;
      if (t) clearTimeout(t);
      t = setTimeout(fetchProjects, 300);
    };
    window.addEventListener("maestri:project-404", h);
    return () => {
      window.removeEventListener("maestri:project-404", h);
      if (t) clearTimeout(t);
    };
  }, []);

  // Atalho 'ver diff' dos nós de agente no canvas
  useEffect(() => {
    const h = (e: Event) => {
      setDiffFocus((e as CustomEvent<string>).detail);
      setActiveTab("worktrees");
    };
    const openRoutines = () => setActiveTab("routines");
    window.addEventListener("maestri:open-diff", h);
    window.addEventListener("maestri:open-routines", openRoutines);
    return () => {
      window.removeEventListener("maestri:open-diff", h);
      window.removeEventListener("maestri:open-routines", openRoutines);
    };
  }, []);

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProjectName.trim()) return;
    setCreateError("");

    try {
      const res = await apiFetch("/api/projects", {
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
      else setCreateError((await res.json().catch(() => ({})))?.error || `Servidor respondeu ${res.status}`);
    } catch (e: any) {
      setCreateError("Erro ao criar projeto: " + (e?.message || "servidor indisponível"));
    }
  };

  return (
    <ConfirmProvider>
    <PresenceProvider
      user={user}
      projectId={activeProject?.id ?? null}
      projectName={(id) => projects.find((p) => p.id === id)?.name || id}
    >
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

            <button
              onClick={() => setActiveTab("routines")}
              className={`p-3 rounded-xl transition ${
                activeTab === "routines"
                  ? "bg-indigo-600 text-white shadow-md shadow-indigo-600/30"
                  : "text-slate-400 hover:text-white hover:bg-slate-800/50"
              }`}
              title="Rotinas agendadas"
              aria-label="Rotinas agendadas"
            >
              <AlarmClock className="h-5 w-5" />
            </button>

            <button
              onClick={() => setIsCliAuthOpen(true)}
              className="p-3 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800/50 transition"
              title="CLIs & Logins"
              aria-label="CLIs e logins"
            >
              <KeyRound className="h-5 w-5" />
            </button>

            {user.role === "admin" && (
              <button
                onClick={() => setIsAdminOpen(true)}
                className="p-3 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800/50 transition"
                title="Usuários e acessos"
                aria-label="Usuários e acessos"
              >
                <ShieldCheck className="h-5 w-5" />
              </button>
            )}

            <button
              onClick={() => setIsSettingsOpen(true)}
              className="p-3 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800/50 transition"
              title="Configurações (Globais e do Projeto)"
            >
              <Settings className="h-5 w-5" />
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
                    {projectSections(projects).map((sec, i) => (
                      <div key={`${sec.label ?? "raiz"}-${i}`} role="group" aria-label={sec.label ?? "Projetos"}>
                        {sec.label && (
                          <div className="px-3 pt-2 pb-0.5 text-[10px] font-mono uppercase text-slate-500">{sec.label}</div>
                        )}
                        {sec.items.map((p) => (
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
                            <div className="flex items-center gap-1.5 font-medium text-slate-100">
                              <span className="truncate">{p.name}</span>
                              {p.access && (
                                <span className={`shrink-0 rounded-full px-1.5 py-px text-[9px] font-normal ${p.access === "owner" ? "bg-amber-500/15 text-amber-300" : p.access === "member" ? "bg-indigo-500/15 text-indigo-300" : "bg-slate-800 text-slate-400"}`}>
                                  {p.access === "owner" ? "dono" : p.access === "member" ? "membro" : "admin"}
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] text-slate-500 truncate">
                              {p.description || "Ambiente isolado"}
                            </div>
                          </button>
                        ))}
                      </div>
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
                    <button
                      onClick={() => {
                        setIsDropdownOpen(false);
                        setIsOrganizeOpen(true);
                      }}
                      className="w-full flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-slate-300 hover:bg-slate-900 transition font-medium"
                    >
                      <FolderPlus className="h-3.5 w-3.5" />
                      Organizar grupos e pastas
                    </button>
                    {activeProject && (
                      <button
                        onClick={() => {
                          setIsDropdownOpen(false);
                          setIsMembersOpen(true);
                        }}
                        className="w-full flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-slate-300 hover:bg-slate-900 transition font-medium"
                      >
                        <Users className="h-3.5 w-3.5" />
                        Membros…
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-3">
            <PresenceStack me={user.id} projects={projects} onGoTo={goToPeer} />
            <ProfileMenu user={user} onChange={setUser} onLogout={logout} />
            <button
              onClick={() => setIsCliAuthOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 hover:border-indigo-500 text-xs font-medium text-slate-300 hover:text-white transition"
              title="Instalar CLIs e fazer login"
            >
              <KeyRound className="h-3.5 w-3.5 text-indigo-400" />
              <span>CLIs & Logins</span>
            </button>
            <button
              onClick={() => setIsSettingsOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-800 hover:border-indigo-500 text-xs font-medium text-slate-300 hover:text-white transition"
              title="Configurações de inicialização dos agentes"
            >
              <Settings className="h-3.5 w-3.5 text-indigo-400" />
              <span>Configurações</span>
            </button>

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
              <button
                onClick={() => setActiveTab("routines")}
                className={`px-3 py-1 rounded-md font-medium transition ${
                  activeTab === "routines"
                    ? "bg-indigo-600 text-white"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                Rotinas
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
                clientId={user.id}
                focus={focus}
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
              projectsLoaded && projects.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 bg-[#080d1a] text-xs text-slate-400">
                  <p>Nenhum projeto — crie um.</p>
                  <button
                    onClick={() => setIsNewProjectModalOpen(true)}
                    className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium transition"
                  >
                    Criar projeto
                  </button>
                </div>
              ) : (
                <div className="flex h-full items-center justify-center text-xs text-slate-500 font-mono">
                  Selecione um projeto para abrir o canvas.
                </div>
              )
            )
          ) : activeTab === "routines" ? (
            activeProject ? (
              <RoutinesPanel key={activeProject.id} projectId={activeProject.id} />
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-slate-500 font-mono">
                Selecione um projeto para ver as rotinas.
              </div>
            )
          ) : activeProject ? (
            <WorktreesPanel
              key={activeProject.id}
              projectId={activeProject.id}
              repoPath={activeProject.repoPath}
              clientId={user.id}
              focusName={diffFocus}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-slate-500 font-mono">
              Selecione um projeto para ver os andares.
            </div>
          )}
        </div>
      </div>

      {activeProject && <SidebarSync projectId={activeProject.id} onChange={fetchProjects} />}
      {isOrganizeOpen && activeProject && <SidebarManager projectId={activeProject.id} projects={projects} onClose={() => setIsOrganizeOpen(false)} onChanged={fetchProjects} onDeleteProject={(p) => setDeleteTarget({ id: p.id, name: p.name })} />}
      {isMembersOpen && activeProject && (
        <ProjectMembersModal
          projectId={activeProject.id}
          projectName={activeProject.name}
          access={activeProject.access ?? "admin"}
          me={user}
          onClose={() => setIsMembersOpen(false)}
          onChanged={fetchProjects}
          onLeft={async () => {
            quietRef.current = true;
            setIsMembersOpen(false);
            showNotice("Você saiu do projeto");
            await fetchProjects();
          }}
        />
      )}
      {notice && (
        <div role="status" className="fixed left-1/2 top-4 z-[130] -translate-x-1/2 rounded-lg border border-slate-700 bg-slate-900/95 px-4 py-2 text-xs text-slate-100 shadow-xl backdrop-blur-md">
          {notice}
        </div>
      )}
      {deleteTarget && (
        <DeleteProjectModal
          projectId={deleteTarget.id}
          projectName={deleteTarget.name}
          onClose={() => setDeleteTarget(null)}
          onDeleted={async () => {
            setDeleteTarget(null);
            setIsSettingsOpen(false);
            setIsOrganizeOpen(false);
            quietRef.current = true;
            await fetchProjects(); // se o excluído era o aberto, cai no primeiro que sobrou
          }}
        />
      )}

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
              {createError && <p role="alert" className="text-xs text-rose-300 break-words">{createError}</p>}
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
      {isSettingsOpen && (
        <ProjectSettingsModal
          isOpen={isSettingsOpen}
          projectId={activeProject?.id || ""}
          projectName={activeProject?.name || "Projeto"}
          onClose={() => setIsSettingsOpen(false)}
          onDeleteProject={activeProject?.access === "member" ? undefined : () => activeProject && setDeleteTarget({ id: activeProject.id, name: activeProject.name })}
        />
      )}
      <CliAuthModal isOpen={isCliAuthOpen} onClose={() => setIsCliAuthOpen(false)} />
      {user.role === "admin" && <AdminUsersModal isOpen={isAdminOpen} onClose={() => setIsAdminOpen(false)} me={user} />}
      <PresenceToasts />
    </div>
    </PresenceProvider>
    </ConfirmProvider>
  );
}
