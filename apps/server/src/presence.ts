import crypto from "node:crypto";
import type { WebSocket } from "ws";

interface User {
  id: string;
  name: string;
  color: string;
}

interface Peer {
  connId: string;
  user: User;
  projectId: string | null;
  cursor: { x: number; y: number } | null;
  activeNodeId: string | null;
  activity: string;
  since: string;
}

const ACTIVITIES = ["idle", "typing", "dragging", "editing", "viewing"];
const MAX_MSGS_PER_SEC = 30;
const PING_MS = 25_000;
const PONG_TIMEOUT_MS = 60_000;

const isStr = (v: unknown): v is string => typeof v === "string" && v.length <= 64;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function parseUser(u: any): User | null {
  if (!u || !isStr(u.id) || !u.id || !isStr(u.name) || !u.name.trim()) return null;
  if (typeof u.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(u.color)) return null;
  return { id: u.id, name: u.name, color: u.color };
}

// Só campos válidos passam; ausentes/inválidos = sem mudança
function parseUpdate(msg: any) {
  const out: Record<string, unknown> = {};
  if (msg.projectId === null || isStr(msg.projectId)) out.projectId = msg.projectId;
  if (msg.cursor === null) out.cursor = null;
  else if (msg.cursor && isNum(msg.cursor.x) && isNum(msg.cursor.y)) out.cursor = { x: msg.cursor.x, y: msg.cursor.y };
  if (msg.activeNodeId === null || isStr(msg.activeNodeId)) out.activeNodeId = msg.activeNodeId;
  if (ACTIVITIES.includes(msg.activity)) out.activity = msg.activity;
  return out;
}

// Presença global: um socket por aba, independente de projeto
export class PresenceHub {
  private peers = new Map<string, { peer: Peer; socket: WebSocket }>();
  private timers = new Set<NodeJS.Timeout>();

  private send(socket: WebSocket, msg: unknown) {
    try {
      if (socket.readyState === 1 /* OPEN */) socket.send(JSON.stringify(msg));
    } catch {}
  }

  private broadcast(msg: unknown, exceptConnId: string) {
    for (const [connId, { socket }] of this.peers) if (connId !== exceptConnId) this.send(socket, msg);
  }

  // authUser: conta que abriu o socket; nome/cor passam a vir dela em vez do que o cliente manda no hello
  attach(socket: WebSocket, authUser: { id: string; name: string; color: string } | null = null) {
    const connId = crypto.randomUUID();
    let joined = false;
    let tokens = MAX_MSGS_PER_SEC;
    let lastRefill = Date.now();
    let lastPong = Date.now();

    // Heartbeat: ping a cada 25s; sem pong em 60s encerra
    const timer = setInterval(() => {
      if (Date.now() - lastPong > PONG_TIMEOUT_MS) {
        socket.terminate();
        return;
      }
      try {
        socket.ping();
      } catch {}
    }, PING_MS);
    timer.unref();
    this.timers.add(timer);
    socket.on("pong", () => (lastPong = Date.now()));

    socket.on("message", (raw: Buffer | string) => {
      const now = Date.now();
      tokens = Math.min(MAX_MSGS_PER_SEC, tokens + ((now - lastRefill) / 1000) * MAX_MSGS_PER_SEC);
      lastRefill = now;
      if (tokens < 1) return; // excesso descartado
      tokens--;

      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg?.type === "hello") {
        if (joined) return;
        const user = authUser ? { id: authUser.id, name: authUser.name, color: authUser.color } : parseUser(msg.user);
        if (!user) {
          socket.close(4400, "hello inválido");
          return;
        }
        joined = true;
        const peer: Peer = { connId, user, projectId: null, cursor: null, activeNodeId: null, activity: "idle", since: new Date().toISOString() };
        const others = [...this.peers.values()].map((e) => e.peer);
        this.peers.set(connId, { peer, socket });
        this.send(socket, { type: "snapshot", you: connId, peers: others });
        this.broadcast({ type: "join", peer }, connId);
        return;
      }

      if (!joined || msg?.type !== "update") return;
      const changes = parseUpdate(msg);
      if (Object.keys(changes).length === 0) return;
      Object.assign(this.peers.get(connId)!.peer, changes);
      this.broadcast({ type: "update", connId, ...changes }, connId);
    });

    socket.on("close", () => {
      clearInterval(timer);
      this.timers.delete(timer);
      if (this.peers.delete(connId)) this.broadcast({ type: "leave", connId }, connId);
    });
  }

  close() {
    for (const t of this.timers) clearInterval(t);
    this.timers.clear();
  }
}
