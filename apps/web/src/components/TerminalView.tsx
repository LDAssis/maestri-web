"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { apiFetch, wsUrl } from "@/lib/api";
import { usePresenceStore } from "@/lib/presence";
import CliConfigModal, { CliPreset, DEFAULT_CLI_PRESETS } from "./CliConfigModal";
import { Settings, Copy, ClipboardPaste, TextSelect } from "lucide-react";
import { copyText, readText } from "@/lib/clipboard";

export type TerminalStatus = "conectando" | "online" | "offline" | "encerrada";

interface TerminalViewProps {
  projectId: string;
  nodeId: string;
  cwd?: string;
  initialCmd?: string;
  onStatusChange?: (status: TerminalStatus) => void;
  cliPresets?: CliPreset[];
  onUpdateConfig?: (defaultCmd: string, cliPresets: CliPreset[]) => void;
}

export default function TerminalView({
  projectId,
  nodeId,
  cwd,
  initialCmd,
  onStatusChange,
  cliPresets,
  onUpdateConfig,
}: TerminalViewProps) {
  const presence = usePresenceStore();
  const [status, setStatus] = useState<TerminalStatus>("conectando");
  const onStatusRef = useRef(onStatusChange);
  onStatusRef.current = onStatusChange;
  const connectRef = useRef<() => void>(() => {});
  const updateStatus = useCallback((next: TerminalStatus) => {
    setStatus(next);
    onStatusRef.current?.(next);
  }, []);

  const [isConfigOpen, setIsConfigOpen] = useState(false);
  const [currentPresets, setCurrentPresets] = useState<CliPreset[]>(
    cliPresets && cliPresets.length > 0 ? cliPresets : DEFAULT_CLI_PRESETS
  );
  const [currentDefaultCmd, setCurrentDefaultCmd] = useState(initialCmd || "");

  useEffect(() => {
    if (cliPresets && cliPresets.length > 0) {
      setCurrentPresets(cliPresets);
    }
  }, [cliPresets]);

  useEffect(() => {
    if (initialCmd !== undefined) {
      setCurrentDefaultCmd(initialCmd);
    }
  }, [initialCmd]);

  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  // Copiar/colar: menu do botão direito, campo de colar (quando o navegador não deixa ler a área de transferência) e aviso
  const [menu, setMenu] = useState<{ x: number; y: number; hasSelection: boolean } | null>(null);
  const [pasteBox, setPasteBox] = useState(false);
  const [flash, setFlash] = useState("");
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showFlash = useCallback((text: string) => {
    setFlash(text);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(""), 1400);
  }, []);
  const copySelection = useCallback(async () => {
    const term = termRef.current;
    const text = term?.getSelection() ?? "";
    if (!text) return showFlash("Nada selecionado");
    const ok = await copyText(text);
    showFlash(ok ? "Copiado" : "Não foi possível copiar");
    term?.focus();
  }, [showFlash]);
  const pasteFromClipboard = useCallback(async () => {
    const text = await readText();
    if (text === null) return setPasteBox(true); // sem permissão (ex.: http na rede): o usuário cola no campo
    if (text) termRef.current?.paste(text);
    termRef.current?.focus();
  }, []);
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

    // Atalhos de copiar/colar. Ctrl+C com seleção copia (sem seleção segue como interrupção, ^C);
    // Ctrl+Shift+C sempre copia. Ctrl+V / Ctrl+Shift+V não vão ao PTY: o navegador dispara o evento de colar,
    // que o xterm trata (com bracketed paste) e funciona até sem HTTPS. Shift+Insert já é nativo.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === "c" && (e.shiftKey || term.hasSelection())) {
        e.preventDefault(); // Ctrl+Shift+C abriria o inspetor do Chrome
        copySelectionRef.current();
        if (!e.shiftKey) term.clearSelection();
        return false;
      }
      if (mod && key === "v") return false;
      return true;
    });

    // Sessão compartilhada no servidor: fechar o socket não mata o PTY; reconecta com backoff
    let ws: WebSocket | null = null;
    let closed = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (retryTimer) clearTimeout(retryTimer);
      updateStatus("conectando");
      const sock = new WebSocket(
        wsUrl("/ws/terminal", { project: projectId, node: nodeId, cwd: cwd || "", cmd: currentDefaultCmd || "" })
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
  }, [projectId, nodeId, cwd, currentDefaultCmd, updateStatus, presence]);

  // O efeito do xterm não depende de copySelection; a ref mantém a versão atual para o atalho
  const copySelectionRef = useRef(copySelection);
  copySelectionRef.current = copySelection;

  // Fecha o menu ao clicar fora ou apertar Esc
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const openMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation(); // não abre o menu do canvas
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    // o nó pode estar com zoom do canvas: converte para coordenadas locais do elemento
    const scale = rect.width ? el.offsetWidth / rect.width : 1;
    setMenu({ x: (e.clientX - rect.left) * scale, y: (e.clientY - rect.top) * scale, hasSelection: !!termRef.current?.hasSelection() });
  };

  const menuAction = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    setMenu(null);
    fn();
  };

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

  const getPresetColor = (preset: CliPreset) => {
    switch (preset.id) {
      case "agy":
        return "bg-purple-950/80 text-purple-300 border-purple-800 hover:bg-purple-900";
      case "claude":
        return "bg-amber-950/80 text-amber-300 border-amber-800 hover:bg-amber-900";
      case "opencode":
        return "bg-emerald-950/80 text-emerald-300 border-emerald-800 hover:bg-emerald-900";
      default:
        return "bg-slate-900 text-slate-200 border-slate-700 hover:bg-slate-800 hover:border-indigo-500";
    }
  };

  return (
    <div
      className="nodrag nopan relative flex flex-col h-full w-full bg-[#050811] overflow-hidden min-h-0 select-text"
      onMouseDown={(e) => e.stopPropagation()}
      onFocusCapture={() => presence.setActive(nodeId, "viewing")}
      onBlurCapture={() => presence.setActive(null, "viewing")}
    >
      {/* Quick Launchers for CLI Agents */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-950 border-b border-slate-800 text-[10px] font-mono shrink-0 nodrag">
        <span className="text-slate-500 mr-1">CLI:</span>
        <div className="flex items-center gap-1 overflow-x-auto max-w-[calc(100%-120px)] pr-1">
          {currentPresets.map((preset) => (
            <button
              key={preset.id}
              onClick={() => sendCommand(preset.cmd)}
              className={`px-2 py-0.5 rounded border transition shrink-0 font-medium ${getPresetColor(preset)}`}
              title={`Executar: ${preset.cmd}`}
            >
              {preset.label}
            </button>
          ))}
        </div>

        <button
          onClick={copySelection}
          className="ml-auto p-1 rounded text-slate-500 hover:text-slate-200 hover:bg-slate-800 transition shrink-0"
          title="Copiar seleção (Ctrl+Shift+C, ou Ctrl+C com texto selecionado)"
          aria-label="Copiar seleção"
        >
          <Copy className="h-3 w-3" />
        </button>
        <button
          onClick={pasteFromClipboard}
          className="p-1 rounded text-slate-500 hover:text-slate-200 hover:bg-slate-800 transition shrink-0"
          title="Colar (Ctrl+Shift+V ou Ctrl+V)"
          aria-label="Colar"
        >
          <ClipboardPaste className="h-3 w-3" />
        </button>
        <button
          onClick={() => sendCommand("clear")}
          className="px-1.5 py-0.5 text-slate-500 hover:text-slate-300 transition shrink-0"
          title="Limpar tela"
        >
          limpar
        </button>

        <button
          onClick={() => setIsConfigOpen(true)}
          className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800 transition shrink-0 ml-1"
          title="Personalizar Comando Default e Botões CLI"
        >
          <Settings className="h-3 w-3" />
        </button>
      </div>

      {/* Terminal Container com posicionamento absoluto para prevenir expansão do container */}
      <div className="flex-1 w-full relative overflow-hidden min-h-0 nodrag nopan">
        <div
          ref={containerRef}
          className="absolute inset-0 p-2 overflow-hidden nodrag nopan"
          onMouseDown={(e) => {
            e.stopPropagation();
            termRef.current?.focus();
          }}
          onMouseUp={(e) => {
            e.stopPropagation();
          }}
          onContextMenu={openMenu}
        />
        {menu && (
          <div
            role="menu"
            aria-label="Menu do terminal"
            className="absolute z-20 min-w-[170px] rounded-lg border border-slate-700 bg-slate-900/95 py-1 text-[11px] text-slate-200 shadow-2xl nodrag nopan"
            style={{ left: menu.x, top: menu.y }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button role="menuitem" disabled={!menu.hasSelection} onClick={menuAction(copySelection)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-slate-800 disabled:opacity-40 disabled:hover:bg-transparent">
              <Copy className="h-3 w-3" /> Copiar <span className="ml-auto text-slate-500">Ctrl+Shift+C</span>
            </button>
            <button role="menuitem" onClick={menuAction(pasteFromClipboard)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-slate-800">
              <ClipboardPaste className="h-3 w-3" /> Colar <span className="ml-auto text-slate-500">Ctrl+Shift+V</span>
            </button>
            <button role="menuitem" onClick={menuAction(() => { termRef.current?.selectAll(); termRef.current?.focus(); })} className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-slate-800">
              <TextSelect className="h-3 w-3" /> Selecionar tudo
            </button>
          </div>
        )}
        {pasteBox && (
          <div className="absolute inset-x-3 top-3 z-20 rounded-lg border border-indigo-700 bg-slate-950/95 p-2 text-[11px] text-slate-300 shadow-2xl nodrag nopan" onMouseDown={(e) => e.stopPropagation()}>
            <p className="mb-1">O navegador não deixa ler a área de transferência aqui (sem HTTPS). Cole no campo abaixo com <b>Ctrl+V</b>:</p>
            <textarea
              autoFocus
              aria-label="Colar no terminal"
              rows={2}
              className="w-full resize-none rounded bg-slate-900 border border-slate-700 px-2 py-1 font-mono text-slate-100 focus:outline-none focus:border-indigo-500"
              onPaste={(e) => {
                e.preventDefault();
                const text = e.clipboardData.getData("text");
                setPasteBox(false);
                if (text) termRef.current?.paste(text);
                termRef.current?.focus();
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setPasteBox(false);
                  termRef.current?.focus();
                }
              }}
            />
            <button onClick={() => { setPasteBox(false); termRef.current?.focus(); }} className="mt-1 text-slate-500 hover:text-slate-300">Cancelar (Esc)</button>
          </div>
        )}
        {flash && (
          <div role="status" className="pointer-events-none absolute bottom-2 right-3 z-20 rounded bg-indigo-600/90 px-2 py-0.5 text-[10px] font-medium text-white shadow">
            {flash}
          </div>
        )}
        {status === "encerrada" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[#050811]/85 text-xs text-slate-300 nodrag">
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

      {/* Modal de Personalização dos Comandos */}
      <CliConfigModal
        isOpen={isConfigOpen}
        onClose={() => setIsConfigOpen(false)}
        defaultCmd={currentDefaultCmd}
        cliPresets={currentPresets}
        onRunNow={(cmd) => sendCommand(cmd)}
        onSave={(newDefaultCmd, newPresets) => {
          setCurrentDefaultCmd(newDefaultCmd);
          setCurrentPresets(newPresets);
          onUpdateConfig?.(newDefaultCmd, newPresets);
        }}
      />
    </div>
  );
}
