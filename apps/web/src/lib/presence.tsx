"use client";

import React, { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import { wsUrl } from "@/lib/api";

export type Activity = "idle" | "typing" | "dragging" | "editing" | "viewing";

export interface PresenceUser {
  id: string;
  name: string;
  color: string;
}

export interface Peer {
  connId: string;
  user: PresenceUser;
  projectId: string | null;
  cursor: { x: number; y: number } | null;
  activeNodeId: string | null;
  activity: Activity;
  since: number | string;
}

export interface Toast {
  id: number;
  text: string;
}

interface MyState {
  projectId: string | null;
  cursor: { x: number; y: number } | null;
  activeNodeId: string | null;
  activity: Activity;
}

export interface PresenceSnapshot {
  peers: Peer[];
  toasts: Toast[];
  online: boolean;
  projectId: string | null;
  nodeTitles: Record<string, string>;
}

// Estado de presença fora do React: eventos de cursor (dezenas por segundo) só re-renderizam
// quem assina (avatares, camada de cursores), não o App inteiro.
export class PresenceStore {
  private peers = new Map<string, Peer>();
  private listeners = new Set<() => void>();
  private snap: PresenceSnapshot = { peers: [], toasts: [], online: false, projectId: null, nodeTitles: {} };
  private ws: WebSocket | null = null;
  private stopped = true;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private raf: ReturnType<typeof setTimeout> | number = 0;
  private toastSeq = 0;
  private state: MyState = { projectId: null, cursor: null, activeNodeId: null, activity: "idle" };
  private cursorTimer: ReturnType<typeof setTimeout> | null = null;
  private lastCursorAt = 0;
  private pendingCursor: MyState["cursor"] = null;
  private typingTimer: ReturnType<typeof setTimeout> | null = null;
  projectName: (id: string) => string = (id) => id;

  constructor(public user: PresenceUser) {}

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };

  getSnapshot = () => this.snap;

  private emit() {
    if (this.raf) return;
    const flush = () => {
      this.raf = 0;
      this.snap = { ...this.snap, peers: Array.from(this.peers.values()) };
      this.listeners.forEach((l) => l());
    };
    this.raf = typeof requestAnimationFrame !== "undefined" ? requestAnimationFrame(flush) : setTimeout(flush, 16);
  }

  private toast(text: string) {
    const id = ++this.toastSeq;
    this.snap = { ...this.snap, toasts: [...this.snap.toasts, { id, text }] };
    setTimeout(() => {
      this.snap = { ...this.snap, toasts: this.snap.toasts.filter((t) => t.id !== id) };
      this.emit();
    }, 3000);
  }

  private hasOtherConn(userId: string, exceptConn: string) {
    return Array.from(this.peers.values()).some((p) => p.user.id === userId && p.connId !== exceptConn);
  }

  private handle(msg: any) {
    if (msg.type === "snapshot") {
      this.peers = new Map((msg.peers as Peer[]).map((p) => [p.connId, p]));
    } else if (msg.type === "join") {
      const p = msg.peer as Peer;
      const known = this.hasOtherConn(p.user.id, p.connId);
      this.peers.set(p.connId, p);
      if (p.user.id !== this.user.id && !known) this.toast(`${p.user.name} entrou`);
    } else if (msg.type === "update") {
      const { type, connId, ...fields } = msg;
      const prev = this.peers.get(connId);
      if (!prev) return;
      this.peers.set(connId, { ...prev, ...fields });
      if (
        prev.user.id !== this.user.id &&
        prev.projectId &&
        fields.projectId &&
        fields.projectId !== prev.projectId
      ) {
        this.toast(`${prev.user.name} foi para ${this.projectName(fields.projectId)}`);
      }
    } else if (msg.type === "leave") {
      const prev = this.peers.get(msg.connId);
      if (!prev) return;
      this.peers.delete(msg.connId);
      if (prev.user.id !== this.user.id && !this.hasOtherConn(prev.user.id, msg.connId)) {
        this.toast(`${prev.user.name} saiu`);
      }
    } else {
      return;
    }
    this.emit();
  }

  private connect() {
    const ws = new WebSocket(wsUrl("/ws/presence"));
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      ws.send(JSON.stringify({ type: "hello", user: this.user }));
      ws.send(JSON.stringify({ type: "update", ...this.state }));
      this.snap = { ...this.snap, online: true };
      this.emit();
    };
    ws.onmessage = (event) => {
      try {
        this.handle(JSON.parse(event.data));
      } catch {}
    };
    ws.onclose = () => {
      if (this.stopped || this.ws !== ws) return;
      this.peers.clear();
      this.snap = { ...this.snap, online: false };
      this.emit();
      this.retryTimer = setTimeout(() => this.connect(), Math.min(1000 * 2 ** this.attempt, 10000));
      this.attempt++;
    };
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.cursorTimer) clearTimeout(this.cursorTimer);
    if (this.typingTimer) clearTimeout(this.typingTimer);
    if (typeof this.raf === "number") cancelAnimationFrame(this.raf);
    else clearTimeout(this.raf);
    this.raf = 0;
    this.ws?.close();
    this.ws = null;
  }

  // Envia só o que mudou (cursor sempre que informado)
  send(partial: Partial<MyState>) {
    const changed: Partial<MyState> = {};
    for (const k of Object.keys(partial) as (keyof MyState)[]) {
      const v = partial[k] as any;
      if (k === "cursor" ? JSON.stringify(v) !== JSON.stringify(this.state.cursor) : v !== this.state[k]) {
        (changed as any)[k] = v;
        (this.state as any)[k] = v;
      }
    }
    if (Object.keys(changed).length && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "update", ...changed }));
    }
  }

  setProject(projectId: string | null) {
    this.snap = { ...this.snap, projectId };
    this.send({ projectId, cursor: null, activeNodeId: null, activity: projectId ? "viewing" : "idle" });
    this.emit();
  }

  setNodeTitles(nodeTitles: Record<string, string>) {
    this.snap = { ...this.snap, nodeTitles };
    this.emit();
  }

  setActive(activeNodeId: string | null, activity: Activity = "viewing") {
    this.send({ activeNodeId, activity });
  }

  // Cursor em coordenadas do flow, throttle de 50ms (com envio final garantido)
  sendCursor(cursor: MyState["cursor"]) {
    this.pendingCursor = cursor;
    const wait = 50 - (Date.now() - this.lastCursorAt);
    if (wait <= 0 || cursor === null) {
      if (this.cursorTimer) clearTimeout(this.cursorTimer);
      this.cursorTimer = null;
      this.lastCursorAt = Date.now();
      this.send({ cursor });
    } else if (!this.cursorTimer) {
      this.cursorTimer = setTimeout(() => {
        this.cursorTimer = null;
        this.lastCursorAt = Date.now();
        this.send({ cursor: this.pendingCursor });
      }, wait);
    }
  }

  // "digitando" num nó; volta a "viewing" após 1.5s sem teclas
  typing(nodeId: string) {
    this.send({ activeNodeId: nodeId, activity: "typing" });
    if (this.typingTimer) clearTimeout(this.typingTimer);
    this.typingTimer = setTimeout(() => this.send({ activity: "viewing" }), 1500);
  }
}

const Ctx = createContext<PresenceStore>(new PresenceStore({ id: "", name: "", color: "#6366f1" }));

export function PresenceProvider({
  user,
  projectId,
  projectName,
  children,
}: {
  user: PresenceUser;
  projectId: string | null;
  projectName: (id: string) => string;
  children: React.ReactNode;
}) {
  const store = useMemo(() => new PresenceStore(user), [user.id, user.name, user.color]);
  store.projectName = projectName;

  useEffect(() => {
    store.start();
    return () => store.stop();
  }, [store]);

  useEffect(() => {
    store.setProject(projectId);
  }, [store, projectId]);

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

export const usePresenceStore = () => useContext(Ctx);

export function usePresence(): PresenceSnapshot {
  const store = usePresenceStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

// Seletor para valores primitivos (string/boolean): só re-renderiza quando o valor muda
export function usePresenceValue<T extends string | number | boolean | null>(
  selector: (s: PresenceSnapshot) => T
): T {
  const store = usePresenceStore();
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getSnapshot()),
    () => selector(store.getSnapshot())
  );
}
