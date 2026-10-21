"use client";

import React from "react";
import { Handle, Position } from "@xyflow/react";
import { Terminal, ShieldCheck, Cpu, Code2 } from "lucide-react";

export interface AgentNodeData extends Record<string, unknown> {
  title: string;
  role: string;
  model: string;
  status: "idle" | "running" | "done" | "waiting";
  logs: string[];
  lastCommand?: string;
  branch?: string;
}

export default function AgentTerminalNode({ data }: { data: AgentNodeData }) {
  const nodeData = data;

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
    <div className="w-[380px] rounded-xl border border-slate-700 bg-slate-900/95 shadow-2xl backdrop-blur-md overflow-hidden text-slate-100 font-sans transition hover:border-indigo-500">
      {/* Entrada de conexões superior */}
      <Handle
        type="target"
        position={Position.Top}
        className="!w-3 !h-3 !bg-indigo-500 !border-2 !border-slate-900"
      />

      {/* Header do Agente */}
      <div className="px-4 py-3 border-b border-slate-800 bg-slate-950/70 flex items-center justify-between">
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

        <div className="flex items-center gap-1.5">
          <span className={`h-2 w-2 rounded-full ${getStatusColor()}`}></span>
          <span className="text-[10px] font-mono capitalize text-slate-300">
            {nodeData.status}
          </span>
        </div>
      </div>

      {/* Terminal Integrado */}
      <div className="bg-black/90 p-3 font-mono text-[11px] leading-relaxed flex flex-col justify-between h-[180px]">
        {/* Terminal Header bar */}
        <div className="flex items-center justify-between text-slate-500 border-b border-slate-800/80 pb-1.5 mb-2">
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-red-500/80 inline-block"></span>
            <span className="h-2 w-2 rounded-full bg-yellow-500/80 inline-block"></span>
            <span className="h-2 w-2 rounded-full bg-green-500/80 inline-block"></span>
            <span className="ml-1 text-[10px] text-slate-400 flex items-center gap-1">
              <Terminal className="h-2.5 w-2.5" />
              {nodeData.branch || "terminal"}
            </span>
          </div>
          <span className="text-[9px] text-slate-500">sh - worktree</span>
        </div>

        {/* Logs do terminal com auto-scroll */}
        <div className="overflow-y-auto space-y-1.5 pr-1 flex-1 text-slate-300">
          {(nodeData.logs || []).map((log, i) => (
            <div key={i} className="flex items-start gap-1.5">
              <span className="text-slate-600 select-none">&gt;</span>
              <span
                className={
                  log.includes("OK") || log.includes("sucesso") || log.includes("pass")
                    ? "text-emerald-400"
                    : log.includes("exec") || log.includes("run")
                    ? "text-indigo-400"
                    : log.includes("aviso")
                    ? "text-amber-400"
                    : "text-slate-300"
                }
              >
                {log}
              </span>
            </div>
          ))}
        </div>

        {/* Linha de comando ativa */}
        <div className="mt-2 pt-1 border-t border-slate-800/80 flex items-center gap-2 text-indigo-400">
          <span className="animate-pulse">❯</span>
          <span className="text-[10px] text-slate-300 truncate">
            {nodeData.lastCommand || "aguardando instrução..."}
          </span>
        </div>
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
