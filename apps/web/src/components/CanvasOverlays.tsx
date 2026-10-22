"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Node } from "@xyflow/react";
import { Search, Bot, StickyNote, Globe, Plus, FolderTree, FileDiff, Layers } from "lucide-react";

export const NOTE_COLORS = ["amber", "indigo", "emerald", "rose"] as const;
export const NOTE_DOT: Record<string, string> = {
  amber: "bg-amber-400",
  indigo: "bg-indigo-400",
  emerald: "bg-emerald-400",
  rose: "bg-rose-400",
};

const TYPE_LABEL: Record<string, string> = { agentTerminal: "agente", stickyNote: "nota", portal: "portal", fileTree: "arquivos", diff: "diff", noteStack: "fichário" };

// Devolve o foco ao elemento que o tinha antes do overlay abrir
// Captura o foco no render (antes do autoFocus do commit) e o devolve ao desmontar — só se o foco
// caiu no body (desmontagem real); a desmontagem simulada do StrictMode mantém o input focado
function useRestoreFocus() {
  const [prev] = useState(() => document.activeElement as HTMLElement | null);
  useEffect(() => {
    return () => {
      setTimeout(() => {
        const active = document.activeElement;
        if ((!active || active === document.body) && prev && document.contains(prev)) prev.focus();
      });
    };
  }, [prev]);
}

export interface PaletteAction {
  label: string;
  run: () => void;
}

export function CommandPalette({
  nodes,
  actions,
  onPickNode,
  onClose,
}: {
  nodes: Node<any>[];
  actions: PaletteAction[];
  onPickNode: (id: string) => void;
  onClose: () => void;
}) {
  useRestoreFocus();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    const nodeItems = nodes
      .filter((n) => {
        if (!q) return true;
        const d = n.data || {};
        return [d.title, d.role, n.type === "stickyNote" ? d.content : ""].some((v) => String(v ?? "").toLowerCase().includes(q));
      })
      .slice(0, 50)
      .map((n) => ({
        key: `n:${n.id}`,
        label: String(n.data?.title ?? n.id),
        hint: TYPE_LABEL[String(n.type)] || "nó",
        run: () => onPickNode(n.id),
      }));
    const actionItems = actions
      .filter((a) => !q || a.label.toLowerCase().includes(q))
      .map((a) => ({ key: `a:${a.label}`, label: a.label, hint: "ação", run: a.run }));
    return [...nodeItems, ...actionItems];
  }, [query, nodes, actions, onPickNode]);

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    listRef.current?.children[index]?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (items.length) setIndex((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length);
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      const it = items[index];
      if (it) {
        onClose();
        it.run();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Tab") {
      e.preventDefault(); // foco preso no campo; a lista navega com as setas
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[15vh] px-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Buscar no canvas"
        onMouseDown={(e) => e.stopPropagation()}
        className="w-full max-w-lg rounded-xl border border-slate-700 bg-slate-950 shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-slate-800 px-3">
          <Search className="h-4 w-4 text-slate-500" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={items[index] ? `palette-${index}` : undefined}
            aria-label="Buscar nós ou ações"
            placeholder="Buscar nó por título, conteúdo ou papel…"
            className="flex-1 bg-transparent py-3 text-xs text-white placeholder-slate-500 focus:outline-none"
          />
        </div>
        <ul ref={listRef} id="palette-list" role="listbox" className="max-h-72 overflow-y-auto py-1 text-xs">
          {items.length === 0 && <li className="px-3 py-3 text-slate-500">Nada encontrado.</li>}
          {items.map((it, i) => (
            <li
              key={it.key}
              id={`palette-${i}`}
              role="option"
              aria-selected={i === index}
              onMouseMove={() => setIndex(i)}
              onClick={() => {
                onClose();
                it.run();
              }}
              className={`flex cursor-pointer items-center justify-between gap-2 px-3 py-1.5 ${
                i === index ? "bg-indigo-900/50 text-white" : "text-slate-300"
              }`}
            >
              <span className="truncate">{it.label}</span>
              <span className="text-[10px] text-slate-500">{it.hint}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export interface MenuState {
  x: number;
  y: number;
  nodeId?: string;
  nodeType?: string;
  flow: { x: number; y: number };
}

export function ContextMenu({
  menu,
  onClose,
  onAdd,
  onDuplicate,
  onExport,
  onImport,
  onDelete,
  onColor,
}: {
  menu: MenuState;
  onClose: () => void;
  onAdd: (kind: "agent" | "note" | "portal" | "fileTree" | "diff" | "noteStack", at: { x: number; y: number }) => void;
  onDuplicate: (id: string) => void;
  onExport: (nodeId?: string) => void;
  onImport: () => void;
  onDelete: (id: string) => void;
  onColor: (id: string, color: string) => void;
}) {
  useRestoreFocus();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
  }, []);

  const act = (fn: () => void) => () => {
    onClose();
    fn();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? []);
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Tab"].includes(e.key)) {
      e.preventDefault();
      const back = e.key === "ArrowUp" || e.key === "ArrowLeft" || (e.key === "Tab" && e.shiftKey);
      items[(i + (back ? -1 : 1) + items.length) % items.length]?.focus();
    }
  };

  const item = "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-slate-200 hover:bg-indigo-900/50 focus:bg-indigo-900/50 focus:outline-none";
  const x = Math.min(menu.x, window.innerWidth - 200);
  const y = Math.min(menu.y, window.innerHeight - 220);

  return (
    <div className="fixed inset-0 z-50" onMouseDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }}>
      <div
        ref={ref}
        role="menu"
        aria-label={menu.nodeId ? "Ações do nó" : "Ações do canvas"}
        onKeyDown={onKeyDown}
        onMouseDown={(e) => e.stopPropagation()}
        style={{ left: x, top: y }}
        className="absolute w-48 overflow-hidden rounded-lg border border-slate-700 bg-slate-950 py-1 shadow-2xl"
      >
        {menu.nodeId ? (
          <>
            <button role="menuitem" className={item} onClick={act(() => onDuplicate(menu.nodeId!))}>Duplicar</button>
            <button role="menuitem" className={item} onClick={act(() => onExport(menu.nodeId))}>Exportar partitura</button>
            <button role="menuitem" className={`${item} text-rose-300`} onClick={act(() => onDelete(menu.nodeId!))}>Apagar</button>
            {menu.nodeType === "stickyNote" && (
              <>
                <div className="px-3 pt-1.5 text-[10px] uppercase text-slate-500">Cor ▸</div>
                {NOTE_COLORS.map((c) => (
                  <button key={c} role="menuitem" className={item} onClick={act(() => onColor(menu.nodeId!, c))}>
                    <span className={`h-2.5 w-2.5 rounded-full ${NOTE_DOT[c]}`} />
                    {c}
                  </button>
                ))}
              </>
            )}
          </>
        ) : (
          <>
            <button role="menuitem" className={item} onClick={act(() => onAdd("agent", menu.flow))}><Bot className="h-3 w-3" />Novo agente</button>
            <button role="menuitem" className={item} onClick={act(() => onAdd("note", menu.flow))}><StickyNote className="h-3 w-3" />Nova nota</button>
            <button role="menuitem" className={item} onClick={act(() => onAdd("noteStack", menu.flow))}><Layers className="h-3 w-3" />Novo fichário</button>
            <button role="menuitem" className={item} onClick={act(() => onAdd("portal", menu.flow))}><Globe className="h-3 w-3" />Novo portal</button>
            <button role="menuitem" className={item} onClick={act(() => onAdd("fileTree", menu.flow))}><FolderTree className="h-3 w-3" />Nova árvore de arquivos</button>
            <button role="menuitem" className={item} onClick={act(() => onAdd("diff", menu.flow))}><FileDiff className="h-3 w-3" />Novo diff</button>
            <button role="menuitem" className={item} onClick={act(() => onExport())}>Exportar partitura</button>
            <button role="menuitem" className={item} onClick={act(onImport)}>Importar partitura</button>
          </>
        )}
      </div>
    </div>
  );
}

const SHORTCUTS: [string, string][] = [
  ["A", "Novo agente"],
  ["N", "Nova nota"],
  ["P", "Novo portal"],
  ["F", "Enquadrar tudo"],
  ["Ctrl/⌘ K", "Buscar"],
  ["Ctrl/⌘ E", "Exportar partitura (seleção ou tudo)"],
  ["Ctrl/⌘ I", "Importar partitura"],
  ["Delete / Backspace", "Apagar nó selecionado"],
  ["Botão direito", "Menu de contexto"],
  ["?", "Esta lista"],
];

export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  useRestoreFocus();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Atalhos de teclado"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Tab") e.preventDefault(); // único elemento focável
        }}
        className="w-full max-w-sm rounded-xl border border-slate-700 bg-slate-950 p-4 shadow-2xl"
      >
        <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-white"><Plus className="h-3 w-3 rotate-45" />Atalhos</h3>
        <dl className="space-y-1 text-xs">
          {SHORTCUTS.map(([k, d]) => (
            <div key={k} className="flex items-center justify-between gap-3">
              <dt><kbd className="rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 font-mono text-[10px] text-indigo-300">{k}</kbd></dt>
              <dd className="text-slate-300">{d}</dd>
            </div>
          ))}
        </dl>
        <button
          autoFocus
          onClick={onClose}
          className="mt-3 w-full rounded-lg bg-indigo-600 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
        >
          Fechar
        </button>
      </div>
    </div>
  );
}
