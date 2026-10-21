"use client";

import React, { useState, useCallback, useMemo, useEffect } from "react";
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  addEdge,
  Connection,
  Edge,
  Node,
  BackgroundVariant,
  MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import AgentTerminalNode, { AgentNodeData } from "./AgentTerminalNode";
import StickyNoteNode, { StickyNoteData } from "./StickyNoteNode";
import PortalNode, { PortalNodeData } from "./PortalNode";
import { Plus, RefreshCw, StickyNote, Globe, Bookmark, FolderOpen, Save } from "lucide-react";

interface MaestriCanvasProps {
  projectId: string;
  projectName: string;
}

const defaultPartituraFullstack: { nodes: Node<any>[]; edges: Edge[] } = {
  nodes: [
    {
      id: "planner",
      type: "agentTerminal",
      position: { x: 440, y: 30 },
      style: { width: 460, height: 330 },
      data: {
        title: "Agente 01: Arquiteto",
        role: "Planejamento e Orquestração",
        model: "Claude 3.5 Sonnet",
        status: "running",
        branch: "main/planning",
        isMaestro: true,
        defaultCmd: "maestri context",
      },
    },
    {
      id: "specs-note",
      type: "stickyNote",
      position: { x: 40, y: 40 },
      style: { width: 280, height: 200 },
      data: {
        title: "Notas de Arquitetura",
        color: "amber",
        author: "👑 Maestro",
        content:
          "1. Autenticação via JWT + Cookies HTTP-Only\n2. Worktree isolado por dev\n3. Zero colisão de dependências\n4. Review obrigatório antes do merge",
      },
    },
    {
      id: "coder-backend",
      type: "agentTerminal",
      position: { x: 40, y: 400 },
      style: { width: 460, height: 330 },
      data: {
        title: "Agente 02: Backend Coder",
        role: "Implementação API & Banco",
        model: "Claude 3.5 Sonnet",
        status: "idle",
        branch: "agent/backend-oauth",
        defaultCmd: "echo 'Backend Coder pronto. Clique no botão [claude] para iniciar:'",
      },
    },
    {
      id: "coder-frontend",
      type: "agentTerminal",
      position: { x: 620, y: 400 },
      style: { width: 460, height: 330 },
      data: {
        title: "Agente 03: Frontend Coder",
        role: "Telas e Componentes UI",
        model: "GPT-4o",
        status: "idle",
        branch: "agent/frontend-oauth",
        defaultCmd: "echo 'Frontend Coder pronto. Clique no botão [opencode] para iniciar:'",
      },
    },
    {
      id: "portal-debug",
      type: "portal",
      position: { x: 1140, y: 400 },
      style: { width: 480, height: 330 },
      data: {
        title: "Portal Web: Live Preview",
        url: "http://localhost:3000",
      },
    },
    {
      id: "reviewer",
      type: "agentTerminal",
      position: { x: 440, y: 800 },
      style: { width: 460, height: 330 },
      data: {
        title: "Agente 04: QA & Code Reviewer",
        role: "Validação Cruzada de Diffs",
        model: "Gemini 1.5 Pro",
        status: "waiting",
        branch: "stage/review-gate",
        defaultCmd: "git status",
      },
    },
  ],
  edges: [
    {
      id: "e-note-planner",
      source: "specs-note",
      target: "planner",
      animated: true,
      label: "Diretrizes",
      style: { stroke: "#f59e0b", strokeWidth: 1.5, strokeDasharray: "4" },
      labelStyle: { fill: "#fde68a", fontSize: 10, fontWeight: 500 },
      labelBgStyle: { fill: "#0f172a", fillOpacity: 0.9 },
    },
    {
      id: "e-planner-backend",
      source: "planner",
      target: "coder-backend",
      animated: true,
      label: "Specs API & Tarefas",
      style: { stroke: "#818cf8", strokeWidth: 2 },
      labelStyle: { fill: "#cbd5e1", fontSize: 10, fontWeight: 500 },
      labelBgStyle: { fill: "#0f172a", fillOpacity: 0.9 },
      markerEnd: { type: MarkerType.ArrowClosed, color: "#818cf8" },
    },
    {
      id: "e-planner-frontend",
      source: "planner",
      target: "coder-frontend",
      animated: true,
      label: "Design Specs & Telas",
      style: { stroke: "#818cf8", strokeWidth: 2 },
      labelStyle: { fill: "#cbd5e1", fontSize: 10, fontWeight: 500 },
      labelBgStyle: { fill: "#0f172a", fillOpacity: 0.9 },
      markerEnd: { type: MarkerType.ArrowClosed, color: "#818cf8" },
    },
    {
      id: "e-frontend-portal",
      source: "coder-frontend",
      target: "portal-debug",
      animated: true,
      label: "Inspeciona DOM & Live View",
      style: { stroke: "#06b6d4", strokeWidth: 2 },
      labelStyle: { fill: "#cffafe", fontSize: 10, fontWeight: 500 },
      labelBgStyle: { fill: "#0f172a", fillOpacity: 0.9 },
      markerEnd: { type: MarkerType.ArrowClosed, color: "#06b6d4" },
    },
    {
      id: "e-backend-reviewer",
      source: "coder-backend",
      target: "reviewer",
      animated: true,
      label: "Diff PR Backend -> Review",
      style: { stroke: "#34d399", strokeWidth: 2 },
      labelStyle: { fill: "#cbd5e1", fontSize: 10, fontWeight: 500 },
      labelBgStyle: { fill: "#0f172a", fillOpacity: 0.9 },
      markerEnd: { type: MarkerType.ArrowClosed, color: "#34d399" },
    },
    {
      id: "e-frontend-reviewer",
      source: "coder-frontend",
      target: "reviewer",
      animated: true,
      label: "Diff PR Frontend -> Review",
      style: { stroke: "#34d399", strokeWidth: 2 },
      labelStyle: { fill: "#cbd5e1", fontSize: 10, fontWeight: 500 },
      labelBgStyle: { fill: "#0f172a", fillOpacity: 0.9 },
      markerEnd: { type: MarkerType.ArrowClosed, color: "#34d399" },
    },
  ],
};

export default function MaestriCanvas({ projectId, projectName }: MaestriCanvasProps) {
  const nodeTypes = useMemo(
    () => ({
      agentTerminal: AgentTerminalNode as any,
      stickyNote: StickyNoteNode as any,
      portal: PortalNode as any,
    }),
    []
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<Node<any>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [saveStatus, setSaveStatus] = useState<string>("");

  // Carrega o canvas específico deste projeto
  useEffect(() => {
    async function loadProjectCanvas() {
      try {
        const res = await fetch(`http://localhost:4000/api/projects/${projectId}/canvas`);
        if (res.ok) {
          const data = await res.json();
          if (data.nodes && data.nodes.length > 0) {
            setNodes(data.nodes);
            setEdges(data.edges || []);
            return;
          }
        }
      } catch {}

      // Fallback para Partitura padrão
      setNodes(defaultPartituraFullstack.nodes);
      setEdges(defaultPartituraFullstack.edges);
    }

    loadProjectCanvas();
  }, [projectId, setNodes, setEdges]);

  // Salva o canvas deste projeto no backend
  const saveProjectCanvas = async () => {
    setSaveStatus("Salvando...");
    try {
      await fetch(`http://localhost:4000/api/projects/${projectId}/canvas`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodes, edges }),
      });
      setSaveStatus("Salvo!");
      setTimeout(() => setSaveStatus(""), 2000);
    } catch {
      setSaveStatus("Erro ao salvar");
    }
  };

  const onConnect = useCallback(
    (params: Connection) =>
      setEdges((eds) =>
        addEdge(
          {
            ...params,
            animated: true,
            style: { stroke: "#818cf8", strokeWidth: 2 },
            markerEnd: { type: MarkerType.ArrowClosed, color: "#818cf8" },
          },
          eds
        )
      ),
    [setEdges]
  );

  const addAgent = () => {
    const newId = `agent-${Date.now().toString().slice(-4)}`;
    const newNode: Node<AgentNodeData> = {
      id: newId,
      type: "agentTerminal",
      position: { x: 450 + Math.random() * 50, y: 400 + Math.random() * 50 },
      data: {
        title: `Agente Especialista ${nodes.length + 1}`,
        role: "DevOps / Worker CLI",
        model: "Claude 3.5 Sonnet",
        status: "idle",
        branch: `agent/${newId}`,
        defaultCmd: `echo 'Agente inicializado para o projeto: ${projectName}'`,
      },
    };
    setNodes((nds) => [...nds, newNode]);
  };

  const addStickyNote = () => {
    const newId = `note-${Date.now().toString().slice(-4)}`;
    const newNode: Node<StickyNoteData> = {
      id: newId,
      type: "stickyNote",
      position: { x: 300 + Math.random() * 60, y: 200 + Math.random() * 60 },
      data: {
        title: `Nota: ${projectName}`,
        color: "amber",
        author: "Dev / Equipe",
        content: "Clique no ícone de lápis para escrever notas deste projeto.",
      },
    };
    setNodes((nds) => [...nds, newNode]);
  };

  const addPortal = () => {
    const newId = `portal-${Date.now().toString().slice(-4)}`;
    const newNode: Node<PortalNodeData> = {
      id: newId,
      type: "portal",
      position: { x: 800 + Math.random() * 60, y: 250 + Math.random() * 60 },
      data: {
        title: `Portal: ${projectName}`,
        url: "http://localhost:3000",
      },
    };
    setNodes((nds) => [...nds, newNode]);
  };

  const resetToDefault = () => {
    setNodes(defaultPartituraFullstack.nodes);
    setEdges(defaultPartituraFullstack.edges);
  };

  return (
    <div className="relative w-full h-full bg-[#0a0f1d] overflow-hidden">
      {/* Floating Toolbar do Canvas */}
      <div className="absolute top-4 left-4 z-10 flex items-center gap-2 bg-slate-900/90 border border-slate-800 rounded-xl p-2 backdrop-blur-md shadow-xl flex-wrap max-w-[calc(100vw-350px)]">
        <button
          onClick={addAgent}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition"
        >
          <Plus className="h-3.5 w-3.5" />
          Adicionar Agente
        </button>

        <button
          onClick={addStickyNote}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-medium transition"
        >
          <StickyNote className="h-3.5 w-3.5" />
          Nova Nota
        </button>

        <button
          onClick={addPortal}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-medium transition"
        >
          <Globe className="h-3.5 w-3.5" />
          Novo Portal Web
        </button>

        <div className="h-4 w-[1px] bg-slate-700 mx-1"></div>

        <button
          onClick={saveProjectCanvas}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium transition"
          title="Salvar canvas deste projeto"
        >
          <Save className="h-3.5 w-3.5" />
          {saveStatus || "Salvar no Projeto"}
        </button>

        <button
          onClick={resetToDefault}
          className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
          title="Restaurar Arranjo Padrão"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>

      {/* Badge do Projeto Ativo no Canvas */}
      <div className="absolute top-4 right-4 z-10 bg-slate-900/90 border border-slate-800 rounded-xl px-3 py-1.5 text-xs text-slate-300 font-mono flex items-center gap-2 backdrop-blur-md">
        <span className="h-2 w-2 rounded-full bg-emerald-500"></span>
        <span>Espaço Isolado: <strong className="text-white font-semibold">{projectName}</strong></span>
      </div>

      {/* Dica de interação */}
      <div className="absolute bottom-4 left-4 z-10 bg-slate-900/80 border border-slate-800/80 rounded-lg px-3 py-1.5 text-[11px] text-slate-400 backdrop-blur-sm pointer-events-none">
        💡 Cada projeto tem seus próprios agentes, terminais PTY, notas e portais web salvos de forma independente
      </div>

      {/* O Canvas Principal com React Flow */}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        nodeTypes={nodeTypes}
        fitView
        className="bg-[#080d1a]"
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={24}
          size={1.5}
          color="#334155"
        />
        <Controls className="!bg-slate-900 !border-slate-800 !fill-slate-300 !text-slate-300 rounded-lg shadow-xl" />
        <MiniMap
          nodeColor={(n) =>
            n.type === "stickyNote"
              ? "#f59e0b"
              : n.type === "portal"
              ? "#06b6d4"
              : "#6366f1"
          }
          className="!bg-slate-950/80 !border !border-slate-800 !rounded-xl overflow-hidden"
          maskColor="rgba(15, 23, 42, 0.7)"
        />
      </ReactFlow>
    </div>
  );
}
