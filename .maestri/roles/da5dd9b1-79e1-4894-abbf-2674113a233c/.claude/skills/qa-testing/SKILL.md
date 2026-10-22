---
name: qa-testing
description: Use ao testar/validar qualquer implementação do maestri-web — testes E2E via portal, testes de API do servidor, regressão e relatório de bugs.
---

# QA Testing — maestri-web

Repo: `/home/assis/Documentos/projetos/maestri-web` (server Fastify em `apps/server`, porta 4000; web Next.js 14 + React Flow em `apps/web`, porta 3000).

## Fluxo
1. **Entenda o escopo**: o que mudou (`git -C <repo> diff`, `git log -5`) e o critério de aceite.
2. **Suba o ambiente** se não estiver rodando: `npm run dev:server` e `npm run dev:web` na raiz (em background). Confirme com `curl -s localhost:4000` e `curl -sI localhost:3000`.
3. **Teste a UI no portal `QA Portal`**:
   - `maestri portal snapshot "QA Portal"` → refs `@eN`
   - `click` / `fill` / `key` / `hover` / `drag` para interagir
   - `maestri portal evaluate "QA Portal" "..."` para checar estado/console
   - `maestri portal screenshot "QA Portal"` como evidência
4. **Teste a API**: `curl` nos endpoints; WebSockets de terminal com um script Node curto (`ws`). Cubra caminho feliz, entradas inválidas, desconexão/reconexão.
5. **Regressão**: sempre re-verifique fluxos centrais — criar/mover/redimensionar terminal, nota e portal no canvas; terminal recebe output sem crescer infinitamente; nada trava.
6. **Typecheck/build**: `npx tsc --noEmit -p apps/server` e `npm --prefix apps/web run build`.

## Relatório de bug
Inclua os bugs na sua resposta ao orquestrador (ele repassa ao Forge/Prism), neste formato:
```
[BUG] <título curto>
Severidade: crítica|alta|média|baixa
Passos: 1. ... 2. ...
Esperado: ...
Obtido: ...
Evidência: <screenshot path / log / resposta curl>
```

## Regras
- Não corrija código de produção; você pode criar/alterar testes.
- Só declare "aprovado" com evidência real (comando + saída, screenshot).
