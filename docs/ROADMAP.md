# Roadmap — Maestri Web

Ordem de execução (cada item = 1 branch + PR). Status: ⬜ a fazer · 🔄 em andamento · ✅ mergeado

| # | Funcionalidade | Depende de | Status |
|---|---|---|---|
| F1 | Acesso multiusuário: URL da API derivada do host, token de acesso, identidade (nome/cor) | — | ✅ |
| F2 | Sessões de terminal compartilhadas: registro por nó, vários clientes no mesmo PTY, reattach com scrollback | F1 | ✅ |
| F3 | Canvas em tempo real: servidor como fonte da verdade, mudanças transmitidas por WS a todos | F1 | ✅ |
| F4 | Presença: usuários conectados, cursores ao vivo, projeto atual de cada um, nó em que estão interagindo | F3 | ✅ |
| F5 | CLI `maestri` real: context, send, note, spawn; `MAESTRI_NODE_ID` no PTY | F2, F3 | ✅ |
| F6 | Face de chat real: envia ao PTY, histórico persistido e compartilhado | F2, F3 | ✅ |
| F7 | Andares (worktrees): criar por agente, listar, diff, land (merge), apagar; aba Worktrees real | F2 | ✅ |
| F8 | UX do canvas: elevar nó, busca Ctrl+K, atalhos, apagar nó, menu de contexto, nota com Markdown e cor | F3 | ✅ |
| F9 | Roles e presets: folha de criação de agente (claude/codex/opencode/agy/shell), roles por projeto | F2, F5 | ✅ |
| F10 | Partituras: exportar/importar seleção do canvas como arquivo | F3 | ✅ |
| F11 | Rotinas: comando/prompt agendado para um terminal, histórico, liga/desliga | F2 | ✅ |
| F12 | Árvore de arquivos e nó de diff | F7 | ✅ |
| F13 | Comunicação CLI: `ask --batch`, `ask --raw` (escapes), `say`/`recall` com 7 threads coloridas no chat, `debug`, `help` | F5, F6 | ✅ |
| F14 | Notas avançadas: `note read` com linhas/intervalo, `note edit`, `note delete`, `--name` estável, cor, notas travadas, cadeia de notas, fichários (`note stack/unstack`), `arrange` (nome/ícone/cor) | F5, F8 | ✅ |
| F15 | Equipe: `connect`, `recruit --replace/--floor/--dir/--icon/--color`, `preset list/show/create/set/delete`, `role list/show/create/edit/write/assign`, bandas (`band create/add/remove/dissolve`) | F9, F16 | ✅ |
| F16 | Andares como níveis do canvas: seletor de andar, status do andar (estado/progresso/avisos), CLI `floor list/create/land/delete/status/unload`; workspaces: `workspace list/create --from/rename/move`, grupos e pastas na barra lateral | F7 | ✅ |
| F17 | Rotinas com paridade total: `--every/--daily/--weekly/--once`, `--terminal`, `--reminder`, `--count/--until`, `--pre-run` com `{{output}}`, pular se ocupado, `--no-notify`, `--disabled`, `show/edit/enable/disable/run/delete`, `--id`; só Maestro | F11 | ✅ |
| F18 | Automação de portais: Chromium headless no servidor; `portal create/edit/close/navigate/back/forward/reload/info/screenshot/snapshot` (refs `@eN`), `click/fill/type/key/selectall/clear/hover/focus/select/check/uncheck/upload/scroll/scrollintoview/text/html/evaluate/logs-start/logs/resize/ua`; nó do portal mostra a sessão automatizada | F5 | ✅ |
| F19 | Andares `--copy` (clone isolado) e `--pull-request` (via `gh`, merge e detecção de PR pelo seletor); marcador `<maestri-create-floor/>` (ação "Novo andar" no chat) | F16 | ✅ |
| F20 | Ferramentas de desenho por andar: caneta, retângulo, elipse, seta, texto, cor, espessura, borracha, desfazer; tempo real e persistência | F16 | ✅ |
| F21 | Chat com anexos (`say --file/--attach`, imagens embutidas, `recall attachment`), retomada de sessão (`claude --continue`, `codex resume`...) e contas por CLI (`--account`, `maestri account`) | F13, F15 | ✅ |
| F22 | Lacunas da auditoria: workspaces cruzados (`Nome @ Workspace`, `recruit/band --workspace`), acordar agentes sem sessão, `portal wait`, flags desconhecidas falham, `$MAESTRI_CLI`, diretório de role, notificações do sistema, fichário/barra lateral pela UI, roles globais, notificações do SO, detecção de PR em segundo plano, endurecimento de segurança (revisão) | F15, F16, F18 | ✅ |

Fora de escopo (exigem o app nativo ou hardware/serviços ausentes neste ambiente): portais de dispositivo Android/iOS (`maestri-portal-devices`: exige adb/emulador), Ombro (LLM no dispositivo), Wire/Remote, impedir suspensão, anéis de uso, ambientes remotos SSH/Docker.
