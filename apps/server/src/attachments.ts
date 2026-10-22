// Anexos do chat (POLISH3): arquivos por projeto, com ids estáveis, em <dataDir>/attachments/<projeto>/<id>/.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ApiError } from "./agents.js";

export const ATTACHMENT_MAX = 20 * 1024 * 1024;
export const ATTACHMENTS_PER_MESSAGE = 10;

export interface AttachmentMeta {
  id: string;
  name: string;
  mime: string;
  size: number;
  image: boolean; // PNG/JPEG/GIF/WebP de verdade (conferido pelos primeiros bytes): a web mostra embutido
  at: string;
}

const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".heic": "image/heic",
  ".pdf": "application/pdf", ".zip": "application/zip", ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json",
  ".csv": "text/csv", ".log": "text/plain",
};
const ID_RE = /^[0-9a-f]{12}$/;

// Tipo de imagem pelos primeiros bytes (não confia na extensão)
export function sniffImage(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString("latin1"))) return "image/gif";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

const cleanName = (v: unknown) => {
  const n = path.basename(String(v ?? "")).replace(/[\x00-\x1f\x7f-\x9f\\/]/g, "_").trim().slice(0, 120);
  return n && n !== "." && n !== ".." ? n : "arquivo";
};

export class AttachmentStore {
  constructor(private dataDir: string) {}

  private dir(projectId: string, id: string) {
    return path.join(this.dataDir, "attachments", projectId, id);
  }

  isId = (v: unknown): v is string => typeof v === "string" && ID_RE.test(v);

  save(projectId: string, name: unknown, data: Buffer): AttachmentMeta {
    if (!data.length) throw new ApiError(400, "Arquivo vazio.");
    if (data.length > ATTACHMENT_MAX) throw new ApiError(413, `Arquivo grande demais (máximo ${ATTACHMENT_MAX / 1024 / 1024}MB).`);
    const clean = cleanName(name);
    const sniffed = sniffImage(data);
    const meta: AttachmentMeta = {
      id: crypto.randomBytes(6).toString("hex"),
      name: clean,
      mime: sniffed ?? (MIME[path.extname(clean).toLowerCase()] === undefined || MIME[path.extname(clean).toLowerCase()].startsWith("image/") ? "application/octet-stream" : MIME[path.extname(clean).toLowerCase()]),
      size: data.length,
      image: sniffed !== null,
      at: new Date().toISOString(),
    };
    const dir = this.dir(projectId, meta.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "file"), data);
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta));
    return meta;
  }

  meta(projectId: string, id: unknown): AttachmentMeta | null {
    if (!this.isId(id)) return null;
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir(projectId, id), "meta.json"), "utf8"));
    } catch {
      return null;
    }
  }

  read(projectId: string, id: unknown): { meta: AttachmentMeta; data: Buffer } | null {
    const meta = this.meta(projectId, id);
    if (!meta) return null;
    try {
      return { meta, data: fs.readFileSync(path.join(this.dir(projectId, meta.id), "file")) };
    } catch {
      return null;
    }
  }

  // Valida os ids de uma mensagem (existem neste projeto) e devolve os metadados
  resolve(projectId: string, ids: unknown): AttachmentMeta[] {
    if (ids === undefined) return [];
    if (!Array.isArray(ids) || ids.length > ATTACHMENTS_PER_MESSAGE) throw new ApiError(400, `attachments: lista de até ${ATTACHMENTS_PER_MESSAGE} ids.`);
    return ids.map((id) => {
      const m = this.meta(projectId, id);
      if (!m) throw new ApiError(404, `Anexo "${String(id).slice(0, 20)}" não encontrado.`);
      return m;
    });
  }

  dropProject(projectId: string) {
    fs.rmSync(path.join(this.dataDir, "attachments", projectId), { recursive: true, force: true });
  }
}

export const decodeBase64 = (v: unknown): Buffer => {
  if (typeof v !== "string" || !v || !/^[A-Za-z0-9+/]*={0,2}$/.test(v)) throw new ApiError(400, "data deve ser base64.");
  return Buffer.from(v, "base64");
};
