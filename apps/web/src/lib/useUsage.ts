"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useProjectEvents } from "@/lib/useProjectEvents";

export interface UsageWindow {
  used_percentage: number;
  resets_at: number; // epoch em segundos
}
export interface UsageAccount {
  cli: string;
  account: string;
  model?: string;
  five_hour: UsageWindow | null;
  seven_day: UsageWindow | null;
  updatedAt: string;
}
export interface Usage {
  accounts: UsageAccount[];
  nodes: Record<string, { account: string; model?: string; updatedAt: string }>;
}
const EMPTY: Usage = { accounts: [], nodes: {} };

// Um GET por projeto compartilhado entre o indicador do topo e todos os nós (mesmo padrão de useRoutines)
const cache = new Map<string, Usage>();
const inflight = new Map<string, Promise<void>>();
const subs = new Set<() => void>();

function refresh(projectId: string) {
  let p = inflight.get(projectId);
  if (!p) {
    p = apiFetch(`/api/projects/${projectId}/usage`)
      // 404 (servidor sem o endpoint) = sem dados
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        cache.set(projectId, body && Array.isArray(body.accounts) ? { accounts: body.accounts, nodes: body.nodes ?? {} } : EMPTY);
        subs.forEach((s) => s());
      })
      .catch(() => {})
      .finally(() => inflight.delete(projectId));
    inflight.set(projectId, p);
  }
  return p;
}

export function useUsage(projectId: string): Usage {
  const [, force] = useState(0);
  useEffect(() => {
    const s = () => force((n) => n + 1);
    subs.add(s);
    if (!cache.has(projectId)) refresh(projectId);
    return () => {
      subs.delete(s);
    };
  }, [projectId]);
  useProjectEvents(projectId, (t) => {
    if (t === "usage" || t === "connected") refresh(projectId);
  });
  return cache.get(projectId) ?? EMPTY;
}

// Relógio de 1 min para "reinicia em ..." e "desatualizado"
export function useMinuteTick(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export const STALE_MS = 30 * 60_000;
export const isStale = (a: { updatedAt: string }, now: number) => now - Date.parse(a.updatedAt) > STALE_MS;

export function resetIn(w: UsageWindow, now: number): string {
  const s = Math.round(w.resets_at - now / 1000);
  if (s <= 0) return "já reiniciou";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return "reinicia em " + (d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`);
}
