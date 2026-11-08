"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, Lightbulb, Link2, Search, X } from "lucide-react";
import { HELP_SECTIONS, SHORTCUTS, type HelpBlock, type HelpSection } from "@/lib/helpContent";
import { copyText } from "@/lib/clipboard";
import HelpClip from "./HelpClip";

// **negrito** e `código` dentro dos textos
function Rich({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("**") ? (
          <strong key={i} className="font-semibold text-white">{p.slice(2, -2)}</strong>
        ) : p.startsWith("`") ? (
          <code key={i} className="rounded bg-slate-800 px-1 py-0.5 font-mono text-[11px] text-indigo-300">{p.slice(1, -1)}</code>
        ) : (
          <React.Fragment key={i}>{p}</React.Fragment>
        ),
      )}
    </>
  );
}

const plain = (s: string) => s.replace(/\*\*|`/g, "");

function blockText(b: HelpBlock): string {
  switch (b.t) {
    case "p":
    case "tip":
    case "warn":
      return plain(b.text);
    case "steps":
    case "list":
      return b.items.map(plain).join(" ");
    case "clip":
      return plain(b.caption);
    case "shortcuts":
      return SHORTCUTS.map(([k, d]) => `${k} ${d}`).join(" ");
  }
}

function Block({ b }: { b: HelpBlock }) {
  switch (b.t) {
    case "p":
      return <p className="leading-relaxed text-slate-300"><Rich text={b.text} /></p>;
    case "steps":
      return (
        <ol className="space-y-2">
          {b.items.map((it, i) => (
            <li key={i} className="flex gap-2.5 leading-relaxed text-slate-300">
              <span aria-hidden className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-600/25 text-[10px] font-semibold text-indigo-300">{i + 1}</span>
              <span><Rich text={it} /></span>
            </li>
          ))}
        </ol>
      );
    case "list":
      return (
        <ul className="space-y-1.5">
          {b.items.map((it, i) => (
            <li key={i} className="flex gap-2 leading-relaxed text-slate-300">
              <span aria-hidden className="mt-2 h-1 w-1 shrink-0 rounded-full bg-slate-500" />
              <span><Rich text={it} /></span>
            </li>
          ))}
        </ul>
      );
    case "tip":
      return (
        <div className="flex gap-2 rounded-lg border border-indigo-500/25 bg-indigo-500/10 p-3 leading-relaxed text-slate-200">
          <Lightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0 text-indigo-300" />
          <span><strong className="text-indigo-300">Dica: </strong><Rich text={b.text} /></span>
        </div>
      );
    case "warn":
      return (
        <div className="flex gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 p-3 leading-relaxed text-slate-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" />
          <span><strong className="text-amber-300">Atenção: </strong><Rich text={b.text} /></span>
        </div>
      );
    case "clip":
      return <HelpClip id={b.id} caption={b.caption} />;
    case "shortcuts":
      return (
        <dl className="space-y-1.5">
          {SHORTCUTS.map(([k, d]) => (
            <div key={k} className="flex items-center justify-between gap-3 border-b border-slate-800/70 pb-1.5">
              <dt><kbd className="rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 font-mono text-[10px] text-indigo-300">{k}</kbd></dt>
              <dd className="text-right text-slate-300">{d}</dd>
            </div>
          ))}
        </dl>
      );
  }
}

export default function HelpCenter({ initialSection, isAdmin, onClose }: { initialSection?: string; isAdmin: boolean; onClose: () => void }) {
  const sections = useMemo(() => HELP_SECTIONS.filter((s) => !s.adminOnly || isAdmin), [isAdmin]);
  const [current, setCurrent] = useState(() => (sections.some((s) => s.id === initialSection) ? initialSection! : sections[0].id));
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const prevFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    prevFocus.current = document.activeElement as HTMLElement | null;
    return () => prevFocus.current?.focus?.();
  }, []);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);

  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [current, query]);

  const q = query.trim().toLowerCase();
  const results = useMemo(() => {
    if (!q) return [];
    return sections
      .map((s) => {
        const titleHit = s.title.toLowerCase().includes(q) || s.summary.toLowerCase().includes(q);
        const hits = s.blocks.filter((b) => blockText(b).toLowerCase().includes(q));
        return { s, blocks: titleHit && !hits.length ? s.blocks.slice(0, 1) : hits, hit: titleHit || hits.length > 0 };
      })
      .filter((r) => r.hit);
  }, [q, sections]);

  const section: HelpSection = sections.find((s) => s.id === current) ?? sections[0];

  const copyLink = async () => {
    if (await copyText(`${location.origin}/?ajuda=${section.id}`)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const open = (id: string) => {
    setCurrent(id);
    setQuery("");
  };

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/75 p-2 backdrop-blur-sm sm:p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-title"
        className="flex h-[88vh] w-full max-w-[1000px] flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 font-sans text-xs text-slate-100 shadow-2xl"
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-slate-800 px-4 py-3">
          <h2 id="help-title" className="shrink-0 text-sm font-semibold text-white">Central de Ajuda</h2>
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar na ajuda…"
              aria-label="Buscar na ajuda"
              className="w-full rounded-lg border border-slate-800 bg-slate-900 py-2 pl-8 pr-3 text-xs text-white focus:border-indigo-500 focus:outline-none"
            />
          </div>
          <button onClick={onClose} aria-label="Fechar" className="shrink-0 rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          {/* Índice: lista lateral no desktop, abas rolando na horizontal no celular */}
          <nav aria-label="Seções da ajuda" className="shrink-0 border-b border-slate-800 md:w-56 md:overflow-y-auto md:border-b-0 md:border-r">
            <ul className="flex gap-1 overflow-x-auto p-2 md:flex-col md:overflow-x-visible">
              {sections.map((s) => (
                <li key={s.id} className="shrink-0">
                  <button
                    onClick={() => open(s.id)}
                    aria-current={!q && s.id === section.id ? "page" : undefined}
                    className={`w-full whitespace-nowrap rounded-lg px-3 py-1.5 text-left transition md:whitespace-normal ${
                      !q && s.id === section.id ? "bg-indigo-600 text-white" : "text-slate-400 hover:bg-slate-900 hover:text-white"
                    }`}
                  >
                    {s.title}
                  </button>
                </li>
              ))}
            </ul>
          </nav>

          <div ref={contentRef} className="min-w-0 flex-1 overflow-y-auto p-5">
            {q ? (
              results.length === 0 ? (
                <p className="py-10 text-center text-slate-500">Nada encontrado para &quot;{query}&quot;.</p>
              ) : (
                <div className="space-y-6">
                  <p className="text-[11px] text-slate-500">{results.length} seção(ões) com resultados</p>
                  {results.map(({ s, blocks }) => (
                    <section key={s.id} className="space-y-3">
                      <button onClick={() => open(s.id)} className="text-sm font-semibold text-indigo-300 hover:underline">{s.title}</button>
                      {blocks.map((b, i) => <Block key={i} b={b} />)}
                    </section>
                  ))}
                </div>
              )
            ) : (
              <article className="space-y-4">
                <header className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-base font-semibold text-white">{section.title}</h3>
                    <p className="text-slate-500">{section.summary}</p>
                  </div>
                  <button onClick={copyLink} className="flex shrink-0 items-center gap-1 rounded-lg border border-slate-800 px-2 py-1 text-[11px] text-slate-400 hover:border-indigo-500 hover:text-white" title="Copiar link desta seção">
                    {copied ? <Check className="h-3 w-3" /> : <Link2 className="h-3 w-3" />}
                    {copied ? "Link copiado" : "Copiar link"}
                  </button>
                </header>
                {section.blocks.map((b, i) => <Block key={i} b={b} />)}
              </article>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
