import fs from "node:fs";

interface Entry {
  started: boolean;
  resume?: { program: string; id: string };
}

// Quais terminais já foram iniciados (para relançar em modo de retomada) e a linha de retomada capturada na saída.
// Fica em arquivo próprio para não poluir o canvas nem ser copiado junto com os nós.
export class SessionHistory {
  private data: Record<string, Entry> = {};

  constructor(private file?: string) {
    if (file) {
      try {
        this.data = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {}
    }
  }

  private key = (p: string, n: string) => `${p}:${n}`;

  private save() {
    if (!this.file) return;
    try {
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    } catch (e: any) {
      console.error("Erro ao persistir histórico de sessões:", e.message);
    }
  }

  started(p: string, n: string) {
    return this.data[this.key(p, n)]?.started === true;
  }

  resume(p: string, n: string) {
    return this.data[this.key(p, n)]?.resume;
  }

  markStarted(p: string, n: string) {
    if (this.started(p, n)) return;
    this.data[this.key(p, n)] = { ...this.data[this.key(p, n)], started: true };
    this.save();
  }

  setResume(p: string, n: string, resume: { program: string; id: string }) {
    const e = this.data[this.key(p, n)] ?? { started: true };
    if (e.resume?.id === resume.id) return;
    this.data[this.key(p, n)] = { ...e, resume };
    this.save();
  }

  // Recomeço do zero (replace/role assign): esquece a linha de retomada
  reset(p: string, n: string) {
    this.data[this.key(p, n)] = { started: true };
    this.save();
  }

  // Nós apagados: esquece o histórico deles (senão o arquivo só cresce)
  dropNodes(p: string, ids: string[]) {
    let any = false;
    for (const id of ids) {
      const k = this.key(p, id);
      if (this.data[k]) {
        delete this.data[k];
        any = true;
      }
    }
    if (any) this.save();
  }

  dropProject(p: string) {
    for (const k of Object.keys(this.data)) if (k.startsWith(`${p}:`)) delete this.data[k];
    this.save();
  }
}
