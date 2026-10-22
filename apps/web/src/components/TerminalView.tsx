"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { apiFetch, wsUrl } from "@/lib/api";
import { usePresenceStore } from "@/lib/presence";

export type TerminalStatus = "conectando" | "online" | "offline" | "encerrada";

interface TerminalViewProps {
  projectId: string;
  nodeId: string;
  cwd?: string;
  initialCmd?: string;
  onStatusChange?: (status: TerminalStatus) => void;
}

export default function TerminalView({ projectId, nodeId, cwd, initialCmd, onStatusChange }: TerminalViewProps) {
  const presence = usePresenceStore();
  const [status, setStatus] = useState<TerminalStatus>("conectando");
  const onStatusRef = useRef(onStatusChange);
  onStatusRef.current = onStatusChange;
  const connectRef = useRef<() => void>(() => {});
  const updateStatus = useCallback((next: TerminalStatus) => {
    setStatus(next);
    onStatusRef.current?.(next);
  }, []);

  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      theme: {
        background: "#050811",
        foreground: "#f8fafc",
        cursor: "#818cf8",
        selectionBackground: "#312e81",
        black: "#0f172a",
        red: "#f87171",
        green: "#4ade80",
        yellow: "#facc15",
        blue: "#60a5fa",
        magenta: "#c084fc",
        cyan: "#38bdf8",
        white: "#f8fafc",
      },
      fontFamily: "Consolas, 'Courier New', monospace",
      fontSize: 12,
      lineHeight: 1.2,
      convertEol: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    termRef.current = term;

    // Sessão compartilhada no servidor: fechar o socket não mata o PTY; reconecta com backoff
    let ws: WebSocket | null = null;
    let closed = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (retryTimer) clearTimeout(retryTimer);
      updateStatus("conectando");
      const sock = new WebSocket(
        wsUrl("/ws/terminal", { project: projectId, node: nodeId, cwd: cwd || "", cmd: initialCmd || "" })
      );
      ws = sock;
      socketRef.current = sock;

      sock.onopen = () => {
        attempt = 0;
        term.reset(); // o servidor reenvia o scrollback inteiro ao anexar
        updateStatus("online");
        try {
          fitAddon.fit();
        } catch {}
        sock.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      };

      sock.onmessage = (event) => {
        term.write(event.data);
      };

      sock.onclose = (event) => {
        if (closed || ws !== sock) return;
        if (event.code === 4000) {
          updateStatus("encerrada");
          return;
        }
        updateStatus("offline");
        retryTimer = setTimeout(connect, Math.min(1000 * 2 ** attempt, 10000));
        attempt++;
      };
    };
    connectRef.current = () => {
      attempt = 0;
      ws?.close();
      connect();
    };
    connect();

    term.onData((data) => {
      presence.typing(nodeId);
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    term.onResize((size) => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols: size.cols, rows: size.rows }));
      }
    });

    // Proteção contra loop infinito: debounce e verificação de alteração real de tamanho
    let lastWidth = 0;
    let lastHeight = 0;
    let resizeTimer: NodeJS.Timeout | null = null;

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        // Terminal escondido (face Chat): não ajustar para 0x0, senão o PTY encolhe
        if (width === 0 || height === 0) continue;
        if (Math.abs(width - lastWidth) > 4 || Math.abs(height - lastHeight) > 4) {
          lastWidth = width;
          lastHeight = height;

          if (resizeTimer) clearTimeout(resizeTimer);
          resizeTimer = setTimeout(() => {
            try {
              fitAddon.fit();
              if (ws?.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
              }
            } catch {}
          }, 60);
        }
      }
    });

    resizeObserver.observe(containerRef.current);

    setTimeout(() => {
      try {
        fitAddon.fit();
      } catch {}
    }, 150);

    return () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeObserver.disconnect();
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      ws?.close();
      term.dispose();
    };
  }, [projectId, nodeId, cwd, initialCmd, updateStatus, presence]);

  const restartSession = async () => {
    try {
      await apiFetch(`/api/projects/${projectId}/sessions/${nodeId}/restart`, { method: "POST" });
    } catch {}
    connectRef.current();
  };

  const sendCommand = (cmd: string) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(`${cmd}\r`);
    }
  };

  return (
    <div
      className="nodrag nopan flex flex-col h-full w-full bg-[#050811] overflow-hidden min-h-0 select-text" onMouseDown={(e) => e.stopPropagation()}
      onFocusCapture={() => presence.setActive(nodeId, "viewing")}
      onBlurCapture={() => presence.setActive(null, "viewing")}
    >
      {/* Quick Launchers for CLI Agents */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-950 border-b border-slate-800 text-[10px] font-mono shrink-0">
        <span className="text-slate-500 mr-1">CLI Rápido:</span>
        <button
          onClick={() => sendCommand("agy")}
          className="px-2 py-0.5 rounded bg-purple-950/80 text-purple-300 border border-purple-800 hover:bg-purple-900 transition"
        >
          agy
        </button>
        <button
          onClick={() => sendCommand("claude")}
          className="px-2 py-0.5 rounded bg-amber-950/80 text-amber-300 border border-amber-800 hover:bg-amber-900 transition"
        >
          claude
        </button>
        <button
          onClick={() => sendCommand("opencode")}
          className="px-2 py-0.5 rounded bg-emerald-950/80 text-emerald-300 border border-emerald-800 hover:bg-emerald-900 transition"
        >
          opencode
        </button>
        <button
          onClick={() => sendCommand("clear")}
          className="ml-auto px-1.5 py-0.5 text-slate-500 hover:text-slate-300 transition"
        >
          limpar
        </button>
      </div>

      {/* Terminal Container com posicionamento absoluto para prevenir expansão do container */}
      <div className="flex-1 w-full relative overflow-hidden min-h-0">
        <div ref={containerRef} className="absolute inset-0 p-2 overflow-hidden nodrag nopan" onMouseDown={(e) => { e.stopPropagation(); termRef.current?.focus(); }} onMouseUp={(e) => { e.stopPropagation(); }} />
        {status === "encerrada" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[#050811]/85 text-xs text-slate-300">
            <span>Sessão encerrada</span>
            <button
              onClick={restartSession}
              className="px-3 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium transition"
            >
              Reiniciar
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
