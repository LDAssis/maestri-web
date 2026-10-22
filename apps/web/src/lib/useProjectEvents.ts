"use client";

import { useEffect, useRef } from "react";
import { wsUrl } from "@/lib/api";

// Um único WebSocket /ws/project/:id por projeto, compartilhado entre todos os painéis/nós que
// escutam eventos avulsos ({type:"worktrees"}, {type:"routines"}, ...). O listener recebe o type
// da mensagem, e "connected" a cada (re)conexão (para recarregar o que pode ter sido perdido).
type Listener = (type: string) => void;
interface Hub {
  listeners: Set<Listener>;
  ws: WebSocket | null;
  timer: ReturnType<typeof setTimeout> | null;
  attempt: number;
  closed: boolean;
}
const hubs = new Map<string, Hub>();
const clientId = `events-${Math.random().toString(36).slice(2, 8)}`;

function connect(projectId: string, hub: Hub) {
  const ws = new WebSocket(wsUrl(`/ws/project/${projectId}`, { clientId }));
  hub.ws = ws;
  ws.onopen = () => {
    hub.attempt = 0;
    hub.listeners.forEach((l) => l("connected"));
  };
  ws.onmessage = (event) => {
    try {
      const type = JSON.parse(event.data)?.type;
      if (typeof type === "string") hub.listeners.forEach((l) => l(type));
    } catch {}
  };
  ws.onclose = () => {
    if (hub.closed) return;
    hub.timer = setTimeout(() => connect(projectId, hub), Math.min(1000 * 2 ** hub.attempt, 10000));
    hub.attempt++;
  };
}

function subscribe(projectId: string, listener: Listener) {
  let hub = hubs.get(projectId);
  if (!hub) {
    hub = { listeners: new Set(), ws: null, timer: null, attempt: 0, closed: false };
    hubs.set(projectId, hub);
    connect(projectId, hub);
  }
  hub.listeners.add(listener);
  const h = hub;
  return () => {
    h.listeners.delete(listener);
    if (h.listeners.size) return;
    h.closed = true;
    if (h.timer) clearTimeout(h.timer);
    h.ws?.close();
    hubs.delete(projectId);
  };
}

export function useProjectEvents(projectId: string, onEvent: Listener) {
  const ref = useRef(onEvent);
  ref.current = onEvent;
  useEffect(() => subscribe(projectId, (t) => ref.current(t)), [projectId]);
}
