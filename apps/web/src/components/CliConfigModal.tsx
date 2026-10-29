"use client";

import React, { useState } from "react";
import { Settings, Plus, Trash2, Check, X, Play } from "lucide-react";
import PresetLookFields from "./PresetLookFields";
import { randomPresetLook } from "./palette";

export interface CliPreset {
  id: string;
  label: string;
  cmd: string;
  color?: string;
  icon?: string;
}

export const DEFAULT_CLI_PRESETS: CliPreset[] = [
  { id: "agy", label: "agy", cmd: "agy", color: "purple" },
  { id: "claude", label: "claude", cmd: "claude", color: "amber" },
  { id: "opencode", label: "opencode", cmd: "opencode", color: "emerald" },
];

interface CliConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  defaultCmd: string;
  cliPresets: CliPreset[];
  onSave: (newDefaultCmd: string, newPresets: CliPreset[]) => void;
  onRunNow?: (cmd: string) => void;
}

export default function CliConfigModal({
  isOpen,
  onClose,
  defaultCmd,
  cliPresets,
  onSave,
  onRunNow,
}: CliConfigModalProps) {
  const [currentDefaultCmd, setCurrentDefaultCmd] = useState(defaultCmd || "");
  const [presets, setPresets] = useState<CliPreset[]>(
    cliPresets && cliPresets.length > 0 ? cliPresets : DEFAULT_CLI_PRESETS
  );
  const [newLabel, setNewLabel] = useState("");
  const [newCmd, setNewCmd] = useState("");

  if (!isOpen) return null;

  const handleAddPreset = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newLabel.trim() || !newCmd.trim()) return;
    const newId = `cli-${Date.now().toString().slice(-4)}`;
    setPresets((prev) => [
      ...prev,
      { id: newId, label: newLabel.trim(), cmd: newCmd.trim(), ...randomPresetLook(newCmd) },
    ]);
    setNewLabel("");
    setNewCmd("");
  };

  const handleRemovePreset = (id: string) => {
    setPresets((prev) => prev.filter((p) => p.id !== id));
  };

  const handleUpdatePreset = (id: string, field: "label" | "cmd", value: string) => {
    setPresets((prev) =>
      prev.map((p) => (p.id === id ? { ...p, [field]: value } : p))
    );
  };

  const handleSaveAll = () => {
    onSave(currentDefaultCmd, presets);
    onClose();
  };

  return (
    <div
      className="absolute inset-0 z-50 bg-black/85 backdrop-blur-md p-4 flex flex-col justify-between text-slate-100 font-sans select-none nodrag nopan"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="overflow-y-auto pr-1 space-y-4">
        {/* Header do Modal */}
        <div className="flex items-center justify-between pb-2 border-b border-slate-800">
          <div className="flex items-center gap-2 text-xs font-semibold text-indigo-300">
            <Settings className="h-4 w-4" />
            <span>Personalizar Inicialização & CLIs</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-white rounded hover:bg-slate-800 transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Seção 1: Comando Default de Auto-Inicialização */}
        <div>
          <label className="block text-[11px] font-medium text-slate-300 mb-1">
            Comando de Auto-Inicialização do Nó
          </label>
          <div className="text-[10px] text-slate-500 mb-1.5">
            Executado automaticamente assim que a sessão do terminal for aberta.
          </div>
          <input
            type="text"
            value={currentDefaultCmd}
            onChange={(e) => setCurrentDefaultCmd(e.target.value)}
            placeholder="ex: agy, claude, opencode ou echo 'pronto'"
            className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-xs font-mono text-indigo-300 focus:outline-none focus:border-indigo-500"
          />

          {/* Atalhos de preenchimento rápido */}
          <div className="flex items-center gap-1.5 mt-2 text-[10px] text-slate-500 font-mono">
            <span>Sugestões:</span>
            <button
              type="button"
              onClick={() => setCurrentDefaultCmd("agy")}
              className="px-1.5 py-0.5 rounded bg-slate-900 hover:bg-slate-800 text-purple-300 border border-purple-900/50"
            >
              agy
            </button>
            <button
              type="button"
              onClick={() => setCurrentDefaultCmd("claude")}
              className="px-1.5 py-0.5 rounded bg-slate-900 hover:bg-slate-800 text-amber-300 border border-amber-900/50"
            >
              claude
            </button>
            <button
              type="button"
              onClick={() => setCurrentDefaultCmd("opencode")}
              className="px-1.5 py-0.5 rounded bg-slate-900 hover:bg-slate-800 text-emerald-300 border border-emerald-900/50"
            >
              opencode
            </button>
            <button
              type="button"
              onClick={() => setCurrentDefaultCmd("")}
              className="px-1.5 py-0.5 rounded bg-slate-900 hover:bg-slate-800 text-slate-400"
            >
              nenhum (bash limpo)
            </button>
          </div>
        </div>

        {/* Seção 2: Personalização dos Botões de CLI Rápido */}
        <div className="pt-2 border-t border-slate-800">
          <label className="block text-[11px] font-medium text-slate-300 mb-1">
            Botões do CLI Rápido
          </label>
          <div className="text-[10px] text-slate-500 mb-2">
            Personalize os comandos executados ao clicar nos botões do cabeçalho do terminal.
          </div>

          <div className="space-y-2 max-h-36 overflow-y-auto pr-1">
            {presets.map((preset) => (
              <div
                key={preset.id}
                className="flex items-center gap-1.5 bg-slate-950 p-1.5 rounded-lg border border-slate-800 text-xs"
              >
                <input
                  type="text"
                  value={preset.label}
                  onChange={(e) => handleUpdatePreset(preset.id, "label", e.target.value)}
                  className="w-20 bg-slate-900 border border-slate-800 rounded px-1.5 py-1 text-slate-200 text-[11px] font-semibold"
                  title="Rótulo do botão"
                />
                <input
                  type="text"
                  value={preset.cmd}
                  onChange={(e) => handleUpdatePreset(preset.id, "cmd", e.target.value)}
                  className="flex-1 bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-300 text-[11px] font-mono"
                  placeholder="comando CLI"
                  title="Comando disparado"
                />
                <PresetLookFields color={preset.color} icon={preset.icon} onChange={(patch) => setPresets((prev) => prev.map((p) => (p.id === preset.id ? { ...p, ...patch } : p)))} />
                {onRunNow && (
                  <button
                    type="button"
                    onClick={() => {
                      onRunNow(preset.cmd);
                      onClose();
                    }}
                    className="p-1 rounded text-emerald-400 hover:bg-emerald-950/60"
                    title="Executar agora no terminal"
                  >
                    <Play className="h-3.5 w-3.5 fill-current" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => handleRemovePreset(preset.id)}
                  className="p-1 rounded text-slate-500 hover:text-red-400"
                  title="Remover botão"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>

          {/* Adicionar Novo CLI Preset */}
          <div className="flex items-center gap-1.5 mt-2">
            <input
              type="text"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="Rótulo (ex: gemini)"
              className="w-24 bg-slate-950 border border-slate-800 rounded px-2 py-1 text-[11px] text-white"
            />
            <input
              type="text"
              value={newCmd}
              onChange={(e) => setNewCmd(e.target.value)}
              placeholder="Comando exato (ex: agy --model gemini-pro)"
              className="flex-1 bg-slate-950 border border-slate-800 rounded px-2 py-1 text-[11px] text-white font-mono"
            />
            <button
              type="button"
              onClick={handleAddPreset}
              className="p-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white"
              title="Adicionar Atalho"
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Footer com Salvar */}
      <div className="pt-3 border-t border-slate-800 flex items-center justify-end gap-2 shrink-0">
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-1 rounded text-xs text-slate-400 hover:text-white hover:bg-slate-900 transition"
        >
          Cancelar
        </button>
        <button
          type="button"
          onClick={handleSaveAll}
          className="px-4 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition flex items-center gap-1.5 shadow-md shadow-indigo-600/30"
        >
          <Check className="h-3.5 w-3.5" />
          Salvar Configurações
        </button>
      </div>
    </div>
  );
}
