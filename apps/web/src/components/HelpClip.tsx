"use client";

import React, { useEffect, useRef, useState } from "react";
import { Maximize2, Play, X } from "lucide-react";

// Clipe curto (gravação real da tela) em /help/<id>.webm com poster /help/<id>.jpg.
// Só carrega quando entra na tela; com "reduzir movimento" mostra o poster e um botão de play.
export default function HelpClip({ id, caption }: { id: string; caption: string }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [zoom, setZoom] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    try {
      setReduced(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    } catch {}
  }, []);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") return setVisible(true);
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && (setVisible(true), io.disconnect()), { rootMargin: "120px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!zoom) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setZoom(false);
      }
    };
    document.addEventListener("keydown", esc, true);
    return () => document.removeEventListener("keydown", esc, true);
  }, [zoom]);

  if (failed) return null;
  const src = `/help/${id}.webm`;
  const poster = `/help/${id}.jpg`;
  const autoplay = visible && (!reduced || playing);

  const video = (cls: string) => (
    <video
      key={autoplay ? "play" : "still"}
      className={cls}
      src={visible ? src : undefined}
      poster={poster}
      autoPlay={autoplay}
      muted
      loop
      playsInline
      preload="none"
      aria-label={caption}
      onError={() => setFailed(true)}
    />
  );

  return (
    <>
      <figure ref={boxRef} className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900">
        <div className="relative">
          {video("block aspect-[1120/700] w-full bg-slate-950 object-cover")}
          {reduced && !playing && (
            <button onClick={() => setPlaying(true)} aria-label={`Reproduzir: ${caption}`} className="absolute inset-0 flex items-center justify-center bg-black/30 text-white hover:bg-black/40">
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-indigo-600 shadow-lg"><Play className="h-5 w-5" /></span>
            </button>
          )}
          <button
            onClick={() => setZoom(true)}
            aria-label="Ampliar clipe"
            title="Ampliar"
            className="absolute right-2 top-2 rounded-lg bg-black/60 p-1.5 text-slate-200 opacity-80 hover:bg-black/80 hover:opacity-100"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
        </div>
        <figcaption className="px-3 py-2 text-[11px] text-slate-400">{caption}</figcaption>
      </figure>
      {zoom && (
        <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/90 p-4" onMouseDown={(e) => e.target === e.currentTarget && setZoom(false)} role="dialog" aria-modal="true" aria-label={caption}>
          <button onClick={() => setZoom(false)} aria-label="Fechar" className="absolute right-4 top-4 rounded-lg bg-slate-800 p-2 text-white hover:bg-slate-700">
            <X className="h-4 w-4" />
          </button>
          <div className="max-h-full w-full max-w-[1280px]">
            <video className="max-h-[85vh] w-full rounded-xl bg-black" src={src} poster={poster} autoPlay muted loop playsInline controls />
            <p className="mt-2 text-center text-xs text-slate-300">{caption}</p>
          </div>
        </div>
      )}
    </>
  );
}
