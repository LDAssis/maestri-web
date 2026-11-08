import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const opts = { recursive: true, force: true, maxRetries: 10, retryDelay: 200 };

// Windows: o ConPTY/filhos de PTY seguram o cwd até o processo de teste sair (EPERM/EBUSY).
// Só nesse caso adia a limpeza para o 'exit'; qualquer outro erro continua estourando.
export function rmTmp(...dirs: string[]) {
  for (const d of dirs) {
    try {
      fs.rmSync(d, opts);
    } catch (e: any) {
      if (process.platform !== "win32" || !["EPERM", "EBUSY"].includes(e?.code)) throw e;
      process.on("exit", () => {
        try {
          fs.rmSync(d, opts);
        } catch {}
      });
    }
  }
}

// Windows sem Modo de Desenvolvedor/admin: criar symlink dá EPERM. Só nesse caso os testes de symlink são pulados (motivo no skip).
export const noSymlink: string | false = (() => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "maestri-symprobe-"));
  try {
    fs.symlinkSync(d, path.join(d, "l"), "dir");
    return false;
  } catch (e: any) {
    if (e?.code !== "EPERM") throw e;
    return "symlink não permitido neste ambiente (EPERM)";
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
})();

// CLI falso no PATH. POSIX: script sh. Windows: execFile("gh") só acha .exe, então copia o node.exe como <name>.exe;
// um preload (NODE_OPTIONS) detecta que o executável não é "node" e repassa os argumentos ao <name>.sh via sh do Git Bash.
export function installFakeBin(dir: string, name: string, shBody: string) {
  if (process.platform !== "win32") return fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${shBody}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, `${name}.sh`), `${shBody}\n`);
  fs.copyFileSync(process.execPath, path.join(dir, `${name}.exe`));
  const preload = path.join(dir, "_fakebin-preload.cjs");
  if (!fs.existsSync(preload)) {
    fs.writeFileSync(
      preload,
      `const p = require("path");
const b = p.basename(process.execPath, ".exe");
if (b !== "node") {
  // node já trocou argv[1] por um caminho absoluto (cwd + 1º argumento): desfaz
  const args = [p.relative(process.cwd(), process.argv[1]), ...process.argv.slice(2)];
  const r = require("child_process").spawnSync("sh", [p.join(p.dirname(process.execPath), b + ".sh"), ...args], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}
`,
    );
    process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} --require "${preload.replaceAll("\\", "/")}"`.trim();
  }
}
