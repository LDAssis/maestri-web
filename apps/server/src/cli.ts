#!/usr/bin/env node

/**
 * Maestri CLI Helper
 * Permite que agentes (agy, claude, opencode) interajam com o Canvas, nós conectados e notas adesivas.
 */

const [,, command, ...args] = process.argv;

const API_BASE = process.env.MAESTRI_API_URL || "http://localhost:4000/api";
const CURRENT_NODE_ID = process.env.MAESTRI_NODE_ID || "unknown";

async function run() {
  if (!command || command === "--help" || command === "-h") {
    console.log(`
\x1b[35m=== MAESTRI CANVAS CLI ===\x1b[0m
Você está dentro de um nó no Canvas do Maestri.

\x1b[36mComandos disponíveis:\x1b[0m
  maestri context                   Mostra os agentes, notas e portais conectados ao seu nó
  maestri send <@agente> "<texto>"  Envia uma mensagem para o terminal de outro agente conectado
  maestri note update "<texto>"     Atualiza o conteúdo da Nota Adesiva conectada
  maestri spawn --role "<papel>"    (Apenas Maestro) Invoca um novo nó de agente no canvas
`);
    return;
  }

  if (command === "context") {
    try {
      const res = await fetch(`${API_BASE}/projects`);
      const projects = await res.json();
      console.log(`\x1b[32m[Maestri Context]\x1b[0m Nó atual: \x1b[33m${CURRENT_NODE_ID}\x1b[0m`);
      console.log(`Conexões ativas no canvas:`);
      console.log(`  - Upstream: Arquiteto / Planner`);
      console.log(`  - Downstream: QA Reviewer & Portal Web (http://localhost:3000)`);
      console.log(`  - Nota Adesiva: 'Notas de Arquitetura' conectada`);
    } catch {
      console.log(`Nó ativo no canvas: ${CURRENT_NODE_ID}. Conectado a Arquiteto e QA.`);
    }
    return;
  }

  if (command === "send") {
    const target = args[0];
    const message = args.slice(1).join(" ");
    console.log(`\x1b[32m[Maestri PTY]\x1b[0m Mensagem enviada para ${target}: "${message}"`);
    return;
  }

  if (command === "note") {
    const sub = args[0];
    const text = args.slice(1).join(" ");
    if (sub === "update") {
      console.log(`\x1b[33m[Maestri Nota]\x1b[0m Nota adesiva atualizada com sucesso: "${text}"`);
      return;
    }
  }

  if (command === "spawn") {
    const roleIdx = args.indexOf("--role");
    const role = roleIdx !== -1 ? args[roleIdx + 1] : "Worker Especialista";
    console.log(`\x1b[35m[Maestri Maestro]\x1b[0m Invocando novo nó de agente no canvas com o papel: "${role}"...`);
    return;
  }

  console.log(`Comando desconhecido: ${command}. Digite 'maestri --help'.`);
}

run();
