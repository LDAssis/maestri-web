"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useProjectEvents } from "@/lib/useProjectEvents";

export interface Role {
  id: string;
  name: string;
  prompt: string;
  color: string;
  icon?: string;
}

// Cache por projeto compartilhado entre todos os nós; recargas simultâneas viram uma só requisição
const cache = new Map<string, Role[]>();
const inflight = new Map<string, Promise<void>>();
const subs = new Set<() => void>();

function refresh(projectId: string) {
  let p = inflight.get(projectId);
  if (!p) {
    p = apiFetch(`/api/projects/${projectId}/roles`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (body?.roles) {
          cache.set(projectId, body.roles);
          subs.forEach((s) => s());
        }
      })
      .catch(() => {})
      .finally(() => inflight.delete(projectId));
    inflight.set(projectId, p);
  }
  return p;
}

export function useRoles(projectId: string) {
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
    if (t === "roles" || t === "connected") refresh(projectId);
  });
  return { roles: cache.get(projectId) ?? [], reload: () => refresh(projectId) };
}
