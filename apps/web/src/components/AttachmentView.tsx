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
// Cache com contagem de uso: o blob URL é compartilhado entre quem o mostra; quando ninguém usa mais, ele vira "ocioso" e
// só os 50 mais recentes ficam (os demais têm o blob URL revogado, liberando a memória).
interface Blobbed {
  promise: Promise<string | null>;
  url: string | null;
  refs: number;
}
const cache = new Map<string, Blobbed>(); // ordem de inserção = ordem de uso (a mais antiga primeiro)
const IDLE_MAX = 50;
const key = (projectId: string, id: string) => `${projectId}:${id}`;

function evictIdle() {
  const idle = Array.from(cache.entries()).filter(([, b]) => b.refs === 0);
  for (const [k, b] of idle.slice(0, Math.max(0, idle.length - IDLE_MAX))) {
    if (b.url) URL.revokeObjectURL(b.url);
    cache.delete(k);
  }
}

function acquire(projectId: string, id: string): Blobbed {
  const k = key(projectId, id);
  let b = cache.get(k);
  if (b) {
    cache.delete(k); // reinsere: passa a ser o mais recente
  } else {
    const fresh: Blobbed = { refs: 0, url: null, promise: Promise.resolve(null) };
    fresh.promise = apiFetch(`/api/projects/${projectId}/attachments/${id}`)
      .then((r) => (r.ok ? r.blob() : null))
      .then((blob) => (blob ? (fresh.url = URL.createObjectURL(blob)) : null))
      .catch(() => null);
    b = fresh;
  }
  cache.set(k, b);
  b.refs++;
  return b;
}

function release(projectId: string, id: string) {
  const b = cache.get(key(projectId, id));
  if (!b) return;
  b.refs = Math.max(0, b.refs - 1);
  evictIdle();
}

export function AttachmentImage({ projectId, id, alt }: { projectId: string; id: string; alt?: string }) {
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const b = acquire(projectId, id);
    b.promise.then((u) => live && setUrl(u));
    return () => {
      live = false;
      release(projectId, id); // desmontou: o blob URL fica ocioso (e é revogado quando passa do limite)
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
    const b = acquire(projectId, att.id);
    try {
      const u = await b.promise;
      if (!u) return;
      const a = document.createElement("a");
      a.href = u;
      a.download = att.name;
      a.click();
    } finally {
      release(projectId, att.id);
    }
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
