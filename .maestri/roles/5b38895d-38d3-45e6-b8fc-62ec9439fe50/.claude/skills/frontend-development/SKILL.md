---
name: frontend-development
description: Use ao implementar ou alterar qualquer coisa em apps/web do maestri-web — componentes React, canvas React Flow (terminais, notas, portais), estilos Tailwind, integração com a API.
---

# Frontend Development — maestri-web

Stack: Next.js 14 (porta 3000), React 18, `@xyflow/react` 12, Tailwind, `lucide-react`, `@monaco-editor/react`. Código em `apps/web/src`.

## Ao implementar
- Siga os componentes/padrões existentes; reutilize antes de criar.
- Componentes que usam browser APIs (xterm, ResizeObserver, window) devem ser `'use client'` e/ou carregados dinamicamente sem SSR.
- React Flow: nodes customizados memoizados, `nodeTypes` fora do render, evite loops de resize (ResizeObserver → setState → resize).
- Limpe efeitos (sockets, observers, listeners) no cleanup do `useEffect`.
- Acessibilidade: botões com `aria-label`, foco visível, contraste ok.
- Estados de loading/erro para toda chamada à API (backend em `localhost:4000`).

## Verificação
- `npm --prefix apps/web run build` sem erros de tipo/lint.
- Rode `npm run dev:web` e confira no navegador.
- Precisa de endpoint novo/alterado? Peça na resposta ao orquestrador.
- Ao final: responda ao orquestrador com o que mudou e como testar (não chame colegas).
