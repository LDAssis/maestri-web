// Conexões agente↔agente entre workspaces (projetos) diferentes (POLISH5). Cada projeto tem o próprio canvas,
// então a corda entre dois deles não é uma aresta: vive neste registro do servidor (<dataDir>/links.json).
import fs from "node:fs";

export interface LinkEnd {
  project: string;
  node: string;
}
export interface Link {
  a: LinkEnd;
  b: LinkEnd;
}

const same = (x: LinkEnd, y: LinkEnd) => x.project === y.project && x.node === y.node;

export class CrossLinks {
  private links: Link[] = [];

  constructor(private file?: string) {
    if (file) {
      try {
        const saved = JSON.parse(fs.readFileSync(file, "utf8"));
        if (Array.isArray(saved.links)) this.links = saved.links.filter((l: Link) => l?.a?.project && l?.a?.node && l?.b?.project && l?.b?.node);
      } catch {}
    }
  }

  private save() {
    if (!this.file) return;
    try {
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ links: this.links }, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (e: any) {
      console.error("Erro ao persistir links entre workspaces:", e.message);
    }
  }

  all() {
    return [...this.links];
  }

  has(a: LinkEnd, b: LinkEnd) {
    return this.links.some((l) => (same(l.a, a) && same(l.b, b)) || (same(l.a, b) && same(l.b, a)));
  }

  // true se criou (false = já existia)
  add(a: LinkEnd, b: LinkEnd): boolean {
    if (a.project === b.project) throw new Error("Links só existem entre projetos diferentes.");
    if (this.has(a, b)) return false;
    this.links.push({ a, b });
    this.save();
    return true;
  }

  // Os pares do nó, em outros projetos
  peers(project: string, node: string): LinkEnd[] {
    const me = { project, node };
    return this.links.flatMap((l) => (same(l.a, me) ? [l.b] : same(l.b, me) ? [l.a] : []));
  }

  dropNode(project: string, node: string) {
    const me = { project, node };
    const before = this.links.length;
    this.links = this.links.filter((l) => !same(l.a, me) && !same(l.b, me));
    if (this.links.length !== before) this.save();
  }

  dropProject(project: string) {
    const before = this.links.length;
    this.links = this.links.filter((l) => l.a.project !== project && l.b.project !== project);
    if (this.links.length !== before) this.save();
  }
}
