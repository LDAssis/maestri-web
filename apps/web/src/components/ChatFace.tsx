"use client";

import React, { useEffect, useRef, useState } from "react";
import { useReactFlow } from "@xyflow/react";
import { Send, AtSign, Trash2, AlertTriangle } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { Avatar, readUser } from "./EntryGate";
import Markdown from "./Markdown";

export interface ChatMessage {
  id: string;
  role: "user" | "agent" | "terminal";
  text: string;
  author?: { id: string; name: string; color: string };
  at: string;
}

interface Mention {
  title: string;
  kind: string;
}

const KIND_LABEL: Record<string, string> = { agentTerminal: "agente", stickyNote: "nota", portal: "portal" };
const MAX_INPUT_HEIGHT = 6 * 16;

function TerminalOutput({ text }: { text: string }) {
  const lines = text.split("\n").length;
  return (
    <details className="max-w-full rounded-lg border border-slate-800 bg-black/40 text-[11px] text-slate-400">
      <summary className="cursor-pointer px-2 py-1 font-mono select-none hover:text-slate-200">
        Saída do terminal · {lines} {lines === 1 ? "linha" : "linhas"}
      </summary>
      <pre className="px-2 pb-2 overflow-x-auto font-mono whitespace-pre-wrap text-slate-300 max-h-60 overflow-y-auto nowheel">
        {text}
      </pre>
    </details>
  );
}

export default function ChatFace({
  projectId,
  nodeId,
  messages,
  busy,
}: {
  projectId: string;
  nodeId: string;
  messages: ChatMessage[];
  busy: boolean;
}) {
  const { getNodes, getEdges } = useReactFlow();
  const draftKey = `maestri.chatDraft.${projectId}.${nodeId}`;
  const [input, setInput] = useState(() => {
    try {
      return localStorage.getItem(draftKey) || "";
    } catch {
      return "";
    }
  });
  const [warning, setWarning] = useState("");
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stickRef = useRef(true);

  // Auto-scroll só se o usuário já estava no fim
  useEffect(() => {
    const el = listRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, busy]);

  useEffect(() => {
    try {
      if (input) localStorage.setItem(draftKey, input);
      else localStorage.removeItem(draftKey);
    } catch {}
  }, [draftKey, input]);

  // Textarea autoexpansível até 6 linhas
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_HEIGHT)}px`;
  }, [input]);

  // Nós conectados a este (qualquer direção) que casam com o texto após '@'
  const updateMentions = (value: string, caret: number) => {
    const match = /@([^@\n]*)$/.exec(value.slice(0, caret));
    if (!match) return setMentions([]);
    const linked = new Set<string>();
    for (const e of getEdges()) {
      if (e.source === nodeId) linked.add(e.target);
      if (e.target === nodeId) linked.add(e.source);
    }
    const q = match[1].toLowerCase();
    setMentions(
      getNodes()
        .filter((n) => linked.has(n.id) && (n.type === "agentTerminal" || n.type === "stickyNote") && String(n.data?.title ?? "").toLowerCase().includes(q))
        .map((n) => ({ title: String(n.data.title), kind: KIND_LABEL[String(n.type)] || "nó" }))
    );
    setMentionIndex(0);
  };

  const pickMention = (m: Mention) => {
    const el = inputRef.current;
    const caret = el?.selectionStart ?? input.length;
    const before = input.slice(0, caret).replace(/@([^@\n]*)$/, `@${m.title} `);
    setInput(before + input.slice(caret));
    setMentions([]);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(before.length, before.length);
    });
  };

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setWarning("");
    try {
      const res = await apiFetch(`/api/projects/${projectId}/nodes/${nodeId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, author: readUser() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setWarning(res.status === 409 ? body?.error || "Agente ocupado, aguarde a resposta." : body?.error || `Servidor respondeu ${res.status}`);
        return;
      }
      setInput("");
      setMentions([]);
      stickRef.current = true;
    } catch {
      setWarning("Servidor indisponível");
    }
  };

  const clearHistory = async () => {
    if (!window.confirm("Limpar o histórico do chat para todos os usuários?")) return;
    try {
      const res = await apiFetch(`/api/projects/${projectId}/nodes/${nodeId}/chat`, { method: "DELETE" });
      if (!res.ok) setWarning("Não foi possível limpar o histórico");
    } catch {
      setWarning("Não foi possível limpar o histórico");
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentions.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setMentionIndex((i) => (i + step + mentions.length) % mentions.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickMention(mentions[mentionIndex]);
        return;
      }
      if (e.key === "Escape") {
        setMentions([]);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="w-full h-full bg-[#070b16] flex flex-col p-3 min-h-0">
      <div
        ref={listRef}
        role="log"
        aria-live="polite"
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="overflow-y-auto space-y-2 pr-1 flex-1 text-xs min-h-0 nowheel"
      >
        {messages.length === 0 && (
          <div className="text-slate-500 text-center pt-6">Nenhuma mensagem. Envie uma instrução ao agente.</div>
        )}
        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="ml-auto max-w-[85%]">
              <div className="flex items-center justify-end gap-1.5 mb-0.5 text-[10px]" style={{ color: m.author?.color }}>
                {m.author && <Avatar user={m.author} size={14} />}
                <span>{m.author?.name || "Usuário"}</span>
              </div>
              <div className="p-2.5 rounded-xl bg-indigo-600 text-white leading-relaxed whitespace-pre-wrap">
                {m.text}
              </div>
            </div>
          ) : m.role === "agent" ? (
            <div
              key={m.id}
              className="max-w-[90%] p-2.5 rounded-xl bg-slate-900 border border-slate-800 text-slate-200 leading-relaxed"
            >
              <Markdown>{m.text}</Markdown>
            </div>
          ) : (
            <TerminalOutput key={m.id} text={m.text} />
          )
        )}
        {busy && <div className="text-slate-500 animate-pulse">Agente trabalhando…</div>}
      </div>

      {warning && (
        <div role="alert" className="mt-2 flex items-center gap-1.5 rounded-lg border border-amber-700/60 bg-amber-950/60 px-2 py-1 text-[11px] text-amber-300">
          <AlertTriangle className="h-3 w-3 shrink-0" />
          {warning}
        </div>
      )}

      <div className="relative mt-2 pt-2 border-t border-slate-800 flex items-end gap-2 shrink-0">
        {mentions.length > 0 && (
          <ul
            id="chat-mentions"
            role="listbox"
            className="absolute bottom-full left-8 mb-1 w-56 max-h-40 overflow-y-auto rounded-lg border border-slate-700 bg-slate-950 py-1 shadow-2xl z-10 text-xs"
          >
            {mentions.map((m, i) => (
              <li
                key={m.title}
                role="option"
                aria-selected={i === mentionIndex}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickMention(m);
                }}
                className={`flex items-center justify-between gap-2 px-2.5 py-1 cursor-pointer ${
                  i === mentionIndex ? "bg-indigo-900/50 text-white" : "text-slate-300 hover:bg-slate-900"
                }`}
              >
                <span className="truncate">{m.title}</span>
                <span className="text-[10px] text-slate-500">{m.kind}</span>
              </li>
            ))}
          </ul>
        )}
        <button
          onClick={() => {
            setInput((prev) => prev + "@");
            inputRef.current?.focus();
          }}
          className="p-1 rounded text-slate-400 hover:text-indigo-400 hover:bg-slate-800"
          title="Mencionar nó conectado (@)"
          aria-label="Mencionar nó conectado"
        >
          <AtSign className="h-3.5 w-3.5" />
        </button>
        <textarea
          ref={inputRef}
          rows={1}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            updateMentions(e.target.value, e.target.selectionStart);
          }}
          onKeyDown={onKeyDown}
          aria-label="Instrução para o agente"
          aria-autocomplete="list"
          aria-expanded={mentions.length > 0}
          aria-controls="chat-mentions"
          placeholder="Instrução (Enter envia, Shift+Enter quebra linha, @ menciona)"
          className="nodrag flex-1 resize-none bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1 text-xs leading-4 focus:outline-none focus:border-indigo-500"
        />
        <button
          onClick={clearHistory}
          className="p-1.5 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-slate-800 transition"
          title="Limpar histórico"
          aria-label="Limpar histórico"
        >
          <Trash2 className="h-3 w-3" />
        </button>
        <button
          onClick={send}
          disabled={busy || !input.trim()}
          className="p-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition disabled:opacity-40 disabled:cursor-not-allowed"
          title="Enviar"
          aria-label="Enviar"
        >
          <Send className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}
