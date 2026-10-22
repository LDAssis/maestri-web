---
name: maestri-canvas
description: Instruções essenciais para agentes (claude, codex, opencode) operando dentro de um terminal do Maestri Canvas Web. Explica como ver os nós conectados e usar o comando `maestri` para conversar com outros agentes, ler/escrever notas, navegar portais, notificar e (Maestro) recrutar agentes.
---

# Maestri Canvas Skill

Você roda em um terminal de um nó do **Maestri Canvas Web**, ligado por arestas a outros nós: agentes (terminais), notas adesivas e portais (navegadores). O comando `maestri` já está no seu PATH e o ambiente (`MAESTRI_API_URL`, `MAESTRI_PROJECT_ID`, `MAESTRI_NODE_ID`, `MAESTRI_TOKEN`) já está configurado.

**Regras de nomes:** o alvo é o **título** do nó (sem diferenciar maiúsculas) e precisa estar **conectado ao seu nó** por uma aresta (em qualquer direção). Erros saem em stderr com código 1.

## Comandos

```bash
maestri list                 # (ou: maestri context) quem é você e quem está conectado
                             #   Você: Agente 01 (Maestro)
                             #   Agentes: / Notas: / Portais: (com URL)

maestri send "Backend" "rode os testes e me avise"      # escreve texto + Enter no terminal do agente
maestri check "Backend" --lines 80                       # últimas 80 linhas do terminal dele (sem ANSI; padrão 60)
maestri ask "Backend" "qual o status da migração?"      # send + espera o agente ficar 5s quieto e imprime a resposta
maestri ask "Backend" "..." --timeout 120                # padrão 600s; ao estourar imprime o parcial e sai com código 2
maestri ask --batch '{"Backend":"status?","Frontend":"status?"}'   # asks em paralelo; imprime array JSON [{name, output}|{name, error}]
maestri ask "Backend" --raw "2\n"                          # entrada crua (\n Enter, \t Tab, \e ESC, \xNN) para responder prompts interativos
maestri debug                                              # diagnostica env, API, nó, sessão e papel de Maestro (sai 0/1)

maestri note read "Notas" [início] [quantidade]          # lê com números de linha (intervalo opcional)
maestri note write "Notas" "texto"                       # substitui o conteúdo
maestri note append "Notas" "mais uma linha"             # acrescenta
maestri note edit "Notas" "antigo" "novo"                # troca um trecho (precisa aparecer exatamente uma vez)
maestri note delete "Notas"                              # remove a nota (destrutivo: só se o usuário pedir)
maestri note create ["conteúdo"] [--name "Nome"] [--stack ["Fichário"]] [--color C]   # nome = 1ª linha, a menos que --name fixe; imprime o nome exato
maestri note stack "Notas" ["Fichário"]                  # guarda a nota num fichário (cria se preciso)
maestri note unstack "Notas"                             # tira do fichário
maestri arrange ["Nome"] [--name N] [--icon I] [--color C]   # renomeia/estiliza você, uma nota ou (Maestro) um agente; sem args mostra; --help lista ícones/cores
maestri note create "Decisões" "texto"                   # forma antiga: título fixo + texto

maestri portal navigate "Preview" "http://localhost:3000"   # só http/https (veja "Portais" abaixo para a automação completa)

maestri notify "Deploy concluído"                        # toast para todos os navegadores no projeto

# Somente o nó Maestro (coroa) — outros recebem erro "Apenas o Maestro pode ..."
maestri recruit "QA" --cmd claude --role "Você testa a API e reporta falhas"
maestri dismiss "QA"
```

`maestri --help` e `maestri <comando> --help` mostram o uso.

## Portais (navegador automatizável)
Cada portal conectado tem um Chromium headless no servidor, aberto sob demanda no primeiro comando de automação (o nó passa a mostrar a sessão ao vivo; humanos também clicam, digitam e rolam nele). O nome do portal é sempre obrigatório (`maestri list` mostra os conectados). Só URLs http/https (localhost vale).

```bash
maestri portal create http://localhost:3000 "Preview" [--size 390x844]   # cria à direita de você, conectado
maestri portal edit "Preview" --url http://localhost:5173
maestri portal close "Preview"                           # destrutivo: só se o usuário pedir

maestri portal snapshot "Preview"                        # árvore dos elementos interativos visíveis, com refs
#   viewport: 1280x800  url: http://localhost:3000/  title: App
#   @e1 a "Home" href=http://localhost:3000/ [10,5 60x20]
#   @e2 input type=text "Buscar" [200,50 300x32] *focused*
maestri portal click "Preview" @e1                       # seletor: @eN, CSS (#id) ou x,y
maestri portal fill "Preview" @e2 "texto"                # substitui; type acrescenta (sem seletor: elemento focado)
maestri portal key "Preview" "Enter"                     # Tab, Escape, Backspace, setas, Space, ctrl+a, shift+tab...
maestri portal select "Preview" @e5 "Texto da opção"     # check/uncheck @e6; upload @e4 ./arquivo.pdf
maestri portal scroll "Preview" down 300 [x,y|@ref]      # scrollintoview @e10
maestri portal text|html|evaluate|info|screenshot "Preview" ...   # screenshot imprime o caminho do PNG
maestri portal logs-start "Preview"; maestri portal logs "Preview"   # console (logs devolve e limpa)
maestri portal back|forward|reload "Preview"
maestri portal resize "Preview" 390 844                  # viewport exato; ua "Preview" ios|android|chrome|... (sem argumento lista)
```

Fluxo: `snapshot` → agir com as refs → `snapshot` de novo para conferir. As refs valem até o próximo snapshot ou navegação. Falhas imprimem `maestri: error: <motivo>` no stderr com código ≠ 0. Popups abertos pela página viram portais `[Portal] #2`.

## Como usar bem
1. Comece com `maestri list` para saber quem são seus vizinhos.
2. Use `send` para delegar sem esperar; `ask` quando precisar da resposta antes de continuar; `check` para acompanhar o progresso de quem está trabalhando.
3. Registre decisões e progresso nas notas conectadas (`note append`) — os humanos veem ao vivo no canvas.
4. `recruit`: com `--role`, o texto do papel vai para `.maestri-roles/<id>.md` (nunca é interpolado no comando); com `--cmd claude` ou `--cmd codex` o arquivo é passado como prompt inicial. O novo agente já nasce conectado a você e com o terminal iniciado.
5. Se for o Maestro: quebre o objetivo em tarefas, recrute especialistas, delegue com `send`/`ask`, acompanhe com `check` e dispense (`dismiss`) quem terminou.

## Face de chat
Os usuários também conversam com você pela **face de chat** do seu nó: a mensagem chega digitada no seu terminal (menções `@Nota` vêm com a dica de como ler). **Quando receber mensagens pela face de chat (cabeçalho `Below is a message from the user through Maestri Chat` com `thread: <cor>`), responda SOMENTE com `maestri say`** — é o que aparece, renderizado em Markdown, para todos que estão no canvas, na thread (cor) da última mensagem do usuário; a saída crua do terminal vira só um bloco recolhido. `maestri chat reply` continua funcionando como alias.

```bash
maestri say "Pronto! Veja o resumo:\n\n- item 1\n- item 2"   # aceita Markdown; sem argumento lê stdin (heredoc)
maestri say --file resposta.md                                 # texto UTF-8 de um arquivo
maestri say --progress "rodando os testes..."                  # balão intermediário (estilo diferente), antes da resposta final
maestri recall --turns 5                                       # releia a thread atual (--last day|week|month, --from/--to YYYY-MM-DD, --all, --json)
maestri recall purple                                          # outra thread: blue purple pink red orange yellow green
maestri recall list                                            # threads com contagem de mensagens
maestri chat history --last 10                                 # histórico bruto do chat (todas as threads)
```

## Notas avançadas
- `maestri list` mostra `(locked: true)` em notas travadas (somente leitura: write/edit/append/delete falham), notas encadeadas
  indentadas sob a nota-mãe e os fichários com suas páginas. Notas ligadas a uma nota conectada a você, e as páginas de
  fichários conectados a você, também podem ser lidas e escritas.
- O nome de uma nota sem `--name` acompanha a primeira linha; `write`/`edit` informam o novo nome quando muda. Prefira `--name`
  se for endereçar a nota de novo.

## Rotinas (só o Maestro)
Rotinas são comandos/prompts agendados do **projeto**; disparam num terminal (o seu por padrão) ou viram um aviso (`--reminder`). Rode `maestri routine list` antes para ver nomes e ids curtos.
```
maestri routine create "Digest" --command "Resuma os commits:\n\n{{output}}" --daily 18:00 --pre-run "git log --since=midnight --oneline"
maestri routine create "Auditoria" --command "npm audit" --weekly mon,wed,fri@02:00 --terminal "Backend" --count 10 --until 2026-12-31
maestri routine create "Standup" --command "Hora do standup" --weekly mon,tue,wed,thu,fri@09:00 --reminder
maestri routine create "Auto-check" --command "Releia o plano" --every 1h30m     # 45s, 30m, 2h, 1h30m; número puro = minutos
maestri routine create "Deploy" --command "./deploy.sh" --once "2026-06-20 15:00" --no-notify --disabled
maestri routine show|edit|enable|disable|run|delete "Nome"                       # edit muda só os campos passados
maestri routine edit "Auditoria" --id a1b2c3 --daily 03:00                        # --id (prefixo) quando há nomes iguais
```
Horários na hora local do servidor. O `--pre-run` roda no diretório do alvo e precisa sair com 0 (senão o disparo é pulado); `{{output}}` no comando vira o stdout. Por padrão o disparo é pulado se o terminal estiver ocupado (chat em andamento ou saída nos últimos 5s; `--no-skip-if-busy` desliga). `delete` é destrutivo: só a pedido do usuário.

## Andares e workspaces
Andares são níveis do canvas do projeto ("Ground" = térreo; cada nó tem `data.floor`). Com git, um andar é uma worktree na
própria branch em `<repo>/.worktrees/<slug>` (terminais dele começam nesse checkout).
```
maestri floor list
maestri floor status "Testes verdes" --progress 3/5          # qualquer agente, para o PRÓPRIO andar
maestri floor status "Preciso de decisão" --state blocked    # blocked/review/done também avisam o usuário (toast)
maestri floor create "Nome" [--branch B] [--existing-branch] [--no-git] [--copy-ground]   # só Maestro
maestri floor land "Nome" [--into BRANCH] [--delete-branch] [--keep-floor]                # só Maestro, do térreo; só se o usuário pedir
maestri floor delete "Nome" [--keep-branch] [--force]                                      # só Maestro, do térreo; só se o usuário pedir
maestri floor unload "Nome"                                                                # só Maestro; não o seu andar
maestri workspace list | create "Nome" --dir PATH [--from "Origem"] [--group G] [--folder F] | rename "A" "B" | move "Nome" --group G | --folder F | --root   # só Maestro
```
`floor land` recusa (sem alterar nada) se houver trabalho não commitado no andar ou no térreo, ou conflito de merge; peça ao
agente do andar para commitar antes. Workspaces não têm delete pela CLI.
