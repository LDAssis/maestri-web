"use client";

import React, { useState } from "react";
import { Handle, Position, NodeResizer } from "@xyflow/react";
import {
  Terminal,
  ShieldCheck,
  Cpu,
  Code2,
  MessageSquare,
  Send,
  AtSign,
} from "lucide-react";
import dynamic from "next/dynamic";

const TerminalView = dynamic(() => import("./TerminalView"), {
  ssr: false,
  loading: () => (
    <div className="h-full flex items-center justify-center font-mono text-[11px] text-slate-500 bg-[#050811]">
      Iniciando Bash / ConPTY...
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

export default function AgentTerminalNode({
  data,
  selected,
}: {
  data: AgentNodeData;
  selected?: boolean;
}) {
  const nodeData = data;
  const [activeFace, setActiveFace] = useState<"terminal" | "chat">("terminal");
  const [chatInput, setChatInput] = useState("");
  const [messages, setMessages] = useState<Array<{ sender: "user" | "agent"; text: string }>>([
    {
      sender: "agent",
      text: `Olá! Sou o ${nodeData.title}. Aguardando comandos ou instruções via terminal/chat.`,
    },
  ]);

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

  const handleSendMessage = () => {
    if (!chatInput.trim()) return;
    const userMsg = chatInput;
    setMessages((prev) => [...prev, { sender: "user", text: userMsg }]);
    setChatInput("");

    setTimeout(() => {
      setMessages((prev) => [
        ...prev,
        {
          sender: "agent",
          text: `[Recebido]: Processando instrução no worktree '${nodeData.branch}'. Executando modificações...`,
        },
      ]);
    }, 600);
  };

  return (
    <div className="w-full h-full min-w-[360px] min-h-[260px] rounded-xl border border-slate-700 bg-slate-900/95 shadow-2xl backdrop-blur-md overflow-hidden text-slate-100 font-sans transition hover:border-indigo-500 flex flex-col">
      {/* Redimensionador Oficial do React Flow */}
      <NodeResizer
        minWidth={360}
        minHeight={260}
        isVisible={selected}
        lineClassName="!border-indigo-500"
        handleClassName="!h-3 !w-3 !bg-indigo-500 !border-2 !border-slate-900 !rounded"
      />

      {/* Entrada de conexões superior */}
      <Handle
        type="target"
        position={Position.Top}
        className="!w-3 !h-3 !bg-indigo-500 !border-2 !border-slate-900"
      />

      {/* Header do Agente */}
      <div className="px-4 py-2.5 border-b border-slate-800 bg-slate-950/80 flex items-center justify-between shrink-0">
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

        {/* Toggle Face: Terminal <-> Chat */}
        <div className="flex items-center gap-2">
          <div className="flex items-center bg-slate-900 border border-slate-800 rounded-lg p-0.5 text-[11px]">
            <button
              onClick={() => setActiveFace("terminal")}
              className={`flex items-center gap-1 px-2 py-0.5 rounded transition ${
                activeFace === "terminal"
                  ? "bg-indigo-600 text-white font-medium"
                  : "text-slate-400 hover:text-white"
              }`}
              title="Ver Terminal PTY"
            >
              <Terminal className="h-3 w-3" />
              Terminal
            </button>
            <button
              onClick={() => setActiveFace("chat")}
              className={`flex items-center gap-1 px-2 py-0.5 rounded transition ${
                activeFace === "chat"
                  ? "bg-indigo-600 text-white font-medium"
                  : "text-slate-400 hover:text-white"
              }`}
              title="Ver Face de Chat"
            >
              <MessageSquare className="h-3 w-3" />
              Chat
            </button>
          </div>

          <span className={`h-2 w-2 rounded-full ${getStatusColor()}`}></span>
        </div>
      </div>

      {/* Corpo do Nó: Terminal ou Face de Chat (Flexível para redimensionamento) */}
      <div className="flex-1 w-full overflow-hidden flex flex-col">
        {activeFace === "terminal" ? (
          <div className="w-full h-full flex flex-col">
            <TerminalView
              cwd={nodeData.worktreePath}
              initialCmd={nodeData.defaultCmd}
            />
          </div>
        ) : (
          <div className="w-full h-full bg-[#070b16] flex flex-col justify-between p-3">
            {/* Mensagens formatadas */}
            <div className="overflow-y-auto space-y-2 pr-1 flex-1 text-xs">
              {messages.map((m, i) => (
                <div
                  key={i}
                  className={`p-2.5 rounded-xl max-w-[85%] leading-relaxed ${
                    m.sender === "user"
                      ? "ml-auto bg-indigo-600 text-white"
                      : "bg-slate-900 border border-slate-800 text-slate-200"
                  }`}
                >
                  {m.text}
                </div>
              ))}
            </div>

            {/* Prompt Composer com @ mention */}
            <div className="mt-2 pt-2 border-t border-slate-800 flex items-center gap-2 shrink-0">
              <button
                onClick={() => setChatInput((prev) => prev + "@nota ")}
                className="p-1 rounded text-slate-400 hover:text-indigo-400 hover:bg-slate-800"
                title="Mencionar Nota ou Terminal (@)"
              >
                <AtSign className="h-3.5 w-3.5" />
              </button>
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSendMessage()}
                placeholder="Digite instrução ou @ para mencionar..."
                className="flex-1 bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1 text-xs focus:outline-none focus:border-indigo-500"
              />
              <button
                onClick={handleSendMessage}
                className="p-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition"
              >
                <Send className="h-3 w-3" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Footer bar */}
      <div className="px-3 py-1.5 bg-slate-950 border-t border-slate-800/80 flex items-center justify-between text-[10px] text-slate-400 font-mono shrink-0">
        <span className="flex items-center gap-1 text-indigo-400">
          <Terminal className="h-3 w-3" />
          {nodeData.branch || "worktree isolado"}
        </span>
        <span className="text-slate-500">
          {activeFace === "terminal" ? "ConPTY Conectado" : "Face de Chat Ativa"}
        </span>
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
