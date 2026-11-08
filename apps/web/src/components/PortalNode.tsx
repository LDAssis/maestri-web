"use client";

import React, { useCallback, useContext, useEffect, useRef, useState } from "react";
import { Handle, Position, NodeResizer, useReactFlow, useStoreApi } from "@xyflow/react";
import { Globe, RefreshCw, ExternalLink, ShieldCheck, ArrowLeft, ArrowRight, Radio } from "lucide-react";
import DeleteNodeButton from "./DeleteNodeButton";
import { usePresenceStore } from "@/lib/presence";
import { wsUrl } from "@/lib/api";
import { ProjectIdContext } from "@/lib/projectContext";

export interface PortalNodeData extends Record<string, unknown> {
  title: string;
  url: string;
  device?: "browser" | "mobile";
  // Sessão automatizada (Chromium no servidor) em vez do iframe
  live?: boolean;
  viewport?: { w: number; h: number };
}

type LiveStatus = "conectando" | "online" | "offline";
interface LiveMeta {
  url: string;
  title: string;
  w: number;
  h: number;
}

// Mostra a sessão Chromium do servidor (frames JPEG) e repassa clique, digitação e rolagem do usuário
// `viewEl` é a área da imagem: serve para pausar quando ninguém vê e para informar ao servidor o tamanho exibido
function useLiveSession(projectId: string, nodeId: string, enabled: boolean, viewEl: React.RefObject<HTMLElement>) {
  const storeApi = useStoreApi();
  // Pausa (≠ queda): fora da área visível do canvas ou aba escondida o WS fecha e o servidor para a captura
  const [seen, setSeen] = useState(true);
  const [frame, setFrame] = useState<string | null>(null);
  const [meta, setMeta] = useState<LiveMeta | null>(null);
  const [status, setStatus] = useState<LiveStatus>("conectando");
  const [error, setError] = useState("");
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const el = viewEl.current;
    const io = el && typeof IntersectionObserver !== "undefined" ? new IntersectionObserver((es) => ((inView = es[es.length - 1].isIntersecting), update())) : null;
    let inView = !io;
    let tabOn = document.visibilityState !== "hidden";
    const update = () => setSeen(inView && tabOn);
    const onVis = () => ((tabOn = document.visibilityState !== "hidden"), update());
    if (el) io?.observe(el);
    document.addEventListener("visibilitychange", onVis);
    update();
    return () => {
      io?.disconnect();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [enabled, viewEl]);

  useEffect(() => {
    if (!enabled || !projectId || !seen) return;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let lastUrl: string | null = null;

    // Tamanho EXIBIDO da imagem em pixels de tela (o rect já inclui o zoom do canvas) × devicePixelRatio, com debounce
    let viewTimer: ReturnType<typeof setTimeout> | undefined;
    const sendView = () => {
      clearTimeout(viewTimer);
      viewTimer = setTimeout(() => {
        const ws = wsRef.current;
        const r = viewEl.current?.getBoundingClientRect();
        if (!ws || ws.readyState !== WebSocket.OPEN || !r || !r.width || !r.height) return;
        const dpr = window.devicePixelRatio || 1;
        ws.send(JSON.stringify({ type: "view", maxWidth: Math.round(r.width * dpr), maxHeight: Math.round(r.height * dpr) }));
      }, 300);
    };
    // Resize do nó muda o layout (ResizeObserver); zoom não muda: ouve só o zoom no store, sem re-render
    const ro = typeof ResizeObserver !== "undefined" && viewEl.current ? new ResizeObserver(sendView) : null;
    if (viewEl.current) ro?.observe(viewEl.current);
    let zoom = storeApi.getState().transform[2];
    const unsub = storeApi.subscribe((s) => {
      if (s.transform[2] !== zoom) {
        zoom = s.transform[2];
        sendView();
      }
    });

    const connect = () => {
      setStatus("conectando");
      const ws = new WebSocket(wsUrl("/ws/portal", { project: projectId, node: nodeId }));
      ws.binaryType = "blob";
      wsRef.current = ws;
      ws.onopen = () => {
        setStatus("online");
        sendView();
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          try {
            const m = JSON.parse(ev.data);
            if (m.type === "meta") setMeta({ url: m.url, title: m.title, w: m.w, h: m.h });
            else if (m.type === "error") setError(String(m.error));
          } catch {}
          return;
        }
        setError("");
        const url = URL.createObjectURL(ev.data as Blob);
        setFrame(url);
        if (lastUrl) URL.revokeObjectURL(lastUrl);
        lastUrl = url;
      };
      ws.onclose = () => {
        // Um socket antigo (ex.: efeito duplicado do StrictMode) não pode apagar a referência do novo
        if (wsRef.current === ws) wsRef.current = null;
        if (closed) return;
        setStatus("offline");
        retry = setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      clearTimeout(viewTimer);
      ro?.disconnect();
      unsub();
      wsRef.current?.close();
      wsRef.current = null;
      if (lastUrl) URL.revokeObjectURL(lastUrl);
      setFrame(null);
    };
  }, [enabled, projectId, nodeId, seen, viewEl, storeApi]);

  const send = useCallback((msg: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  return { frame, meta, status, error, send };
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
  const projectId = useContext(ProjectIdContext);
  const live = data.live === true;
  const viewRef = useRef<HTMLDivElement>(null);
  const session = useLiveSession(projectId, id, live, viewRef);
  const urlFocused = useRef(false);
  const wheelAcc = useRef({ x: 0, y: 0, dx: 0, dy: 0, timer: 0 as unknown as ReturnType<typeof setTimeout> });

  // A barra de URL reflete a página automatizada (a menos que o usuário esteja digitando)
  useEffect(() => {
    if (live && session.meta?.url && !urlFocused.current) setInputUrl(session.meta.url);
  }, [live, session.meta?.url]);

  const vp = session.meta ? { w: session.meta.w, h: session.meta.h } : data.viewport ?? { w: 1280, h: 800 };

  // Coordenada do ponteiro -> pixel CSS do viewport do Chromium (a imagem é escalada com letterbox)
  const toViewport = (clientX: number, clientY: number) => {
    const r = viewRef.current!.getBoundingClientRect();
    const scale = Math.min(r.width / vp.w, r.height / vp.h);
    const offX = (r.width - vp.w * scale) / 2;
    const offY = (r.height - vp.h * scale) / 2;
    return { x: Math.round((clientX - r.left - offX) / scale), y: Math.round((clientY - r.top - offY) / scale) };
  };

  const onLiveClick = (e: React.MouseEvent) => {
    viewRef.current?.focus();
    const p = toViewport(e.clientX, e.clientY);
    if (p.x >= 0 && p.y >= 0 && p.x <= vp.w && p.y <= vp.h) session.send({ type: "click", ...p, dbl: e.detail === 2 });
  };

  const onLiveKey = (e: React.KeyboardEvent) => {
    if (e.key === "Dead" || e.key === "Process") return;
    e.preventDefault();
    e.stopPropagation();
    const mod = e.ctrlKey || e.metaKey || e.altKey;
    if (e.key.length === 1 && !mod) return session.send({ type: "type", text: e.key });
    if (["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(e.key)) return;
    const named = e.key === " " ? "Space" : e.key;
    const keys = [e.ctrlKey && "ctrl", e.metaKey && "cmd", e.altKey && "alt", e.shiftKey && e.key.length > 1 && "shift", named].filter(Boolean);
    session.send({ type: "key", key: keys.join("+") });
  };

  // Rolagem agrupada (~20 envios/s) para não inundar o servidor
  const onLiveWheel = (e: React.WheelEvent) => {
    const a = wheelAcc.current;
    const p = toViewport(e.clientX, e.clientY);
    a.x = p.x;
    a.y = p.y;
    a.dx += e.deltaX;
    a.dy += e.deltaY;
    if (a.timer) return;
    a.timer = setTimeout(() => {
      session.send({ type: "scroll", x: a.x, y: a.y, dx: a.dx, dy: a.dy });
      a.dx = a.dy = 0;
      a.timer = 0 as unknown as ReturnType<typeof setTimeout>;
    }, 50);
  };

  const handleReload = () => {
    if (live) session.send({ type: "reload" });
    else setKey((prev) => prev + 1);
  };

  const handleNavigate = (e: React.FormEvent) => {
    e.preventDefault();
    const next = normalizeUrl(inputUrl);
    setInvalid(!next && !!inputUrl.trim());
    if (next) setInputUrl(next);
    updateNodeData(id, { url: next });
    if (live && next) session.send({ type: "navigate", url: next });
    setKey((prev) => prev + 1);
  };

  const isSelf = !!currentUrl && new URL(currentUrl).origin === location.origin;

  return (
    <div className="w-full h-full min-w-[380px] min-h-[260px] rounded-2xl border border-slate-700 bg-slate-900/95 shadow-2xl backdrop-blur-md overflow-hidden text-slate-100 font-sans transition hover:border-cyan-500 flex flex-col">
      {/* Redimensionador Oficial do React Flow */}
      <NodeResizer
        minWidth={380}
        minHeight={260}
        isVisible={true}
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
          {live && (
            <>
              <button onClick={() => session.send({ type: "back" })} className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-white transition" title="Voltar">
                <ArrowLeft className="h-3 w-3" />
              </button>
              <button onClick={() => session.send({ type: "forward" })} className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-white transition" title="Avançar">
                <ArrowRight className="h-3 w-3" />
              </button>
            </>
          )}
          <button
            onClick={() => updateNodeData(id, { live: !live })}
            className={`p-1 rounded transition ${live ? "text-emerald-400 hover:bg-slate-800" : "text-slate-400 hover:bg-slate-800 hover:text-white"}`}
            title={live ? "Sessão ao vivo (Chromium): voltar ao iframe" : "Ligar a sessão ao vivo (Chromium automatizável)"}
          >
            <Radio className="h-3 w-3" />
          </button>
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
          onFocus={() => {
            urlFocused.current = true;
            presence.setActive(id, "editing");
          }}
          onBlur={() => {
            urlFocused.current = false;
            presence.setActive(null, "viewing");
          }}
          className="flex-1 bg-slate-950 border border-slate-800 rounded px-2 py-0.5 text-xs font-mono text-cyan-300 focus:outline-none focus:border-cyan-500"
          placeholder="Digite a URL…"
        />
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-950 text-cyan-400 border border-cyan-800/80 font-mono">
          {live ? "Ao vivo" : "iframe"}
        </span>
      </form>

      {/* Viewport do Navegador (Iframe auto-expansível) */}
      <div className="flex-1 w-full bg-slate-950 relative overflow-hidden">
        {live ? (
          <div
            ref={viewRef}
            tabIndex={0}
            onClick={onLiveClick}
            onKeyDown={onLiveKey}
            onWheel={onLiveWheel}
            className="nodrag nowheel nopan w-full h-full outline-none focus:ring-1 focus:ring-cyan-500/60 cursor-default bg-white"
          >
            {session.frame ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={session.frame} alt="Sessão do portal" draggable={false} className="w-full h-full object-contain select-none pointer-events-none" />
            ) : (
              <div className="h-full flex items-center justify-center p-4 text-center text-xs text-slate-500 bg-slate-950">
                {session.error || (session.status === "online" ? "Abrindo o navegador…" : "Conectando à sessão…")}
              </div>
            )}
            {session.error && session.frame && (
              <div className="absolute bottom-1 left-1 right-1 rounded bg-red-950/90 border border-red-800 text-red-200 text-[10px] px-2 py-1">{session.error}</div>
            )}
          </div>
        ) : currentUrl && !isSelf ? (
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
          {live ? "Chromium automatizado" : "DOM Sandbox Conectado"}
        </span>
        <span className="text-slate-500">{live ? `${vp.w}×${vp.h} · ${session.status}` : "Live Viewport"}</span>
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
