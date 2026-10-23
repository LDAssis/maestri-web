# Maestri Web 🎼

> Um canvas infinito, no navegador, para orquestrar agentes de IA: terminais reais, chat, notas, portais web automatizáveis, andares isolados por Git e uma equipe de agentes que se coordena por uma CLI (`maestri`) — tudo compartilhado em tempo real entre vários usuários.

Inspirado no [Maestri](https://www.themaestri.app) (app nativo). O Maestri Web reimplementa, para a web, a experiência de canvas + agentes + CLI, de modo que uma equipe inteira trabalhe no mesmo canvas ao mesmo tempo.

- Documentação para os **agentes** (como usar a CLI de dentro do terminal): [`SKILL.md`](SKILL.md).
- Plano e histórico de entregas: [`docs/ROADMAP.md`](docs/ROADMAP.md).

---

## Sumário

1. [Recursos](#-recursos)
2. [Como funciona](#-como-funciona)
3. [Requisitos](#-requisitos)
4. [Instalação e execução](#-instalação-e-execução)
5. [Configuração](#️-configuração)
6. [Referência rápida da CLI `maestri`](#-referência-rápida-da-cli-maestri)
7. [Testes](#-testes)
8. [Estrutura do repositório](#️-estrutura-do-repositório)
9. [Licença](#-licença)

---

## ✨ Recursos

### Canvas e nós
- **Canvas infinito** (React Flow): mova, redimensione e ligue nós por arestas; busca (Ctrl+K), atalhos, menu de contexto, elevar e apagar nós.
- **Tempo real e multiusuário:** o servidor é a fonte da verdade do canvas e transmite cada mudança por WebSocket. Presença com usuários conectados, cursores ao vivo e o nó em que cada pessoa está interagindo.
- **Multi-projetos (workspaces):** cada projeto tem o próprio diretório, canvas, configurações, sessões e agentes — nada vaza de um projeto para outro. Barra lateral com fixados, grupos e pastas.
- **Partituras:** exporte/importe uma seleção do canvas como arquivo.
- **Desenhos por andar:** caneta, retângulo, elipse, seta, texto, cor, espessura, borracha e desfazer, em tempo real e persistidos.
- **Avisos:** toasts no canvas (`maestri notify`, lembretes de rotinas, status de andar, andar que passa a seguir um PR) e notificações do sistema operacional pelo servidor (liga/desliga nas Configurações).

### Agentes e terminais
- **Terminais reais** (`node-pty` + `xterm.js`) por nó de agente, com sessões **compartilhadas**: vários clientes no mesmo PTY, reconexão com histórico (scrollback) e sessões que sobrevivem à desconexão do navegador.
- **Presets de CLI:** `claude`, `codex`, `opencode`, `agy` e shell embutidos, mais presets seus (comando, Maestro on/off, chat on/off, atalho rápido, cor e ícone), globais ou por projeto.
- **Nó Maestro 👑:** qualquer agente pode ser o Maestro da equipe e recrutar, conectar, dispensar e coordenar outros agentes pela CLI.
- **Retomada de sessão:** se o terminal de um agente reinicia (servidor reiniciado, nó reaberto), `claude`, `codex` e `opencode` voltam em modo de retomada (`claude --continue`/`--resume <id>`, `codex resume`, `opencode --continue`). Há um toggle por projeto.
- **Contas de CLI:** vários logins lado a lado para `claude` e `codex` (`CLAUDE_CONFIG_DIR`/`CODEX_HOME` isolados), com `--account` em recrutas e presets.
- **Acordar agentes:** `ask`/`send`/`check` num agente sem sessão sobem o terminal (cwd e comando do nó) em vez de falhar.

### Chat
- **Face de chat** ao lado do terminal: as mensagens do usuário chegam ao agente com um cabeçalho padrão, e o agente responde por `maestri say` (Markdown renderizado).
- **7 threads coloridas** por agente; `maestri recall` relê o histórico por thread, turnos, período ou datas.
- **Anexos:** o agente anexa imagens e arquivos (`say --file/--attach`, imagens embutidas por `![desc](/caminho.png)`); o usuário anexa pelo clipe ou colando imagens. Os arquivos ficam no servidor, por projeto, com ids estáveis (`recall attachment <id>`).
- **`@menções`** de notas e agentes conectados.

### Notas, fichários e arquivos
- **Notas adesivas** em Markdown, com cor e ícone, travadas/destravadas e encadeadas entre si; os agentes leem e escrevem pela CLI (`note read/write/append/edit/delete`, por linha ou intervalo).
- **Fichários:** pilhas de notas (páginas) num único nó; `note stack/unstack`.
- **Árvore de arquivos** (com editor Monaco) e **nó de diff** do projeto/andar.

### Portais web automatizáveis
- Um **Chromium headless** por portal, no servidor; o nó mostra a sessão ao vivo (frames + eventos do usuário).
- Automação completa pela CLI: `snapshot` com refs `@eN`, `click/fill/type/key/select/check/upload/scroll`, `text/html/evaluate`, `logs`, `resize/ua`, `wait`, `screenshot`… Popups viram portais “`[Pai] #N`”.
- **Seguro por padrão:** bloqueia metadata de nuvem, endereços link-local e a API do próprio servidor (inclusive por redirecionamento); `upload` só lê arquivos do projeto, dos anexos do chat ou do tmp.

### Andares, workspaces e Git
- **Andares** são níveis do canvas de um projeto (“Ground” é o térreo), com seletor, status (estado, progresso, avisos) e desenhos próprios. Um andar pode ter **isolamento Git** (uma worktree na própria branch em `.worktrees/`), ser um **clone** (`--copy`) ou compartilhar o diretório do térreo (`--no-git`).
- `floor land` traz o trabalho de volta (merge); andares podem ser abertos a partir de um **pull request** (`--pull-request`), com acompanhamento de review/checks e merge do PR pela interface — via `gh`.
- **Workspaces cruzados:** agentes de outros projetos aparecem como `Nome @ Workspace` e podem ser recrutados (`recruit --workspace`), conectados e consultados como qualquer colega.

### Equipe
- **`recruit`** (do zero, cópia sua ou `--replace` no mesmo nó), `connect`, **bandas** (grupos em que todo membro alcança todos), **roles** (por projeto ou globais, entregues como `CLAUDE.md`/`AGENTS.md` na pasta do role) e **presets**.
- **Rotinas:** comandos/prompts agendados (`--every`, `--daily`, `--weekly`, `--once`) para o próprio terminal, outro terminal ou como lembrete; `--pre-run` com `{{output}}`, `--count/--until`, pular se ocupado e histórico de disparos.

### Colaboração
- Acesso por rede com **token** e identidade (nome e cor) na primeira visita; várias pessoas no mesmo canvas, nos mesmos terminais e no mesmo chat.

---

## 🧩 Como funciona

```
apps/web (Next.js :3000)  ──HTTP/WS──►  apps/server (Fastify :4000)
   canvas, xterm, chat                    canvas (fonte da verdade), sessões PTY, APIs,
                                          Chromium dos portais, rotinas, anexos
                                                    ▲
                      terminal de cada agente ──────┘  CLI `maestri` (HTTP) com MAESTRI_* no ambiente
```

- Cada terminal de agente roda com as variáveis `MAESTRI_API_URL`, `MAESTRI_PROJECT_ID`, `MAESTRI_NODE_ID`, `MAESTRI_TOKEN` e `MAESTRI_CLI` (caminho absoluto do binário) e com `apps/server/bin` no `PATH` — é assim que o agente enxerga a equipe e age no canvas.
- **Dados:** `.maestri_data/` (dentro de `REPO_PATH`) guarda projetos, canvas, configurações, rotinas, andares, anexos, contas e links entre workspaces. Projetos novos ganham uma pasta própria em `~/maestri-projects/` (`MAESTRI_PROJECTS_DIR`). Roles do projeto ficam em `<projeto>/.maestri/roles/` e andares com Git em `<projeto>/.worktrees/`.

---

## 📋 Requisitos

| Item | Observação |
|---|---|
| **Node.js ≥ 18** | e `npm` |
| **Git** | para andares com isolamento (worktrees/clones) |
| **Toolchain de compilação** | o `node-pty` é um módulo nativo (compilador C++/Python quando não há binário pré-compilado) |
| **Chromium do Playwright** (para os portais) | o servidor usa `playwright-core`, que **não baixa** navegador sozinho: instale uma vez com `cd apps/server && npx playwright-core install chromium` (fica em cache, p.ex. `~/.cache/ms-playwright` no Linux). Sem ele o servidor sobe normalmente e só os portais falham (503 com a causa) |
| **`gh` (GitHub CLI)** — opcional | só para os recursos de pull request dos andares (abrir andar a partir de um PR, detectar o PR de um andar, ver review/checks, mesclar); precisa estar autenticado (`gh auth login`) |
| **CLIs de agentes** — opcionais | `claude`, `codex`, `opencode`, `agy`… instalados à parte e disponíveis no `PATH` do servidor |

**Sistemas:** desenvolvido e testado principalmente em **Linux**. O terminal usa `$SHELL` (ou `/bin/bash`); há tratamento para Windows (Git Bash, se instalado, senão PowerShell, via ConPTY do `node-pty`) e macOS, mas ele recebe menos testes.

---

## 🏁 Instalação e execução

```bash
git clone https://github.com/LDAssis/maestri-web.git
cd maestri-web
npm install                      # workspaces: instala apps/server e apps/web

# (portais) baixa o Chromium usado pelo servidor — uma vez por máquina
cd apps/server && npx playwright-core install chromium && cd ../..
```

Abra dois terminais:

```bash
# Backend (porta 4000)
cd apps/server && npm run dev

# Frontend (porta 3000)
cd apps/web && npm run dev
```

Acesse **http://localhost:3000**. Para uma build do frontend: `cd apps/web && npm run build && npm start`.

### Modo colaborativo (várias pessoas / rede)

```bash
# Backend: expõe na rede (HOST não-loopback EXIGE MAESTRI_TOKEN; sem ele o servidor se recusa a subir)
cd apps/server
HOST=0.0.0.0 MAESTRI_TOKEN=um-segredo-forte npm run dev

# Frontend: escuta em todas as interfaces
cd apps/web
npm run dev:lan
```

Acesse por **http://&lt;ip-da-maquina&gt;:3000**. Cada pessoa informa o token e escolhe nome e cor na primeira visita. Se a API estiver em outro endereço, defina `NEXT_PUBLIC_API_URL` no frontend.

Com `MAESTRI_TOKEN` definido, `GET /api/health` continua público; as demais rotas `/api/*` exigem `Authorization: Bearer <token>` e os WebSockets, `?token=<token>`.

> ⚠️ Os terminais são shells reais da máquina do servidor. Exponha o Maestri Web apenas a pessoas em quem você confia e sempre com token.

---

## ⚙️ Configuração

### Servidor (`apps/server`)

| Variável | Padrão | Para quê |
|---|---|---|
| `PORT` | `4000` | Porta da API/WebSocket |
| `HOST` | `127.0.0.1` | Interface de escuta; um valor não-loopback exige `MAESTRI_TOKEN` |
| `MAESTRI_TOKEN` | — | Token de acesso à API e aos WebSockets (vazio = sem autenticação, só para uso local) |
| `ALLOWED_ORIGINS` | `http://localhost:3000` | Origens CORS permitidas, separadas por vírgula (com `MAESTRI_TOKEN` definido, qualquer Origin é aceito) |
| `REPO_PATH` | raiz do repositório | Diretório do projeto inicial; `.maestri_data/` fica dentro dele |
| `MAESTRI_PROJECTS_DIR` | `~/maestri-projects` | Onde nascem as pastas dos projetos criados pela UI |
| `SHELL` | `/bin/bash` | Shell dos terminais dos agentes |
| `MAESTRI_PORTAL_ALLOW_PRIVATE` | — | `1` libera o bloqueio de metadata/link-local e da API do próprio servidor nos portais (localhost em outras portas já é livre); necessário para abrir a própria UI do Maestri Web dentro de um portal |
| `MAESTRI_PORTAL_NO_SANDBOX` | — | Qualquer valor inicia o Chromium com `--no-sandbox` (necessário em alguns contêineres/root) |
| `MAESTRI_PORTAL_FRAME_MS` | `700` | Intervalo dos frames ao vivo dos portais |
| `MAESTRI_ASK_QUIET_MS` | `5000` | Silêncio do terminal que encerra um `ask` |
| `MAESTRI_WAKE_STARTUP_MS` | `30000` | Tempo máximo em que um agente recém-acordado ainda “está iniciando” |
| `MAESTRI_WAKE_SETTLE_MS` | `1500` | Silêncio após a primeira saída para o agente acordado contar como pronto |
| `MAESTRI_DESKTOP_NOTIFY` | — | `1`/`0` força ligar/desligar as notificações do sistema (`notify-send` no Linux, `osascript` no macOS) para `maestri notify`, lembretes de rotina, andares em blocked/review/done e andares que passam a seguir um PR. Sem a variável vale a preferência do projeto; o padrão é ligado só quando o servidor escuta em loopback |
| `MAESTRI_PR_POLL_MS` | `120000` | Intervalo da detecção de PRs em segundo plano nos andares git (também roda quando um agente do andar fica ocioso depois de produzir saída, `MAESTRI_IDLE_MS`, padrão 8000) |
| `MAESTRI_ROUTINE_TICK_MS` | `15000` | Granularidade do agendador de rotinas |
| `MAESTRI_ROUTINE_BUSY_MS` | `5000` | Saída recente que conta como “terminal ocupado” numa rotina |
| `MAESTRI_ROUTINE_PRERUN_MS` | `30000` | Timeout do `--pre-run` de uma rotina |

### Frontend (`apps/web`)

| Variável | Padrão | Para quê |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `<protocolo>//<host da página>:4000` | Endereço da API quando não é o padrão |

### Dentro dos terminais (definidas pelo servidor)

`MAESTRI_API_URL`, `MAESTRI_PROJECT_ID`, `MAESTRI_NODE_ID`, `MAESTRI_TOKEN` e `MAESTRI_CLI`. Se `maestri` não for encontrado no `PATH`, use `"$MAESTRI_CLI"`.

### Configurações na interface
Comando de inicialização e atalhos de CLI (globais e por projeto), retomada de sessão, contas de CLI, roles, rotinas, notificações do sistema e organização da barra lateral.

---

## 🧰 Referência rápida da CLI `maestri`

Disponível em todo terminal de agente (`maestri help`, `maestri <comando> --help`). Nomes são os títulos dos nós; o alvo precisa estar conectado a você (agentes de outros workspaces: `"Nome @ Workspace"`). Flags desconhecidas falham; use `--` antes de um texto que comece com `--`. Detalhes e exemplos completos para agentes: **[`SKILL.md`](SKILL.md)**.

**Equipe e contexto**
```bash
maestri list                                   # você, colegas, bandas, notas, portais (Maestro: com as conexões deles)
maestri ask "Nome" "pergunta" [--timeout S]    # envia e espera o agente ficar quieto
maestri ask --batch '{"A":"p1","B":"p2"}'      # em paralelo; saída em JSON
maestri send "Nome" "texto" | check "Nome"     # escreve / lê as últimas linhas
maestri recruit "Hawk" --role "Reviewer" [--preset P] [--floor F] [--workspace W] [--band B] [--account A]
maestri recruit "Novo" --replace "Antigo" --preset "Codex"   # troca o agente no mesmo nó
maestri dismiss "Nome" | connect "A" "B"       # (Maestro)
maestri preset list|show|create|set|delete     # presets de agente
maestri role list|show|create|edit|write|assign
maestri band create|add|remove|dissolve        # (Maestro)
maestri account list|create|delete --cli claude|codex
```

**Chat**
```bash
maestri say "resposta em **Markdown**" [--file img.png] [--attach doc.pdf] [--progress "trabalhando..."]
maestri recall [thread] [--turns N | --last day|week|month | --from D [--to D] | --all] [--json]
maestri recall list | recall attachment <id>
```

**Notas, fichários e aparência**
```bash
maestri note read|write|append|edit|delete|create "Nota" ...   # linhas/intervalos, travas, cadeias
maestri note stack|unstack ...                                  # fichários
maestri arrange ["Nome"] [--name N] [--icon I] [--color C]
```

**Portais**
```bash
maestri portal create URL "Nome" | edit | close | navigate "Portal" URL
maestri portal snapshot "Portal"                 # árvore com refs @e1…
maestri portal click|fill|type|key|select|check|upload|scroll "Portal" @e3 ...
maestri portal text|html|evaluate|logs|screenshot|resize|ua "Portal" ...
maestri portal wait "Portal" (@ref|seletor|--text "t"|--url "padrão"|MS) [--timeout S]
```

**Andares e workspaces**
```bash
maestri floor list | status "texto" [--progress 3/5] [--state working|blocked|review|done]
maestri floor create "Nome" [--branch B] [--existing-branch] [--copy | --no-git]   # (Maestro)
maestri floor create --pull-request NUMERO|URL                                      # (Maestro; usa o gh)
maestri floor land "Nome" | delete "Nome" | unload "Nome"                           # (Maestro; land/delete a partir do térreo)
maestri workspace list | create "Nome" --dir PATH [--from "Origem"] | rename | move # (Maestro)
```

**Rotinas** (Maestro)
```bash
maestri routine create "Digest" --command "..." (--every 30m | --daily 18:00 | --weekly mon,fri@09:00 | --once "2026-06-20 15:00") \
        [--terminal "Nome" | --reminder] [--pre-run "script"] [--count N] [--until D] [--no-skip-if-busy] [--no-notify] [--disabled]
maestri routine list|show|edit|enable|disable|run|delete "Nome" [--id prefixo]
```

**Diversos**
```bash
maestri notify "texto"     # aviso a todos os navegadores do projeto
maestri debug              # diagnóstico do ambiente (variáveis, API, nó, sessão)
```

---

## ✅ Testes

```bash
# Servidor: suíte completa (node:test via tsx; leva alguns minutos)
cd apps/server && npm test

# Typecheck dos dois pacotes e build do frontend
cd apps/server && npx tsc --noEmit -p .
cd apps/web    && npx tsc --noEmit -p . && npx next build
```

- A suíte do servidor sobe servidores Fastify reais, abre PTYs de verdade e usa diretórios temporários — **não toca em `.maestri_data/`**. CLIs de agentes são substituídos por programas falsos no `PATH`.
- Os testes de portal precisam do Chromium do Playwright; sem ele, são pulados com uma mensagem clara.
- Máquinas muito carregadas podem deixar mais lentos os testes que dependem de shells interativos.

---

## 🗂️ Estrutura do repositório

```
apps/
  server/            # Fastify: API REST + WebSockets, PTYs, portais (Playwright), rotinas, anexos
    bin/maestri      # CLI (carrega bin/maestri-*.mjs, um por área)
    src/             # nodeApi, teamApi, floorsApi, portals, routines, sessions, ...
    test/            # suíte node:test
  web/               # Next.js (App Router) + React Flow + xterm.js
    src/components/  # nós do canvas, ChatFace, painéis, modais
SKILL.md             # documentação da CLI para os agentes
docs/ROADMAP.md      # plano e histórico das entregas
```

**Stack:** TypeScript em todo o código; Next.js 14, React 18, Tailwind, `@xyflow/react`, `@xterm/xterm` e Monaco no frontend; Fastify, `@fastify/websocket`, `node-pty` e `playwright-core` no backend.

---

## 📜 Licença
Distribuído sob a licença MIT.
