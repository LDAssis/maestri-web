"use client";

import React, { useEffect, useId, useState } from "react";
import { apiFetch } from "@/lib/api";

// CLIs com seletor de modelo (shell não tem)
export const MODEL_CLIS = ["claude", "codex", "opencode", "agy"];

// Mesma regra do servidor (src/resume.ts validModel): vira flag de linha de comando, então é allowlist
export const validModel = (v: string) => /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}$/.test(v);
export const MODEL_ERROR = "Modelo inválido: use só letras, números e . _ : / @ - (começando por letra ou número).";

interface ModelList {
  models: { id: string; label: string }[];
  source: "static" | "cli" | "none";
}

// GET /models?cli=...; 404 (servidor sem o endpoint) e falha de rede viram source:none
export function useModels(projectId: string, cli: string | undefined): ModelList {
  const [list, setList] = useState<ModelList>({ models: [], source: "none" });
  useEffect(() => {
    if (!cli || !MODEL_CLIS.includes(cli)) return setList({ models: [], source: "none" });
    let alive = true;
    apiFetch(`/api/projects/${projectId}/models?cli=${cli}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => alive && setList(b && Array.isArray(b.models) ? { models: b.models, source: b.source ?? "static" } : { models: [], source: "none" }))
      .catch(() => alive && setList({ models: [], source: "none" }));
    return () => {
      alive = false;
    };
  }, [projectId, cli]);
  return list;
}

// Texto livre + sugestões do CLI; vazio = padrão do CLI
export default function ModelPicker({
  value,
  onChange,
  list,
  className,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  list: ModelList;
  className?: string;
  autoFocus?: boolean;
}) {
  const id = useId();
  return (
    <>
      <input
        list={id}
        value={value}
        autoFocus={autoFocus}
        maxLength={100}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Padrão do CLI"
        aria-label="Modelo"
        className={className}
      />
      <datalist id={id}>
        {list.models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </datalist>
      {list.source === "none" && <span className="mt-1 block text-[10px] text-slate-500">lista indisponível (CLI não instalado)</span>}
    </>
  );
}
