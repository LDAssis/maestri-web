"use client";

import SessionAccountsSettings from "./SessionAccountsSettings";
import React, { useState, useEffect } from "react";
import { Settings, Globe, FolderGit2, Plus, Trash2, Check, X, ShieldAlert } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { CliPreset, DEFAULT_CLI_PRESETS } from "./CliConfigModal";

interface ProjectSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
  projectName: string;
  onSettingsChanged?: () => void;
}

export default function ProjectSettingsModal({
  isOpen,
  onClose,
  projectId,
  projectName,
  onSettingsChanged,
}: ProjectSettingsModalProps) {
  const [activeTab, setActiveTab] = useState<"project" | "global">("project");
  const [loading, setLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");

  // Configurações do Projeto
  const [useGlobalDefault, setUseGlobalDefault] = useState(true);
  const [projectCmd, setProjectCmd] = useState("");
  const [projectPresets, setProjectPresets] = useState<CliPreset[]>(DEFAULT_CLI_PRESETS);

  // Configurações Globais
  const [globalCmd, setGlobalCmd] = useState("echo 'Agente inicializado'");
  const [globalPresets, setGlobalPresets] = useState<CliPreset[]>(DEFAULT_CLI_PRESETS);

  // Campos para novo atalho
  const [newLabel, setNewLabel] = useState("");
  const [newCmd, setNewCmd] = useState("");

  const loadSettings = async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const response = await apiFetch(`/api/projects/${projectId}/settings`);
      const res = await response.json();
      if (res.global) {
        setGlobalCmd(res.global.defaultCmd || "");
        setGlobalPresets(res.global.cliPresets || DEFAULT_CLI_PRESETS);
      }
      if (res.project) {
        setUseGlobalDefault(false);
        setProjectCmd(res.project.defaultCmd || "");
        setProjectPresets(res.project.cliPresets || DEFAULT_CLI_PRESETS);
      } else {
        setUseGlobalDefault(true);
        setProjectCmd(res.global?.defaultCmd || "");
        setProjectPresets(res.global?.cliPresets || DEFAULT_CLI_PRESETS);
      }
    } catch (e) {
      console.warn("Falha ao carregar configurações:", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadSettings();
      setStatusMsg("");
    }
  }, [isOpen, projectId]);

  if (!isOpen) return null;

  const handleSaveProject = async () => {
    setStatusMsg("Salvando projeto...");
    try {
      if (useGlobalDefault) {
        // Remove configuração específica do projeto, voltando ao global
        const res = await apiFetch(`/api/projects/${projectId}/settings`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(null),
        });
        if (!res.ok) throw new Error(`Falha HTTP ${res.status}`);
      } else {
        const res = await apiFetch(`/api/projects/${projectId}/settings`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            defaultCmd: projectCmd,
            cliPresets: projectPresets,
          }),
        });
        if (!res.ok) throw new Error(`Falha HTTP ${res.status}`);
      }
      setStatusMsg("Configurações do projeto salvas com sucesso!");
      onSettingsChanged?.();
      setTimeout(() => setStatusMsg(""), 2500);
    } catch (e: any) {
      setStatusMsg("Erro ao salvar: " + e.message);
    }
  };

  const handleSaveGlobal = async () => {
    setStatusMsg("Salvando global...");
    try {
      const res = await apiFetch(`/api/settings/global`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          defaultCmd: globalCmd,
          cliPresets: globalPresets,
        }),
      });
      if (!res.ok) throw new Error(`Falha HTTP ${res.status}`);
      setStatusMsg("Configurações globais salvas com sucesso!");
      onSettingsChanged?.();
      setTimeout(() => setStatusMsg(""), 2500);
    } catch (e: any) {
      setStatusMsg("Erro ao salvar: " + e.message);
    }
  };

  const handleAddPresetToActive = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newLabel.trim() || !newCmd.trim()) return;
    const newId = `cli-${Date.now().toString().slice(-4)}`;
    const newPreset: CliPreset = { id: newId, label: newLabel.trim(), cmd: newCmd.trim(), color: "indigo" };

    if (activeTab === "project") {
      setProjectPresets((prev) => [...prev, newPreset]);
    } else {
      setGlobalPresets((prev) => [...prev, newPreset]);
    }
    setNewLabel("");
    setNewCmd("");
  };

  const currentPresetsList = activeTab === "project" ? projectPresets : globalPresets;
  const setPresetsList = activeTab === "project" ? setProjectPresets : setGlobalPresets;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 select-none nodrag nopan"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="w-full max-w-xl rounded-2xl border border-slate-800 bg-slate-950 p-6 shadow-2xl flex flex-col max-h-[85vh] text-slate-100 font-sans">
        {/* Header */}
        <div className="flex items-center justify-between pb-3 mb-4 border-b border-slate-800 shrink-0">
          <div className="flex items-center gap-2">
            <Settings className="h-5 w-5 text-indigo-400" />
            <h2 className="text-sm font-semibold text-white">
              Configurações de Inicialização dos Agentes & CLIs
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-900 transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Abas: Projeto vs Global */}
        <div className="flex items-center gap-2 bg-slate-900 p-1 rounded-xl border border-slate-800 mb-4 shrink-0 text-xs">
          <button
            onClick={() => setActiveTab("project")}
            className={`flex-1 flex items-center justify-center gap-2 py-1.5 px-3 rounded-lg font-medium transition ${
              activeTab === "project"
                ? "bg-indigo-600 text-white shadow-md shadow-indigo-600/30"
                : "text-slate-400 hover:text-white"
            }`}
          >
            <FolderGit2 className="h-3.5 w-3.5" />
            Projeto: {projectName}
          </button>
          <button
            onClick={() => setActiveTab("global")}
            className={`flex-1 flex items-center justify-center gap-2 py-1.5 px-3 rounded-lg font-medium transition ${
              activeTab === "global"
                ? "bg-indigo-600 text-white shadow-md shadow-indigo-600/30"
                : "text-slate-400 hover:text-white"
            }`}
          >
            <Globe className="h-3.5 w-3.5" />
            Padrão Global (Todos os Projetos)
          </button>
        </div>

        {/* Conteúdo da Aba */}
        <div className="flex-1 overflow-y-auto pr-1 space-y-4 text-xs">
          <SessionAccountsSettings projectId={projectId} />
          {activeTab === "project" ? (
            <>
              {/* Checkbox de herança global */}
              <div className="bg-slate-900/60 p-3 rounded-xl border border-slate-800 flex items-center justify-between">
                <div>
                  <div className="font-semibold text-slate-200">Usar configurações globais padrão</div>
                  <div className="text-[11px] text-slate-400">
                    Novos agentes deste projeto herdarão os comandos definidos na aba Global.
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={useGlobalDefault}
                  onChange={(e) => setUseGlobalDefault(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-700 bg-slate-950 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                />
              </div>

              {!useGlobalDefault && (
                <div className="space-y-4 pt-1">
                  <div>
                    <label className="block text-[11px] font-medium text-slate-300 mb-1">
                      Comando de Auto-Inicialização deste Projeto
                    </label>
                    <input
                      type="text"
                      value={projectCmd}
                      onChange={(e) => setProjectCmd(e.target.value)}
                      placeholder="ex: agy, claude, opencode ou script customizado"
                      className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-indigo-300 focus:outline-none focus:border-indigo-500"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-medium text-slate-300 mb-1">
                      Atalhos de CLI Rápidos deste Projeto
                    </label>
                    <div className="space-y-2 max-h-36 overflow-y-auto pr-1">
                      {projectPresets.map((preset) => (
                        <div
                          key={preset.id}
                          className="flex items-center gap-1.5 bg-slate-900 p-1.5 rounded-lg border border-slate-800"
                        >
                          <input
                            type="text"
                            value={preset.label}
                            onChange={(e) =>
                              setProjectPresets((prev) =>
                                prev.map((p) => (p.id === preset.id ? { ...p, label: e.target.value } : p))
                              )
                            }
                            className="w-20 bg-slate-950 border border-slate-800 rounded px-2 py-1 text-[11px] text-slate-200 font-semibold"
                          />
                          <input
                            type="text"
                            value={preset.cmd}
                            onChange={(e) =>
                              setProjectPresets((prev) =>
                                prev.map((p) => (p.id === preset.id ? { ...p, cmd: e.target.value } : p))
                              )
                            }
                            className="flex-1 bg-slate-950 border border-slate-800 rounded px-2 py-1 text-[11px] text-slate-300 font-mono"
                          />
                          <button
                            type="button"
                            onClick={() => setProjectPresets((prev) => prev.filter((p) => p.id !== preset.id))}
                            className="p-1 text-slate-500 hover:text-red-400"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="space-y-4">
              <div>
                <label className="block text-[11px] font-medium text-slate-300 mb-1">
                  Comando Padrão Global de Auto-Inicialização
                </label>
                <div className="text-[10px] text-slate-500 mb-1.5">
                  Aplicado automaticamente a qualquer novo projeto e novos agentes criados no canvas.
                </div>
                <input
                  type="text"
                  value={globalCmd}
                  onChange={(e) => setGlobalCmd(e.target.value)}
                  placeholder="ex: agy, claude, opencode"
                  className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-purple-300 focus:outline-none focus:border-purple-500"
                />
              </div>

              <div>
                <label className="block text-[11px] font-medium text-slate-300 mb-1">
                  Atalhos de CLI Padrão Globais
                </label>
                <div className="space-y-2 max-h-36 overflow-y-auto pr-1">
                  {globalPresets.map((preset) => (
                    <div
                      key={preset.id}
                      className="flex items-center gap-1.5 bg-slate-900 p-1.5 rounded-lg border border-slate-800"
                    >
                      <input
                        type="text"
                        value={preset.label}
                        onChange={(e) =>
                          setGlobalPresets((prev) =>
                            prev.map((p) => (p.id === preset.id ? { ...p, label: e.target.value } : p))
                          )
                        }
                        className="w-20 bg-slate-950 border border-slate-800 rounded px-2 py-1 text-[11px] text-slate-200 font-semibold"
                      />
                      <input
                        type="text"
                        value={preset.cmd}
                        onChange={(e) =>
                          setGlobalPresets((prev) =>
                            prev.map((p) => (p.id === preset.id ? { ...p, cmd: e.target.value } : p))
                          )
                        }
                        className="flex-1 bg-slate-950 border border-slate-800 rounded px-2 py-1 text-[11px] text-slate-300 font-mono"
                      />
                      <button
                        type="button"
                        onClick={() => setGlobalPresets((prev) => prev.filter((p) => p.id !== preset.id))}
                        className="p-1 text-slate-500 hover:text-red-400"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Adicionar Novo Atalho de CLI */}
          {(!useGlobalDefault || activeTab === "global") && (
            <div className="pt-2 border-t border-slate-800 flex items-center gap-2">
              <input
                type="text"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="Rótulo (ex: gemini)"
                className="w-24 bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-white"
              />
              <input
                type="text"
                value={newCmd}
                onChange={(e) => setNewCmd(e.target.value)}
                placeholder="Comando (ex: agy --resume)"
                className="flex-1 bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-white font-mono"
              />
              <button
                type="button"
                onClick={handleAddPresetToActive}
                className="p-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white"
                title="Adicionar Atalho"
              >
                <Plus className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>

        {/* Footer com Status e Botões de Salvar */}
        <div className="pt-4 border-t border-slate-800 flex items-center justify-between shrink-0">
          <span className="text-xs text-indigo-400 font-mono">{statusMsg}</span>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg text-xs font-medium text-slate-400 hover:text-white hover:bg-slate-900 transition"
            >
              Fechar
            </button>
            {activeTab === "project" ? (
              <button
                onClick={handleSaveProject}
                className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition flex items-center gap-1.5 shadow-md shadow-indigo-600/30"
              >
                <Check className="h-3.5 w-3.5" />
                Salvar para Este Projeto
              </button>
            ) : (
              <button
                onClick={handleSaveGlobal}
                className="px-4 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-medium transition flex items-center gap-1.5 shadow-md shadow-purple-600/30"
              >
                <Check className="h-3.5 w-3.5" />
                Salvar Padrão Global
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
