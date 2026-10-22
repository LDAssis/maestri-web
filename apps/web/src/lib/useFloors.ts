"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useProjectEvents } from "@/lib/useProjectEvents";

export type FloorState = "working" | "blocked" | "review" | "done";

export interface FloorInfo {
  name: string;
  ground: boolean;
  git: boolean;
  branch: string | null;
  path: string;
  status: { text: string; state: FloorState; progress: number | null; updatedAt: string } | null;
}

export const GROUND = "Ground";

// Andares do projeto (Ground primeiro); recarrega nos eventos {type:"floors"} e a cada (re)conexão
export function useFloors(projectId: string) {
  const [floors, setFloors] = useState<FloorInfo[]>([{ name: GROUND, ground: true, git: true, branch: null, path: "", status: null }]);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/projects/${projectId}/floors`);
      if (!res.ok) throw new Error(`Servidor respondeu ${res.status}`);
      setFloors((await res.json()).floors);
      setError("");
    } catch (e: any) {
      setError(e?.message || "Falha de rede");
    }
  }, [projectId]);

  useEffect(() => {
    refresh();
  }, [refresh]);
  useProjectEvents(projectId, (t) => {
    if (t === "floors" || t === "connected") refresh();
  });
  return { floors, error, refresh };
}
