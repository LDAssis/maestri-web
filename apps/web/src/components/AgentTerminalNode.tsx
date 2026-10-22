"use client";

import React, { useContext, useState } from "react";
import { Handle, Position, NodeResizer, useReactFlow } from "@xyflow/react";
import {
  Terminal,
  ShieldCheck,
  Cpu,
  Code2,
  MessageSquare,
  Send,
  AtSign,
  Crown,
  Sparkles,
  RotateCw,
  HelpCircle,
} from "lucide-react";
import dynamic from "next/dynamic";
import DeleteNodeButton from "./DeleteNodeButton";
import { apiFetch } from "@/lib/api";
import { ProjectIdContext } from "@/lib/projectContext";
import { usePresenceValue } from "@/lib/presence";
import type { TerminalStatus } from "./TerminalView";

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
  isMaestro?: boolean;
}

export default function AgentTerminalNode({
  id,
  data,
  selected,
}: {
  id: string;
  data: AgentNodeData;
  selected?: boolean;
}) {
  const nodeData = data;
  const [activeFace, setActiveFace] = useState<"terminal" | "chat">("terminal");
  const { updateNodeData } = useReactFlow();
  const projectId = useContext(ProjectIdContext);
  const typingLabel = usePresenceValue((s) => {
    const p = s.peers.find((x) => x.projectId === s.projectId && x.activeNodeId === id && x.activity === "typing");
    return p ? `${p.user.name} digitando…` : "";
  });
  const [showCli, setShowCli] = useState(false);
  const [termStatus, setTermStatus] = useState<TerminalStatus>("conectando");
  const isMaestro = Boolean(nodeData.isMaestro);
  const [chatInput, setChatInput] = useState("");
  const [messages, setMessages] = useState<Array<{ sender: "user" | "agent"; text: string }>>([
    {
      sender: "agent",
      text: `Olá! Sou o ${nodeData.title}. Estou ciente do meu papel no canvas do Maestri.`,
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
    if (isMaestro) {
      return <Crown className="h-4 w-4 text-amber-400" />;
    }
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
    <div
      className={`w-full h-full min-w-[360px] min-h-[260px] rounded-xl border bg-slate-900/95 shadow-2xl backdrop-blur-md overflow-hidden text-slate-100 font-sans transition flex flex-col ${
        isMaestro
          ? "border-amber-500/90 shadow-amber-500/20 ring-1 ring-amber-400/40"
          : "border-slate-700 hover:border-indigo-500"
      }`}
    >
      {/* Redimensionador Oficial do React Flow */}
      <NodeResizer
        minWidth={360}
        minHeight={260}
        isVisible={selected}
        lineClassName={isMaestro ? "!border-amber-400" : "!border-indigo-500"}
        handleClassName={
          isMaestro
            ? "!h-3 !w-3 !bg-amber-400 !border-2 !border-slate-900 !rounded"
            : "!h-3 !w-3 !bg-indigo-500 !border-2 !border-slate-900 !rounded"
        }
      />

      {/* Entrada de conexões superior */}
      <Handle
        type="target"
        position={Position.Top}
        className={`!w-3 !h-3 !border-2 !border-slate-900 ${
          isMaestro ? "!bg-amber-400" : "!bg-indigo-500"
        }`}
      />

      {/* Header do Agente */}
      <div className="px-3.5 py-2 border-b border-slate-800 bg-slate-950/90 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <div
            className={`p-1.5 rounded-lg border ${
              isMaestro
                ? "bg-amber-950/60 border-amber-600/60"
                : "bg-slate-800/80 border-slate-700"
            }`}
          >
            {getRoleIcon()}
          </div>
          <div>
            <div className="font-semibold text-xs text-slate-100 flex items-center gap-1.5">
              {nodeData.title}
              {isMaestro && (
                <span className="text-[10px] px-1.5 py-0.2 rounded bg-amber-950 text-amber-300 border border-amber-700 font-medium flex items-center gap-0.5">
                  <Crown className="h-2.5 w-2.5" /> Maestro
                </span>
              )}
            </div>
            <div className="text-[11px] text-slate-400">{nodeData.role}</div>
          </div>
        </div>

        {/* Toggle Maestro & Face Toggle */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => updateNodeData(id, { isMaestro: !isMaestro })}
            className={`p-1 rounded-md text-[10px] font-medium border transition flex items-center gap-1 ${
              isMaestro
                ? "bg-amber-500 text-slate-950 border-amber-400 font-bold"
                : "text-slate-400 hover:text-amber-300 border-slate-800 bg-slate-900"
            }`}
            title="Marcar este nó como Maestro (orquestrador com permissão para invocar agentes)"
          >
            <Crown className="h-3 w-3" />
            {isMaestro ? "Maestro" : "Tornar Maestro"}
          </button>

          <div className="flex items-center bg-slate-900 border border-slate-800 rounded-lg p-0.5 text-[11px]">
            <button
              onClick={() => setActiveFace("terminal")}
              className={`flex items-center gap-1 px-2 py-0.5 rounded transition ${
                activeFace === "terminal"
                  ? "bg-indigo-600 text-white font-medium"
                  : "text-slate-400 hover:text-white"
              }`}
              title="Ver Terminal ConPTY"
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
          <DeleteNodeButton id={id} />
        </div>
      </div>

      {/* Corpo do Nó: Terminal ou Face de Chat */}
      <div className="flex-1 w-full overflow-hidden flex flex-col min-h-0">
        {/* Terminal sempre montado (só escondido) para não matar o PTY ao ir para o Chat */}
        <div
          className={`w-full h-full flex-col min-h-0 ${
            activeFace === "terminal" ? "flex nodrag nopan" : "hidden"
          }`}
        >
          <TerminalView
            projectId={projectId}
            nodeId={id}
            onStatusChange={setTermStatus}
            cwd={nodeData.worktreePath}
            initialCmd={nodeData.defaultCmd}
          />
        </div>
        {activeFace === "chat" && (
          <div className="w-full h-full bg-[#070b16] flex flex-col justify-between p-3 min-h-0 nodrag nopan">
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
      <div className="relative px-3 py-1 bg-slate-950 border-t border-slate-800/80 flex items-center justify-between text-[10px] text-slate-400 font-mono shrink-0">
        <span className="flex items-center gap-1 text-indigo-400 truncate max-w-[200px]">
          <Terminal className="h-3 w-3" />
          {nodeData.branch || "worktree isolado"}
        </span>
        {showCli && (
          <div
            role="dialog"
            aria-label="CLI maestri"
            className="nodrag absolute bottom-full right-2 mb-1 w-72 rounded-xl border border-slate-700 bg-slate-950 p-3 text-[11px] shadow-2xl z-10 space-y-1 text-slate-300"
          >
            <div className="font-semibold text-slate-100 mb-1">CLI maestri (neste terminal)</div>
            <div><code className="text-indigo-300">maestri list</code> — nós conectados</div>
            <div><code className="text-indigo-300">maestri ask "Nome" "texto"</code> — pergunta e espera a resposta</div>
            <div><code className="text-indigo-300">maestri check "Nome"</code> — últimas linhas do terminal</div>
            <div><code className="text-indigo-300">maestri send "Nome" "texto"</code> — envia ao terminal</div>
            <div><code className="text-indigo-300">maestri note read|write|append "Nome"</code> — notas</div>
            <div><code className="text-indigo-300">maestri notify "texto"</code> — avisa todos no projeto</div>
            {isMaestro && (
              <div>
                <code className="text-amber-300">maestri recruit|dismiss "Nome"</code> — só Maestro
              </div>
            )}
          </div>
        )}
        <span className="flex items-center gap-2 text-slate-500">
          {typingLabel && <span className="text-indigo-300 truncate max-w-[140px]">{typingLabel}</span>}
          {isMaestro && "👑"}
          <span
            className={
              termStatus === "online"
                ? "text-emerald-400"
                : termStatus === "encerrada"
                ? "text-rose-400"
                : "text-amber-400"
            }
          >
            {{ conectando: "Conectando…", online: "Online", offline: "Offline", encerrada: "Sessão encerrada" }[termStatus]}
          </span>
          <button
            onClick={() =>
              apiFetch(`/api/projects/${projectId}/sessions/${id}/restart`, { method: "POST" }).catch(() => {})
            }
            className="p-0.5 rounded hover:text-white hover:bg-slate-800 transition"
            title="Reiniciar sessão"
            aria-label="Reiniciar sessão"
          >
            <RotateCw className="h-3 w-3" />
          </button>
          <button
            onClick={() => setShowCli(!showCli)}
            className="p-0.5 rounded hover:text-white hover:bg-slate-800 transition"
            title="CLI maestri"
            aria-label="CLI maestri"
            aria-expanded={showCli}
          >
            <HelpCircle className="h-3 w-3" />
          </button>
        </span>
      </div>

      {/* Saída de conexões inferior */}
      <Handle
        type="source"
        position={Position.Bottom}
        className={`!w-3 !h-3 !border-2 !border-slate-900 ${
          isMaestro ? "!bg-amber-400" : "!bg-indigo-500"
        }`}
      />
    </div>
  );
}
