"use client";

import React, { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Handle, Position, NodeResizer, useReactFlow } from "@xyflow/react";
import dynamic from "next/dynamic";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronRight, File, Folder, FolderTree, RefreshCw, X } from "lucide-react";
import DeleteNodeButton from "./DeleteNodeButton";
import { apiFetch } from "@/lib/api";
import { ProjectIdContext } from "@/lib/projectContext";
import { useProjectEvents } from "@/lib/useProjectEvents";

const Monaco = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => <div className="p-3 text-xs text-slate-500 font-mono">Carregando editor…</div>,
});

export interface FileTreeNodeData extends Record<string, unknown> {
  title: string;
  root?: string; // "main" (padrão) ou nome de um andar
}

interface FileEntry {
  path: string;
  status?: string;
}

interface TreeDir {
  name: string;
  path: string;
  dirs: Map<string, TreeDir>;
  files: FileEntry[];
  changed: boolean;
}

const STATUS_COLOR: Record<string, string> = {
  M: "text-amber-300",
  A: "text-emerald-400",
  "?": "text-emerald-400",
  D: "text-rose-400",
};

const LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", md: "markdown", css: "css", scss: "scss", html: "html", yml: "yaml", yaml: "yaml",
  py: "python", go: "go", rs: "rust", java: "java", sh: "shell", sql: "sql", xml: "xml", toml: "ini", c: "c", cpp: "cpp", h: "c",
};
const languageOf = (p: string) => LANG[p.split(".").pop()?.toLowerCase() || ""] || "plaintext";

function buildTree(files: FileEntry[]): TreeDir {
  const root: TreeDir = { name: "", path: "", dirs: new Map(), files: [], changed: false };
  for (const f of files) {
    const parts = f.path.split("/");
    let dir = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts.slice(0, i + 1).join("/");
      let next = dir.dirs.get(parts[i]);
      if (!next) dir.dirs.set(parts[i], (next = { name: parts[i], path: p, dirs: new Map(), files: [], changed: false }));
      if (f.status) next.changed = true;
      dir = next;
    }
    dir.files.push(f);
  }
  return root;
}

const byName = (a: string, b: string) => a.localeCompare(b);

function Viewer({ projectId, root, path, onClose }: { projectId: string; root: string; path: string; onClose: () => void }) {
  const [state, setState] = useState<{ content?: string; binary?: boolean; error?: string }>({});
  useEffect(() => {
    let cancelled = false;
    setState({});
    apiFetch(`/api/projects/${projectId}/files/content?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.status === 413) setState({ error: "Arquivo maior que 1 MB." });
        else if (!res.ok) setState({ error: body?.error || `Servidor respondeu ${res.status}` });
        else setState({ content: body.content, binary: body.binary });
      })
      .catch(() => !cancelled && setState({ error: "Servidor indisponível" }));
    return () => {
      cancelled = true;
    };
  }, [projectId, root, path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Portal: o transform dos nós do React Flow quebraria o position:fixed do modal
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Arquivo ${path}`}
        onMouseDown={(e) => e.stopPropagation()}
        className="flex h-[80vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-slate-700 bg-slate-950 shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2 text-xs">
          <span className="truncate font-mono text-slate-200">{root} · {path}</span>
          <button autoFocus onClick={onClose} aria-label="Fechar visualizador" className="p-1 text-slate-400 hover:text-white">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="min-h-0 flex-1">
          {state.error ? (
            <div role="alert" className="p-4 text-xs text-rose-300">{state.error}</div>
          ) : state.binary ? (
            <div className="p-4 text-xs text-slate-400">Arquivo binário — sem pré-visualização.</div>
          ) : state.content === undefined ? (
            <div className="p-4 text-xs font-mono text-slate-500">Carregando…</div>
          ) : (
            <Monaco
              value={state.content}
              language={languageOf(path)}
              theme="vs-dark"
              options={{ readOnly: true, minimap: { enabled: false }, fontSize: 12, scrollBeyondLastLine: false, automaticLayout: true }}
            />
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

function DirView({
  dir,
  depth,
  open,
  toggle,
  onOpenFile,
  forceOpen,
}: {
  dir: TreeDir;
  depth: number;
  open: Set<string>;
  toggle: (p: string) => void;
  onOpenFile: (p: string) => void;
  forceOpen: boolean;
}) {
  const pad = { paddingLeft: depth * 12 + 4 };
  return (
    <>
      {Array.from(dir.dirs.values()).sort((a, b) => byName(a.name, b.name)).map((d) => {
        const isOpen = forceOpen || open.has(d.path);
        return (
          <div key={d.path}>
            <button
              onClick={() => toggle(d.path)}
              aria-expanded={isOpen}
              style={pad}
              className="flex w-full items-center gap-1 py-0.5 text-left text-slate-300 hover:bg-white/5"
            >
              {isOpen ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
              <Folder className="h-3 w-3 shrink-0 text-indigo-400" />
              <span className="truncate">{d.name}</span>
              {d.changed && <span className="h-1.5 w-1.5 rounded-full bg-amber-300" aria-label="contém alterações" />}
            </button>
            {isOpen && <DirView dir={d} depth={depth + 1} open={open} toggle={toggle} onOpenFile={onOpenFile} forceOpen={forceOpen} />}
          </div>
        );
      })}
      {[...dir.files].sort((a, b) => byName(a.path, b.path)).map((f) => (
        <button
          key={f.path}
          onClick={() => onOpenFile(f.path)}
          style={{ paddingLeft: depth * 12 + 20 }}
          className="flex w-full items-center gap-1 py-0.5 text-left text-slate-400 hover:bg-white/5 hover:text-white"
          title={f.path}
        >
          <File className="h-3 w-3 shrink-0" />
          <span className="truncate">{f.path.split("/").pop()}</span>
          {f.status && <span className={`ml-auto pr-1 font-mono text-[10px] ${STATUS_COLOR[f.status] || "text-slate-400"}`}>{f.status}</span>}
        </button>
      ))}
    </>
  );
}

export default function FileTreeNode({ id, data, selected }: { id: string; data: FileTreeNodeData; selected?: boolean }) {
  const projectId = useContext(ProjectIdContext);
  const { updateNodeData } = useReactFlow();
  const root = data.root || "main";
  const [roots, setRoots] = useState<string[]>([]);
  const [files, setFiles] = useState<FileEntry[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [viewing, setViewing] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const wt = await apiFetch(`/api/projects/${projectId}/worktrees`);
      if (wt.ok) setRoots(((await wt.json()).worktrees || []).map((w: { name: string }) => w.name));
    } catch {
      /* lista de andares é best-effort */
    }
    try {
      const res = await apiFetch(`/api/projects/${projectId}/files?root=${encodeURIComponent(root)}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `Servidor respondeu ${res.status}`);
      const body = await res.json();
      setFiles(body.files);
      setTruncated(Boolean(body.truncated));
      setError("");
    } catch (e: any) {
      setFiles(null);
      setError(e?.message || "Falha de rede");
    }
  }, [projectId, root]);

  useEffect(() => {
    setFiles(null);
    setOpen(new Set());
    load();
  }, [load]);

  useProjectEvents(projectId, (t) => {
    if (t === "worktrees" || t === "connected") load();
  });

  const q = filter.trim().toLowerCase();
  const tree = useMemo(
    () => buildTree((files || []).filter((f) => !q || f.path.toLowerCase().includes(q)).slice(0, q ? 500 : undefined)),
    [files, q]
  );
  const toggle = (p: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (!n.delete(p)) n.add(p);
      return n;
    });

  return (
    <div className={`w-full h-full min-w-[260px] min-h-[240px] rounded-xl border bg-slate-900/95 shadow-2xl overflow-hidden text-slate-100 font-sans flex flex-col ${selected ? "border-indigo-500" : "border-slate-700"}`}>
      <NodeResizer minWidth={260} minHeight={240} isVisible={selected} lineClassName="!border-indigo-500" handleClassName="!h-3 !w-3 !bg-indigo-500 !border-2 !border-slate-900 !rounded" />
      <Handle type="target" position={Position.Top} className="!w-3 !h-3 !bg-indigo-500 !border-2 !border-slate-900" />
      <div className="px-3 py-2 border-b border-slate-800 bg-slate-950/90 flex items-center justify-between gap-2 shrink-0 text-xs">
        <div className="flex items-center gap-1.5 font-semibold min-w-0">
          <FolderTree className="h-3.5 w-3.5 text-indigo-400 shrink-0" />
          <span className="truncate">{data.title || "Arquivos"}</span>
        </div>
        <div className="nodrag flex items-center gap-1.5">
          <select
            value={root}
            onChange={(e) => updateNodeData(id, { root: e.target.value })}
            aria-label="Raiz"
            className="bg-slate-900 border border-slate-800 rounded-md px-1.5 py-0.5 text-[11px] max-w-[120px] focus:outline-none focus:border-indigo-500"
          >
            <option value="main">main</option>
            {root !== "main" && !roots.includes(root) && <option value={root}>{root} (inexistente)</option>}
            {roots.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
          <button onClick={load} className="p-1 rounded hover:bg-white/10 text-slate-400 hover:text-white" aria-label="Recarregar arquivos" title="Recarregar">
            <RefreshCw className="h-3 w-3" />
          </button>
          <DeleteNodeButton id={id} />
        </div>
      </div>
      <div className="nodrag px-2 py-1.5 border-b border-slate-800 shrink-0">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filtrar por nome…"
          aria-label="Filtrar arquivos"
          className="w-full bg-slate-900 border border-slate-800 rounded-md px-2 py-1 text-[11px] focus:outline-none focus:border-indigo-500"
        />
      </div>
      <div className="nodrag flex-1 min-h-0 overflow-y-auto py-1 text-[11px] font-mono nowheel" role="tree" aria-label="Árvore de arquivos">
        {error && <div role="alert" className="px-3 py-2 text-rose-300 font-sans">{error}</div>}
        {!error && files === null && <div className="px-3 py-2 text-slate-500">Carregando…</div>}
        {files && files.length === 0 && <div className="px-3 py-2 text-slate-500 font-sans">Nenhum arquivo.</div>}
        {files && files.length > 0 && tree.files.length + tree.dirs.size === 0 && (
          <div className="px-3 py-2 text-slate-500 font-sans">Nenhum arquivo casa com o filtro.</div>
        )}
        {files && <DirView dir={tree} depth={0} open={open} toggle={toggle} onOpenFile={setViewing} forceOpen={Boolean(q)} />}
        {truncated && <div className="px-3 py-1 text-amber-300 font-sans">Lista truncada em 20000 arquivos.</div>}
      </div>
      {viewing && <Viewer projectId={projectId} root={root} path={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}
