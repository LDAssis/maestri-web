"use client";

import React, { useState, useCallback, useMemo } from "react";
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
import { Play, Plus, RefreshCw } from "lucide-react";

const initialNodes: Node<AgentNodeData>[] = [
  {
    id: "planner",
    type: "agentTerminal",
    position: { x: 380, y: 30 },
    data: {
      title: "Agente 01: Arquiteto (agy)",
      role: "Planejamento e Quebra de Tarefas",
      model: "Claude 3.5 Sonnet",
      status: "running",
      branch: "main/planning",
      defaultCmd: "echo 'Arquiteto pronto. Digite agy ou comando bash:'",
    },
  },
  {
    id: "coder-backend",
    type: "agentTerminal",
    position: { x: 40, y: 380 },
    data: {
      title: "Agente 02: Backend Coder (claude)",
      role: "Implementação API & Banco",
      model: "Claude 3.5 Sonnet",
      status: "idle",
      branch: "agent/backend-oauth",
      defaultCmd: "echo 'Backend Coder pronto. Clique no botão [claude] acima para iniciar:'",
    },
  },
  {
    id: "coder-frontend",
    type: "agentTerminal",
    position: { x: 720, y: 380 },
    data: {
      title: "Agente 03: Frontend Coder (opencode)",
      role: "Telas e Componentes UI",
      model: "GPT-4o",
      status: "idle",
      branch: "agent/frontend-oauth",
      defaultCmd: "echo 'Frontend Coder pronto. Clique no botão [opencode] acima para iniciar:'",
    },
  },
  {
    id: "reviewer",
    type: "agentTerminal",
    position: { x: 380, y: 740 },
    data: {
      title: "Agente 04: QA & Code Reviewer",
      role: "Validação Cruzada de Diffs",
      model: "Gemini 1.5 Pro",
      status: "waiting",
      branch: "stage/review-gate",
      defaultCmd: "git status",
    },
  },
];

const initialEdges: Edge[] = [
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
];

export default function MaestriCanvas() {
  const nodeTypes = useMemo(() => ({ agentTerminal: AgentTerminalNode as any }), []);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node<AgentNodeData>>(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

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
      position: { x: 450 + Math.random() * 50, y: 350 + Math.random() * 50 },
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

  return (
    <div className="relative w-full h-full bg-[#0a0f1d] overflow-hidden">
      {/* Floating Toolbar do Canvas */}
      <div className="absolute top-4 left-4 z-10 flex items-center gap-2 bg-slate-900/90 border border-slate-800 rounded-xl p-2 backdrop-blur-md shadow-xl">
        <button
          onClick={addAgent}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition"
        >
          <Plus className="h-3.5 w-3.5" />
          Adicionar Agente
        </button>

        <div className="h-4 w-[1px] bg-slate-700 mx-1"></div>

        <button
          onClick={() => {
            setNodes(initialNodes);
            setEdges(initialEdges);
          }}
          className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
          title="Resetar Posições"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>

      {/* Dica de interação */}
      <div className="absolute bottom-4 left-4 z-10 bg-slate-900/80 border border-slate-800/80 rounded-lg px-3 py-1.5 text-[11px] text-slate-400 backdrop-blur-sm pointer-events-none">
        💡 Terminais interativos reais: clique e digite comandos bash ou use os botões rápidos [agy], [claude], [opencode]
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
          nodeColor={() => "#6366f1"}
          className="!bg-slate-950/80 !border !border-slate-800 !rounded-xl overflow-hidden"
          maskColor="rgba(15, 23, 42, 0.7)"
        />
      </ReactFlow>
    </div>
  );
}
