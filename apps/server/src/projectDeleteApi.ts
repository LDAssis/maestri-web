// Exclusão de projeto: GET /api/projects/:id/delete-info (o que será apagado e se a pasta pode ir junto)
// e DELETE /api/projects/:id { deleteFolder? }. Tudo o que é do projeto some do servidor; a pasta só é
// apagada quando o cliente pede E ela fica dentro de MAESTRI_PROJECTS_DIR (nunca o repo principal nem pastas de fora).
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { CanvasStore } from "./canvas.js";
import type { SessionManager } from "./sessions.js";
import type { FloorStore } from "./floors.js";
import type { SessionHistory } from "./sessionHistory.js";
import type { CrossLinks } from "./crossLinks.js";
import type { AttachmentStore } from "./attachments.js";
import { isInside, overlaps, projectsDir, realOrResolved } from "./projectDirs.js";

interface ProjectLite {
  id: string;
  name: string;
  repoPath: string;
}

interface Deps {
  fastify: FastifyInstance;
  projects: ProjectLite[]; // o mesmo array vivo do index (a rota remove o item com splice)
  defaultRepo: string;
  dataDir: string;
  canvas: CanvasStore;
  sessions: SessionManager;
  portals: { closeProject(projectId: string): void };
  routines: { removeProject(projectId: string): void };
  floors: FloorStore;
  sessionHistory: SessionHistory;
  crossLinks: CrossLinks;
  attachments: AttachmentStore;
  saveProjects: () => void;
}

const idPattern = /^[\w-]+$/;

export function registerProjectDeleteApi(d: Deps) {
  const { fastify, projects, dataDir } = d;

  // A pasta do projeto pode ser apagada junto? { allowed, reason }
  function folderCheck(project: ProjectLite): { allowed: boolean; reason?: string } {
    try {
      if (fs.lstatSync(project.repoPath).isSymbolicLink()) return { allowed: false, reason: "A pasta do projeto é um link simbólico." };
    } catch {
      return { allowed: false, reason: "A pasta do projeto não existe mais no disco." };
    }
    const real = realOrResolved(project.repoPath);
    const root = realOrResolved(projectsDir());
    if (!fs.existsSync(real) || !fs.statSync(real).isDirectory()) return { allowed: false, reason: "A pasta do projeto não existe mais no disco." };
    if (real === root || !isInside(root, real)) return { allowed: false, reason: `Só pastas criadas pelo Maestri (dentro de ${root}) podem ser apagadas.` };
    if (overlaps(real, d.defaultRepo)) return { allowed: false, reason: "A pasta contém ou é o repositório principal do Maestri." };
    if (overlaps(real, dataDir)) return { allowed: false, reason: "A pasta contém os dados internos do Maestri." };
    const other = projects.find((o) => o.id !== project.id && overlaps(real, o.repoPath));
    if (other) return { allowed: false, reason: `A pasta é compartilhada com o projeto "${other.name}".` };
    return { allowed: true };
  }

  const readRoutineCount = (id: string) => {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dataDir, `routines_${id}.json`), "utf8"));
      return Array.isArray(data.routines) ? data.routines.length : 0;
    } catch {
      return 0;
    }
  };

  const find = (id: string) => (idPattern.test(id) ? projects.find((p) => p.id === id) : undefined);

  fastify.get<{ Params: { id: string } }>("/api/projects/:id/delete-info", async (req, reply) => {
    const project = find(req.params.id);
    if (!project) return reply.status(404).send({ error: "Projeto não encontrado." });
    const nodes = d.canvas.state(project.id).nodes ?? [];
    const count = (...types: string[]) => nodes.filter((n) => types.includes(String(n.type))).length;
    const check = folderCheck(project);
    return {
      id: project.id,
      name: project.name,
      // não-admin (o dono de um projeto criado por ele) não recebe o caminho no servidor
      ...(!req.authUser || req.authUser.role === "admin" ? { repoPath: project.repoPath } : {}),
      isLast: projects.length <= 1,
      canDeleteFolder: check.allowed,
      ...(check.reason && { folderReason: check.reason }),
      counts: {
        agents: count("agentTerminal"),
        notes: count("stickyNote", "noteStack"),
        portals: count("portal"),
        floors: d.floors.read(project.id).floors.length,
        routines: readRoutineCount(project.id),
        liveTerminals: d.sessions.list(project.id).length,
      },
    };
  });

  fastify.delete<{ Params: { id: string }; Body: { deleteFolder?: unknown } | undefined }>("/api/projects/:id", async (req, reply) => {
    const project = find(req.params.id);
    if (!project) return reply.status(404).send({ error: "Projeto não encontrado." });
    const deleteFolder = req.body?.deleteFolder;
    if (deleteFolder !== undefined && typeof deleteFolder !== "boolean") return reply.status(400).send({ error: "deleteFolder deve ser booleano." });
    if (projects.length <= 1) return reply.status(409).send({ error: "Este é o último projeto; crie outro antes de excluí-lo." });
    // Valida tudo ANTES de mexer em qualquer coisa
    if (deleteFolder) {
      const check = folderCheck(project);
      if (!check.allowed) return reply.status(400).send({ error: check.reason });
    }
    const id = project.id;
    const folder = deleteFolder ? realOrResolved(project.repoPath) : null;

    // Avisa quem está dentro (outros usuários) antes de fechar as conexões do projeto
    d.canvas.notify(id, { type: "project-deleted", id, name: project.name });

    const idx = projects.findIndex((p) => p.id === id);
    projects.splice(idx, 1);
    d.saveProjects();
    for (const p of projects) d.canvas.notify(p.id, { type: "sidebar" });

    d.sessions.killProject(id);
    d.portals.closeProject(id);
    d.canvas.drop(id);
    d.routines.removeProject(id);
    d.floors.drop(id);
    d.sessionHistory.dropProject(id);
    d.crossLinks.dropProject(id);
    d.attachments.dropProject(id);
    for (const f of [`canvas_${id}.json`, `settings_${id}.json`, `prefs_${id}.json`]) fs.rmSync(path.join(dataDir, f), { force: true });

    if (!folder) return { ok: true, folderDeleted: false };
    try {
      fs.rmSync(folder, { recursive: true, force: true });
      return { ok: true, folderDeleted: true };
    } catch (e: any) {
      return { ok: true, folderDeleted: false, folderError: e?.message || "Não foi possível apagar a pasta." };
    }
  });
}
