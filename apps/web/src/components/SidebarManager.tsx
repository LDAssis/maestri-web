"use client";

import React, { useCallback, useEffect, useState } from "react";
import { X, FolderPlus, Pencil, Trash2, Pin, PinOff, Folder, Layers } from "lucide-react";
import { apiFetch } from "@/lib/api";

interface ProjectLite { id: string; name: string; group?: string | null; folder?: string | null; pinned?: boolean }
interface Sidebar { groups: string[]; folders: { name: string; group: string | null }[] }

const J = { "Content-Type": "application/json" };
const dest = (group: string | null, folder: string | null) => JSON.stringify({ group, folder });

// Gerência da barra lateral de workspaces: grupos, pastas, mover e fixar
export default function SidebarManager({ projects, onClose, onChanged }: { projects: ProjectLite[]; onClose: () => void; onChanged: () => void }) {
  const [sb, setSb] = useState<Sidebar>({ groups: [], folders: [] });
  const [error, setError] = useState("");
  const [newGroup, setNewGroup] = useState("");
  const [newFolder, setNewFolder] = useState("");
  const [folderScope, setFolderScope] = useState("");
  // item em renomeação: chave "g:Nome" ou "f:Grupo|Nome"
  const [editing, setEditing] = useState<{ key: string; value: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch("/api/sidebar");
      if (!res.ok) throw new Error(`Servidor respondeu ${res.status}`);
      setSb(await res.json());
    } catch (e: any) {
      setError(e?.message || "Falha de rede");
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  async function act(req: () => Promise<Response>) {
    setError("");
    try {
      const res = await req();
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return setError(body?.error || `Servidor respondeu ${res.status}`), false;
      await load();
      onChanged();
      return true;
    } catch {
      setError("Servidor indisponível");
      return false;
    }
  }

  const q = (g: string | null) => (g ? `?group=${encodeURIComponent(g)}` : "");
  const field = "bg-slate-900 border border-slate-800 rounded-lg px-2 py-1 text-xs text-white focus:outline-none focus:border-indigo-500";
  const ibtn = "p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400";

  const rename = async () => {
    if (!editing) return;
    const [kind, rest] = [editing.key[0], editing.key.slice(2)];
    const ok =
      kind === "g"
        ? await act(() => apiFetch(`/api/sidebar/groups/${encodeURIComponent(rest)}`, { method: "PATCH", headers: J, body: JSON.stringify({ name: editing.value }) }))
        : await act(() => {
            const [g, n] = rest.split("|");
            return apiFetch(`/api/sidebar/folders/${encodeURIComponent(n)}${q(g || null)}`, { method: "PATCH", headers: J, body: JSON.stringify({ name: editing.value }) });
          });
    if (ok) setEditing(null);
  };

  const row = (key: string, label: React.ReactNode, onDelete: () => void, name: string) => (
    <li key={key} className="flex items-center gap-1.5 py-0.5">
      {editing?.key === key ? (
        <form onSubmit={(e) => (e.preventDefault(), rename())} className="flex items-center gap-1 flex-1">
          <input autoFocus aria-label={`Novo nome de ${name}`} value={editing.value} onChange={(e) => setEditing({ key, value: e.target.value })} className={`${field} flex-1`} />
          <button type="submit" className="px-2 py-1 rounded bg-indigo-600 text-white text-[11px]">Salvar</button>
          <button type="button" onClick={() => setEditing(null)} className="px-2 py-1 rounded border border-slate-700 text-[11px] text-slate-300">Cancelar</button>
        </form>
      ) : (
        <>
          <span className="flex-1 flex items-center gap-1.5 text-xs text-slate-200 min-w-0 truncate">{label}</span>
          <button aria-label={`Renomear ${name}`} title="Renomear" className={ibtn} onClick={() => setEditing({ key, value: name })}><Pencil className="h-3 w-3" /></button>
          <button aria-label={`Apagar ${name}`} title="Apagar" className={`${ibtn} hover:!text-rose-400`} onClick={onDelete}><Trash2 className="h-3 w-3" /></button>
        </>
      )}
    </li>
  );

  const folderLabel = (f: { name: string; group: string | null }) => `${f.group ? `${f.group} / ` : ""}${f.name}`;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div role="dialog" aria-modal="true" aria-label="Organizar workspaces" className="w-full max-w-xl max-h-[85vh] overflow-y-auto rounded-2xl border border-slate-800 bg-slate-950 p-5 shadow-2xl text-slate-100">
        <div className="flex items-center justify-between pb-3 mb-3 border-b border-slate-800">
          <h3 className="text-sm font-semibold flex items-center gap-2"><FolderPlus className="h-4 w-4 text-indigo-400" />Organizar workspaces</h3>
          <button onClick={onClose} aria-label="Fechar" className={ibtn}><X className="h-4 w-4" /></button>
        </div>
        {error && <p role="alert" className="mb-3 text-xs text-rose-300 break-words">{error}</p>}

        <h4 className="text-[10px] font-mono uppercase text-slate-500 mb-1">Grupos e pastas</h4>
        <ul className="mb-2">
          {sb.groups.map((g) => row(`g:${g}`, <><Layers className="h-3 w-3 text-indigo-400 shrink-0" />{g}</>, () => window.confirm(`Apagar o grupo "${g}"? Os workspaces dele vão para a raiz.`) && act(() => apiFetch(`/api/sidebar/groups/${encodeURIComponent(g)}`, { method: "DELETE" })), g))}
          {sb.folders.map((f) =>
            row(`f:${f.group ?? ""}|${f.name}`, <><Folder className="h-3 w-3 text-amber-400 shrink-0" />{folderLabel(f)}</>, () => window.confirm(`Apagar a pasta "${f.name}"? Os workspaces dela ficam no ${f.group ? "grupo" : "nível raiz"}.`) && act(() => apiFetch(`/api/sidebar/folders/${encodeURIComponent(f.name)}${q(f.group)}`, { method: "DELETE" })), f.name),
          )}
          {!sb.groups.length && !sb.folders.length && <li className="text-xs text-slate-500">Nenhum grupo ou pasta ainda.</li>}
        </ul>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-5">
          <form onSubmit={async (e) => (e.preventDefault(), newGroup.trim() && (await act(() => apiFetch("/api/sidebar/groups", { method: "POST", headers: J, body: JSON.stringify({ name: newGroup }) }))) && setNewGroup(""))} className="flex gap-1">
            <input aria-label="Nome do novo grupo" placeholder="Novo grupo" value={newGroup} onChange={(e) => setNewGroup(e.target.value)} className={`${field} flex-1 min-w-0`} />
            <button type="submit" className="px-2 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-[11px]">Criar</button>
          </form>
          <form onSubmit={async (e) => (e.preventDefault(), newFolder.trim() && (await act(() => apiFetch("/api/sidebar/folders", { method: "POST", headers: J, body: JSON.stringify({ name: newFolder, group: folderScope || null }) }))) && setNewFolder(""))} className="flex gap-1">
            <input aria-label="Nome da nova pasta" placeholder="Nova pasta" value={newFolder} onChange={(e) => setNewFolder(e.target.value)} className={`${field} flex-1 min-w-0`} />
            <select aria-label="Grupo da nova pasta" value={folderScope} onChange={(e) => setFolderScope(e.target.value)} className={field}>
              <option value="">Raiz</option>
              {sb.groups.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
            <button type="submit" className="px-2 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-[11px]">Criar</button>
          </form>
        </div>

        <h4 className="text-[10px] font-mono uppercase text-slate-500 mb-1">Workspaces</h4>
        <ul className="space-y-1">
          {projects.map((p) => (
            <li key={p.id} className="flex items-center gap-2">
              <button
                aria-pressed={!!p.pinned}
                aria-label={p.pinned ? `Desafixar ${p.name}` : `Fixar ${p.name}`}
                title={p.pinned ? "Desafixar" : "Fixar"}
                className={`${ibtn} ${p.pinned ? "!text-amber-400" : ""}`}
                onClick={() => act(() => apiFetch(`/api/projects/${p.id}/sidebar`, { method: "PATCH", headers: J, body: JSON.stringify({ pinned: !p.pinned }) }))}
              >
                {p.pinned ? <Pin className="h-3.5 w-3.5" /> : <PinOff className="h-3.5 w-3.5" />}
              </button>
              <span className="flex-1 text-xs truncate">{p.name}</span>
              <select
                aria-label={`Mover ${p.name} para`}
                value={dest(p.group ?? null, p.folder ?? null)}
                onChange={(e) => act(() => apiFetch(`/api/projects/${p.id}/sidebar`, { method: "PATCH", headers: J, body: e.target.value }))}
                className={`${field} max-w-[200px]`}
              >
                <option value={dest(null, null)}>Raiz</option>
                {sb.folders.filter((f) => !f.group).map((f) => <option key={`r${f.name}`} value={dest(null, f.name)}>📁 {f.name}</option>)}
                {sb.groups.map((g) => (
                  <React.Fragment key={g}>
                    <option value={dest(g, null)}>{g}</option>
                    {sb.folders.filter((f) => f.group === g).map((f) => <option key={`${g}${f.name}`} value={dest(g, f.name)}>{g} / 📁 {f.name}</option>)}
                  </React.Fragment>
                ))}
              </select>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
