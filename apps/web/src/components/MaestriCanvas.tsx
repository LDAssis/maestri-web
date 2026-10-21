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
import { Plus, RefreshCw, StickyNote, Globe, Bookmark, Download, FolderOpen } from "lucide-react";

// Partitura Padrão 1: Fullstack Team + Portal + Notas
const defaultPartituraFullstack: { nodes: Node<any>[]; edges: Edge[] } = {
  nodes: [
    {
      id: "planner",
      type: "agentTerminal",
      position: { x: 440, y: 30 },
      data: {
        title: "Agente 01: Arquiteto (agy)",
        role: "Planejamento e Quebra de Tarefas",
        model: "Claude 3.5 Sonnet",
        status: "running",
        branch: "main/planning",
        defaultCmd: "echo 'Arquiteto pronto. Digite agy ou comandos bash:'",
      },
    },
    {
      id: "specs-note",
      type: "stickyNote",
      position: { x: 40, y: 40 },
      data: {
        title: "Notas de Arquitetura",
        color: "amber",
        author: "Agente 01 (Arquiteto)",
        content:
          "1. Autenticação via JWT + Cookies HTTP-Only\n2. Worktree isolado por dev\n3. Zero colisão de dependências\n4. Review obrigatório antes do merge",
      },
    },
    {
      id: "coder-backend",
      type: "agentTerminal",
      position: { x: 40, y: 400 },
      data: {
        title: "Agente 02: Backend Coder (claude)",
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
      data: {
        title: "Agente 03: Frontend Coder (opencode)",
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
      data: {
        title: "Portal Web: Live Preview",
        url: "http://localhost:3000",
      },
    },
    {
      id: "reviewer",
      type: "agentTerminal",
      position: { x: 440, y: 800 },
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

export default function MaestriCanvas() {
  const nodeTypes = useMemo(
    () => ({
      agentTerminal: AgentTerminalNode as any,
      stickyNote: StickyNoteNode as any,
      portal: PortalNode as any,
    }),
    []
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<Node<any>>(defaultPartituraFullstack.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(defaultPartituraFullstack.edges);
  const [currentPartituraName, setCurrentPartituraName] = useState("Fullstack Swarm + Portal");

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
        defaultCmd: "echo 'Novo agente inicializado em worktree isolado.'",
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
        title: "Nova Nota Adesiva",
        color: "amber",
        author: "Dev / Equipe",
        content: "Clique no ícone de lápis para escrever notas de progresso, prompts ou decisões.",
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
        title: "Portal Web Adicional",
        url: "http://localhost:3000",
      },
    };
    setNodes((nds) => [...nds, newNode]);
  };

  // Salvar Partitura atual no LocalStorage
  const savePartitura = () => {
    const partituraName = prompt("Nome da Partitura:", currentPartituraName) || currentPartituraName;
    const data = { nodes, edges, name: partituraName };
    localStorage.setItem(`maestri_partitura_${partituraName}`, JSON.stringify(data));
    setCurrentPartituraName(partituraName);
    alert(`Partitura "${partituraName}" salva com sucesso!`);
  };

  // Carregar Partitura
  const loadDefaultPartitura = () => {
    setNodes(defaultPartituraFullstack.nodes);
    setEdges(defaultPartituraFullstack.edges);
    setCurrentPartituraName("Fullstack Swarm + Portal");
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

        {/* Partitura Controls */}
        <button
          onClick={savePartitura}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-medium transition"
          title="Salvar arranjo atual como Partitura"
        >
          <Bookmark className="h-3.5 w-3.5 text-indigo-400" />
          Salvar Partitura
        </button>

        <button
          onClick={loadDefaultPartitura}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-medium transition"
          title="Restaurar Partitura Padrão"
        >
          <FolderOpen className="h-3.5 w-3.5 text-cyan-400" />
          Partitura Padrão
        </button>

        <button
          onClick={loadDefaultPartitura}
          className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
          title="Resetar Posições"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>

      {/* Badge da Partitura Ativa */}
      <div className="absolute top-4 right-4 z-10 bg-slate-900/90 border border-slate-800 rounded-xl px-3 py-1.5 text-xs text-slate-300 font-mono flex items-center gap-2 backdrop-blur-md">
        <span className="h-2 w-2 rounded-full bg-indigo-500"></span>
        <span>Partitura: <strong className="text-white font-semibold">{currentPartituraName}</strong></span>
      </div>

      {/* Dica de interação */}
      <div className="absolute bottom-4 left-4 z-10 bg-slate-900/80 border border-slate-800/80 rounded-lg px-3 py-1.5 text-[11px] text-slate-400 backdrop-blur-sm pointer-events-none">
        💡 O Portal Web renderiza a página em tempo real para os agentes depurarem • Salve seu arranjo em [Salvar Partitura]
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
