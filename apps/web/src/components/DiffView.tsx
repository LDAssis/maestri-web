"use client";

import React, { useState } from "react";

export interface DiffFile {
  path: string;
  status: "A" | "M" | "D" | "R" | "?";
  additions: number;
  deletions: number;
}

export interface Diff {
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

export function PatchView({ patch, className = "max-h-[55vh]" }: { patch: string; className?: string }) {
  return (
    <pre className={`font-mono text-[11px] leading-4 overflow-auto rounded-lg border border-slate-800 bg-black/50 py-1 nowheel ${className}`}>
      {patch.split("\n").map((l, i) => (
        <div key={i} className={`px-2 whitespace-pre ${lineClass(l)}`}>
          {l || " "}
        </div>
      ))}
    </pre>
  );
}

// Patch completo -> seções por arquivo (cada uma começa em "diff --git a/x b/x")
export function patchForFile(patch: string, file: string | null) {
  if (!file) return patch;
  const sections = patch.split(/^(?=diff --git )/m).filter(Boolean);
  return sections.filter((s) => s.split("\n", 1)[0].endsWith(`b/${file}`)).join("") || patch;
}

// Lista de arquivos alterados (chips) + patch colorido do arquivo escolhido (ou de todos)
export default function DiffView({
  diff,
  error,
  patchClassName,
}: {
  diff: Diff | null;
  error?: string;
  patchClassName?: string;
}) {
  const [fileSel, setFileSel] = useState<string | null>(null);
  const sel = fileSel && diff?.files.some((f) => f.path === fileSel) ? fileSel : null;
  const chip = "px-2 py-1 rounded-md text-[11px] font-medium transition";

  if (error) return <div role="alert" className="text-[11px] text-rose-300">{error}</div>;
  if (!diff) return <div className="text-[11px] text-slate-500 font-mono">Carregando diff…</div>;
  if (diff.files.length === 0) return <div className="text-[11px] text-slate-500">Sem diferenças em relação a {diff.base}.</div>;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1 nowheel max-h-24 overflow-y-auto">
        <button
          onClick={() => setFileSel(null)}
          className={`${chip} ${sel === null ? "bg-indigo-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}
        >
          Todos ({diff.files.length})
        </button>
        {diff.files.map((f) => (
          <button
            key={f.path}
            onClick={() => setFileSel(f.path)}
            className={`${chip} font-mono ${sel === f.path ? "bg-indigo-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}
          >
            <span className={STATUS_COLOR[f.status]}>{f.status}</span> {f.path}{" "}
            <span className="text-emerald-400">+{f.additions}</span> <span className="text-rose-400">-{f.deletions}</span>
          </button>
        ))}
      </div>
      <PatchView patch={patchForFile(diff.patch, sel)} className={patchClassName} />
      {diff.truncated && <div className="text-[11px] text-amber-300">Patch truncado em 500 KB.</div>}
    </div>
  );
}
