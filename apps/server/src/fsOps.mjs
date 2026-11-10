// Operações de arquivo "seguras contra symlink" para tudo que o SERVIDOR faz dentro da árvore de um projeto/HOME.
// Executa como o usuário do projeto (via runAs.ts: setpriv + este mesmo arquivo como helper) — assim um symlink plantado pelo agente
// só alcança o que o próprio agente já alcança; nunca o que é de root. Sem isolamento (dev/projeto externo) roda no próprio processo
// com as mesmas proteções (O_NOFOLLOW, tmp aleatório com O_EXCL, sem chown). JS puro: o helper roda com `node fsOps.mjs`.
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { O_WRONLY, O_CREAT, O_EXCL, O_APPEND, O_RDONLY, O_NOFOLLOW } = fs.constants;
const NOFOLLOW = O_NOFOLLOW ?? 0;

const readNoFollow = (p) => {
  const fd = fs.openSync(p, O_RDONLY | NOFOLLOW);
  try {
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
};

// Escrita atômica: tmp aleatório criado com O_EXCL|O_NOFOLLOW e rename (o rename substitui o próprio link, nunca segue)
function atomicWrite(file, data, mode = 0o660) {
  const tmp = `${file}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  const fd = fs.openSync(tmp, O_WRONLY | O_CREAT | O_EXCL | NOFOLLOW, mode);
  try {
    fs.writeFileSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

// Cada op devolve um resultado simples (true/false/string/null)
export function runOp(op) {
  switch (op.op) {
    case "mkdirp":
      fs.mkdirSync(op.path, { recursive: true, mode: op.mode ?? 0o770 });
      return true;
    case "write": {
      if (op.ifChanged) {
        try {
          if (readNoFollow(op.path).toString("utf8") === op.data) return false;
        } catch {}
      }
      fs.mkdirSync(path.dirname(op.path), { recursive: true, mode: 0o770 });
      atomicWrite(op.path, op.data, op.mode);
      return true;
    }
    case "append": {
      fs.mkdirSync(path.dirname(op.path), { recursive: true, mode: 0o770 });
      const fd = fs.openSync(op.path, O_WRONLY | O_CREAT | O_APPEND | NOFOLLOW, op.mode ?? 0o660);
      try {
        fs.writeSync(fd, op.data);
      } finally {
        fs.closeSync(fd);
      }
      return true;
    }
    case "copy": {
      // só arquivo regular, sem seguir symlink (o agente não faz o servidor copiar o que ele não alcança)
      const st = fs.lstatSync(op.src);
      if (!st.isFile()) return false;
      const data = readNoFollow(op.src);
      fs.mkdirSync(path.dirname(op.dest), { recursive: true, mode: 0o770 });
      atomicWrite(op.dest, data, op.mode ?? (st.mode & 0o777));
      return true;
    }
    case "read": {
      try {
        return readNoFollow(op.path).toString("utf8");
      } catch {
        return null;
      }
    }
    case "upsert": {
      // bloco gerenciado entre marcadores (AGENTS.md): lê, substitui/acrescenta e grava, tudo com a identidade do usuário
      let cur = "";
      try {
        cur = readNoFollow(op.path).toString("utf8");
      } catch {}
      const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`${esc(op.start)}[\\s\\S]*?${esc(op.end)}`);
      const next = re.test(cur) ? cur.replace(re, () => op.block) : cur.trim() ? `${cur.replace(/\s*$/, "")}\n\n${op.block}\n` : `${op.block}\n`;
      if (next === cur) return false;
      fs.mkdirSync(path.dirname(op.path), { recursive: true, mode: 0o770 });
      atomicWrite(op.path, next, op.mode);
      return true;
    }
    case "rm":
      fs.rmSync(op.path, { recursive: !!op.recursive, force: true });
      return true;
    default:
      throw new Error(`op desconhecida: ${op.op}`);
  }
}

// Falha de uma op não impede as seguintes (cada resultado: valor ou { error })
export function runOps(ops) {
  return ops.map((op) => {
    try {
      return runOp(op);
    } catch (e) {
      return { error: String(e?.code || e?.message || e) };
    }
  });
}

// Modo helper: `node fsOps.mjs` lê as ops do stdin (JSON) e imprime os resultados
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.umask(0o007); // grupo primário é só do usuário; na pasta da conta (setgid) o grupo da conta escreve
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (input += d));
  process.stdin.on("end", () => {
    process.stdout.write(JSON.stringify(runOps(JSON.parse(input))));
  });
}
