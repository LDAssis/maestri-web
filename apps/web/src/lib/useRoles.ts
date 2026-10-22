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
  // Cópia materializada de um role global (ver server/src/globalRolesApi.ts): a UI a lista como global
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

// Roles globais (valem para todos os projetos; `role create --scope global`), com o mesmo esquema de cache
const gcache: { roles: Role[] | null } = { roles: null };
let ginflight: Promise<void> | null = null;
const gsubs = new Set<() => void>();

function refreshGlobal() {
  if (!ginflight) {
    ginflight = apiFetch("/api/global-roles")
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (body?.roles) {
          gcache.roles = body.roles;
          gsubs.forEach((s) => s());
        }
      })
      .catch(() => {})
      .finally(() => {
        ginflight = null;
      });
  }
  return ginflight;
}

export function useGlobalRoles(projectId: string) {
  const [, force] = useState(0);
  useEffect(() => {
    const s = () => force((n) => n + 1);
    gsubs.add(s);
    if (!gcache.roles) refreshGlobal();
    return () => {
      gsubs.delete(s);
    };
  }, []);
  useProjectEvents(projectId, (t) => {
    if (t === "roles" || t === "connected") refreshGlobal();
  });
  return { globalRoles: gcache.roles ?? [], reloadGlobal: refreshGlobal };
}
