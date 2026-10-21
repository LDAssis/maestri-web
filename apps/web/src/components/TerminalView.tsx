"use client";

import React, { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

interface TerminalViewProps {
  cwd?: string;
  initialCmd?: string;
}

export default function TerminalView({ cwd, initialCmd }: TerminalViewProps) {
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

    // Conecta via WebSocket ao Fastify Terminal
    const wsUrl = `ws://localhost:4000/ws/terminal?cwd=${encodeURIComponent(
      cwd || ""
    )}&cmd=${encodeURIComponent(initialCmd || "")}`;
    const ws = new WebSocket(wsUrl);
    socketRef.current = ws;

    ws.onmessage = (event) => {
      term.write(event.data);
    };

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    term.onResize((size) => {
      if (ws.readyState === WebSocket.OPEN) {
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
        if (Math.abs(width - lastWidth) > 4 || Math.abs(height - lastHeight) > 4) {
          lastWidth = width;
          lastHeight = height;

          if (resizeTimer) clearTimeout(resizeTimer);
          resizeTimer = setTimeout(() => {
            try {
              fitAddon.fit();
              if (ws.readyState === WebSocket.OPEN) {
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
      ws.close();
      term.dispose();
    };
  }, [cwd, initialCmd]);

  const sendCommand = (cmd: string) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(`${cmd}\r`);
    }
  };

  return (
    <div className="flex flex-col h-full w-full bg-[#050811] overflow-hidden min-h-0">
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
        <div ref={containerRef} className="absolute inset-0 p-2 overflow-hidden" />
      </div>
    </div>
  );
}
