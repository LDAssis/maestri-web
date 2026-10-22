"use client";

import React, { useEffect, useState } from "react";
import { Handle, Position, NodeResizer, useReactFlow } from "@xyflow/react";
import { Globe, RefreshCw, ExternalLink, ShieldCheck } from "lucide-react";
import DeleteNodeButton from "./DeleteNodeButton";
import { usePresenceStore } from "@/lib/presence";

export interface PortalNodeData extends Record<string, unknown> {
  title: string;
  url: string;
  device?: "browser" | "mobile";
}

// Só http/https; "exemplo.com" vira "http://exemplo.com". Retorna "" se inválida ou de outro esquema.
function normalizeUrl(raw: string): string {
  const v = raw.trim();
  if (!v) return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : /^(javascript|data|vbscript|file|blob|about):/i.test(v) ? "" : `http://${v}`;
  try {
    const u = new URL(withScheme);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : "";
  } catch {
    return "";
  }
}

export default function PortalNode({
  id,
  data,
  selected,
}: {
  id: string;
  data: PortalNodeData;
  selected?: boolean;
}) {
  const currentUrl = normalizeUrl(data.url || "");
  const [inputUrl, setInputUrl] = useState(data.url || "");
  const [invalid, setInvalid] = useState(false);
  const [key, setKey] = useState(0);

  // URL alterada por outro usuário: atualiza o campo (o iframe segue data.url)
  useEffect(() => {
    setInputUrl(data.url || "");
    setInvalid(false);
  }, [data.url]);
  const { updateNodeData } = useReactFlow();
  const presence = usePresenceStore();

  const handleReload = () => {
    setKey((prev) => prev + 1);
  };

  const handleNavigate = (e: React.FormEvent) => {
    e.preventDefault();
    const next = normalizeUrl(inputUrl);
    setInvalid(!next && !!inputUrl.trim());
    if (next) setInputUrl(next);
    updateNodeData(id, { url: next });
    setKey((prev) => prev + 1);
  };

  const isSelf = !!currentUrl && new URL(currentUrl).origin === location.origin;

  return (
    <div className="w-full h-full min-w-[380px] min-h-[260px] rounded-2xl border border-slate-700 bg-slate-900/95 shadow-2xl backdrop-blur-md overflow-hidden text-slate-100 font-sans transition hover:border-cyan-500 flex flex-col">
      {/* Redimensionador Oficial do React Flow */}
      <NodeResizer
        minWidth={380}
        minHeight={260}
        isVisible={selected}
        lineClassName="!border-cyan-500"
        handleClassName="!h-3 !w-3 !bg-cyan-500 !border-2 !border-slate-900 !rounded"
      />

      {/* Handle superior de conexão */}
      <Handle
        type="target"
        position={Position.Top}
        className="!w-3 !h-3 !bg-cyan-500 !border-2 !border-slate-900"
      />

      {/* Header do Navegador */}
      <div className="px-4 py-2 bg-slate-950 border-b border-slate-800 flex items-center justify-between gap-3 shrink-0">
        {/* Controles de janela */}
        <div className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-red-500/80 inline-block"></span>
          <span className="h-2.5 w-2.5 rounded-full bg-yellow-500/80 inline-block"></span>
          <span className="h-2.5 w-2.5 rounded-full bg-green-500/80 inline-block"></span>
          <span className="ml-2 text-xs font-semibold text-slate-200 flex items-center gap-1.5">
            <Globe className="h-3.5 w-3.5 text-cyan-400" />
            {data.title || "Portal Web"}
          </span>
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={handleReload}
            className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-white transition"
            title="Recarregar Portal"
          >
            <RefreshCw className="h-3 w-3" />
          </button>
          <a
            href={currentUrl || undefined}
            target="_blank"
            rel="noopener noreferrer"
            className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-white transition"
            title="Abrir em nova aba"
          >
            <ExternalLink className="h-3 w-3" />
          </a>
          <DeleteNodeButton id={id} />
        </div>
      </div>

      {/* Barra de Endereço (URL) */}
      <form
        onSubmit={handleNavigate}
        className="px-3 py-1 bg-slate-900/80 border-b border-slate-800 flex items-center gap-2 shrink-0"
      >
        <span className="text-[10px] text-slate-500 font-mono">URL:</span>
        <input
          type="text"
          value={inputUrl}
          onChange={(e) => setInputUrl(e.target.value)}
          onFocus={() => presence.setActive(id, "editing")}
          onBlur={() => presence.setActive(null, "viewing")}
          className="flex-1 bg-slate-950 border border-slate-800 rounded px-2 py-0.5 text-xs font-mono text-cyan-300 focus:outline-none focus:border-cyan-500"
          placeholder="Digite a URL…"
        />
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-950 text-cyan-400 border border-cyan-800/80 font-mono">
          DOM Inspector
        </span>
      </form>

      {/* Viewport do Navegador (Iframe auto-expansível) */}
      <div className="flex-1 w-full bg-slate-950 relative overflow-hidden">
        {currentUrl && !isSelf ? (
          <iframe
            key={key}
            src={currentUrl}
            title="Portal Web do Agente"
            className="w-full h-full border-0 bg-white"
            sandbox="allow-scripts allow-same-origin allow-forms"
          />
        ) : (
          <div className="h-full flex items-center justify-center p-4 text-center text-xs text-slate-500">
            {isSelf
              ? "Este portal apontaria para o próprio Maestri Web. Informe a URL do app que você quer testar."
              : invalid
              ? "URL inválida: use http:// ou https://"
              : "Digite a URL acima para abrir uma página."}
          </div>
        )}
      </div>

      {/* Footer bar */}
      <div className="px-3 py-1 bg-slate-950 border-t border-slate-800 flex items-center justify-between text-[10px] text-slate-400 font-mono shrink-0">
        <span className="text-cyan-400 flex items-center gap-1">
          <ShieldCheck className="h-3 w-3" />
          DOM Sandbox Conectado
        </span>
        <span className="text-slate-500">Live Viewport</span>
      </div>

      {/* Handle inferior de conexão */}
      <Handle
        type="source"
        position={Position.Bottom}
        className="!w-3 !h-3 !bg-cyan-500 !border-2 !border-slate-900"
      />
    </div>
  );
}
