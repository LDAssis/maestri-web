"use client";

import React, { useEffect, useState } from "react";
import { Download, FileText } from "lucide-react";
import { apiFetch } from "@/lib/api";

export interface ChatAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  image: boolean;
}

// A rota é autenticada (Bearer): o arquivo vem por fetch e é exibido por blob URL, nunca por <img src> direto.
const cache = new Map<string, Promise<string | null>>();
const key = (projectId: string, id: string) => `${projectId}:${id}`;

function blobUrl(projectId: string, id: string): Promise<string | null> {
  const k = key(projectId, id);
  let p = cache.get(k);
  if (!p) {
    p = apiFetch(`/api/projects/${projectId}/attachments/${id}`)
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => (b ? URL.createObjectURL(b) : null))
      .catch(() => null);
    cache.set(k, p);
  }
  return p;
}

export function AttachmentImage({ projectId, id, alt }: { projectId: string; id: string; alt?: string }) {
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    blobUrl(projectId, id).then((u) => live && setUrl(u));
    return () => {
      live = false;
    };
  }, [projectId, id]);
  if (url === undefined) return <span className="text-[11px] text-slate-500">Carregando imagem…</span>;
  if (url === null) return <span className="text-[11px] text-rose-300">Imagem indisponível{alt ? `: ${alt}` : ""}</span>;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt={alt ?? ""} className="max-h-64 max-w-full rounded-lg border border-white/10 object-contain" />;
}

const size = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

export function AttachmentFile({ projectId, att }: { projectId: string; att: ChatAttachment }) {
  const download = async () => {
    const u = await blobUrl(projectId, att.id);
    if (!u) return;
    const a = document.createElement("a");
    a.href = u;
    a.download = att.name;
    a.click();
  };
  return (
    <button
      type="button"
      onClick={download}
      title={`Baixar ${att.name}`}
      className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-white/15 bg-black/20 px-2 py-1 text-[11px] hover:bg-black/40"
    >
      <FileText className="h-3 w-3 shrink-0" />
      <span className="truncate">{att.name}</span>
      <span className="shrink-0 opacity-60">{size(att.size)}</span>
      <Download className="h-3 w-3 shrink-0 opacity-70" />
    </button>
  );
}

// Anexos de uma mensagem: imagens embutidas e arquivos como link de download (imagens já citadas no texto ficam de fora)
export function Attachments({ projectId, items, text }: { projectId: string; items?: ChatAttachment[]; text: string }) {
  const rest = (items ?? []).filter((a) => !text.includes(`attachment:${a.id}`));
  if (!rest.length) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-start gap-1.5">
      {rest.map((a) => (a.image ? <AttachmentImage key={a.id} projectId={projectId} id={a.id} alt={a.name} /> : <AttachmentFile key={a.id} projectId={projectId} att={a} />))}
    </div>
  );
}
