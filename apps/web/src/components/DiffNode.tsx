"use client";

import React, { useCallback, useContext, useEffect, useState } from "react";
import { Handle, Position, NodeResizer, useReactFlow } from "@xyflow/react";
import { FileDiff, RefreshCw } from "lucide-react";
import DeleteNodeButton from "./DeleteNodeButton";
import DiffView, { Diff } from "./DiffView";
import { apiFetch } from "@/lib/api";
import { ProjectIdContext } from "@/lib/projectContext";
import { useProjectEvents } from "@/lib/useProjectEvents";

export interface DiffNodeData extends Record<string, unknown> {
  title: string;
  worktree?: string;
}

export default function DiffNode({ id, data, selected }: { id: string; data: DiffNodeData; selected?: boolean }) {
  const projectId = useContext(ProjectIdContext);
  const { updateNodeData } = useReactFlow();
  const [names, setNames] = useState<string[]>([]);
  const [diff, setDiff] = useState<Diff | null>(null);
  const [error, setError] = useState("");
  const worktree = data.worktree || "";
  const api = `/api/projects/${projectId}/worktrees`;

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(api);
      if (!res.ok) throw new Error(`Servidor respondeu ${res.status}`);
      setNames(((await res.json()).worktrees || []).map((w: { name: string }) => w.name));
    } catch {
      /* a lista é best-effort; o erro do diff é mostrado abaixo */
    }
    if (!worktree) return;
    try {
      const res = await apiFetch(`${api}/${encodeURIComponent(worktree)}/diff`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `Servidor respondeu ${res.status}`);
      setDiff(await res.json());
      setError("");
    } catch (e: any) {
      setDiff(null);
      setError(e?.message || "Falha de rede");
    }
  }, [api, worktree]);

  useEffect(() => {
    setDiff(null);
    setError("");
    load();
  }, [load]);

  useProjectEvents(projectId, (t) => {
    if (t === "worktrees" || t === "connected") load();
  });

  return (
    <div className={`w-full h-full min-w-[320px] min-h-[220px] rounded-xl border bg-slate-900/95 shadow-2xl overflow-hidden text-slate-100 font-sans flex flex-col ${selected ? "border-indigo-500" : "border-slate-700"}`}>
      <NodeResizer minWidth={320} minHeight={220} isVisible={selected} lineClassName="!border-indigo-500" handleClassName="!h-3 !w-3 !bg-indigo-500 !border-2 !border-slate-900 !rounded" />
      <Handle type="target" position={Position.Top} className="!w-3 !h-3 !bg-indigo-500 !border-2 !border-slate-900" />
      <div className="px-3 py-2 border-b border-slate-800 bg-slate-950/90 flex items-center justify-between gap-2 shrink-0 text-xs">
        <div className="flex items-center gap-1.5 font-semibold min-w-0">
          <FileDiff className="h-3.5 w-3.5 text-indigo-400 shrink-0" />
          <span className="truncate">{data.title || "Diff"}</span>
        </div>
        <div className="nodrag flex items-center gap-1.5">
          <select
            value={worktree}
            onChange={(e) => updateNodeData(id, { worktree: e.target.value })}
            aria-label="Andar"
            className="bg-slate-900 border border-slate-800 rounded-md px-1.5 py-0.5 text-[11px] max-w-[140px] focus:outline-none focus:border-indigo-500"
          >
            <option value="">Escolher andar…</option>
            {worktree && !names.includes(worktree) && <option value={worktree}>{worktree} (inexistente)</option>}
            {names.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
          <button onClick={load} className="p-1 rounded hover:bg-white/10 text-slate-400 hover:text-white" aria-label="Recarregar diff" title="Recarregar">
            <RefreshCw className="h-3 w-3" />
          </button>
          <DeleteNodeButton id={id} />
        </div>
      </div>
      <div className="nodrag flex-1 min-h-0 overflow-y-auto p-3 nowheel">
        {worktree ? (
          <DiffView diff={diff} error={error} patchClassName="max-h-64" />
        ) : (
          <div className="text-[11px] text-slate-500">Escolha um andar para ver as alterações.</div>
        )}
      </div>
    </div>
  );
}
