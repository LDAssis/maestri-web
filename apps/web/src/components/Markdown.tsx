"use client";

import React from "react";
import ReactMarkdown, { Components, defaultUrlTransform } from "react-markdown";
import { AttachmentImage } from "./AttachmentView";
import remarkGfm from "remark-gfm";

// HTML cru não é renderizado (sem rehype-raw); urls javascript: são descartadas pelo react-markdown; imagens remotas desabilitadas.
// Só imagens de anexo (`![d](attachment:ID)`, geradas por `maestri say`) aparecem, buscadas com autenticação.
const components: Components = {
  h1: ({ children }) => <h1 className="text-sm font-bold mb-1.5">{children}</h1>,
  h2: ({ children }) => <h2 className="text-[13px] font-bold mb-1.5">{children}</h2>,
  h3: ({ children }) => <h3 className="text-xs font-bold mb-1">{children}</h3>,
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="list-disc pl-4 mb-2 space-y-0.5">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-4 mb-2 space-y-0.5">{children}</ol>,
  blockquote: ({ children }) => <blockquote className="border-l-2 border-white/30 pl-2 mb-2 opacity-80">{children}</blockquote>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="underline text-indigo-300 hover:text-indigo-200">
      {children}
    </a>
  ),
  pre: ({ children }) => (
    <pre className="bg-black/40 rounded-lg p-2 mb-2 overflow-x-auto font-mono text-[11px] [&_code]:bg-transparent [&_code]:p-0">
      {children}
    </pre>
  ),
  code: ({ children, className }) => (
    <code className={`bg-black/30 rounded px-1 font-mono text-[11px] ${className || ""}`}>{children}</code>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto mb-2">
      <table className="border-collapse text-[11px]">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border border-white/20 px-2 py-1 text-left font-semibold">{children}</th>,
  td: ({ children }) => <td className="border border-white/20 px-2 py-1">{children}</td>,
};

const keepAttachment = (url: string) => (url.startsWith("attachment:") ? url : defaultUrlTransform(url));

export default function Markdown({ children, projectId }: { children: string; projectId?: string }) {
  const comps: Components = {
    ...components,
    img: ({ src, alt }) => {
      const id = typeof src === "string" ? /^attachment:([0-9a-f]{12})$/.exec(src)?.[1] : undefined;
      return id && projectId ? <AttachmentImage projectId={projectId} id={id} alt={alt} /> : <span className="opacity-60">[imagem{alt ? `: ${alt}` : ""}]</span>;
    },
  };
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={keepAttachment} components={comps}>
      {children}
    </ReactMarkdown>
  );
}
