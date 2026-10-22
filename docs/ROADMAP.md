# Roadmap — Maestri Web

Ordem de execução (cada item = 1 branch + PR). Status: ⬜ a fazer · 🔄 em andamento · ✅ mergeado

| # | Funcionalidade | Depende de | Status |
|---|---|---|---|
| F1 | Acesso multiusuário: URL da API derivada do host, token de acesso, identidade (nome/cor) | — | ✅ |
| F2 | Sessões de terminal compartilhadas: registro por nó, vários clientes no mesmo PTY, reattach com scrollback | F1 | ✅ |
| F3 | Canvas em tempo real: servidor como fonte da verdade, mudanças transmitidas por WS a todos | F1 | ✅ |
| F4 | Presença: usuários conectados, cursores ao vivo, projeto atual de cada um, nó em que estão interagindo | F3 | ✅ |
| F5 | CLI `maestri` real: context, send, note, spawn; `MAESTRI_NODE_ID` no PTY | F2, F3 | ✅ |
| F6 | Face de chat real: envia ao PTY, histórico persistido e compartilhado | F2, F3 | ⬜ |
| F7 | Andares (worktrees): criar por agente, listar, diff, land (merge), apagar; aba Worktrees real | F2 | ⬜ |
| F8 | UX do canvas: elevar nó, busca Ctrl+K, atalhos, apagar nó, menu de contexto, nota com Markdown e cor | F3 | ⬜ |
| F9 | Roles e presets: folha de criação de agente (claude/codex/opencode/agy/shell), roles por projeto | F2, F5 | ⬜ |
| F10 | Partituras: exportar/importar seleção do canvas como arquivo | F3 | ⬜ |
| F11 | Rotinas: comando/prompt agendado para um terminal, histórico, liga/desliga | F2 | ⬜ |
| F12 | Árvore de arquivos e nó de diff | F7 | ⬜ |

Fora de escopo (exclusivos do app nativo): portais de dispositivo (iOS/Android), Ombro (LLM no dispositivo), Wire/Remote, impedir suspensão, anéis de uso, ambientes SSH/Docker, ferramentas de desenho.
