"use client";

import React, { useState } from "react";
import { Handle, Position } from "@xyflow/react";
import { Terminal, ShieldCheck, Cpu, Code2, Play, ToggleLeft, ToggleRight } from "lucide-react";
import dynamic from "next/dynamic";

const TerminalView = dynamic(() => import("./TerminalView"), {
  ssr: false,
  loading: () => (
    <div className="h-[220px] flex items-center justify-center font-mono text-[11px] text-slate-500 bg-[#050811]">
      Iniciando Bash / PTY...
    </div>
  ),
});

export interface AgentNodeData extends Record<string, unknown> {
  title: string;
  role: string;
  model: string;
  status: "idle" | "running" | "done" | "waiting";
  branch?: string;
  worktreePath?: string;
  defaultCmd?: string;
}

export default function AgentTerminalNode({ data }: { data: AgentNodeData }) {
  const nodeData = data;
  const [useInteractiveBash, setUseInteractiveBash] = useState(true);

  const getStatusColor = () => {
    switch (nodeData.status) {
      case "running":
        return "bg-amber-500 animate-pulse";
      case "done":
        return "bg-emerald-500";
      case "waiting":
        return "bg-sky-500";
      default:
        return "bg-slate-500";
    }
  };

  const getRoleIcon = () => {
    if (nodeData.role?.toLowerCase().includes("arquiteto") || nodeData.role?.toLowerCase().includes("planner")) {
      return <Cpu className="h-4 w-4 text-purple-400" />;
    }
    if (nodeData.role?.toLowerCase().includes("review") || nodeData.role?.toLowerCase().includes("qa")) {
      return <ShieldCheck className="h-4 w-4 text-emerald-400" />;
    }
    return <Code2 className="h-4 w-4 text-indigo-400" />;
  };

  return (
    <div className="w-[440px] rounded-xl border border-slate-700 bg-slate-900/95 shadow-2xl backdrop-blur-md overflow-hidden text-slate-100 font-sans transition hover:border-indigo-500">
      {/* Entrada de conexões superior */}
      <Handle
        type="target"
        position={Position.Top}
        className="!w-3 !h-3 !bg-indigo-500 !border-2 !border-slate-900"
      />

      {/* Header do Agente */}
      <div className="px-4 py-2.5 border-b border-slate-800 bg-slate-950/80 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="p-1.5 rounded-lg bg-slate-800/80 border border-slate-700">
            {getRoleIcon()}
          </div>
          <div>
            <div className="font-semibold text-xs text-slate-100 flex items-center gap-1.5">
              {nodeData.title}
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 font-mono">
                {nodeData.model}
              </span>
            </div>
            <div className="text-[11px] text-slate-400">{nodeData.role}</div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${getStatusColor()}`}></span>
          <span className="text-[10px] font-mono capitalize text-slate-300">
            {nodeData.status}
          </span>
        </div>
      </div>

      {/* Terminal Interativo com suporte a agy / claude / opencode */}
      <div className="h-[230px] w-full bg-[#050811] flex flex-col">
        <TerminalView
          cwd={nodeData.worktreePath}
          initialCmd={nodeData.defaultCmd}
        />
      </div>

      {/* Footer bar */}
      <div className="px-3 py-1.5 bg-slate-950 border-t border-slate-800/80 flex items-center justify-between text-[10px] text-slate-400 font-mono">
        <span className="flex items-center gap-1 text-indigo-400">
          <Terminal className="h-3 w-3" />
          {nodeData.branch || "worktree isolado"}
        </span>
        <span className="text-slate-500">Bash PTY Conectado</span>
      </div>

      {/* Saída de conexões inferior */}
      <Handle
        type="source"
        position={Position.Bottom}
        className="!w-3 !h-3 !bg-indigo-500 !border-2 !border-slate-900"
      />
    </div>
  );
}
