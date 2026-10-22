"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useProjectEvents } from "@/lib/useProjectEvents";

// Contagem de rotinas ativas por nó, com um GET por projeto compartilhado entre todos os nós
const cache = new Map<string, Record<string, number>>();
const inflight = new Map<string, Promise<void>>();
const subs = new Set<() => void>();

function refresh(projectId: string) {
  let p = inflight.get(projectId);
  if (!p) {
    p = apiFetch(`/api/projects/${projectId}/routines`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (!body?.routines) return;
        const counts: Record<string, number> = {};
        // lembretes (nodeId null) não pertencem a nenhum nó
        for (const r of body.routines as { nodeId: string | null; enabled: boolean }[]) if (r.enabled && r.nodeId) counts[r.nodeId] = (counts[r.nodeId] || 0) + 1;
        cache.set(projectId, counts);
        subs.forEach((s) => s());
      })
      .catch(() => {})
      .finally(() => inflight.delete(projectId));
    inflight.set(projectId, p);
  }
  return p;
}

export function useActiveRoutineCount(projectId: string, nodeId: string) {
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
    if (t === "routines" || t === "connected") refresh(projectId);
  });
  return cache.get(projectId)?.[nodeId] ?? 0;
}
