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
    position: { x: 350, y: 30 },
    data: {
      title: "Agente 01: Arquiteto",
      role: "Planejamento e Quebra de Tarefas",
      model: "Claude 3.5 Sonnet",
      status: "done",
      branch: "main/planning",
      lastCommand: "gerando sub-tarefas para os coders",
      logs: [
        "Lendo requisitos do projeto...",
        "Analisando arquivos existentes no repo",
        "Especificação OpenAPI definida",
        "Sub-tarefas distribuídas para Coder 1 e Coder 2 [OK]",
      ],
    },
  },
  {
    id: "coder-backend",
    type: "agentTerminal",
    position: { x: 80, y: 330 },
    data: {
      title: "Agente 02: Backend Coder",
      role: "Implementação Fastify / Worktree 1",
      model: "Claude 3.5 Sonnet",
      status: "running",
      branch: "agent/worktree-backend",
      lastCommand: "npm run test -- auth.spec.ts",
      logs: [
        "Criou branch isolada 'agent/backend-oauth'",
        "Criou rotas em apps/server/src/auth.ts",
        "Executando migração de schema...",
        "Testes unitários passando (4/4)",
      ],
    },
  },
  {
    id: "coder-frontend",
    type: "agentTerminal",
    position: { x: 620, y: 330 },
    data: {
      title: "Agente 03: Frontend Coder",
      role: "Telas e Componentes / Worktree 2",
      model: "GPT-4o",
      status: "running",
      branch: "agent/worktree-frontend",
      lastCommand: "npx tailwindcss -i src/input.css",
      logs: [
        "Branch isolada 'agent/frontend-oauth' pronta",
        "Construindo tela de login OAuth",
        "Consumindo endpoints do backend",
        "Layout responsivo validado [OK]",
      ],
    },
  },
  {
    id: "reviewer",
    type: "agentTerminal",
    position: { x: 350, y: 640 },
    data: {
      title: "Agente 04: QA & Code Reviewer",
      role: "Validação Cruzada e Testes E2E",
      model: "Gemini 1.5 Pro",
      status: "waiting",
      branch: "stage/review-gate",
      lastCommand: "aguardando conclusão dos coders",
      logs: [
        "Pronto para receber diffs dos dois worktrees",
        "Avaliando cobertura de testes",
        "Verificação de vulnerabilidades agendada",
      ],
    },
  },
];

const initialEdges: Edge[] = [
  {
    id: "e-planner-backend",
    source: "planner",
    target: "coder-backend",
    animated: true,
    label: "Specs API & Tarefa Backend",
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
        role: "DevOps / Worker sob demanda",
        model: "Claude 3.5 Sonnet",
        status: "idle",
        branch: `agent/${newId}`,
        lastCommand: "aguardando conexão no canvas",
        logs: ["Ambiente isolado criado", "Aguardando pipeline"],
      },
    };
    setNodes((nds) => [...nds, newNode]);
  };

  const simulateStep = () => {
    setNodes((nds) =>
      nds.map((node) => {
        if (node.id === "coder-backend") {
          return {
            ...node,
            data: {
              ...node.data,
              status: "done",
              logs: [...node.data.logs, "Git commit realizado", "PR #102 aberto [OK]"],
              lastCommand: "git push origin agent/backend-oauth",
            },
          };
        }
        if (node.id === "reviewer") {
          return {
            ...node,
            data: {
              ...node.data,
              status: "running",
              logs: [
                ...node.data.logs,
                "Recebido PR #102 do Backend Coder",
                "Rodando testes de integração no worktree...",
                "Zero conflitos de merge detectados [OK]",
              ],
              lastCommand: "npm run test:e2e",
            },
          };
        }
        return node;
      })
    );
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

        <button
          onClick={simulateStep}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium transition"
        >
          <Play className="h-3.5 w-3.5 fill-current" />
          Disparar Fluxo em Equipe
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
        💡 Arraste os terminais para organizar • Conecte os círculos azuis para criar fluxos de comunicação
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
