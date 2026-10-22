"use client";

import React, { useEffect, useRef, useState } from "react";
import { Layers, GitBranch, Plus, GitMerge, Trash2, PowerOff, ChevronDown, ChevronUp, GitPullRequest } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { FloorInfo, FloorState, GROUND } from "@/lib/useFloors";

const BADGE: Record<FloorState, string> = {
  working: "bg-sky-950 text-sky-300 border-sky-800",
  blocked: "bg-rose-950 text-rose-300 border-rose-800",
  review: "bg-amber-950 text-amber-300 border-amber-800",
  done: "bg-emerald-950 text-emerald-300 border-emerald-800",
};
const BAR: Record<FloorState, string> = { working: "bg-sky-500", blocked: "bg-rose-500", review: "bg-amber-500", done: "bg-emerald-500" };

interface PrState { state: string; review: string | null; checks: { passing: number; failing: number; pending: number } }

// Link do PR do andar + estado (gh pr view) carregado ao abrir o seletor
function PrInfo({ projectId, floor }: { projectId: string; floor: FloorInfo }) {
  const pr = floor.pullRequest!;
  const [info, setInfo] = useState<PrState | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let live = true;
    apiFetch(`/api/projects/${projectId}/floors/${encodeURIComponent(floor.name)}/pr`)
      .then(async (r) => {
        const b = await r.json().catch(() => ({}));
        if (!live) return;
        if (r.ok) setInfo(b);
        else setErr(b?.error || `Servidor respondeu ${r.status}`);
      })
      .catch(() => live && setErr("Servidor indisponível"));
    return () => {
      live = false;
    };
  }, [projectId, floor.name]);
  return (
    <div className="mt-0.5 text-[10px] flex flex-wrap items-center gap-x-2 gap-y-0.5">
      <a href={pr.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-sky-300 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400 rounded">
        <GitPullRequest className="h-2.5 w-2.5" />PR #{pr.number}
      </a>
      {info && (
        <>
          <span className="text-slate-400">{info.state.toLowerCase()}</span>
          {info.review && <span className="text-slate-400">review: {info.review.toLowerCase().replace(/_/g, " ")}</span>}
          <span className="text-slate-400">
            checks: <span className="text-emerald-400">{info.checks.passing}✓</span> <span className="text-rose-400">{info.checks.failing}✗</span> <span className="text-amber-400">{info.checks.pending}…</span>
          </span>
        </>
      )}
      {err && <span className="text-slate-500" title={err}>estado indisponível</span>}
    </div>
  );
}

type Pending = { name: string; kind: "land" | "delete" | "unload" } | null;

// Seletor de andares do canvas: um andar por vez; criar, land, delete e unload ficam aqui
export default function FloorSwitcher({
  projectId,
  floors,
  current,
  counts,
  onSelect,
  onChanged,
}: {
  projectId: string;
  floors: FloorInfo[];
  current: string;
  counts: Record<string, number>;
  onSelect: (name: string) => void;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [noGit, setNoGit] = useState(false);
  const [copyGround, setCopyGround] = useState(false);
  const [clone, setClone] = useState(false);
  const [prRef, setPrRef] = useState("");
  const [pending, setPending] = useState<Pending>(null);
  const [into, setInto] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [canForce, setCanForce] = useState(false);

  const createdName = useRef("");
  const createdNote = useRef("");
  const [notice, setNotice] = useState("");
  const base = `/api/projects/${projectId}/floors`;
  const cur = floors.find((f) => f.name === current) ?? floors[0];

  async function run(req: () => Promise<Response>, after?: () => void) {
    setBusy(true);
    setError("");
    setCanForce(false);
    try {
      const res = await req();
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body?.error || `Servidor respondeu ${res.status}`);
        setCanForce(res.status === 409);
        return;
      }
      after?.();
      setPending(null);
      onChanged();
    } catch {
      setError("Servidor indisponível");
    } finally {
      setBusy(false);
    }
  }

  const create = (e: React.FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    const pr = prRef.trim();
    if (!n && !pr) return setError("Informe o nome do andar (ou um pull request).");
    run(
      async () => {
        const res = await apiFetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: n || undefined, noGit, copyGround, copy: clone, pullRequest: pr || undefined }) });
        // Seleciona o andar criado (o nome padrão de PR vem do servidor)
        const body = await res.clone().json().catch(() => ({}));
        createdName.current = body?.floor?.name ?? n;
        createdNote.current = body?.note ?? "";
        return res;
      },
      () => {
        setName("");
        setPrRef("");
        setCreating(false);
        setNotice(createdNote.current);
        onSelect(createdName.current);
      },
    );
  };

  const confirm = (force = false) => {
    if (!pending) return;
    const n = encodeURIComponent(pending.name);
    const leave = () => pending.name === current && pending.kind !== "unload" && onSelect(GROUND);
    if (pending.kind === "land") {
      run(() => apiFetch(`${base}/${n}/land`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ into: into.trim() || undefined }) }), leave);
    } else if (pending.kind === "delete") {
      run(() => apiFetch(`${base}/${n}${force ? "?force=1" : ""}`, { method: "DELETE" }), leave);
    } else run(() => apiFetch(`${base}/${n}/unload`, { method: "POST" }));
  };

  const btn = "px-1.5 py-0.5 rounded text-[10px] border transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400 disabled:opacity-40";

  return (
    <div className="absolute top-20 left-4 z-10 w-80 rounded-xl border border-slate-800 bg-slate-900/95 backdrop-blur-md shadow-xl text-xs text-slate-200">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="floor-list"
        className="w-full flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-slate-800/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400"
      >
        <Layers className="h-3.5 w-3.5 text-indigo-400" />
        <span className="font-semibold">Andar: {cur.name}</span>
        {cur.status && <span className={`px-1.5 rounded border text-[10px] ${BADGE[cur.status.state]}`}>{cur.status.state}</span>}
        <span className="ml-auto text-slate-500">{counts[cur.name] ?? 0} nós</span>
        {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
      </button>

      {open && (
        <div id="floor-list" className="border-t border-slate-800 max-h-[60vh] overflow-y-auto">
          <ul role="listbox" aria-label="Andares">
            {floors.map((f) => {
              const st = f.status;
              const active = f.name === current;
              return (
                <li key={f.name} role="option" aria-selected={active} className={`px-3 py-2 border-b border-slate-800/60 ${active ? "bg-indigo-950/40" : ""}`}>
                  <button onClick={() => onSelect(f.name)} className="w-full text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400 rounded">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium text-slate-100">{f.ground ? "Ground (térreo)" : f.name}</span>
                      {st && <span className={`px-1.5 rounded border text-[10px] ${BADGE[st.state]}`}>{st.state}</span>}
                      <span className="ml-auto text-slate-500">{counts[f.name] ?? 0} nós</span>
                    </div>
                    <div className="flex items-center gap-1 text-[10px] text-slate-500 mt-0.5">
                      <GitBranch className="h-2.5 w-2.5" />
                      {f.git ? f.branch ?? "—" : "sem git (diretório do térreo)"}
                      {f.copy && <span className="ml-1 px-1 rounded border border-slate-700 text-slate-400">clone</span>}
                    </div>
                    {st?.text && <div className="text-[11px] text-slate-300 mt-0.5 break-words">{st.text}</div>}
                    {st?.progress != null && (
                      <div
                        role="progressbar"
                        aria-label={`Progresso de ${f.name}`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(st.progress * 100)}
                        className="mt-1 h-1.5 rounded bg-slate-800 overflow-hidden"
                      >
                        <div className={`h-full ${BAR[st.state]}`} style={{ width: `${Math.round(st.progress * 100)}%` }} />
                      </div>
                    )}
                  </button>

                  {f.pullRequest && <PrInfo projectId={projectId} floor={f} />}
                  <div className="flex items-center gap-1 mt-1.5">
                    {!f.ground && f.git && (
                      <button className={`${btn} border-slate-700 text-slate-300 hover:bg-slate-800`} onClick={() => { setPending({ name: f.name, kind: "land" }); setError(""); }}>
                        <GitMerge className="inline h-2.5 w-2.5 mr-0.5" />Land
                      </button>
                    )}
                    <button className={`${btn} border-slate-700 text-slate-300 hover:bg-slate-800`} disabled={active} title={active ? "Você está neste andar" : undefined} onClick={() => { setPending({ name: f.name, kind: "unload" }); setError(""); }}>
                      <PowerOff className="inline h-2.5 w-2.5 mr-0.5" />Unload
                    </button>
                    {!f.ground && (
                      <button className={`${btn} border-rose-900 text-rose-300 hover:bg-rose-950`} onClick={() => { setPending({ name: f.name, kind: "delete" }); setError(""); }}>
                        <Trash2 className="inline h-2.5 w-2.5 mr-0.5" />Delete
                      </button>
                    )}
                  </div>

                  {pending?.name === f.name && (
                    <div role="alertdialog" aria-label={`Confirmar ${pending.kind}`} className="mt-1.5 rounded-lg border border-slate-700 bg-slate-950 p-2 space-y-1.5">
                      <p className="text-[11px] text-slate-300">
                        {pending.kind === "land" && "Fechar o andar mantendo a branch. Opcionalmente mesclar a branch em outra:"}
                        {pending.kind === "delete" && `Apagar o andar "${f.name}", seus nós, o clone e a branch?`}
                        {pending.kind === "unload" && `Encerrar os terminais do andar "${f.name}"?`}
                      </p>
                      {pending.kind === "land" && (
                        <input
                          value={into}
                          onChange={(e) => setInto(e.target.value)}
                          aria-label="Mesclar em (branch)"
                          placeholder="main (opcional)"
                          className="w-full bg-slate-900 border border-slate-800 rounded px-2 py-1 text-[11px] text-white focus:outline-none focus:border-indigo-500"
                        />
                      )}
                      <div className="flex gap-1">
                        <button disabled={busy} className={`${btn} bg-indigo-600 border-indigo-500 text-white hover:bg-indigo-500`} onClick={() => confirm()}>Confirmar</button>
                        {pending.kind === "delete" && canForce && (
                          <button disabled={busy} className={`${btn} border-rose-700 text-rose-300 hover:bg-rose-950`} onClick={() => confirm(true)}>Apagar mesmo assim</button>
                        )}
                        <button className={`${btn} border-slate-700 text-slate-300 hover:bg-slate-800`} onClick={() => { setPending(null); setError(""); }}>Cancelar</button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>

          <div className="p-2">
            {creating ? (
              <form onSubmit={create} className="space-y-1.5">
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  aria-label="Nome do novo andar"
                  placeholder={prRef.trim() ? "Nome (opcional com PR)" : "Nome do andar"}
                  maxLength={60}
                  className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1 text-[11px] text-white focus:outline-none focus:border-indigo-500"
                />
                <input
                  value={prRef}
                  onChange={(e) => setPrRef(e.target.value)}
                  aria-label="Pull request (número ou link, opcional)"
                  placeholder="Pull request: nº ou link (opcional, usa o gh)"
                  className="w-full bg-slate-950 border border-slate-800 rounded px-2 py-1 text-[11px] text-white focus:outline-none focus:border-indigo-500"
                />
                <label className="flex items-center gap-1.5 text-[11px] text-slate-400">
                  <input type="checkbox" checked={clone} disabled={noGit} onChange={(e) => setClone(e.target.checked)} /> Clone isolado (--copy; pode usar a mesma branch do térreo)
                </label>
                <label className="flex items-center gap-1.5 text-[11px] text-slate-400">
                  <input type="checkbox" checked={noGit} disabled={clone || !!prRef.trim()} onChange={(e) => setNoGit(e.target.checked)} /> Sem git (compartilha o diretório do térreo)
                </label>
                <label className="flex items-center gap-1.5 text-[11px] text-slate-400">
                  <input type="checkbox" checked={copyGround} onChange={(e) => setCopyGround(e.target.checked)} /> Copiar o layout do térreo
                </label>
                <div className="flex gap-1">
                  <button type="submit" disabled={busy} className={`${btn} bg-indigo-600 border-indigo-500 text-white hover:bg-indigo-500`}>Criar andar</button>
                  <button type="button" className={`${btn} border-slate-700 text-slate-300 hover:bg-slate-800`} onClick={() => { setCreating(false); setError(""); }}>Cancelar</button>
                </div>
              </form>
            ) : (
              <button onClick={() => setCreating(true)} className="flex items-center gap-1 text-[11px] text-indigo-400 hover:text-indigo-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400 rounded">
                <Plus className="h-3 w-3" /> Novo andar
              </button>
            )}
            {notice && <p role="status" className="mt-1.5 text-[11px] text-amber-300 break-words">{notice}</p>}
            {error && <p role="alert" className="mt-1.5 text-[11px] text-rose-300 break-words">{error}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
