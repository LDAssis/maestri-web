---
name: backend-development
description: Use ao implementar ou alterar qualquer coisa em apps/server do maestri-web — rotas Fastify, WebSockets de terminal, processos/pty, configuração de projetos.
---

# Backend Development — maestri-web

Stack: Node + TypeScript, Fastify 4, `@fastify/websocket`, `@fastify/cors`, `tsx watch` em dev (porta 4000). Código em `apps/server/src`.

## Antes de codar
- Leia o código vizinho e siga o mesmo estilo/nomenclatura.
- Defina o contrato (método, rota, payload, respostas de erro) antes de implementar.

## Ao implementar
- Valide entradas (schema Fastify) e retorne erros com status corretos (400/404/409/500) e corpo `{ error: string }`.
- WebSockets/pty: trate `error`, `close` e back-pressure (EAGAIN); nunca deixe uma exceção derrubar o processo; mate processos filhos ao fechar a sessão.
- Sem bloqueio do event loop; use APIs assíncronas.
- Sem segredos no código; nada de execução de shell com input não sanitizado.

## Verificação
- `npx tsc --noEmit -p apps/server` limpo.
- Teste manual com `curl` / cliente ws.
- Mudou contrato? Descreva o novo formato na resposta ao orquestrador.
- Ao final: responda ao orquestrador com o que mudou e como testar (não chame colegas).
