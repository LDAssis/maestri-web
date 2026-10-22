"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { FolderGit2, GitBranch, GitMerge, Trash2, FileDiff, RefreshCw, AlertTriangle } from "lucide-react";
import { apiFetch, wsUrl } from "@/lib/api";

interface Worktree {
  name: string;
  branch: string;
  path: string;
  head: string;
  ahead: number;
  behind: number;
  changed: number;
  nodeIds: string[];
}

interface DiffFile {
  path: string;
  status: "A" | "M" | "D" | "R" | "?";
  additions: number;
  deletions: number;
}

interface Diff {
  base: string;
  files: DiffFile[];
  patch: string;
  truncated?: boolean;
}

const STATUS_COLOR: Record<string, string> = {
  A: "text-emerald-400",
  "?": "text-emerald-400",
  M: "text-amber-300",
  D: "text-rose-400",
  R: "text-sky-300",
};

function lineClass(l: string) {
  if (l.startsWith("+++") || l.startsWith("---") || l.startsWith("diff ") || l.startsWith("index ")) return "text-slate-500";
  if (l.startsWith("@@")) return "text-sky-300 bg-sky-950/40";
  if (l.startsWith("+")) return "text-emerald-300 bg-emerald-950/40";
  if (l.startsWith("-")) return "text-rose-300 bg-rose-950/40";
  return "text-slate-300";
}

function PatchView({ patch }: { patch: string }) {
  return (
    <pre className="font-mono text-[11px] leading-4 overflow-auto max-h-[55vh] rounded-lg border border-slate-800 bg-black/50 py-1">
      {patch.split("\n").map((l, i) => (
        <div key={i} className={`px-2 whitespace-pre ${lineClass(l)}`}>
          {l || " "}
        </div>
      ))}
    </pre>
  );
}

export default function WorktreesPanel({
  projectId,
  repoPath,
  clientId,
  focusName,
}: {
  projectId: string;
  repoPath: string;
  clientId: string;
  focusName?: string | null;
}) {
  const [base, setBase] = useState("main");
  const [list, setList] = useState<Worktree[] | null>(null);
  const [nodeTitles, setNodeTitles] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [diffName, setDiffName] = useState<string | null>(null);
  const [diff, setDiff] = useState<Diff | null>(null);
  const [diffError, setDiffError] = useState("");
  const [fileSel, setFileSel] = useState<string | null>(null);
  // confirmação inline por andar: land / delete / force-delete
  const [confirm, setConfirm] = useState<{ name: string; kind: "land" | "delete" | "force" } | null>(null);
  const [landMsg, setLandMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [rowError, setRowError] = useState<{ name: string; text: string } | null>(null);
  const diffNameRef = useRef<string | null>(null);
  diffNameRef.current = diffName;
  const api = `/api/projects/${projectId}/worktrees`;

  const loadDiff = useCallback(
    async (name: string) => {
      setDiffError("");
      try {
        const res = await apiFetch(`${api}/${encodeURIComponent(name)}/diff`);
        if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `Servidor respondeu ${res.status}`);
        setDiff(await res.json());
      } catch (e: any) {
        setDiff(null);
        setDiffError(e?.message || "Falha de rede");
      }
    },
    [api]
  );

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(api);
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `Servidor respondeu ${res.status}`);
      const data = await res.json();
      setBase(data.base);
      setList(data.worktrees);
      setError("");
      // títulos dos agentes ligados (best-effort: se falhar, mostra o id)
      apiFetch(`/api/projects/${projectId}/canvas`)
        .then((r) => (r.ok ? r.json() : null))
        .then((c) => {
          if (c?.nodes) setNodeTitles(Object.fromEntries(c.nodes.map((n: any) => [n.id, String(n.data?.title ?? n.id)])));
        })
        .catch(() => {});
      if (diffNameRef.current) {
        if (data.worktrees.some((w: Worktree) => w.name === diffNameRef.current)) loadDiff(diffNameRef.current);
        else setDiffName(null);
      }
    } catch (e: any) {
      setError(e?.message || "Falha de rede");
    }
  }, [api, projectId, loadDiff]);

  useEffect(() => {
    setList(null);
    setDiffName(null);
    load();
  }, [load]);

  // Evento WS {type:"worktrees"} do projeto -> refaz o GET
  useEffect(() => {
    let closed = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let ws: WebSocket | null = null;
    const connect = () => {
      ws = new WebSocket(wsUrl(`/ws/project/${projectId}`, { clientId: `${clientId}:worktrees` }));
      ws.onopen = () => {
        attempt = 0;
        load(); // pode ter perdido eventos durante a reconexão
      };
      ws.onmessage = (event) => {
        try {
          if (JSON.parse(event.data).type === "worktrees") load();
        } catch {}
      };
      ws.onclose = () => {
        if (closed) return;
        timer = setTimeout(connect, Math.min(1000 * 2 ** attempt, 10000));
        attempt++;
      };
    };
    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, [projectId, clientId, load]);

  const openDiff = useCallback(
    (name: string) => {
      setDiffName(name);
      setDiff(null);
      setFileSel(null);
      loadDiff(name);
    },
    [loadDiff]
  );

  useEffect(() => {
    if (focusName) openDiff(focusName);
  }, [focusName, openDiff]);

  const run = async (name: string, path: string, init: RequestInit) => {
    setBusy(true);
    setRowError(null);
    try {
      const res = await apiFetch(`${api}/${encodeURIComponent(name)}${path}`, init);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRowError({ name, text: body?.error || `Servidor respondeu ${res.status}` });
        return res.status;
      }
      setConfirm(null);
      setLandMsg("");
      await load();
      return 200;
    } catch {
      setRowError({ name, text: "Servidor indisponível" });
      return 0;
    } finally {
      setBusy(false);
    }
  };

  const land = (name: string) =>
    run(name, "/land", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(landMsg.trim() ? { message: landMsg.trim() } : {}),
    });

  const remove = async (name: string, force: boolean) => {
    const status = await run(name, force ? "?force=1" : "", { method: "DELETE" });
    if (status === 409 && !force) setConfirm({ name, kind: "force" });
  };

  const sections = diff ? diff.patch.split(/^(?=diff --git )/m).filter(Boolean) : [];
  const shownPatch = !diff
    ? ""
    : fileSel
      ? sections.filter((s) => s.split("\n", 1)[0].endsWith(`b/${fileSel}`)).join("") || diff.patch
      : diff.patch;
  const btn = "px-2 py-1 rounded-md text-[11px] font-medium transition disabled:opacity-40";

  return (
    <div className="h-full overflow-y-auto bg-[#080d1a] p-6">
      <div className="mx-auto max-w-5xl space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
              <FolderGit2 className="h-4 w-4 text-indigo-400" />
              Andares (worktrees)
            </h2>
            <p className="mt-1 text-[11px] text-slate-500 font-mono truncate">
              {repoPath} · base <span className="text-emerald-400">{base}</span>
            </p>
          </div>
          <button
            onClick={load}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"
            aria-label="Atualizar andares"
            title="Atualizar"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>

        {error && (
          <div role="alert" className="flex items-center gap-2 rounded-lg border border-rose-800/60 bg-rose-950/50 px-3 py-2 text-xs text-rose-300">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            {error}
          </div>
        )}
        {list === null && !error && <div className="text-xs text-slate-500 font-mono">Carregando andares…</div>}
        {list?.length === 0 && (
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-6 text-center text-xs text-slate-400">
            Nenhum andar ainda. No canvas, use “Criar andar” em um agente para isolá-lo numa branch própria.
          </div>
        )}

        {list?.map((w) => {
          const agents = w.nodeIds.map((id) => nodeTitles[id] || id);
          const active = confirm?.name === w.name ? confirm.kind : null;
          return (
            <div key={w.name} className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-100">
                    <GitBranch className="h-3.5 w-3.5 text-indigo-400" />
                    <span className="font-mono truncate">{w.branch}</span>
                    <span className="font-mono text-[10px] text-slate-500">{w.head}</span>
                  </div>
                  <div className="mt-1 text-[11px] text-slate-400">
                    {agents.length ? `Agentes: ${agents.join(", ")}` : "Nenhum agente ligado"} ·{" "}
                    <span title={`commits à frente de ${base}`}>↑{w.ahead}</span>{" "}
                    <span title={`commits atrás de ${base}`}>↓{w.behind}</span> ·{" "}
                    {w.changed} {w.changed === 1 ? "alterado" : "alterados"}
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => (diffName === w.name ? setDiffName(null) : openDiff(w.name))}
                    className={`${btn} flex items-center gap-1 ${diffName === w.name ? "bg-indigo-600 text-white" : "bg-slate-800 text-slate-200 hover:bg-slate-700"}`}
                  >
                    <FileDiff className="h-3 w-3" /> Diff
                  </button>
                  <button
                    onClick={() => setConfirm({ name: w.name, kind: "land" })}
                    className={`${btn} flex items-center gap-1 bg-emerald-700 text-white hover:bg-emerald-600`}
                  >
                    <GitMerge className="h-3 w-3" /> Land
                  </button>
                  <button
                    onClick={() => setConfirm({ name: w.name, kind: "delete" })}
                    className={`${btn} flex items-center gap-1 bg-slate-800 text-rose-300 hover:bg-rose-950`}
                    aria-label={`Apagar andar ${w.name}`}
                  >
                    <Trash2 className="h-3 w-3" /> Apagar
                  </button>
                </div>
              </div>

              {active === "land" && (
                <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-slate-300">
                  <span>Commitar tudo e mesclar em {base} (--no-ff)?</span>
                  <input
                    value={landMsg}
                    onChange={(e) => setLandMsg(e.target.value)}
                    placeholder={`mensagem (maestri: land ${w.name})`}
                    aria-label="Mensagem do commit"
                    className="flex-1 min-w-[180px] bg-slate-950 border border-slate-800 rounded-md px-2 py-1 focus:outline-none focus:border-indigo-500"
                  />
                  <button disabled={busy} onClick={() => land(w.name)} className={`${btn} bg-emerald-600 text-white hover:bg-emerald-500`}>
                    {busy ? "Mesclando…" : "Confirmar land"}
                  </button>
                  <button onClick={() => setConfirm(null)} className={`${btn} text-slate-400 hover:text-white`}>Cancelar</button>
                </div>
              )}
              {(active === "delete" || active === "force") && (
                <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-slate-300">
                  <span>
                    {active === "force"
                      ? "Há trabalho não landado. Apagar mesmo assim (perde as mudanças)?"
                      : "Remover o worktree e a branch? Os agentes voltam ao repo principal."}
                  </span>
                  <button disabled={busy} onClick={() => remove(w.name, active === "force")} className={`${btn} bg-rose-600 text-white hover:bg-rose-500`}>
                    {active === "force" ? "Apagar mesmo assim" : "Confirmar"}
                  </button>
                  <button onClick={() => setConfirm(null)} className={`${btn} text-slate-400 hover:text-white`}>Cancelar</button>
                </div>
              )}
              {rowError?.name === w.name && (
                <div role="alert" className="mt-2 flex items-center gap-1.5 rounded-lg border border-amber-700/60 bg-amber-950/60 px-2 py-1 text-[11px] text-amber-300">
                  <AlertTriangle className="h-3 w-3 shrink-0" />
                  {rowError.text}
                </div>
              )}

              {diffName === w.name && (
                <div className="mt-3 space-y-2">
                  {diffError && <div role="alert" className="text-[11px] text-rose-300">{diffError}</div>}
                  {!diff && !diffError && <div className="text-[11px] text-slate-500 font-mono">Carregando diff…</div>}
                  {diff && diff.files.length === 0 && <div className="text-[11px] text-slate-500">Sem diferenças em relação a {diff.base}.</div>}
                  {diff && diff.files.length > 0 && (
                    <>
                      <div className="flex flex-wrap gap-1">
                        <button
                          onClick={() => setFileSel(null)}
                          className={`${btn} ${fileSel === null ? "bg-indigo-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}
                        >
                          Todos ({diff.files.length})
                        </button>
                        {diff.files.map((f) => (
                          <button
                            key={f.path}
                            onClick={() => setFileSel(f.path)}
                            className={`${btn} font-mono ${fileSel === f.path ? "bg-indigo-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}
                          >
                            <span className={STATUS_COLOR[f.status]}>{f.status}</span> {f.path}{" "}
                            <span className="text-emerald-400">+{f.additions}</span> <span className="text-rose-400">-{f.deletions}</span>
                          </button>
                        ))}
                      </div>
                      <PatchView patch={shownPatch} />
                      {diff.truncated && <div className="text-[11px] text-amber-300">Patch truncado em 500 KB.</div>}
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
