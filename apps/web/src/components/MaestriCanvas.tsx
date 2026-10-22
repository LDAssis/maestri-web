"use client";

import React, { useState, useCallback, useMemo, useEffect, useRef } from "react";
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
  NodeChange,
  EdgeChange,
  Node,
  BackgroundVariant,
  MarkerType,
  Viewport,
  ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { wsUrl } from "@/lib/api";
import { ProjectIdContext } from "@/lib/projectContext";
import { usePresenceStore } from "@/lib/presence";
import { PresenceLayer } from "./PresenceUI";
import AgentTerminalNode, { AgentNodeData } from "./AgentTerminalNode";
import StickyNoteNode, { StickyNoteData } from "./StickyNoteNode";
import NoteStackNode from "./NoteStackNode";
import BandNode from "./BandNode";
import { CanvasOpsContext } from "@/lib/canvasOps";
import PortalNode, { PortalNodeData } from "./PortalNode";
import {
  instantiatePartitura,
  MAX_PARTITURA_BYTES,
  parsePartitura,
  partituraBounds,
  partituraFileName,
  serializePartitura,
} from "@/lib/partitura";
import FileTreeNode, { FileTreeNodeData } from "./FileTreeNode";
import DiffNode, { DiffNodeData } from "./DiffNode";
import NewAgentSheet from "./NewAgentSheet";
import RolesPanel from "./RolesPanel";
import { CommandPalette, ContextMenu, ShortcutsHelp, MenuState } from "./CanvasOverlays";
import { Download, Upload, Plus, UserCog, RefreshCw, StickyNote, Globe, FolderTree, FileDiff, Bell } from "lucide-react";

interface MaestriCanvasProps {
  projectId: string;
  projectName: string;
  clientId: string;
  focus?: { x?: number; y?: number; nodeId?: string | null; nonce: number };
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
        url: "",
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

type CanvasOp =
  | { kind: "upsertNodes"; nodes: (Partial<Node<any>> & { id: string })[] }
  | { kind: "removeNodes"; ids: string[] }
  | { kind: "patchNodeData"; id: string; data: Record<string, unknown> }
  | { kind: "upsertEdges"; edges: Edge[] }
  | { kind: "removeEdges"; ids: string[] }
  | { kind: "replace"; nodes: Node<any>[]; edges: Edge[] };

type ConnState = "connecting" | "online" | "reconnecting";

// Remove campos transitórios (o servidor também remove, mas evita tráfego inútil)
const stripNode = ({ selected, dragging, measured, resizing, ...rest }: any) => rest;
const stripEdge = ({ selected, ...rest }: any) => rest;

const viewportKey = (projectId: string) => `maestri.viewport.${projectId}`;
const readViewport = (projectId: string): Viewport | undefined => {
  try {
    return JSON.parse(localStorage.getItem(viewportKey(projectId)) || "null") || undefined;
  } catch {
    return undefined;
  }
};

export default function MaestriCanvas({ projectId, projectName, clientId, focus }: MaestriCanvasProps) {
  const presence = usePresenceStore();
  const nodeTypes = useMemo(
    () => ({
      agentTerminal: AgentTerminalNode as any,
      stickyNote: StickyNoteNode as any,
      noteStack: NoteStackNode as any,
      band: BandNode as any,
      portal: PortalNode as any,
      fileTree: FileTreeNode as any,
      diff: DiffNode as any,
    }),
    []
  );

  const [nodes, setNodes, onNodesChangeBase] = useNodesState<Node<any>>([]);
  const [edges, setEdges, onEdgesChangeBase] = useEdgesState<Edge>([]);
  // Notas guardadas em fichário (data.stackId) ficam escondidas no canvas, qualquer que seja o flag hidden
  const displayNodes = useMemo(
    () => nodes.map((n) => (Boolean((n.data as any)?.stackId) !== Boolean(n.hidden) ? { ...n, hidden: Boolean((n.data as any)?.stackId) } : n)),
    [nodes],
  );
  const [loadState, setLoadState] = useState<"loading" | "ready">("loading");
  const [connState, setConnState] = useState<ConnState>("connecting");
  const [initialViewport] = useState<Viewport | undefined>(() => readViewport(projectId));
  const containerRef = useRef<HTMLDivElement>(null);
  const flowRef = useRef<ReactFlowInstance | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const nodesRef = useRef<Node<any>[]>([]);
  const edgesRef = useRef<Edge[]>([]);
  nodesRef.current = nodes;
  edgesRef.current = edges;

  // Títulos dos nós para o painel de presença ("digitando no Agente 01")
  useEffect(() => {
    presence.setNodeTitles(Object.fromEntries(nodes.map((n) => [n.id, String(n.data?.title ?? n.id)])));
  }, [nodes, presence]);

  useEffect(() => () => presence.sendCursor(null), [presence]);

  // "Ir até": centraliza no cursor (ou no nó ativo) da pessoa, uma vez por pedido
  const focusedRef = useRef(0);
  useEffect(() => {
    if (!focus || loadState !== "ready" || focusedRef.current === focus.nonce) return;
    focusedRef.current = focus.nonce;
    const t = setTimeout(() => {
      const flow = flowRef.current;
      if (!flow) return;
      let target = focus.x !== undefined && focus.y !== undefined ? { x: focus.x, y: focus.y } : null;
      const node = focus.nodeId ? nodesRef.current.find((n) => n.id === focus.nodeId) : undefined;
      if (!target && node) {
        target = {
          x: node.position.x + Number(node.measured?.width ?? node.width ?? node.style?.width ?? 300) / 2,
          y: node.position.y + Number(node.measured?.height ?? node.height ?? node.style?.height ?? 200) / 2,
        };
      }
      if (target) flow.setCenter(target.x, target.y, { zoom: flow.getZoom(), duration: 400 });
    }, 350);
    return () => clearTimeout(t);
  }, [focus, loadState]);

  // Notificações do CLI (maestri notify): toast por 6s, clicável para centralizar no nó emissor
  const [notifications, setNotifications] = useState<{ id: number; nodeId: string; title: string; text: string }[]>([]);
  const notifySeqRef = useRef(0);
  const pushNotification = useCallback((from: { nodeId: string; title: string }, text: string) => {
    const id = ++notifySeqRef.current;
    setNotifications((list) => [...list, { id, nodeId: from.nodeId, title: from.title, text }]);
    setTimeout(() => setNotifications((list) => list.filter((n) => n.id !== id)), 6000);
  }, []);
  const centerOnNode = (nodeId: string) => {
    const node = nodesRef.current.find((n) => n.id === nodeId);
    if (!node) return;
    flowRef.current?.setCenter(
      node.position.x + Number(node.measured?.width ?? node.width ?? node.style?.width ?? 300) / 2,
      node.position.y + Number(node.measured?.height ?? node.height ?? node.style?.height ?? 200) / 2,
      { zoom: flowRef.current.getZoom(), duration: 400 }
    );
  };

  const sendOp = useCallback((op: CanvasOp) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "op", op }));
  }, []);

  // Aplica op recebida de outro cliente (sem reemitir)
  const applyRemoteOp = useCallback(
    (op: CanvasOp) => {
      switch (op.kind) {
        case "upsertNodes":
          setNodes((nds) => {
            const byId = new Map(op.nodes.map((n) => [n.id, n]));
            const merged = nds.map((n) => (byId.has(n.id) ? { ...n, ...byId.get(n.id)! } : n));
            const known = new Set(nds.map((n) => n.id));
            return [...merged, ...(op.nodes.filter((n) => n.position && !known.has(n.id)) as Node<any>[])];
          });
          break;
        case "removeNodes": {
          const ids = new Set(op.ids);
          setNodes((nds) => nds.filter((n) => !ids.has(n.id)));
          setEdges((eds) => eds.filter((e) => !ids.has(e.source) && !ids.has(e.target)));
          break;
        }
        case "patchNodeData":
          setNodes((nds) =>
            nds.map((n) => (n.id === op.id ? { ...n, data: { ...n.data, ...op.data } } : n))
          );
          break;
        case "upsertEdges":
          setEdges((eds) => {
            const byId = new Map(op.edges.map((e) => [e.id, e]));
            const merged = eds.map((e) => (byId.has(e.id) ? { ...e, ...byId.get(e.id)! } : e));
            const known = new Set(eds.map((e) => e.id));
            return [...merged, ...op.edges.filter((e) => !known.has(e.id))];
          });
          break;
        case "removeEdges": {
          const ids = new Set(op.ids);
          setEdges((eds) => eds.filter((e) => !ids.has(e.id)));
          break;
        }
        case "replace":
          setNodes(op.nodes);
          setEdges(op.edges);
          break;
      }
    },
    [setNodes, setEdges]
  );

  // Conexão em tempo real com o projeto (reconecta com backoff; o snapshot substitui o estado local)
  useEffect(() => {
    let closed = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      const ws = new WebSocket(wsUrl(`/ws/project/${projectId}`, { clientId }));
      wsRef.current = ws;

      ws.onopen = () => {
        attempt = 0;
        setConnState("online");
      };

      ws.onmessage = (event) => {
        let msg: any;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        if (msg.type === "snapshot") {
          if (msg.nodes == null) {
            // Projeto novo ou sem canvas salvo: inicia 100% zerado
            setNodes([]);
            setEdges([]);
            sendOp({ kind: "replace", nodes: [], edges: [] });
          } else {
            setNodes(msg.nodes);
            setEdges(msg.edges || []);
          }
          setLoadState("ready");
        } else if (msg.type === "op") {
          applyRemoteOp(msg.op);
        } else if (msg.type === "notify") {
          pushNotification(msg.from, String(msg.text ?? ""));
        } else if (msg.type === "error") {
          console.warn("Op recusada pelo servidor:", msg.error);
        }
      };

      ws.onclose = () => {
        if (closed) return;
        setConnState("reconnecting");
        timer = setTimeout(connect, Math.min(1000 * 2 ** attempt, 10000));
        attempt++;
      };
    };

    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [projectId, clientId, setNodes, setEdges, sendOp, applyRemoteOp, pushNotification]);

  // Arrasto/resize saem como upsertNodes parciais ({id, position} / {id, width, height, style}) com throttle de 60ms
  const pendingUpsertRef = useRef<Map<string, { pos?: boolean; size?: boolean }>>(new Map());
  const upsertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queueUpsert = useCallback(
    (id: string, field: "pos" | "size") => {
      pendingUpsertRef.current.set(id, { ...pendingUpsertRef.current.get(id), [field]: true });
      if (upsertTimerRef.current) return;
      upsertTimerRef.current = setTimeout(() => {
        upsertTimerRef.current = null;
        const pending = pendingUpsertRef.current;
        pendingUpsertRef.current = new Map();
        const changed = nodesRef.current.filter((n) => pending.has(n.id)).map((n) => {
          const f = pending.get(n.id)!;
          return {
            id: n.id,
            ...(f.pos ? { position: n.position } : {}),
            ...(f.size ? { width: n.width, height: n.height, style: n.style } : {}),
          };
        });
        if (changed.length) sendOp({ kind: "upsertNodes", nodes: changed });
      }, 60);
    },
    [sendOp]
  );

  // Mudanças de data (updateNodeData dos nós) chegam como 'replace': vira patchNodeData com debounce de 300ms
  const pendingPatchRef = useRef<Map<string, Record<string, unknown>>>(new Map());
  const patchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queuePatch = useCallback(
    (id: string, data: Record<string, unknown>) => {
      pendingPatchRef.current.set(id, { ...pendingPatchRef.current.get(id), ...data });
      if (patchTimerRef.current) clearTimeout(patchTimerRef.current);
      patchTimerRef.current = setTimeout(() => {
        patchTimerRef.current = null;
        const patches = pendingPatchRef.current;
        pendingPatchRef.current = new Map();
        patches.forEach((data, id) => sendOp({ kind: "patchNodeData", id, data }));
      }, 300);
    },
    [sendOp]
  );

  useEffect(
    () => () => {
      if (upsertTimerRef.current) clearTimeout(upsertTimerRef.current);
      if (patchTimerRef.current) clearTimeout(patchTimerRef.current);
    },
    []
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<Node<any>>[]) => {
      onNodesChangeBase(changes);
      const removed: string[] = [];
      for (const c of changes) {
        if (c.type === "position") {
          queueUpsert(c.id, "pos");
        } else if (c.type === "dimensions" && c.resizing === false) {
          queueUpsert(c.id, "size");
        } else if (c.type === "remove") {
          removed.push(c.id);
        } else if (c.type === "replace") {
          const prev = nodesRef.current.find((n) => n.id === c.id);
          if (!prev) continue;
          const diff: Record<string, unknown> = {};
          for (const k of Object.keys(c.item.data || {})) {
            if (c.item.data[k] !== (prev.data as any)?.[k]) diff[k] = c.item.data[k];
          }
          if (Object.keys(diff).length) queuePatch(c.id, diff);
        }
      }
      if (removed.length) sendOp({ kind: "removeNodes", ids: removed });
    },
    [onNodesChangeBase, queueUpsert, queuePatch, sendOp]
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]) => {
      onEdgesChangeBase(changes);
      const removed = changes.filter((c) => c.type === "remove").map((c) => c.id);
      if (removed.length) sendOp({ kind: "removeEdges", ids: removed });
    },
    [onEdgesChangeBase, sendOp]
  );

  const onConnect = useCallback(
    (params: Connection) => {
      const edge: Edge = {
        ...addEdge<Edge>(params, [])[0],
        animated: true,
        style: { stroke: "#818cf8", strokeWidth: 2 },
        markerEnd: { type: MarkerType.ArrowClosed, color: "#818cf8" },
      };
      if (edgesRef.current.some((e) => e.id === edge.id)) return;
      setEdges((eds) => addEdge(edge, eds));
      sendOp({ kind: "upsertEdges", edges: [edge] });
    },
    [setEdges, sendOp]
  );

  // Centro da viewport atual (nó centralizado), deslocado em passos de 40px até não sobrepor outro nó
  const getSpawnPosition = (w: number, h: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    const flow = flowRef.current;
    if (!rect || !flow) return { x: 300, y: 200 };
    const c = flow.screenToFlowPosition({
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    });
    const size = (n: Node<any>) => ({
      w: Number(n.measured?.width ?? n.style?.width ?? 300) || 300,
      h: Number(n.measured?.height ?? n.style?.height ?? 200) || 200,
    });
    let pos = { x: c.x - w / 2, y: c.y - h / 2 };
    // Empurra para a direita do nó que cobre a posição até achar espaço livre (x só cresce, então termina)
    for (;;) {
      const { x, y } = pos;
      const hit = nodes.find((n) => {
        const s = size(n);
        return x < n.position.x + s.w && x + w > n.position.x && y < n.position.y + s.h && y + h > n.position.y;
      });
      if (!hit) return pos;
      pos = { x: hit.position.x + size(hit).w + 40, y };
    }
  };

  // Criação de agente passa pela folha (preset/role/andar); a posição vem do clique ou do centro da viewport
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [rolesOpen, setRolesOpen] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [agentSheet, setAgentSheet] = useState<{ at: { x: number; y: number } } | null>(null);

  const addAgent = (at?: { x: number; y: number }) => {
    setMenu(null);
    setPaletteOpen(false);
    setAgentSheet({ at: at ?? getSpawnPosition(460, 330) });
  };

  const addStickyNote = (at?: { x: number; y: number }) => {
    const newId = `note-${Date.now().toString().slice(-4)}`;
    const newNode: Node<StickyNoteData> = {
      id: newId,
      type: "stickyNote",
      position: at ?? getSpawnPosition(280, 200),
      style: { width: 280, height: 200 },
      data: {
        title: `Nota: ${projectName}`,
        color: "amber",
        author: "Dev / Equipe",
        content: "Clique no ícone de lápis para escrever notas deste projeto.",
      },
    };
    setNodes((nds) => [...nds, newNode]);
    sendOp({ kind: "upsertNodes", nodes: [newNode] });
  };

  const addPortal = (at?: { x: number; y: number }) => {
    const newId = `portal-${Date.now().toString().slice(-4)}`;
    const newNode: Node<PortalNodeData> = {
      id: newId,
      type: "portal",
      position: at ?? getSpawnPosition(480, 330),
      style: { width: 480, height: 330 },
      data: {
        title: `Portal: ${projectName}`,
        url: "",
      },
    };
    setNodes((nds) => [...nds, newNode]);
    sendOp({ kind: "upsertNodes", nodes: [newNode] });
  };

  const [helpOpen, setHelpOpen] = useState(false);

  const selectNode = (id: string) => {
    setNodes((nds) => nds.map((n) => (n.selected === (n.id === id) ? n : { ...n, selected: n.id === id })));
    centerOnNode(id);
  };

  const duplicateNode = (id: string) => {
    const src = nodesRef.current.find((n) => n.id === id);
    if (!src) return;
    const {
      chat, chatBusy, worktree, branch, worktreePath, ...data
    } = (src.data || {}) as Record<string, unknown>;
    const prefix = ({ agentTerminal: "agent", stickyNote: "note", noteStack: "stack", band: "band", fileTree: "files", diff: "diff" } as Record<string, string>)[String(src.type)] ?? "portal";
    const copy: Node<any> = {
      id: `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      type: src.type,
      position: { x: src.position.x + 40, y: src.position.y + 40 },
      style: src.style,
      data,
      selected: true,
    };
    setNodes((nds) => [...nds.map((n) => (n.selected ? { ...n, selected: false } : n)), copy]);
    sendOp({ kind: "upsertNodes", nodes: [{ ...copy, selected: undefined }] });
  };

  // Partitura: exporta a seleção (ou só o nó clicado no menu; sem seleção, o canvas todo)
  const exportPartitura = (onlyId?: string) => {
    const all = nodesRef.current;
    const selected = all.filter((n) => n.selected);
    const picked = onlyId && !selected.some((n) => n.id === onlyId) ? all.filter((n) => n.id === onlyId) : selected.length ? selected : all;
    const partitura = serializePartitura(projectName, picked, edgesRef.current);
    const url = URL.createObjectURL(new Blob([JSON.stringify(partitura, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = partituraFileName(projectName);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importError, setImportError] = useState("");
  const openImport = () => {
    setImportError("");
    fileInputRef.current?.click();
  };
  const importFile = async (file: File) => {
    if (file.size > MAX_PARTITURA_BYTES) return setImportError("Arquivo maior que 2 MB.");
    const result = parsePartitura(await file.text());
    if (!result.ok) return setImportError(result.error);
    if (result.partitura.nodes.length === 0) return setImportError("A partitura não tem nós.");
    const { width, height } = partituraBounds(result.partitura);
    const origin = getSpawnPosition(width, height);
    const { nodes: added, edges: addedEdges } = instantiatePartitura(result.partitura, origin, nodesRef.current.map((n) => n.id));
    setNodes((nds) => [...nds.map((n) => (n.selected ? { ...n, selected: false } : n)), ...(added as Node<any>[])]);
    if (addedEdges.length) setEdges((eds) => [...eds, ...(addedEdges as Edge[])]);
    sendOp({ kind: "upsertNodes", nodes: added.map(({ selected: _s, ...n }: { selected?: boolean }) => n) as any });
    if (addedEdges.length) sendOp({ kind: "upsertEdges", edges: addedEdges as any });
    setImportError("");
  };

  // Atalhos globais (ignorados em campos editáveis e no xterm)
  const shortcutsRef = useRef({ addAgent, addStickyNote, addPortal, exportPartitura, openImport });
  shortcutsRef.current = { addAgent, addStickyNote, addPortal, exportPartitura, openImport };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.(".xterm")) return;
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setMenu(null);
        setPaletteOpen(true);
        return;
      }
      const editable = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      const blocked = () => editable || document.querySelector("[role=dialog][aria-modal=true], [role=menu]");
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key.toLowerCase() === "e" || e.key.toLowerCase() === "i")) {
        if (blocked()) return;
        e.preventDefault();
        if (e.key.toLowerCase() === "e") shortcutsRef.current.exportPartitura();
        else shortcutsRef.current.openImport();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (blocked()) return;
      const k = e.key.toLowerCase();
      if (k === "a") shortcutsRef.current.addAgent();
      else if (k === "n") shortcutsRef.current.addStickyNote();
      else if (k === "p") shortcutsRef.current.addPortal();
      else if (k === "f") flowRef.current?.fitView({ duration: 300 });
      else if (e.key === "?") setHelpOpen(true);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const addFileTree = (at?: { x: number; y: number }) => {
    const newNode: Node<FileTreeNodeData> = {
      id: `files-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      type: "fileTree",
      position: at ?? getSpawnPosition(320, 420),
      style: { width: 320, height: 420 },
      data: { title: "Arquivos", root: "main" },
    };
    setNodes((nds) => [...nds, newNode]);
    sendOp({ kind: "upsertNodes", nodes: [newNode] });
  };

  const addDiff = (at?: { x: number; y: number }) => {
    const newNode: Node<DiffNodeData> = {
      id: `diff-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      type: "diff",
      position: at ?? getSpawnPosition(520, 380),
      style: { width: 520, height: 380 },
      data: { title: "Diff", worktree: "" },
    };
    setNodes((nds) => [...nds, newNode]);
    sendOp({ kind: "upsertNodes", nodes: [newNode] });
  };

  const resetToDefault = () => {
    if (!window.confirm("Restaurar o arranjo padrão? Isso substitui o canvas para todos os usuários.")) return;
    applyRemoteOp({ kind: "replace", ...defaultPartituraFullstack });
    sendOp({ kind: "replace", ...defaultPartituraFullstack });
  };

  return (
    <div ref={containerRef} className="relative w-full h-full bg-[#0a0f1d] overflow-hidden">
      {/* Floating Toolbar do Canvas */}
      <div className="absolute top-4 left-4 z-10 flex items-center gap-2 bg-slate-900/90 border border-slate-800 rounded-xl p-2 backdrop-blur-md shadow-xl flex-wrap max-w-[calc(100vw-350px)]">
        <button
          onClick={() => addAgent()}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition"
        >
          <Plus className="h-3.5 w-3.5" />
          Adicionar Agente
        </button>

        <button
          onClick={() => addStickyNote()}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-medium transition"
        >
          <StickyNote className="h-3.5 w-3.5" />
          Nova Nota
        </button>

        <button
          onClick={() => addPortal()}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-medium transition"
        >
          <Globe className="h-3.5 w-3.5" />
          Novo Portal Web
        </button>

        <button
          onClick={() => addFileTree()}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-medium transition"
        >
          <FolderTree className="h-3.5 w-3.5" />
          Arquivos
        </button>

        <button
          onClick={() => addDiff()}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-purple-700 hover:bg-purple-600 text-white text-xs font-medium transition"
        >
          <FileDiff className="h-3.5 w-3.5" />
          Diff
        </button>

        <button
          onClick={() => exportPartitura()}
          className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
          title="Exportar partitura (seleção ou canvas todo) — Ctrl+E"
          aria-label="Exportar partitura"
        >
          <Download className="h-4 w-4" />
        </button>
        <button
          onClick={openImport}
          className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
          title="Importar partitura — Ctrl+I"
          aria-label="Importar partitura"
        >
          <Upload className="h-4 w-4" />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          aria-hidden
          tabIndex={-1}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) importFile(f);
          }}
        />

        <button
          onClick={() => setRolesOpen(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-100 text-xs font-medium transition"
        >
          <UserCog className="h-3.5 w-3.5" />
          Roles
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
        <span
          className={`h-2 w-2 rounded-full ${connState === "online" ? "bg-emerald-500" : "bg-amber-500 animate-pulse"}`}
          title={connState === "online" ? "Online" : "Reconectando..."}
        ></span>
        <span>Espaço Isolado: <strong className="text-white font-semibold">{projectName}</strong></span>
      </div>

      {/* Dica de interação */}
      <div className="absolute bottom-4 left-4 z-10 bg-slate-900/80 border border-slate-800/80 rounded-lg px-3 py-1.5 text-[11px] text-slate-400 backdrop-blur-sm pointer-events-none">
        Ctrl+K buscar · ? atalhos
      </div>

      {loadState === "loading" && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-[#080d1a] text-slate-500 font-mono text-xs">
          Carregando canvas do projeto...
        </div>
      )}

      {importError && (
        <div
          role="alert"
          className="absolute top-20 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 max-w-md rounded-lg border border-rose-700/70 bg-rose-950/95 px-3 py-2 text-xs text-rose-200 shadow-xl"
        >
          <span>Importação falhou: {importError}</span>
          <button onClick={() => setImportError("")} aria-label="Dispensar erro" className="text-rose-300 hover:text-white">✕</button>
        </div>
      )}

      {notifications.length > 0 && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-30 flex flex-col items-center gap-2" role="status">
          {notifications.map((n) => (
            <button
              key={n.id}
              onClick={() => centerOnNode(n.nodeId)}
              className="flex items-start gap-2 max-w-md text-left rounded-xl border border-amber-600/70 bg-slate-900/95 px-3 py-2 text-xs shadow-xl backdrop-blur-md hover:border-amber-400 transition"
              title="Ir até o nó"
            >
              <Bell className="h-3.5 w-3.5 mt-0.5 shrink-0 text-amber-400" />
              <span>
                <span className="block font-semibold text-amber-300">{n.title}</span>
                <span className="text-slate-200 whitespace-pre-wrap">{n.text}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {paletteOpen && (
        <CommandPalette
          nodes={nodes}
          onClose={() => setPaletteOpen(false)}
          onPickNode={selectNode}
          actions={[
            { label: "Novo agente", run: () => addAgent() },
            { label: "Nova nota", run: () => addStickyNote() },
            { label: "Novo portal", run: () => addPortal() },
            { label: "Nova árvore de arquivos", run: () => addFileTree() },
            { label: "Novo diff", run: () => addDiff() },
            { label: "Exportar partitura", run: () => exportPartitura() },
            { label: "Importar partitura", run: openImport },
          ]}
        />
      )}
      {agentSheet && (
        <NewAgentSheet
          projectId={projectId}
          position={agentSheet.at}
          onClose={() => setAgentSheet(null)}
          onCreated={(node) => {
            setAgentSheet(null);
            // o nó chega pelo broadcast do servidor; espera ele entrar no estado para selecionar
            setTimeout(() => nodesRef.current.some((n) => n.id === node.id) && selectNode(node.id), 400);
          }}
        />
      )}
      {rolesOpen && <RolesPanel projectId={projectId} onClose={() => setRolesOpen(false)} />}
      {helpOpen && <ShortcutsHelp onClose={() => setHelpOpen(false)} />}
      {menu && (
        <ContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onAdd={(kind, at) => (kind === "agent" ? addAgent(at) : kind === "note" ? addStickyNote(at) : kind === "fileTree" ? addFileTree(at) : kind === "diff" ? addDiff(at) : addPortal(at))}
          onDuplicate={duplicateNode}
          onExport={exportPartitura}
          onImport={openImport}
          onDelete={(id) => flowRef.current?.deleteElements({ nodes: [{ id }] })}
          onColor={(id, color) => flowRef.current?.updateNodeData(id, { color })}
        />
      )}

      {connState !== "online" && (
        <div
          role="status"
          className="absolute top-16 left-1/2 -translate-x-1/2 z-30 rounded-lg border border-amber-700/60 bg-amber-950/90 px-3 py-1.5 text-xs text-amber-300 font-mono"
        >
          Reconectando…
        </div>
      )}

      {/* O Canvas Principal com React Flow */}
      {loadState === "ready" && (
      <ProjectIdContext.Provider value={projectId}>
      <CanvasOpsContext.Provider value={sendOp as any}>
      <ReactFlow
        nodes={displayNodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onInit={(instance) => (flowRef.current = instance)}
        nodeTypes={nodeTypes}
        deleteKeyCode={["Backspace", "Delete"]}
        elevateNodesOnSelect
        onPaneContextMenu={(e) => {
          e.preventDefault();
          const flow = flowRef.current?.screenToFlowPosition({ x: e.clientX, y: e.clientY });
          if (flow) setMenu({ x: e.clientX, y: e.clientY, flow });
        }}
        onNodeContextMenu={(e, node) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, nodeId: node.id, nodeType: node.type, flow: node.position });
        }}
        onMouseMove={(e) => {
          const pos = flowRef.current?.screenToFlowPosition({ x: e.clientX, y: e.clientY });
          if (pos) presence.sendCursor(pos);
        }}
        onMouseLeave={() => presence.sendCursor(null)}
        onNodeDragStart={(_, node) => presence.setActive(node.id, "dragging")}
        onNodeDragStop={() => presence.setActive(null, "viewing")}
        defaultViewport={initialViewport}
        fitView={!initialViewport}
        onMoveEnd={(event, v) => {
          if (!event) return;
          try {
            localStorage.setItem(viewportKey(projectId), JSON.stringify(v));
          } catch {}
        }}
        className="bg-[#080d1a]"
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={24}
          size={1.5}
          color="#334155"
        />
        <PresenceLayer nodes={nodes} projectId={projectId} />
        <Controls className="!bg-slate-900 !border-slate-800 !fill-slate-300 !text-slate-300 rounded-lg shadow-xl" />
        <MiniMap
          nodeColor={(n) =>
            n.type === "stickyNote" || n.type === "noteStack"
              ? "#f59e0b"
              : n.type === "portal"
              ? "#06b6d4"
              : n.type === "fileTree"
              ? "#10b981"
              : n.type === "diff"
              ? "#a855f7"
              : "#6366f1"
          }
          className="!bg-slate-950/80 !border !border-slate-800 !rounded-xl overflow-hidden"
          maskColor="rgba(15, 23, 42, 0.7)"
        />
      </ReactFlow>
      </CanvasOpsContext.Provider>
      </ProjectIdContext.Provider>
      )}
    </div>
  );
}
