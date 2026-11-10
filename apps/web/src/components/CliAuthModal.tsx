"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, ChevronDown, Copy, Download, ExternalLink, KeyRound, Loader2, LogIn, LogOut, Plus, RefreshCw, Send, X } from "lucide-react";
import { accountProgramOf } from "@/lib/accounts";
import { apiFetch, wsUrl } from "@/lib/api";
import { copyText, readText } from "@/lib/clipboard";

type JobState = "running" | "waiting_input" | "done" | "failed" | "cancelled";

interface JobRef {
  id: string;
  cliId: string;
  kind: "install" | "login";
  state: JobState;
}

interface Job extends JobRef {
  account?: string;
  log: string;
  url?: string;
  code?: string;
  exitCode?: number;
  error?: string;
}

interface CliInfo {
  id: string;
  label: string;
  installed: boolean;
  version: string | null;
  path: string | null;
  loggedIn: boolean | null;
  loginDetail?: string;
  accountsSupported: boolean;
  installCmd: string;
  activeJob?: JobRef;
}

interface Account {
  program: string;
  name: string;
}

const DEFAULT_ACCOUNT = "";
const MAX_LOG = 200_000;
const ORDER = ["claude", "codex", "agy", "opencode", "gemini"];
const isTerminal = (s: JobState) => s === "done" || s === "failed" || s === "cancelled";

const BRAND: Record<string, { name: string; desc: string; mono: string; bg: string; fg: string }> = {
  claude: { name: "Claude Code", desc: "Agente de código da Anthropic", mono: "C", bg: "#D97757", fg: "#ffffff" },
  codex: { name: "Codex", desc: "Agente de código da OpenAI", mono: "Cx", bg: "#0b3d2e", fg: "#ffffff" },
  agy: { name: "Antigravity", desc: "CLI de agentes do Google", mono: "A", bg: "#4285F4", fg: "#ffffff" },
  opencode: { name: "OpenCode", desc: "Agente open source para o terminal", mono: "OC", bg: "#52525b", fg: "#ffffff" },
  gemini: { name: "Gemini CLI", desc: "Gemini direto no terminal", mono: "G", bg: "linear-gradient(135deg,#4285F4,#9B72CB)", fg: "#ffffff" },
};
const brandOf = (c: { id: string; label: string }) => BRAND[c.id] ?? { name: c.label, desc: "CLI de agente", mono: c.label.slice(0, 1).toUpperCase(), bg: "#475569", fg: "#ffffff" };

async function errorOf(res: Response | null, fallback: string) {
  const body = await res?.json().catch(() => ({}));
  return body?.error || fallback;
}

function Monogram({ cli, size }: { cli: CliInfo; size: "sm" | "lg" }) {
  const b = brandOf(cli);
  const dim = size === "lg" ? "h-14 w-14 rounded-2xl text-xl" : "h-9 w-9 rounded-xl text-sm";
  return (
    <span aria-hidden className={`${dim} flex shrink-0 items-center justify-center font-bold shadow-md`} style={{ background: b.bg, color: b.fg }}>
      {b.mono}
    </span>
  );
}

interface Status {
  label: string;
  dot: string;
  pill: string;
}
function statusOf(cli: CliInfo, busy: boolean): Status {
  if (busy) return { label: "em andamento", dot: "bg-sky-400 animate-pulse", pill: "border-sky-800 bg-sky-950/50 text-sky-300" };
  if (!cli.installed) return { label: "não instalado", dot: "bg-slate-600", pill: "border-slate-700 bg-slate-900 text-slate-400" };
  if (cli.loggedIn === true) return { label: "logado", dot: "bg-emerald-400", pill: "border-emerald-800 bg-emerald-950/50 text-emerald-300" };
  if (cli.loggedIn === false) return { label: "instalado · sem login", dot: "bg-amber-400", pill: "border-amber-800 bg-amber-950/40 text-amber-300" };
  return { label: "instalado · login não verificável", dot: "bg-amber-400", pill: "border-amber-800 bg-amber-950/40 text-amber-300" };
}

function CopyBtn({ value, label, className = "" }: { value: string; label: string; className?: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        if (await copyText(value)) {
          setOk(true);
          setTimeout(() => setOk(false), 1500);
        }
      }}
      aria-label={label}
      title={label}
      className={`flex items-center gap-1 rounded-lg bg-slate-800 px-2.5 py-2 text-xs text-slate-200 transition hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${className}`}
    >
      {ok ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
      {ok && <span>Copiado</span>}
    </button>
  );
}

// Job ao vivo (WebSocket, com polling se o WS cair). Avisa o pai quando termina.
function useCliJob(jobId: string, onFinished: () => void, onActive: (active: boolean) => void) {
  const [job, setJob] = useState<Job | null>(null);
  const finishedRef = useRef(onFinished);
  finishedRef.current = onFinished;
  const activeRef = useRef(onActive);
  activeRef.current = onActive;
  const notified = useRef(false);

  const terminal = job ? isTerminal(job.state) : false;
  useEffect(() => {
    if (!job) return;
    activeRef.current(!terminal);
    if (terminal && !notified.current) {
      notified.current = true;
      finishedRef.current();
    }
  }, [job, terminal]);

  useEffect(() => {
    notified.current = false;
    setJob(null);
    let closed = false;
    let ws: WebSocket | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;

    const fetchOnce = async () => {
      const res = await apiFetch(`/api/cli-jobs/${jobId}`).catch(() => null);
      if (!res?.ok || closed) return;
      const j: Job = await res.json();
      setJob(j);
      if (isTerminal(j.state) && poll) clearInterval(poll);
    };
    const startPolling = () => {
      if (poll || closed) return;
      fetchOnce();
      poll = setInterval(fetchOnce, 2000);
    };
    try {
      ws = new WebSocket(wsUrl("/ws/cli-job", { job: jobId }));
      ws.onmessage = (ev) => {
        let m: any;
        try {
          m = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (m.type === "snapshot") setJob(m.job);
        else if (m.type === "log") setJob((j) => (j ? { ...j, log: (j.log + m.data).slice(-MAX_LOG) } : j));
        else if (m.type === "url") setJob((j) => (j ? { ...j, url: m.url } : j));
        else if (m.type === "code") setJob((j) => (j ? { ...j, code: m.code } : j));
        else if (m.type === "state") setJob((j) => (j ? { ...j, state: m.state, exitCode: m.exitCode, error: m.error } : j));
      };
      ws.onclose = () => {
        if (!closed) startPolling();
      };
    } catch {
      startPolling();
    }
    return () => {
      closed = true;
      ws?.close();
      if (poll) clearInterval(poll);
    };
  }, [jobId]);

  return job;
}

// Log estilo terminal, colapsável
function TerminalLog({ log, defaultOpen, active }: { log: string; defaultOpen: boolean; active: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log, open]);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-1 text-[11px] text-slate-400 transition hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded"
      >
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "" : "-rotate-90"}`} />
        {open ? "Ocultar detalhes" : "Ver detalhes"}
        {active && <span className="ml-1 h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" />}
      </button>
      {open && (
        <pre ref={ref} aria-label="Saída do comando" className="mt-1.5 max-h-52 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-slate-800 bg-black p-3 font-mono text-[11px] leading-relaxed text-emerald-200/90">
          {log || "$ aguardando saída…"}
        </pre>
      )}
    </div>
  );
}

function SuccessCheck() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setOn(true), 30);
    return () => clearTimeout(t);
  }, []);
  return (
    <span className={`relative flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/15 ring-2 ring-emerald-500/60 transition-all duration-500 ${on ? "scale-100 opacity-100" : "scale-50 opacity-0"}`}>
      <Check className={`h-7 w-7 text-emerald-400 transition-all delay-200 duration-500 ${on ? "scale-100" : "scale-0"}`} strokeWidth={3} />
    </span>
  );
}

function StepRow({ n, state, title, children }: { n: number; state: "done" | "current" | "todo"; title: string; children?: React.ReactNode }) {
  return (
    <li className={`flex gap-3 rounded-xl border p-3 transition ${state === "current" ? "border-indigo-500/60 bg-indigo-950/20" : "border-slate-800 bg-slate-900/30"} ${state === "todo" ? "opacity-50" : ""}`} aria-current={state === "current" ? "step" : undefined}>
      <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold transition ${state === "done" ? "bg-emerald-500 text-white" : state === "current" ? "bg-indigo-600 text-white" : "bg-slate-800 text-slate-400"}`}>
        {state === "done" ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : n}
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <div className={`text-sm font-semibold ${state === "todo" ? "text-slate-400" : "text-slate-100"}`}>{title}</div>
        {children}
      </div>
    </li>
  );
}

function LoginStepper({ job, onDismiss, onRetry }: { job: Job; onDismiss: () => void; onRetry: () => void }) {
  const [text, setText] = useState("");
  const [forceInput, setForceInput] = useState(false);
  const [error, setError] = useState("");
  const active = !isTerminal(job.state);
  const safeUrl = job.url && /^https:\/\//i.test(job.url) ? job.url : null; // texto vindo de processo externo: só https

  const send = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!text) return;
    setError("");
    const res = await apiFetch(`/api/cli-jobs/${job.id}/input`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }).catch(() => null);
    if (!res?.ok) return setError(await errorOf(res, "Não foi possível enviar"));
    setText("");
  };
  const cancel = async () => {
    setError("");
    const res = await apiFetch(`/api/cli-jobs/${job.id}`, { method: "DELETE" }).catch(() => null);
    if (!res?.ok) setError(await errorOf(res, "Não foi possível cancelar"));
  };

  if (job.state === "done") {
    return (
      <div className="flex flex-col items-center gap-3 rounded-2xl border border-emerald-900/60 bg-emerald-950/20 px-4 py-8 text-center">
        <SuccessCheck />
        <div className="text-base font-semibold text-emerald-300">Login concluído</div>
        <div className="text-xs text-slate-400">O status do CLI foi atualizado.</div>
        <button onClick={onDismiss} className="rounded-xl bg-emerald-600 px-5 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300">
          Concluir
        </button>
        {job.log && <div className="w-full text-left"><TerminalLog log={job.log} defaultOpen={false} active={false} /></div>}
      </div>
    );
  }
  if (job.state === "failed" || job.state === "cancelled") {
    return (
      <div className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
        <div role="alert" className="flex items-start gap-2 text-sm text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{job.state === "cancelled" ? "Login cancelado." : job.error || `O login falhou${job.exitCode != null ? ` (código ${job.exitCode})` : ""}.`}</span>
        </div>
        <TerminalLog log={job.log} defaultOpen={job.state === "failed"} active={false} />
        <div className="flex gap-2">
          <button onClick={onRetry} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300">
            Tentar de novo
          </button>
          <button onClick={onDismiss} className="rounded-xl px-4 py-2 text-sm text-slate-400 transition hover:bg-slate-800 hover:text-white">
            Fechar
          </button>
        </div>
      </div>
    );
  }

  const cur = job.state === "waiting_input" ? 3 : safeUrl ? 2 : 1;
  const st = (n: number) => (n < cur ? "done" : n === cur ? "current" : "todo");
  const showInput = job.state === "waiting_input" || forceInput;
  return (
    <div className="space-y-3">
      <ol className="space-y-2" aria-label="Passos do login">
        <StepRow n={1} state={st(1)} title="Abrir a página de login">
          {safeUrl ? (
            <div className="flex items-center gap-2">
              <a href={safeUrl} target="_blank" rel="noopener noreferrer" className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-md shadow-indigo-600/30 transition hover:bg-indigo-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300">
                <ExternalLink className="h-4 w-4" /> Abrir página de login
              </a>
              <CopyBtn value={safeUrl} label="Copiar link" className="py-2.5" />
            </div>
          ) : (
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Gerando o link de login…
            </div>
          )}
        </StepRow>
        <StepRow n={2} state={st(2)} title={job.code ? "Autorizar com este código" : "Entrar na conta e autorizar"}>
          {job.code ? (
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded-xl border border-indigo-900 bg-slate-950 px-4 py-3 text-center font-mono text-2xl font-bold tracking-[0.25em] text-indigo-200">{job.code}</code>
              <CopyBtn value={job.code} label="Copiar código" className="py-3" />
            </div>
          ) : (
            <p className="text-xs text-slate-400">Entre na sua conta na página aberta e autorize o acesso.</p>
          )}
        </StepRow>
        <StepRow n={3} state={st(3)} title="Colar o código de volta">
          {showInput ? (
            <form onSubmit={send} className="space-y-1.5">
              <p className="text-xs text-slate-400">Cole aqui o código que o navegador mostrou (ou responda ao que o CLI perguntou).</p>
              <div className="flex gap-2">
                <input
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus
                  placeholder="Cole o código"
                  aria-label="Código ou resposta para o CLI"
                  className="min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 font-mono text-sm text-white transition focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
                />
                <button type="button" onClick={async () => { const t = await readText(); if (t) setText(t.trim()); }} className="rounded-xl bg-slate-800 px-3 text-xs text-slate-200 transition hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
                  Colar
                </button>
                <button type="submit" disabled={!text} className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300 disabled:opacity-40">
                  <Send className="h-3.5 w-3.5" /> Enviar
                </button>
              </div>
            </form>
          ) : (
            <button type="button" onClick={() => setForceInput(true)} className="text-xs text-slate-400 underline-offset-2 transition hover:text-slate-200 hover:underline">
              O CLI está pedindo uma resposta?
            </button>
          )}
        </StepRow>
      </ol>
      {error && <div role="alert" className="text-xs text-amber-300">{error}</div>}
      <TerminalLog log={job.log} defaultOpen={false} active />
      <div className="flex justify-end">
        <button onClick={cancel} className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs text-slate-400 transition hover:bg-rose-600 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400">
          <X className="h-3.5 w-3.5" /> Cancelar login
        </button>
      </div>
    </div>
  );
}

function InstallPanel({ job, onDismiss, onRetry }: { job: Job; onDismiss: () => void; onRetry: () => void }) {
  const [error, setError] = useState("");
  const active = !isTerminal(job.state);
  const cancel = async () => {
    setError("");
    const res = await apiFetch(`/api/cli-jobs/${job.id}`, { method: "DELETE" }).catch(() => null);
    if (!res?.ok) setError(await errorOf(res, "Não foi possível cancelar"));
  };

  if (job.state === "done") {
    return (
      <div className="flex flex-col items-center gap-3 rounded-2xl border border-emerald-900/60 bg-emerald-950/20 px-4 py-8 text-center">
        <SuccessCheck />
        <div className="text-base font-semibold text-emerald-300">Instalação concluída</div>
        <button onClick={onDismiss} className="rounded-xl bg-emerald-600 px-5 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300">
          Concluir
        </button>
        {job.log && <div className="w-full text-left"><TerminalLog log={job.log} defaultOpen={false} active={false} /></div>}
      </div>
    );
  }
  return (
    <div className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
      {active ? (
        <>
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
            <Loader2 className="h-4 w-4 animate-spin text-sky-400" /> Instalando…
          </div>
          <style>{`@keyframes cli-indet{0%{transform:translateX(-100%)}100%{transform:translateX(350%)}}`}</style>
          <div role="progressbar" aria-label="Instalando" aria-busy="true" className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
            <div className="h-full w-1/3 rounded-full bg-indigo-500" style={{ animation: "cli-indet 1.3s ease-in-out infinite" }} />
          </div>
        </>
      ) : (
        <div role="alert" className="flex items-start gap-2 text-sm text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{job.state === "cancelled" ? "Instalação cancelada." : job.error || `A instalação falhou${job.exitCode != null ? ` (código ${job.exitCode})` : ""}.`}</span>
        </div>
      )}
      <TerminalLog log={job.log} defaultOpen={job.state === "failed"} active={active} />
      {error && <div role="alert" className="text-xs text-amber-300">{error}</div>}
      <div className="flex gap-2">
        {active ? (
          <button onClick={cancel} className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs text-slate-400 transition hover:bg-rose-600 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400">
            <X className="h-3.5 w-3.5" /> Cancelar
          </button>
        ) : (
          <>
            <button onClick={onRetry} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500">Tentar de novo</button>
            <button onClick={onDismiss} className="rounded-xl px-4 py-2 text-sm text-slate-400 transition hover:bg-slate-800 hover:text-white">Fechar</button>
          </>
        )}
      </div>
    </div>
  );
}

function JobArea({ jobId, onFinished, onActive, onDismiss, onRetry }: { jobId: string; onFinished: () => void; onActive: (a: boolean) => void; onDismiss: () => void; onRetry: (kind: "install" | "login") => void }) {
  const job = useCliJob(jobId, onFinished, onActive);
  if (!job)
    return (
      <div className="flex items-center gap-2 rounded-2xl border border-slate-800 bg-slate-900/40 p-4 text-xs text-slate-400">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Conectando ao processo…
      </div>
    );
  const retry = () => onRetry(job.kind);
  return job.kind === "login" ? <LoginStepper job={job} onDismiss={onDismiss} onRetry={retry} /> : <InstallPanel job={job} onDismiss={onDismiss} onRetry={retry} />;
}

export default function CliAuthModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const [clis, setClis] = useState<CliInfo[]>([]);
  const [installEnabled, setInstallEnabled] = useState(true);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountOf, setAccountOf] = useState<Record<string, string>>({});
  const [jobs, setJobs] = useState<Record<string, string>>({});
  const [activeJobs, setActiveJobs] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState("claude");
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [loading, setLoading] = useState(true);
  const [globalError, setGlobalError] = useState("");
  const [newAccount, setNewAccount] = useState<string | null>(null); // null = campo fechado
  const [accountError, setAccountError] = useState("");
  const accountOfRef = useRef(accountOf);
  accountOfRef.current = accountOf;
  const dialogRef = useRef<HTMLDivElement>(null);

  const setError = (id: string, msg: string) => setErrors((e) => ({ ...e, [id]: msg }));

  const fetchList = useCallback(async (sel: Record<string, string>) => {
    const distinct = Array.from(new Set([DEFAULT_ACCOUNT, ...Object.values(sel)]));
    const results = await Promise.all(
      distinct.map(async (acc) => {
        const res = await apiFetch(`/api/clis${acc ? `?account=${encodeURIComponent(acc)}` : ""}`);
        if (!res.ok) throw new Error(await errorOf(res, "Não foi possível carregar os CLIs"));
        return [acc, await res.json()] as const;
      })
    );
    const byAccount = Object.fromEntries(results);
    const base = byAccount[DEFAULT_ACCOUNT];
    const list: CliInfo[] = base.clis.map((c: CliInfo) => byAccount[sel[c.id] || DEFAULT_ACCOUNT]?.clis.find((x: CliInfo) => x.id === c.id) ?? c);
    list.sort((a, b) => (ORDER.indexOf(a.id) + 1 || 99) - (ORDER.indexOf(b.id) + 1 || 99));
    return { list, installEnabled: base.installEnabled !== false };
  }, []);

  const reload = useCallback(
    async (sel?: Record<string, string>) => {
      setGlobalError("");
      setLoading(true);
      try {
        const { list, installEnabled: enabled } = await fetchList(sel ?? accountOfRef.current);
        setClis(list);
        setInstallEnabled(enabled);
        // o servidor só devolve activeJob para jobs em andamento: mantém os pontos de status honestos nos CLIs não selecionados
        setActiveJobs(Object.fromEntries(list.map((c) => [c.id, !!c.activeJob])));
        setJobs((prev) => {
          const next = { ...prev };
          for (const c of list) if (c.activeJob && !next[c.id]) next[c.id] = c.activeJob.id;
          return next;
        });
      } catch (e: any) {
        setGlobalError(e?.message || "Servidor indisponível");
      } finally {
        setLoading(false);
      }
    },
    [fetchList]
  );

  const loadAccounts = useCallback(async () => {
    const res = await apiFetch("/api/accounts").catch(() => null);
    if (res?.ok) setAccounts((await res.json()).accounts || []);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    reload({});
    loadAccounts();
    dialogRef.current?.focus();
  }, [isOpen, reload, loadAccounts]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const cli = clis.find((c) => c.id === selected) ?? clis[0];
  const busyOf = (id: string) => !!jobs[id] && activeJobs[id] !== false;

  const changeAccount = (cliId: string, account: string) => {
    const next = { ...accountOf, [cliId]: account };
    setAccountOf(next);
    setConfirmLogout(false);
    reload(next);
  };

  const startJob = async (c: CliInfo, kind: "install" | "login") => {
    setError(c.id, "");
    const account = accountOf[c.id];
    const res = await apiFetch(`/api/clis/${c.id}/${kind}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(kind === "login" && c.accountsSupported && account ? { account } : {}),
    }).catch(() => null);
    if (!res?.ok) return setError(c.id, res?.status === 409 ? "Já existe uma operação em andamento para este CLI." : await errorOf(res, "Servidor indisponível"));
    const body = await res.json();
    setActiveJobs((m) => ({ ...m, [c.id]: true }));
    setJobs((j) => ({ ...j, [c.id]: body.job.id }));
  };

  const dismissJob = (id: string) => setJobs((j) => { const { [id]: _, ...rest } = j; return rest; });

  const logout = async (c: CliInfo) => {
    setError(c.id, "");
    setConfirmLogout(false);
    const account = accountOf[c.id];
    const res = await apiFetch(`/api/clis/${c.id}/logout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(c.accountsSupported && account ? { account } : {}),
    }).catch(() => null);
    if (!res?.ok) setError(c.id, await errorOf(res, "Não foi possível sair"));
    reload();
  };

  const createAccount = async (c: CliInfo, e: React.FormEvent) => {
    e.preventDefault();
    const name = (newAccount || "").trim();
    if (!name) return;
    setAccountError("");
    const res = await apiFetch("/api/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ program: accountProgramOf(c.id), name }),
    }).catch(() => null);
    if (!res?.ok) return setAccountError(await errorOf(res, "Não foi possível criar a conta"));
    setNewAccount(null);
    await loadAccounts();
    changeAccount(c.id, name);
  };

  const listItem = (c: CliInfo, layout: "row" | "tab") => {
    const b = brandOf(c);
    const s = statusOf(c, busyOf(c.id));
    const on = c.id === cli?.id;
    return (
      <button
        key={c.id}
        role="tab"
        aria-selected={on}
        onClick={() => { setSelected(c.id); setConfirmLogout(false); setNewAccount(null); }}
        className={`flex items-center gap-3 rounded-xl border text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${layout === "row" ? "w-full px-3 py-2.5" : "shrink-0 px-2.5 py-2"} ${on ? "border-indigo-500/60 bg-indigo-950/30" : "border-transparent hover:bg-slate-900"}`}
      >
        <Monogram cli={c} size="sm" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-slate-100">{b.name}</span>
          {layout === "row" && <span className="block truncate text-[11px] text-slate-500">{s.label}</span>}
        </span>
        <span aria-label={s.label} className={`h-2.5 w-2.5 shrink-0 rounded-full ${s.dot}`} />
      </button>
    );
  };

  const b = cli ? brandOf(cli) : null;
  const busy = cli ? busyOf(cli.id) : false;
  const jobId = cli ? jobs[cli.id] : undefined;
  const accountNames = cli ? accounts.filter((a) => a.program === accountProgramOf(cli.id)).map((a) => a.name) : [];
  const status = cli ? statusOf(cli, busy) : null;
  const bigBtn = "flex items-center justify-center gap-2 rounded-xl px-6 py-3 text-sm font-semibold text-white shadow-md transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300 disabled:opacity-40";

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 p-3 backdrop-blur-sm nodrag nopan sm:p-4"
      onMouseDown={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cli-auth-title"
        className="flex max-h-[85vh] min-h-[420px] w-full max-w-[900px] flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 font-sans text-slate-100 shadow-2xl focus:outline-none"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-slate-800 px-5 py-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600/20 text-indigo-300"><KeyRound className="h-4 w-4" /></span>
            <div>
              <h2 id="cli-auth-title" className="text-sm font-semibold text-white">CLIs &amp; Logins</h2>
              <p className="text-[11px] text-slate-500">Instale e conecte os agentes sem abrir um terminal</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={() => reload()} aria-label="Atualizar status" title="Atualizar status" className="rounded-lg p-2 text-slate-400 transition hover:bg-slate-900 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </button>
            <button onClick={onClose} aria-label="Fechar (Esc)" title="Fechar (Esc)" className="rounded-lg p-2 text-slate-400 transition hover:bg-slate-900 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* tela estreita: a lista vira abas no topo */}
        {clis.length > 0 && (
          <div role="tablist" aria-label="CLIs" className="flex shrink-0 gap-1 overflow-x-auto border-b border-slate-800 p-2 md:hidden">
            {clis.map((c) => listItem(c, "tab"))}
          </div>
        )}

        <div className="flex min-h-0 flex-1">
          {clis.length > 0 && (
            <div role="tablist" aria-orientation="vertical" aria-label="CLIs" className="hidden w-64 shrink-0 space-y-1 overflow-y-auto border-r border-slate-800 bg-slate-950/60 p-2 md:block">
              {clis.map((c) => listItem(c, "row"))}
            </div>
          )}

          <div role="tabpanel" className="min-w-0 flex-1 overflow-y-auto p-5">
            {globalError && !cli && (
              <div className="flex h-full flex-col items-center justify-center gap-3 py-10 text-center">
                <AlertTriangle className="h-8 w-8 text-amber-400" />
                <div role="alert" className="text-sm text-amber-200">{globalError}</div>
                <button onClick={() => reload()} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500">Tentar de novo</button>
              </div>
            )}
            {!cli && !globalError && (
              <div className="flex h-full items-center justify-center gap-2 py-10 text-sm text-slate-400">
                <Loader2 className="h-4 w-4 animate-spin" /> Carregando CLIs…
              </div>
            )}

            {cli && b && status && (
              <div className="space-y-5">
                {globalError && <div role="alert" className="text-xs text-amber-300">{globalError}</div>}

                <div className="flex items-start gap-4">
                  <Monogram cli={cli} size="lg" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-lg font-semibold text-white">{b.name}</h3>
                      <span className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition ${status.pill}`}>
                        <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} /> {status.label}
                      </span>
                    </div>
                    <p className="text-xs text-slate-400">{b.desc}</p>
                    {(cli.version || cli.path) && (
                      <p className="mt-1 truncate font-mono text-[10px] text-slate-500" title={cli.path || undefined}>
                        {cli.version && <span>v{cli.version.replace(/^v/i, "")}</span>}
                        {cli.version && cli.path && " · "}
                        {cli.path}
                      </p>
                    )}
                  </div>
                </div>

                {/* Contas (claude/codex/gemini): o status de login é por conta */}
                {cli.accountsSupported && cli.installed && (
                  <div>
                    <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-500">Conta</div>
                    <div role="radiogroup" aria-label={`Conta do ${b.name}`} className="flex flex-wrap items-center gap-1.5">
                      {[DEFAULT_ACCOUNT, ...accountNames].map((n) => {
                        const on = (accountOf[cli.id] || DEFAULT_ACCOUNT) === n;
                        return (
                          <button
                            key={n || "default"}
                            role="radio"
                            aria-checked={on}
                            disabled={busy}
                            onClick={() => changeAccount(cli.id, n)}
                            className={`rounded-full border px-3 py-1 text-xs font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-50 ${on ? "border-indigo-500 bg-indigo-600 text-white" : "border-slate-700 bg-slate-900 text-slate-300 hover:border-slate-500"}`}
                          >
                            {n || "Default"}
                          </button>
                        );
                      })}
                      {newAccount === null ? (
                        <button onClick={() => { setNewAccount(""); setAccountError(""); }} className="flex items-center gap-1 rounded-full border border-dashed border-slate-700 px-3 py-1 text-xs text-slate-400 transition hover:border-indigo-500 hover:text-indigo-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
                          <Plus className="h-3 w-3" /> Nova conta
                        </button>
                      ) : (
                        <form onSubmit={(e) => createAccount(cli, e)} className="flex items-center gap-1">
                          <input
                            autoFocus
                            value={newAccount}
                            onChange={(e) => setNewAccount(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setNewAccount(null); } }}
                            maxLength={40}
                            placeholder="Nome (ex: Work)"
                            aria-label="Nome da nova conta"
                            className="w-36 rounded-full border border-slate-700 bg-slate-900 px-3 py-1 text-xs text-white focus:border-indigo-500 focus:outline-none"
                          />
                          <button type="submit" disabled={!newAccount.trim()} className="rounded-full bg-indigo-600 px-3 py-1 text-xs font-medium text-white transition hover:bg-indigo-500 disabled:opacity-40">Criar</button>
                          <button type="button" onClick={() => setNewAccount(null)} aria-label="Cancelar nova conta" className="rounded-full p-1 text-slate-500 hover:text-white"><X className="h-3.5 w-3.5" /></button>
                        </form>
                      )}
                    </div>
                    {accountError && <div role="alert" className="mt-1.5 text-xs text-amber-300">{accountError}</div>}
                  </div>
                )}

                {cli.loginDetail && cli.installed && <p className="text-xs text-slate-400">{cli.loginDetail}</p>}

                {/* CTA principal conforme o estado */}
                {!jobId && (
                  <div className="space-y-3">
                    {!cli.installed && (
                      <div className="space-y-3 rounded-2xl border border-dashed border-slate-700 bg-slate-900/30 p-5">
                        <div className="text-sm text-slate-300">{b.name} ainda não está instalado neste servidor.</div>
                        {installEnabled ? (
                          <button onClick={() => startJob(cli, "install")} className={`${bigBtn} w-full bg-indigo-600 shadow-indigo-600/30 hover:bg-indigo-500 sm:w-auto`}>
                            <Download className="h-4 w-4" /> Instalar {b.name}
                          </button>
                        ) : (
                          <div className="text-xs text-slate-400">A instalação pelo menu está desligada (MAESTRI_CLI_INSTALL=0). Instale manualmente:</div>
                        )}
                        {cli.installCmd && (
                          <div className="flex items-center gap-2">
                            <code className="min-w-0 flex-1 truncate rounded-lg border border-slate-800 bg-black px-3 py-2 font-mono text-[11px] text-slate-400" title={cli.installCmd}>$ {cli.installCmd}</code>
                            <CopyBtn value={cli.installCmd} label="Copiar comando" />
                          </div>
                        )}
                      </div>
                    )}

                    {cli.installed && cli.loggedIn !== true && (
                      <div className="rounded-2xl border border-slate-800 bg-slate-900/30 p-5">
                        <div className="mb-3 text-sm text-slate-300">
                          {cli.loggedIn === false ? "Você ainda não entrou." : "Não foi possível verificar o login."} Conecte sua conta em poucos passos.
                        </div>
                        <button onClick={() => startJob(cli, "login")} className={`${bigBtn} w-full bg-indigo-600 shadow-indigo-600/30 hover:bg-indigo-500 sm:w-auto`}>
                          <LogIn className="h-4 w-4" /> Entrar
                        </button>
                      </div>
                    )}

                    {cli.installed && cli.loggedIn === true && (
                      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-emerald-900/50 bg-emerald-950/15 p-5">
                        <div className="flex items-center gap-3">
                          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400"><Check className="h-5 w-5" strokeWidth={3} /></span>
                          <div>
                            <div className="text-sm font-semibold text-emerald-300">Conectado</div>
                            <div className="text-xs text-slate-400">Pronto para usar nos agentes.</div>
                          </div>
                        </div>
                        {confirmLogout ? (
                          <span className="flex items-center gap-2 text-xs">
                            Sair desta conta?
                            <button onClick={() => logout(cli)} className="rounded-lg bg-rose-600 px-3 py-1.5 font-medium text-white transition hover:bg-rose-500">Sim, sair</button>
                            <button onClick={() => setConfirmLogout(false)} className="rounded-lg px-2 py-1.5 text-slate-400 hover:text-white">Não</button>
                          </span>
                        ) : (
                          <button onClick={() => setConfirmLogout(true)} className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 transition hover:border-rose-500 hover:text-rose-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400">
                            <LogOut className="h-3.5 w-3.5" /> Sair
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {errors[cli.id] && <div role="alert" className="rounded-lg border border-amber-900/50 bg-amber-950/20 p-2.5 text-xs text-amber-200">{errors[cli.id]}</div>}

                {jobId && (
                  <JobArea
                    key={jobId}
                    jobId={jobId}
                    onFinished={() => reload()}
                    onActive={(a) => setActiveJobs((m) => (m[cli.id] === a ? m : { ...m, [cli.id]: a }))}
                    onDismiss={() => dismissJob(cli.id)}
                    onRetry={(kind) => { dismissJob(cli.id); startJob(cli, kind); }}
                  />
                )}

                {cli.id === "gemini" && cli.installed && (
                  <p className="text-[11px] text-slate-500">Para conta Google pessoal, prefira Antigravity (<code>agy</code>).</p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
