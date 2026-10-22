"use client";

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  // Ação destrutiva: o foco inicial fica em Cancelar e o botão de confirmar é vermelho
  danger?: boolean;
}

type ConfirmFn = (o: ConfirmOptions | string) => Promise<boolean>;

// Sem provider nunca cai nos diálogos nativos (travam o portal automatizado): recusa
const Ctx = createContext<ConfirmFn>(() => Promise.resolve(false));
export const useConfirm = () => useContext(Ctx);

// Confirmação própria (modal acessível) no lugar de window.confirm
export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState<{ opts: ConfirmOptions; resolve: (v: boolean) => void } | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  const prevFocus = useRef<HTMLElement | null>(null);

  const confirm = useCallback<ConfirmFn>(
    (o) =>
      new Promise<boolean>((resolve) => {
        prevFocus.current = document.activeElement as HTMLElement | null;
        // Uma confirmação por vez: a anterior pendente é recusada
        setPending((cur) => {
          cur?.resolve(false);
          return { opts: typeof o === "string" ? { message: o } : o, resolve };
        });
      }),
    [],
  );

  const close = (v: boolean) => {
    pending?.resolve(v);
    setPending(null);
    const el = prevFocus.current;
    if (el && document.contains(el)) setTimeout(() => el.focus());
  };

  useEffect(() => {
    if (!pending) return;
    (pending.opts.danger ? cancelRef : okRef).current?.focus();
  }, [pending]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close(false);
    } else if (e.key === "Tab") {
      // Foco preso entre os dois botões
      e.preventDefault();
      (document.activeElement === cancelRef.current ? okRef : cancelRef).current?.focus();
    }
  };

  return (
    <Ctx.Provider value={confirm}>
      {children}
      {pending &&
        typeof document !== "undefined" &&
        createPortal(
          <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/70 p-4" onMouseDown={() => close(false)}>
            <div
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="confirm-title"
              aria-describedby="confirm-message"
              onKeyDown={onKeyDown}
              onMouseDown={(e) => e.stopPropagation()}
              className="w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-950 p-5 shadow-2xl text-slate-100 font-sans"
            >
              <h3 id="confirm-title" className="text-sm font-semibold text-white">{pending.opts.title ?? "Confirmar"}</h3>
              <p id="confirm-message" className="mt-2 text-xs text-slate-300 whitespace-pre-wrap">{pending.opts.message}</p>
              <div className="mt-4 flex justify-end gap-2">
                <button ref={cancelRef} type="button" onClick={() => close(false)} className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400">
                  {pending.opts.cancelLabel ?? "Cancelar"}
                </button>
                <button
                  ref={okRef}
                  type="button"
                  onClick={() => close(true)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-300 ${pending.opts.danger ? "bg-rose-600 hover:bg-rose-500" : "bg-indigo-600 hover:bg-indigo-500"}`}
                >
                  {pending.opts.confirmLabel ?? "Confirmar"}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </Ctx.Provider>
  );
}
