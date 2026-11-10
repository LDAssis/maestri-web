// Token por terminal (Fase 3): cada PTY nasce com um token próprio (mt_ + 32 bytes base64url), válido só enquanto o PTY vive e
// só para a API do SEU projeto/nó. O servidor guarda apenas o SHA-256 (em memória). A entrega é por arquivo (0400, dono = uid do
// projeto) e a variável MAESTRI_TOKEN_FILE; o token nunca vai em argv nem no ambiente.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface TerminalScope {
  projectId: string;
  nodeId: string;
  ptyId: string;
  uid: number | null; // uid do projeto (null = root/dev)
  createdAt: number;
}

const sha = (t: string) => crypto.createHash("sha256").update(t).digest("hex");
export const TERMINAL_TOKEN_PREFIX = "mt_";

// Diretório dos arquivos de token: /run/maestri/tok (root); fora disso (dev/CI sem root) um diretório do usuário em tmp
export function tokenDir(env: NodeJS.ProcessEnv = process.env) {
  if (env.MAESTRI_TOK_DIR) return path.resolve(env.MAESTRI_TOK_DIR);
  const root = process.platform === "linux" && process.getuid?.() === 0;
  return root ? "/run/maestri/tok" : path.join(os.tmpdir(), `maestri-tok-${process.getuid?.() ?? "u"}`);
}

export class TerminalTokens {
  private byHash = new Map<string, TerminalScope>();
  private byPty = new Map<string, { hash: string; file: string }>();
  private dirReady = false;

  constructor(private dir: string = tokenDir()) {}

  get directory() {
    return this.dir;
  }

  private ensureDir() {
    if (this.dirReady && fs.existsSync(this.dir)) return;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o711 });
    try {
      fs.chmodSync(this.dir, 0o711); // o uid do projeto só atravessa (x): não lista, lê só o próprio arquivo
    } catch {}
    this.dirReady = true;
  }

  // Emite o token do PTY e grava o arquivo (dono uid:gid, 0400). Devolve o caminho do arquivo.
  issue(scope: { projectId: string; nodeId: string; uid?: number | null; gid?: number | null }) {
    const ptyId = crypto.randomBytes(8).toString("hex");
    const token = TERMINAL_TOKEN_PREFIX + crypto.randomBytes(32).toString("base64url");
    this.ensureDir();
    const file = path.join(this.dir, ptyId);
    fs.writeFileSync(file, token, { mode: 0o600 });
    try {
      if (scope.uid != null && scope.gid != null) fs.chownSync(file, scope.uid, scope.gid);
      fs.chmodSync(file, 0o400);
    } catch (e: any) {
      // Sem conseguir entregar ao dono certo o token não serve: não deixa arquivo órfão
      fs.rmSync(file, { force: true });
      throw e;
    }
    const hash = sha(token);
    this.byHash.set(hash, { projectId: scope.projectId, nodeId: scope.nodeId, ptyId, uid: scope.uid ?? null, createdAt: Date.now() });
    this.byPty.set(ptyId, { hash, file });
    return { ptyId, file, token };
  }

  verify(token: unknown): TerminalScope | null {
    if (typeof token !== "string" || !token.startsWith(TERMINAL_TOKEN_PREFIX)) return null;
    return this.byHash.get(sha(token)) ?? null;
  }

  revoke(ptyId: string) {
    const e = this.byPty.get(ptyId);
    if (!e) return;
    this.byHash.delete(e.hash);
    this.byPty.delete(ptyId);
    fs.rmSync(e.file, { force: true });
  }

  revokeAll() {
    for (const id of [...this.byPty.keys()]) this.revoke(id);
  }

  size() {
    return this.byPty.size;
  }
}

// ---------- escopo ----------
// Terminal só fala com /api/projects/<seu projeto>/nodes/<seu nó>/... e POST /api/projects/<seu projeto>/usage/report.
const NODE_RE = /^\/api\/projects\/([\w-]+)\/nodes\/([\w-]+)(\/.*)?$/;
const USAGE_RE = /^\/api\/projects\/([\w-]+)\/usage\/report$/;

export interface ScopeVerdict {
  ok: boolean;
  status?: number;
  error?: string;
}

export function terminalScopeCheck(scope: TerminalScope, method: string, pathname: string): ScopeVerdict {
  const deny = (status: number, error: string): ScopeVerdict => ({ ok: false, status, error });
  if (pathname.split("/").some((s) => s === ".." || s === ".")) return deny(403, "Caminho inválido para o token do terminal.");
  const n = NODE_RE.exec(pathname);
  if (n) {
    if (n[1] !== scope.projectId || n[2] !== scope.nodeId) return deny(403, "O token deste terminal só vale para o próprio projeto e nó.");
    const rest = n[3] ?? "";
    if (rest === "/workspaces" || rest.startsWith("/workspaces/")) return deny(403, "Workspaces e bandas entre projetos ainda não são permitidos a partir de um terminal (isolamento por projeto).");
    if (rest === "/accounts/create" || rest === "/accounts/delete") return deny(403, "Contas de assinatura só podem ser gerenciadas por um administrador.");
    return { ok: true };
  }
  const u = USAGE_RE.exec(pathname);
  if (u && method === "POST") return u[1] === scope.projectId ? { ok: true } : deny(403, "O token deste terminal só vale para o próprio projeto.");
  return deny(403, "O token de terminal não dá acesso a esta rota.");
}
